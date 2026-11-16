'use strict';

// new-test-file: tests/renderer-message-index-utils.test.js is at the line ceiling (1014 lines).
// identity-retry 8: an error message replaced under the same id with only its
// error or recovery fields changed must get a new projection fingerprint, or the
// per-turn projection cache serves the old rows (the old error card).

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessageProjectionFingerprint } = require('../renderer/chat/renderer-message-index-utils');

function errorMessage(overrides = {}) {
  return {
    id: 'assistant_err', role: 'assistant', kind: '', status: 'error', content: '', finalizedAt: '2026-11-12T10:00:00Z',
    stream_error: 'The engine stopped.', error_code: 'CMP-ENGINE-0001', recovery_title: 'Try again',
    recovery_actions: [{ id: 'retry', label: 'Retry' }], terminal_subcode: 'engine_exit', ...overrides,
  };
}

test('a same-id error replacement that changes only an error or recovery field gets a new fingerprint', () => {
  for (const [field, value] of [
    ['stream_error', 'The engine ran out of memory.'],
    ['error_code', 'CMP-ENGINE-0002'],
    ['recovery_title', 'Restart the engine'],
    ['recovery_actions', [{ id: 'retry', label: 'Retry' }, { id: 'restart_engine', label: 'Restart engine' }]],
    ['terminal_subcode', 'engine_oom'],
  ]) {
    const before = buildMessageProjectionFingerprint(errorMessage());
    assert.notEqual(buildMessageProjectionFingerprint(errorMessage({ [field]: value })), before, `${field} reaches the fingerprint`);
  }
  const settled = buildMessageProjectionFingerprint(errorMessage());
  assert.equal(buildMessageProjectionFingerprint(errorMessage()), settled, 'an identical replacement keeps the fingerprint');
});
