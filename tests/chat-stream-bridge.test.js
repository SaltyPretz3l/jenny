const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatStreamBridge,
} = require('../services/chat-stream-bridge');

test('chat stream bridge forwards streaming hot-path events immediately and emits one terminal summary', () => {
  const calls = [];
  const recordedUsage = [];
  let nowMs = 1_000;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      calls.push({ kind: 'send', method, payload });
    },
    log(level, event, details) {
      calls.push({ kind: 'log', level, event, details });
    },
    usageHistory: {
      recordTurnUsage(sessionId, usage, metadata) {
        recordedUsage.push({ sessionId, usage, metadata });
        calls.push({ kind: 'usage', sessionId, usage, metadata });
      },
    },
    now: () => nowMs,
  });

  bridge.handleEvent({
    type: 'started',
    sessionId: 'session-1',
    streamId: 'stream-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    model: 'qwen3.5:9b',
  });

  for (let index = 0; index < 8; index += 1) {
    nowMs += 5;
    bridge.handleEvent({
      type: 'delta',
      sessionId: 'session-1',
      streamId: 'stream-1',
      model: 'qwen3.5:9b',
      content: `token-${index}`,
      aggregate: `aggregate-${index}`,
      reasoning: {
        source: 'provider',
        entriesDelta: [{ id: `reason_${index}`, text: `thinking-${index}` }],
      },
    });
    nowMs += 5;
    bridge.handleEvent({
      type: 'thinking_status',
      sessionId: 'session-1',
      streamId: 'stream-1',
      model: 'qwen3.5:9b',
      text: `status-${index}`,
    });
  }

  const callCountBeforeComplete = calls.length;
  nowMs += 40;
  bridge.handleEvent({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-1',
    requestId: 'request-1',
    traceId: 'trace-1',
    model: 'qwen3.5:9b',
    usage: { total_tokens: 42 },
  });

  const sendCalls = calls.filter((call) => call.kind === 'send');
  const logCalls = calls.filter((call) => call.kind === 'log');

  assert.equal(sendCalls.length, 18);
  const summaryLogs = logCalls.filter((call) => call.event === 'chat.stream_summary');
  assert.equal(logCalls.length, 2);
  assert.equal(summaryLogs.length, 1);
  assert.deepEqual(recordedUsage, [{
    sessionId: 'session-1',
    usage: { total_tokens: 42 },
    metadata: {
      streamId: 'stream-1',
      requestId: 'request-1',
      traceId: 'trace-1',
      model: 'qwen3.5:9b',
      sessionId: 'session-1',
      terminalType: 'complete',
      outcome: 'complete',
      outcomeDetail: '',
      durationMs: 120,
    },
  }]);

  const terminalCalls = calls.slice(callCountBeforeComplete);
  assert.deepEqual(
    terminalCalls.map((call) => call.kind),
    ['send', 'usage', 'log']
  );
  assert.equal(terminalCalls[0].method, 'chat.onStream');
  assert.equal(summaryLogs[0].event, 'chat.stream_summary');
  assert.deepEqual(summaryLogs[0].details, {
    type: 'complete',
    streamId: 'stream-1',
    stream_id: 'stream-1',
    requestId: 'request-1',
    request_id: 'request-1',
    traceId: 'trace-1',
    trace_id: 'trace-1',
    sessionId: 'session-1',
    model: 'qwen3.5:9b',
    message: '',
    errorCode: '',
    retryable: true,
    category: '',
    durationMs: 120,
    forwardedEventCount: 18,
    deltaCount: 8,
    reasoningChunkCount: 8,
    thinkingStatusCount: 8,
    toolEventCount: 0,
    agentStatusCount: 0,
    messageUpdatedCount: 0,
  });
});

test('chat stream bridge forwards errors immediately and clears per-stream counters after terminal cleanup', () => {
  const calls = [];
  let nowMs = 5_000;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      calls.push({ kind: 'send', method, payload });
    },
    log(level, event, details) {
      calls.push({ kind: 'log', level, event, details });
    },
    now: () => nowMs,
  });

  bridge.handleEvent({
    type: 'started',
    sessionId: 'session-2',
    streamId: 'stream-err',
    model: 'mock-v1',
  });
  nowMs += 10;
  bridge.handleEvent({
    type: 'delta',
    sessionId: 'session-2',
    streamId: 'stream-err',
    model: 'mock-v1',
    content: 'hello',
    aggregate: 'hello',
  });

  const callCountBeforeError = calls.length;
  nowMs += 15;
  bridge.handleEvent({
    type: 'error',
    sessionId: 'session-2',
    streamId: 'stream-err',
    model: 'mock-v1',
    message: 'boom',
    error_code: 'CMP-CHAT-0002',
    retryable: false,
    category: 'transport',
  });

  const errorCalls = calls.slice(callCountBeforeError);
  assert.deepEqual(
    errorCalls.map((call) => call.kind),
    ['send', 'send', 'log']
  );
  assert.equal(errorCalls[0].method, 'chat.onStream');
  assert.equal(errorCalls[0].payload.type, 'delta');
  assert.equal(errorCalls[1].method, 'chat.onStream');
  assert.equal(errorCalls[1].payload.type, 'error');
  assert.equal(errorCalls[2].level, 'ERROR');
  assert.deepEqual(errorCalls[2].details, {
    type: 'error',
    streamId: 'stream-err',
    stream_id: 'stream-err',
    requestId: 'stream-err',
    request_id: 'stream-err',
    traceId: 'stream-err',
    trace_id: 'stream-err',
    sessionId: 'session-2',
    model: 'mock-v1',
    message: 'boom',
    errorCode: 'CMP-CHAT-0002',
    retryable: false,
    category: 'transport',
    durationMs: 25,
    forwardedEventCount: 3,
    deltaCount: 1,
    reasoningChunkCount: 0,
    thinkingStatusCount: 0,
    toolEventCount: 0,
    agentStatusCount: 0,
    messageUpdatedCount: 0,
  });

  nowMs += 5;
  bridge.handleEvent({
    type: 'started',
    sessionId: 'session-2',
    streamId: 'stream-err',
    model: 'mock-v1',
  });
  nowMs += 20;
  bridge.handleEvent({
    type: 'complete',
    sessionId: 'session-2',
    streamId: 'stream-err',
    model: 'mock-v1',
  });

  const summaryLogs = calls.filter((call) => call.kind === 'log' && call.event === 'chat.stream_summary');
  assert.equal(summaryLogs.length, 2);
  assert.deepEqual(summaryLogs[1].details, {
    type: 'complete',
    streamId: 'stream-err',
    stream_id: 'stream-err',
    requestId: 'stream-err',
    request_id: 'stream-err',
    traceId: 'stream-err',
    trace_id: 'stream-err',
    sessionId: 'session-2',
    model: 'mock-v1',
    message: '',
    errorCode: '',
    retryable: true,
    category: '',
    durationMs: 20,
    forwardedEventCount: 2,
    deltaCount: 0,
    reasoningChunkCount: 0,
    thinkingStatusCount: 0,
    toolEventCount: 0,
    agentStatusCount: 0,
    messageUpdatedCount: 0,
  });
});

test('chat stream bridge includes cancellation metadata in terminal summaries', () => {
  const calls = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      calls.push({ kind: 'send', method, payload });
    },
    log(level, event, details) {
      calls.push({ kind: 'log', level, event, details });
    },
    now: () => 2_000,
  });

  bridge.handleEvent({
    type: 'error',
    sessionId: 'session-cancel',
    streamId: 'stream-cancel',
    model: 'mock-v1',
    message: 'Session deleted during stream.',
    category: 'cancelled',
    terminal_subcode: 'session_delete',
    cancel_reason: 'session_delete',
  });

  const summary = calls.find((call) =>
    call.kind === 'log' && call.event === 'chat.stream_summary'
  );
  assert.ok(summary);
  assert.equal(summary.details.terminal_subcode, 'session_delete');
  assert.equal(summary.details.terminalSubcode, 'session_delete');
  assert.equal(summary.details.cancel_reason, 'session_delete');
  assert.equal(summary.details.cancelReason, 'session_delete');
});

test('chat stream bridge records zero-token canonical terminal rows without a usage payload', () => {
  const recorded = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent() {},
    log() {},
    usageHistory: {
      recordTurnUsage(sessionId, usagePayload, metadata) {
        recorded.push({ sessionId, usagePayload, metadata });
      },
    },
    now: () => 2000,
  });
  bridge.handleEvent({
    type: 'started', sessionId: 'session-zero', streamId: 'stream-zero', model: 'qwen',
  });
  bridge.handleEvent({
    type: 'error', sessionId: 'session-zero', streamId: 'stream-zero', model: 'qwen',
    terminal_status: 'failed', error_code: 'CMP-CHAT-0099', message: 'private provider message',
  });
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].usagePayload, {});
  assert.equal(recorded[0].metadata.outcome, 'error');
  assert.equal(recorded[0].metadata.outcomeDetail, 'CMP-CHAT-0099');
  assert.equal(JSON.stringify(recorded).includes('private provider message'), false);
});

test('chat stream bridge treats terminal collaborator failures as non-fatal and still resets per-stream counters', () => {
  const sends = [];
  const logs = [];
  const recordedUsage = [];
  let nowMs = 10_000;
  let failCostOnce = true;
  let failLogOnce = true;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sends.push({ method, payload });
    },
    log(level, event, details) {
      if (event === 'chat.stream_summary' && failLogOnce) {
        failLogOnce = false;
        throw new Error('summary log unavailable');
      }
      logs.push({ level, event, details });
    },
    usageHistory: {
      recordTurnUsage(sessionId, usage, metadata) {
        if (failCostOnce) {
          failCostOnce = false;
          throw new Error('cost tracker unavailable');
        }
        recordedUsage.push({ sessionId, usage, metadata });
      },
    },
    now: () => nowMs,
  });

  assert.doesNotThrow(() => {
    bridge.handleEvent({
      type: 'started',
      sessionId: 'session-3',
      streamId: 'stream-stable',
      model: 'mock-v2',
    });
    nowMs += 25;
    bridge.handleEvent({
      type: 'complete',
      sessionId: 'session-3',
      streamId: 'stream-stable',
      model: 'mock-v2',
      usage: { total_tokens: 7 },
    });
  });

  nowMs += 5;
  bridge.handleEvent({
    type: 'started',
    sessionId: 'session-3',
    streamId: 'stream-stable',
    model: 'mock-v2',
  });
  nowMs += 30;
  bridge.handleEvent({
    type: 'complete',
    sessionId: 'session-3',
    streamId: 'stream-stable',
    model: 'mock-v2',
    usage: { total_tokens: 11 },
  });

  assert.equal(sends.length, 4);
  assert.deepEqual(recordedUsage, [{
    sessionId: 'session-3',
    usage: { total_tokens: 11 },
    metadata: {
      streamId: 'stream-stable',
      requestId: 'stream-stable',
      traceId: 'stream-stable',
      model: 'mock-v2',
      sessionId: 'session-3',
      terminalType: 'complete',
      outcome: 'complete',
      outcomeDetail: '',
      durationMs: 30,
    },
  }]);
  const summaryLogs = logs.filter((call) => call.event === 'chat.stream_summary');
  assert.equal(summaryLogs.length, 1);
  assert.deepEqual(summaryLogs[0].details, {
    type: 'complete',
    streamId: 'stream-stable',
    stream_id: 'stream-stable',
    requestId: 'stream-stable',
    request_id: 'stream-stable',
    traceId: 'stream-stable',
    trace_id: 'stream-stable',
    sessionId: 'session-3',
    model: 'mock-v2',
    message: '',
    errorCode: '',
    retryable: true,
    category: '',
    durationMs: 30,
    forwardedEventCount: 2,
    deltaCount: 0,
    reasoningChunkCount: 0,
    thinkingStatusCount: 0,
    toolEventCount: 0,
    agentStatusCount: 0,
    messageUpdatedCount: 0,
  });
});

test('chat stream bridge isolates renderer forward failures and includes failure metadata in terminal summary', () => {
  const calls = [];
  let nowMs = 20_000;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(_method, payload) {
      calls.push({ kind: 'send_attempt', type: payload.type });
      if (payload.type === 'delta') {
        throw new Error('renderer clone failed');
      }
    },
    log(level, event, details) {
      calls.push({ kind: 'log', level, event, details });
    },
    now: () => nowMs,
  });

  bridge.handleEvent({
    type: 'started',
    sessionId: 'session-renderer-fail',
    streamId: 'stream-renderer-fail',
    model: 'mock-v3',
  });
  nowMs += 10;
  assert.doesNotThrow(() => {
    bridge.handleEvent({
      type: 'delta',
      sessionId: 'session-renderer-fail',
      streamId: 'stream-renderer-fail',
      model: 'mock-v3',
      content: 'hello',
      aggregate: 'hello',
    });
  });
  nowMs += 20;
  bridge.handleEvent({
    type: 'complete',
    sessionId: 'session-renderer-fail',
    streamId: 'stream-renderer-fail',
    model: 'mock-v3',
  });

  const summary = calls.find((call) =>
    call.kind === 'log' && call.event === 'chat.stream_summary'
  );
  assert.ok(summary);
  assert.equal(summary.details.forwardedEventCount, 3);
  assert.equal(summary.details.deltaCount, 1);
  assert.equal(summary.details.rendererForwardFailed, true);
  assert.equal(summary.details.rendererForwardError, 'renderer clone failed');
  assert.equal(summary.details.rendererForwardFailedCount, 1);
});

test('chat stream bridge caps abandoned stream stats and evicts oldest started-only entries', () => {
  const summaries = [];
  let nowMs = 30_000;
  const bridge = createChatStreamBridge({
    sendBridgeEvent() {},
    log(_level, event, details) {
      if (event === 'chat.stream_summary') {
        summaries.push(details);
      }
    },
    now: () => nowMs,
  });

  for (let index = 0; index < 80; index += 1) {
    bridge.handleEvent({
      type: 'started',
      sessionId: 'session-cap',
      streamId: `stream-cap-${index}`,
      model: 'mock-v3',
    });
    nowMs += 1;
  }

  bridge.handleEvent({
    type: 'complete',
    sessionId: 'session-cap',
    streamId: 'stream-cap-0',
    model: 'mock-v3',
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].forwardedEventCount, 1);
  assert.equal(summaries[0].durationMs, 0);
});

test('chat stream bridge reports usage record failures through history diagnostics', () => {
  const reportCalls = [];
  const summaries = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent() {},
    log(_level, event, details) {
      if (event === 'chat.stream_summary') {
        summaries.push(details);
      }
    },
    usageHistory: {
      recordTurnUsage() {
        throw new Error('usage mid mutation');
      },
      reportRecordFailure(details) {
        reportCalls.push(details);
      },
    },
    now: () => 40_000,
  });

  bridge.handleEvent({
    type: 'complete',
    sessionId: 'session-usage-fail',
    streamId: 'stream-usage-fail',
    model: 'mock-v4',
    usage: { total_tokens: 5 },
  });

  assert.deepEqual(reportCalls, [{
    sessionId: 'session-usage-fail',
    error: 'usage mid mutation',
  }]);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].usageRecordingFailed, true);
  assert.equal(summaries[0].usageRecordingError, 'record_failed');
});

test('chat stream bridge logs first renderer notification only after a successful forward', () => {
  const logs = [];
  let shouldFailForward = true;
  const bridge = createChatStreamBridge({
    sendBridgeEvent() {
      if (shouldFailForward) {
        shouldFailForward = false;
        throw new Error('renderer temporarily unavailable');
      }
    },
    log(level, event, details) {
      logs.push({ level, event, details });
    },
    now: () => 50_000,
  });

  bridge.handleEvent({
    type: 'started',
    sessionId: 'session-first-forward',
    streamId: 'stream-first-forward',
    model: 'mock-v5',
  });
  bridge.handleEvent({
    type: 'delta',
    sessionId: 'session-first-forward',
    streamId: 'stream-first-forward',
    model: 'mock-v5',
    content: 'hello',
    aggregate: 'hello',
  });

  const firstForwardLogs = logs.filter((call) => call.event === 'chat.first_notification_forwarded');
  assert.equal(firstForwardLogs.length, 1);
  assert.equal(firstForwardLogs[0].details.type, 'delta');
});

/* ── Coalescing (delta merge + flush rules) ── */

function makeCoalescingBridge() {
  const sent = [];
  let pendingFn = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent: (channel, payload) => {
      sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) });
    },
    log: () => {},
    setCoalesceTimer: (fn) => { pendingFn = fn; return 'fake'; },
    clearCoalesceTimer: () => { pendingFn = null; },
  });
  return {
    bridge,
    sent,
    fireTimer: () => {
      if (pendingFn) {
        const fn = pendingFn;
        pendingFn = null;
        fn();
      }
    },
  };
}

test('coalescing: 5 same-stream deltas before flush produce 0 IPC sends', () => {
  const { bridge, sent } = makeCoalescingBridge();
  for (let i = 0; i < 5; i += 1) {
    bridge.handleEvent({ type: 'delta', streamId: 's', content: `tok${i + 1}` });
  }
  assert.equal(sent.length, 0);
});

test('coalescing: timer flush merges content (concat), aggregate (latest wins), and entriesDelta (concat)', () => {
  const { bridge, sent, fireTimer } = makeCoalescingBridge();
  for (let i = 0; i < 5; i += 1) {
    bridge.handleEvent({
      type: 'delta',
      streamId: 's',
      content: `tok${i + 1}`,
      aggregate: `agg${i + 1}`,
      reasoning: { entriesDelta: [{ text: `r${i + 1}` }] },
    });
  }
  fireTimer();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.content, 'tok1tok2tok3tok4tok5');
  assert.equal(sent[0].payload.aggregate, 'agg5');
  assert.deepEqual(sent[0].payload.reasoning.entriesDelta, [
    { text: 'r1' },
    { text: 'r2' },
    { text: 'r3' },
    { text: 'r4' },
    { text: 'r5' },
  ]);
});

test('coalescing: different streams do not merge — one flush yields one merged event per stream', () => {
  const { bridge, sent, fireTimer } = makeCoalescingBridge();
  bridge.handleEvent({ type: 'delta', streamId: 'A', content: 'a1' });
  bridge.handleEvent({ type: 'delta', streamId: 'B', content: 'b1' });
  bridge.handleEvent({ type: 'delta', streamId: 'A', content: 'a2' });
  bridge.handleEvent({ type: 'delta', streamId: 'B', content: 'b2' });
  bridge.handleEvent({ type: 'delta', streamId: 'A', content: 'a3' });
  fireTimer();
  assert.equal(sent.length, 2);
  const byStream = new Map(sent.map((entry) => [entry.payload.streamId, entry.payload]));
  assert.equal(byStream.get('A').content, 'a1a2a3');
  assert.equal(byStream.get('B').content, 'b1b2');
});

test('coalescing: non-delta event flushes pending delta first, then sends itself', () => {
  const { bridge, sent } = makeCoalescingBridge();
  bridge.handleEvent({ type: 'delta', streamId: 's', content: 'tok1' });
  bridge.handleEvent({ type: 'tool_use', streamId: 's' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.type, 'delta');
  assert.equal(sent[1].payload.type, 'tool_use');
});

test('coalescing: terminal complete flushes pending delta first, then sends complete', () => {
  const { bridge, sent } = makeCoalescingBridge();
  bridge.handleEvent({ type: 'delta', streamId: 's', content: 'tok1' });
  bridge.handleEvent({ type: 'complete', streamId: 's' });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.type, 'delta');
  assert.equal(sent[1].payload.type, 'complete');
});

test('coalescing: resetStream drops pending delta — buffered chunk would be stale', () => {
  // resetStream signals the caller has abandoned the stream; the buffered
  // delta must be dropped (not flushed) because the renderer no longer cares.
  const { bridge, sent, fireTimer } = makeCoalescingBridge();
  bridge.handleEvent({ type: 'delta', streamId: 's', content: 'tok1' });
  bridge.resetStream('s');
  fireTimer();
  assert.equal(sent.length, 0);
});

test('coalescing: delta without streamId bypasses the coalescer and sends immediately', () => {
  const { bridge, sent } = makeCoalescingBridge();
  bridge.handleEvent({ type: 'delta', content: 'tok1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.content, 'tok1');
});

test('coalescing: empty entriesDelta preserves prior entries while updating other reasoning fields', () => {
  const { bridge, sent, fireTimer } = makeCoalescingBridge();
  bridge.handleEvent({
    type: 'delta',
    streamId: 's',
    reasoning: { source: 'old', entriesDelta: [{ text: 'r1' }] },
  });
  bridge.handleEvent({
    type: 'delta',
    streamId: 's',
    reasoning: { source: 'new', entriesDelta: [] },
  });
  fireTimer();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.reasoning.source, 'new');
  assert.deepEqual(sent[0].payload.reasoning.entriesDelta, [{ text: 'r1' }]);
});

test('coalescing: stats counters tick per underlying event regardless of coalescing', () => {
  const logs = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent: () => {},
    log: (level, event, details) => { logs.push({ level, event, details }); },
    setCoalesceTimer: () => 'fake',
    clearCoalesceTimer: () => {},
  });
  for (let i = 0; i < 3; i += 1) {
    bridge.handleEvent({
      type: 'delta',
      streamId: 's',
      sessionId: 'sess',
      model: 'm',
      content: `t${i + 1}`,
      reasoning: { entriesDelta: [{ text: `r${i + 1}` }] },
    });
  }
  bridge.handleEvent({ type: 'complete', streamId: 's', sessionId: 'sess', model: 'm' });

  const firstForward = logs.filter((entry) => entry.event === 'chat.first_notification_forwarded');
  assert.equal(firstForward.length, 1);
  const summary = logs.find((entry) => entry.event === 'chat.stream_summary');
  assert.ok(summary);
  assert.equal(summary.details.forwardedEventCount, 4);
  assert.equal(summary.details.deltaCount, 3);
  assert.equal(summary.details.reasoningChunkCount, 3);
});
