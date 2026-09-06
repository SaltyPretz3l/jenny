const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureArray,
  isPlainObject,
} = require('../services/value-utils');

test('isPlainObject accepts plain object records only', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Map()), false);
  assert.equal(isPlainObject('object'), false);
});

test('ensureArray returns arrays and preserves fallback identity', () => {
  const source = [1, 2, 3];
  const fallback = ['fallback'];

  assert.equal(ensureArray(source), source);
  assert.deepEqual(ensureArray(null), []);
  assert.equal(ensureArray('nope', fallback), fallback);
});
