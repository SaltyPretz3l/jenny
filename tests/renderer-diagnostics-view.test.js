'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { OBSERVED_SOURCES, deferred } = require('./helpers/diagnostics-view-fixtures');

// Diagnostics page frame in the loaded app: tabs, launches, live intake, refresh and deep links.

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
  assert.deepEqual(Array.from(doc.querySelectorAll('.diagnostics-log-header > span')).map((cell) => cell.textContent), ['Time', '', 'Message', 'Event', 'Source']);
  const targetIds = new Set(['old', 'new', 'renderer-live']);
  assert.deepEqual(Array.from(doc.querySelectorAll('.log-entry')).map((row) => row.dataset.entryId).filter((id) => targetIds.has(id)), ['old', 'new', 'renderer-live']);
  const firstRow = doc.querySelector('[data-entry-id="old"]');
  assert.equal(firstRow.getAttribute('aria-controls'), 'logDetailPanel');
  assert.equal(firstRow.querySelector('time').getAttribute('title'), '2026-08-16T00:00:01Z');
  assert.doesNotMatch(firstRow.querySelector('time').textContent, /2026-/);
  assert.match(firstRow.querySelector('.log-entry-message').textContent, /—/);
  // The narrow layout (no Event column) shows this event name in place of the dash.
  assert.equal(firstRow.querySelector('.log-entry-message .log-entry-message-event').textContent, 'main.ready');
  assert.match(firstRow.getAttribute('aria-label'), /Time 2026-08-16T00:00:01Z/);
  assert.match(firstRow.getAttribute('aria-label'), /Level INFO/);
  assert.match(firstRow.getAttribute('aria-label'), /Source App,/);
  assert.match(firstRow.getAttribute('aria-label'), /Event main\.ready/);
  assert.match(firstRow.getAttribute('aria-label'), /Message No additional message/);
  doc.querySelector('[data-entry-id="old"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(doc.activeElement?.dataset.entryId, 'new');
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
  // A previous launch is described from its own records, with its partial history said once.
  assert.match(doc.getElementById('diagnosticsOverall').textContent, /The previous launch had 1 warning/);
  assert.match(doc.getElementById('diagnosticsOverall').textContent, /Some records are missing/);
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
  const refreshButton = doc.getElementById('observabilityRefreshButton');
  refreshButton.focus();
  refreshButton.click();
  await waitForUi(window, 20);
  assert.equal(snapshotCalls, callsBeforeOpen + 1);
  // Busy keeps the button focusable: aria-disabled, not the disabled property.
  assert.equal(refreshButton.getAttribute('aria-disabled'), 'true');
  assert.equal(refreshButton.disabled, false);
  assert.equal(doc.activeElement, refreshButton);

  pendingSnapshot = null;
  firstSnapshot.resolve(snapshot);
  await waitForUi(window, 80);
  assert.equal(refreshButton.hasAttribute('aria-disabled'), false);
  refreshButton.click();
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
  assert.match(doc.getElementById('diagnosticsOverall').textContent, /Some of this page couldn’t be refreshed\./);
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
