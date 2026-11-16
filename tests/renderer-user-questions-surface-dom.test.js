'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { JSDOM } = require('jsdom');
const { renderUserQuestionsBlock } = require('../renderer/chat/renderer-user-questions-block');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
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

// Card behaviour through the real transcript bindings (jsdom, no renderer app).
function mountCard(t, { answerResult = true, questions } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="chatTimeline">${renderUserQuestionsBlock({
    toolCallId: 'call-1',
    questionRef: 'question-ref',
    questions: questions || [
      { id: 'single', prompt: 'Pick one', options: ['Alpha', 'Beta', 'Gamma'], multi_select: false, allow_other: true },
      { id: 'multi', prompt: 'Pick many', options: ['One', 'Two'], multi_select: true, allow_other: true },
      { id: 'free', prompt: 'Add notes', options: [], multi_select: false, allow_other: false },
    ],
  })}</div></body>`);
  const { window } = dom;
  const calls = { answer: [], decline: [] };
  window.jennyShell = { chat: {
    answerUserQuestions: async (...args) => { calls.answer.push(args); return answerResult; },
    declineUserQuestions: async (...args) => { calls.decline.push(args); return true; },
  } };
  const previous = { window: global.window, document: global.document };
  global.window = window;
  global.document = window.document;
  const bindings = createTranscriptEventBindings({
    chatTimeline: window.document.getElementById('chatTimeline'),
    state: { currentSessionId: 'session-1', messagesBySession: new Map() },
    appendClientLog() {},
    showComposerActionError() {},
    resolveToolCallId: () => '',
    toggleInteractiveRoundRecap() {},
    toggleThreadBranch() {},
    syncThinkingBlockNode() {},
    getSessionMessages: () => [],
    setSessionMessages() {},
  });
  bindings.bindTranscriptEvents((target, name, handler, options) => target.addEventListener(name, handler, options));
  t.after(() => {
    bindings.dispose();
    if (previous.window === undefined) delete global.window; else global.window = previous.window;
    if (previous.document === undefined) delete global.document; else global.document = previous.document;
    window.close();
  });
  const root = window.document.getElementById('chatTimeline');
  const keydown = (target, key, init = {}) => {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const type = (field, value) => {
    field.value = value;
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { window, root, calls, keydown, type, settle,
    submit: root.querySelector('.user-questions-submit-btn'),
    progress: root.querySelector('.user-questions-progress') };
}

test('Submit is disabled until a question is answered and the count follows the answers', (t) => {
  const { root, submit, progress, type } = mountCard(t);
  assert.equal(submit.disabled, true);
  assert.equal(progress.textContent, '0 of 3 answered');
  root.querySelector('[data-user-question-option][value="Beta"]').click();
  assert.equal(submit.disabled, false);
  assert.equal(progress.textContent, '1 of 3 answered');
  const free = root.querySelector('[data-user-question-free-text]');
  type(free, 'some notes');
  assert.equal(progress.textContent, '2 of 3 answered');
  type(free, '   ');
  assert.equal(progress.textContent, '1 of 3 answered', 'whitespace is not an answer');
  const multi = root.querySelector('[data-user-question-option][value="One"]');
  multi.click();
  assert.equal(progress.textContent, '2 of 3 answered');
  multi.click();
  assert.equal(progress.textContent, '1 of 3 answered');
  type(free, '');
  root.querySelector('[data-user-question-option][value="Beta"]').click();
  assert.equal(submit.disabled, false, 'a re-clicked radio stays picked');
});

test('clearing the only answer disables Submit again', (t) => {
  const { root, submit, progress, type } = mountCard(t);
  const free = root.querySelector('[data-user-question-free-text]');
  type(free, 'notes');
  assert.equal(submit.disabled, false);
  type(free, '');
  assert.equal(submit.disabled, true);
  assert.equal(progress.textContent, '0 of 3 answered');
});

test('Enter on the focused Skip button declines instead of submitting', async (t) => {
  const { root, calls, keydown, settle } = mountCard(t);
  root.querySelector('[data-user-question-option][value="Alpha"]').click();
  const skip = root.querySelector('.user-questions-decline-btn');
  const event = keydown(skip, 'Enter');
  assert.equal(calls.answer.length, 0, 'Enter on a button must not submit the form');
  if (!event.defaultPrevented) skip.click(); // the browser's own activation of a focused button
  await settle();
  assert.deepEqual(calls.decline, [['question-ref']]);
  assert.equal(calls.answer.length, 0);
});

test('typing in Other selects it, clears a picked option and ships the text', async (t) => {
  const { root, calls, type, settle, submit } = mountCard(t);
  const alpha = root.querySelector('[data-user-question-option][value="Alpha"]');
  const toggle = root.querySelector('[data-user-question-other-toggle]');
  const field = root.querySelector('[data-user-question-other-input]');
  alpha.click();
  assert.equal(field.disabled, false, 'the Other field is never disabled');
  type(field, 'Delta');
  assert.equal(toggle.checked, true);
  assert.equal(alpha.checked, false, 'a single-select radio group clears the old pick');
  type(field, '');
  assert.equal(toggle.checked, true, 'clearing the text leaves Other ticked');
  assert.equal(root.querySelector('.user-questions-progress').textContent, '0 of 3 answered');
  type(field, 'Delta');
  submit.click();
  await settle();
  assert.deepEqual(calls.answer[0][1].answers[0], { id: 'single', value: '', other: 'Delta' });
});

test('a pointer click on the Other row lands in its text field; arrow-key selection keeps focus on the radio', async (t) => {
  const { root, window, settle } = mountCard(t);
  const toggle = root.querySelector('[data-user-question-other-toggle]');
  const field = root.querySelector('[data-user-question-other-input]');
  // Arrow keys select a radio with a detail-0 click: focus must stay on it.
  toggle.focus();
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  await settle();
  assert.equal(toggle.checked, true);
  assert.equal(window.document.activeElement, toggle, 'keyboard selection keeps arrowing possible');
  // A pointer click on the row's glyph ticks Other through the label and moves into the field.
  toggle.checked = false;
  root.querySelector('.user-questions-other-option .user-questions-glyph')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(toggle.checked, true);
  assert.equal(window.document.activeElement, field);
});

test('digit keys pick a row of the focused question and toggle multi-select rows', (t) => {
  const { root, keydown, window } = mountCard(t);
  const alpha = root.querySelector('[data-user-question-option][value="Alpha"]');
  const beta = root.querySelector('[data-user-question-option][value="Beta"]');
  alpha.focus();
  const event = keydown(alpha, '2');
  assert.equal(event.defaultPrevented, true);
  assert.equal(beta.checked, true);
  assert.equal(window.document.activeElement, beta);
  assert.equal(root.querySelector('.user-questions-progress').textContent, '1 of 3 answered');

  const one = root.querySelector('[data-user-question-option][value="One"]');
  keydown(one, '1');
  assert.equal(one.checked, true);
  keydown(one, '1');
  assert.equal(one.checked, false, 'a multi-select digit toggles');

  // A digit unticks a multi-select Other as well as ticking it.
  const multiOther = root.querySelector('[data-user-question-id="multi"] [data-user-question-other-toggle]');
  keydown(one, '3');
  assert.equal(multiOther.checked, true);
  one.focus();
  keydown(one, '3');
  assert.equal(multiOther.checked, false);

  // Row 4 of the single-select question is Other: pick it and land in its field.
  keydown(beta, '4');
  assert.equal(root.querySelector('[data-user-question-other-toggle]').checked, true);
  assert.equal(window.document.activeElement, root.querySelector('[data-user-question-other-input]'));
  assert.equal(beta.checked, false);

  const field = root.querySelector('[data-user-question-other-input]');
  assert.equal(keydown(field, '1').defaultPrevented, false, 'a digit typed into a text field is left alone');
  assert.equal(keydown(beta, '1', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(keydown(beta, '9').defaultPrevented, false, 'no such row');
});

test('Shift+Enter in the free-text field adds a line; Enter submits once an answer exists', async (t) => {
  const { root, calls, keydown, type, settle } = mountCard(t);
  const free = root.querySelector('[data-user-question-free-text]');
  assert.equal(free.tagName, 'TEXTAREA');
  type(free, 'first line');
  const shifted = keydown(free, 'Enter', { shiftKey: true });
  assert.equal(shifted.defaultPrevented, false);
  await settle();
  assert.equal(calls.answer.length, 0);
  const plain = keydown(free, 'Enter');
  assert.equal(plain.defaultPrevented, true);
  await settle();
  assert.equal(calls.answer.length, 1);
});

test('Enter does nothing while no question is answered', async (t) => {
  const { root, calls, keydown, settle } = mountCard(t);
  keydown(root.querySelector('[data-user-question-free-text]'), 'Enter');
  await settle();
  assert.equal(calls.answer.length, 0);
});

test('a failed send restores the card and keeps Submit enabled for the surviving answer', async (t) => {
  const { root, window, submit, settle } = mountCard(t);
  window.jennyShell.chat.answerUserQuestions = async () => { throw new Error('offline'); };
  root.querySelector('[data-user-question-option][value="Alpha"]').click();
  submit.click();
  assert.equal(submit.disabled, true);
  await settle();
  assert.equal(root.querySelector('.user-questions-block').getAttribute('aria-busy'), 'false');
  assert.equal(submit.disabled, false);
  assert.equal(root.querySelector('[data-user-question-other-input]').disabled, false);
});

test('a demoted card keeps the prompts it asked in its stale receipt', async (t) => {
  const { root, settle } = mountCard(t, { answerResult: false });
  root.querySelector('[data-user-question-option][value="Alpha"]').click();
  root.querySelector('.user-questions-submit-btn').click();
  await settle();
  const receipt = root.querySelector('.user-questions-receipt');
  assert.ok(receipt);
  assert.match(receipt.querySelector('.user-questions-receipt-status').textContent, /These questions are no longer active/);
  assert.deepEqual(
    Array.from(receipt.querySelectorAll('.user-questions-receipt-prompt')).map((node) => node.textContent),
    ['Pick one', 'Pick many', 'Add notes']
  );
  assert.equal(root.querySelector('.user-questions-block').getAttribute('aria-label'), 'These questions are no longer active');
});
