const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStreamEnvelopeReceiptTracker,
  createStreamEnvelopeSequenceGuard,
  streamEnvelopeToLegacyPayload,
} = require('../renderer/chat/renderer-stream-envelope-v2');
const {
  buildEnvelopeSources,
  mergeStreamEnvelopeDeltas,
} = require('../services/stream-envelope-shape');

test('reasoning envelope coalescing replaces matching entry snapshots by id', () => {
  const envelope = (entriesDelta) => ({
    sequence: 1,
    channelSequence: 1,
    payload: { entriesDelta },
  });
  const merged = mergeStreamEnvelopeDeltas(
    envelope([{ id: 'same', text: 'old' }, { id: 'first', text: 'first' }]),
    envelope([{ id: 'same', text: 'new' }, { id: 'second', text: 'second' }]),
  );

  assert.deepEqual(merged.payload.entriesDelta, [
    { id: 'same', text: 'new' },
    { id: 'first', text: 'first' },
    { id: 'second', text: 'second' },
  ]);
});

test('W2-1: tool_output_chunk envelopes classify as tool/progress and round-trip without coalescing', () => {
  // Sidecar → bridge classification: eventKind must NOT be "delta" — delta
  // envelopes coalesce via a payload merge that replaces `lines`, which would
  // silently drop earlier live-output batches.
  const sources = buildEnvelopeSources({
    type: 'tool_output_chunk',
    streamId: 'stream-chunk',
    callId: 'call-1',
    lines: [{ stream: 'stdout', text: 'live' }],
    partial: 'progress 42%',
  }, 'tool_output_chunk');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].channel, 'tool');
  assert.equal(sources[0].eventKind, 'progress');

  // Renderer unwrap: a progress envelope must fall through to the generic
  // branch and restore the original chat-stream type.
  const legacy = streamEnvelopeToLegacyPayload({
    schemaVersion: 2,
    streamId: 'stream-chunk',
    sessionId: 'session-1',
    channel: 'tool',
    eventKind: 'progress',
    payload: sources[0].payload,
  });
  assert.ok(legacy);
  assert.equal(legacy.type, 'tool_output_chunk');
  assert.deepEqual(legacy.lines, [{ stream: 'stdout', text: 'live' }]);
  assert.equal(legacy.partial, 'progress 42%');
});

test('context_usage envelopes classify as control/progress and round-trip without coalescing', () => {
  // Same class as tool_output_chunk: a rapid stream of ephemeral readings on
  // one channel must NOT classify as "delta", or successive snapshots merge
  // into a single payload and the composer ring stops tracking the turn.
  const params = {
    type: 'context_usage',
    streamId: 'stream-ring',
    phase: 'iteration',
    iteration: 2,
    usage: { context_used_tokens: 9000, compact_threshold_tokens: 20000 },
  };
  const sources = buildEnvelopeSources(params, 'context_usage');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].channel, 'control');
  assert.equal(sources[0].eventKind, 'progress');

  const legacy = streamEnvelopeToLegacyPayload({
    schemaVersion: 2,
    streamId: 'stream-ring',
    sessionId: 'session-1',
    channel: 'control',
    eventKind: 'progress',
    payload: sources[0].payload,
  });
  assert.ok(legacy);
  assert.equal(legacy.type, 'context_usage');
  assert.equal(legacy.iteration, 2);
  assert.deepEqual(legacy.usage, params.usage, 'the meter reading survives the round trip');
  // Known, pre-existing collision shared with context_compacted: `common`
  // overwrites a payload's top-level `phase` with the envelope's structured
  // phase (null here). Harmless for this event — the store maps any
  // non-'preflight' value to 'iteration', and both are equally non-terminal,
  // so precedence is unaffected. Do not "fix" it by renaming the wire field
  // without also moving context_compacted.
  assert.equal(legacy.phase, null);
});

test('renderer V2 sequence guard bounds abandoned stream sequence state', () => {
  const logs = [];
  const guard = createStreamEnvelopeSequenceGuard({
    maxStreams: 2,
    appendClientLog(level, eventName, details) {
      logs.push({ level, eventName, details });
    },
  });

  const envelope = (streamId, sequence) => ({
    streamId,
    sequence,
    sequenceEnd: sequence,
    channel: 'response',
    channelSequence: sequence,
    channelSequenceEnd: sequence,
  });
  assert.equal(guard.shouldAccept(envelope('stream-a', 1)), true);
  assert.equal(guard.shouldAccept(envelope('stream-b', 1)), true);
  assert.equal(guard.shouldAccept(envelope('stream-c', 1)), true);

  assert.equal(
    guard.shouldAccept(envelope('stream-b', 1)),
    false,
    'retained stream sequence regressions must still be rejected'
  );
  assert.equal(
    guard.shouldAccept(envelope('stream-a', 1)),
    true,
    'oldest abandoned stream should be evicted once the cap is exceeded'
  );
  assert.equal(
    logs.some((entry) => entry.eventName === 'stream.envelope_v2_sequence_state_pruned'),
    true
  );
});

test('renderer V2 sequence guard bounds poisoned malformed stream state', () => {
  const guard = createStreamEnvelopeSequenceGuard({ maxStreams: 2, appendClientLog() {} });

  for (const streamId of ['bad-1', 'bad-2', 'bad-3']) {
    assert.equal(guard.shouldAccept({
      streamId, sequence: 0, channel: 'response', channelSequence: 1,
    }), false);
  }

  assert.equal(guard.consumeFault('bad-1'), '', 'oldest poisoned stream is pruned at the cap');
  assert.equal(guard.consumeFault('bad-2'), 'invalid_sequence');
  assert.equal(guard.consumeFault('bad-3'), 'invalid_sequence');
});

test('renderer V2 receipt tracker bounds abandoned stream receipt state', () => {
  const logs = [];
  const acks = [];
  const tracker = createStreamEnvelopeReceiptTracker({
    maxStreams: 2,
    sendAck(record) {
      acks.push(record);
    },
    appendClientLog(level, eventName, details) {
      logs.push({ level, eventName, details });
    },
  });

  tracker.beginSubscription(7, 'envelope');
  acks.length = 0;

  tracker.noteEnvelope({ streamId: 'stream-a' });
  tracker.noteEnvelope({ streamId: 'stream-b' });
  tracker.noteEnvelope({ streamId: 'stream-c' });

  assert.equal(tracker.size(), 2);
  tracker.flushAck({ streamId: 'stream-b', eventKind: 'terminal', payload: { type: 'complete' } });
  assert.deepEqual(acks, [{
    recordType: 'terminal_receipt',
    rendererEpoch: 7,
    streamId: 'stream-b',
    receivedCount: 1,
    terminalType: 'complete',
    eventKind: 'terminal',
    sequenceStart: null,
    sequenceEnd: null,
    channels: {},
  }]);
  assert.equal(
    logs.some((entry) => entry.eventName === 'stream.envelope_v2_receipt_state_pruned'),
    true
  );
});

test('renderer V2 receipt tracker counts and acks buffered envelopes only after replay (finding #8)', () => {
  const acks = [];
  const tracker = createStreamEnvelopeReceiptTracker({
    sendAck(record) { acks.push(record); },
    appendClientLog() {},
  });
  tracker.beginSubscription(9, 'envelope');
  acks.length = 0;

  // Three envelopes buffered during the bootstrap race (incl. the terminal): no
  // ack should fire and they must not be counted until replay.
  tracker.noteBufferedEnvelope({ streamId: 'stream-x', eventKind: 'delta' });
  tracker.noteBufferedEnvelope({ streamId: 'stream-x', eventKind: 'delta' });
  tracker.noteBufferedEnvelope({ streamId: 'stream-x', eventKind: 'terminal', payload: { type: 'complete' } });
  assert.equal(acks.length, 0);

  // After the buffer replays, all three count and the terminal acks once.
  tracker.flushBufferedReceipts('stream-x');
  assert.deepEqual(acks, [{
    recordType: 'terminal_receipt',
    rendererEpoch: 9,
    streamId: 'stream-x',
    receivedCount: 3,
    terminalType: 'complete',
    eventKind: 'terminal',
    sequenceStart: null,
    sequenceEnd: null,
    channels: {},
  }]);

  // A flush with nothing buffered is a no-op (no spurious ack).
  tracker.flushBufferedReceipts('stream-y');
  assert.equal(acks.length, 1);
});

test('renderer V2 buffered receipt proof stays payload-free and faults instead of acknowledging degradation', () => {
  const records = [];
  const tracker = createStreamEnvelopeReceiptTracker({ sendAck(record) { records.push(record); } });
  tracker.beginSubscription(10, 'envelope');
  records.length = 0;

  for (let sequence = 1; sequence <= 1_000; sequence += 1) {
    tracker.noteBufferedEnvelope({
      streamId: 'stream-bounded', sessionId: 'session-bounded', turnId: 'turn-bounded',
      eventKind: 'delta', channel: 'response', sequence, channelSequence: sequence,
      payload: { delta: 'x'.repeat(10_000) },
    });
  }
  tracker.noteBufferedEnvelope({
    streamId: 'stream-bounded', sessionId: 'session-bounded', turnId: 'turn-bounded',
    eventKind: 'terminal', channel: 'control', sequence: 1_001, channelSequence: 1,
    payload: { type: 'complete', content: 'x'.repeat(10_000) },
  });

  tracker.faultBufferedReceipts('stream-bounded', 'buffer_replay_degraded');
  assert.deepEqual(records, [{
    recordType: 'stream_fault', rendererEpoch: 10, streamId: 'stream-bounded',
    session_id: 'session-bounded', turn_id: 'turn-bounded', reason: 'buffer_replay_degraded',
  }]);
  tracker.flushBufferedReceipts('stream-bounded');
  assert.equal(records.length, 1, 'degraded replay must never emit a terminal receipt');
});

test('renderer V2 sequence guard poisons forward and per-channel gaps', () => {
  const logs = [];
  const guard = createStreamEnvelopeSequenceGuard({
    appendClientLog(level, eventName, details) { logs.push({ level, eventName, details }); },
  });
  assert.equal(guard.shouldAccept({
    streamId: 'stream-gap', sequence: 1, channel: 'response', channelSequence: 1,
  }), true);
  assert.equal(guard.shouldAccept({
    streamId: 'stream-gap', sequence: 3, channel: 'response', channelSequence: 2,
  }), false);
  assert.equal(guard.consumeFault('stream-gap'), 'sequence_gap');
  assert.equal(guard.shouldAccept({
    streamId: 'stream-gap', sequence: 2, channel: 'response', channelSequence: 2,
  }), false, 'a later suffix cannot repair a poisoned stream');

  assert.equal(guard.shouldAccept({
    streamId: 'stream-channel-gap', sequence: 1, channel: 'response', channelSequence: 2,
  }), false);
  assert.equal(guard.consumeFault('stream-channel-gap'), 'channel_sequence_gap');
  assert.equal(logs.some((entry) => entry.eventName === 'stream.envelope_v2_sequence_gap'), true);
});

test('renderer V2 sequence guard tolerates sequence-less envelopes with a one-shot diagnostic', () => {
  // A producer that omits sequence stamping must not poison the stream: the
  // poison path drops the entire renderer to legacy mode. Sequence-less
  // envelopes pass through without advancing the guard's expectations, and
  // the omission is logged once per stream.
  const logs = [];
  const guard = createStreamEnvelopeSequenceGuard({
    appendClientLog(level, eventName, details) { logs.push({ level, eventName, details }); },
  });
  const bare = { streamId: 'stream-bare', channel: 'response', eventKind: 'delta' };
  assert.equal(guard.shouldAccept(bare), true);
  assert.equal(guard.shouldAccept(bare), true);
  assert.equal(guard.consumeFault('stream-bare'), '', 'no fault recorded');
  const missingLogs = logs.filter((entry) => entry.eventName === 'stream.envelope_v2_sequence_missing');
  assert.equal(missingLogs.length, 1, 'diagnostic is one-shot per stream');
  assert.equal(missingLogs[0].details.eventKind, 'delta');

  // Sequenced envelopes on the same stream still validate from sequence 1.
  assert.equal(guard.shouldAccept({
    streamId: 'stream-bare', sequence: 1, channel: 'response', channelSequence: 1,
  }), true);

  // The synthetic started envelope stays exempt from the diagnostic.
  assert.equal(guard.shouldAccept({ streamId: 'stream-started', eventKind: 'started' }), true);
  assert.equal(
    logs.filter((entry) => entry.eventName === 'stream.envelope_v2_sequence_missing').length,
    1
  );
});

test('renderer V2 sequence guard logs invalid sequence values under the invalid event name', () => {
  const logs = [];
  const guard = createStreamEnvelopeSequenceGuard({
    appendClientLog(level, eventName, details) { logs.push({ level, eventName, details }); },
  });
  assert.equal(guard.shouldAccept({
    streamId: 'stream-invalid', sequence: 0, channel: 'response', channelSequence: 1,
  }), false);
  assert.equal(guard.consumeFault('stream-invalid'), 'invalid_sequence');
  const invalidLog = logs.find((entry) => entry.eventName === 'stream.envelope_v2_sequence_invalid');
  assert.ok(invalidLog, 'invalid sequences no longer masquerade as gaps');
  assert.equal(invalidLog.details.reason, 'invalid_sequence');
});

test('renderer V2 receipt proof includes exact ranges and channel coverage', () => {
  const records = [];
  const tracker = createStreamEnvelopeReceiptTracker({ sendAck(record) { records.push(record); } });
  tracker.beginSubscription(11, 'envelope');
  tracker.noteEnvelope({ streamId: 'proof', eventKind: 'started', channel: 'control' });
  tracker.noteEnvelope({
    streamId: 'proof', sequence: 1, sequenceEnd: 2,
    channel: 'response', channelSequence: 1, channelSequenceEnd: 2,
  });
  tracker.noteEnvelope({
    streamId: 'proof', sequence: 3, channel: 'control', channelSequence: 1,
    eventKind: 'terminal', payload: { type: 'complete' },
  });
  tracker.flushAck({ streamId: 'proof', eventKind: 'terminal', payload: { type: 'complete' } });
  assert.deepEqual(records.at(-1), {
    recordType: 'terminal_receipt', rendererEpoch: 11, streamId: 'proof', receivedCount: 3,
    sequenceStart: 1, sequenceEnd: 3,
    channels: {
      control: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
      response: { count: 1, sequenceStart: 1, sequenceEnd: 2 },
    },
    terminalType: 'complete', eventKind: 'terminal',
  });
});

test('renderer V2 receipts carry canonical recovery identity without changing proof fields', () => {
  const records = [];
  const tracker = createStreamEnvelopeReceiptTracker({ sendAck(record) { records.push(record); } });
  tracker.beginSubscription(12, 'envelope');
  tracker.noteEnvelope({
    streamId: 'identity-stream', sessionId: 'identity-session', turnId: 'identity-turn',
    sequence: 1, channel: 'control', channelSequence: 1,
    eventKind: 'terminal', payload: { type: 'complete' },
  });
  tracker.flushAck({
    streamId: 'identity-stream', sessionId: 'identity-session', turnId: 'identity-turn',
    eventKind: 'terminal', payload: { type: 'complete' },
  });
  assert.equal(records.at(-1).session_id, 'identity-session');
  assert.equal(records.at(-1).turn_id, 'identity-turn');
});

test('W3c: a reset envelope round-trips the whole stream_reset contract, not just the type', () => {
  // The reset branch used to return `{...common, type:'stream_reset'}` and drop
  // the envelope payload entirely, so with stream_envelope_v2 on EVERY reset
  // arrived reason-less and scope-less: the reducer read it as an unlabelled
  // discard and the post-reset id/segment alignment silently reverted.
  const sources = buildEnvelopeSources({
    type: 'stream_reset',
    streamId: 'stream-reset',
    reason: 'model_winddown',
    next_assistant_message_id: 'assistant_stream-reset_seg1',
    preserve_prior_segments: true,
    discard_scope: 'live_slice',
  }, 'stream_reset');
  assert.equal(sources.length, 1);
  assert.equal(sources[0].channel, 'control');
  assert.equal(sources[0].eventKind, 'reset');

  const legacy = streamEnvelopeToLegacyPayload({
    schemaVersion: 2,
    streamId: 'stream-reset',
    sessionId: 'session-1',
    channel: 'control',
    eventKind: 'reset',
    payload: sources[0].payload,
  });
  assert.ok(legacy);
  assert.equal(legacy.type, 'stream_reset');
  assert.equal(legacy.reason, 'model_winddown');
  assert.equal(legacy.next_assistant_message_id, 'assistant_stream-reset_seg1');
  assert.equal(legacy.preserve_prior_segments, true);
  assert.equal(legacy.discard_scope, 'live_slice');
  // Transport identity still comes from the envelope, never from the payload.
  assert.equal(legacy.streamId, 'stream-reset');
  assert.equal(legacy.sessionId, 'session-1');
});
