(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('../shared/log-contract-utils'),
      require('../shared/renderer-motion-preference-utils')
    );
    return;
  }
  root.rendererObservabilityUtils = factory(root.stringUtils, root.logContractUtils, root.rendererMotionPreferenceUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, logContractUtils, motionPreferenceUtils) {
  'use strict';

  // UIUX-030: sole smooth-scroll gate — 'auto' (instant) under prefers-reduced-motion.
  const resolveScrollBehavior = motionPreferenceUtils && typeof motionPreferenceUtils.resolveScrollBehavior === 'function'
    ? motionPreferenceUtils.resolveScrollBehavior
    : function fallbackResolveScrollBehavior() { return 'smooth'; };

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
  const escapeHtml = stringUtils.escapeHtml;
  const redactLogText = logContractUtils && typeof logContractUtils.redactLogText === 'function'
    ? logContractUtils.redactLogText
    : function fallbackRedactLogText(value) { return String(value || ''); };

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
      expandedTraces: new Set(),
      lastRenderSig: '',
      pendingTraceMissStreamId: '',
      pendingTraceMissCount: 0,
      pendingTraceMissMessage: '',
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

    const targets = {
      latency: dom.toolLatencyTable || null,
      slow: dom.slowOperationsList || null,
      traces: dom.recentTracesList || null,
    };

    function getDiagnosticsApi() {
      if (!windowRef) return null;
      const shell = windowRef.jennyShell;
      if (!shell || !shell.diagnostics) return null;
      const fn = shell.diagnostics.getJennyStatus;
      return typeof fn === 'function' ? fn.bind(shell.diagnostics) : null;
    }

    function traceExpansionKey(trace, index) {
      const streamId = String(trace && trace.stream_id || '').trim();
      if (streamId) return streamId;
      const traceId = String(trace && trace.trace_id || '').trim();
      if (traceId) return 'trace:' + traceId;
      const requestId = String(trace && trace.request_id || '').trim();
      if (requestId) return 'request:' + requestId;
      return 'row:' + index;
    }

    function buildTraceExpansionFacet(facet) {
      if (!facet || !Array.isArray(facet.recent)) return facet;
      return {
        ...facet,
        recent: facet.recent.map((trace, index) => ({
          ...trace,
          stream_id: traceExpansionKey(trace, index),
        })),
      };
    }

    function pruneExpandedTraces() {
      const snapshot = state.snapshot;
      const traces = snapshot && snapshot.trace_timing && Array.isArray(snapshot.trace_timing.recent)
        ? snapshot.trace_timing.recent
        : [];
      if (state.expandedTraces.size === 0) return;
      const liveStreams = new Set();
      for (let index = 0; index < traces.length; index += 1) {
        liveStreams.add(traceExpansionKey(traces[index], index));
      }
      for (const stream of Array.from(state.expandedTraces)) {
        if (!liveStreams.has(stream)) state.expandedTraces.delete(stream);
      }
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
      const expandedKey = Array.from(state.expandedTraces).sort().join(',');
      const toolSig = objectEntrySig(tool && tool.tools, (name, stats) => {
        const latency = stats.latency_ms || {};
        const errorCodes = objectEntrySig(stats.error_codes, (code, count) => code + ':' + valueSig(count));
        return [
          name, stats.count, stats.error_rate,
          latency.p50, latency.p95, latency.p99,
          errorCodes,
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
          item && item.mode,
          provider.time_to_first_chunk_ms,
          provider.time_to_first_visible_token_ms,
          provider.request_duration_ms,
          tools.total,
        ].map(valueSig).join(',');
      });
      return [
        state.error,
        state.pendingTraceMissMessage,
        expandedKey,
        snapshot && snapshot.generated_at,
        tool && tool.generated_at, toolSig,
        slow && slow.generated_at, slow && slow.count, slowSig,
        trace && trace.generated_at, trace && trace.count, traceSig,
      ].join('|');
    }

    function renderAll() {
      if (state.disposed) return;
      const sig = buildRenderSignature();
      if (sig === state.lastRenderSig) return;
      state.lastRenderSig = sig;
      const snapshot = state.snapshot;
      if (targets.latency) {
        targets.latency.innerHTML = markup.buildToolLatencyMarkup(snapshot && snapshot.tool_observability);
      }
      if (targets.slow) {
        targets.slow.innerHTML = markup.buildSlowOperationsMarkup(snapshot && snapshot.slow_operations);
      }
      if (targets.traces) {
        const traceFacet = snapshot && snapshot.trace_timing;
        targets.traces.innerHTML = markup.buildTraceTimingMarkup(
          buildTraceExpansionFacet(traceFacet),
          state.expandedTraces
        );
        const traces = traceFacet && Array.isArray(traceFacet.recent) ? traceFacet.recent.slice().reverse() : [];
        Array.from(targets.traces.querySelectorAll('[data-trace-stream]')).forEach((row, index) => {
          row.setAttribute('data-trace-stream', String(traces[index] && traces[index].stream_id || ''));
        });
        if (state.pendingTraceMissMessage) {
          targets.traces.insertAdjacentHTML(
            'afterbegin',
            '<div class="observability-error" role="status">' + escapeHtml(state.pendingTraceMissMessage) + '</div>'
          );
        }
      }
      if (state.error) {
        const errorBanner = '<div class="observability-error" role="alert">' + escapeHtml(state.error) + '</div>';
        if (targets.latency) targets.latency.insertAdjacentHTML('afterbegin', errorBanner);
      }
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
        state.error = 'jennyShell.diagnostics unavailable';
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
          pruneExpandedTraces();
          renderAll();
          focusPendingTraceIfRequested();
          return state.snapshot;
        } catch (error) {
          if (state.disposed || requestEpoch !== state.refreshEpoch || !isRefreshCurrent(options)) return null;
          state.error = (error && error.message) || String(error || 'failed to fetch jenny_status');
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

    function formatTraceIdForNotice(streamId) {
      const label = redactLogText(String(streamId || '').trim());
      if (label.length <= 80) {
        return label;
      }
      return label.slice(0, 77) + '...';
    }

    function resetPendingTraceMiss(streamId) {
      state.pendingTraceMissStreamId = streamId || '';
      state.pendingTraceMissCount = 0;
      state.pendingTraceMissMessage = '';
    }

    function focusPendingTraceIfRequested() {
      let streamId = '';
      if (typeof callbacks.peekPendingTraceFocus === 'function') {
        streamId = callbacks.peekPendingTraceFocus();
      } else if (typeof callbacks.consumePendingTraceFocus === 'function') {
        streamId = callbacks.consumePendingTraceFocus();
      }
      streamId = String(streamId || '').trim();
      if (!streamId || !targets.traces) return;
      if (state.pendingTraceMissStreamId !== streamId) {
        resetPendingTraceMiss(streamId);
      }
      const traces = state.snapshot && state.snapshot.trace_timing && Array.isArray(state.snapshot.trace_timing.recent)
        ? state.snapshot.trace_timing.recent
        : [];
      const traceIndex = traces.findIndex((trace) => String(trace && trace.stream_id || '') === String(streamId));
      if (traceIndex < 0) {
        state.pendingTraceMissCount += 1;
        if (state.pendingTraceMissCount >= 3) {
          state.pendingTraceMissMessage = `Trace ${formatTraceIdForNotice(streamId)} has not appeared in recent Runtime Health rows yet.`;
          if (typeof callbacks.clearPendingTraceFocus === 'function') {
            callbacks.clearPendingTraceFocus(streamId);
          }
          renderAll();
        }
        return;
      }
      resetPendingTraceMiss('');
      state.expandedTraces.add(traceExpansionKey(traces[traceIndex], traceIndex));
      renderAll();
      if (typeof callbacks.clearPendingTraceFocus === 'function') {
        callbacks.clearPendingTraceFocus(streamId);
      }
      const win = windowRef;
      if (!win) return;
      win.requestAnimationFrame(() => {
        if (state.disposed) return;
        const row = targets.traces.querySelector('[data-trace-stream="' + cssEscape(streamId) + '"]');
        if (row && typeof row.scrollIntoView === 'function') {
          row.scrollIntoView({ behavior: resolveScrollBehavior(null, win), block: 'center' });
        }
      });
    }

    function cssEscape(value) {
      const win = typeof window !== 'undefined' ? window : null;
      const escaper = win && win.CSS && typeof win.CSS.escape === 'function' ? win.CSS.escape : null;
      if (escaper) return escaper(String(value || ''));
      return String(value || '').replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch; });
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      const traceToggle = target.closest('[data-observability-trace-toggle]');
      if (traceToggle) {
        event.preventDefault();
        const stream = traceToggle.getAttribute('data-observability-trace-toggle') || '';
        if (state.expandedTraces.has(stream)) {
          state.expandedTraces.delete(stream);
        } else {
          state.expandedTraces.add(stream);
        }
        renderAll();
        return;
      }

      const traceLink = target.closest('[data-observability-trace]');
      if (traceLink) {
        event.preventDefault();
        const stream = traceLink.getAttribute('data-observability-trace') || '';
        if (typeof callbacks.onTraceLink === 'function') {
          callbacks.onTraceLink(stream);
        } else {
          state.expandedTraces.add(stream);
          renderAll();
          if (targets.traces) {
            const row = targets.traces.querySelector('[data-trace-stream="' + cssEscape(stream) + '"]');
            if (row && typeof row.scrollIntoView === 'function') {
              row.scrollIntoView({ behavior: resolveScrollBehavior(null, windowRef), block: 'center' });
            }
          }
        }
        return;
      }

      const sessionLink = target.closest('[data-observability-session]');
      if (sessionLink) {
        event.preventDefault();
        const session = sessionLink.getAttribute('data-observability-session') || '';
        if (typeof callbacks.onSessionLink === 'function') {
          callbacks.onSessionLink(session);
        }
      }
    }

    const scopes = [targets.latency, targets.slow, targets.traces].filter(Boolean);
    scopes.forEach((scope) => {
      scope.addEventListener('click', handleClick);
    });

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
      scopes.forEach((scope) => scope.removeEventListener('click', handleClick));
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
