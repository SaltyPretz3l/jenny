'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUEST_TIMEOUT_MS_BY_METHOD,
  resolveRequestTimeoutMs,
} = require('../services/backend/sidecar-request-timeouts');

test('undefined wrapper values preserve the method default timeout', () => {
  assert.equal(
    resolveRequestTimeoutMs('initialize', { timeoutMs: undefined }),
    REQUEST_TIMEOUT_MS_BY_METHOD.initialize
  );
  assert.equal(resolveRequestTimeoutMs('chat.send', { timeoutMs: undefined }), 360_000);
  assert.equal(resolveRequestTimeoutMs('memory.status', { timeoutMs: undefined }), 5_000);
});

test('retired active-turn RPC has no transport-specific timeout policy', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(REQUEST_TIMEOUT_MS_BY_METHOD, 'chat.get_active_turn_state'),
    false
  );
});

test('workspace recovery RPCs have operation-sized timeout budgets', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(REQUEST_TIMEOUT_MS_BY_METHOD)
      .filter(([method]) => method.startsWith('workspace.'))),
    {
      'workspace.list_change_sets': 60_000,
      'workspace.preflight_undo': 300_000,
      'workspace.undo_change_set': 300_000,
      'workspace.restore_trash_entry': 300_000,
      'workspace.abandon_restore': 60_000,
    }
  );
});

test('intentional null and zero overrides still disable a request timeout', () => {
  assert.equal(resolveRequestTimeoutMs('initialize', { timeoutMs: null }), null);
  assert.equal(resolveRequestTimeoutMs('initialize', { timeoutMs: 0 }), null);
});
