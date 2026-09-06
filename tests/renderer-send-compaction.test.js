const test = require('node:test');
const assert = require('node:assert/strict');

const { createControllerHarness } = require('./helpers/send-controller-harness');

test('startPromptSend blocks instead of queueing while that session is compacting', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: 'Do not queue this',
    compactionCoordinator: {
      isPending(sessionId) { return sessionId === 'session-1'; },
      clearSettled() { throw new Error('pending compaction must not be cleared'); },
    },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('Do not queue this');

  assert.deepEqual(result, { rejected: true, reason: 'session_compacting', sessionId: 'session-1' });
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.optimisticAppend.length, 0);
  assert.equal(harness.state.queuedSendBySession.has('session-1'), false);
  assert.match(harness.calls.composerNotices.at(-1).message, /Compacting context/i);
  assert.equal(harness.calls.logs.some((entry) => entry.event === 'chat.send_blocked' && entry.details.reason === 'session_compacting'), true);
});

test('a retry blocked by compaction keeps the original failure marker visible', async (t) => {
  let compacting = false;
  const harness = createControllerHarness([], {
    chatInputValue: 'original',
    compactionCoordinator: {
      isPending: () => compacting,
      clearSettled() {},
    },
    startStream: async () => {
      const error = new Error('transport unavailable');
      error.code = 'CMP-CHAT-0002';
      throw error;
    },
  });
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('original', { restoreInputOnError: true });
  const failed = harness.state.messagesBySession.get('session-1')
    .find((message) => message.send_failure?.payload_id);
  compacting = true;

  const result = await harness.controller.retryFailedPayload(failed.send_failure.payload_id);
  const current = harness.state.messagesBySession.get('session-1')
    .find((message) => message.id === failed.id);

  assert.deepEqual(result, { rejected: true, reason: 'session_compacting', sessionId: 'session-1' });
  assert.notEqual(current.send_failure.dismissed, true);
  assert.equal(harness.calls.startStream.length, 1);
});
