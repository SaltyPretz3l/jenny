'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  finalizeManagedTerminalCleanup,
} = require('../services/backend/managed-sidecar-terminal-cleanup');

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
  await finalizeManagedTerminalCleanup({
    service, runtime, actorRegistry: { release: () => calls.push(['release']) },
    lease: { released: false }, sessionId: 'session_1', streamId: 'stream_1',
    terminalStatus: 'denied', deferredQuestionBatchEvent: {},
    beforeRelease: () => calls.push(['beforeRelease']),
  });
  assert.deepEqual(calls, [['resolve', false, 'denied'], ['beforeRelease']]);
});
