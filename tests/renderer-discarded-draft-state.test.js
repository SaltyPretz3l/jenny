// "Draft discarded" fold state: a LIVE stream_reset that erased visible text
// stamps ONE anchor row (discard_anchor + reason + capped erased text) and
// hides the rest of that reset's rows (discard_hidden). Replayed resets (no
// `live` flag) tombstone as before but stamp nothing. Also guards the render
// index: tombstoned rows must not shadow the live post-reset row.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');
const { indexRowsByRenderMessageId } = require('../renderer/chat/renderer-render-message-index-utils');
const { STREAM_ID, makeRig, payload } = require('./helpers/renderer-stream-reset-rig');

const SID = 'stream-discard';
const BASE = `assistant_${SID}`;

function makeTurn() {
  const state = createTurnReducerState();
  let ordinal = 0;
  const apply = (body, context = {}, mutate) => {
    let events = buildTurnEventFromStreamPayload({ streamId: SID, ...body }, {
      turn_id: SID,
      primary_user_message_id: 'user_discard',
      primary_assistant_message_id: BASE,
      ordinal,
      ...context,
    });
    ordinal += 1;
    if (mutate) events = [].concat(events).map(mutate);
    applyTurnStreamEvent(state, events);
    return state.turns_by_id[SID];
  };
  return { apply, turn: () => state.turns_by_id[SID] };
}

const segId = (segmentIndex) => (segmentIndex ? `${BASE}_seg${segmentIndex}` : BASE);
const text = (segmentIndex, content) => [
  { type: 'delta', content, aggregate: content },
  { primary_assistant_message_id: segId(segmentIndex), segmentText: content, segmentIndex },
];
const reasoning = (segmentIndex, id, content) => [
  { type: 'delta', reasoning: { source: 'provider', entriesDelta: [{ id, text: content }] } },
  { primary_assistant_message_id: segId(segmentIndex), segmentIndex },
];
// fromIndex names the OUTGOING slice (the reset event's primary id).
const reset = (reason, fromIndex, nextIndex, extra = {}) => [
  { type: 'stream_reset', reason, ...extra },
  { primary_assistant_message_id: segId(fromIndex), next_assistant_message_id: segId(nextIndex) },
];
const rowsOf = (turn, kind) => turn.rows.filter((row) => row.kind === kind);

test('scope all folds every in-scope row into one anchor; earlier preserved commentary is hidden but counted', () => {
  const { apply, turn } = makeTurn();
  apply({ type: 'started' });
  apply(...text(0, 'COMMENTARY'));
  apply(...reset('tool_continuation', 0, 1));
  apply(...reasoning(1, 'r1', 'THINKING'));
  apply(...text(1, 'DRAFT'));
  apply(...reset('retry', 1, 2, { discard_scope: 'all' }));

  const rows = turn().rows.filter((row) => row.kind === 'assistant_text' || row.kind === 'reasoning');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.discarded === true));
  const anchors = rows.filter((row) => row.payload.discard_anchor === true);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0], rows[2], 'the LAST in-scope row anchors');
  assert.equal(anchors[0].payload.discard_reason, 'retry');
  assert.equal(anchors[0].payload.discard_text, 'COMMENTARY\n\nDRAFT');
  assert.equal(anchors[0].payload.discard_reasoning_text, 'THINKING');
  assert.equal(anchors[0].payload.discard_text_trimmed, undefined);
  assert.equal(rows[0].payload.discard_hidden, true);
  assert.equal(rows[1].payload.discard_hidden, true);
  assert.equal(anchors[0].payload.discard_hidden, undefined);
});

test('live_slice (model_winddown) anchors only the active slice and leaves earlier rows alone', () => {
  const { apply, turn } = makeTurn();
  apply({ type: 'started' });
  apply(...text(0, 'PRE_TOOL'));
  apply(...reset('tool_continuation', 0, 1));
  apply(...text(1, 'LIVE_SLICE'));
  apply(...reset('model_winddown', 1, 1, { discard_scope: 'live_slice' }));

  const [pre, slice] = rowsOf(turn(), 'assistant_text');
  assert.equal(pre.discarded, undefined);
  assert.equal(pre.payload.discard_hidden, undefined);
  assert.equal(pre.payload.discard_anchor, undefined);
  assert.equal(slice.payload.discard_anchor, true);
  assert.equal(slice.payload.discard_reason, 'model_winddown');
  assert.equal(slice.payload.discard_text, 'LIVE_SLICE');
});

test('scope none (tool_continuation) stamps no anchor and no hidden rows', () => {
  const { apply, turn } = makeTurn();
  apply({ type: 'started' });
  apply(...text(0, 'COMMENTARY'));
  apply(...reset('tool_continuation', 0, 1));
  const [row] = rowsOf(turn(), 'assistant_text');
  assert.equal(row.discarded, undefined);
  assert.equal(row.payload.discard_anchor, undefined);
  assert.equal(row.payload.discard_hidden, undefined);
});

test('a reset that erased no visible text stamps nothing', () => {
  const { apply, turn } = makeTurn();
  apply({ type: 'started' });
  apply(...text(0, '   '));
  apply(...reset('retry', 0, 1, { discard_scope: 'all' }));
  const rows = turn().rows.filter((row) => row.kind === 'assistant_text' || row.kind === 'reasoning');
  assert.ok(rows.every((row) => row.payload.discard_anchor === undefined && row.payload.discard_hidden === undefined));
});

test('two discarding resets each get their own anchor and post-reset rows stay live', () => {
  const { apply, turn } = makeTurn();
  apply({ type: 'started' });
  apply(...text(0, 'ONE'));
  apply(...reset('retry', 0, 1, { discard_scope: 'all' }));
  apply(...text(1, 'TWO'));
  apply(...reset('retry', 1, 2, { discard_scope: 'all' }));
  apply(...text(2, 'THREE'));

  const rows = rowsOf(turn(), 'assistant_text');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.discarded === true), [true, true, false]);
  assert.deepEqual(rows.map((row) => row.payload.discard_anchor === true), [true, true, false]);
  assert.equal(rows[0].payload.discard_text, 'ONE', 'a later reset does not restamp an earlier fold');
  assert.equal(rows[1].payload.discard_text, 'TWO');
  assert.equal(rows[0].payload.discard_hidden, undefined);
  assert.equal(rows[2].payload.discard_hidden, undefined);
  assert.equal(rows[2].payload.text, 'THREE');
});

test('erased text is capped at 4000 chars and flagged trimmed', () => {
  const { apply, turn } = makeTurn();
  apply({ type: 'started' });
  apply(...text(0, 'x'.repeat(4500)));
  apply(...reset('retry', 0, 1, { discard_scope: 'all' }));
  const [row] = rowsOf(turn(), 'assistant_text');
  assert.equal(row.payload.discard_text.length, 4000);
  assert.equal(row.payload.discard_text_trimmed, true);
});

test('a reset event without live:true (replay) tombstones but stamps no fold', () => {
  const { apply, turn } = makeTurn();
  apply({ type: 'started' });
  apply(...text(0, 'REPLAYED'));
  const [body, context] = reset('retry', 0, 1, { discard_scope: 'all' });
  apply(body, context, (event) => {
    assert.equal(event.live, true, 'the live translator marks its resets');
    const { live, ...replayed } = event;
    return replayed;
  });
  const [row] = rowsOf(turn(), 'assistant_text');
  assert.equal(row.discarded, true);
  assert.equal(row.payload.discard_anchor, undefined);
  assert.equal(row.payload.discard_hidden, undefined);
});

test('render index keeps the live post-reset row when tombstoned drafts share its message id', async () => {
  const rig = makeRig();
  await rig.handlers.handleStarted(payload({ type: 'started' }));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'DRAFT_A', aggregate: 'DRAFT_A' }));
  const resetPayload = {
    type: 'stream_reset',
    reason: 'model_winddown',
    next_assistant_message_id: `assistant_${STREAM_ID}`,
    preserve_prior_segments: false,
    discard_scope: 'all',
  };
  await rig.handlers.handleStreamReset(payload(resetPayload));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'DRAFT_B', aggregate: 'DRAFT_B' }));
  await rig.handlers.handleStreamReset(payload(resetPayload));
  await rig.handlers.handleDelta(payload({ type: 'delta', content: 'LIVE_ANSWER', aggregate: 'LIVE_ANSWER' }));

  const rows = rig.turn().rows;
  const texts = rows.filter((row) => row.kind === 'assistant_text');
  assert.equal(texts.length, 3);
  const live = texts.find((row) => row.payload.text === 'LIVE_ANSWER');
  assert.ok(live && live.discarded !== true);
  assert.ok(
    texts.filter((row) => row.discarded === true).every((row) => row.primary_message_id === live.primary_message_id),
    'scenario: tombstones share the live row message id',
  );

  const indexed = indexRowsByRenderMessageId(new Map([[STREAM_ID, rows]]));
  const indexedRows = [...indexed.values()].flat();
  assert.ok(indexedRows.includes(live), 'the live post-reset assistant_text row survives the index');
  assert.equal(
    indexedRows.filter((row) => row.kind === 'assistant_text').length,
    3,
    'discarded drafts stay indexed beside the live row',
  );
});

test('render index slots a discarded draft above a hydrated twin that already holds its message id', () => {
  const twin = { row_id: 'twin', kind: 'assistant_text', primary_message_id: 'm1', payload: { text: 'ANSWER' } };
  const discarded = {
    row_id: 'row:x:discarded', kind: 'assistant_text', primary_message_id: 'm1', discarded: true,
    payload: { text: 'DRAFT', discarded: true, discard_anchor: true },
  };
  const tool = { row_id: 'tool', kind: 'system_notice', primary_message_id: 'm1', payload: {} };
  const indexed = indexRowsByRenderMessageId(new Map([['hydrated', [twin, tool]], ['live', [discarded]]]));
  assert.deepEqual(indexed.get('m1').map((row) => row.row_id), ['row:x:discarded', 'twin', 'tool']);
});
