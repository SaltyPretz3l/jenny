'use strict';
// Diagnostics › Runs (owner, 2026-10-03): the Runs board left Settings and is
// the third Diagnostics tab. Split from renderer-diagnostics-view.test.js
// (file-size ceiling).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { snapshot, item } = require('./helpers/runs-orchestration-harness');

const OBSERVED_SOURCES = {
  electron: { state: 'observed', capture_state: 'capturing', count: 1 },
  renderer: { state: 'observed', capture_state: 'capturing', count: 1 },
  sidecar: { state: 'observed', capture_state: 'capturing', count: 1 },
};

test('Diagnostics › Runs: a third tab mounts the Runs board (owner, 2026-10-03)', async (t) => {
  let reads = 0;
  const app = await loadRendererApp({
    shell: {
      diagnostics: { logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) } },
      sessionRuntime: {
        // Only the board asks for the Runs shape; other readers (the away digest) are not counted.
        getSnapshot: async (payload) => {
          if (payload?.view === 'runs') reads += 1;
          return snapshot([item('work_a', { session_id: 'session_runs_a' })]);
        },
        getWork: async () => ({ ok: false }),
      },
    },
  });
  t.after(async () => app.dispose());
  const { window } = app; const doc = window.document;
  // Settings no longer carries a Runs card or rail item.
  assert.equal(doc.querySelector('[data-settings-section="runs"]'), null);
  assert.equal(doc.getElementById('sessionRunsMount'), null);
  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  const tabs = Array.from(doc.querySelectorAll('#diagnosticsTabs [role="tab"]'));
  assert.deepEqual(tabs.map((tab) => [tab.dataset.tab, tab.id, tab.getAttribute('aria-controls'), tab.textContent.trim()]), [
    ['overview', 'diagnosticsOverviewTab', 'diagnosticsOverview', 'Overview'],
    ['activity', 'diagnosticsActivityTab', 'diagnosticsActivity', 'Activity'],
    ['runs', 'diagnosticsRunsTab', 'diagnosticsRuns', 'Runs'],
  ]);
  const panel = doc.getElementById('diagnosticsRuns');
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.equal(panel.getAttribute('aria-labelledby'), 'diagnosticsRunsTab');
  assert.equal(panel.hidden, true);
  assert.equal(reads, 0, 'no runs poll before the tab is shown');

  // The board rides the runtime console the Settings page group publishes (lazy since row 32 W2), so the first show loads that group.
  doc.querySelector('[data-tab="runs"]').click(); await waitForUi(window, 400);
  assert.equal(panel.hidden, false);
  assert.equal(doc.getElementById('diagnosticsOverview').hidden, true);
  assert.equal(doc.getElementById('diagnosticsActivity').hidden, true);
  assert.equal(doc.getElementById('diagnosticsRunsTab').getAttribute('aria-selected'), 'true');
  assert.equal(doc.getElementById('diagnosticsRunsTab').getAttribute('tabindex'), '0');
  assert.equal(doc.getElementById('diagnosticsOverviewTab').getAttribute('tabindex'), '-1');
  assert.ok(panel.querySelector('.runs-header'), 'the Runs board is attached');
  assert.ok(reads >= 1, 'the board reads while it shows');
  assert.ok(panel.querySelector('.runs-row[data-work-id="work_a"]'));

  // Keyboard: the arrows cycle all three tabs; Home and End jump to the ends.
  const tablist = doc.getElementById('diagnosticsTabs');
  const press = async (key) => { tablist.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })); await waitForUi(window, 40); };
  await press('ArrowRight');
  assert.equal(window.__rendererState.ui.logs.activeTab, 'overview', 'ArrowRight wraps from Runs to Overview');
  await press('ArrowLeft');
  assert.equal(window.__rendererState.ui.logs.activeTab, 'runs', 'ArrowLeft wraps from Overview to Runs');
  await press('ArrowLeft');
  assert.equal(window.__rendererState.ui.logs.activeTab, 'activity');
  await press('End');
  assert.equal(window.__rendererState.ui.logs.activeTab, 'runs');
  await press('Home');
  assert.equal(window.__rendererState.ui.logs.activeTab, 'overview');
  assert.equal(panel.hidden, true);
});

test('Diagnostics › Runs: the header evidence controls step away, and renderer teardown ends the poll', async (t) => {
  let reads = 0;
  const app = await loadRendererApp({
    shell: {
      diagnostics: { logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [], sources: OBSERVED_SOURCES, integrity: { complete: true, partial_reasons: [] } }) } },
      sessionRuntime: {
        getSnapshot: async (payload) => {
          if (payload?.view === 'runs') reads += 1;
          return snapshot([item('work_a', { session_id: 'session_runs_a' })]);
        },
        getWork: async () => ({ ok: false }),
      },
    },
  });
  t.after(async () => app.dispose());
  const { window } = app; const doc = window.document;
  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  const actions = doc.querySelector('#logsMasthead .diagnostics-header-actions');
  assert.equal(actions.hidden, false, 'Overview keeps the evidence window and report');
  doc.querySelector('[data-tab="runs"]').click(); await waitForUi(window, 400);
  assert.equal(actions.hidden, true, '"Current run" would read as part of the Runs board');
  assert.ok(reads >= 1);
  assert.ok(window.rendererRuntimeConsole, 'the console seam is published');

  await window.__disposeRenderer();
  const afterDispose = reads;
  await new Promise((resolve) => setTimeout(resolve, 2600)); // past one 2 s poll tick
  assert.equal(reads, afterDispose, 'no runs read after the renderer is disposed');
  assert.equal(window.rendererRuntimeConsole, null, 'the seam goes with its binder set');
});
