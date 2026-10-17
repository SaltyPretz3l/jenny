(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../inventory/state-icon'), require('../inventory/action-button'));
    return;
  }
  root.rendererObservabilityMarkupUtils = factory(root.stringUtils, root.inventoryStateIcon, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, stateIcon, actionButton) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const escapeHtml = stringUtils.escapeHtml;
  const normString = stringUtils.normalizeString;

  // This script loads before the shared formatters, so they are resolved when markup is built.
  function format() {
    return globalThis.rendererDiagnosticsFormat || (typeof require === 'function' ? require('./renderer-diagnostics-format') : null);
  }

  // classNames: one class or a list of class tokens.
  function headerCell(label, title, classNames) {
    var className = [].concat(classNames || []).join(' ');
    return '<th scope="col"' + (className ? ' class="' + className + '"' : '') + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(label) + '</th>';
  }

  /* ── The rows each group would show; a facet with none hides its group ── */

  // The tool the slowest calls belong to comes first.
  function toolRows(facet) {
    if (!facet || facet.available !== true) return [];
    const tools = facet.tools && typeof facet.tools === 'object' ? facet.tools : {};
    return Object.entries(tools)
      .map(([name, stats]) => ({ name, stats: stats || {} }))
      .filter((row) => Number.isFinite(Number(row.stats.count)) && Number(row.stats.count) > 0)
      .sort((a, b) => (Number(b.stats.latency_ms?.p95) || 0) - (Number(a.stats.latency_ms?.p95) || 0));
  }

  function slowRows(facet) {
    if (!facet || facet.available !== true || !Array.isArray(facet.items)) return [];
    return facet.items.slice().sort((a, b) => Number(b?.observed_ms || 0) - Number(a?.observed_ms || 0));
  }

  // Newest first: the facet keeps them oldest first.
  function traceRows(facet) {
    if (!facet || facet.available !== true || !Array.isArray(facet.recent)) return [];
    return facet.recent.filter((trace) => trace && typeof trace === 'object').reverse();
  }

  /* ── Tools ── */

  // The most RECENT error code: `recent_errors` is kept oldest first. Without it, a tool that has only ever
  // failed one way still names that code; otherwise there is no recency to report.
  function lastErrorCode(stats) {
    const recent = Array.isArray(stats.recent_errors) ? stats.recent_errors : [];
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const code = normString(recent[index] && recent[index].error_code);
      if (code) return code;
    }
    const codes = Object.keys(stats.error_codes && typeof stats.error_codes === 'object' ? stats.error_codes : {});
    return codes.length === 1 ? codes[0] : '';
  }

  function failedCount(stats) {
    const reported = Number(stats.error_count);
    if (Number.isFinite(reported) && reported >= 0) return reported;
    const derived = Math.round(Number(stats.error_rate) * Number(stats.count));
    return Number.isFinite(derived) && derived > 0 ? derived : 0;
  }

  function buildToolLatencyMarkup(facet) {
    const entries = toolRows(facet);
    if (!entries.length) return '';
    const fmt = format();
    const rows = entries.map((row) => {
      const stats = row.stats;
      const latency = stats.latency_ms || {};
      const failed = failedCount(stats);
      const code = lastErrorCode(stats);
      return '<tr>'
        + '<td><code class="diagnostics-mono">' + escapeHtml(row.name) + '</code></td>'
        + '<td class="diagnostics-num">' + escapeHtml(fmt.formatNumber(stats.count)) + '</td>'
        + '<td class="diagnostics-num' + (failed > 0 ? ' diagnostics-num--warn' : ' diagnostics-muted') + '">' + escapeHtml(failed > 0 ? fmt.formatNumber(failed) : fmt.EMPTY) + '</td>'
        + '<td class="diagnostics-num">' + escapeHtml(fmt.formatMs(latency.p50)) + '</td>'
        + '<td class="diagnostics-num">' + escapeHtml(fmt.formatMs(latency.p95)) + '</td>'
        + '<td class="diagnostics-col-wide">' + (code ? '<code class="diagnostics-mono">' + escapeHtml(code) + '</code>' : '<span class="diagnostics-muted">' + escapeHtml(fmt.EMPTY) + '</span>') + '</td>'
        + '</tr>';
    }).join('');
    return '<table class="diagnostics-table"><thead><tr>'
      + headerCell(jt('diagnostics.performance.tool', 'Tool'))
      + headerCell(jt('diagnostics.performance.calls', 'Calls'), '', 'diagnostics-num')
      + headerCell(jt('diagnostics.performance.failed', 'Failed'), '', 'diagnostics-num')
      + headerCell(jt('diagnostics.performance.typical', 'Typical'), 'P50', 'diagnostics-num')
      + headerCell(jt('diagnostics.performance.slow', 'Slow'), 'P95', 'diagnostics-num')
      + headerCell(jt('diagnostics.observability.lastError', 'Last error'), '', 'diagnostics-col-wide')
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ── Over target ── */

  function buildSlowOperationsMarkup(facet) {
    const items = slowRows(facet);
    if (!items.length) return '';
    const fmt = format();
    const rows = items.map((item) => {
      const kind = normString(item && item.kind);
      const id = normString(item && item.id) || kind || jt('diagnostics.performance.operation', 'Operation');
      const count = Math.max(Number(item && item.count) || 0, 0);
      return '<tr>'
        + '<td><code class="diagnostics-mono">' + escapeHtml(id) + '</code>' + (kind && kind !== id ? ' <small class="diagnostics-muted">' + escapeHtml(kind) + '</small>' : '') + '</td>'
        + '<td class="diagnostics-num diagnostics-num--warn">' + escapeHtml(fmt.formatMs(item && item.observed_ms)) + '</td>'
        + '<td class="diagnostics-num diagnostics-muted">' + escapeHtml(jt('diagnostics.performance.targetValue', 'target {value}', { value: fmt.formatMs(item && item.threshold_ms) })) + '</td>'
        + '<td class="diagnostics-num diagnostics-muted diagnostics-col-wide">'
        + escapeHtml(count > 0 ? jtn('diagnostics.performance.times', count, { count: fmt.formatNumber(count) }, '{count} time', '{count} times') : '') + '</td>'
        + '</tr>';
    }).join('');
    return '<table class="diagnostics-table"><thead class="sr-only"><tr>'
      + headerCell(jt('diagnostics.performance.operation', 'Operation'))
      + headerCell(jt('diagnostics.performance.observed', 'Observed'))
      + headerCell(jt('diagnostics.performance.target', 'Target'))
      + headerCell(jt('diagnostics.performance.count', 'Count'))
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* ── Recent chats ── */

  // Tone and icon follow the terminal status value, never the words shown for it.
  function describeResult(status) {
    switch (status) {
      case 'completed': return { word: jt('diagnostics.performance.resultCompleted', 'Completed'), icon: '' };
      case 'error':
      case 'runtime_error': return { word: jt('diagnostics.performance.resultFailed', 'Failed'), icon: 'error' };
      case 'timeout': return { word: jt('diagnostics.performance.resultTimedOut', 'Timed out'), icon: 'error' };
      case 'cancelled': return { word: jt('diagnostics.performance.resultCancelled', 'Cancelled'), icon: 'warn' };
      case 'preempted': return { word: jt('diagnostics.performance.resultPreempted', 'Preempted'), icon: 'warn' };
      case 'denied': return { word: jt('diagnostics.performance.resultDenied', 'Denied'), icon: 'warn' };
      case 'question_batch': return { word: jt('diagnostics.performance.resultQuestions', 'Waiting for answers'), icon: '' };
      default: return { word: status ? format().humanize(status) : format().EMPTY, icon: status ? 'warn' : '' };
    }
  }

  function resultCell(trace) {
    const result = describeResult(normString(trace.terminal_status));
    const streamId = normString(trace.stream_id);
    const tone = result.icon === 'error' ? 'error' : 'warn';
    const content = (result.icon ? stateIcon(result.icon, { tone, size: 'sm' }) : '') + escapeHtml(result.word);
    const verdict = trace.terminal_status === 'completed' ? 'completed' : (result.icon || 'neutral');
    if (!streamId) {
      return '<span class="diagnostics-verdict" data-verdict="' + verdict + '">' + content + '</span>';
    }
    // A plain button so a keyboard user reaches each chat; it opens the chat's records in Activity. The visible
    // result is its name; what it does is the tooltip.
    return actionButton({
      plain: true,
      className: 'diagnostics-row-link diagnostics-verdict',
      title: jt('diagnostics.performance.showRecords', "Show this chat's records"),
      trustedHtml: content,
      dataset: { 'observability-trace': streamId, verdict },
    });
  }

  function buildTraceTimingMarkup(facet) {
    const items = traceRows(facet);
    if (!items.length) return '';
    const fmt = format();
    const rows = items.map((trace) => {
      const provider = trace.provider_timing && typeof trace.provider_timing === 'object' ? trace.provider_timing : {};
      const tools = trace.tool_events && typeof trace.tool_events === 'object' ? trace.tool_events : {};
      const toolCount = Number(tools.total) || 0;
      return '<tr>'
        + '<td>' + resultCell(trace) + '</td>'
        + '<td>' + escapeHtml(normString(trace.model) || fmt.EMPTY) + '</td>'
        + '<td class="diagnostics-num">' + escapeHtml(fmt.formatMs(provider.time_to_first_visible_token_ms)) + '</td>'
        + '<td class="diagnostics-num">' + escapeHtml(fmt.formatMs(trace.duration_ms)) + '</td>'
        + '<td class="diagnostics-num diagnostics-col-wide">' + escapeHtml(toolCount > 0 ? fmt.formatNumber(toolCount) : fmt.EMPTY) + '</td>'
        + '</tr>';
    }).join('');
    return '<table class="diagnostics-table"><thead><tr>'
      + headerCell(jt('diagnostics.performance.result', 'Result'))
      + headerCell(jt('diagnostics.performance.model', 'Model'))
      + headerCell(jt('diagnostics.performance.firstToken', 'First token'), '', 'diagnostics-num')
      + headerCell(jt('diagnostics.performance.total', 'Total'), '', 'diagnostics-num')
      + headerCell(jt('diagnostics.performance.toolsColumn', 'Tools'), '', ['diagnostics-num', 'diagnostics-col-wide'])
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  return {
    buildToolLatencyMarkup,
    buildSlowOperationsMarkup,
    buildTraceTimingMarkup,
    slowRows,
    toolRows,
    traceRows,
  };
});
