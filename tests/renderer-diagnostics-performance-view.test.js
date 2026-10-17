'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { OBSERVED_SOURCES } = require('./helpers/diagnostics-view-fixtures');

// Diagnostics Overview in the loaded app: the Performance section.

const PAYLOAD = {
  phases: { provider_request_start_to_first_chunk: { count: 2, p50: 100, p95: 190, p99: 190 } },
  targets: { provider_request_start_to_first_chunk: { p50: 150, p95: 400 } },
};
const FACETS = {
  tool_observability: { available: true, tools: { read_file: { count: 3, error_count: 0, error_rate: 0, latency_ms: { p50: 10, p95: 20, p99: 30 }, error_codes: {} } } },
  slow_operations: { available: true, count: 0, items: [] },
  trace_timing: { available: true, count: 1, recent: [
    { stream_id: 'stream-1', terminal_status: 'completed', duration_ms: 900, model: 'qwen3', provider_timing: { time_to_first_visible_token_ms: 150 }, tool_events: { total: 1 } },
  ] },
};

async function openDiagnostics(t, { status = {}, shell = {}, diagnostics = {} } = {}) {
  const app = await loadRendererApp({
    shell: {
      ...shell,
      diagnostics: {
        logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
        getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' }, ...status }),
        ...diagnostics,
      },
    },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 50);
  return app;
}

const text = (doc, id) => doc.getElementById(id).textContent.replace(/\s+/g, ' ').trim();

test('a launch with nothing measured says so once and offers nothing to reset', async (t) => {
  const app = await openDiagnostics(t, { status: {
    phase_percentiles: { available: true, phases: {}, targets: {} },
    tool_observability: { available: true, tools: {} },
    slow_operations: { available: true, count: 0, items: [] },
    trace_timing: { available: true, count: 0, recent: [] },
  } });
  const doc = app.window.document;
  assert.equal(text(doc, 'diagnosticsPerformanceEmpty'), 'No chats measured in this launch yet. Send a chat and its timings appear here.');
  assert.equal(doc.getElementById('diagnosticsPerformanceEmpty').hidden, false);
  assert.equal(doc.getElementById('diagnosticsPerformanceGroups').hidden, true);
  assert.equal(doc.getElementById('diagnosticsResetControl').hidden, true);
  assert.doesNotMatch(text(doc, 'diagnosticsPerformanceEmpty'), /could not be loaded|unavailable/i);
});

test('measured timings, tools and chats appear as their own groups', async (t) => {
  const app = await openDiagnostics(t, { status: FACETS, shell: { phasePercentilesPayload: PAYLOAD } });
  const doc = app.window.document;
  assert.equal(doc.getElementById('diagnosticsPerformanceEmpty').hidden, true);
  assert.equal(doc.getElementById('diagnosticsResetControl').hidden, false);
  assert.equal(doc.getElementById('diagnosticsChatTiming').hidden, false);
  assert.match(text(doc, 'diagnosticsChatTimingHeading'), /2 chats · 1 of 9 steps measured/);
  assert.match(text(doc, 'phasePercentilesTable'), /Provider start to first chunk/);
  assert.equal(doc.getElementById('diagnosticsOverTarget').hidden, true, 'no slow operations, no group');
  assert.equal(doc.querySelector('#toolLatencyTable td code').textContent, 'read_file');
  assert.equal(doc.querySelector('#recentTracesList [data-observability-trace]').getAttribute('data-observability-trace'), 'stream-1');
});

test('selecting a recent chat opens its records in Activity', async (t) => {
  const app = await openDiagnostics(t, { status: FACETS, shell: { phasePercentilesPayload: PAYLOAD } });
  const doc = app.window.document;
  doc.querySelector('#recentTracesList [data-observability-trace="stream-1"]').click();
  await waitForUi(app.window, 50);
  assert.equal(doc.getElementById('diagnosticsActivity').hidden, false);
  assert.equal(doc.getElementById('diagnosticsOverview').hidden, true);
});

test('failed percentile reset keeps the timings and says the refresh failed', async (t) => {
  const app = await openDiagnostics(t, {
    status: FACETS,
    shell: { phasePercentilesPayload: PAYLOAD },
    diagnostics: { phasePercentiles: { reset: async () => { throw new Error('reset failed'); } } },
  });
  const doc = app.window.document;
  assert.equal(doc.getElementById('phasePercentilesResetButton').disabled, false);
  doc.getElementById('phasePercentilesResetButton').click();
  await waitForUi(app.window, 50);
  assert.match(text(doc, 'diagnosticsPerformanceEmpty'), /Timings could not be refreshed\. reset failed/);
  assert.match(text(doc, 'phasePercentilesTable'), /Provider start to first chunk/, 'the numbers stay on screen');
});
