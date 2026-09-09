(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/string-utils'));
    return;
  }
  root.rendererHealthPillUtils = factory(root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const POPOVER_OPEN_REFRESH_MS = 4000;
  const DEFAULT_REFRESH_OPTIONS = Object.freeze({ recentLogLimit: 25 });

  const normString = stringUtils.normalizeString;

  function resolveLifecycleTone(state) {
    switch (normString(state).toLowerCase()) {
      case 'ready': return { tone: 'success', label: jt('healthPill.ready', 'Ready') };
      case 'sidecar_spawned': return { tone: 'pending', label: jt('healthPill.startingEngine', 'Starting engine') };
      case 'model_acquiring':
      case 'acquiring': return { tone: 'pending', label: jt('healthPill.downloadingModel', 'Downloading model') };
      case 'model_loading':
      case 'loading': return { tone: 'pending', label: jt('healthPill.loadingModel', 'Loading model') };
      case 'model_unavailable':
      case 'unavailable': return { tone: 'danger', label: jt('healthPill.modelFailed', 'Model failed') };
      case 'starting': return { tone: 'pending', label: jt('healthPill.starting', 'Starting') };
      case 'retrying': return { tone: 'pending', label: jt('healthPill.retrying', 'Retrying') };
      case 'stopping': return { tone: 'warning', label: jt('healthPill.stopping', 'Stopping') };
      case 'error': return { tone: 'danger', label: jt('healthPill.error', 'Error') };
      case 'stopped': return { tone: 'muted', label: jt('healthPill.offline', 'Offline') };
      default: return { tone: 'muted', label: jt('healthPill.unknown', 'Unknown') };
    }
  }

  function combineHealthSignal(snapshot, deps) {
    const lifecycle = snapshot && snapshot.runtime && snapshot.runtime.lifecycle
      ? snapshot.runtime.lifecycle
      : null;
    const modelState = normString(lifecycle && lifecycle.model_state).toLowerCase();
    const lifecycleState = modelState && modelState !== 'unloaded' ? modelState : normString(lifecycle && lifecycle.state).toLowerCase();
    const lifecycleTone = resolveLifecycleTone(lifecycleState);

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
      (lifecycleState === 'model_acquiring' || lifecycleState === 'acquiring')
      && acquisition
      && normString(acquisition.stage) === 'acquiring'
      && Number.isFinite(acquisitionPercent)
      && acquisitionPercent > 0
    ) {
      label += ' · ' + Math.round(Math.max(0, Math.min(100, acquisitionPercent))) + '%';
    }

    const remote = deps.remoteStatus;
    const connected = Array.isArray(remote?.devices) ? remote.devices.filter((device) => device?.connected === true).length : 0;
    const segments = remote?.reachable === true
      ? [{ tone: 'neutral', label: jtn('healthPill.remoteDevices', connected, { count: connected }, 'Remote · {count} device', 'Remote · {count} devices') }] : [];
    return { tone, label, summary, lifecycle, segments };
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

  /* Linux packaging decision 2 (NEXT_STEPS.md): the AppImage runtime adds
   * --no-sandbox where unprivileged user namespaces are restricted, and the
   * main process records that in jenny_status.runtime.chromium_sandbox. The
   * renderer paints model output, so the first snapshot that reports the OS
   * sandbox off raises one sticky warning per profile; "Do not show again"
   * persists in storage. No toast or storage dependency -> no notice. */
  const SANDBOX_NOTICE_DISMISSED_KEY = 'jenny.chromiumSandboxNotice.dismissed';

  // localStorage on an opaque origin throws on access (JSDOM about:blank), so
  // tests inject a storage and production falls back to the window's, guarded.
  function resolveNoticeStorage(injected, windowRef) {
    if (injected && typeof injected.getItem === 'function' && typeof injected.setItem === 'function') {
      return injected;
    }
    try {
      const storage = windowRef ? windowRef.localStorage : null;
      return storage && typeof storage.getItem === 'function' ? storage : null;
    } catch (_error) {
      return null;
    }
  }

  function readSandboxFacet(snapshot) {
    const facet = snapshot && snapshot.runtime ? snapshot.runtime.chromium_sandbox : null;
    return facet && typeof facet === 'object' && !Array.isArray(facet) ? facet : null;
  }

  function sandboxNoticeMessage(facet) {
    if (facet.package_kind === 'appimage') {
      return jt('titlebar.sandboxNotice.appImage', 'Jenny is running without the Chromium OS sandbox: this system restricts unprivileged user namespaces, so the AppImage launcher disabled it. Install the .deb package for full sandboxing.');
    }
    return jt('titlebar.sandboxNotice.noSandboxFlag', 'Jenny is running without the Chromium OS sandbox because it was launched with --no-sandbox. Remove that flag to restore it.');
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
    const showToastMessage = typeof dependencies.showToastMessage === 'function'
      ? dependencies.showToastMessage
      : function noopShowToastMessage() {};
    /* EH-W11: optional error-center store. Absent store -> the pill
     * renders exactly as before (no badge, no Recent errors section). */
    const errorCenterStore = dependencies.errorCenterStore
      && typeof dependencies.errorCenterStore.list === 'function'
      ? dependencies.errorCenterStore
      : null;
    const noticeStorage = resolveNoticeStorage(dependencies.storage, windowRef);
    let unsubscribeErrorCenter = null;
    let unsubscribeRemote = null;
    let unsubscribeUnattendedPause = null;
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
      toneLabel: { tone: 'muted', label: jt('healthPill.unknown', 'Unknown'), summary: '' },
      error: '',
      open: false,
      pollTimer: null,
      disposed: false,
      inFlight: false,
      queuedRefresh: null,
      recoveryPolls: 0,
      lastFetchAt: 0,
      lastPillSig: '',
      lastPopoverSig: '',
      consecutiveFailures: 0,
      remoteStatus: null,
      runModeFacet: { runMode: 'ask', pauseState: 'none' },
      unattendedPause: null,
      sandboxNoticeShown: false,
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
      return state.toneLabel.tone + '|' + state.toneLabel.label + '|'
        + (state.toneLabel.segments?.[0]?.label || '') + '|' + getUnseenErrorCount()
        + '|' + state.runModeFacet.runMode + '|' + state.runModeFacet.pauseState;
    }

    function buildPopoverSignature() {
      const lifecycle = state.snapshot && state.snapshot.runtime && state.snapshot.runtime.lifecycle;
      const runtime = state.snapshot && state.snapshot.runtime;
      const logs = state.snapshot && state.snapshot.logs;
      const slow = state.snapshot && state.snapshot.slow_operations;
      const server = runtime && runtime.llama_server;
      return [
        state.error,
        state.toneLabel.tone, state.toneLabel.label, state.toneLabel.summary,
        state.runModeFacet.runMode, state.runModeFacet.pauseState,
        lifecycle && lifecycle.state, lifecycle && lifecycle.phase, lifecycle && lifecycle.detail,
        lifecycle && lifecycle.pid, lifecycle && lifecycle.startup_ms,
        lifecycle && lifecycle.model_state,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.requested_model,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.stage,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.percent,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.completed_bytes,
        lifecycle && lifecycle.model_acquisition && lifecycle.model_acquisition.total_bytes,
        runtime && runtime.engine, runtime && runtime.model, runtime && runtime.model_loaded,
        server && server.state, server && server.alias, server && server.port,
        server && server.acceleration_mode, server && server.last_error,
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
      const restorePillFocus = pillButton && documentRef && documentRef.activeElement === pillButton;
      state.lastPillSig = sig;
      slot.innerHTML = buildPillMarkup(state.toneLabel, {
        unseenErrorCount: getUnseenErrorCount(),
        runMode: state.runModeFacet.runMode,
        pauseState: state.runModeFacet.pauseState,
      });
      pillButton = slot.querySelector('#' + ID_PILL_BUTTON);
      if (pillButton) {
        const segment = state.toneLabel.segments?.[0];
        if (segment && documentRef) {
          const node = documentRef.createElement('span');
          node.className = 'workbench-health-pill-label'; node.dataset.healthTone = segment.tone;
          node.textContent = segment.label; pillButton.appendChild(node);
        }
        pillButton.addEventListener('click', handlePillClick);
        pillButton.setAttribute('aria-expanded', state.open ? 'true' : 'false');
        if (restorePillFocus) pillButton.focus();
      }
    }

    function ensurePopoverNode() {
      if (popoverNode || !documentRef) return popoverNode;
      const host = documentRef.body;
      if (!host) return null;
      const wrapper = documentRef.createElement('div');
      wrapper.innerHTML = buildPopoverMarkup(state, state.snapshot, {
        recentErrors: getRecentErrors(),
        runMode: state.runModeFacet.runMode,
        pauseState: state.runModeFacet.pauseState,
      });
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
      const next = buildPopoverMarkup(state, state.snapshot, {
        recentErrors: getRecentErrors(),
        runMode: state.runModeFacet.runMode,
        pauseState: state.runModeFacet.pauseState,
      });
      const wrapper = documentRef.createElement('div');
      wrapper.innerHTML = next;
      const fresh = wrapper.firstElementChild;
      if (!fresh) return;
      const restorePopoverFocus = state.open && popoverNode.contains(documentRef.activeElement);
      const focusedAction = restorePopoverFocus
        && documentRef.activeElement.getAttribute('data-health-pill-action');
      popoverNode.replaceWith(fresh);
      popoverNode = fresh;
      popoverNode.addEventListener('click', handlePopoverClick);
      if (state.open) {
        popoverNode.setAttribute('data-open', 'true');
        positionPopover(pillButton, popoverNode);
        if (restorePopoverFocus) {
          const nextFocus = focusedAction && Array.from(popoverNode.querySelectorAll('[data-health-pill-action]'))
            .find((node) => node.getAttribute('data-health-pill-action') === focusedAction);
          (nextFocus || popoverNode).focus();
        }
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
      schedulePoll();
      if (documentRef) {
        documentRef.removeEventListener('click', handleDocumentClickAway, true);
        documentRef.removeEventListener('keydown', handleEscape);
      }
      if (windowRef) {
        windowRef.removeEventListener('resize', handleViewportChange);
        windowRef.removeEventListener('scroll', handleViewportChange, true);
      }
    }

    function needsReconciliation() {
      const lifecycle = state.snapshot && state.snapshot.runtime && state.snapshot.runtime.lifecycle;
      const modelState = normString(lifecycle && lifecycle.model_state).toLowerCase();
      const lifecycleState = modelState && modelState !== 'unloaded' ? modelState : normString(lifecycle && lifecycle.state).toLowerCase();
      const signal = resolveLifecycleTone(lifecycleState);
      return Boolean(state.error) || signal.tone === 'pending' || lifecycleState === 'stopping'
        || (signal.tone === 'muted' && lifecycleState !== 'stopped');
    }

    function schedulePoll() {
      cancelPoll();
      if (state.disposed || state.inFlight || !windowRef || documentRef?.visibilityState === 'hidden') return;
      if (!state.open && !needsReconciliation()) {
        state.recoveryPolls = 0;
        return;
      }
      // Closed-pill recovery backs off to 30s; stable closed pills do not poll.
      const delay = state.open ? POPOVER_OPEN_REFRESH_MS
        : Math.min(30000, POPOVER_OPEN_REFRESH_MS * (2 ** state.recoveryPolls));
      state.pollTimer = windowRef.setTimeout(function pollTick() {
        state.pollTimer = null;
        if (state.disposed || documentRef?.visibilityState === 'hidden') return;
        if (!state.open) state.recoveryPolls = Math.min(3, state.recoveryPolls + 1);
        refresh({ silent: true });
      }, delay);
    }

    function handleVisibilityChange() {
      if (state.disposed) return;
      cancelPoll();
      if (documentRef?.visibilityState === 'hidden') return;
      state.recoveryPolls = 0;
      refresh({ silent: true });
    }

    function cancelPoll() {
      if (state.pollTimer && windowRef) {
        windowRef.clearTimeout(state.pollTimer);
      }
      state.pollTimer = null;
    }

    function announceSandboxNoticeOnce(snapshot) {
      if (state.sandboxNoticeShown || !showToastMessage) return;
      const facet = readSandboxFacet(snapshot);
      if (!facet || facet.packaged !== true || facet.sandboxed !== false) return;
      let dismissed;
      try {
        dismissed = Boolean(noticeStorage && noticeStorage.getItem(SANDBOX_NOTICE_DISMISSED_KEY) === '1');
      } catch (_error) {
        dismissed = false;
      }
      if (dismissed) return;
      state.sandboxNoticeShown = true;
      showToastMessage(sandboxNoticeMessage(facet), {
        title: jt('titlebar.sandboxNotice.title', 'Chromium sandbox is off'),
        tone: 'warning',
        sticky: true,
        dedupeKey: 'chromium-sandbox-notice',
        actions: [{
          id: 'chromium_sandbox_notice_dismiss',
          label: jt('titlebar.sandboxNotice.dismiss', 'Do not show again'),
          onClick: () => {
            try {
              if (noticeStorage) noticeStorage.setItem(SANDBOX_NOTICE_DISMISSED_KEY, '1');
            } catch (_error) {
              /* storage unavailable: the notice simply returns next launch */
            }
          },
        }],
      });
    }

    async function refresh(options) {
      if (state.disposed) return null;
      const silent = options && options.silent === true;
      if (state.inFlight) {
        // Preserve one trailing refresh; an explicit request wins over silent ones.
        state.queuedRefresh = { silent: silent && (!state.queuedRefresh || state.queuedRefresh.silent) };
        return state.snapshot;
      }
      cancelPoll();
      const fetchFn = getDiagnosticsApi();
      if (!fetchFn) {
        /* A missing bridge is a failure episode like a throwing fetch: it
         * counts toward degradation and reports once, so a torn-down preload
         * cannot leave a stale green dot or swallow the next real error. */
        state.consecutiveFailures += 1;
        const hadBridgeError = Boolean(state.error);
        state.error = jt('diagnostics.unavailable', 'jennyShell.diagnostics unavailable');
        if (!hadBridgeError && reportError) {
          reportError({ message: state.error, dedupeKey: 'health-poll:status' }, { origin: 'health-poll' });
        }
        if (state.consecutiveFailures >= 2) {
          state.toneLabel = { tone: 'muted', label: jt('healthPill.unknown', 'Unknown'), summary: state.error };
        }
        renderPill();
        if (state.open) refreshPopoverContent();
        schedulePoll();
        return null;
      }
      state.inFlight = true;
      try {
        const snapshot = await fetchFn(DEFAULT_REFRESH_OPTIONS);
        if (state.disposed) return null;
        state.snapshot = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
          ? snapshot
          : null;
        state.toneLabel = combineHealthSignal(state.snapshot, { deriveRuntimeHealthState, remoteStatus: state.remoteStatus });
        state.consecutiveFailures = 0;
        state.error = '';
        state.lastFetchAt = Date.now();
        announceSandboxNoticeOnce(state.snapshot);
        renderPill();
        if (state.open) refreshPopoverContent();
        return state.snapshot;
      } catch (error) {
        if (state.disposed) return null;
        state.consecutiveFailures += 1;
        const hadError = Boolean(state.error);
        state.error = (error && error.message) || String(error || jt('healthPill.statusRequestFailed', 'status request failed'));
        /* Report once per failure episode (resets when a refresh succeeds)
         * so the open-popover poll cannot stack error-center records. */
        if (!hadError && reportError) {
          reportError({ message: state.error, dedupeKey: 'health-poll:status' }, { origin: 'health-poll' });
        }
        if (state.consecutiveFailures >= 2) {
          state.toneLabel = { tone: 'muted', label: jt('healthPill.unknown', 'Unknown'), summary: state.error };
          renderPill();
        } else if (!silent) {
          state.toneLabel = { tone: 'danger', label: jt('healthPill.error', 'Error'), summary: state.error };
          renderPill();
        }
        if (state.open) refreshPopoverContent();
        return null;
      } finally {
        state.inFlight = false;
        const queued = state.queuedRefresh;
        state.queuedRefresh = null;
        if (!state.disposed && queued) await refresh(queued);
        else schedulePoll();
      }
    }

    function refreshRunModeFacet() {
      if (state.disposed) return false;
      let runMode = 'ask';
      try {
        const currentRunMode = globalThis.rendererRunModeControl?.currentRunMode;
        const value = typeof currentRunMode === 'function' ? currentRunMode() : 'ask';
        if (value === 'auto' || value === 'plan') runMode = value;
      } catch (_error) {
        runMode = 'ask';
      }
      if (state.runModeFacet.runMode === runMode) return false;
      state.runModeFacet.runMode = runMode;
      renderPill();
      if (state.open) refreshPopoverContent();
      return true;
    }

    function setRunModePauseState(value) {
      if (state.disposed) return false;
      const pauseState = value === 'requested' || value === 'paused' ? value : 'none';
      if (state.runModeFacet.pauseState === pauseState) return false;
      state.runModeFacet.pauseState = pauseState;
      renderPill();
      if (state.open) refreshPopoverContent();
      return true;
    }

    function handleUnattendedPause(payload) {
      if (state.disposed || payload?.state !== 'requested') return;
      const streamId = String(payload.stream_id || '');
      state.unattendedPause = {
        streamId,
        sessionId: String(payload.session_id || ''),
      };
      setRunModePauseState('requested');
      refreshRunModeFacet();
      const minutes = Math.max(1, Math.round(Number(payload.threshold_minutes) || 0));
      try {
        showToastMessage(jt(
          'safety.unattendedPause.toast',
          'You were away for about {minutes} minutes, so Auto run is pausing: Jenny will ask before its next step, or stop safely if there is nothing left to ask. If nobody answers within 10 minutes the turn stops.',
          { minutes }
        ), {
          tone: 'warning',
          source: 'safety.unattended_guard',
          dedupeKey: 'safety:unattended-pause:' + streamId,
        });
      } catch (_error) { /* toast presentation must not break the safety listener */ }
    }

    function observeStreamPayload(payload) {
      if (!state.unattendedPause) return;
      try {
        const events = Array.isArray(payload?.events) ? payload.events : [payload];
        for (const event of events) {
          if (!event || typeof event !== 'object') continue;
          const eventPayload = event.payload && typeof event.payload === 'object' ? event.payload : event;
          const streamId = String(event.streamId || payload?.streamId || '');
          if (streamId !== state.unattendedPause.streamId) continue;
          const type = String(event.type || eventPayload.type || (event.eventKind === 'reset' ? 'stream_reset' : ''));
          if (type === 'tool_approval_needed'
            || (type === 'tool_result' && eventPayload.errorCode === 'CMP-TOOL-0046')) {
            setRunModePauseState('paused');
          } else if (type === 'complete' || type === 'error'
            || (type === 'stream_reset' && eventPayload.reason !== 'tool_continuation')) {
            setRunModePauseState('none');
            state.unattendedPause = null;
            refreshRunModeFacet();
            return;
          }
        }
      } catch (_error) { /* observer is an optional presentation tap */ }
    }

    function dispose() {
      if (state.disposed) return;
      state.disposed = true;
      state.queuedRefresh = null;
      closePopover();
      if (documentRef) documentRef.removeEventListener('visibilitychange', handleVisibilityChange);
      if (typeof unsubscribeUnattendedPause === 'function') {
        try { unsubscribeUnattendedPause(); } catch (_error) { /* optional bridge cleanup */ }
        unsubscribeUnattendedPause = null;
      }
      if (unsubscribeErrorCenter) {
        unsubscribeErrorCenter();
        unsubscribeErrorCenter = null;
      }
      try { unsubscribeRemote?.(); } catch (_error) { /* best effort */ }
      unsubscribeRemote = null;
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
      if (globalThis.rendererHealthPillController === controller) {
        delete globalThis.rendererHealthPillController;
      }
    }

    if (errorCenterStore && typeof errorCenterStore.subscribe === 'function') {
      unsubscribeErrorCenter = errorCenterStore.subscribe(function onErrorCenterChange() {
        if (state.disposed) return;
        renderPill();
        if (state.open) refreshPopoverContent();
      });
    }
    const remoteApi = windowRef?.jennyShell?.remote;
    const applyRemote = (next) => {
      if (state.disposed) return;
      state.remoteStatus = next && typeof next === 'object' ? next : null;
      state.toneLabel = combineHealthSignal(state.snapshot, { deriveRuntimeHealthState, remoteStatus: state.remoteStatus });
      renderPill(); if (state.open) refreshPopoverContent();
    };
    try { unsubscribeRemote = remoteApi?.onStateChanged?.(applyRemote) || null; } catch (_error) { unsubscribeRemote = null; }
    Promise.resolve(remoteApi?.getState?.()).then(applyRemote, function ignoreRemoteFailure() {});

    if (documentRef) documentRef.addEventListener('visibilitychange', handleVisibilityChange);

    const controller = {
      refresh,
      refreshRunModeFacet,
      setRunModePauseState,
      observeStreamPayload,
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
    const subscribeUnattendedPause = windowRef?.jennyShell?.safety?.onUnattendedPause;
    if (typeof subscribeUnattendedPause === 'function') {
      try {
        const unsubscribe = subscribeUnattendedPause.call(
          windowRef.jennyShell.safety,
          handleUnattendedPause
        );
        if (typeof unsubscribe === 'function') unsubscribeUnattendedPause = unsubscribe;
      } catch (_error) { /* optional bridge */ }
    }
    globalThis.rendererHealthPillController = controller;
    renderPill();
    refreshRunModeFacet();
    return controller;
  }

  return {
    createHealthPillController,
    resolveLifecycleTone,
    combineHealthSignal,
  };
});
