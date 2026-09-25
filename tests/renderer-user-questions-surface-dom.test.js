'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildManagedSidecarChatSendOptions } = require('../services/backend/electron-tool-bridge');
const askUser = require('../services/tools/builtin/ask-user-tool');
const { answerUserQuestions, hasPendingUserQuestions } = require('../services/backend/backend-chat-stream');

test('managed ask_user opens and answers its panel with distinct logical turn and stream IDs', async t => {
  const sessionId = 'session-question-runtime';
  const streamId = 'stream-question-runtime';
  const turnId = 'turn-question-runtime';
  const controller = new AbortController();
  const emitted = []; const deliveries = [];
  let shell;
  const service = {
    currentModel: 'replay-model', pendingUserQuestions: new Map(),
    emit(name, payload) {
      assert.equal(name, 'chat-stream');
      emitted.push(payload); deliveries.push(shell.__emitChat(payload));
    },
    toolExecutor: {
      executePreApproved({ callId, input }, context) {
        return askUser.execute(input, { ...context, callId });
      },
    },
  };
  const app = await loadRendererApp({ shell: { chat: {
    async startStream(_payload, { state }) {
      state.sessions = [{ id: sessionId, title: 'Questions', conversation_mode: 'chat',
        preferred_model: 'replay-model', updated_at: new Date().toISOString() }];
      state.messagesBySession.set(sessionId, []);
      return { sessionId, streamId, turnId };
    },
  } } });
  shell = app.shell;
  Object.assign(shell.chat, {
    async hasPendingUserQuestions(ref) { return hasPendingUserQuestions(service, ref); },
    async answerUserQuestions(ref, payload) { return answerUserQuestions(service, ref, payload); },
  });
  t.after(async () => { controller.abort(); await app.dispose(); });
  const { window } = app; const doc = window.document;
  const input = doc.getElementById('chatInput');
  input.value = 'Ask me a question';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);
  await shell.__emitChat({ type: 'started', sessionId, streamId, turnId });
  await shell.__emitChat({ type: 'tool_use', sessionId, streamId, turnId,
    callId: 'call-question', toolName: 'ask_user', status: 'running', input: {}, summary: 'Ask User' });
  const options = buildManagedSidecarChatSendOptions({ service, controller, streamId,
    resolvedSessionId: sessionId, turnEventCollector: { turnId }, runtime: { handleNotification() {} },
    toolContext: {}, normalizedPreferences: {}, timeoutMs: 1000 });
  const result = options.onElectronToolRequest({ tool_name: 'ask_user', tool_call_id: 'call-question',
    turn_id: 'forged-model-turn', arguments: { questions: [
      { id: 'choice', prompt: 'Which value?', options: ['One', 'Two'] },
    ] } });
  await Promise.all(deliveries);
  await waitForUi(window, 50);
  const panels = doc.querySelectorAll('#chatTimeline .user-questions-block');
  assert.equal(panels.length, 1, 'the live tool must show exactly one question panel');
  assert.equal(emitted[0].turnId, turnId, 'logical identity comes from the application collector');
  const panel = panels[0];
  const choice = panel.querySelector('[data-user-question-option][value="Two"]');
  choice.closest('label').click();
  assert.equal(choice.checked, true);
  panel.querySelector('.user-questions-submit-btn').click();
  await waitForUi(window, 30);
  assert.equal(service.pendingUserQuestions.size, 0);
  assert.match((await result).output, /A: Two/);
});
