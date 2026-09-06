/* renderer/features/renderer-ide-map-lod.js — semantic-zoom tier tracking for
 * the Living Atlas File Map (renderer-ide-map-atlas-view.js). This module is
 * PURE ORCHESTRATION over the transform subscription — it never touches the
 * DOM. It answers exactly two questions the atlas view needs to cull/paint
 * correctly:
 *
 *   1. Which tier ('regions' | 'dots' | 'tiles') does the current scale map
 *      to? The view owns what each tier renders; this module only tracks the
 *      band and tells the view when it crosses one.
 *   2. What content-space rect is currently visible, so the view can cull
 *      district/tile materialization to it?
 *
 * Directory clustering (computeClusters/aggregateClusterEdges/applyPins/
 * setExpanded/setPinned) and the old dots/pills/cards materialization-cap
 * machinery are RETIRED with the global node+edge canvas they served — the
 * atlas view's own spatial index + viewport rect own culling now.
 *
 * ── Tier thresholds (band hysteresis) ───────────────────────────────────────
 *   tierForScale(scale) is the boundary-only mapping used to seed the very
 *   first tier at construction: scale < 0.35 -> 'regions'; 0.35 <= scale <
 *   1.0 -> 'dots'; scale >= 1.0 -> 'tiles'.
 *
 *   Every commit thereafter goes through nextTierForScale(currentTier,
 *   scale), which only crosses a boundary once the scale has moved
 *   HYSTERESIS_BAND (0.03) PAST it in the direction of travel — e.g. from
 *   'dots' you need scale >= 1.03 to enter 'tiles', and from 'tiles' you need
 *   scale < 0.97 to fall back to 'dots'. A scale sitting on or oscillating
 *   around a raw boundary (0.35 or 1.0) never flaps between tiers.
 *
 * ── Public interface ────────────────────────────────────────────────────────
 *   createMapLod({ transform, view?, viewportEl?, onLodChange?, timers?,
 *                  debounceMs? }) -> { dispose, _internals }
 *   transform    { subscribe(fn) -> unsub, getState() -> {scale,tx,ty},
 *                  clientToContent({x,y}) -> {x,y} } (renderer-ide-map-
 *                  transform.js's shape).
 *   view         optional; receives view.setTier(tier) and
 *                  view.setViewportRect({x,y,w,h}) directly (renderer-ide-
 *                  map-atlas-view.js's shape). Both calls are no-ops if the
 *                  dep is absent, so this module still unit-tests headless.
 *   viewportEl   optional; DOM element read via getBoundingClientRect() to
 *                  compute the visible rect. No rect is emitted without it.
 *   onLodChange  optional (tier) => void via { tier } payload — fired
 *                  ONLY on a real tier crossing, immediately (not debounced).
 *   timers       optional { setTimeout, clearTimeout } — defaults to window/
 *                  global; injectable for fake-timer tests.
 *   debounceMs   optional, default 120 — settle delay before the viewport
 *                  rect is recomputed and pushed to the view.
 *
 *   On EVERY transform commit: a tier crossing (if any) is applied
 *   immediately (view.setTier + onLodChange); the viewport-rect recompute is
 *   always debounced (a fast pan/zoom flurry recomputes the rect once after
 *   it settles, not once per rAF commit).
 *
 *   dispose() unsubscribes from transform and cancels any pending debounce;
 *     idempotent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapLod = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Tier boundaries. 'dots' is the half-open band between them.
  const REGIONS_DOTS_BOUNDARY = 0.35;
  const DOTS_TILES_BOUNDARY = 1.0;
  // Crossing hysteresis: a boundary only triggers once scale has moved this
  // far past it in the direction of travel (prevents flapping at rest).
  const HYSTERESIS_BAND = 0.03;
  const DEBOUNCE_MS = 120;

  function normalizeScale(scale) {
    return Number.isFinite(scale) ? scale : 1;
  }

  // Raw boundary mapping, no hysteresis — used only to seed the initial tier.
  function tierForScale(scale) {
    const s = normalizeScale(scale);
    if (s < REGIONS_DOTS_BOUNDARY) return 'regions';
    if (s >= DOTS_TILES_BOUNDARY) return 'tiles';
    return 'dots';
  }

  function isKnownTier(tier) {
    return tier === 'regions' || tier === 'dots' || tier === 'tiles';
  }

  // Hysteresis-aware transition: only moves off currentTier once scale has
  // crossed the relevant boundary by more than HYSTERESIS_BAND. Cascades
  // through an intermediate tier within a single call so a large single-commit
  // scale jump (e.g. a keyboard zoom-to-fit) still lands on the right tier.
  function nextTierForScale(currentTier, scale) {
    const s = normalizeScale(scale);
    let tier = isKnownTier(currentTier) ? currentTier : tierForScale(s);
    if (tier === 'regions' && s >= REGIONS_DOTS_BOUNDARY + HYSTERESIS_BAND) tier = 'dots';
    if (tier === 'dots' && s >= DOTS_TILES_BOUNDARY + HYSTERESIS_BAND) tier = 'tiles';
    if (tier === 'tiles' && s < DOTS_TILES_BOUNDARY - HYSTERESIS_BAND) tier = 'dots';
    if (tier === 'dots' && s < REGIONS_DOTS_BOUNDARY - HYSTERESIS_BAND) tier = 'regions';
    return tier;
  }

  // Content-space rect of the viewport's current visible window, via
  // transform.clientToContent() on the viewport's client-space corners. Null
  // when either dep is missing or the geometry isn't finite (nothing to cull
  // to; callers should treat null as "show everything").
  function computeViewportRect(viewportEl, transform) {
    if (!viewportEl || typeof viewportEl.getBoundingClientRect !== 'function') return null;
    if (!transform || typeof transform.clientToContent !== 'function') return null;
    const rect = viewportEl.getBoundingClientRect();
    if (!rect
      || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)
      || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
      return null;
    }
    const topLeft = transform.clientToContent({ x: rect.left, y: rect.top });
    const bottomRight = transform.clientToContent({ x: rect.left + rect.width, y: rect.top + rect.height });
    if (!topLeft || !bottomRight
      || !Number.isFinite(topLeft.x) || !Number.isFinite(topLeft.y)
      || !Number.isFinite(bottomRight.x) || !Number.isFinite(bottomRight.y)) {
      return null;
    }
    return {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };
  }

  function resolveTimers(injected) {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    const t = injected || {};
    const win = g.window || g;
    return {
      setTimeout: typeof t.setTimeout === 'function' ? t.setTimeout : (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: typeof t.clearTimeout === 'function' ? t.clearTimeout : (id) => win.clearTimeout(id),
    };
  }

  function createMapLod(deps) {
    const d = deps || {};
    const transform = d.transform || null;
    const view = d.view || null;
    const viewportEl = d.viewportEl || null;
    const onLodChange = typeof d.onLodChange === 'function' ? d.onLodChange : () => {};
    const debounceMs = Number.isFinite(d.debounceMs) ? d.debounceMs : DEBOUNCE_MS;
    const timers = resolveTimers(d.timers);

    let disposed = false;
    let unsubscribe = null;
    let settleTimerId = null;

    function scaleFromState(state) {
      return normalizeScale(state ? state.scale : undefined);
    }

    function currentScale() {
      const state = transform && typeof transform.getState === 'function' ? transform.getState() : null;
      return scaleFromState(state);
    }

    let tier = tierForScale(currentScale());

    function settleViewport() {
      settleTimerId = null;
      if (disposed || !view || typeof view.setViewportRect !== 'function') return;
      const rect = computeViewportRect(viewportEl, transform);
      if (rect) view.setViewportRect(rect);
    }

    function scheduleSettle() {
      if (disposed) return;
      if (settleTimerId != null) timers.clearTimeout(settleTimerId);
      settleTimerId = timers.setTimeout(settleViewport, debounceMs);
    }

    // Transform commits fire on every rAF; the tier crossing (if any) applies
    // immediately, but the viewport-rect recompute always debounces.
    function handleCommit(state) {
      if (disposed) return;
      const next = nextTierForScale(tier, scaleFromState(state));
      if (next !== tier) {
        tier = next;
        if (view && typeof view.setTier === 'function') view.setTier(tier);
        onLodChange({ tier });
      }
      scheduleSettle();
    }

    if (transform && typeof transform.subscribe === 'function') {
      unsubscribe = transform.subscribe(handleCommit);
    }
    if (view && typeof view.setTier === 'function') view.setTier(tier);
    scheduleSettle();

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
        unsubscribe = null;
      }
      if (settleTimerId != null) {
        timers.clearTimeout(settleTimerId);
        settleTimerId = null;
      }
    }

    return {
      dispose,
      _internals: {
        REGIONS_DOTS_BOUNDARY,
        DOTS_TILES_BOUNDARY,
        HYSTERESIS_BAND,
        DEBOUNCE_MS: debounceMs,
      },
    };
  }

  return {
    createMapLod,
    tierForScale,
    nextTierForScale,
    computeViewportRect,
    REGIONS_DOTS_BOUNDARY,
    DOTS_TILES_BOUNDARY,
    HYSTERESIS_BAND,
    DEBOUNCE_MS,
  };
});
