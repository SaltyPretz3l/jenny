'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnosticReport } = require('../renderer/shared/diagnostics-report-utils');
const { buildResourceBudgetFacet } = require('../services/backend/resource-budget-facade');
const phaseUtils = require('../renderer/shell/renderer-phase-percentiles-utils');
const { createOverviewHarness, makeState, readyBackend, OBSERVED } = require('./helpers/diagnostics-overview-harness');

// What the Overview claims is bounded by the evidence behind it: the selected launch's records, the live
// backend and the measurements the status carries; nothing it cannot show is reported as healthy.

function paint(t, overrides) {
  const harness = createOverviewHarness(t, { actions: {} });
  harness.render(makeState(overrides), []);
  return harness;
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

test('a previous launch shows its own records and none of the live engine', (t) => {
  const harness = paint(t, {
    ui: { logs: { selectedRunId: 'prior' } },
    diagnosticsSnapshot: { active_run: { run_id: 'current' }, prior_run: { run_id: 'prior', sources: { electron: OBSERVED(3) }, integrity: { complete: true } } },
  });
  assert.match(harness.status().querySelector('h3').textContent, /^The previous launch/);
  assert.doesNotMatch(harness.text('diagnosticsOverview'), /gemma3|Ollama|is ready|VRAM|Tokens|Sandbox/);
  assert.ok(harness.group('Records in the previous launch'));
  assert.equal(harness.group('Engine and memory'), null, 'live engine facts are not that launch');
});

test('facade budget measurements render through the Runtime facts', (t) => {
  const budgets = buildResourceBudgetFacet({
    usage: { available: true, session: { total_tokens: 21, provider_cost_usd: 0.21 }, cumulative: { total_tokens: 44, provider_cost_usd: 0.44 } },
    resources: { available: true, sidecar: { system_pressure: { status: 'critical', warnings: ['cpu_saturation_high'] } } },
    tool_observability: { available: true, tools: { read_file: { error_count: 2, slow_count: 3 } } },
    slow_operations: { available: true, count: 4, items: [] },
  });
  const harness = paint(t, { diagnosticsStatus: { backend: readyBackend(), budgets } });
  assert.equal(harness.fact('Tokens').textContent.replace(/\s+/g, ' ').trim(), '21 this session · 44 all time');
  assert.equal(harness.fact('System memory').textContent.replace(/\s+/g, ' ').trim(), 'critical pressure', 'a pressure level is shown even without a percentage');
  assert.ok(harness.fact('System memory').querySelector('svg.inv-state-icon--error'));
  for (const label of ['App memory', 'Model memory']) assert.equal(harness.fact(label).textContent.trim(), 'Not measured', label);
  assert.doesNotMatch(harness.text('diagnosticsRuntimeInventory'), /\$0|NaN/);
});

test('null token figures and null source counts stay unmeasured and never read as zero', (t) => {
  const budgets = buildResourceBudgetFacet({ usage: { available: true, session: {}, cumulative: { total_tokens: 44 } } });
  budgets.usage.session_total_tokens = null;
  const harness = paint(t, {
    diagnosticsStatus: { backend: readyBackend(), budgets },
    diagnosticsSnapshot: { active_run: { run_id: 'run-1', sources: { electron: OBSERVED(null), renderer: OBSERVED(1), sidecar: OBSERVED(1) }, integrity: { complete: true } } },
  });
  assert.equal(harness.fact('Tokens').textContent.replace(/\s+/g, ' ').trim(), '— this session · 44 all time');
  assert.equal(harness.fact('App').textContent.replace(/\s+/g, ' ').trim().split(' ')[0], '—');
});

test('a model that is not available names the requested model and never claims the engine is ready or live', (t) => {
  const backend = { phase: 'model_unavailable', model_acquisition: { requested_model: 'missing-model' } };
  const harness = paint(t, { backend, diagnosticsStatus: { backend } });
  assert.equal(harness.status().querySelector('h3').textContent, 'missing-model isn’t available');
  assert.doesNotMatch(harness.text('diagnosticsOverall'), /ready|working|Pending|Live/);
});

test('engines other than the local ones are named in the status line without local copy', (t) => {
  for (const [engine, name] of [['chatgpt', 'ChatGPT'], ['codex-cli', 'Codex CLI'], ['ollama', 'Ollama']]) {
    const harness = paint(t, { harness: { snapshot: { runtime: { active_engine: engine, active_model: 'm-1' } }, error: '' } });
    assert.match(harness.text('diagnosticsOverall'), new RegExp(`${name} · m-1 is ready`));
    assert.doesNotMatch(harness.text('diagnosticsOverall'), /local/i);
  }
});

test('the status line follows the live backend over the snapshot taken when the page opened', (t) => {
  const harness = paint(t, { backend: readyBackend(), diagnosticsStatus: { backend: { phase: 'model_loading' } } });
  assert.equal(harness.status().querySelector('h3').textContent, 'Jenny is working');
});

test('the status line names the loaded model once ready and the requested model before', (t) => {
  const lifecycle = { requested_model: 'requested-model', engine: 'ollama' };
  const ready = paint(t, { backend: { phase: 'ready', model_lifecycle: lifecycle }, harness: { snapshot: { runtime: { active_engine: 'ollama', active_model: 'loaded-model' } }, error: '' } });
  assert.match(ready.text('diagnosticsOverall'), /loaded-model/);
  assert.doesNotMatch(ready.text('diagnosticsOverall'), /requested-model/);
  const backend = { phase: 'model_loading', model_lifecycle: lifecycle };
  const loading = paint(t, { backend, diagnosticsStatus: { backend }, harness: { snapshot: { runtime: { active_engine: 'ollama', active_model: 'loaded-model' } }, error: '' } });
  assert.match(loading.text('diagnosticsOverall'), /requested-model/);
  assert.doesNotMatch(loading.text('diagnosticsOverall'), /loaded-model/);
});

test('null phase timings remain unknown and do not pass latency targets', () => {
  assert.equal(phaseUtils.deriveVerdict({ count: 1, p50: null, p95: null }, { p50: 50, p95: 100 }), 'empty');
});
