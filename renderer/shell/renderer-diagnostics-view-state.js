(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(require('../shared/log-contract-utils')); return; }
  root.rendererDiagnosticsViewState = factory(root.logContractUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (logContractUtils) {
  'use strict';
  var retention = logContractUtils.LOG_RETENTION || {};
  var CURRENT_LIMIT = Number(retention.diagnosticsCurrentRunLimit) || 750;
  var PRIOR_LIMIT = Number(retention.diagnosticsPriorRunLimit) || 250;
  function ensure(state) {
    state.ui = state.ui || {}; state.ui.logs = state.ui.logs || {};
    var value = state.ui.logs;
    if (!['overview', 'activity', 'runs'].includes(value.activeTab)) value.activeTab = 'overview';
    if (!value.selectedRunId) value.selectedRunId = '';
    if (!value.levelFilter) value.levelFilter = 'all';
    if (!value.sourceFilter) value.sourceFilter = 'all';
    if (typeof value.query !== 'string') value.query = '';
    if (typeof value.autoScroll !== 'boolean') value.autoScroll = true;
    if (!value.selectedEntryId) value.selectedEntryId = '';
    return value;
  }
  function resetLogsViewState(state) {
    var value = ensure(state); value.query = ''; value.levelFilter = 'all'; value.sourceFilter = 'all';
    value.selectedEntryId = ''; value.issueScope = null; value.autoScroll = true; return value;
  }
  function focusDiagnosticsTarget(state, target) {
    var value = ensure(state);
    if (!value.returnState) {
      value.returnState = {
        activeTab: value.activeTab, query: value.query,
        levelFilter: value.levelFilter, sourceFilter: value.sourceFilter,
        issueScope: value.issueScope || null, selectedRunId: value.selectedRunId,
        selectedEntryId: value.selectedEntryId, autoScroll: value.autoScroll,
      };
    }
    value.activeTab = target.tab;
    value.query = target.query || '';
    value.levelFilter = 'all'; value.sourceFilter = 'all';
    value.issueScope = target.issueScope || null;
    if (target.runId !== undefined) value.selectedRunId = target.runId;
    value.selectedEntryId = target.entryId || '';
    value.autoScroll = false;
    return value;
  }
  function trimBucket(entries, limit) {
    if (entries.length <= limit) return entries;
    var removeCount = entries.length - limit; var removed = new Set();
    ['DEBUG', 'INFO'].forEach(function (level) {
      for (var index = 0; index < entries.length && removed.size < removeCount; index += 1) {
        if (String(entries[index] && entries[index].level || 'INFO').toUpperCase() === level) removed.add(index);
      }
    });
    for (var index = 0; index < entries.length && removed.size < removeCount; index += 1) removed.add(index);
    return entries.filter(function (_entry, index) { return !removed.has(index); });
  }
  function retainRunEntries(entries, activeRunId, priorRunId) {
    var activeId = String(activeRunId || ''); var priorId = String(priorRunId || '');
    var active = []; var prior = [];
    (Array.isArray(entries) ? entries : []).forEach(function (entry) {
      var runId = String(entry && entry.run_id || activeId);
      if (priorId && runId === priorId) prior.push(entry);
      else if (!activeId || runId === activeId) active.push(entry);
    });
    return trimBucket(prior, PRIOR_LIMIT).concat(trimBucket(active, CURRENT_LIMIT));
  }
  function updateActiveSources(snapshot, entries) {
    var activeRunId = String(snapshot && snapshot.active_run && snapshot.active_run.run_id || '');
    [snapshot.sources, snapshot.active_run && snapshot.active_run.sources].filter(function (value, index, values) {
      return value && values.indexOf(value) === index;
    }).forEach(function (sources) {
      Object.keys(sources).forEach(function (name) {
        var retained = entries.filter(function (entry) {
          return String(entry.run_id || activeRunId) === activeRunId && String(entry.layer || entry.source || 'electron') === name;
        });
        var source = sources[name]; source.count = retained.length;
        var integrity = snapshot.active_run && snapshot.active_run.integrity || snapshot.integrity || {};
        source.dropped = Number((integrity.dropped_by_source || {})[name] || 0);
        if (retained.length) {
          source.last_seen = retained[retained.length - 1].ts || null;
          source.state = 'observed'; source.capture_state = 'capturing';
        }
      });
    });
  }
  function eachPartialIntegrity(snapshot, reason, apply) {
    [snapshot, snapshot.active_run].filter(Boolean).map(function (run) {
      return run.integrity || (run.integrity = {});
    }).filter(function (value, index, values) { return values.indexOf(value) === index; }).forEach(function (integrity) {
      integrity.complete = false;
      integrity.partial_reasons = Array.from(new Set((integrity.partial_reasons || []).concat(reason))).slice(0, 12);
      apply(integrity);
    });
  }
  function recordLoss(snapshot, source, count, reason) {
    if (!snapshot || !Number.isSafeInteger(count) || count <= 0) return;
    eachPartialIntegrity(snapshot, reason, function (integrity) {
      var drops = integrity.dropped_by_source || (integrity.dropped_by_source = {});
      drops[source] = Math.min(Number.MAX_SAFE_INTEGER, Number(drops[source] || 0) + count);
    });
  }
  // Records the sidecar accepted but could not persist or mirror; mirrors the
  // main process tally in diagnostic-log-service.js (integrity.sink_failures).
  function recordSinkFailures(snapshot, failures) {
    if (!snapshot || !failures || typeof failures !== 'object') return;
    ['file', 'mirror'].forEach(function (sink) {
      var count = failures[sink];
      if (!Number.isSafeInteger(count) || count <= 0) return;
      eachPartialIntegrity(snapshot, 'sidecar_sink_failed', function (integrity) {
        var bySource = integrity.sink_failures || (integrity.sink_failures = {});
        var sidecar = bySource.sidecar || (bySource.sidecar = { file: 0, mirror: 0 });
        sidecar[sink] = Math.min(Number.MAX_SAFE_INTEGER, Number(sidecar[sink] || 0) + count);
      });
    });
  }
  function appendEntryToState(state, entry) {
    var snapshot = state.diagnosticsSnapshot || {}; var activeRunId = String(snapshot.active_run && snapshot.active_run.run_id || '');
    var normalized = entry.run_id || !activeRunId ? entry : Object.assign({}, entry, { run_id: activeRunId });
    if (normalized.entry_id && state.logs.some(function (row) { return row.entry_id === normalized.entry_id; })) return normalized;
    state.logs.push(normalized);
    if (normalized.event === 'sidecar.runtime.diagnostics_queue_dropped') {
      recordLoss(snapshot, 'sidecar', normalized.data && normalized.data.dropped_count, 'entries_dropped');
      recordSinkFailures(snapshot, normalized.data && normalized.data.sink_failures);
    }
    // Display retention is not capture loss: integrity reports only what capture
    // lost, and the source counts describe the retained rows, here and on refresh.
    var retained = retainRunEntries(state.logs, activeRunId, snapshot.prior_run && snapshot.prior_run.run_id);
    state.logs = retained; updateActiveSources(snapshot, retained);
    return normalized;
  }
  function mergeSnapshotEntries(existingEntries, snapshot) {
    var current = Array.isArray(existingEntries) ? existingEntries : [];
    var canonical = Array.isArray(snapshot && snapshot.entries) ? snapshot.entries : [];
    var activeRunId = String(snapshot && snapshot.active_run && snapshot.active_run.run_id || '');
    var priorRunId = String(snapshot && snapshot.prior_run && snapshot.prior_run.run_id || '');

    var identities = new Set(canonical.map(function (entry) { return entry.entry_id || (entry.run_id && entry.sequence ? entry.run_id + ':' + entry.sequence : ''); }).filter(Boolean));
    var watermark = Math.max(Number(snapshot.active_run && snapshot.active_run.sequence) || 0, ...canonical.filter(function (entry) { return entry.run_id === activeRunId; }).map(function (entry) { return Number(entry.sequence) || 0; }));
    var newer = current.filter(function (entry) {
      var identity = entry.entry_id || (entry.run_id && entry.sequence ? entry.run_id + ':' + entry.sequence : '');
      return entry.run_id === activeRunId && Number(entry.sequence) > watermark && !identities.has(identity);
    });
    var canonicalOrigins = new Set(canonical.concat(newer).map(function (entry) { return entry.origin_entry_id; }).filter(Boolean));
    var localRenderer = current.filter(function (entry) {
      return (entry && entry.source === 'renderer') || (entry && entry.layer === 'renderer');
    }).filter(function (entry) {
      return entry.origin_entry_id && !entry.entry_id && !Number(entry.sequence) && !canonicalOrigins.has(entry.origin_entry_id);
    }).map(function (entry) {
      return entry.run_id || !activeRunId ? entry : Object.assign({}, entry, { run_id: activeRunId });
    });
    return retainRunEntries(canonical.concat(newer, localRenderer), activeRunId, priorRunId);
  }
  function createDiagnosticsWorkspaceRefresher(options) {
    var refreshPromise = null;
    function isDisposed() { return options.isDisposed && options.isDisposed(); }
    function disposedResult() { return { complete: false }; }
    function markIncomplete(integrity, reasons) {
      var base = integrity && typeof integrity === 'object' && !Array.isArray(integrity) ? integrity : {};
      var prior = (Array.isArray(base.partial_reasons) ? base.partial_reasons : [])
        .filter(function (reason) { return !/^refresh_.+_failed$/.test(String(reason)); });
      return Object.assign({}, base, {
        complete: false,
        partial_reasons: Array.from(new Set(reasons.concat(prior))).slice(0, 12),
      });
    }
    async function run() {
      var shell = options.getShell();
      var refreshers = [
        ['logs', async function () {
          var snapshot = await shell.diagnostics?.logs?.getSnapshot?.();
          if (isDisposed()) return;
          if (!snapshot || !Array.isArray(snapshot.entries)) throw new Error('logs unavailable');
          options.state.diagnosticsSnapshot = snapshot;
          options.state.logs = mergeSnapshotEntries(options.state.logs, snapshot);
          var watermark = Math.max(Number(snapshot.active_run && snapshot.active_run.sequence) || 0, ...snapshot.entries.map(function (entry) {
            return entry.run_id === snapshot.active_run?.run_id ? Number(entry.sequence) || 0 : 0;
          }));
          options.state.logs.forEach(function (entry) {
            if (entry.run_id === snapshot.active_run?.run_id && Number(entry.sequence) > watermark && entry.event === 'sidecar.runtime.diagnostics_queue_dropped') {
              recordLoss(snapshot, 'sidecar', entry.data && entry.data.dropped_count, 'entries_dropped');
              recordSinkFailures(snapshot, entry.data && entry.data.sink_failures);
            }
          });
          updateActiveSources(snapshot, options.state.logs);
        }],
        ['status', async function () {
          // No harness snapshot (tools, memories, skills); the sidecar pressure rides its own light read.
          var status = await shell.diagnostics?.getJennyStatus?.({ include_harness: false, include_system_pressure: true });
          if (isDisposed()) return;
          if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('status unavailable');
          options.state.diagnosticsStatus = status;
        }],
        ['scheduler', async function () {
          try {
            var scheduler = await shell.scheduler?.getState?.();
            if (isDisposed()) return;
            if (!scheduler || typeof scheduler !== 'object' || Array.isArray(scheduler)) throw new Error('scheduler status unavailable');
            options.state.schedulerDiagnostics = scheduler;
          } catch (error) {
            // Clear rather than leave the prior value on screen: a stale row
            // reads as current, and an omitted row reads as nothing to report.
            if (isDisposed()) return;
            options.state.schedulerDiagnostics = null;
            throw error;
          }
        }],
        ['runtime_inventory', async function () {
          if (!shell.harness?.inspect) throw new Error('runtime inventory bridge unavailable');
          try {
            var inventory = await shell.harness.inspect({
              sections: ['runtime', 'tools', 'memories', 'skills', 'workspace', 'shell'],
              include_recent_history: false,
              recent_history_limit: 1,
            });
            if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
              throw new Error('runtime inventory malformed');
            }
            if (isDisposed()) return;
            options.state.harness = Object.assign({}, options.state.harness || {}, {
              snapshot: inventory, error: '', loadedAt: Date.now(),
            });
          } catch (error) {
            if (isDisposed()) return;
            options.state.harness = Object.assign({}, options.state.harness || {}, {
              snapshot: null, error: error?.message || String(error),
            });
            throw error;
          }
        }],
        ['phase_percentiles', async function () {
          if (!await options.refreshPhasePercentiles()) throw new Error('phase percentiles unavailable');
        }],
        ['observability', async function () {
          if (!await options.refreshObservability()) throw new Error('observability unavailable');
        }],
      ];
      var results = await Promise.allSettled(refreshers.map(function (entry) { return entry[1](); }));
      if (isDisposed()) return disposedResult();
      var failed = results.flatMap(function (result, index) {
        return result.status === 'rejected' ? [refreshers[index][0]] : [];
      });
      if (failed.length) {
        var reasons = failed.map(function (facet) { return 'refresh_' + facet + '_failed'; });
        var snapshot = options.state.diagnosticsSnapshot;
        snapshot = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
        var markRun = function (run) {
          return run ? Object.assign({}, run, { integrity: markIncomplete(run.integrity, reasons) }) : run;
        };
        options.state.diagnosticsSnapshot = Object.assign({}, snapshot, {
          integrity: markIncomplete(snapshot.integrity, reasons),
          active_run: markRun(snapshot.active_run),
          prior_run: markRun(snapshot.prior_run),
        });
      }
      options.renderIfVisible();
      if (failed.length) throw new Error('Diagnostics refresh incomplete: ' + failed.join(', '));
      return { complete: true };
    }
    function refresh() {
      if (isDisposed()) return Promise.resolve(disposedResult());
      if (!refreshPromise) {
        refreshPromise = run().catch(function (error) {
          options.onError(error);
          throw error;
        }).finally(function () { refreshPromise = null; });
      }
      return refreshPromise;
    }
    return Object.freeze({ refresh: refresh });
  }
  return Object.freeze({
    ensureDiagnosticsViewState: ensure,
    resetLogsViewState: resetLogsViewState,
    focusDiagnosticsTarget: focusDiagnosticsTarget,
    mergeSnapshotEntries: mergeSnapshotEntries,
    retainRunEntries: retainRunEntries,
    appendEntryToState: appendEntryToState,
    createDiagnosticsWorkspaceRefresher: createDiagnosticsWorkspaceRefresher,
  });
});
