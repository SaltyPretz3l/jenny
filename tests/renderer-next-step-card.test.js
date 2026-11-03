'use strict';

// The suggest_next_step card (row 97) through the REAL projector, row renderer and persistence
// normalizers: the tool's own metadata is round-tripped rather than hand-stamped, so a whitelist or
// projection drop shows up here instead of in the real app.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const suggestNextStepTool = require('../services/tools/builtin/suggest-next-step-tool');
const { LIMITS } = require('../services/backend/next-step-result-metadata');
const { normalizePersistedToolResultMetadata } = require('../services/backend/tool-result-diff-metadata');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const nextStepCard = require('../renderer/chat/renderer-next-step-card');

const INPUT = {
  recap: 'Fixed the parser; the 14 parser tests pass.',
  question: 'Commit this now?',
  actions: [
    { label: 'Commit', message: 'Commit the parser fix.' },
    { label: 'Show diff', message: 'Show me the diff first.' },
  ],
};

async function realMetadata(input = INPUT) {
  const result = await suggestNextStepTool.execute(input, {});
  assert.notEqual(result.isError, true);
  return result.metadata;
}

function makeRenderUtils() {
  return createTurnRowRenderUtils({
    renderToolCallBlock() { return '<div class="settled-tool-row"></div>'; },
    renderMarkdown(value) { return `<p>${String(value || '')}</p>`; },
    getFeatureFlags() { return {}; },
    MESSAGE_STATUS: { STREAMING: 'streaming' },
  });
}

// One turn: text, the call and its result, closing text. `metadata` rides the tool_result event.
function turnEvents({ metadata, toolName = 'suggest_next_step', isError = false, withResult = true, callId = 'c1' } = {}) {
  const useId = `tool_use_${callId}`;
  const resultId = `tool_result_${callId}`;
  const base = (kind, messageId, index, extra) => ({
    event_id: `t:${kind}:${index}`, event_seq: index, turn_id: 't', kind,
    primary_message_id: messageId, source_message_ids: [messageId], sort_key: [index, 0, 0], ...extra,
  });
  const events = [
    base('assistant_text_segment', 'assistant_a', 0, { tool_call_id: '', payload: { text: 'Parser is fixed.', assistant_phase: 'commentary' } }),
    base('tool_use', useId, 1, { tool_call_id: callId, status: 'running', payload: { tool_name: toolName, input: INPUT } }),
  ];
  if (withResult) {
    events.push({
      ...base('tool_result', useId, 2, { tool_call_id: callId, status: isError ? 'error' : 'completed',
        payload: { tool_name: toolName, output_text: 'shown', is_error: isError, ...(metadata ? { metadata } : {}) } }),
      tool_result_message_id: resultId, source_message_ids: [useId, resultId],
    });
  }
  events.push(base('assistant_text_segment', 'assistant_final', 3, { tool_call_id: '', payload: { text: 'All done.', assistant_phase: 'final_answer' } }));
  return events;
}

function transcript({ metadata, later = [], callId = 'c1', toolName = 'suggest_next_step', storeResult = true } = {}) {
  return [
    { id: 'user_1', role: 'user', content: 'Fix the parser' },
    { id: 'assistant_a', role: 'assistant', content: 'Parser is fixed.' },
    { id: `tool_use_${callId}`, role: 'assistant', kind: 'tool_use', tool_call: { call_id: callId, tool_name: toolName, status: 'completed' } },
    ...(storeResult ? [{ id: `tool_result_${callId}`, role: 'tool', kind: 'tool_result', tool_result: { call_id: callId, metadata } }] : []),
    { id: 'assistant_final', role: 'assistant', content: 'All done.' },
    ...later,
  ];
}

function render(events, messages, options = {}) {
  const rows = projectTurnRows(events);
  const html = makeRenderUtils().buildTurnRowListMarkup(rows, messages, { sessionId: 's1', ...options });
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  return { html, rows, document: dom.window.document, window: dom.window, close: () => dom.window.close() };
}

const buttonLabels = (document) => [...document.querySelectorAll('.next-step-action')].map((button) => button.textContent);

test('a successful call projects to the card with recap, question and buttons; the first is primary', async () => {
  const metadata = await realMetadata();
  const { document, close } = render(turnEvents({ metadata }), transcript({ metadata }));
  try {
    const card = document.querySelector('.next-step-card');
    assert.ok(card, 'the card renders');
    assert.equal(card.getAttribute('role'), 'group');
    assert.equal(card.getAttribute('aria-label'), 'Next step');
    assert.equal(card.getAttribute('data-tool-call-id'), 'c1');
    assert.equal(card.getAttribute('data-state'), 'live');
    assert.equal(card.querySelector('.next-step-eyebrow').textContent, 'Next step');
    assert.equal(card.querySelector('.next-step-recap').textContent, INPUT.recap);
    assert.equal(card.querySelector('.next-step-question').textContent, INPUT.question);
    const buttons = [...card.querySelectorAll('.next-step-action')];
    assert.deepEqual(buttons.map((button) => button.textContent), ['Commit', 'Show diff']);
    assert.deepEqual(buttons.map((button) => button.getAttribute('data-primary')), ['true', 'false']);
    assert.deepEqual(buttons.map((button) => button.getAttribute('data-next-step-index')), ['0', '1']);
    assert.deepEqual(buttons.map((button) => button.getAttribute('title')), INPUT.actions.map((action) => action.message));
    assert.ok(buttons.every((button) => button.type === 'button' && !button.disabled));
    assert.equal(card.querySelector('.next-step-receipt'), null);
    assert.equal(document.querySelector('.tool-call-row'), null, 'the generic tool row is replaced');
  } finally { close(); }
});

test('the card row is a direct child of the turn row list and never folds into a tool run', async () => {
  const metadata = await realMetadata();
  assert.equal(toolCallUtils.isToolRunFoldable({ toolName: 'suggest_next_step', status: 'completed' }), false);
  const events = turnEvents({ metadata });
  const reads = ['r1', 'r2'].map((callId, index) => [
    { event_id: `t:use:${callId}`, event_seq: 10 + index * 2, turn_id: 't', kind: 'tool_use', primary_message_id: `tool_use_${callId}`,
      source_message_ids: [`tool_use_${callId}`], sort_key: [0, index, 5], tool_call_id: callId, status: 'running',
      payload: { tool_name: 'read_file', input: { path: `${callId}.js` } } },
    { event_id: `t:res:${callId}`, event_seq: 11 + index * 2, turn_id: 't', kind: 'tool_result', primary_message_id: `tool_use_${callId}`,
      tool_result_message_id: `tool_result_${callId}`, source_message_ids: [`tool_use_${callId}`, `tool_result_${callId}`],
      sort_key: [0, index, 6], tool_call_id: callId, status: 'completed', payload: { tool_name: 'read_file', output_text: 'ok', is_error: false } },
  ]).flat();
  const messages = [...transcript({ metadata }), ...['r1', 'r2'].flatMap((callId) => [
    { id: `tool_use_${callId}`, role: 'assistant', kind: 'tool_use', tool_call: { call_id: callId, tool_name: 'read_file', status: 'completed' } },
    { id: `tool_result_${callId}`, role: 'tool', kind: 'tool_result', tool_result: { call_id: callId } },
  ])];
  const { document, close } = render([...events, ...reads], messages, { transcriptView: 'answers' });
  try {
    const list = document.querySelector('.turn-row-list');
    const cardRow = document.querySelector('.next-step-card').closest('.chat-row');
    assert.equal(cardRow.parentElement, list, 'a direct .chat-row child, so the CSS order applies');
    assert.equal(cardRow.getAttribute('data-run-member'), null, 'not a run member');
    assert.equal(cardRow.getAttribute('data-row-kind'), 'tool_call');
    assert.equal(document.querySelectorAll('.chat-row[data-row-kind="tool_run"]').length, 1, 'the two reads still fold');
  } finally { close(); }
});

test('card state follows the messages after the call: live, picked and passed', async () => {
  const metadata = await realMetadata();
  const stateOf = (later, options) => {
    const view = render(turnEvents({ metadata }), transcript({ metadata, later }), options);
    try {
      const card = view.document.querySelector('.next-step-card');
      return {
        state: card.getAttribute('data-state'),
        buttons: buttonLabels(view.document),
        disabled: [...view.document.querySelectorAll('.next-step-action')].map((button) => button.disabled),
        question: card.querySelector('.next-step-question')?.textContent ?? null,
        receipt: card.querySelector('.next-step-receipt')?.textContent ?? null,
        recap: card.querySelector('.next-step-recap')?.textContent ?? null,
      };
    } finally { view.close(); }
  };

  const live = stateOf([]);
  assert.deepEqual(live, { state: 'live', buttons: ['Commit', 'Show diff'], disabled: [false, false], question: INPUT.question, receipt: null, recap: INPUT.recap });

  const streaming = stateOf([], { turnLive: true });
  assert.equal(streaming.state, 'live');
  assert.deepEqual(streaming.disabled, [true, true], 'the buttons wait while the reply streams');

  const picked = stateOf([{ id: 'user_2', role: 'user', content: '  Show me the diff first. ' }]);
  assert.deepEqual(picked, { state: 'picked', buttons: [], disabled: [], question: INPUT.question, receipt: 'You chose Show diff', recap: INPUT.recap });

  const passed = stateOf([{ id: 'user_2', role: 'user', content: 'Actually, do something else.' }]);
  assert.deepEqual(passed, { state: 'passed', buttons: [], disabled: [], question: null, receipt: null, recap: INPUT.recap });

  const afterAssistant = stateOf([{ id: 'assistant_b', role: 'assistant', content: 'More.' }]);
  assert.equal(afterAssistant.state, 'live', 'only a user message settles the card');

  const wake = { id: 'user_wake', role: 'user', application_turn: 'wake', content: 'A background job finished.' };
  assert.equal(stateOf([wake]).state, 'live', "a wake turn is the app's, not the person's reply");
  assert.equal(stateOf([wake, { id: 'user_3', role: 'user', content: INPUT.actions[0].message }]).state, 'picked',
    "the person's own reply after a wake still settles it");
});

test('a recap-only call draws a card with no question and no buttons', async () => {
  const metadata = await realMetadata({ recap: 'Everything is pushed.' });
  const { document, close } = render(turnEvents({ metadata }), transcript({ metadata }));
  try {
    const card = document.querySelector('.next-step-card');
    assert.equal(card.querySelector('.next-step-recap').textContent, 'Everything is pushed.');
    assert.equal(card.querySelector('.next-step-question'), null);
    assert.equal(card.querySelector('.next-step-actions'), null);
  } finally { close(); }
});

test('a running or errored call keeps the generic tool row', async () => {
  const metadata = await realMetadata();
  const running = render(turnEvents({ metadata, withResult: false }), transcript({ metadata, storeResult: false }));
  try {
    assert.equal(running.document.querySelector('.next-step-card'), null);
    assert.ok(running.document.querySelector('.tool-call-row'), 'a running call renders the generic row');
  } finally { running.close(); }

  const errored = render(turnEvents({ metadata, isError: true }), transcript({ metadata }));
  try {
    assert.equal(errored.document.querySelector('.next-step-card'), null);
    assert.ok(errored.document.querySelector('.tool-call-row'));
  } finally { errored.close(); }

  const noMetadata = render(turnEvents({}), transcript({ storeResult: false }));
  try {
    assert.equal(noMetadata.document.querySelector('.next-step-card'), null);
  } finally { noMetadata.close(); }
});

test('metadata with the wrong kind or out-of-bounds fields draws no card', async () => {
  const good = await realMetadata();
  const bad = {
    'wrong result_kind': { ...good, result_kind: 'git_proposal' },
    'wrong schema_version': { ...good, schema_version: 2 },
    'oversize recap': { ...good, recap: 'x'.repeat(LIMITS.recap + 1) },
    'empty recap': { ...good, recap: '' },
    'oversize question': { ...good, question: 'q'.repeat(LIMITS.question + 1) },
    'oversize label': { ...good, actions: [{ label: 'l'.repeat(LIMITS.label + 1), message: 'ok' }] },
    'oversize message': { ...good, actions: [{ label: 'ok', message: 'm'.repeat(LIMITS.message + 1) }] },
    'too many actions': { ...good, actions: Array.from({ length: LIMITS.actions + 1 }, (_, i) => ({ label: `L${i}`, message: `M${i}` })) },
    'question without actions': { ...good, actions: [] },
    'actions not an array': { ...good, actions: 'Commit' },
  };
  for (const [name, metadata] of Object.entries(bad)) {
    const view = render(turnEvents({ metadata }), transcript({ metadata }));
    try {
      assert.equal(view.document.querySelector('.next-step-card'), null, name);
      assert.ok(view.document.querySelector('.tool-call-row'), `${name}: falls back to the generic row`);
    } finally { view.close(); }
  }
});

test('hostile recap, label, question and message render escaped', async () => {
  const hostile = '<script>alert(1)</script> "quoted" & \'single\'';
  const metadata = { schema_version: 1, result_kind: 'next_step', recap: hostile,
    question: hostile, actions: [{ label: '<b>Go</b>', message: hostile }] };
  const { html, document, close } = render(turnEvents({ metadata }), transcript({ metadata }));
  try {
    assert.doesNotMatch(html, /<script>|<b>Go/);
    assert.equal(document.querySelector('script'), null);
    assert.equal(document.querySelector('.next-step-recap').textContent, hostile);
    assert.equal(document.querySelector('.next-step-question').textContent, hostile);
    const button = document.querySelector('.next-step-action');
    assert.equal(button.textContent, '<b>Go</b>');
    assert.equal(button.getAttribute('title'), hostile);
    assert.equal(button.getAttribute('data-next-step-message'), hostile);
  } finally { close(); }

  const picked = render(turnEvents({ metadata }), transcript({ metadata, later: [{ id: 'u2', role: 'user', content: hostile }] }));
  try {
    assert.equal(picked.document.querySelector('.next-step-receipt').textContent, 'You chose <b>Go</b>');
    assert.equal(picked.document.querySelector('b'), null, 'the receipt label is escaped too');
  } finally { picked.close(); }
});

test('a reload from persisted history renders the same card', async () => {
  const live = await realMetadata();
  const persisted = normalizePersistedToolResultMetadata(live);
  assert.deepEqual(persisted, {
    result_kind: 'next_step', schema_version: 1, recap: INPUT.recap, question: INPUT.question, actions: INPUT.actions,
  });
  const fromLive = render(turnEvents({ metadata: live }), transcript({ metadata: live }));
  const fromEvents = render(turnEvents({ metadata: persisted }), transcript({ metadata: persisted }));
  // The stored result message alone (no metadata on the event) also carries the card.
  const fromMessage = render(turnEvents({}), transcript({ metadata: persisted }));
  try {
    const expected = fromLive.document.querySelector('.next-step-card').outerHTML;
    assert.ok(expected.includes('next-step-action'));
    assert.equal(fromEvents.document.querySelector('.next-step-card').outerHTML, expected);
    assert.equal(fromMessage.document.querySelector('.next-step-card')?.outerHTML, expected);
  } finally { fromLive.close(); fromEvents.close(); fromMessage.close(); }
});

test('renderer limits match the persistence allowlist limits', () => {
  assert.deepEqual({ ...nextStepCard.LIMITS }, { ...LIMITS });
});

// ---- click handling ---------------------------------------------------------------------

async function mountCard({ sendPrompt, later = [] } = {}) {
  const metadata = await realMetadata();
  const view = render(turnEvents({ metadata }), transcript({ metadata, later }));
  const container = view.document.body;
  const toasts = [];
  const cleanup = nextStepCard.bindNextStepActions(container, {
    sendPrompt, showToastMessage: (message) => toasts.push(message),
  });
  const card = () => container.querySelector('.next-step-card');
  const click = (index) => container.querySelectorAll('.next-step-action')[index].click();
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { ...view, card, click, settle, toasts, cleanup };
}

test('clicking a live button sends its message once, settles the card, and a second click sends nothing', async () => {
  const sent = [];
  const view = await mountCard({ sendPrompt: async (message) => { sent.push(message); return { sessionId: 's1' }; } });
  try {
    const buttons = [...view.document.querySelectorAll('.next-step-action')];
    buttons[1].click();
    assert.equal(view.card().getAttribute('data-state'), 'picked', 'flips before the send resolves');
    assert.ok(buttons.every((button) => button.disabled), 'both buttons lock');
    assert.equal(view.card().querySelector('.next-step-receipt').textContent, 'You chose Show diff');
    buttons[0].click();
    buttons[1].click();
    await view.settle();
    assert.deepEqual(sent, ['Show me the diff first.'], 'one send, with the clicked action message');
    assert.equal(view.card().getAttribute('data-state'), 'picked');
    assert.equal(view.card().querySelector('.next-step-actions'), null, 'accepted: the buttons are gone like a re-render');
    assert.equal(view.card().querySelectorAll('.next-step-receipt').length, 1);
    assert.deepEqual(view.toasts, []);
  } finally { view.cleanup(); view.close(); }
});

test('a refused send restores the live card (null, rejected, or a throw)', async () => {
  for (const outcome of [() => null, () => ({ rejected: true, reason: 'session_busy' }), () => { throw new Error('boom'); }]) {
    let calls = 0;
    const view = await mountCard({ sendPrompt: async (message) => { calls += 1; return outcome(message); } });
    try {
      view.click(0);
      assert.equal(view.card().getAttribute('data-state'), 'picked');
      await view.settle();
      assert.equal(view.card().getAttribute('data-state'), 'live');
      assert.equal(view.card().querySelector('.next-step-receipt'), null);
      assert.ok([...view.document.querySelectorAll('.next-step-action')].every((button) => !button.disabled));
      assert.equal(view.toasts.length, 1, 'the refusal is surfaced');
      view.click(0);
      await view.settle();
      assert.equal(calls, 2, 'the restored card can be tried again');
    } finally { view.cleanup(); view.close(); }
  }
});

test('buttons that are disabled or in a settled card never send', async () => {
  const sent = [];
  const sendPrompt = async (message) => { sent.push(message); return {}; };
  const streaming = await (async () => {
    const metadata = await realMetadata();
    const view = render(turnEvents({ metadata }), transcript({ metadata }), { turnLive: true });
    const cleanup = nextStepCard.bindNextStepActions(view.document.body, { sendPrompt });
    return { ...view, cleanup };
  })();
  try {
    streaming.document.querySelector('.next-step-action').click();
    assert.equal(streaming.document.querySelector('.next-step-card').getAttribute('data-state'), 'live');
  } finally { streaming.cleanup(); streaming.close(); }

  const passed = await mountCard({ sendPrompt, later: [{ id: 'u2', role: 'user', content: 'something else' }] });
  try {
    assert.equal(passed.document.querySelectorAll('.next-step-action').length, 0);
  } finally { passed.cleanup(); passed.close(); }
  assert.deepEqual(sent, []);
});
