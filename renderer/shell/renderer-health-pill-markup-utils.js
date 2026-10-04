(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('../inventory/action-button'),
      require('../inventory/badge')
    );
    return;
  }
  root.rendererHealthPillMarkupUtils = factory(
    root.stringUtils,
    root.inventoryActionButton,
    root.inventoryBadge
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, injectedActionButton, injectedBadge) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const ID_PILL_BUTTON = 'workbenchHealthPillButton';
  const ID_POPOVER = 'workbenchHealthPopover';

  const escapeHtml = stringUtils.escapeHtml;
  const normString = stringUtils.normalizeString;
  const PROVIDER_ENGINE_RESIDENCY = Object.freeze({ chatgpt: 'remote', 'codex-cli': 'cli' });

  function pickPositiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function arrayLength(value) {
    return Array.isArray(value) ? value.length : 0;
  }

  function runModeText(pauseState) {
    if (pauseState === 'requested') return jt('healthPill.runMode.pauseRequested', 'Auto · Pause requested');
    if (pauseState === 'paused') return jt('healthPill.runMode.paused', 'Auto · Paused');
    return jt('healthPill.runMode.autoChip', 'Auto');
  }

  /* The health dot, plus (only while Auto run is on) the run-mode chip as its
   * own button beside it: it opens the run-mode setting, not this dialog. The
   * dot's name carries every visible segment (status, engine, model, unseen
   * errors, remote devices); the badge itself is presentational. */
  function buildPillMarkup(toneLabel, options) {
    const opts = options || {};
    const tone = escapeHtml(toneLabel.tone || 'muted');
    const labelHtml = escapeHtml(toneLabel.label || 'Unknown');
    const runMode = opts.runMode === 'auto' ? 'auto' : 'ask';
    const pauseState = ['requested', 'paused'].includes(opts.pauseState) ? opts.pauseState : 'none';
    const unseen = Number(opts.unseenErrorCount) || 0;
    const segments = (Array.isArray(toneLabel.segments) ? toneLabel.segments : [])
      .filter((segment) => segment && normString(segment.label));
    const accessibleLabel = [
      normString(toneLabel.statusLabel) || normString(toneLabel.label) || jt('healthPill.unknown', 'Unknown'),
      normString(opts.engine),
      normString(opts.model),
      unseen > 0 ? jtn('healthPill.popover.recentErrorCount', unseen, { count: unseen }, '{count} recent error', '{count} recent errors') : '',
    ].concat(segments.map((segment) => normString(segment.label))).filter(Boolean).join(' · ');
    const badge = unseen > 0
      ? '<span class="workbench-health-pill-error-badge" aria-hidden="true">'
        + (unseen > 9 ? '9+' : unseen) + '</span>'
      : '';
    const segmentHtml = segments.map((segment) => '<span class="workbench-health-pill-label" data-health-tone="'
      + escapeHtml(segment.tone || 'neutral') + '">' + escapeHtml(segment.label) + '</span>').join('');
    const actionButton = runMode === 'auto' ? resolveActionButtonPrimitive() : null;
    const modeText = runModeText(pauseState);
    const modeChip = actionButton
      ? actionButton({
        label: modeText,
        plain: true,
        className: 'workbench-health-pill-mode',
        ariaLabel: jt('healthPill.runMode.chipLabel', 'Run mode: {mode}', { mode: modeText }),
        title: jt('healthPill.runMode.chipLabel', 'Run mode: {mode}', { mode: modeText }),
        dataset: { 'run-mode': 'auto', 'pause-state': pauseState, 'health-pill-action': 'open-run-mode' },
      })
      : '';
    return ''
      + '<button type="button" class="workbench-health-pill"'
      + ' id="' + ID_PILL_BUTTON + '"'
      + ' data-health-tone="' + tone + '"'
      + ' aria-haspopup="dialog"'
      + ' aria-expanded="false"'
      + ' aria-controls="' + ID_POPOVER + '"'
      + ' aria-label="' + escapeHtml(accessibleLabel) + '"'
      + ' title="' + escapeHtml(accessibleLabel) + '">'
      + '<span class="workbench-health-pill-dot" aria-hidden="true"></span>'
      + (toneLabel.tone === 'success'
        ? ''
        : '<span class="workbench-health-pill-label">' + labelHtml + '</span>')
      + segmentHtml
      + badge
      + '</button>'
      + modeChip;
  }

  function buildPopoverRow(label, valueHtml, valueClass) {
    const cls = ['workbench-health-popover-row-value'];
    if (valueClass) cls.push('workbench-health-popover-row-value-' + valueClass);
    return ''
      + '<div class="workbench-health-popover-row">'
      + '<span class="workbench-health-popover-row-label">' + escapeHtml(label) + '</span>'
      + '<span class="' + cls.join(' ') + '">' + valueHtml + '</span>'
      + '</div>';
  }

  function formatLifecycleDetail(lifecycle) {
    if (!lifecycle || lifecycle.available !== true) {
      return { html: escapeHtml(jt('healthPill.lifecycleUnavailable', 'lifecycle facet unavailable')), valueClass: 'muted' };
    }
    const parts = [];
    const phase = normString(lifecycle.phase);
    if (phase && phase !== 'unknown') parts.push('phase ' + phase);
    if (Number.isFinite(lifecycle.pid) && lifecycle.pid > 0) parts.push('pid ' + lifecycle.pid);
    const startupMs = pickPositiveNumber(lifecycle.startup_ms);
    if (startupMs != null) {
      const seconds = startupMs >= 1000 ? (startupMs / 1000).toFixed(2) + 's' : startupMs + 'ms';
      parts.push(jt('healthPill.launchedIn', 'launched in {duration}', { duration: seconds }));
    }
    const detail = normString(lifecycle.detail);
    if (detail) parts.push(detail);
    if (parts.length === 0) {
      return { html: escapeHtml('idle'), valueClass: 'muted' };
    }
    return { html: escapeHtml(parts.join(' · ')), valueClass: '' };
  }

  function formatEngineModel(snapshot) {
    const runtime = snapshot && snapshot.runtime ? snapshot.runtime : null;
    const engine = normString(runtime && runtime.engine) || jt('healthPill.noEngine', 'no engine');
    const model = normString(runtime && runtime.model) || jt('healthPill.noModel', 'no model');
    const loaded = runtime && runtime.model_loaded === true;
    const runtimeModel = runtime && runtime.local_runtime && runtime.local_runtime.model;
    // The sidecar's residency wins; before its first status arrives, only the provider engines are named.
    const residency = normString(runtimeModel && runtimeModel.residency)
      || PROVIDER_ENGINE_RESIDENCY[normString(runtime && runtime.engine)] || 'local';
    const providerConfigured = runtimeModel && typeof runtimeModel.configured === 'boolean'
      ? runtimeModel.configured : !!normString(runtime && runtime.model);
    const isProvider = residency === 'remote' || residency === 'cli';
    const tag = isProvider
      ? (providerConfigured
        ? (residency === 'remote' ? jt('healthPill.configuredCloud', 'Configured (cloud)') : jt('healthPill.configuredCli', 'Configured (CLI)'))
        : jt('healthPill.notConfigured', 'Not configured'))
      : (loaded ? 'loaded' : 'unloaded');
    const valueClass = (isProvider ? providerConfigured : loaded) ? 'success' : 'muted';
    return {
      html: escapeHtml(engine + ' · ' + model + ' · ') + '<em>' + escapeHtml(tag) + '</em>',
      valueClass,
    };
  }

  /* Managed llama-server facet (runtime.llama_server). Only a server that is
   * running, coming up, crashed, or failed to (re)start carries information;
   * a clean 'stopped' (the normal state while Ollama is the engine) renders
   * nothing. */
  function formatLlamaServer(snapshot) {
    const facet = snapshot && snapshot.runtime && snapshot.runtime.llama_server;
    if (!facet || typeof facet !== 'object' || Array.isArray(facet)) return null;
    const state = normString(facet.state).toLowerCase();
    const lastError = normString(facet.last_error);
    if (!state || state === 'unknown' || (state === 'stopped' && !lastError)) return null;
    const alias = normString(facet.alias);
    const port = Number(facet.port);
    const mode = normString(facet.acceleration_mode).toLowerCase();
    let detail = state;
    let valueClass = 'muted';
    if (state === 'ready') {
      // A custom build names itself ('build 10683', 1-9 digits, no leading zero);
      // bundled, env, custom and unknown add nothing.
      const build = /^build ([1-9]\d{0,8})$/.exec(typeof facet.runtime_label === 'string' ? facet.runtime_label : '');
      detail = 'serving' + (alias ? ' ' + alias : '') + (port > 0 ? ' on :' + port : '')
        + (mode && mode !== 'off' && mode !== 'unknown' ? ' · ' + mode : '')
        + (build ? jt('models.library.buildSuffix', ' · build {build}', { build: build[1] }) : '');
      valueClass = 'success';
    } else if (state === 'crashed') {
      detail = jt('healthPill.serverStoppedUnexpectedly', 'stopped unexpectedly{alias}', { alias: alias ? ' (' + alias + ')' : '' });
      valueClass = 'danger';
    } else if (state === 'stopped') {
      detail = jt('healthPill.serverFailedToStart', 'failed to start{alias}: {error}', { alias: alias ? ' (' + alias + ')' : '', error: lastError });
      valueClass = 'danger';
    }
    return {
      html: escapeHtml('llama-server · ') + '<em>' + escapeHtml(detail) + '</em>',
      valueClass,
      needsRestart: state === 'crashed' || state === 'stopped',
    };
  }

  // Decimal units, as the model sources report sizes: one download, one GB
  // total.
  const BYTE_UNIT_BASE = 1000;
  function formatByteCount(value) {
    const bytes = pickPositiveNumber(value);
    if (bytes == null || bytes === 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let scaled = bytes;
    let unit = 0;
    while (scaled >= BYTE_UNIT_BASE && unit < units.length - 1) {
      scaled /= BYTE_UNIT_BASE;
      unit += 1;
    }
    return (scaled >= 10 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)) + ' ' + units[unit];
  }

  function formatModelAcquisition(snapshot) {
    const lifecycle = snapshot && snapshot.runtime && snapshot.runtime.lifecycle;
    const acquisition = lifecycle && lifecycle.model_acquisition;
    if (!acquisition || typeof acquisition !== 'object') {
      return { html: escapeHtml(jt('healthPill.noAcquisition', 'no acquisition in progress')), valueClass: 'muted' };
    }
    const requestedModel = normString(acquisition.requested_model) || jt('healthPill.noModelRequested', 'no model requested');
    const stage = normString(acquisition.stage) || 'unloaded';
    const percent = Math.max(0, Math.min(100, Number(acquisition.percent) || 0));
    const completed = formatByteCount(acquisition.completed_bytes);
    const total = formatByteCount(acquisition.total_bytes);
    const separator = ' \u00b7 ';
    const bytes = completed ? separator + completed + (total ? ' / ' + total : '') : '';
    const percentText = stage === 'acquiring' ? separator + Math.round(percent) + '%' : '';
    return {
      html: escapeHtml(requestedModel + separator + stage + percentText + bytes),
      valueClass: stage === 'unavailable' ? 'danger' : stage === 'ready' ? 'success' : 'muted',
    };
  }

  // m:ss, the one clock for the pill's live load label and the popover.
  function formatLoadClock(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  }

  /* While a model loads, what the same model took last time (the backend's
   * bounded per-model memory, model_acquisition.last_load_ms). Nothing when
   * no earlier load is known or nothing is loading. */
  function buildLastLoadFact(lifecycleFacet) {
    const acquisition = lifecycleFacet && lifecycleFacet.model_acquisition;
    if (!acquisition || typeof acquisition !== 'object') return '';
    const stage = normString(acquisition.stage).toLowerCase();
    const lastMs = Number(acquisition.last_load_ms);
    if ((stage !== 'loading' && stage !== 'model_loading') || !Number.isFinite(lastMs) || lastMs <= 0) return '';
    return '<div class="workbench-health-popover-fact" data-health-fact="last-load">'
      + escapeHtml(jt('healthPill.popover.lastLoad', 'Last time: {duration}', { duration: formatLoadClock(lastMs) }))
      + '</div>';
  }

  function formatRecentIssues(snapshot) {
    const logs = snapshot && snapshot.logs ? snapshot.logs : null;
    const slowOps = snapshot && snapshot.slow_operations ? snapshot.slow_operations : null;
    const issueCount = logs && logs.available === true ? arrayLength(logs.recent_issues) : 0;
    const slowCount = slowOps && slowOps.available === true ? arrayLength(slowOps.items) : 0;
    if (issueCount === 0 && slowCount === 0) {
      return { html: escapeHtml(jt('healthPill.noRecentIssues', 'no warnings or slow operations')), valueClass: 'success', none: true };
    }
    const parts = [];
    if (issueCount > 0) parts.push(jtn('healthPill.recentIssueCount', issueCount, { count: issueCount }, '{count} recent issue', '{count} recent issues'));
    if (slowCount > 0) parts.push(jtn('healthPill.slowOperationCount', slowCount, { count: slowCount }, '{count} slow op', '{count} slow ops'));
    const valueClass = issueCount > 0 ? 'warning' : 'muted';
    return { html: escapeHtml(parts.join(' · ')), valueClass };
  }

  function resolveActionButtonPrimitive() {
    if (typeof globalThis !== 'undefined') {
      const inv = globalThis.inventory;
      if (inv && typeof inv.actionButton === 'function') return inv.actionButton;
      if (typeof globalThis.inventoryActionButton === 'function') return globalThis.inventoryActionButton;
    }
    return typeof injectedActionButton === 'function' ? injectedActionButton : null;
  }

  function resolveBadgePrimitive() {
    if (typeof globalThis !== 'undefined') {
      const inv = globalThis.inventory;
      if (inv && typeof inv.badge === 'function') return inv.badge;
      if (typeof globalThis.inventoryBadge === 'function') return globalThis.inventoryBadge;
    }
    return typeof injectedBadge === 'function' ? injectedBadge : null;
  }

  function formatRelativeTime(at, nowMs) {
    const then = Number(at) || 0;
    const now = Number(nowMs) || Date.now();
    const deltaSeconds = Math.max(0, Math.round((now - then) / 1000));
    if (deltaSeconds < 60) return jt('healthPill.justNow', 'just now');
    const minutes = Math.floor(deltaSeconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  }

  /* EH-W11: "Recent errors" popover section — at most five entries
   * (code badge + title + relative time); empty
   * center omits the whole section so the popover reads as before. */
  function buildRecentErrorsSection(extras) {
    const recentErrors = extras && Array.isArray(extras.recentErrors) ? extras.recentErrors : [];
    if (!recentErrors.length) return '';
    const badge = resolveBadgePrimitive();
    const nowMs = extras && Number(extras.nowMs) > 0 ? Number(extras.nowMs) : Date.now();
    const rows = recentErrors.slice(0, 5).map(function buildErrorRow(entry) {
      const source = entry && typeof entry === 'object' ? entry : {};
      const code = normString(source.code);
      const title = normString(source.title) || 'Error';
      const codeBadge = code && badge
        ? badge({ tone: source.severity === 'danger' ? 'danger' : 'default', size: 'sm', text: code, className: 'workbench-health-popover-error-code' })
        : '';
      return buildPopoverRow(
        formatRelativeTime(source.at, nowMs),
        codeBadge + '<span class="workbench-health-popover-error-title">' + escapeHtml(title) + '</span>',
        source.severity === 'danger' ? 'danger' : 'warning'
      );
    }).join('');
    return ''
      + '<div class="workbench-health-popover-errors">'
      + '<div class="workbench-health-popover-errors-head">'
      + '<span class="workbench-health-popover-errors-title">' + escapeHtml(jt('healthPill.popover.recentErrors', 'Recent errors')) + '</span>'
      + '</div>'
      + '<div class="workbench-health-popover-rows">' + rows + '</div>'
      + '</div>';
  }

  function buildPopoverAction(label, action) {
    const actionButton = resolveActionButtonPrimitive();
    return actionButton ? actionButton({
      label,
      plain: true,
      className: 'workbench-health-popover-action',
      dataset: { 'health-pill-action': action },
    }) : '';
  }

  function formatLoadPercent(value) {
    const n = value === null || value === undefined || value === '' ? NaN : Number(value);
    return Number.isFinite(n) ? Math.round(n) + '%' : '';
  }

  /* Machine load as one flat fact: CPU, then GPU utilization and VRAM when the
   * sampler has them (never on Windows ARM), RAM without a VRAM sample. No
   * stats yet renders nothing rather than invented zeros. */
  function buildLoadFact(stats) {
    if (!stats || typeof stats !== 'object') return '';
    const arch = normString(stats.arch).toLowerCase();
    const blocked = (arch === 'arm' || arch === 'arm64') && normString(stats.platform) !== 'darwin';
    const gpu = !blocked && stats.gpuMemory && typeof stats.gpuMemory === 'object' ? stats.gpuMemory : null;
    const parts = [];
    const cpu = formatLoadPercent(stats.cpuPercent);
    if (cpu) parts.push(jt('titlebar.metrics.cpu', 'CPU') + ' ' + cpu);
    const gpuUtil = gpu && gpu.utilAvailable === true ? formatLoadPercent(gpu.utilPercent) : '';
    if (gpuUtil) parts.push(jt('titlebar.metrics.gpu', 'GPU') + ' ' + gpuUtil);
    const usedMb = Number(gpu && gpu.usedMb);
    const totalMb = Number(gpu && gpu.totalMb);
    if (gpu && gpu.available === true && Number.isFinite(usedMb) && Number.isFinite(totalMb) && totalMb > 0) {
      parts.push(jt('titlebar.metrics.vram', 'VRAM') + ' ' + (usedMb / 1024).toFixed(1) + ' / ' + (totalMb / 1024).toFixed(1) + ' GB');
    } else {
      const ram = formatLoadPercent(stats.ramPercent);
      if (ram) parts.push(jt('titlebar.metrics.ram', 'RAM') + ' ' + ram);
    }
    return parts.length
      ? '<div class="workbench-health-popover-fact" data-health-fact="load">' + escapeHtml(parts.join(' · ')) + '</div>'
      : '';
  }

  function buildPopoverMarkup(state, snapshot, extras) {
    if (state.error) {
      return ''
        + '<div class="workbench-health-popover" id="' + ID_POPOVER + '" role="dialog"'
        + ' tabindex="-1" aria-label="' + escapeHtml(jt('healthPill.popover.ariaLabel', 'Runtime health')) + '" data-health-tone="danger">'
        + '<div class="workbench-health-popover-status">'
        + '<span class="workbench-health-pill-dot" aria-hidden="true"></span>'
        + '<span>' + escapeHtml(jt('healthPill.error', 'Error')) + '</span>'
        + '</div>'
        + '<div class="workbench-health-popover-empty">' + escapeHtml(state.error) + '</div>'
        + '</div>';
    }

    if (!snapshot) {
      return ''
        + '<div class="workbench-health-popover" id="' + ID_POPOVER + '" role="dialog"'
        + ' tabindex="-1" aria-label="' + escapeHtml(jt('healthPill.popover.ariaLabel', 'Runtime health')) + '" data-health-tone="pending">'
        + '<div class="workbench-health-popover-status">'
        + '<span class="workbench-health-pill-dot" aria-hidden="true"></span>'
        + '<span>' + escapeHtml(jt('healthPill.popover.loadingStatus', 'Loading status…')) + '</span>'
        + '</div>'
        + '<div class="workbench-health-popover-empty">' + escapeHtml(jt('healthPill.popover.loading', 'Loading')) + '</div>'
        + '</div>';
    }

    const lifecycleFacet = snapshot.runtime && snapshot.runtime.lifecycle;
    const lifecycle = formatLifecycleDetail(lifecycleFacet);
    const engine = formatEngineModel(snapshot);
    const issues = formatRecentIssues(snapshot);
    const acquisition = formatModelAcquisition(snapshot);
    const llamaServer = formatLlamaServer(snapshot);
    const modelUnavailable = lifecycleFacet?.model_state === 'unavailable';
    const summary = normString(state.toneLabel && state.toneLabel.summary);
    const tone = escapeHtml(state.toneLabel.tone || 'muted');
    const recentErrors = extras && Array.isArray(extras.recentErrors) ? extras.recentErrors : [];
    const runMode = extras && extras.runMode === 'auto' ? 'auto' : 'ask';
    const pauseState = extras && ['requested', 'paused'].includes(extras.pauseState)
      ? extras.pauseState
      : 'none';
    const pauseSummary = pauseState === 'requested'
      ? jt('healthPill.runMode.pauseRequested', 'Auto · Pause requested')
      : (pauseState === 'paused'
        ? jt('healthPill.runMode.paused', 'Auto · Paused')
        : '');
    const runModeSummary = jt('healthPill.runMode.autoSummary', 'Auto — tools run without asking')
      + (pauseSummary ? ' · ' + pauseSummary : '');
    const hasLifecycle = lifecycleFacet && lifecycleFacet.available === true
      && lifecycle.html !== escapeHtml('idle');
    /* The composer always emits a model_acquisition object (idle stages mirror
     * lifecycle state), so presence alone would render a permanent filler row —
     * only an in-flight or failed acquisition carries information. */
    const acquisitionStage = normString(
      lifecycleFacet && lifecycleFacet.model_acquisition && lifecycleFacet.model_acquisition.stage
    ).toLowerCase();
    const hasAcquisition = acquisitionStage === 'acquiring' || acquisitionStage === 'unavailable';
    const hasIssues = issues.none !== true;

    return ''
      + '<div class="workbench-health-popover" id="' + ID_POPOVER + '" role="dialog"'
      + ' tabindex="-1" aria-label="' + escapeHtml(jt('healthPill.popover.ariaLabel', 'Runtime health')) + '" data-health-tone="' + tone + '">'
      + '<div class="workbench-health-popover-status">'
      + '<span class="workbench-health-pill-dot" aria-hidden="true"></span>'
      + '<span>' + escapeHtml(state.toneLabel.label) + '</span>'
      + '</div>'
      + (summary ? '<div class="workbench-health-popover-summary">'
        + escapeHtml(summary) + '</div>' : '')
      + '<div class="workbench-health-popover-facts">'
      + (runMode === 'auto'
        ? buildPopoverRow(
          jt('healthPill.runMode.rowLabel', 'Run mode'),
          escapeHtml(runModeSummary),
          pauseState === 'paused' ? 'danger' : (pauseState === 'requested' ? 'warning' : '')
        )
        : '')
      + '<div class="workbench-health-popover-fact workbench-health-popover-row-value-'
      + engine.valueClass + '">' + engine.html + '</div>'
      + (hasLifecycle
        ? '<div class="workbench-health-popover-fact">' + lifecycle.html + '</div>'
        : '')
      + buildLastLoadFact(lifecycleFacet)
      + (hasAcquisition
        ? '<div class="workbench-health-popover-fact workbench-health-popover-row-value-'
          + acquisition.valueClass + '">' + acquisition.html + '</div>'
        : '')
      + (llamaServer
        ? '<div class="workbench-health-popover-fact workbench-health-popover-row-value-'
          + llamaServer.valueClass + '">' + llamaServer.html + '</div>'
        : '')
      + (hasIssues
        ? '<div class="workbench-health-popover-fact workbench-health-popover-row-value-warning">'
          + issues.html + '</div>'
        : '')
      + buildLoadFact(extras && extras.systemStats)
      + '</div>'
      + buildRecentErrorsSection(extras)
      + '<div class="workbench-health-popover-actions">'
      + (llamaServer && llamaServer.needsRestart
        ? buildPopoverAction(jt('healthPill.popover.restartLlamaServer', 'Restart llama-server'), 'restart-llama-server')
        : '')
      + (modelUnavailable
        ? buildPopoverAction(jt('healthPill.popover.retry', 'Retry'), 'retry-model')
          + buildPopoverAction(jt('healthPill.popover.models', 'Models'), 'open-models')
        : '')
      + buildPopoverAction(jt('healthPill.popover.diagnostics', 'Diagnostics'), 'open-runtime-health')
      + buildPopoverAction(jt('healthPill.popover.logs', 'Logs'), 'open-logs')
      + buildPopoverAction(extras && extras.titlebarLoad === true
        ? jt('healthPill.popover.hideLoad', 'Hide load from title bar')
        : jt('healthPill.popover.showLoad', 'Show load in title bar'), 'toggle-titlebar-load')
      + (recentErrors.length ? buildPopoverAction(jt('healthPill.popover.clearErrors', 'Clear errors'), 'clear-errors') : '')
      + '</div>'
      + '</div>';
  }

  function positionPopover(button, popover) {
    if (!button || !popover) return;
    const rect = button.getBoundingClientRect();
    const popHeight = popover.offsetHeight || 200;
    const viewportH = (typeof window !== 'undefined' && window.innerHeight) || 800;
    const viewportW = (typeof window !== 'undefined' && window.innerWidth) || 1200;
    const showBelow = rect.bottom + popHeight + 16 < viewportH;
    const top = showBelow ? Math.round(rect.bottom + 8) : Math.round(rect.top - popHeight - 8);
    const popWidth = popover.offsetWidth || 320;
    let left = Math.round(rect.right - popWidth);
    if (left < 12) left = 12;
    if (left + popWidth > viewportW - 12) left = viewportW - popWidth - 12;
    popover.style.top = top + 'px';
    popover.style.left = left + 'px';
  }

  return {
    ID_PILL_BUTTON,
    ID_POPOVER,
    escapeHtml,
    buildPillMarkup,
    buildPopoverRow,
    buildPopoverMarkup,
    buildRecentErrorsSection,
    formatRelativeTime,
    formatLifecycleDetail,
    formatLoadClock,
    formatEngineModel,
    formatModelAcquisition,
    formatRecentIssues,
    positionPopover,
  };
});
