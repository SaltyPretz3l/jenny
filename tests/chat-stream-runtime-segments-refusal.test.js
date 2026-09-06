// Audit finding A3 acceptance pin (segment half): a segment append the store
// REFUSES must leave no durable footprint — no assistant_text_segment turn
// event, no reasoning-event retarget onto the never-persisted id, no entry in
// persistedTextSegmentIds, no hasPersistedSegments flip, and the visible
// assistant id must not point at a message that does not exist. The refusal
// flag and live slice bookkeeping (index bump, text reset) still run.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  persistCurrentTextSegment,
} = require('../services/backend/chat-stream-managed-runtime-segments');

function buildSegmentCtx({ appendAccepts }) {
  const noteTurnEventCalls = [];
  const retargetCalls = [];
  const logs = [];
  const ctx = {
    streamId: 'stream-seg',
    resolvedSessionId: 'session-seg',
    model: 'test-model',
    currentSegmentText: 'visible text before the tool boundary',
    textSegmentIndex: 0,
    persistedTextSegmentIds: [],
    reasoningEntries: [],
    reasoningTailBreakPending: false,
    reasoningRawTailText: '',
    lastReasoningEventPhaseKey: 'phase-key',
    reasoningTurnEventOrdinal: 0,
    hasPersistedSegments: false,
    visibleAssistantMessageId: 'assistant_stream-seg',
    segmentPersistRefused: false,
    refusedTextSegments: [],
    transcriptCollector: {
      completeCurrentPhase() {},
      resetSlice() {},
      buildAssistantMessageFields() {
        return {
          parent_stream_id: 'stream-seg',
          phases: [{ phase_id: 'phase_1', phase_kind: 'reasoning' }],
          visible_segments: [{ segment_id: 'segment_stream-seg_0', phase_id: 'phase_1' }],
          tool_steps: [],
          reasoning: { entries: [] },
        };
      },
    },
    adapter: {
      appendMessage(message) {
        return appendAccepts ? { id: message.id } : undefined;
      },
    },
    service: {
      featureFlags: {},
      _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    },
    turnEventCollector: {
      retargetCapturedEvents(streamId, options) { retargetCalls.push({ streamId, options }); },
    },
    noteTurnEvent(kind, payload) { noteTurnEventCalls.push({ kind, payload }); },
  };
  return { ctx, noteTurnEventCalls, retargetCalls, logs };
}

test('a REFUSED segment append records no durable turn events and no persisted bookkeeping', () => {
  const { ctx, noteTurnEventCalls, retargetCalls, logs } = buildSegmentCtx({ appendAccepts: false });

  const result = persistCurrentTextSegment(ctx, { atToolBoundary: true });

  assert.equal(result, null, 'a refused segment reports null (refusal), never a summary');
  assert.equal(ctx.segmentPersistRefused, true, 'the refusal is tracked for the settle-time warning');
  assert.deepEqual(noteTurnEventCalls, [], 'no assistant_text_segment event may reference the missing message');
  assert.deepEqual(retargetCalls, [], 'no reasoning event may be retargeted onto the never-persisted id');
  assert.deepEqual(ctx.persistedTextSegmentIds, [], 'the refused id is not recorded as persisted');
  assert.equal(ctx.hasPersistedSegments, false, 'a refused-only turn keeps the full-append settle path open');
  assert.equal(
    ctx.visibleAssistantMessageId,
    'assistant_stream-seg',
    'the visible assistant id must not point at a message that does not exist'
  );
  assert.equal(ctx.textSegmentIndex, 1, 'live slice bookkeeping still advances');
  assert.equal(ctx.currentSegmentText, '', 'live slice text still resets');
  assert.deepEqual(
    ctx.refusedTextSegments.map((message) => [message.id, message.content]),
    [['assistant_stream-seg_seg0', 'visible text before the tool boundary']]
  );
  assert.ok(
    logs.some((entry) => entry.event === 'chat.assistant_segment_persist_refused'),
    'the refusal stays diagnosed'
  );
});

// Green pin: an accepted segment keeps today's full durable footprint.
test('an ACCEPTED segment append records the event, the bookkeeping, and the visible id', () => {
  const { ctx, noteTurnEventCalls, retargetCalls } = buildSegmentCtx({ appendAccepts: true });

  const result = persistCurrentTextSegment(ctx, { atToolBoundary: true });

  assert.ok(result, 'an accepted segment returns its summary');
  assert.equal(ctx.segmentPersistRefused, false);
  assert.equal(noteTurnEventCalls.length, 1, 'the assistant_text_segment event is recorded');
  assert.equal(noteTurnEventCalls[0].kind, 'assistant_text_segment');
  assert.equal(retargetCalls.length, 1, 'the slice reasoning events retarget onto the persisted segment');
  assert.deepEqual(ctx.persistedTextSegmentIds, ['assistant_stream-seg_seg0']);
  assert.equal(ctx.hasPersistedSegments, true);
  assert.equal(ctx.visibleAssistantMessageId, 'assistant_stream-seg_seg0');
});

test('after the first production refusal later segments stay in one ordered terminal suffix', () => {
  const { ctx } = buildSegmentCtx({ appendAccepts: true });
  ctx.service.terminalCoordinator = { settle() {} };
  assert.ok(persistCurrentTextSegment(ctx, { atToolBoundary: true }));

  let laterAppendCalls = 0;
  ctx.adapter.appendMessage = () => {
    laterAppendCalls += 1;
    return null;
  };
  ctx.currentSegmentText = 'missing middle';
  assert.equal(persistCurrentTextSegment(ctx, { atToolBoundary: true }), null);
  ctx.currentSegmentText = 'missing suffix';
  assert.equal(persistCurrentTextSegment(ctx, { atToolBoundary: true }), null);

  assert.equal(laterAppendCalls, 1, 'the store is not allowed to persist beyond the first gap');
  assert.deepEqual(ctx.persistedTextSegmentIds, ['assistant_stream-seg_seg0']);
  assert.deepEqual(
    ctx.refusedTextSegments.map((message) => [message.id, message.content]),
    [
      ['assistant_stream-seg_seg1', 'missing middle'],
      ['assistant_stream-seg_seg2', 'missing suffix'],
    ]
  );
});
