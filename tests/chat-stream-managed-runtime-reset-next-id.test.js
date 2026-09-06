// Sibling of tests/chat-stream-managed-runtime-notifications.test.js (that file
// sits at the file-size cap): the chat.stream_reset payload's
// `next_assistant_message_id` contract.
//
// Main is the authority for the id the post-reset text is persisted under. The
// renderer used to guess it as its OWN segmentIndex + 1, which drifts because a
// reset never moves ctx.textSegmentIndex — the same text then painted twice
// (canonical row on main's index, live row one index further along) until
// terminal reconcile deleted the stale rows.
//
// Static-literal requires (source->test existence gate walks this graph):
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
// Real segment persistence/discard, so the id oracles below compare the emitted
// next_assistant_message_id against the id a REAL persist mints.
const {
  persistCurrentTextSegment,
  discardPersistedTextSegmentsForReset,
} = require('../services/backend/chat-stream-managed-runtime-segments');
const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
} = require('./helpers/managed-runtime-notification-harness');

// Wires the recording harness to the REAL segment persist/discard functions so
// a test can drive a reset and then a persist and compare the two ids for real.
function makeSegmentAwareCtx() {
  const ctx = makeCtx();
  const appended = [];
  ctx.textSegmentIndex = 0;
  ctx.persistedTextSegmentIds = [];
  ctx.hasPersistedSegments = false;
  ctx.segmentPersistRefused = false;
  ctx.refusedTextSegments = [];
  ctx.reasoningTailBreakPending = false;
  ctx.reasoningRawTailText = '';
  ctx.appendedSegmentMessages = appended;
  ctx.adapter.appendMessage = (message) => {
    appended.push(message);
    // Mirror into the fake store so a discarding reset genuinely removes the
    // row instead of filtering an empty list.
    ctx.service.sessionStore.messages.push(message);
    return { id: message.id };
  };
  ctx.transcriptCollector.completeCurrentPhase = () => {};
  ctx.transcriptCollector.buildAssistantMessageFields = () => ({
    phases: [],
    visible_segments: [],
    tool_steps: [],
    reasoning: { source: 'none', entries: [] },
  });
  ctx.service.sessionStore = {
    messages: [],
    getSessionMessages() { return this.messages; },
    replaceMessages(_sessionId, next) { this.messages = next; },
  };
  ctx.persistCurrentTextSegment = (options) => persistCurrentTextSegment(ctx, options);
  ctx.discardPersistedTextSegmentsForReset = () => discardPersistedTextSegmentsForReset(ctx);
  return ctx;
}

function resetAndCapturePayload(ctx, reason) {
  const before = callsOf(ctx, 'emitChatStream').length;
  handleNotification(
    ctx,
    { method: 'chat.stream_reset', params: { reason } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
  );
  const emits = callsOf(ctx, 'emitChatStream');
  assert.equal(emits.length, before + 1, 'the reset emits exactly one control event');
  assert.equal(emits[before].payload.type, 'stream_reset');
  return emits[before].payload;
}

function resetAndCaptureNextId(ctx, reason) {
  return resetAndCapturePayload(ctx, reason).next_assistant_message_id;
}

test('chat.stream_reset reason=nudge_retry publishes the id the next persisted segment actually gets (first-iteration discard)', () => {
  const ctx = makeSegmentAwareCtx();
  ctx.assistantText = 'iteration one answer';
  ctx.currentSegmentText = 'iteration one answer';
  ctx.streamSawText = true;

  // Nothing was persisted before the reset, so textSegmentIndex is still 0.
  const publishedId = resetAndCaptureNextId(ctx, 'nudge_retry');
  assert.equal(publishedId, 'assistant_stream-1_seg0');
  assert.equal(ctx.textSegmentIndex, 0, 'a discarding reset does not move textSegmentIndex');

  ctx.currentSegmentText = 'iteration two answer';
  ctx.persistCurrentTextSegment({});

  assert.equal(ctx.appendedSegmentMessages.length, 1);
  assert.equal(ctx.appendedSegmentMessages[0].content, 'iteration two answer');
  assert.equal(
    ctx.appendedSegmentMessages[0].id,
    publishedId,
    'the published id must equal the id the post-reset segment is persisted under',
  );
});

test('chat.stream_reset reason=nudge_retry publishes the surviving index after earlier tool_continuation segments', () => {
  const ctx = makeSegmentAwareCtx();
  ctx.service.featureFlags.response_loop_display_v2 = true;

  // Iteration one persists a tool-boundary commentary segment => index 0 is
  // consumed and textSegmentIndex advances to 1.
  ctx.currentSegmentText = 'pre-tool commentary';
  ctx.persistCurrentTextSegment({ atToolBoundary: true });
  assert.deepEqual(ctx.persistedTextSegmentIds, ['assistant_stream-1_seg0']);
  assert.equal(ctx.textSegmentIndex, 1);

  ctx.currentSegmentText = 'iteration one answer';
  const publishedId = resetAndCaptureNextId(ctx, 'nudge_retry');

  // The discard deletes the persisted row but does NOT rewind the index, so
  // the next persist reuses index 1, not index 0.
  assert.deepEqual(ctx.persistedTextSegmentIds, []);
  assert.deepEqual(ctx.service.sessionStore.messages, [], 'the stale segment row is deleted');
  assert.equal(ctx.textSegmentIndex, 1);
  assert.equal(publishedId, 'assistant_stream-1_seg1');

  ctx.currentSegmentText = 'iteration two answer';
  ctx.persistCurrentTextSegment({});

  const lastAppended = ctx.appendedSegmentMessages[ctx.appendedSegmentMessages.length - 1];
  assert.equal(lastAppended.content, 'iteration two answer');
  assert.equal(lastAppended.id, publishedId);
});

test('chat.stream_reset reason=tool_continuation publishes the same id on the preserve path', () => {
  const ctx = makeSegmentAwareCtx();
  ctx.service.featureFlags.response_loop_display_v2 = true;

  ctx.currentSegmentText = 'pre-tool commentary';
  ctx.persistCurrentTextSegment({ atToolBoundary: true });
  assert.equal(ctx.textSegmentIndex, 1);
  ctx.hasPersistedSegments = true;

  const publishedId = resetAndCaptureNextId(ctx, 'tool_continuation');

  // Preserve path: the earlier segment survives and the index is untouched.
  assert.deepEqual(ctx.persistedTextSegmentIds, ['assistant_stream-1_seg0']);
  assert.deepEqual(
    ctx.service.sessionStore.messages.map((message) => message.id),
    ['assistant_stream-1_seg0'],
    'the preserve path keeps the earlier segment row',
  );
  assert.equal(publishedId, 'assistant_stream-1_seg1', 'the field is present and consistent on the preserve path too');

  ctx.currentSegmentText = 'post-tool answer';
  ctx.persistCurrentTextSegment({});

  const lastAppended = ctx.appendedSegmentMessages[ctx.appendedSegmentMessages.length - 1];
  assert.equal(lastAppended.content, 'post-tool answer');
  assert.equal(lastAppended.id, publishedId);
});

// ---------------------------------------------------------------------------
// `reason` alone does not tell the renderer what a reset erased: the
// tool_continuation preserve is gated on response_loop_display_v2, and
// model_winddown keeps its persisted segments while erasing the unsaved live
// slice. Main publishes its own decision as `preserve_prior_segments` and
// `discard_scope`; these tests pin the published labels against what the
// branch ACTUALLY did (segment store + turnEventCollector.discardCapturedEvents).
// ---------------------------------------------------------------------------

function discardScopeCalls(ctx) {
  return callsOf(ctx, 'discardCapturedEvents');
}

test('chat.stream_reset reason=nudge_retry labels itself preserve=false / discard_scope=all', () => {
  const ctx = makeSegmentAwareCtx();
  ctx.currentSegmentText = 'pre-tool commentary';
  ctx.persistCurrentTextSegment({ atToolBoundary: true });
  assert.deepEqual(ctx.persistedTextSegmentIds, ['assistant_stream-1_seg0']);

  const emitted = resetAndCapturePayload(ctx, 'nudge_retry');

  assert.equal(emitted.preserve_prior_segments, false);
  assert.equal(emitted.discard_scope, 'all');
  // ... and 'all' is literally what happened.
  assert.deepEqual(ctx.service.sessionStore.messages, [], 'every persisted segment row is gone');
  assert.equal(discardScopeCalls(ctx).length, 1);
  assert.deepEqual(discardScopeCalls(ctx)[0].kinds, ['assistant_text_segment', 'reasoning_phase']);
  assert.equal(
    discardScopeCalls(ctx)[0].options,
    undefined,
    'the captured-event discard is UNSCOPED — every segment of the turn',
  );
});

test('chat.stream_reset reason=tool_continuation labels itself by the display flag, not by the reason', () => {
  // Flag ON: the documented preserve path — nothing erased.
  const preserving = makeSegmentAwareCtx();
  preserving.service.featureFlags.response_loop_display_v2 = true;
  preserving.currentSegmentText = 'pre-tool commentary';
  preserving.persistCurrentTextSegment({ atToolBoundary: true });

  const preservedEmit = resetAndCapturePayload(preserving, 'tool_continuation');
  assert.equal(preservedEmit.preserve_prior_segments, true);
  assert.equal(preservedEmit.discard_scope, 'none');
  assert.deepEqual(
    preserving.service.sessionStore.messages.map((message) => message.id),
    ['assistant_stream-1_seg0'],
    'the persisted segment row survives',
  );
  assert.equal(discardScopeCalls(preserving).length, 0, 'no captured event is discarded');

  // Flag OFF: the SAME reason discards everything.
  const discarding = makeSegmentAwareCtx();
  discarding.service.featureFlags.response_loop_display_v2 = false;
  discarding.currentSegmentText = 'pre-tool commentary';
  discarding.persistCurrentTextSegment({ atToolBoundary: true });

  const discardedEmit = resetAndCapturePayload(discarding, 'tool_continuation');
  assert.equal(discardedEmit.preserve_prior_segments, false);
  assert.equal(discardedEmit.discard_scope, 'all');
  assert.deepEqual(discarding.service.sessionStore.messages, [], 'the persisted segment row is deleted');
  assert.equal(discardScopeCalls(discarding).length, 1);
  assert.equal(discardScopeCalls(discarding)[0].options, undefined, 'unscoped discard');
});

test('chat.stream_reset reason=model_winddown labels itself preserve=true / discard_scope=live_slice', () => {
  const ctx = makeSegmentAwareCtx();
  ctx.currentSegmentText = 'pre-tool commentary';
  ctx.persistCurrentTextSegment({ atToolBoundary: true });
  assert.equal(ctx.textSegmentIndex, 1);
  ctx.hasPersistedSegments = true;
  ctx.currentSegmentText = 'live slice the cycle hint erases';

  const emitted = resetAndCapturePayload(ctx, 'model_winddown');

  assert.equal(emitted.preserve_prior_segments, true);
  assert.equal(emitted.discard_scope, 'live_slice');
  assert.equal(
    emitted.next_assistant_message_id,
    'assistant_stream-1_seg1',
    'textSegmentIndex has NOT advanced, so the wind-down answer reuses index 1',
  );
  // 'live_slice' is exactly what happened: the persisted segment survives and
  // only the captured events of the base (unsaved) message are dropped.
  assert.deepEqual(
    ctx.service.sessionStore.messages.map((message) => message.id),
    ['assistant_stream-1_seg0'],
    'persisted segments survive a wind-down',
  );
  assert.equal(discardScopeCalls(ctx).length, 1);
  assert.deepEqual(discardScopeCalls(ctx)[0].kinds, ['assistant_text_segment', 'reasoning_phase']);
  assert.deepEqual(
    discardScopeCalls(ctx)[0].options,
    { primaryMessageId: 'assistant-base-1' },
    'the discard is SCOPED to the live slice, not the whole turn',
  );
});
