(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'), require('../shared/log-view-utils'));
    return;
  }
  root.rendererObservabilityMarkupUtils = factory(root.stringUtils, root.logViewUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, logViewUtils) {
  'use strict';

  const escapeHtml = stringUtils.escapeHtml;
  const normString = stringUtils.normalizeString;
  const formatRelativeTimestamp = logViewUtils.formatRelativeTime;

  function formatMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '--';
    if (numeric >= 1000) return (numeric / 1000).toFixed(2) + 's';
    return Math.round(numeric) + 'ms';
  }

  function formatPercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '--';
    return (numeric * 100).toFixed(1) + '%';
  }

  function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return n.toLocaleString('en-US');
  }

  function formatCost(value) {
    if (value === null || value === undefined || value === '') return 'Unavailable';
    const n = Number(value);
    if (!Number.isFinite(n)) return 'Unavailable';
    if (n === 0) return '$0.00';
    if (n < 0.01) return '$' + n.toFixed(4);
    return '$' + n.toFixed(2);
  }

  function plural(value, singular, pluralForm) {
    return Number(value) === 1 ? singular : (pluralForm || singular + 's');
  }

  function buildEmptyState(copy) {
    return ''
      + '<div class="observability-empty-state">'
      + '<p class="observability-empty-copy">' + escapeHtml(copy) + '</p>'
      + '</div>';
  }

  /* ── Tool latency table ── */

  function buildToolLatencyMarkup(facet) {
    if (!facet || facet.available !== true) {
      return buildEmptyState('Tool observability is unavailable.');
    }
    const tools = facet.tools && typeof facet.tools === 'object' ? facet.tools : {};
    const entries = Object.entries(tools)
      .map(([name, stats]) => ({ name, stats: stats || {} }))
      .filter((row) => Number.isFinite(Number(row.stats.count)) && Number(row.stats.count) > 0);
    if (entries.length === 0) {
      return buildEmptyState('No tool calls recorded yet.');
    }
    entries.sort((a, b) => {
      const ap = Number(a.stats.latency_ms?.p95) || 0;
      const bp = Number(b.stats.latency_ms?.p95) || 0;
      return bp - ap;
    });
    const rows = entries.map((row) => {
      const stats = row.stats;
      const latency = stats.latency_ms || {};
      const lastError = (() => {
        const codes = stats.error_codes && typeof stats.error_codes === 'object' ? stats.error_codes : {};
        const list = Object.entries(codes).sort((a, b) => b[1] - a[1]);
        return list.length > 0 ? list[0][0] : '';
      })();
      const errorRateClass = (Number(stats.error_rate) > 0.05)
        ? 'observability-cell-warn'
        : (Number(stats.error_rate) > 0 ? 'observability-cell-warn-soft' : '');
      return ''
        + '<tr>'
        + '<td class="observability-cell-tool"><code>' + escapeHtml(row.name) + '</code></td>'
        + '<td class="observability-cell-num">' + formatNumber(stats.count) + '</td>'
        + '<td class="observability-cell-num ' + errorRateClass + '">' + formatPercent(stats.error_rate) + '</td>'
        + '<td class="observability-cell-num">' + escapeHtml(formatMs(latency.p50)) + '</td>'
        + '<td class="observability-cell-num">' + escapeHtml(formatMs(latency.p95)) + '</td>'
        + '<td class="observability-cell-num">' + escapeHtml(formatMs(latency.p99)) + '</td>'
        + '<td class="observability-cell-code">' + (lastError ? '<code>' + escapeHtml(lastError) + '</code>' : '<span class="observability-cell-muted">--</span>') + '</td>'
        + '</tr>';
    }).join('');
    return ''
      + '<table class="observability-table">'
      + '<thead><tr>'
      + '<th scope="col" class="observability-cell-tool">Tool</th>'
      + '<th scope="col" class="observability-cell-num">Calls</th>'
      + '<th scope="col" class="observability-cell-num">Err %</th>'
      + '<th scope="col" class="observability-cell-num">p50</th>'
      + '<th scope="col" class="observability-cell-num">p95</th>'
      + '<th scope="col" class="observability-cell-num">p99</th>'
      + '<th scope="col" class="observability-cell-code">Last error</th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody>'
      + '</table>';
  }

  /* ── Slow operations ── */

  function buildSlowOperationsMarkup(facet) {
    if (!facet || facet.available !== true) {
      return buildEmptyState('Slow operations facet unavailable.');
    }
    const items = Array.isArray(facet.items) ? facet.items : [];
    if (items.length === 0) {
      return buildEmptyState('No slow operations recorded.');
    }
    const rows = items.slice().sort((a, b) => Number(b?.observed_ms || 0) - Number(a?.observed_ms || 0)).map((item) => {
      const kind = normString(item && item.kind) || 'operation';
      const id = normString(item && item.id) || 'unknown';
      const metric = normString(item && item.metric);
      const observed = formatMs(item && item.observed_ms);
      const threshold = formatMs(item && item.threshold_ms);
      const count = Math.max(Number(item && item.count) || 0, 0);
      const errorCount = Math.max(Number(item && item.error_count) || 0, 0);
      const meta = [
        threshold !== '--' ? 'threshold ' + threshold : '',
        count > 0 ? formatNumber(count) + ' ' + plural(count, 'sample') : '',
        errorCount > 0 ? formatNumber(errorCount) + ' ' + plural(errorCount, 'error') : '',
        metric,
      ].filter(Boolean).map((part) => '<span class="observability-list-meta">' + escapeHtml(part) + '</span>').join('');
      return ''
        + '<li class="observability-list-row">'
        + '<span class="observability-list-time">' + escapeHtml(kind) + '</span>'
        + '<code class="observability-list-tool">' + escapeHtml(id) + '</code>'
        + '<span class="observability-list-duration">' + escapeHtml(observed) + '</span>'
        + (meta ? '<span class="observability-list-link-cell">' + meta + '</span>' : '')
        + '</li>';
    }).join('');
    return '<ul class="observability-list">' + rows + '</ul>';
  }

  /* ── Recent traces ── */

  function buildTraceTimingMarkup(facet, expandedStreams) {
    if (!facet || facet.available !== true) {
      return buildEmptyState('Trace timing facet unavailable.');
    }
    const items = Array.isArray(facet.recent) ? facet.recent : [];
    if (items.length === 0) {
      return buildEmptyState('No turns recorded yet.');
    }
    const expandedSet = expandedStreams instanceof Set ? expandedStreams : new Set();
    const rows = items.slice().reverse().map((trace, index) => {
      const stream = normString(trace && trace.stream_id);
      const terminal = normString(trace && trace.terminal_status) || 'unknown';
      const tone = ({
        completed: 'success', error: 'danger', timeout: 'warning',
        cancelled: 'warning', preempted: 'warning', denied: 'warning',
        runtime_error: 'danger', question_batch: 'pending',
      })[terminal] || 'muted';
      const duration = formatMs(trace && trace.duration_ms);
      const provider = trace && trace.provider_timing ? trace.provider_timing : {};
      const ttfc = formatMs(provider.time_to_first_chunk_ms);
      const ttfvt = formatMs(provider.time_to_first_visible_token_ms);
      const tools = trace && trace.tool_events ? trace.tool_events : {};
      const toolCount = Number(tools.total) || 0;
      const isExpanded = expandedSet.has(stream);
      const expandedDetail = isExpanded ? buildTraceDetailMarkup(trace) : '';
      const detailId = 'diagnostics-trace-detail-' + index + '-' + stream.replace(/[^a-zA-Z0-9_-]/g, '-');
      return ''
        + '<li class="observability-trace-row" data-trace-stream="' + escapeHtml(stream) + '">'
        + '<button type="button" class="observability-trace-row-header"'
        + ' aria-expanded="' + (isExpanded ? 'true' : 'false') + '"'
        + ' aria-controls="' + escapeHtml(detailId) + '"'
        + ' aria-label="' + escapeHtml('Trace ' + (stream || 'without an identifier') + ', ' + terminal + ', ' + duration) + '"'
        + ' data-observability-trace-toggle="' + escapeHtml(stream) + '">'
        + '<span class="observability-trace-status observability-trace-status-' + escapeHtml(tone) + '">' + escapeHtml(terminal) + '</span>'
        + '<span class="observability-trace-duration">' + escapeHtml(duration) + '</span>'
        + '<span class="observability-trace-model">' + escapeHtml(normString(trace.model) || 'no-model') + '</span>'
        + '<span class="observability-trace-mode">' + escapeHtml(normString(trace.mode) || 'chat') + '</span>'
        + '<span class="observability-trace-meta">TTFC ' + escapeHtml(ttfc) + ' · vis ' + escapeHtml(ttfvt) + '</span>'
        + '<span class="observability-trace-meta">' + toolCount + ' tool' + (toolCount === 1 ? '' : 's') + '</span>'
        + '<span class="observability-trace-caret" aria-hidden="true"></span>'
        + '</button>'
        + '<div class="observability-trace-detail" id="' + escapeHtml(detailId) + '"' + (isExpanded ? '' : ' hidden') + '>' + expandedDetail + '</div>'
        + '</li>';
    }).join('');
    return '<ul class="observability-trace-list">' + rows + '</ul>';
  }

  function buildTraceDetailMarkup(trace) {
    if (!trace || typeof trace !== 'object') return '';
    const provider = trace.provider_timing || {};
    const tools = trace.tool_events || {};
    const ids = [
      ['stream', normString(trace.stream_id)],
      ['session', normString(trace.session_id)],
      ['trace', normString(trace.trace_id)],
      ['request', normString(trace.request_id)],
    ].filter((pair) => pair[1]);
    const idsMarkup = ids.map((pair) => '<span class="observability-trace-id"><span class="observability-trace-id-label">' + escapeHtml(pair[0]) + '</span><code>' + escapeHtml(pair[1]) + '</code></span>').join('');
    const providerRows = [
      ['Request start', formatMs(provider.time_to_provider_request_start_ms)],
      ['First chunk', formatMs(provider.time_to_first_chunk_ms)],
      ['First visible token', formatMs(provider.time_to_first_visible_token_ms)],
      ['Total request', formatMs(provider.request_duration_ms)],
      ['Tokens / sec', Number.isFinite(Number(provider.visible_tokens_per_second_estimate))
        ? Number(provider.visible_tokens_per_second_estimate).toFixed(1)
        : '--'],
    ].map(([label, value]) => '<div class="observability-trace-detail-row"><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(value) + '</span></div>').join('');
    const phaseEntries = tools.by_phase && typeof tools.by_phase === 'object' ? Object.entries(tools.by_phase) : [];
    const phaseMarkup = phaseEntries.length
      ? phaseEntries.map(([phase, count]) => '<span class="observability-trace-phase"><code>' + escapeHtml(phase) + '</code><span>' + escapeHtml(String(count)) + '</span></span>').join('')
      : '<span class="observability-cell-muted">no tool events</span>';
    return ''
      + '<div class="observability-trace-detail-ids">' + idsMarkup + '</div>'
      + '<div class="observability-trace-detail-grid">' + providerRows + '</div>'
      + '<div class="observability-trace-detail-phases">' + phaseMarkup + '</div>';
  }

  return {
    buildToolLatencyMarkup,
    buildSlowOperationsMarkup,
    buildTraceTimingMarkup,
    formatMs,
    formatPercent,
    formatRelativeTimestamp,
    formatNumber,
    formatCost,
    escapeHtml,
  };
});
