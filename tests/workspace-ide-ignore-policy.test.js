'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWalkIgnorePolicy } = require('../services/workspace-ide-ignore-policy');

test('.git is skipped even when dot-directory skipping is disabled', () => {
  const policy = createWalkIgnorePolicy({ skipDotDirectories: false });
  assert.equal(policy.shouldSkipDirectory('.git', '.git'), true);
});

test('dot-directories are skipped by default and kept when disabled', () => {
  assert.equal(createWalkIgnorePolicy().shouldSkipDirectory('.tools', '.tools'), true);
  assert.equal(
    createWalkIgnorePolicy({ skipDotDirectories: false }).shouldSkipDirectory('.tools', '.tools'),
    false
  );
});

test('known dependency, cache, coverage, and environment directories are skipped', () => {
  const policy = createWalkIgnorePolicy({
    skipDotDirectories: false,
    extraSkipNames: ['node_modules'],
  });
  for (const name of ['node_modules', '__pycache__', 'coverage', '.venv']) {
    assert.equal(policy.shouldSkipDirectory(name, `nested/${name}`), true, name);
  }
});

test('ambiguous generated names are not skipped', () => {
  const policy = createWalkIgnorePolicy();
  for (const name of ['build', 'dist', 'out', 'target']) {
    assert.equal(policy.shouldSkipDirectory(name, `src/${name}`), false, name);
  }
});

test('extraSkipNames entries are skipped', () => {
  const policy = createWalkIgnorePolicy({ extraSkipNames: ['vendor'] });
  assert.equal(policy.shouldSkipDirectory('vendor', 'packages/vendor'), true);
});

test('extraSkipNames follow the same platform case rule as generated names', () => {
  const win32Policy = createWalkIgnorePolicy({ platform: 'win32', extraSkipNames: ['vendor'] });
  const linuxPolicy = createWalkIgnorePolicy({ platform: 'linux', extraSkipNames: ['vendor'] });
  assert.equal(win32Policy.shouldSkipDirectory('Vendor', 'packages/Vendor'), true);
  assert.equal(linuxPolicy.shouldSkipDirectory('Vendor', 'packages/Vendor'), false);
});

test('unrelated and empty names are not skipped', () => {
  const policy = createWalkIgnorePolicy();
  assert.equal(policy.shouldSkipDirectory('services', 'services'), false);
  assert.equal(policy.shouldSkipDirectory('', ''), false);
  assert.equal(policy.shouldSkipDirectory(null, ''), false);
});

test('generated-directory matching is case-insensitive only on win32', () => {
  const win32Policy = createWalkIgnorePolicy({
    platform: 'win32',
    extraSkipNames: ['node_modules'],
  });
  const linuxPolicy = createWalkIgnorePolicy({
    platform: 'linux',
    extraSkipNames: ['node_modules'],
  });
  assert.equal(win32Policy.shouldSkipDirectory('NODE_MODULES', 'NODE_MODULES'), true);
  assert.equal(linuxPolicy.shouldSkipDirectory('NODE_MODULES', 'NODE_MODULES'), false);
});

test('describe reports the names policy and configured inputs', () => {
  const policy = createWalkIgnorePolicy({ extraSkipNames: ['vendor'] });
  assert.deepEqual(policy.describe(), {
    source: 'names',
    skipDotDirectories: true,
    extraSkipNames: ['vendor'],
  });
});
