'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PRELOAD_CHECKED_ENV,
  ensureDevPreloadBundle,
  rebuildPreloadBundleInChild,
} = require('../services/main/dev-preload-bundle');
const startLauncher = require('../start');

const ROOT = path.resolve(__dirname, '..');
const mustNotRun = (label) => () => { throw new Error(`${label} must not run`); };

test('a packaged app never checks or rebuilds the preload bundle', () => {
  const result = ensureDevPreloadBundle({
    isPackaged: true, rootDir: ROOT, env: {}, isCurrent: mustNotRun('isCurrent'), rebuild: mustNotRun('rebuild'),
  });
  assert.deepEqual(result, { status: 'packaged' });
});

test('a launch through start.js skips the repeat check', () => {
  const result = ensureDevPreloadBundle({
    isPackaged: false, rootDir: ROOT, env: { [PRELOAD_CHECKED_ENV]: '1' },
    isCurrent: mustNotRun('isCurrent'), rebuild: mustNotRun('rebuild'),
  });
  assert.deepEqual(result, { status: 'launcher-checked' });
});

test('a current stamp is checked in-process with no child process', () => {
  const seen = [];
  const result = ensureDevPreloadBundle({
    isPackaged: false, rootDir: ROOT, env: {},
    isCurrent: (rootDir) => { seen.push(rootDir); return true; },
    rebuild: mustNotRun('rebuild'),
  });
  assert.deepEqual(result, { status: 'current' });
  assert.deepEqual(seen, [ROOT]);
});

test('a stale or unreadable stamp rebuilds, and a failed rebuild reports why', () => {
  const env = { PATH: 'x' };
  const rebuilds = [];
  const stale = ensureDevPreloadBundle({
    isPackaged: false, rootDir: ROOT, env, execPath: 'electron.exe',
    isCurrent: () => false,
    rebuild: (options) => { rebuilds.push(options); return { status: 0 }; },
  });
  assert.deepEqual(stale, { status: 'rebuilt' });
  assert.deepEqual(rebuilds, [{ rootDir: ROOT, env, execPath: 'electron.exe' }]);

  const unreadable = ensureDevPreloadBundle({
    isPackaged: false, rootDir: ROOT, env,
    isCurrent: () => { throw new Error('esbuild missing'); },
    rebuild: () => ({ status: 1, stderr: 'Cannot find module esbuild\n' }),
  });
  assert.deepEqual(unreadable, { status: 'failed', detail: 'Cannot find module esbuild' });

  const spawnFailed = ensureDevPreloadBundle({
    isPackaged: false, rootDir: ROOT, env, isCurrent: () => false,
    rebuild: () => ({ status: null, error: new Error('spawn ENOENT') }),
  });
  assert.deepEqual(spawnFailed, { status: 'failed', detail: 'spawn ENOENT' });
});

test('the rebuild runs build-preload.js in this Electron binary as Node, hidden', () => {
  const calls = [];
  rebuildPreloadBundleInChild({
    rootDir: ROOT,
    env: { KEEP: '1' },
    execPath: 'C:/electron/electron.exe',
    spawnSyncImpl: (...args) => { calls.push(args); return { status: 0 }; },
  });
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, 'C:/electron/electron.exe');
  assert.deepEqual(args, [path.join(ROOT, 'scripts', 'build', 'build-preload.js')]);
  assert.ok(fs.existsSync(args[0]), 'the rebuild script path must exist');
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(options.env.KEEP, '1');
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, ROOT);
});

test('start.js vouches for the bundle with the same marker main.js reads, never an inherited one', () => {
  assert.equal(startLauncher.PRELOAD_CHECKED_ENV, PRELOAD_CHECKED_ENV);
  const { env } = startLauncher.resolveLaunch({ argv: [], env: { [PRELOAD_CHECKED_ENV]: '1' }, cwd: ROOT });
  assert.equal(env[PRELOAD_CHECKED_ENV], undefined);
});

test('launch-jenny.cmd starts Electron without a separate Node preload build', () => {
  const launcher = fs.readFileSync(path.join(ROOT, 'launch-jenny.cmd'), 'utf8');
  assert.doesNotMatch(launcher, /build-preload|where node|^\s*node\s/im);
  assert.match(launcher, new RegExp(`set "${PRELOAD_CHECKED_ENV}="`));
  assert.match(launcher, /start "" \/D "%REPO_ROOT%" "%ELECTRON_EXE%" "%REPO_ROOT%"/);
});
