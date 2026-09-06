'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createKeepSetIgnorePolicy,
  resolveWalkIgnorePolicy,
} = require('../services/workspace-ide-ignore-policy');

test('keep-set policy prunes a directory containing only ignored files', () => {
  const policy = createKeepSetIgnorePolicy({ keepSet: ['src/app.js'] });
  assert.equal(policy.shouldSkipDirectory('artifacts', 'artifacts'), true);
});

test('keep-set policy keeps a directory containing a tracked file among ignored files', () => {
  const policy = createKeepSetIgnorePolicy({ keepSet: ['native/src/lib.rs'] });
  assert.equal(policy.shouldSkipDirectory('native', 'native'), false);
  assert.equal(policy.shouldSkipDirectory('target', 'native/target'), true);
});

test('keep-set policy always skips .git', () => {
  const policy = createKeepSetIgnorePolicy({ keepSet: ['.git/config', 'src/app.js'] });
  assert.equal(policy.shouldSkipDirectory('.git', '.git'), true);
});

test('win32 keep-set matching is case-insensitive while linux matching is exact', () => {
  const keepSet = ['Native/src/lib.rs'];
  const win32Policy = createKeepSetIgnorePolicy({ keepSet, platform: 'win32' });
  const linuxPolicy = createKeepSetIgnorePolicy({ keepSet, platform: 'linux' });
  assert.equal(win32Policy.shouldSkipDirectory('native', 'native'), false);
  assert.equal(linuxPolicy.shouldSkipDirectory('native', 'native'), true);
  assert.equal(linuxPolicy.shouldSkipDirectory('Native', 'Native'), false);
});

test('resolveWalkIgnorePolicy falls back to names for a null git service', async () => {
  const policy = await resolveWalkIgnorePolicy({ gitService: null });
  assert.equal(policy.describe().source, 'names');
});

test('resolveWalkIgnorePolicy falls back to names for a service without the method', async () => {
  const policy = await resolveWalkIgnorePolicy({ gitService: {} });
  assert.equal(policy.describe().source, 'names');
});

test('resolveWalkIgnorePolicy falls back to names for an ok-false result', async () => {
  const gitService = { async listNonIgnoredFiles() { return { ok: false }; } };
  const policy = await resolveWalkIgnorePolicy({ gitService });
  assert.equal(policy.describe().source, 'names');
});

test('resolveWalkIgnorePolicy falls back to names when the git call throws', async () => {
  const gitService = { async listNonIgnoredFiles() { throw new Error('git failed'); } };
  const policy = await resolveWalkIgnorePolicy({ gitService });
  assert.equal(policy.describe().source, 'names');
});

test('resolveWalkIgnorePolicy falls back to names for an empty files array', async () => {
  const gitService = { async listNonIgnoredFiles() { return { ok: true, files: [] }; } };
  const policy = await resolveWalkIgnorePolicy({ gitService });
  assert.equal(policy.describe().source, 'names');
});

test('resolveWalkIgnorePolicy returns the git policy for a successful inventory', async () => {
  const gitService = {
    async listNonIgnoredFiles() {
      return { ok: true, files: ['src/app.js'] };
    },
  };
  const policy = await resolveWalkIgnorePolicy({ gitService });
  assert.equal(policy.describe().source, 'git');
});
