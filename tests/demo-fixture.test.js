'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CONFIG_VERSION, normalizeState } = require('../services/shell-config-state');
const { seedDemoProfile, cleanupDemoProfile } = require('../scripts/demo/demo-profile');

const {
  FIXTURE_FILES,
  WORKING_TREE_EDIT,
  materialize,
} = require('../scripts/demo/demo-fixture');

test('demo fixture paths and contents are bounded', () => {
  const keys = Object.keys(FIXTURE_FILES);
  for (const key of keys) {
    assert.ok(!path.isAbsolute(key), `${key} is relative`);
    assert.ok(!key.startsWith('/'), `${key} has no leading slash`);
    assert.ok(!key.includes('\\'), `${key} uses forward slashes`);
    assert.ok(!key.includes('..'), `${key} contains no parent traversal`);
  }
  const totalBytes = Object.values(FIXTURE_FILES)
    .reduce((total, contents) => total + Buffer.byteLength(contents, 'utf8'), 0);
  assert.ok(totalBytes < 32 * 1024, `fixture is below 32 KB (${totalBytes} bytes)`);
  for (const required of ['README.md', 'src/index.js', 'src/parser.js']) {
    assert.ok(Object.hasOwn(FIXTURE_FILES, required), `${required} is present`);
  }
});

test('working-tree edit has exactly one fixture target', () => {
  const contents = FIXTURE_FILES[WORKING_TREE_EDIT.path];
  assert.strictEqual(typeof contents, 'string');
  assert.strictEqual(contents.split(WORKING_TREE_EDIT.find).length - 1, 1);
});

test('materialize writes every fixture file unchanged', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-demo-fixture-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const written = materialize(tempDir);
  assert.strictEqual(written.length, Object.keys(FIXTURE_FILES).length);
  for (const [relativePath, expected] of Object.entries(FIXTURE_FILES)) {
    const absolutePath = path.join(tempDir, ...relativePath.split('/'));
    assert.strictEqual(fs.readFileSync(absolutePath, 'utf8'), expected, relativePath);
  }
});

test('the fixture test script is the bare node runner (Node 22+ rejects a `test/` directory argument)', () => {
  const pkg = JSON.parse(FIXTURE_FILES['package.json']);
  assert.strictEqual(pkg.scripts.test, 'node --test');
});

test('seeded demo profile keeps its intentional 100 percent zoom at the current config version', (t) => {
  const mkdtempSync = fs.mkdtempSync;
  // Keep the real seeder's recording workspace inside the writable temp root.
  t.mock.method(fs, 'mkdtempSync', (prefix, options) => mkdtempSync(
    path.basename(prefix) === 'ledger-cli-' ? path.join(os.tmpdir(), 'ledger-cli-') : prefix,
    options
  ));
  const seeded = seedDemoProfile({});
  t.after(() => cleanupDemoProfile(seeded));
  const config = JSON.parse(fs.readFileSync(path.join(seeded.profile, 'shell-config.json'), 'utf8'));
  assert.strictEqual(config.version, CONFIG_VERSION);
  assert.strictEqual(config.windowUi.appZoomPercent, 100);
  assert.strictEqual(normalizeState(config).windowUi.appZoomPercent, 100);
  // The seed went through the whole migration chain, not just a version stamp.
  assert.strictEqual(config.home.showContextualTips, false, 'v45 turned tips off for versioned configs');
});
