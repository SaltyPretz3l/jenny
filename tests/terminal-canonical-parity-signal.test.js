'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createReducerWiring,
} = require('../renderer/chat/renderer-stream-handler-reducer-wiring');

function createHarness(t, options = {}) {
  const streamSegmentState = new Map();
  const liveStates = new Map();
  const rolloutSignals = [];
  const hydratedRows = options.hydratedRows || [{ row_id: 'hydrated-1', kind: 'assistant_text' }];
  const finalRows = options.finalRows || hydratedRows;
  liveStates.set('session-1', {
    active_turn_id: 'stream-1',
    turns_by_id: {
      'stream-1': {
        rows: [{ row_id: 'live-1', kind: 'assistant_text' }],
      },
    },
    reconciled_rows_by_turn_id: Object.create(null),
    pending_reconciliation_by_turn_id: Object.create(null),
  });
  t.after(() => {
    streamSegmentState.clear();
    liveStates.clear();
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
    reconcileTurnRows: () => ({
      finalRows,
      staleRows: [],
      secondPassMatches: [],
    }),
    turnTreeProjectorUtils: {
      projectTurnTree() {
        return {
          turns: [{ turn_id: 'stream-1', events: [], messages: [] }],
        };
      },
    },
    turnRowProjectorUtils: {
      projectTurnRows: () => hydratedRows,
      projectTurn: () => ({ rows: hydratedRows, viewModel: null }),
    },
    streamRehydrateUtils: {},
    isCanonicalRendererProjectionEnabled: () => false,
    isRenderTelemetryEnabled: () => options.telemetryEnabled !== false,
    recordChatTimelineRolloutSignal(sessionId, signal, details) {
      rolloutSignals.push({ sessionId, signal, details });
      return { logged: true, count: rolloutSignals.length };
    },
  });

  return { wiring, rolloutSignals };
}

function findParitySignal(rolloutSignals) {
  return rolloutSignals.find((entry) => entry.signal === 'terminal_canonical_parity');
}

test('records canonical terminal event presence and count', (t) => {
  const harness = createHarness(t);
  const canonicalTurnEvents = [
    { event_id: 'event-1', kind: 'assistant_text' },
    { event_id: 'event-2', kind: 'terminal' },
  ];

  harness.wiring.reconcileLiveTurnWithHydratedRows(
    'session-1',
    'stream-1',
    [],
    null,
    canonicalTurnEvents
  );

  const parity = findParitySignal(harness.rolloutSignals);
  assert.ok(parity, 'terminal_canonical_parity signal recorded');
  assert.equal(parity.details.canonicalEventsPresent, true);
  assert.equal(parity.details.canonicalEventCount, 2);
});

test('records an absent canonical terminal event field', (t) => {
  const harness = createHarness(t);

  harness.wiring.reconcileLiveTurnWithHydratedRows('session-1', 'stream-1', []);

  const parity = findParitySignal(harness.rolloutSignals);
  assert.ok(parity, 'terminal_canonical_parity signal recorded');
  assert.equal(parity.details.canonicalEventsPresent, false);
  assert.equal(parity.details.canonicalEventCount, 0);
});

test('records hydrated and final row counts from the reconcile', (t) => {
  const hydratedRows = [
    { row_id: 'hydrated-1', kind: 'assistant_text' },
    { row_id: 'hydrated-2', kind: 'tool_call' },
  ];
  const finalRows = [
    ...hydratedRows,
    { row_id: 'final-3', kind: 'tool_result' },
  ];
  const harness = createHarness(t, { hydratedRows, finalRows });

  harness.wiring.reconcileLiveTurnWithHydratedRows(
    'session-1',
    'stream-1',
    [],
    null,
    [{ event_id: 'event-1' }]
  );

  const parity = findParitySignal(harness.rolloutSignals);
  assert.ok(parity, 'terminal_canonical_parity signal recorded');
  assert.equal(parity.details.turnId, 'stream-1');
  assert.equal(parity.details.hydratedRowCount, 2);
  assert.equal(parity.details.finalRowCount, 3);
});

test('does not record canonical parity when render telemetry is disabled', (t) => {
  const harness = createHarness(t, { telemetryEnabled: false });

  harness.wiring.reconcileLiveTurnWithHydratedRows(
    'session-1',
    'stream-1',
    [],
    null,
    [{ event_id: 'event-1' }]
  );

  assert.equal(findParitySignal(harness.rolloutSignals), undefined);
});
