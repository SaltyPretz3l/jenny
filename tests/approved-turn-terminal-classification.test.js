const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createManagedChatStreamRuntime,
} = require('../services/backend/chat-stream-managed-runtime');
const {
  isDeniedTerminalStatus,
} = require('../services/backend/chat-stream-terminal-utils');

function createRuntime() {
  const emittedEvents = [];
  let activeTurn = { request_id: 'stream-approved', stream_id: 'stream-approved' };
  const service = {
    featureFlags: {},
    emit(eventName, payload) {
      emittedEvents.push({ eventName, payload });
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        return message;
      },
      setSessionPreferences() {},
      getActiveTurn() {
        return activeTurn;
      },
      setActiveTurn(_sessionId, next) {
        activeTurn = next;
        return next;
      },
      clearActiveTurn() {
        activeTurn = null;
        return null;
      },
      touchActiveTurn() {},
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-approved',
    streamId: 'stream-approved',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-approved',
  });
  return { emittedEvents, runtime };
}

test('awaiting approval is not classified as a denied terminal', async () => {
  assert.equal(isDeniedTerminalStatus('awaiting_approval'), false);
  const { runtime } = createRuntime();

  await assert.rejects(
    runtime.settleTerminalResult({
      status: 'awaiting_approval',
      tool_observations: [{ error_code: 'CMP-TOOL-0042' }],
    }),
    (error) => {
      assert.equal(error.status, 'runtime_error');
      assert.equal(error.error_code, 'CMP-TOOL-0042');
      assert.equal(error.message, 'The turn stopped while another tool approval was pending.');
      return true;
    }
  );
});

test('a genuine denied terminal carries its existing cause code', async () => {
  const { emittedEvents, runtime } = createRuntime();

  const settled = await runtime.settleTerminalResult({
    status: 'denied',
    tool_observations: [{ error_code: 'CMP-TOOL-0025' }],
  });

  assert.equal(settled.status, 'denied');
  const terminal = emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.equal(terminal.payload.error_code, 'CMP-TOOL-0025');
  assert.equal(terminal.payload.message, 'The request was denied.');
});
