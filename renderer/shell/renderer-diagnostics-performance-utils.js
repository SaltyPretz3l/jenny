(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-phase-percentiles-utils'), require('../shared/string-utils'));
    return;
  }
  root.rendererDiagnosticsPerformanceUtils = factory(root.rendererPhasePercentilesUtils, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (phaseUtils, stringUtils) {
  'use strict';
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var escapeHtml = stringUtils.escapeHtml;

  function humanize(value, fallback) {
    var text = String(value || '').trim();
    if (!text) return fallback || jt('diagnostics.common.unknown', 'Unknown');
    return text.replace(/[._-]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function formatNumber(value) {
    if (value == null || String(value).trim() === '') return '\u2014';
    var number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString(globalThis.jennyI18n?.tag?.()) : '\u2014';
  }

  function formatMetricMs(value) {
    if (value == null || String(value).trim() === '') return '\u2014';
    var number = Number(value);
    if (!Number.isFinite(number)) return '\u2014';
    return number >= 1000 ? (number / 1000).toFixed(2) + 's' : Math.round(number) + 'ms';
  }

  function hasPositiveCounts(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).some(function (item) {
      var count = Number(item?.count);
      return Number.isFinite(count) && count > 0;
    });
  }

  function hasPerformanceSamples(status) {
    return hasPositiveCounts(status.phase_percentiles?.phases)
      || hasPositiveCounts(status.tool_observability?.tools);
  }

  function budgetDisplayRows(budgets) {
    if (!budgets || budgets.available !== true) return [];
    var rows = [];
    var usage = budgets.inputs?.usage === true ? budgets.usage || {} : {};
    [
      ['session_total_tokens', jt('diagnostics.budgets.sessionTokens', 'Session tokens'), false],
      ['cumulative_total_tokens', jt('diagnostics.budgets.cumulativeTokens', 'Cumulative tokens'), false],
      ['session_provider_cost_usd', jt('diagnostics.budgets.sessionProviderCost', 'Session provider cost'), true],
      ['cumulative_provider_cost_usd', jt('diagnostics.budgets.cumulativeProviderCost', 'Cumulative provider cost'), true],
    ].forEach(function (field) {
      var value = usage[field[0]];
      if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) return;
      rows.push([field[1], field[2] ? '$' + Number(value).toFixed(2) : formatNumber(value), 'ok']);
    });
    (Array.isArray(budgets.items) ? budgets.items : []).forEach(function (item) {
      if (item.kind === 'resource_pressure') {
        var pressureLabels = { critical: jt('diagnostics.budgets.critical', 'Critical'), warning: jt('diagnostics.budgets.warning', 'Warning'), normal: jt('diagnostics.budgets.normal', 'Normal') };
        rows.push([jt('diagnostics.budgets.resourcePressure', 'Resource pressure'), pressureLabels[item.status] || humanize(item.status), item.status === 'critical' ? 'error' : 'warn']);
      } else if (item.kind === 'tool_pressure') {
        var measurements = [];
        if (item.error_count != null && Number.isFinite(Number(item.error_count))) measurements.push(jt('diagnostics.budgets.toolErrors', '{count} errors', { count: formatNumber(item.error_count) }));
        if (item.slow_count != null && Number.isFinite(Number(item.slow_count))) measurements.push(jt('diagnostics.budgets.toolSlow', '{count} slow', { count: formatNumber(item.slow_count) }));
        if (measurements.length) rows.push([jt('diagnostics.budgets.toolPressure', '{tool} pressure', { tool: item.id }), measurements.join(' / '), 'warn']);
      } else if (item.kind === 'slow_operations' && item.count != null && Number.isFinite(Number(item.count))) {
        rows.push([jt('diagnostics.budgets.slowOperations', 'Slow operations'), formatNumber(item.count), 'warn']);
      }
    });
    return rows;
  }

  function renderPerformanceSummary(status, runtimeHealthState, paintMarkup) {
    var anomalies = document.getElementById('performanceAnomaliesContainer');
    var slow = status.slow_operations || null;
    var items = Array.isArray(slow?.items) ? slow.items : [];
    var hasSamples = hasPerformanceSamples(status);
    var backend = runtimeHealthState.backend || status.backend || {};
    var backendPhase = phaseUtils.classifyBackendPhase(backend.phase);
    var backendUnavailable = backendPhase === 'unavailable' || backendPhase === 'model_unavailable';
    var unavailableFacets = [];
    if (status.phase_percentiles?.available === false) unavailableFacets.push(jt('diagnostics.performance.phaseLatencyFacet', 'phase latency'));
    if (status.tool_observability?.available === false) unavailableFacets.push(jt('diagnostics.performance.toolLatencyFacet', 'tool latency'));
    if (anomalies) {
      var anomalyMarkup;
      var slowRows = items.length ? '<ul>' + items.slice(0, 4).map(function (item) {
        return '<li><code>' + escapeHtml(item.id || item.kind || jt('diagnostics.performance.operation', 'Operation')) + '</code><span>'
          + escapeHtml(jt('diagnostics.performance.observedAndTarget', '{observed} observed \u00b7 {target} target', { observed: formatMetricMs(item.observed_ms), target: formatMetricMs(item.threshold_ms) })) + '</span></li>';
      }).join('') + '</ul>' : '';
      if (backendUnavailable) {
        var modelUnavailable = backendPhase === 'model_unavailable';
        var model = backend.model_acquisition?.requested_model || backend.model_lifecycle?.requested_model
          || status.runtime?.active_model || runtimeHealthState.status?.model || jt('diagnostics.phases.noActiveModel', 'no active model');
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>'
          + escapeHtml(modelUnavailable ? jt('diagnostics.phases.modelUnavailable', 'Model unavailable') : jt('diagnostics.performance.evidenceUnavailable', 'Performance evidence unavailable')) + '</strong><p>'
          + escapeHtml(modelUnavailable
            ? jt('diagnostics.phases.modelSamplingUnavailable', 'Model {model} is unavailable. Load an available model before collecting latency samples.', { model: model })
            : jt('diagnostics.performance.backendUnavailable', 'Latency sampling is unavailable until the backend recovers.'))
          + (hasSamples || items.length ? ' ' + escapeHtml(jt('diagnostics.performance.retainedEvidence', 'Displayed samples are retained evidence.')) : '') + '</p>' + slowRows + '</div>';
      } else if (backendPhase !== 'ready') {
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>'
          + escapeHtml(hasSamples || items.length ? jt('diagnostics.performance.retained', 'Retained performance evidence') : jt('diagnostics.performance.waitingBackend', 'Waiting for the backend')) + '</strong><p>'
          + escapeHtml(jt('diagnostics.phases.samplingWaitForReady', 'Latency sampling will resume when the backend is ready.')) + '</p>' + slowRows + '</div>';
      } else if (items.length) {
        anomalyMarkup = '<div class="diagnostics-performance-summary" data-tone="warn"><strong>' + escapeHtml(jtn('diagnostics.performance.operationsOverTarget', items.length, { count: items.length }, '{count} operation over target', '{count} operations over target')) + '</strong>'
          + slowRows + '</div>';
      } else if (!slow || slow.available === false) {
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>' + escapeHtml(jt('diagnostics.performance.evidenceUnavailable', 'Performance evidence unavailable')) + '</strong>'
          + '<p>' + escapeHtml(jt('diagnostics.performance.slowEvidenceUnavailable', 'Slow-operation evidence could not be loaded for this run.')) + '</p></div>';
      } else if (unavailableFacets.length) {
        var allUnavailable = unavailableFacets.length === 2;
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>'
          + escapeHtml(allUnavailable ? jt('diagnostics.performance.evidenceUnavailable', 'Performance evidence unavailable') : jt('diagnostics.performance.evidencePartial', 'Performance evidence partial')) + '</strong><p>'
          + escapeHtml(jt('diagnostics.performance.facetsUnavailable', '{facets} evidence could not be loaded for this run.', { facets: unavailableFacets.join(jt('diagnostics.performance.and', ' and ')) })) + '</p></div>';
      } else if (!hasSamples) {
        anomalyMarkup = '<div class="diagnostics-performance-summary"><strong>' + escapeHtml(jt('diagnostics.performance.noSamples', 'No performance samples yet')) + '</strong>'
          + '<p>' + escapeHtml(phaseUtils.isLocalEngine(status.runtime?.active_engine || runtimeHealthState.status?.active_engine || runtimeHealthState.status?.engine || backend.engine)
            ? jt('diagnostics.performance.collectEvidenceHint', 'Run a local chat or tool to collect latency evidence.')
            : jt('diagnostics.performance.collectChatEvidenceHint', 'Run a chat or tool to collect latency evidence.')) + '</p></div>';
      } else {
        anomalyMarkup = '<div class="diagnostics-performance-summary" data-tone="ok"><strong>' + escapeHtml(jt('diagnostics.performance.noAnomalies', 'No performance anomalies')) + '</strong>'
          + '<p>' + escapeHtml(jt('diagnostics.performance.noExceededTargets', 'No recorded phase or tool sample exceeded its latency target.')) + '</p></div>';
      }
      paintMarkup(anomalies, anomalyMarkup);
    }
    var budgetHost = document.getElementById('resourceBudgetsContainer');
    if (!budgetHost) return;
    var budgets = status.budgets || null;
    var budgetRows = budgetDisplayRows(budgets);
    var budgetMarkup = budgetRows.length
      ? '<dl class="diagnostics-budget-list">' + budgetRows.map(function (row) {
        return '<div data-tone="' + row[2] + '"><dt>' + escapeHtml(row[0]) + '</dt><dd>' + escapeHtml(row[1]) + '</dd></div>';
      }).join('') + '</dl>'
      : '<div class="diagnostics-compact-empty"><strong>' + escapeHtml(jt('diagnostics.budgets.heading', 'Resource budgets')) + '</strong><p>'
        + escapeHtml(budgets?.available === false ? jt('diagnostics.budgets.evidenceUnavailable', 'Budget evidence is unavailable.') : jt('diagnostics.budgets.noCounters', 'No resource budget counters are available for this run.'))
        + '</p></div>';
    paintMarkup(budgetHost, budgetMarkup);
  }

  return Object.freeze({
    renderPerformanceSummary: renderPerformanceSummary,
    formatNumber: formatNumber,
    formatMetricMs: formatMetricMs,
    budgetDisplayRows: budgetDisplayRows,
  });
});
