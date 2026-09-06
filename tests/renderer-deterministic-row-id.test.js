/*
 * Deterministic row_id acceptance (DC1 flicker cure —
 * chat_timeline_deterministic_row_id).
 *
 * The structural cure: the live reducer and the hydrated projector stamp the
 * SAME deterministic identity-tuple row_id (one shared definition in
 * renderer-row-identity-utils.js), so the same logical row keeps one DOM
 * data-row-id across the live -> reconciled -> canonical handoffs — no blink.
 *
 * These are all flag-ON, threaded via the module options (createTurnReducerState
 * / projectTurnRows / projectTurn / reconcileTurnRows). The flag-OFF byte-
 * identity is guarded by the timeline-replay corpus + the reducer/projector
 * suites, which call these APIs with no options.
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows, projectTurn } = require('../renderer/chat/renderer-turn-row-projector');
const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
  reconcileTurnRows,
  buildRowIdentityKey,
  deriveDeterministicRowId,
} = require('../renderer/chat/renderer-turn-reducer');
const {
  deriveDeterministicRowId: sharedDerive,
  stampDeterministicRowId,
  stampDeterministicRowIds,
} = require('../renderer/chat/renderer-row-identity-utils');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'timeline-replay');
const SMOKE_SCENARIOS = Object.freeze([
  '07-tool-use-error-invalid-args',
  '18-stream-events-tool-call-trace',
  '20-plan-proposal',
  '22-approval-pending',
  '23-approval-pending-status-mismatch',
  '24-settled-tool-no-assistant-text',
]);
const DETERMINISTIC_KINDS = new Set(['reasoning', 'assistant_text', 'tool_call', 'tool_result', 'approval_gap']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---- deriveDeterministicRowId (the shared identity tuple) ----

test('deriveDeterministicRowId anchors each DC1 kind on its stable tuple', () => {
  assert.equal(
    deriveDeterministicRowId({ kind: 'reasoning', turn_id: 't', payload: { thinking_id: 'th1', phase_id: 'ph1' } }, 'row:e1'),
    'row:reasoning:t:ph1',
    'reasoning prefers the phase identity when available'
  );
  assert.equal(
    deriveDeterministicRowId({ kind: 'reasoning', turn_id: 't', phase_id: 'ph1', payload: {} }, 'row:e1'),
    'row:reasoning:t:ph1',
    'reasoning falls back to phase_id when thinking_id absent'
  );
  assert.equal(
    deriveDeterministicRowId({ kind: 'assistant_text', turn_id: 't', segment_group_index: 2, payload: {} }, 'row:e1'),
    'row:assistant_text:t:2'
  );
  assert.equal(
    deriveDeterministicRowId({ kind: 'assistant_text', turn_id: 't', segment_group_index: 0, payload: {} }, 'row:e1'),
    'row:assistant_text:t:0',
    'segment_group_index 0 is a real index, not a missing tuple'
  );
  assert.equal(
    deriveDeterministicRowId({ kind: 'tool_call', turn_id: 't', tool_call_id: 'c9', payload: {} }, 'row:e1'),
    'row:tool_call:t:c9'
  );
  assert.equal(
    deriveDeterministicRowId({ kind: 'tool_result', turn_id: 't', payload: { tool_call_id: 'c9' } }, 'row:e1'),
    'row:tool_result:t:c9'
  );
  assert.equal(
    deriveDeterministicRowId({ kind: 'approval_gap', turn_id: 't', tool_call_id: 'c9', payload: {} }, 'row:e1'),
    'row:approval_gap:t:c9'
  );
});

test('deriveDeterministicRowId returns the fallback id when the keyed tuple field is missing', () => {
  // A DC1 kind with an empty keyed field keeps its provisional id (never lose an
  // id — the event.row_id / row:${event_id} seam).
  assert.equal(deriveDeterministicRowId({ kind: 'reasoning', turn_id: 't', payload: {} }, 'row:e1'), 'row:e1');
  assert.equal(deriveDeterministicRowId({ kind: 'tool_call', turn_id: 't', payload: {} }, 'row:e1'), 'row:e1');
  assert.equal(deriveDeterministicRowId({ kind: 'assistant_text', turn_id: 't', payload: {} }, 'row:e1'), 'row:e1');
});

test('deriveDeterministicRowId leaves non-DC1 kinds on their fallback id (byte-identical for them)', () => {
  assert.equal(deriveDeterministicRowId({ kind: 'user_bubble', turn_id: 't', primary_message_id: 'm1', payload: {} }, 'row:e1'), 'row:e1');
  assert.equal(deriveDeterministicRowId({ kind: 'system_notice', turn_id: 't', payload: { subkind: 'x' } }, 'row:e1'), 'row:e1');
  assert.equal(deriveDeterministicRowId({ kind: 'batch', turn_id: 't', primary_message_id: 'm1', payload: {} }, 'row:e1'), 'row:e1');
});

test('the reducer re-exports the shared deriveDeterministicRowId (one definition)', () => {
  assert.equal(deriveDeterministicRowId, sharedDerive, 'reducer must re-export the shared function, not a copy');
});

test('stampDeterministicRowId is a no-op unless enabled === true', () => {
  const row = { kind: 'tool_call', turn_id: 't', tool_call_id: 'c1', row_id: 'row:e1', payload: {} };
  stampDeterministicRowId(row, false);
  assert.equal(row.row_id, 'row:e1', 'disabled => unchanged');
  stampDeterministicRowId(row, true);
  assert.equal(row.row_id, 'row:tool_call:t:c1', 'enabled => stamped');
});

test('stampDeterministicRowIds disambiguates in-turn collisions (approval-resume reuses a reasoning anchor)', () => {
  // Two reasoning rows in one turn sharing a thinking_id — the documented
  // approval-resume case where the backend reuses (phase_id, thinking_id). The
  // first keeps the bare id (so it still matches the single live-reducer row in
  // reconcile's first pass); the second gets a deterministic `#N` suffix so the
  // two never share a DOM data-row-id.
  const rows = [
    { kind: 'reasoning', turn_id: 't', row_id: 'row:r1', payload: { thinking_id: 'th_dup' } },
    { kind: 'tool_call', turn_id: 't', tool_call_id: 'c1', row_id: 'row:u1', payload: {} },
    { kind: 'reasoning', turn_id: 't', row_id: 'row:r2', payload: { thinking_id: 'th_dup' } },
  ];
  stampDeterministicRowIds(rows, true);
  assert.equal(rows[0].row_id, 'row:reasoning:t:th_dup', 'first occurrence keeps the bare id');
  assert.equal(rows[1].row_id, 'row:tool_call:t:c1', 'non-colliding row is unaffected');
  assert.equal(rows[2].row_id, 'row:reasoning:t:th_dup#1', 'colliding sibling is suffixed');
  assert.equal(new Set(rows.map((r) => r.row_id)).size, rows.length, 'all row_ids are unique');
  // Idempotent: re-stamping recomputes the same base ids and suffixes.
  const before = rows.map((r) => r.row_id);
  stampDeterministicRowIds(rows, true);
  assert.deepEqual(rows.map((r) => r.row_id), before, 're-stamping is stable');
});

test('stampDeterministicRowIds is a no-op (byte-identical) unless enabled === true', () => {
  const rows = [
    { kind: 'reasoning', turn_id: 't', row_id: 'row:r1', payload: { thinking_id: 'th_dup' } },
    { kind: 'reasoning', turn_id: 't', row_id: 'row:r2', payload: { thinking_id: 'th_dup' } },
  ];
  stampDeterministicRowIds(rows, false);
  assert.deepEqual(rows.map((r) => r.row_id), ['row:r1', 'row:r2'], 'disabled => untouched (collisions and all)');
});

// ---- buildRowIdentityKey ----

test('buildRowIdentityKey returns row_id under flag-on and the legacy tuple key otherwise', () => {
  const row = { kind: 'reasoning', turn_id: 't', phase_id: 'ph1', row_id: 'row:reasoning:t:th1', payload: { phase_id: 'ph1', thinking_id: 'th1' } };
  assert.equal(buildRowIdentityKey(row, { deterministicRowId: true }), 'row:reasoning:t:th1');
  assert.equal(buildRowIdentityKey(row), 'reasoning|t|ph1', 'flag-off keeps the slice-scoped phase_id key');
});

// ---- projector: flag-off byte-identical, flag-on deterministic ----

function reasoningToolTurnEvents() {
  const T = 'turn_proj';
  const A = 'assist_proj';
  return [
    { event_id: 'r1', turn_id: T, kind: 'reasoning_phase', primary_message_id: A, source_message_ids: [A], phase_id: 'phase_x', status: 'completed', sort_key: [1, 0, 0], payload: { phase_id: 'phase_x', thinking_id: 'th_x', entries: [{ text: 'hmm' }] } },
    { event_id: 'u1', turn_id: T, kind: 'tool_use', status: 'running', primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1'], tool_call_id: 'c1', sort_key: [2, 0, 0], payload: { tool_name: 'Read', input: {}, input_json: '{}', summary: 'read' } },
    { event_id: 'x1', turn_id: T, kind: 'tool_result', status: 'completed', primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1', 'tool_result_c1'], tool_call_id: 'c1', sort_key: [2, 1, 0], payload: { tool_name: 'Read', content: 'ok', is_error: false } },
    { event_id: 't1', turn_id: T, kind: 'assistant_text_segment', primary_message_id: A, source_message_ids: [A], assistant_phase: 'final_answer', sort_key: [9, 0, 30], payload: { text: 'Done', assistant_phase: 'final_answer', segment_id: `${A}_seg_0` } },
  ];
}

test('projectTurnRows: flag-off keeps row:${event_id}; flag-on stamps deterministic ids for DC1 kinds only', () => {
  const events = reasoningToolTurnEvents();
  const off = projectTurnRows(events);
  const offExplicit = projectTurnRows(events, { deterministicRowId: false });
  const on = projectTurnRows(events, { deterministicRowId: true });

  assert.deepEqual(toPlainJson(off), toPlainJson(offExplicit), 'explicit false === omitted (byte-identical)');
  assert.deepEqual(off.map((r) => r.kind), on.map((r) => r.kind), 'structure unchanged by the flag');

  const byKindOff = new Map(off.map((r) => [r.kind, r]));
  const byKindOn = new Map(on.map((r) => [r.kind, r]));
  assert.match(byKindOn.get('reasoning').row_id, /^row:reasoning:turn_proj:phase_x$/);
  assert.match(byKindOn.get('tool_call').row_id, /^row:tool_call:turn_proj:c1$/);
  assert.match(byKindOn.get('tool_result').row_id, /^row:tool_result:turn_proj:c1$/);
  assert.match(byKindOn.get('assistant_text').row_id, /^row:assistant_text:turn_proj:0$/);
  // Flag-off form is the raw event id for every DC1 kind.
  assert.match(byKindOff.get('reasoning').row_id, /^row:r1$/);
  // projectTurn threads the flag identically to projectTurnRows.
  const viaProjectTurn = projectTurn({ turn_id: 'turn_proj', events }, { deterministicRowId: true }).rows;
  assert.deepEqual(viaProjectTurn.map((r) => r.row_id), on.map((r) => r.row_id));
});

test('projectTurnRows deterministic ids are idempotent across repeated projection (no repaint drift)', () => {
  const events = reasoningToolTurnEvents();
  const first = projectTurnRows(events, { deterministicRowId: true }).map((r) => r.row_id);
  const second = projectTurnRows(events, { deterministicRowId: true }).map((r) => r.row_id);
  assert.deepEqual(first, second, 'projecting the same events twice yields identical row_ids');
});

// A turn whose backend reuses one (phase_id, thinking_id) across a tool call —
// the approval-resume case (canonical-turn-event-collector reasoning
// mis-retargeting RCA). The projector groups reasoning by CONTIGUOUS phase_id,
// so the tool call between the two phases splits them into two reasoning rows
// that both anchor on the shared thinking_id. Without de-dup they would share a
// DOM data-row-id under flag-on (the exact blink DC1 cures, reintroduced).
function reusedReasoningTurnEvents() {
  const T = 'turn_reuse';
  const A = 'assist_reuse';
  return [
    { event_id: 'r1', turn_id: T, kind: 'reasoning_phase', primary_message_id: A, source_message_ids: [A], phase_id: 'phase_x', status: 'completed', sort_key: [1, 0, 0], payload: { phase_id: 'phase_x', thinking_id: 'th_reuse', entries: [{ text: 'first' }] } },
    { event_id: 'u1', turn_id: T, kind: 'tool_use', status: 'running', primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1'], tool_call_id: 'c1', sort_key: [2, 0, 0], payload: { tool_name: 'Read', input: {}, input_json: '{}', summary: 'read' } },
    { event_id: 'x1', turn_id: T, kind: 'tool_result', status: 'completed', primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1', 'tool_result_c1'], tool_call_id: 'c1', sort_key: [2, 1, 0], payload: { tool_name: 'Read', content: 'ok', is_error: false } },
    { event_id: 'r2', turn_id: T, kind: 'reasoning_phase', primary_message_id: A, source_message_ids: [A], phase_id: 'phase_x', status: 'completed', sort_key: [3, 0, 0], payload: { phase_id: 'phase_x', thinking_id: 'th_reuse', entries: [{ text: 'second' }] } },
    { event_id: 't1', turn_id: T, kind: 'assistant_text_segment', primary_message_id: A, source_message_ids: [A], assistant_phase: 'final_answer', sort_key: [9, 0, 30], payload: { text: 'Done', assistant_phase: 'final_answer', segment_id: `${A}_seg_0` } },
  ];
}

test('projectTurnRows: reused-thinking_id reasoning rows get distinct row_ids under flag-on (no duplicate DOM key)', () => {
  const events = reusedReasoningTurnEvents();
  const on = projectTurnRows(events, { deterministicRowId: true });
  const reasoning = on.filter((r) => r.kind === 'reasoning');
  assert.equal(reasoning.length, 2, 'the tool call splits the reused phase into two reasoning rows');
  assert.equal(reasoning[0].row_id, 'row:reasoning:turn_reuse:phase_x', 'first keeps the bare anchor (matches the live row)');
  assert.equal(reasoning[1].row_id, 'row:reasoning:turn_reuse:phase_x#1', 'the sibling is deterministically disambiguated');
  // The load-bearing invariant: no two rows in a turn share a row_id under flag-on.
  const ids = on.map((r) => r.row_id);
  assert.equal(new Set(ids).size, ids.length, 'every row_id in the turn is unique');
  // Flag-off is unchanged: distinct raw event ids, no suffixing.
  const off = projectTurnRows(events);
  const offReasoning = off.filter((r) => r.kind === 'reasoning').map((r) => r.row_id);
  assert.deepEqual(offReasoning, ['row:r1', 'row:r2'], 'flag-off keeps raw event ids (byte-identical)');
});

// ---- cross-path equality: live reducer vs hydrated projector ----

test('cross-path: live reducer rows and hydrated projector rows share the same deterministic row_id per logical row', () => {
  const T = 'turn_xp';
  const A = 'assist_xp';
  // Live path.
  const state = createTurnReducerState({ deterministicRowId: true });
  let ordinal = 0;
  const apply = (payload, ctx = {}) => applyTurnStreamEvent(state, buildTurnEventFromStreamPayload(payload, {
    turn_id: T, primary_user_message_id: 'user_xp', primary_assistant_message_id: A, ordinal: ordinal += 1, ...ctx,
  }));
  apply({ type: 'started', streamId: T });
  apply({
    type: 'delta',
    streamId: T,
    phaseId: 'phase_sidecar',
    phaseKind: 'reasoning',
    thinkingId: 'th_shared',
    phase: { phase_id: 'phase_sidecar', phase_kind: 'reasoning', thinking_id: 'th_shared' },
    reasoning: { entriesDelta: [{ text: 'think' }] },
  });
  apply({ type: 'tool_use', streamId: T, callId: 'c1', toolName: 'Read', status: 'running', summary: 'r' }, { primary_tool_message_id: 'tool_use_c1' });
  apply({ type: 'tool_result', streamId: T, callId: 'c1', toolName: 'Read', content: 'ok', isError: false, approvalState: 'auto' }, { tool_result_message_id: 'tool_result_c1' });
  apply({ type: 'delta', streamId: T, content: 'Done.' }, { segment_text: 'Done.', segment_index: 0, assistant_phase: 'final_answer' });
  const liveRows = state.turns_by_id[T].rows;

  // Hydrated path — same logical turn, persisted shape (sidecar phase_id drifts,
  // thinking_id shared).
  const persisted = [
    { event_id: 'e:r', turn_id: T, kind: 'reasoning_phase', primary_message_id: A, source_message_ids: [A], phase_id: 'phase_sidecar', status: 'completed', sort_key: [1, 0, 0], payload: { phase_id: 'phase_sidecar', thinking_id: 'th_shared', entries: [{ text: 'think' }] } },
    { event_id: 'e:u', turn_id: T, kind: 'tool_use', status: 'running', primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1'], tool_call_id: 'c1', sort_key: [2, 0, 0], payload: { tool_name: 'Read', input: {}, input_json: '{}', summary: 'r' } },
    { event_id: 'e:x', turn_id: T, kind: 'tool_result', status: 'completed', primary_message_id: 'tool_use_c1', source_message_ids: ['tool_use_c1', 'tool_result_c1'], tool_call_id: 'c1', sort_key: [2, 1, 0], payload: { tool_name: 'Read', content: 'ok', is_error: false } },
    { event_id: 'e:t', turn_id: T, kind: 'assistant_text_segment', primary_message_id: A, source_message_ids: [A], assistant_phase: 'final_answer', sort_key: [9, 0, 30], payload: { text: 'Done.', assistant_phase: 'final_answer', segment_id: `${A}_seg_0` } },
  ];
  const hydratedRows = projectTurnRows(persisted, { deterministicRowId: true });

  const liveById = new Map(liveRows.map((r) => [r.kind + '|' + (r.tool_call_id || r.payload.tool_call_id || r.segment_group_index || ''), r.row_id]));
  for (const h of hydratedRows) {
    if (!DETERMINISTIC_KINDS.has(h.kind)) continue;
    const key = h.kind + '|' + (h.tool_call_id || h.payload.tool_call_id || h.segment_group_index || '');
    assert.equal(liveById.get(key), h.row_id, `live and hydrated ${h.kind} must share row_id ${h.row_id}`);
  }

  // And the whole turn reconciles first-pass with zero stale / zero second-pass.
  const reconciliation = reconcileTurnRows(liveRows, hydratedRows, { deterministicRowId: true });
  assert.equal(reconciliation.staleRows.length, 0);
  assert.deepEqual(reconciliation.secondPassMatches, []);
});

// ---- stream-event scenario smoke (flag-on) ----

for (const scenario of SMOKE_SCENARIOS) {
  test(`flag-on smoke: scenario ${scenario} projects deterministic ids and (when live) reconciles first-pass`, () => {
    const dir = path.join(FIXTURE_ROOT, scenario);
    const session = normalizeChatMessages(readJson(path.join(dir, 'session.json')));
    const tree = projectTurnTree({ messages: session });

    for (const turn of tree.turns) {
      const off = projectTurnRows(turn.events);
      const on = projectTurnRows(turn.events, { deterministicRowId: true });
      assert.deepEqual(on.map((r) => r.kind), off.map((r) => r.kind), 'flag-on preserves row structure');
      for (let i = 0; i < on.length; i += 1) {
        const row = on[i];
        if (DETERMINISTIC_KINDS.has(row.kind)) {
          // Either a deterministic id (row:<kind>:<turn>:<anchor>) or, when the
          // tuple field is genuinely absent, the fallback event id.
          const anchored = new RegExp(`^row:${row.kind}:`).test(row.row_id);
          assert.ok(anchored || row.row_id === off[i].row_id, `${scenario} ${row.kind} row_id ${row.row_id} must be deterministic or fall back`);
        } else {
          assert.equal(row.row_id, off[i].row_id, `${scenario} non-DC1 ${row.kind} row_id must be byte-identical flag-on`);
        }
      }
    }

    const streamEventsPath = path.join(dir, 'stream-events.json');
    if (!fs.existsSync(streamEventsPath)) {
      return;
    }
    const streamEvents = readJson(streamEventsPath);
    if (!Array.isArray(streamEvents) || streamEvents.length === 0) {
      return;
    }
    const state = createTurnReducerState({ deterministicRowId: true });
    for (const entry of streamEvents) {
      const e = entry && typeof entry === 'object' ? entry : {};
      const payload = e.payload && typeof e.payload === 'object' ? e.payload : e;
      const context = e.context && typeof e.context === 'object' ? e.context : {};
      applyTurnStreamEvent(state, buildTurnEventFromStreamPayload(payload, context));
    }
    const first = streamEvents.find((e) => e && typeof e === 'object') || {};
    const turnId = String(first?.context?.turn_id || first?.payload?.streamId || first?.payload?.requestId || first?.payload?.request_id || '').trim();
    assert.ok(turnId, `${scenario}: stream-events must identify the replay turn`);
    const provisionalRows = state.turns_by_id[turnId]?.rows || [];
    const hydratedTurn = tree.turns.find((t) => String(t.turn_id) === turnId);
    assert.ok(hydratedTurn, `${scenario}: expected a hydrated turn ${turnId}`);
    const hydratedRows = projectTurnRows(hydratedTurn.events, { deterministicRowId: true });

    const reconciliation = reconcileTurnRows(provisionalRows, hydratedRows, { deterministicRowId: true });
    assert.deepEqual(
      reconciliation.staleRows,
      [],
      `${scenario}: no provisional row may be stranded under the deterministic flag`
    );
    assert.deepEqual(
      reconciliation.secondPassMatches,
      [],
      `${scenario}: the deterministic first pass must match everything (second-pass net must not fire)`
    );
    assert.deepEqual(
      toPlainJson(reconciliation.finalRows),
      toPlainJson(hydratedRows),
      `${scenario}: reconciled rows equal the hydrated rows (shared deterministic ids)`
    );
  });
}
