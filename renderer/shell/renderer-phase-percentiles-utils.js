/* renderer/shell/renderer-phase-percentiles-utils.js - Diagnostics phase percentile renderer. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPhasePercentilesUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  const PHASE_LABELS = {
    click_to_optimistic_render: 'Click to optimistic render',
    optimistic_render_to_context_assembly_started: 'Optimistic render to assembly start',
    context_assembly_elapsed_no_memory_git: 'Context assembly, no memory/Git',
    context_assembly_elapsed_memory_git: 'Context assembly, memory/Git',
    context_assembly_completed_to_sidecar_request_sent: 'Assembly complete to sidecar sent',
    sidecar_request_sent_to_provider_request_start: 'Sidecar sent to provider start',
    provider_request_start_to_first_chunk: 'Provider start to first chunk',
    first_chunk_to_first_visible_token: 'First chunk to first visible token',
    completion_to_terminal_persist: 'Completion to terminal persist',
  };

  function defaultEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 'TBD';
    }
    if (numeric >= 1000) {
      return `${(numeric / 1000).toFixed(2)}s`;
    }
    return `${Math.round(numeric)}ms`;
  }

  function deriveVerdict(stats, target) {
    const count = Number(stats?.count || 0);
    if (!count) {
      return 'empty';
    }
    const p50 = Number(stats?.p50);
    const p95 = Number(stats?.p95);
    const targetP50 = Number(target?.p50);
    const targetP95 = Number(target?.p95);
    if (!Number.isFinite(targetP50) || !Number.isFinite(targetP95)) {
      return 'empty';
    }
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

  function buildPhaseRows(payload, escapeHtml) {
    const phases = payload?.phases && typeof payload.phases === 'object' ? payload.phases : {};
    const targets = payload?.targets && typeof payload.targets === 'object' ? payload.targets : {};
    return getPhaseNames(payload).map((phaseName) => {
      const stats = phases[phaseName] || {};
      const target = targets[phaseName] || {};
      const verdict = deriveVerdict(stats, target);
      return [
        '<tr>',
        `<td>${escapeHtml(PHASE_LABELS[phaseName] || phaseName)}</td>`,
        `<td>${escapeHtml(formatMs(stats.p50))}</td>`,
        `<td>${escapeHtml(formatMs(stats.p95))}</td>`,
        `<td>${escapeHtml(formatMs(stats.p99))}</td>`,
        `<td>${escapeHtml(Number(stats.count || 0))}</td>`,
        `<td>${escapeHtml(formatMs(target.p50))}</td>`,
        `<td>${escapeHtml(formatMs(target.p95))}</td>`,
        `<td><span class="phase-verdict phase-verdict-${escapeHtml(verdict)}">${escapeHtml(verdict)}</span></td>`,
        '</tr>',
      ].join('');
    }).join('');
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const normalized = String(value == null ? '' : value).trim();
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  function getPhaseStats(payload, phaseName) {
    const phases = payload?.phases && typeof payload.phases === 'object' ? payload.phases : {};
    return phases[phaseName] && typeof phases[phaseName] === 'object' ? phases[phaseName] : {};
  }

  function sumSamples(payload) {
    const phases = payload?.phases && typeof payload.phases === 'object' ? payload.phases : {};
    return Object.values(phases).reduce((total, stats) => total + Number(stats?.count || 0), 0);
  }

  function applyHarnessHealthOverride(summary, harnessSnapshot, deriveRuntimeHealthState) {
    if (!harnessSnapshot || typeof deriveRuntimeHealthState !== 'function') {
      return summary;
    }
    let phase7;
    try {
      phase7 = deriveRuntimeHealthState(harnessSnapshot);
    } catch (_error) {
      return summary;
    }
    if (!phase7 || typeof phase7 !== 'object') {
      return summary;
    }
    const tone = String(phase7.tone || '').trim();
    if (tone !== 'warning' && tone !== 'danger') {
      return summary;
    }
    const phase7Summary = String(phase7.summary || '').trim();
    const badge = summary.badge === 'Unavailable' && tone === 'warning'
      ? summary.badge
      : tone === 'danger' ? 'Blocked' : 'Degraded';
    return Object.assign({}, summary, {
      badge,
      summary: phase7Summary
        ? `${phase7Summary}. ${summary.summary || ''}`.trim()
        : summary.summary,
    });
  }

  function buildRuntimeHealthSummary({ phasePercentilesState, runtimeHealthState, harnessSnapshot, deriveRuntimeHealthState } = {}) {
    const state = phasePercentilesState && typeof phasePercentilesState === 'object'
      ? phasePercentilesState
      : {};
    const runtime = runtimeHealthState && typeof runtimeHealthState === 'object'
      ? runtimeHealthState
      : {};
    const payload = state.payload && typeof state.payload === 'object' ? state.payload : null;
    const backend = runtime.backend && typeof runtime.backend === 'object' ? runtime.backend : {};
    const status = runtime.status && typeof runtime.status === 'object' ? runtime.status : {};
    const modelList = runtime.modelList && typeof runtime.modelList === 'object' ? runtime.modelList : {};
    const offline = runtime.offline && typeof runtime.offline === 'object' ? runtime.offline : {};
    const engine = firstNonEmpty(status.engine, status.active_engine, backend.engine, modelList.engine, 'local');
    const model = firstNonEmpty(
      status.model,
      status.active_model,
      modelList.active_model,
      offline.preferredLocalModel,
      'no active model'
    );
    const backendPhase = firstNonEmpty(backend.phase, status.phase, 'unknown');
    const backendUnavailable = ['failed', 'unavailable', 'stopped', 'error', 'crashed']
      .includes(backendPhase.toLowerCase());
    const offlineActive = offline.mode === 'local_only' || offline.mode === 'offline';
    const offlineUnavailableReason = offlineActive ? offline.unavailableReason : '';
    const lastError = firstNonEmpty(
      state.error,
      backend.last_error,
      backend.lastError,
      backend.error,
      status.last_error,
      status.lastError,
      offlineUnavailableReason
    );
    const catalogUnavailable = modelList.available === false;
    const degraded = Boolean(
      lastError
      || catalogUnavailable
      || backend.degraded === true
      || status.degraded === true
      || offline.degraded === true
      || backendUnavailable
      || (offline.mode === 'local_only' && offline.localChatReady === false)
    );
    const providerStats = getPhaseStats(payload, 'provider_request_start_to_first_chunk');
    const visibleStats = getPhaseStats(payload, 'first_chunk_to_first_visible_token');
    const providerP50 = formatMs(providerStats.p50);
    const visibleP50 = formatMs(visibleStats.p50);
    const sampleCount = sumSamples(payload);
    const generatedAt = firstNonEmpty(payload?.generated_at, 'recently');
    const baseSummary = {
      badge: state.loading
        ? 'Refreshing'
        : backendUnavailable
          ? 'Unavailable'
          : degraded
            ? 'Degraded'
            : backendPhase === 'ready' || backendPhase === 'initialized' || offline.localChatReady === true
              ? 'Healthy'
              : sampleCount > 0
                ? 'Live'
                : 'Pending',
      summary: `Runtime health: ${engine} / ${model}; backend ${backendPhase}.`,
      status: lastError
        ? `Last error: ${lastError}`
        : sampleCount > 0
          ? `Snapshot ${generatedAt}. Provider start to first chunk P50 ${providerP50}; first chunk to first visible token P50 ${visibleP50}.`
          : backendUnavailable
            ? 'Latency evidence is unavailable until the backend recovers.'
            : 'No latency samples recorded for this run.',
      sampleHint: backendUnavailable
        ? 'Latency sampling is unavailable until the backend recovers.'
        : 'Send a local chat to populate the live ring buffers.',
      recoveryLabel: degraded ? 'Retry backend status' : 'Open Models',
      recoverySection: 'models',
    };
    if (state.loading) {
      return baseSummary;
    }
    return applyHarnessHealthOverride(baseSummary, harnessSnapshot, deriveRuntimeHealthState);
  }

  function renderPhasePercentilesPane({
    phasePercentilesState,
    runtimeHealthState,
    harnessSnapshot,
    deriveRuntimeHealthState,
    dom,
    escapeHtml = defaultEscapeHtml,
  } = {}) {
    const state = phasePercentilesState && typeof phasePercentilesState === 'object'
      ? phasePercentilesState
      : {};
    const paneDom = dom && typeof dom === 'object' ? dom : {};
    const payload = state.payload && typeof state.payload === 'object' ? state.payload : null;
    const phaseCount = payload?.phases && typeof payload.phases === 'object'
      ? Object.keys(payload.phases).length
      : 0;
    const sampleCount = sumSamples(payload);
    const health = buildRuntimeHealthSummary({
      phasePercentilesState: state,
      runtimeHealthState,
      harnessSnapshot,
      deriveRuntimeHealthState,
    });

    if (paneDom.diagnosticsBadge) {
      const badgeText = state.loading
        ? 'Refreshing'
        : state.error
          ? 'Error'
          : health.badge;
      paneDom.diagnosticsBadge.textContent = badgeText;
      paneDom.diagnosticsBadge.dataset.tone = ({
        healthy: 'success',
        live: 'success',
        degraded: 'warning',
        blocked: 'danger',
        error: 'danger',
        unavailable: 'danger',
        refreshing: 'pending',
        pending: 'pending',
      })[String(badgeText).toLowerCase()] || 'pending';
    }
    if (paneDom.diagnosticsStatus) {
      paneDom.diagnosticsStatus.textContent = String(state.error || '').trim()
        || health.status;
    }
    if (paneDom.diagnosticsSummary) {
      paneDom.diagnosticsSummary.textContent = state.loading
        ? 'Refreshing live phase percentiles...'
        : state.error
          ? `Phase percentiles unavailable: ${String(state.error || 'refresh failed').trim()}`
          : sampleCount > 0
            ? `${health.summary} ${sampleCount} samples across ${phaseCount} phases.`
            : `${health.summary} ${health.sampleHint}`;
    }
    if (paneDom.phasePercentilesTable) {
      const markup = state.loading
        ? '<div class="phase-percentiles-empty"><strong>Loading latency samples…</strong></div>'
        : state.error
          ? '<div class="phase-percentiles-empty" data-tone="error"><strong>Phase latency unavailable</strong><p>'
            + escapeHtml(String(state.error || 'Refresh failed').trim()) + '</p></div>'
          : sampleCount === 0
            ? '<div class="phase-percentiles-empty"><strong>No latency samples yet</strong><p>'
              + escapeHtml(health.sampleHint) + '</p></div>'
            : [
              '<table class="phase-percentiles-table">',
              '<thead><tr>',
              '<th scope="col">Phase</th><th scope="col">P50</th><th scope="col">P95</th><th scope="col">P99</th><th scope="col">Count</th><th scope="col">Target P50</th><th scope="col">Target P95</th><th scope="col">Verdict</th>',
              '</tr></thead>',
              `<tbody>${buildPhaseRows(payload || { targets: {}, phases: {} }, escapeHtml)}</tbody>`,
              '</table>',
            ].join('');
      if (paneDom.phasePercentilesTable.innerHTML !== markup) {
        paneDom.phasePercentilesTable.innerHTML = markup;
      }
    }
    if (paneDom.phasePercentilesResetButton) {
      paneDom.phasePercentilesResetButton.disabled = state.loading || sampleCount === 0;
    }
  }

  return {
    PHASE_LABELS,
    PHASE_ORDER,
    buildRuntimeHealthSummary,
    deriveVerdict,
    formatMs,
    renderPhasePercentilesPane,
  };
});
