/**
 * Build script: bundles @chenglou/pretext ESM into an IIFE global for Jenny's
 * renderer <script> tag loading pattern.
 *
 * Usage:  node scripts/build-pretext-umd.js
 * Output: vendor/pretext-layout.umd.js  (exposes window.pretextLayout)
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'node_modules', '@chenglou', 'pretext', 'dist', 'layout.js');
const OUT = path.join(ROOT, 'vendor', 'pretext-layout.umd.js');

if (!fs.existsSync(ENTRY)) {
  console.error('ERROR: @chenglou/pretext not installed. Run npm install first.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'iife',
  globalName: 'pretextLayout',
  outfile: OUT,
  logLevel: 'info',
});

console.log('Pretext UMD bundle written to: ' + path.relative(ROOT, OUT));
