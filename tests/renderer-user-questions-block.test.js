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
  assert.equal(doc.querySelector('[data-user-question-id="single"] [data-user-question-other-input]').disabled, false);
  assert.equal(doc.querySelector('[data-user-question-other-input]').getAttribute('placeholder'), 'Something else…');
  assert.equal(doc.querySelector('.user-questions-other-option').tagName, 'LABEL');
  assert.equal(doc.querySelector('.user-questions-other-option [data-user-question-other-toggle]').type, 'radio');
  const freeText = doc.querySelector('[data-user-question-id="free"] [data-user-question-free-text]');
  assert.equal(freeText.tagName, 'TEXTAREA');
  assert.equal(freeText.getAttribute('placeholder'), 'Type your answer');
  assert.equal(freeText.getAttribute('rows'), '1');
  const keys = Array.from(doc.querySelectorAll('[data-user-question-id="single"] .user-questions-key')).map((key) => key.textContent);
  assert.deepEqual(keys, ['1', '2', '3', '4', '5', '6', '7', '8', '9'], 'eight options plus Other are numbered 1 to 9');
  assert.equal(doc.querySelector('[data-user-question-id="single"] [data-user-question-option]').value, '<b>Alpha</b>');
  assert.equal(doc.querySelector('.user-questions-kicker').textContent, 'Jenny is asking0 of 4 answered');
  assert.ok(doc.querySelector('.user-questions-kicker .user-questions-dot[aria-hidden="true"]'));
  assert.equal(doc.querySelector('.user-questions-progress').getAttribute('aria-live'), 'polite');
  assert.equal(doc.querySelector('.user-questions-choose-any').textContent, ' · choose any');
  assert.equal(doc.querySelector('[data-user-question-id="multi"] .user-questions-prompt-text').textContent, 'Pick many');
  assert.equal(doc.querySelector('.user-questions-submit-btn').disabled, true, 'nothing is answered yet');
  assert.equal(doc.querySelector('.user-questions-decline-btn').disabled, false);
  assert.equal(doc.querySelector('.user-questions-submit-btn').getAttribute('aria-label'), 'Submit your answers');
  assert.equal(doc.querySelector('.user-questions-submit-btn').title, 'Submit your answers');
  assert.equal(doc.querySelector('.user-questions-decline-btn').textContent, 'Skip');
  assert.equal(doc.querySelector('.user-questions-decline-btn').getAttribute('aria-label'), 'Skip these questions');
  assert.equal(doc.querySelector('.user-questions-decline-btn').title, 'Skip these questions');
  assert.equal(doc.querySelector('.user-questions-enter-hint').textContent, 'Enter to submit · Shift+Enter for a new line');
  assert.doesNotMatch(html, />Questions<|Other:|Enter ↵|user-questions-header|user-questions-eyebrow|user-questions-rule/);
  assert.doesNotMatch(html, /ask-card|interactive-option-button|interactive-question-prompt|interactive-card-actions/);
  dom.window.close();
});

test('Submit assembles normalized answer shapes from an always-enabled Other field', async (t) => {
  const dom = new JSDOM(`<!doctype html><body><input id="chatInput"><div id="chatTimeline">${renderCard()}</div></body>`);
  const calls = { answer: [], decline: [] };
  const harness = bindCard(dom, calls);
  t.after(harness.cleanup);
  const { window } = dom;
  const root = harness.chatTimeline;

  const singleOtherInput = root.querySelector('[data-user-question-id="single"] [data-user-question-other-input]');
  assert.equal(singleOtherInput.disabled, false);
  singleOtherInput.value = 'Custom editor';
  singleOtherInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  root.querySelector('[data-user-question-id="multi"] [data-user-question-option][value="One"]').click();
  root.querySelector('[data-user-question-id="multi"] [data-user-question-option][value="Two"]').click();
  const free = root.querySelector('[data-user-question-id="free"] [data-user-question-free-text]');
  free.value = 'Free form';
  free.dispatchEvent(new window.Event('input', { bubbles: true }));

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
    harness.chatTimeline.querySelector('[data-user-question-id="multi"] [data-user-question-option]').click();
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
    harness.chatTimeline.querySelector('[data-user-question-option]').click();
    harness.chatTimeline.querySelector(selector).click();
    await new Promise((resolve) => setImmediate(resolve));

    const block = harness.chatTimeline.querySelector('.user-questions-block');
    assert.equal(block.dataset.userQuestionsStale, 'true');
    assert.match(block.querySelector('.user-questions-receipt').textContent, /These questions are no longer active/);
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

  harness.chatTimeline.querySelector('[data-user-question-option]').click();
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
  assert.match(pointerHarness.chatTimeline.querySelector('.user-questions-receipt').textContent, /These questions are no longer active/);

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
  assert.match(harness.chatTimeline.querySelector('.user-questions-receipt').textContent, /These questions are no longer active/);
});

test('answered receipts render single, multi, Other, missing, and escaped content in full', () => {
  const long = 'long answer '.repeat(40).trim();
  const html = renderUserQuestionsReceipt({
    toolCallId: 'call-<receipt>',
    resultKind: 'user_questions_answered',
    questions: [
      { id: 'single', prompt: '<script>Pick one</script>', options: ['Alpha'], multi_select: false, allow_other: false },
      { id: 'other', prompt: 'Other choice', options: ['Known'], multi_select: false, allow_other: true },
      { id: 'missing', prompt: 'Optional note', options: [], multi_select: false, allow_other: false },
      { id: 'long', prompt: 'Why', options: [], multi_select: false, allow_other: false },
    ],
    answers: [
      { id: 'single', value: 'Alpha' },
      { id: 'other', value: ['Known', 'Second'], other: '<img src=x onerror=alert(1)>' },
      { id: 'long', value: long },
    ],
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const receipt = dom.window.document.querySelector('.user-questions-receipt');
  const lines = Array.from(receipt.querySelectorAll('.user-questions-receipt-line')).map((line) => [
    line.querySelector('.user-questions-receipt-prompt').textContent,
    line.querySelector('.user-questions-receipt-answer').textContent,
  ]);

  assert.equal(receipt.dataset.toolCallId, 'call-<receipt>');
  assert.equal(receipt.querySelector('.user-questions-receipt-status').textContent, '✓You answered 3 questions', 'a skipped question is not counted');
  assert.equal(receipt.querySelector('.user-questions-receipt-mark').textContent, '✓');
  assert.deepEqual(lines, [
    ['<script>Pick one</script>', 'Alpha'],
    ['Other choice', 'Known, Second, Other: <img src=x onerror=alert(1)>'],
    ['Optional note', 'Skipped'],
    ['Why', long],
  ]);
  const skipped = receipt.querySelectorAll('.user-questions-receipt-answer.is-skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].textContent, 'Skipped');
  assert.equal(receipt.querySelector('.user-questions-receipt-rule'), null);
  assert.equal(receipt.querySelectorAll('script, img').length, 0);
  assert.doesNotMatch(html, /…|text-overflow|ellipsis/);
  dom.window.close();
});

test('a reply receipt shows the typed reply in full, then the prompts it answered', () => {
  const reply = '<b>Use Postgres</b> because of the audit trail. ' + 'x'.repeat(2500);
  const html = renderUserQuestionsReceipt({
    toolCallId: 'call-1',
    resultKind: 'user_questions_answered',
    reply,
    questions: [{ id: 'db', prompt: 'Which database?', options: ['A'], multi_select: false, allow_other: false }],
    answers: [],
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.user-questions-receipt-status').textContent, '✓You replied in your own words');
  const shown = doc.querySelector('.user-questions-receipt-reply').textContent;
  assert.ok(shown.startsWith('<b>Use Postgres</b> because'));
  assert.equal(shown.length, 2000, 'the reply is bounded');
  assert.equal(doc.querySelectorAll('b').length, 0);
  assert.deepEqual(Array.from(doc.querySelectorAll('.user-questions-receipt-prompt')).map((node) => node.textContent), ['Which database?']);
  assert.equal(doc.querySelector('.user-questions-receipt-answer'), null);
  const blank = renderUserQuestionsReceipt({ toolCallId: 'c', resultKind: 'user_questions_answered', reply: '   ', questions: [{ id: 'a', prompt: 'Q' }], answers: [] });
  assert.match(blank, /You skipped Jenny&#39;s questions/, 'a blank reply with no answers reads as skipped');
  dom.window.close();
});

test('receipt renders skipped and stale states and rejects unknown result kinds', () => {
  const skipped = renderUserQuestionsReceipt({ toolCallId: 'call-1', resultKind: 'user_questions_declined' });
  const stale = renderUserQuestionsReceipt({ toolCallId: 'call-1', resultKind: 'unknown', stale: true });
  assert.match(skipped, /–<\/span>You skipped Jenny&#39;s questions/);
  assert.match(stale, /–<\/span>These questions are no longer active/);
  assert.doesNotMatch(stale, /user-questions-receipt-line/, 'no prompts were given');
  assert.equal(renderUserQuestionsReceipt({ toolCallId: 'call-1', resultKind: 'unknown' }), '');
  const withPrompts = new JSDOM(`<div>${renderUserQuestionsReceipt({
    toolCallId: 'call-1', stale: true, questions: [{ id: 'a', prompt: 'First?' }, { id: 'b', prompt: 'Second?' }],
  })}</div>`).window.document;
  assert.deepEqual(Array.from(withPrompts.querySelectorAll('.user-questions-receipt-prompt')).map((node) => node.textContent), ['First?', 'Second?']);
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
  assert.match(skippedHtml, /You skipped Jenny&#39;s questions/);
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
  assert.match(html, /These questions are no longer active/);
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
