'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ToolObservabilityAggregator,
} = require('../services/backend/tool-observability-aggregator');

test('tool observability aggregates latency and error data without payloads', () => {
  let nowMs = 1000;
  const aggregator = new ToolObservabilityAggregator({
    now: () => nowMs,
    samplesPerTool: 10,
    recentLimit: 4,
    slowThresholdMs: 400,
  });

  assert.equal(aggregator.recordToolExecuting({
    streamId: 'stream-1',
    sessionId: 'session-1',
    callId: 'call-success',
    toolName: 'read_file',
    toolInput: { path: 'secret.txt' },
  }), true);

  nowMs = 1350;
  assert.equal(aggregator.recordToolResult({
    streamId: 'stream-1',
    sessionId: 'session-1',
    callId: 'call-success',
    toolName: 'read_file',
    success: true,
    output: 'super-secret-output',
  }), true);

  assert.equal(aggregator.recordToolResult({
    streamId: 'stream-1',
    sessionId: 'session-1',
    callId: 'call-error',
    toolName: 'read_file',
    success: false,
    errorCode: 'CMP-TOOL-0001',
    durationMs: 550,
    output: 'second-secret-output',
    toolInput: { path: 'another-secret.txt' },
  }), true);

  const snapshot = aggregator.snapshot();
  assert.equal(snapshot.open_call_count, 0);
  assert.equal(snapshot.tools.read_file.count, 2);
  assert.equal(snapshot.tools.read_file.success_count, 1);
  assert.equal(snapshot.tools.read_file.error_count, 1);
  assert.equal(snapshot.tools.read_file.error_rate, 0.5);
  assert.equal(snapshot.tools.read_file.error_codes['CMP-TOOL-0001'], 1);
  assert.equal(snapshot.tools.read_file.latency_ms.p50, 350);
  assert.equal(snapshot.tools.read_file.latency_ms.p95, 550);
  assert.equal(snapshot.tools.read_file.recent_errors.length, 1);
  assert.equal(snapshot.tools.read_file.recent_slow.length, 1);

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('super-secret-output'), false);
  assert.equal(serialized.includes('secret.txt'), false);
});

test('tool observability keeps bounded latency samples while retaining total counts', () => {
  const aggregator = new ToolObservabilityAggregator({
    samplesPerTool: 3,
    recentLimit: 2,
    slowThresholdMs: 1000,
  });

  [100, 200, 300, 400].forEach((durationMs, index) => {
    assert.equal(aggregator.recordToolResult({
      streamId: 'stream-1',
      sessionId: 'session-1',
      callId: `call-${index}`,
      toolName: 'shell',
      success: true,
      durationMs,
    }), true);
  });

  const shell = aggregator.snapshot().tools.shell;
  assert.equal(shell.count, 4);
  assert.equal(shell.latency_ms.count, 3);
  assert.equal(shell.latency_ms.last_N, 3);
  assert.equal(shell.latency_ms.min, 200);
  assert.equal(shell.latency_ms.p50, 300);
  assert.equal(shell.latency_ms.p95, 400);
  assert.equal(shell.latency_ms.max, 400);
});

test('tool observability rejects malformed observations and accepts result-only observations', () => {
  const aggregator = new ToolObservabilityAggregator();

  assert.equal(aggregator.recordToolExecuting({
    streamId: 'stream-1',
    callId: '',
    toolName: 'read_file',
  }), false);
  assert.equal(aggregator.recordToolResult({
    streamId: 'stream-1',
    callId: 'call-missing-tool',
    toolName: '',
    success: true,
    durationMs: 10,
  }), false);
  assert.equal(aggregator.recordToolResult({
    streamId: 'stream-1',
    callId: 'call-negative-duration',
    toolName: 'read_file',
    success: true,
    durationMs: -1,
  }), false);

  assert.equal(aggregator.recordToolResult({
    streamId: 'stream-1',
    callId: 'call-result-only',
    toolName: 'read_file',
    success: true,
    durationMs: 25,
  }), true);

  const snapshot = aggregator.snapshot();
  assert.equal(snapshot.open_call_count, 0);
  assert.equal(snapshot.tools.read_file.count, 1);
  assert.equal(snapshot.tools.read_file.latency_ms.p50, 25);
});

test('tool observability bounds open-call tracking and evicts oldest starts', () => {
  const aggregator = new ToolObservabilityAggregator({
    maxOpenCalls: 2,
    now: () => 1000,
  });

  assert.equal(aggregator.recordToolExecuting({
    streamId: 'stream-1',
    sessionId: 'session-1',
    callId: 'call-1',
    toolName: 'read_file',
  }), true);
  assert.equal(aggregator.recordToolExecuting({
    streamId: 'stream-1',
    sessionId: 'session-1',
    callId: 'call-2',
    toolName: 'read_file',
  }), true);
  assert.equal(aggregator.recordToolExecuting({
    streamId: 'stream-1',
    sessionId: 'session-1',
    callId: 'call-3',
    toolName: 'read_file',
  }), true);

  const snapshot = aggregator.snapshot();
  assert.equal(snapshot.open_call_count, 2);
  assert.equal(snapshot.open_call_eviction_count, 1);
  assert.equal(snapshot.retention.max_open_calls, 2);
});

test('tool observability bounds distinct tool buckets and reports oldest-entry evictions', () => {
  const aggregator = new ToolObservabilityAggregator({ maxToolBuckets: 2 });

  for (const toolName of ['unknown_a', 'unknown_b', 'unknown_c']) {
    assert.equal(aggregator.recordToolResult({
      sessionId: 'session-1',
      streamId: `stream-${toolName}`,
      callId: 'call-1',
      toolName,
    }), true);
  }

  const snapshot = aggregator.snapshot();
  assert.deepEqual(Object.keys(snapshot.tools), ['unknown_b', 'unknown_c']);
  assert.equal(snapshot.retention.max_tool_buckets, 2);
  assert.equal(snapshot.tool_bucket_eviction_count, 1);
  assert.equal(aggregator.reset().tool_bucket_eviction_count, 0);
});

test('tool observability keys open calls by session and stream before call id', () => {
  let nowMs = 1000;
  const aggregator = new ToolObservabilityAggregator({ now: () => nowMs });

  assert.equal(aggregator.recordToolExecuting({
    sessionId: 'session-a',
    callId: 'shared-call',
    toolName: 'read_file',
  }), true);
  nowMs = 2000;
  assert.equal(aggregator.recordToolExecuting({
    sessionId: 'session-b',
    callId: 'shared-call',
    toolName: 'read_file',
  }), true);
  nowMs = 2500;
  assert.equal(aggregator.recordToolResult({
    sessionId: 'session-a',
    callId: 'shared-call',
    toolName: 'read_file',
    success: true,
  }), true);

  const snapshot = aggregator.snapshot();
  assert.equal(snapshot.open_call_count, 1);
  assert.equal(snapshot.tools.read_file.latency_ms.p50, 1500);
});
