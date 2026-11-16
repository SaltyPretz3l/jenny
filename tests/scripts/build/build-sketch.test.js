'use strict';

// new-test-file: the build script's stamp lane runs against a mocked esbuild in a temp root; the
// golden-scene lane in tests/sketch-core.test.js builds the real bundles.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createTrackedTempDir, cleanupTrackedResources } = require('../../helpers/resource-cleanup');

const BUILDER_PATH = require.resolve('../../../scripts/build/build-sketch');
const ESBUILD_PATH = require.resolve('esbuild');

test.after(cleanupTrackedResources);

function writeBackdated(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  const past = new Date(Date.now() - 5000);
  fs.utimesSync(filePath, past, past);
}

// Loads the builder against a fake esbuild whose build() writes the requested outfile.
function loadBuilder(t, { frameBytes = 10 } = {}) {
  const counter = { builds: 0 };
  const fakeEsbuild = {
    version: 'test-esbuild-sketch',
    async build(options) {
      counter.builds += 1;
      const bytes = options.platform === 'browser' ? frameBytes : 10;
      fs.writeFileSync(options.outfile, 'x'.repeat(bytes), 'utf8');
      return { metafile: { inputs: { 'shared.ts': { bytes: 1 }, 'inline:shared.css': { bytes: 1 }, '../outside.ts': { bytes: 1 } } } };
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
  return { ...builder, counter };
}

function seedRoot(prefix) {
  const root = createTrackedTempDir(prefix);
  writeBackdated(path.join(root, 'shared.ts'), 'export const a = 1;\n');
  writeBackdated(path.join(root, 'shared.css'), 'a { color: red; }\n');
  return root;
}

test('the stamp skips unchanged work and rebuilds for stale, missing or corrupt state', async (t) => {
  const root = seedRoot('jenny-sketch-stamp-');
  const { buildSketchBundles, isSketchBundleCurrent, counter } = loadBuilder(t);

  assert.equal(isSketchBundleCurrent({ root }), false, 'no stamp yet');
  const first = await buildSketchBundles({ root });
  assert.equal(first.skipped, false);
  assert.deepEqual(first.outputs.map((o) => o.path), ['sketch-frame.bundle.js', 'sketch-core.bundle.cjs']);
  assert.equal(counter.builds, 2, 'one esbuild run per bundle');
  assert.equal(isSketchBundleCurrent({ root }), true);

  const second = await buildSketchBundles({ root });
  assert.equal(second.skipped, true, 'unchanged inputs skip esbuild');
  assert.equal(counter.builds, 2);

  writeBackdated(path.join(root, 'shared.css'), 'a { color: blue; }\n');
  assert.equal(isSketchBundleCurrent({ root }), false, 'a changed inline input is stale');
  await buildSketchBundles({ root });
  assert.equal(counter.builds, 4);

  fs.writeFileSync(path.join(root, 'sketch-core.bundle.cjs'), 'truncated', 'utf8');
  assert.equal(isSketchBundleCurrent({ root }), false, 'a corrupted output is stale');
  await buildSketchBundles({ root });
  assert.equal(counter.builds, 6);

  fs.rmSync(path.join(root, 'sketch-frame.bundle.js'));
  await buildSketchBundles({ root });
  assert.equal(counter.builds, 8, 'a missing output rebuilds');

  fs.writeFileSync(path.join(root, '.sketch-build-stamp.json'), '{broken', 'utf8');
  await buildSketchBundles({ root });
  assert.equal(counter.builds, 10, 'an unreadable stamp rebuilds');
});

test('--force and JENNY_SKETCH_FORCE_REBUILD bypass the stamp', async (t) => {
  const root = seedRoot('jenny-sketch-force-');
  const { buildSketchBundles, counter } = loadBuilder(t);
  await buildSketchBundles({ root });
  assert.equal(counter.builds, 2);
  assert.equal((await buildSketchBundles({ root, argv: [] })).skipped, true);
  assert.equal((await buildSketchBundles({ root, argv: ['--force'] })).skipped, false);
  assert.equal(counter.builds, 4);
  assert.equal((await buildSketchBundles({ root, env: { JENNY_SKETCH_FORCE_REBUILD: '1 ' } })).skipped, false);
  assert.equal(counter.builds, 6, 'a trailing space from cmd.exe does not defeat the force flag');
});

test('a stamp that names an input outside the root is treated as absent', async (t) => {
  const root = seedRoot('jenny-sketch-escape-');
  const { buildSketchBundles, isSketchBundleCurrent } = loadBuilder(t);
  await buildSketchBundles({ root });
  const stampPath = path.join(root, '.sketch-build-stamp.json');
  const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  assert.ok(!stamp.inputs.some((input) => input.includes('outside')), 'an input outside the root is never recorded');
  stamp.inputs.push('../../outside.ts');
  fs.writeFileSync(stampPath, JSON.stringify(stamp), 'utf8');
  assert.equal(isSketchBundleCurrent({ root }), false);
});

test('an unchanged tree is recognised from sizes and times alone; a touched file is judged by its content', async (t) => {
  const root = seedRoot('jenny-sketch-quick-');
  const { buildSketchBundles, isSketchBundleCurrent } = loadBuilder(t);
  await buildSketchBundles({ root });
  const stampPath = path.join(root, '.sketch-build-stamp.json');
  const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
  assert.equal(stamp.quick.stats.length, 1 + stamp.inputs.length + 2, 'this script, each input, both outputs');
  // With every size and time equal, the content hash is not consulted.
  fs.writeFileSync(stampPath, JSON.stringify({ ...stamp, value: 'not-the-hash' }), 'utf8');
  assert.equal(isSketchBundleCurrent({ root }), true);
  fs.writeFileSync(stampPath, JSON.stringify(stamp), 'utf8');
  // Same content, new modified time: the quick check misses and the content hash still matches.
  writeBackdated(path.join(root, 'shared.ts'), 'export const a = 1;\n');
  assert.equal(isSketchBundleCurrent({ root }), true);
  // Same size, different content: stale.
  writeBackdated(path.join(root, 'shared.ts'), 'export const a = 2;\n');
  assert.equal(isSketchBundleCurrent({ root }), false);
});

test('a frame bundle over the size ceiling fails the build and leaves no skippable stamp', async (t) => {
  const root = seedRoot('jenny-sketch-size-');
  const { buildSketchBundles, MAX_FRAME_BYTES } = loadBuilder(t, { frameBytes: 3_000_001 });
  assert.equal(MAX_FRAME_BYTES, 3_000_000);
  await assert.rejects(() => buildSketchBundles({ root }), /over the 3000000 byte ceiling/);
  assert.equal(fs.existsSync(path.join(root, '.sketch-build-stamp.json')), false);
});
