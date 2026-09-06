'use strict';

// L1 lease_conflict diagnostics wiring (Chat Lifecycle v2 plan §4): the
// managed active_turn CAS-claim refusal is one of the two backend
// lease-conflict sites this wave wires into
// services/backend/chat-lifecycle-diagnostics.js's shared counter.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  logAndBuildActiveTurnClaimRefusedError,
  logAndBuildUserMessagePersistRefusedError,
} = require('../services/backend/chat-stream-managed-runtime-admission-claim');
const {
  resetLifecycleDiagnosticCounts,
  getLifecycleDiagnosticCounts,
} = require('../services/backend/chat-lifecycle-diagnostics');

test.beforeEach(() => {
  resetLifecycleDiagnosticCounts();
});

function makeFakeService() {
  const logs = [];
  return {
    logs,
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };
}

test('logAndBuildActiveTurnClaimRefusedError logs the refusal and records a managed lease_conflict diagnostic', () => {
  const service = makeFakeService();

  const error = logAndBuildActiveTurnClaimRefusedError(service, {
    sessionId: 'session-1',
    streamId: 'stream-1',
    userMessageId: 'user-1',
  });

  assert.ok(error instanceof Error);

  const refusalLogs = service.logs.filter((entry) => entry.event === 'chat.active_turn_claim_refused');
  assert.equal(refusalLogs.length, 1, 'the existing refusal log must still fire unchanged');

  const lifecycleLogs = service.logs.filter((entry) => entry.event === 'lifecycle.lease_conflict');
  assert.equal(lifecycleLogs.length, 1, 'the claim refusal must record a lifecycle.lease_conflict diagnostic');
  assert.equal(lifecycleLogs[0].level, 'WARN');
  assert.equal(lifecycleLogs[0].details.path, 'managed');
  assert.equal(lifecycleLogs[0].details.sessionId, 'session-1');
  assert.equal(lifecycleLogs[0].details.streamId, 'stream-1');

  assert.deepEqual(getLifecycleDiagnosticCounts(), { lease_conflict: 1 });
});

test('logAndBuildUserMessagePersistRefusedError does not record a lease_conflict diagnostic (different refusal class)', () => {
  const service = makeFakeService();

  logAndBuildUserMessagePersistRefusedError(service, {
    sessionId: 'session-1',
    streamId: 'stream-1',
    userMessageId: 'user-1',
    reason: 'write_failed',
  });

  assert.deepEqual(getLifecycleDiagnosticCounts(), {});
});
