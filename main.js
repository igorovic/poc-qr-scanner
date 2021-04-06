import QrScanner from "qr-scanner";

const pre = document.getElementById("output");
const videoElem = document.querySelector("video");
const qrScanner = new QrScanner(
  videoElem,
  (result) => {
    console.log("decoded qr code:", result);
    pre.textContent = String(result);
  },
  (err) => {
    pre.textContent = String(err);
  },
  300,
  "environment"
);

qrScanner.turnFlashOn();
qrScanner.start();
/* if ("mediaDevices" in navigator && "getUserMedia" in navigator.mediaDevices) {
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
} */
