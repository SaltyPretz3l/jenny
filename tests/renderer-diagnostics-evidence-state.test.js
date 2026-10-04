'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildDiagnosticReport } = require('../renderer/shared/diagnostics-report-utils');
const { buildResourceBudgetFacet } = require('../services/backend/resource-budget-facade');
const phaseUtils = require('../renderer/shell/renderer-phase-percentiles-utils');
const { createLogRenderer } = require('../renderer/shell/renderer-diagnostics-render-utils');

function paintOverview(t, status = {}, options = {}) {
  const ids = ['diagnosticsOverall', 'diagnosticsSourceCoverage', 'diagnosticsBadge', 'diagnosticsSummary',
    'diagnosticsStatus', 'phasePercentilesTable', 'performanceAnomaliesContainer', 'resourceBudgetsContainer'];
  const dom = new JSDOM(ids.map((id) => `<div id="${id}"></div>`).join(''));
  const previous = { document: global.document, window: global.window };
  global.document = dom.window.document;
  global.window = dom.window;
  let paint;
  dom.window.requestAnimationFrame = (callback) => { paint = callback; return 1; };
  const state = {
    ui: { activeView: 'logs', logs: { activeTab: 'overview', selectedRunId: options.runId || 'current' } },
    logs: [], diagnosticsSnapshot: { active_run: { run_id: 'current' }, prior_run: { run_id: 'prior' } },
    diagnosticsStatus: status, backend: options.backend || status.backend || {},
    status: options.runtime || {}, phasePercentiles: { payload: status.phase_percentiles || { phases: {} } },
  };
  const renderer = createLogRenderer({ state });
  t.after(() => { renderer.dispose(); dom.window.close(); Object.assign(global, previous); });
  renderer.renderLogs();
  paint();
  return dom.window.document;
}

test('prior-run report excludes current status while the active report preserves it', () => {
  const snapshot = { active_run: { run_id: 'current' }, prior_run: { run_id: 'prior' }, entries: [] };
  const status = { runtime: { model: 'current-model' }, backend: { phase: 'ready' }, trace_timing: { latest: 'current-trace' } };
  const priorText = buildDiagnosticReport(snapshot, status, { runId: 'prior' });
  const prior = JSON.parse(priorText);
  assert.doesNotMatch(priorText, /current-model|current-trace/);
  assert.equal(prior.status_scope, 'prior_run');
  assert.deepEqual(prior.runtime, { available: false, reason: 'not_captured_for_prior_run' });
  assert.deepEqual(prior.observability, prior.runtime);
  const active = JSON.parse(buildDiagnosticReport(snapshot, status, { runId: 'current' }));
  assert.equal(active.status_scope, 'current_launch');
  assert.equal(active.runtime.runtime.model, 'current-model');
  assert.equal(active.observability.trace_timing.latest, 'current-trace');
});

test('prior-run Overview labels live health as current-launch status', (t) => {
  const doc = paintOverview(t, { backend: { phase: 'ready' } }, { runId: 'prior' });
  assert.match(doc.getElementById('diagnosticsSummary').textContent, /Health shows the current launch, not the selected run/);
});

test('facade budget measurements and pressure items render through Overview', (t) => {
  const budgets = buildResourceBudgetFacet({
    usage: { available: true, session: { total_tokens: 21, provider_cost_usd: 0.21 }, cumulative: { total_tokens: 44, provider_cost_usd: 0.44 } },
    resources: { available: true, sidecar: { system_pressure: { status: 'critical', warnings: ['cpu_saturation_high'] } } },
    tool_observability: { available: true, tools: { read_file: { error_count: 2, slow_count: 3 } } },
    slow_operations: { available: true, count: 4, items: [] },
  });
  const doc = paintOverview(t, { budgets });
  const text = doc.getElementById('resourceBudgetsContainer').textContent;
  assert.match(text, /Session tokens21/);
  assert.match(text, /Cumulative tokens44/);
  assert.match(text, /\$0\.21/);
  assert.match(text, /\$0\.44/);
  assert.match(text, /critical/i);
  assert.match(text, /read_file.*2.*3/);
  assert.match(text, /Slow operations4/);
});

test('null and absent facade budget measurements never render zero', (t) => {
  const budgets = buildResourceBudgetFacet({ usage: { available: true, session: {}, cumulative: { total_tokens: 44 } } });
  budgets.usage.session_provider_cost_usd = null;
  budgets.usage.session_total_tokens = null;
  const doc = paintOverview(t, { budgets });
  const host = doc.getElementById('resourceBudgetsContainer');
  assert.match(host.textContent, /Cumulative tokens44/);
  assert.doesNotMatch(host.textContent, /\$0\.00|tokens0/);
  assert.equal(host.querySelectorAll('dd').length, 1);
});

for (const count of [0, 2]) {
  test(`model unavailable with ${count} samples has model copy and never claims pending/live`, (t) => {
    const doc = paintOverview(t, {
      backend: { phase: 'model_unavailable', model_acquisition: { requested_model: 'missing-model' } },
      phase_percentiles: { available: true, phases: count ? { provider_request_start_to_first_chunk: { count, p50: 12 } } : {} },
      tool_observability: { available: true, tools: {} }, slow_operations: { available: true, items: [] },
    });
    assert.match(doc.getElementById('diagnosticsBadge').textContent, /Model unavailable/i);
    assert.doesNotMatch(doc.getElementById('diagnosticsBadge').textContent, /Pending|Live/);
    assert.match(doc.getElementById('diagnosticsOverall').textContent, /Model unavailable/i);
    assert.match(doc.getElementById('performanceAnomaliesContainer').textContent, /model.*unavailable/i);
    assert.match(doc.getElementById('diagnosticsSummary').textContent, /missing-model/);
    assert.doesNotMatch(doc.getElementById('diagnosticsSummary').textContent, /Send a local chat/);
    if (count) assert.match(doc.getElementById('diagnosticsStatus').textContent, /retained/i);
  });
}

for (const engine of ['chatgpt', 'codex-cli']) {
  test(`${engine} empty hints use the active diagnostics engine without local copy`, (t) => {
    const doc = paintOverview(t, {
      backend: { phase: 'ready' }, runtime: { active_engine: engine },
      phase_percentiles: { available: true, phases: {} }, tool_observability: { available: true, tools: {} },
      slow_operations: { available: true, items: [] },
    });
    assert.match(doc.getElementById('diagnosticsSummary').textContent, /Send a chat/);
    assert.match(doc.getElementById('performanceAnomaliesContainer').textContent, /Run a chat or tool/);
    assert.doesNotMatch(doc.getElementById('diagnosticsSummary').textContent, /local/i);
    assert.doesNotMatch(doc.getElementById('performanceAnomaliesContainer').textContent, /local/i);
  });
}

test('non-ready phases label retained samples and never imply live sampling', () => {
  for (const phase of ['sidecar_spawned', 'starting', 'retrying', 'stopping', 'model_acquiring', 'model_loading', 'stopped', 'failed', 'error', 'crashed', 'unknown']) {
    const health = phaseUtils.buildRuntimeHealthSummary({
      phasePercentilesState: { payload: { phases: { example: { count: 1 } } } },
      runtimeHealthState: { backend: { phase }, status: { engine: 'ollama' } },
    });
    assert.notEqual(health.badge, 'Live', phase);
    assert.match(health.status, /retained/i, phase);
    assert.doesNotMatch(health.sampleHint, /live ring buffers/i, phase);
  }
});

test('null phase timings remain unknown and do not pass latency targets', () => {
  assert.equal(phaseUtils.formatMs(null), 'TBD');
  assert.equal(phaseUtils.formatMs(undefined), 'TBD');
  assert.equal(phaseUtils.formatMs(0), '0ms');
  assert.equal(phaseUtils.deriveVerdict({ count: 1, p50: null, p95: null }, { p50: 50, p95: 100 }), 'empty');
});

test('null source counts and slow-operation timings remain unavailable', (t) => {
  const doc = paintOverview(t, { backend: { phase: 'ready' }, slow_operations: { available: true, items: [{ id: 'read_file', observed_ms: null, threshold_ms: null }] } });
  const sourceCell = doc.getElementById('diagnosticsSourceCoverage').querySelector('tbody td');
  assert.equal(sourceCell.textContent, '\u2014');
  const text = doc.getElementById('performanceAnomaliesContainer').textContent;
  assert.doesNotMatch(text, /0ms/);
  assert.match(text, /\u2014 observed/);
});

test('the Overview health pane follows live backend state over the snapshot taken when it opened', (t) => {
  const doc = paintOverview(t, { backend: { phase: 'model_loading' } }, { backend: { phase: 'ready' } });
  assert.match(doc.getElementById('diagnosticsSummary').textContent, /backend ready/i);
});

test('health names the loaded model once ready and the requested model before', () => {
  const runtimeHealthState = (phase) => ({
    backend: { phase, model_lifecycle: { requested_model: 'requested-model' } },
    status: { engine: 'ollama', active_model: 'loaded-model' },
  });
  const ready = phaseUtils.buildRuntimeHealthSummary({ phasePercentilesState: {}, runtimeHealthState: runtimeHealthState('ready') });
  assert.match(JSON.stringify(ready), /loaded-model/);
  assert.doesNotMatch(JSON.stringify(ready), /requested-model/);
  const loading = phaseUtils.buildRuntimeHealthSummary({ phasePercentilesState: {}, runtimeHealthState: runtimeHealthState('model_loading') });
  assert.match(JSON.stringify(loading), /requested-model/);
});
