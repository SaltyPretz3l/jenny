(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.rendererUsageMarkupUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CSV_COLUMNS = Object.freeze([
    'record_id', 'recorded_at', 'session_id', 'stream_id', 'request_id', 'trace_id',
    'model', 'provider', 'terminal_type', 'outcome', 'outcome_detail', 'duration_ms',
    'input_tokens', 'output_tokens', 'total_tokens', 'generation_tokens',
    'generation_duration_ms', 'ttft_ms', 'estimated', 'cost_source', 'cost_usd',
  ]);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function formatInteger(value) {
    return Math.round(finiteNumber(value)).toLocaleString('en-US');
  }

  function formatRate(value) {
    if (value === null || value === undefined || value === '') return '—';
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number.toFixed(1) : '—';
  }

  function formatTtft(value) {
    const number = finiteNumber(value);
    if (!number) return '—';
    const seconds = number / 1000;
    return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)}s`;
  }

  function formatDuration(value) {
    const number = finiteNumber(value);
    if (number < 1000) return `${Math.round(number)}ms`;
    if (number < 60000) return `${(number / 1000).toFixed(1)}s`;
    if (number < 3600000) return `${Math.floor(number / 60000)}m ${String(Math.floor((number % 60000) / 1000)).padStart(2, '0')}s`;
    return `${Math.floor(number / 3600000)}h ${Math.floor((number % 3600000) / 60000)}m`;
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Unknown time';
    const elapsed = Date.now() - date.getTime();
    if (elapsed >= 0 && elapsed < 60000) return 'just now';
    if (elapsed >= 0 && elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
    if (elapsed >= 0 && elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function formatCost(value) {
    const number = finiteNumber(value);
    if (!number) return '$0.00';
    if (number < 0.01) return `$${number.toFixed(4)}`;
    return `$${number.toFixed(2)}`;
  }

  function plural(count, singular, pluralForm) {
    return `${formatInteger(count)} ${Number(count) === 1 ? singular : (pluralForm || `${singular}s`)}`;
  }

  function actionButton(inventory, options) {
    const render = inventory && inventory.actionButton;
    return typeof render === 'function' ? render(options) : '';
  }

  function buildScopeMarkup(inventory, value) {
    const render = inventory && inventory.segmentedControl;
    if (typeof render !== 'function') return '';
    return render({
      id: 'usage-scope',
      ariaLabel: 'Usage scope',
      value: value || 'today',
      options: [
        { value: 'session', label: 'This chat' },
        { value: 'today', label: 'Today' },
        { value: 'all', label: 'All retained' },
      ],
    });
  }

  function outcomeCounts(totals) {
    const source = totals && totals.outcomes || {};
    return {
      failed: finiteNumber(source.error),
      stopped: ['cancelled', 'interrupted', 'preempted', 'denied', 'timeout']
        .reduce((sum, key) => sum + finiteNumber(source[key]), 0),
    };
  }

  function buildStatsMarkup(totals, outcomeOnly) {
    const data = totals || {};
    const speed = data.speed || {};
    const rate = speed.tokens_per_second || {};
    const firstToken = speed.ttft_ms || {};
    const outcomes = outcomeCounts(data);
    const outcomeParts = [];
    if (outcomes.stopped) outcomeParts.push(`${formatInteger(outcomes.stopped)} stopped`);
    if (outcomes.failed) outcomeParts.push(`${formatInteger(outcomes.failed)} failed`);
    const outcomeFilter = outcomeParts.length
      ? `<span class="usage-stat-note usage-stat-note--action" role="button" tabindex="0" data-usage-outcome-filter aria-pressed="${outcomeOnly ? 'true' : 'false'}">${outcomeParts.join(' · ')}</span>`
      : '<span class="usage-stat-note">all completed</span>';
    const measured = finiteNumber(speed.measured_turns);
    const ttftMeasured = finiteNumber(firstToken.measured_turns);
    const missingMeasured = Math.max(finiteNumber(data.turn_count) - measured, 0);
    const rateDetail = measured
      ? `p10–p90 ${formatRate(rate.p10)}–${formatRate(rate.p90)} tok/s${missingMeasured ? ` · ${formatInteger(missingMeasured)} not measured` : ''}`
      : 'not reported by this provider';
    return [
      ['Tokens', formatInteger(data.total_tokens), '', `${formatInteger(data.input_tokens)} in · ${formatInteger(data.output_tokens)} out`],
      ['Speed', measured ? formatRate(rate.median) : '—', measured ? 'tok/s' : '', rateDetail],
      ['Turns', formatInteger(data.turn_count), '', outcomeFilter],
      ['First token', ttftMeasured ? formatTtft(firstToken.median) : '—', '', ttftMeasured
        ? `median wait${ttftMeasured < finiteNumber(data.turn_count) ? ` · ${formatInteger(finiteNumber(data.turn_count) - ttftMeasured)} not measured` : ''}`
        : 'not reported by this provider'],
    ].map(([label, value, unit, detail]) => (
      `<div class="usage-stat"><span class="usage-stat-label">${escapeHtml(label)}</span>`
      + `<div class="usage-stat-value${value === '—' ? ' usage-none' : ''}">${escapeHtml(value)}`
      + (unit ? ` <span class="usage-stat-unit">${escapeHtml(unit)}</span>` : '')
      + '</div>'
      + (typeof detail === 'string' && detail.startsWith('<span') ? detail : `<div class="usage-stat-note">${escapeHtml(detail)}</div>`)
      + '</div>'
    )).join('');
  }

  function sortedModels(totals) {
    return Object.entries(totals && totals.models || {}).map(([model, bucket]) => ({ model, ...bucket }))
      .sort((a, b) => finiteNumber(b.turn_count) - finiteNumber(a.turn_count)
        || String(a.model || '').localeCompare(String(b.model || '')))
      .slice(0, 8);
  }

  function buildModelTableMarkup(totals, selectedModel) {
    const rows = sortedModels(totals);
    if (!rows.length) return '<p class="usage-empty-inline">No model usage in this scope.</p>';
    const body = rows.map((row) => {
      const model = String(row.model || 'Unknown model');
      const pressed = model === selectedModel;
      return `<tr role="button" tabindex="0" data-usage-model="${escapeHtml(model)}" aria-pressed="${pressed ? 'true' : 'false'}">`
        + `<th scope="row" title="${escapeHtml(model)}">${escapeHtml(model)}</th>`
        + `<td class="usage-cell-num">${formatInteger(row.turn_count)}</td><td class="usage-cell-num">${formatInteger(row.total_tokens)}</td>`
        + `<td class="usage-cell-num">${escapeHtml(row.speed?.measured_turns ? formatRate(row.speed?.tokens_per_second?.median) : '—')}</td>`
        + `<td class="usage-cell-num">${escapeHtml(formatTtft(row.speed?.ttft_ms?.median))}</td>`
        + `<td class="usage-cell-num usage-col-time">${escapeHtml(formatDuration(row.duration_ms))}</td></tr>`;
    }).join('');
    const totalModels = Object.keys(totals && totals.models || {}).length;
    const overflow = totalModels > rows.length
      ? `<div class="usage-model-overflow">and ${formatInteger(totalModels - rows.length)} more models — export for the full list</div>`
      : '';
    return '<table class="usage-table usage-model-table">'
      + '<caption class="sr-only">Usage by model. Select a row to filter recent turns.</caption>'
      + '<thead><tr><th scope="col">Model</th><th scope="col" class="usage-cell-num">Turns</th><th scope="col" class="usage-cell-num">Tokens</th><th scope="col" class="usage-cell-num">Tok/s</th><th scope="col" class="usage-cell-num">First token</th><th scope="col" class="usage-cell-num usage-col-time">Time</th></tr></thead>'
      + `<tbody>${body}</tbody></table>${overflow}`;
  }

  function outcomeLabel(row) {
    const outcome = String(row && row.outcome || 'complete');
    if (outcome === 'complete') return '';
    if (outcome === 'error') return 'failed';
    return outcome.charAt(0).toUpperCase() + outcome.slice(1);
  }

  function buildRowActions(inventory, row) {
    const actions = [];
    if (row.session_id) {
      actions.push(actionButton(inventory, {
        label: 'chat', variant: 'ghost', size: 'sm', className: 'usage-link',
        dataset: { 'usage-action': 'chat', 'session-id': String(row.session_id) },
        ariaLabel: 'Open turn in chat',
        title: 'Open this turn in chat',
      }));
    }
    if (row.stream_id) {
      actions.push(actionButton(inventory, {
        label: 'trace', variant: 'ghost', size: 'sm', className: 'usage-link',
        dataset: {
          'usage-action': 'trace',
          'stream-id': String(row.stream_id),
          'trace-id': String(row.trace_id || ''),
          'session-id': String(row.session_id || ''),
        },
        ariaLabel: 'Open diagnostics trace',
        title: 'Open the diagnostics trace for this turn',
      }));
    }
    return actions.filter(Boolean).join('');
  }

  function buildRecentRowsMarkup(inventory, rows, filteredEmpty) {
    if (!rows.length) {
      const message = filteredEmpty ? 'No retained turns match these filters.' : 'No retained turns in this scope.';
      return `<tr><td colspan="7" class="usage-table-empty">${escapeHtml(filteredEmpty ? 'No turns match this filter.' : message)}</td></tr>`;
    }
    return rows.map((row) => {
      const detail = String(row.outcome_detail || '');
      const estimated = row.estimated === true ? ' <span class="usage-est">est.</span>' : '';
      const generationDuration = finiteNumber(row.generation_duration_ms);
      const speed = generationDuration > 0 ? finiteNumber(row.generation_tokens) * 1000 / generationDuration : null;
      const outcome = outcomeLabel(row);
      return '<tr>'
        + `<td>${escapeHtml(formatTimestamp(row.recorded_at))}</td>`
        + `<td><span class="usage-model-cell"><span class="usage-model" title="${escapeHtml(row.model || 'Unknown')}">${escapeHtml(row.model || 'Unknown')}</span>${outcome ? `<span class="usage-outcome" data-outcome="${escapeHtml(row.outcome)}"${detail ? ` title="${escapeHtml(detail)}"` : ''}>${escapeHtml(outcome)}</span>` : ''}</span></td>`
        + `<td class="usage-cell-num${row.estimated ? ' usage-cell-muted' : ''}">${formatInteger(row.input_tokens)} / ${formatInteger(row.output_tokens)}${estimated}</td>`
        + `<td class="usage-cell-num">${escapeHtml(formatRate(speed))}</td>`
        + `<td class="usage-cell-num usage-col-ttft">${escapeHtml(generationDuration > 0 ? formatTtft(row.ttft_ms) : '—')}</td>`
        + `<td class="usage-cell-num">${escapeHtml(formatDuration(row.duration_ms))}</td>`
        + `<td class="usage-row-actions">${buildRowActions(inventory, row)}</td></tr>`;
    }).join('');
  }

  function buildRecentTableMarkup(inventory, rows, filteredEmpty) {
    return '<table class="usage-table usage-recent-table">'
      + '<caption class="sr-only">Recent turns, newest first.</caption>'
      + '<thead><tr><th scope="col">When</th><th scope="col">Model</th><th scope="col" class="usage-cell-num">In / out</th><th scope="col" class="usage-cell-num">Tok/s</th><th scope="col" class="usage-cell-num usage-col-ttft">First token</th><th scope="col" class="usage-cell-num">Total</th><th scope="col">Open</th></tr></thead>'
      + `<tbody data-usage-recent-body>${buildRecentRowsMarkup(inventory, rows, filteredEmpty)}</tbody></table>`;
  }

  function buildFootnotesMarkup(totals) {
    const data = totals || {};
    const total = finiteNumber(data.turn_count);
    if (!total) return '';
    const coverage = data.cost_coverage || {};
    const notes = [];
    const estimated = finiteNumber(data.estimated_turns);
    if (estimated) notes.push(`${formatInteger(estimated)} of ${formatInteger(total)} turns use estimated token counts.`);
    const hasKnownCost = finiteNumber(coverage.provider_reported_turns) > 0
      || finiteNumber(coverage.local_zero_turns) > 0;
    const spend = hasKnownCost ? formatCost(data.provider_cost_usd) : 'Unavailable';
    notes.push(`Provider-reported spend: ${spend} across ${formatInteger(coverage.provider_reported_turns)} turns — ${formatInteger(coverage.local_zero_turns)} local, ${formatInteger(coverage.unavailable_turns)} not reported.`);
    return notes.map((note) => `<div class="usage-footnote">${escapeHtml(note)}</div>`).join('');
  }

  function buildRecentMetaMarkup(inventory, meta) {
    const shown = finiteNumber(meta.shown);
    const matched = finiteNumber(meta.matched);
    const retained = finiteNumber(meta.retained);
    const filters = [];
    if (meta.selectedModel) filters.push(meta.selectedModel);
    if (meta.outcomeOnly) filters.push('failed or stopped');
    const total = filters.length ? matched : retained;
    const copy = (shown < total
      ? `${formatInteger(shown)} of ${formatInteger(total)} turns`
      : `${plural(total, 'turn')} · all shown`)
      + (filters.length ? ` · ${filters.join(' · ')}` : '');
    const clear = filters.length ? actionButton(inventory, {
      label: 'Clear', variant: 'ghost', size: 'sm', dataset: { 'usage-action': 'clear-filters' },
    }) : '';
    return `<span>${escapeHtml(copy)}</span>${clear}`;
  }

  function buildMoreMarkup(inventory, visible, matched) {
    if (visible >= matched) return '';
    return actionButton(inventory, {
      label: 'Show 50 more',
      variant: 'ghost', size: 'sm', dataset: { 'usage-action': 'more' },
    });
  }

  function buildActionsMarkup(inventory, busyAction) {
    return actionButton(inventory, {
      label: busyAction === 'export' ? 'Exporting…' : 'Export CSV',
      variant: 'secondary', size: 'sm', disabled: Boolean(busyAction),
      dataset: { 'usage-action': 'export' },
    }) + actionButton(inventory, {
      label: busyAction === 'clear' ? 'Clearing…' : 'Clear history',
      variant: 'danger', size: 'sm', disabled: Boolean(busyAction),
      dataset: { 'usage-action': 'clear' },
    });
  }

  function csvCell(value) {
    const text = value === true ? 'true' : value === false ? 'false' : String(value == null ? '' : value);
    const safeText = /^\s*[=+\-@]/u.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safeText) ? `"${safeText.replace(/"/g, '""')}"` : safeText;
  }

  function buildCsv(rows) {
    const lines = [CSV_COLUMNS.join(',')];
    for (const row of Array.isArray(rows) ? rows : []) {
      lines.push(CSV_COLUMNS.map((column) => csvCell(row && row[column])).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  return {
    CSV_COLUMNS,
    escapeHtml,
    formatInteger,
    formatRate,
    formatTtft,
    formatDuration,
    formatTimestamp,
    formatCost,
    buildScopeMarkup,
    buildStatsMarkup,
    buildModelTableMarkup,
    buildRecentRowsMarkup,
    buildRecentTableMarkup,
    buildFootnotesMarkup,
    buildRecentMetaMarkup,
    buildMoreMarkup,
    buildActionsMarkup,
    buildCsv,
  };
});
