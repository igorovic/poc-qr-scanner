(function () {
    'use strict';

    class QrScanner {
        /* async */
        static hasCamera() {
            if (!navigator.mediaDevices) return Promise.resolve(false);
            // note that enumerateDevices can always be called and does not prompt the user for permission. However, device
            // labels are only readable if served via https and an active media stream exists or permanent permission is
            // given. That doesn't matter for us though as we don't require labels.
            return navigator.mediaDevices.enumerateDevices()
                .then(devices => devices.some(device => device.kind === 'videoinput'))
                .catch(() => false);
        }

        constructor(
            video,
            onDecode,
            canvasSizeOrOnDecodeError = this._onDecodeError.bind(this),
            canvasSize = QrScanner.DEFAULT_CANVAS_SIZE,
            preferredFacingMode = 'environment'
        ) {
            this.$video = video;
            this.$canvas = document.createElement('canvas');
            this._onDecode = onDecode;
            this._preferredFacingMode = preferredFacingMode;
            this._active = false;
            this._paused = false;
            this._flashOn = false;

            if (typeof canvasSizeOrOnDecodeError === 'number') {
                // legacy function signature where canvas size is the third argument
                canvasSize = canvasSizeOrOnDecodeError;
                console.warn('You\'re using a deprecated version of the QrScanner constructor which will be removed in '
                    + 'the future');
            } else {
                this._onDecodeError = canvasSizeOrOnDecodeError;
            }

            this.$canvas.width = canvasSize;
            this.$canvas.height = canvasSize;
            this._sourceRect = {
                x: 0,
                y: 0,
                width: canvasSize,
                height: canvasSize
            };

            this._updateSourceRect = this._updateSourceRect.bind(this);
            this._onPlay = this._onPlay.bind(this);
            this._onVisibilityChange = this._onVisibilityChange.bind(this);

            // Allow inline playback on iPhone instead of requiring full screen playback,
            // see https://webkit.org/blog/6784/new-video-policies-for-ios/
            this.$video.playsInline = true;
            // Allow play() on iPhone without requiring a user gesture. Should not really be needed as camera stream
            // includes no audio, but just to be safe.
            this.$video.muted = true;
            this.$video.disablePictureInPicture = true;
            this.$video.addEventListener('loadedmetadata', this._updateSourceRect);
            this.$video.addEventListener('play', this._onPlay);
            document.addEventListener('visibilitychange', this._onVisibilityChange);

            this._qrEnginePromise = QrScanner.createQrEngine();
        }

        /* async */
        hasFlash() {
            if (!('ImageCapture' in window)) {
                return Promise.resolve(false);
            }

            const track = this.$video.srcObject ? this.$video.srcObject.getVideoTracks()[0] : null;
            if (!track) {
                return Promise.reject('Camera not started or not available');
            }

            const imageCapture = new ImageCapture(track);
            return imageCapture.getPhotoCapabilities()
                .then((result) => {
                    return result.fillLightMode.includes('flash');
                })
                .catch((error) => {
                    console.warn(error);
                    return false;
                });
        }

        isFlashOn() {
          return this._flashOn;
        }

        /* async */
        toggleFlash() {
          return this._setFlash(!this._flashOn);
        }

        /* async */
        turnFlashOff() {
          return this._setFlash(false);
        }

        /* async */
        turnFlashOn() {
          return this._setFlash(true);
        }

        destroy() {
            this.$video.removeEventListener('loadedmetadata', this._updateSourceRect);
            this.$video.removeEventListener('play', this._onPlay);
            document.removeEventListener('visibilitychange', this._onVisibilityChange);

            this.stop();
            QrScanner._postWorkerMessage(this._qrEnginePromise, 'close');
        }

        /* async */
        start() {
            if (this._active && !this._paused) {
                return Promise.resolve();
            }
            if (window.location.protocol !== 'https:') {
                // warn but try starting the camera anyways
                console.warn('The camera stream is only accessible if the page is transferred via https.');
            }
            this._active = true;
            this._paused = false;
            if (document.hidden) {
                // camera will be started as soon as tab is in foreground
                return Promise.resolve();
            }
            clearTimeout(this._offTimeout);
            this._offTimeout = null;
            if (this.$video.srcObject) {
                // camera stream already/still set
                this.$video.play();
                return Promise.resolve();
            }

            let facingMode = this._preferredFacingMode;
            return this._getCameraStream(facingMode, true)
                .catch(() => {
                    // We (probably) don't have a camera of the requested facing mode
                    facingMode = facingMode === 'environment' ? 'user' : 'environment';
                    return this._getCameraStream(); // throws if camera is not accessible (e.g. due to not https)
                })
                .then(stream => {
                    // Try to determine the facing mode from the stream, otherwise use our guess. Note that the guess is not
                    // always accurate as Safari returns cameras of different facing mode, even for exact constraints.
                    facingMode = this._getFacingMode(stream) || facingMode;
                    this.$video.srcObject = stream;
                    this.$video.play();
                    this._setVideoMirror(facingMode);
                })
                .catch(e => {
                    this._active = false;
                    throw e;
                });
        }

        stop() {
            this.pause();
            this._active = false;
        }

        pause() {
            this._paused = true;
            if (!this._active) {
                return;
            }
            this.$video.pause();
            if (this._offTimeout) {
                return;
            }
            this._offTimeout = setTimeout(() => {
                const tracks = this.$video.srcObject ? this.$video.srcObject.getTracks() : [];
                for (const track of tracks) {
                    track.stop(); //  note that this will also automatically turn the flashlight off
                }
                this.$video.srcObject = null;
                this._offTimeout = null;
            }, 300);
        }

        /* async */
        static scanImage(imageOrFileOrUrl, sourceRect=null, qrEngine=null, canvas=null, fixedCanvasSize=false,
                         alsoTryWithoutSourceRect=false) {
            const gotExternalWorker = qrEngine instanceof Worker;

            let promise = Promise.all([
                qrEngine || QrScanner.createQrEngine(),
                QrScanner._loadImage(imageOrFileOrUrl),
            ]).then(([engine, image]) => {
                qrEngine = engine;
                let canvasContext;
                [canvas, canvasContext] = this._drawToCanvas(image, sourceRect, canvas, fixedCanvasSize);

                if (qrEngine instanceof Worker) {
                    if (!gotExternalWorker) {
                        // Enable scanning of inverted color qr codes. Not using _postWorkerMessage as it's async
                        qrEngine.postMessage({ type: 'inversionMode', data: 'both' });
                    }
                    return new Promise((resolve, reject) => {
                        let timeout, onMessage, onError;
                        onMessage = event => {
                            if (event.data.type !== 'qrResult') {
                                return;
                            }
                            qrEngine.removeEventListener('message', onMessage);
                            qrEngine.removeEventListener('error', onError);
                            clearTimeout(timeout);
                            if (event.data.data !== null) {
                                resolve(event.data.data);
                            } else {
                                reject(QrScanner.NO_QR_CODE_FOUND);
                            }
                        };
                        onError = (e) => {
                            qrEngine.removeEventListener('message', onMessage);
                            qrEngine.removeEventListener('error', onError);
                            clearTimeout(timeout);
                            const errorMessage = !e ? 'Unknown Error' : (e.message || e);
                            reject('Scanner error: ' + errorMessage);
                        };
                        qrEngine.addEventListener('message', onMessage);
                        qrEngine.addEventListener('error', onError);
                        timeout = setTimeout(() => onError('timeout'), 10000);
                        const imageData = canvasContext.getImageData(0, 0, canvas.width, canvas.height);
                        qrEngine.postMessage({
                            type: 'decode',
                            data: imageData
                        }, [imageData.data.buffer]);
                    });
                } else {
                    return new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject('Scanner error: timeout'), 10000);
                        qrEngine.detect(canvas).then(scanResults => {
                            if (!scanResults.length) {
                                reject(QrScanner.NO_QR_CODE_FOUND);
                            } else {
                                resolve(scanResults[0].rawValue);
                            }
                        }).catch((e) => reject('Scanner error: ' + (e.message || e))).finally(() => clearTimeout(timeout));
                    });
                }
            });

            if (sourceRect && alsoTryWithoutSourceRect) {
                promise = promise.catch(() => QrScanner.scanImage(imageOrFileOrUrl, null, qrEngine, canvas, fixedCanvasSize));
            }

            promise = promise.finally(() => {
                if (gotExternalWorker) return;
                QrScanner._postWorkerMessage(qrEngine, 'close');
            });

            return promise;
        }

        setGrayscaleWeights(red, green, blue, useIntegerApproximation = true) {
            // Note that for the native BarcodeDecoder, this is a no-op. However, the native implementations work also
            // well with colored qr codes.
            QrScanner._postWorkerMessage(
                this._qrEnginePromise,
                'grayscaleWeights',
                { red, green, blue, useIntegerApproximation }
            );
        }

        setInversionMode(inversionMode) {
            // Note that for the native BarcodeDecoder, this is a no-op. However, the native implementations scan normal
            // and inverted qr codes by default
            QrScanner._postWorkerMessage(this._qrEnginePromise, 'inversionMode', inversionMode);
        }

        /* async */
        static createQrEngine(workerPath = QrScanner.WORKER_PATH) {
            return ('BarcodeDetector' in window ? BarcodeDetector.getSupportedFormats() : Promise.resolve([]))
                .then((supportedFormats) => supportedFormats.indexOf('qr_code') !== -1
                    ? new BarcodeDetector({ formats: ['qr_code'] })
                    : new Worker(workerPath)
                );
        }

        _onPlay() {
            this._updateSourceRect();
            this._scanFrame();
        }

        _onVisibilityChange() {
            if (document.hidden) {
                this.pause();
            } else if (this._active) {
                this.start();
            }
        }

        _updateSourceRect() {
            const smallestDimension = Math.min(this.$video.videoWidth, this.$video.videoHeight);
            const sourceRectSize = Math.round(2 / 3 * smallestDimension);
            this._sourceRect.width = this._sourceRect.height = sourceRectSize;
            this._sourceRect.x = (this.$video.videoWidth - sourceRectSize) / 2;
            this._sourceRect.y = (this.$video.videoHeight - sourceRectSize) / 2;
        }

        _scanFrame() {
            if (!this._active || this.$video.paused || this.$video.ended) return false;
            // using requestAnimationFrame to avoid scanning if tab is in background
            requestAnimationFrame(() => {
                if (this.$video.readyState <= 1) {
                    // Skip scans until the video is ready as drawImage() only works correctly on a video with readyState
                    // > 1, see https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage#Notes.
                    // This also avoids false positives for videos paused after a successful scan which remains visible on
                    // the canvas until the video is started again and ready.
                    this._scanFrame();
                    return;
                }
                this._qrEnginePromise
                    .then((qrEngine) => QrScanner.scanImage(this.$video, this._sourceRect, qrEngine, this.$canvas, true))
                    .then(this._onDecode, (error) => {
                        if (!this._active) return;
                        const errorMessage = error.message || error;
                        if (errorMessage.indexOf('service unavailable') !== -1) {
                            // When the native BarcodeDetector crashed, create a new one
                            this._qrEnginePromise = QrScanner.createQrEngine();
                        }
                        this._onDecodeError(error);
                    })
                    .then(() => this._scanFrame());
            });
        }

        _onDecodeError(error) {
            // default error handler; can be overwritten in the constructor
            if (error === QrScanner.NO_QR_CODE_FOUND) return;
            console.log(error);
        }

        _getCameraStream(facingMode, exact = false) {
            const constraintsToTry = [{
                width: { min: 1024 }
            }, {
                width: { min: 768 }
            }, {}];

            if (facingMode) {
                if (exact) {
                    facingMode = { exact: facingMode };
                }
                constraintsToTry.forEach(constraint => constraint.facingMode = facingMode);
            }
            return this._getMatchingCameraStream(constraintsToTry);
        }

        _getMatchingCameraStream(constraintsToTry) {
            if (!navigator.mediaDevices || constraintsToTry.length === 0) {
                return Promise.reject('Camera not found.');
            }
            return navigator.mediaDevices.getUserMedia({
                video: constraintsToTry.shift()
            }).catch(() => this._getMatchingCameraStream(constraintsToTry));
        }

        /* async */
        _setFlash(on) {
            return this.hasFlash().then((hasFlash) => {
                if (!hasFlash) return Promise.reject('No flash available');
                // Note that the video track is guaranteed to exist at this point
                return this.$video.srcObject.getVideoTracks()[0].applyConstraints({
                    advanced: [{ torch: on }],
                });
            }).then(() => this._flashOn = on);
        }

        _setVideoMirror(facingMode) {
            // in user facing mode mirror the video to make it easier for the user to position the QR code
            const scaleFactor = facingMode==='user'? -1 : 1;
            this.$video.style.transform = 'scaleX(' + scaleFactor + ')';
        }

        _getFacingMode(videoStream) {
            const videoTrack = videoStream.getVideoTracks()[0];
            if (!videoTrack) return null; // unknown
            // inspired by https://github.com/JodusNodus/react-qr-reader/blob/master/src/getDeviceId.js#L13
            return /rear|back|environment/i.test(videoTrack.label)
                ? 'environment'
                : /front|user|face/i.test(videoTrack.label)
                    ? 'user'
                    : null; // unknown
        }

        static _drawToCanvas(image, sourceRect=null, canvas=null, fixedCanvasSize=false) {
            canvas = canvas || document.createElement('canvas');
            const sourceRectX = sourceRect && sourceRect.x? sourceRect.x : 0;
            const sourceRectY = sourceRect && sourceRect.y? sourceRect.y : 0;
            const sourceRectWidth = sourceRect && sourceRect.width? sourceRect.width : image.width || image.videoWidth;
            const sourceRectHeight = sourceRect && sourceRect.height? sourceRect.height : image.height || image.videoHeight;
            if (!fixedCanvasSize && (canvas.width !== sourceRectWidth || canvas.height !== sourceRectHeight)) {
                canvas.width = sourceRectWidth;
                canvas.height = sourceRectHeight;
            }
            const context = canvas.getContext('2d', { alpha: false });
            context.imageSmoothingEnabled = false; // gives less blurry images
            context.drawImage(image, sourceRectX, sourceRectY, sourceRectWidth, sourceRectHeight, 0, 0, canvas.width, canvas.height);
            return [canvas, context];
        }

        /* async */
        static _loadImage(imageOrFileOrBlobOrUrl) {
            if (imageOrFileOrBlobOrUrl instanceof HTMLCanvasElement || imageOrFileOrBlobOrUrl instanceof HTMLVideoElement
                || window.ImageBitmap && imageOrFileOrBlobOrUrl instanceof window.ImageBitmap
                || window.OffscreenCanvas && imageOrFileOrBlobOrUrl instanceof window.OffscreenCanvas) {
                return Promise.resolve(imageOrFileOrBlobOrUrl);
            } else if (imageOrFileOrBlobOrUrl instanceof Image) {
                return QrScanner._awaitImageLoad(imageOrFileOrBlobOrUrl).then(() => imageOrFileOrBlobOrUrl);
            } else if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob
                || imageOrFileOrBlobOrUrl instanceof URL || typeof(imageOrFileOrBlobOrUrl)==='string') {
                const image = new Image();
                if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob) {
                    image.src = URL.createObjectURL(imageOrFileOrBlobOrUrl);
                } else {
                    image.src = imageOrFileOrBlobOrUrl;
                }
                return QrScanner._awaitImageLoad(image).then(() => {
                    if (imageOrFileOrBlobOrUrl instanceof File || imageOrFileOrBlobOrUrl instanceof Blob) {
                        URL.revokeObjectURL(image.src);
                    }
                    return image;
                });
            } else {
                return Promise.reject('Unsupported image type.');
            }
        }

        /* async */
        static _awaitImageLoad(image) {
            return new Promise((resolve, reject) => {
                if (image.complete && image.naturalWidth!==0) {
                    // already loaded
                    resolve();
                } else {
                    let onLoad, onError;
                    onLoad = () => {
                        image.removeEventListener('load', onLoad);
                        image.removeEventListener('error', onError);
                        resolve();
                    };
                    onError = () => {
                        image.removeEventListener('load', onLoad);
                        image.removeEventListener('error', onError);
                        reject('Image load error');
                    };
                    image.addEventListener('load', onLoad);
                    image.addEventListener('error', onError);
                }
            });
        }

        /* async */
        static _postWorkerMessage(qrEngineOrQrEnginePromise, type, data) {
            return Promise.resolve(qrEngineOrQrEnginePromise).then((qrEngine) => {
                if (!(qrEngine instanceof Worker)) return;
                qrEngine.postMessage({ type, data });
            });
        }
    }
    QrScanner.DEFAULT_CANVAS_SIZE = 400;
    QrScanner.NO_QR_CODE_FOUND = 'No QR code found';
    QrScanner.WORKER_PATH = 'qr-scanner-worker.min.js';

    const pre = document.getElementById("output");
    const videoElem = document.querySelector("video");
    const qrScanner = new QrScanner(videoElem, result => {
      console.log('decoded qr code:', result);
      pre.textContent = String(result);
    });

    if ("mediaDevices" in navigator && "getUserMedia" in navigator.mediaDevices) {
      console.log("Let's get this party started");
      navigator.mediaDevices
        .getUserMedia({
          video: {
            facingMode: {
              exact: "environment",
            },
          },
        })
        .then((stream) => {
          console.log("got media stream");
          pre.textContent = "got media stream";
          
          videoElem.srcObject = stream;
          qrScanner.start();
        });
    }

}());
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLi4vbm9kZV9tb2R1bGVzL3FyLXNjYW5uZXIvc3JjL3FyLXNjYW5uZXIuanMiLCIuLi9tYWluLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImV4cG9ydCBkZWZhdWx0IGNsYXNzIFFyU2Nhbm5lciB7XG4gICAgLyogYXN5bmMgKi9cbiAgICBzdGF0aWMgaGFzQ2FtZXJhKCkge1xuICAgICAgICBpZiAoIW5hdmlnYXRvci5tZWRpYURldmljZXMpIHJldHVybiBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuICAgICAgICAvLyBub3RlIHRoYXQgZW51bWVyYXRlRGV2aWNlcyBjYW4gYWx3YXlzIGJlIGNhbGxlZCBhbmQgZG9lcyBub3QgcHJvbXB0IHRoZSB1c2VyIGZvciBwZXJtaXNzaW9uLiBIb3dldmVyLCBkZXZpY2VcbiAgICAgICAgLy8gbGFiZWxzIGFyZSBvbmx5IHJlYWRhYmxlIGlmIHNlcnZlZCB2aWEgaHR0cHMgYW5kIGFuIGFjdGl2ZSBtZWRpYSBzdHJlYW0gZXhpc3RzIG9yIHBlcm1hbmVudCBwZXJtaXNzaW9uIGlzXG4gICAgICAgIC8vIGdpdmVuLiBUaGF0IGRvZXNuJ3QgbWF0dGVyIGZvciB1cyB0aG91Z2ggYXMgd2UgZG9uJ3QgcmVxdWlyZSBsYWJlbHMuXG4gICAgICAgIHJldHVybiBuYXZpZ2F0b3IubWVkaWFEZXZpY2VzLmVudW1lcmF0ZURldmljZXMoKVxuICAgICAgICAgICAgLnRoZW4oZGV2aWNlcyA9PiBkZXZpY2VzLnNvbWUoZGV2aWNlID0+IGRldmljZS5raW5kID09PSAndmlkZW9pbnB1dCcpKVxuICAgICAgICAgICAgLmNhdGNoKCgpID0+IGZhbHNlKTtcbiAgICB9XG5cbiAgICBjb25zdHJ1Y3RvcihcbiAgICAgICAgdmlkZW8sXG4gICAgICAgIG9uRGVjb2RlLFxuICAgICAgICBjYW52YXNTaXplT3JPbkRlY29kZUVycm9yID0gdGhpcy5fb25EZWNvZGVFcnJvci5iaW5kKHRoaXMpLFxuICAgICAgICBjYW52YXNTaXplID0gUXJTY2FubmVyLkRFRkFVTFRfQ0FOVkFTX1NJWkUsXG4gICAgICAgIHByZWZlcnJlZEZhY2luZ01vZGUgPSAnZW52aXJvbm1lbnQnXG4gICAgKSB7XG4gICAgICAgIHRoaXMuJHZpZGVvID0gdmlkZW87XG4gICAgICAgIHRoaXMuJGNhbnZhcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xuICAgICAgICB0aGlzLl9vbkRlY29kZSA9IG9uRGVjb2RlO1xuICAgICAgICB0aGlzLl9wcmVmZXJyZWRGYWNpbmdNb2RlID0gcHJlZmVycmVkRmFjaW5nTW9kZTtcbiAgICAgICAgdGhpcy5fYWN0aXZlID0gZmFsc2U7XG4gICAgICAgIHRoaXMuX3BhdXNlZCA9IGZhbHNlO1xuICAgICAgICB0aGlzLl9mbGFzaE9uID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjYW52YXNTaXplT3JPbkRlY29kZUVycm9yID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgLy8gbGVnYWN5IGZ1bmN0aW9uIHNpZ25hdHVyZSB3aGVyZSBjYW52YXMgc2l6ZSBpcyB0aGUgdGhpcmQgYXJndW1lbnRcbiAgICAgICAgICAgIGNhbnZhc1NpemUgPSBjYW52YXNTaXplT3JPbkRlY29kZUVycm9yO1xuICAgICAgICAgICAgY29uc29sZS53YXJuKCdZb3VcXCdyZSB1c2luZyBhIGRlcHJlY2F0ZWQgdmVyc2lvbiBvZiB0aGUgUXJTY2FubmVyIGNvbnN0cnVjdG9yIHdoaWNoIHdpbGwgYmUgcmVtb3ZlZCBpbiAnXG4gICAgICAgICAgICAgICAgKyAndGhlIGZ1dHVyZScpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5fb25EZWNvZGVFcnJvciA9IGNhbnZhc1NpemVPck9uRGVjb2RlRXJyb3I7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLiRjYW52YXMud2lkdGggPSBjYW52YXNTaXplO1xuICAgICAgICB0aGlzLiRjYW52YXMuaGVpZ2h0ID0gY2FudmFzU2l6ZTtcbiAgICAgICAgdGhpcy5fc291cmNlUmVjdCA9IHtcbiAgICAgICAgICAgIHg6IDAsXG4gICAgICAgICAgICB5OiAwLFxuICAgICAgICAgICAgd2lkdGg6IGNhbnZhc1NpemUsXG4gICAgICAgICAgICBoZWlnaHQ6IGNhbnZhc1NpemVcbiAgICAgICAgfTtcblxuICAgICAgICB0aGlzLl91cGRhdGVTb3VyY2VSZWN0ID0gdGhpcy5fdXBkYXRlU291cmNlUmVjdC5iaW5kKHRoaXMpO1xuICAgICAgICB0aGlzLl9vblBsYXkgPSB0aGlzLl9vblBsYXkuYmluZCh0aGlzKTtcbiAgICAgICAgdGhpcy5fb25WaXNpYmlsaXR5Q2hhbmdlID0gdGhpcy5fb25WaXNpYmlsaXR5Q2hhbmdlLmJpbmQodGhpcyk7XG5cbiAgICAgICAgLy8gQWxsb3cgaW5saW5lIHBsYXliYWNrIG9uIGlQaG9uZSBpbnN0ZWFkIG9mIHJlcXVpcmluZyBmdWxsIHNjcmVlbiBwbGF5YmFjayxcbiAgICAgICAgLy8gc2VlIGh0dHBzOi8vd2Via2l0Lm9yZy9ibG9nLzY3ODQvbmV3LXZpZGVvLXBvbGljaWVzLWZvci1pb3MvXG4gICAgICAgIHRoaXMuJHZpZGVvLnBsYXlzSW5saW5lID0gdHJ1ZTtcbiAgICAgICAgLy8gQWxsb3cgcGxheSgpIG9uIGlQaG9uZSB3aXRob3V0IHJlcXVpcmluZyBhIHVzZXIgZ2VzdHVyZS4gU2hvdWxkIG5vdCByZWFsbHkgYmUgbmVlZGVkIGFzIGNhbWVyYSBzdHJlYW1cbiAgICAgICAgLy8gaW5jbHVkZXMgbm8gYXVkaW8sIGJ1dCBqdXN0IHRvIGJlIHNhZmUuXG4gICAgICAgIHRoaXMuJHZpZGVvLm11dGVkID0gdHJ1ZTtcbiAgICAgICAgdGhpcy4kdmlkZW8uZGlzYWJsZVBpY3R1cmVJblBpY3R1cmUgPSB0cnVlO1xuICAgICAgICB0aGlzLiR2aWRlby5hZGRFdmVudExpc3RlbmVyKCdsb2FkZWRtZXRhZGF0YScsIHRoaXMuX3VwZGF0ZVNvdXJjZVJlY3QpO1xuICAgICAgICB0aGlzLiR2aWRlby5hZGRFdmVudExpc3RlbmVyKCdwbGF5JywgdGhpcy5fb25QbGF5KTtcbiAgICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigndmlzaWJpbGl0eWNoYW5nZScsIHRoaXMuX29uVmlzaWJpbGl0eUNoYW5nZSk7XG5cbiAgICAgICAgdGhpcy5fcXJFbmdpbmVQcm9taXNlID0gUXJTY2FubmVyLmNyZWF0ZVFyRW5naW5lKCk7XG4gICAgfVxuXG4gICAgLyogYXN5bmMgKi9cbiAgICBoYXNGbGFzaCgpIHtcbiAgICAgICAgaWYgKCEoJ0ltYWdlQ2FwdHVyZScgaW4gd2luZG93KSkge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShmYWxzZSk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB0cmFjayA9IHRoaXMuJHZpZGVvLnNyY09iamVjdCA/IHRoaXMuJHZpZGVvLnNyY09iamVjdC5nZXRWaWRlb1RyYWNrcygpWzBdIDogbnVsbDtcbiAgICAgICAgaWYgKCF0cmFjaykge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KCdDYW1lcmEgbm90IHN0YXJ0ZWQgb3Igbm90IGF2YWlsYWJsZScpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgaW1hZ2VDYXB0dXJlID0gbmV3IEltYWdlQ2FwdHVyZSh0cmFjayk7XG4gICAgICAgIHJldHVybiBpbWFnZUNhcHR1cmUuZ2V0UGhvdG9DYXBhYmlsaXRpZXMoKVxuICAgICAgICAgICAgLnRoZW4oKHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuZmlsbExpZ2h0TW9kZS5pbmNsdWRlcygnZmxhc2gnKTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc29sZS53YXJuKGVycm9yKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBpc0ZsYXNoT24oKSB7XG4gICAgICByZXR1cm4gdGhpcy5fZmxhc2hPbjtcbiAgICB9XG5cbiAgICAvKiBhc3luYyAqL1xuICAgIHRvZ2dsZUZsYXNoKCkge1xuICAgICAgcmV0dXJuIHRoaXMuX3NldEZsYXNoKCF0aGlzLl9mbGFzaE9uKTtcbiAgICB9XG5cbiAgICAvKiBhc3luYyAqL1xuICAgIHR1cm5GbGFzaE9mZigpIHtcbiAgICAgIHJldHVybiB0aGlzLl9zZXRGbGFzaChmYWxzZSk7XG4gICAgfVxuXG4gICAgLyogYXN5bmMgKi9cbiAgICB0dXJuRmxhc2hPbigpIHtcbiAgICAgIHJldHVybiB0aGlzLl9zZXRGbGFzaCh0cnVlKTtcbiAgICB9XG5cbiAgICBkZXN0cm95KCkge1xuICAgICAgICB0aGlzLiR2aWRlby5yZW1vdmVFdmVudExpc3RlbmVyKCdsb2FkZWRtZXRhZGF0YScsIHRoaXMuX3VwZGF0ZVNvdXJjZVJlY3QpO1xuICAgICAgICB0aGlzLiR2aWRlby5yZW1vdmVFdmVudExpc3RlbmVyKCdwbGF5JywgdGhpcy5fb25QbGF5KTtcbiAgICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcigndmlzaWJpbGl0eWNoYW5nZScsIHRoaXMuX29uVmlzaWJpbGl0eUNoYW5nZSk7XG5cbiAgICAgICAgdGhpcy5zdG9wKCk7XG4gICAgICAgIFFyU2Nhbm5lci5fcG9zdFdvcmtlck1lc3NhZ2UodGhpcy5fcXJFbmdpbmVQcm9taXNlLCAnY2xvc2UnKTtcbiAgICB9XG5cbiAgICAvKiBhc3luYyAqL1xuICAgIHN0YXJ0KCkge1xuICAgICAgICBpZiAodGhpcy5fYWN0aXZlICYmICF0aGlzLl9wYXVzZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAod2luZG93LmxvY2F0aW9uLnByb3RvY29sICE9PSAnaHR0cHM6Jykge1xuICAgICAgICAgICAgLy8gd2FybiBidXQgdHJ5IHN0YXJ0aW5nIHRoZSBjYW1lcmEgYW55d2F5c1xuICAgICAgICAgICAgY29uc29sZS53YXJuKCdUaGUgY2FtZXJhIHN0cmVhbSBpcyBvbmx5IGFjY2Vzc2libGUgaWYgdGhlIHBhZ2UgaXMgdHJhbnNmZXJyZWQgdmlhIGh0dHBzLicpO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuX2FjdGl2ZSA9IHRydWU7XG4gICAgICAgIHRoaXMuX3BhdXNlZCA9IGZhbHNlO1xuICAgICAgICBpZiAoZG9jdW1lbnQuaGlkZGVuKSB7XG4gICAgICAgICAgICAvLyBjYW1lcmEgd2lsbCBiZSBzdGFydGVkIGFzIHNvb24gYXMgdGFiIGlzIGluIGZvcmVncm91bmRcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgICBjbGVhclRpbWVvdXQodGhpcy5fb2ZmVGltZW91dCk7XG4gICAgICAgIHRoaXMuX29mZlRpbWVvdXQgPSBudWxsO1xuICAgICAgICBpZiAodGhpcy4kdmlkZW8uc3JjT2JqZWN0KSB7XG4gICAgICAgICAgICAvLyBjYW1lcmEgc3RyZWFtIGFscmVhZHkvc3RpbGwgc2V0XG4gICAgICAgICAgICB0aGlzLiR2aWRlby5wbGF5KCk7XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZmFjaW5nTW9kZSA9IHRoaXMuX3ByZWZlcnJlZEZhY2luZ01vZGU7XG4gICAgICAgIHJldHVybiB0aGlzLl9nZXRDYW1lcmFTdHJlYW0oZmFjaW5nTW9kZSwgdHJ1ZSlcbiAgICAgICAgICAgIC5jYXRjaCgoKSA9PiB7XG4gICAgICAgICAgICAgICAgLy8gV2UgKHByb2JhYmx5KSBkb24ndCBoYXZlIGEgY2FtZXJhIG9mIHRoZSByZXF1ZXN0ZWQgZmFjaW5nIG1vZGVcbiAgICAgICAgICAgICAgICBmYWNpbmdNb2RlID0gZmFjaW5nTW9kZSA9PT0gJ2Vudmlyb25tZW50JyA/ICd1c2VyJyA6ICdlbnZpcm9ubWVudCc7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2dldENhbWVyYVN0cmVhbSgpOyAvLyB0aHJvd3MgaWYgY2FtZXJhIGlzIG5vdCBhY2Nlc3NpYmxlIChlLmcuIGR1ZSB0byBub3QgaHR0cHMpXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLnRoZW4oc3RyZWFtID0+IHtcbiAgICAgICAgICAgICAgICAvLyBUcnkgdG8gZGV0ZXJtaW5lIHRoZSBmYWNpbmcgbW9kZSBmcm9tIHRoZSBzdHJlYW0sIG90aGVyd2lzZSB1c2Ugb3VyIGd1ZXNzLiBOb3RlIHRoYXQgdGhlIGd1ZXNzIGlzIG5vdFxuICAgICAgICAgICAgICAgIC8vIGFsd2F5cyBhY2N1cmF0ZSBhcyBTYWZhcmkgcmV0dXJucyBjYW1lcmFzIG9mIGRpZmZlcmVudCBmYWNpbmcgbW9kZSwgZXZlbiBmb3IgZXhhY3QgY29uc3RyYWludHMuXG4gICAgICAgICAgICAgICAgZmFjaW5nTW9kZSA9IHRoaXMuX2dldEZhY2luZ01vZGUoc3RyZWFtKSB8fCBmYWNpbmdNb2RlO1xuICAgICAgICAgICAgICAgIHRoaXMuJHZpZGVvLnNyY09iamVjdCA9IHN0cmVhbTtcbiAgICAgICAgICAgICAgICB0aGlzLiR2aWRlby5wbGF5KCk7XG4gICAgICAgICAgICAgICAgdGhpcy5fc2V0VmlkZW9NaXJyb3IoZmFjaW5nTW9kZSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgLmNhdGNoKGUgPT4ge1xuICAgICAgICAgICAgICAgIHRoaXMuX2FjdGl2ZSA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIHRocm93IGU7XG4gICAgICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzdG9wKCkge1xuICAgICAgICB0aGlzLnBhdXNlKCk7XG4gICAgICAgIHRoaXMuX2FjdGl2ZSA9IGZhbHNlO1xuICAgIH1cblxuICAgIHBhdXNlKCkge1xuICAgICAgICB0aGlzLl9wYXVzZWQgPSB0cnVlO1xuICAgICAgICBpZiAoIXRoaXMuX2FjdGl2ZSkge1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuJHZpZGVvLnBhdXNlKCk7XG4gICAgICAgIGlmICh0aGlzLl9vZmZUaW1lb3V0KSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fb2ZmVGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgdHJhY2tzID0gdGhpcy4kdmlkZW8uc3JjT2JqZWN0ID8gdGhpcy4kdmlkZW8uc3JjT2JqZWN0LmdldFRyYWNrcygpIDogW107XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRyYWNrIG9mIHRyYWNrcykge1xuICAgICAgICAgICAgICAgIHRyYWNrLnN0b3AoKTsgLy8gIG5vdGUgdGhhdCB0aGlzIHdpbGwgYWxzbyBhdXRvbWF0aWNhbGx5IHR1cm4gdGhlIGZsYXNobGlnaHQgb2ZmXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLiR2aWRlby5zcmNPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgdGhpcy5fb2ZmVGltZW91dCA9IG51bGw7XG4gICAgICAgIH0sIDMwMCk7XG4gICAgfVxuXG4gICAgLyogYXN5bmMgKi9cbiAgICBzdGF0aWMgc2NhbkltYWdlKGltYWdlT3JGaWxlT3JVcmwsIHNvdXJjZVJlY3Q9bnVsbCwgcXJFbmdpbmU9bnVsbCwgY2FudmFzPW51bGwsIGZpeGVkQ2FudmFzU2l6ZT1mYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgIGFsc29UcnlXaXRob3V0U291cmNlUmVjdD1mYWxzZSkge1xuICAgICAgICBjb25zdCBnb3RFeHRlcm5hbFdvcmtlciA9IHFyRW5naW5lIGluc3RhbmNlb2YgV29ya2VyO1xuXG4gICAgICAgIGxldCBwcm9taXNlID0gUHJvbWlzZS5hbGwoW1xuICAgICAgICAgICAgcXJFbmdpbmUgfHwgUXJTY2FubmVyLmNyZWF0ZVFyRW5naW5lKCksXG4gICAgICAgICAgICBRclNjYW5uZXIuX2xvYWRJbWFnZShpbWFnZU9yRmlsZU9yVXJsKSxcbiAgICAgICAgXSkudGhlbigoW2VuZ2luZSwgaW1hZ2VdKSA9PiB7XG4gICAgICAgICAgICBxckVuZ2luZSA9IGVuZ2luZTtcbiAgICAgICAgICAgIGxldCBjYW52YXNDb250ZXh0O1xuICAgICAgICAgICAgW2NhbnZhcywgY2FudmFzQ29udGV4dF0gPSB0aGlzLl9kcmF3VG9DYW52YXMoaW1hZ2UsIHNvdXJjZVJlY3QsIGNhbnZhcywgZml4ZWRDYW52YXNTaXplKTtcblxuICAgICAgICAgICAgaWYgKHFyRW5naW5lIGluc3RhbmNlb2YgV29ya2VyKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFnb3RFeHRlcm5hbFdvcmtlcikge1xuICAgICAgICAgICAgICAgICAgICAvLyBFbmFibGUgc2Nhbm5pbmcgb2YgaW52ZXJ0ZWQgY29sb3IgcXIgY29kZXMuIE5vdCB1c2luZyBfcG9zdFdvcmtlck1lc3NhZ2UgYXMgaXQncyBhc3luY1xuICAgICAgICAgICAgICAgICAgICBxckVuZ2luZS5wb3N0TWVzc2FnZSh7IHR5cGU6ICdpbnZlcnNpb25Nb2RlJywgZGF0YTogJ2JvdGgnIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBsZXQgdGltZW91dCwgb25NZXNzYWdlLCBvbkVycm9yO1xuICAgICAgICAgICAgICAgICAgICBvbk1lc3NhZ2UgPSBldmVudCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoZXZlbnQuZGF0YS50eXBlICE9PSAncXJSZXN1bHQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgcXJFbmdpbmUucmVtb3ZlRXZlbnRMaXN0ZW5lcignbWVzc2FnZScsIG9uTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBxckVuZ2luZS5yZW1vdmVFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uRXJyb3IpO1xuICAgICAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGV2ZW50LmRhdGEuZGF0YSAhPT0gbnVsbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlc29sdmUoZXZlbnQuZGF0YS5kYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVqZWN0KFFyU2Nhbm5lci5OT19RUl9DT0RFX0ZPVU5EKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICAgICAgb25FcnJvciA9IChlKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBxckVuZ2luZS5yZW1vdmVFdmVudExpc3RlbmVyKCdtZXNzYWdlJywgb25NZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHFyRW5naW5lLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgb25FcnJvcik7XG4gICAgICAgICAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zdCBlcnJvck1lc3NhZ2UgPSAhZSA/ICdVbmtub3duIEVycm9yJyA6IChlLm1lc3NhZ2UgfHwgZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWplY3QoJ1NjYW5uZXIgZXJyb3I6ICcgKyBlcnJvck1lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgICAgICBxckVuZ2luZS5hZGRFdmVudExpc3RlbmVyKCdtZXNzYWdlJywgb25NZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgcXJFbmdpbmUuYWRkRXZlbnRMaXN0ZW5lcignZXJyb3InLCBvbkVycm9yKTtcbiAgICAgICAgICAgICAgICAgICAgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gb25FcnJvcigndGltZW91dCcpLCAxMDAwMCk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGltYWdlRGF0YSA9IGNhbnZhc0NvbnRleHQuZ2V0SW1hZ2VEYXRhKDAsIDAsIGNhbnZhcy53aWR0aCwgY2FudmFzLmhlaWdodCk7XG4gICAgICAgICAgICAgICAgICAgIHFyRW5naW5lLnBvc3RNZXNzYWdlKHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHR5cGU6ICdkZWNvZGUnLFxuICAgICAgICAgICAgICAgICAgICAgICAgZGF0YTogaW1hZ2VEYXRhXG4gICAgICAgICAgICAgICAgICAgIH0sIFtpbWFnZURhdGEuZGF0YS5idWZmZXJdKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoKCkgPT4gcmVqZWN0KCdTY2FubmVyIGVycm9yOiB0aW1lb3V0JyksIDEwMDAwKTtcbiAgICAgICAgICAgICAgICAgICAgcXJFbmdpbmUuZGV0ZWN0KGNhbnZhcykudGhlbihzY2FuUmVzdWx0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIXNjYW5SZXN1bHRzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlamVjdChRclNjYW5uZXIuTk9fUVJfQ09ERV9GT1VORCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlc29sdmUoc2NhblJlc3VsdHNbMF0ucmF3VmFsdWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9KS5jYXRjaCgoZSkgPT4gcmVqZWN0KCdTY2FubmVyIGVycm9yOiAnICsgKGUubWVzc2FnZSB8fCBlKSkpLmZpbmFsbHkoKCkgPT4gY2xlYXJUaW1lb3V0KHRpbWVvdXQpKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHNvdXJjZVJlY3QgJiYgYWxzb1RyeVdpdGhvdXRTb3VyY2VSZWN0KSB7XG4gICAgICAgICAgICBwcm9taXNlID0gcHJvbWlzZS5jYXRjaCgoKSA9PiBRclNjYW5uZXIuc2NhbkltYWdlKGltYWdlT3JGaWxlT3JVcmwsIG51bGwsIHFyRW5naW5lLCBjYW52YXMsIGZpeGVkQ2FudmFzU2l6ZSkpO1xuICAgICAgICB9XG5cbiAgICAgICAgcHJvbWlzZSA9IHByb21pc2UuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgICBpZiAoZ290RXh0ZXJuYWxXb3JrZXIpIHJldHVybjtcbiAgICAgICAgICAgIFFyU2Nhbm5lci5fcG9zdFdvcmtlck1lc3NhZ2UocXJFbmdpbmUsICdjbG9zZScpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICB9XG5cbiAgICBzZXRHcmF5c2NhbGVXZWlnaHRzKHJlZCwgZ3JlZW4sIGJsdWUsIHVzZUludGVnZXJBcHByb3hpbWF0aW9uID0gdHJ1ZSkge1xuICAgICAgICAvLyBOb3RlIHRoYXQgZm9yIHRoZSBuYXRpdmUgQmFyY29kZURlY29kZXIsIHRoaXMgaXMgYSBuby1vcC4gSG93ZXZlciwgdGhlIG5hdGl2ZSBpbXBsZW1lbnRhdGlvbnMgd29yayBhbHNvXG4gICAgICAgIC8vIHdlbGwgd2l0aCBjb2xvcmVkIHFyIGNvZGVzLlxuICAgICAgICBRclNjYW5uZXIuX3Bvc3RXb3JrZXJNZXNzYWdlKFxuICAgICAgICAgICAgdGhpcy5fcXJFbmdpbmVQcm9taXNlLFxuICAgICAgICAgICAgJ2dyYXlzY2FsZVdlaWdodHMnLFxuICAgICAgICAgICAgeyByZWQsIGdyZWVuLCBibHVlLCB1c2VJbnRlZ2VyQXBwcm94aW1hdGlvbiB9XG4gICAgICAgICk7XG4gICAgfVxuXG4gICAgc2V0SW52ZXJzaW9uTW9kZShpbnZlcnNpb25Nb2RlKSB7XG4gICAgICAgIC8vIE5vdGUgdGhhdCBmb3IgdGhlIG5hdGl2ZSBCYXJjb2RlRGVjb2RlciwgdGhpcyBpcyBhIG5vLW9wLiBIb3dldmVyLCB0aGUgbmF0aXZlIGltcGxlbWVudGF0aW9ucyBzY2FuIG5vcm1hbFxuICAgICAgICAvLyBhbmQgaW52ZXJ0ZWQgcXIgY29kZXMgYnkgZGVmYXVsdFxuICAgICAgICBRclNjYW5uZXIuX3Bvc3RXb3JrZXJNZXNzYWdlKHRoaXMuX3FyRW5naW5lUHJvbWlzZSwgJ2ludmVyc2lvbk1vZGUnLCBpbnZlcnNpb25Nb2RlKTtcbiAgICB9XG5cbiAgICAvKiBhc3luYyAqL1xuICAgIHN0YXRpYyBjcmVhdGVRckVuZ2luZSh3b3JrZXJQYXRoID0gUXJTY2FubmVyLldPUktFUl9QQVRIKSB7XG4gICAgICAgIHJldHVybiAoJ0JhcmNvZGVEZXRlY3RvcicgaW4gd2luZG93ID8gQmFyY29kZURldGVjdG9yLmdldFN1cHBvcnRlZEZvcm1hdHMoKSA6IFByb21pc2UucmVzb2x2ZShbXSkpXG4gICAgICAgICAgICAudGhlbigoc3VwcG9ydGVkRm9ybWF0cykgPT4gc3VwcG9ydGVkRm9ybWF0cy5pbmRleE9mKCdxcl9jb2RlJykgIT09IC0xXG4gICAgICAgICAgICAgICAgPyBuZXcgQmFyY29kZURldGVjdG9yKHsgZm9ybWF0czogWydxcl9jb2RlJ10gfSlcbiAgICAgICAgICAgICAgICA6IG5ldyBXb3JrZXIod29ya2VyUGF0aClcbiAgICAgICAgICAgICk7XG4gICAgfVxuXG4gICAgX29uUGxheSgpIHtcbiAgICAgICAgdGhpcy5fdXBkYXRlU291cmNlUmVjdCgpO1xuICAgICAgICB0aGlzLl9zY2FuRnJhbWUoKTtcbiAgICB9XG5cbiAgICBfb25WaXNpYmlsaXR5Q2hhbmdlKCkge1xuICAgICAgICBpZiAoZG9jdW1lbnQuaGlkZGVuKSB7XG4gICAgICAgICAgICB0aGlzLnBhdXNlKCk7XG4gICAgICAgIH0gZWxzZSBpZiAodGhpcy5fYWN0aXZlKSB7XG4gICAgICAgICAgICB0aGlzLnN0YXJ0KCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfdXBkYXRlU291cmNlUmVjdCgpIHtcbiAgICAgICAgY29uc3Qgc21hbGxlc3REaW1lbnNpb24gPSBNYXRoLm1pbih0aGlzLiR2aWRlby52aWRlb1dpZHRoLCB0aGlzLiR2aWRlby52aWRlb0hlaWdodCk7XG4gICAgICAgIGNvbnN0IHNvdXJjZVJlY3RTaXplID0gTWF0aC5yb3VuZCgyIC8gMyAqIHNtYWxsZXN0RGltZW5zaW9uKTtcbiAgICAgICAgdGhpcy5fc291cmNlUmVjdC53aWR0aCA9IHRoaXMuX3NvdXJjZVJlY3QuaGVpZ2h0ID0gc291cmNlUmVjdFNpemU7XG4gICAgICAgIHRoaXMuX3NvdXJjZVJlY3QueCA9ICh0aGlzLiR2aWRlby52aWRlb1dpZHRoIC0gc291cmNlUmVjdFNpemUpIC8gMjtcbiAgICAgICAgdGhpcy5fc291cmNlUmVjdC55ID0gKHRoaXMuJHZpZGVvLnZpZGVvSGVpZ2h0IC0gc291cmNlUmVjdFNpemUpIC8gMjtcbiAgICB9XG5cbiAgICBfc2NhbkZyYW1lKCkge1xuICAgICAgICBpZiAoIXRoaXMuX2FjdGl2ZSB8fCB0aGlzLiR2aWRlby5wYXVzZWQgfHwgdGhpcy4kdmlkZW8uZW5kZWQpIHJldHVybiBmYWxzZTtcbiAgICAgICAgLy8gdXNpbmcgcmVxdWVzdEFuaW1hdGlvbkZyYW1lIHRvIGF2b2lkIHNjYW5uaW5nIGlmIHRhYiBpcyBpbiBiYWNrZ3JvdW5kXG4gICAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICAgICAgICBpZiAodGhpcy4kdmlkZW8ucmVhZHlTdGF0ZSA8PSAxKSB7XG4gICAgICAgICAgICAgICAgLy8gU2tpcCBzY2FucyB1bnRpbCB0aGUgdmlkZW8gaXMgcmVhZHkgYXMgZHJhd0ltYWdlKCkgb25seSB3b3JrcyBjb3JyZWN0bHkgb24gYSB2aWRlbyB3aXRoIHJlYWR5U3RhdGVcbiAgICAgICAgICAgICAgICAvLyA+IDEsIHNlZSBodHRwczovL2RldmVsb3Blci5tb3ppbGxhLm9yZy9lbi1VUy9kb2NzL1dlYi9BUEkvQ2FudmFzUmVuZGVyaW5nQ29udGV4dDJEL2RyYXdJbWFnZSNOb3Rlcy5cbiAgICAgICAgICAgICAgICAvLyBUaGlzIGFsc28gYXZvaWRzIGZhbHNlIHBvc2l0aXZlcyBmb3IgdmlkZW9zIHBhdXNlZCBhZnRlciBhIHN1Y2Nlc3NmdWwgc2NhbiB3aGljaCByZW1haW5zIHZpc2libGUgb25cbiAgICAgICAgICAgICAgICAvLyB0aGUgY2FudmFzIHVudGlsIHRoZSB2aWRlbyBpcyBzdGFydGVkIGFnYWluIGFuZCByZWFkeS5cbiAgICAgICAgICAgICAgICB0aGlzLl9zY2FuRnJhbWUoKTtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aGlzLl9xckVuZ2luZVByb21pc2VcbiAgICAgICAgICAgICAgICAudGhlbigocXJFbmdpbmUpID0+IFFyU2Nhbm5lci5zY2FuSW1hZ2UodGhpcy4kdmlkZW8sIHRoaXMuX3NvdXJjZVJlY3QsIHFyRW5naW5lLCB0aGlzLiRjYW52YXMsIHRydWUpKVxuICAgICAgICAgICAgICAgIC50aGVuKHRoaXMuX29uRGVjb2RlLCAoZXJyb3IpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF0aGlzLl9hY3RpdmUpIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gZXJyb3IubWVzc2FnZSB8fCBlcnJvcjtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGVycm9yTWVzc2FnZS5pbmRleE9mKCdzZXJ2aWNlIHVuYXZhaWxhYmxlJykgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBXaGVuIHRoZSBuYXRpdmUgQmFyY29kZURldGVjdG9yIGNyYXNoZWQsIGNyZWF0ZSBhIG5ldyBvbmVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3FyRW5naW5lUHJvbWlzZSA9IFFyU2Nhbm5lci5jcmVhdGVRckVuZ2luZSgpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX29uRGVjb2RlRXJyb3IoZXJyb3IpO1xuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgLnRoZW4oKCkgPT4gdGhpcy5fc2NhbkZyYW1lKCkpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBfb25EZWNvZGVFcnJvcihlcnJvcikge1xuICAgICAgICAvLyBkZWZhdWx0IGVycm9yIGhhbmRsZXI7IGNhbiBiZSBvdmVyd3JpdHRlbiBpbiB0aGUgY29uc3RydWN0b3JcbiAgICAgICAgaWYgKGVycm9yID09PSBRclNjYW5uZXIuTk9fUVJfQ09ERV9GT1VORCkgcmV0dXJuO1xuICAgICAgICBjb25zb2xlLmxvZyhlcnJvcik7XG4gICAgfVxuXG4gICAgX2dldENhbWVyYVN0cmVhbShmYWNpbmdNb2RlLCBleGFjdCA9IGZhbHNlKSB7XG4gICAgICAgIGNvbnN0IGNvbnN0cmFpbnRzVG9UcnkgPSBbe1xuICAgICAgICAgICAgd2lkdGg6IHsgbWluOiAxMDI0IH1cbiAgICAgICAgfSwge1xuICAgICAgICAgICAgd2lkdGg6IHsgbWluOiA3NjggfVxuICAgICAgICB9LCB7fV07XG5cbiAgICAgICAgaWYgKGZhY2luZ01vZGUpIHtcbiAgICAgICAgICAgIGlmIChleGFjdCkge1xuICAgICAgICAgICAgICAgIGZhY2luZ01vZGUgPSB7IGV4YWN0OiBmYWNpbmdNb2RlIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdHJhaW50c1RvVHJ5LmZvckVhY2goY29uc3RyYWludCA9PiBjb25zdHJhaW50LmZhY2luZ01vZGUgPSBmYWNpbmdNb2RlKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdGhpcy5fZ2V0TWF0Y2hpbmdDYW1lcmFTdHJlYW0oY29uc3RyYWludHNUb1RyeSk7XG4gICAgfVxuXG4gICAgX2dldE1hdGNoaW5nQ2FtZXJhU3RyZWFtKGNvbnN0cmFpbnRzVG9UcnkpIHtcbiAgICAgICAgaWYgKCFuYXZpZ2F0b3IubWVkaWFEZXZpY2VzIHx8IGNvbnN0cmFpbnRzVG9UcnkubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoJ0NhbWVyYSBub3QgZm91bmQuJyk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5hdmlnYXRvci5tZWRpYURldmljZXMuZ2V0VXNlck1lZGlhKHtcbiAgICAgICAgICAgIHZpZGVvOiBjb25zdHJhaW50c1RvVHJ5LnNoaWZ0KClcbiAgICAgICAgfSkuY2F0Y2goKCkgPT4gdGhpcy5fZ2V0TWF0Y2hpbmdDYW1lcmFTdHJlYW0oY29uc3RyYWludHNUb1RyeSkpO1xuICAgIH1cblxuICAgIC8qIGFzeW5jICovXG4gICAgX3NldEZsYXNoKG9uKSB7XG4gICAgICAgIHJldHVybiB0aGlzLmhhc0ZsYXNoKCkudGhlbigoaGFzRmxhc2gpID0+IHtcbiAgICAgICAgICAgIGlmICghaGFzRmxhc2gpIHJldHVybiBQcm9taXNlLnJlamVjdCgnTm8gZmxhc2ggYXZhaWxhYmxlJyk7XG4gICAgICAgICAgICAvLyBOb3RlIHRoYXQgdGhlIHZpZGVvIHRyYWNrIGlzIGd1YXJhbnRlZWQgdG8gZXhpc3QgYXQgdGhpcyBwb2ludFxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuJHZpZGVvLnNyY09iamVjdC5nZXRWaWRlb1RyYWNrcygpWzBdLmFwcGx5Q29uc3RyYWludHMoe1xuICAgICAgICAgICAgICAgIGFkdmFuY2VkOiBbeyB0b3JjaDogb24gfV0sXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSkudGhlbigoKSA9PiB0aGlzLl9mbGFzaE9uID0gb24pO1xuICAgIH1cblxuICAgIF9zZXRWaWRlb01pcnJvcihmYWNpbmdNb2RlKSB7XG4gICAgICAgIC8vIGluIHVzZXIgZmFjaW5nIG1vZGUgbWlycm9yIHRoZSB2aWRlbyB0byBtYWtlIGl0IGVhc2llciBmb3IgdGhlIHVzZXIgdG8gcG9zaXRpb24gdGhlIFFSIGNvZGVcbiAgICAgICAgY29uc3Qgc2NhbGVGYWN0b3IgPSBmYWNpbmdNb2RlPT09J3VzZXInPyAtMSA6IDE7XG4gICAgICAgIHRoaXMuJHZpZGVvLnN0eWxlLnRyYW5zZm9ybSA9ICdzY2FsZVgoJyArIHNjYWxlRmFjdG9yICsgJyknO1xuICAgIH1cblxuICAgIF9nZXRGYWNpbmdNb2RlKHZpZGVvU3RyZWFtKSB7XG4gICAgICAgIGNvbnN0IHZpZGVvVHJhY2sgPSB2aWRlb1N0cmVhbS5nZXRWaWRlb1RyYWNrcygpWzBdO1xuICAgICAgICBpZiAoIXZpZGVvVHJhY2spIHJldHVybiBudWxsOyAvLyB1bmtub3duXG4gICAgICAgIC8vIGluc3BpcmVkIGJ5IGh0dHBzOi8vZ2l0aHViLmNvbS9Kb2R1c05vZHVzL3JlYWN0LXFyLXJlYWRlci9ibG9iL21hc3Rlci9zcmMvZ2V0RGV2aWNlSWQuanMjTDEzXG4gICAgICAgIHJldHVybiAvcmVhcnxiYWNrfGVudmlyb25tZW50L2kudGVzdCh2aWRlb1RyYWNrLmxhYmVsKVxuICAgICAgICAgICAgPyAnZW52aXJvbm1lbnQnXG4gICAgICAgICAgICA6IC9mcm9udHx1c2VyfGZhY2UvaS50ZXN0KHZpZGVvVHJhY2subGFiZWwpXG4gICAgICAgICAgICAgICAgPyAndXNlcidcbiAgICAgICAgICAgICAgICA6IG51bGw7IC8vIHVua25vd25cbiAgICB9XG5cbiAgICBzdGF0aWMgX2RyYXdUb0NhbnZhcyhpbWFnZSwgc291cmNlUmVjdD1udWxsLCBjYW52YXM9bnVsbCwgZml4ZWRDYW52YXNTaXplPWZhbHNlKSB7XG4gICAgICAgIGNhbnZhcyA9IGNhbnZhcyB8fCBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdjYW52YXMnKTtcbiAgICAgICAgY29uc3Qgc291cmNlUmVjdFggPSBzb3VyY2VSZWN0ICYmIHNvdXJjZVJlY3QueD8gc291cmNlUmVjdC54IDogMDtcbiAgICAgICAgY29uc3Qgc291cmNlUmVjdFkgPSBzb3VyY2VSZWN0ICYmIHNvdXJjZVJlY3QueT8gc291cmNlUmVjdC55IDogMDtcbiAgICAgICAgY29uc3Qgc291cmNlUmVjdFdpZHRoID0gc291cmNlUmVjdCAmJiBzb3VyY2VSZWN0LndpZHRoPyBzb3VyY2VSZWN0LndpZHRoIDogaW1hZ2Uud2lkdGggfHwgaW1hZ2UudmlkZW9XaWR0aDtcbiAgICAgICAgY29uc3Qgc291cmNlUmVjdEhlaWdodCA9IHNvdXJjZVJlY3QgJiYgc291cmNlUmVjdC5oZWlnaHQ/IHNvdXJjZVJlY3QuaGVpZ2h0IDogaW1hZ2UuaGVpZ2h0IHx8IGltYWdlLnZpZGVvSGVpZ2h0O1xuICAgICAgICBpZiAoIWZpeGVkQ2FudmFzU2l6ZSAmJiAoY2FudmFzLndpZHRoICE9PSBzb3VyY2VSZWN0V2lkdGggfHwgY2FudmFzLmhlaWdodCAhPT0gc291cmNlUmVjdEhlaWdodCkpIHtcbiAgICAgICAgICAgIGNhbnZhcy53aWR0aCA9IHNvdXJjZVJlY3RXaWR0aDtcbiAgICAgICAgICAgIGNhbnZhcy5oZWlnaHQgPSBzb3VyY2VSZWN0SGVpZ2h0O1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGNvbnRleHQgPSBjYW52YXMuZ2V0Q29udGV4dCgnMmQnLCB7IGFscGhhOiBmYWxzZSB9KTtcbiAgICAgICAgY29udGV4dC5pbWFnZVNtb290aGluZ0VuYWJsZWQgPSBmYWxzZTsgLy8gZ2l2ZXMgbGVzcyBibHVycnkgaW1hZ2VzXG4gICAgICAgIGNvbnRleHQuZHJhd0ltYWdlKGltYWdlLCBzb3VyY2VSZWN0WCwgc291cmNlUmVjdFksIHNvdXJjZVJlY3RXaWR0aCwgc291cmNlUmVjdEhlaWdodCwgMCwgMCwgY2FudmFzLndpZHRoLCBjYW52YXMuaGVpZ2h0KTtcbiAgICAgICAgcmV0dXJuIFtjYW52YXMsIGNvbnRleHRdO1xuICAgIH1cblxuICAgIC8qIGFzeW5jICovXG4gICAgc3RhdGljIF9sb2FkSW1hZ2UoaW1hZ2VPckZpbGVPckJsb2JPclVybCkge1xuICAgICAgICBpZiAoaW1hZ2VPckZpbGVPckJsb2JPclVybCBpbnN0YW5jZW9mIEhUTUxDYW52YXNFbGVtZW50IHx8IGltYWdlT3JGaWxlT3JCbG9iT3JVcmwgaW5zdGFuY2VvZiBIVE1MVmlkZW9FbGVtZW50XG4gICAgICAgICAgICB8fCB3aW5kb3cuSW1hZ2VCaXRtYXAgJiYgaW1hZ2VPckZpbGVPckJsb2JPclVybCBpbnN0YW5jZW9mIHdpbmRvdy5JbWFnZUJpdG1hcFxuICAgICAgICAgICAgfHwgd2luZG93Lk9mZnNjcmVlbkNhbnZhcyAmJiBpbWFnZU9yRmlsZU9yQmxvYk9yVXJsIGluc3RhbmNlb2Ygd2luZG93Lk9mZnNjcmVlbkNhbnZhcykge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShpbWFnZU9yRmlsZU9yQmxvYk9yVXJsKTtcbiAgICAgICAgfSBlbHNlIGlmIChpbWFnZU9yRmlsZU9yQmxvYk9yVXJsIGluc3RhbmNlb2YgSW1hZ2UpIHtcbiAgICAgICAgICAgIHJldHVybiBRclNjYW5uZXIuX2F3YWl0SW1hZ2VMb2FkKGltYWdlT3JGaWxlT3JCbG9iT3JVcmwpLnRoZW4oKCkgPT4gaW1hZ2VPckZpbGVPckJsb2JPclVybCk7XG4gICAgICAgIH0gZWxzZSBpZiAoaW1hZ2VPckZpbGVPckJsb2JPclVybCBpbnN0YW5jZW9mIEZpbGUgfHwgaW1hZ2VPckZpbGVPckJsb2JPclVybCBpbnN0YW5jZW9mIEJsb2JcbiAgICAgICAgICAgIHx8IGltYWdlT3JGaWxlT3JCbG9iT3JVcmwgaW5zdGFuY2VvZiBVUkwgfHwgdHlwZW9mKGltYWdlT3JGaWxlT3JCbG9iT3JVcmwpPT09J3N0cmluZycpIHtcbiAgICAgICAgICAgIGNvbnN0IGltYWdlID0gbmV3IEltYWdlKCk7XG4gICAgICAgICAgICBpZiAoaW1hZ2VPckZpbGVPckJsb2JPclVybCBpbnN0YW5jZW9mIEZpbGUgfHwgaW1hZ2VPckZpbGVPckJsb2JPclVybCBpbnN0YW5jZW9mIEJsb2IpIHtcbiAgICAgICAgICAgICAgICBpbWFnZS5zcmMgPSBVUkwuY3JlYXRlT2JqZWN0VVJMKGltYWdlT3JGaWxlT3JCbG9iT3JVcmwpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpbWFnZS5zcmMgPSBpbWFnZU9yRmlsZU9yQmxvYk9yVXJsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIFFyU2Nhbm5lci5fYXdhaXRJbWFnZUxvYWQoaW1hZ2UpLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChpbWFnZU9yRmlsZU9yQmxvYk9yVXJsIGluc3RhbmNlb2YgRmlsZSB8fCBpbWFnZU9yRmlsZU9yQmxvYk9yVXJsIGluc3RhbmNlb2YgQmxvYikge1xuICAgICAgICAgICAgICAgICAgICBVUkwucmV2b2tlT2JqZWN0VVJMKGltYWdlLnNyYyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBpbWFnZTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIFByb21pc2UucmVqZWN0KCdVbnN1cHBvcnRlZCBpbWFnZSB0eXBlLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyogYXN5bmMgKi9cbiAgICBzdGF0aWMgX2F3YWl0SW1hZ2VMb2FkKGltYWdlKSB7XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICBpZiAoaW1hZ2UuY29tcGxldGUgJiYgaW1hZ2UubmF0dXJhbFdpZHRoIT09MCkge1xuICAgICAgICAgICAgICAgIC8vIGFscmVhZHkgbG9hZGVkXG4gICAgICAgICAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBsZXQgb25Mb2FkLCBvbkVycm9yO1xuICAgICAgICAgICAgICAgIG9uTG9hZCA9ICgpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaW1hZ2UucmVtb3ZlRXZlbnRMaXN0ZW5lcignbG9hZCcsIG9uTG9hZCk7XG4gICAgICAgICAgICAgICAgICAgIGltYWdlLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgb25FcnJvcik7XG4gICAgICAgICAgICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIG9uRXJyb3IgPSAoKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGltYWdlLnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2xvYWQnLCBvbkxvYWQpO1xuICAgICAgICAgICAgICAgICAgICBpbWFnZS5yZW1vdmVFdmVudExpc3RlbmVyKCdlcnJvcicsIG9uRXJyb3IpO1xuICAgICAgICAgICAgICAgICAgICByZWplY3QoJ0ltYWdlIGxvYWQgZXJyb3InKTtcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIGltYWdlLmFkZEV2ZW50TGlzdGVuZXIoJ2xvYWQnLCBvbkxvYWQpO1xuICAgICAgICAgICAgICAgIGltYWdlLmFkZEV2ZW50TGlzdGVuZXIoJ2Vycm9yJywgb25FcnJvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qIGFzeW5jICovXG4gICAgc3RhdGljIF9wb3N0V29ya2VyTWVzc2FnZShxckVuZ2luZU9yUXJFbmdpbmVQcm9taXNlLCB0eXBlLCBkYXRhKSB7XG4gICAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUocXJFbmdpbmVPclFyRW5naW5lUHJvbWlzZSkudGhlbigocXJFbmdpbmUpID0+IHtcbiAgICAgICAgICAgIGlmICghKHFyRW5naW5lIGluc3RhbmNlb2YgV29ya2VyKSkgcmV0dXJuO1xuICAgICAgICAgICAgcXJFbmdpbmUucG9zdE1lc3NhZ2UoeyB0eXBlLCBkYXRhIH0pO1xuICAgICAgICB9KTtcbiAgICB9XG59XG5RclNjYW5uZXIuREVGQVVMVF9DQU5WQVNfU0laRSA9IDQwMDtcblFyU2Nhbm5lci5OT19RUl9DT0RFX0ZPVU5EID0gJ05vIFFSIGNvZGUgZm91bmQnO1xuUXJTY2FubmVyLldPUktFUl9QQVRIID0gJ3FyLXNjYW5uZXItd29ya2VyLm1pbi5qcyc7XG4iLCJpbXBvcnQgUXJTY2FubmVyIGZyb20gJ3FyLXNjYW5uZXInO1xyXG5cclxuY29uc3QgcHJlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJvdXRwdXRcIik7XHJcbmNvbnN0IHZpZGVvRWxlbSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCJ2aWRlb1wiKVxyXG5jb25zdCBxclNjYW5uZXIgPSBuZXcgUXJTY2FubmVyKHZpZGVvRWxlbSwgcmVzdWx0ID0+IHtcclxuICBjb25zb2xlLmxvZygnZGVjb2RlZCBxciBjb2RlOicsIHJlc3VsdCk7XHJcbiAgcHJlLnRleHRDb250ZW50ID0gU3RyaW5nKHJlc3VsdCk7XHJcbn0pO1xyXG5cclxuaWYgKFwibWVkaWFEZXZpY2VzXCIgaW4gbmF2aWdhdG9yICYmIFwiZ2V0VXNlck1lZGlhXCIgaW4gbmF2aWdhdG9yLm1lZGlhRGV2aWNlcykge1xyXG4gIGNvbnNvbGUubG9nKFwiTGV0J3MgZ2V0IHRoaXMgcGFydHkgc3RhcnRlZFwiKTtcclxuICBuYXZpZ2F0b3IubWVkaWFEZXZpY2VzXHJcbiAgICAuZ2V0VXNlck1lZGlhKHtcclxuICAgICAgdmlkZW86IHtcclxuICAgICAgICBmYWNpbmdNb2RlOiB7XHJcbiAgICAgICAgICBleGFjdDogXCJlbnZpcm9ubWVudFwiLFxyXG4gICAgICAgIH0sXHJcbiAgICAgIH0sXHJcbiAgICB9KVxyXG4gICAgLnRoZW4oKHN0cmVhbSkgPT4ge1xyXG4gICAgICBjb25zb2xlLmxvZyhcImdvdCBtZWRpYSBzdHJlYW1cIik7XHJcbiAgICAgIHByZS50ZXh0Q29udGVudCA9IFwiZ290IG1lZGlhIHN0cmVhbVwiO1xyXG4gICAgICBcclxuICAgICAgdmlkZW9FbGVtLnNyY09iamVjdCA9IHN0cmVhbTtcclxuICAgICAgcXJTY2Fu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
