const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

const {
  buildSandboxLayout,
  isChildPath,
  normalizeString,
} = require('../services/backend/path-utils');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

/* ── buildSandboxLayout ── */

test('buildSandboxLayout returns expected keys', () => {
  const root = '/tmp/test-root';
  const layout = buildSandboxLayout(root);
  assert.equal(layout.rootPath, root);
  assert.equal(layout.installPath, path.join(root, 'install'));
  assert.equal(layout.localAppDataPath, path.join(root, 'localappdata'));
  assert.equal(layout.runtimePath, path.join(root, 'runtime'));
  assert.equal(layout.logsPath, path.join(root, 'logs'));
  assert.equal(layout.stateFilePath, path.join(root, 'sidecar-state.json'));
});

test('buildSandboxLayout paths are under rootPath', () => {
  const root = path.resolve('/tmp/test-root');
  const layout = buildSandboxLayout(root);
  assert.equal(layout.rootPath, root);
  for (const key of ['installPath', 'localAppDataPath', 'runtimePath', 'logsPath', 'stateFilePath']) {
    const relative = path.relative(root, layout[key]);
    assert.ok(relative && !relative.startsWith('..'), `${key} should be under rootPath`);
  }
});

test('buildSandboxLayout uses tmpdir fallback when no root given', () => {
  const layout = buildSandboxLayout();
  assert.ok(layout.rootPath.includes('jenny-shell-backend'));
});

/* ── isChildPath ── */

test('isChildPath returns true for direct children', () => {
  assert.equal(isChildPath('/root', '/root/child'), true);
  assert.equal(isChildPath('/root', '/root/a/b/c'), true);
});

test('isChildPath returns false for parent traversal', () => {
  assert.equal(isChildPath('/root/child', '/root'), false);
  assert.equal(isChildPath('/root', '/root/../etc/passwd'), false);
});

test('isChildPath returns false for same path', () => {
  assert.equal(isChildPath('/root', '/root'), false);
});

test('isChildPath returns false for sibling paths', () => {
  assert.equal(isChildPath('/root/a', '/root/b'), false);
});

test('isChildPath handles empty strings gracefully', () => {
  assert.equal(typeof isChildPath('', ''), 'boolean');
  assert.equal(typeof isChildPath(null, null), 'boolean');
});

test('isChildPath rejects symlinked paths that resolve outside the root', () => {
  const rootDir = createTrackedTempDir('jenny-path-root-');
  const outsideDir = createTrackedTempDir('jenny-path-outside-');
  const escapeLink = path.join(rootDir, 'escape-link');

  fs.symlinkSync(outsideDir, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');

  assert.equal(isChildPath(rootDir, path.join(escapeLink, 'secret.txt')), false);
});

/* ── normalizeString ── */

test('normalizeString trims and converts to string', () => {
  assert.equal(normalizeString('  hello  '), 'hello');
  assert.equal(normalizeString(42), '42');
  assert.equal(normalizeString(null), '');
  assert.equal(normalizeString(undefined), '');
  assert.equal(normalizeString(''), '');
});
