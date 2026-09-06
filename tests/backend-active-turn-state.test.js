'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getManagedActiveTurnState,
  hasActiveStreamRegistry,
  hasRegisteredActiveStream,
} = require('../services/backend/backend-active-turn-state');

function activeTurn(overrides = {}) {
  return {
    request_id: 'stream-live',
    stream_id: 'stream-live',
    trace_id: 'trace-live',
    user_message_id: 'user-stream-live',
    started_at: '2026-07-12T12:00:00.000Z',
    last_event_at: '2026-07-12T12:00:01.000Z',
    status: 'streaming',
    ...overrides,
  };
}

function serviceFixture(overrides = {}) {
  const logs = [];
  const persistedTurn = overrides.persistedTurn === undefined
    ? activeTurn()
    : overrides.persistedTurn;
  const messages = overrides.messages || [];
  return {
    logs,
    service: {
      activeStreams: new Map(),
      pendingToolApprovals: new Map(),
      sessionStore: {
        getActiveTurn: () => persistedTurn,
        getSessionMessages: () => messages,
      },
      _emitServiceLog(level, event, details) {
        logs.push({ level, event, details });
      },
      ...overrides.service,
    },
  };
}

test('active stream registry helpers distinguish missing, unrelated, and matching controllers', () => {
  assert.equal(hasActiveStreamRegistry({}), false);
  assert.equal(hasRegisteredActiveStream({}, 'stream-live'), false);
  const service = { activeStreams: new Map([['stream-other', new AbortController()]]) };
  assert.equal(hasActiveStreamRegistry(service), true);
  assert.equal(hasRegisteredActiveStream(service, 'stream-live'), false);
  service.activeStreams.set('stream-live', new AbortController());
  assert.equal(hasRegisteredActiveStream(service, 'stream-live'), true);
});

test('managed active-turn state requires canonical persisted state and a matching controller', () => {
  const { service } = serviceFixture();
  assert.equal(getManagedActiveTurnState(service, 'session-live'), null);
  service.activeStreams.set('stream-other', new AbortController());
  assert.equal(getManagedActiveTurnState(service, 'session-live'), null);
  service.activeStreams.set('stream-live', new AbortController());

  assert.deepEqual(getManagedActiveTurnState(service, 'session-live'), {
    ...activeTurn(),
    session_id: 'session-live',
    state: 'streaming',
    phase: null,
    terminal_reason: null,
    terminal_subcode: null,
  });
});

test('managed active-turn state enriches the matching live Electron approval', () => {
  const { service } = serviceFixture({
    messages: [{
      kind: 'tool_use',
      content: 'fallback summary',
      tool_call: {
        call_id: 'call-live',
        status: 'pending_approval',
        summary: 'write_file notes.md',
      },
    }],
  });
  service.activeStreams.set('stream-live', new AbortController());
  service.pendingToolApprovals.set('approval-live', {
    approvalId: 'approval-live',
    sessionId: 'session-live',
    streamId: 'stream-live',
    callId: 'call-live',
    toolName: 'write_file',
    policyScope: 'Workspace files',
    policyConsequence: 'May change data in this scope.',
    reason: 'This command can overwrite files. Approve to continue.',
  });
  service.pendingToolApprovals.set('approval-other', {
    approvalId: 'approval-other',
    sessionId: 'session-other',
    streamId: 'stream-live',
    callId: 'call-other',
    toolName: 'shell',
  });

  const snapshot = getManagedActiveTurnState(service, 'session-live');
  assert.equal(snapshot.state, 'pending_approval');
  assert.equal(snapshot.phase, 'approval_wait');
  assert.deepEqual(snapshot.pending_approval, {
    approval_id: 'approval-live',
    call_id: 'call-live',
    tool_name: 'write_file',
    policy_scope: 'Workspace files',
    policy_consequence: 'May change data in this scope.',
    reason: 'This command can overwrite files. Approve to continue.',
    summary: 'write_file notes.md',
  });
});

test('active-turn state fails closed for malformed or unavailable owners', () => {
  const { service } = serviceFixture();
  service.activeStreams.set('stream-live', new AbortController());
  assert.equal(getManagedActiveTurnState(service, ''), null);
  service.activeStreams = null;
  assert.equal(getManagedActiveTurnState(service, 'session-live'), null);
});

test('active-turn state logs and degrades to null when the persisted-state read fails', () => {
  const { service, logs } = serviceFixture({
    service: {
      activeStreams: new Map([['stream-live', new AbortController()]]),
      sessionStore: {
        getActiveTurn() {
          throw new Error('store unavailable');
        },
      },
    },
  });

  assert.equal(getManagedActiveTurnState(service, 'session-live'), null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].event, 'backend.active_turn_state_read_failed');
});
