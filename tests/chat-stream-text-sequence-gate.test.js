// The text-sequence dedupe gate: a highest-contiguous watermark plus a
// bounded out-of-order window, replacing a Set that retained one string per
// accepted sequence for the whole turn.
//
// These live here rather than in the sibling notifications test because that
// file sits at exactly the 1015-line ceiling.
//
// Static-literal require (source->test existence gate walks this graph):
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  createTextSequenceGate,
} = require('../services/backend/chat-stream-managed-runtime-utils');
const {
  makeCtx,
  makeHandleToolNotification,
  callsOf,
} = require('./helpers/managed-runtime-notification-harness');

test('the text sequence gate stays O(1) across 10,000 sequential tokens', () => {
  const ctx = makeCtx({ emitChatStream() {} });
  const handle = makeHandleToolNotification(ctx);
  for (let sequence = 1; sequence <= 10_000; sequence += 1) {
    handleNotification(ctx, { method: 'chat.token', params: { delta: 'x', sequence } }, {
      toolContext: {}, handleToolNotification: handle,
    });
  }

  assert.deepEqual(ctx.appliedTextSequenceGate.state(), { watermark: 10_000, gapSize: 0 });
});

test('an out-of-order sequence below the watermark is rejected exactly like the Set', () => {
  const ctx = makeCtx();
  const handle = makeHandleToolNotification(ctx);
  const arrivals = [[5, '5'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [3, 'X']];
  for (const [sequence, delta] of arrivals) {
    handleNotification(ctx, { method: 'chat.token', params: { delta, sequence } }, {
      toolContext: {}, handleToolNotification: handle,
    });
  }

  assert.equal(callsOf(ctx, 'emitChatStream').length, 5);
  assert.equal(ctx.assistantText, '51234');
});

test('gap overflow forces the watermark and warns once', () => {
  const maxGap = 2;
  const ctx = makeCtx({ appliedTextSequenceGate: createTextSequenceGate({ maxGap }) });
  const handle = makeHandleToolNotification(ctx);
  for (let index = 1; index <= maxGap + 5; index += 1) {
    handleNotification(ctx, { method: 'chat.token', params: { delta: 'x', sequence: index * 2 } }, {
      toolContext: {}, handleToolNotification: handle,
    });
  }

  const warnings = callsOf(ctx, 'serviceLog')
    .filter((entry) => entry.code === 'chat.text_sequence_gap_overflow');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'WARN');
  assert.deepEqual(ctx.appliedTextSequenceGate.state(), { watermark: 12, gapSize: 1 });
});

test('deltas with no sequence are always applied', () => {
  const ctx = makeCtx({ canonicalBridgeEnabled: false });
  const handle = makeHandleToolNotification(ctx);
  for (const delta of ['A', 'A']) {
    handleNotification(ctx, { method: 'chat.token', params: { delta } }, {
      toolContext: {}, handleToolNotification: handle,
    });
  }

  assert.equal(callsOf(ctx, 'emitChatStream').length, 2);
  assert.equal(ctx.assistantText, 'AA');
  assert.deepEqual(ctx.appliedTextSequenceGate.state(), { watermark: 0, gapSize: 0 });
});
