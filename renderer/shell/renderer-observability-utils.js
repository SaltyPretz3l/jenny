(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/log-contract-utils'));
    return;
  }
  root.rendererObservabilityUtils = factory(root.logContractUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (logContractUtils) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const LOG_RETENTION = logContractUtils && logContractUtils.LOG_RETENTION
    ? logContractUtils.LOG_RETENTION
    : { observabilityRecentLogLimit: 50 };
  const TURN_SETTLED_REFRESH_MS = 4000;
  // This controller renders only tool_observability, slow_operations, and trace_timing;
  // harness inspection is unused here and adds a sidecar round trip.
  const FETCH_OPTIONS = Object.freeze({
    recentLogLimit: LOG_RETENTION.observabilityRecentLogLimit,
    includeHarness: false,
  });

  function resolveMarkup(deps) {
    if (deps.markup && typeof deps.markup === 'object') return deps.markup;
    if (typeof globalThis !== 'undefined' && globalThis.rendererObservabilityMarkupUtils) {
      return globalThis.rendererObservabilityMarkupUtils;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-observability-markup-utils'); } catch (_error) { /* not available */ }
    }
    return null;
  }

  function createObservabilityController(deps) {
    const dependencies = deps || {};
    const windowRef = dependencies.window || (typeof window !== 'undefined' ? window : null);
    const dom = dependencies.dom || {};
    const callbacks = dependencies.callbacks || {};
    const markup = resolveMarkup(dependencies);
    const now = typeof dependencies.now === 'function' ? dependencies.now : () => Date.now();
    const setTimer = dependencies.setTimeout || windowRef?.setTimeout?.bind(windowRef) || setTimeout;
    const clearTimer = dependencies.clearTimeout || windowRef?.clearTimeout?.bind(windowRef) || clearTimeout;
    if (!markup) {
      return { refresh: function noop() { return Promise.resolve(null); }, dispose: function noop() {} };
    }

    const state = {
      snapshot: null,
      error: '',
      inFlight: null,
      refreshEpoch: 0,
      lastFetchAt: 0,
      refreshTimer: null,
      lastRenderSig: '',
      disposed: false,
    };

    function isVisible() {
      if (state.disposed) return false;
      if (typeof callbacks.isVisible === 'function') return callbacks.isVisible() === true;
      return true;
    }

    function isRefreshCurrent(options) {
      if (options?.signal?.aborted === true) return false;
      const guard = options?.guard;
      return !guard || typeof guard.isCurrent !== 'function' || guard.isCurrent() === true;
    }

    // Each pane: its host, what builds its markup, and the markup it last painted.
    const panes = [
      { host: dom.toolLatencyTable || null, build: (snapshot) => markup.buildToolLatencyMarkup(snapshot && snapshot.tool_observability), painted: null },
      { host: dom.slowOperationsList || null, build: (snapshot) => markup.buildSlowOperationsMarkup(snapshot && snapshot.slow_operations), painted: null },
      { host: dom.recentTracesList || null, build: (snapshot) => markup.buildTraceTimingMarkup(snapshot && snapshot.trace_timing), painted: null },
    ].filter((pane) => pane.host);

    function getDiagnosticsApi() {
      if (!windowRef) return null;
      const shell = windowRef.jennyShell;
      if (!shell || !shell.diagnostics) return null;
      const fn = shell.diagnostics.getJennyStatus;
      return typeof fn === 'function' ? fn.bind(shell.diagnostics) : null;
    }

    function valueSig(value) {
      if (value === null || value === undefined) return '';
      return String(value);
    }

    function itemListSig(items, mapper) {
      if (!Array.isArray(items) || items.length === 0) return '';
      return items.map(mapper).join('~');
    }

    function objectEntrySig(obj, mapper) {
      if (!obj || typeof obj !== 'object') return '';
      return Object.keys(obj).sort().map((key) => mapper(key, obj[key])).join('~');
    }

    function buildRenderSignature() {
      const snapshot = state.snapshot;
      const tool = snapshot && snapshot.tool_observability;
      const slow = snapshot && snapshot.slow_operations;
      const trace = snapshot && snapshot.trace_timing;
      const toolSig = objectEntrySig(tool && tool.tools, (name, stats) => {
        const latency = stats.latency_ms || {};
        const errorCodes = objectEntrySig(stats.error_codes, (code, count) => code + ':' + valueSig(count));
        const recentErrors = itemListSig(stats.recent_errors, (item) => item && item.error_code);
        return [
          name, stats.count, stats.error_count, stats.error_rate,
          latency.p50, latency.p95, latency.p99,
          errorCodes, recentErrors,
        ].map(valueSig).join(',');
      });
      const slowSig = itemListSig(slow && slow.items, (item) => [
        item && item.kind,
        item && item.id,
        item && item.metric,
        item && item.observed_ms,
        item && item.threshold_ms,
        item && item.count,
        item && item.error_count,
      ].map(valueSig).join(','));
      const traceSig = itemListSig(trace && trace.recent, (item) => {
        const provider = item && item.provider_timing ? item.provider_timing : {};
        const tools = item && item.tool_events ? item.tool_events : {};
        return [
          item && item.stream_id,
          item && item.request_id,
          item && item.trace_id,
          item && item.terminal_status,
          item && item.duration_ms,
          item && item.model,
          provider.time_to_first_visible_token_ms,
          tools.total,
        ].map(valueSig).join(',');
      });
      return [
        state.error,
        snapshot && snapshot.generated_at,
        // Availability decides what the Performance section says, so a flip alone is a new snapshot.
        [tool, slow, trace].map((facet) => valueSig(facet && facet.available)).join(','),
        tool && tool.generated_at, toolSig,
        slow && slow.generated_at, slow && slow.count, slowSig,
        trace && trace.generated_at, trace && trace.count, traceSig,
      ].join('|');
    }

    function cssEscape(value) {
      const escaper = windowRef && windowRef.CSS && typeof windowRef.CSS.escape === 'function' ? windowRef.CSS.escape : null;
      if (escaper) return escaper(String(value || ''));
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch; });
    }

    // The chat whose Result button holds keyboard focus, so a repaint can hand focus back to it.
    function focusedTrace(host) {
      const active = host.ownerDocument && host.ownerDocument.activeElement;
      if (!active || !host.contains(active) || typeof active.closest !== 'function') return '';
      const control = active.closest('[data-observability-trace]');
      return control ? control.getAttribute('data-observability-trace') || '' : '';
    }

    function traceControls(host) {
      return Array.from(host.querySelectorAll('[data-observability-trace]'));
    }

    // A repaint keeps focus on the same chat; when that chat is gone, on the one now in its place (or the last),
    // and when none remain, on the Performance heading rather than the page body.
    function paintPane(pane, snapshot) {
      const next = pane.build(snapshot);
      if (pane.painted === next) return;
      const focused = focusedTrace(pane.host);
      const focusedIndex = focused ? traceControls(pane.host).findIndex((node) => node.getAttribute('data-observability-trace') === focused) : -1;
      pane.host.innerHTML = next;
      pane.painted = next;
      if (!focused) return;
      const remaining = traceControls(pane.host);
      const control = pane.host.querySelector('[data-observability-trace="' + cssEscape(focused) + '"]')
        || remaining[Math.min(Math.max(focusedIndex, 0), remaining.length - 1)];
      const target = control || pane.host.ownerDocument.getElementById('diagnosticsPerformanceHeading');
      if (!target || typeof target.focus !== 'function') return;
      if (!control) target.tabIndex = -1;
      target.focus();
    }

    function renderAll() {
      if (state.disposed) return;
      const sig = buildRenderSignature();
      if (sig === state.lastRenderSig) return;
      state.lastRenderSig = sig;
      panes.forEach((pane) => paintPane(pane, state.snapshot));
      // The Overview decides which groups show from its own state, so it hears about every new snapshot.
      if (typeof callbacks.onSnapshot === 'function') callbacks.onSnapshot(state.snapshot);
    }

    async function refresh(options) {
      if (state.disposed || !isRefreshCurrent(options)) return null;
      const silent = options && options.silent === true;
      const force = options && options.force === true;
      const invalidateSnapshot = options && options.invalidateSnapshot === true;
      if (invalidateSnapshot) {
        state.snapshot = null;
        state.error = '';
        state.lastRenderSig = '';
        renderAll();
      }
      if (force && state.inFlight) {
        state.refreshEpoch += 1;
      }
      const fetchFn = getDiagnosticsApi();
      if (!fetchFn) {
        state.error = jt('diagnostics.unavailable', 'jennyShell.diagnostics unavailable');
        renderAll();
        return null;
      }
      if (state.inFlight) {
        const activeRequest = state.inFlight;
        if (!force) return activeRequest;
        await activeRequest;
        if (state.disposed || !isRefreshCurrent(options)) return null;
        if (state.inFlight === activeRequest) {
          state.inFlight = null;
        }
        return refresh({ ...options, force: false });
      }
      const requestEpoch = state.refreshEpoch + 1;
      state.refreshEpoch = requestEpoch;
      const request = (async () => {
        try {
          const sessionId = String(callbacks.getCurrentSessionId?.() || '').trim();
          const snapshot = await fetchFn({
            ...FETCH_OPTIONS,
            ...(sessionId ? { sessionId } : {}),
          });
          if (state.disposed || requestEpoch !== state.refreshEpoch || !isRefreshCurrent(options)) return null;
          state.snapshot = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : null;
          state.error = '';
          state.lastFetchAt = now();
          renderAll();
          return state.snapshot;
        } catch (error) {
          if (state.disposed || requestEpoch !== state.refreshEpoch || !isRefreshCurrent(options)) return null;
          state.error = (error && error.message) || String(error || jt('diagnostics.observability.statusFetchFailed', 'failed to fetch jenny_status'));
          if (!silent || invalidateSnapshot) renderAll();
          return null;
        }
      })();
      state.inFlight = request;
      try {
        return await request;
      } finally {
        if (state.inFlight === request) state.inFlight = null;
      }
    }

    // Selecting a chat opens its records in Activity.
    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const traceLink = target.closest('[data-observability-trace]');
      if (!traceLink) return;
      event.preventDefault();
      const stream = traceLink.getAttribute('data-observability-trace') || '';
      if (stream && typeof callbacks.onTraceLink === 'function') callbacks.onTraceLink(stream);
    }

    panes.forEach((pane) => pane.host.addEventListener('click', handleClick));

    function notifyTurnSettled() {
      if (!isVisible()) {
        if (state.refreshTimer) clearTimer(state.refreshTimer);
        state.refreshTimer = null;
        return;
      }
      if (state.refreshTimer) return;
      const delay = Math.max(0, TURN_SETTLED_REFRESH_MS - (now() - state.lastFetchAt));
      state.refreshTimer = setTimer(() => {
        state.refreshTimer = null;
        if (!isVisible()) return;
        refresh({ silent: true });
      }, delay);
    }

    function dispose() {
      if (state.disposed) return;
      state.disposed = true;
      if (state.refreshTimer) clearTimer(state.refreshTimer);
      state.refreshTimer = null;
      panes.forEach((pane) => pane.host.removeEventListener('click', handleClick));
    }

    return {
      refresh,
      notifyTurnSettled,
      dispose,
      getSnapshot: function getSnapshot() { return state.snapshot; },
    };
  }

  return { createObservabilityController };
});
