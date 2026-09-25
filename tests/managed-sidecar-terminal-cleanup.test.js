'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  finalizeManagedTerminalCleanup,
  noteRuntimeInferenceSettlement,
} = require('../services/backend/managed-sidecar-terminal-cleanup');

function legacyService() {
  return {
    pendingToolApprovals: new Map(),
    sessionStore: { getSessionMessages: () => [] },
    _emitServiceLog() {},
  };
}

function turnCollector() {
  return { turnId: 'turn_1', persistFinalizedTurn: () => ({ ok: true }) };
}

test('runtime inference and tool notifications follow only accepted settlement frames', () => {
  let notifications = 0;
  const notify = () => { notifications += 1; };
  const accepted = { status: 'settled' };
  assert.equal(noteRuntimeInferenceSettlement({ kind: 'inference', phase: 'settle' }, accepted, notify), accepted);
  noteRuntimeInferenceSettlement({ kind: 'inference', phase: 'admit' }, accepted, notify);
  noteRuntimeInferenceSettlement({ kind: 'tool', phase: 'settle' }, accepted, notify);
  noteRuntimeInferenceSettlement({ kind: 'inference', phase: 'settle' }, { status: 'rejected' }, notify);
  noteRuntimeInferenceSettlement({ kind: 'continuation', phase: 'settle' }, accepted, notify);
  assert.equal(notifications, 2);
});

test('coordinator-owned cleanup drains waiters without legacy release or deferred emit', async () => {
  const calls = [];
  const service = {
    pendingToolApprovals: new Map([['call_1', {
      streamId: 'stream_1', resolve: (...args) => calls.push(['resolve', ...args]),
    }]]),
  };
  const runtime = {
    isTerminalCoordinatorHandled: () => true,
    emitQuestionBatchEvent: () => calls.push(['question']),
  };
  const result = await finalizeManagedTerminalCleanup({
    service, runtime, actorRegistry: { release: () => calls.push(['release']) },
    lease: { released: false }, sessionId: 'session_1', streamId: 'stream_1',
    terminalStatus: 'denied', deferredQuestionBatchEvent: {},
    beforeRelease: () => calls.push(['beforeRelease']),
  });
  assert.deepEqual(calls, [['resolve', false, 'denied'], ['beforeRelease']]);
  assert.equal(result.canonicalSettled, false);
});

test('legacy cleanup reports canonical proof only for an unblocked actor release', async () => {
  const lease = { released: false };
  const result = await finalizeManagedTerminalCleanup({
    service: legacyService(),
    runtime: {
      isTerminalCoordinatorHandled: () => false,
      shouldPreserveActiveTurnOnRelease: () => false,
      emitQuestionBatchEvent() {},
    },
    actorRegistry: { release: () => {
      lease.released = true;
      return { released: true, recoveryBlocked: 'active_turn_release_failed' };
    } },
    lease, turnEventCollector: turnCollector(), sessionId: 'session_1', streamId: 'stream_1',
    terminalStatus: 'failed',
  });
  assert.equal(result.canonicalSettled, false);

  const cleanLease = { released: false };
  const clean = await finalizeManagedTerminalCleanup({
    service: legacyService(),
    runtime: {
      isTerminalCoordinatorHandled: () => false,
      shouldPreserveActiveTurnOnRelease: () => false,
      emitQuestionBatchEvent() {},
    },
    actorRegistry: { release: () => {
      cleanLease.released = true;
      return { released: true };
    } },
    lease: cleanLease, turnEventCollector: turnCollector(), sessionId: 'session_2', streamId: 'stream_2',
    terminalStatus: 'completed',
  });
  assert.equal(clean.canonicalSettled, true);
});
