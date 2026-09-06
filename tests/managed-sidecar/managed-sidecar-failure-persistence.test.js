const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createManagedChatStreamRuntime,
} = require('../../services/backend/chat-stream-managed-runtime');

function createRuntimeHarness({ streamId = 'stream-failure', sessionId = 'session-failure' } = {}) {
  const persistedMessages = [];
  const storeCalls = [];
  let activeTurn = { request_id: streamId, stream_id: streamId };
  const service = {
    featureFlags: { phase_events: true },
    emit() {},
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        storeCalls.push(['appendMessage', message.id]);
        persistedMessages.push(message);
        return message;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return activeTurn; },
      setActiveTurn(_sessionId, next) {
        storeCalls.push(['setActiveTurn']);
        activeTurn = next;
        return next;
      },
      touchActiveTurn() { return null; },
      clearActiveTurn() {
        storeCalls.push(['clearActiveTurn']);
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
    persistedMessages,
    storeCalls,
    getActiveTurn: () => activeTurn,
    emitToken(delta) {
      runtime.handleNotification({ method: 'chat.token', params: { delta } }, notificationContext);
    },
    emitToolRound(callId = 'call_failure') {
      runtime.handleNotification({
        method: 'tool.executing',
        params: { tool_call_id: callId, tool_name: 'worktree_create', tool_input: {} },
      }, notificationContext);
      runtime.handleNotification({
        method: 'tool.result',
        params: { tool_call_id: callId, tool_name: 'worktree_create', success: true, output: 'ok' },
      }, notificationContext);
    },
    emitQuestionBatch() {
      runtime.handleNotification({
        method: 'chat.question_batch',
        params: {
          batch: {
            object: 'jenny.interactive.question_batch',
            batch_id: 'ib_1',
            round_index: 1,
            intro_text: 'Quick question first.',
            questions: [{
              id: 'q1',
              prompt: 'Which one?',
              options: [
                { id: 'a', label: 'Option A' },
                { id: 'b', label: 'Option B' },
              ],
            }],
          },
        },
      }, notificationContext);
    },
  };
}

const CRASH_PAYLOAD = {
  message: 'Sidecar process exited.',
  error_code: 'CMP-SIDECAR-0003',
  retryable: true,
  category: 'process_exit',
  status: 'runtime_error',
  terminal_subcode: 'sidecar_crash',
};

test('shouldPersistFailureMessage stays true when partial text streamed (Trace B gate)', () => {
  const harness = createRuntimeHarness();
  assert.equal(harness.runtime.shouldPersistFailureMessage(), true);
  harness.emitToken('A partial ');
  harness.emitToken('answer.');
  assert.equal(
    harness.runtime.shouldPersistFailureMessage(),
    true,
    'partial streamed text must strengthen the case for persistence, not veto it'
  );
});

test('shouldPersistFailureMessage stays true after a tool boundary persisted a segment', () => {
  const harness = createRuntimeHarness();
  harness.emitToken('Before tool.');
  harness.emitToolRound();
  assert.equal(harness.runtime.shouldPersistFailureMessage(), true);
});

test('shouldPersistFailureMessage vetoes after a settled visible completion', async () => {
  const harness = createRuntimeHarness();
  harness.emitToken('Full answer.');
  await harness.runtime.settleTerminalResult({ status: 'completed' });
  assert.equal(harness.runtime.shouldPersistFailureMessage(), false);
});

test('shouldPersistFailureMessage vetoes after a question batch arrived', () => {
  const harness = createRuntimeHarness();
  harness.emitQuestionBatch();
  assert.equal(harness.runtime.shouldPersistFailureMessage(), false);
});

test('persistFailureMessage threads the streamed partial text into the failure row', () => {
  const harness = createRuntimeHarness({ streamId: 'stream-crash-text' });
  harness.emitToken('The answer is ');
  harness.emitToken('forty-two.');

  harness.runtime.persistFailureMessage(CRASH_PAYLOAD);

  const failureRow = harness.persistedMessages.find(
    (message) => message.id === 'assistant_stream-crash-text'
  );
  assert.ok(failureRow, 'failure row persisted');
  assert.equal(failureRow.content, 'The answer is forty-two.');
  assert.equal(failureRow.status, 'runtime_error');
  assert.equal(failureRow.terminal_status, 'runtime_error');
  assert.equal(failureRow.stream_error, 'Sidecar process exited.');
  assert.equal(failureRow.parent_stream_id, 'stream-crash-text');
  const visibleText = (failureRow.visible_segments || [])
    .map((segment) => segment.text)
    .join('');
  assert.equal(visibleText, 'The answer is forty-two.');
});

test('persistFailureMessage persists only the unpersisted tail after a tool boundary', () => {
  const harness = createRuntimeHarness({ streamId: 'stream-crash-tail' });
  harness.emitToken('Before the tool.');
  harness.emitToolRound();
  harness.emitToken('After the tool, then crash.');

  harness.runtime.persistFailureMessage(CRASH_PAYLOAD);

  const segmentRow = harness.persistedMessages.find(
    (message) => message.id === 'assistant_stream-crash-tail_seg0'
  );
  assert.ok(segmentRow, 'pre-tool segment row persisted at the boundary');
  assert.equal(segmentRow.content, 'Before the tool.');

  const failureRow = harness.persistedMessages.find(
    (message) => message.id === 'assistant_stream-crash-tail'
  );
  assert.ok(failureRow, 'failure row persisted');
  assert.equal(
    failureRow.content,
    'After the tool, then crash.',
    'failure row must carry only the tail the segment rows do not already hold'
  );
});

test('persistFailureMessage clears the active turn only after the failure row is appended', () => {
  const harness = createRuntimeHarness({ streamId: 'stream-crash-order' });
  harness.emitToken('Partial.');

  assert.ok(harness.getActiveTurn(), 'active turn armed before the failure');
  harness.runtime.persistFailureMessage(CRASH_PAYLOAD);

  assert.equal(harness.getActiveTurn(), null, 'active turn cleared after persistence');
  const appendIndex = harness.storeCalls.findIndex(
    ([name, id]) => name === 'appendMessage' && id === 'assistant_stream-crash-order'
  );
  const clearIndex = harness.storeCalls.findIndex(([name]) => name === 'clearActiveTurn');
  assert.ok(appendIndex !== -1 && clearIndex !== -1);
  assert.ok(
    appendIndex < clearIndex,
    'the reconciler marker must outlive the persistence write (defense in depth)'
  );
});
