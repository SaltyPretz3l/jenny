// A turn with successful tool work must settle with visible assistant text,
// even when the model's final segment is blank. These tests pin Electron's
// last-resort fallback and preserve fail-closed behavior for genuinely
// reasoning-only or failed-only turns.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createManagedChatStreamRuntime,
} = require('../services/backend/chat-stream-managed-runtime');

function buildServiceStub() {
  const persistedMessages = [];
  const logs = [];
  return {
    persistedMessages,
    logs,
    service: {
      featureFlags: {},
      emit() {},
      _emitServiceLog(level, event, details) {
        logs.push({ level, event, details });
      },
      renameSession: async () => null,
      sessionStore: {
        appendMessage(sessionId, message) {
          persistedMessages.push(message);
          return { id: sessionId };
        },
        setSessionPreferences() { return null; },
        getActiveTurn() { return null; },
        setActiveTurn() { return null; },
        touchActiveTurn() { return null; },
        clearActiveTurn() { return null; },
        getSessionMessages() { return []; },
      },
    },
  };
}

function buildRuntime(service, streamId) {
  return createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-toolwork-1',
    streamId,
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: `user-${streamId}`,
  });
}

const NOTIFICATION_DEPS = {
  toolContext: {},
  handleToolNotification() {},
};

function sendReasoning(runtime, text) {
  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: text,
      thinking_id: 'think_toolwork',
      kind: 'reasoning',
      persist: false,
    },
  }, NOTIFICATION_DEPS);
}

function sendToolRoundTrip(runtime, { success, callId = 'call_1' }) {
  runtime.handleNotification({
    method: 'tool.executing',
    params: { tool_call_id: callId, tool_name: 'create_artifact' },
  }, NOTIFICATION_DEPS);
  runtime.handleNotification({
    method: 'tool.result',
    params: { tool_call_id: callId, tool_name: 'create_artifact', success },
  }, NOTIFICATION_DEPS);
}

test('reasoning-only ending after a COMPLETED tool settles with visible fallback text', async () => {
  const { service, persistedMessages, logs } = buildServiceStub();
  const runtime = buildRuntime(service, 'stream-toolwork-ok');

  sendReasoning(runtime, 'Planning the artifact.');
  sendToolRoundTrip(runtime, { success: true });

  const result = await runtime.settleTerminalResult({ status: 'completed' });
  assert.equal(result.status, 'completed');
  assert.equal(runtime.isVisibleCompletionEmitted(), true);

  const errorState = runtime.getErrorState();
  assert.notEqual(String(errorState?.sidecarErrorCode || ''), 'CMP-STREAM-REASONING-ONLY');

  // The classification is logged as a WARN and recovered with a visible message.
  const recoveryLog = logs.find((entry) => entry.event === 'chat.toolwork_only_completion');
  assert.ok(recoveryLog);
  assert.equal(recoveryLog.details.fallback, 'visible_message');
  assert.equal(logs.some((entry) => entry.event === 'chat.thinking_only_completion'), false);

  const fallbackMessage = persistedMessages.find((message) =>
    message.role === 'assistant'
    && String(message.content || '').includes('Tool work completed successfully'));
  assert.ok(fallbackMessage, 'the successful tool-only turn persists visible fallback text');

  // No empty final assistant bubble remains after recovery.
  const emptyFinalBubbles = persistedMessages.filter((message) =>
    message.role === 'assistant'
    && !String(message.content || '').trim()
    && !(message.reasoning && message.reasoning.entries && message.reasoning.entries.length)
  );
  assert.equal(emptyFinalBubbles.length, 0);
});

test('reasoning-only ending with NO tool work still fails closed as CMP-STREAM-REASONING-ONLY', async () => {
  const { service } = buildServiceStub();
  const runtime = buildRuntime(service, 'stream-toolwork-none');

  sendReasoning(runtime, 'Thinking without answering.');

  await assert.rejects(
    () => runtime.settleTerminalResult({ status: 'completed' }),
    /no visible assistant text/i
  );
  const errorState = runtime.getErrorState();
  assert.equal(String(errorState?.sidecarErrorCode || ''), 'CMP-STREAM-REASONING-ONLY');
});

test('a FAILED tool does not rescue a reasoning-only ending', async () => {
  const { service } = buildServiceStub();
  const runtime = buildRuntime(service, 'stream-toolwork-failed');

  sendReasoning(runtime, 'Trying a tool that fails.');
  sendToolRoundTrip(runtime, { success: false });

  await assert.rejects(
    () => runtime.settleTerminalResult({ status: 'completed' }),
    /no visible assistant text/i
  );
});

test('mixed tool outcomes produce an accurate visible fallback', async () => {
  const { service, persistedMessages, logs } = buildServiceStub();
  const runtime = buildRuntime(service, 'stream-toolwork-mixed');

  sendToolRoundTrip(runtime, { success: true, callId: 'call_ok' });
  sendToolRoundTrip(runtime, { success: false, callId: 'call_failed' });

  const result = await runtime.settleTerminalResult({ status: 'completed' });
  assert.equal(result.status, 'completed');
  const fallbackMessage = persistedMessages.find((message) =>
    message.role === 'assistant'
    && String(message.content || '').includes('1 successful and 1 failed'));
  assert.ok(fallbackMessage, 'the mixed outcome fallback reports both result classes');
  const recoveryLog = logs.find((entry) => entry.event === 'chat.toolwork_only_completion');
  assert.equal(recoveryLog?.details?.completedToolResultCount, 1);
  assert.equal(recoveryLog?.details?.failedToolResultCount, 1);
});

test('visible text still completes exactly as before when a tool ran', async () => {
  const { service, persistedMessages } = buildServiceStub();
  const runtime = buildRuntime(service, 'stream-toolwork-text');

  sendToolRoundTrip(runtime, { success: true });
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Here you go.' },
  }, NOTIFICATION_DEPS);

  const result = await runtime.settleTerminalResult({ status: 'completed' });
  assert.equal(result.status, 'completed');
  const finalAssistant = persistedMessages.find((message) =>
    message.role === 'assistant' && String(message.content || '').includes('Here you go.'));
  assert.ok(finalAssistant, 'the visible final answer persists as before');
  assert.equal(
    persistedMessages.some((message) =>
      String(message.content || '').includes('Tool work completed successfully')),
    false,
    'a normal visible answer is never duplicated with fallback text'
  );
});
