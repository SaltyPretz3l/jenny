'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeId,
  normalizeString,
} = require('../services/shared/normalize');

test('shared service normalizers preserve the legacy value-or-empty-string semantics', () => {
  assert.equal(normalizeId, normalizeString);
  assert.equal(normalizeString('  value  '), 'value');
  assert.equal(normalizeString(undefined), '');
  assert.equal(normalizeString(null), '');
  assert.equal(normalizeString(0), '');
  assert.equal(normalizeString(false), '');
  assert.equal(normalizeString(42), '42');
});
