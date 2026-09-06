(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppSurfaceInput = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // One list, one module (Rev 2 §3.3): interactive chrome whose activation
  // events must never be mirrored by a background effect. Chat's populated
  // and empty center lanes have an explicit hover-only exception below.
  const SURFACE_INPUT_BLOCKER_SELECTOR = [
    '.composer', '.composer-wrap', '.chat-thread-column', '.chat-empty .hero-stack',
    '.home-card', '.dashboard-card', '.home-panel', '.settings-card', '.settings-nav',
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[data-surface-input-block]',
  ].join(', ');
  const CHAT_AMBIENT_HOVER_SELECTOR = '.chat-thread-column, .chat-empty .hero-stack';

  const POINTER_EVENT_TYPES = Object.freeze({
    pointerenter: 'enter',
    pointermove: 'move',
    pointerleave: 'leave',
    pointerdown: 'press',
    pointerup: 'release',
    pointercancel: 'cancel',
    lostpointercapture: 'cancel',
    click: 'click',
  });
  const MAX_POINTER_STATES = 64;

  function isHoverInputType(type) {
    return type === 'enter' || type === 'move';
  }

  function isActivationInputType(type) {
    return type === 'press' || type === 'release' || type === 'click';
  }

  function eventMatchesSelector(event, surfaceElement, selector) {
    if (typeof event.composedPath === 'function') {
      const path = event.composedPath();
      if (Array.isArray(path) && path.length) {
        for (const node of path) {
          if (node === surfaceElement) {
            break;
          }
          if (node && typeof node.matches === 'function' && node.matches(selector)) {
            return true;
          }
        }
        return false;
      }
    }
    const eventTarget = event.target;
    return Boolean(eventTarget && typeof eventTarget.closest === 'function'
      && eventTarget.closest(selector));
  }

  function toRect(element) {
    if (element && typeof element.getBoundingClientRect === 'function') {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left || 0,
        top: rect.top || 0,
        width: rect.width || 0,
        height: rect.height || 0,
      };
    }
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  function rectContains(rect, clientX, clientY) {
    return rect.width > 0 && rect.height > 0
      && clientX >= rect.left && clientX <= rect.left + rect.width
      && clientY >= rect.top && clientY <= rect.top + rect.height;
  }

  function snapshotHostRect(target, surfaceRole) {
    const hosts = target && Array.isArray(target.hosts) ? target.hosts : [];
    const hostRects = target && target.layout && Array.isArray(target.layout.hostRects)
      ? target.layout.hostRects : [];
    const index = hosts.findIndex((host) => host && host.role === surfaceRole);
    return index >= 0 ? (hostRects[index] || null) : null;
  }

  function createSurfaceInputRouter({
    windowRef,
    documentRef = null,
    dom = {},
    registerCleanup = () => {},
    getInputTarget = () => null,
    onInputFailure = () => {},
  }) {
    const surfaces = [];
    if (dom.chatView) {
      surfaces.push({ element: dom.chatView, surface: 'chat' });
    }
    if (dom.homeView) {
      surfaces.push({ element: dom.homeView, surface: 'home' });
    }

    // Per-pointer tracking: live = last event landed in an unblocked region;
    // captured = a press acquired pointer capture on the surface element.
    const pointerStates = new Map();
    const pendingMoves = new Map();
    let flushRafId = 0;
    let routerDisposed = false;

    function getPointerState(pointerId) {
      let entry = pointerStates.get(pointerId);
      if (!entry) {
        if (pointerStates.size >= MAX_POINTER_STATES) {
          clearPointerState('pointer-capacity');
        }
        entry = { live: false, captureElement: null };
        pointerStates.set(pointerId, entry);
      }
      return entry;
    }

    function isBlocked(event, surfaceElement, target, type, chatAmbientHoverTarget) {
      if (type === 'leave' || type === 'cancel') {
        return false;
      }
      if (chatAmbientHoverTarget && isHoverInputType(type)) {
        return false;
      }
      if (typeof event.composedPath === 'function') {
        const path = event.composedPath();
        if (Array.isArray(path) && path.length) {
          for (const node of path) {
            if (node === surfaceElement) {
              break;
            }
            if (node && typeof node.matches === 'function'
              && node.matches(SURFACE_INPUT_BLOCKER_SELECTOR)) {
              return true;
            }
          }
          const regions = target && target.layout && target.layout.interactionBlockRects;
          return Array.isArray(regions)
            && regions.some((rect) => rectContains(rect, event.clientX || 0, event.clientY || 0));
        }
      }
      const eventTarget = event.target;
      if (eventTarget && typeof eventTarget.closest === 'function'
        && eventTarget.closest(SURFACE_INPUT_BLOCKER_SELECTOR)) {
        return true;
      }
      const regions = target && target.layout && target.layout.interactionBlockRects;
      return Array.isArray(regions)
        && regions.some((rect) => rectContains(rect, event.clientX || 0, event.clientY || 0));
    }

    // Chat publishes exactly one full-bleed host (F1, 2026-08-21); the
    // `chat-left` role string is kept because the layout snapshot contract
    // names it. There is no second gutter left to disambiguate against.
    function resolveSurfaceRole(surface) {
      return surface === 'home' ? 'home' : 'chat-left';
    }

    function hostElementForRole(surfaceRole) {
      if (surfaceRole === 'home') {
        return dom.homeView || null;
      }
      return dom.chatSurfaceEffectLeft || null;
    }

    // S10 snapshot authority: scene coordinates use the manager-published
    // shared scene; local coordinates use the parallel role host rectangle.
    function buildPayload(type, event, descriptor, generation, target) {
      const surfaceRole = resolveSurfaceRole(descriptor.surface);
      const hostRect = snapshotHostRect(target, surfaceRole) || toRect(hostElementForRole(surfaceRole));
      const sceneRect = (target && target.layout && target.layout.sceneRect) || toRect(descriptor.element);
      return {
        type,
        pointerId: Number.isFinite(event.pointerId) ? event.pointerId : 1,
        pointerType: event.pointerType || 'mouse',
        isPrimary: event.isPrimary !== false,
        buttons: event.buttons || 0,
        pressure: Number.isFinite(event.pressure) ? event.pressure : 0,
        timeStamp: Number.isFinite(event.timeStamp) ? event.timeStamp : 0,
        clientX: event.clientX || 0,
        clientY: event.clientY || 0,
        surfaceRole,
        localX: (event.clientX || 0) - hostRect.left,
        localY: (event.clientY || 0) - hostRect.top,
        sceneX: (event.clientX || 0) - sceneRect.left,
        sceneY: (event.clientY || 0) - sceneRect.top,
        generation,
      };
    }

    function dispatchPayload(payload) {
      if (routerDisposed) {
        return;
      }
      const target = getInputTarget() || null;
      if (!target || !target.controller || target.inputDisabled) {
        return;
      }
      if (payload.generation !== target.generation) {
        return;
      }
      try {
        if (typeof target.controller.handleInput === 'function') {
          target.controller.handleInput(payload);
        }
      } catch (err) {
        onInputFailure(target.effectId, err);
      }
    }

    function flushPendingMove(pointerId) {
      const pending = pendingMoves.get(pointerId);
      if (!pending) {
        return;
      }
      pendingMoves.delete(pointerId);
      dispatchPayload(pending);
    }

    function flushAllPendingMoves() {
      flushRafId = 0;
      const pointerIds = Array.from(pendingMoves.keys());
      for (const pointerId of pointerIds) {
        flushPendingMove(pointerId);
      }
    }

    function scheduleMoveFlush() {
      if (flushRafId) {
        return;
      }
      flushRafId = windowRef.requestAnimationFrame(flushAllPendingMoves);
    }

    function acquireCapture(descriptor, event, target) {
      if (!target.captureOnPress) {
        return;
      }
      const element = descriptor.element;
      if (typeof element.setPointerCapture !== 'function') {
        return;
      }
      try {
        element.setPointerCapture(event.pointerId);
        getPointerState(event.pointerId).captureElement = element;
      } catch (_captureErr) {
        // Capture is best-effort: a released or synthetic pointer throws here.
      }
    }

    function releaseCapture(pointerId) {
      const entry = pointerStates.get(pointerId);
      if (!entry || !entry.captureElement) {
        return;
      }
      const element = entry.captureElement;
      entry.captureElement = null;
      if (typeof element.releasePointerCapture === 'function') {
        try {
          element.releasePointerCapture(pointerId);
        } catch (_releaseErr) {
          // Already released by the browser — nothing to undo.
        }
      }
    }

    function handleSurfaceEvent(descriptor, event) {
      if (routerDisposed) {
        return;
      }
      const type = POINTER_EVENT_TYPES[event.type];
      if (!type) {
        return;
      }
      const target = getInputTarget() || null;
      const generation = target ? target.generation : 0;
      const pointerId = Number.isFinite(event.pointerId) ? event.pointerId : 1;
      let pointerState = pointerStates.get(pointerId);
      const chatAmbientHoverTarget = descriptor.surface === 'chat'
        && eventMatchesSelector(event, descriptor.element, CHAT_AMBIENT_HOVER_SELECTOR);

      // Chat's populated and empty center lanes are ambient-hover territory:
      // foreground controls keep activation while effect hover remains live.
      if (chatAmbientHoverTarget && isActivationInputType(type)) {
        return;
      }

      const blocked = isBlocked(
        event, descriptor.element, target, type, chatAmbientHoverTarget,
      );

      if (blocked) {
        // Live → blocked is a boundary: flush the pending move, then a single
        // synthesized leave so effects never stay attracted to a stale point.
        if (pointerState && pointerState.live) {
          pointerState.live = false;
          flushPendingMove(pointerId);
          releaseCapture(pointerId);
          dispatchPayload(buildPayload('leave', event, descriptor, generation, target));
          pointerStates.delete(pointerId);
        }
        return;
      }

      if (!pointerState && type !== 'leave' && type !== 'cancel') {
        pointerState = getPointerState(pointerId);
      }
      if (pointerState && type !== 'leave' && type !== 'cancel') {
        pointerState.surfaceRole = resolveSurfaceRole(descriptor.surface);
        pointerState.pointerType = event.pointerType || 'mouse';
        pointerState.isPrimary = event.isPrimary !== false;
      }
      if (pointerState && !pointerState.live && type !== 'leave' && type !== 'cancel') {
        // Blocked → live re-entry never refires pointerenter (the pointer
        // never left the surface element), so the router synthesizes it.
        pointerState.live = true;
        if (type !== 'enter') {
          dispatchPayload(buildPayload('enter', event, descriptor, generation, target));
        }
      }

      if (type === 'move') {
        pendingMoves.set(pointerId, buildPayload('move', event, descriptor, generation, target));
        scheduleMoveFlush();
        return;
      }

      // Boundary + discrete events flush that pointer's pending move first,
      // preserving move-before-boundary ordering, and are never coalesced.
      flushPendingMove(pointerId);
      if (type === 'press' && target && !target.inputDisabled) {
        acquireCapture(descriptor, event, target);
      }
      if (type === 'release' || type === 'cancel' || type === 'leave') {
        releaseCapture(pointerId);
      }
      if (type === 'leave' || type === 'cancel') {
        if (pointerState) pointerState.live = false;
        pointerStates.delete(pointerId);
      }
      dispatchPayload(buildPayload(type, event, descriptor, generation, target));
    }

    function clearPointerState(reason) {
      if (routerDisposed) {
        return;
      }
      pendingMoves.clear();
      if (flushRafId) {
        windowRef.cancelAnimationFrame(flushRafId);
        flushRafId = 0;
      }
      const target = getInputTarget() || null;
      for (const [pointerId, entry] of pointerStates.entries()) {
        releaseCapture(pointerId);
        if (!entry.live) {
          continue;
        }
        entry.live = false;
        if (!target || !target.controller || target.inputDisabled) {
          continue;
        }
        try {
          if (typeof target.controller.handleInput === 'function') {
            target.controller.handleInput({
              type: 'cancel', pointerId, pointerType: entry.pointerType, isPrimary: entry.isPrimary,
              buttons: 0, pressure: 0, timeStamp: 0, clientX: 0, clientY: 0,
              surfaceRole: entry.surfaceRole, localX: 0, localY: 0, sceneX: 0, sceneY: 0,
              generation: target.generation, reason: String(reason || ''),
            });
          }
        } catch (err) {
          onInputFailure(target.effectId, err);
        }
      }
      pointerStates.clear();
    }

    function dispose() {
      if (routerDisposed) {
        return;
      }
      clearPointerState('dispose');
      routerDisposed = true;
      if (flushRafId) {
        windowRef.cancelAnimationFrame(flushRafId);
        flushRafId = 0;
      }
      pendingMoves.clear();
      pointerStates.clear();
    }

    const listenerRecords = [];
    for (const descriptor of surfaces) {
      const listener = (event) => handleSurfaceEvent(descriptor, event);
      for (const eventName of Object.keys(POINTER_EVENT_TYPES)) {
        descriptor.element.addEventListener(eventName, listener);
        listenerRecords.push({ element: descriptor.element, eventName, listener });
      }
    }
    const onWindowBlur = () => clearPointerState('blur');
    windowRef.addEventListener('blur', onWindowBlur);
    const onVisibilityChange = documentRef
      ? () => {
        if (documentRef.hidden) {
          clearPointerState('visibility');
        }
      }
      : null;
    if (onVisibilityChange) {
      documentRef.addEventListener('visibilitychange', onVisibilityChange);
    }
    registerCleanup(() => {
      for (const record of listenerRecords) {
        record.element.removeEventListener(record.eventName, record.listener);
      }
      windowRef.removeEventListener('blur', onWindowBlur);
      if (onVisibilityChange) {
        documentRef.removeEventListener('visibilitychange', onVisibilityChange);
      }
      dispose();
    });

    return {
      clearPointerState,
      dispose,
      _internals: {
        SURFACE_INPUT_BLOCKER_SELECTOR,
        CHAT_AMBIENT_HOVER_SELECTOR,
        eventMatchesSelector,
        isBlocked,
        resolveSurfaceRole,
        buildPayload,
        getPendingMoveCount: () => pendingMoves.size,
        getPointerStateCount: () => pointerStates.size,
      },
    };
  }

  return {
    MAX_POINTER_STATES,
    SURFACE_INPUT_BLOCKER_SELECTOR,
    CHAT_AMBIENT_HOVER_SELECTOR,
    createSurfaceInputRouter,
  };
});
