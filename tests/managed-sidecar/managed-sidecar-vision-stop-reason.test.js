const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createManagedChatStreamRuntime,
} = require('../../services/backend/chat-stream-managed-runtime');

function createRuntimeHarness({ streamId = 'stream-vision', sessionId = 'session-vision' } = {}) {
  let activeTurn = { request_id: streamId, stream_id: streamId };
  const service = {
    featureFlags: { phase_events: true },
    emit() {},
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        return message;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return activeTurn; },
      setActiveTurn(_sessionId, next) {
        activeTurn = next;
        return next;
      },
      touchActiveTurn() { return null; },
      clearActiveTurn() {
        activeTurn = null;
        return null;
      },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: sessionId,
    streamId,
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: `user_${streamId}`,
  });
  const notificationContext = {
    toolContext: {},
    handleToolNotification() {},
  };
  return {
    runtime,
    emitToken(delta) {
      runtime.handleNotification({ method: 'chat.token', params: { delta } }, notificationContext);
    },
    emitDone(stopReason) {
      runtime.handleNotification({
        method: 'chat.done',
        params: { stop_reason: stopReason, usage: {} },
      }, notificationContext);
    },
  };
}

test('chat.done with stop_reason max_tokens settles as a successful completion', async () => {
  const harness = createRuntimeHarness({ streamId: 'stream-vision-truncated' });
  harness.emitToken('A truncated vision answer');
  harness.emitDone('max_tokens');

  const result = await harness.runtime.settleTerminalResult({ status: 'completed' });

  assert.equal(
    result.status,
    'completed',
    'a budget-truncated turn is still a successful completion, not a terminal error'
  );
});

test('chat.done with an unrecognized stop_reason still settles as a terminal error', async () => {
  const harness = createRuntimeHarness({ streamId: 'stream-vision-bad-stop' });
  harness.emitToken('Some text');
  harness.emitDone('content_filter');

  await assert.rejects(
    () => harness.runtime.settleTerminalResult({ status: 'completed' }),
    (error) => /content_filter/.test(String((error && error.message) || ''))
  );
});
