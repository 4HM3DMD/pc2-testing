#!/usr/bin/env node
/**
 * Build a browser bundle of @elacity-js/access for use in the Elacity Market dApp.
 * Outputs dist/elacity-access.browser.js (ESM, can be loaded via import()).
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(__dirname, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outfile: join(__dirname, 'dist', 'elacity-access.browser.js'),
  alias: {
    crypto: 'crypto-browserify',
    stream: 'stream-browserify',
    buffer: 'buffer',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
  },
  banner: {
    js: [
      'var global=globalThis;',
      'if(typeof globalThis.process==="undefined"){globalThis.process={env:{},version:"",browser:true};}',
      'if(typeof globalThis.Buffer==="undefined"){globalThis.Buffer={isBuffer:function(){return false;}};}',
    ].join(''),
  },
  sourcemap: true,
});
