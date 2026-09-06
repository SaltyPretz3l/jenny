(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./diagnostics-issue-utils'), require('./log-contract-utils'));
    return;
  }
  root.diagnosticsReportUtils = factory(root.diagnosticsIssueUtils || {}, root.logContractUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (issueUtils, logContractUtils) {
  'use strict';
  var MAX_EVENTS = 80; var MAX_CHARS = 64000;
  function safe(value, fallback) {
    try {
      var redacted = typeof logContractUtils.redactLogReportValue === 'function'
        ? logContractUtils.redactLogReportValue(value)
        : value;
      return JSON.parse(JSON.stringify(redacted));
    } catch (_error) { return fallback; }
  }
  function summarizeSources(entries, integrity) {
    var sources = {};
    ['electron', 'renderer', 'sidecar'].forEach(function (name) {
      var matching = entries.filter(function (entry) { return String(entry.layer || entry.source || '') === name; });
      sources[name] = {
        state: matching.length ? 'observed' : 'waiting',
        capture_state: matching.length ? 'historical' : 'not_observed',
        count: matching.length,
        last_seen: matching.length ? matching[matching.length - 1].ts || null : null,
        dropped: Number(integrity.dropped_by_source && integrity.dropped_by_source[name] || 0),
      };
    });
    return sources;
  }
  function selectRunEvidence(snapshot, selectedRunId, entries) {
    var value = snapshot || {}; var active = value.active_run || {}; var prior = value.prior_run || {};
    var run = String(selectedRunId || active.run_id || '') === String(prior.run_id || '') ? prior : active;
    if (run.sources && run.integrity) return { sources: run.sources, integrity: run.integrity };
    if (run === active) return { sources: value.sources || {}, integrity: value.integrity || {} };
    var reasons = Array.from(new Set([].concat(value.integrity && value.integrity.partial_reasons || [], ['prior_run_source_integrity_unavailable']))).slice(0, 12);
    var integrity = {
      complete: false,
      partial_reasons: reasons,
      dropped_by_source: {},
      capture_policy: value.integrity && value.integrity.capture_policy || {},
    };
    return { sources: summarizeSources(Array.isArray(entries) ? entries : [], integrity), integrity: integrity };
  }
  function buildDiagnosticReport(snapshot, status, options) {
    var selectedRunId = String(options && options.runId || snapshot && snapshot.active_run && snapshot.active_run.run_id || '');
    var entries = (Array.isArray(snapshot && snapshot.entries) ? snapshot.entries : [])
      .filter(function (entry) { return !selectedRunId || String(entry.run_id || '') === selectedRunId; });
    var evidence = selectRunEvidence(snapshot, selectedRunId, entries);
    var payload = {
      report_kind: 'jenny_diagnostics', schema_version: 1,
      generated_at: new Date().toISOString(), selected_run_id: selectedRunId,
      evidence: {
        complete: evidence.integrity && evidence.integrity.complete === true,
        partial_reasons: safe(evidence.integrity && evidence.integrity.partial_reasons, []),
        sources: safe(evidence.sources, {}),
        capture_policy: safe(evidence.integrity && evidence.integrity.capture_policy, {}),
      },
      runtime: safe({ backend: status && status.backend, runtime: status && status.runtime }, {}),
      grouped_issues: safe((issueUtils.groupIssues ? issueUtils.groupIssues(entries) : []).slice(0, 30), []),
      observability: safe({ phase_percentiles: status && status.phase_percentiles, tool_observability: status && status.tool_observability, slow_operations: status && status.slow_operations, budgets: status && status.budgets, trace_timing: status && status.trace_timing }, {}),
      event_tail: safe(entries.slice(-MAX_EVENTS), []),
      report_truncated: false,
    };
    var text = JSON.stringify(payload, null, 2);
    while (text.length > MAX_CHARS && payload.event_tail.length > 0) {
      payload.event_tail.shift(); payload.report_truncated = true; text = JSON.stringify(payload, null, 2);
    }
    if (text.length > MAX_CHARS) {
      payload.grouped_issues = []; payload.observability = { truncated: true };
      payload.runtime = { truncated: true }; payload.report_truncated = true;
      text = JSON.stringify(payload, null, 2);
    }
    if (text.length > MAX_CHARS) {
      text = JSON.stringify({
        report_kind: payload.report_kind, schema_version: payload.schema_version,
        generated_at: payload.generated_at, selected_run_id: payload.selected_run_id,
        evidence: {
          complete: payload.evidence.complete,
          partial_reasons: Array.isArray(payload.evidence.partial_reasons) ? payload.evidence.partial_reasons.slice(0, 12) : [],
          sources: { truncated: true }, capture_policy: { truncated: true },
        },
        report_truncated: true,
      }, null, 2);
    }
    return text;
  }
  return Object.freeze({ buildDiagnosticReport: buildDiagnosticReport, selectRunEvidence: selectRunEvidence, MAX_EVENTS: MAX_EVENTS });
});
