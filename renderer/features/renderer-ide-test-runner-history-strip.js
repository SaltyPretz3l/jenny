/* Per-config run-history visualization for the Workspace IDE test runner.
 * Jenny-initiated runs (initiator: 'jenny' -- the `verify` tool or the
 * verification gate) carry a 2px accent tick above their bar and a legend entry
 * in the summary line; a `skipped` run (requested while the user's own run held
 * the lock) has no duration, so only its tick shows. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTestRunnerHistoryStrip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MAX_RUNS = 30;
  const BAR_CAP_MS = 5 * 60 * 1000;
  const STATUSES = new Set(['passed', 'failed', 'error', 'aborted', 'timeout', 'interrupted', 'running', 'skipped']);
  const INITIATOR_JENNY = 'jenny';
  const TICK_HEIGHT = 2;

  function isJennyRun(run) {
    return Boolean(run) && String(run.initiator || '') === INITIATOR_JENNY;
  }
  const HANG_STATUSES = new Set(['timeout', 'interrupted']);

  function durationValue(value) {
    if (value == null || value === '') return null;
    const duration = Number(value);
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  }

  function formatDuration(value) {
    const duration = durationValue(value);
    if (duration == null) return '—';
    if (duration < 1000) return `${Math.round(duration)}ms`;
    if (duration < 60000) {
      return `${(duration / 1000).toFixed(1).replace(/\.0$/, '')}s`;
    }
    const totalSeconds = Math.round(duration / 1000);
    return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  }

  function formatStartedAt(value, locale) {
    if (value == null || value === '') return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(locale) : '—';
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function appendTextElement(doc, parent, tag, className, value) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    el.textContent = value;
    parent.appendChild(el);
    return el;
  }

  function statusOf(run) {
    const status = String(run && run.status || 'error').toLowerCase();
    return STATUSES.has(status) ? status : 'error';
  }

  function buildChart(doc, runs, locale) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ide-test-runner-history-strip__chart');
    svg.setAttribute('viewBox', '0 0 300 42');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    const jennyCount = runs.filter(isJennyRun).length;
    svg.setAttribute('aria-label', `Durations for the last ${runs.length} test runs, oldest to newest`
      + (jennyCount ? `; ticks mark ${jennyCount} started by Jenny` : ''));
    const slotWidth = 300 / runs.length;
    runs.forEach((run, index) => {
      const status = statusOf(run);
      const duration = durationValue(run && run.durationMs);
      const height = duration == null || duration === 0
        ? 0
        : 34 * Math.min(1, Math.log1p(duration) / Math.log1p(BAR_CAP_MS));
      const barWidth = Math.min(8, Math.max(2, slotWidth - 2));
      const bar = doc.createElementNS(SVG_NS, 'rect');
      bar.setAttribute('class', `ide-test-runner-history-strip__bar ide-test-runner-history-strip__bar--${status}${HANG_STATUSES.has(status) ? ' ide-test-runner-history-strip__bar--hang' : ''}`);
      bar.setAttribute('data-status', status);
      bar.setAttribute('x', String((index * slotWidth) + ((slotWidth - barWidth) / 2)));
      bar.setAttribute('y', String(38 - height));
      bar.setAttribute('width', String(barWidth));
      bar.setAttribute('height', String(height));
      const title = doc.createElementNS(SVG_NS, 'title');
      const durationText = formatDuration(run && run.durationMs);
      const who = isJennyRun(run) ? ' · by Jenny' : '';
      title.textContent = HANG_STATUSES.has(status)
        ? `hang: ${status} after ${durationText}${who}`
        : `${formatStartedAt(run && run.startedAt, locale)} · ${status} · ${durationText}${who}`;
      bar.appendChild(title);
      svg.appendChild(bar);
      if (isJennyRun(run)) {
        const tick = doc.createElementNS(SVG_NS, 'rect');
        tick.setAttribute('class', 'ide-test-runner-history-strip__tick');
        tick.setAttribute('data-initiator', INITIATOR_JENNY);
        tick.setAttribute('x', bar.getAttribute('x'));
        tick.setAttribute('y', '0');
        tick.setAttribute('width', String(barWidth));
        tick.setAttribute('height', String(TICK_HEIGHT));
        svg.appendChild(tick);
      }
    });
    return svg;
  }

  function buildSummary(doc, runs) {
    const durations = runs.map((run) => durationValue(run && run.durationMs)).filter((value) => value != null);
    const summary = doc.createElement('div');
    summary.className = 'ide-test-runner-history-strip__summary';
    if (durations.length) {
      appendTextElement(doc, summary, 'span', '', `min ${formatDuration(Math.min(...durations))} / median ${formatDuration(median(durations))} / max ${formatDuration(Math.max(...durations))}`);
    } else {
      appendTextElement(doc, summary, 'span', '', 'min — / median — / max —');
    }
    if (runs.some(isJennyRun)) {
      const legend = appendTextElement(doc, summary, 'span', 'ide-test-runner-history-strip__legend', '▔ by Jenny');
      legend.dataset.initiator = INITIATOR_JENNY;
    }
    if (durations.length >= 4) {
      const windowSize = Math.min(10, Math.floor(durations.length / 2));
      const recentMedian = median(durations.slice(-windowSize));
      const priorMedian = median(durations.slice(-windowSize * 2, -windowSize));
      const ratio = priorMedian === 0 ? (recentMedian === 0 ? 1 : Infinity) : recentMedian / priorMedian;
      const trend = ratio > 1.1 ? 'slower' : (ratio < 0.9 ? 'faster' : 'flat');
      const arrow = trend === 'slower' ? '↑' : (trend === 'faster' ? '↓' : '→');
      const trendEl = appendTextElement(doc, summary, 'span', `ide-test-runner-history-strip__trend ide-test-runner-history-strip__trend--${trend}`, `${arrow} ${trend}`);
      trendEl.dataset.trend = trend;
    }
    return summary;
  }

  function buildHistoryTable(doc, runs, locale) {
    const details = doc.createElement('details');
    details.className = 'ide-test-runner-history-strip__details';
    appendTextElement(doc, details, 'summary', '', 'history');
    const table = doc.createElement('table');
    table.className = 'ide-test-runner-history-strip__table';
    const hasCounts = runs.some((run) => run && (run.passedCount != null || run.failedCount != null));
    const hasAttribution = runs.some(isJennyRun);
    const thead = doc.createElement('thead');
    const header = doc.createElement('tr');
    ['Started', 'Duration', 'Status']
      .concat(hasCounts ? ['Passed', 'Failed'] : [])
      .concat(hasAttribution ? ['By'] : [])
      .forEach((label) => {
      appendTextElement(doc, header, 'th', '', label);
    });
    thead.appendChild(header);
    table.appendChild(thead);
    const tbody = doc.createElement('tbody');
    runs.slice().reverse().forEach((run) => {
      const row = doc.createElement('tr');
      const cells = [formatStartedAt(run && run.startedAt, locale), formatDuration(run && run.durationMs), statusOf(run)];
      if (hasCounts) cells.push(run && run.passedCount != null ? String(run.passedCount) : '—', run && run.failedCount != null ? String(run.failedCount) : '—');
      if (hasAttribution) cells.push(isJennyRun(run) ? 'Jenny' : 'you');
      cells.forEach((value) => appendTextElement(doc, row, 'td', '', value));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    details.appendChild(table);
    return details;
  }

  function renderTestRunnerHistoryStrip(doc, runs, opts = {}) {
    if (!doc || !Array.isArray(runs) || runs.length === 0) return null;
    const shown = runs.slice(-MAX_RUNS);
    const root = doc.createElement('section');
    root.className = 'ide-test-runner-history-strip';
    root.appendChild(buildChart(doc, shown, opts.locale));
    root.appendChild(buildSummary(doc, shown));
    root.appendChild(buildHistoryTable(doc, shown, opts.locale));
    return root;
  }

  return { renderTestRunnerHistoryStrip, formatDuration };
});
