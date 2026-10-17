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
  function selectRunEvidence(snapshot, selectedRunId) {
    var value = snapshot || {}; var active = value.active_run || {}; var prior = value.prior_run || {};
    var runId = String(selectedRunId || active.run_id || '');
    var run = runId === String(active.run_id || '') ? active
      : prior.run_id && runId === String(prior.run_id) ? prior : null;
    return run ? { sources: run.sources || {}, integrity: run.integrity || {} }
      : { available: false, reason: 'run_not_in_snapshot' };
  }
  function buildDiagnosticReport(snapshot, status, options) {
    var selectedRunId = String(options && options.runId || snapshot && snapshot.active_run && snapshot.active_run.run_id || '');
    var evidence = selectRunEvidence(snapshot, selectedRunId);
    var entries = (Array.isArray(snapshot && snapshot.entries) ? snapshot.entries : [])
      .filter(function (entry) { return evidence.available !== false && String(entry.run_id || '') === selectedRunId; });
    var issues = issueUtils.groupIssues ? issueUtils.groupIssues(entries) : [];
    // A group in the report names its members by count only, and keeps the latest data's short scalars,
    // so a noisy issue cannot crowd recent events out of the size cap.
    function reportGroup(group) {
      var slim = Object.assign({}, group, { data: {} });
      delete slim.entry_ids;
      Object.keys(group.data || {}).slice(0, 12).forEach(function (key) {
        var value = group.data[key];
        if (typeof value === 'number' || typeof value === 'boolean') slim.data[key] = value;
        else if (typeof value === 'string') slim.data[key] = value.slice(0, 200);
      });
      return slim;
    }
    var priorRun = Boolean(selectedRunId && selectedRunId !== String(snapshot && snapshot.active_run && snapshot.active_run.run_id || ''));
    var uncaptured = { available: false, reason: 'not_captured_for_prior_run' };
    var payload = {
      report_kind: 'jenny_diagnostics', schema_version: 1,
      generated_at: new Date().toISOString(), selected_run_id: selectedRunId,
      status_scope: priorRun ? 'prior_run' : 'current_launch',
      evidence: evidence.available === false ? evidence : {
        complete: evidence.integrity && evidence.integrity.complete === true,
        partial_reasons: safe(evidence.integrity && evidence.integrity.partial_reasons, []),
        sources: safe(evidence.sources, {}),
        capture_policy: safe(evidence.integrity && evidence.integrity.capture_policy, {}),
      },
      runtime: priorRun ? uncaptured : safe({ backend: status && status.backend, runtime: status && status.runtime, memory_reflection: status && status.memory_reflection }, {}),
      grouped_issues: safe(issues.slice(0, 30).map(reportGroup), []),
      issue_groups_total: issues.length,
      observability: priorRun ? uncaptured : safe({ phase_percentiles: status && status.phase_percentiles, tool_observability: status && status.tool_observability, slow_operations: status && status.slow_operations, budgets: status && status.budgets, trace_timing: status && status.trace_timing }, {}),
      event_tail: safe(entries.slice(-MAX_EVENTS), []),
      event_tail_total: entries.length,
      event_tail_omitted: Math.max(0, entries.length - MAX_EVENTS),
      report_truncated: issues.length > 30 || entries.length > MAX_EVENTS,
    };
    var text = JSON.stringify(payload, null, 2);
    while (text.length > MAX_CHARS && payload.event_tail.length > 0) {
      payload.event_tail.shift(); payload.event_tail_omitted += 1;
      payload.report_truncated = true; text = JSON.stringify(payload, null, 2);
    }
    if (text.length > MAX_CHARS) {
      payload.grouped_issues = []; payload.observability = priorRun ? uncaptured : { truncated: true };
      payload.runtime = priorRun ? uncaptured : { truncated: true }; payload.report_truncated = true;
      text = JSON.stringify(payload, null, 2);
    }
    if (text.length > MAX_CHARS) {
      text = JSON.stringify({
        report_kind: payload.report_kind, schema_version: payload.schema_version,
        generated_at: payload.generated_at, selected_run_id: payload.selected_run_id,
        status_scope: payload.status_scope,
        runtime: priorRun ? uncaptured : { truncated: true },
        observability: priorRun ? uncaptured : { truncated: true },
        evidence: evidence.available === false ? evidence : {
          complete: payload.evidence.complete,
          partial_reasons: Array.isArray(payload.evidence.partial_reasons) ? payload.evidence.partial_reasons.slice(0, 12) : [],
          sources: { truncated: true }, capture_policy: { truncated: true },
        },
        issue_groups_total: payload.issue_groups_total,
        event_tail_total: payload.event_tail_total,
        event_tail_omitted: payload.event_tail_total,
        report_truncated: true,
      }, null, 2);
    }
    return text;
  }
  return Object.freeze({ buildDiagnosticReport: buildDiagnosticReport, selectRunEvidence: selectRunEvidence, MAX_EVENTS: MAX_EVENTS });
});
