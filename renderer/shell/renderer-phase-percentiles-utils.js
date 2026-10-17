/* renderer/shell/renderer-phase-percentiles-utils.js - Diagnostics chat-timing table (phase percentiles). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPhasePercentilesUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const stateIcon = globalThis.inventoryStateIcon || (typeof require === 'function' ? require('../inventory/state-icon') : null);
  const PHASE_ORDER = [
    'click_to_optimistic_render',
    'optimistic_render_to_context_assembly_started',
    'context_assembly_elapsed_no_memory_git',
    'context_assembly_elapsed_memory_git',
    'context_assembly_completed_to_sidecar_request_sent',
    'sidecar_request_sent_to_provider_request_start',
    'provider_request_start_to_first_chunk',
    'first_chunk_to_first_visible_token',
    'completion_to_terminal_persist',
  ];

  // This script loads before the shared formatters, so they are resolved when a table is built.
  function format() {
    return globalThis.rendererDiagnosticsFormat || (typeof require === 'function' ? require('./renderer-diagnostics-format') : null);
  }

  // Built per call so a locale switch reaches the labels.
  function phaseLabel(phaseName) {
    const labels = {
      click_to_optimistic_render: jt('diagnostics.phases.clickToOptimisticRender', 'Click to optimistic render'),
      optimistic_render_to_context_assembly_started: jt('diagnostics.phases.optimisticRenderToAssemblyStart', 'Optimistic render to assembly start'),
      context_assembly_elapsed_no_memory_git: jt('diagnostics.phases.contextAssemblyNoMemoryGit', 'Context assembly, no memory/Git'),
      context_assembly_elapsed_memory_git: jt('diagnostics.phases.contextAssemblyMemoryGit', 'Context assembly, memory/Git'),
      context_assembly_completed_to_sidecar_request_sent: jt('diagnostics.phases.assemblyCompleteToSidecarSent', 'Assembly complete to sidecar sent'),
      sidecar_request_sent_to_provider_request_start: jt('diagnostics.phases.sidecarSentToProviderStart', 'Sidecar sent to provider start'),
      provider_request_start_to_first_chunk: jt('diagnostics.phases.providerStartToFirstChunk', 'Provider start to first chunk'),
      first_chunk_to_first_visible_token: jt('diagnostics.phases.firstChunkToFirstVisibleToken', 'First chunk to first visible token'),
      completion_to_terminal_persist: jt('diagnostics.phases.completionToTerminalPersist', 'Completion to terminal persist'),
    };
    return Object.prototype.hasOwnProperty.call(labels, phaseName) ? labels[phaseName] : format().humanize(phaseName);
  }

  function classifyBackendPhase(phase) {
    switch (String(phase || '').trim().toLowerCase()) {
      case 'ready':
      case 'initialized': return 'ready';
      case 'starting':
      case 'retrying':
      case 'sidecar_spawned': return 'starting';
      case 'acquiring':
      case 'model_acquiring': return 'acquiring';
      case 'loading':
      case 'model_loading': return 'loading';
      case 'model_unavailable': return 'model_unavailable';
      case 'failed':
      case 'unavailable':
      case 'stopping':
      case 'stopped':
      case 'error':
      case 'crashed': return 'unavailable';
      default: return 'unknown';
    }
  }

  function deriveVerdict(stats, target) {
    const count = Number(stats?.count || 0);
    if (!count) {
      return 'empty';
    }
    const measurements = [stats?.p50, stats?.p95, target?.p50, target?.p95];
    if (measurements.some((value) => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)))) {
      return 'empty';
    }
    const p50 = Number(stats?.p50);
    const p95 = Number(stats?.p95);
    const targetP50 = Number(target?.p50);
    const targetP95 = Number(target?.p95);
    if (p50 <= targetP50 && p95 <= targetP95) {
      return 'pass';
    }
    if (p50 <= targetP50 * 1.5 && p95 <= targetP95 * 1.5) {
      return 'warn';
    }
    return 'fail';
  }

  function getPhaseNames(payload) {
    const phases = payload?.phases && typeof payload.phases === 'object' ? payload.phases : {};
    const targets = payload?.targets && typeof payload.targets === 'object' ? payload.targets : {};
    const extras = Object.keys({ ...targets, ...phases }).filter((name) => PHASE_ORDER.indexOf(name) === -1).sort();
    return PHASE_ORDER.concat(extras);
  }

  // The verdict reads from the derived value, never from translated text. A step with no target has none.
  function verdictCell(verdict) {
    if (verdict === 'pass') {
      return '<span class="diagnostics-verdict" data-verdict="pass">' + escapeHtml(jt('diagnostics.performance.onTarget', 'On target')) + '</span>';
    }
    if (verdict === 'warn') {
      return '<span class="diagnostics-verdict" data-verdict="warn">' + stateIcon('warn', { tone: 'warn', size: 'sm' })
        + escapeHtml(jt('diagnostics.performance.nearLimit', 'Near limit')) + '</span>';
    }
    if (verdict === 'fail') {
      return '<span class="diagnostics-verdict" data-verdict="fail">' + stateIcon('error', { tone: 'error', size: 'sm' })
        + escapeHtml(jt('diagnostics.performance.overTargetVerdict', 'Over target')) + '</span>';
    }
    return '';
  }

  // classNames: one class or a list of class tokens.
  function headerCell(label, title, classNames) {
    var className = [].concat(classNames || []).join(' ');
    return '<th scope="col"' + (className ? ' class="' + className + '"' : '') + (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(label) + '</th>';
  }

  /**
   * The Chat timing table: only steps with samples are rows.
   * @returns {{markup: string, measured: number, total: number, chats: number}} markup is '' when nothing is measured
   */
  function buildPhaseTimingView(payload) {
    const fmt = format();
    const phases = payload?.phases && typeof payload.phases === 'object' ? payload.phases : {};
    const targets = payload?.targets && typeof payload.targets === 'object' ? payload.targets : {};
    const allNames = getPhaseNames(payload);
    const names = allNames.filter((name) => Number(phases[name]?.count) > 0);
    if (!names.length) return { markup: '', measured: 0, total: allNames.length, chats: 0 };
    const rows = names.map((name) => {
      const stats = phases[name] || {};
      const target = targets[name] || {};
      const hasTarget = fmt.formatMs(target.p50) !== fmt.EMPTY || fmt.formatMs(target.p95) !== fmt.EMPTY;
      return '<tr>'
        + '<td>' + escapeHtml(phaseLabel(name)) + '</td>'
        + '<td class="diagnostics-num">' + escapeHtml(fmt.formatMs(stats.p50)) + '</td>'
        + '<td class="diagnostics-num">' + escapeHtml(fmt.formatMs(stats.p95)) + '</td>'
        + '<td class="diagnostics-num diagnostics-col-wide">' + escapeHtml(fmt.formatMs(stats.p99)) + '</td>'
        + '<td class="diagnostics-num diagnostics-col-wide">' + escapeHtml(hasTarget ? fmt.formatMs(target.p50) + ' / ' + fmt.formatMs(target.p95) : fmt.EMPTY) + '</td>'
        + '<td>' + verdictCell(deriveVerdict(stats, target)) + '</td>'
        + '</tr>';
    }).join('');
    const markup = '<table class="diagnostics-table"><thead><tr>'
      + headerCell(jt('diagnostics.performance.step', 'Step'))
      + headerCell(jt('diagnostics.performance.typical', 'Typical'), 'P50', 'diagnostics-num')
      + headerCell(jt('diagnostics.performance.slow', 'Slow'), 'P95', 'diagnostics-num')
      + headerCell(jt('diagnostics.performance.slowest', 'Slowest'), 'P99', ['diagnostics-num', 'diagnostics-col-wide'])
      + headerCell(jt('diagnostics.performance.target', 'Target'), 'P50 / P95', ['diagnostics-num', 'diagnostics-col-wide'])
      + '<th scope="col"><span class="sr-only">' + escapeHtml(jt('diagnostics.performance.verdict', 'Verdict')) + '</span></th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
    // One chat contributes a sample to each step it passed through, so the busiest step counts the chats.
    const chats = Math.max(...names.map((name) => Number(phases[name].count) || 0));
    return { markup, measured: names.length, total: allNames.length, chats };
  }

  return {
    PHASE_ORDER,
    buildPhaseTimingView,
    classifyBackendPhase,
    deriveVerdict,
    phaseLabel,
  };
});
