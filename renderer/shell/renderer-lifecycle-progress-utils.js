/* global window */
(function exposeLifecycleProgressUtils(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.lifecycleProgressUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function lifecycleProgressUtilsFactory() {

  var PILL_SOURCES = (typeof globalThis !== 'undefined'
    && globalThis.rendererTurnStatusPill
    && globalThis.rendererTurnStatusPill.SOURCES)
    || {
      LIFECYCLE_STARTUP: 'lifecycle.startup',
      LIFECYCLE_SHUTDOWN: 'lifecycle.shutdown',
      LIFECYCLE_MODEL_SWITCH: 'lifecycle.modelSwitch',
    };

  var MODEL_SWITCH_STEPS = [
    { key: 'reinitialize',  label: 'Re-initializing engine...' },
    { key: 'model_acquiring', label: 'Downloading model...' },
    { key: 'model_loading', label: 'Loading model...' },
    { key: 'ready',         label: 'Model loaded' },
  ];

  var SETTLE_DELAY_MS = 1200;
  var SHUTDOWN_SETTLE_DELAY_MS = 2400;
  var DEFAULT_STARTUP_OVERLAY_SLOW_MS = 8000;
  var DEFAULT_STARTUP_OVERLAY_MAX_VISIBLE_MS = 20000;

  function defaultLifecycleProgress() {
    return {
      active: false,
      scenario: '',
      phase: '',
      detail: '',
      stepIndex: 0,
      stepCount: 0,
      percent: 0,
      startedAt: 0,
      error: '',
    };
  }

  function normalizePercent(value) {
    var percent = Number(value);
    if (!Number.isFinite(percent)) { return 0; }
    return Math.max(0, Math.min(100, Math.round(percent)));
  }

  function prefersReducedMotion() {
    try {
      return typeof globalThis.matchMedia === 'function'
        && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch (_error) {
      return false;
    }
  }

  function isTerminalPhase(scenario, phase) {
    if (scenario === 'startup') { return phase === 'ready' || phase === 'model_unavailable'; }
    if (scenario === 'shutdown') { return phase === 'done'; }
    if (scenario === 'modelSwitch') { return phase === 'ready' || phase === 'model_unavailable'; }
    return false;
  }

  var STARTUP_OVERLAY_LABELS = {
    ollama_start: 'Starting local inference\u2026',
    ollama_ready: 'Inference engine ready',
    sidecar_spawn: 'Launching companion engine\u2026',
    sidecar_ready: 'Engine process started',
    sidecar_spawned: 'Engine process started',
    sidecar_initialize: 'Initializing engine\u2026',
    model_load: 'Almost ready\u2026',
    model_acquiring: 'Downloading the configured model\u2026',
    model_loading: 'Loading model capabilities\u2026',
    model_unavailable: 'Model unavailable',
    ready: 'Jenny is ready',
  };

  // UIUX-021: fatal startup/backend-failure alertdialog + Retry, shared by
  // the lifecycle-progress controller below AND by app.js's top-level
  // composition-failure guard (which runs before/without a controller
  // instance). Module-level (not controller-closure) so both call sites use
  // the exact same accessibility mechanics; per-overlay state rides on the
  // element itself (no shared module state to leak across overlays/tests).
  var STARTUP_OVERLAY_RETRY_BUTTON_ID = 'startupOverlayRetryButton';

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
    try { node.inert = true; } catch (_e) { /* best-effort */ }
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
      try { node.inert = restoreInert; } catch (_e) { /* best-effort */ }
      node.removeAttribute('data-startup-fatal-inert');
    }
  }

  function ensureStartupOverlayRetryButton(overlayEl) {
    var retryButton = getStartupOverlayRetryButton(overlayEl);
    if (retryButton) { return retryButton; }
    renderStartupOverlayActions(overlayEl, [
      { id: 'startup-retry', domId: STARTUP_OVERLAY_RETRY_BUTTON_ID, label: 'Retry', variant: 'primary' },
    ]);
    return getStartupOverlayRetryButton(overlayEl);
  }

  // Promotes the overlay into a true modal alertdialog: assertive
  // announcement, a keyboard-activatable Retry button wired to onRetry,
  // focus moved onto the dialog, and the rest of the app marked inert.
  // Idempotent -- safe to call again on a repeat failure (re-focuses the
  // Retry button and rebinds onRetry without stacking listeners or losing
  // the original pre-error focus target).
  function presentStartupOverlayFatalError(overlayEl, options) {
    if (!overlayEl) { return; }
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
    var retryButton = ensureStartupOverlayRetryButton(overlayEl);
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
        try { retryButton.focus({ preventScroll: true }); }
        catch (_e) { try { retryButton.focus(); } catch (_e2) { /* ignore */ } }
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
    setStartupOverlayBackgroundInert(overlayEl, false);
    var target = overlayEl.__jennyStartupFocusReturn;
    overlayEl.__jennyStartupFocusReturn = null;
    if (target && typeof target.focus === 'function') {
      try { target.focus({ preventScroll: true }); }
      catch (_e) { try { target.focus(); } catch (_e2) { /* ignore */ } }
    }
  }

  function setupStartupCircuitTrace(overlay) {
    var core = typeof globalThis !== 'undefined' && globalThis.rendererCircuitTraceCore;
    if (!core || !overlay || typeof overlay.getBoundingClientRect !== 'function') { return null; }
    if (prefersReducedMotion()) { return null; }

    var doc = overlay.ownerDocument || (typeof document !== 'undefined' ? document : null);
    var win = (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win || (doc.documentElement && doc.documentElement.dataset.surfaceEffect === 'none')) { return null; }

    var canvas = doc.createElement('canvas');
    canvas.className = 'startup-circuit-canvas';
    overlay.insertBefore(canvas, overlay.firstChild);

    var ctx = canvas.getContext('2d');
    if (!ctx) {
      if (canvas.parentNode) { canvas.parentNode.removeChild(canvas); }
      return null;
    }

    var style = win.getComputedStyle(overlay);
    var gridColor = (style.getPropertyValue('--startup-circuit-grid') || '').trim() || 'rgba(106, 58, 255, 0.12)';
    var lineColor = (style.getPropertyValue('--startup-circuit-line') || '').trim() || 'rgba(41, 192, 255, 0.80)';
    var glowColor = lineColor;
    var hexSize = 48;
    var density = 0.6;
    var speedMul = 0.6;

    var dpr = Math.max((win.devicePixelRatio) || 1, 1);
    var rect = overlay.getBoundingClientRect();
    var w = Math.round(rect.width);
    var h = Math.round(rect.height);
    if (w === 0 || h === 0) {
      if (canvas.parentNode) { canvas.parentNode.removeChild(canvas); }
      return null;
    }
    canvas.width = Math.max(Math.round(w * dpr), 1);
    canvas.height = Math.max(Math.round(h * dpr), 1);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';

    // Startup-overlay decoration may use per-launch entropy.
    var seed = (0xc1c2c3 ^ (Math.random() * 0xffffff | 0)) >>> 0;
    var rng = core.makeRng(seed);
    var graph = core.buildHexGraph(w, h, hexSize, rng);
    var hexArea = (3 * core.SQRT3 / 2) * hexSize * hexSize;
    var traceCount = Math.max(3, Math.min(20, Math.round((w * h / hexArea) * 0.08 * density)));
    var traces = core.buildTraces(graph, traceCount, rng);

    var rafHandle = 0;
    var lastNow = 0;
    var disposed = false;
    var BUCKET_CENTERS = core.BUCKET_CENTERS;

    function draw(now) {
      if (disposed) { return; }
      rafHandle = 0;
      var dt = lastNow > 0 ? (now - lastNow) : 16;
      lastNow = now;
      if (dt > 80) { dt = 80; }

      var frameRng = core.makeRng((seed + Math.floor(now)) >>> 0);
      for (var i = 0; i < traces.length; i++) {
        var tr = traces[i];
        tr.t += tr.speed * speedMul * dt;
        while (tr.t >= 1) {
          tr.t -= 1;
          tr.prevIdx = tr.fromIdx;
          tr.fromIdx = tr.toIdx;
          var nextIdx = core.pickNeighbor(graph.nodes[tr.fromIdx], tr.prevIdx, frameRng);
          if (nextIdx < 0) { tr.t = 0; break; }
          tr.toIdx = nextIdx;
        }
        var from = graph.nodes[tr.fromIdx];
        var to = graph.nodes[tr.toIdx];
        if (from && to) {
          var te = core.easeInOutQuad(tr.t);
          core.pushTrailPoint(tr, from.x + (to.x - from.x) * te, from.y + (to.y - from.y) * te);
        }
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      ctx.strokeStyle = gridColor;
      ctx.lineCap = 'round';
      ctx.lineWidth = 1;
      for (var b = 0; b < graph.bucketLists.length; b++) {
        var list = graph.bucketLists[b];
        if (!list || list.length === 0) { continue; }
        ctx.globalAlpha = BUCKET_CENTERS[b];
        ctx.beginPath();
        for (var k = 0; k < list.length; k++) {
          var e = graph.edges[list[k]];
          ctx.moveTo(graph.nodes[e.a].x, graph.nodes[e.a].y);
          ctx.lineTo(graph.nodes[e.b].x, graph.nodes[e.b].y);
        }
        ctx.stroke();
      }

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (var ti = 0; ti < traces.length; ti++) {
        var t = traces[ti];
        var fNode = graph.nodes[t.fromIdx];
        var tNode = graph.nodes[t.toIdx];
        if (!fNode || !tNode) { continue; }
        var tt = core.easeInOutQuad(t.t);
        var hx = fNode.x + (tNode.x - fNode.x) * tt;
        var hy = fNode.y + (tNode.y - fNode.y) * tt;
        var color = t.hue === 1 ? glowColor : lineColor;

        if (t.trailSize > 1) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = color;
          ctx.lineWidth = 3.0;
          ctx.globalAlpha = 0.13;
          core.strokeTrailPath(ctx, t, 14);
          ctx.stroke();
          ctx.restore();

          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2;
          ctx.globalAlpha = 0.50;
          core.strokeTrailPath(ctx, t, 14);
          ctx.stroke();
        }

        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.80;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.restore();
      }

      ctx.restore();

      if (!disposed) {
        rafHandle = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(draw) : 0;
      }
    }

    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(function () {
      if (!disposed) { canvas.classList.add('startup-circuit-ready'); }
    });
    rafHandle = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(draw) : 0;

    return {
      dispose: function () {
        disposed = true;
        if (rafHandle && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(rafHandle); rafHandle = 0; }
        if (canvas.parentNode) { canvas.parentNode.removeChild(canvas); }
      },
    };
  }

  function createLifecycleProgressController(deps) {
    var state = deps.state;
    var startupOverlay = deps.dom.startupOverlay || null;
    var startupOverlaySublabel = deps.dom.startupOverlaySublabel || null;
    var startupOverlaySecondary = deps.dom.startupOverlaySecondary || null;
    var onStartupReady = typeof deps.callbacks.onStartupReady === 'function' ? deps.callbacks.onStartupReady : null;
    var onStartupRemoved = typeof deps.callbacks.onStartupRemoved === 'function' ? deps.callbacks.onStartupRemoved : null;
    var retryBackendStart = typeof deps.callbacks.retryBackendStart === 'function' ? deps.callbacks.retryBackendStart : function noopRetryBackendStart() { return Promise.resolve(); };
    var openLogs = typeof deps.callbacks.openLogs === 'function' ? deps.callbacks.openLogs : function noopOpenLogs() {};
    var appendClientLog = typeof deps.callbacks.appendClientLog === 'function' ? deps.callbacks.appendClientLog : function noopAppendClientLog() {};
    var setTurnStatusPill = typeof deps.callbacks.setTurnStatusPill === 'function' ? deps.callbacks.setTurnStatusPill : function noopSetPill() {};
    var clearTurnStatusPill = typeof deps.callbacks.clearTurnStatusPill === 'function' ? deps.callbacks.clearTurnStatusPill : function noopClearPill() {};

    function lifecyclePillSource(scenario) {
      if (scenario === 'startup') { return PILL_SOURCES.LIFECYCLE_STARTUP; }
      if (scenario === 'shutdown') { return PILL_SOURCES.LIFECYCLE_SHUTDOWN; }
      if (scenario === 'modelSwitch') { return PILL_SOURCES.LIFECYCLE_MODEL_SWITCH; }
      return '';
    }

    var settleTimer = 0;
    var startupOverlayDismissed = false;
    var startupOverlayRemovedNotified = false;
    var startupOverlayRemovalTimer = 0;
    var lifecycleControllerDisposed = false;
    // Every restored view gates dismissal on backend readiness plus usable render.
    var startupBackendReady = false;
    var startupBootViewReady = false;
    var startupOverlaySlowTimer = 0;
    var startupOverlayBackstopTimer = 0;
    var startupOverlayPercent = 0;
    var startupOverlaySlowElapsed = false;
    var startupOverlayBlockedActive = false;
    var startupOverlayBackstopElapsed = false;
    var startupOverlayBackstopLogged = false;
    var startupOverlaySlowMs = Math.max(Number((typeof globalThis !== 'undefined' && globalThis.__JENNY_STARTUP_OVERLAY_SLOW_MS) || 0) || 0, 0) || DEFAULT_STARTUP_OVERLAY_SLOW_MS;
    var startupOverlayMaxVisibleMs = Math.max(Number((typeof globalThis !== 'undefined' && globalThis.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS) || 0) || 0, 0) || DEFAULT_STARTUP_OVERLAY_MAX_VISIBLE_MS;

    function getLifecycleScenarioLabel(scenario) {
      if (scenario === 'startup') { return 'Startup'; }
      if (scenario === 'shutdown') { return 'Shutdown'; }
      if (scenario === 'modelSwitch') { return 'Model Switch'; }
      return 'Lifecycle';
    }

    function buildLifecycleStatusModel(scenario, phase, detail, error, options) {
      var terminal = isTerminalPhase(scenario, phase);
      var unavailable = phase === 'model_unavailable';
      var tone = error || unavailable
        ? 'danger'
        : terminal
          ? 'success'
          : scenario === 'shutdown'
            ? 'warning'
            : 'pending';
      var badgeText = error || unavailable
        ? (unavailable ? 'Unavailable' : 'Error')
        : terminal
          ? (scenario === 'shutdown' ? 'Done' : 'Ready')
          : scenario === 'shutdown'
            ? 'Closing'
            : scenario === 'modelSwitch'
              ? 'Switching'
              : 'Starting';
      return {
        tone: tone,
        label: getLifecycleScenarioLabel(scenario),
        message: String(detail || error || '').trim(),
        badgeText: badgeText,
        spinner: !error && !terminal && !unavailable,
        compact: true,
        className: String(options && options.className ? options.className : '').trim(),
        ariaLive: String(options && options.ariaLive ? options.ariaLive : '').trim(),
      };
    }

    function bindStartupOverlayAction(actionId, handler) {
      if (!startupOverlay || typeof startupOverlay.querySelector !== 'function') { return; }
      var button = startupOverlay.querySelector('[data-action="' + actionId + '"]');
      if (button && typeof button.addEventListener === 'function') {
        button.addEventListener('click', handler);
      }
    }

    function setStartupOverlayActions(actions) {
      renderStartupOverlayActions(startupOverlay, actions);
    }

    function handleStartupOverlayRetryClick(event) {
      var button = event && event.currentTarget ? event.currentTarget : getStartupOverlayRetryButton(startupOverlay);
      return retryBackendStart(button);
    }

    function handleStartupOverlayContinue(reason) {
      appendClientLog('INFO', 'startup.curtain_continued', { reason: reason });
      dismissStartupOverlay();
    }

    function handleStartupOverlayViewLogs() {
      openLogs();
      clearStartupOverlayFatalError(startupOverlay);
      dismissStartupOverlay();
    }

    function renderSlowState() {
      if (startupOverlayDismissed || !startupOverlay || startupOverlayBlockedActive
        || isStartupOverlayFatalActive(startupOverlay)) { return; }
      startupOverlay.setAttribute('data-state', 'slow');
      if (startupOverlaySecondary) { startupOverlaySecondary.textContent = 'Startup is taking longer than usual.'; }
      setStartupOverlayActions([
        { id: 'startup-continue', label: 'Continue anyway', variant: 'secondary' },
      ]);
      bindStartupOverlayAction('startup-continue', function () { handleStartupOverlayContinue('slow'); });
    }

    function updateStartupOverlay(phase, error, detail, percent) {
      if (startupOverlayDismissed || !startupOverlay) { return; }
      var rawPercent = Number(percent);
      var progressPercent = normalizePercent(rawPercent);
      if (Number.isFinite(rawPercent) && rawPercent > 0 && progressPercent < 6) { progressPercent = 6; }
      startupOverlayPercent = Math.max(startupOverlayPercent, progressPercent);
      var progressFill = startupOverlay.querySelector('#startupOverlayProgressFill');
      if (progressFill) {
        progressFill.style.width = startupOverlayPercent + '%';
      }
      var progressBar = startupOverlay.querySelector('#startupOverlayProgressBar');
      if (progressBar && typeof progressBar.setAttribute === 'function') {
        progressBar.setAttribute('aria-valuenow', String(startupOverlayPercent));
      }

      if (error) {
        startupOverlayBlockedActive = false;
        startupOverlay.setAttribute('data-state', 'error');
        if (startupOverlaySublabel) { startupOverlaySublabel.textContent = 'Startup failed'; }
        if (startupOverlaySecondary) { startupOverlaySecondary.textContent = String(detail || error || 'Backend failed to start.'); }
        setStartupOverlayActions([
          { id: 'startup-retry', domId: STARTUP_OVERLAY_RETRY_BUTTON_ID, label: 'Retry', variant: 'primary' },
          { id: 'startup-view-logs', label: 'View logs', variant: 'secondary' },
        ]);
        bindStartupOverlayAction('startup-retry', handleStartupOverlayRetryClick);
        bindStartupOverlayAction('startup-view-logs', handleStartupOverlayViewLogs);
        return;
      }
      if (isStartupOverlayFatalActive(startupOverlay)
        && phase !== 'ready' && phase !== 'model_unavailable') { return; }
      if (startupOverlayBlockedActive && phase !== 'ready') {
        if (startupOverlayBackstopElapsed) { dismissStartupOverlayForBackstop(); }
        return;
      }
      if (phase === 'ready') { startupOverlayBlockedActive = false; }
      clearStartupOverlayFatalError(startupOverlay);
      startupOverlay.removeAttribute('data-state');
      if (startupOverlaySecondary) { startupOverlaySecondary.textContent = ''; }
      setStartupOverlayActions([]);
      if (phase === 'model_unavailable') {
        startupOverlayBlockedActive = true;
        startupOverlay.setAttribute('data-state', 'blocked');
        if (startupOverlaySecondary) {
          startupOverlaySecondary.textContent = 'The configured model is unavailable. You can continue and choose another model in Settings.';
        }
        setStartupOverlayActions([
          { id: 'startup-continue', label: 'Continue', variant: 'primary' },
        ]);
        bindStartupOverlayAction('startup-continue', function () { handleStartupOverlayContinue('model_unavailable'); });
      } else if (startupOverlaySlowElapsed) {
        renderSlowState();
      }
      var message = String(detail || STARTUP_OVERLAY_LABELS[phase] || '').trim();
      if (startupOverlaySublabel) { startupOverlaySublabel.textContent = message; }
      if (startupOverlayBackstopElapsed) { dismissStartupOverlayForBackstop(); }
    }

    function dismissStartupOverlay() {
      if (startupOverlayDismissed || !startupOverlay) { return; }
      // UIUX-021: the backstop must never silently drop a fatal alertdialog.
      if (isStartupOverlayFatalActive(startupOverlay)) { return; }
      startupOverlayDismissed = true;
      if (startupOverlaySlowTimer) { clearTimeout(startupOverlaySlowTimer); startupOverlaySlowTimer = 0; }
      if (startupOverlayBackstopTimer) { clearTimeout(startupOverlayBackstopTimer); startupOverlayBackstopTimer = 0; }
      if (startupCircuitTrace) {
        try { startupCircuitTrace.dispose(); } catch (_e) { /* best-effort */ }
        startupCircuitTrace = null;
      }
      if (onStartupReady) { try { onStartupReady(); } catch (_e) { /* visual init best-effort */ } }
      startupOverlay.classList.add('hidden');
      // F2: the curtain blocked the mouse (opaque, no pointer-events:none) but
      // never made the background keyboard-inert during a normal boot -- only
      // the fatal-error path did. Un-inert here so a normal dismissal always
      // restores reachability (this is a no-op if nothing was marked, and
      // harmless alongside clearStartupOverlayFatalError, which this function
      // never reaches while a fatal dialog is active -- see the early return above).
      setStartupOverlayBackgroundInert(startupOverlay, false);
      try { globalThis.__jennyStartupAudit?.mark?.('shell-interactive'); } catch (_e) { /* best effort */ }
      function removeStartupOverlayNode() {
        if (startupOverlayRemovalTimer) {
          clearTimeout(startupOverlayRemovalTimer);
          startupOverlayRemovalTimer = 0;
        }
        if (startupOverlay.parentNode) {
          startupOverlay.parentNode.removeChild(startupOverlay);
        }
        if (!startupOverlayRemovedNotified && !lifecycleControllerDisposed) {
          startupOverlayRemovedNotified = true;
          if (onStartupRemoved) { try { onStartupRemoved(); } catch (_e) { /* banner refresh best-effort */ } }
        }
      }
      startupOverlay.addEventListener('transitionend', function onEnd(event) {
        if (event && event.target && event.target !== startupOverlay) { return; }
        if (event && event.propertyName && event.propertyName !== 'opacity') { return; }
        startupOverlay.removeEventListener('transitionend', onEnd);
        removeStartupOverlayNode();
      });
      startupOverlayRemovalTimer = setTimeout(removeStartupOverlayNode, prefersReducedMotion() ? 0 : 420);
    }

    function dismissStartupOverlayForBackstop() {
      if (startupOverlayDismissed || !startupOverlay || isStartupOverlayFatalActive(startupOverlay)) { return; }
      if (!startupOverlayBackstopLogged) {
        startupOverlayBackstopLogged = true;
        appendClientLog('WARN', 'startup.curtain_backstop_dismissed', {
          state: startupOverlay.getAttribute('data-state') || 'starting',
        });
      }
      dismissStartupOverlay();
    }

    function maybeDismissStartupOverlay() {
      if (!startupBackendReady || !startupBootViewReady) { return; }
      dismissStartupOverlay();
    }

    // Success and failure both count once the restored view has a usable render.
    function notifyBootViewReady() {
      if (lifecycleControllerDisposed) { return; }
      startupBootViewReady = true;
      maybeDismissStartupOverlay();
    }

    function scheduleStartupOverlayTimers() {
      if (lifecycleControllerDisposed || startupOverlayDismissed || !startupOverlay) { return; }
      if (!startupOverlaySlowTimer && startupOverlaySlowMs > 0) {
        startupOverlaySlowTimer = setTimeout(function handleStartupOverlaySlow() {
          startupOverlaySlowTimer = 0;
          startupOverlaySlowElapsed = true;
          renderSlowState();
        }, startupOverlaySlowMs);
      }
      if (!startupOverlayBackstopTimer && startupOverlayMaxVisibleMs > 0) {
        startupOverlayBackstopTimer = setTimeout(function handleStartupOverlayBackstop() {
          startupOverlayBackstopTimer = 0;
          startupOverlayBackstopElapsed = true;
          dismissStartupOverlayForBackstop();
        }, startupOverlayMaxVisibleMs);
      }
    }

    // F2: the curtain is opaque and blocks the mouse, but nothing made the
    // background keyboard/AT-inert during a normal boot -- only the
    // fatal-error path did (presentStartupOverlayFatalError below). Mark it
    // inert as soon as the curtain is up so a nav click behind it can't
    // activate and persist a view the user never saw.
    if (startupOverlay) { setStartupOverlayBackgroundInert(startupOverlay, true); }
    scheduleStartupOverlayTimers();

    var startupCircuitTrace = startupOverlay ? setupStartupCircuitTrace(startupOverlay) : null;

    function scheduleHide(delayMs) {
      if (settleTimer) { clearTimeout(settleTimer); }
      settleTimer = setTimeout(function handleSettleHide() {
        settleTimer = 0;
        if (!state) { return; }
        var prevScenario = state.lifecycleProgress && state.lifecycleProgress.scenario;
        state.lifecycleProgress = defaultLifecycleProgress();
        var prevSource = lifecyclePillSource(prevScenario);
        if (prevSource) { clearTurnStatusPill(prevSource); }
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
      var detail = payload.detail || '';
      var stepIndex = Number(payload.stepIndex || 0);
      var stepCount = Number(payload.stepCount || 0);
      var percent = Number(payload.percent || 0);
      if (state.lifecycleProgress.active && state.lifecycleProgress.scenario === scenario) {
        percent = Math.max(percent, Number(state.lifecycleProgress.percent || 0));
      }
      var error = String(payload.error || '');
      var terminal = isTerminalPhase(scenario, phase);

      state.lifecycleProgress = {
        active: true,
        scenario: scenario,
        phase: phase,
        detail: detail,
        stepIndex: stepIndex,
        stepCount: stepCount,
        percent: terminal ? 100 : percent,
        startedAt: state.lifecycleProgress.startedAt || Date.now(),
        error: error,
      };

      if (scenario === 'startup') {
        scheduleStartupOverlayTimers();
        updateStartupOverlay(phase, error, detail, terminal ? 100 : percent);
        if (error) {
          presentStartupOverlayFatalError(startupOverlay, { onRetry: handleStartupOverlayRetryClick });
        }
      }

      publishLifecycleStatus();

      if (terminal) {
        var delay = scenario === 'shutdown' ? SHUTDOWN_SETTLE_DELAY_MS : SETTLE_DELAY_MS;
        if (error) { delay = 3000; }
        scheduleHide(delay);
        if (scenario === 'startup' && !error && phase !== 'model_unavailable') {
          clearStartupOverlayFatalError(startupOverlay);
          startupBackendReady = true;
          maybeDismissStartupOverlay();
        }
      }
    }

    function handleBackendStatus(payload) {
      if (lifecycleControllerDisposed || !payload) { return; }
      scheduleStartupOverlayTimers();
      var phase = String(payload.phase || '').trim().toLowerCase();
      var startupActive = state.lifecycleProgress.active
        && state.lifecycleProgress.scenario === 'startup';
      var lifecycle = payload.model_lifecycle || {};
      var acquisition = payload.model_acquisition || lifecycle.model_acquisition || {};
      if (phase === 'sidecar_spawned' || phase === 'model_acquiring' || phase === 'model_loading') {
        clearStartupOverlayFatalError(startupOverlay);
        var activeScenario = state.lifecycleProgress.active
          && state.lifecycleProgress.scenario === 'modelSwitch'
          ? 'modelSwitch'
          : 'startup';
        var stagePercent = phase === 'sidecar_spawned'
          ? 30
          : phase === 'model_loading'
            ? 90
            : 40 + (Math.max(0, Math.min(100, Number(acquisition.percent) || 0)) * 0.4);
        handleLifecycleProgress({
          scenario: activeScenario,
          phase: phase,
          detail: String(acquisition.status || payload.detail || STARTUP_OVERLAY_LABELS[phase] || ''),
          stepIndex: activeScenario === 'modelSwitch'
            ? (phase === 'model_loading' ? 2 : 1)
            : phase === 'sidecar_spawned' ? 2 : phase === 'model_acquiring' ? 4 : 5,
          stepCount: activeScenario === 'modelSwitch' ? MODEL_SWITCH_STEPS.length : 7,
          percent: stagePercent,
          error: '',
        });
      } else if (phase === 'model_unavailable') {
        clearStartupOverlayFatalError(startupOverlay);
        var unavailableScenario = state.lifecycleProgress.active
          && state.lifecycleProgress.scenario === 'modelSwitch'
          ? 'modelSwitch'
          : 'startup';
        handleLifecycleProgress({
          scenario: unavailableScenario,
          phase: 'model_unavailable',
          detail: 'Model failed to load. Send a message to retry, or pick another model in Settings.',
          stepIndex: unavailableScenario === 'modelSwitch' ? MODEL_SWITCH_STEPS.length - 1 : 6,
          stepCount: unavailableScenario === 'modelSwitch' ? MODEL_SWITCH_STEPS.length : 7,
          percent: 100,
          error: '',
        });
      } else if (phase === 'failed') {
        // UIUX-021: surface failures right away — don't gate behind the boot
        // view — as a modal alertdialog with a Retry affordance. Guarded on
        // the overlay still being up: a backend-status 'failed' arriving
        // after a successful boot (overlay long gone) is the running app's
        // banner/toast surface's job, not this one's.
        if (!startupOverlayDismissed && startupOverlay) {
          var failureDetail = String(payload.detail || '').trim();
          updateStartupOverlay(phase, failureDetail || 'Backend failed to start.', failureDetail, 100);
          presentStartupOverlayFatalError(startupOverlay, { onRetry: handleStartupOverlayRetryClick });
        }
      } else if (phase === 'ready' && startupActive) {
        // Delegate to the terminal startup progress event, whose terminal branch
        // already marks the backend ready and attempts a gated dismiss.
        handleLifecycleProgress({
          scenario: 'startup',
          phase: 'ready',
          detail: 'Jenny is ready',
          stepIndex: 6,
          stepCount: 7,
          percent: 100,
          error: '',
        });
      } else if (phase === 'ready') {
        // No active startup progress to delegate to — mark ready directly.
        clearStartupOverlayFatalError(startupOverlay);
        startupBackendReady = true;
        if (startupOverlayBackstopElapsed) {
          dismissStartupOverlayForBackstop();
        } else {
          maybeDismissStartupOverlay();
        }
      }
    }

    function beginModelSwitch(detail) {
      var steps = MODEL_SWITCH_STEPS;
      handleLifecycleProgress({
        scenario: 'modelSwitch',
        phase: 'reinitialize',
        detail: detail || steps[0].label,
        stepIndex: 0,
        stepCount: steps.length,
        percent: 0,
        error: '',
      });
    }

    function updateModelSwitch(phase, detail) {
      var steps = MODEL_SWITCH_STEPS;
      var idx = 0;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].key === phase) { idx = i; break; }
      }
      handleLifecycleProgress({
        scenario: 'modelSwitch',
        phase: phase,
        detail: detail || steps[idx].label,
        stepIndex: idx,
        stepCount: steps.length,
        percent: Math.round((idx / Math.max(steps.length, 1)) * 100),
        error: '',
      });
    }

    function failModelSwitch(detail) {
      var steps = MODEL_SWITCH_STEPS;
      handleLifecycleProgress({
        scenario: 'modelSwitch',
        phase: 'model_unavailable',
        detail: detail || 'Model switch failed',
        stepIndex: steps.length - 1,
        stepCount: steps.length,
        percent: 100,
        error: detail || 'Model switch failed',
      });
    }

    /* Publishes the active lifecycle scenario to the titlebar turn-status pill. */
    function publishLifecycleStatus() {
      var progress = state.lifecycleProgress;

      if (!progress.active) {
        return;
      }

      var pillSource = lifecyclePillSource(progress.scenario);
      if (!pillSource) { return; }

      var statusModel = buildLifecycleStatusModel(
        progress.scenario,
        progress.phase,
        progress.detail,
        progress.error,
        {}
      );

      var terminal = isTerminalPhase(progress.scenario, progress.phase);
      var indeterminate = !terminal && (progress.percent < 1
        || progress.phase === 'model_loading' || progress.phase === 'model_load');

      setTurnStatusPill(pillSource, {
        message: statusModel.message
          || (progress.scenario === 'shutdown' ? 'Shutting down…' : ''),
        tone: progress.error
          ? 'danger'
          : terminal
            ? 'success'
            : progress.scenario === 'shutdown'
              ? 'warning'
              : 'pending',
        spinner: !terminal && !progress.error,
        badgeText: statusModel.badgeText || '',
        indeterminate: indeterminate,
        progressPercent: indeterminate ? null : (terminal ? 100 : Math.max(progress.percent, 2)),
      });
    }

    function dispose() {
      lifecycleControllerDisposed = true;
      // A controller torn down while its overlay is still in fatal mode must
      // not leave the rest of the app permanently inert / focus stranded.
      if (isStartupOverlayFatalActive(startupOverlay)) {
        try { clearStartupOverlayFatalError(startupOverlay); } catch (_e) { /* best-effort */ }
      }
      if (settleTimer) {
        try { clearTimeout(settleTimer); } catch (_e) { /* best-effort */ }
        settleTimer = 0;
      }
      if (startupOverlaySlowTimer) {
        try { clearTimeout(startupOverlaySlowTimer); } catch (_e) { /* best-effort */ }
        startupOverlaySlowTimer = 0;
      }
      if (startupOverlayBackstopTimer) {
        try { clearTimeout(startupOverlayBackstopTimer); } catch (_e) { /* best-effort */ }
        startupOverlayBackstopTimer = 0;
      }
      if (startupOverlayRemovalTimer) {
        try { clearTimeout(startupOverlayRemovalTimer); } catch (_e) { /* best-effort */ }
        startupOverlayRemovalTimer = 0;
      }
      // Teardown while visible must stop the circuit rAF loop too.
      if (startupCircuitTrace) {
        try { startupCircuitTrace.dispose(); } catch (_e) { /* best-effort */ }
        startupCircuitTrace = null;
      }
      try { clearTurnStatusPill(PILL_SOURCES.LIFECYCLE_STARTUP); } catch (_e) { /* best-effort */ }
      try { clearTurnStatusPill(PILL_SOURCES.LIFECYCLE_SHUTDOWN); } catch (_e) { /* best-effort */ }
      try { clearTurnStatusPill(PILL_SOURCES.LIFECYCLE_MODEL_SWITCH); } catch (_e) { /* best-effort */ }
    }

    return {
      handleLifecycleProgress: handleLifecycleProgress,
      handleBackendStatus: handleBackendStatus,
      notifyBootViewReady: notifyBootViewReady,
      beginModelSwitch: beginModelSwitch,
      updateModelSwitch: updateModelSwitch,
      failModelSwitch: failModelSwitch,
      publishLifecycleStatus: publishLifecycleStatus,
      dispose: dispose,
    };
  }

  return {
    createLifecycleProgressController: createLifecycleProgressController,
    defaultLifecycleProgress: defaultLifecycleProgress,
    MODEL_SWITCH_STEPS: MODEL_SWITCH_STEPS,
    // Shared with app.js's pre-controller composition-failure guard (UIUX-021).
    presentStartupOverlayFatalError: presentStartupOverlayFatalError,
    clearStartupOverlayFatalError: clearStartupOverlayFatalError,
    isStartupOverlayFatalActive: isStartupOverlayFatalActive,
  };
});
