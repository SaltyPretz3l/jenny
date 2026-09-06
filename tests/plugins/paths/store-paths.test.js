'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OPERATION_ID_PATTERN,
  STAGING_DIR,
  isContainedIn,
  isValidOperationId,
  pluginDataDir,
  stagingDir,
} = require('../../../services/plugins/paths/store-paths.js');

const { DATA_DIR } = require('../../../services/plugins/store/cleanup-state');

const BASE = 'plugins';

test('isContainedIn: baseDir itself and its descendants are contained', () => {
  assert.equal(isContainedIn(BASE, BASE), true);
  assert.equal(isContainedIn(BASE, `${BASE}/generations`), true);
  assert.equal(isContainedIn(BASE, `${BASE}/generations/gen-1/control-plane.json`), true);
});

test('isContainedIn: a sibling or ancestor path is NOT contained', () => {
  assert.equal(isContainedIn(BASE, 'other'), false);
  assert.equal(isContainedIn(BASE, ''), false);
  assert.equal(isContainedIn(BASE, 'pluginsx/generations'), false, 'prefix-of-name collision must not count as contained');
});

test('isContainedIn: "" as baseDir means the whole facade root, everything is contained', () => {
  assert.equal(isContainedIn('', 'anything/at/all'), true);
  assert.equal(isContainedIn('', ''), true);
});

test('pluginDataDir composes DATA_DIR without re-declaring it', () => {
  const dir = pluginDataDir(BASE, 'acme-labs', 'widgets');
  assert.equal(dir, `${BASE}/${DATA_DIR}/acme-labs/widgets`);
  assert.equal(isContainedIn(BASE, dir), true);
});

// --- stagingDir: validate-or-reject, never interpolate ---------------------

test('stagingDir accepts a well-formed operation id and returns a contained path', () => {
  const result = stagingDir(BASE, 'op-12345');
  assert.equal(result.ok, true);
  assert.equal(result.path, `${BASE}/${STAGING_DIR}/op-12345`);
  assert.equal(isContainedIn(BASE, result.path), true);
});

test('stagingDir rejects a path-traversal operation id instead of interpolating it', () => {
  for (const hostile of ['../escape', '..', 'a/../../b', './x', 'a/b']) {
    const result = stagingDir(BASE, hostile);
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(hostile)}`);
    assert.equal(result.reason, 'invalid_operation_id');
  }
});

test('stagingDir rejects a separator-bearing or backslash operation id', () => {
  for (const hostile of ['a/b', 'a\\b', 'a:b', '']) {
    assert.equal(stagingDir(BASE, hostile).ok, false, `expected rejection for ${JSON.stringify(hostile)}`);
  }
});

test('stagingDir rejects a non-string or over-length operation id', () => {
  assert.equal(stagingDir(BASE, null).ok, false);
  assert.equal(stagingDir(BASE, undefined).ok, false);
  assert.equal(stagingDir(BASE, 123).ok, false);
  assert.equal(stagingDir(BASE, 'a'.repeat(65)).ok, false);
  assert.equal(stagingDir(BASE, 'a'.repeat(64)).ok, true);
});

test('OPERATION_ID_PATTERN / isValidOperationId agree', () => {
  assert.equal(isValidOperationId('op-1_2'), true);
  assert.equal(OPERATION_ID_PATTERN.test('op-1_2'), true);
  assert.equal(isValidOperationId('bad/id'), false);
  assert.equal(isValidOperationId(''), false);
});
