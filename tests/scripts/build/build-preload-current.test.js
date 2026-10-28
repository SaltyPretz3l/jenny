'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createTrackedTempDir, cleanupTrackedResources } = require('../../helpers/resource-cleanup');

const BUILDER_PATH = require.resolve('../../../scripts/build/build-preload');
const ESBUILD_PATH = require.resolve('esbuild');
const ENTRYPOINTS = ['preload.js', 'uninstall-preload.js'];

test.after(cleanupTrackedResources);

function writeBackdated(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  const past = new Date(Date.now() - 5000);
  fs.utimesSync(filePath, past, past);
}

function loadBuilderWithFakeEsbuild(t, counter) {
  const fakeEsbuild = {
    version: 'test-esbuild-current',
    buildSync(options) {
      counter.builds += 1;
      for (const entrypoint of options.entryPoints) {
        fs.writeFileSync(path.join(options.outdir, entrypoint.replace(/\.js$/, '.bundle.js')), `b${counter.builds}\n`, 'utf8');
      }
      return { metafile: { inputs: Object.fromEntries([...options.entryPoints, 'shared.js'].map((input) => [input, { bytes: 1 }])) } };
    },
  };
  const original = require.cache[ESBUILD_PATH];
  require.cache[ESBUILD_PATH] = { id: ESBUILD_PATH, filename: ESBUILD_PATH, loaded: true, exports: fakeEsbuild, children: [], paths: [] };
  delete require.cache[BUILDER_PATH];
  const builder = require(BUILDER_PATH);
  t.after(() => {
    delete require.cache[BUILDER_PATH];
    if (original) require.cache[ESBUILD_PATH] = original;
    else delete require.cache[ESBUILD_PATH];
  });
  return builder;
}

test('the read-only stamp check agrees with the build skip path and never builds', (t) => {
  const root = createTrackedTempDir('jenny-preload-current-');
  for (const entrypoint of ENTRYPOINTS) {
    writeBackdated(path.join(root, entrypoint), `require('./shared'); module.exports = ${JSON.stringify(entrypoint)};\n`);
  }
  writeBackdated(path.join(root, 'shared.js'), 'module.exports = 1;\n');
  const counter = { builds: 0 };
  const { buildPreloadBundle, isPreloadBundleCurrent } = loadBuilderWithFakeEsbuild(t, counter);

  assert.equal(isPreloadBundleCurrent({ root }), false, 'no stamp yet');
  buildPreloadBundle({ root });
  assert.equal(counter.builds, 1);
  assert.equal(isPreloadBundleCurrent({ root }), true);
  assert.equal(buildPreloadBundle({ root }).skipped, true);

  writeBackdated(path.join(root, 'shared.js'), 'module.exports = 2;\n');
  assert.equal(isPreloadBundleCurrent({ root }), false, 'a changed input is stale');
  buildPreloadBundle({ root });
  assert.equal(isPreloadBundleCurrent({ root }), true);

  fs.writeFileSync(path.join(root, 'preload.bundle.js'), 'truncated', 'utf8');
  assert.equal(isPreloadBundleCurrent({ root }), false, 'a corrupted output is stale');
  assert.equal(counter.builds, 2, 'the check itself never runs esbuild');
});
