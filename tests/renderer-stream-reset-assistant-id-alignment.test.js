// Regression: post-reset assistant-shell id alignment between main and the
// renderer (2026-08-21).
//
// Incident: a DISCARDING stream reset (sidecar reason 'nudge_retry') left main
// and the renderer disagreeing about the message id of the post-reset text.
// Main does not move ctx.textSegmentIndex across a reset, so it persisted the
// iteration-2 text under the SAME index as before; the renderer's
// handleStreamReset blindly advanced its own counter (segmentIndex + 1) and
// streamed the live rows one index further along. The same text then painted
// twice — canonical row on main's index, live row on the renderer's — until
// terminal reconcile deleted two stale rows.
//
// Fix: main publishes `next_assistant_message_id` on the stream_reset payload
// and the renderer prefers it (falling back to the local counter when absent),
// latching the named segment index so subsequent deltas key the same id.
//
// The sibling suite tests/renderer-stream-reset-discard-scope.test.js covers
// what a reset ERASED (preserve_prior_segments / discard_scope). Both share
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


test('handleStreamReset keys post-reset text by main authoritative next_assistant_message_id, not segmentIndex + 1', async () => {
  const rig = makeRig();

  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'nudge_retry',
    // Main discarded the iteration-1 segment WITHOUT moving textSegmentIndex,
    // so it will persist the iteration-2 text under index 0 again.
    next_assistant_message_id: `assistant_${STREAM_ID}_seg0`,
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));

  const rows = rig.textRows();
  const postResetRows = rows.filter((row) => String(row.payload?.text || '').includes('TEXT_B'));
  assert.equal(postResetRows.length, 1, 'exactly one live row carries the post-reset text');
  assert.equal(
    postResetRows[0].primary_message_id,
    `assistant_${STREAM_ID}_seg0`,
    'the post-reset row is keyed by the id main will persist, not the renderer _seg1 guess',
  );
  assert.notEqual(postResetRows[0].primary_message_id, `assistant_${STREAM_ID}_seg1`);
  assert.equal(
    rig.streamSegmentState.get(STREAM_ID).segmentIndex,
    0,
    'segState follows the index the authoritative id names',
  );
  // The pre-reset row is a distinct row and still carries the discarded text,
  // stamped restarted by the reducer's unchanged truncation semantics.
  const preResetRows = rows.filter((row) => String(row.payload?.text || '').includes('TEXT_A'));
  assert.equal(preResetRows.length, 1);
  assert.equal(preResetRows[0].primary_message_id, `assistant_${STREAM_ID}`);
  assert.equal(preResetRows[0].payload.truncated, true, 'discarding resets still stamp "restarted"');
});

test('handleStreamReset honours a non-zero authoritative index instead of double-counting', async () => {
  const rig = makeRig();

  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
  // A preserved tool continuation hands over to index 1.
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'tool_continuation',
    next_assistant_message_id: `assistant_${STREAM_ID}_seg1`,
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));
  // A discarding reset then reuses index 1 (main never rewound it).
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'nudge_retry',
    next_assistant_message_id: `assistant_${STREAM_ID}_seg1`,
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_C', aggregate: 'TEXT_C' }));

  assert.equal(rig.streamSegmentState.get(STREAM_ID).segmentIndex, 1);
  const rows = rig.textRows();
  const postResetRows = rows.filter((row) => String(row.payload?.text || '').includes('TEXT_C'));
  assert.equal(postResetRows.length, 1);
  assert.equal(
    postResetRows[0].primary_message_id,
    `assistant_${STREAM_ID}_seg1`,
    'the second reset must not advance to _seg2 when main stayed on index 1',
  );
});

test('handleStreamReset without next_assistant_message_id keeps the legacy local counter', async () => {
  const rig = makeRig();

  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
  await rig.handlers.handleStreamReset(payload({ type: 'stream_reset', reason: 'nudge_retry' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));

  assert.equal(
    rig.streamSegmentState.get(STREAM_ID).segmentIndex,
    1,
    'an older main (no field) still advances the local counter',
  );
  const postResetRows = rig.textRows().filter((row) => String(row.payload?.text || '').includes('TEXT_B'));
  assert.equal(postResetRows.length, 1);
  assert.equal(postResetRows[0].primary_message_id, `assistant_${STREAM_ID}_seg1`);
});

// ---------------------------------------------------------------------------
// Wave 3b: the id alignment above is necessary but NOT sufficient — reconcile
// does not key assistant_text rows by message id. It keys them by
// segment_group_index (renderer-row-identity-utils.js buildRowIdentityKey), or
// by the deterministic row_id derived from it under
// chat_timeline_deterministic_row_id (DEFAULT ON). Main's discarding reset
// deletes every persisted text segment AND every captured
// assistant_text_segment / reasoning_phase turn event for the stream, so the
// hydrated projector (renderer-turn-row-projector.js) renumbers the surviving
// post-reset text as group index 0. The live reducer used to hand the
// post-reset row index 1, so at reconcile the canonical row (index 0, holding
// the POST-reset text) merged into the truncated PRE-reset row while the live
// index-1 row kept the same text — the double paint, cleared only at terminal
// with stale_row_deletion staleRowCount 2.
// ---------------------------------------------------------------------------

// Canonical events for the post-reset generation only: everything before the
// discarding reset was deleted by main, so this is what hydration sees.
function postResetCanonicalEvents(assistantMessageId, text) {
  return [
    {
      event_id: 'evt-reasoning-iter2',
      turn_id: STREAM_ID,
      kind: 'reasoning_phase',
      primary_message_id: assistantMessageId,
      phase_id: 'phase-iter2',
      status: 'completed',
      sort_key: [0, 0, 10],
      payload: { phase_id: 'phase-iter2', phase_kind: 'reasoning', entries: [{ id: 'r-iter2', text: 'second attempt' }] },
    },
    {
      event_id: 'evt-text-iter2',
      turn_id: STREAM_ID,
      kind: 'assistant_text_segment',
      primary_message_id: assistantMessageId,
      assistant_phase: 'final_answer',
      status: 'completed',
      sort_key: [1, 0, 20],
      payload: { segment_id: 'seg-iter2', text, segment_index: 0 },
    },
  ];
}

for (const deterministicRowId of [true, false]) {
  test(`discarding reset gives the post-reset row group index 0 and reconciles to ONE text row (deterministicRowId=${deterministicRowId})`, async () => {
    const rig = makeRig({ deterministicRowId });

    await rig.handlers.handleStarted(payload({ type: 'started' }));
    await rig.handlers.handleDelta(payload({
      type: 'delta',
      phaseId: 'phase-iter1',
      reasoning: { source: 'provider', entriesDelta: [{ id: 'r-iter1', text: 'first attempt' }] },
    }));
    await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
    await rig.handlers.handleStreamReset(payload({
      type: 'stream_reset',
      reason: 'nudge_retry',
      next_assistant_message_id: `assistant_${STREAM_ID}_seg0`,
    }));
    await rig.handlers.handleDelta(payload({
      type: 'delta',
      phaseId: 'phase-iter2',
      reasoning: { source: 'provider', entriesDelta: [{ id: 'r-iter2', text: 'second attempt' }] },
    }));
    await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));

    const rows = rig.textRows();
    assert.equal(rows.length, 2, 'the discarded row stays visible next to the new one');
    const discardedRow = rows[0];
    const liveRow = rows[1];

    // (a) the pre-reset row keeps its "restarted" marker but leaves the
    // canonical identity space; the post-reset row takes index 0.
    assert.equal(discardedRow.payload.text, 'TEXT_A');
    assert.equal(discardedRow.payload.truncated, true, 'EH-W5 marker survives the tombstone');
    assert.equal(discardedRow.discarded, true);
    assert.notEqual(textRowGroupIndex(discardedRow), 0, 'the discarded row must not sit at index 0');
    assert.equal(textRowGroupIndex(discardedRow), -1);
    assert.equal(liveRow.payload.text, 'TEXT_B');
    assert.equal(textRowGroupIndex(liveRow), 0);
    assert.equal(liveRow.payload.segment_group_index, 0);
    assert.equal(liveRow.discarded, undefined, 'the surviving row is not tombstoned');
    if (deterministicRowId) {
      assert.equal(liveRow.row_id, `row:assistant_text:${STREAM_ID}:0`);
      assert.notEqual(discardedRow.row_id, liveRow.row_id);
      assert.match(discardedRow.row_id, /:discarded$/);
    }

    // (b) reconcile the live rows against the REAL projector's hydrated rows.
    const hydratedRows = projectTurnRows(
      postResetCanonicalEvents(`assistant_${STREAM_ID}_seg0`, 'TEXT_B'),
      { deterministicRowId }
    );
    const hydratedTextRows = hydratedRows.filter((row) => row.kind === 'assistant_text');
    assert.equal(hydratedTextRows.length, 1);
    assert.equal(
      textRowGroupIndex(hydratedTextRows[0]),
      0,
      'the projector renumbers the surviving post-reset text as group 0',
    );

    const liveRows = rig.turn().rows;
    const { finalRows, staleRows } = reconcileTurnRows(liveRows, hydratedRows, { deterministicRowId });
    const finalTextRows = finalRows.filter((row) => row.kind === 'assistant_text');
    assert.equal(finalTextRows.length, 1, 'exactly ONE assistant_text row survives reconcile');
    assert.equal(finalTextRows[0].payload.text, 'TEXT_B');
    assert.equal(
      finalTextRows[0].row_id,
      liveRow.row_id,
      'the canonical row adopts the LIVE post-reset row_id so the DOM node is reused',
    );
    // The post-reset reasoning phase reconciles against its canonical twin, so
    // the ONLY stale rows are the two tombstoned iteration-1 rows.
    const finalReasoningRows = finalRows.filter((row) => row.kind === 'reasoning');
    assert.equal(finalReasoningRows.length, 1, 'exactly ONE reasoning row survives reconcile');
    assert.equal(finalReasoningRows[0].payload.entries[0].text, 'second attempt');
    const staleKinds = staleRows.map((row) => row.kind).sort();
    assert.deepEqual(staleKinds, ['assistant_text', 'reasoning'], 'only the discarded rows are stale');
    for (const row of staleRows) {
      assert.equal(row.discarded, true, 'every stale row is a tombstone, not a live row');
    }
    assert.equal(
      staleRows.find((row) => row.kind === 'assistant_text').payload.text,
      'TEXT_A',
      'the stale text row is the DISCARDED one, never the surviving answer',
    );
  });
}

test('tool_continuation reset keeps the existing segment numbering and tombstones nothing', async () => {
  const rig = makeRig({ deterministicRowId: true });

  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'tool_continuation',
    next_assistant_message_id: `assistant_${STREAM_ID}_seg1`,
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));

  const rows = rig.textRows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].payload.text, 'TEXT_A');
  assert.equal(textRowGroupIndex(rows[0]), 0, 'preserved commentary keeps index 0');
  assert.equal(rows[0].discarded, undefined, 'a preserve reset tombstones nothing');
  assert.notEqual(rows[0].payload.truncated, true, 'and carries no "restarted" marker');
  assert.equal(rows[0].row_id, `row:assistant_text:${STREAM_ID}:0`);
  assert.equal(textRowGroupIndex(rows[1]), 1, 'the continuation segment is index 1');
  assert.equal(rows[1].row_id, `row:assistant_text:${STREAM_ID}:1`);
});

test('tool_continuation seg0 then a nudge_retry discard renumbers the post-reset row to 0', async () => {
  // Main's case (b): the boundary persist consumed index 0 so main publishes
  // `_seg1`, but the discard deletes that persisted segment too — the surviving
  // count is 0, so the live post-reset row must land on group index 0.
  const rig = makeRig({ deterministicRowId: true });

  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_A', aggregate: 'TEXT_A' }));
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'tool_continuation',
    next_assistant_message_id: `assistant_${STREAM_ID}_seg1`,
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_B', aggregate: 'TEXT_B' }));
  await rig.handlers.handleStreamReset(payload({
    type: 'stream_reset',
    reason: 'nudge_retry',
    next_assistant_message_id: `assistant_${STREAM_ID}_seg1`,
  }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'TEXT_C', aggregate: 'TEXT_C' }));

  const rows = rig.textRows();
  assert.equal(rows.length, 3);
  assert.equal(rows[2].payload.text, 'TEXT_C');
  assert.equal(textRowGroupIndex(rows[2]), 0, 'the post-reset row is the first SURVIVING segment');
  assert.equal(rows[2].row_id, `row:assistant_text:${STREAM_ID}:0`);
  // Both earlier rows were erased by main's discard, so both must leave the
  // canonical space — and take DISTINCT tombstone identities.
  assert.equal(rows[0].discarded, true);
  assert.equal(rows[1].discarded, true);
  const tombstoneIndexes = [textRowGroupIndex(rows[0]), textRowGroupIndex(rows[1])];
  assert.deepEqual(tombstoneIndexes, [-1, -2], 'each tombstone gets its own non-canonical index');
  assert.notEqual(rows[0].row_id, rows[1].row_id);
});

