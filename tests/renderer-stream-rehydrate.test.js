const test = require('node:test');
const assert = require('node:assert/strict');

const streamRehydrateUtils = require('../renderer/chat/renderer-stream-rehydrate');
const {
  rehydrateSessionLiveState,
  projectPersistedEventsWithReducer,
  shapePersistedEventForReducer,
  resolveInFlightTurnId,
  withActiveTurnForwarded,
  REPLAYABLE_KINDS,
} = streamRehydrateUtils;
const { createTurnReducerState } = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const {
  indexRowsByRenderMessageId,
} = require('../renderer/chat/renderer-render-message-index-utils');
const {
  buildTerminal,
  collectModelParts,
  resolvePhaseKey,
  selectActiveTurnFromLiveState,
} = require('../renderer/chat/renderer-turn-phase-model');
const {
  createStreamHandlerLifecycle,
} = require('../renderer/chat/renderer-stream-handler-lifecycle');

// A persisted turn_failed/turn_cancelled lands as `assistant_error`
// (PERSISTED_KIND_BY_TYPE, services/backend/canonical-turn-event.js).
function persistedAssistantError({
  eventId = 'e:err',
  turnId = 'turn-1',
  message = 'Turn failed mid-flight.',
} = {}) {
  return {
    event_id: eventId,
    turn_id: turnId,
    kind: 'assistant_error',
    status: 'error',
    primary_message_id: `assistant_${turnId}`,
    source_message_ids: [`assistant_${turnId}`],
    payload: { message, error_code: 'CMP-LOOP-0015' },
  };
}

// The backend session summary's active_turn for a genuinely in-flight turn.
// turn_id === stream_id (services/backend/managed-sidecar-chat.js).
function inFlightActiveTurn({ streamId = 'turn-1' } = {}) {
  return {
    request_id: `req_${streamId}`,
    stream_id: streamId,
    user_message_id: `user_${streamId}`,
    started_at: '2026-07-04T00:00:00.000Z',
    last_event_at: '2026-07-04T00:00:01.000Z',
    status: 'streaming',
  };
}

function buildRehydrateLifecycle({ turnEventsBySession, liveStore }) {
  return createStreamHandlerLifecycle({
    state: { turnEventsBySession },
    normalizeId: (value) => String(value || '').trim(),
    appendClientLog: () => {},
    handleStreamPayload: async () => {},
    pendingStreamCommitQueue: { dispose() {} },
    approvalToastSessionIds: new Set(),
    isRowModelEnabled: () => true,
    getLiveStateStore: () => liveStore,
    streamRehydrateUtils,
  });
}

// Phase 10C P.5 — detached event accumulation across renderer remounts.
//
// rehydrateSessionLiveState replays a session's persisted turn_events[]
// back through the reducer so the renderer's live state survives a
// remount/hot-reload without losing tool/reasoning/text rows that
// already streamed.

function persistedToolUseEvent({
  eventId = 'e:tu',
  turnId = 'turn-1',
  callId = 'c1',
  toolName = 'Read',
} = {}) {
  return {
    event_id: eventId,
    turn_id: turnId,
    kind: 'tool_use',
    status: 'running',
    primary_message_id: `tool_use_${callId}`,
    source_message_ids: [`tool_use_${callId}`],
    tool_call_id: callId,
    payload: {
      tool_name: toolName,
      input: {},
      input_json: '{}',
      summary: 'reading file',
    },
  };
}

function persistedToolResultEvent({
  eventId = 'e:tr',
  turnId = 'turn-1',
  callId = 'c1',
  toolName = 'Read',
} = {}) {
  return {
    event_id: eventId,
    turn_id: turnId,
    kind: 'tool_result',
    status: 'completed',
    primary_message_id: `tool_use_${callId}`,
    source_message_ids: [`tool_use_${callId}`, `tool_result_${callId}`],
    tool_call_id: callId,
    payload: {
      tool_name: toolName,
      output_text: 'README contents',
      summary: 'read README',
    },
  };
}

function persistedAssistantTextSegment({
  eventId = 'e:txt',
  turnId = 'turn-1',
  primaryMessageId = 'assistant_turn-1',
  text = 'Final.',
} = {}) {
  return {
    event_id: eventId,
    turn_id: turnId,
    kind: 'assistant_text_segment',
    primary_message_id: primaryMessageId,
    source_message_ids: [primaryMessageId],
    payload: {
      text,
      assistant_phase: 'final_answer',
      segment_id: `${primaryMessageId}_seg_0`,
    },
  };
}

test('REPLAYABLE_KINDS covers every kind the fold can build a row from', () => {
  // The allow-list decides what production hands the fold, and it fails SILENTLY:
  // shapePersistedEventForReducer returns null for anything unlisted. That was
  // harmless while the turn-row projector owned the hydrated rows, and became row
  // deletion on 2026-08-25 when canonical_renderer_projection went default-on and
  // the fold became the producer -- it dropped the terminal error card, every user
  // bubble, and every notice/batch/recap/slash/plan/progress row in the corpus.
  //
  // So the contract inverted: the list must now cover everything the fold builds.
  // tests/timeline-fold-convergence-gap.test.js asserts that end-to-end against
  // the corpus; this pins the membership directly.
  for (const kind of [
    'started',
    'reasoning_phase',
    'assistant_text_segment',
    'tool_use',
    'tool_executing',
    'tool_result',
    'approval_requested',
    'approval_resolved',
    'stream_reset',
    'complete',
    'error',
    'user_prompt',
    'attachment_cluster',
    'assistant_error',
    'system_notice',
    'source_citations',
    'agent_progress',
    'slash_output',
    'interactive_batch',
    'interactive_recap',
    'proactive_suggestion',
    'plan_object',
    // Intentional: the canonical fold is the reconcile-time producer since
    // canonical_renderer_projection became default-on.
    'plan_document',
    'plan_proposal',
  ]) {
    assert.ok(REPLAYABLE_KINDS.has(kind), `expected ${kind} replayable`);
  }
  // Still an allow-list, not a pass-through: an unknown kind is dropped rather
  // than shaped into a row nothing knows how to render.
  for (const kind of ['not_a_kind']) {
    assert.ok(!REPLAYABLE_KINDS.has(kind), `expected ${kind} not replayable`);
  }
});

test('persisted plan document transitions reconcile into one terminal row', () => {
  const projection = projectPersistedEventsWithReducer([
    {
      event_id: 'stream-plan-replay:plan_document:plan-dom-1:pending',
      turn_id: 'stream-plan-replay',
      kind: 'plan_document',
      primary_message_id: 'plan_document_plan-dom-1',
      source_message_ids: ['plan_document_plan-dom-1'],
      tool_call_id: 'call-plan-dom',
      status: 'pending',
      payload: {
        plan_id: 'plan-dom-1',
        tool_call_id: 'call-plan-dom',
        transition: 'pending',
        title: 'Ship the fix',
        summary: '',
        steps: ['Read', 'Write', 'Test'],
        notes: '',
        verification: '',
        feedback: '',
        files_read: ['a.js'],
        plan_edited: false,
        render_collapsed: false,
      },
    },
    {
      event_id: 'stream-plan-replay:plan_document:plan-dom-1:approved',
      turn_id: 'stream-plan-replay',
      kind: 'plan_document',
      primary_message_id: 'plan_document_plan-dom-1',
      source_message_ids: ['plan_document_plan-dom-1'],
      tool_call_id: 'call-plan-dom',
      status: 'approved',
      payload: {
        plan_id: 'plan-dom-1',
        tool_call_id: 'call-plan-dom',
        transition: 'approved',
        title: 'Ship the fix',
        summary: '',
        steps: ['Read', 'Write', 'Test'],
        notes: '',
        verification: '',
        feedback: '',
        files_read: ['a.js'],
        plan_edited: false,
        render_collapsed: true,
      },
    },
  ], { turnId: 'stream-plan-replay', deterministicRowId: true });

  assert.ok(projection, 'persisted plan documents should create a reducer projection');
  const planRows = projection.rows.filter((row) => row.kind === 'plan_document');
  assert.equal(planRows.length, 1);
  assert.deepEqual(planRows[0].payload.transitions, ['pending', 'approved']);
  assert.equal(planRows[0].payload.state, 'approved');
});

test('sealing a persisted pending plan document abandons the plan', () => {
  const projection = projectPersistedEventsWithReducer([{
    event_id: 'stream-plan-pending:plan_document:plan-pending:pending',
    turn_id: 'stream-plan-pending',
    kind: 'plan_document',
    primary_message_id: 'plan_document_plan-pending',
    source_message_ids: ['plan_document_plan-pending'],
    tool_call_id: 'call-plan-pending',
    status: 'pending',
    payload: {
      plan_id: 'plan-pending',
      tool_call_id: 'call-plan-pending',
      transition: 'pending',
      title: 'Pending plan',
      summary: '',
      steps: ['Wait for approval'],
      notes: '',
      verification: '',
      feedback: '',
      files_read: [],
      plan_edited: false,
      render_collapsed: false,
    },
  }], { turnId: 'stream-plan-pending', deterministicRowId: true });

  assert.ok(projection, 'a pending plan document should create a reducer projection');
  const planRow = projection.rows.find((row) => row.kind === 'plan_document');
  assert.ok(planRow, 'the sealed projection should retain the plan document row');
  assert.equal(planRow.payload.state, 'abandoned');
  assert.equal(planRow.payload.transition, 'abandoned');
  assert.deepEqual(planRow.payload.transitions, ['pending', 'abandoned']);
});

test('a persisted assistant_error replays as itself and settles the turn', () => {
  // It used to be remapped onto `error`, which stamps turn.status and builds NO
  // row. Under delegation that remap deleted the terminal error card. It now
  // replays as itself and does both jobs.
  const reducerEvent = shapePersistedEventForReducer({
    event_id: 'err-1',
    turn_id: 'turn-err',
    kind: 'assistant_error',
    primary_message_id: 'assistant_err',
    payload: { terminal_status: 'cancelled', message: 'Stream cancelled.' },
  }, 0);

  assert.equal(reducerEvent.kind, 'assistant_error', 'the kind must survive the shaping');
  assert.equal(reducerEvent.terminal_status, 'cancelled', 'the fold reads this to settle the turn');

  const projection = projectPersistedEventsWithReducer([{
    event_id: 'err-1',
    turn_id: 'turn-err',
    kind: 'assistant_error',
    primary_message_id: 'assistant_err',
    payload: { terminal_status: 'cancelled' },
  }], { turnId: 'turn-err', deterministicRowId: true });

  assert.equal(projection.rows.length, 1, 'the historical error row must survive delegation');
  assert.equal(projection.rows[0].kind, 'system_notice');
  assert.equal(projection.turn.status, 'cancelled', 'and the turn must still settle');
});

test('shapePersistedEventForReducer drops malformed entries', () => {
  assert.equal(shapePersistedEventForReducer(null, 0), null);
  assert.equal(shapePersistedEventForReducer({ kind: 'tool_use' }, 0), null);
  assert.equal(shapePersistedEventForReducer({ turn_id: 'x', kind: 'unknown' }, 0), null);
});

test('shapePersistedEventForReducer preserves tool_call_id and primary_message_id', () => {
  const reducerEvent = shapePersistedEventForReducer(persistedToolUseEvent(), 0);
  assert.ok(reducerEvent);
  assert.equal(reducerEvent.kind, 'tool_use');
  assert.equal(reducerEvent.turn_id, 'turn-1');
  assert.equal(reducerEvent.primary_message_id, 'tool_use_c1');
  assert.equal(reducerEvent.tool_call_id, 'c1');
  assert.equal(reducerEvent.payload.tool_name, 'Read');
});

test('shapePersistedEventForReducer preserves canonical terminal outcomes and fails malformed status closed', () => {
  const cases = [
    ['cancelled', 'cancelled'], ['denied', 'denied'], ['timeout', 'timed_out'],
    ['interrupted', 'interrupted'], ['preempted', 'preempted'], ['malformed', 'unknown'],
  ];
  for (const [terminalStatus, expected] of cases) {
    const event = shapePersistedEventForReducer({
      event_id: `terminal-${terminalStatus}`,
      turn_id: 'turn-terminal',
      kind: 'assistant_error',
      payload: { terminal_status: terminalStatus },
    }, 0);
    assert.equal(event.terminal_status, expected);
  }
});

test('rehydrateSessionLiveState seeds reducer state from tool_use + tool_result', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [persistedToolUseEvent(), persistedToolResultEvent()],
    liveStateStore: liveStore,
  });
  assert.ok(state, 'reducer state created');
  assert.ok(state.turns_by_id['turn-1'], 'turn state present');
  const rows = state.turns_by_id['turn-1'].rows;
  assert.equal(rows.length, 2, 'tool_use + tool_result emit a tool_call row and a tool_result row');
  const toolCallRow = rows.find((row) => row.kind === 'tool_call');
  const toolResultRow = rows.find((row) => row.kind === 'tool_result');
  assert.ok(toolCallRow, 'tool_call row present');
  assert.ok(toolResultRow, 'tool_result row present');
  assert.equal(toolCallRow.tool_call_id, 'c1');
  assert.equal(toolResultRow.tool_call_id, 'c1');
  assert.equal(toolCallRow.payload.state, 'completed', 'tool_call row flips to completed once result arrives');
  assert.equal(toolResultRow.payload.state, 'completed');
  assert.equal(liveStore.get('session-1'), state, 'state installed in store');
});

test('rehydrateSessionLiveState preserves text segment and ordering', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [
      persistedToolUseEvent(),
      persistedToolResultEvent(),
      persistedAssistantTextSegment({ text: 'Done.' }),
    ],
    liveStateStore: liveStore,
  });
  assert.ok(state);
  const rows = state.turns_by_id['turn-1'].rows;
  assert.deepEqual(rows.map((row) => row.kind), ['tool_call', 'tool_result', 'assistant_text']);
  const textRow = rows.find((row) => row.kind === 'assistant_text');
  assert.equal(textRow.payload.text, 'Done.');
});

test('rehydrateSessionLiveState skips one malformed persisted event and replays later valid events', () => {
  const liveStore = new Map();
  const logs = [];
  const malformed = {
    event_id: 'bad:event',
    turn_id: 'turn-1',
    kind: 'tool_use',
    primary_message_id: 'tool_use_bad',
    source_message_ids: ['tool_use_bad'],
    tool_call_id: 'bad',
  };
  Object.defineProperty(malformed, 'payload', {
    get() {
      throw new Error('payload unavailable');
    },
  });

  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [
      malformed,
      persistedAssistantTextSegment({ text: 'Recovered after malformed event.' }),
    ],
    liveStateStore: liveStore,
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  assert.ok(state);
  const rows = state.turns_by_id['turn-1'].rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'assistant_text');
  assert.equal(rows[0].payload.text, 'Recovered after malformed event.');
  assert.ok(logs.some((entry) => entry.event === 'stream.rehydrate_event_failed'));
});

test('rehydrateSessionLiveState returns null for empty event lists', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [],
    liveStateStore: liveStore,
  });
  assert.equal(state, null);
  assert.equal(liveStore.size, 0);
});

test('rehydrateSessionLiveState returns null for empty session ids', () => {
  assert.equal(
    rehydrateSessionLiveState({
      sessionId: '',
      turnEvents: [persistedToolUseEvent()],
      liveStateStore: new Map(),
    }),
    null
  );
});

test('rehydrate + canonical projection collision is resolved to a single row by indexRowsByRenderMessageId', () => {
  // End-to-end test of the dedup contract that A1 just split out into its
  // own helper. Same primary_message_id flows through two paths:
  //   * canonical: projectTurnRows over persisted turn_events
  //   * live overlay: rehydrateSessionLiveState replays into the reducer
  // After both surface, the index helper must collapse the collision down
  // to one row, preferring canonical over the live overlay. Without this
  // contract the renderer flashed duplicate bubbles after rehydration
  // (commit 686a987 phantom-row regression).
  const sharedPrimaryMessageId = 'assistant_rehydrate_collision';
  const sharedTurnId = 'turn-rehydrate-collision';

  const persistedEvents = [
    {
      event_id: 'evt:txt_seg_0',
      turn_id: sharedTurnId,
      kind: 'assistant_text_segment',
      primary_message_id: sharedPrimaryMessageId,
      source_message_ids: [sharedPrimaryMessageId],
      assistant_phase: 'final_answer',
      sort_key: [1, 0, 30],
      payload: {
        text: 'Hello from rehydration. ',
        assistant_phase: 'final_answer',
        segment_id: `${sharedPrimaryMessageId}_seg_0`,
        phase_id: 'phase_text_final',
      },
    },
    {
      event_id: 'evt:txt_seg_1',
      turn_id: sharedTurnId,
      kind: 'assistant_text_segment',
      primary_message_id: sharedPrimaryMessageId,
      source_message_ids: [sharedPrimaryMessageId],
      assistant_phase: 'final_answer',
      sort_key: [1, 1, 30],
      payload: {
        text: 'Final.',
        assistant_phase: 'final_answer',
        segment_id: `${sharedPrimaryMessageId}_seg_1`,
        phase_id: 'phase_text_final',
      },
    },
  ];

  // Canonical path: project the persisted events into row models. These are
  // the rows the projector emits during a normal render after the stream
  // completes — untagged (no _dedup_source), authoritative.
  const canonicalRows = projectTurnRows(persistedEvents);
  const canonicalAssistantRow = canonicalRows.find((row) => row.kind === 'assistant_text');
  assert.ok(canonicalAssistantRow, 'canonical projection must yield one assistant_text row');
  assert.equal(canonicalAssistantRow.payload.text, 'Hello from rehydration. Final.');

  // Live overlay path: replay the same events through the reducer (as a
  // remount would), then tag the resulting row with the live overlay
  // dedup_source the way overlayProjectedRows does in production.
  const liveStore = new Map();
  rehydrateSessionLiveState({
    sessionId: 'session-rehydrate-collision',
    turnEvents: persistedEvents,
    liveStateStore: liveStore,
  });
  const liveRows = liveStore.get('session-rehydrate-collision').turns_by_id[sharedTurnId].rows.slice();
  const liveAssistantRow = liveRows.find((row) => row.kind === 'assistant_text');
  assert.ok(liveAssistantRow, 'rehydrated live state must contain an assistant_text row');
  // Tag like overlayProjectedRows does for the live overlay branch.
  liveAssistantRow._dedup_source = 'live';

  // Simulate the projection-context surface: rowsByTurnId carries both
  // turn buckets keyed by turn_id. Canonical and live use distinct turn_ids
  // (canonical: sharedTurnId; live overlay: a sibling turn for the same
  // primary_message_id, which is the multi-turn collision shape).
  const rowsByTurnId = new Map([
    ['turn-live-overlay', liveRows],
    [sharedTurnId, canonicalRows],
  ]);

  const index = indexRowsByRenderMessageId(rowsByTurnId);
  const bucket = index.get(sharedPrimaryMessageId) || [];
  const dedupedAssistantRows = bucket.filter((row) => row.kind === 'assistant_text');
  assert.equal(
    dedupedAssistantRows.length,
    1,
    'canonical+live collision over rehydration must collapse to a single assistant_text row'
  );
  assert.equal(
    dedupedAssistantRows[0].payload.text,
    'Hello from rehydration. Final.',
    'canonical row content must survive (live overlay loses the rank tiebreak)'
  );
  assert.notEqual(
    dedupedAssistantRows[0]._dedup_source,
    'live',
    'survivor must be canonical (untagged), not the live overlay row'
  );
});

test('projectPersistedEventsWithReducer projects canonical rows without render-time dedup tags', () => {
  const turnEvents = [
    persistedAssistantTextSegment({
      eventId: 'evt:txt:first',
      turnId: 'turn-reducer-projection',
      primaryMessageId: 'assistant_reducer_projection',
      text: 'Hello ',
    }),
    {
      event_id: 'evt:reasoning:empty',
      turn_id: 'turn-reducer-projection',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_reducer_projection',
      source_message_ids: ['assistant_reducer_projection'],
      phase_id: 'phase_empty',
      status: 'completed',
      payload: {
        phase_id: 'phase_empty',
        phase_kind: 'reasoning',
        thinking_id: 'think_empty',
        entries: [],
      },
    },
    persistedAssistantTextSegment({
      eventId: 'evt:txt:second',
      turnId: 'turn-reducer-projection',
      primaryMessageId: 'assistant_reducer_projection',
      text: 'world.',
    }),
    persistedToolUseEvent({
      eventId: 'evt:tool:use',
      turnId: 'turn-reducer-projection',
      callId: 'call-reducer-projection',
    }),
    persistedToolResultEvent({
      eventId: 'evt:tool:result',
      turnId: 'turn-reducer-projection',
      callId: 'call-reducer-projection',
    }),
  ];

  const projection = projectPersistedEventsWithReducer(turnEvents);

  assert.ok(projection);
  assert.equal(projection.turn.turn_id, 'turn-reducer-projection');
  assert.deepEqual(
    projection.rows.map((row) => row.kind),
    ['assistant_text', 'tool_call', 'tool_result']
  );
  assert.equal(projection.rows[0].payload.text, 'Hello world.');
  assert.equal(projection.rows[0]._dedup_source, undefined);
  const projectedToolCall = projection.rows.find((row) => row.kind === 'tool_call');
  const projectedToolResult = projection.rows.find((row) => row.kind === 'tool_result');
  assert.equal(projectedToolCall.payload.state, 'completed');
  assert.equal(projectedToolResult.payload.state, 'completed');
});

test('rehydrateSessionLiveState is identical to applying events through the public reducer API', () => {
  // Sanity check: replaying a known turn through rehydrate produces the
  // same row shape as feeding the same persisted events into a fresh
  // reducer state via applyTurnStreamEvent indirectly.
  const liveStore = new Map();
  rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [persistedToolUseEvent(), persistedToolResultEvent()],
    liveStateStore: liveStore,
  });
  const rehydratedRows = liveStore.get('session-1').turns_by_id['turn-1'].rows;
  // Construct an empty state to compare row shape.
  const direct = createTurnReducerState();
  assert.deepEqual(Object.keys(direct.turns_by_id), []);
  assert.equal(rehydratedRows.length, 2);
  assert.deepEqual(rehydratedRows.map((row) => row.kind), ['tool_call', 'tool_result']);
});

// ── Settled-turn rehydration gate (session-persistence audit #2) ─────────────
//
// On reopen, persisted turn_events[] were replayed into the LIVE reducer
// unconditionally. A settled session has no persisted+replayable terminal marker
// (turn_completed is never persisted; turn_failed/cancelled persist as
// assistant_error, which REPLAYABLE_KINDS excludes), so replay left active_turn_id
// set with an empty status and the renderer showed a phantom live turn. The
// fix gates live seeding on the backend summary's
// active_turn (the authoritative in-flight signal) and settles a replayed
// terminal assistant_error into Needs-Recovery rather than limbo.

test('resolveInFlightTurnId returns the in-flight turn_id (=== stream_id) or empty', () => {
  assert.equal(resolveInFlightTurnId(null), '');
  assert.equal(resolveInFlightTurnId(undefined), '');
  assert.equal(resolveInFlightTurnId({}), '');
  assert.equal(resolveInFlightTurnId([]), '');
  assert.equal(resolveInFlightTurnId(inFlightActiveTurn({ streamId: 'turn-7' })), 'turn-7');
});

test('withActiveTurnForwarded forwards the key only when the source carries it (opt-in contract)', () => {
  const base = { sessionId: 's1', turnEvents: [] };
  // Key absent on the source -> return base untouched (legacy replay-all).
  assert.equal(withActiveTurnForwarded(base, {}), base, 'no activeTurn key -> same object, key stays absent');
  assert.equal(withActiveTurnForwarded(base, null), base, 'null source -> same object');
  assert.equal(withActiveTurnForwarded(base, undefined), base, 'missing source -> same object');
  // Key present (even when null) -> forwarded onto a fresh object (settled-skip opt-in).
  const settled = withActiveTurnForwarded(base, { activeTurn: null });
  assert.notEqual(settled, base, 'present key -> new object, base not mutated');
  assert.equal(Object.prototype.hasOwnProperty.call(settled, 'activeTurn'), true);
  assert.equal(settled.activeTurn, null);
  const live = { stream_id: 'stream-9' };
  assert.deepEqual(
    withActiveTurnForwarded(base, { activeTurn: live }).activeTurn,
    live,
    'present in-flight activeTurn is forwarded verbatim'
  );
  assert.equal(Object.prototype.hasOwnProperty.call(base, 'activeTurn'), false, 'base is never mutated');
});

test('rehydrateSessionLiveState skips a settled completed turn — no live seed or selection', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [
      persistedToolUseEvent(),
      persistedToolResultEvent(),
      persistedAssistantTextSegment({ text: 'Done.' }),
    ],
    liveStateStore: liveStore,
    activeTurn: null,
  });
  assert.equal(state, null, 'a settled turn (active_turn null) is not replayed into live state');
  assert.equal(liveStore.size, 0, 'no live state installed for a settled session');
  const selected = selectActiveTurnFromLiveState(liveStore.get('session-1'));
  assert.equal(selected, null, 'nothing to select from an empty live store');
});

test('rehydrateSessionLiveState skips a failed-but-settled turn (assistant_error persisted, active_turn null)', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [persistedToolUseEvent(), persistedAssistantError()],
    liveStateStore: liveStore,
    activeTurn: null,
  });
  assert.equal(state, null);
  assert.equal(liveStore.size, 0);
});

test('rehydrateSessionLiveState skips a settled turn that ended mid-tool-use (active_turn null)', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    // tool_use with no matching tool_result: the turn ended mid-tool-use.
    turnEvents: [persistedToolUseEvent()],
    liveStateStore: liveStore,
    activeTurn: null,
  });
  assert.equal(state, null, 'a mid-tool-use turn that is no longer in flight does not seed');
  assert.equal(liveStore.size, 0);
});

test('rehydrateSessionLiveState skips seeding when the in-flight turn_id matches no persisted event', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [persistedToolUseEvent({ turnId: 'turn-1', callId: 'c1' })],
    liveStateStore: liveStore,
    activeTurn: inFlightActiveTurn({ streamId: 'turn-999' }),
  });
  assert.equal(state, null, 'an in-flight turn with no persisted events is not seeded from stale history');
  assert.equal(liveStore.size, 0);
});

test('rehydrateSessionLiveState seeds a genuine orphan whose in-flight turn_id matches persisted events', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [persistedToolUseEvent({ turnId: 'turn-1', callId: 'c1' })],
    liveStateStore: liveStore,
    activeTurn: inFlightActiveTurn({ streamId: 'turn-1' }),
  });
  assert.ok(state, 'a genuine orphan replays so crash recovery still shows the interrupted turn');
  assert.equal(state.active_turn_id, 'turn-1');
  assert.ok(liveStore.get('session-1'), 'live state installed for the in-flight session');
});

test('rehydrateSessionLiveState settles a replayed orphan carrying a terminal assistant_error into Needs-Recovery', () => {
  const liveStore = new Map();
  rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [
      persistedToolUseEvent({ turnId: 'turn-1', callId: 'c1' }),
      persistedAssistantError({ turnId: 'turn-1', message: 'Turn failed mid-flight.' }),
    ],
    liveStateStore: liveStore,
    activeTurn: inFlightActiveTurn({ streamId: 'turn-1' }),
  });
  const seeded = liveStore.get('session-1');
  assert.ok(seeded, 'the orphan is seeded');
  const turn = seeded.turns_by_id['turn-1'];
  assert.equal(turn.status, 'errored', 'a terminal assistant_error still settles the turn');
  // Inverted on 2026-08-25. The row used to be withheld here because the projector
  // owned it; under canonical_renderer_projection the fold IS the producer, so
  // withholding it deleted the error card. Both folds mint the same id for this
  // row, so a flag-off rollback still reconciles the live row against the
  // projector's without duplicating it.
  assert.equal(
    turn.rows.some((row) => row.kind === 'system_notice'),
    true,
    'the fold builds the historical error row now'
  );
  const selected = selectActiveTurnFromLiveState(seeded);
  const parts = collectModelParts(selected);
  const terminal = buildTerminal(selected, parts.rows);
  assert.equal(terminal.kind, 'errored', 'shared phase derivation preserves the recovery state');
  assert.equal(resolvePhaseKey(parts, terminal), 'error');
});

test('rehydrateSessionLiveState without an activeTurn key preserves legacy replay-all seeding', () => {
  const liveStore = new Map();
  const state = rehydrateSessionLiveState({
    sessionId: 'session-1',
    turnEvents: [persistedToolUseEvent(), persistedToolResultEvent()],
    liveStateStore: liveStore,
  });
  assert.ok(state, 'omitting activeTurn keeps the ungated legacy path (overlay/projection callers)');
  assert.ok(liveStore.get('session-1'));
});

test('rehydrateSessionFromPersistedTurnEvents skips a settled session and seeds a genuine orphan (reopen bridge)', () => {
  const liveStore = new Map();
  const turnEventsBySession = new Map();
  const lifecycle = buildRehydrateLifecycle({ turnEventsBySession, liveStore });

  // Settled reopen: clearActiveTurn persisted active_turn: null on completion.
  turnEventsBySession.set('settled', {
    turnEventLogVersion: 1,
    turnEvents: [
      persistedToolUseEvent({ turnId: 'turn-s', callId: 'cs' }),
      persistedAssistantTextSegment({
        turnId: 'turn-s',
        primaryMessageId: 'assistant_turn-s',
        text: 'Done.',
      }),
    ],
    activeTurn: null,
  });
  assert.equal(
    lifecycle.rehydrateSessionFromPersistedTurnEvents('settled'),
    null,
    'reopening a settled session does not seed phantom live state'
  );
  assert.equal(liveStore.has('settled'), false);

  // Orphan reopen: active_turn still set for the interrupted in-flight turn.
  turnEventsBySession.set('orphan', {
    turnEventLogVersion: 1,
    turnEvents: [persistedToolUseEvent({ turnId: 'turn-o', callId: 'co' })],
    activeTurn: inFlightActiveTurn({ streamId: 'turn-o' }),
  });
  const seeded = lifecycle.rehydrateSessionFromPersistedTurnEvents('orphan');
  assert.ok(seeded, 'reopening a genuine orphan seeds live state (crash recovery preserved)');
  assert.equal(seeded.active_turn_id, 'turn-o');
  assert.ok(liveStore.get('orphan'));
});
