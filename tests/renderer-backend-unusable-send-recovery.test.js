const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

// Defense-in-depth: a streaming turn whose terminal chat-stream event never
// arrives (sidecar crash / unexpected exit) must not leave the composer
// permanently disabled for that session. When the backend reports an unusable
// phase, the renderer should clear the per-session send lifecycle + registered
// stream so the composer recovers once the backend comes back.
test('renderer un-sticks the composer when the backend fails mid-stream without a terminal event', async (t) => {
  const { window, shell, dispose } = await loadRendererApp({
    shell: {
      chat: {
        async startStream(payload, { state, emitChat }) {
          const sessionId = payload.sessionId || 'session-stuck';
          state.sessions = [{
            id: sessionId,
            title: 'Stuck Session',
            conversation_mode: 'chat',
            preferred_model: 'gpt-test',
            reasoning_effort: 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          await emitChat({ type: 'started', sessionId, streamId: 'stream-stuck' });
          await emitChat({
            type: 'delta',
            sessionId,
            streamId: 'stream-stuck',
            content: 'Partial answer',
            aggregate: 'Partial answer',
          });
          // Intentionally never emit a terminal (done/error) event.
          return { sessionId, streamId: 'stream-stuck' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'This will get stuck';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();

  await waitForUiState(window, () => {
    const controller = window.rendererMultiStreamController;
    return Boolean(controller && controller.getStreamingSessionIds().length);
  }, { timeoutMs: 1500, message: 'stream was never registered while sending' });

  const controller = window.rendererMultiStreamController;
  const sessionId = shell.__state.sessions[0].id;
  const lifecycleStore = window.__rendererState.ui.chatSendLifecycleBySession;

  // Sanity: the session is busy/streaming and the composer is disabled.
  assert.equal(controller.isSessionStreaming(sessionId), true);
  assert.equal(controller.isAnySendBusy(), true);
  assert.equal(lifecycleStore.get(sessionId), 'streaming');
  assert.equal(sendButton.disabled, true);

  // Backend dies without ever delivering a terminal chat-stream event.
  await shell.__emitBackendStatus({ phase: 'failed', detail: 'sidecar crashed', mode: 'managed-dev' });
  await waitForUi(window, 40);

  // The in-flight send lifecycle and registered stream are cleared, so the
  // session is no longer considered busy.
  assert.equal(lifecycleStore.has(sessionId), false, 'send lifecycle should be cleared');
  assert.equal(controller.isSessionStreaming(sessionId), false, 'stream should be unregistered');
  assert.equal(controller.isAnySendBusy(), false, 'no session should still be busy');
  assert.equal(controller.isSessionInPreflight(sessionId), false);

  // The stranded assistant message is surfaced as an error (reusing the
  // existing terminal-error rendering shape).
  const messages = window.__rendererState.messagesBySession.get(sessionId) || [];
  const erroredAssistant = messages.find((message) => (
    message
    && message.role === 'assistant'
    && String(message.status || '').toLowerCase() === 'error'
  ));
  assert.ok(erroredAssistant, 'stranded assistant message should be marked errored');
  assert.match(String(erroredAssistant.stream_error || ''), /backend connection failed/i);

  // While the backend is failed the composer is still gated by the backend
  // phase. Once the backend recovers, the composer must be usable again --
  // which only happens because the per-session state above was cleared.
  await shell.__emitBackendStatus({ phase: 'ready', detail: '', mode: 'managed-dev' });
  await waitForUi(window, 40);

  assert.equal(window.__rendererState.backend.phase, 'ready');
  assert.equal(controller.isSessionStreaming(sessionId), false);
  // The send button also stays disabled while the composer draft is empty, so
  // type a fresh draft (as a user would) before asserting recovery re-enabled it.
  input.value = 'Try again after recovery';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 20);
  assert.equal(sendButton.disabled, false, 'composer should be re-enabled after backend recovers');
});

// Regression: a mid-stream backend failure must error ONLY the in-flight reply,
// not every assistant message in the transcript. The earlier recovery code
// marked every non-terminal assistant message errored, which corrupted prior
// replies (especially history rows hydrated without a terminal status).
test('backend failure only errors the in-flight reply, never earlier transcript replies', async (t) => {
  const { window, shell, dispose } = await loadRendererApp({
    shell: {
      chat: {
        async startStream(payload, { state, emitChat }) {
          const sessionId = payload.sessionId || 'session-history';
          state.sessions = [{
            id: sessionId,
            title: 'History Session',
            conversation_mode: 'chat',
            preferred_model: 'gpt-test',
            reasoning_effort: 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          await emitChat({ type: 'started', sessionId, streamId: 'stream-history' });
          await emitChat({
            type: 'delta',
            sessionId,
            streamId: 'stream-history',
            content: 'Partial answer',
            aggregate: 'Partial answer',
          });
          // Intentionally never emit a terminal event.
          return { sessionId, streamId: 'stream-history' };
        },
      },
    },
  });
  t.after(async () => {
    await dispose();
  });

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = 'Latest question';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();

  await waitForUiState(window, () => {
    const controller = window.rendererMultiStreamController;
    return Boolean(controller && controller.getStreamingSessionIds().length);
  }, { timeoutMs: 1500, message: 'stream was never registered while sending' });

  const sessionId = shell.__state.sessions[0].id;
  const messages = window.__rendererState.messagesBySession.get(sessionId);

  // Prepend earlier transcript history ahead of the live turn: a completed reply
  // and a reply hydrated WITHOUT a terminal status (the case the old code
  // corrupted). The live in-flight reply stays at the tail.
  messages.unshift(
    { id: 'assistant-complete', role: 'assistant', content: 'first reply', status: 'complete' },
    { id: 'user-1', role: 'user', content: 'first question', status: 'complete' },
    { id: 'assistant-hydrated', role: 'assistant', content: 'second reply', status: '' },
    { id: 'user-2', role: 'user', content: 'second question', status: 'complete' },
  );
  window.__rendererState.messagesBySession.set(sessionId, messages);

  await shell.__emitBackendStatus({ phase: 'failed', detail: 'sidecar crashed', mode: 'managed-dev' });
  await waitForUi(window, 40);

  const finalMessages = window.__rendererState.messagesBySession.get(sessionId) || [];
  const byId = new Map(finalMessages.map((message) => [message.id, message]));
  const inflight = finalMessages[finalMessages.length - 1];

  assert.equal(String(inflight.status || '').toLowerCase(), 'error', 'in-flight reply is errored');
  assert.equal(byId.get('assistant-complete').status, 'complete', 'completed reply untouched');
  assert.equal(byId.get('assistant-hydrated').status, '', 'non-terminal historical reply untouched');
  assert.ok(!byId.get('assistant-hydrated').stream_error, 'historical reply not annotated with an error');
});

// The recovery hook must be a no-op when nothing is in flight, and must not
// fire for transient/usable phases (retrying/ready).
test('backend status recovery is idempotent and ignores usable/transient phases', async (t) => {
  const { window, shell, dispose } = await loadRendererApp();
  t.after(async () => {
    await dispose();
  });

  const controller = window.rendererMultiStreamController;
  const lifecycleStore = window.__rendererState.ui.chatSendLifecycleBySession;

  assert.equal(controller.isAnySendBusy(), false);
  assert.equal(lifecycleStore.size, 0);

  // No in-flight sends: failed/stopped should not throw and should leave
  // everything untouched.
  await shell.__emitBackendStatus({ phase: 'failed', detail: 'no streams active', mode: 'managed-dev' });
  await waitForUi(window, 20);
  assert.equal(controller.isAnySendBusy(), false);
  assert.equal(lifecycleStore.size, 0);

  // Transient/usable phases never clear in-flight state. Seed a streaming
  // lifecycle + stream, then emit retrying and ready, and confirm both are
  // preserved.
  lifecycleStore.set('session-keep', 'streaming');
  controller.registerStream('session-keep', 'stream-keep');

  await shell.__emitBackendStatus({ phase: 'retrying', detail: 'reconnecting', mode: 'managed-dev' });
  await waitForUi(window, 20);
  assert.equal(lifecycleStore.get('session-keep'), 'streaming');
  assert.equal(controller.isSessionStreaming('session-keep'), true);
});
