'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createReducerWiring,
} = require('../renderer/chat/renderer-stream-handler-reducer-wiring');

const SESSION_ID = 'session-1';
const TURN_ID = 'stream-1';
const PERSISTED_LOG_VERSION = 7;

function makeEvent(eventId, kind, text) {
  return {
    event_id: eventId,
    turn_id: TURN_ID,
    kind,
    payload: { text },
  };
}

function rowsFromEvents(events) {
  return events.map((event) => ({
    row_id: event.event_id,
    kind: event.kind,
    payload: { text: event.payload.text },
  }));
}

function createHarness(t) {
  const streamSegmentState = new Map();
  const liveStates = new Map();
  const rolloutSignals = [];
  const projectionInputs = [];
  liveStates.set(SESSION_ID, {
    active_turn_id: TURN_ID,
    turns_by_id: {
      [TURN_ID]: {
        rows: [{ row_id: 'live-row', kind: 'assistant_text' }],
      },
    },
    reconciled_rows_by_turn_id: Object.create(null),
    pending_reconciliation_by_turn_id: Object.create(null),
  });
  t.after(() => {
    streamSegmentState.clear();
    liveStates.clear();
    rolloutSignals.length = 0;
    projectionInputs.length = 0;
  });

  const wiring = createReducerWiring({
    streamSegmentState,
    normalizeId: (value) => value == null ? '' : String(value),
    normalizeString: (value) => value == null ? '' : String(value),
    getSessionMessages: () => [],
    isRowModelEnabled: () => true,
    getSessionLiveTurnState: (sessionId) => liveStates.get(sessionId) || null,
    pruneEmptySessionLiveState: () => false,
    buildRolloutRowKey: (row) => `${row?.kind || ''}|${row?.row_id || ''}`,
    buildTurnEventFromStreamPayload: () => null,
    applyTurnStreamEvent: () => {},
    reconcileTurnRows: (_provisionalRows, hydratedRows) => ({
      finalRows: hydratedRows.map((row) => ({ ...row, payload: { ...row.payload } })),
      staleRows: [],
      secondPassMatches: [],
    }),
    turnTreeProjectorUtils: {
      projectTurnTree(projectionInput) {
        projectionInputs.push(projectionInput);
        return {
          turns: [{
            turn_id: TURN_ID,
            events: Array.isArray(projectionInput.turnEvents) ? projectionInput.turnEvents : [],
          }],
        };
      },
    },
    turnRowProjectorUtils: {
      projectTurn: (turn) => ({ rows: rowsFromEvents(turn.events), viewModel: null }),
      projectTurnRows: rowsFromEvents,
    },
    streamRehydrateUtils: {},
    isCanonicalRendererProjectionEnabled: () => false,
    isRenderTelemetryEnabled: () => true,
    recordChatTimelineRolloutSignal(sessionId, signal, details) {
      rolloutSignals.push({ sessionId, signal, details });
      return { logged: true, count: rolloutSignals.length };
    },
  });

  return { liveStates, projectionInputs, rolloutSignals, wiring };
}

function reconcile(harness, persistedEvents, canonicalTurnEvents) {
  return harness.wiring.reconcileLiveTurnWithHydratedRows(
    SESSION_ID,
    TURN_ID,
    [],
    {
      turnEventLogVersion: PERSISTED_LOG_VERSION,
      turnEvents: persistedEvents,
    },
    canonicalTurnEvents
  );
}

function findParitySignal(harness) {
  return harness.rolloutSignals.find((entry) => entry.signal === 'terminal_canonical_parity');
}

test('projects carried finalized events instead of pre-finalization persisted events', (t) => {
  const persistedEvents = [makeEvent('reasoning-1', 'reasoning_phase', 'captured reasoning')];
  const finalizedEvents = [makeEvent('reasoning-1', 'reasoning_phase', 'settled reasoning')];
  const harness = createHarness(t);

  const result = reconcile(harness, persistedEvents, finalizedEvents);

  assert.deepEqual(result.finalRows, rowsFromEvents(finalizedEvents));
  assert.strictEqual(harness.projectionInputs[0].turnEvents, finalizedEvents);
  assert.strictEqual(harness.projectionInputs[0].turn_events, finalizedEvents);
  assert.equal(harness.projectionInputs[0].turnEventLogVersion, PERSISTED_LOG_VERSION);
  assert.equal(harness.projectionInputs[0].turn_event_log_version, PERSISTED_LOG_VERSION);
});

test('without carried events the persisted projection is byte-identical', (t) => {
  const persistedEvents = [makeEvent('answer-1', 'assistant_text', 'persisted answer')];
  const harness = createHarness(t);

  const result = reconcile(harness, persistedEvents, undefined);

  assert.equal(
    JSON.stringify(result.finalRows),
    JSON.stringify(rowsFromEvents(persistedEvents))
  );
  assert.strictEqual(harness.projectionInputs[0].turnEvents, persistedEvents);
  assert.strictEqual(harness.projectionInputs[0].turn_events, persistedEvents);
});

test('an empty carried event array falls back to persisted events', (t) => {
  const persistedEvents = [makeEvent('answer-1', 'assistant_text', 'persisted answer')];
  const harness = createHarness(t);

  const result = reconcile(harness, persistedEvents, []);

  assert.deepEqual(result.finalRows, rowsFromEvents(persistedEvents));
  assert.strictEqual(harness.projectionInputs[0].turnEvents, persistedEvents);
  assert.strictEqual(harness.projectionInputs[0].turn_events, persistedEvents);
});

test('swapping to finalized events preserves row identity, kind, and order', (t) => {
  const persistedEvents = [
    makeEvent('reasoning-1', 'reasoning_phase', 'captured reasoning'),
    makeEvent('answer-1', 'assistant_text', 'final answer'),
  ];
  const finalizedEvents = [
    makeEvent('reasoning-1', 'reasoning_phase', 'settled reasoning'),
    makeEvent('answer-1', 'assistant_text', 'final answer'),
  ];
  const persistedHarness = createHarness(t);
  const finalizedHarness = createHarness(t);

  const persistedRows = reconcile(persistedHarness, persistedEvents, undefined).finalRows;
  const finalizedRows = reconcile(finalizedHarness, persistedEvents, finalizedEvents).finalRows;

  const rowStructure = (rows) => rows.map((row) => ({ row_id: row.row_id, kind: row.kind }));
  assert.deepEqual(rowStructure(finalizedRows), rowStructure(persistedRows));
  assert.equal(persistedRows[0].payload.text, 'captured reasoning');
  assert.equal(finalizedRows[0].payload.text, 'settled reasoning');
});

test('terminal canonical parity reports the projection source', (t) => {
  const persistedEvents = [makeEvent('answer-1', 'assistant_text', 'persisted answer')];
  const finalizedEvents = [makeEvent('answer-1', 'assistant_text', 'finalized answer')];
  const finalizedHarness = createHarness(t);
  const persistedHarness = createHarness(t);

  reconcile(finalizedHarness, persistedEvents, finalizedEvents);
  reconcile(persistedHarness, persistedEvents, undefined);

  assert.equal(
    findParitySignal(finalizedHarness).details.projectionSource,
    'finalized_canonical_events'
  );
  assert.equal(
    findParitySignal(persistedHarness).details.projectionSource,
    'persisted_store'
  );
});

test('an unsupported log version does not let the parity record claim a fold that cannot happen', (t) => {
  // projectTurnTree gates the ENTIRE persisted-events path on
  // isTurnEventLogSupported(version >= 1), so with an empty store -- version 0 --
  // the carried log would be handed over and then silently dropped for a
  // message-built tree. Rendering is the same either way; what would be wrong is
  // projectionSource reporting a fold that never ran. This program has now been
  // burned seven times by a signal asserting a configuration production does not
  // execute, and this is the seam where the eighth would have come from.
  const harness = createHarness(t);
  const persistedEvents = [];
  const finalizedEvents = [makeEvent('answer-1', 'assistant_text', 'finalized answer')];

  harness.wiring.reconcileLiveTurnWithHydratedRows(
    SESSION_ID,
    TURN_ID,
    [],
    { turnEventLogVersion: 0, turnEvents: persistedEvents },
    finalizedEvents
  );

  assert.equal(findParitySignal(harness).details.projectionSource, 'persisted_store');
  assert.equal(findParitySignal(harness).details.canonicalEventsPresent, true);
});

test('a supported log version still prefers the carried log', (t) => {
  // The guard above must key on the version, not on the store being non-empty --
  // otherwise it would silently stop preferring finalized events the moment a
  // turn legitimately persisted none.
  const harness = createHarness(t);
  const finalizedEvents = [makeEvent('answer-1', 'assistant_text', 'finalized answer')];

  harness.wiring.reconcileLiveTurnWithHydratedRows(
    SESSION_ID,
    TURN_ID,
    [],
    { turnEventLogVersion: PERSISTED_LOG_VERSION, turnEvents: [] },
    finalizedEvents
  );

  assert.equal(findParitySignal(harness).details.projectionSource, 'finalized_canonical_events');
  assert.strictEqual(harness.projectionInputs[0].turnEvents, finalizedEvents);
});
