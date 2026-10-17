'use strict';

// Diagnostics Overview, status line: one sentence answering "is Jenny working?", a line of context,
// an optional note and at most its one next action.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOverviewHarness, makeState, entry, readyBackend, NOW, LAUNCH_START } = require('./helpers/diagnostics-overview-harness');

const clock = (value) => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const failureBackend = (extra) => ({
  phase: 'model_unavailable',
  model_lifecycle: { failure: { cause: 'out_of_memory', model: 'qwen3:8b', engine: 'ollama', context: 65536, at: new Date(NOW - 120000).toISOString(), ...extra } },
});
const warn = (event, extra) => entry({ event, component: 'electron.main', ...extra });
const error = (event, extra) => entry({ event, level: 'ERROR', component: 'sidecar.memory.index', layer: 'sidecar', ...extra });

function paint(t, overrides, logs) {
  const harness = createOverviewHarness(t, { actions: {} });
  const state = makeState({ logs: logs || [], ...overrides });
  harness.render(state, logs || []);
  const body = harness.status();
  return {
    harness, state, body,
    title: body.querySelector('h3')?.textContent,
    context: body.querySelector('.diagnostics-status-context')?.textContent,
    note: body.querySelector('.diagnostics-status-note')?.textContent,
    icon: body.querySelector('svg.inv-state-icon'),
  };
}

test('before the first snapshot it says Checking and claims nothing about health, sources or issues', (t) => {
  const result = paint(t, { diagnosticsSnapshot: null, diagnosticsRefreshedAt: undefined, harness: { snapshot: null, error: '' } });
  assert.equal(result.title, 'Checking…');
  assert.equal(result.context, 'Reading the records for this launch.');
  assert.equal(result.body.dataset.tone, 'pending');
  assert.ok(result.icon.classList.contains('inv-state-icon--md'));
  assert.doesNotMatch(result.body.textContent, /Jenny is working|error|warning|dropped|incomplete/i);
  assert.equal(result.harness.doc.getElementById('diagnosticsUpdatedAt').textContent, 'Checking');
  assert.equal(result.harness.doc.getElementById('diagnosticsAttention').hidden, true);
  assert.equal(result.note, undefined);
});

test('ready with nothing to report: Jenny is working, with the launch time', (t) => {
  const result = paint(t, {});
  assert.equal(result.title, 'Jenny is working');
  assert.equal(result.context, `Ollama · gemma3:latest is ready. No warnings or errors since ${clock(LAUNCH_START)}.`);
  assert.equal(result.body.dataset.tone, 'ok');
  assert.ok(result.icon.classList.contains('inv-state-icon--ok'));
  assert.equal(result.body.querySelector('button'), null, 'no action when nothing needs one');
  assert.equal(result.harness.doc.getElementById('diagnosticsUpdatedAt').textContent, `Updated ${clock(NOW - 8000)}`);
});

test('warnings only: working, with the count of merged explanations', (t) => {
  const one = paint(t, {}, [warn('ipc.handler_slow')]);
  assert.equal(one.title, 'Jenny is working, with 1 warning');
  assert.equal(one.context, `Ollama · gemma3:latest is ready. The warnings below are since ${clock(LAUNCH_START)}.`);
  assert.equal(one.body.dataset.tone, 'warn');
  assert.ok(one.icon.classList.contains('inv-state-icon--warn'));
  const two = paint(t, {}, [warn('ipc.handler_slow'), warn('some.other_warning', { component: 'tool.run' })]);
  assert.equal(two.title, 'Jenny is working, with 2 warnings');
});

test('errors: the count of errors needing attention, and errors with warnings together', (t) => {
  const one = paint(t, {}, [error('memory.index_write_failed')]);
  assert.equal(one.title, '1 error needs attention');
  assert.equal(one.context, 'Ollama · gemma3:latest is ready.');
  assert.equal(one.body.dataset.tone, 'error');
  assert.ok(one.icon.classList.contains('inv-state-icon--error'));
  const many = paint(t, {}, [error('a.failed'), error('b.failed', { component: 'sidecar.other' }), warn('ipc.handler_slow')]);
  assert.equal(many.title, '2 errors and 1 warning need attention');
  const mixed = paint(t, {}, [error('a.failed'), warn('ipc.handler_slow'), warn('x.warn', { component: 'tool.run' })]);
  assert.equal(mixed.title, '1 error and 2 warnings need attention');
});

test('a model that did not load: the cause, the last attempt and both actions', (t) => {
  const backend = failureBackend();
  const result = paint(t, { backend, diagnosticsStatus: { backend } });
  assert.equal(result.title, 'qwen3:8b didn’t load');
  assert.match(result.context, /^Not enough memory to load it\. A smaller context needs less\. Last tried at .+ with 64K context\.$/);
  assert.equal(result.body.dataset.tone, 'error');
  const retry = result.body.querySelector('[data-action="diagnostics-retry-load"]');
  assert.equal(retry.textContent, 'Retry load');
  assert.equal(retry.dataset.retryModel, 'qwen3:8b');
  assert.equal(retry.dataset.retryEngine, 'ollama');
  assert.ok(retry.classList.contains('btn') && retry.classList.contains('btn--sm'));
  const open = result.body.querySelector('[data-action="diagnostics-open-models"]');
  assert.equal(open.textContent, 'Open Models');
  assert.ok(open.classList.contains('btn--ghost') && open.classList.contains('btn--sm'));
  assert.equal(result.body.querySelectorAll('button').length, 2);
});

test('Retry load that turns the status into Starting hands focus to the status heading', (t) => {
  const backend = failureBackend();
  const result = paint(t, { backend, diagnosticsStatus: { backend } });
  const doc = result.harness.doc;
  result.body.querySelector('[data-action="diagnostics-retry-load"]').focus();
  const loading = { phase: 'model_loading' };
  result.harness.render(makeState({ backend: loading, diagnosticsStatus: { backend: loading } }), []);
  assert.equal(result.body.querySelector('h3').textContent, 'Starting');
  assert.equal(doc.activeElement, result.body.querySelector('h3'));
});

test('a failure with no recorded context or time still reads cleanly', (t) => {
  const backend = failureBackend({ context: null, at: '' , cause: 'timeout' });
  const result = paint(t, { backend, diagnosticsStatus: { backend } });
  assert.equal(result.context, 'Loading took too long and was stopped.');
});

test('starting, acquiring and loading say the page fills in as Jenny reports', (t) => {
  for (const phase of ['starting', 'model_acquiring', 'model_loading']) {
    const backend = { phase, model_lifecycle: { requested_model: 'gemma3:latest', engine: 'ollama' } };
    const result = paint(t, { backend, diagnosticsStatus: { backend, runtime: { engine: 'ollama' } } });
    assert.equal(result.title, 'Starting', phase);
    assert.equal(result.context, 'Ollama is starting gemma3:latest. This page fills in as Jenny reports.', phase);
    assert.equal(result.body.dataset.tone, 'pending');
  }
});

test('an engine that is not running and a model that is not available say so with the backend reason', (t) => {
  const down = { phase: 'failed', detail: 'The local engine exited with code 1.' };
  const stopped = paint(t, { backend: down, diagnosticsStatus: { backend: down, runtime: { engine: 'ollama' } } });
  assert.equal(stopped.title, 'Ollama isn’t running');
  assert.equal(stopped.context, 'The local engine exited with code 1.');
  assert.equal(stopped.body.dataset.tone, 'error');
  const missing = { phase: 'model_unavailable', detail: 'Model not found.', model_acquisition: { requested_model: 'missing-model' } };
  const result = paint(t, { backend: missing, diagnosticsStatus: { backend: missing } });
  assert.equal(result.title, 'missing-model isn’t available');
  assert.equal(result.context, 'Model not found.');
  const reasonless = paint(t, { backend: { phase: 'stopped' }, diagnosticsStatus: { backend: { phase: 'stopped' }, runtime: { engine: 'ollama' } } });
  assert.equal(reasonless.context, undefined, 'no reason, no invented one');
});

test('a live backend newer than the status snapshot wins', (t) => {
  const result = paint(t, { backend: readyBackend(), diagnosticsStatus: { backend: { phase: 'model_loading' } } });
  assert.equal(result.title, 'Jenny is working');
});

test('an unknown backend phase makes no health claim', (t) => {
  const result = paint(t, { backend: {}, diagnosticsStatus: {} });
  assert.equal(result.title, 'Checking…');
  assert.equal(result.context, 'Waiting for Jenny to report its state.');
});

test('warnings with an unknown backend phase give the count, never "working"', (t) => {
  const result = paint(t, { backend: {}, diagnosticsStatus: {} }, [warn('ipc.handler_slow')]);
  assert.equal(result.title, '1 warning needs attention');
  assert.equal(result.body.dataset.tone, 'warn');
  assert.doesNotMatch(result.body.textContent, /working|is ready/);
});

test('partial evidence adds one muted note with a small warning icon', (t) => {
  const run = (integrity, sidecar) => ({ active_run: { run_id: 'run-1', started_at: LAUNCH_START, sources: { sidecar: { state: 'observed', count: 4, ...sidecar } }, integrity } });
  const dropped = paint(t, { diagnosticsSnapshot: run({ complete: false, partial_reasons: ['dropped_records'] }, { dropped: 12 }) });
  assert.equal(dropped.note, '12 records from the local engine were dropped under load, so this picture may be incomplete.');
  assert.ok(dropped.body.querySelector('.diagnostics-status-note svg.inv-state-icon--warn.inv-state-icon--sm'));
  assert.equal(dropped.title, 'Jenny is working', 'the headline does not change');
  const missing = paint(t, { diagnosticsSnapshot: run({ complete: false, partial_reasons: ['source_gap'] }) });
  assert.equal(missing.note, 'Some records are missing, so this picture may be incomplete.');
  const refresh = paint(t, { diagnosticsSnapshot: run({ complete: false, partial_reasons: ['refresh_harness_failed', 'refresh_observability_failed'] }) });
  assert.equal(refresh.note, 'Some of this page couldn’t be refreshed.');
  const complete = paint(t, { diagnosticsSnapshot: run({ complete: true, partial_reasons: [] }) });
  assert.equal(complete.note, undefined);
});

test('a previous launch is described from its own records, never from live engine state', (t) => {
  const prior = (sources) => ({
    ui: { logs: { selectedRunId: 'run-0' } },
    diagnosticsSnapshot: {
      active_run: { run_id: 'run-1', started_at: LAUNCH_START, sources: {}, integrity: { complete: true } },
      prior_run: { run_id: 'run-0', started_at: new Date(NOW - 3 * 86400000).toISOString(), sources: sources || {}, integrity: { complete: true } },
    },
  });
  const clean = paint(t, prior(), []);
  assert.equal(clean.title, 'The previous launch had no warnings or errors');
  assert.doesNotMatch(clean.body.textContent, /gemma3|is ready|is working|Ollama/);
  const logs = [error('a.failed', { run_id: 'run-0' }), error('b.failed', { run_id: 'run-0', component: 'sidecar.other' })];
  const errors = paint(t, prior(), logs);
  assert.equal(errors.title, 'The previous launch had 2 errors');
  assert.doesNotMatch(errors.body.textContent, /gemma3|is ready/);
  assert.equal(errors.body.dataset.tone, 'error');
  const down = failureBackend();
  const failed = paint(t, { ...prior(), backend: down, diagnosticsStatus: { backend: down } }, []);
  assert.equal(failed.title, 'The previous launch had no warnings or errors', 'a live load failure is not that launch');
  assert.equal(failed.body.querySelector('button'), null);
});

test('state changes are announced once through the page announcer', (t) => {
  const { harness, state } = paint(t, {}, []);
  const announcer = harness.doc.getElementById('diagnosticsStatusAnnouncer');
  assert.match(announcer.textContent, /^Jenny is working\./);
  const observer = new harness.window.MutationObserver(() => {});
  observer.observe(announcer, { childList: true, characterData: true, subtree: true });
  harness.render(state, []);
  assert.equal(observer.takeRecords().length, 0, 'an identical state is not announced again');
  const logs = [warn('ipc.handler_slow')];
  harness.render({ ...state, logs }, logs);
  assert.match(announcer.textContent, /^Jenny is working, with 1 warning\./);
});
