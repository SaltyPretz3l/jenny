(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppSurfaceLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_REGION_RECTS = 128;
  const DEFAULT_INTERACTION_SELECTOR = [
    '.composer', '.composer-wrap',
    '.home-card', '.dashboard-card', '.home-panel', '.settings-card', '.settings-nav',
    'button', 'a', 'input', 'select', 'textarea',
    '[role="button"]', '[data-surface-input-block]',
  ].join(', ');
  const PAINT_OCCLUSION_SELECTOR = [
    '[data-surface-effect-paint-occlusion]',
    '.composer-wrap',
  ].join(', ');
  const SPAWN_AVOIDANCE_SELECTOR = [
    '[data-surface-effect-spawn-avoidance]',
    '.composer-wrap',
  ].join(', ');

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function normalizeRect(rect) {
    return {
      left: finite(rect && rect.left),
      top: finite(rect && rect.top),
      width: Math.max(finite(rect && rect.width), 0),
      height: Math.max(finite(rect && rect.height), 0),
    };
  }

  function freezeRect(rect) {
    return Object.freeze(normalizeRect(rect));
  }

  function intersectRects(rect, bounds) {
    const a = normalizeRect(rect);
    const b = normalizeRect(bounds);
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.left + a.width, b.left + b.width);
    const bottom = Math.min(a.top + a.height, b.top + b.height);
    if (!(right > left) || !(bottom > top)) return null;
    return { left, top, width: right - left, height: bottom - top };
  }

  function rectKey(rect) {
    return [rect.left, rect.top, rect.width, rect.height].join('|');
  }

  function freezeRectList(rects, sceneRect) {
    const seen = new Set();
    const frozen = [];
    for (const candidate of Array.isArray(rects) ? rects : []) {
      const clipped = intersectRects(candidate, sceneRect);
      if (!clipped) continue;
      const key = rectKey(clipped);
      if (seen.has(key)) continue;
      seen.add(key);
      frozen.push(freezeRect(clipped));
      if (frozen.length >= MAX_REGION_RECTS) break;
    }
    return Object.freeze(frozen);
  }

  function safeReadRect(element, warn) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return normalizeRect(null);
    try {
      return normalizeRect(element.getBoundingClientRect());
    } catch (_error) {
      warn('surface layout geometry read failed');
      return normalizeRect(null);
    }
  }

  function queryRegionElements(rootElement, selector, warn) {
    if (!rootElement || !selector || typeof rootElement.querySelectorAll !== 'function') return [];
    try {
      return Array.from(rootElement.querySelectorAll(selector) || []).slice(0, MAX_REGION_RECTS);
    } catch (_error) {
      warn('surface layout region query failed');
      return [];
    }
  }

  function createSurfaceLayoutPublisher({
    state = { ui: {} },
    windowRef,
    dom = {},
    interactionSelector = DEFAULT_INTERACTION_SELECTOR,
    paintOcclusionSelector = PAINT_OCCLUSION_SELECTOR,
    spawnAvoidanceSelector = SPAWN_AVOIDANCE_SELECTOR,
    priorityRegionSelector = '',
    onLayoutChange = () => {},
    onWarning = () => {},
  }) {
    let revision = 0;
    let currentSnapshot = null;
    let currentSignature = '';
    let disposed = false;
    let publishRafId = 0;
    let warned = false;
    const observed = new Set();

    function warn(message) {
      if (warned) return;
      warned = true;
      onWarning(message);
    }

    const ResizeObserverCtor = windowRef && windowRef.ResizeObserver;
    const resizeObserver = typeof ResizeObserverCtor === 'function'
      ? new ResizeObserverCtor(() => schedulePublish())
      : null;

    function observe(element) {
      if (!resizeObserver || !element || observed.has(element)) return;
      try {
        resizeObserver.observe(element);
        observed.add(element);
      } catch (_error) {
        warn('surface layout observer registration failed');
      }
    }

    function reconcileObserved(elements) {
      if (!resizeObserver) return;
      const nextObserved = new Set(elements.filter(Boolean));
      for (const element of observed) {
        if (nextObserved.has(element)) continue;
        try {
          resizeObserver.unobserve(element);
        } catch (_error) {
          warn('surface layout observer removal failed');
        }
        observed.delete(element);
      }
      nextObserved.forEach(observe);
    }

    function measure() {
      const surface = state && state.ui && state.ui.activeView === 'home' ? 'home' : 'chat';
      const hosts = [];
      if (surface === 'home' && dom.homeView) {
        hosts.push({ element: dom.homeView, role: 'home' });
      } else if (surface === 'chat') {
        // One full-bleed chat host; see renderer-app-surface-effects.js (F1).
        if (dom.chatSurfaceEffectLeft) hosts.push({ element: dom.chatSurfaceEffectLeft, role: 'chat-left' });
      }
      const sceneElement = surface === 'home'
        ? dom.homeView
        : (dom.chatSurfaceEffects || dom.chatView);
      const regionRoot = surface === 'home' ? dom.homeView : dom.chatView;
      const sceneRect = safeReadRect(sceneElement, warn);
      const hostRects = hosts.map((host) => safeReadRect(host.element, warn));
      const priorityElements = queryRegionElements(regionRoot, priorityRegionSelector, warn);
      const interactionElements = [...priorityElements,
        ...queryRegionElements(regionRoot, interactionSelector, warn)];
      const paintElements = [...priorityElements,
        ...queryRegionElements(regionRoot, paintOcclusionSelector, warn)];
      const spawnElements = [...priorityElements,
        ...queryRegionElements(regionRoot, spawnAvoidanceSelector, warn)];
      const readElements = (elements) => elements.map((element) => safeReadRect(element, warn));

      reconcileObserved([sceneElement, regionRoot, ...hosts.map((host) => host.element),
        ...interactionElements, ...paintElements, ...spawnElements]);

      const raw = {
        surface,
        hosts: hosts.map((host) => Object.freeze(host)),
        sceneRect: freezeRect(sceneRect),
        hostRects: Object.freeze(hostRects.map(freezeRect)),
        interactionBlockRects: freezeRectList(readElements(interactionElements), sceneRect),
        paintOcclusionRects: freezeRectList(readElements(paintElements), sceneRect),
        spawnAvoidanceRects: freezeRectList(readElements(spawnElements), sceneRect),
      };
      const signature = JSON.stringify({
        surface: raw.surface,
        roles: raw.hosts.map((host) => host.role),
        sceneRect: raw.sceneRect,
        hostRects: raw.hostRects,
        interactionBlockRects: raw.interactionBlockRects,
        paintOcclusionRects: raw.paintOcclusionRects,
        spawnAvoidanceRects: raw.spawnAvoidanceRects,
      });
      return { raw, signature };
    }

    function refresh() {
      if (disposed) return { changed: false, snapshot: currentSnapshot };
      const measured = measure();
      if (currentSnapshot && measured.signature === currentSignature) {
        return { changed: false, snapshot: currentSnapshot };
      }
      revision += 1;
      currentSignature = measured.signature;
      const layout = Object.freeze({
        revision,
        sceneRect: measured.raw.sceneRect,
        hostRects: measured.raw.hostRects,
        interactionBlockRects: measured.raw.interactionBlockRects,
        paintOcclusionRects: measured.raw.paintOcclusionRects,
        spawnAvoidanceRects: measured.raw.spawnAvoidanceRects,
      });
      currentSnapshot = Object.freeze({
        surface: measured.raw.surface,
        hosts: Object.freeze(measured.raw.hosts),
        layout,
      });
      return { changed: true, snapshot: currentSnapshot };
    }

    function schedulePublish() {
      if (disposed || publishRafId) return;
      publishRafId = windowRef.requestAnimationFrame(() => {
        publishRafId = 0;
        if (disposed) return;
        const result = refresh();
        if (result.changed) onLayoutChange(result.snapshot);
      });
    }

    function getSnapshot() {
      const result = refresh();
      return result.snapshot;
    }

    function getCurrentSnapshot() {
      return currentSnapshot;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (publishRafId) windowRef.cancelAnimationFrame(publishRafId);
      publishRafId = 0;
      if (resizeObserver) resizeObserver.disconnect();
      observed.clear();
    }

    return Object.freeze({ getSnapshot, getCurrentSnapshot, refresh, schedulePublish, dispose });
  }

  return Object.freeze({
    MAX_REGION_RECTS,
    DEFAULT_INTERACTION_SELECTOR,
    PAINT_OCCLUSION_SELECTOR,
    SPAWN_AVOIDANCE_SELECTOR,
    normalizeRect,
    intersectRects,
    createSurfaceLayoutPublisher,
  });
});
