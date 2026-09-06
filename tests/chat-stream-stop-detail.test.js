'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeResumableStop,
} = require('../services/backend/chat-stream-stop-detail');

test('normalizeResumableStop preserves supported stop details', () => {
  for (const value of [
    'tool_cap',
    'max_iterations',
    'diminishing_returns',
    'context_budget',
  ]) {
    assert.equal(normalizeResumableStop(value), value);
  }
  assert.equal(normalizeResumableStop('  tool_cap  '), 'tool_cap');
});

test('normalizeResumableStop rejects unsupported values without throwing', () => {
  for (const value of [
    undefined,
    null,
    '',
    '   ',
    'TOOL_CAP',
    'nonsense',
    0,
    false,
    {},
    [],
  ]) {
    assert.doesNotThrow(() => normalizeResumableStop(value));
    assert.equal(normalizeResumableStop(value), null);
  }
});
