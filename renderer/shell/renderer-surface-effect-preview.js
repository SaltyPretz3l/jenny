/* renderer/shell/renderer-surface-effect-preview.js
 *
 * The Settings Appearance preview owns exactly one live controller and
 * disposes it when hidden, replaced, or itself disposed. */
/* global document, window */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSurfaceEffectPreview = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var HOST_CLASS = 'surface-effect-preview';
  var EMPTY_CLASS = 'surface-effect-preview-empty';
  var EMPTY_LABEL = 'No background effect';

  // Deliberately mirrors the effectId -> factory maps in renderer/app.js and
  // renderer-surface-gallery-utils.js: each surface re-reads the globals it
  // owns rather than importing another surface's wiring.
  function resolveFactory(windowRef, effectId) {
    var modules = {
      'reactive-grid': ['rendererReactiveGridUtils', 'createReactiveGridController'],
      'playlist-scroll': ['rendererPlaylistScrollUtils', 'createPlaylistScrollController'],
      'atomic-burst': ['rendererAtomicBurstUtils', 'createAtomicBurstController'],
      'circuit-trace': ['rendererCircuitTraceUtils', 'createCircuitTraceController'],
      'context-weave': ['rendererContextWeaveUtils', 'createContextWeaveController'],
    };
    var entry = modules[effectId];
    if (!entry || !windowRef) { return null; }
    var moduleRef = windowRef[entry[0]];
    var factory = moduleRef && moduleRef[entry[1]];
    return typeof factory === 'function' ? factory : null;
  }

  function readRect(element) {
    if (element && typeof element.getBoundingClientRect === 'function') {
      var rect = element.getBoundingClientRect();
      return {
        left: rect.left || 0, top: rect.top || 0,
        width: rect.width || 0, height: rect.height || 0,
      };
    }
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  // Copied in shape from renderer-surface-gallery-utils.js buildBindContext():
  // one host, the host rect doubling as the scene rect, and no manager-owned
  // occlusion or avoidance regions to project.
  function buildBindContext(host) {
    var rect = readRect(host);
    return {
      generation: 1,
      staged: false,
      surface: 'chat',
      hosts: [{ element: host, role: 'chat-left' }],
      layout: {
        revision: 1,
        sceneRect: rect,
        hostRects: [rect],
        interactionBlockRects: [],
        paintOcclusionRects: [],
        spawnAvoidanceRects: [],
      },
    };
  }

  function createSurfaceEffectPreview(options) {
    var opts = options || {};
    var windowRef = opts.windowRef || (typeof window !== 'undefined' ? window : null);
    var documentRef = opts.documentRef
      || (windowRef && windowRef.document)
      || (typeof document !== 'undefined' ? document : null);
    var reducedMotionQuery = opts.reducedMotionQuery || null;
    var controller = null;
    var currentEffectId = '';
    var currentHost = null;
    var removeListeners = function noop() {};
    var disposed = false;

    function detachListeners() {
      removeListeners();
      removeListeners = function noop() {};
    }

    function disposeController() {
      detachListeners();
      if (controller && typeof controller.dispose === 'function') {
        try { controller.dispose(); } catch (_disposeErr) { /* a broken controller must not wedge Settings */ }
      }
      controller = null;
      currentEffectId = '';
    }

    function degradePreview(host, phase) {
      disposeController();
      showEmptyLabel(host);
      try {
        if (windowRef && windowRef.console && typeof windowRef.console.warn === 'function') {
          windowRef.console.warn('[surface-effect-preview] ' + phase + ' failed');
        }
      } catch (_warningErr) { /* diagnostics must not wedge Settings */ }
      return null;
    }

    // The contract's no-own-listeners invariant binds CONTROLLERS, not
    // harnesses: the preview owns its host, so it forwards its own pointer
    // events rather than weakening that rule. `data-surface-input-block` keeps
    // the app-wide router from also forwarding them to the live effect.
    function attachListeners(host) {
      if (!host || typeof host.addEventListener !== 'function') { return; }
      function forward(type) {
        return function handlePointerEvent(event) {
          if (!controller || typeof controller.handleInput !== 'function') { return; }
          var rect = readRect(host);
          var localX = (event.clientX || 0) - rect.left;
          var localY = (event.clientY || 0) - rect.top;
          controller.handleInput({
            type: type,
            pointerId: Number.isFinite(event.pointerId) ? event.pointerId : 1,
            pointerType: event.pointerType || 'mouse',
            isPrimary: event.isPrimary !== false,
            buttons: event.buttons || 0,
            pressure: Number.isFinite(event.pressure) ? event.pressure : 0,
            timeStamp: Number.isFinite(event.timeStamp) ? event.timeStamp : 0,
            clientX: event.clientX || 0,
            clientY: event.clientY || 0,
            surfaceRole: 'chat-left',
            localX: localX, localY: localY, sceneX: localX, sceneY: localY,
            generation: 1,
          });
        };
      }
      var bindings = [
        ['pointerenter', forward('enter')],
        ['pointermove', forward('move')],
        ['pointerleave', forward('leave')],
        ['click', forward('click')],
      ];
      bindings.forEach(function (binding) { host.addEventListener(binding[0], binding[1]); });
      removeListeners = function removeHostListeners() {
        bindings.forEach(function (binding) {
          if (typeof host.removeEventListener === 'function') {
            host.removeEventListener(binding[0], binding[1]);
          }
        });
      };
    }

    function showEmptyLabel(host) {
      if (!host) { return; }
      if (host.classList && typeof host.classList.add === 'function') { host.classList.add(EMPTY_CLASS); }
      host.textContent = EMPTY_LABEL;
    }
    function clearEmptyLabel(host) {
      if (!host) { return; }
      if (host.classList && typeof host.classList.remove === 'function') { host.classList.remove(EMPTY_CLASS); }
      if (host.textContent) { host.textContent = ''; }
    }

    function prepareHost(host) {
      if (!host) { return; }
      if (host.classList && typeof host.classList.add === 'function') { host.classList.add(HOST_CLASS); }
      if (typeof host.setAttribute === 'function') {
        host.setAttribute('data-surface-input-block', '');
        host.setAttribute('aria-hidden', 'true');
      }
    }

    function render(context) {
      if (disposed) { return null; }
      var next = context || {};
      var host = next.host || null;
      var effectId = String(next.effectId || 'none');
      var visible = next.visible !== false;

      if (!host || !visible) {
        disposeController();
        currentHost = host;
        return null;
      }
      if (host !== currentHost) {
        disposeController();
        currentHost = host;
      }
      prepareHost(host);
      if (typeof host.setAttribute === 'function') {
        host.setAttribute('data-widget-modifier', effectId);
      }

      if (effectId === 'none') {
        disposeController();
        showEmptyLabel(host);
        return null;
      }
      var factory = resolveFactory(windowRef, effectId);
      if (typeof factory !== 'function') {
        // An effect with no reachable module is a wiring bug, not a crash:
        // fall back to the empty label rather than leaving a blank band.
        disposeController();
        showEmptyLabel(host);
        return null;
      }
      clearEmptyLabel(host);
      if (effectId !== currentEffectId) {
        disposeController();
        try {
          controller = factory({
            documentRef: documentRef,
            reducedMotionQuery: reducedMotionQuery,
            effectId: effectId,
            rendererLaunchSeed: 1,
          });
        } catch (_factoryErr) {
          return degradePreview(host, 'factory');
        }
        currentEffectId = effectId;
        try {
          controller.bind(buildBindContext(host));
          attachListeners(host);
        } catch (_bindErr) {
          return degradePreview(host, 'bind');
        }
        return controller;
      }
      if (controller && typeof controller.refresh === 'function') {
        try {
          controller.refresh(buildBindContext(host));
        } catch (_refreshErr) {
          return degradePreview(host, 'refresh');
        }
      }
      return controller;
    }

    function dispose() {
      if (disposed) { return; }
      disposed = true;
      disposeController();
      currentHost = null;
    }

    function inspect() {
      return {
        disposed: disposed,
        effectId: currentEffectId,
        hasController: Boolean(controller),
        hasHost: Boolean(currentHost),
      };
    }

    return { render: render, dispose: dispose, _internals: { inspect: inspect } };
  }

  return {
    createSurfaceEffectPreview: createSurfaceEffectPreview,
    resolveFactory: resolveFactory,
    buildBindContext: buildBindContext,
    EMPTY_CLASS: EMPTY_CLASS,
    EMPTY_LABEL: EMPTY_LABEL,
  };
});
