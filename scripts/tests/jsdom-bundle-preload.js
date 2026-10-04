'use strict';

// Preloaded into test processes by the safe runner: points require('jsdom') at
// the single-file build from scripts/tests/jsdom-bundle.js. Only the bare
// 'jsdom' request is redirected, and only when the bundle file exists.

const fs = require('fs');
const Module = require('module');

const bundlePath = process.env.JENNY_JSDOM_BUNDLE;

if (bundlePath && fs.existsSync(bundlePath)) {
  const resolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveWithJsdomBundle(request, ...rest) {
    return request === 'jsdom' ? bundlePath : resolveFilename.call(this, request, ...rest);
  };
}
