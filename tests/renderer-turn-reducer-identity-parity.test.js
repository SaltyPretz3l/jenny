/*
 * Row-identity parity guard (flicker/persistence RCA — defect class DC1).
 *
 * Reasoning/tool rows derive their identity from slice-scoped fields and THREE
 * paths must agree on it: live dispatch, persisted rehydration, and collection.
 * Current stream envelopes carry sidecar phase_id end to end. Legacy phase-less
 * deltas still fall back to thinking_id and exercise the reconciliation net.
 *
 * This file guards BOTH reconcile regimes:
 *   1. FLAG-OFF (default): reconcile keys on the slice-scoped tuple, so the
 *      drifted reasoning row is recovered by the SECOND PASS (staleRows === 0,
 *      DOM node reused via mergeReconciledRow). This is the runtime tripwire's
 *      deterministic counterpart — reducer-wiring records `stale_row_deletion`
 *      whenever reconcileTurnRows returns staleRows.length > 0.
 *   2. FLAG-ON (chat_timeline_deterministic_row_id): both paths stamp the same
 *      deterministic row_id (reasoning anchored on the shared phase_id), so
 *      the FIRST pass matches structurally and the second-pass net is NOT
 *      exercised (secondPassMatches is empty) — the structural DC1 cure.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
  reconcileTurnRows,
  buildRowIdentityKey,
} = require('../renderer/chat/renderer-turn-reducer');
const { rehydrateSessionLiveState } = require('../renderer/chat/renderer-stream-rehydrate');

const TURN = 'turn_parity';
const ASSISTANT = 'assistant_turn_parity';
const USER = 'user_parity';

// ---- Live dispatch path: stream payloads -> reducer -> provisional rows. ----
function buildLiveRows({ deterministicRowId = false, legacyPhaseDrift = false } = {}) {
  const state = createTurnReducerState({ deterministicRowId });
  let ordinal = 0;
  const apply = (payload, context = {}) => {
    const events = buildTurnEventFromStreamPayload(payload, {
      turn_id: TURN,
      primary_user_message_id: USER,
      primary_assistant_message_id: ASSISTANT,
      ordinal: ordinal += 1,
      ...context,
    });
    applyTurnStreamEvent(state, events);
  };
  apply({ type: 'started', streamId: TURN });
  // Current deltas carry the sidecar phase envelope. The legacy fixture omits it
  // to retain coverage for older handoffs that synthesize phase_id from thinkingId.
  apply({
    type: 'delta',
    streamId: TURN,
    thinkingId: 'think_shared',
    ...(legacyPhaseDrift ? {} : {
      phaseId: 'phase_sidecar',
      phaseKind: 'reasoning',
      phase: { phase_id: 'phase_sidecar', phase_kind: 'reasoning', thinking_id: 'think_shared' },
    }),
    reasoning: { entriesDelta: [{ text: 'Let me think about it.' }] },
    content: '',
  });
  apply(
    { type: 'tool_use', streamId: TURN, callId: 'c1', toolName: 'Read', status: 'running', summary: 'Read a' },
    { primary_tool_message_id: 'tool_use_c1' }
  );
  apply(
    { type: 'tool_result', streamId: TURN, callId: 'c1', toolName: 'Read', content: 'ok', isError: false, approvalState: 'auto' },
    { tool_result_message_id: 'tool_result_c1' }
  );
  apply(
    { type: 'tool_use', streamId: TURN, callId: 'c2', toolName: 'Grep', status: 'running', summary: 'Grep b' },
    { primary_tool_message_id: 'tool_use_c2' }
  );
  apply(
    { type: 'tool_result', streamId: TURN, callId: 'c2', toolName: 'Grep', content: 'hit', isError: false, approvalState: 'auto' },
    { tool_result_message_id: 'tool_result_c2' }
  );
  apply(
    { type: 'delta', streamId: TURN, content: 'Done.', aggregate: 'Done.' },
    { segment_text: 'Done.', segment_index: 0, assistant_phase: 'final_answer' }
  );
  return state.turns_by_id[TURN].rows.slice();
}

// ---- Rehydrate path: persisted turn_events -> reducer -> hydrated rows. ----
function persistedTurnEvents() {
  const toolUse = (callId, name, ord) => ({
    event_id: `e:tu:${callId}`, turn_id: TURN, kind: 'tool_use', status: 'running',
    primary_message_id: `tool_use_${callId}`, source_message_ids: [`tool_use_${callId}`],
    tool_call_id: callId, sort_key: [ord, 0, 0],
    payload: { tool_name: name, input: {}, input_json: '{}', summary: `${name} x` },
  });
  const toolResult = (callId, name, ord) => ({
    event_id: `e:tr:${callId}`, turn_id: TURN, kind: 'tool_result', status: 'completed',
    primary_message_id: `tool_use_${callId}`, source_message_ids: [`tool_use_${callId}`, `tool_result_${callId}`],
    tool_call_id: callId, sort_key: [ord, 1, 0],
    payload: { tool_name: name, content: 'ok', is_error: false, approval_state: 'auto' },
  });
  return [
    {
      event_id: 'e:reason', turn_id: TURN, kind: 'reasoning_phase',
      primary_message_id: ASSISTANT, source_message_ids: [ASSISTANT],
      // The persisted event carries the sidecar phase_id (which drifts from the
      // live synthesized one) but the SAME thinking_id the live delta carried.
      phase_id: 'phase_sidecar', status: 'completed', sort_key: [1, 0, 0],
      payload: { phase_id: 'phase_sidecar', phase_kind: 'reasoning', thinking_id: 'think_shared', entries: [{ text: 'Let me think about it.' }] },
    },
    toolUse('c1', 'Read', 2), toolResult('c1', 'Read', 2),
    toolUse('c2', 'Grep', 3), toolResult('c2', 'Grep', 3),
    {
      event_id: 'e:txt', turn_id: TURN, kind: 'assistant_text_segment',
      primary_message_id: ASSISTANT, source_message_ids: [ASSISTANT], assistant_phase: 'final_answer',
      sort_key: [9, 0, 30],
      payload: { text: 'Done.', assistant_phase: 'final_answer', segment_id: `${ASSISTANT}_seg_0`, phase_id: 'phase_text_final' },
    },
  ];
}

function buildHydratedRows({ deterministicRowId = false } = {}) {
  const store = new Map();
  rehydrateSessionLiveState({ sessionId: 'sess_parity', turnEvents: persistedTurnEvents(), liveStateStore: store, deterministicRowId });
  const session = store.get('sess_parity');
  const turn = session && session.turns_by_id[TURN];
  return turn ? turn.rows.slice() : [];
}

const EXPECTED_KINDS = ['reasoning', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant_text'];

test('live and rehydrate paths produce the same logical rows for a reasoning + multi-tool turn', () => {
  const live = buildLiveRows();
  const hydrated = buildHydratedRows();
  assert.deepEqual(live.map((r) => r.kind), EXPECTED_KINDS, 'live path row kinds');
  assert.deepEqual(hydrated.map((r) => r.kind), EXPECTED_KINDS, 'rehydrate path row kinds');
});

test('flag-OFF: drifted reasoning identity reconciles via the second pass with zero stale rows and preserved row_ids', () => {
  const live = buildLiveRows({ legacyPhaseDrift: true });
  const hydrated = buildHydratedRows();

  // Precondition: the reasoning row identity MUST genuinely drift between the
  // two paths (phase_id), otherwise this test would trivially pass without
  // exercising the second-pass recovery it is meant to guard.
  const liveReasoning = live.find((r) => r.kind === 'reasoning');
  const hydratedReasoning = hydrated.find((r) => r.kind === 'reasoning');
  const livePhaseId = liveReasoning.phase_id || (liveReasoning.payload && liveReasoning.payload.phase_id);
  const hydratedPhaseId = hydratedReasoning.phase_id || (hydratedReasoning.payload && hydratedReasoning.payload.phase_id);
  assert.notEqual(
    livePhaseId,
    hydratedPhaseId,
    'fixture must exercise DC1: the live (thinkingId) and persisted (sidecar) reasoning phase_ids must differ'
  );

  const reconciliation = reconcileTurnRows(live, hydrated);

  // 1. No orphaned provisional row -> no remove/insert blink at the handoff.
  assert.equal(
    reconciliation.staleRows.length,
    0,
    `expected zero stale rows; got ${reconciliation.staleRows.map((r) => `${r.kind}|${r.row_id}`).join(', ')}`
  );
  // 2. One reconciled row per live row — no phantom insert, no loss.
  assert.equal(reconciliation.finalRows.length, live.length, 'finalRows count matches live row count');
  assert.deepEqual(
    reconciliation.finalRows.map((r) => r.kind),
    live.map((r) => r.kind),
    'reconciled row kinds match the live order'
  );
  // 3. Every reconciled row adopts a live row_id -> the painted DOM node is
  //    reused in place rather than remounted (incl. the drifted reasoning row,
  //    recovered by the second pass via mergeReconciledRow).
  const liveRowIds = new Set(live.map((r) => r.row_id));
  for (const row of reconciliation.finalRows) {
    assert.ok(
      liveRowIds.has(row.row_id),
      `reconciled ${row.kind} row_id ${row.row_id} was not adopted from a live provisional row`
    );
  }
  // 4. The second pass DID the recovery here (the reasoning row drifted on
  //    phase_id), so the flag-off net is genuinely exercised.
  assert.ok(
    Array.isArray(reconciliation.secondPassMatches)
      && reconciliation.secondPassMatches.some((m) => m.kind === 'reasoning'),
    'flag-off: the reasoning row must be recovered by the second pass'
  );
});

test('flag-ON: deterministic row_id makes reconcile match on the FIRST pass — second pass not exercised', () => {
  const live = buildLiveRows({ deterministicRowId: true });
  const hydrated = buildHydratedRows({ deterministicRowId: true });

  assert.deepEqual(live.map((r) => r.kind), EXPECTED_KINDS, 'live kinds unchanged under flag-on');
  assert.deepEqual(hydrated.map((r) => r.kind), EXPECTED_KINDS, 'hydrated kinds unchanged under flag-on');

  // Cross-path row_id equality over all five DC1 kinds: for each live row there
  // is exactly one hydrated row with the identical deterministic row_id.
  const hydratedIdCounts = new Map();
  for (const row of hydrated) {
    hydratedIdCounts.set(row.row_id, (hydratedIdCounts.get(row.row_id) || 0) + 1);
  }
  for (const row of live) {
    assert.equal(
      hydratedIdCounts.get(row.row_id),
      1,
      `live ${row.kind} row_id ${row.row_id} must have exactly one hydrated counterpart with the same deterministic id`
    );
  }

  // The reasoning row specifically: deterministic id is anchored on the shared
  // phase_id supplied by the current live and persisted paths.
  const liveReasoning = live.find((r) => r.kind === 'reasoning');
  const hydratedReasoning = hydrated.find((r) => r.kind === 'reasoning');
  assert.equal(liveReasoning.row_id, `row:reasoning:${TURN}:phase_sidecar`);
  assert.equal(hydratedReasoning.row_id, liveReasoning.row_id, 'reasoning row_id identical across paths');

  // buildRowIdentityKey === row_id under the flag (reconcile keys on the id).
  for (const row of live.concat(hydrated)) {
    assert.equal(
      buildRowIdentityKey(row, { deterministicRowId: true }),
      row.row_id,
      `buildRowIdentityKey must equal row_id under flag-on for ${row.kind}`
    );
  }

  const reconciliation = reconcileTurnRows(live, hydrated, { deterministicRowId: true });
  assert.equal(reconciliation.staleRows.length, 0, 'zero stale rows under flag-on');
  assert.equal(reconciliation.finalRows.length, live.length, 'one reconciled row per live row');
  assert.deepEqual(
    reconciliation.secondPassMatches,
    [],
    'the deterministic first pass must match everything; the second-pass net must NOT fire'
  );
  const liveRowIds = new Set(live.map((r) => r.row_id));
  for (const row of reconciliation.finalRows) {
    assert.ok(liveRowIds.has(row.row_id), `reconciled ${row.kind} row_id ${row.row_id} preserved`);
  }
});

test('reconcile surfaces a provisional row with no hydrated counterpart as stale (runtime tripwire signal)', () => {
  // Documents the input contract the runtime tripwire depends on: when a live
  // provisional row genuinely has no persisted counterpart, it must appear in
  // staleRows so reducer-wiring can record the `stale_row_deletion` signal.
  const live = buildLiveRows();
  const hydrated = buildHydratedRows().filter((r) => !(r.kind === 'tool_result' && (r.tool_call_id === 'c2' || (r.payload && r.payload.tool_call_id === 'c2'))));

  const reconciliation = reconcileTurnRows(live, hydrated);
  assert.equal(reconciliation.staleRows.length, 1, 'the unmatched provisional tool_result should be stale');
  assert.equal(reconciliation.staleRows[0].kind, 'tool_result', 'the stale row is the dropped tool_result');
});
