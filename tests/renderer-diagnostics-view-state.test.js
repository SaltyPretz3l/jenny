'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSnapshotEntries, retainRunEntries, TABS, ensureDiagnosticsViewState, createDiagnosticsWorkspaceRefresher } = require('../renderer/shell/renderer-diagnostics-view-state');

test('run-aware retention preserves prior evidence while trimming current informational rows', () => {
  const prior = Array.from({ length: 250 }, (_, index) => ({ run_id: 'prior', sequence: index + 1, level: 'INFO', event: `prior.${index}` }));
  const current = [
    { run_id: 'current', sequence: 1, level: 'ERROR', event: 'current.failure' },
    ...Array.from({ length: 760 }, (_, index) => ({ run_id: 'current', sequence: index + 2, level: 'INFO', event: `current.${index}` })),
  ];
  const retained = retainRunEntries(prior.concat(current), 'current', 'prior');
  assert.equal(retained.filter((entry) => entry.run_id === 'prior').length, 250);
  assert.equal(retained.filter((entry) => entry.run_id === 'current').length, 750);
  assert.ok(retained.some((entry) => entry.event === 'current.failure'));
});

test('exported frozen tabs define valid view state', () => {
  assert.deepEqual(TABS, ['overview', 'activity', 'runs']);
  assert.equal(Object.isFrozen(TABS), true);
  for (const activeTab of TABS) assert.equal(ensureDiagnosticsViewState({ ui: { logs: { activeTab } } }).activeTab, activeTab);
  assert.equal(ensureDiagnosticsViewState({ ui: { logs: { activeTab: 'invalid' } } }).activeTab, TABS[0]);
});

test('Overview resize is bounded session state and a fresh session gets the default', () => {
  const state = { ui: { logs: { overviewMetricsPercent: 65 } } };
  assert.equal(ensureDiagnosticsViewState(state).overviewMetricsPercent, 65);
  state.ui.logs.activeTab = 'activity';
  assert.equal(ensureDiagnosticsViewState(state).overviewMetricsPercent, 65);
  state.ui.logs.overviewMetricsPercent = 90;
  assert.equal(ensureDiagnosticsViewState(state).overviewMetricsPercent, 75);
  state.ui.logs.overviewMetricsPercent = 20;
  assert.equal(ensureDiagnosticsViewState(state).overviewMetricsPercent, 40);
  assert.equal(ensureDiagnosticsViewState({}).overviewMetricsPercent, 60);
});

function refreshFixture(failStatus = false) {
  const prior = { run_id: 'prior', integrity: { complete: true, partial_reasons: [] } };
  const state = { logs: [], diagnosticsSnapshot: null, diagnosticsRefreshedAt: 1 };
  const snapshot = { entries: [], integrity: { complete: true }, active_run: { run_id: 'current', integrity: { complete: true } }, prior_run: prior };
  const options = {
    state, getShell: () => ({
      diagnostics: { logs: { getSnapshot: async () => snapshot }, getJennyStatus: async () => {
        if (failStatus) throw new Error('offline');
        return {};
      } },
      scheduler: { getState: async () => ({}) }, harness: { inspect: async () => ({}) },
    }), renderIfVisible() {}, onError() {},
    refreshPhasePercentiles: async () => true, refreshObservability: async () => true,
  };
  return { state, prior, options };
}

test('live refresh failures mark current integrity while preserving prior-run evidence', async () => {
  const { state, prior, options } = refreshFixture(true);
  await assert.rejects(createDiagnosticsWorkspaceRefresher(options).refresh(), /status/);
  assert.equal(state.diagnosticsSnapshot.integrity.complete, false);
  assert.deepEqual(state.diagnosticsSnapshot.active_run.integrity.partial_reasons, ['refresh_status_failed']);
  assert.equal(state.diagnosticsSnapshot.prior_run, prior);
  assert.deepEqual(prior.integrity, { complete: true, partial_reasons: [] });
});

test('settled workspace refreshes record an update time on success and partial failure', async () => {
  for (const failStatus of [false, true]) {
    const { state, options } = refreshFixture(failStatus);
    const before = Date.now();
    const pending = createDiagnosticsWorkspaceRefresher(options).refresh();
    if (failStatus) await assert.rejects(pending, /status/);
    else await pending;
    assert.ok(state.diagnosticsRefreshedAt >= before && state.diagnosticsRefreshedAt <= Date.now());
  }
});

test('disposed workspace refreshes do not record an update time', async () => {
  const { state, options } = refreshFixture();
  let disposed = false;
  options.isDisposed = () => disposed;
  const pending = createDiagnosticsWorkspaceRefresher(options).refresh();
  disposed = true;
  assert.deepEqual(await pending, { complete: false });
  assert.equal(state.diagnosticsRefreshedAt, 1);
});

test('snapshot merge preserves only uncommitted renderer origins and assigns them to the active run', () => {
  const snapshot = {
    active_run: { run_id: 'current' }, prior_run: { run_id: 'prior' },
    entries: [
      { entry_id: 'prior:1', run_id: 'prior', sequence: 1, source: 'renderer', event: 'prior.event' },
      { entry_id: 'current:1', run_id: 'current', sequence: 1, source: 'renderer', origin_entry_id: 'boot:committed', event: 'committed' },
    ],
  };
  const merged = mergeSnapshotEntries([
    { source: 'renderer', origin_entry_id: 'boot:pending', event: 'pending' },
    { source: 'renderer', origin_entry_id: 'boot:committed', event: 'duplicate' },
    { source: 'renderer', entry_id: 'legacy-canonical', event: 'must-not-duplicate' },
  ], snapshot);
  assert.equal(merged.filter((entry) => entry.origin_entry_id === 'boot:committed').length, 1);
  assert.equal(merged.some((entry) => entry.event === 'must-not-duplicate'), false);
  assert.equal(merged.find((entry) => entry.event === 'pending').run_id, 'current');
});


test('snapshot merge retains canonical arrivals newer than its watermark', () => {
  const newer = { entry_id: 'run:2', run_id: 'run', sequence: 2, layer: 'sidecar' };
  const snapshot = { active_run: { run_id: 'run' }, entries: [{ entry_id: 'run:1', run_id: 'run', sequence: 1 }] };
  assert.deepEqual(mergeSnapshotEntries([newer], snapshot), [...snapshot.entries, newer]);
});

test('live source counts describe retained rows and integrity includes queue loss', () => {
  const { appendEntryToState } = require('../renderer/shell/renderer-diagnostics-view-state');
  const sources = { sidecar: { count: 0, dropped: 0 } };
  const state = { logs: [], diagnosticsSnapshot: { active_run: { run_id: 'run', sources }, sources, integrity: { complete: true, partial_reasons: [], dropped_by_source: {} } } };
  for (let i = 1; i <= 751; i += 1) appendEntryToState(state, { entry_id: `run:${i}`, run_id: 'run', sequence: i, layer: 'sidecar' });
  assert.equal(sources.sidecar.count, 750);
  // Trimming the display is not capture loss, so a refresh cannot flip it back.
  assert.equal(state.diagnosticsSnapshot.integrity.complete, true);
  appendEntryToState(state, { entry_id: 'run:752', run_id: 'run', sequence: 752, layer: 'sidecar', event: 'sidecar.runtime.diagnostics_queue_dropped', data: { dropped_count: 7 } });
  assert.equal(state.diagnosticsSnapshot.integrity.complete, false);
  assert.equal(state.diagnosticsSnapshot.integrity.dropped_by_source.sidecar, 7);
});


test('a sink-only sidecar loss record marks live integrity partial without counting dropped entries', () => {
  const { appendEntryToState } = require('../renderer/shell/renderer-diagnostics-view-state');
  const integrity = { complete: true, partial_reasons: [], dropped_by_source: {} };
  const state = { logs: [], diagnosticsSnapshot: { active_run: { run_id: 'run' }, integrity } };
  appendEntryToState(state, { entry_id: 'run:1', run_id: 'run', layer: 'sidecar', event: 'sidecar.runtime.diagnostics_queue_dropped', data: { sink_failures: { file: 3 } } });
  assert.equal(integrity.complete, false);
  assert.deepEqual(integrity.partial_reasons, ['sidecar_sink_failed']);
  assert.equal(integrity.sink_failures.sidecar.file, 3);
  assert.equal(integrity.dropped_by_source.sidecar, undefined);
});

test('snapshot watermark prevents replay of records intentionally omitted by retention', () => {
  const snapshot = { active_run: { run_id: 'run', sequence: 2 }, entries: [] };
  assert.deepEqual(mergeSnapshotEntries([
    { run_id: 'run', sequence: 1, entry_id: 'run:1' },
    { run_id: 'run', sequence: 3, entry_id: 'run:3' },
  ], snapshot).map((entry) => entry.sequence), [3]);
});

test('in-flight refresh retains newer canonical queue loss and its integrity', async () => {
  const { appendEntryToState, createDiagnosticsWorkspaceRefresher } = require('../renderer/shell/renderer-diagnostics-view-state');
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  const state = { logs: [], diagnosticsSnapshot: { active_run: { run_id: 'run' } } };
  const refresher = createDiagnosticsWorkspaceRefresher({
    state, getShell: () => ({
      diagnostics: { logs: { getSnapshot: () => response }, getJennyStatus: async () => ({}) },
      scheduler: { getState: async () => ({}) },
      harness: { inspect: async () => ({}) },
    }), renderIfVisible() {}, onError() {},
    refreshPhasePercentiles: async () => true, refreshObservability: async () => true,
  });
  const pending = refresher.refresh();
  appendEntryToState(state, { entry_id: 'run:2', run_id: 'run', sequence: 2, layer: 'sidecar', event: 'sidecar.runtime.diagnostics_queue_dropped', data: { dropped_count: 7 } });
  const sources = { sidecar: { count: 0, dropped: 0 } };
  resolve({ active_run: { run_id: 'run', sequence: 1, sources }, sources, entries: [], integrity: { complete: true, dropped_by_source: {} } });
  assert.equal((await pending).complete, true);
  assert.equal(state.logs.length, 1);
  assert.equal(state.diagnosticsSnapshot.integrity.complete, false);
  assert.equal(state.diagnosticsSnapshot.integrity.dropped_by_source.sidecar, 7);
  assert.equal(sources.sidecar.count, 1);
  assert.equal(sources.sidecar.dropped, 7);
});

test('in-flight refresh keeps sink failures from a newer loss record', async () => {
  const { appendEntryToState, createDiagnosticsWorkspaceRefresher } = require('../renderer/shell/renderer-diagnostics-view-state');
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  const state = { logs: [], diagnosticsSnapshot: { active_run: { run_id: 'run' } } };
  const refresher = createDiagnosticsWorkspaceRefresher({
    state, getShell: () => ({
      diagnostics: { logs: { getSnapshot: () => response }, getJennyStatus: async () => ({}) },
      scheduler: { getState: async () => ({}) },
      harness: { inspect: async () => ({}) },
    }), renderIfVisible() {}, onError() {},
    refreshPhasePercentiles: async () => true, refreshObservability: async () => true,
  });
  const pending = refresher.refresh();
  appendEntryToState(state, { entry_id: 'run:2', run_id: 'run', sequence: 2, layer: 'sidecar', event: 'sidecar.runtime.diagnostics_queue_dropped', data: { sink_failures: { mirror: 2 } } });
  const sources = { sidecar: { count: 0, dropped: 0 } };
  resolve({ active_run: { run_id: 'run', sequence: 1, sources }, sources, entries: [], integrity: { complete: true, dropped_by_source: {} } });
  await pending;
  const integrity = state.diagnosticsSnapshot.integrity;
  assert.equal(integrity.complete, false);
  assert.ok(integrity.partial_reasons.includes('sidecar_sink_failed'));
  assert.equal(integrity.sink_failures.sidecar.mirror, 2);
});
