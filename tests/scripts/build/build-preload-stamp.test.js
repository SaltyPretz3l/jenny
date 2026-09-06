const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createTrackedTempDir, cleanupTrackedResources } = require('../../helpers/resource-cleanup');

const BUILDER_PATH = require.resolve('../../../scripts/build/build-preload');
const ESBUILD_PATH = require.resolve('esbuild');
const ENTRYPOINTS = [
  'preload.js',
  'uninstall-preload.js',
  'plugin-view-preload.js',
  'plugin-consent-preload.js',
];

test.after(cleanupTrackedResources);

// Windows file mtimes carry sub-millisecond precision while Date.now()
// truncates to whole milliseconds, so a file written and then immediately
// built can spuriously look "written after buildStartedAt" by a fraction of
// a millisecond. Backdate seeded sources well clear of that truncation
// artifact so only a deliberate mtime bump (see the race test below) trips
// the build-window race check.
const SAFELY_PAST = () => new Date(Date.now() - 5000);

function writeBackdated(filePath, content) {
  fs.writeFileSync(filePath, content, 'utf8');
  const past = SAFELY_PAST();
  fs.utimesSync(filePath, past, past);
}

function seedPreloadEntries(root) {
  for (const entrypoint of ENTRYPOINTS) {
    writeBackdated(
      path.join(root, entrypoint),
      `require('./shared'); module.exports = ${JSON.stringify(entrypoint)};\n`,
    );
  }
  writeBackdated(path.join(root, 'shared.js'), 'module.exports = 1;\n');
}

function writeBundleOutputs(options, tag) {
  for (const entrypoint of options.entryPoints) {
    const outputName = entrypoint.replace(/\.js$/, '.bundle.js');
    fs.writeFileSync(path.join(options.outdir, outputName), `build ${tag}\n`, 'utf8');
  }
}

function metafileWithInputs(entryPoints, extraInputs = []) {
  return {
    metafile: {
      inputs: Object.fromEntries(
        [...entryPoints, ...extraInputs].map((input) => [input, { bytes: 1 }]),
      ),
    },
  };
}

// Swaps in a fake esbuild module (mirroring the mocking used by the test
// above) and returns a fresh buildPreloadBundle bound to it; restores both
// require.cache entries on test teardown.
function withMockedEsbuild(t, esbuildImpl) {
  const originalEsbuildModule = require.cache[ESBUILD_PATH];
  require.cache[ESBUILD_PATH] = {
    id: ESBUILD_PATH,
    filename: ESBUILD_PATH,
    loaded: true,
    exports: esbuildImpl,
    children: [],
    paths: [],
  };
  delete require.cache[BUILDER_PATH];
  const { buildPreloadBundle } = require(BUILDER_PATH);
  t.after(() => {
    delete require.cache[BUILDER_PATH];
    if (originalEsbuildModule) require.cache[ESBUILD_PATH] = originalEsbuildModule;
    else delete require.cache[ESBUILD_PATH];
  });
  return buildPreloadBundle;
}

test('preload stamp skips unchanged work and rebuilds for stale or corrupt state', (t) => {
  const root = createTrackedTempDir('jenny-preload-stamp-');
  const sharedPath = path.join(root, 'shared.js');
  for (const entrypoint of ENTRYPOINTS) {
    fs.writeFileSync(
      path.join(root, entrypoint),
      `require('./shared'); module.exports = ${JSON.stringify(entrypoint)};\n`,
      'utf8',
    );
  }
  fs.writeFileSync(sharedPath, 'module.exports = 1;\n', 'utf8');

  let buildCount = 0;
  let failAfterWrite = false;
  const fakeEsbuild = {
    version: 'test-esbuild-1',
    buildSync(options) {
      buildCount += 1;
      assert.equal(options.metafile, true);
      for (const entrypoint of options.entryPoints) {
        const outputName = entrypoint.replace(/\.js$/, '.bundle.js');
        fs.writeFileSync(path.join(options.outdir, outputName), `build ${buildCount}\n`, 'utf8');
      }
      if (failAfterWrite) {
        failAfterWrite = false;
        throw new Error('simulated esbuild failure');
      }
      return {
        metafile: {
          inputs: Object.fromEntries(
            [...options.entryPoints, 'shared.js'].map((input) => [input, { bytes: 1 }]),
          ),
        },
      };
    },
  };
  const originalEsbuildModule = require.cache[ESBUILD_PATH];
  require.cache[ESBUILD_PATH] = {
    id: ESBUILD_PATH,
    filename: ESBUILD_PATH,
    loaded: true,
    exports: fakeEsbuild,
    children: [],
    paths: [],
  };
  delete require.cache[BUILDER_PATH];
  const { buildPreloadBundle } = require(BUILDER_PATH);
  t.after(() => {
    delete require.cache[BUILDER_PATH];
    if (originalEsbuildModule) require.cache[ESBUILD_PATH] = originalEsbuildModule;
    else delete require.cache[ESBUILD_PATH];
  });

  buildPreloadBundle({ root });
  assert.equal(buildCount, 1);
  buildPreloadBundle({ root });
  assert.equal(buildCount, 1, 'unchanged inputs skip esbuild');

  fs.appendFileSync(sharedPath, '// changed\n', 'utf8');
  buildPreloadBundle({ root });
  assert.equal(buildCount, 2, 'a changed transitive input rebuilds');

  fs.rmSync(path.join(root, 'plugin-view-preload.bundle.js'));
  buildPreloadBundle({ root });
  assert.equal(buildCount, 3, 'a missing expected output rebuilds');

  fs.writeFileSync(path.join(root, '.preload-build-stamp.json'), '{broken', 'utf8');
  buildPreloadBundle({ root });
  assert.equal(buildCount, 4, 'an unreadable stamp rebuilds');

  fs.rmSync(path.join(root, 'plugin-consent-preload.bundle.js'));
  failAfterWrite = true;
  assert.throws(() => buildPreloadBundle({ root }), /simulated esbuild failure/);
  assert.equal(fs.existsSync(path.join(root, '.preload-build-stamp.json')), false);
  buildPreloadBundle({ root });
  assert.equal(buildCount, 6, 'a failed rebuild cannot leave a skippable stamp');
});

test('a source touched during the esbuild read window leaves the stamp absent for the next call', (t) => {
  const root = createTrackedTempDir('jenny-preload-stamp-race-');
  seedPreloadEntries(root);
  let buildCount = 0;
  const buildPreloadBundle = withMockedEsbuild(t, {
    version: 'test-esbuild-race',
    buildSync(options) {
      buildCount += 1;
      writeBundleOutputs(options, buildCount);
      // Simulate a source changing WHILE esbuild held it open: bump its mtime
      // into the future relative to the buildStartedAt captured just before
      // this call.
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(root, 'shared.js'), future, future);
      return metafileWithInputs(options.entryPoints, ['shared.js']);
    },
  });

  const first = buildPreloadBundle({ root });
  assert.equal(first.skipped, false);
  assert.equal(
    fs.existsSync(path.join(root, '.preload-build-stamp.json')),
    false,
    'a build-window race leaves no stamp behind',
  );

  const second = buildPreloadBundle({ root });
  assert.equal(buildCount, 2, 'no stamp means the next call rebuilds instead of skipping');
  assert.equal(second.skipped, false);
});

test('a truncated output on disk forces a rebuild even when the stamp still matches', (t) => {
  const root = createTrackedTempDir('jenny-preload-stamp-corrupt-');
  seedPreloadEntries(root);
  let buildCount = 0;
  const buildPreloadBundle = withMockedEsbuild(t, {
    version: 'test-esbuild-corrupt',
    buildSync(options) {
      buildCount += 1;
      writeBundleOutputs(options, buildCount);
      return metafileWithInputs(options.entryPoints, ['shared.js']);
    },
  });

  buildPreloadBundle({ root });
  assert.equal(buildCount, 1);

  // Truncate one output to zero bytes without touching any input or the stamp.
  fs.writeFileSync(path.join(root, 'preload.bundle.js'), '', 'utf8');

  const second = buildPreloadBundle({ root });
  assert.equal(buildCount, 2, 'a corrupted output is not trusted just because the stamp matches');
  assert.equal(second.skipped, false);
});

test('JENNY_PRELOAD_FORCE_REBUILD=1 bypasses the stamp check entirely', (t) => {
  const root = createTrackedTempDir('jenny-preload-stamp-force-');
  seedPreloadEntries(root);
  let buildCount = 0;
  const buildPreloadBundle = withMockedEsbuild(t, {
    version: 'test-esbuild-force',
    buildSync(options) {
      buildCount += 1;
      writeBundleOutputs(options, buildCount);
      return metafileWithInputs(options.entryPoints, ['shared.js']);
    },
  });

  buildPreloadBundle({ root });
  assert.equal(buildCount, 1);
  buildPreloadBundle({ root });
  assert.equal(buildCount, 1, 'sanity: unchanged inputs skip without the flag');

  const forced = buildPreloadBundle({ root, env: { JENNY_PRELOAD_FORCE_REBUILD: '1' } });
  assert.equal(buildCount, 2, 'the force flag rebuilds even though the stamp matches');
  assert.equal(forced.skipped, false);
});

test('JENNY_PRELOAD_FORCE_REBUILD tolerates the trailing space cmd.exe leaves behind', (t) => {
  // Reproduced: `cmd.exe`'s `set VAR=1 && next-command` (exactly the form
  // pack:release / release:windows use) assigns "1 " -- a trailing space
  // INSIDE the value, not just around the whole env entry.
  const root = createTrackedTempDir('jenny-preload-stamp-force-whitespace-');
  seedPreloadEntries(root);
  let buildCount = 0;
  const buildPreloadBundle = withMockedEsbuild(t, {
    version: 'test-esbuild-force-whitespace',
    buildSync(options) {
      buildCount += 1;
      writeBundleOutputs(options, buildCount);
      return metafileWithInputs(options.entryPoints, ['shared.js']);
    },
  });

  buildPreloadBundle({ root });
  assert.equal(buildCount, 1);

  const forced = buildPreloadBundle({ root, env: { JENNY_PRELOAD_FORCE_REBUILD: '1 ' } });
  assert.equal(buildCount, 2, 'a trailing space must not defeat the force flag');
  assert.equal(forced.skipped, false);
});

test('an oversized or path-escaping stamp is rejected as if absent', (t) => {
  const root = createTrackedTempDir('jenny-preload-stamp-malformed-');
  seedPreloadEntries(root);
  let buildCount = 0;
  const buildPreloadBundle = withMockedEsbuild(t, {
    version: 'test-esbuild-malformed',
    buildSync(options) {
      buildCount += 1;
      writeBundleOutputs(options, buildCount);
      return metafileWithInputs(options.entryPoints, ['shared.js']);
    },
  });
  const stampPath = path.join(root, '.preload-build-stamp.json');
  const readStamp = () => JSON.parse(fs.readFileSync(stampPath, 'utf8'));

  buildPreloadBundle({ root });
  assert.equal(buildCount, 1);

  fs.writeFileSync(stampPath, JSON.stringify({
    ...readStamp(),
    inputs: Array.from({ length: 5001 }, (_unused, index) => `extra-${index}.js`),
  }), 'utf8');
  buildPreloadBundle({ root });
  assert.equal(buildCount, 2, 'a stamp over the 5000-input bound is treated as absent');

  // The rebuild above wrote a fresh, valid stamp matching current output
  // content -- corrupt only `inputs` this time so the escape check, not an
  // output mismatch, is what forces the next rebuild.
  fs.writeFileSync(stampPath, JSON.stringify({
    ...readStamp(),
    inputs: [...readStamp().inputs, '../../outside.js'],
  }), 'utf8');
  buildPreloadBundle({ root });
  assert.equal(buildCount, 3, 'a stamp input that resolves outside root is treated as absent');
});

test('the skip flag is reset at the start of every call and returned to the caller', (t) => {
  const root = createTrackedTempDir('jenny-preload-stamp-return-value-');
  seedPreloadEntries(root);
  let buildCount = 0;
  let shouldThrow = false;
  const buildPreloadBundle = withMockedEsbuild(t, {
    version: 'test-esbuild-return-value',
    buildSync(options) {
      buildCount += 1;
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('simulated failure');
      }
      writeBundleOutputs(options, buildCount);
      return metafileWithInputs(options.entryPoints, ['shared.js']);
    },
  });
  const expectedOutput = path.join(root, 'preload.bundle.js');

  const first = buildPreloadBundle({ root });
  assert.deepEqual(first, { output: expectedOutput, skipped: false });

  const second = buildPreloadBundle({ root });
  assert.deepEqual(second, { output: expectedOutput, skipped: true });

  const sharedPath = path.join(root, 'shared.js');
  fs.appendFileSync(sharedPath, '// changed\n', 'utf8');
  const past = SAFELY_PAST();
  fs.utimesSync(sharedPath, past, past);
  shouldThrow = true;
  assert.throws(() => buildPreloadBundle({ root }), /simulated failure/);

  // A prior throw must not leave a stale skipped flag for the NEXT call to
  // report -- the reset happens as the first statement of every call, not
  // only on a successful return.
  const third = buildPreloadBundle({ root });
  assert.deepEqual(third, { output: expectedOutput, skipped: false });
});

test('the --force argv flag bypasses the stamp check on every shell', (t) => {
  // The release scripts force the rebuild with --force rather than an env var:
  // npm runs scripts through cmd.exe on Windows but `sh` on macOS/Linux, and
  // `set VAR=1 && ...` is cmd-only. Under sh it sets a positional parameter and
  // exports nothing, so an env-var force would silently do nothing on exactly
  // the macOS release path -- and ship whatever the stamp happened to skip.
  const root = createTrackedTempDir('jenny-preload-stamp-force-argv-');
  seedPreloadEntries(root);
  let buildCount = 0;
  const buildPreloadBundle = withMockedEsbuild(t, {
    version: 'test-esbuild-force-argv',
    buildSync(options) {
      buildCount += 1;
      writeBundleOutputs(options, buildCount);
      return metafileWithInputs(options.entryPoints, ['shared.js']);
    },
  });

  buildPreloadBundle({ root });
  assert.equal(buildCount, 1);
  buildPreloadBundle({ root, argv: [] });
  assert.equal(buildCount, 1, 'sanity: unchanged inputs skip without the flag');

  const forced = buildPreloadBundle({ root, env: {}, argv: ['--force'] });
  assert.equal(buildCount, 2, '--force rebuilds even though the stamp matches');
  assert.equal(forced.skipped, false);
});
