// Ht-F soak-gate canary contract for the chat-timeline rollout signals
// (legacy_message_article_markup_render / turn_article_suppressed_sibling).
//
// Reproduces the 2026-07-05 live-session shapes from the persisted stores
// (sess_1783214598425 / sess_1783175733195): once a session has ANY persisted
// turn events, projectTurnTree sources the whole turn tree from events only,
// so (1) a blank assistant _seg0 that no event references legacy-renders on
// every session open, (2) a whole live turn legacy-renders until its events
// persist at terminal, and (3) a blank segment with membership but no rows
// fires turn_article_suppressed_sibling even when it is the turn's
// primary_assistant_message_id. All three are benign-empty or self-healing
// shapes; the canary must stay quiet for them while still firing for genuine
// store damage (a content-bearing message the event log lost).
const test = require('node:test');
const assert = require('node:assert/strict');

// Global-only module (no module.exports): requiring it once attaches
// rendererAppLifecyclePreferences to globalThis. Never delete-then-require it --
// Node caches the module, so a cached require will not re-run and the global
// would stay gone.
require('../renderer/app/renderer-app-lifecycle-preferences');

const {
  createPipelineHarness,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');

const SESSION_ID = 'session-rollout-signals';

test('turn_article_stream_mismatch treats held phase as INFO and fallback as WARN', () => {
  const controller = global.rendererAppLifecyclePreferences.createChatTimelinePreferenceController({
    state: { ui: {} },
    storage: null,
    storageKeys: {},
    callbacks: {},
  });

  assert.equal(controller.resolveChatTimelineRolloutSignalLevel(
    'turn_article_stream_mismatch',
    { phase: 'signature_hold' },
  ), 'INFO');
  assert.equal(controller.resolveChatTimelineRolloutSignalLevel(
    'turn_article_stream_mismatch',
    { phase: 'patch_fallback' },
  ), 'WARN');
});

function makeTurnEventsMap(turnEvents) {
  return new Map([[SESSION_ID, { turnEventLogVersion: 3, turnEvents }]]);
}

function renderHarness(visibleMessages, turnEvents) {
  const dom = createRenderDom();
  const harness = createPipelineHarness({
    dom,
    visibleMessages,
    rowModelEnabled: true,
    currentSessionId: SESSION_ID,
    turnEventsBySession: makeTurnEventsMap(turnEvents),
  });
  withWindowGlobals(harness.dom, () => {
    harness.pipeline.renderMessages({ forceFullRender: true });
  });
  return harness;
}

function legacySignalsFor(harness, messageId) {
  return harness.rolloutSignals.filter((entry) =>
    entry.signal === 'legacy_message_article_markup_render'
    && entry.details?.messageId === messageId);
}

function suppressedSignalsFor(harness, messageId) {
  return harness.rolloutSignals.filter((entry) =>
    entry.signal === 'turn_article_suppressed_sibling'
    && entry.details?.messageId === messageId);
}

// --- Shape 1: blank orphan _seg0 (sess_1783214598425 turn _d52e140e) --------
// The turn's persisted events reference the tool call and _seg1 but never the
// blank _seg0 the stream handler created before the model went straight to a
// tool call. The blank segment must be claimed into its stream's turn
// (compat anchor), not legacy-rendered, and must not fire the canary.

const ORPHAN_TURN = 'stream_orphan_seg0';
const orphanMessages = [
  { id: 'user_orphan', role: 'user', content: 'run the tool', status: 'complete', streamId: ORPHAN_TURN },
  {
    id: 'tool_use_orphan',
    role: 'assistant',
    kind: 'tool_use',
    status: 'completed',
    content: '',
    tool_call: {
      call_id: 'call_orphan',
      tool_name: 'Read',
      parent_stream_id: ORPHAN_TURN,
      status: 'completed',
      input: 'README.md',
    },
  },
  { id: 'assistant_orphan_seg0', role: 'assistant', content: '', status: 'complete', streamId: ORPHAN_TURN },
  {
    id: 'tool_result_orphan',
    role: 'tool',
    kind: 'tool_result',
    status: 'complete',
    content: '',
    tool_result: {
      call_id: 'call_orphan',
      parent_stream_id: ORPHAN_TURN,
      output_text: 'file contents',
    },
  },
  { id: 'assistant_orphan_seg1', role: 'assistant', content: 'Found the answer.', status: 'complete', streamId: ORPHAN_TURN },
];
const orphanTurnEvents = [
  {
    event_id: 'ev_orphan_0', event_seq: 0, turn_id: ORPHAN_TURN, kind: 'user_prompt',
    primary_message_id: 'user_orphan', source_message_ids: ['user_orphan'],
    payload: { content: 'run the tool', attachments: [] },
  },
  {
    event_id: 'ev_orphan_1', event_seq: 1, turn_id: ORPHAN_TURN, kind: 'tool_use',
    status: 'completed', tool_call_id: 'call_orphan',
    primary_message_id: 'tool_use_orphan', source_message_ids: ['tool_use_orphan'],
    payload: { tool_name: 'Read', input: 'README.md', summary: 'Read README.md' },
  },
  {
    event_id: 'ev_orphan_2', event_seq: 2, turn_id: ORPHAN_TURN, kind: 'tool_result',
    status: 'completed', tool_call_id: 'call_orphan',
    primary_message_id: 'tool_result_orphan', source_message_ids: ['tool_result_orphan'],
    payload: { tool_name: 'Read', output_text: 'file contents', is_error: false },
  },
  {
    event_id: 'ev_orphan_3', event_seq: 3, turn_id: ORPHAN_TURN, kind: 'assistant_text_segment',
    status: 'completed',
    primary_message_id: 'assistant_orphan_seg1', source_message_ids: ['assistant_orphan_seg1'],
    payload: { text: 'Found the answer.', segment_index: 1, segment_group_index: 1 },
  },
];

test('blank orphan seg0 in an evented session does not fire the legacy canary and compat-anchors instead of rendering an empty article', () => {
  const harness = renderHarness(orphanMessages, orphanTurnEvents);
  const doc = harness.dom.window.document;

  assert.deepEqual(legacySignalsFor(harness, 'assistant_orphan_seg0'), []);
  // The rest of the turn still renders its real content.
  assert.ok(doc.querySelector('[data-row-kind="tool_call"][data-tool-call-id="call_orphan"]'));
  assert.match(doc.getElementById('timeline').textContent, /Found the answer\./);
  // The blank segment is a compat anchor, not a full (empty) article.
  assert.equal(doc.querySelector('.chat-entry[data-message-id="assistant_orphan_seg0"]'), null);
  assert.ok(doc.querySelector('[data-thread-compat-anchor][data-message-id="assistant_orphan_seg0"]'));
});

// --- Shape 2: live turn in a session that already has persisted events ------
// The live turn's events have not persisted yet; its messages must still be
// claimed via the message-derived turn grouping (fresh-session parity) so the
// active turn renders projected and the canary stays quiet during streaming.

test('a live turn in an evented session renders without firing the legacy canary', () => {
  const messages = [
    { id: 'user_prior', role: 'user', content: 'earlier question', status: 'complete', streamId: 'stream_prior' },
    { id: 'assistant_prior', role: 'assistant', content: 'earlier answer', status: 'complete', streamId: 'stream_prior' },
    { id: 'user_live', role: 'user', content: 'new question', status: 'complete', streamId: 'stream_live' },
    { id: 'assistant_live', role: 'assistant', content: 'Working on it', status: 'streaming', streamId: 'stream_live' },
  ];
  const turnEvents = [
    {
      event_id: 'ev_prior_0', event_seq: 0, turn_id: 'stream_prior', kind: 'user_prompt',
      primary_message_id: 'user_prior', source_message_ids: ['user_prior'],
      payload: { content: 'earlier question', attachments: [] },
    },
    {
      event_id: 'ev_prior_1', event_seq: 1, turn_id: 'stream_prior', kind: 'assistant_text_segment',
      status: 'completed',
      primary_message_id: 'assistant_prior', source_message_ids: ['assistant_prior'],
      payload: { text: 'earlier answer', segment_index: 0, segment_group_index: 0 },
    },
  ];
  const harness = renderHarness(messages, turnEvents);
  const doc = harness.dom.window.document;

  assert.deepEqual(legacySignalsFor(harness, 'assistant_live'), []);
  // The live message still renders its streaming content.
  const liveArticle = doc.querySelector('[data-message-id="assistant_live"]');
  assert.ok(liveArticle);
  assert.match(doc.getElementById('timeline').textContent, /Working on it/);
  // The settled prior turn keeps rendering projected too.
  assert.match(doc.getElementById('timeline').textContent, /earlier answer/);
});

// --- Shape 3: blank primary suppressed as "sibling" (turn _4c5be16b) --------
// The error turn's blank seg0 hosted only a settled-empty reasoning phase, so
// it has turn membership but projects no rows — and it is also the turn's
// primary_assistant_message_id. Suppressing it to a compat anchor is correct;
// firing turn_article_suppressed_sibling for a blank message is noise.

const ERROR_TURN = 'stream_error_turn';
const errorMessages = [
  { id: 'user_err', role: 'user', content: 'try the tool', status: 'complete', streamId: ERROR_TURN },
  { id: 'assistant_err_seg0', role: 'assistant', content: '', status: 'complete', streamId: ERROR_TURN },
  {
    id: 'tool_use_err',
    role: 'assistant',
    kind: 'tool_use',
    status: 'error',
    content: '',
    tool_call: {
      call_id: 'call_err',
      tool_name: 'get_weather',
      parent_stream_id: ERROR_TURN,
      status: 'error',
      input: '{}',
    },
  },
  {
    id: 'tool_result_err',
    role: 'tool',
    kind: 'tool_result',
    status: 'complete',
    content: '',
    tool_result: {
      call_id: 'call_err',
      parent_stream_id: ERROR_TURN,
      output_text: 'HTTP 400: Bad Request',
      is_error: true,
    },
  },
  { id: 'assistant_err', role: 'assistant', content: '', status: 'runtime_error', streamId: ERROR_TURN },
];
const errorTurnEvents = [
  {
    event_id: 'ev_err_0', event_seq: 0, turn_id: ERROR_TURN, kind: 'user_prompt',
    primary_message_id: 'user_err', source_message_ids: ['user_err'],
    payload: { content: 'try the tool', attachments: [] },
  },
  {
    event_id: 'ev_err_1', event_seq: 1, turn_id: ERROR_TURN, kind: 'reasoning_phase',
    status: 'completed',
    primary_message_id: 'assistant_err_seg0', source_message_ids: ['assistant_err_seg0'],
    payload: { phase_id: 'phase_err_1', phase_kind: 'thinking', entries: [], chunk_count: 0 },
  },
  {
    event_id: 'ev_err_2', event_seq: 2, turn_id: ERROR_TURN, kind: 'tool_use',
    status: 'running', tool_call_id: 'call_err',
    primary_message_id: 'tool_use_err', source_message_ids: ['tool_use_err'],
    payload: { tool_name: 'get_weather', input: '{}', summary: 'get_weather' },
  },
  {
    event_id: 'ev_err_3', event_seq: 3, turn_id: ERROR_TURN, kind: 'tool_result',
    status: 'error', tool_call_id: 'call_err',
    primary_message_id: 'tool_result_err', source_message_ids: ['tool_result_err'],
    payload: { tool_name: 'get_weather', output_text: 'HTTP 400: Bad Request', is_error: true, error_code: 'CMP-AI-0002' },
  },
  {
    event_id: 'ev_err_4', event_seq: 4, turn_id: ERROR_TURN, kind: 'assistant_error',
    status: 'runtime_error',
    primary_message_id: 'assistant_err', source_message_ids: ['assistant_err'],
    payload: { stream_error: 'model generation failed', terminal_status: 'runtime_error', content: '', error_code: 'CMP-AI-0005', retryable: true },
  },
];

test('a blank primary segment with membership but no rows compat-anchors without firing turn_article_suppressed_sibling', () => {
  const harness = renderHarness(errorMessages, errorTurnEvents);
  const doc = harness.dom.window.document;

  assert.deepEqual(suppressedSignalsFor(harness, 'assistant_err_seg0'), []);
  // The blank segment still resolves to a compat anchor (not a full article).
  assert.equal(doc.querySelector('.chat-entry[data-message-id="assistant_err_seg0"]'), null);
  // The turn's real rows (the errored tool call) still render.
  assert.ok(doc.querySelector('[data-tool-call-id="call_err"]'));
});

// --- Canary preservation: genuine store damage must still fire --------------
// A CONTENT-BEARING assistant message the event log never recorded is the
// 2026-07-02 store-loss fingerprint. The legacy fallback must keep rendering
// its content AND keep firing the canary.

test('a content-bearing message missing from the event log still legacy-renders with the canary firing', () => {
  const turnId = 'stream_damaged';
  const messages = [
    { id: 'user_damaged', role: 'user', content: 'question', status: 'complete', streamId: turnId },
    { id: 'assistant_damaged_seg0', role: 'assistant', content: 'recovered answer text', status: 'complete', streamId: turnId },
    { id: 'assistant_damaged_seg1', role: 'assistant', content: 'recorded tail', status: 'complete', streamId: turnId },
  ];
  const turnEvents = [
    {
      event_id: 'ev_dam_0', event_seq: 0, turn_id: turnId, kind: 'user_prompt',
      primary_message_id: 'user_damaged', source_message_ids: ['user_damaged'],
      payload: { content: 'question', attachments: [] },
    },
    {
      event_id: 'ev_dam_1', event_seq: 1, turn_id: turnId, kind: 'assistant_text_segment',
      status: 'completed',
      primary_message_id: 'assistant_damaged_seg1', source_message_ids: ['assistant_damaged_seg1'],
      payload: { text: 'recorded tail', segment_index: 1, segment_group_index: 1 },
    },
  ];
  const harness = renderHarness(messages, turnEvents);
  const doc = harness.dom.window.document;

  assert.equal(legacySignalsFor(harness, 'assistant_damaged_seg0').length, 1);
  assert.match(doc.getElementById('timeline').textContent, /recovered answer text/);
});
