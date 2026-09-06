/* comet/index.js – orchestrator for comet personality system (UMD) */
/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometModule = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var _g = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});

  /* ── sub-module references (set by script load order) ── */
  var cometUtils = _g.rendererCometUtils || null;
  var cometDomUtils = _g.cometDomUtils || null;
  var behaviorRegistryUtils = _g.cometBehaviorRegistryUtils || null;
  var personalityUtils = _g.rendererCometPersonalityUtils || null;

  /* behavior plugins — each may or may not be loaded */
  var idleDriftPlugin = _g.cometBehaviorIdleDrift || null;
  var settlePlugin = _g.cometBehaviorSettle || null;
  var followCursorPlugin = _g.cometBehaviorFollowCursor || null;
  var alertPlugin = _g.cometBehaviorAlert || null;
  var excitedPlugin = _g.cometBehaviorExcited || null;
  var anchoredOrbitPlugin = _g.cometBehaviorAnchoredOrbit || null;

  /* ── module state ── */
  var _instance = null;

  function isCometEnabled(state) {
    if (state && state.features && state.features.featureFlags) {
      return state.features.featureFlags.comet_personality === true;
    }
    return false;
  }

  function registerBehaviorPlugins(engine) {
    if (idleDriftPlugin && idleDriftPlugin.createIdleDrift) {
      engine.register('idle-drift', idleDriftPlugin.createIdleDrift);
    }
    if (settlePlugin && settlePlugin.createSettle) {
      engine.register('settle', settlePlugin.createSettle);
    }
    if (followCursorPlugin && followCursorPlugin.createFollowCursor) {
      engine.register('follow-cursor', followCursorPlugin.createFollowCursor);
    }
    if (alertPlugin && alertPlugin.createAlert) {
      engine.register('alert', alertPlugin.createAlert);
    }
    if (excitedPlugin && excitedPlugin.createExcited) {
      engine.register('excited', excitedPlugin.createExcited);
    }
    if (anchoredOrbitPlugin && anchoredOrbitPlugin.createAnchoredOrbit) {
      engine.register('anchored-orbit', anchoredOrbitPlugin.createAnchoredOrbit);
    }
  }

  function registerPersonalityPalettes(comet) {
    if (!personalityUtils || !personalityUtils.PERSONALITY_PALETTES) return;
    var palettes = personalityUtils.PERSONALITY_PALETTES;
    for (var name in palettes) {
      if (Object.prototype.hasOwnProperty.call(palettes, name)) {
        comet.registerPalette(name, palettes[name]);
      }
    }
  }

  /* ── factory: creates an independent comet instance ── */
  function createCometInstance(deps) {
    var reducedMotionQuery = deps.reducedMotionQuery || { matches: false };
    var dom = deps.dom || {};
    var callbacks = deps.callbacks || {};
    var container = deps.container;
    var manualClock = deps.manualClock === true;

    if (!cometUtils || !cometDomUtils || !behaviorRegistryUtils || !personalityUtils) {
      return null;
    }

    var domLayer = cometDomUtils.createCometDomLayer(container);
    if (!domLayer) return null;
    var layerEl = domLayer.getElement();

    var comet = cometUtils.createComet(layerEl, {
      reducedMotionQuery: reducedMotionQuery,
      manualClock: manualClock,
    });
    registerPersonalityPalettes(comet);

    var containerRect = layerEl.getBoundingClientRect
      ? layerEl.getBoundingClientRect()
      : { width: 800, height: 600 };
    var behaviorEngine = behaviorRegistryUtils.createBehaviorEngine({
      bounds: { width: containerRect.width, height: containerRect.height },
      reducedMotionQuery: reducedMotionQuery,
    });
    registerBehaviorPlugins(behaviorEngine);

    var personality = personalityUtils.createCometPersonality({
      behaviorEngine: behaviorEngine,
      comet: comet,
      container: layerEl,
      inferSentiment: callbacks.inferSentimentFromText || null,
      onStateChange: callbacks.onStateChange || null,
      reducedMotionQuery: reducedMotionQuery,
      dom: dom,
      manualClock: manualClock,
    });

    comet.start();
    personality.bind();
    domLayer.show();

    var instanceDisposed = false;
    return {
      onStreamEvent: function (event) { personality?.onStreamEvent(event); },
      onSentiment: function (expression) { personality?.onSentiment(expression); },
      onUserAction: function (action) { personality?.onUserAction(action); },
      dispose: function () {
        if (instanceDisposed) return;
        instanceDisposed = true;
        if (personality) { personality.dispose(); personality = null; }
        if (behaviorEngine) { behaviorEngine.dispose(); behaviorEngine = null; }
        if (comet) { comet.dispose(); comet = null; }
        if (domLayer) { domLayer.dispose(); domLayer = null; }
      },
    };
  }

  function bootstrapComet(deps) {
    if (_instance) return null;
    if (!isCometEnabled(deps.state)) return null;

    _instance = createCometInstance({
      state: deps.state,
      reducedMotionQuery: deps.reducedMotionQuery,
      dom: deps.dom,
      callbacks: deps.callbacks,
      container: deps.dom?.workspace,
      manualClock: true,
    });

    return _instance;
  }

  function disposeComet() {
    if (_instance) { _instance.dispose(); _instance = null; }
  }

  return {
    bootstrapComet: bootstrapComet,
    disposeComet: disposeComet,
    createCometInstance: createCometInstance,
  };
});
