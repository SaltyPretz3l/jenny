const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const {
  renderUserQuestionsBlock,
  renderUserQuestionsReceipt,
} = require('../renderer/chat/renderer-user-questions-block');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

function renderCard(overrides = {}) {
  return renderUserQuestionsBlock({
    toolCallId: 'call-1',
    questionRef: 'question-ref',
    questions: [
      { id: 'single', prompt: 'Pick one', options: ['Alpha', 'Beta'], multi_select: false, allow_other: true },
      { id: 'multi', prompt: 'Pick many', options: ['One', 'Two'], multi_select: true, allow_other: false },
      { id: 'free', prompt: 'Add notes', options: [], multi_select: false, allow_other: false },
    ],
    ...overrides,
  });
}

function bindCard(dom, calls, options = {}) {
  const { window } = dom;
  const chatTimeline = window.document.getElementById('chatTimeline');
  const state = options.state || {
    currentSessionId: 'session-1',
    messagesBySession: new Map([['session-1', [{
      id: 'tool_use_call-1', kind: 'tool_use', status: 'complete',
      tool_call: {
        call_id: 'call-1', tool_name: 'ask_user', status: 'pending_user_input',
        question_ref: 'question-ref', user_questions: [],
      },
    }]]]),
  };
  window.jennyShell = {
    chat: {
      answerUserQuestions: async (...args) => { calls.answer.push(args); return options.answerResult ?? true; },
      declineUserQuestions: async (...args) => { calls.decline.push(args); return options.declineResult ?? true; },
      getActiveTurnState: async () => null,
    },
  };
  if (typeof options.hasPendingUserQuestions === 'function') {
    window.jennyShell.chat.hasPendingUserQuestions = options.hasPendingUserQuestions;
  }
  const previousWindow = global.window;
  const previousDocument = global.document;
  const resolveSessionId = (sessionId) => {
    const normalizedSessionId = String(sessionId || '').trim();
    return options.resolvedSessionIds?.get(normalizedSessionId) || normalizedSessionId;
  };
  const getSessionMessages = (sessionId) => {
    const resolvedSessionId = resolveSessionId(sessionId);
    if (!resolvedSessionId) return [];
    if (!(state.sessionMessageAccessOrder instanceof Map)) {
      state.sessionMessageAccessOrder = new Map();
    }
    state.sessionMessageAccessOrder.delete(resolvedSessionId);
    state.sessionMessageAccessOrder.set(resolvedSessionId, Date.now());
    return state.messagesBySession.get(resolvedSessionId) || [];
  };
  const setSessionMessages = (sessionId, messages) => {
    const resolvedSessionId = resolveSessionId(sessionId);
    if (!resolvedSessionId) return;
    const normalizedMessages = Array.isArray(messages) ? messages : [];
    state.messagesBySession.set(resolvedSessionId, normalizedMessages);
    getSessionMessages(resolvedSessionId);
    options.onSessionMessagesReplaced?.(resolvedSessionId, normalizedMessages);
  };
  global.window = window;
  global.document = window.document;
  const bindings = createTranscriptEventBindings({
    chatTimeline,
    state,
    appendClientLog() {},
    showComposerActionError: options.showComposerActionError || ((error) => { throw error; }),
    resolveToolCallId: () => '',
    toggleInteractiveRoundRecap() {},
    toggleThreadBranch() {},
    syncThinkingBlockNode() {},
    getSessionMessages,
    setSessionMessages,
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => {
    target.addEventListener(eventName, handler, options);
  });
  return {
    chatTimeline,
    state,
    cleanup() {
      bindings.dispose();
      if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
      if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
      window.close();
    },
  };
}

function installFakeWindowTimers(window) {
  const timers = new Map();
  let nextId = 1;
  window.setTimeout = (callback, delay) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { callback, delay });
    return id;
  };
  window.clearTimeout = (id) => {
    timers.delete(id);
  };
  return {
    pendingCount: () => timers.size,
    runNext() {
      const entry = timers.entries().next().value;
      if (!entry) return false;
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
      return true;
    },
  };
}

test('renders escaped bounded editorial questions with native controls and functional hooks', () => {
  const hostilePrompt = '<script>alert("x")</script>' + 'x'.repeat(1000);
  const html = renderCard({
    questions: [
      { id: 'single', prompt: hostilePrompt, options: ['<b>Alpha</b>', ...Array.from({ length: 10 }, (_, i) => `Choice ${i}`)], multi_select: false, allow_other: true },
      { id: 'multi', prompt: 'Pick many', options: ['One'], multi_select: true, allow_other: false },
      { id: 'free', prompt: 'Notes', options: [], multi_select: false, allow_other: false },
      { id: 'four', prompt: 'Fourth', options: [], multi_select: false, allow_other: false },
      { id: 'clamped', prompt: 'Fifth', options: [], multi_select: false, allow_other: false },
    ],
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const doc = dom.window.document;

  assert.equal(doc.querySelectorAll('script').length, 0);
  assert.match(doc.querySelector('.user-questions-prompt').textContent, /^<script>alert\("x"\)<\/script>/);
  assert.ok(doc.querySelector('.user-questions-prompt').textContent.length < hostilePrompt.length);
  assert.equal(doc.querySelectorAll('.user-questions-question').length, 4);
  assert.equal(doc.querySelectorAll('[data-user-question-id="single"] [data-user-question-option]').length, 8);
  assert.equal(doc.querySelector('[data-user-question-id="single"] [data-user-question-option]').type, 'radio');
  assert.equal(doc.querySelector('[data-user-question-id="multi"] [data-user-question-option]').type, 'checkbox');
  assert.equal(doc.querySelector('[data-user-question-id="single"] [data-user-question-other-input]').disabled, true);
  assert.ok(doc.querySelector('[data-user-question-id="free"] [data-user-question-free-text]'));
  assert.equal(doc.querySelector('[data-user-question-id="single"] [data-user-question-option]').value, '<b>Alpha</b>');
  assert.equal(doc.querySelector('.user-questions-eyebrow').textContent, 'Questions');
  assert.equal(doc.querySelector('.user-questions-choose-any').textContent, ' — choose any');
  assert.equal(doc.querySelector('.user-questions-submit-btn').getAttribute('aria-label'), 'Submit your answers');
  assert.equal(doc.querySelector('.user-questions-submit-btn').title, 'Submit your answers');
  assert.equal(doc.querySelector('.user-questions-decline-btn').textContent, 'Skip');
  assert.equal(doc.querySelector('.user-questions-decline-btn').getAttribute('aria-label'), 'Skip these questions');
  assert.equal(doc.querySelector('.user-questions-decline-btn').title, 'Skip these questions');
  assert.equal(doc.querySelector('.user-questions-enter-hint').textContent, 'Enter ↵');
  assert.doesNotMatch(html, /ask-card|interactive-option-button|interactive-question-prompt|interactive-card-actions/);
  dom.window.close();
});

test('Other selection gates its text input and Submit assembles normalized answer shapes', async (t) => {
  const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const calls = { answer: [], decline: [] };
  const harness = bindCard(dom, calls);
  t.after(harness.cleanup);
  const { window } = dom;
  const root = harness.chatTimeline;

  const singleOther = root.querySelector('[data-user-question-id="single"] [data-user-question-other-toggle]');
  const singleOtherInput = root.querySelector('[data-user-question-id="single"] [data-user-question-other-input]');
  singleOther.click();
  assert.equal(singleOtherInput.disabled, false);
  singleOtherInput.value = 'Custom editor';
  root.querySelector('[data-user-question-id="multi"] [data-user-question-option][value="One"]').click();
  root.querySelector('[data-user-question-id="multi"] [data-user-question-option][value="Two"]').click();
  root.querySelector('[data-user-question-id="free"] [data-user-question-free-text]').value = 'Free form';

  const submit = root.querySelector('.user-questions-submit-btn');
  submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(root.querySelectorAll('.user-questions-block input:disabled').length, root.querySelectorAll('.user-questions-block input').length);
  assert.equal(root.querySelector('.user-questions-decline-btn').disabled, true);
  await Promise.resolve();

  assert.deepEqual(calls.answer, [[
    'question-ref',
    { answers: [
      { id: 'single', value: '', other: 'Custom editor' },
      { id: 'multi', value: ['One', 'Two'] },
      { id: 'free', value: 'Free form' },
    ] },
  ]]);
  assert.deepEqual(calls.decline, []);
});

test('Submit uses the selected option value and Skip calls the decline bridge once', async (t) => {
  const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const calls = { answer: [], decline: [] };
  const harness = bindCard(dom, calls);
  t.after(harness.cleanup);
  const { window } = dom;
  const root = harness.chatTimeline;

  root.querySelector('[data-user-question-id="single"] [data-user-question-option][value="Beta"]').click();
  root.querySelector('.user-questions-submit-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await Promise.resolve();
  assert.equal(calls.answer[0][1].answers[0].value, 'Beta');

  const secondDom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const secondCalls = { answer: [], decline: [] };
  const secondHarness = bindCard(secondDom, secondCalls);
  t.after(secondHarness.cleanup);
  const decline = secondHarness.chatTimeline.querySelector('.user-questions-decline-btn');
  assert.equal(decline.textContent, 'Skip');
  decline.dispatchEvent(new secondDom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(decline.disabled, true);
  assert.equal(secondHarness.chatTimeline.querySelector('.user-questions-submit-btn').disabled, true);
  await Promise.resolve();
  assert.deepEqual(secondCalls.decline, [['question-ref']]);
});

test('plain Enter submits once from question inputs and prevents the key event', async (t) => {
  const targets = [
    '[data-user-question-id="single"] [data-user-question-option]',
    '[data-user-question-id="single"] [data-user-question-other-input]',
    '[data-user-question-id="free"] [data-user-question-free-text]',
  ];
  for (const selector of targets) {
    const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
    const calls = { answer: [], decline: [] };
    const harness = bindCard(dom, calls);
    t.after(harness.cleanup);
    if (selector.includes('other-input')) {
      harness.chatTimeline.querySelector('[data-user-question-other-toggle]').click();
    }
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    harness.chatTimeline.querySelector(selector).dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.answer.length, 1);
  }
});

test('Enter submit ignores modifiers, composition, and busy question blocks', async (t) => {
  const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const calls = { answer: [], decline: [] };
  const harness = bindCard(dom, calls);
  t.after(harness.cleanup);
  const target = harness.chatTimeline.querySelector('[data-user-question-free-text]');
  for (const init of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
  }
  harness.chatTimeline.querySelector('.user-questions-block').setAttribute('aria-busy', 'true');
  const busyEvent = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  target.dispatchEvent(busyEvent);
  await Promise.resolve();
  assert.equal(busyEvent.defaultPrevented, false);
  assert.equal(calls.answer.length, 0);
});

test('plain Enter outside a question block neither throws nor submits', async (t) => {
  const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline"><button id="plainBtn" type="button">x</button>${renderCard()}</div></body>`);
  const calls = { answer: [], decline: [] };
  const harness = bindCard(dom, calls);
  t.after(harness.cleanup);
  const errors = [];
  dom.window.addEventListener('error', (event) => { errors.push(event); event.preventDefault(); });
  const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  dom.window.document.getElementById('plainBtn').dispatchEvent(event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 0);
  assert.equal(calls.answer.length, 0);
});

test('answer and Skip false outcomes become persistent stale receipts and surface a failure error', async (t) => {
  for (const decline of [false, true]) {
    const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
    const calls = { answer: [], decline: [] };
    const surfacedErrors = [];
    const harness = bindCard(dom, calls, {
      ...(decline ? { declineResult: false } : { answerResult: false }),
      showComposerActionError(error, title) { surfacedErrors.push([error, title]); },
    });
    t.after(harness.cleanup);
    const selector = decline ? '.user-questions-decline-btn' : '.user-questions-submit-btn';
    harness.chatTimeline.querySelector(selector).click();
    await new Promise((resolve) => setImmediate(resolve));

    const block = harness.chatTimeline.querySelector('.user-questions-block');
    assert.equal(block.dataset.userQuestionsStale, 'true');
    assert.match(block.querySelector('.user-questions-receipt').textContent, /Questions no longer active/);
    assert.equal(block.querySelector('button, input'), null);
    const message = harness.state.messagesBySession.get('session-1')[0];
    assert.equal(message.tool_call.status, 'completed');
    assert.equal(message.tool_call.user_questions_result_kind, 'user_questions_stale');
    assert.equal(message.tool_call.user_questions_stale, true);
    // The stale receipt is passive — the user must also be told the
    // submission itself did not take effect.
    assert.equal(surfacedErrors.length, 1);
    assert.match(surfacedErrors[0][0].message, /already resolved or are no longer active/);
    assert.equal(surfacedErrors[0][1], decline ? 'Decline Failed' : 'Submit Failed');
  }
});

test('a resolution-requiring current session id stamps stale through session-message accessors', async (t) => {
  const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const calls = { answer: [], decline: [] };
  const notifications = [];
  const state = {
    currentSessionId: 'temporary-session',
    messagesBySession: new Map([['session-1', [{
      id: 'tool_use_call-1',
      kind: 'tool_use',
      status: 'complete',
      tool_call: {
        call_id: 'call-1',
        tool_name: 'ask_user',
        status: 'pending_user_input',
        question_ref: 'question-ref',
        user_questions: [],
      },
    }]]]),
  };
  const harness = bindCard(dom, calls, {
    state,
    answerResult: false,
    showComposerActionError() {},
    resolvedSessionIds: new Map([['temporary-session', 'session-1']]),
    onSessionMessagesReplaced(sessionId, messages) {
      notifications.push([sessionId, messages]);
    },
  });
  t.after(harness.cleanup);

  harness.chatTimeline.querySelector('.user-questions-submit-btn').click();
  await new Promise((resolve) => setImmediate(resolve));

  const message = state.messagesBySession.get('session-1')[0];
  assert.equal(message.tool_call.status, 'completed');
  assert.equal(message.tool_call.user_questions_result_kind, 'user_questions_stale');
  assert.equal(state.messagesBySession.has('temporary-session'), false);
  assert.deepEqual([...state.sessionMessageAccessOrder.keys()], ['session-1']);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0][0], 'session-1');
});

test('pending question blocks become stalled after one timer', (t) => {
  const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const fakeTimers = installFakeWindowTimers(dom.window);
  const harness = bindCard(dom, { answer: [], decline: [] });
  t.after(harness.cleanup);
  const block = harness.chatTimeline.querySelector('.user-questions-block');

  assert.equal(fakeTimers.pendingCount(), 1);
  block.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  block.dispatchEvent(new dom.window.Event('focusin', { bubbles: true }));
  assert.equal(fakeTimers.pendingCount(), 1);
  assert.equal(fakeTimers.runNext(), true);
  assert.equal(fakeTimers.pendingCount(), 0);
  assert.equal(block.dataset.stalled, 'true');
});

test('submit dispatch and binding disposal cancel pending stalled timers', () => {
  const submitDom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const submitTimers = installFakeWindowTimers(submitDom.window);
  const submitHarness = bindCard(submitDom, { answer: [], decline: [] }, {
    answerResult: new Promise(() => {}),
  });
  assert.equal(submitTimers.pendingCount(), 1);
  submitHarness.chatTimeline.querySelector('.user-questions-submit-btn').click();
  assert.equal(submitTimers.pendingCount(), 0);
  submitHarness.cleanup();

  const disposeDom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const disposeTimers = installFakeWindowTimers(disposeDom.window);
  const disposeHarness = bindCard(disposeDom, { answer: [], decline: [] });
  assert.equal(disposeTimers.pendingCount(), 1);
  disposeHarness.cleanup();
  assert.equal(disposeTimers.pendingCount(), 0);
});

test('lazy and initial liveness checks stale dead cards while an absent IPC is a no-op', async (t) => {
  const pointerDom = new JSDOM('<!doctype html><body><input id="chatInput"><div id="chatTimeline"></div></body>');
  const pointerCalls = { answer: [], decline: [], liveness: 0 };
  const pointerHarness = bindCard(pointerDom, pointerCalls, {
    hasPendingUserQuestions: async () => { pointerCalls.liveness += 1; return false; },
  });
  t.after(pointerHarness.cleanup);
  pointerHarness.chatTimeline.innerHTML = renderCard();
  pointerHarness.chatTimeline.querySelector('[data-user-question-free-text]')
    .dispatchEvent(new pointerDom.window.Event('pointerover', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pointerCalls.liveness, 1);
  assert.match(pointerHarness.chatTimeline.querySelector('.user-questions-receipt').textContent, /Questions no longer active/);

  const sweepDom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const sweepCalls = { answer: [], decline: [], liveness: 0 };
  const sweepHarness = bindCard(sweepDom, sweepCalls, {
    hasPendingUserQuestions: async () => { sweepCalls.liveness += 1; return false; },
  });
  t.after(sweepHarness.cleanup);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sweepCalls.liveness, 1);
  assert.ok(sweepHarness.chatTimeline.querySelector('.user-questions-receipt'));

  const absentDom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const absentHarness = bindCard(absentDom, { answer: [], decline: [] });
  t.after(absentHarness.cleanup);
  absentHarness.chatTimeline.querySelector('[data-user-question-free-text]')
    .dispatchEvent(new absentDom.window.Event('focusin', { bubbles: true }));
  await Promise.resolve();
  assert.ok(absentHarness.chatTimeline.querySelector('.user-questions-submit-btn'));
  assert.equal(absentHarness.chatTimeline.querySelector('.user-questions-receipt'), null);
});

test('a rejected liveness probe re-arms so the next hover retries instead of burning the one-shot flag', async (t) => {
  const dom = new JSDOM('<!doctype html><body><input id="chatInput"><div id="chatTimeline"></div></body>');
  const calls = { answer: [], decline: [], liveness: 0 };
  let failProbe = true;
  const harness = bindCard(dom, calls, {
    hasPendingUserQuestions: async () => {
      calls.liveness += 1;
      if (failProbe) throw new Error('transient IPC failure');
      return false;
    },
  });
  t.after(harness.cleanup);
  harness.chatTimeline.innerHTML = renderCard();
  const target = harness.chatTimeline.querySelector('[data-user-question-free-text]');

  target.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.liveness, 1);
  // The failed probe must not stale the card or leave the one-shot flag set.
  assert.equal(harness.chatTimeline.querySelector('.user-questions-receipt'), null);
  const block = harness.chatTimeline.querySelector('.user-questions-block');
  assert.equal(block.dataset.userQuestionsLivenessChecked, undefined);

  failProbe = false;
  target.dispatchEvent(new dom.window.Event('pointerover', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.liveness, 2);
  assert.match(harness.chatTimeline.querySelector('.user-questions-receipt').textContent, /Questions no longer active/);
});

test('answered receipts render single, multi, Other, missing, and escaped content', () => {
  const html = renderUserQuestionsReceipt({
    toolCallId: 'call-<receipt>',
    resultKind: 'user_questions_answered',
    questions: [
      { id: 'single', prompt: '<script>Pick one</script>', options: ['Alpha'], multi_select: false, allow_other: false },
      { id: 'multi', prompt: 'Pick many', options: ['One', 'Two'], multi_select: true, allow_other: false },
      { id: 'other', prompt: 'Other choice', options: ['Known'], multi_select: false, allow_other: true },
      { id: 'missing', prompt: 'Optional note', options: [], multi_select: false, allow_other: false },
    ],
    answers: [
      { id: 'single', value: 'Alpha' },
      { id: 'multi', value: ['One', 'Two'] },
      { id: 'other', value: 'Known', other: '<img src=x onerror=alert(1)>' },
    ],
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const receipt = dom.window.document.querySelector('.user-questions-receipt');
  const lines = Array.from(receipt.querySelectorAll('.user-questions-receipt-line')).map((line) => line.textContent);

  assert.equal(receipt.dataset.toolCallId, 'call-<receipt>');
  assert.equal(receipt.querySelector('.user-questions-receipt-status').textContent, 'Answered 4 questions');
  assert.deepEqual(lines, [
    '<script>Pick one</script> — Alpha',
    'Pick many — One, Two',
    'Other choice — Known, Other: <img src=x onerror=alert(1)>',
    'Optional note — (no answer)',
  ]);
  assert.equal(receipt.querySelectorAll('script, img').length, 0);
  dom.window.close();
});

test('receipt renders skipped and stale states and rejects unknown result kinds', () => {
  const skipped = renderUserQuestionsReceipt({ toolCallId: 'call-1', resultKind: 'user_questions_declined' });
  const stale = renderUserQuestionsReceipt({ toolCallId: 'call-1', resultKind: 'unknown', stale: true });
  assert.match(skipped, /Questions skipped/);
  assert.match(stale, /Questions no longer active/);
  assert.equal(renderUserQuestionsReceipt({ toolCallId: 'call-1', resultKind: 'unknown' }), '');
});

test('settled ask_user rows with stamped results render receipts, never pending or generic tool markup', () => {
  const renderUtils = createTurnRowRenderUtils({
    renderToolCallBlock() { return '<div class="settled-tool-row"></div>'; },
    renderMarkdown(value) { return String(value || ''); },
    getFeatureFlags() { return {}; },
    MESSAGE_STATUS: { STREAMING: 'streaming' },
  });
  const message = {
    id: 'tool_use_call-1', role: 'assistant', kind: 'tool_use', status: 'complete',
    tool_call: { call_id: 'call-1', tool_name: 'ask_user', status: 'completed' },
  };
  const row = {
    row_id: 'row-1', turn_id: 'turn-1', kind: 'tool_call', primary_message_id: message.id,
    tool_call_id: 'call-1',
    payload: {
      tool_call_id: 'call-1', tool_name: 'ask_user', state: 'completed',
      user_questions: [{ id: 'single', prompt: 'Pick one', options: ['Alpha'], multi_select: false, allow_other: false }],
      user_questions_result_kind: 'user_questions_answered',
      user_questions_answers: [{ id: 'single', value: 'Alpha' }],
    },
  };

  const html = renderUtils.buildToolCallRowMarkup(row, [message], { messageById: new Map([[message.id, message]]) });
  assert.match(html, /user-questions-receipt/);
  assert.doesNotMatch(html, /user-questions-block/);
  assert.doesNotMatch(html, /tool-call-row/);

  const skippedHtml = renderUtils.buildToolCallRowMarkup({
    ...row,
    payload: { ...row.payload, user_questions_result_kind: 'user_questions_declined' },
  }, [message], { messageById: new Map([[message.id, message]]) });
  assert.match(skippedHtml, /Questions skipped/);
  assert.doesNotMatch(skippedHtml, /tool-call-row/);
});

test('stale-marked ask_user rows render the stale receipt from tool_call state alone', () => {
  const renderUtils = createTurnRowRenderUtils({
    renderToolCallBlock() { return '<div class="settled-tool-row"></div>'; },
    renderMarkdown(value) { return String(value || ''); },
    getFeatureFlags() { return {}; },
    MESSAGE_STATUS: { STREAMING: 'streaming' },
  });
  const message = {
    id: 'tool_use_call-1', role: 'assistant', kind: 'tool_use', status: 'complete',
    tool_call: {
      call_id: 'call-1', tool_name: 'ask_user', status: 'completed',
      user_questions: [{ id: 'single', prompt: 'Pick one', options: ['Alpha'], multi_select: false, allow_other: false }],
      user_questions_result_kind: 'user_questions_stale', user_questions_stale: true,
    },
  };
  const row = {
    row_id: 'row-1', turn_id: 'turn-1', kind: 'tool_call', primary_message_id: message.id,
    tool_call_id: 'call-1',
    payload: { tool_call_id: 'call-1', tool_name: 'ask_user', state: 'completed' },
  };

  const html = renderUtils.buildToolCallRowMarkup(row, [message], { messageById: new Map([[message.id, message]]) });
  assert.match(html, /user-questions-receipt/);
  assert.match(html, /Questions no longer active/);
  assert.doesNotMatch(html, /user-questions-block|tool-call-row/);
});

test('settled ask_user rows without stamped result metadata retain generic tool markup', () => {
  const renderUtils = createTurnRowRenderUtils({
    renderToolCallBlock() { return '<div class="settled-tool-row"></div>'; },
    renderMarkdown(value) { return String(value || ''); },
    getFeatureFlags() { return {}; },
    MESSAGE_STATUS: { STREAMING: 'streaming' },
  });
  const message = {
    id: 'tool_use_call-1', role: 'assistant', kind: 'tool_use', status: 'complete',
    tool_call: { call_id: 'call-1', tool_name: 'ask_user', status: 'completed' },
  };
  const row = {
    row_id: 'row-1', turn_id: 'turn-1', kind: 'tool_call', primary_message_id: message.id,
    tool_call_id: 'call-1',
    payload: {
      tool_call_id: 'call-1', tool_name: 'ask_user', state: 'completed',
      user_questions: [{ id: 'single', prompt: 'Pick one', options: ['Alpha'], multi_select: false, allow_other: false }],
    },
  };

  const html = renderUtils.buildToolCallRowMarkup(row, [message], { messageById: new Map([[message.id, message]]) });
  assert.match(html, /tool-call-row/);
  assert.doesNotMatch(html, /user-questions-receipt|user-questions-block/);
});
