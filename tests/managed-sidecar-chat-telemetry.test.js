// Focused coverage for services/backend/managed-sidecar-chat-telemetry.js, the
// turn telemetry split out of managed-sidecar-chat.js: timing markers, the
// context-assembly phase logs and the fire-and-forget diagnostic dump.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createManagedTurnTiming,
  dumpTurnDiagnosticSafely,
  noteManagedContextAssemblyCompleted,
  noteManagedContextAssemblyStarted,
} = require('../services/backend/managed-sidecar-chat-telemetry');

function createLoggingService(extra = {}) {
  const logs = [];
  return {
    logs,
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
    ...extra,
  };
}

test('createManagedTurnTiming marks send_initiated and logs unmeasured client timing as null', (t) => {
  t.mock.method(Date, 'now', () => 5_000);
  const service = createLoggingService();
  const timing = createManagedTurnTiming(service, {
    sessionId: 'session-1',
    streamId: 'stream-1',
    traceId: 'trace-1',
    clientTiming: { sendStartedAtMs: null, localRenderLatencyMs: null },
  });

  assert.deepEqual(timing.timingMarkers, [{ name: 'send_initiated', ts_ms: 5_000 }]);
  assert.deepEqual(service.logs, [{
    level: 'DEBUG',
    event: 'chat.send_initiated',
    details: {
      sessionId: 'session-1',
      streamId: 'stream-1',
      traceId: 'trace-1',
      ipc_latency_ms: null,
      local_render_latency_ms: null,
    },
  }]);
});

test('recordTiming logs the elapsed phase and appends its marker', (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const service = createLoggingService();
  const timing = createManagedTurnTiming(service, {
    sessionId: 'session-1',
    streamId: 'stream-1',
    traceId: 'trace-1',
    clientTiming: { sendStartedAtMs: 400, localRenderLatencyMs: 12 },
  });
  assert.equal(service.logs[0].details.ipc_latency_ms, 600);
  assert.equal(service.logs[0].details.local_render_latency_ms, 12);

  now = 1_250;
  timing.recordTiming('chat.model_resolved', 1_000, 'model_resolved', { model: 'm' });
  timing.recordTimingMarker('context_assembly_started');

  assert.deepEqual(service.logs[1], {
    level: 'DEBUG',
    event: 'chat.model_resolved',
    details: { sessionId: 'session-1', streamId: 'stream-1', elapsedMs: 250, model: 'm' },
  });
  assert.deepEqual(timing.timingMarkers.map((marker) => marker.name), [
    'send_initiated', 'model_resolved', 'context_assembly_started',
  ]);
});

test('context assembly phase logs record markers, percentiles and the elapsed time', (t) => {
  let now = 2_000;
  t.mock.method(Date, 'now', () => now);
  const percentiles = [];
  const service = createLoggingService({
    phasePercentilesAggregator: { record: (name, value) => percentiles.push([name, value]) },
  });
  const markers = [];
  const contextPreferences = { history_scope: 'recent', include_memory: false };

  const startedAt = noteManagedContextAssemblyStarted(service, {
    recordTimingMarker: (name) => markers.push(name),
    clientTiming: { localRenderLatencyMs: 7, optimisticRenderedAtMs: 1_900 },
    sessionId: 'session-1', streamId: 'stream-1', engineType: 'ollama', model: 'm', contextPreferences,
  });
  now = 2_300;
  const completedAt = noteManagedContextAssemblyCompleted(service, {
    recordTimingMarker: (name) => markers.push(name),
    sessionId: 'session-1', streamId: 'stream-1', engineType: 'ollama', model: 'm',
    contextAssemblyStartedAt: startedAt,
    contextAssemblyBreakdown: { includedPersonality: true },
    contextPreferences,
    memoryPolicy: { enabled: true },
  });

  assert.equal(startedAt, 2_000);
  assert.equal(completedAt, 2_300);
  assert.deepEqual(markers, ['context_assembly_started', 'context_assembly_completed']);
  assert.deepEqual(percentiles, [
    ['click_to_optimistic_render', 7],
    ['optimistic_render_to_context_assembly_started', 100],
  ]);
  const started = service.logs.find((entry) => entry.event === 'chat.context_assembly_started');
  assert.equal(started.details.history_scope, 'recent');
  assert.equal(started.details.include_memory, false);
  assert.equal(started.details.include_personality, true);
  const completed = service.logs.find((entry) => entry.event === 'chat.context_assembly_completed');
  assert.equal(completed.details.elapsedMs, 300);
  assert.equal(completed.details.included_personality, true);
  assert.equal(completed.details.memory_policy_enabled, true);
});

test('dumpTurnDiagnosticSafely logs a rejected dump instead of throwing into the turn', async () => {
  const logs = [];
  const service = {
    _emitServiceLog(level, event, details) {
      // The dump rejects through its own stream-id warning; the helper must
      // catch that and report it under the unexpected-error event.
      if (event === 'chat.turn_diagnostic_stream_id_rejected') throw new Error('sink down');
      logs.push({ level, event, details });
    },
  };

  assert.equal(dumpTurnDiagnosticSafely({
    service,
    sessionId: 'session-1',
    streamId: 'not a valid id',
    requestId: 'not a valid id',
    traceId: 'trace-1',
    terminalStatus: 'completed',
    timingMarkers: [],
  }), undefined);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(logs, [{
    level: 'WARN',
    event: 'chat.turn_diagnostic_dump_unexpected_error',
    details: { sessionId: 'session-1', streamId: 'not a valid id', traceId: 'trace-1', message: 'sink down' },
  }]);
});
