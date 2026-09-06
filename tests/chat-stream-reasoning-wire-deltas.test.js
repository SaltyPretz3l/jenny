const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REASONING_EDIT_BASE_TAIL_CHARS,
  buildReasoningEntryContentKey,
  buildReasoningEntryMergeIndexes,
  mergeReasoningEntriesInto,
  resolveReasoningEntryEdits,
} = require('../renderer/chat/renderer-reasoning-entry-merge-utils');
const { mergeReasoningEntries } = require('../renderer/chat/chat-message-utils');
const {
  createReasoningStreamMerger,
} = require('../renderer/chat/renderer-stream-handler-reasoning-merge');
const { createChatStreamBridge } = require('../services/chat-stream-bridge');
const { projectLegacyStreamPayload } = require('../services/stream-envelope-parity');

function createMergeState(entries = []) {
  const { indexById, contentKeyCounts } = buildReasoningEntryMergeIndexes(entries);
  return { entries, indexById, contentKeyCounts };
}

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

function coalesceReasoningEntries(frames) {
  const sent = [];
  let flush = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(channel, payload) {
      sent.push({ channel, payload });
    },
    log() {},
    setCoalesceTimer(callback) {
      flush = callback;
      return 'timer';
    },
    clearCoalesceTimer() {
      flush = null;
    },
  });
  for (const entriesDelta of frames) {
    bridge.handleEvent({
      type: 'delta',
      streamId: 'stream-wire-coalesce',
      reasoning: { source: 'provider', entriesDelta },
    });
  }
  assert.equal(typeof flush, 'function');
  flush();
  assert.equal(sent.length, 1);
  return sent[0].payload.reasoning.entriesDelta;
}

test('reasoning merge primitive applies edits, re-keys, drops mismatches, and heals', () => {
  const snapshot = { id: 'r1', text: 'Hello', timestamp: 't1' };
  const state = createMergeState();
  mergeReasoningEntriesInto(state, [snapshot]);
  mergeReasoningEntriesInto(state, [
    { id: 'r1', baseLength: 5, baseTail: 'Hello', append: ' world', timestamp: 't2' },
  ]);

  assert.equal(state.entries[0].text, 'Hello world');
  assert.equal(state.contentKeyCounts.has(buildReasoningEntryContentKey(snapshot)), false);
  assert.equal(state.contentKeyCounts.has(buildReasoningEntryContentKey(state.entries[0])), true);

  mergeReasoningEntriesInto(state, [{ id: 'r2', text: 'Hello', timestamp: 't1' }]);
  assert.deepEqual(state.entries.map((entry) => entry.text), ['Hello world', 'Hello']);

  mergeReasoningEntriesInto(state, [{ id: 'r1', baseLength: 3, baseTail: 'Hel', append: ' stale' }]);
  assert.equal(state.entries[0].text, 'Hello world');
  assert.equal(state.editMismatches, 1);

  mergeReasoningEntriesInto(state, [{ id: 'unknown', baseLength: 0, baseTail: '', append: 'lost' }]);
  assert.equal(state.entries.length, 2);
  assert.equal(state.editMismatches, 2);

  mergeReasoningEntriesInto(state, [{ id: 'r1', text: 'Healed', timestamp: 't3' }]);
  assert.equal(state.entries[0].text, 'Healed');
  mergeReasoningEntriesInto(state, [
    { id: 'r1', baseLength: 6, baseTail: 'Healed', append: '', timestamp: 't4' },
  ]);
  assert.equal(state.entries[0].text, 'Healed');
  assert.equal(state.entries[0].timestamp, 't4');
});

test('chat message reasoning normalization preserves valid edits and drops an empty id', () => {
  const merged = mergeReasoningEntries(
    [{ id: 'r1', text: 'abc' }],
    [{ id: 'r1', baseLength: 3, baseTail: 'abc', append: 'def' }]
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, 'abcdef');

  const unchanged = mergeReasoningEntries(
    [{ id: 'r1', text: 'abc' }],
    [{ id: '', baseLength: 3, baseTail: 'abc', append: 'def' }]
  );
  assert.deepEqual(unchanged.map((entry) => entry.text), ['abc']);
});

test('reasoning stream merger applies edits and logs a stale base once before healing', () => {
  const logs = [];
  const merger = createDirectReasoningMerger({
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });
  const message = {
    id: 'assistant-wire-edits',
    reasoning: { source: 'provider', entries: [] },
  };
  const frames = [
    { id: 'r1', text: 'A', timestamp: 't1' },
    { id: 'r1', baseLength: 1, baseTail: 'A', append: 'B', timestamp: 't2' },
    { id: 'r1', baseLength: 2, baseTail: 'AB', append: 'C', timestamp: 't3' },
    { id: 'r1', baseLength: 3, baseTail: 'ABC', append: 'D', timestamp: 't4' },
    { id: 'r1', baseLength: 1, baseTail: 'A', append: 'E', timestamp: 't5' },
    { id: 'r1', text: 'ABCDEF', timestamp: 't6' },
  ];
  const expected = ['A', 'AB', 'ABC', 'ABCD', 'ABCD', 'ABCDEF'];

  frames.forEach((entry, index) => {
    message.reasoning = merger.merge('stream-wire-edits', message, {
      source: 'provider',
      entriesDelta: [entry],
    });
    assert.equal(message.reasoning.entries[0].text, expected[index], `frame ${index + 1}`);
  });

  assert.deepEqual(logs.map(({ level, event }) => ({ level, event })), [{
    level: 'WARN',
    event: 'stream.reasoning_edit_base_mismatch',
  }]);
  assert.equal(logs[0].details.streamId, 'stream-wire-edits');
  assert.equal(logs[0].details.messageId, 'assistant-wire-edits');
  assert.equal(logs[0].details.mismatches, 1);
});

test('reasoning edits require base identity', () => {
  assert.equal(REASONING_EDIT_BASE_TAIL_CHARS, 64);
  const state = createMergeState([{ id: 'r1', text: 'abc' }]);
  mergeReasoningEntriesInto(state, [
    { id: 'r1', baseLength: 3, append: 'd' },
    { id: 'r1', baseLength: 3, baseTail: 'wrong', append: 'd' },
  ]);
  assert.equal(state.entries[0].text, 'abc');
  assert.equal(state.editMismatches, 2);
});

test('dropped retraction base tail prevents equal-length reasoning corruption', () => {
  const logs = [];
  const merger = createDirectReasoningMerger({
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });
  const message = {
    id: 'assistant-dropped-retraction',
    reasoning: { source: 'provider', entries: [] },
  };
  message.reasoning = merger.merge('stream-dropped-retraction', message, {
    source: 'provider',
    entriesDelta: [{ id: 'r1', text: 'abc<thi' }],
  });
  // The producer emitted abcWXYZ as a retraction snapshot, but that frame was dropped.
  message.reasoning = merger.merge('stream-dropped-retraction', message, {
    source: 'provider',
    entriesDelta: [{ id: 'r1', baseLength: 7, baseTail: 'abcWXYZ', append: 'Q' }],
  });
  assert.equal(message.reasoning.entries[0].text, 'abc<thi');
  assert.equal(logs[0].details.mismatches, 1);

  message.reasoning = merger.merge('stream-dropped-retraction', message, {
    source: 'provider',
    entriesDelta: [{ id: 'r1', text: 'abcWXYZQ' }],
  });
  assert.equal(message.reasoning.entries[0].text, 'abcWXYZQ');
});

test('reasoning edit resolver evolves its base through an ordered mixed frame', () => {
  const resolved = resolveReasoningEntryEdits([
    { id: 'r1', text: 'xyz' },
    { id: 'r1', baseLength: 3, baseTail: 'xyz', append: 'd' },
  ], []);

  assert.equal(resolved.mismatches, 0);
  assert.equal(resolved.entries.at(-1).text, 'xyzd');
});

test('reasoning stream merger preserves mixed-frame order', () => {
  const merger = createDirectReasoningMerger({ appendClientLog() {} });
  const message = {
    id: 'assistant-mixed-order',
    reasoning: { source: 'provider', entries: [{ id: 'r1', text: 'abc' }] },
  };
  message.reasoning = merger.merge('stream-mixed-order', message, {
    source: 'provider',
    entriesDelta: [
      { id: 'r1', baseLength: 3, baseTail: 'abc', append: 'd' },
      { id: 'r1', text: 'xyz' },
    ],
  });

  assert.equal(message.reasoning.entries[0].text, 'xyz');
});

test('chat stream bridge coalesces compatible edits and preserves snapshot authority', () => {
  assert.deepEqual(coalesceReasoningEntries([
    [{ id: 'r1', baseLength: 3, baseTail: 'abc', append: 'd', timestamp: 't1' }],
    [{ id: 'r1', baseLength: 4, baseTail: 'abcd', append: 'e', timestamp: 't2' }],
  ]), [
    { id: 'r1', baseLength: 3, baseTail: 'abc', append: 'de', timestamp: 't2' },
  ]);

  const folded = coalesceReasoningEntries([
    [{ id: 'r1', text: 'abc', timestamp: 't1', thinkingId: 'old' }],
    [{ id: 'r1', baseLength: 3, baseTail: 'abc', append: 'd', timestamp: 't2', thinkingId: 'new' }],
  ]);
  assert.deepEqual(folded, [
    { id: 'r1', text: 'abcd', timestamp: 't2', thinkingId: 'new' },
  ]);
  assert.equal(Object.hasOwn(folded[0], 'baseLength'), false);
  assert.equal(Object.hasOwn(folded[0], 'append'), false);

  assert.deepEqual(coalesceReasoningEntries([
    [{ id: 'r1', text: 'abc', timestamp: 't1' }],
    [{ id: 'r1', baseLength: 2, baseTail: 'bc', append: 'd', timestamp: 't2' }],
  ]), [
    { id: 'r1', text: 'abc', timestamp: 't1' },
  ]);

  assert.deepEqual(coalesceReasoningEntries([
    [{ id: 'r1', baseLength: 3, baseTail: 'abc', append: 'd', timestamp: 't1' }],
    [{ id: 'r1', text: 'snapshot', timestamp: 't2' }],
  ]), [
    { id: 'r1', text: 'snapshot', timestamp: 't2' },
  ]);

  assert.deepEqual(coalesceReasoningEntries([
    [{ id: 'r1', text: 'abc', timestamp: 't1' }],
    [{ id: 'r1', baseLength: 3, baseTail: 'xyz', append: 'd', timestamp: 't2' }],
  ]), [
    { id: 'r1', text: 'abc', timestamp: 't1' },
  ]);

  assert.deepEqual(coalesceReasoningEntries([
    [{ id: 'r1', baseLength: 3, baseTail: 'abc', append: 'd', timestamp: 't1' }],
    [{ id: 'r1', baseLength: 4, baseTail: 'abce', append: 'f', timestamp: 't2' }],
  ]), [
    { id: 'r1', baseLength: 4, baseTail: 'abce', append: 'f', timestamp: 't2' },
  ]);
});

test('300 reasoning wire frames stay stale after a mismatch and heal at the next snapshot', (t) => {
  let nowMs = 100_000;
  t.mock.method(Date, 'now', () => nowMs);
  let flush = null;
  const message = {
    id: 'assistant-wire-round-trip',
    reasoning: { source: 'provider', entries: [] },
  };
  const merger = createDirectReasoningMerger({ appendClientLog() {} });
  const bridge = createChatStreamBridge({
    sendBridgeEvent(channel, payload) {
      assert.equal(channel, 'chat.onStream');
      message.reasoning = merger.merge(payload.streamId, message, payload.reasoning);
    },
    log() {},
    setCoalesceTimer(callback, delayMs) {
      assert.equal(delayMs, 50);
      flush = callback;
      return 'timer';
    },
    clearCoalesceTimer() {
      flush = null;
    },
  });
  let oracle = '';
  let staleText = '';

  for (let frameIndex = 0; frameIndex < 300; frameIndex += 1) {
    const chunk = String.fromCharCode(97 + (frameIndex % 26)).repeat(1 + (frameIndex % 5));
    const baseLength = oracle.length;
    oracle += chunk;
    const timestamp = new Date(nowMs).toISOString();
    const entry = frameIndex % 40 === 0
      ? { id: 'r1', text: oracle, timestamp }
      : {
          id: 'r1',
          baseLength: frameIndex === 150 ? baseLength - 1 : baseLength,
          baseTail: oracle.slice(0, baseLength).slice(-REASONING_EDIT_BASE_TAIL_CHARS),
          append: chunk,
          timestamp,
        };
    bridge.handleEvent({
      type: 'delta',
      streamId: 'stream-wire-round-trip',
      reasoning: { source: 'provider', entriesDelta: [entry] },
    });
    nowMs += 50;
    assert.equal(typeof flush, 'function');
    const flushFrame = flush;
    flush = null;
    flushFrame();

    if (frameIndex === 149) staleText = oracle;
    const expected = frameIndex >= 150 && frameIndex < 160 ? staleText : oracle;
    assert.equal(
      message.reasoning.entries[0].text,
      expected,
      `frame ${frameIndex + 1}`
    );
  }
});

test('stream envelope parity applies matching edits and skips mismatches without poisoning the base', () => {
  const projection = {
    content: '',
    reasoningEntries: [],
    phases: [],
    tools: [],
    terminalStatus: '',
    reasoningEditMismatches: 0,
  };
  projectLegacyStreamPayload(projection, {
    type: 'delta',
    reasoning: {
      entriesDelta: [{ id: 'r1', text: 'abc', timestamp: 't1' }],
    },
  });
  projectLegacyStreamPayload(projection, {
    type: 'delta',
    reasoning: {
      entriesDelta: [{ id: 'r1', baseLength: 3, baseTail: 'abc', append: 'def', timestamp: 't2' }],
    },
  });
  assert.deepEqual(projection.reasoningEntries, [
    { id: 'r1', text: 'abcdef', timestamp: 't1' },
  ]);

  const mismatch = { id: 'r1', baseLength: 6, baseTail: 'wrong', append: 'stale', timestamp: 't3' };
  projectLegacyStreamPayload(projection, {
    type: 'delta',
    reasoning: { entriesDelta: [mismatch] },
  });
  projectLegacyStreamPayload(projection, {
    type: 'delta',
    reasoning: {
      entriesDelta: [{ id: 'r1', baseLength: 6, baseTail: 'abcdef', append: 'g' }],
    },
  });
  assert.deepEqual(projection.reasoningEntries, [
    { id: 'r1', text: 'abcdefg', timestamp: 't1' },
  ]);
  assert.equal(projection.reasoningEditMismatches, 1);
});
