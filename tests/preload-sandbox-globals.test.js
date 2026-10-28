'use strict';

// Electron 45 removed the `events`/`timers`/`url` shims and the `Buffer`,
// `setImmediate` and `clearImmediate` globals from sandboxed preloads; only
// `electron` (and its `/renderer`, `/common` subpaths) resolves through
// `require`. The preload bundle uses esbuild's node platform, so a Node builtin
// required by preload code would stay external and fail only at window load.
const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');

const { preloadBuildPlan, REPO_ROOT } = require('../scripts/build/build-preload');

const ALLOWED_EXTERNALS = new Set(['electron', 'electron/renderer', 'electron/common']);
const REMOVED_GLOBALS = /\b(Buffer|setImmediate|clearImmediate)\b/;

test('sandboxed preload bundles require only electron and use no globals Electron 45 removed', () => {
  const { buildOptions, outputs: plannedOutputs } = preloadBuildPlan(REPO_ROOT);
  const result = esbuild.buildSync({ ...buildOptions, write: false });

  const outputs = Object.entries(result.metafile.outputs);
  assert.equal(outputs.length, plannedOutputs.length);
  for (const [outputPath, meta] of outputs) {
    const externals = meta.imports.filter((entry) => entry.external).map((entry) => entry.path);
    assert.deepEqual(externals.filter((name) => !ALLOWED_EXTERNALS.has(name)), [], outputPath);
  }
  for (const file of result.outputFiles) {
    assert.doesNotMatch(file.text, REMOVED_GLOBALS, file.path);
  }
});
