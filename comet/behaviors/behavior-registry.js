/* comet/behaviors/behavior-registry.js – plugin registry + engine for comet movement behaviors (UMD) */
/* global window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometBehaviorRegistryUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  var TRANSITION_DURATION = 500;

  function createBehaviorEngine(options) {
    var opts = options || {};
    var bounds = opts.bounds || { width: 800, height: 600 };
    var reducedMotionQuery = opts.reducedMotionQuery || { matches: false };

    var factories = {};
    var activeBehavior = null;
    var previousPos = { x: 0, y: 0 };
    var transitionStart = -1;
    var transitionDuration = TRANSITION_DURATION;
    var transitionFromPos = { x: 0, y: 0 };
    var fallbackBehaviorName = null;
    var baseTransitionDuration = TRANSITION_DURATION;

    function setBaseTransitionDuration(ms) {
      baseTransitionDuration = Math.max(0, Math.round(Number(ms) || TRANSITION_DURATION));
    }

    function register(name, factory) {
      if (typeof name === 'string' && typeof factory === 'function') {
        factories[name] = factory;
        if (!fallbackBehaviorName) { fallbackBehaviorName = name; }
      }
    }

    function has(name) {
      return name in factories;
    }

    function activate(name, params) {
      var factory = factories[name];
      if (!factory) {
        if (fallbackBehaviorName && factories[fallbackBehaviorName]) {
          factory = factories[fallbackBehaviorName];
        } else {
          return false;
        }
      }

      transitionFromPos.x = previousPos.x;
      transitionFromPos.y = previousPos.y;

      if (activeBehavior && typeof activeBehavior.exit === 'function') {
        activeBehavior.exit();
      }

      activeBehavior = factory(params || {});
      if (typeof activeBehavior.enter === 'function') {
        activeBehavior.enter({ x: previousPos.x, y: previousPos.y });
      }

      transitionStart = -1;
      transitionDuration = reducedMotionQuery.matches ? 0 : baseTransitionDuration;
      return true;
    }

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function update(dt, ctx) {
      if (!activeBehavior || typeof activeBehavior.update !== 'function') {
        return previousPos;
      }

      var fullCtx = {
        mouseX: ctx.mouseX || 0,
        mouseY: ctx.mouseY || 0,
        bounds: ctx.bounds || bounds,
        currentPos: { x: previousPos.x, y: previousPos.y },
      };

      var target = activeBehavior.update(dt, fullCtx);
      if (!target) { return previousPos; }

      if (transitionStart < 0) {
        transitionStart = 0;
      }

      var result;
      if (transitionDuration > 0 && transitionStart < transitionDuration) {
        transitionStart += dt;
        var t = Math.min(1, transitionStart / transitionDuration);
        var ease = easeInOutCubic(t);
        result = {
          x: transitionFromPos.x + (target.x - transitionFromPos.x) * ease,
          y: transitionFromPos.y + (target.y - transitionFromPos.y) * ease,
        };
      } else {
        result = target;
      }

      previousPos.x = result.x;
      previousPos.y = result.y;
      return result;
    }

    function getActive() {
      return activeBehavior ? activeBehavior.name || null : null;
    }

    function setPosition(x, y) {
      if (typeof x === 'number' && isFinite(x)) {
        previousPos.x = x;
      }
      if (typeof y === 'number' && isFinite(y)) {
        previousPos.y = y;
      }
    }

    function dispose() {
      if (activeBehavior && typeof activeBehavior.exit === 'function') {
        activeBehavior.exit();
      }
      activeBehavior = null;
      factories = {};
      fallbackBehaviorName = null;
    }

    function getActiveBehaviorInstance() {
      return activeBehavior || null;
    }

    return {
      register: register,
      has: has,
      activate: activate,
      update: update,
      getActive: getActive,
      setPosition: setPosition,
      setBaseTransitionDuration: setBaseTransitionDuration,
      dispose: dispose,
      getActiveBehaviorInstance: getActiveBehaviorInstance,
    };
  }

  return { createBehaviorEngine: createBehaviorEngine };
});
