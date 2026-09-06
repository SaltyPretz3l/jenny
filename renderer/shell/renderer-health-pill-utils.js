(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererHealthPillUtils = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  const POPOVER_OPEN_REFRESH_MS = 4000;
  const DEFAULT_REFRESH_OPTIONS = Object.freeze({ recentLogLimit: 25 });

  const normString = stringUtils.normalizeString;

  function resolveLifecycleTone(state) {
    switch (normString(state).toLowerCase()) {
      case 'ready': return { tone: 'success', label: 'Ready' };
      case 'sidecar_spawned': return { tone: 'pending', label: 'Starting engine' };
      case 'model_acquiring':
      case 'acquiring': return { tone: 'pending', label: 'Downloading model' };
      case 'model_loading':
      case 'loading': return { tone: 'pending', label: 'Loading model' };
      case 'model_unavailable':
      case 'unavailable': return { tone: 'danger', label: 'Model failed' };
      case 'starting': return { tone: 'pending', label: 'Starting' };
      case 'retrying': return { tone: 'pending', label: 'Retrying' };
      case 'stopping': return { tone: 'warning', label: 'Stopping' };
      case 'error': return { tone: 'danger', label: 'Error' };
      case 'stopped': return { tone: 'muted', label: 'Offline' };
      default: return { tone: 'muted', label: 'Unknown' };
    }
  }

  function combineHealthSignal(snapshot, deps) {
    const lifecycle = snapshot && snapshot.runtime && snapshot.runtime.lifecycle
      ? snapshot.runtime.lifecycle
      : null;
    const modelState = normString(lifecycle && lifecycle.model_state).toLowerCase();
    const lifecycleTone = resolveLifecycleTone(
      modelState && modelState !== 'unloaded' ? modelState : lifecycle && lifecycle.state
    );

    let derivedTone = null;
    let derivedSummary = '';
    if (deps.deriveRuntimeHealthState && lifecycle) {
      try {
        const derived = deps.deriveRuntimeHealthState(snapshot || {});
        if (derived && typeof derived === 'object') {
          derivedTone = normString(derived.tone) || null;
          derivedSummary = normString(derived.summary);
        }
      } catch (_error) {
        derivedTone = null;
      }
    }

    let tone = lifecycleTone.tone;
    let label = lifecycleTone.label;
    let summary = '';
    if (derivedTone === 'danger') {
      tone = 'danger';
      label = 'Blocked';
      summary = derivedSummary;
    } else if (derivedTone === 'warning' && tone !== 'danger') {
      tone = 'warning';
      label = 'Degraded';
      summary = derivedSummary;
    }

    const acquisition = lifecycle && lifecycle.model_acquisition;
    const acquisitionPercent = Number(acquisition && acquisition.percent);
    if (
      label === 'Downloading model'
      && acquisition
      && normString(acquisition.stage) === 'acquiring'
      && Number.isFinite(acquisitionPercent)
      && acquisitionPercent > 0
    ) {
      label += ' · ' + Math.round(Math.max(0, Math.min(100, acquisitionPercent))) + '%';
    }

    return { tone, label, summary, lifecycle };
  }

  function resolveMarkupHelpers(deps) {
    if (deps.markupHelpers && typeof deps.markupHelpers === 'object') {
      return deps.markupHelpers;
    }
    if (typeof globalThis !== 'undefined' && globalThis.rendererHealthPillMarkupUtils) {
      return globalThis.rendererHealthPillMarkupUtils;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-health-pill-markup-utils'); } catch (_error) { /* not available */ }
    }
    return null;
  }

  function createHealthPillController(deps) {
    const dependencies = deps || {};
    const windowRef = dependencies.window || (typeof window !== 'undefined' ? window : null);
    const documentRef = dependencies.document
      || (windowRef && windowRef.document)
      || (typeof document !== 'undefined' ? document : null);
    const slot = dependencies.slot || (documentRef && documentRef.getElementById('workbenchHealthPillSlot'));
    const deriveRuntimeHealthState = dependencies.deriveRuntimeHealthState
      || (windowRef && windowRef.rendererRuntimeHealthUtils
        ? windowRef.rendererRuntimeHealthUtils.deriveRuntimeHealthState
        : null);
    const markup = resolveMarkupHelpers(dependencies);
    const buildPillMarkup = markup && typeof markup.buildPillMarkup === 'function'
      ? markup.buildPillMarkup
      : function fallbackPillMarkup() { return ''; };
    const buildPopoverMarkup = markup && typeof markup.buildPopoverMarkup === 'function'
      ? markup.buildPopoverMarkup
      : function fallbackPopoverMarkup() { return ''; };
    const positionPopover = markup && typeof markup.positionPopover === 'function'
      ? markup.positionPopover
      : function noopPositionPopover() {};
    const ID_PILL_BUTTON = (markup && markup.ID_PILL_BUTTON) || 'workbenchHealthPillButton';
    /* EH-W10: flag-gated intake route (error-center only — the pill's own
     * tone/summary stays the visible surface). Null when routing is off. */
    const reportError = typeof dependencies.reportError === 'function'
      ? dependencies.reportError
      : null;
    /* EH-W11: optional error-center store. Absent store -> the pill
     * renders exactly as before (no badge, no Recent errors section). */
    const errorCenterStore = dependencies.errorCenterStore
      && typeof dependencies.errorCenterStore.list === 'function'
      ? dependencies.errorCenterStore
      : null;
    let unsubscribeErrorCenter = null;
    /* Retry is latched once, in the shell status controller: the failure toast
     * and this popover both call the same function, so clicking both fires one
     * retryStart() instead of two. Absent injection, fall back to calling the
     * bridge directly so the popover still works standalone (tests, harness). */
    const retryBackendStart = typeof dependencies.retryBackendStart === 'function'
      ? dependencies.retryBackendStart
      : null;
    let localRetryInFlight = false;
    let localRestartInFlight = false;

    const state = {
      snapshot: null,
      toneLabel: { tone: 'muted', label: 'Unknown', summary: '' },
      error: '',
      open: false,
      pollTimer: null,
      disposed: false,
      inFlight: false,
      lastFetchAt: 0,
      lastPillSig: '',
      lastPopoverSig: '',
      consecutiveFailures: 0,
    };

    let popoverNode = null;
    let pillButton = null;

    function getUnseenErrorCount() {
      return errorCenterStore ? errorCenterStore.getUnseenCount() : 0;
    }

    function getRecentErrors() {
      return errorCenterStore ? errorCenterStore.list().slice(0, 5) : [];
    }

    function buildPillSignature() {
      return state.toneLabel.tone + '|' + state.toneLabel.label + '|' + getUnseenErrorCount();
    }

    function buildPopoverSignature() {
      const lifecycle = state.snapshot && state.snapshot.runtime && state.snapshot.runtime.lifecycle;
      const runtime = state.snapshot && state.snapshot.runtime;
      const logs = state.snapshot && state.snapshot.logs;
      const slow = state.snapshot && state.snapshot.slow_operations;
      return [
        state.error,
        state.toneLabel.tone, state.toneLabel.label, state.toneLabel.summary,
        lifecycle && lifecycle.state, lifecycle && lifecycle.phase, lifecycle && lifecycle.detail,
        lifecycle && lifecycle.pid, lifecycle && lifecycle.startup_ms,
        lifecycle && lifecycle.model_state,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.requested_model,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.stage,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.percent,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.completed_bytes,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.total_bytes,
        runtime && runtime.engine, runtime && runtime.model, runtime && runtime.model_loaded,
        logs && logs.available && Array.isArray(logs.recent_issues) ? logs.recent_issues.length : 0,
        slow && slow.available && Array.isArray(slow.items) ? slow.items.length : 0,
        getRecentErrors().map(function entrySig(entry) {
          return entry.key + ':' + entry.code + ':' + entry.at + ':' + entry.seen;
        }).join(','),
      ].join('|');
    }

    function getDiagnosticsApi() {
      if (!windowRef) return null;
      const shell = windowRef.jennyShell;
      if (!shell || !shell.diagnostics) return null;
      const fn = shell.diagnostics.getJennyStatus;
      return typeof fn === 'function' ? fn.bind(shell.diagnostics) : null;
    }

    function renderPill() {
      if (!slot) return;
      const sig = buildPillSignature();
      if (sig === state.lastPillSig && pillButton) {
        pillButton.setAttribute('aria-expanded', state.open ? 'true' : 'false');
        return;
      }
      state.lastPillSig = sig;
      slot.innerHTML = buildPillMarkup(state.toneLabel, { unseenErrorCount: getUnseenErrorCount() });
      pillButton = slot.querySelector('#' + ID_PILL_BUTTON);
      if (pillButton) {
        pillButton.addEventListener('click', handlePillClick);
        pillButton.setAttribute('aria-expanded', state.open ? 'true' : 'false');
      }
    }

    function ensurePopoverNode() {
      if (popoverNode || !documentRef) return popoverNode;
      const host = documentRef.body;
      if (!host) return null;
      const wrapper = documentRef.createElement('div');
      wrapper.innerHTML = buildPopoverMarkup(state, state.snapshot, { recentErrors: getRecentErrors() });
      popoverNode = wrapper.firstElementChild;
      if (popoverNode) {
        host.appendChild(popoverNode);
        popoverNode.addEventListener('click', handlePopoverClick);
      }
      return popoverNode;
    }

    function refreshPopoverContent() {
      if (!popoverNode || !documentRef) return;
      const sig = buildPopoverSignature();
      if (sig === state.lastPopoverSig) {
        if (state.open) positionPopover(pillButton, popoverNode);
        return;
      }
      state.lastPopoverSig = sig;
      const next = buildPopoverMarkup(state, state.snapshot, { recentErrors: getRecentErrors() });
      const wrapper = documentRef.createElement('div');
      wrapper.innerHTML = next;
      const fresh = wrapper.firstElementChild;
      if (!fresh) return;
      const restorePopoverFocus = state.open && popoverNode.contains(documentRef.activeElement);
      popoverNode.replaceWith(fresh);
      popoverNode = fresh;
      popoverNode.addEventListener('click', handlePopoverClick);
      if (state.open) {
        popoverNode.setAttribute('data-open', 'true');
        positionPopover(pillButton, popoverNode);
        if (restorePopoverFocus) popoverNode.focus();
      }
    }

    function handlePillClick(event) {
      event.preventDefault();
      event.stopPropagation();
      if (state.open) {
        closePopover();
      } else {
        openPopover();
      }
    }

    function handlePopoverClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      const actionButton = target.closest('[data-health-pill-action]');
      if (!actionButton) return;
      const action = actionButton.getAttribute('data-health-pill-action');
      if (action === 'clear-errors') {
        /* EH-W11: clear the error center and keep the popover open —
         * the section omits itself on the re-render. */
        if (errorCenterStore) errorCenterStore.clear();
        return;
      }
      if (action === 'open-runtime-health') {
        invokeNavigation('settings', 'diagnostics');
      } else if (action === 'open-models') {
        invokeNavigation('settings', 'models');
      } else if (action === 'retry-model') {
        if (retryBackendStart) {
          retryBackendStart();
        } else {
          const retryStart = windowRef?.jennyShell?.backend?.retryStart;
          if (!localRetryInFlight && typeof retryStart === 'function') {
            localRetryInFlight = true;
            Promise.resolve(retryStart.call(windowRef.jennyShell.backend))
              .catch(function ignoreRetryFailure() {})
              .finally(function finishRetry() { localRetryInFlight = false; });
          }
        }
      } else if (action === 'restart-llama-server') {
        /* Crash policy: the managed llama-server is never respawned on its
         * own; this row and the next chat are the two recovery paths. */
        const restart = windowRef?.jennyShell?.llamaServer?.restart;
        if (!localRestartInFlight && typeof restart === 'function') {
          localRestartInFlight = true;
          Promise.resolve(restart.call(windowRef.jennyShell.llamaServer))
            .catch(function ignoreRestartFailure() {})
            .finally(function finishRestart() {
              localRestartInFlight = false;
              if (!state.disposed) refresh({ silent: true });
            });
        }
      } else if (action === 'open-logs') {
        invokeNavigation('logs', null);
      }
      closePopover();
    }

    function invokeNavigation(view, settingsSection) {
      const setActiveView = typeof dependencies.setActiveView === 'function'
        ? dependencies.setActiveView
        : null;
      const setActiveSettingsSection = typeof dependencies.setActiveSettingsSection === 'function'
        ? dependencies.setActiveSettingsSection
        : null;
      if (settingsSection && setActiveSettingsSection) {
        try { setActiveSettingsSection(settingsSection); } catch (_error) { /* noop */ }
      }
      if (setActiveView) {
        try { setActiveView(view); } catch (_error) { /* noop */ }
      }
    }

    function handleDocumentClickAway(event) {
      if (!state.open) return;
      const target = event.target;
      if (!target) return;
      if (popoverNode && popoverNode.contains(target)) return;
      if (pillButton && pillButton.contains(target)) return;
      closePopover();
    }

    function handleEscape(event) {
      if (state.open && (event.key === 'Escape' || event.keyCode === 27)) {
        closePopover();
        if (pillButton && typeof pillButton.focus === 'function') {
          pillButton.focus();
        }
      }
    }

    function handleViewportChange() {
      if (!state.open) return;
      positionPopover(pillButton, popoverNode);
    }

    function openPopover() {
      ensurePopoverNode();
      if (!popoverNode) return;
      state.open = true;
      if (pillButton) pillButton.setAttribute('aria-expanded', 'true');
      popoverNode.setAttribute('data-open', 'true');
      positionPopover(pillButton, popoverNode);
      popoverNode.focus();
      schedulePoll();
      if (documentRef) {
        documentRef.addEventListener('click', handleDocumentClickAway, true);
        documentRef.addEventListener('keydown', handleEscape);
      }
      if (windowRef) {
        windowRef.addEventListener('resize', handleViewportChange);
        windowRef.addEventListener('scroll', handleViewportChange, true);
      }
      /* EH-W11: opening the popover acknowledges the error badge. */
      if (errorCenterStore) errorCenterStore.markSeen();
      refresh({ silent: false });
    }

    function closePopover() {
      state.open = false;
      if (pillButton) pillButton.setAttribute('aria-expanded', 'false');
      if (popoverNode) popoverNode.setAttribute('data-open', 'false');
      cancelPoll();
      if (documentRef) {
        documentRef.removeEventListener('click', handleDocumentClickAway, true);
        documentRef.removeEventListener('keydown', handleEscape);
      }
      if (windowRef) {
        windowRef.removeEventListener('resize', handleViewportChange);
        windowRef.removeEventListener('scroll', handleViewportChange, true);
      }
    }

    function schedulePoll() {
      cancelPoll();
      if (!state.open || state.disposed || !windowRef) return;
      state.pollTimer = windowRef.setTimeout(function pollTick() {
        state.pollTimer = null;
        if (!state.open || state.disposed) return;
        refresh({ silent: true }).then(schedulePoll, schedulePoll);
      }, POPOVER_OPEN_REFRESH_MS);
    }

    function cancelPoll() {
      if (state.pollTimer && windowRef) {
        windowRef.clearTimeout(state.pollTimer);
      }
      state.pollTimer = null;
    }

    async function refresh(options) {
      if (state.disposed) return null;
      const silent = options && options.silent === true;
      const fetchFn = getDiagnosticsApi();
      if (!fetchFn) {
        /* A missing bridge is a failure episode like a throwing fetch: it
         * counts toward degradation and reports once, so a torn-down preload
         * cannot leave a stale green dot or swallow the next real error. */
        state.consecutiveFailures += 1;
        const hadBridgeError = Boolean(state.error);
        state.error = 'jennyShell.diagnostics unavailable';
        if (!hadBridgeError && reportError) {
          reportError({ message: state.error, dedupeKey: 'health-poll:status' }, { origin: 'health-poll' });
        }
        if (state.consecutiveFailures >= 2) {
          state.toneLabel = { tone: 'muted', label: 'Unknown', summary: state.error };
        }
        renderPill();
        if (state.open) refreshPopoverContent();
        return null;
      }
      if (state.inFlight) return state.snapshot;
      state.inFlight = true;
      try {
        const snapshot = await fetchFn(DEFAULT_REFRESH_OPTIONS);
        if (state.disposed) return null;
        state.snapshot = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
          ? snapshot
          : null;
        state.toneLabel = combineHealthSignal(state.snapshot, { deriveRuntimeHealthState });
        state.consecutiveFailures = 0;
        state.error = '';
        state.lastFetchAt = Date.now();
        renderPill();
        if (state.open) refreshPopoverContent();
        return state.snapshot;
      } catch (error) {
        if (state.disposed) return null;
        state.consecutiveFailures += 1;
        const hadError = Boolean(state.error);
        state.error = (error && error.message) || String(error || 'status request failed');
        /* Report once per failure episode (resets when a refresh succeeds)
         * so the open-popover poll cannot stack error-center records. */
        if (!hadError && reportError) {
          reportError({ message: state.error, dedupeKey: 'health-poll:status' }, { origin: 'health-poll' });
        }
        if (state.consecutiveFailures >= 2) {
          state.toneLabel = { tone: 'muted', label: 'Unknown', summary: state.error };
          renderPill();
        } else if (!silent) {
          state.toneLabel = { tone: 'danger', label: 'Error', summary: state.error };
          renderPill();
        }
        if (state.open) refreshPopoverContent();
        return null;
      } finally {
        state.inFlight = false;
      }
    }

    function dispose() {
      if (state.disposed) return;
      closePopover();
      state.disposed = true;
      if (unsubscribeErrorCenter) {
        unsubscribeErrorCenter();
        unsubscribeErrorCenter = null;
      }
      if (popoverNode) {
        popoverNode.removeEventListener('click', handlePopoverClick);
        if (popoverNode.parentNode) {
          popoverNode.parentNode.removeChild(popoverNode);
        }
        popoverNode = null;
      }
      if (pillButton) {
        pillButton.removeEventListener('click', handlePillClick);
        pillButton = null;
      }
      if (slot) slot.innerHTML = '';
    }

    if (errorCenterStore && typeof errorCenterStore.subscribe === 'function') {
      unsubscribeErrorCenter = errorCenterStore.subscribe(function onErrorCenterChange() {
        if (state.disposed) return;
        renderPill();
        if (state.open) refreshPopoverContent();
      });
    }

    renderPill();

    return {
      refresh,
      dispose,
      isPopoverOpen: function isPopoverOpen() { return state.open === true; },
      getState: function getState() {
        return {
          tone: state.toneLabel.tone,
          label: state.toneLabel.label,
          summary: state.toneLabel.summary,
          error: state.error,
        };
      },
    };
  }

  return {
    createHealthPillController,
    resolveLifecycleTone,
    combineHealthSignal,
  };
});
