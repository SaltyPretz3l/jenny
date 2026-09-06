// Producer half of the reasoning wire-delta contract (slice C1-c), split from
// chat-stream-reasoning-wire-deltas.test.js to keep both under the 600-line
// test ratchet. Drives the REAL producer, bridge coalescer and renderer merger.
const test = require('node:test');
const assert = require('node:assert/strict');

const { mergeReasoningEntries } = require('../renderer/chat/chat-message-utils');
const {
  createReasoningStreamMerger,
} = require('../renderer/chat/renderer-stream-handler-reasoning-merge');
const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  resolvePersistedReasoningCap,
} = require('../services/backend/chat-stream-reasoning-delta');
const { mergeDeltaPayloads } = require('../services/chat-stream-bridge-support');
const {
  buildFeatureFlags,
  FEATURE_OVERRIDE_KEYS,
  INTERNAL_FEATURE_FLAG_KEYS,
} = require('../services/feature-flags');
const {
  callsOf,
  makeCtx,
  makeHandleToolNotification,
} = require('./helpers/managed-runtime-notification-harness');

function createDirectReasoningMerger(options = {}) {
  return createReasoningStreamMerger({
    normalizeId(value) {
      return String(value || '').trim();
    },
    mergeMessageReasoning(message, payload) {
      const existing = Array.isArray(message?.reasoning?.entries)
        ? message.reasoning.entries
        : [];
      if (!payload || !Array.isArray(payload.entriesDelta) || !payload.entriesDelta.length) {
        return message.reasoning || { source: 'none', entries: [] };
      }
      return {
        source: String(payload.source || 'provider'),
        entries: mergeReasoningEntries(existing, payload.entriesDelta, {
          timestamp: '2026-09-05T00:00:00.000Z',
        }),
      };
    },
    ...options,
  });
}

const COALESCE_GROUP_SIZES = [1, 3, 7, 2, 5, 1, 8, 4, 6, 2, 3, 1, 5, 7];

function makeReasoningProducerCtx(flagValue) {
  const ctx = makeCtx({ canonicalBridgeEnabled: false, textSegmentIndex: 0 });
  if (flagValue !== undefined) {
    ctx.service.featureFlags.reasoning_wire_deltas = flagValue;
  }
  return ctx;
}

function emitProducerReasoning(ctx, delta, thinkingId = 'thinking-wire') {
  const before = callsOf(ctx, 'emitChatStream').length;
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
  return callsOf(ctx, 'emitChatStream').length > before
    ? callsOf(ctx, 'emitChatStream').at(-1).payload
    : null;
}

function emitProducerToken(ctx, delta) {
  handleNotification(ctx, { method: 'chat.token', params: { delta } }, {
    toolContext: {},
    handleToolNotification: makeHandleToolNotification(ctx),
  });
}

function producerReasoningPayloads(ctx) {
  return callsOf(ctx, 'emitChatStream')
    .map((call) => call.payload)
    .filter((payload) => Array.isArray(payload.reasoning?.entriesDelta));
}

function reasoningJsonBytes(payloads) {
  return payloads.reduce(
    (total, payload) => total + Buffer.byteLength(JSON.stringify(payload)),
    0
  );
}

function coalesceProducerFrames(payloads, oracleByDelta) {
  const frames = [];
  for (let start = 0, frameIndex = 0; start < payloads.length; frameIndex += 1) {
    const size = COALESCE_GROUP_SIZES[frameIndex % COALESCE_GROUP_SIZES.length];
    const end = Math.min(start + size, payloads.length);
    const payload = payloads.slice(start, end).reduce((merged, next) => (
      merged ? mergeDeltaPayloads(merged, next) : { ...next }
    ), null);
    frames.push({ payload, oracle: oracleByDelta[end - 1], start, end });
    start = end;
  }
  return frames;
}

function createProducerRendererState() {
  return {
    merger: createDirectReasoningMerger({ appendClientLog() {} }),
    message: {
      id: 'assistant-wire-producer',
      reasoning: { source: 'provider', entries: [] },
    },
  };
}

function mergeProducerFrame(state, frame) {
  state.message.reasoning = state.merger.merge(
    'stream-wire-producer',
    state.message,
    frame.payload.reasoning
  );
  return state.message.reasoning.entries.at(-1)?.text || '';
}

function assertProducerFrames(frames, label) {
  const state = createProducerRendererState();
  for (let index = 0; index < frames.length; index += 1) {
    const actual = mergeProducerFrame(state, frames[index]);
    // The real guard. Final-only parity is vacuous because a stale frame can
    // visibly regress and then heal at the next periodic snapshot.
    assert.equal(actual, frames[index].oracle.text, `${label}: frame ${index}`);
  }
  return state;
}

function recordReasoningDelta(ctx, delta, nowMs, records, thinkingId) {
  const payload = emitProducerReasoning(ctx, delta, thinkingId);
  if (payload) {
    records.payloads.push(payload);
    records.oracles.push({ text: ctx.reasoningEntries.at(-1).text, nowMs });
  }
  return payload;
}

test('reasoning wire producer keeps 400 ascii deltas exact and edit-dominant', (t) => {
  let nowMs = 100_000;
  t.mock.method(Date, 'now', () => nowMs);
  assert.equal(buildFeatureFlags({}).reasoning_wire_deltas, false);
  assert.equal(
    buildFeatureFlags({ JENNY_ENABLE_REASONING_WIRE_DELTAS: '1' }).reasoning_wire_deltas,
    true
  );
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('reasoning_wire_deltas'));
  assert.ok(!FEATURE_OVERRIDE_KEYS.includes('reasoning_wire_deltas'));

  const chunks = Array.from({ length: 400 }, (_value, index) => (
    String.fromCharCode(97 + (index % 26)).repeat(1 + (index % 40))
  ));
  const enabledCtx = makeReasoningProducerCtx(true);
  const enabled = { payloads: [], oracles: [] };
  for (const chunk of chunks) {
    recordReasoningDelta(enabledCtx, chunk, nowMs, enabled);
    nowMs += 50;
  }
  const entries = enabled.payloads.map((payload) => payload.reasoning.entriesDelta[0]);
  const snapshots = entries.filter((entry) => Object.hasOwn(entry, 'text')).length;
  const edits = entries.filter((entry) => Object.hasOwn(entry, 'baseLength')).length;
  assert.ok(edits > snapshots, `${edits} edits vs ${snapshots} snapshots`);
  for (let index = 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!Object.hasOwn(entry, 'baseLength')) continue;
    const previousText = enabled.oracles[index - 1].text.trim();
    assert.ok(entry.baseTail.length <= 64, `edit ${index} base tail is bounded`);
    assert.equal(entry.baseTail, previousText.slice(-64), `edit ${index} base tail`);
  }
  assert.ok(callsOf(enabledCtx, 'appendReasoningEntries').every((call) => (
    Object.hasOwn(call.entries[0], 'text')
    && !Object.hasOwn(call.entries[0], 'baseLength')
  )));
  assert.ok(callsOf(enabledCtx, 'noteTurnEvent').every((call) => (
    Object.hasOwn(call.event.payload.entries[0], 'text')
    && !Object.hasOwn(call.event.payload.entries[0], 'baseLength')
  )));
  assertProducerFrames(
    coalesceProducerFrames(enabled.payloads, enabled.oracles),
    'enabled ascii'
  );

  nowMs = 100_000;
  const disabledCtx = makeReasoningProducerCtx(false);
  const disabled = { payloads: [], oracles: [] };
  for (const chunk of chunks) {
    recordReasoningDelta(disabledCtx, chunk, nowMs, disabled);
    nowMs += 50;
  }
  const enabledBytes = reasoningJsonBytes(enabled.payloads);
  const disabledBytes = reasoningJsonBytes(disabled.payloads);
  assert.ok(enabledBytes < disabledBytes);
  t.diagnostic(
    `reasoning wire: ${snapshots} snapshots, ${edits} edits; `
    + `${enabledBytes} B ON vs ${disabledBytes} B OFF; `
    + `${(disabledBytes / enabledBytes).toFixed(2)}x reduction`
  );
});

test('reasoning wire retractions are snapshots with per-frame parity', (t) => {
  let nowMs = 200_000;
  t.mock.method(Date, 'now', () => nowMs);
  const shapes = [
    ['Some text\nThou', 'ght: more here'],
    ['abc<thi', 'nk>hidden tail'],
  ];

  for (const [shapeIndex, deltas] of shapes.entries()) {
    const ctx = makeReasoningProducerCtx(true);
    const records = { payloads: [], oracles: [] };
    for (const delta of deltas) {
      recordReasoningDelta(ctx, delta, nowMs, records);
      nowMs += 50;
    }
    const retractionEntry = records.payloads[1].reasoning.entriesDelta[0];
    assert.ok(Object.hasOwn(retractionEntry, 'text'), `shape ${shapeIndex} snapshot`);
    assert.ok(!Object.hasOwn(retractionEntry, 'baseLength'));
    assertProducerFrames(
      coalesceProducerFrames(records.payloads, records.oracles),
      `retraction ${shapeIndex}`
    );
  }
});

test('reasoning wire truncation emits a healing snapshot and then stops', (t) => {
  let nowMs = 300_000;
  t.mock.method(Date, 'now', () => nowMs);
  const ctx = makeReasoningProducerCtx(true);
  ctx.thinkingBudgetChars = 0;
  assert.equal(resolvePersistedReasoningCap(ctx.thinkingBudgetChars), 48_000);
  const records = { payloads: [], oracles: [] };
  for (let index = 0; index < 70; index += 1) {
    recordReasoningDelta(ctx, 'x'.repeat(997), nowMs, records);
    nowMs += 50;
  }

  const truncatedIndex = records.payloads.findIndex((payload) => payload.reasoning.truncated === true);
  assert.ok(truncatedIndex >= 0);
  const truncatedEntry = records.payloads[truncatedIndex].reasoning.entriesDelta[0];
  assert.ok(Object.hasOwn(truncatedEntry, 'text'));
  assert.match(truncatedEntry.text, /_\[reasoning truncated - \d+ more characters not stored\]_$/);
  assert.equal(truncatedIndex, records.payloads.length - 1);
  assert.ok(records.payloads.length < 70, 'post-cap deltas stop emitting');
  assertProducerFrames(
    coalesceProducerFrames(records.payloads, records.oracles),
    'truncation'
  );
});

test('reasoning wire phase re-open snapshots the same thinking id', (t) => {
  let nowMs = 400_000;
  t.mock.method(Date, 'now', () => nowMs);
  const ctx = makeReasoningProducerCtx(true);
  let phaseId = 'phase-before-text';
  ctx._setAppendReasoningResult((_entries, meta = {}) => ({
    protocolViolation: false,
    phase: {
      phase_id: phaseId,
      thinking_id: meta.thinking_id,
      started_at: meta.timestamp,
      render_collapsed: false,
    },
  }));
  const records = { payloads: [], oracles: [] };
  recordReasoningDelta(ctx, 'before', nowMs, records, 'same-thinking-id');
  nowMs += 50;
  recordReasoningDelta(ctx, '-more', nowMs, records, 'same-thinking-id');
  nowMs += 50;
  emitProducerToken(ctx, 'visible answer');
  phaseId = 'phase-after-text';
  nowMs += 50;
  const reopened = recordReasoningDelta(
    ctx, '-reopened', nowMs, records, 'same-thinking-id'
  ).reasoning.entriesDelta[0];

  assert.ok(Object.hasOwn(reopened, 'text'));
  assert.ok(!Object.hasOwn(reopened, 'baseLength'));
  assertProducerFrames(
    coalesceProducerFrames(records.payloads, records.oracles),
    'phase reopen'
  );
});

test('reasoning wire dropped edit stays prefix-stale and heals within two seconds', (t) => {
  let nowMs = 500_000;
  t.mock.method(Date, 'now', () => nowMs);
  const ctx = makeReasoningProducerCtx(true);
  const records = { payloads: [], oracles: [] };
  for (const delta of ['Some text\nThou', 'ght: more here']) {
    recordReasoningDelta(ctx, delta, nowMs, records);
    nowMs += 50;
  }
  for (let index = 0; index < 120; index += 1) {
    recordReasoningDelta(ctx, String.fromCharCode(97 + (index % 26)), nowMs, records);
    nowMs += 50;
  }

  const frames = coalesceProducerFrames(records.payloads, records.oracles);
  const droppedIndex = frames.findIndex((frame, index) => (
    index > 1
    && Object.hasOwn(frame.payload.reasoning.entriesDelta[0], 'baseLength')
    && frames.slice(index + 1).some((next) => (
      Object.hasOwn(next.payload.reasoning.entriesDelta[0], 'text')
    ))
  ));
  assert.ok(droppedIndex > 1);
  const state = createProducerRendererState();
  let staleText = '';
  let healed = false;
  const droppedAtMs = frames[droppedIndex].oracle.nowMs;

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (index === droppedIndex) {
      staleText = state.message.reasoning.entries.at(-1).text;
      assert.notEqual(staleText, frame.oracle.text);
      assert.ok(frame.oracle.text.startsWith(staleText));
      continue;
    }
    const actual = mergeProducerFrame(state, frame);
    if (index < droppedIndex) {
      assert.equal(actual, frame.oracle.text, `pre-drop frame ${index}`);
      continue;
    }
    const isSnapshot = Object.hasOwn(frame.payload.reasoning.entriesDelta[0], 'text');
    if (!healed && isSnapshot) {
      healed = true;
      assert.equal(actual, frame.oracle.text, `healing frame ${index}`);
      assert.ok(frame.oracle.nowMs - droppedAtMs <= 2_000);
    } else if (!healed) {
      assert.equal(actual, staleText, `stale frame ${index}`);
      assert.ok(frame.oracle.text.startsWith(actual), `prefix frame ${index}`);
    } else {
      assert.equal(actual, frame.oracle.text, `post-heal frame ${index}`);
    }
  }
  assert.equal(healed, true);
});

test('reasoning wire flag flips preserve snapshot rollback and resume with a snapshot', (t) => {
  let nowMs = 600_000;
  t.mock.method(Date, 'now', () => nowMs);
  const ctx = makeReasoningProducerCtx(false);
  const records = { payloads: [], oracles: [] };
  for (let index = 0; index < 60; index += 1) {
    recordReasoningDelta(ctx, 'a', nowMs, records);
    nowMs += 50;
  }
  assert.ok(records.payloads.every((payload) => (
    Object.hasOwn(payload.reasoning.entriesDelta[0], 'text')
    && !Object.hasOwn(payload.reasoning.entriesDelta[0], 'baseLength')
  )));
  assert.equal(ctx.reasoningWireLast, undefined);

  ctx.service.featureFlags.reasoning_wire_deltas = true;
  const firstEnabledIndex = records.payloads.length;
  recordReasoningDelta(ctx, 'b', nowMs, records);
  nowMs += 50;
  for (let index = 0; index < 5; index += 1) {
    recordReasoningDelta(ctx, 'b', nowMs, records);
    nowMs += 50;
  }
  assert.ok(Object.hasOwn(
    records.payloads[firstEnabledIndex].reasoning.entriesDelta[0],
    'text'
  ));
  assert.ok(records.payloads.slice(firstEnabledIndex + 1).some((payload) => (
    Object.hasOwn(payload.reasoning.entriesDelta[0], 'baseLength')
  )));

  ctx.service.featureFlags.reasoning_wire_deltas = false;
  const rolledBack = recordReasoningDelta(ctx, 'c', nowMs, records)
    .reasoning.entriesDelta[0];
  assert.ok(Object.hasOwn(rolledBack, 'text'));
  assert.ok(!Object.hasOwn(rolledBack, 'baseLength'));
  assertProducerFrames(
    coalesceProducerFrames(records.payloads, records.oracles),
    'flag flips'
  );
});

test('reasoning wire OFF to ON always resumes with a healing snapshot', (t) => {
  let nowMs = 650_000;
  t.mock.method(Date, 'now', () => nowMs);
  const ctx = makeReasoningProducerCtx(true);
  const payloads = [];

  payloads.push(emitProducerReasoning(ctx, 'a'));
  nowMs += 50;
  ctx.service.featureFlags.reasoning_wire_deltas = false;
  payloads.push(emitProducerReasoning(ctx, 'b'));
  assert.equal(ctx.reasoningWireLast, undefined);
  nowMs += 50;
  ctx.service.featureFlags.reasoning_wire_deltas = true;
  payloads.push(emitProducerReasoning(ctx, 'c'));

  const resumed = payloads[2].reasoning.entriesDelta[0];
  assert.equal(resumed.text, 'abc');
  assert.ok(!Object.hasOwn(resumed, 'baseLength'));

  const state = createProducerRendererState();
  for (const payload of payloads) {
    mergeProducerFrame(state, { payload });
  }
  assert.equal(state.message.reasoning.entries[0].text, 'abc');
});

test('reasoning wire stays snapshot-only while stream envelope v2 is enabled', (t) => {
  let nowMs = 675_000;
  t.mock.method(Date, 'now', () => nowMs);
  const ctx = makeReasoningProducerCtx(true);
  ctx.service.featureFlags.stream_envelope_v2 = true;

  const entries = [];
  for (const delta of ['a', 'b', 'c']) {
    entries.push(emitProducerReasoning(ctx, delta).reasoning.entriesDelta[0]);
    nowMs += 50;
  }

  assert.ok(entries.every((entry) => (
    Object.hasOwn(entry, 'text')
    && !Object.hasOwn(entry, 'baseLength')
  )));
  assert.equal(ctx.reasoningWireLast, undefined);
});

test('reasoning wire computes edits from receiver-visible trimmed text', (t) => {
  let nowMs = 690_000;
  t.mock.method(Date, 'now', () => nowMs);
  const ctx = makeReasoningProducerCtx(true);
  const snapshotPayload = emitProducerReasoning(ctx, 'abc');
  const snapshot = snapshotPayload.reasoning.entriesDelta[0];

  // Exercise a whitespace-ending emitted base even though today's sanitizer
  // normally trims it before this seam.
  const receiverSnapshotPayload = {
    ...snapshotPayload,
    reasoning: {
      ...snapshotPayload.reasoning,
      entriesDelta: [{ ...snapshot, text: `${snapshot.text} ` }],
    },
  };
  ctx.reasoningWireLast.text += ' ';
  nowMs += 50;
  const editPayload = emitProducerReasoning(ctx, ' def');
  const edit = editPayload.reasoning.entriesDelta[0];

  assert.deepEqual({
    baseLength: edit.baseLength,
    baseTail: edit.baseTail,
    append: edit.append,
  }, {
    baseLength: 3,
    baseTail: 'abc',
    append: ' def',
  });
  assert.equal(ctx.reasoningWireLast.text, 'abc def');

  const state = createProducerRendererState();
  mergeProducerFrame(state, { payload: receiverSnapshotPayload });
  assert.equal(mergeProducerFrame(state, { payload: editPayload }), 'abc def');
});

test('reasoning wire flag OFF is byte-identical to an absent flag', (t) => {
  const fixedTimestamp = '2026-09-05T12:00:00.000Z';
  t.mock.method(Date, 'now', () => 700_000);
  t.mock.method(Date.prototype, 'toISOString', () => fixedTimestamp);
  t.mock.method(Math, 'random', () => 0.5);
  const disabledCtx = makeReasoningProducerCtx(false);
  const absentCtx = makeReasoningProducerCtx(undefined);

  for (let index = 0; index < 100; index += 1) {
    const delta = String.fromCharCode(97 + (index % 26)).repeat(1 + (index % 9));
    emitProducerReasoning(disabledCtx, delta);
    emitProducerReasoning(absentCtx, delta);
  }

  const disabledPayloads = producerReasoningPayloads(disabledCtx);
  const absentPayloads = producerReasoningPayloads(absentCtx);
  assert.deepEqual(disabledPayloads, absentPayloads);
  assert.ok(disabledPayloads.every((payload) => (
    !Object.hasOwn(payload.reasoning.entriesDelta[0], 'baseLength')
    && !Object.hasOwn(payload.reasoning.entriesDelta[0], 'append')
  )));
  assert.equal(disabledCtx.reasoningWireLast, undefined);
  assert.equal(absentCtx.reasoningWireLast, undefined);
});
