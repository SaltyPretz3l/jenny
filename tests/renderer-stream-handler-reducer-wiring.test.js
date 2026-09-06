const test = require('node:test');
const assert = require('node:assert/strict');

const { createReducerWiring } = require('../renderer/chat/renderer-stream-handler-reducer-wiring');

function normalizeIdImpl(value) {
  return value === null || value === undefined ? '' : String(value);
}
function normalizeStringImpl(value) {
  return value === null || value === undefined ? '' : String(value);
}

function makeReducerState() {
  return {
    active_turn_id: '',
    turns_by_id: Object.create(null),
    reconciled_rows_by_turn_id: Object.create(null),
    pending_reconciliation_by_turn_id: Object.create(null),
  };
}

function createHarness(overrides = {}) {
  const streamSegmentState = overrides.streamSegmentState || new Map();
  const sessionLiveStates = new Map();
  const sessionMessages = new Map(Object.entries(overrides.sessionMessages || {}));
  const rolloutSignals = [];

  function getSessionMessages(sessionId) {
    return sessionMessages.get(sessionId) || [];
  }
  function getSessionLiveTurnState(sessionId, callOptions = {}) {
    if (!sessionId) return null;
    let state = sessionLiveStates.get(sessionId) || null;
    if (!state && callOptions.create) {
      state = makeReducerState();
      sessionLiveStates.set(sessionId, state);
    }
    return state;
  }
  function pruneEmptySessionLiveState(sessionId, sessionLiveState) {
    const live = sessionLiveState || sessionLiveStates.get(sessionId);
    if (!live) return false;
    const hasTurns = Object.keys(live.turns_by_id).length > 0;
    const hasReconciled = Object.keys(live.reconciled_rows_by_turn_id).length > 0;
    const hasPending = Object.keys(live.pending_reconciliation_by_turn_id).length > 0;
    if (!hasTurns && !hasReconciled && !hasPending) {
      return sessionLiveStates.delete(sessionId);
    }
    return false;
  }
  function buildRolloutRowKey(row) {
    return `${row?.kind || ''}|${row?.row_id || ''}`;
  }

  const rowModelEnabled = overrides.rowModelEnabled !== false;

  const builtEvents = [];
  const buildTurnEventFromStreamPayload = overrides.buildTurnEventFromStreamPayload || function (payload, context) {
    builtEvents.push({ payload, context });
    return overrides.skipReducerEvent ? null : { kind: payload?.type || 'delta', payload, context };
  };
  const appliedEvents = [];
  const applyTurnStreamEvent = overrides.applyTurnStreamEvent || function (state, event) {
    appliedEvents.push({ state, event });
    const turnId = event?.context?.turn_id || '';
    if (turnId && !state.turns_by_id[turnId]) {
      state.turns_by_id[turnId] = { rows: [], next_sort_ordinal: 0, primary_user_message_id: event.context.primary_user_message_id };
    }
    if (turnId) {
      state.turns_by_id[turnId].rows.push({ row_id: `row_${state.turns_by_id[turnId].rows.length}` });
    }
  };
  const reconcileTurnRows = overrides.reconcileTurnRows || function (provisionalRows, hydratedRows) {
    return { finalRows: hydratedRows.slice(), staleRows: [] };
  };

  const turnTreeProjectorUtils = overrides.turnTreeProjectorUtils || {
    projectTurnTree({ messages }) {
      const turns = new Map();
      for (const message of messages || []) {
        const turnId = message?.turn_id;
        if (!turnId) continue;
        if (!turns.has(turnId)) turns.set(turnId, { turn_id: turnId, events: [], messages: [] });
        turns.get(turnId).messages.push(message);
      }
      return { turns: [...turns.values()] };
    },
  };
  const turnRowProjectorUtils = overrides.turnRowProjectorUtils || {
    projectTurnRows(events) {
      return (Array.isArray(events) ? events : []).map((e, i) => ({ row_id: `hr_${i}`, kind: e?.kind || 'delta' }));
    },
    projectTurn(turn) {
      return {
        rows: (turn.messages || []).map((m, i) => ({ row_id: `hr_${i}`, kind: m.kind || 'tool_use', primary_message_id: m.id })),
        viewModel: { id: turn.turn_id },
      };
    },
  };
  const streamRehydrateUtils = overrides.streamRehydrateUtils || {};

  const wiring = createReducerWiring({
    streamSegmentState,
    normalizeId: normalizeIdImpl,
    normalizeString: normalizeStringImpl,
    getSessionMessages,
    isRowModelEnabled: () => rowModelEnabled,
    getSessionLiveTurnState,
    pruneEmptySessionLiveState,
    buildRolloutRowKey,
    buildTurnEventFromStreamPayload,
    applyTurnStreamEvent,
    reconcileTurnRows,
    turnTreeProjectorUtils,
    turnRowProjectorUtils,
    streamRehydrateUtils,
    isCanonicalRendererProjectionEnabled: overrides.isCanonicalRendererProjectionEnabled || (() => false),
    recordChatTimelineRolloutSignal(sessionId, signal, details) {
      rolloutSignals.push({ sessionId, signal, details });
      return { logged: true, count: rolloutSignals.length };
    },
  });

  return {
    wiring,
    streamSegmentState,
    sessionLiveStates,
    sessionMessages,
    rolloutSignals,
    builtEvents,
    appliedEvents,
  };
}

test('factory dep validation throws on missing required deps', () => {
  assert.throws(() => createReducerWiring({}), /streamSegmentState/);
  assert.throws(() => createReducerWiring({ streamSegmentState: new Map() }), /normalizeId/);
  assert.throws(() => createReducerWiring({
    streamSegmentState: new Map(),
    normalizeId: () => '',
    normalizeString: () => '',
  }), /getSessionMessages/);
  assert.throws(() => createReducerWiring({
    streamSegmentState: new Map(),
    normalizeId: () => '',
    normalizeString: () => '',
    getSessionMessages: () => [],
  }), /row-model sibling helpers/);
  assert.throws(() => createReducerWiring({
    streamSegmentState: new Map(),
    normalizeId: () => '',
    normalizeString: () => '',
    getSessionMessages: () => [],
    isRowModelEnabled: () => false,
    getSessionLiveTurnState: () => null,
    pruneEmptySessionLiveState: () => false,
    buildRolloutRowKey: () => '',
  }), /turn-reducer helpers/);
});

test('buildAssistantShellMessageId formats segment-zero and higher distinctly', () => {
  const { wiring } = createHarness();
  assert.equal(wiring.buildAssistantShellMessageId('stream-1', 0), 'assistant_stream-1');
  assert.equal(wiring.buildAssistantShellMessageId('stream-1', 1), 'assistant_stream-1_seg1');
  assert.equal(wiring.buildAssistantShellMessageId('stream-1', 3), 'assistant_stream-1_seg3');
  assert.equal(wiring.buildAssistantShellMessageId('stream-1', null), 'assistant_stream-1');
});

test('applyLiveTurnPayload bypasses reducer when row model disabled', () => {
  const { wiring, appliedEvents } = createHarness({ rowModelEnabled: false });
  const result = wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  assert.equal(result, null);
  assert.equal(appliedEvents.length, 0);
});

test('applyLiveTurnPayload builds reducer context, dispatches event, returns session state', () => {
  const harness = createHarness({
    sessionMessages: {
      s1: [
        { id: 'u1', role: 'user' },
        { id: 'a1', role: 'assistant' },
      ],
    },
  });
  const result = harness.wiring.applyLiveTurnPayload(
    { sessionId: 's1', streamId: 'stream-1', type: 'delta' },
    { segmentText: 'hello' }
  );
  assert.ok(result, 'session live state created');
  assert.equal(harness.appliedEvents.length, 1);
  const context = harness.builtEvents[0].context;
  assert.equal(context.turn_id, 'stream-1');
  assert.equal(context.primary_user_message_id, 'u1', 'falls back via resolvePrimaryUserMessageId');
  assert.equal(context.primary_assistant_message_id, 'assistant_stream-1');
  assert.equal(context.segment_text, 'hello');
});

test('applyLiveTurnPayload short-circuits when buildTurnEventFromStreamPayload returns null', () => {
  const harness = createHarness({ skipReducerEvent: true });
  const result = harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  assert.ok(result, 'state still returned');
  assert.equal(harness.appliedEvents.length, 0, 'reducer not invoked on null event');
});

test('applyLiveTurnPayload increments next_sort_ordinal as ordinals are issued', () => {
  const harness = createHarness();
  harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  const ordinals = harness.builtEvents.map((e) => e.context.ordinal);
  assert.deepEqual(ordinals, [0, 1, 2]);
  assert.equal(
    harness.sessionLiveStates.get('s1').turns_by_id['stream-1'].next_sort_ordinal,
    3
  );
});

test('reconcileLiveTurnWithHydratedRows returns null on missing dependencies or empty IDs', () => {
  const harness = createHarness();
  assert.equal(harness.wiring.reconcileLiveTurnWithHydratedRows('', '', []), null);
  assert.equal(harness.wiring.reconcileLiveTurnWithHydratedRows('s1', '', []), null);
  assert.equal(harness.wiring.reconcileLiveTurnWithHydratedRows('', 'stream-1', []), null);
});

test('reconcileLiveTurnWithHydratedRows uses reducer projection when canonical renderer projection is enabled', () => {
  let legacyProjectTurnCalled = false;
  let reducerProjectionCalled = false;
  const harness = createHarness({
    isCanonicalRendererProjectionEnabled: () => true,
    sessionMessages: {
      s1: [{ id: 'a1', role: 'assistant', turn_id: 'stream-1', kind: 'assistant' }],
    },
    turnTreeProjectorUtils: {
      projectTurnTree() {
        return {
          turns: [{
            turn_id: 'stream-1',
            events: [{ event_id: 'evt:txt', turn_id: 'stream-1', kind: 'assistant_text_segment' }],
          }],
        };
      },
    },
    turnRowProjectorUtils: {
      projectTurn() {
        legacyProjectTurnCalled = true;
        return { rows: [{ row_id: 'legacy-row', kind: 'assistant_text' }], viewModel: null };
      },
      projectTurnRows() {
        legacyProjectTurnCalled = true;
        return [{ row_id: 'legacy-row', kind: 'assistant_text' }];
      },
    },
    streamRehydrateUtils: {
      projectPersistedEventsWithReducer(events) {
        reducerProjectionCalled = true;
        assert.equal(events.length, 1);
        return {
          turn: { turn_id: 'stream-1', events },
          rows: [{ row_id: 'reducer-row', kind: 'assistant_text', payload: { text: 'canonical' } }],
          viewModel: { id: 'stream-1', source: 'reducer' },
        };
      },
    },
  });
  const seeded = makeReducerState();
  seeded.turns_by_id['stream-1'] = {
    rows: [{ row_id: 'provisional-row', kind: 'assistant_text', payload: { text: 'live' } }],
    next_sort_ordinal: 0,
    primary_user_message_id: '',
  };
  harness.sessionLiveStates.set('s1', seeded);

  const result = harness.wiring.reconcileLiveTurnWithHydratedRows('s1', 'stream-1', []);

  assert.ok(result);
  assert.equal(reducerProjectionCalled, true);
  assert.equal(legacyProjectTurnCalled, false);
  const reconciled = harness.sessionLiveStates.get('s1').reconciled_rows_by_turn_id['stream-1'];
  assert.equal(reconciled.rows[0].row_id, 'reducer-row');
  assert.deepEqual(reconciled.viewModel, { id: 'stream-1', source: 'reducer' });
  // The flag is DEFAULT-ON as of 2026-08-25, so which builder produced a hydrated
  // turn is no longer inferable from the flag alone. The signal is how the owner
  // telemetry pass tells "the fold ran" from "the fold was skipped".
  const applied = harness.rolloutSignals.find((entry) => entry.signal === 'canonical_projection_applied');
  assert.ok(applied, 'a delegated hydration must announce itself');
  assert.equal(applied.details.rowCount, 1);
});

test('reconcileLiveTurnWithHydratedRows names the fallback when the reducer projection yields nothing', () => {
  // The flag can be ON and this path still hand the turn back to the projector:
  // projectPersistedEventsWithReducer returns null when the replay resolves no
  // turn, and the legacy branch silently takes over. Wave 1 lost an entire owner
  // telemetry pass to exactly this shape of anonymous fallback, so it is named.
  let legacyProjectTurnCalled = false;
  const harness = createHarness({
    isCanonicalRendererProjectionEnabled: () => true,
    sessionMessages: {
      s1: [{ id: 'a1', role: 'assistant', turn_id: 'stream-1', kind: 'assistant' }],
    },
    turnTreeProjectorUtils: {
      projectTurnTree() {
        return {
          turns: [{
            turn_id: 'stream-1',
            events: [{ event_id: 'evt:txt', turn_id: 'stream-1', kind: 'assistant_text_segment' }],
          }],
        };
      },
    },
    turnRowProjectorUtils: {
      projectTurn() {
        legacyProjectTurnCalled = true;
        return { rows: [{ row_id: 'legacy-row', kind: 'assistant_text' }], viewModel: null };
      },
      projectTurnRows() {
        legacyProjectTurnCalled = true;
        return [{ row_id: 'legacy-row', kind: 'assistant_text' }];
      },
    },
    streamRehydrateUtils: {
      projectPersistedEventsWithReducer() {
        return null;
      },
    },
  });
  const seeded = makeReducerState();
  seeded.turns_by_id['stream-1'] = {
    rows: [{ row_id: 'provisional-row', kind: 'assistant_text', payload: { text: 'live' } }],
    next_sort_ordinal: 0,
    primary_user_message_id: '',
  };
  harness.sessionLiveStates.set('s1', seeded);

  harness.wiring.reconcileLiveTurnWithHydratedRows('s1', 'stream-1', []);

  const signals = harness.rolloutSignals.map((entry) => entry.signal);
  assert.ok(signals.includes('canonical_projection_fallback'), 'the skipped delegation must say so');
  assert.ok(!signals.includes('canonical_projection_applied'));
  assert.equal(legacyProjectTurnCalled, true, 'the turn must still render, via the projector');
});

test('reconcileLiveTurnWithHydratedRows prefers hydrated turn events over message-only projection', () => {
  let projectedWithTurnEvents = false;
  const harness = createHarness({
    turnTreeProjectorUtils: {
      projectTurnTree(payload) {
        const turnEvents = Array.isArray(payload?.turn_events) ? payload.turn_events : [];
        if (turnEvents.length) {
          projectedWithTurnEvents = true;
          return {
            turns: [{
              turn_id: 'stream-1',
              events: turnEvents,
            }],
          };
        }
        return {
          turns: [{
            turn_id: 'stream-1',
            events: [
              { event_id: 'message-reasoning-a', turn_id: 'stream-1', kind: 'reasoning_phase' },
              { event_id: 'message-reasoning-b', turn_id: 'stream-1', kind: 'reasoning_phase' },
            ],
          }],
        };
      },
    },
    turnRowProjectorUtils: {
      projectTurn(turn) {
        return {
          rows: (turn.events || []).map((event) => ({
            row_id: event.event_id,
            kind: event.kind,
          })),
          viewModel: null,
        };
      },
      projectTurnRows(events) {
        return events.map((event) => ({ row_id: event.event_id, kind: event.kind }));
      },
    },
  });
  harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });

  const messages = [
    { id: 'assistant_stream-1_seg0', turn_id: 'stream-1', kind: 'assistant_text' },
    { id: 'assistant_stream-1_seg1', turn_id: 'stream-1', kind: 'assistant_text' },
  ];
  const result = harness.wiring.reconcileLiveTurnWithHydratedRows('s1', 'stream-1', messages, {
    turnEventLogVersion: 2,
    turnEvents: [{
      event_id: 'canonical-reasoning',
      turn_id: 'stream-1',
      kind: 'reasoning_phase',
    }],
  });

  assert.ok(result);
  assert.equal(projectedWithTurnEvents, true);
  const reconciled = harness.sessionLiveStates.get('s1').reconciled_rows_by_turn_id['stream-1'];
  assert.deepEqual(
    reconciled.rows.map((row) => row.row_id),
    ['canonical-reasoning']
  );
});

test('reconcileLiveTurnWithHydratedRows returns null if no provisional turn exists', () => {
  const harness = createHarness();
  // session created but no provisional turn for stream-X
  harness.sessionLiveStates.set('s1', makeReducerState());
  assert.equal(harness.wiring.reconcileLiveTurnWithHydratedRows('s1', 'stream-X', []), null);
});

test('reconcileLiveTurnWithHydratedRows clears provisional state when hydrated turn absent', () => {
  const harness = createHarness();
  // Seed a provisional turn
  harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  const liveState = harness.sessionLiveStates.get('s1');
  assert.ok(liveState.turns_by_id['stream-1']);
  // Hydrate with messages that don't include stream-1 turn
  const result = harness.wiring.reconcileLiveTurnWithHydratedRows('s1', 'stream-1', [{ id: 'm1', turn_id: 'other-turn' }]);
  assert.equal(result, null);
  assert.equal(harness.sessionLiveStates.get('s1'), undefined, 'session pruned when state empty');
});

test('reconcileLiveTurnWithHydratedRows reconciles, stamps reconciled_rows, deletes provisional turn', () => {
  const harness = createHarness();
  harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  harness.sessionLiveStates.get('s1').turns_by_id['stream-1'].status = 'unknown';
  const messages = [{ id: 'a1', turn_id: 'stream-1', kind: 'assistant_text' }];
  const result = harness.wiring.reconcileLiveTurnWithHydratedRows('s1', 'stream-1', messages);
  assert.ok(result, 'reconciliation returned');
  const live = harness.sessionLiveStates.get('s1');
  assert.equal(live.turns_by_id['stream-1'], undefined, 'provisional turn deleted');
  assert.equal(live.reconciled_rows_by_turn_id['stream-1'].turn.status, 'unknown', 'live terminal classification survives hydration');
  assert.equal(live.pending_reconciliation_by_turn_id['stream-1'], true);
});

test('reconcileLiveTurnWithHydratedRows records stale-row deletion rollout signal', () => {
  const harness = createHarness({
    reconcileTurnRows() {
      return {
        finalRows: [{ row_id: 'hr_0', kind: 'assistant_text' }],
        staleRows: [{ row_id: 'stale_a', kind: 'assistant_text' }],
      };
    },
  });
  harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  harness.wiring.reconcileLiveTurnWithHydratedRows('s1', 'stream-1', [{ id: 'a1', turn_id: 'stream-1', kind: 'assistant_text' }]);
  assert.ok(harness.rolloutSignals.some((s) => s.signal === 'stale_row_deletion'));
});

test('reconcileLiveTurnWithHydratedRows records orphan_row and interrupted_running_tool_hydration signals', () => {
  const harness = createHarness({
    turnRowProjectorUtils: {
      projectTurnRows() { return []; },
      projectTurn() {
        return {
          rows: [
            { row_id: 'r1', kind: 'system_notice', primary_message_id: 'sn1', payload: { subkind: 'orphan_dangling' } },
            { row_id: 'r2', kind: 'tool_call', tool_call_id: 'tc', primary_message_id: 'tu', payload: { state: 'interrupted' } },
          ],
          viewModel: null,
        };
      },
    },
  });
  harness.wiring.applyLiveTurnPayload({ sessionId: 's1', streamId: 'stream-1', type: 'delta' });
  harness.wiring.reconcileLiveTurnWithHydratedRows('s1', 'stream-1', [{ id: 'a1', turn_id: 'stream-1', kind: 'assistant_text' }]);
  const signals = harness.rolloutSignals.map((s) => s.signal);
  assert.ok(signals.includes('orphan_row'));
  assert.ok(signals.includes('interrupted_running_tool_hydration'));
});

test('factory only exposes documented surface', () => {
  const { wiring } = createHarness();
  assert.deepEqual(Object.keys(wiring).sort(), [
    'applyLiveTurnPayload',
    'buildAssistantShellMessageId',
    'reconcileLiveTurnWithHydratedRows',
  ]);
});

/* 2026-06-11 live-debug regression: reasoning deltas carried only thinkingId
   while phase_started carried the sidecar phase_id, so the live reasoning row
   and the settled shell had DIFFERENT dedup keys and a stale truncated copy
   survived next to the full settled row. Deltas now inherit the turn's open
   reasoning phase id; phase_completed releases the latch. */
test('reasoning deltas inherit the open sidecar phase id and release it on phase_completed', () => {
  const turnReducerUtils = require('../renderer/chat/renderer-turn-reducer');
  const produced = [];
  const harness = createHarness({
    buildTurnEventFromStreamPayload(payload, context) {
      const events = turnReducerUtils.buildTurnEventFromStreamPayload(payload, context);
      const list = Array.isArray(events) ? events : (events ? [events] : []);
      produced.push(...list);
      return events;
    },
    applyTurnStreamEvent: turnReducerUtils.applyTurnStreamEvent,
  });
  const base = { sessionId: 's1', streamId: 'stream-1' };

  harness.wiring.applyLiveTurnPayload({
    ...base,
    type: 'phase_started',
    phaseId: 'phase_reasoning_r1_iter0_1',
    thinkingId: 'think_r1_iter0',
    phaseKind: 'reasoning',
    summary: 'Reasoning through the turn',
  });
  harness.wiring.applyLiveTurnPayload({
    ...base,
    type: 'delta',
    thinkingId: 'think_r1_iter0',
    reasoning: { entriesDelta: [{ text: 'partial thought', thinkingId: 'think_r1_iter0' }] },
  });

  const reasoningEvents = produced.filter((event) => event.kind === 'reasoning_phase');
  assert.equal(reasoningEvents.length, 2);
  assert.equal(reasoningEvents[0].phase_id, 'phase_reasoning_r1_iter0_1');
  assert.equal(
    reasoningEvents[1].phase_id,
    'phase_reasoning_r1_iter0_1',
    'the delta lands on the OPEN phase, not its thinkingId'
  );

  harness.wiring.applyLiveTurnPayload({
    ...base,
    type: 'phase_completed',
    phaseId: 'phase_reasoning_r1_iter0_1',
    phaseKind: 'reasoning',
  });
  harness.wiring.applyLiveTurnPayload({
    ...base,
    type: 'delta',
    thinkingId: 'think_r1_iter1',
    reasoning: { entriesDelta: [{ text: 'later thought', thinkingId: 'think_r1_iter1' }] },
  });
  const lateReasoning = produced.filter((event) => event.kind === 'reasoning_phase').pop();
  assert.equal(
    lateReasoning.phase_id,
    'think_r1_iter1',
    'after phase_completed the latch is released and the thinkingId fallback returns'
  );
});
