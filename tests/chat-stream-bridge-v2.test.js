const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatStreamBridge,
  MAX_STREAM_ENVELOPE_STATE_ENTRIES,
} = require('../services/chat-stream-bridge');

// Run a minimal started -> complete -> terminal-ack handshake so the bridge
// latches envelope consumption as proven and goes envelope-only. The bridge
// fail-opens (dual-emits legacy chat.onStream) until this first ack arrives.
function proveEnvelopeAck(bridge, streamId = 'stream-handshake') {
  bridge.recordEnvelopeAck({
    recordType: 'subscription_started',
    rendererEpoch: 1,
    mode: 'envelope',
  });
  bridge.handleEvent({ type: 'started', streamId, sessionId: 'session-handshake' });
  bridge.handleEvent({ type: 'complete', streamId, sessionId: 'session-handshake' });
  bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt',
    rendererEpoch: 1,
    streamId,
    receivedCount: 2,
    sequenceStart: 1,
    sequenceEnd: 1,
    channels: {
      control: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
    },
    terminalType: 'complete',
    eventKind: 'terminal',
  });
}

test('chat stream bridge emits gated V2 envelopes without mixing response and reasoning channels', () => {
  const sent = [];
  let nowMs = 60_000;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log() {},
    now: () => nowMs,
    isStreamEnvelopeV2Enabled: () => true,
  });
  proveEnvelopeAck(bridge, 'stream-v2-handshake');
  sent.length = 0;

  bridge.handleEvent({
    type: 'started',
    sessionId: 'session-v2',
    streamId: 'stream-v2',
    turnId: 'turn-v2',
    requestId: 'request-v2',
    traceId: 'trace-v2',
    model: 'mock-v2',
  });
  nowMs += 5;
  bridge.handleEvent({
    type: 'delta',
    sessionId: 'session-v2',
    streamId: 'stream-v2',
    turnId: 'turn-v2',
    requestId: 'request-v2',
    traceId: 'trace-v2',
    model: 'mock-v2',
    sequence: 1,
    channel: 'response',
    channelSequence: 1,
    phase: { phase_id: 'phase_text_1', phase_kind: 'text', iteration: 1 },
    content: 'Hello',
    aggregate: 'Hello',
  });
  nowMs += 5;
  bridge.handleEvent({
    type: 'delta',
    sessionId: 'session-v2',
    streamId: 'stream-v2',
    turnId: 'turn-v2',
    requestId: 'request-v2',
    traceId: 'trace-v2',
    model: 'mock-v2',
    sequence: 2,
    channel: 'reasoning',
    channelSequence: 1,
    phase: { phase_id: 'phase_reasoning_1', phase_kind: 'reasoning', iteration: 1 },
    reasoning: {
      source: 'provider',
      summary: 'Provider supplied summary',
      entriesDelta: [{ id: 'reason_1', text: 'Checking intent' }],
    },
    aggregate: 'Hello',
  });
  nowMs += 5;
  bridge.handleEvent({
    type: 'stream_reset',
    sessionId: 'session-v2',
    streamId: 'stream-v2',
    turnId: 'turn-v2',
    sequence: 3,
  });
  nowMs += 5;
  bridge.handleEvent({
    type: 'complete',
    sessionId: 'session-v2',
    streamId: 'stream-v2',
    turnId: 'turn-v2',
    sequence: 4,
    sequence_end: 6,
    channel_sequence_end: 2,
    emitted_at_ms: nowMs - 1,
  });

  const legacyMethods = sent.filter((entry) => entry.method === 'chat.onStream');
  const envelopes = sent
    .filter((entry) => entry.method === 'chat.onStreamEnvelope')
    .map((entry) => entry.payload);
  assert.equal(legacyMethods.length, 0);
  assert.equal(envelopes[0].schemaVersion, 2);
  assert.equal(envelopes[0].eventKind, 'started');
  assert.equal(envelopes[0].channel, 'control');
  assert.equal(envelopes[0].streamId, 'stream-v2');
  assert.equal(envelopes[0].turnId, 'turn-v2');

  const responseEnvelope = envelopes.find((entry) => entry.channel === 'response');
  const reasoningEnvelope = envelopes.find((entry) => entry.channel === 'reasoning');
  assert.ok(responseEnvelope);
  assert.ok(reasoningEnvelope);
  assert.equal(responseEnvelope.eventKind, 'delta');
  assert.equal(responseEnvelope.payload.delta, 'Hello');
  assert.equal(responseEnvelope.payload.aggregate, 'Hello');
  assert.equal(responseEnvelope.phase.phaseId, 'phase_text_1');
  assert.equal(responseEnvelope.sequence, 1);
  assert.equal(responseEnvelope.channelSequence, 1);

  assert.equal(reasoningEnvelope.eventKind, 'delta');
  assert.deepEqual(reasoningEnvelope.payload.entriesDelta, [{ id: 'reason_1', text: 'Checking intent' }]);
  assert.equal(reasoningEnvelope.payload.summary, 'Provider supplied summary');
  assert.equal(reasoningEnvelope.phase.phaseKind, 'reasoning');
  assert.equal(reasoningEnvelope.channelSequence, 1);

  const resetEnvelope = envelopes.find((entry) => entry.eventKind === 'reset');
  const terminalEnvelope = envelopes.find((entry) => entry.eventKind === 'terminal');
  assert.ok(resetEnvelope);
  assert.ok(terminalEnvelope);
  assert.equal(resetEnvelope.channel, 'control');
  assert.equal(terminalEnvelope.channel, 'control');
  assert.equal(Object.hasOwn(terminalEnvelope.payload, 'sequence_end'), false);
  assert.equal(Object.hasOwn(terminalEnvelope.payload, 'channel_sequence_end'), false);
  assert.equal(Object.hasOwn(terminalEnvelope.payload, 'emitted_at_ms'), false);
  assert.equal(terminalEnvelope.sequenceEnd, 6);
  assert.ok(resetEnvelope.bridgedAtMs >= resetEnvelope.emittedAtMs);
});

test('chat stream bridge keeps V2 receipt counts until terminal ack arrives', () => {
  const sent = [];
  const logs = [];
  let watchdog = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log(level, event, details) {
      logs.push({ level, event, details });
    },
    setReceiptWatchdog(fn) {
      watchdog = fn;
      return 'watchdog';
    },
    clearReceiptWatchdog() {
      watchdog = null;
    },
    isStreamEnvelopeV2Enabled: () => true,
  });
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 1, mode: 'envelope' });

  bridge.handleEvent({ type: 'started', streamId: 'stream-ack', sessionId: 'session-ack' });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-ack',
    sessionId: 'session-ack',
    sequence: 1,
    channel: 'response',
    channelSequence: 1,
    content: 'Hello',
  });
  bridge.handleEvent({ type: 'complete', streamId: 'stream-ack', sessionId: 'session-ack' });

  const receivedCount = sent.filter((entry) => entry.method === 'chat.onStreamEnvelope').length;
  assert.equal(receivedCount, 3);
  assert.ok(watchdog);

  bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt',
    rendererEpoch: 1,
    streamId: 'stream-ack',
    receivedCount,
    sequenceStart: 1,
    sequenceEnd: 2,
    channels: {
      control: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
      response: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
    },
    terminalType: 'complete',
    eventKind: 'terminal',
  });

  assert.equal(
    logs.some((entry) => entry.event === 'chat.stream_envelope_v2_ack_mismatch'),
    false
  );
  assert.equal(watchdog, null);
});

test('chat stream bridge ignores terminal ack after receipt watchdog cleanup', () => {
  const sent = [];
  const logs = [];
  let watchdog = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log(level, event, details) {
      logs.push({ level, event, details });
    },
    setReceiptWatchdog(fn) {
      watchdog = fn;
      return 'watchdog';
    },
    clearReceiptWatchdog() {
      watchdog = null;
    },
    isStreamEnvelopeV2Enabled: () => true,
  });
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 1, mode: 'envelope' });

  bridge.handleEvent({ type: 'started', streamId: 'stream-late-ack', sessionId: 'session-ack' });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-late-ack',
    sessionId: 'session-ack',
    sequence: 1,
    channel: 'response',
    channelSequence: 1,
    content: 'Hello',
  });
  bridge.handleEvent({ type: 'complete', streamId: 'stream-late-ack', sessionId: 'session-ack' });

  const receivedCount = sent.filter((entry) => entry.method === 'chat.onStreamEnvelope').length;
  assert.ok(watchdog);
  watchdog();
  assert.equal(
    logs.some((entry) => entry.event === 'chat.stream_envelope_v2_no_ack'),
    true
  );

  bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt',
    rendererEpoch: 1,
    streamId: 'stream-late-ack',
    receivedCount,
    terminalType: 'complete',
    eventKind: 'terminal',
  });

  assert.equal(
    logs.some((entry) => entry.event === 'chat.stream_envelope_v2_ack_mismatch'),
    false
  );
});

test('chat stream bridge does not count failed V2 envelope sends as delivered', () => {
  const logs = [];
  let watchdog = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method) {
      if (method === 'chat.onStreamEnvelope') {
        throw new Error('renderer send failed');
      }
    },
    log(level, event, details) {
      logs.push({ level, event, details });
    },
    setReceiptWatchdog(fn) {
      watchdog = fn;
      return 'watchdog';
    },
    clearReceiptWatchdog() {
      watchdog = null;
    },
    isStreamEnvelopeV2Enabled: () => true,
  });
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 1, mode: 'envelope' });

  bridge.handleEvent({ type: 'started', streamId: 'stream-send-fail', sessionId: 'session-send-fail' });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-send-fail',
    sessionId: 'session-send-fail',
    content: 'Hello',
  });
  bridge.handleEvent({ type: 'complete', streamId: 'stream-send-fail', sessionId: 'session-send-fail' });

  assert.equal(watchdog, null);
  bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt',
    rendererEpoch: 1,
    streamId: 'stream-send-fail',
    receivedCount: 0,
    terminalType: 'complete',
    eventKind: 'terminal',
  });
  assert.equal(
    logs.some((entry) => entry.event === 'chat.stream_envelope_v2_ack_mismatch'),
    false
  );
  assert.equal(
    logs.some((entry) => entry.event === 'chat.stream_envelope_v2_no_ack'),
    false
  );
  const summary = logs.find((entry) => entry.event === 'chat.stream_summary');
  assert.equal(summary?.details?.rendererForwardFailed, true);
});

test('chat stream bridge revokes promotion and delivers the same terminal through legacy on envelope failure', () => {
  const sent = [];
  let failEnvelope = false;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      if (failEnvelope && method === 'chat.onStreamEnvelope') {
        throw new Error('renderer envelope send failed');
      }
      sent.push({ method, payload });
    },
    log() {},
    isStreamEnvelopeV2Enabled: () => true,
  });
  proveEnvelopeAck(bridge, 'stream-promoted');
  sent.length = 0;
  failEnvelope = true;

  bridge.handleEvent({
    type: 'complete', streamId: 'stream-failed-terminal', sessionId: 'session-failed-terminal',
  });

  assert.equal(sent.some((entry) => (
    entry.method === 'chat.onStream' && entry.payload.type === 'complete'
  )), true);
  sent.length = 0;
  bridge.handleEvent({
    type: 'started', streamId: 'stream-after-forward-failure', sessionId: 'session-next',
  });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), true);
});

test('chat stream bridge retains recovery when both terminal delivery channels fail', () => {
  const sent = [];
  let failTerminalDelivery = false;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      if (failTerminalDelivery && ['chat.onStreamEnvelope', 'chat.onStream'].includes(method)) {
        throw new Error('terminal delivery failed');
      }
      sent.push({ method, payload });
    },
    log() {},
    isStreamEnvelopeV2Enabled: () => true,
  });
  proveEnvelopeAck(bridge, 'stream-promoted-before-total-failure');
  sent.length = 0;
  failTerminalDelivery = true;

  bridge.handleEvent({ type: 'complete', streamId: 'stream-total-failure',
    sessionId: 'session-total-failure', turnId: 'turn-total-failure' });
  assert.equal(sent.find((entry) => entry.method === 'chat.onStreamRecoveryRequired')?.payload?.reason, 'renderer_terminal_forward_failed');

  sent.length = 0;
  failTerminalDelivery = false;
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 2, mode: 'legacy' });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStreamRecoveryRequired'
    && entry.payload.stream_id === 'stream-total-failure'), true);
});

test('chat stream bridge dual-emits legacy stream events when V2 parity diagnostics are enabled', () => {
  const sent = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log() {},
    isStreamEnvelopeV2Enabled: () => true,
    enableStreamEnvelopeParityDiagnostics: () => true,
  });
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 1, mode: 'envelope' });

  bridge.handleEvent({ type: 'started', streamId: 'stream-parity', sessionId: 'session-parity' });
  bridge.handleEvent({ type: 'delta', streamId: 'stream-parity', sessionId: 'session-parity', content: 'A' });
  bridge.handleEvent({ type: 'complete', streamId: 'stream-parity', sessionId: 'session-parity' });

  assert.equal(sent.some((entry) => entry.method === 'chat.onStreamEnvelope'), true);
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), true);
});

test('chat stream bridge coalesces V2 deltas per stream channel and phase', () => {
  const sent = [];
  let pendingFn = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log() {},
    setCoalesceTimer(fn) { pendingFn = fn; return 'fake'; },
    clearCoalesceTimer() { pendingFn = null; },
    isStreamEnvelopeV2Enabled: () => true,
  });
  proveEnvelopeAck(bridge, 'stream-v2-coalesce-handshake');

  bridge.handleEvent({ type: 'started', streamId: 'stream-v2-coalesce', sessionId: 'session-v2-coalesce' });
  sent.length = 0;
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-v2-coalesce',
    sessionId: 'session-v2-coalesce',
    sequence: 1,
    channel: 'response',
    channelSequence: 1,
    phase: { phase_id: 'phase_text', phase_kind: 'text' },
    content: 'Hel',
    aggregate: 'Hel',
    tokenSequence: 0,
  });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-v2-coalesce',
    sessionId: 'session-v2-coalesce',
    sequence: 2,
    channel: 'response',
    channelSequence: 2,
    phase: { phase_id: 'phase_text', phase_kind: 'text' },
    content: 'lo',
    aggregate: 'Hello',
    tokenSequence: 1,
  });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-v2-coalesce',
    sessionId: 'session-v2-coalesce',
    sequence: 3,
    channel: 'reasoning',
    channelSequence: 1,
    phase: { phase_id: 'phase_reasoning', phase_kind: 'reasoning' },
    reasoning: { entriesDelta: [{ text: 'r1' }], summary: 'first' },
  });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-v2-coalesce',
    sessionId: 'session-v2-coalesce',
    sequence: 4,
    channel: 'reasoning',
    channelSequence: 2,
    phase: { phase_id: 'phase_reasoning', phase_kind: 'reasoning' },
    reasoning: { entriesDelta: [{ text: 'r2' }], summary: 'latest' },
  });

  assert.equal(sent.length, 0);
  assert.ok(pendingFn);
  pendingFn();

  const envelopes = sent
    .filter((entry) => entry.method === 'chat.onStreamEnvelope')
    .map((entry) => entry.payload);
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), false);
  assert.equal(envelopes.length, 2);
  const response = envelopes.find((entry) => entry.channel === 'response');
  const reasoning = envelopes.find((entry) => entry.channel === 'reasoning');
  assert.ok(response);
  assert.ok(reasoning);
  assert.equal(response.payload.delta, 'Hello');
  assert.equal(response.payload.aggregate, 'Hello');
  assert.equal(response.payload.tokenSequence, 1);
  assert.equal(response.sequence, 1);
  assert.equal(response.sequenceEnd, 2);
  assert.equal(response.channelSequence, 1);
  assert.equal(response.channelSequenceEnd, 2);
  assert.deepEqual(reasoning.payload.entriesDelta, [{ text: 'r1' }, { text: 'r2' }]);
  assert.equal(reasoning.payload.summary, 'latest');
  assert.equal(reasoning.sequence, 3);
  assert.equal(reasoning.sequenceEnd, 4);
  assert.equal(reasoning.channelSequence, 1);
  assert.equal(reasoning.channelSequenceEnd, 2);
});

test('chat stream bridge coalesces split V2 deltas without claiming interleaved sequence ranges', () => {
  const sent = [];
  const logs = [];
  let pendingFn = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log(level, event, details) {
      logs.push({ level, event, details });
    },
    setCoalesceTimer(fn) { pendingFn = fn; return 'fake'; },
    clearCoalesceTimer() { pendingFn = null; },
    isStreamEnvelopeV2Enabled: () => true,
  });

  bridge.handleEvent({ type: 'started', streamId: 'stream-v2-split-coalesce', sessionId: 'session-v2-split' });
  sent.length = 0;
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-v2-split-coalesce',
    sessionId: 'session-v2-split',
    sequence: 10,
    content: 'A',
    aggregate: 'A',
    reasoning: { entriesDelta: [{ text: 'r1' }] },
  });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-v2-split-coalesce',
    sessionId: 'session-v2-split',
    sequence: 11,
    content: 'B',
    aggregate: 'AB',
    reasoning: { entriesDelta: [{ text: 'r2' }] },
  });

  assert.ok(pendingFn);
  pendingFn();

  const envelopes = sent
    .filter((entry) => entry.method === 'chat.onStreamEnvelope')
    .map((entry) => entry.payload);
  const response = envelopes.find((entry) => entry.channel === 'response');
  const reasoning = envelopes.find((entry) => entry.channel === 'reasoning');
  assert.ok(response);
  assert.ok(reasoning);
  assert.equal(logs.some((entry) => entry.event === 'chat.stream_envelope_sequence_regression'), false);
  assert.equal(response.payload.delta, 'AB');
  assert.equal(response.payload.aggregate, 'AB');
  assert.deepEqual(reasoning.payload.entriesDelta, [{ text: 'r1' }, { text: 'r2' }]);
  assert.equal(response.sequence, 10);
  assert.equal(response.sequenceEnd, 10);
  assert.equal(reasoning.sequence, 11);
  assert.equal(reasoning.sequenceEnd, 11);
  assert.equal(response.channelSequence, 1);
  assert.equal(response.channelSequenceEnd, 2);
  assert.equal(reasoning.channelSequence, 1);
  assert.equal(reasoning.channelSequenceEnd, 2);
});

test('chat stream bridge filters phase metadata to the matching V2 channel when a payload splits', () => {
  const sent = [];
  let pendingFn = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log() {},
    setCoalesceTimer(fn) { pendingFn = fn; return 'fake'; },
    clearCoalesceTimer() { pendingFn = null; },
    isStreamEnvelopeV2Enabled: () => true,
  });

  bridge.handleEvent({ type: 'started', streamId: 'stream-phase-filter', sessionId: 'session-phase-filter' });
  sent.length = 0;
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-phase-filter',
    sessionId: 'session-phase-filter',
    sequence: 1,
    channel: 'reasoning',
    channelSequence: 1,
    phase: { phase_id: 'phase_reasoning', phase_kind: 'reasoning' },
    content: 'Visible',
    reasoning: { entriesDelta: [{ text: 'private' }] },
  });
  pendingFn();

  const envelopes = sent
    .filter((entry) => entry.method === 'chat.onStreamEnvelope')
    .map((entry) => entry.payload);
  const response = envelopes.find((entry) => entry.channel === 'response');
  const reasoning = envelopes.find((entry) => entry.channel === 'reasoning');
  assert.ok(response);
  assert.ok(reasoning);
  assert.equal(response.phase, null);
  assert.equal(reasoning.phase.phaseKind, 'reasoning');
});

test('chat stream bridge keeps V2 envelope sequence monotonic and logs regressions', () => {
  const sent = [];
  const logs = [];
  let pendingFn = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log(level, event, details) {
      logs.push({ level, event, details });
    },
    isStreamEnvelopeV2Enabled: () => true,
    setCoalesceTimer(fn) { pendingFn = fn; return 'fake'; },
    clearCoalesceTimer() { pendingFn = null; },
  });

  bridge.handleEvent({ type: 'started', streamId: 'stream-seq', sessionId: 'session-seq' });
  bridge.handleEvent({
    type: 'phase_started',
    streamId: 'stream-seq',
    sessionId: 'session-seq',
    sequence: 5,
    phaseId: 'phase-reasoning',
    phaseKind: 'reasoning',
  });
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-seq',
    sessionId: 'session-seq',
    sequence: 1,
    channel: 'response',
    channelSequence: 1,
    content: 'A',
    aggregate: 'A',
  });
  pendingFn();

  const envelopes = sent
    .filter((entry) => entry.method === 'chat.onStreamEnvelope')
    .map((entry) => entry.payload);
  const phaseEnvelope = envelopes.find((entry) => entry.eventKind === 'started' && entry.channel === 'phase');
  const responseEnvelope = envelopes.find((entry) => entry.channel === 'response');
  assert.equal(phaseEnvelope.sequence, 5);
  assert.equal(responseEnvelope.sequence, 6);
  assert.equal(logs.some((entry) => entry.event === 'chat.stream_envelope_sequence_regression'), true);
});

test('chat stream bridge bounds V2 envelope state for abandoned streams', () => {
  const sent = [];
  let pendingFn = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log() {},
    setCoalesceTimer(fn) { pendingFn = fn; return 'fake'; },
    clearCoalesceTimer() { pendingFn = null; },
    isStreamEnvelopeV2Enabled: () => true,
  });

  for (let index = 0; index < MAX_STREAM_ENVELOPE_STATE_ENTRIES + 4; index += 1) {
    bridge.handleEvent({
      type: 'started',
      streamId: `stream-cap-v2-${index}`,
      sessionId: 'session-cap-v2',
    });
  }
  sent.length = 0;
  bridge.handleEvent({
    type: 'delta',
    streamId: 'stream-cap-v2-0',
    sessionId: 'session-cap-v2',
    content: 'late',
    aggregate: 'late',
  });
  pendingFn();

  const envelopes = sent
    .filter((entry) => entry.method === 'chat.onStreamEnvelope')
    .map((entry) => entry.payload);
  assert.equal(envelopes[0].eventKind, 'started');
  assert.equal(envelopes[0].streamId, 'stream-cap-v2-0');
  assert.equal(envelopes[1].channel, 'response');
});

test('chat stream bridge suppresses streamless legacy-only events when V2 is the active path', () => {
  const sent = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload });
    },
    log() {},
    isStreamEnvelopeV2Enabled: () => true,
  });
  proveEnvelopeAck(bridge, 'stream-streamless-handshake');
  sent.length = 0;

  bridge.handleEvent({
    type: 'delta',
    sessionId: 'session-streamless',
    content: 'legacy only',
    aggregate: 'legacy only',
  });

  assert.equal(sent.some((entry) => entry.method === 'chat.onStreamEnvelope'), false);
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), false);
});

test('chat stream bridge fail-opens legacy stream events until the renderer proves envelope consumption', () => {
  const sent = [];
  const logs = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log(level, event, details) {
      logs.push({ level, event, details });
    },
    isStreamEnvelopeV2Enabled: () => true,
  });
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 1, mode: 'envelope' });

  // Turn 1: no ack recorded yet — legacy events must flow alongside envelopes,
  // otherwise a renderer still subscribed to chat:stream gets a dead chat.
  bridge.handleEvent({ type: 'started', streamId: 'stream-failopen-1', sessionId: 'session-failopen' });
  bridge.handleEvent({ type: 'complete', streamId: 'stream-failopen-1', sessionId: 'session-failopen' });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), true);
  assert.equal(sent.some((entry) => entry.method === 'chat.onStreamEnvelope'), true);

  bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt',
    rendererEpoch: 1,
    streamId: 'stream-failopen-1',
    receivedCount: 2,
    sequenceStart: 1,
    sequenceEnd: 1,
    channels: {
      control: { count: 1, sequenceStart: 1, sequenceEnd: 1 },
    },
    terminalType: 'complete',
    eventKind: 'terminal',
  });
  assert.equal(
    logs.some((entry) => entry.event === 'chat.stream_envelope_v2_ack_proven'),
    true
  );

  // Turn 2: consumption proven — the bridge goes envelope-only.
  sent.length = 0;
  bridge.handleEvent({ type: 'started', streamId: 'stream-failopen-2', sessionId: 'session-failopen' });
  bridge.handleEvent({ type: 'complete', streamId: 'stream-failopen-2', sessionId: 'session-failopen' });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), false);
  assert.equal(sent.filter((entry) => entry.method === 'chat.onStreamEnvelope').length, 2);
});

test('chat stream bridge preserves plan proposals as envelope terminals after promotion', () => {
  const sent = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log() {},
    isStreamEnvelopeV2Enabled: () => true,
  });
  proveEnvelopeAck(bridge, 'stream-plan-handshake');
  sent.length = 0;

  bridge.handleEvent({ type: 'started', streamId: 'stream-plan', sessionId: 'session-plan' });
  bridge.handleEvent({
    type: 'plan_proposal',
    streamId: 'stream-plan',
    sessionId: 'session-plan',
    plan: [{ step: 'Review', status: 'pending' }],
  });

  const planEnvelope = sent.find((entry) => (
    entry.method === 'chat.onStreamEnvelope'
    && entry.payload?.payload?.type === 'plan_proposal'
  ));
  assert.ok(planEnvelope);
  assert.equal(planEnvelope.payload.eventKind, 'terminal');
});

test('chat stream bridge refuses promotion for mismatched or stale terminal receipts', () => {
  const sent = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) { sent.push({ method, payload }); },
    log() {},
    isStreamEnvelopeV2Enabled: () => true,
  });
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 4, mode: 'envelope' });
  bridge.handleEvent({ type: 'started', streamId: 'bad-proof', sessionId: 'session-proof' });
  bridge.handleEvent({ type: 'complete', streamId: 'bad-proof', sessionId: 'session-proof' });
  const mismatch = bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt', rendererEpoch: 4, streamId: 'bad-proof',
    session_id: 'session-proof',
    receivedCount: 1, sequenceStart: 1, sequenceEnd: 1,
    channels: { control: { count: 1, sequenceStart: 1, sequenceEnd: 1 } },
    terminalType: 'complete', eventKind: 'terminal',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.recovery_ticket_issued, true);
  assert.equal(sent.some((entry) => (
    entry.method === 'chat.onStreamRecoveryRequired'
    && entry.payload.stream_id === 'bad-proof'
    && entry.payload.session_id === 'session-proof'
  )), true);

  sent.length = 0;
  bridge.handleEvent({ type: 'started', streamId: 'after-mismatch', sessionId: 'session-proof' });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), true);

  const stale = bridge.recordEnvelopeAck({
    recordType: 'stream_fault', rendererEpoch: 3, streamId: 'after-mismatch', reason: 'sequence_gap',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_or_missing_renderer_epoch');
});

test('chat stream bridge preserves active receipt state across stale renderer records', () => {
  const sent = [];
  let watchdog = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) { sent.push({ method, payload }); },
    log() {},
    setReceiptWatchdog(fn) {
      watchdog = fn;
      return 'watchdog';
    },
    clearReceiptWatchdog() {
      watchdog = null;
    },
    isStreamEnvelopeV2Enabled: () => true,
  });
  bridge.recordEnvelopeAck({
    recordType: 'subscription_started', rendererEpoch: 5, mode: 'envelope',
  });
  bridge.handleEvent({ type: 'started', streamId: 'stream-current', sessionId: 'session-current' });
  bridge.handleEvent({ type: 'complete', streamId: 'stream-current', sessionId: 'session-current' });
  assert.ok(watchdog);

  const staleSubscription = bridge.recordEnvelopeAck({
    recordType: 'subscription_started', rendererEpoch: 4, mode: 'legacy',
  });
  assert.equal(staleSubscription.reason, 'stale_subscription_epoch');
  assert.ok(watchdog);

  const staleFault = bridge.recordEnvelopeAck({
    recordType: 'stream_fault', rendererEpoch: 4,
    streamId: 'stream-current', reason: 'sequence_gap',
  });
  assert.equal(staleFault.reason, 'stale_or_missing_renderer_epoch');
  assert.ok(watchdog);

  const currentFault = bridge.recordEnvelopeAck({
    recordType: 'stream_fault', rendererEpoch: 5,
    streamId: 'stream-current', session_id: 'session-current', reason: 'sequence_gap',
  });
  assert.equal(currentFault.record_accepted, true);
  assert.equal(currentFault.recovery_ticket_issued, true);
  assert.equal(watchdog, null);
  assert.equal(sent.some((entry) => (
    entry.method === 'chat.onStreamRecoveryRequired'
    && entry.payload.stream_id === 'stream-current'
  )), true);
});

test('chat stream bridge re-opens legacy stream events after a terminal ack timeout', () => {
  const sent = [];
  const logs = [];
  let watchdog = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log(level, event, details) {
      logs.push({ level, event, details });
    },
    setReceiptWatchdog(fn) {
      watchdog = fn;
      return 'watchdog';
    },
    clearReceiptWatchdog() {
      watchdog = null;
    },
    isStreamEnvelopeV2Enabled: () => true,
  });
  proveEnvelopeAck(bridge, 'stream-reopen-handshake');

  // Proven: envelope-only; the terminal arms the receipt watchdog.
  sent.length = 0;
  bridge.handleEvent({
    type: 'started', streamId: 'stream-reopen-1', sessionId: 'session-reopen', turnId: 'turn-reopen',
  });
  bridge.handleEvent({
    type: 'complete', streamId: 'stream-reopen-1', sessionId: 'session-reopen', turnId: 'turn-reopen',
  });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), false);
  assert.ok(watchdog);

  // No ack arrives: the watchdog re-opens legacy emission for later turns so
  // a renderer that stopped consuming envelopes degrades to legacy streaming.
  watchdog();
  const noAck = logs.find((entry) => entry.event === 'chat.stream_envelope_v2_no_ack');
  assert.equal(noAck?.details?.legacyReopened, true);
  const recovery = sent.find((entry) => entry.method === 'chat.onStreamRecoveryRequired');
  assert.deepEqual(recovery?.payload, {
    recovery_id: 'stream-reopen-1',
    renderer_epoch: 1,
    stream_id: 'stream-reopen-1',
    session_id: 'session-reopen',
    turn_id: 'turn-reopen',
    terminal_type: 'complete',
    reason: 'renderer_terminal_ack_timeout',
    created_at_ms: recovery?.payload?.created_at_ms,
  });

  sent.length = 0;
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 2, mode: 'legacy' });
  assert.equal(sent.filter((entry) => entry.method === 'chat.onStreamRecoveryRequired').length, 1);
  assert.equal(sent[0].payload.renderer_epoch, 2);

  const applied = bridge.recordEnvelopeAck({
    record_type: 'recovery_applied',
    recovery_id: 'stream-reopen-1',
    renderer_epoch: 2,
    stream_id: 'stream-reopen-1',
    session_id: 'session-reopen',
    outcome: 'applied',
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.recovery_applied, true);

  sent.length = 0;
  const lateReceipt = bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt', rendererEpoch: 2,
    streamId: 'stream-reopen-1', session_id: 'session-reopen',
    receivedCount: 0, sequenceStart: 0, sequenceEnd: 0,
    channels: {}, terminalType: 'complete', eventKind: 'terminal',
  });
  assert.equal(lateReceipt.recovery_ticket_issued, true);
  assert.equal(sent.some((entry) => entry.method === 'chat.onStreamRecoveryRequired'), true);
  const duplicateApplied = bridge.recordEnvelopeAck({
    record_type: 'recovery_applied', recovery_id: 'stream-reopen-1',
    renderer_epoch: 2, stream_id: 'stream-reopen-1', session_id: 'session-reopen',
    outcome: 'applied',
  });
  assert.equal(duplicateApplied.already_applied, true);

  sent.length = 0;
  bridge.recordEnvelopeAck({ recordType: 'subscription_started', rendererEpoch: 3, mode: 'legacy' });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStreamRecoveryRequired'), false);

  sent.length = 0;
  bridge.handleEvent({ type: 'started', streamId: 'stream-reopen-2', sessionId: 'session-reopen' });
  bridge.handleEvent({ type: 'complete', streamId: 'stream-reopen-2', sessionId: 'session-reopen' });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), true);
  assert.equal(sent.some((entry) => entry.method === 'chat.onStreamEnvelope'), true);
});

test('subscription replacement promotes every pending terminal watchdog to recovery', () => {
  const sent = [];
  const watchdogs = new Map();
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) { sent.push({ method, payload }); },
    log() {},
    setReceiptWatchdog(fn) {
      const handle = `watchdog-${watchdogs.size + 1}`;
      watchdogs.set(handle, fn);
      return handle;
    },
    clearReceiptWatchdog(handle) { watchdogs.delete(handle); },
    isStreamEnvelopeV2Enabled: () => true,
  });
  bridge.recordEnvelopeAck({
    recordType: 'subscription_started', rendererEpoch: 1, mode: 'envelope',
  });
  bridge.handleEvent({
    type: 'complete', streamId: 'stream-a', sessionId: 'session-a', turnId: 'turn-a',
  });
  bridge.handleEvent({
    type: 'complete', streamId: 'stream-b', sessionId: 'session-b', turnId: 'turn-b',
  });
  assert.equal(watchdogs.size, 2);

  sent.length = 0;
  bridge.recordEnvelopeAck({
    recordType: 'subscription_started', rendererEpoch: 2, mode: 'legacy',
  });

  const recoveries = sent
    .filter((entry) => entry.method === 'chat.onStreamRecoveryRequired')
    .map((entry) => entry.payload);
  assert.deepEqual(recoveries.map((entry) => entry.stream_id), ['stream-a', 'stream-b']);
  assert.equal(recoveries.every((entry) => entry.renderer_epoch === 2), true);
  assert.equal(recoveries.every((entry) => (
    entry.reason === 'renderer_subscription_replaced_before_terminal_ack'
  )), true);
  assert.equal(watchdogs.size, 0);
});

test('missing receipt state revokes proof before the next stream', () => {
  const sent = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) { sent.push({ method, payload }); },
    log() {},
    isStreamEnvelopeV2Enabled: () => true,
  });
  proveEnvelopeAck(bridge, 'stream-missing-state-handshake');
  bridge.handleEvent({ type: 'started', streamId: 'stream-reset', sessionId: 'session-reset' });
  bridge.resetStream('stream-reset');

  const result = bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt',
    rendererEpoch: 1,
    streamId: 'stream-reset',
  });
  assert.equal(result.reason, 'missing_receipt_state');

  sent.length = 0;
  bridge.handleEvent({ type: 'started', streamId: 'stream-after-reset', sessionId: 'session-reset' });
  assert.equal(sent.some((entry) => entry.method === 'chat.onStream'), true);
});
