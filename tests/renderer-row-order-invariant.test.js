// Row-order invariant (2026-10-25): after an error-card Retry in the primary
// chat, a settled multi-tool turn showed its answer ABOVE its tool rows, and no
// replay of the persisted data reproduced it. The invariant compares each painted
// row list with the session's canonical event order and logs
// row_order_violation through the rollout-signal sink, so the next occurrence
// records itself. These tests pin it against real pipeline markup: quiet for
// the canonical render, loud (once) for the production inversion.
const test = require('node:test');
const assert = require('node:assert/strict');

// Global-only module: requiring it attaches rendererAppLifecyclePreferences.
require('../renderer/app/renderer-app-lifecycle-preferences');
const rowOrderInvariant = require('../renderer/chat/renderer-row-order-invariant');

const {
  createPipelineHarness,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');

const SESSION_ID = 'session-row-order';
const TURN = 'stream_retry_order';

const messages = [
  { id: 'user_order', role: 'user', content: 'what is on today?', status: 'complete', streamId: TURN },
  {
    id: 'tool_use_order_a', role: 'assistant', kind: 'tool_use', status: 'completed', content: '',
    tool_call: { call_id: 'call_order_a', tool_name: 'Read', parent_stream_id: TURN, status: 'completed', input: 'a.md' },
  },
  {
    id: 'tool_result_order_a', role: 'tool', kind: 'tool_result', status: 'complete', content: '',
    tool_result: { call_id: 'call_order_a', parent_stream_id: TURN, output_text: 'alpha' },
  },
  {
    id: 'tool_use_order_b', role: 'assistant', kind: 'tool_use', status: 'completed', content: '',
    tool_call: { call_id: 'call_order_b', tool_name: 'Read', parent_stream_id: TURN, status: 'completed', input: 'b.md' },
  },
  {
    id: 'tool_result_order_b', role: 'tool', kind: 'tool_result', status: 'complete', content: '',
    tool_result: { call_id: 'call_order_b', parent_stream_id: TURN, output_text: 'beta' },
  },
  { id: 'assistant_order', role: 'assistant', content: 'Nothing booked today.', status: 'complete', streamId: TURN },
];

// Production's persisted shape: the tool_use events land AFTER the answer
// (seq 6, 7), the tool_executing ones before it. A row must rank by its call's
// first event or every tool row would look misplaced.
function event(seq, kind, messageId, extra = {}) {
  return {
    event_id: `ev_order_${seq}`, event_seq: seq, turn_id: TURN, kind, status: 'completed',
    primary_message_id: messageId, source_message_ids: [messageId], payload: {}, ...extra,
  };
}
const turnEvents = [
  event(0, 'user_prompt', 'user_order', { payload: { content: 'what is on today?', attachments: [] } }),
  event(1, 'tool_executing', 'tool_use_order_a', { tool_call_id: 'call_order_a', payload: { tool_name: 'Read', tool_input: 'a.md' } }),
  event(2, 'tool_result', 'tool_result_order_a', { tool_call_id: 'call_order_a', payload: { tool_name: 'Read', output_text: 'alpha', is_error: false } }),
  event(3, 'tool_executing', 'tool_use_order_b', { tool_call_id: 'call_order_b', payload: { tool_name: 'Read', tool_input: 'b.md' } }),
  event(4, 'tool_result', 'tool_result_order_b', { tool_call_id: 'call_order_b', payload: { tool_name: 'Read', output_text: 'beta', is_error: false } }),
  event(5, 'assistant_text_segment', 'assistant_order', { payload: { text: 'Nothing booked today.', segment_index: 0, segment_group_index: 0 } }),
  event(6, 'tool_use', 'tool_use_order_a', { tool_call_id: 'call_order_a', payload: { tool_name: 'Read', input: 'a.md', summary: 'Read a.md' } }),
  event(7, 'tool_use', 'tool_use_order_b', { tool_call_id: 'call_order_b', payload: { tool_name: 'Read', input: 'b.md', summary: 'Read b.md' } }),
];

function renderTimeline() {
  const dom = createRenderDom();
  const harness = createPipelineHarness({
    dom,
    visibleMessages: messages,
    rowModelEnabled: true,
    currentSessionId: SESSION_ID,
    turnEventsBySession: new Map([[SESSION_ID, { turnEventLogVersion: 3, turnEvents }]]),
  });
  withWindowGlobals(harness.dom, () => {
    harness.pipeline.renderMessages({ forceFullRender: true });
  });
  return harness.dom.window.document;
}

// The production shape: the answer row painted above the rows it follows. The
// pipeline can spread one turn's rows over several row lists, so the answer
// moves in front of the turn's first row, wherever that row's list is.
function moveAnswerRowFirst(doc) {
  const answerRow = [...doc.querySelectorAll('.chat-row[data-row-kind]')]
    .find((row) => /\bassistant_order\b/.test(row.getAttribute('data-source-message-ids') || ''));
  assert.ok(answerRow, 'the answer row renders with its source message id');
  const turnId = answerRow.closest('[data-turn-id]').getAttribute('data-turn-id');
  const firstRow = doc.querySelector(`[data-turn-id="${turnId}"] .chat-row[data-row-kind]`);
  assert.notEqual(firstRow, answerRow);
  firstRow.parentNode.insertBefore(answerRow, firstRow);
  return answerRow;
}

test('the canonical render of a multi-tool turn has no row-order violation', () => {
  const doc = renderTimeline();
  const kinds = [...doc.querySelectorAll('[data-turn-id] .chat-row[data-row-kind]')]
    .map((row) => row.getAttribute('data-row-kind'));
  assert.ok(kinds.length >= 3, `expected the tool and answer rows, got ${kinds.join(',')}`);
  assert.deepEqual(rowOrderInvariant.findRowOrderViolations(doc, turnEvents), []);
});

test('an answer row painted above its tool rows is one violation naming the inversion', () => {
  const doc = renderTimeline();
  const answerRow = moveAnswerRowFirst(doc);
  const violations = rowOrderInvariant.findRowOrderViolations(doc, turnEvents);
  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.equal(violation.turnId, answerRow.closest('[data-turn-id]').getAttribute('data-turn-id'));
  assert.equal(violation.inversion.before.kind, answerRow.getAttribute('data-row-kind'));
  assert.equal(violation.inversion.before.rank, 5);
  assert.equal(violation.inversion.after.rank, 1, 'the first tool row ranks by its call, not its late tool_use event');
  assert.match(violation.order, /^\S+:5 \S+:1 /);
});

test('rows with no canonical event and rows of another session are skipped', () => {
  const doc = renderTimeline();
  const firstRow = doc.querySelector('[data-turn-id] .chat-row[data-row-kind]');
  const foreign = doc.createElement('div');
  foreign.className = 'chat-row';
  foreign.setAttribute('data-row-kind', 'assistant_text');
  foreign.setAttribute('data-source-message-ids', 'assistant_other_session');
  firstRow.parentNode.insertBefore(foreign, firstRow);
  assert.deepEqual(rowOrderInvariant.findRowOrderViolations(doc, turnEvents), []);
  // No canonical events at all (a fresh chat before its first settle): nothing to check.
  moveAnswerRowFirst(doc);
  assert.deepEqual(rowOrderInvariant.findRowOrderViolations(doc, []), []);
});

// A single-segment turn: the reasoning row and the answer row share the bare
// assistant message id, with a tool call between them. Ranking by that shared
// message id would put the answer at the reasoning's seq and flag a correct
// order; ranking by each row's own source event does not.
test('rows sharing a message id rank by their own source event, not the message', () => {
  const doc = createRenderDom().window.document;
  const article = doc.createElement('article');
  article.setAttribute('data-turn-id', 'turn_shared');
  article.innerHTML = [
    ['reasoning', 'ev_s1', 'assistant_shared'],
    ['tool_call', 'ev_s2', 'tool_use_shared'],
    ['assistant_text', 'ev_s3', 'assistant_shared'],
  ].map(([kind, eventId, messageId]) => `<div class="chat-row" data-row-kind="${kind}" data-source-event-id="${eventId}"`
    + ` data-source-message-id="${messageId}" data-source-message-ids="${messageId}"></div>`).join('');
  doc.body.appendChild(article);
  const sharedEvents = [
    { event_id: 'ev_s1', event_seq: 1, kind: 'reasoning_phase', primary_message_id: 'assistant_shared' },
    { event_id: 'ev_s2', event_seq: 2, kind: 'tool_executing', primary_message_id: 'tool_use_shared' },
    { event_id: 'ev_s3', event_seq: 3, kind: 'assistant_text_segment', primary_message_id: 'assistant_shared' },
  ];
  assert.deepEqual(rowOrderInvariant.findRowOrderViolations(doc, sharedEvents), []);
  article.insertBefore(article.lastElementChild, article.firstElementChild);
  assert.equal(rowOrderInvariant.findRowOrderViolations(doc, sharedEvents).length, 1);
});

function createSinkController(doc) {
  const logs = [];
  const controller = global.rendererAppLifecyclePreferences.createChatTimelinePreferenceController({
    state: {
      ui: {},
      turnEventsBySession: new Map([[SESSION_ID, { turnEventLogVersion: 3, turnEvents }]]),
    },
    storage: null,
    storageKeys: {},
    callbacks: {
      appendClientLog(level, event, details) {
        logs.push({ level, event, details });
      },
    },
  });
  const violations = () => logs.filter((entry) => entry.details?.signal === 'row_order_violation');
  return { controller, logs, violations };
}

// rAF is absent under node, so the scheduler runs on setTimeout(16) then setTimeout(0).
const afterPaint = () => new Promise((resolve) => setTimeout(resolve, 60));

test('the signal sink logs row_order_violation after a full render and dedupes it on the settle', async (t) => {
  const doc = renderTimeline();
  moveAnswerRowFirst(doc);
  const priorDocument = global.document;
  const priorInvariant = global.rendererRowOrderInvariant;
  global.document = doc;
  global.rendererRowOrderInvariant = rowOrderInvariant;
  t.after(() => {
    global.document = priorDocument;
    global.rendererRowOrderInvariant = priorInvariant;
  });
  const { controller, violations } = createSinkController(doc);

  // A row-list write is not a trigger; only a full render or a settle is.
  controller.recordChatTimelineRolloutSignal(SESSION_ID, 'timeline_dom_write', { lane: 'turn_row_list', outcome: 'reconcile_applied' });
  await afterPaint();
  assert.equal(violations().length, 0);

  // Two full renders in one paint (the second is a deduped healthy write) run one check.
  controller.recordChatTimelineRolloutSignal(SESSION_ID, 'timeline_dom_write', { lane: 'full_render', outcome: 'morph_applied' });
  controller.recordChatTimelineRolloutSignal(SESSION_ID, 'timeline_dom_write', { lane: 'full_render', outcome: 'morph_applied' });
  await afterPaint();
  assert.equal(violations().length, 1);
  const [logged] = violations();
  assert.equal(logged.level, 'WARN');
  assert.equal(logged.event, 'chat_timeline.row_model_rollout_signal');
  assert.equal(logged.details.reason, 'full_render');
  assert.equal(logged.details.sessionId, SESSION_ID);

  // The settle re-checks; the same misordering is counted but not logged twice.
  controller.recordChatTimelineRolloutSignal(SESSION_ID, 'terminal_canonical_parity', { turnId: TURN });
  await afterPaint();
  assert.equal(violations().length, 1);
  const counters = controller.getChatTimelineRowModelMeta(SESSION_ID).telemetry_counters;
  assert.equal(counters.row_order_violation, 2, 'the settle check ran and found the same inversion');
});

test('the signal sink stays quiet when the painted order is canonical', async (t) => {
  const doc = renderTimeline();
  const priorDocument = global.document;
  const priorInvariant = global.rendererRowOrderInvariant;
  global.document = doc;
  global.rendererRowOrderInvariant = rowOrderInvariant;
  t.after(() => {
    global.document = priorDocument;
    global.rendererRowOrderInvariant = priorInvariant;
  });
  const { controller, violations, logs } = createSinkController(doc);
  controller.recordChatTimelineRolloutSignal(SESSION_ID, 'terminal_canonical_parity', { turnId: TURN });
  await afterPaint();
  assert.equal(violations().length, 0);
  assert.equal(logs.filter((entry) => entry.event === 'chat_timeline.row_order_check_failed').length, 0);
});
