/* global window */
(function exposeLifecycleProgressUtils(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.lifecycleProgressUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function lifecycleProgressUtilsFactory() {
  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  var SETTLE_DELAY_MS = 1200;
  var SHUTDOWN_SETTLE_DELAY_MS = 2400;
  var DEFAULT_STARTUP_OVERLAY_SLOW_MS = 8000;
  var DEFAULT_STARTUP_OVERLAY_MAX_VISIBLE_MS = 20000;
  // The curtain's plain fade (animation off, reduced motion, backstop). The
  // removal timer is the fallback for a transitionend that never arrives.
  var STARTUP_OVERLAY_PLAIN_FADE_MS = 240;
  var STARTUP_OVERLAY_REMOVAL_FALLBACK_MS = STARTUP_OVERLAY_PLAIN_FADE_MS + 60;
  // A starfield collapse lands in COLLAPSE_MS; this backstops a window that
  // stops delivering frames mid-collapse.
  var STARTUP_OVERLAY_COLLAPSE_FALLBACK_SLACK_MS = 250;
  var STARTUP_LINE_REFRESH_MS = 250;
  var DEFAULT_STARFIELD_MIN_HOLD_MS = 900;
  var DEFAULT_STARFIELD_COLLAPSE_MS = 750;
  var ERROR_CODE_PATTERN = /CMP-[A-Z]+-\d{4}/;

  var STARTUP_OVERLAY_CONTINUE_ACTION = 'startup-continue';

  function defaultLifecycleProgress() {
    return {
      active: false,
      scenario: '',
      phase: '',
      startedAt: 0,
      error: '',
    };
  }

  function prefersReducedMotion() {
    try {
      return typeof globalThis.matchMedia === 'function'
        && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch (_error) {
      return false;
    }
  }

  function defaultNow() {
    return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  function isTerminalPhase(scenario, phase) {
    if (scenario === 'startup') { return phase === 'ready' || phase === 'model_unavailable'; }
    if (scenario === 'shutdown') { return phase === 'done'; }
    if (scenario === 'modelSwitch') { return phase === 'ready' || phase === 'model_unavailable'; }
    return false;
  }

  // Restored-view display names for the curtain's "Opening {view}" line.
  var VIEW_DISPLAY_NAMES = {
    chat: jt('shell.topNav.chat', 'Chat'),
    home: jt('shell.topNav.home', 'Home'),
    ide: jt('shell.topNav.workspace', 'Workspace'),
    logs: jt('shell.topNav.diagnostics', 'Diagnostics'),
    settings: jt('shell.topNav.settings', 'Settings'),
  };

  // The facts main or the backend status carry about a load: never sentences.
  function readLoadFacts(payload) {
    var source = payload && typeof payload === 'object' ? payload : {};
    var lifecycle = source.model_lifecycle && typeof source.model_lifecycle === 'object' ? source.model_lifecycle : {};
    var acquisition = source.model_acquisition && typeof source.model_acquisition === 'object'
      ? source.model_acquisition
      : (lifecycle.model_acquisition && typeof lifecycle.model_acquisition === 'object' ? lifecycle.model_acquisition : {});
    return {
      modelId: String(source.modelId || acquisition.requested_model || lifecycle.requested_model || '').trim(),
    };
  }

  // UIUX-021: fatal startup/backend-failure alertdialog + Retry, shared by
  // the lifecycle-progress controller below AND by app.js's top-level
  // composition-failure guard (which runs before/without a controller
  // instance). Module-level (not controller-closure) so both call sites use
  // the exact same accessibility mechanics; per-overlay state rides on the
  // element itself (no shared module state to leak across overlays/tests).
  var STARTUP_OVERLAY_RETRY_BUTTON_ID = 'startupOverlayRetryButton';

  // Renders the action row. An action carrying onClick is bound here, so a
  // caller-supplied extra action (e.g. Reload window) needs no other seam.
  function renderStartupOverlayActions(overlayEl, actions) {
    if (!overlayEl || typeof overlayEl.querySelector !== 'function') { return null; }
    var host = overlayEl.querySelector('#startupOverlayActions');
    var actionButton = typeof globalThis !== 'undefined' && globalThis.inventoryActionButton;
    if (!host) { return null; }
    var actionList = actions || [];
    if (typeof actionButton !== 'function') {
      host.textContent = '';
      return host;
    }
    host.innerHTML = actionList.map(function (action) {
      return actionButton({
        id: action.id,
        domId: action.domId || '',
        label: action.label,
        variant: action.variant || 'secondary',
        size: 'sm',
        className: 'startup-overlay-action',
      });
    }).join('');
    actionList.forEach(function bindAction(action) {
      if (typeof action.onClick !== 'function' || typeof host.querySelector !== 'function') { return; }
      var button = host.querySelector('[data-action="' + action.id + '"]');
      if (button && typeof button.addEventListener === 'function') {
        button.addEventListener('click', action.onClick);
      }
    });
    return host;
  }

  function getStartupOverlayRetryButton(overlayEl) {
    return (overlayEl && typeof overlayEl.querySelector === 'function')
      ? overlayEl.querySelector('#' + STARTUP_OVERLAY_RETRY_BUTTON_ID)
      : null;
  }

  function isStartupOverlayFatalActive(overlayEl) {
    return !!(overlayEl && overlayEl.__jennyStartupFatalActive);
  }

  function isStartupInertExempt(node) {
    return !!(node && typeof node.hasAttribute === 'function'
      && node.hasAttribute('data-startup-inert-exempt'));
  }

  function branchContainsStartupInertExempt(node) {
    return isStartupInertExempt(node) || !!(node && typeof node.querySelector === 'function'
      && node.querySelector('[data-startup-inert-exempt]'));
  }

  function markStartupBranchInert(node) {
    if (!node || isStartupInertExempt(node)) { return; }
    if (branchContainsStartupInertExempt(node)) {
      var children = node.children ? Array.prototype.slice.call(node.children) : [];
      for (var childIndex = 0; childIndex < children.length; childIndex++) {
        markStartupBranchInert(children[childIndex]);
      }
      return;
    }
    if (typeof node.hasAttribute === 'function' && !node.hasAttribute('data-startup-fatal-inert')) {
      node.setAttribute('data-startup-fatal-inert', node.inert ? '1' : '0');
    }
    node.inert = true;
  }

  // A branch containing an exempt descendant cannot itself be inert. Recurse
  // through that branch and inert only its non-exempt siblings, preserving the
  // prior inert value on every node changed by this controller.
  function setStartupOverlayBackgroundInert(overlayEl, makeInert) {
    var doc = overlayEl && (overlayEl.ownerDocument || (typeof document !== 'undefined' ? document : null));
    if (!overlayEl || !doc || !doc.body) { return; }
    if (makeInert) {
      var roots = doc.body.children ? Array.prototype.slice.call(doc.body.children) : [];
      for (var rootIndex = 0; rootIndex < roots.length; rootIndex++) {
        if (roots[rootIndex] !== overlayEl) { markStartupBranchInert(roots[rootIndex]); }
      }
      return;
    }
    var marked = typeof doc.querySelectorAll === 'function'
      ? Array.prototype.slice.call(doc.querySelectorAll('[data-startup-fatal-inert]'))
      : [];
    for (var i = 0; i < marked.length; i++) {
      var node = marked[i];
      var restoreInert = node.getAttribute('data-startup-fatal-inert') === '1';
      node.inert = restoreInert;
      node.removeAttribute('data-startup-fatal-inert');
    }
  }

  function ensureStartupOverlayRetryButton(overlayEl, extraActions) {
    var retryButton = getStartupOverlayRetryButton(overlayEl);
    if (retryButton) { return retryButton; }
    renderStartupOverlayActions(overlayEl, [
      { id: 'startup-retry', domId: STARTUP_OVERLAY_RETRY_BUTTON_ID, label: jt('common.retry', 'Retry'), variant: 'primary' },
    ].concat(Array.isArray(extraActions) ? extraActions : []));
    return getStartupOverlayRetryButton(overlayEl);
  }

  // Promotes the overlay into a true modal alertdialog: assertive
  // announcement, a keyboard-activatable Retry button wired to onRetry,
  // focus moved onto the dialog, and the rest of the app marked inert.
  // Idempotent -- safe to call again on a repeat failure (re-focuses the
  // Retry button and rebinds onRetry without stacking listeners or losing
  // the original pre-error focus target). options.extraActions adds caller
  // actions after Retry when this call has to render the row itself.
  function presentStartupOverlayFatalError(overlayEl, options) {
    if (!overlayEl) { return; }
    if (overlayEl.__jennyStartupSky) { overlayEl.__jennyStartupSky.pause(); }
    var opts = options || {};
    if (!overlayEl.__jennyStartupFatalActive) {
      overlayEl.__jennyStartupFatalActive = true;
      var doc = overlayEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
      overlayEl.__jennyStartupFocusReturn = (doc && doc.activeElement) || null;
    }
    if (typeof overlayEl.setAttribute === 'function') {
      overlayEl.setAttribute('role', 'alertdialog');
      overlayEl.setAttribute('aria-modal', 'true');
      overlayEl.setAttribute('aria-live', 'assertive');
    }
    var retryButton = ensureStartupOverlayRetryButton(overlayEl, opts.extraActions);
    if (retryButton) {
      if (retryButton.classList) { retryButton.classList.remove('hidden'); }
      retryButton.disabled = false;
      if (typeof opts.onRetry === 'function') {
        if (retryButton.__jennyStartupRetryHandler && typeof retryButton.removeEventListener === 'function') {
          retryButton.removeEventListener('click', retryButton.__jennyStartupRetryHandler);
        }
        retryButton.__jennyStartupRetryHandler = opts.onRetry;
        if (typeof retryButton.addEventListener === 'function') {
          retryButton.addEventListener('click', opts.onRetry);
        }
      }
      if (typeof retryButton.focus === 'function') {
        retryButton.focus({ preventScroll: true });
      }
    }
    setStartupOverlayBackgroundInert(overlayEl, true);
  }

  // Reverts an overlay taken modal by presentStartupOverlayFatalError back to
  // its resting role="status" narration state and restores focus to whatever
  // had it before the failure. No-op if the overlay was never in fatal mode.
  function clearStartupOverlayFatalError(overlayEl) {
    if (!overlayEl || !overlayEl.__jennyStartupFatalActive) { return; }
    overlayEl.__jennyStartupFatalActive = false;
    if (typeof overlayEl.setAttribute === 'function') {
      overlayEl.setAttribute('role', 'status');
      overlayEl.setAttribute('aria-live', 'polite');
    }
    if (typeof overlayEl.removeAttribute === 'function') {
      overlayEl.removeAttribute('aria-modal');
    }
    var target = overlayEl.__jennyStartupFocusReturn;
    overlayEl.__jennyStartupFocusReturn = null;
    if (target && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
  }

  // 'on' | 'off'. Off: the Settings toggle (documentElement data attribute set
  // by appearance-utils), the startup_animation kill switch (stamped pre-paint
  // by theme-bootstrap, or the fetched flag), or the __JENNY_STARTUP_ANIMATION
  // automation/test override. Reduced motion is not off: it paints a still sky.
  function resolveStartupAnimationMode(doc, state) {
    var override = typeof globalThis !== 'undefined' ? String(globalThis.__JENNY_STARTUP_ANIMATION || '') : '';
    if (override === 'off') { return 'off'; }
    var rootElement = doc && doc.documentElement;
    var rootData = (rootElement && rootElement.dataset) || {};
    if (rootData.startupAnimation === 'off' || rootData.startupAnimationFlag === 'off') { return 'off'; }
    var flags = state && state.features && state.features.featureFlags;
    if (flags && flags.startup_animation === false) { return 'off'; }
    return 'on';
  }

  function mountStartupStarfield(overlay, doc, reducedMotion) {
    var engine = typeof globalThis !== 'undefined' && globalThis.rendererStartupStarfield;
    if (!engine || typeof engine.createStartupStarfield !== 'function' || !overlay
      || typeof overlay.querySelector !== 'function') { return null; }
    var canvas = overlay.querySelector('#startupOverlaySky');
    if (!canvas) { return null; }
    var sky = engine.createStartupStarfield({
      canvas: canvas,
      wordmark: overlay.querySelector('.startup-overlay-wordmark'),
      curtain: overlay,
      window: (doc && doc.defaultView) || null,
      reducedMotion: reducedMotion,
    });
    if (sky) { sky.start(); }
    return sky;
  }

  function createLifecycleProgressController(deps) {
    var state = deps.state;
    var startupOverlay = deps.dom.startupOverlay || null;
    var startupOverlaySublabel = deps.dom.startupOverlaySublabel || null;
    var startupOverlaySecondary = deps.dom.startupOverlaySecondary || null;
    var now = typeof deps.now === 'function' ? deps.now : defaultNow;
    // Caller-supplied fatal actions appended after Retry / View logs.
    var fatalExtraActions = Array.isArray(deps.fatalActions) ? deps.fatalActions.slice() : [];
    var onStartupReady = typeof deps.callbacks.onStartupReady === 'function' ? deps.callbacks.onStartupReady : null;
    var onStartupRemoved = typeof deps.callbacks.onStartupRemoved === 'function' ? deps.callbacks.onStartupRemoved : null;
    var retryBackendStart = typeof deps.callbacks.retryBackendStart === 'function' ? deps.callbacks.retryBackendStart : function noopRetryBackendStart() { return Promise.resolve(); };
    var openLogs = typeof deps.callbacks.openLogs === 'function' ? deps.callbacks.openLogs : function noopOpenLogs() {};
    var appendClientLog = typeof deps.callbacks.appendClientLog === 'function' ? deps.callbacks.appendClientLog : function noopAppendClientLog() {};
    // A best-effort callback or teardown step threw: startup carries on, the log keeps the trace.
    function logIgnoredError(site, error) {
      appendClientLog('DEBUG', 'startup.ignored_error', { site: site, error: String((error && error.message) || error || '') });
    }

    var settleTimer = 0;
    var startupOverlayDismissed = false;
    var startupOverlayRemoved = false;
    var startupOverlayRemovalTimer = 0;
    var lifecycleControllerDisposed = false;
    // Normal dismissal needs shared shell hydration and the restored view's
    // first usable render. Backend readiness only tracks the model story.
    var startupBackendReady = false;
    var startupBootViewReady = false;
    var startupShellHydrated = false;
    var startupOverlaySlowTimer = 0;
    var startupOverlayBackstopTimer = 0;
    var startupOverlayHoldTimer = 0;
    var startupLineRefreshTimer = 0;
    var startupOverlaySlowElapsed = false;
    var startupOverlayBackstopElapsed = false;
    var startupOverlayBackstopLogged = false;
    var startupOverlayContinueButton = null;
    var modelSwitchFacts = null;
    var startupOverlaySlowMs = Math.max(Number((typeof globalThis !== 'undefined' && globalThis.__JENNY_STARTUP_OVERLAY_SLOW_MS) || 0) || 0, 0) || DEFAULT_STARTUP_OVERLAY_SLOW_MS;
    var startupOverlayMaxVisibleMs = Math.max(Number((typeof globalThis !== 'undefined' && globalThis.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS) || 0) || 0, 0) || DEFAULT_STARTUP_OVERLAY_MAX_VISIBLE_MS;
    var starfieldModule = typeof globalThis !== 'undefined' ? globalThis.rendererStartupStarfield : null;
    var starfieldMinHoldMs = (starfieldModule && Number(starfieldModule.MIN_HOLD_MS)) || DEFAULT_STARFIELD_MIN_HOLD_MS;
    var starfieldCollapseMs = (starfieldModule && Number(starfieldModule.COLLAPSE_MS)) || DEFAULT_STARFIELD_COLLAPSE_MS;

    var overlayDocument = startupOverlay && (startupOverlay.ownerDocument || (typeof document !== 'undefined' ? document : null));
    var startupSky = null;
    var startupSkyMountedAt = 0;

    function isSkyAnimating() {
      return !!(startupSky && typeof startupSky.isAnimated === 'function' && startupSky.isAnimated());
    }

    function disposeStartupSky() {
      if (!startupSky) { return; }
      try { startupSky.dispose(); } catch (error) { logIgnoredError('starfield_dispose', error); }
      startupSky = null;
      delete startupOverlay.__jennyStartupSky;
    }

    // The Settings toggle or the kill switch may land after mount (feature
    // flags are fetched after the curtain is built).
    function retireSkyWhenSwitchedOff() {
      if (startupSky && resolveStartupAnimationMode(overlayDocument, state) === 'off') { disposeStartupSky(); }
    }

    // Nothing animates behind the fatal dialog; recovery brings the sky back.
    function holdStartupSky(held) {
      if (startupSky) { startupSky[held ? 'pause' : 'resume'](); }
    }

    // ---- The curtain -------------------------------------------------------

    function resolveStartupLine() {
      if (!state || state.sessionListLoaded !== true) {
        return jt('setup.startup.restoringChats', 'Restoring your chats');
      }
      var activeView = String((state.ui && state.ui.activeView) || 'chat');
      var viewName = VIEW_DISPLAY_NAMES[activeView] || VIEW_DISPLAY_NAMES.chat;
      return jt('setup.startup.openingView', 'Opening {view}', { view: viewName });
    }

    function refreshStartupLine() {
      if (startupOverlayDismissed || !startupOverlay || isStartupOverlayFatalActive(startupOverlay)) { return; }
      if (startupOverlay.getAttribute && startupOverlay.getAttribute('data-state') === 'error') { return; }
      var line = resolveStartupLine();
      if (startupOverlaySublabel && startupOverlaySublabel.textContent !== line) {
        startupOverlaySublabel.textContent = line;
      }
    }

    function scheduleStartupLineRefresh() {
      if (startupLineRefreshTimer || lifecycleControllerDisposed || startupOverlayDismissed || !startupOverlay) { return; }
      startupLineRefreshTimer = setTimeout(function handleStartupLineRefresh() {
        startupLineRefreshTimer = 0;
        retireSkyWhenSwitchedOff();
        refreshStartupLine();
        scheduleStartupLineRefresh();
      }, STARTUP_LINE_REFRESH_MS);
    }

    function setStartupOverlayActions(actions) {
      renderStartupOverlayActions(startupOverlay, actions);
      startupOverlayContinueButton = null;
    }

    function handleStartupOverlayRetryClick(event) {
      var button = event && event.currentTarget ? event.currentTarget : getStartupOverlayRetryButton(startupOverlay);
      return retryBackendStart(button);
    }

    function handleStartupOverlayContinue(reason) {
      appendClientLog('INFO', 'startup.curtain_continued', { reason: reason });
      dismissStartupOverlay({ skipHold: true });
    }

    function handleStartupOverlayViewLogs() {
      openLogs();
      clearStartupOverlayFatalError(startupOverlay);
      dismissStartupOverlay({ skipHold: true });
    }

    // Continue anyway is created once and kept: progress ticks never rebuild
    // it, so a click or focus on it survives a download update.
    function ensureContinueButton() {
      if (!startupOverlay || typeof startupOverlay.querySelector !== 'function') { return null; }
      var host = startupOverlay.querySelector('#startupOverlayActions');
      if (!host) { return null; }
      if (startupOverlayContinueButton && startupOverlayContinueButton.parentNode === host) {
        return startupOverlayContinueButton;
      }
      var label = jt('shell.progress.continueAnyway', 'Continue anyway');
      renderStartupOverlayActions(startupOverlay, [
        { id: STARTUP_OVERLAY_CONTINUE_ACTION, label: label, variant: 'secondary', onClick: function onContinue() { handleStartupOverlayContinue('slow'); } },
      ]);
      startupOverlayContinueButton = typeof host.querySelector === 'function'
        ? host.querySelector('[data-action="' + STARTUP_OVERLAY_CONTINUE_ACTION + '"]')
        : null;
      return startupOverlayContinueButton;
    }

    function renderSlowState() {
      if (startupOverlayDismissed || !startupOverlay || isStartupOverlayFatalActive(startupOverlay)) { return; }
      startupOverlay.setAttribute('data-state', 'slow');
      var secondary = jt('setup.startup.slow', 'Taking longer than usual');
      if (startupOverlaySecondary && startupOverlaySecondary.textContent !== secondary) {
        startupOverlaySecondary.textContent = secondary;
      }
      var button = ensureContinueButton();
      var label = jt('shell.progress.continueAnyway', 'Continue anyway');
      if (button && button.textContent !== label) { button.textContent = label; }
    }

    function resolveFailureCodeLine(error, detail) {
      var match = String(detail || '').match(ERROR_CODE_PATTERN) || String(error || '').match(ERROR_CODE_PATTERN);
      return match
        ? jt('setup.startup.errorCode', 'Error code {code}', { code: match[0] })
        : jt('setup.startup.failedHint', 'Retry restarts the engine. View logs shows what happened.');
    }

    function renderFailureState(error, detail) {
      startupOverlay.setAttribute('data-state', 'error');
      holdStartupSky(true);
      if (startupOverlaySublabel) { startupOverlaySublabel.textContent = jt('setup.startup.failed', 'Jenny could not start'); }
      if (startupOverlaySecondary) { startupOverlaySecondary.textContent = resolveFailureCodeLine(error, detail); }
      setStartupOverlayActions([
        // Retry's click is bound once by presentStartupOverlayFatalError.
        { id: 'startup-retry', domId: STARTUP_OVERLAY_RETRY_BUTTON_ID, label: jt('common.retry', 'Retry'), variant: 'primary' },
        { id: 'startup-view-logs', label: jt('shell.progress.viewLogs', 'View logs'), variant: 'secondary', onClick: handleStartupOverlayViewLogs },
      ].concat(fatalExtraActions));
    }

    // Recovery from the fatal dialog back to the resting line (+ slow line).
    function renderRestingState() {
      clearStartupOverlayFatalError(startupOverlay);
      holdStartupSky(false);
      if (startupOverlay.getAttribute('data-state') === 'error') {
        startupOverlay.removeAttribute('data-state');
        if (startupOverlaySecondary) { startupOverlaySecondary.textContent = ''; }
        setStartupOverlayActions([]);
      }
      if (startupOverlaySlowElapsed) { renderSlowState(); }
      refreshStartupLine();
      // A backstop that elapsed behind the fatal dialog applies once it clears,
      // whichever event (startup, model switch, ready) confirmed the recovery.
      if (startupOverlayBackstopElapsed) { dismissStartupOverlayForBackstop(); }
    }

    function updateStartupOverlay(error, detail) {
      if (startupOverlayDismissed || !startupOverlay) { return; }
      if (error) {
        renderFailureState(error, detail);
        return;
      }
      if (isStartupOverlayFatalActive(startupOverlay)) { return; }
      refreshStartupLine();
      if (startupOverlayBackstopElapsed) { dismissStartupOverlayForBackstop(); }
    }

    function removeStartupOverlayNode() {
      if (startupOverlayRemoved) { return; }
      startupOverlayRemoved = true;
      if (startupOverlayRemovalTimer) {
        clearTimeout(startupOverlayRemovalTimer);
        startupOverlayRemovalTimer = 0;
      }
      disposeStartupSky();
      if (startupOverlay.parentNode) {
        startupOverlay.parentNode.removeChild(startupOverlay);
      }
      setStartupOverlayBackgroundInert(startupOverlay, false);
      try { globalThis.__jennyStartupAudit?.mark?.('shell-interactive'); } catch (error) { logIgnoredError('startup_audit_mark', error); }
      if (!lifecycleControllerDisposed) {
        if (onStartupRemoved) { try { onStartupRemoved(); } catch (error) { logIgnoredError('startup_removed', error); } }
      }
    }

    function clearStartupOverlayTimers() {
      if (startupOverlaySlowTimer) { clearTimeout(startupOverlaySlowTimer); startupOverlaySlowTimer = 0; }
      if (startupOverlayBackstopTimer) { clearTimeout(startupOverlayBackstopTimer); startupOverlayBackstopTimer = 0; }
      if (startupOverlayHoldTimer) { clearTimeout(startupOverlayHoldTimer); startupOverlayHoldTimer = 0; }
      if (startupLineRefreshTimer) { clearTimeout(startupLineRefreshTimer); startupLineRefreshTimer = 0; }
    }

    function dismissStartupOverlay(options) {
      if (startupOverlayDismissed || !startupOverlay) { return; }
      // UIUX-021: the backstop must never silently drop a fatal alertdialog.
      if (isStartupOverlayFatalActive(startupOverlay)) { return; }
      retireSkyWhenSwitchedOff();
      var animating = isSkyAnimating();
      // A warm start still gets a short sky: never collapse before the hold.
      var holdLeft = animating && !(options && options.skipHold)
        ? Math.ceil(starfieldMinHoldMs - (now() - startupSkyMountedAt))
        : 0;
      if (holdLeft > 0) {
        if (!startupOverlayHoldTimer) {
          startupOverlayHoldTimer = setTimeout(function handleStartupOverlayHold() {
            startupOverlayHoldTimer = 0;
            dismissStartupOverlay({ skipHold: true });
          }, holdLeft);
        }
        return;
      }
      startupOverlayDismissed = true;
      clearStartupOverlayTimers();
      if (onStartupReady) { try { onStartupReady(); } catch (error) { logIgnoredError('startup_ready', error); } }
      if (animating && startupOverlay.style) {
        // The stars drive the fade; the class marks dismissal while the
        // mounted curtain continues intercepting input until removal.
        startupOverlay.style.opacity = '1';
      } else {
        disposeStartupSky();
      }
      startupOverlay.classList.add('hidden');
      if (animating) {
        startupSky.collapse({ onDone: removeStartupOverlayNode });
        if (startupOverlayDismissed && !startupOverlayRemoved && !startupOverlayRemovalTimer) {
          startupOverlayRemovalTimer = setTimeout(removeStartupOverlayNode, starfieldCollapseMs + STARTUP_OVERLAY_COLLAPSE_FALLBACK_SLACK_MS);
        }
        return;
      }
      startupOverlay.addEventListener('transitionend', function onEnd(event) {
        if (event && event.target && event.target !== startupOverlay) { return; }
        if (event && event.propertyName && event.propertyName !== 'opacity') { return; }
        startupOverlay.removeEventListener('transitionend', onEnd);
        removeStartupOverlayNode();
      });
      startupOverlayRemovalTimer = setTimeout(removeStartupOverlayNode, STARTUP_OVERLAY_REMOVAL_FALLBACK_MS);
    }

    function dismissStartupOverlayForBackstop() {
      if (startupOverlayDismissed || !startupOverlay || isStartupOverlayFatalActive(startupOverlay)) { return; }
      if (!startupOverlayBackstopLogged) {
        startupOverlayBackstopLogged = true;
        appendClientLog('WARN', 'startup.curtain_backstop_dismissed', {
          state: startupOverlay.getAttribute('data-state') || 'starting',
        });
      }
      dismissStartupOverlay({ skipHold: true });
    }

    function maybeDismissStartupOverlay() {
      if (lifecycleControllerDisposed || !startupBootViewReady || !startupShellHydrated) { return; }
      // The backstop exists only for a shell that never reports fully ready.
      if (startupOverlayBackstopTimer) { clearTimeout(startupOverlayBackstopTimer); startupOverlayBackstopTimer = 0; }
      dismissStartupOverlay();
    }

    // Success and failure both count once the restored view has a usable render.
    function notifyBootViewReady() {
      if (lifecycleControllerDisposed || startupBootViewReady) { return; }
      startupBootViewReady = true;
      refreshStartupLine();
      maybeDismissStartupOverlay();
    }

    function notifyShellHydrated() {
      if (lifecycleControllerDisposed || startupShellHydrated) { return; }
      startupShellHydrated = true;
      maybeDismissStartupOverlay();
    }

    function scheduleStartupOverlayTimers() {
      if (lifecycleControllerDisposed || startupOverlayDismissed || !startupOverlay) { return; }
      if (!startupOverlaySlowTimer && !startupOverlaySlowElapsed && startupOverlaySlowMs > 0) {
        startupOverlaySlowTimer = setTimeout(function handleStartupOverlaySlow() {
          startupOverlaySlowTimer = 0;
          startupOverlaySlowElapsed = true;
          renderSlowState();
        }, startupOverlaySlowMs);
      }
      if (!startupOverlayBackstopTimer && !(startupBootViewReady && startupShellHydrated) && !startupOverlayBackstopElapsed && startupOverlayMaxVisibleMs > 0) {
        startupOverlayBackstopTimer = setTimeout(function handleStartupOverlayBackstop() {
          startupOverlayBackstopTimer = 0;
          startupOverlayBackstopElapsed = true;
          dismissStartupOverlayForBackstop();
        }, startupOverlayMaxVisibleMs);
      }
    }

    // The mounted curtain isolates the background through hydration and fade.
    if (startupOverlay) {
      setStartupOverlayBackgroundInert(startupOverlay, true);
      if (resolveStartupAnimationMode(overlayDocument, state) === 'on') {
        try {
          startupSky = mountStartupStarfield(startupOverlay, overlayDocument, prefersReducedMotion());
          if (startupSky) { startupOverlay.__jennyStartupSky = startupSky; }
        } catch (error) {
          logIgnoredError('starfield_mount', error);
          startupSky = null;
        }
      }
      startupSkyMountedAt = now();
      refreshStartupLine();
      scheduleStartupLineRefresh();
    }
    scheduleStartupOverlayTimers();

    // ---- Lifecycle state (the curtain, the model-switch story) ---------------

    function scheduleHide(delayMs) {
      if (settleTimer) { clearTimeout(settleTimer); }
      settleTimer = setTimeout(function handleSettleHide() {
        settleTimer = 0;
        if (!state) { return; }
        state.lifecycleProgress = defaultLifecycleProgress();
      }, delayMs);
    }

    function handleLifecycleProgress(payload) {
      if (lifecycleControllerDisposed || !payload || !payload.scenario) { return; }

      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }

      var scenario = payload.scenario;
      var phase = payload.phase || '';
      var error = String(payload.error || '');
      var terminal = isTerminalPhase(scenario, phase);
      var facts = readLoadFacts(payload.facts || payload);
      var previous = state.lifecycleProgress || defaultLifecycleProgress();

      state.lifecycleProgress = {
        active: true,
        scenario: scenario,
        phase: phase,
        modelId: facts.modelId,
        startedAt: (previous.active && previous.scenario === scenario && previous.startedAt) || Date.now(),
        error: error,
      };

      if (scenario === 'startup') {
        scheduleStartupOverlayTimers();
        updateStartupOverlay(error, payload.detail || error);
        // The curtain lifts on the shell, before the backend is done, so a
        // startup error can land after it is gone. Only a curtain still up
        // becomes the alertdialog; otherwise the health pill and its toasts
        // carry the failure (marking the app inert behind a removed curtain would have
        // left it unreachable, with Retry on a node nobody can see).
        if (error && !startupOverlayDismissed && startupOverlay) {
          presentStartupOverlayFatalError(startupOverlay, { onRetry: handleStartupOverlayRetryClick, extraActions: fatalExtraActions });
        }
      }

      if (terminal) {
        var delay = scenario === 'shutdown' ? SHUTDOWN_SETTLE_DELAY_MS : SETTLE_DELAY_MS;
        if (error) { delay = 3000; }
        scheduleHide(delay);
        if ((scenario === 'startup' || scenario === 'modelSwitch') && !error && phase !== 'model_unavailable') {
          startupBackendReady = true;
          modelSwitchFacts = null;
          if (startupOverlay && isStartupOverlayFatalActive(startupOverlay)) { renderRestingState(); }
          maybeDismissStartupOverlay();
        }
      }
    }

    // A load after boot (including the auto-load right after startup's
    // ready, while its state still settles): a model switch, never startup.
    function isLoadAfterBoot() {
      var progress = state.lifecycleProgress;
      var startupInFlight = progress.active && progress.scenario === 'startup' && !isTerminalPhase('startup', progress.phase);
      return startupBackendReady && !startupInFlight;
    }

    function handleBackendStatus(payload) {
      if (lifecycleControllerDisposed || !payload) { return; }
      scheduleStartupOverlayTimers();
      var phase = String(payload.phase || '').trim().toLowerCase();
      var facts = readLoadFacts(payload);
      var switchActive = state.lifecycleProgress.active && state.lifecycleProgress.scenario === 'modelSwitch';
      if (phase === 'sidecar_spawned' || phase === 'model_acquiring' || phase === 'model_loading') {
        if (startupOverlay && isStartupOverlayFatalActive(startupOverlay)) { renderRestingState(); }
        if (phase !== 'sidecar_spawned' && (switchActive || isLoadAfterBoot())) {
          if (!switchActive) { beginModelSwitch(facts.modelId); }
          updateModelSwitch(phase, facts);
          maybeDismissStartupOverlay();
          return;
        }
        handleLifecycleProgress({ scenario: 'startup', phase: phase, facts: facts, error: '' });
        maybeDismissStartupOverlay();
      } else if (phase === 'model_unavailable') {
        if (startupOverlay && isStartupOverlayFatalActive(startupOverlay)) { renderRestingState(); }
        handleLifecycleProgress({
          scenario: switchActive ? 'modelSwitch' : 'startup',
          phase: 'model_unavailable',
          facts: facts,
          error: '',
        });
        maybeDismissStartupOverlay();
      } else if (phase === 'failed') {
        // UIUX-021: surface failures right away — don't gate behind the boot
        // view — as a modal alertdialog with a Retry affordance. Guarded on
        // the overlay still being up: a backend-status 'failed' arriving
        // after a successful boot (overlay long gone) is the running app's
        // toast surface's job, not this one's.
        if (!startupOverlayDismissed && startupOverlay) {
          var failureDetail = String(payload.detail || '').trim();
          updateStartupOverlay(failureDetail || jt('shell.progress.backendFailedToStart', 'Backend failed to start.'), failureDetail);
          presentStartupOverlayFatalError(startupOverlay, { onRetry: handleStartupOverlayRetryClick, extraActions: fatalExtraActions });
        }
      } else if (phase === 'ready') {
        if (state.lifecycleProgress.active
          && (state.lifecycleProgress.scenario === 'startup' || state.lifecycleProgress.scenario === 'modelSwitch')) {
          // Delegate to the terminal progress event, which settles the state.
          handleLifecycleProgress({
            scenario: state.lifecycleProgress.scenario,
            phase: 'ready',
            facts: facts,
            error: '',
          });
          return;
        }
        startupBackendReady = true;
        if (startupOverlay && isStartupOverlayFatalActive(startupOverlay)) { renderRestingState(); }
        if (startupOverlayBackstopElapsed) {
          dismissStartupOverlayForBackstop();
        } else {
          maybeDismissStartupOverlay();
        }
      }
    }

    // Model switch: tracked as its own scenario, never as startup, so the
    // curtain never re-raises for a load after boot.
    function beginModelSwitch(modelOrFacts) {
      var facts = modelOrFacts && typeof modelOrFacts === 'object'
        ? readLoadFacts(modelOrFacts)
        : { modelId: String(modelOrFacts || '').trim() };
      modelSwitchFacts = facts;
      handleLifecycleProgress({
        scenario: 'modelSwitch',
        phase: 'reinitialize',
        facts: facts,
        error: '',
      });
    }

    function updateModelSwitch(phase, factsOrModel) {
      var facts = factsOrModel && typeof factsOrModel === 'object'
        ? factsOrModel
        : { modelId: String(factsOrModel || '') };
      if (!facts.modelId && modelSwitchFacts) { facts = Object.assign({}, facts, { modelId: modelSwitchFacts.modelId }); }
      handleLifecycleProgress({
        scenario: 'modelSwitch',
        phase: phase,
        facts: facts,
        error: '',
      });
    }

    function failModelSwitch(detail) {
      handleLifecycleProgress({
        scenario: 'modelSwitch',
        phase: 'model_unavailable',
        facts: modelSwitchFacts || { modelId: '' },
        error: String(detail || 'model_switch_failed'),
      });
    }

    function dispose() {
      lifecycleControllerDisposed = true;
      // A controller torn down while its overlay is still in fatal mode must
      // not leave the rest of the app permanently inert / focus stranded.
      if (isStartupOverlayFatalActive(startupOverlay)) {
        try { clearStartupOverlayFatalError(startupOverlay); } catch (error) { logIgnoredError('clear_fatal', error); }
        setStartupOverlayBackgroundInert(startupOverlay, false);
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
        settleTimer = 0;
      }
      clearStartupOverlayTimers();
      // A handoff in flight completes now (removal also clears its timer).
      if (startupOverlayDismissed && !startupOverlayRemoved) {
        removeStartupOverlayNode();
      }
      // Teardown while visible must stop the starfield rAF loop too.
      disposeStartupSky();
    }

    return {
      handleLifecycleProgress: handleLifecycleProgress,
      handleBackendStatus: handleBackendStatus,
      notifyBootViewReady: notifyBootViewReady,
      notifyShellHydrated: notifyShellHydrated,
      beginModelSwitch: beginModelSwitch,
      updateModelSwitch: updateModelSwitch,
      failModelSwitch: failModelSwitch,
      dispose: dispose,
    };
  }

  return {
    createLifecycleProgressController: createLifecycleProgressController,
    defaultLifecycleProgress: defaultLifecycleProgress,
    STARTUP_OVERLAY_REMOVAL_FALLBACK_MS: STARTUP_OVERLAY_REMOVAL_FALLBACK_MS,
    // Shared with app.js's pre-controller composition-failure guard (UIUX-021).
    presentStartupOverlayFatalError: presentStartupOverlayFatalError,
    clearStartupOverlayFatalError: clearStartupOverlayFatalError,
    isStartupOverlayFatalActive: isStartupOverlayFatalActive,
  };
});
