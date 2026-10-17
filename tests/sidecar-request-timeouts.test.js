'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_REQUEST_TIMEOUT_MS,
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
  assert.equal(resolveRequestTimeoutMs('memory.pending.accept', { timeoutMs: undefined }), 10_000);
});

test('reflection: memory.reflect gets 120 s and the inline reflection methods keep the default', () => {
  assert.equal(resolveRequestTimeoutMs('memory.reflect', {}), 120_000);
  for (const method of ['memory.reflection_state', 'memory.policy_epoch', 'memory.apply']) {
    assert.equal(resolveRequestTimeoutMs(method, {}), DEFAULT_REQUEST_TIMEOUT_MS, method);
  }
});

test('conversation index and embed-step RPCs have bounded timeouts (row 58 W4)', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(REQUEST_TIMEOUT_MS_BY_METHOD)
    .filter(([method]) => method.startsWith('conversations.') || method === 'memory.embed_step')), {
    'conversations.index_state': 10_000,
    'conversations.index_session': 15_000,
    'conversations.purge': 10_000,
    'conversations.search': 5_000,
    'conversations.embed_step': 35_000,
    'memory.embed_step': 8_000,
  });
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
      'workspace.reapply_change_set': 300_000,
      'workspace.restore_trash_entry': 300_000,
      'workspace.abandon_restore': 60_000,
      'workspace.apply_suggested_changes': 120_000,
    }
  );
});

test('intentional null and zero overrides still disable a request timeout', () => {
  assert.equal(resolveRequestTimeoutMs('initialize', { timeoutMs: null }), null);
  assert.equal(resolveRequestTimeoutMs('initialize', { timeoutMs: 0 }), null);
});

test('Settings memory page RPCs get the 10 s management budget', () => {
  for (const method of ['memory.erase', 'memory.operations', 'memory.restore', 'memory.clear_suppressions', 'memory.list']) {
    assert.equal(resolveRequestTimeoutMs(method, {}), 10_000, method);
  }
});
