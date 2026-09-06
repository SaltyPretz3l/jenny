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

  const ID_PILL_BUTTON = 'workbenchHealthPillButton';
  const ID_POPOVER = 'workbenchHealthPopover';

  const escapeHtml = stringUtils.escapeHtml;
  const normString = stringUtils.normalizeString;

  function pickPositiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function arrayLength(value) {
    return Array.isArray(value) ? value.length : 0;
  }

  function buildPillMarkup(toneLabel, options) {
    const tone = escapeHtml(toneLabel.tone || 'muted');
    const labelHtml = escapeHtml(toneLabel.label || 'Unknown');
    const accessibleLabel = toneLabel.tone === 'success'
      ? 'Engine ready — runtime health'
      : (toneLabel.label || 'Unknown') + ' — runtime health';
    /* EH-W11: tiny danger count badge when the error center holds
     * unseen entries; absent store (or zero unseen) renders as before. */
    const unseen = Number(options && options.unseenErrorCount) || 0;
    const badge = unseen > 0
      ? '<span class="workbench-health-pill-error-badge" role="status"'
        + ' aria-label="' + unseen + ' recent error' + (unseen === 1 ? '' : 's') + '">'
        + (unseen > 9 ? '9+' : unseen) + '</span>'
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
      + badge
      + '</button>';
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
      return { html: escapeHtml('lifecycle facet unavailable'), valueClass: 'muted' };
    }
    const parts = [];
    const phase = normString(lifecycle.phase);
    if (phase && phase !== 'unknown') parts.push('phase ' + phase);
    if (Number.isFinite(lifecycle.pid) && lifecycle.pid > 0) parts.push('pid ' + lifecycle.pid);
    const startupMs = pickPositiveNumber(lifecycle.startup_ms);
    if (startupMs != null) {
      const seconds = startupMs >= 1000 ? (startupMs / 1000).toFixed(2) + 's' : startupMs + 'ms';
      parts.push('launched in ' + seconds);
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
    const engine = normString(runtime && runtime.engine) || 'no engine';
    const model = normString(runtime && runtime.model) || 'no model';
    const loaded = runtime && runtime.model_loaded === true;
    const tag = loaded ? 'loaded' : 'unloaded';
    const valueClass = loaded ? 'success' : 'muted';
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
      detail = 'serving' + (alias ? ' ' + alias : '') + (port > 0 ? ' on :' + port : '')
        + (mode && mode !== 'off' && mode !== 'unknown' ? ' · ' + mode : '');
      valueClass = 'success';
    } else if (state === 'crashed') {
      detail = 'stopped unexpectedly' + (alias ? ' (' + alias + ')' : '');
      valueClass = 'danger';
    } else if (state === 'stopped') {
      detail = 'failed to start' + (alias ? ' (' + alias + ')' : '') + ': ' + lastError;
      valueClass = 'danger';
    }
    return {
      html: escapeHtml('llama-server · ') + '<em>' + escapeHtml(detail) + '</em>',
      valueClass,
      needsRestart: state === 'crashed' || state === 'stopped',
    };
  }

  function formatByteCount(value) {
    const bytes = pickPositiveNumber(value);
    if (bytes == null || bytes === 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let scaled = bytes;
    let unit = 0;
    while (scaled >= 1024 && unit < units.length - 1) {
      scaled /= 1024;
      unit += 1;
    }
    return (scaled >= 10 || unit === 0 ? scaled.toFixed(0) : scaled.toFixed(1)) + ' ' + units[unit];
  }

  function formatModelAcquisition(snapshot) {
    const lifecycle = snapshot && snapshot.runtime && snapshot.runtime.lifecycle;
    const acquisition = lifecycle && lifecycle.model_acquisition;
    if (!acquisition || typeof acquisition !== 'object') {
      return { html: escapeHtml('no acquisition in progress'), valueClass: 'muted' };
    }
    const requestedModel = normString(acquisition.requested_model) || 'no model requested';
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

  function formatRecentIssues(snapshot) {
    const logs = snapshot && snapshot.logs ? snapshot.logs : null;
    const slowOps = snapshot && snapshot.slow_operations ? snapshot.slow_operations : null;
    const issueCount = logs && logs.available === true ? arrayLength(logs.recent_issues) : 0;
    const slowCount = slowOps && slowOps.available === true ? arrayLength(slowOps.items) : 0;
    if (issueCount === 0 && slowCount === 0) {
      return { html: escapeHtml('no warnings or slow operations'), valueClass: 'success' };
    }
    const parts = [];
    if (issueCount > 0) parts.push(issueCount + ' recent ' + (issueCount === 1 ? 'issue' : 'issues'));
    if (slowCount > 0) parts.push(slowCount + ' slow op' + (slowCount === 1 ? '' : 's'));
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
    if (deltaSeconds < 60) return 'just now';
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
      + '<span class="workbench-health-popover-errors-title">Recent errors</span>'
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

  function buildPopoverMarkup(state, snapshot, extras) {
    if (state.error) {
      return ''
        + '<div class="workbench-health-popover" id="' + ID_POPOVER + '" role="dialog"'
        + ' tabindex="-1" aria-label="Runtime health" data-health-tone="danger">'
        + '<div class="workbench-health-popover-status">'
        + '<span class="workbench-health-pill-dot" aria-hidden="true"></span>'
        + '<span>Error</span>'
        + '</div>'
        + '<div class="workbench-health-popover-empty">' + escapeHtml(state.error) + '</div>'
        + '</div>';
    }

    if (!snapshot) {
      return ''
        + '<div class="workbench-health-popover" id="' + ID_POPOVER + '" role="dialog"'
        + ' tabindex="-1" aria-label="Runtime health" data-health-tone="pending">'
        + '<div class="workbench-health-popover-status">'
        + '<span class="workbench-health-pill-dot" aria-hidden="true"></span>'
        + '<span>Loading status…</span>'
        + '</div>'
        + '<div class="workbench-health-popover-empty">Loading</div>'
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
    const hasLifecycle = lifecycleFacet && lifecycleFacet.available === true
      && lifecycle.html !== escapeHtml('idle');
    /* The composer always emits a model_acquisition object (idle stages mirror
     * lifecycle state), so presence alone would render a permanent filler row —
     * only an in-flight or failed acquisition carries information. */
    const acquisitionStage = normString(
      lifecycleFacet && lifecycleFacet.model_acquisition && lifecycleFacet.model_acquisition.stage
    ).toLowerCase();
    const hasAcquisition = acquisitionStage === 'acquiring' || acquisitionStage === 'unavailable';
    const hasIssues = issues.html !== escapeHtml('no warnings or slow operations');

    return ''
      + '<div class="workbench-health-popover" id="' + ID_POPOVER + '" role="dialog"'
      + ' tabindex="-1" aria-label="Runtime health" data-health-tone="' + tone + '">'
      + '<div class="workbench-health-popover-status">'
      + '<span class="workbench-health-pill-dot" aria-hidden="true"></span>'
      + '<span>' + escapeHtml(state.toneLabel.label) + '</span>'
      + '</div>'
      + (summary ? '<div class="workbench-health-popover-summary">'
        + escapeHtml(summary) + '</div>' : '')
      + '<div class="workbench-health-popover-facts">'
      + '<div class="workbench-health-popover-fact workbench-health-popover-row-value-'
      + engine.valueClass + '">' + engine.html + '</div>'
      + (hasLifecycle
        ? '<div class="workbench-health-popover-fact">' + lifecycle.html + '</div>'
        : '')
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
      + '</div>'
      + buildRecentErrorsSection(extras)
      + '<div class="workbench-health-popover-actions">'
      + (llamaServer && llamaServer.needsRestart
        ? buildPopoverAction('Restart llama-server', 'restart-llama-server')
        : '')
      + (modelUnavailable
        ? buildPopoverAction('Retry', 'retry-model')
          + buildPopoverAction('Models', 'open-models')
        : '')
      + buildPopoverAction('Diagnostics', 'open-runtime-health')
      + buildPopoverAction('Logs', 'open-logs')
      + (recentErrors.length ? buildPopoverAction('Clear errors', 'clear-errors') : '')
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
    formatEngineModel,
    formatModelAcquisition,
    formatRecentIssues,
    positionPopover,
  };
});
