
import {nodeResolve} from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';


export default {
  input: 'main.js',
  output: {
    file: "dist/main.js",
    sourcemap: 'inline',
    format: 'iife',
    //exports: 'default'
  },
  external: ['obsidian'],
  plugins: [
    nodeResolve({browser: true}),
    commonjs()
  ]
};