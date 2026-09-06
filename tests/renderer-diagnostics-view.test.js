'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createLogsEventBindings } = require('../renderer/shell/renderer-diagnostics-event-bindings');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

// Overview groups its issues from the renderer's LIVE client-log ring, not from
// the stubbed snapshot entries. Monaco is unavailable by construction in this
// harness (renderer-shell-harness-dom.js stubs ensureScript to resolve false),
// so the renderer logs a genuine WARN renderer.monaco_fallback into the ring at
// boot. That ambient issue flipped the ready case to 'Warnings detected' and
// pushed a second row into the issue list. Seed the shared Monaco state as
// already-reported (it logs once per window) so the ring reflects only what the
// test itself emits.
const QUIET_MONACO_WINDOW_GLOBALS = {
  __jennyMonacoSharedState: {
    ready: false,
    failed: true,
    readyPromise: null,
    loaderConfigured: true,
    failureReason: 'harness',
    loggedFailure: true,
    requireErrorHookInstalled: true,
  },
};

const OBSERVED_SOURCES = {
  electron: { state: 'observed', capture_state: 'capturing', count: 1 },
  renderer: { state: 'observed', capture_state: 'capturing', count: 1 },
  sidecar: { state: 'observed', capture_state: 'capturing', count: 1 },
};

function inventoryRow(inventory, label) {
  return Array.from(inventory.querySelectorAll('div')).find(
    (candidate) => candidate.querySelector('dt')?.textContent === label,
  ) || null;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test('Diagnostics defaults to Overview and Activity renders oldest-to-newest', async (t) => {
  const entries = [
    { entry_id: 'new', run_id: 'run', sequence: 2, ts: '2026-08-16T00:00:02Z', level: 'ERROR', layer: 'sidecar', component: 'runtime', event: 'runtime.failed', message: 'new' },
    { entry_id: 'old', run_id: 'run', sequence: 1, ts: '2026-08-16T00:00:01Z', level: 'INFO', layer: 'electron', component: 'main', event: 'main.ready', message: 'main.ready' },
    { origin_entry_id: 'renderer-live', run_id: 'run', ts: '2026-08-16T00:00:03Z', level: 'WARN', layer: 'renderer', component: 'shell', event: 'renderer.live', message: 'latest local' },
  ];
  const app = await loadRendererApp({ shell: { diagnostics: { logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries, sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) } } } });
  t.after(async () => app.dispose());
  const { window } = app; const doc = window.document;
  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  assert.equal(doc.getElementById('diagnosticsOverview').hidden, false);
  assert.equal(doc.getElementById('diagnosticsActivity').hidden, true);
  assert.equal(doc.getElementById('diagnosticsOverviewTab').getAttribute('aria-selected'), 'true');
  assert.equal(doc.getElementById('diagnosticsActivityTab').getAttribute('tabindex'), '-1');
  doc.querySelector('[data-tab="activity"]').click(); await waitForUi(window, 40);
  assert.deepEqual(Array.from(doc.querySelectorAll('.diagnostics-log-header > span')).map((cell) => cell.textContent), ['Time', 'Level', 'Source', 'Event', 'Message']);
  const targetIds = new Set(['old', 'new', 'renderer-live']);
  assert.deepEqual(Array.from(doc.querySelectorAll('.log-entry')).map((row) => row.dataset.entryId).filter((id) => targetIds.has(id)), ['old', 'new', 'renderer-live']);
  const firstRow = doc.querySelector('[data-entry-id="old"]');
  assert.equal(firstRow.getAttribute('aria-controls'), 'logDetailPanel');
  assert.equal(firstRow.querySelector('time').getAttribute('title'), '2026-08-16T00:00:01Z');
  assert.doesNotMatch(firstRow.querySelector('time').textContent, /2026-/);
  assert.match(firstRow.querySelector('.log-entry-message').textContent, /—/);
  assert.match(firstRow.getAttribute('aria-label'), /Time 2026-08-16T00:00:01Z/);
  assert.match(firstRow.getAttribute('aria-label'), /Level INFO/);
  assert.match(firstRow.getAttribute('aria-label'), /Source electron/);
  assert.match(firstRow.getAttribute('aria-label'), /Event main\.ready/);
  assert.match(firstRow.getAttribute('aria-label'), /Message No additional message/);
  doc.querySelector('[data-entry-id="old"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(doc.activeElement?.dataset.entryId, 'new');
});

test('Overview distinguishes ready, starting, and unavailable runtime states', async (t) => {
  for (const [phase, label] of [['ready', 'Ready'], ['starting', 'Starting'], ['failed', 'Runtime unavailable']]) {
    const app = await loadRendererApp({
      windowGlobals: QUIET_MONACO_WINDOW_GLOBALS,
      shell: { diagnostics: {
        logs: { getSnapshot: async () => ({ active_run: { run_id: phase }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
        getJennyStatus: async () => ({ schema_version: 3, backend: { phase } }),
      } },
    });
    t.after(async () => app.dispose());
    app.window.document.getElementById('logsTopRailTab').click(); await waitForUi(app.window, 40);
    assert.equal(app.window.document.querySelector('#diagnosticsOverall strong')?.textContent, label);
  }
});

test('Overview renders bounded Runtime Inventory and clears stale health on refresh failure', async (t) => {
  let fail = false;
  const app = await loadRendererApp({
    shell: {
      diagnostics: {
        logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
        getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' } }),
      },
      harness: {
        inspect: async () => {
          if (fail) throw new Error('inventory bridge unavailable');
          return {
            runtime: { active_engine: 'ollama', active_model: 'gemma3:latest', active_mode: 'chat' },
            tools: { items: Array.from({ length: 20 }, (_, index) => ({ name: `tool-${index}` })), counts: { total: 20, enabled: 20, disabled: 0 } },
            memories: { approved: [{ id: 'a' }, { id: 'b' }], pending: [{ id: 'p' }], counts: { approved: 2, pending: 1 }, status: { available: true } },
            skills: { scopes: [{ scope: 'bundled', status: 'ready' }], items: [] },
            workspace: { root: 'C:/dev/jenny', exists: true, blockers: [], workspace_blocked_tools: [] },
            shell: { tools_preferences: {}, companion: {}, proactive: {}, offline: {} },
          };
        },
      },
    },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 60);
  const inventory = app.window.document.getElementById('diagnosticsRuntimeInventory');
  assert.match(inventory.textContent, /ollama · gemma3:latest/);
  // counts.disabled is 0, so the second clause is correctly omitted.
  assert.equal(inventoryRow(inventory, 'Tools').querySelector('dd').textContent, '20 enabled');
  assert.match(inventory.textContent, /2 approved · 1 pending/);
  // The tools row reports counts, never a biased alphabetical sample of names.
  assert.doesNotMatch(inventory.textContent, /tool-\d/);
  // runtime.prompt_experiment has no producer in harness_snapshot.py.
  assert.doesNotMatch(inventory.textContent, /Prompt experiment/);
  const stamp = inventory.querySelector('.diagnostics-inventory-stamp');
  assert.match(stamp.textContent, /^Captured /);
  assert.equal(stamp.getAttribute('aria-hidden'), 'true');
  fail = true;
  app.window.document.querySelector('#diagnosticsRefreshControl button')?.click();
  await waitForUi(app.window, 60);
  assert.match(inventory.textContent, /Runtime inventory unavailable/);
  assert.doesNotMatch(inventory.textContent, /gemma3:latest/);
  assert.equal(inventory.querySelector('.diagnostics-inventory-stamp'), null);
});

test('Runtime Inventory marks partial harness facets unavailable without healthy claims', async (t) => {
  const app = await loadRendererApp({
    shell: {
      diagnostics: {
        logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
        getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' } }),
      },
      harness: {
        inspect: async () => ({
          runtime: { active_engine: 'ollama', active_model: 'gemma3:latest', active_mode: 'chat' },
          tools: { error: 'tool inventory failed', error_type: 'RuntimeError' },
          memories: { error: 'memory inventory failed', error_type: 'RuntimeError' },
          skills: { error: 'skill inventory failed', error_type: 'RuntimeError' },
          workspace: { root: null, exists: false, blockers: ['Workspace root is not configured.'] },
          shell: { error: 'shell inventory failed', error_type: 'RuntimeError' },
        }),
      },
    },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 60);

  const inventory = app.window.document.getElementById('diagnosticsRuntimeInventory');
  for (const label of ['Tools', 'Memory', 'Skills', 'Shell']) {
    const row = inventoryRow(inventory, label);
    assert.equal(row?.querySelector('dd')?.textContent, 'Unavailable');
    assert.equal(row?.getAttribute('data-tone'), 'warn');
  }
  const workspaceRow = inventoryRow(inventory, 'Workspace');
  assert.equal(workspaceRow?.querySelector('dd')?.textContent, 'Not configured');
  assert.equal(workspaceRow?.getAttribute('data-tone'), 'warn');
  // The runtime facet is healthy in this fixture, so Engine must not claim otherwise.
  assert.equal(inventoryRow(inventory, 'Engine')?.getAttribute('data-tone'), 'ok');
});

test('Runtime Inventory tone is styled, not merely attributed', () => {
  // The renderer has always emitted data-tone; before this the stylesheet had no
  // rule for it, so an "Unavailable" row was pixel-identical to a healthy one and
  // the attribute assertions above passed against an invisible signal.
  const css = readFileSync(join(__dirname, '..', 'styles', 'diagnostics-health.css'), 'utf8');
  for (const tone of ['warn', 'danger', 'muted']) {
    assert.match(css, new RegExp(`\\.diagnostics-inventory-list > div\\[data-tone="${tone}"\\] dd`));
  }
  assert.doesNotMatch(css, /\.diagnostics-inventory-list > div \{[^}]*border: 1px solid/s);
});

test('Runtime Inventory reads shell values instead of listing section keys', async (t) => {
  const app = await loadRendererApp({
    shell: {
      diagnostics: {
        logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
        getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' } }),
      },
      harness: {
        inspect: async () => ({
          runtime: { active_engine: 'ollama', active_model: 'gemma3:latest', active_mode: 'chat' },
          skills: { counts: { total: 18 }, scopes: [{ scope: 'bundled', status: 'ready' }, { scope: 'project', status: 'blocked' }] },
          shell: {
            companion: { mode: 'planner' },
            offline: { mode: 'disabled' },
            tools_preferences: { web_enabled: true, image_read_enabled: false, todo_enabled: true, python_runtime_enabled: false },
          },
        }),
      },
    },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 60);

  const inventory = app.window.document.getElementById('diagnosticsRuntimeInventory');
  const shellRow = inventoryRow(inventory, 'Shell');
  assert.equal(shellRow.querySelector('dd').textContent, 'Companion planner · offline disabled · 2 of 4 tool prefs on');
  assert.equal(shellRow.getAttribute('data-tone'), 'ok');
  assert.doesNotMatch(inventory.textContent, /Tools Preferences/);
  const skillsRow = inventoryRow(inventory, 'Skills');
  assert.equal(skillsRow.querySelector('dd').textContent, '18 loaded · 2 scopes · 1 blocked');
  assert.equal(skillsRow.getAttribute('data-tone'), 'warn');
});

test('Runtime Inventory reports an unreachable scheduler instead of dropping the row', async (t) => {
  let schedulerFails = false;
  const app = await loadRendererApp({
    shell: {
      diagnostics: {
        logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
        getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' } }),
      },
      harness: { inspect: async () => ({ runtime: { active_engine: 'ollama', active_model: 'gemma3:latest', active_mode: 'chat' } }) },
      scheduler: {
        getState: async () => {
          if (schedulerFails) throw new Error('scheduler bridge down');
          return { lifecycle: { phase: 'idle', qualifyingTaskCount: 2 } };
        },
      },
    },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 60);

  const inventory = app.window.document.getElementById('diagnosticsRuntimeInventory');
  assert.equal(inventoryRow(inventory, 'Scheduler').querySelector('dd').textContent, 'Idle · 2 enabled tasks');

  schedulerFails = true;
  app.window.document.querySelector('#diagnosticsRefreshControl button')?.click();
  await waitForUi(app.window, 60);

  const failedRow = inventoryRow(inventory, 'Scheduler');
  assert.equal(failedRow.querySelector('dd').textContent, 'Unavailable');
  assert.equal(failedRow.getAttribute('data-tone'), 'warn');
});

test('Runtime Inventory bounds long values and keeps the full text in the title', async (t) => {
  const longError = 'x'.repeat(300);
  const app = await loadRendererApp({
    shell: {
      diagnostics: {
        logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
        getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' } }),
      },
      harness: { inspect: async () => ({ runtime: { active_engine: 'ollama', active_model: 'gemma3:latest', active_mode: 'chat' } }) },
      scheduler: { getState: async () => ({ lifecycle: { phase: 'failed', qualifyingTaskCount: 0, error: longError } }) },
    },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 60);

  const value = inventoryRow(app.window.document.getElementById('diagnosticsRuntimeInventory'), 'Scheduler')
    .querySelector('dd');
  assert.equal(value.textContent.length, 160);
  assert.match(value.textContent, /…$/);
  assert.equal(value.getAttribute('title').includes(longError), true);
});

test('Runtime Inventory does not mutate renderer state after disposal', async () => {
  const inventoryRequest = deferred();
  const app = await loadRendererApp({
    shell: {
      diagnostics: {
        logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
        getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' } }),
      },
      harness: { inspect: async () => inventoryRequest.promise },
    },
  });
  app.window.document.getElementById('logsTopRailTab').click();
  await Promise.resolve();
  const priorHarnessState = app.window.__rendererState.harness;

  await app.dispose();
  inventoryRequest.resolve({
    runtime: { active_engine: 'ollama', active_model: 'late-model', active_mode: 'chat' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.window.__rendererState.harness, priorHarnessState);
  assert.equal(app.window.__rendererState.harness.snapshot, null);
});

test('Overview labels unavailable performance evidence without claiming success', async (t) => {
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
      getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' }, slow_operations: { available: false, items: [] } }),
    } },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 40);
  const summary = app.window.document.getElementById('performanceAnomaliesContainer').textContent;
  assert.match(summary, /Performance evidence unavailable/);
  assert.doesNotMatch(summary, /No performance anomalies/);
});

test('Overview exposes unavailable phase and tool facets instead of suggesting more samples', async (t) => {
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
      getJennyStatus: async () => ({
        schema_version: 3,
        backend: { phase: 'ready' },
        phase_percentiles: { available: false, phases: {} },
        tool_observability: { available: false, tools: {} },
        slow_operations: { available: true, count: 0, items: [] },
      }),
    } },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 40);
  const summary = app.window.document.getElementById('performanceAnomaliesContainer').textContent;
  assert.match(summary, /Performance evidence unavailable/);
  assert.doesNotMatch(summary, /No performance samples yet|Run a local chat/);
});

test('Overview labels performance evidence partial when one latency facet is unavailable', async (t) => {
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
      getJennyStatus: async () => ({
        schema_version: 3,
        backend: { phase: 'ready' },
        phase_percentiles: { available: true, phases: { provider_request_start_to_first_chunk: { count: 1 } } },
        tool_observability: { available: false, tools: {} },
        slow_operations: { available: true, count: 0, items: [] },
      }),
    } },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 40);
  const summary = app.window.document.getElementById('performanceAnomaliesContainer').textContent;
  assert.match(summary, /Performance evidence partial/);
  assert.doesNotMatch(summary, /No performance anomalies/);
});

test('Overview does not recommend sampling while the backend is terminal', async (t) => {
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
      getJennyStatus: async () => ({
        schema_version: 3,
        backend: { phase: 'failed' },
        phase_percentiles: { available: true, phases: {} },
        tool_observability: { available: true, tools: {} },
        slow_operations: { available: true, count: 0, items: [] },
      }),
    } },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 40);
  const summary = app.window.document.getElementById('performanceAnomaliesContainer').textContent;
  assert.match(summary, /Performance evidence unavailable/);
  assert.match(summary, /backend recovers/);
  assert.doesNotMatch(summary, /Run a local chat/);
});

test('Overview does not claim performance success before samples exist', async (t) => {
  let sampled = false;
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) },
      getJennyStatus: async () => ({
        schema_version: 3,
        backend: { phase: 'ready' },
        phase_percentiles: { available: true, phases: sampled ? { provider_request_start_to_first_chunk: { count: 1, p95: 20 } } : {}, targets: {} },
        tool_observability: { available: true, tools: {} },
        slow_operations: { available: true, count: 0, items: [] },
      }),
    } },
  });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 40);
  const summary = app.window.document.getElementById('performanceAnomaliesContainer').textContent;
  assert.match(summary, /No performance samples yet/);
  assert.doesNotMatch(summary, /No performance anomalies/);
  sampled = true;
  app.window.document.getElementById('observabilityRefreshButton').click();
  await waitForUi(app.window, 60);
  assert.match(app.window.document.getElementById('performanceAnomaliesContainer').textContent, /No performance anomalies/);
});

test('issue inspection scopes Activity and selecting a row disengages Follow latest', async (t) => {
  const issue = { entry_id: 'issue', run_id: 'run', sequence: 1, level: 'ERROR', layer: 'sidecar', component: 'runtime.engine', event: 'engine.failed', message: 'failed', trace_id: 'trace-1', request_id: 'request-1', data: { error_code: 'CMP-AI-1' } };
  const app = await loadRendererApp({ shell: { diagnostics: { logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [issue], sources: {}, integrity: { complete: true, partial_reasons: [] } }) } } } });
  t.after(async () => app.dispose());
  const { window } = app; const doc = window.document;
  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  assert.equal(doc.querySelectorAll('#diagnosticsIssueList .log-level-badge').length, 0);
  assert.deepEqual(
    Array.from(doc.querySelectorAll('#diagnosticsIssueList .diagnostics-issue-correlations code')).map((node) => node.textContent),
    ['trace-1', 'request-1'],
  );
  doc.querySelector('[data-action="inspect-diagnostic-issue"]').click(); await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.logs.activeTab, 'activity');
  assert.ok(doc.getElementById('diagnosticsClearScope'));
  const row = doc.querySelector('[data-entry-id="issue"]');
  row.click(); await waitForUi(window, 20);
  assert.equal(window.__rendererState.ui.logs.autoScroll, false);
  assert.equal(doc.getElementById('logDetailPanel').hidden, false);
  assert.equal(doc.querySelector('[data-entry-id="issue"]'), row, 'selection must not rebuild the activity list');
  assert.ok(doc.querySelector('#logDetailPanel .inv-codeblock-wrap'));
  assert.match(doc.getElementById('logDetailPanel').textContent, /Close inspector/);
  assert.match(doc.getElementById('logDetailPanel').textContent, /Back to activity/);
  assert.equal(doc.getElementById('diagnosticsCloseDetail').getAttribute('aria-label'), 'Close inspector and return to activity');
  assert.equal(doc.getElementById('diagnosticsCloseDetail').getAttribute('title'), 'Close inspector and return to activity');
  assert.deepEqual(
    Array.from(doc.querySelectorAll('#logDetailPanel .diagnostics-detail-section > h4')).map((heading) => heading.textContent),
    ['Summary', 'Identity', 'Correlation', 'Structured data'],
  );
  const detailSections = doc.querySelectorAll('#logDetailPanel .diagnostics-detail-section');
  assert.deepEqual(Array.from(detailSections[0].querySelectorAll('dt')).map((term) => term.textContent), ['Message', 'Time', 'Component', 'Run', 'Sequence']);
  assert.deepEqual(Array.from(detailSections[1].querySelectorAll('dt')).map((term) => term.textContent), ['Source', 'Event', 'Level']);
  doc.getElementById('diagnosticsCloseDetail').click(); await waitForUi(window, 40);
  assert.equal(doc.getElementById('logDetailPanel').hidden, true);
  assert.equal(doc.activeElement?.dataset.entryId, 'issue');
  row.click(); await waitForUi(window, 20);
  doc.getElementById('logsView').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(doc.getElementById('logDetailPanel').hidden, true);
  doc.getElementById('diagnosticsClearScope').click(); await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.logs.issueScope, null);
  assert.equal(doc.activeElement, doc.getElementById('logSearchInput'));
});

test('local renderer correlations are redacted and bounded in Overview and detail', async (t) => {
  const app = await loadRendererApp({
    // Without this the ambient monaco_fallback issue is row 0, so both the
    // overviewValues[0] assertion below and the inspect click read the wrong row.
    windowGlobals: QUIET_MONACO_WINDOW_GLOBALS,
    shell: { diagnostics: { logs: { getSnapshot: async () => ({
      active_run: { run_id: 'run' },
      entries: [],
      sources: OBSERVED_SOURCES,
      integrity: { complete: true, partial_reasons: [] },
    }) } } },
  });
  t.after(async () => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);
  await shell.__emitLogAppend({
    origin_entry_id: 'local-correlation',
    run_id: 'run',
    ts: '2026-08-16T00:00:03Z',
    level: 'WARN',
    layer: 'renderer',
    component: 'renderer.lifecycle',
    event: 'renderer.local_warning',
    message: 'Local warning',
    trace_id: 'Bearer local-secret-token',
    request_id: 'r'.repeat(500),
  });
  await waitForUi(window, 80);

  const overviewValues = Array.from(
    doc.querySelectorAll('#diagnosticsIssueList .diagnostics-issue-correlations code'),
  ).map((node) => node.textContent);
  assert.match(overviewValues[0], /Bearer \[redacted\]/);
  assert.equal(overviewValues.some((value) => value.includes('local-secret-token')), false);
  assert.equal(overviewValues.every((value) => value.length <= 160), true);

  // Scope the click to THIS issue's row rather than trusting list order.
  const localIssue = Array.from(doc.querySelectorAll('#diagnosticsIssueList .diagnostics-issue'))
    .find((node) => node.textContent.includes('renderer.local_warning'));
  assert.ok(localIssue, 'the emitted local warning is grouped into an issue row');
  localIssue.querySelector('[data-action="inspect-diagnostic-issue"]').click();
  await waitForUi(window, 40);
  doc.querySelector('[data-entry-id="local-correlation"]').click();
  await waitForUi(window, 20);
  const detailValues = Array.from(
    doc.querySelectorAll('#logDetailPanel .diagnostics-detail-section:nth-of-type(3) code'),
  ).map((node) => node.textContent);
  assert.equal(detailValues.some((value) => value.includes('local-secret-token')), false);
  assert.equal(detailValues.every((value) => value.length <= 160), true);
});

test('run switching clearly selects prior evidence and disables live Follow', async (t) => {
  const snapshot = {
    active_run: { run_id: 'current', sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } },
    prior_run: {
      run_id: 'prior', legacy: false,
      sources: { electron: { state: 'observed', capture_state: 'historical', count: 1 }, renderer: { state: 'waiting', count: 0 }, sidecar: { state: 'waiting', count: 0 } },
      integrity: { complete: false, partial_reasons: ['history_truncated'] },
    },
    entries: [
      { entry_id: 'prior-entry', run_id: 'prior', sequence: 1, level: 'WARN', layer: 'electron', event: 'prior.warn' },
      { entry_id: 'current-entry', run_id: 'current', sequence: 1, level: 'INFO', layer: 'renderer', event: 'current.ready' },
    ],
    sources: {}, integrity: { complete: true, partial_reasons: [] },
  };
  const app = await loadRendererApp({ shell: { diagnostics: { logs: { getSnapshot: async () => snapshot } } } });
  t.after(async () => app.dispose());
  const { window } = app; const doc = window.document;
  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  const runSelect = doc.getElementById('diagnosticsRunSelect');
  runSelect.value = 'prior'; runSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 20);
  assert.match(doc.getElementById('diagnosticsSourceCoverage').textContent, /History Truncated/);
  doc.getElementById('diagnosticsActivityTab').click(); await waitForUi(window, 40);
  assert.deepEqual(Array.from(doc.querySelectorAll('.log-entry')).map((row) => row.dataset.entryId), ['prior-entry']);
  assert.equal(doc.getElementById('logAutoScrollToggle').disabled, true);
});

test('live renderer intake updates active source coverage and never appears in the selected prior run', async (t) => {
  const snapshot = {
    active_run: { run_id: 'current', sources: { electron: { state: 'waiting', count: 0 }, renderer: { state: 'waiting', capture_state: 'awaiting_first_entry', count: 0 }, sidecar: { state: 'waiting', count: 0 } }, integrity: { complete: true, partial_reasons: [] } },
    prior_run: { run_id: 'prior', sources: {}, integrity: { complete: true, partial_reasons: [] } },
    entries: [{ entry_id: 'prior-entry', run_id: 'prior', sequence: 1, level: 'WARN', layer: 'electron', event: 'prior.warn' }],
    sources: { electron: { state: 'waiting', count: 0 }, renderer: { state: 'waiting', capture_state: 'awaiting_first_entry', count: 0 }, sidecar: { state: 'waiting', count: 0 } },
    integrity: { complete: true, partial_reasons: [] },
  };
  const app = await loadRendererApp({ shell: { diagnostics: { logs: { getSnapshot: async () => snapshot } } } });
  t.after(async () => app.dispose());
  const { window, shell } = app; const doc = window.document;
  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  const rendererCountBefore = window.__rendererState.diagnosticsSnapshot.sources.renderer.count;
  await shell.__emitLogAppend({ level: 'WARN', layer: 'renderer', event: 'renderer.live', ts: '2026-08-16T00:00:03Z' });
  assert.equal(window.__rendererState.diagnosticsSnapshot.sources.renderer.count, rendererCountBefore + 1);
  assert.equal(window.__rendererState.diagnosticsSnapshot.sources.renderer.capture_state, 'capturing');
  const runSelect = doc.getElementById('diagnosticsRunSelect');
  runSelect.value = 'prior'; runSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('diagnosticsActivityTab').click(); await waitForUi(window, 40);
  assert.deepEqual(Array.from(doc.querySelectorAll('.log-entry')).map((row) => row.dataset.entryId), ['prior-entry']);
});

test('live bursts coalesce and hidden Diagnostics performs no list DOM work', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  const { window, shell } = app; const doc = window.document;
  const initialMarkup = doc.getElementById('logList').innerHTML;
  await shell.__emitLogAppend({ entry_id: 'hidden', run_id: 'harness-current', sequence: 1, level: 'INFO', layer: 'electron', event: 'hidden.event' });
  await waitForUi(window, 20);
  assert.equal(doc.getElementById('logList').innerHTML, initialMarkup);

  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  doc.getElementById('diagnosticsActivityTab').click(); await waitForUi(window, 20);
  const nativeRaf = window.requestAnimationFrame.bind(window); let frameCount = 0;
  window.requestAnimationFrame = (callback) => { frameCount += 1; return nativeRaf(callback); };
  await Promise.all([1, 2, 3].map((sequence) => shell.__emitLogAppend({ entry_id: `burst-${sequence}`, run_id: 'harness-current', sequence: sequence + 1, level: 'INFO', layer: 'electron', event: 'burst.event' })));
  assert.equal(frameCount, 1);
});

test('first live event replaces the empty state and anchors keyboard navigation', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);
  doc.getElementById('diagnosticsActivityTab').click();
  await waitForUi(window, 30);
  const search = doc.getElementById('logSearchInput');
  search.value = 'first-live-only';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 30);
  assert.ok(doc.querySelector('#logList .diagnostics-empty'));

  await shell.__emitLogAppend({ entry_id: 'first-live', run_id: 'harness-current', sequence: 1, level: 'INFO', layer: 'electron', event: 'first-live-only' });
  await waitForUi(window, 80);
  assert.ok(window.__rendererState.logs.some((entry) => entry.event === 'first-live-only'));
  const row = doc.querySelector('[data-entry-id="first-live"]');
  assert.ok(row);
  assert.equal(row.tabIndex, 0);
  assert.equal(doc.querySelector('#logList .diagnostics-empty'), null);
});

test('Diagnostics Refresh reloads snapshot, status, phase, and observability evidence', async (t) => {
  let snapshotCalls = 0;
  let statusCalls = 0;
  let observabilityCalls = 0;
  let phaseCalls = 0;
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => {
        snapshotCalls += 1;
        return { active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } };
      } },
      getJennyStatus: async (statusOptions) => {
        if (Object.prototype.hasOwnProperty.call(statusOptions || {}, 'include_harness')) statusCalls += 1;
        else observabilityCalls += 1;
        return { schema_version: 3, backend: { phase: 'ready' } };
      },
      phasePercentiles: { get: async () => { phaseCalls += 1; return { phases: {}, targets: {} }; } },
    } },
  });
  t.after(async () => app.dispose());
  const { window } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 50);
  const before = { snapshotCalls, statusCalls, observabilityCalls, phaseCalls };
  doc.getElementById('observabilityRefreshButton').click();
  await waitForUi(window, 60);
  assert.ok(snapshotCalls > before.snapshotCalls);
  assert.ok(statusCalls > before.statusCalls);
  assert.ok(observabilityCalls > before.observabilityCalls);
  assert.ok(phaseCalls > before.phaseCalls);
});

test('opening and manual Diagnostics refreshes share one in-flight workspace request', async (t) => {
  const firstSnapshot = deferred();
  let snapshotCalls = 0;
  let pendingSnapshot = null;
  const snapshot = {
    active_run: { run_id: 'run' },
    entries: [],
    sources: OBSERVED_SOURCES,
    integrity: { complete: true, partial_reasons: [] },
  };
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => {
        snapshotCalls += 1;
        return pendingSnapshot ? pendingSnapshot.promise : snapshot;
      } },
      getJennyStatus: async () => ({ schema_version: 3, backend: { phase: 'ready' } }),
      phasePercentiles: { get: async () => ({ phases: {}, targets: {} }) },
    } },
  });
  t.after(async () => app.dispose());
  const { window } = app;
  const doc = window.document;
  const callsBeforeOpen = snapshotCalls;

  pendingSnapshot = firstSnapshot;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 20);
  doc.getElementById('observabilityRefreshButton').click();
  await waitForUi(window, 20);
  assert.equal(snapshotCalls, callsBeforeOpen + 1);

  pendingSnapshot = null;
  firstSnapshot.resolve(snapshot);
  await waitForUi(window, 80);
  assert.equal(doc.getElementById('observabilityRefreshButton').disabled, false);
  doc.getElementById('observabilityRefreshButton').click();
  await waitForUi(window, 60);
  assert.equal(snapshotCalls, callsBeforeOpen + 2);

  const failedSnapshot = deferred();
  const callsBeforeFailure = snapshotCalls;
  const logsBeforeFailure = window.__rendererState.logs.filter((entry) => entry.event === 'diagnostics.refresh_failed').length;
  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window, 20);
  pendingSnapshot = failedSnapshot;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 20);
  doc.getElementById('observabilityRefreshButton').click();
  await waitForUi(window, 20);
  assert.equal(snapshotCalls, callsBeforeFailure + 1);
  pendingSnapshot = null;
  failedSnapshot.reject(new Error('snapshot unavailable'));
  await waitForUi(window, 80);
  const logsAfterFailure = window.__rendererState.logs.filter((entry) => entry.event === 'diagnostics.refresh_failed').length;
  assert.equal(logsAfterFailure, logsBeforeFailure + 1);
});

test('Diagnostics Refresh marks stale evidence partial and logs every failed facet', async (t) => {
  let failures = new Set();
  const snapshot = {
    active_run: { run_id: 'run', integrity: { complete: true, partial_reasons: [] } },
    entries: [],
    sources: OBSERVED_SOURCES,
    integrity: { complete: true, partial_reasons: [] },
  };
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => {
        if (failures.has('logs')) throw new Error('snapshot unavailable');
        return snapshot;
      } },
      getJennyStatus: async (statusOptions) => {
        const facet = Object.prototype.hasOwnProperty.call(statusOptions || {}, 'include_harness')
          ? 'status'
          : 'observability';
        if (failures.has(facet)) throw new Error(`${facet} unavailable`);
        return { schema_version: 3, backend: { phase: 'ready' } };
      },
      phasePercentiles: { get: async () => {
        if (failures.has('phase_percentiles')) throw new Error('percentiles unavailable');
        return { phases: {}, targets: {} };
      } },
    } },
  });
  t.after(async () => app.dispose());
  const { window } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 50);
  failures = new Set(['logs', 'status', 'phase_percentiles', 'observability']);
  doc.getElementById('observabilityRefreshButton').click();
  await waitForUi(window, 80);
  assert.equal(window.__rendererState.diagnosticsSnapshot.integrity.complete, false);
  const refreshReasons = Array.from(
    window.__rendererState.diagnosticsSnapshot.integrity.partial_reasons,
  ).filter((reason) => reason.startsWith('refresh_'));
  assert.deepEqual(
    refreshReasons,
    ['refresh_logs_failed', 'refresh_status_failed', 'refresh_phase_percentiles_failed', 'refresh_observability_failed'],
  );
  assert.equal(window.__rendererState.diagnosticsSnapshot.active_run.integrity.complete, false);
  assert.match(doc.getElementById('diagnosticsOverall').textContent, /Partial evidence/);
  assert.match(doc.getElementById('diagnosticsSourceCoverage').textContent, /Refresh Logs Failed/);
  assert.ok(window.__rendererState.logs.some((entry) => entry.event === 'diagnostics.refresh_failed'));
  assert.equal(doc.getElementById('observabilityRefreshButton').disabled, false);

  failures = new Set(['logs']);
  doc.getElementById('observabilityRefreshButton').click();
  await waitForUi(window, 80);
  const recoveredReasons = Array.from(
    window.__rendererState.diagnosticsSnapshot.integrity.partial_reasons,
  ).filter((reason) => reason.startsWith('refresh_'));
  assert.deepEqual(recoveredReasons, ['refresh_logs_failed']);
});

test('Diagnostics Refresh rejects array status and reserves integrity space for the current failure', async (t) => {
  let malformedStatus = false;
  const existingReasons = Array.from({ length: 12 }, (_value, index) => `existing_reason_${index}`);
  const snapshot = {
    active_run: { run_id: 'run', integrity: { complete: false, partial_reasons: existingReasons } },
    entries: [],
    sources: OBSERVED_SOURCES,
    integrity: { complete: false, partial_reasons: existingReasons },
  };
  const app = await loadRendererApp({
    shell: { diagnostics: {
      logs: { getSnapshot: async () => snapshot },
      getJennyStatus: async (statusOptions) => {
        if (Object.prototype.hasOwnProperty.call(statusOptions || {}, 'include_harness')) {
          return malformedStatus ? [] : { schema_version: 3, backend: { phase: 'ready' } };
        }
        return { schema_version: 3, backend: { phase: 'ready' }, slow_operations: { available: true, items: [] } };
      },
      phasePercentiles: { get: async () => ({ phases: {}, targets: {} }) },
    } },
  });
  t.after(async () => app.dispose());
  const { window } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 50);

  malformedStatus = true;
  doc.getElementById('observabilityRefreshButton').click();
  await waitForUi(window, 80);
  const reasons = Array.from(window.__rendererState.diagnosticsSnapshot.integrity.partial_reasons);
  assert.equal(reasons.length, 12);
  assert.equal(reasons[0], 'refresh_status_failed');
  assert.equal(window.__rendererState.diagnosticsStatus.backend.phase, 'ready');
  assert.equal(Array.isArray(window.__rendererState.diagnosticsStatus), false);
  assert.ok(window.__rendererState.logs.some((entry) => entry.event === 'diagnostics.refresh_failed'));
});

test('failed percentile reset repaints the visible error state', async (t) => {
  const payload = {
    phases: { provider_request_start_to_first_chunk: { count: 1, p50: 100, p95: 100, p99: 100 } },
    targets: { provider_request_start_to_first_chunk: { p50: 150, p95: 400 } },
  };
  const app = await loadRendererApp({
    shell: {
      phasePercentilesPayload: payload,
      diagnostics: { phasePercentiles: { reset: async () => { throw new Error('reset failed'); } } },
    },
  });
  t.after(async () => app.dispose());
  const { window } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 50);
  assert.equal(doc.getElementById('phasePercentilesResetButton').disabled, false);
  doc.getElementById('phasePercentilesResetButton').click();
  await waitForUi(window, 50);
  assert.match(doc.getElementById('phasePercentilesTable').textContent, /reset failed/i);
});

test('crossing into narrow Activity moves row focus to Back to activity', async (t) => {
  const dom = new JSDOM('<div id="logsView"><div id="logList"><button data-entry-id="entry" tabindex="0">Event</button></div><button id="diagnosticsCloseDetail">Back to activity</button></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  });
  let changeListener = null;
  const query = {
    matches: false,
    addEventListener(type, listener) { if (type === 'change') changeListener = listener; },
    removeEventListener(type, listener) { if (type === 'change' && changeListener === listener) changeListener = null; },
  };
  dom.window.matchMedia = () => query;
  const logList = dom.window.document.getElementById('logList');
  const state = { ui: { logs: { selectedEntryId: 'entry', autoScroll: false } } };
  const bindings = createLogsEventBindings({ state, dom: { logList }, callbacks: { renderLogs() {} } });
  bindings.bind();
  t.after(() => bindings.dispose());

  logList.querySelector('[data-entry-id="entry"]').focus();
  query.matches = true;
  changeListener({ matches: true });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
  assert.equal(dom.window.document.activeElement.id, 'diagnosticsCloseDetail');
});

test('the activity inspector is not a view-panel-registry panel', () => {
  // The logs view declares `panel: null`, so the registry puts `.panel-none` on
  // #workspace.view-shell. `.view-shell.panel-none .view-panel { display: none }`
  // then matched the inspector purely on the shared class name: the panel opened
  // (hidden=false, so the grid reserved its column) but painted nothing.
  const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
  const aside = html.match(/<aside[^>]*id="logDetailPanel"[^>]*>/)[0];
  assert.match(aside, /class="logs-detail-panel"/);
  assert.doesNotMatch(aside, /\bview-panel\b/);

  const registry = readFileSync(join(__dirname, '..', 'renderer', 'shell', 'renderer-view-panel-registry.js'), 'utf8');
  assert.match(registry, /logs:\s*\{\s*panel:\s*null\s*\}/);
  const viewPanelCss = readFileSync(join(__dirname, '..', 'styles', 'view-panel.css'), 'utf8');
  assert.match(viewPanelCss, /\.view-shell\.panel-none \.view-panel/);
});

test('a chat error deep link selects and focuses the turn diagnostic row in Activity', async (t) => {
  const entries = [
    { entry_id: 'unrelated', run_id: 'run', sequence: 1, ts: '2026-08-16T00:00:01Z', level: 'INFO', layer: 'electron', component: 'main', event: 'main.ready' },
    { entry_id: 'turn-diag', run_id: 'run', sequence: 2, ts: '2026-08-16T00:00:02Z', level: 'INFO', layer: 'electron', component: 'chat', event: 'chat.turn_diagnostic_dumped', data: { streamId: 'stream_abc' } },
  ];
  const app = await loadRendererApp({
    shell: { diagnostics: { logs: { getSnapshot: async () => ({
      active_run: { run_id: 'run' },
      entries,
      sources: OBSERVED_SOURCES,
      integrity: { complete: true, partial_reasons: [] },
    }) } } },
  });
  t.after(async () => app.dispose());
  const { window } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);

  /* A stale search would filter the target row out; the deep link has to
   * clear it (and the visible control) on its way in. */
  const search = doc.getElementById('logSearchInput');
  search.value = 'main.ready';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 30);
  assert.equal(doc.querySelector('[data-entry-id="turn-diag"]'), null, 'target hidden by the stale filter');

  /* The real chat-side handler: resolves the entry out of state.logs, writes
   * the diagnostics view state, then asks these bindings to focus the row. */
  const controller = window.rendererShellRuntimeUtils.createShellRuntimeController({
    state: window.__rendererState,
    windowRef: window,
    callbacks: { setActiveView: () => {}, appendClientLog: () => {} },
  });
  await controller.handleErrorRecoveryAction({ action: 'open_logs', streamId: 'stream_abc' });
  await waitForUi(window, 80);

  assert.equal(window.__rendererState.ui.logs.activeTab, 'activity');
  assert.equal(doc.getElementById('diagnosticsActivity').hidden, false, 'Activity tab is showing');
  assert.equal(search.value, '', 'filter control matches the cleared state');
  const row = doc.querySelector('[data-entry-id="turn-diag"]');
  assert.ok(row, 'target row mounted');
  assert.equal(row.getAttribute('aria-selected'), 'true', 'row is the selected entry');
  assert.equal(row.tabIndex, 0, 'row owns the roving tabindex');
  assert.equal(doc.activeElement?.dataset.entryId, 'turn-diag', 'row focused');
  assert.equal(doc.getElementById('logDetailPanel').hidden, false, 'inspector opened on the entry');
});

test('a deep link for an unknown stream leaves Activity usable', async (t) => {
  const app = await loadRendererApp({
    shell: { diagnostics: { logs: { getSnapshot: async () => ({
      active_run: { run_id: 'run' },
      entries: [{ entry_id: 'unrelated', run_id: 'run', sequence: 1, ts: '2026-08-16T00:00:01Z', level: 'INFO', layer: 'electron', component: 'main', event: 'main.ready' }],
      sources: OBSERVED_SOURCES,
      integrity: { complete: true, partial_reasons: [] },
    }) } } },
  });
  t.after(async () => app.dispose());
  const { window } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);

  const controller = window.rendererShellRuntimeUtils.createShellRuntimeController({
    state: window.__rendererState,
    windowRef: window,
    callbacks: { setActiveView: () => {}, appendClientLog: () => {} },
  });
  await controller.handleErrorRecoveryAction({ action: 'open_logs', streamId: 'stream_missing' });
  await waitForUi(window, 60);

  assert.equal(window.__rendererState.ui.logs.activeTab, 'activity', 'still lands on Activity');
  assert.ok(!window.__rendererState.ui.logs.selectedEntryId, 'nothing selected');
  assert.equal(doc.getElementById('logDetailPanel').hidden, true, 'no inspector for a missing entry');
  assert.ok(doc.querySelector('[data-entry-id="unrelated"]'), 'the list still renders normally');
});
