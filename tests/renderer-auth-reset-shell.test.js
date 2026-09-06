const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

test('renderer auth reset clears retained tool stream state', async (t) => {
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          const sessionId = 'session-reset-tools';
          state.sessions = [{
            id: sessionId,
            title: 'Tool Reset Session',
            conversation_mode: payload.conversationMode || 'chat',
            preferred_model: payload.preferredModel || 'gpt-test',
            reasoning_effort: payload.reasoningEffort || 'default',
            interactive_round_count: 0,
            interactive_sequence_state: 'idle',
            pending_question_batch: null,
            updated_at: new Date().toISOString(),
          }];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId: 'stream-reset-tools' };
        },
      },
    },
  });
  const rendererState = window.__rendererState;
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  assert.ok(rendererState);

  input.value = 'Run a tool';
  sendButton.click();
  await waitForUi(window, 20);

  await shell.__emitChat({
    type: 'tool_use',
    sessionId: 'session-reset-tools',
    streamId: 'stream-reset-tools',
    callId: 'call-reset',
    toolName: 'Read',
    summary: 'Read src/app.js',
    input: { file_path: 'src/app.js' },
    status: 'pending_approval',
  });
  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId: 'session-reset-tools',
    streamId: 'stream-reset-tools',
    callId: 'call-reset',
    toolName: 'Read',
    input: { file_path: 'src/app.js' },
  });
  await waitForUi(window, 20);

  assert.equal(rendererState.toolCallsByStream.size, 1);
  assert.equal(rendererState.pendingToolApprovals.size, 1);
  rendererState.queuedSendBySession.set('session-reset-tools', { prompt: 'stale queued prompt' });
  rendererState.ui.chatSendLifecycleBySession.set('session-reset-tools', 'failed');
  rendererState.ui.chatSendFailuresBySession.set('session-reset-tools', {
    sessionId: 'session-reset-tools',
    targetMessageId: 'user-reset',
  });
  rendererState.ui.composerV2 = {
    draftsBySession: new Map([['session-reset-tools', { prompt: 'V2 reset draft' }]]),
    lifecycleBySession: new Map([['session-reset-tools', 'failed']]),
  };

  await shell.__emitAuthState({ authenticated: false, user: null });
  await waitForUi(window, 40);

  assert.equal(rendererState.toolCallsByStream.size, 0);
  assert.equal(rendererState.pendingToolApprovals.size, 0);
  assert.equal(rendererState.queuedSendBySession.size, 0);
  assert.equal(rendererState.ui.chatSendLifecycleBySession.size, 0);
  assert.equal(rendererState.ui.chatSendFailuresBySession.size, 0);
  assert.equal(rendererState.ui.composerV2.draftsBySession.size, 0);
  assert.equal(rendererState.ui.composerV2.lifecycleBySession.size, 0);
});
