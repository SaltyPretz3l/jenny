'use strict';

// scripts/tests/jsdom-bundle.js: the single-file jsdom build the safe runner
// preloads into test processes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_PATH = path.join(ROOT, 'scripts', 'run-node-tests-safe.js');
const {
  BUNDLE_ENV_VAR,
  PRELOAD_PATH,
  bundleKey,
  ensureJsdomBundle,
  jsdomBundleNodeArgs,
} = require('../scripts/tests/jsdom-bundle');

function fakeRoot(t, { lock = 'lock-a' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-jsdom-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), lock);
  for (const [name, version] of [['jsdom', '1.2.3'], ['esbuild', '0.1.0']]) {
    fs.mkdirSync(path.join(root, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version }));
  }
  return root;
}

function fakeBuild(calls) {
  return (root, targetDir) => {
    calls.push(targetDir);
    const file = path.join(targetDir, 'lib', 'living', 'css', 'jsdom-bundle.js');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'module.exports = {};');
  };
}

test('the bundle is built once per key and reused; a lockfile change makes a new one', (t) => {
  const root = fakeRoot(t);
  const calls = [];
  const first = ensureJsdomBundle({ root, env: {}, build: fakeBuild(calls) });
  assert.ok(first && fs.existsSync(first));
  assert.match(first, /jsdom-1\.2\.3-esbuild-0\.1\.0-node\d+-[0-9a-f]{12}/);
  assert.equal(ensureJsdomBundle({ root, env: {}, build: fakeBuild(calls) }), first);
  assert.equal(calls.length, 1, 'the second call reuses the built bundle');
  assert.equal(fs.readdirSync(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(first)))))).length, 1,
    'no staging directory is left behind');

  const keyBefore = bundleKey(root);
  fs.writeFileSync(path.join(root, 'package-lock.json'), 'lock-b');
  assert.notEqual(bundleKey(root), keyBefore);
  assert.notEqual(ensureJsdomBundle({ root, env: {}, build: fakeBuild(calls) }), first);
  assert.equal(fs.existsSync(first), false, 'the superseded bundle is removed');
});

test('a failed build or the kill switch leaves tests on node_modules', (t) => {
  const root = fakeRoot(t);
  const failing = () => { throw new Error('esbuild unavailable'); };
  assert.equal(ensureJsdomBundle({ root, env: {}, build: failing }), null);
  assert.deepEqual(jsdomBundleNodeArgs({ root, env: {}, build: failing }), []);
  const calls = [];
  assert.equal(ensureJsdomBundle({ root, env: { JENNY_TEST_JSDOM_BUNDLE: '0' }, build: fakeBuild(calls) }), null);
  assert.equal(calls.length, 0);

  const env = {};
  assert.deepEqual(jsdomBundleNodeArgs({ root, env, build: fakeBuild(calls) }), ['--require', PRELOAD_PATH]);
  assert.ok(fs.existsSync(env[BUNDLE_ENV_VAR]));
});

test('a test run through the safe runner gets a working jsdom from the bundle', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(ROOT, 'tests', '.tmp-jsdom-bundle-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const fixture = path.join(tempRoot, 'uses-jsdom.test.js');
  fs.writeFileSync(fixture, [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "test('jsdom comes from the bundle and still computes styles', () => {",
    "  assert.equal(require.resolve('jsdom'), process.env.JENNY_JSDOM_BUNDLE);",
    "  const { JSDOM } = require('jsdom');",
    "  const dom = new JSDOM('<!doctype html><body><div id=\"a\">x</div><script>window.ran = 1 + 1;</script></body>', { runScripts: 'dangerously' });",
    "  assert.equal(dom.window.ran, 2);",
    "  // Bundling must not rename jsdom's classes: code under test reads constructor.name.",
    "  assert.equal(new dom.window.Event('x').constructor.name, 'Event');",
    "  assert.equal(dom.window.getComputedStyle(dom.window.document.getElementById('a')).display, 'block');",
    "  assert.equal(dom.window.document.querySelector('body > div').textContent, 'x');",
    '});',
    '',
  ].join('\n'));

  const env = { ...process.env };
  delete env.JENNY_TEST_JSDOM_BUNDLE;
  delete env[BUNDLE_ENV_VAR];
  const result = spawnSync(process.execPath, [RUNNER_PATH, '--no-lock', fixture, '--timeout-ms=120000'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 150_000,
    windowsHide: true,
    env,
  });
  assert.equal(result.status, 0, `stderr=${result.stderr}\nstdout=${result.stdout}`);
  assert.match(result.stdout, /summary: 1 passed, 0 failed/);
});
