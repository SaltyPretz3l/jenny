// Regression: what a chat.stream_reset ERASED, and the row bookkeeping that
// has to mirror it (2026-08-21).
//
// `reason` alone cannot tell the renderer what a reset erased. Main's branch
// (services/backend/chat-stream-managed-runtime-notifications.js) decides three
// different things under two reasons:
//   * tool_continuation preserves ONLY when service.featureFlags
//     .response_loop_display_v2 is true — with the flag off it discards the
//     persisted segments AND every captured assistant_text_segment /
//     reasoning_phase for the turn;
//   * model_winddown keeps its persisted segments but drops the captured events
//     of the unsaved live slice (scoped to assistantBaseMessageId), and its
//     textSegmentIndex has NOT advanced, so next_assistant_message_id comes
//     back EQUAL to the id of the row that is streaming right now.
// So main publishes its own decision as `preserve_prior_segments` and
// `discard_scope` ('all' | 'live_slice' | 'none') and the reducer mirrors it.
//
// Sibling suite: tests/renderer-stream-reset-assistant-id-alignment.test.js
// (the post-reset id itself). Both share
// tests/helpers/renderer-stream-reset-rig.js.
//
// Static-literal requires (source->test existence gate walks this graph):
const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcileTurnRows } = require('../renderer/chat/renderer-turn-reducer');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const {
  STREAM_ID,
  makeRig,
  payload,
  textRowGroupIndex,
} = require('./helpers/renderer-stream-reset-rig');


// Canonical events for the surviving generation after a model_winddown: the
// pre-tool segment main persisted at the boundary (group 0) and the wind-down
// answer (group 1). The unsaved live slice between them is gone — main dropped
// its captured events, scoped to the base message id.
function windDownCanonicalEvents(preToolId, windDownId) {
  return [
    {
      event_id: 'evt-text-pre-tool',
      turn_id: STREAM_ID,
      kind: 'assistant_text_segment',
      primary_message_id: preToolId,
      assistant_phase: 'final_answer',
      status: 'completed',
      sort_key: [0, 0, 10],
      payload: { segment_id: 'seg-pre-tool', text: 'PRE_TOOL', segment_index: 0 },
    },
    {
      event_id: 'evt-text-winddown',
      turn_id: STREAM_ID,
      kind: 'assistant_text_segment',
      primary_message_id: windDownId,
      assistant_phase: 'final_answer',
      status: 'completed',
      sort_key: [1, 0, 20],
      payload: { segment_id: 'seg-winddown', text: 'FINAL_ANSWER', segment_index: 0 },
    },
  ];
}

test('model_winddown after a tool boundary opens a FRESH row even though main hands back the SAME assistant id', async () => {
  // B1. main's textSegmentIndex has NOT advanced when the cycle hint fires
  // (tool_loop_calls.py emits model_winddown exactly when visible text exists),
  // so next_assistant_message_id equals the id of the row currently streaming.
  // Nothing in the id path can notice a "change" — the reducer has to take the
  // erased slice out of the row lookup, or the wind-down answer appends into
  // the abandoned row.
  const rig = makeRig({ deterministicRowId: true });
  const seg1Id = `assistant_${STREAM_ID}_seg1`;

  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'PRE_TOOL', aggregate: 'PRE_TOOL' }));
  await rig.crossToolBoundary('call-winddown');
  // The boundary persisted the commentary (index 0 consumed) and main hands
  // over to index 1 with nothing erased.
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'tool_continuation',
    next_assistant_message_id: seg1Id,
    preserve_prior_segments: true,
    discard_scope: 'none',
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'POST_TOOL', aggregate: 'PRE_TOOLPOST_TOOL' }));
  // Cycle hint: the unsaved live slice is erased, the persisted segment stays,
  // and the SAME id comes back.
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'model_winddown',
    next_assistant_message_id: seg1Id,
    preserve_prior_segments: true,
    discard_scope: 'live_slice',
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'FINAL_ANSWER', aggregate: 'FINAL_ANSWER' }));

  const rows = rig.textRows();
  assert.equal(rows.length, 3, 'the wind-down answer opens its own row, it does not append into the abandoned one');
  const [preToolRow, abandonedRow, windDownRow] = rows;

  assert.equal(preToolRow.payload.text, 'PRE_TOOL');
  assert.equal(preToolRow.discarded, undefined, 'the PERSISTED pre-tool segment survives a live_slice discard');
  assert.equal(textRowGroupIndex(preToolRow), 0);

  assert.equal(abandonedRow.payload.text, 'POST_TOOL', 'the abandoned slice keeps only its own text');
  assert.equal(abandonedRow.discarded, true, 'the erased live slice is tombstoned');
  assert.equal(abandonedRow.payload.truncated, true, 'and keeps the "restarted" marker');
  assert.equal(textRowGroupIndex(abandonedRow), -1, 'out of the canonical index space');
  assert.match(abandonedRow.row_id, /:discarded$/);

  assert.equal(windDownRow.payload.text, 'FINAL_ANSWER');
  assert.equal(windDownRow.primary_message_id, seg1Id, 'keyed by the main authoritative id, which repeats here');
  assert.equal(textRowGroupIndex(windDownRow), 1, 'it is the SECOND surviving segment, after the persisted one');
  assert.equal(windDownRow.row_id, `row:assistant_text:${STREAM_ID}:1`);
  assert.notEqual(windDownRow.row_id, abandonedRow.row_id);

  // Reconcile against the REAL projector output for what main kept.
  const hydratedRows = projectTurnRows(
    windDownCanonicalEvents(`assistant_${STREAM_ID}_seg0`, seg1Id),
    { deterministicRowId: true }
  );
  const hydratedTextRows = hydratedRows.filter((row) => row.kind === 'assistant_text');
  assert.deepEqual(
    hydratedTextRows.map(textRowGroupIndex),
    [0, 1],
    'the projector numbers the two SURVIVING persisted segments 0 and 1',
  );

  const { finalRows, staleRows } = reconcileTurnRows(rig.turn().rows, hydratedRows, { deterministicRowId: true });
  const finalTextRows = finalRows.filter((row) => row.kind === 'assistant_text');
  assert.deepEqual(
    finalTextRows.map((row) => row.payload.text),
    ['PRE_TOOL', 'FINAL_ANSWER'],
    'exactly the two real text rows survive reconcile, in order',
  );
  assert.deepEqual(
    finalTextRows.map((row) => row.row_id),
    [preToolRow.row_id, windDownRow.row_id],
    'both canonical rows adopt their LIVE row ids so the painted nodes are reused',
  );
  const staleTextRows = staleRows.filter((row) => row.kind === 'assistant_text');
  assert.equal(staleTextRows.length, 1);
  assert.equal(staleTextRows[0].payload.text, 'POST_TOOL', 'only the abandoned slice is stale');
});

test('tool_continuation with preserve_prior_segments:false (display flag off) is treated as a full discard', async () => {
  // S3. Main preserves a tool_continuation reset ONLY when
  // response_loop_display_v2 is on; with the flag off it discards the persisted
  // segments AND the captured events under that very same reason. A reducer
  // that trusted `reason` kept the live rows numbered while the projector
  // renumbered from 0 — the double paint again.
  const rig = makeRig({ deterministicRowId: true });

  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'tool_continuation',
    next_assistant_message_id: `assistant_${STREAM_ID}_seg0`,
    preserve_prior_segments: false,
    discard_scope: 'all',
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));

  const rows = rig.textRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].payload.text, 'TEXT_A');
  assert.equal(rows[0].discarded, true, 'the flag-off tool_continuation tombstones like any discard');
  assert.equal(rows[0].payload.truncated, true, 'text main erased carries the "restarted" marker');
  assert.equal(textRowGroupIndex(rows[0]), -1);
  assert.equal(rows[1].payload.text, 'TEXT_B');
  assert.equal(textRowGroupIndex(rows[1]), 0, 'numbering restarts at 0, matching the projector');
  assert.equal(rows[1].row_id, `row:assistant_text:${STREAM_ID}:0`);

  // And the flag-ON spelling of the same reason still preserves.
  const preserving = makeRig({ deterministicRowId: true });
  await preserving.handlers.handleStarted(payload({ type: 'started' }));
  await preserving.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
  await preserving.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'tool_continuation',
    next_assistant_message_id: `assistant_${STREAM_ID}_seg1`,
    preserve_prior_segments: true,
    discard_scope: 'none',
  }));
  await preserving.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));
  const preservedRows = preserving.textRows();
  assert.equal(preservedRows[0].discarded, undefined);
  assert.notEqual(preservedRows[0].payload.truncated, true);
  assert.deepEqual(preservedRows.map(textRowGroupIndex), [0, 1]);
});

test('a tool boundary clears the reset id latch, so the next segment is not keyed by the previous id', async () => {
  // S1. The latch used to be matched against segState.segmentIndex, which the
  // tool handler bumps at every boundary without clearing the latch: asking for
  // the NEW index handed back the PREVIOUS segment's id, and the post-tool text
  // merged into the pre-tool row.
  const rig = makeRig({ deterministicRowId: true });

  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'nudge_retry',
    next_assistant_message_id: `assistant_${STREAM_ID}_seg0`,
    preserve_prior_segments: false,
    discard_scope: 'all',
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));
  assert.equal(
    rig.buildAssistantShellMessageId(STREAM_ID, 0),
    `assistant_${STREAM_ID}_seg0`,
    'the latch still answers for the index it names (main spells 0 as _seg0)',
  );

  await rig.crossToolBoundary('call-latch');
  assert.equal(rig.streamSegmentState.get(STREAM_ID).segmentIndex, 1, 'the boundary opened segment 1');
  assert.equal(
    rig.buildAssistantShellMessageId(STREAM_ID, 1),
    `assistant_${STREAM_ID}_seg1`,
    'the latched _seg0 id must NOT be returned for segment 1',
  );

  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_C', aggregate: 'TEXT_BTEXT_C' }));
  const liveRows = rig.textRows().filter((row) => row.discarded !== true);
  assert.deepEqual(
    liveRows.map((row) => row.payload.text),
    ['TEXT_B', 'TEXT_C'],
    'post-tool text opens its own row instead of merging into the pre-tool row',
  );
  assert.deepEqual(
    liveRows.map((row) => row.primary_message_id),
    [`assistant_${STREAM_ID}_seg0`, `assistant_${STREAM_ID}_seg1`],
  );
});

test('reconcile never re-adopts a tombstoned row through the drift-recovery second pass', () => {
  // N2. The second pass pairs leftover provisional rows with unmatched hydrated
  // rows of the same kind, to recover an identity drift without a DOM blink. A
  // tombstoned row was deliberately taken OUT of the identity space because
  // main erased its content — pairing it would hand the erased row the
  // canonical text and paint that text twice.
  const tombstone = {
    row_id: `row:assistant_text:${STREAM_ID}:0:discarded`,
    turn_id: STREAM_ID,
    kind: 'assistant_text',
    primary_message_id: `assistant_${STREAM_ID}`,
    segment_group_index: -1,
    discarded: true,
    payload: { text: 'ERASED', segment_group_index: -1, truncated: true, discarded: true },
  };
  const hydratedRows = [{
    row_id: `row:assistant_text:${STREAM_ID}:0`,
    turn_id: STREAM_ID,
    kind: 'assistant_text',
    primary_message_id: `assistant_${STREAM_ID}_seg0`,
    segment_group_index: 0,
    payload: { text: 'SURVIVOR', segment_group_index: 0 },
  }];

  const { finalRows, staleRows, secondPassMatches } = reconcileTurnRows(
    [tombstone],
    hydratedRows,
    { deterministicRowId: true }
  );
  assert.deepEqual(secondPassMatches, [], 'a tombstone is not a drift to recover');
  assert.equal(finalRows.length, 1);
  assert.equal(finalRows[0].payload.text, 'SURVIVOR');
  assert.equal(
    finalRows[0].row_id,
    `row:assistant_text:${STREAM_ID}:0`,
    'the canonical row keeps its own id instead of adopting the tombstone id',
  );
  assert.deepEqual(staleRows.map((row) => row.row_id), [tombstone.row_id]);
});
