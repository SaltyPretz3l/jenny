const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  mergeDeltaPayloads,
} = require('../services/chat-stream-bridge-support');
const {
  buildEnvelopeSources,
  STREAM_ENVELOPE_SCHEMA_VERSION,
} = require('../services/stream-envelope-shape');
const {
  streamEnvelopeToLegacyPayload,
} = require('../renderer/chat/renderer-stream-envelope-v2');
const {
  createTextCursor,
  readDelta,
} = require('../renderer/chat/renderer-stream-text-cursor');
const {
  buildFeatureFlags,
  FEATURE_OVERRIDE_KEYS,
  INTERNAL_FEATURE_FLAG_KEYS,
} = require('../services/feature-flags');
const {
  canonicalEvent,
  callsOf,
  makeCtx,
  makeHandleToolNotification,
} = require('./helpers/managed-runtime-notification-harness');

function checkpointCtx(overrides = {}) {
  const ctx = makeCtx({
    canonicalBridgeEnabled: false,
    textSegmentIndex: 0,
    ...overrides,
  });
  ctx.service.featureFlags = {
    ...ctx.service.featureFlags,
    aggregate_checkpoints: true,
  };
  return ctx;
}

function emitToken(ctx, delta) {
  handleNotification(ctx, { method: 'chat.token', params: { delta } }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });
}

function emitReasoning(ctx, delta, thinkingId) {
  handleNotification(ctx, {
    method: 'chat.thinking',
    params: {
      delta,
      kind: 'reasoning',
      persist: true,
      thinking_id: thinkingId,
    },
  }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });
}

function deltaPayloads(ctx) {
  return callsOf(ctx, 'emitChatStream')
    .map((call) => call.payload)
    .filter((payload) => payload.type === 'delta');
}

function hasAggregate(payload) {
  return Object.prototype.hasOwnProperty.call(payload, 'aggregate');
}

function jsonBytes(payloads) {
  return payloads.reduce(
    (total, payload) => total + Buffer.byteLength(JSON.stringify(payload)),
    0
  );
}

function coalesceFrames(payloads, deltasPerFrame) {
  const frames = [];
  for (let start = 0; start < payloads.length; start += deltasPerFrame) {
    frames.push(payloads
      .slice(start, start + deltasPerFrame)
      .reduce((merged, payload) => (
        merged ? mergeDeltaPayloads(merged, payload) : { ...payload }
      ), null));
  }
  return frames;
}

test('aggregate_checkpoints is internal, DEFAULT-ON, with the documented env rollback', () => {
  assert.equal(buildFeatureFlags({}).aggregate_checkpoints, true);
  assert.equal(
    buildFeatureFlags({ JENNY_ENABLE_AGGREGATE_CHECKPOINTS: '0' }).aggregate_checkpoints,
    false
  );
  assert.equal(
    buildFeatureFlags({ JENNY_ENABLE_AGGREGATE_CHECKPOINTS: '1' }).aggregate_checkpoints,
    true
  );
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('aggregate_checkpoints'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('aggregate_checkpoints'));
});

test('flag OFF emits the byte-identical legacy aggregate shape across 50 deltas', () => {
  const ctx = makeCtx({ canonicalBridgeEnabled: false, textSegmentIndex: 0 });
  ctx.service.featureFlags.aggregate_checkpoints = false;
  let aggregate = '';

  for (let index = 0; index < 50; index += 1) {
    const content = String(index % 10);
    aggregate += content;
    emitToken(ctx, content);
    const payload = deltaPayloads(ctx).at(-1);
    const preChangeReference = {
      type: 'delta',
      content,
      aggregate,
      requestId: 'stream-1',
    };
    assert.equal(JSON.stringify(payload), JSON.stringify(preChangeReference));
    assert.equal(Object.hasOwn(payload, 'aggregateLength'), false);
  }
});

// The producer-stage byte-identity test above is not sufficient on its own: the
// renderer sees COALESCED frames, and the bridge merge used to synthesize an
// aggregateLength onto any frame carrying an aggregate without one -- which put a
// key on every flag-off coalesced frame that the pre-change bridge never emitted.
// The rollback promise is about what reaches the renderer, so assert it there.
test('flag OFF coalesced frames are byte-identical to the pre-change bridge shape', () => {
  const ctx = makeCtx({ canonicalBridgeEnabled: false, textSegmentIndex: 0 });
  ctx.service.featureFlags.aggregate_checkpoints = false;
  for (const chunk of ['a', 'b', 'c', 'd', 'e', 'f']) emitToken(ctx, chunk);

  for (const frame of coalesceFrames(deltaPayloads(ctx), 3)) {
    assert.equal(Object.hasOwn(frame, 'aggregateLength'), false);
  }
  const [first, second] = coalesceFrames(deltaPayloads(ctx), 3);
  assert.equal(
    JSON.stringify(first),
    JSON.stringify({ type: 'delta', content: 'abc', aggregate: 'abc', requestId: 'stream-1' })
  );
  assert.equal(
    JSON.stringify(second),
    JSON.stringify({ type: 'delta', content: 'def', aggregate: 'abcdef', requestId: 'stream-1' })
  );
});

test('flag ON steady stream emits one aggregate checkpoint across 50 rapid deltas', (t) => {
  t.mock.method(Date, 'now', () => 10_000);
  const ctx = checkpointCtx();
  let aggregate = '';

  for (let index = 0; index < 50; index += 1) {
    const content = String(index % 10);
    aggregate += content;
    emitToken(ctx, content);
    assert.equal(deltaPayloads(ctx).at(-1).aggregateLength, aggregate.length);
  }

  const payloads = deltaPayloads(ctx);
  assert.equal(payloads.length, 50);
  assert.equal(payloads.filter(hasAggregate).length, 1);
});

test('aggregateLength equals the running UTF-16 concatenation length on every frame', (t) => {
  t.mock.method(Date, 'now', () => 20_000);
  const ctx = checkpointCtx();
  const chunks = ['a', '🙂', 'BC', 'é', '終'];
  let aggregate = '';

  for (const chunk of chunks) {
    aggregate += chunk;
    emitToken(ctx, chunk);
    assert.equal(deltaPayloads(ctx).at(-1).aggregateLength, aggregate.length);
  }
});

test('first delta and first delta after a segment boundary carry checkpoints', (t) => {
  t.mock.method(Date, 'now', () => 30_000);
  const ctx = checkpointCtx();

  emitToken(ctx, 'a');
  emitToken(ctx, 'b');
  ctx.textSegmentIndex += 1;
  ctx.currentSegmentText = '';
  emitToken(ctx, 'c');

  const payloads = deltaPayloads(ctx);
  assert.equal(payloads[0].aggregate, 'a');
  assert.equal(hasAggregate(payloads[1]), false);
  assert.equal(payloads[2].aggregate, 'abc');
});

test('first delta after chat.stream_reset carries a checkpoint', (t) => {
  t.mock.method(Date, 'now', () => 40_000);
  const ctx = checkpointCtx();

  emitToken(ctx, 'a');
  emitToken(ctx, 'b');
  handleNotification(ctx, {
    method: 'chat.stream_reset',
    params: { reason: 'provider_retry' },
  }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });
  emitToken(ctx, 'c');

  const payloads = deltaPayloads(ctx);
  assert.equal(hasAggregate(payloads[1]), false);
  assert.equal(payloads[2].aggregate, 'c');
  assert.equal(payloads[2].aggregateLength, 1);
});

test('reasoning phase transition carries a checkpoint using the existing phase key', (t) => {
  t.mock.method(Date, 'now', () => 50_000);
  const ctx = checkpointCtx({ assistantText: 'visible' });

  emitReasoning(ctx, 'one', 'phase-1');
  emitReasoning(ctx, 'two', 'phase-1');
  emitReasoning(ctx, 'three', 'phase-2');

  const payloads = deltaPayloads(ctx);
  assert.equal(payloads[0].aggregate, 'visible');
  assert.equal(hasAggregate(payloads[1]), false);
  assert.equal(payloads[2].aggregate, 'visible');
});

test('terminal text_part_completed delta carries a checkpoint', (t) => {
  t.mock.method(Date, 'now', () => 60_000);
  const ctx = checkpointCtx({ canonicalBridgeEnabled: true });

  emitToken(ctx, 'a');
  emitToken(ctx, 'b');
  handleNotification(ctx, {
    method: 'turn.event',
    params: canonicalEvent('text_part_completed', { text: 'abc' }, { seq: 3 }),
  }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });

  const payloads = deltaPayloads(ctx);
  assert.equal(hasAggregate(payloads[1]), false);
  assert.equal(payloads[2].content, 'c');
  assert.equal(payloads[2].aggregate, 'abc');
  assert.equal(payloads[2].aggregateLength, 3);
});

test('2 s safety net waits at 1999 ms and fires at 2001 ms', (t) => {
  let nowMs = 70_000;
  t.mock.method(Date, 'now', () => nowMs);
  const ctx = checkpointCtx();

  emitToken(ctx, 'a');
  assert.equal(ctx.lastAggregateCheckpointAtMs, 70_000);

  nowMs = 71_999;
  emitToken(ctx, 'b');
  assert.equal(hasAggregate(deltaPayloads(ctx).at(-1)), false);
  assert.equal(ctx.lastAggregateCheckpointAtMs, 70_000);

  nowMs = 72_001;
  emitToken(ctx, 'c');
  assert.equal(deltaPayloads(ctx).at(-1).aggregate, 'abc');
  assert.equal(ctx.lastAggregateCheckpointAtMs, 72_001);
});

test('reasoning-only delta carries aggregateLength without aggregate between checkpoints', (t) => {
  t.mock.method(Date, 'now', () => 80_000);
  const ctx = checkpointCtx({ assistantText: 'visible' });

  emitReasoning(ctx, 'one', 'phase-1');
  emitReasoning(ctx, 'two', 'phase-1');

  const payload = deltaPayloads(ctx)[1];
  assert.equal(payload.content, '');
  assert.equal(payload.aggregateLength, 'visible'.length);
  assert.equal(hasAggregate(payload), false);
});

test('aggregate and aggregateLength survive response and reasoning envelope round trips', () => {
  const cases = [
    {
      channel: 'response',
      payload: { type: 'delta', content: 'abc', aggregate: 'abc', aggregateLength: 3 },
    },
    {
      channel: 'reasoning',
      payload: {
        type: 'delta',
        content: '',
        aggregate: 'abc',
        aggregateLength: 3,
        reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'why' }] },
      },
    },
  ];

  for (const entry of cases) {
    const source = buildEnvelopeSources(entry.payload, 'delta')
      .find((candidate) => candidate.channel === entry.channel);
    assert.ok(source);
    const decoded = streamEnvelopeToLegacyPayload({
      schemaVersion: STREAM_ENVELOPE_SCHEMA_VERSION,
      streamId: `stream-${entry.channel}`,
      sessionId: 'session-1',
      turnId: 'turn-1',
      ...source,
    });
    assert.equal(decoded.aggregate, 'abc');
    assert.equal(decoded.aggregateLength, 3);
  }
});

// The clock must advance here. The safety net is time-based, so freezing Date.now
// emits exactly one checkpoint for the whole reply and reports a win no real
// stream gets. 10 ms per delta against 5-delta frames matches the bridge's 50 ms
// coalescing window, which puts this 50 KB reply at ~10 s of streaming.
test('50 KB reply checkpoint wire bytes stay far below rollback bytes', (t) => {
  let nowMs = 90_000;
  t.mock.method(Date, 'now', () => nowMs);
  const payloadsFor = (enabled) => {
    nowMs = 90_000;
    const ctx = makeCtx({ canonicalBridgeEnabled: false, textSegmentIndex: 0 });
    ctx.service.featureFlags.aggregate_checkpoints = enabled;
    for (let index = 0; index < 1_000; index += 1) {
      emitToken(ctx, 'x'.repeat(50));
      nowMs += 10;
    }
    return deltaPayloads(ctx);
  };

  const enabledFrames = coalesceFrames(payloadsFor(true), 5);
  const rollbackFrames = coalesceFrames(payloadsFor(false), 5);
  const enabledBytes = jsonBytes(enabledFrames);
  const rollbackBytes = jsonBytes(rollbackFrames);

  t.diagnostic(`aggregate checkpoints ON bytes: ${enabledBytes}`);
  t.diagnostic(`aggregate checkpoints OFF bytes: ${rollbackBytes}`);
  assert.equal(enabledFrames.length, 200);
  assert.equal(rollbackFrames.length, 200);
  assert.ok(
    enabledBytes < rollbackBytes / 10,
    `checkpointed ${enabledBytes} vs rollback ${rollbackBytes}`
  );
});

// Frame sizes cycle through this instead of a random generator so a failure
// reproduces exactly. The point is that checkpoints land at every position
// within a frame -- first, middle, last, and absent entirely.
const COALESCE_GROUP_SIZES = [1, 3, 7, 2, 5, 1, 8, 4, 6, 2, 3, 1, 5, 7];

function reconstructThroughRenderer(payloads, label) {
  const cursor = createTextCursor();
  let pending = '';
  let consumed = '';
  let frameIndex = 0;
  for (let start = 0; start < payloads.length; frameIndex += 1) {
    const size = COALESCE_GROUP_SIZES[frameIndex % COALESCE_GROUP_SIZES.length];
    const group = payloads.slice(start, start + size);
    const frame = group.reduce((merged, payload) => (
      merged ? mergeDeltaPayloads(merged, payload) : { ...payload }
    ), null);
    consumed += group.map((payload) => String(payload.content || '')).join('');
    const result = readDelta(cursor, frame, { basisContent: pending });
    assert.equal(result.regressed, false, `${label}: frame ${frameIndex} regressed`);
    pending = result.pendingContent;
    // The real guard. Asserting only the final text would be vacuous: a stale
    // checkpoint truncates mid-stream and then heals at the next one, so the
    // damage is invisible at the end but visible to the user as text that
    // jumps backwards.
    assert.equal(pending, consumed, `${label}: frame ${frameIndex} diverged`);
    start += size;
  }
  return pending;
}

// The integration invariant the whole slice rests on: whatever the producer
// generates, the renderer must reconstruct byte-for-byte after the bridge has
// coalesced an arbitrary number of deltas into each frame. Its failure mode is
// SILENT -- a stale aggregate beside a newer aggregateLength makes the renderer
// drop text with regressed=false and lengthMismatch=false, so nothing downstream
// notices. Confirmed red against the pre-A1 merge: remove BOTH the
// reconstruction branch and the length self-check from mergeDeltaPayloads and
// this fails at "flag=on ascii @50ms: frame 10 diverged". Removing only the
// reconstruction branch stays green -- the self-check is the load-bearing half,
// because dropping a mismatched aggregate falls back to safe delta-concat.
test('producer to renderer round trip reconstructs the exact text under coalescing', (t) => {
  let nowMs = 100_000;
  t.mock.method(Date, 'now', () => nowMs);
  const shapes = {
    ascii: (index) => String.fromCharCode(97 + (index % 26)).repeat(1 + (index % 40)),
    unicode: (index) => ['a', '\u{1F642}', 'BC', 'é', '終'][index % 5].repeat(1 + (index % 7)),
    emptyRuns: (index) => (index % 3 === 0 ? '' : 'z'.repeat(index % 17)),
  };

  for (const flagOn of [true, false]) {
    for (const [shape, chunkOf] of Object.entries(shapes)) {
      // 0 ms exercises one checkpoint for the whole stream; 900 ms fires the
      // 2 s net regularly; 50 ms is the production frame cadence.
      for (const msPerDelta of [0, 50, 900]) {
        nowMs = 100_000;
        const ctx = makeCtx({ canonicalBridgeEnabled: false, textSegmentIndex: 0 });
        ctx.service.featureFlags = { ...ctx.service.featureFlags, aggregate_checkpoints: flagOn };
        let expected = '';
        for (let index = 0; index < 400; index += 1) {
          const chunk = chunkOf(index);
          expected += chunk;
          emitToken(ctx, chunk);
          nowMs += msPerDelta;
        }
        const payloads = deltaPayloads(ctx);
        const label = `flag=${flagOn ? 'on' : 'off'} ${shape} @${msPerDelta}ms`;
        assert.equal(reconstructThroughRenderer(payloads, label), expected, label);
        t.diagnostic(
          `${label}: ${expected.length} chars, ${payloads.length} deltas, `
          + `${payloads.filter(hasAggregate).length} carried an aggregate`
        );
      }
    }
  }
});
