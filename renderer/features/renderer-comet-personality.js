/* renderer/features/renderer-comet-personality.js – state machine mapping Jenny state to comet behavior + palette (UMD) */
/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../chat/renderer-turn-phase'));
    return;
  }
  root.rendererCometPersonalityUtils = factory(root.rendererTurnPhase || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnPhaseUtils) {
  var globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  var documentRef = globalRef.document || null;
  var ResizeObserverRef = typeof globalRef.ResizeObserver === 'function' ? globalRef.ResizeObserver : null;
  var MutationObserverRef = typeof globalRef.MutationObserver === 'function' ? globalRef.MutationObserver : null;

  /* ── personality palettes (registered on comet at bootstrap) ── */
  var PERSONALITY_PALETTES = {
    idle:      [{ r: 180, g: 210, b: 255 }, { r: 140, g: 180, b: 240 }, { r: 200, g: 220, b: 255 }],
    listening: [{ r: 120, g: 200, b: 240 }, { r: 170, g: 160, b: 255 }, { r: 140, g: 210, b: 255 }],
    happy:     [{ r: 100, g: 230, b: 140 }, { r: 220, g: 210, b: 80 }, { r: 140, g: 250, b: 170 }],
    concerned: [{ r: 240, g: 160, b: 80 }, { r: 220, g: 120, b: 100 }, { r: 255, g: 180, b: 100 }],
    alert:     [{ r: 255, g: 200, b: 100 }, { r: 255, g: 160, b: 80 }, { r: 240, g: 220, b: 120 }],
  };

  /* ── state definitions: state → { behavior, palette, tailLength, speed } ── */
  var STATE_CONFIGS = {
    idle:       { behavior: 'idle-drift',  palette: 'idle',       tailLength: 30, speed: 1,   scale: 0.85 },
    listening:  { behavior: 'settle',      palette: 'listening',  tailLength: 25, speed: 0.8, scale: 0.9 },
    thinking:   { behavior: 'anchored-orbit', palette: 'thinking',   tailLength: 50, speed: 1,   scale: 1.0 },
    responding: { behavior: 'settle',        palette: 'responding', tailLength: 40, speed: 1,   scale: 1.0 },
    'tool-use': { behavior: 'anchored-orbit', palette: 'tool-use',  tailLength: 50, speed: 1.2, scale: 1.1 },
    alert:      { behavior: 'alert',       palette: 'alert',      tailLength: 45, speed: 1.5, scale: 1.3 },
    happy:      { behavior: 'excited',     palette: 'happy',      tailLength: 50, speed: 1.3, scale: 1.2 },
    concerned:  { behavior: 'idle-drift',  palette: 'concerned',  tailLength: 20, speed: 0.5, scale: 0.7 },
  };

  var FALLBACK_STATE = 'idle';
  var TYPING_DEBOUNCE_MS = 1500;   /* covers natural inter-word pauses */
  var TYPING_ENTER_DELAY_MS = 150; /* delay before entering listening, absorbs mid-transition re-entry */
  var BLUR_IDLE_DELAY_MS = 600;    /* delay before returning idle on blur, absorbs transient focus steals */
  var HAPPY_DURATION_MS = 2500;
  var ALERT_DURATION_MS = 1500;

  /* ── sentiment expression → personality state mapping ── */
  var SENTIMENT_STATE_MAP = {
    warm:      'happy',
    concerned: 'concerned',
    focused:   'thinking',
    confused:  'idle',
    idle:      'idle',
  };
  var phaseKindToPresenceState = typeof turnPhaseUtils.phaseKindToPresenceState === 'function'
    ? turnPhaseUtils.phaseKindToPresenceState
    : null;

  function normalizePresenceEvent(event) {
    if (event && typeof event === 'object' && !Array.isArray(event)) {
      return {
        type: String(event.type || event.state || '').trim().toLowerCase(),
        phaseKind: String(event.phaseKind || event.phase_kind || '').trim().toLowerCase(),
        terminalStatus: String(event.terminalStatus || event.terminal_status || '').trim().toLowerCase(),
        externalState: typeof event === 'object' && event !== null
          ? String(event.state || '').trim().toLowerCase()
          : '',
      };
    }
    return {
      type: String(event || '').trim().toLowerCase(),
      phaseKind: '',
      terminalStatus: '',
      externalState: '',
    };
  }

  function getContainerBounds(containerRect) {
    return {
      width: containerRect.width || 800,
      height: containerRect.height || 600,
    };
  }

  function getAmbientHome(bounds) {
    return {
      x: bounds.width * 0.3,
      y: bounds.height * 0.4,
    };
  }

  function projectAnchorRect(rect, containerRect) {
    return {
      x: Math.max(20, (rect.left + rect.width / 2) - containerRect.left),
      y: Math.max(20, (rect.top + rect.height * 0.3) - containerRect.top),
    };
  }

  function getAmbientEnvelope(stateName, bounds) {
    var home = getAmbientHome(bounds);
    if (stateName === 'concerned') {
      return {
        centerX: home.x,
        centerY: home.y,
        rangeX: Math.max(56, bounds.width * 0.10),
        rangeY: Math.max(40, bounds.height * 0.08),
      };
    }
    return {
      centerX: home.x,
      centerY: home.y,
      rangeX: Math.max(96, bounds.width * 0.18),
      rangeY: Math.max(72, bounds.height * 0.14),
    };
  }

  function isOriginLikePosition(pos) {
    return pos
      && isFinite(pos.x)
      && isFinite(pos.y)
      && Math.abs(pos.x) < 1
      && Math.abs(pos.y) < 1;
  }

  function seedBehaviorEnginePosition(behaviorEngine, comet, fallbackPos) {
    if (!behaviorEngine || typeof behaviorEngine.setPosition !== 'function') {
      return;
    }
    var headPos = comet && typeof comet.getHeadPosition === 'function'
      ? comet.getHeadPosition()
      : null;
    var nextPos = headPos && isFinite(headPos.x) && isFinite(headPos.y) && !isOriginLikePosition(headPos)
      ? headPos
      : fallbackPos;
    if (nextPos && isFinite(nextPos.x) && isFinite(nextPos.y)) {
      behaviorEngine.setPosition(nextPos.x, nextPos.y);
    }
  }

  function createCometPersonality(deps) {
    var behaviorEngine = deps.behaviorEngine;
    var comet = deps.comet;
    var container = deps.container;
    var inferSentiment = deps.inferSentiment || null;
    var reducedMotionQuery = deps.reducedMotionQuery || { matches: false };
    var onStateChange = deps.onStateChange || null;
    var dom = deps.dom || {};
    var scheduler = deps.scheduler || {};
    var manualClock = deps.manualClock === true;
    var setTimer = typeof scheduler.setTimeout === 'function' ? scheduler.setTimeout.bind(scheduler) : setTimeout;
    var clearTimer = typeof scheduler.clearTimeout === 'function' ? scheduler.clearTimeout.bind(scheduler) : clearTimeout;
    var requestFrame = typeof scheduler.requestAnimationFrame === 'function'
      ? scheduler.requestAnimationFrame.bind(scheduler)
      : globalRef.requestAnimationFrame;
    var cancelFrame = typeof scheduler.cancelAnimationFrame === 'function'
      ? scheduler.cancelAnimationFrame.bind(scheduler)
      : globalRef.cancelAnimationFrame;
    var visibilityProvider = deps.visibilityProvider || (documentRef
      ? {
        shouldRun: function () {
          return documentRef.visibilityState !== 'hidden' && (!container || container.isConnected !== false);
        },
        subscribe: function (callback) {
          if (typeof documentRef.addEventListener !== 'function') return function () {};
          documentRef.addEventListener('visibilitychange', callback);
          return function unsubscribeVisibility() {
            documentRef.removeEventListener('visibilitychange', callback);
          };
        },
      }
      : null);

    var currentState = 'idle';
    var previousState = null;
    var typingTimer = null;
    var typingEnterTimer = null;
    var blurTimer = null;
    var transientTimer = null;
    var bound = false;
    var mouseX = 0;
    var mouseY = 0;
    var rafId = null;
    var lastTime = 0;
    var disposed = false;
    var cachedBounds = null;
    var engineSeeded = false;

    /* cache comet capability checks once at init (object never changes) */
    var hasSetVisualScale = typeof comet.setVisualScale === 'function';

    /* ── event handlers (stored for unbind) ── */
    var _onMouseMove = null;
    var _onComposerInput = null;
    var _onComposerBlur = null;
    var _resizeObserver = null;
    var visibilityUnsubscribe = null;

    /* ── motion preset scaling ── */
    var MOTION_SCALES = {
      standard:   { transition: 1.0, approach: 1.0 },
      calm:       { transition: 1.3, approach: 0.7 },
      expressive: { transition: 0.7, approach: 1.4 },
    };
    var BASE_TRANSITION_DURATION = 500;
    var BASE_APPROACH_RATE = 0.006;
    var _motionObserver = null;

    function getActiveMotionPreset() {
      var root = documentRef ? documentRef.documentElement : null;
      return (root && root.dataset && root.dataset.motion) || 'standard';
    }

    function applyMotionScaling() {
      var preset = getActiveMotionPreset();
      var scale = MOTION_SCALES[preset] || MOTION_SCALES.standard;
      if (typeof behaviorEngine.setBaseTransitionDuration === 'function') {
        behaviorEngine.setBaseTransitionDuration(Math.round(BASE_TRANSITION_DURATION * scale.transition));
      }
    }

    function getScaledApproachRate() {
      var preset = getActiveMotionPreset();
      var scale = MOTION_SCALES[preset] || MOTION_SCALES.standard;
      return BASE_APPROACH_RATE * scale.approach;
    }

    function getContainerRect() {
      return container ? container.getBoundingClientRect() : { width: 800, height: 600, top: 0, left: 0 };
    }

    function getActiveAnchor(stateName, containerRect) {
      return getSettleAnchor(stateName, containerRect);
    }

    function applyStateConfig(stateName) {
      var config = STATE_CONFIGS[stateName] || STATE_CONFIGS[FALLBACK_STATE];
      comet.setColorPalette(config.palette);
      comet.setTailLength(config.tailLength);
      comet.setSpeed(config.speed);
      if (hasSetVisualScale) { comet.setVisualScale(config.scale || 1); }
      var containerRect = getContainerRect();
      var bounds = getContainerBounds(containerRect);
      cachedBounds = bounds;

      /* settle-to-settle optimization: update anchor without engine re-activation */
      var prevConfig = previousState ? STATE_CONFIGS[previousState] : null;
      if (prevConfig && prevConfig.behavior === 'settle' && config.behavior === 'settle') {
        var nextAnchor = getActiveAnchor(stateName, containerRect);
        var activeInstance = behaviorEngine.getActiveBehaviorInstance
          ? behaviorEngine.getActiveBehaviorInstance()
          : null;
        if (activeInstance && typeof activeInstance.setAnchor === 'function') {
          activeInstance.setAnchor(nextAnchor.x, nextAnchor.y);
          if (reducedMotionQuery.matches) {
            comet.setPosition(nextAnchor.x, nextAnchor.y);
          }
          return;
        }
      }

      /* default path: full re-activation with engine-level 500ms transition */
      var ambientHome = getAmbientHome(bounds);
      if (behaviorEngine.has(config.behavior)) {
        var behaviorParams = buildBehaviorParams(stateName, config, containerRect);
        seedBehaviorEnginePosition(behaviorEngine, comet, ambientHome);
        engineSeeded = true;
        behaviorEngine.activate(config.behavior, behaviorParams);
      } else if (behaviorEngine.has('idle-drift')) {
        seedBehaviorEnginePosition(behaviorEngine, comet, ambientHome);
        engineSeeded = true;
        behaviorEngine.activate('idle-drift', buildBehaviorParams(FALLBACK_STATE, STATE_CONFIGS[FALLBACK_STATE], containerRect));
      }
      /* clear stale tail history so the old trail doesn't streak across screen to the new position */
      if (typeof comet.clearTail === 'function') { comet.clearTail(); }

      /* reduced-motion: jump comet directly to anchor since RAF loop is not running */
      if (reducedMotionQuery.matches) {
        var rmAnchor = getActiveAnchor(stateName, containerRect);
        comet.setPosition(rmAnchor.x, rmAnchor.y);
      }
    }

    function buildBehaviorParams(stateName, config, containerRect) {
      var bounds = getContainerBounds(containerRect);

      if (config.behavior === 'settle') {
        var anchor = getActiveAnchor(stateName, containerRect);
        return { anchorX: anchor.x, anchorY: anchor.y, hoverRadius: 10, approachRate: getScaledApproachRate() };
      }
      if (config.behavior === 'anchored-orbit') {
        var orbitAnchor = getActiveAnchor(stateName, containerRect);
        return { anchorX: orbitAnchor.x, anchorY: orbitAnchor.y, radiusX: 40, radiusY: 25, speed: config.speed };
      }
      if (config.behavior === 'alert') {
        var alertAnchor = getSettleAnchor('responding', containerRect);
        return { targetX: alertAnchor.x, targetY: alertAnchor.y };
      }
      if (config.behavior === 'excited') {
        return { centerX: bounds.width * 0.3, centerY: bounds.height * 0.4, intensity: 1 };
      }
      if (config.behavior === 'idle-drift') {
        var ambientEnvelope = getAmbientEnvelope(stateName, bounds);
        return {
          bounds: bounds,
          centerX: ambientEnvelope.centerX,
          centerY: ambientEnvelope.centerY,
          rangeX: ambientEnvelope.rangeX,
          rangeY: ambientEnvelope.rangeY,
        };
      }
      return { bounds: bounds };
    }

    var STATE_ANCHOR_MAP = {
      idle: 'hero',
      listening: 'composer',
      thinking: 'orbit-header',
      responding: 'composer',
      'tool-use': 'orbit-header',
      alert: 'hero',
      happy: 'composer',
      concerned: 'hero',
    };

    function getSettleAnchor(stateName, containerRect) {
      /* query dock-anchor elements first */
      var preferredAnchor = STATE_ANCHOR_MAP[stateName] || 'composer';
      if (documentRef && typeof documentRef.querySelector === 'function') {
        var anchorEl = documentRef.querySelector('[data-dock-anchor="' + preferredAnchor + '"]');
        if (anchorEl) {
          var rect = anchorEl.getBoundingClientRect();
          /* skip collapsed/hidden anchor elements (e.g. context panel when closed) */
          if (rect.width > 0 || rect.height > 0) {
            /* for composer-anchored states, settle beside the input field rather than
               the center of the full-width wrapper div */
            if (preferredAnchor === 'composer' && dom.chatInput) {
              var inputRect = dom.chatInput.getBoundingClientRect();
              if (inputRect.width > 0) {
                return {
                  x: Math.max(20, inputRect.left - containerRect.left - 24),
                  y: Math.max(20, inputRect.top - containerRect.top + inputRect.height / 2),
                };
              }
            }
            return projectAnchorRect(rect, containerRect);
          }
        }
      }
      /* fallback: settle near contextually relevant UI areas */
      if (stateName === 'listening' && dom.chatInput) {
        var composerInputRect = dom.chatInput.getBoundingClientRect();
        return {
          x: Math.max(20, composerInputRect.left - containerRect.left - 28),
          y: composerInputRect.top - containerRect.top + composerInputRect.height / 2,
        };
      }
      if (stateName === 'responding' && dom.chatThreadScroll) {
        var threadRect = dom.chatThreadScroll.getBoundingClientRect();
        return {
          x: threadRect.left - containerRect.left + 30,
          y: threadRect.top - containerRect.top + threadRect.height - 60,
        };
      }
      /* default: left-center of container */
      return { x: 60, y: containerRect.height * 0.4 };
    }

    function setState(name) {
      if (disposed) return;
      var resolved = STATE_CONFIGS[name] ? name : FALLBACK_STATE;
      if (resolved === currentState) return;

      clearTransientTimer();
      previousState = currentState;
      currentState = resolved;
      applyStateConfig(resolved);

      if (onStateChange) { onStateChange(resolved, previousState); }
    }

    function clearTransientTimer() {
      if (transientTimer) {
        clearTimer(transientTimer);
        transientTimer = null;
      }
    }

    function resolveTransientReturnState(options, current) {
      if (options && typeof options.returnToState === 'string' && options.returnToState) {
        return STATE_CONFIGS[options.returnToState] ? options.returnToState : FALLBACK_STATE;
      }
      return current;
    }

    function setTransientState(name, durationMs, options) {
      clearTransientTimer();
      var returnTo = resolveTransientReturnState(options, currentState);
      setState(name);
      transientTimer = setTimer(function () {
        transientTimer = null;
        setState(returnTo === name ? FALLBACK_STATE : returnTo);
      }, durationMs);
    }

    /* ── public API ── */

    function onStreamEvent(event) {
      if (disposed) return;
      var presence = normalizePresenceEvent(event);
      var type = presence.type;
      var externalState = presence.externalState && STATE_CONFIGS[presence.externalState]
        ? presence.externalState
        : '';
      var isTerminalType = type === 'complete' || type === 'done' || type === 'chat.done'
        || type === 'error' || type === 'chat.error';
      if (externalState) {
        if (isTerminalType && externalState !== 'idle') {
          setTransientState(externalState, HAPPY_DURATION_MS, { returnToState: FALLBACK_STATE });
          return;
        }
        setState(externalState);
        return;
      }
      if (type === 'phase_started') {
        var phasePresence = phaseKindToPresenceState
          ? phaseKindToPresenceState(presence.phaseKind)
          : '';
        if (phasePresence && STATE_CONFIGS[phasePresence]) {
          setState(phasePresence);
        }
        return;
      }
      if (type === 'thinking')    { setState('thinking'); }
      else if (type === 'responding' || type === 'delta') { setState('responding'); }
      else if (type === 'tool-use' || type === 'tool.executing' || type === 'tool_use') { setState('tool-use'); }
      else if (type === 'tool_approval_needed') { setState('alert'); }
      else if (type === 'complete' || type === 'done' || type === 'chat.done') {
        if (presence.terminalStatus === 'cancelled' || presence.terminalStatus === 'preempted') {
          setState('idle');
          return;
        }
        setTransientState('happy', HAPPY_DURATION_MS, { returnToState: FALLBACK_STATE });
      }
      else if (type === 'error' || type === 'chat.error') {
        if (presence.terminalStatus === 'cancelled' || presence.terminalStatus === 'preempted') {
          setState('idle');
          return;
        }
        setTransientState('concerned', HAPPY_DURATION_MS, { returnToState: FALLBACK_STATE });
      }
    }

    function onSentiment(expression) {
      if (disposed) return;
      /* only react to sentiment when idle; active/listening states are arbiter-owned */
      if (currentState !== 'idle') return;
      var mapped = SENTIMENT_STATE_MAP[expression] || null;
      if (mapped && mapped !== currentState) {
        setTransientState(mapped, HAPPY_DURATION_MS);
      }
    }

    function onUserAction(action) {
      if (disposed) return;
      if (action === 'typing') {
        /* keystroke cancels any pending blur-to-idle */
        if (blurTimer) { clearTimer(blurTimer); blurTimer = null; }

        /* deferred entry into listening — prevents snap during mid-transition re-entry.
           also interrupts personality transients (happy, concerned, alert, sentiment)
           but NOT AI states (thinking/responding/tool-use), which have no transientTimer. */
        if ((currentState === 'idle' || transientTimer !== null) && !typingEnterTimer) {
          typingEnterTimer = setTimer(function () {
            typingEnterTimer = null;
            if (currentState === 'idle' || transientTimer !== null) { setState('listening'); }
          }, TYPING_ENTER_DELAY_MS);
        }

        /* reset exit debounce on every keystroke */
        if (typingTimer) { clearTimer(typingTimer); }
        typingTimer = setTimer(function () {
          typingTimer = null;
          if (currentState === 'listening') { setState('idle'); }
        }, TYPING_DEBOUNCE_MS);
      }
      else if (action === 'blur-composer') {
        /* cancel pending entry — blurred before committing to listening */
        if (typingEnterTimer) { clearTimer(typingEnterTimer); typingEnterTimer = null; }
        if (typingTimer) { clearTimer(typingTimer); typingTimer = null; }
        /* delay idle return to absorb transient focus steals (button clicks, etc.) */
        if (currentState === 'listening' && !blurTimer) {
          blurTimer = setTimer(function () {
            blurTimer = null;
            if (currentState === 'listening') { setState('idle'); }
          }, BLUR_IDLE_DELAY_MS);
        }
      }
      else if (action === 'new-message') {
        if (currentState === 'idle') {
          setTransientState('alert', ALERT_DURATION_MS);
        }
      }
    }

    function getState() {
      return currentState;
    }

    /* ── animation loop: drives behavior engine → comet position ── */

    function shouldRunLoop() {
      if (disposed || reducedMotionQuery.matches || typeof requestFrame !== 'function') return false;
      if (visibilityProvider && typeof visibilityProvider.shouldRun === 'function') {
        return visibilityProvider.shouldRun() !== false;
      }
      if (documentRef && documentRef.visibilityState === 'hidden') return false;
      if (container && container.isConnected === false) return false;
      return true;
    }

    function tick(timestamp) {
      if (disposed) return;
      rafId = null;
      if (!shouldRunLoop()) return;
      if (!lastTime) { lastTime = timestamp; }
      var dt = Math.min(timestamp - lastTime, 100);
      lastTime = timestamp;

      var bounds = cachedBounds || getContainerBounds(getContainerRect());
      var pos = behaviorEngine.update(dt, {
        mouseX: mouseX,
        mouseY: mouseY,
        bounds: bounds,
      });
      if (pos) { comet.setPosition(pos.x, pos.y); }
      if (manualClock && typeof comet.step === 'function') {
        comet.step(timestamp);
      }

      rafId = requestFrame(tick);
    }

    function startLoop() {
      if (rafId || disposed) return;
      if (!shouldRunLoop()) return;
      lastTime = 0;
      rafId = requestFrame(tick);
    }

    function stopLoop() {
      if (rafId) {
        if (typeof cancelFrame === 'function') { cancelFrame(rafId); }
        rafId = null;
      }
    }

    function handleVisibilityChange() {
      if (!bound || disposed) return;
      if (shouldRunLoop()) {
        startLoop();
      } else {
        stopLoop();
      }
    }

    /* ── DOM event binding ── */

    function bind() {
      if (bound || disposed) return;
      bound = true;

      _onMouseMove = function (e) {
        var rect = container ? container.getBoundingClientRect() : { left: 0, top: 0 };
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
      };

      _onComposerInput = function () {
        onUserAction('typing');
      };

      _onComposerBlur = function () {
        onUserAction('blur-composer');
      };

      if (container) {
        container.addEventListener('mousemove', _onMouseMove, { passive: true });
        if (ResizeObserverRef) {
          _resizeObserver = new ResizeObserverRef(function () {
            cachedBounds = getContainerBounds(getContainerRect());
          });
          _resizeObserver.observe(container);
        }
      }
      if (dom.chatInput) {
        dom.chatInput.addEventListener('input', _onComposerInput, { passive: true });
        dom.chatInput.addEventListener('blur', _onComposerBlur, { passive: true });
      }

      applyStateConfig(currentState);
      applyMotionScaling();
      if (MutationObserverRef && documentRef) {
        _motionObserver = new MutationObserverRef(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            if (mutations[i].attributeName === 'data-motion') {
              applyMotionScaling();
              break;
            }
          }
        });
        _motionObserver.observe(documentRef.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
      }
      if (!visibilityUnsubscribe && visibilityProvider && typeof visibilityProvider.subscribe === 'function') {
        visibilityUnsubscribe = visibilityProvider.subscribe(handleVisibilityChange) || null;
      }
      startLoop();
    }

    /* ── live reduced-motion preference listener ── */
    function handleReducedMotionChange(e) {
      if (e.matches) {
        stopLoop();
        var anchor = getActiveAnchor(currentState, getContainerRect());
        comet.setPosition(anchor.x, anchor.y);
      } else {
        startLoop();
      }
    }

    if (reducedMotionQuery.addEventListener) {
      reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
    }

    function unbind() {
      if (!bound) return;
      bound = false;
      stopLoop();

      if (container && _onMouseMove) { container.removeEventListener('mousemove', _onMouseMove); }
      if (_resizeObserver) { _resizeObserver.disconnect(); _resizeObserver = null; }
      if (_motionObserver) { _motionObserver.disconnect(); _motionObserver = null; }
      if (visibilityUnsubscribe) { visibilityUnsubscribe(); visibilityUnsubscribe = null; }
      if (dom.chatInput) {
        if (_onComposerInput) { dom.chatInput.removeEventListener('input', _onComposerInput); }
        if (_onComposerBlur) { dom.chatInput.removeEventListener('blur', _onComposerBlur); }
      }

      _onMouseMove = null;
      _onComposerInput = null;
      _onComposerBlur = null;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (reducedMotionQuery.removeEventListener) {
        reducedMotionQuery.removeEventListener('change', handleReducedMotionChange);
      }
      if (_motionObserver) { _motionObserver.disconnect(); _motionObserver = null; }
      unbind();
      clearTransientTimer();
      if (typingTimer) { clearTimer(typingTimer); typingTimer = null; }
      if (typingEnterTimer) { clearTimer(typingEnterTimer); typingEnterTimer = null; }
      if (blurTimer) { clearTimer(blurTimer); blurTimer = null; }
    }

    return {
      setState: setState,
      getState: getState,
      onStreamEvent: onStreamEvent,
      onSentiment: onSentiment,
      onUserAction: onUserAction,
      bind: bind,
      unbind: unbind,
      dispose: dispose,
    };
  }

  return {
    createCometPersonality: createCometPersonality,
    PERSONALITY_PALETTES: PERSONALITY_PALETTES,
    STATE_CONFIGS: STATE_CONFIGS,
  };
});
