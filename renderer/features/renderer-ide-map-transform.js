/* renderer/features/renderer-ide-map-transform.js — the observable pan/zoom
 * transform controller for the Workspace File Map. It is the SINGLE source of
 * truth for the map's {scale, tx, ty}: it applies one CSS transform to the
 * content layer per rAF-coalesced commit, converts between client (screen) and
 * content (graph) coordinate spaces, owns empty-canvas pan + wheel zoom, and
 * fans every committed state out to subscribers. The minimap, node-drag, and
 * LOD layers all READ this controller and never recompute coordinates
 * themselves — that keeps every coordinate-space bug in exactly one place.
 *
 * Reuses only the zoom-toward-cursor FORMULA from renderer-mermaid-utils'
 * attachMermaidControls (fresh implementation: pointer capture + observability
 * are new). Timers (setTimeout/clearTimeout + requestAnimationFrame) and the
 * persistence storage are injectable so the whole controller is testable
 * without a real DOM clock or a real localStorage.
 *
 * ── Public interface — createMapTransform(opts) → controller ────────────────
 * opts:
 *   viewportEl   (Element)  the clipping frame; pan + wheel listeners bind here.
 *   contentEl    (Element)  the transformed layer (cards + edge svg live inside).
 *   workspaceId  (string)   persistence-key suffix (jenny.fileMap.view.<wsId>).
 *                           Empty/absent DISABLES persistence (WIDE-030).
 *   storage      (object?)  { getItem, setItem } — defaults to window.localStorage.
 *   timers       (object?)  { setTimeout, clearTimeout, requestAnimationFrame,
 *                             cancelAnimationFrame } — defaults to window/global.
 *   getViewportRect (fn?)   () => {left,top,width,height}; defaults to
 *                           viewportEl.getBoundingClientRect(). Injectable for
 *                           tests where jsdom returns a zero rect.
 *   onCommitReason  (fn?)   optional side-channel; subscribers are preferred.
 *
 * controller methods:
 *   getState()                       → {scale, tx, ty}          (a fresh copy)
 *   clientToContent({x,y})           → {x,y} in content space
 *   contentToClient({x,y})           → {x,y} in client space
 *   zoomToward(clientPoint, scale)   anchor stays under the cursor; clamped to
 *                                    [SCALE_MIN, SCALE_MAX].
 *   panBy(dx, dy[, reason])          shift by client-space pixels.
 *   panTo(tx, ty[, reason])          set translation directly.
 *   fitToContent(bounds[, reason])   frame {minX,minY,maxX,maxY} in the viewport.
 *   reclampToBounds([reason])        re-run clamp against the current bounds.
 *   setBounds(bounds)                content extent used by clamp/fit (no commit).
 *   subscribe(fn)                    fn({scale,tx,ty,reason}) on every commit;
 *                                    returns an unsubscribe function.
 *   dispose()                        remove listeners, cancel rAF/debounce, clear
 *                                    subscribers; every method becomes a no-op.
 *   _internals                       { clamp, SCALE_MIN, SCALE_MAX, MIN_CONTENT_VISIBLE,
 *                                      DEFAULT_STORAGE_KEY_PREFIX, PERSIST_DEBOUNCE_MS,
 *                                      storageKey, commitReason }  (tests only)
 *
 * _internals.clamp({scale,tx,ty}, bounds, viewport) is a PURE, DOM-free function
 * (exported for unit testing) that keeps at least MIN_CONTENT_VISIBLE px of
 * actual content visible in the viewport per axis, so the map can never be
 * scrolled — or restored from a stale persisted camera — fully off-screen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapTransform = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRefForOwnership = typeof globalThis !== 'undefined' ? globalThis : {};

  function resolveEventOwnership() {
    if (globalRefForOwnership.rendererIdeMapEventOwnership) {
      return globalRefForOwnership.rendererIdeMapEventOwnership;
    }
    if (typeof require === 'function') {
      try {
        return require('./renderer-ide-map-event-ownership');
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  // WIDE-029: shared ownership guard (renderer-ide-map-event-ownership.js) so
  // pan/zoom never steals events from the controls bar, minimap, Overview
  // panel, findings chip bar, contenteditable regions, or generic interactive
  // controls — the empty canvas (or a node/cluster card riding on it) is the
  // only thing that owns pan, and wheel-driven zoom is skipped entirely over
  // a scroll-owning/control surface so nested scrolling (Overview's
  // overflow-y:auto body) keeps working. Falls back to permissive no-op
  // checks if the sibling module is ever unavailable (never throws, never
  // regresses existing canvas behavior).
  const eventOwnership = resolveEventOwnership();
  const ownsCanvasPointerEvent = typeof eventOwnership.ownsCanvasPointerEvent === 'function'
    ? eventOwnership.ownsCanvasPointerEvent
    : () => true;
  const ownsMapWheelZoom = typeof eventOwnership.ownsMapWheelZoom === 'function'
    ? eventOwnership.ownsMapWheelZoom
    : () => true;
  const normalizePointerId = typeof eventOwnership.normalizePointerId === 'function'
    ? eventOwnership.normalizePointerId
    : (event) => (event && event.pointerId != null ? event.pointerId : 'mouse');
  const createPointerIdGate = typeof eventOwnership.createPointerIdGate === 'function'
    ? eventOwnership.createPointerIdGate
    : () => ({ capture() {}, matches: () => true, release() {}, isActive: () => false });

  const SCALE_MIN = 0.2;
  const SCALE_MAX = 3.0;
  const MIN_CONTENT_VISIBLE = 48;
  const PERSIST_DEBOUNCE_MS = 150;
  const DEFAULT_STORAGE_KEY_PREFIX = 'jenny.fileMap.view.';

  function clampScale(scale) {
    if (!Number.isFinite(scale)) {
      return 1;
    }
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale));
  }

  // Pure, DOM-free clamp. `bounds` is the content extent {minX,minY,maxX,maxY};
  // `viewport` is {width,height}. Guarantees at least MIN_CONTENT_VISIBLE px of
  // ACTUAL content stays inside the viewport on each axis — a stale persisted
  // camera or a wild pan can never leave the map fully off-screen (a padding-
  // based clamp allowed exactly that for small graphs). When bounds are
  // absent/degenerate, only the scale is clamped.
  function clamp(state, bounds, viewport) {
    const scale = clampScale(state && state.scale);
    let tx = Number.isFinite(state && state.tx) ? state.tx : 0;
    let ty = Number.isFinite(state && state.ty) ? state.ty : 0;
    const vw = viewport && Number.isFinite(viewport.width) ? viewport.width : 0;
    const vh = viewport && Number.isFinite(viewport.height) ? viewport.height : 0;
    const hasBounds = bounds
      && Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY)
      && Number.isFinite(bounds.maxX) && Number.isFinite(bounds.maxY);
    if (!hasBounds || vw <= 0 || vh <= 0) {
      return { scale, tx, ty };
    }
    // Content extent projected to client space.
    const minX = bounds.minX * scale;
    const maxX = bounds.maxX * scale;
    const minY = bounds.minY * scale;
    const maxY = bounds.maxY * scale;
    // Required visible overlap per axis, shrunk for content/viewports smaller
    // than 2× the target so the constraint always stays satisfiable
    // (txMin <= txMax needs 2·overlap <= vw + contentWidth).
    const ovX = Math.min(MIN_CONTENT_VISIBLE, (maxX - minX) / 2, vw / 2);
    const ovY = Math.min(MIN_CONTENT_VISIBLE, (maxY - minY) / 2, vh / 2);
    tx = Math.max(ovX - maxX, Math.min(vw - ovX - minX, tx));
    ty = Math.max(ovY - maxY, Math.min(vh - ovY - minY, ty));
    return { scale, tx, ty };
  }

  function resolveTimers(injected) {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    const t = injected || {};
    const win = g.window || g;
    return {
      setTimeout: typeof t.setTimeout === 'function'
        ? t.setTimeout
        : (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: typeof t.clearTimeout === 'function'
        ? t.clearTimeout
        : (id) => win.clearTimeout(id),
      requestAnimationFrame: typeof t.requestAnimationFrame === 'function'
        ? t.requestAnimationFrame
        : (typeof win.requestAnimationFrame === 'function'
          ? (fn) => win.requestAnimationFrame(fn)
          : (fn) => win.setTimeout(() => fn(Date.now()), 16)),
      cancelAnimationFrame: typeof t.cancelAnimationFrame === 'function'
        ? t.cancelAnimationFrame
        : (typeof win.cancelAnimationFrame === 'function'
          ? (id) => win.cancelAnimationFrame(id)
          : (id) => win.clearTimeout(id)),
    };
  }

  function resolveStorage(injected) {
    if (injected && typeof injected.getItem === 'function' && typeof injected.setItem === 'function') {
      return injected;
    }
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    const win = g.window || g;
    if (win && win.localStorage) {
      return win.localStorage;
    }
    return null;
  }

  function createMapTransform(opts) {
    const o = opts || {};
    const viewportEl = o.viewportEl || null;
    const contentEl = o.contentEl || null;
    const workspaceId = o.workspaceId == null ? '' : String(o.workspaceId);
    const timers = resolveTimers(o.timers);
    // WIDE-030: no workspace identity → no persistence at all (restore AND
    // persist both no-op on a null storage). Without this, every identity-less
    // workspace read/wrote the SAME bare-prefix key.
    const storage = workspaceId ? resolveStorage(o.storage) : null;
    const keyPrefix = o.storageKeyPrefix || DEFAULT_STORAGE_KEY_PREFIX;
    const storageKey = keyPrefix + workspaceId;

    const state = { scale: 1, tx: 0, ty: 0 };
    // Injectable clock (tests drive flyTo deterministically).
    const nowSource = typeof o.now === 'function' ? o.now : () => Date.now();
    let bounds = null;
    let disposed = false;
    const subscribers = new Set();

    let rafId = null;
    let pendingReason = 'init';
    let persistTimer = null;

    function defaultViewportRect() {
      if (viewportEl && typeof viewportEl.getBoundingClientRect === 'function') {
        return viewportEl.getBoundingClientRect();
      }
      return { left: 0, top: 0, width: 0, height: 0 };
    }
    const getViewportRect = typeof o.getViewportRect === 'function'
      ? o.getViewportRect
      : defaultViewportRect;

    function viewportSize() {
      const rect = getViewportRect() || {};
      return {
        width: Number.isFinite(rect.width) ? rect.width : 0,
        height: Number.isFinite(rect.height) ? rect.height : 0,
      };
    }

    // ── coordinate helpers ─────────────────────────────────────────────────
    function clientToContent(p) {
      const rect = getViewportRect() || {};
      const rl = Number.isFinite(rect.left) ? rect.left : 0;
      const rt = Number.isFinite(rect.top) ? rect.top : 0;
      const s = state.scale || 1;
      return {
        x: ((p.x - rl - state.tx) / s),
        y: ((p.y - rt - state.ty) / s),
      };
    }
    function contentToClient(p) {
      const rect = getViewportRect() || {};
      const rl = Number.isFinite(rect.left) ? rect.left : 0;
      const rt = Number.isFinite(rect.top) ? rect.top : 0;
      const s = state.scale || 1;
      return {
        x: (p.x * s) + state.tx + rl,
        y: (p.y * s) + state.ty + rt,
      };
    }

    // ── commit machinery (rAF-coalesced) ───────────────────────────────────
    function applyDom() {
      if (contentEl && contentEl.style) {
        contentEl.style.transform = 'translate(' + state.tx + 'px, ' + state.ty + 'px) scale(' + state.scale + ')';
        // Zoom-compensation hook: the stylesheet divides chrome sizes
        // (district borders, header labels, ray strokes) by this variable so
        // they hold a constant VISUAL size across the 0.2–3.0 zoom range —
        // without it, far zoom scales 1px borders and 12px labels to
        // invisible sub-pixel chrome.
        if (typeof contentEl.style.setProperty === 'function') {
          contentEl.style.setProperty('--atlas-zoom', String(state.scale));
        }
      }
    }
    function notify(reason) {
      const snapshot = { scale: state.scale, tx: state.tx, ty: state.ty, reason };
      for (const fn of [...subscribers]) {
        try { fn(snapshot); } catch (_error) { /* subscriber isolation */ }
      }
      if (typeof o.onCommitReason === 'function') {
        try { o.onCommitReason(snapshot); } catch (_error) { /* best-effort */ }
      }
    }
    function schedulePersist() {
      if (disposed || !storage) {
        return;
      }
      if (persistTimer != null) {
        timers.clearTimeout(persistTimer);
      }
      persistTimer = timers.setTimeout(() => {
        persistTimer = null;
        try {
          storage.setItem(storageKey, JSON.stringify({ scale: state.scale, tx: state.tx, ty: state.ty }));
        } catch (_error) { /* persistence is best-effort */ }
      }, PERSIST_DEBOUNCE_MS);
    }
    function flushCommit() {
      rafId = null;
      const reason = pendingReason;
      applyDom();
      notify(reason);
      schedulePersist();
    }
    function commit(reason) {
      if (disposed) {
        return;
      }
      pendingReason = reason || 'commit';
      if (rafId != null) {
        return;
      }
      rafId = timers.requestAnimationFrame(flushCommit);
    }

    // ── mutation primitives ─────────────────────────────────────────────────
    function assign(next, reason) {
      const clamped = clamp(next, bounds, viewportSize());
      state.scale = clamped.scale;
      state.tx = clamped.tx;
      state.ty = clamped.ty;
      commit(reason);
    }

    function setBounds(nextBounds) {
      bounds = nextBounds || null;
    }

    // ── animated camera (atlas polish) ──────────────────────────────────────
    // flyTo eases {scale?, tx, ty} over FLY_MS with ease-in-out; any user
    // gesture (pan start, wheel zoom) or an explicit panTo/fit cancels the
    // in-flight flight. prefers-reduced-motion collapses it to a jump.
    const FLY_MS = 350;
    let flyRafId = null;

    function prefersReducedMotion() {
      const g = typeof globalThis !== 'undefined' ? globalThis : {};
      const win = (viewportEl && viewportEl.ownerDocument && viewportEl.ownerDocument.defaultView)
        || g.window || g;
      try {
        return typeof win.matchMedia === 'function'
          && win.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
      } catch (_error) {
        return false;
      }
    }

    function cancelFly() {
      if (flyRafId != null) {
        timers.cancelAnimationFrame(flyRafId);
        flyRafId = null;
      }
    }

    function flyTo(next, reason) {
      if (disposed || !next) {
        return;
      }
      cancelFly();
      const target = {
        scale: Number.isFinite(next.scale) ? clampScale(next.scale) : state.scale,
        tx: Number.isFinite(next.tx) ? next.tx : state.tx,
        ty: Number.isFinite(next.ty) ? next.ty : state.ty,
      };
      if (prefersReducedMotion()) {
        assign(target, reason || 'fly');
        return;
      }
      const from = { scale: state.scale, tx: state.tx, ty: state.ty };
      const start = nowSource();
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
      const step = () => {
        flyRafId = null;
        if (disposed) return;
        const t = Math.min(1, (nowSource() - start) / FLY_MS);
        const k = ease(t);
        assign({
          scale: from.scale + (target.scale - from.scale) * k,
          tx: from.tx + (target.tx - from.tx) * k,
          ty: from.ty + (target.ty - from.ty) * k,
        }, reason || 'fly');
        if (t < 1) {
          flyRafId = timers.requestAnimationFrame(step);
        }
      };
      step();
    }

    function zoomToward(clientPoint, newScale) {
      if (disposed) {
        return;
      }
      cancelFly();
      const s1 = clampScale(newScale);
      // Anchor in content space at the OLD scale, then re-derive tx/ty so the
      // same content point stays under the cursor at the new scale.
      const anchor = clientToContent(clientPoint);
      const rect = getViewportRect() || {};
      const rl = Number.isFinite(rect.left) ? rect.left : 0;
      const rt = Number.isFinite(rect.top) ? rect.top : 0;
      const tx = clientPoint.x - rl - (anchor.x * s1);
      const ty = clientPoint.y - rt - (anchor.y * s1);
      assign({ scale: s1, tx, ty }, 'zoom');
    }

    function panBy(dx, dy, reason) {
      if (disposed) {
        return;
      }
      cancelFly();
      assign({ scale: state.scale, tx: state.tx + (dx || 0), ty: state.ty + (dy || 0) }, reason || 'pan');
    }
    function panTo(tx, ty, reason) {
      if (disposed) {
        return;
      }
      cancelFly();
      assign({ scale: state.scale, tx, ty }, reason || 'pan');
    }

    // Shared fit math: the {scale, tx, ty} that centers `b` in the viewport
    // at 90% zoom-to-fit. Null when the viewport has no size yet.
    function computeFitTarget(b) {
      const vp = viewportSize();
      if (!b || vp.width <= 0 || vp.height <= 0) {
        return null;
      }
      const contentW = Math.max(1, b.maxX - b.minX);
      const contentH = Math.max(1, b.maxY - b.minY);
      const scale = clampScale(Math.min(vp.width / contentW, vp.height / contentH) * 0.9);
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      return {
        scale,
        tx: (vp.width / 2) - (cx * scale),
        ty: (vp.height / 2) - (cy * scale),
      };
    }

    // Returns true when a fit target was actually applied; false when it
    // could not be computed (no bounds, or a 0×0 viewport — e.g. the stage is
    // mounted but hidden). Callers that latch "fitted once" state must only
    // latch on true and retry when the viewport gains real size.
    function fitToContent(fitBounds, reason) {
      if (disposed) {
        return false;
      }
      cancelFly();
      const b = fitBounds || bounds;
      if (b) {
        setBounds(b);
      }
      const target = computeFitTarget(b);
      if (!target) {
        assign({ scale: state.scale, tx: state.tx, ty: state.ty }, reason || 'fit');
        return false;
      }
      assign(target, reason || 'fit');
      return true;
    }

    // Animated fit (district zoom): eases to the same target fitToContent
    // would jump to. Deliberately does NOT adopt `b` as the clamp bounds —
    // mid-flight frames clamp against the CURRENT (wide) bounds, so the
    // camera never snaps; callers keep the full-content bounds throughout.
    function flyToFit(fitBounds, reason) {
      if (disposed) {
        return;
      }
      const target = computeFitTarget(fitBounds || bounds);
      if (!target) {
        return;
      }
      flyTo(target, reason || 'fit');
    }

    function reclampToBounds(reason) {
      if (disposed) {
        return;
      }
      assign({ scale: state.scale, tx: state.tx, ty: state.ty }, reason || 'reclamp');
    }

    // ── pointer pan (empty canvas only) ─────────────────────────────────────
    // The pointer-id gate (renderer-ide-map-event-ownership.js) is the single
    // source of truth for "which pointer is driving this pan gesture" — a
    // pointermove/pointerup/pointercancel whose normalized id does not match
    // the one captured at pointerdown is ignored outright (e.g. a second
    // concurrent touch never perturbs an in-flight one-finger pan).
    let panLastX = 0;
    let panLastY = 0;
    const panPointerGate = createPointerIdGate();
    function onPointerDown(event) {
      if (disposed || panPointerGate.isActive()) {
        return;
      }
      // WIDE-029: pan is owned by the empty canvas (or a node/cluster card
      // riding on it) ONLY — never by controls, the minimap, the Overview
      // panel, the findings chip bar, contenteditable regions, or generic
      // interactive controls, even though all of those are DOM descendants
      // of this same viewport.
      if (!ownsCanvasPointerEvent(event.target)) {
        return;
      }
      cancelFly();
      panPointerGate.capture(normalizePointerId(event));
      panLastX = event.clientX;
      panLastY = event.clientY;
      if (viewportEl && typeof viewportEl.setPointerCapture === 'function' && event.pointerId != null) {
        try { viewportEl.setPointerCapture(event.pointerId); } catch (_error) { /* jsdom / no capture */ }
      }
    }
    function onPointerMove(event) {
      if (disposed || !panPointerGate.matches(event)) {
        return;
      }
      const dx = event.clientX - panLastX;
      const dy = event.clientY - panLastY;
      panLastX = event.clientX;
      panLastY = event.clientY;
      panBy(dx, dy, 'pan');
    }
    function endPan(event) {
      if (!panPointerGate.matches(event)) {
        return;
      }
      if (viewportEl && typeof viewportEl.releasePointerCapture === 'function'
        && event && event.pointerId != null) {
        try { viewportEl.releasePointerCapture(event.pointerId); } catch (_error) { /* best-effort */ }
      }
      panPointerGate.release();
    }
    function onWheel(event) {
      if (disposed) {
        return;
      }
      // WIDE-029: a scroll-owning surface (the Overview panel's
      // overflow-y:auto body) or a control must keep native wheel behavior —
      // zoom is owned by the canvas/node/cluster only.
      if (!ownsMapWheelZoom(event.target)) {
        return;
      }
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      const factor = event.deltaY < 0 ? 1.1 : (1 / 1.1);
      zoomToward({ x: event.clientX, y: event.clientY }, state.scale * factor);
    }

    function bindEvents() {
      if (!viewportEl || typeof viewportEl.addEventListener !== 'function') {
        return;
      }
      viewportEl.addEventListener('pointerdown', onPointerDown);
      viewportEl.addEventListener('pointermove', onPointerMove);
      viewportEl.addEventListener('pointerup', endPan);
      viewportEl.addEventListener('pointercancel', endPan);
      viewportEl.addEventListener('wheel', onWheel, { passive: false });
    }
    function unbindEvents() {
      if (!viewportEl || typeof viewportEl.removeEventListener !== 'function') {
        return;
      }
      viewportEl.removeEventListener('pointerdown', onPointerDown);
      viewportEl.removeEventListener('pointermove', onPointerMove);
      viewportEl.removeEventListener('pointerup', endPan);
      viewportEl.removeEventListener('pointercancel', endPan);
      viewportEl.removeEventListener('wheel', onWheel, { passive: false });
    }

    // ── persistence restore ─────────────────────────────────────────────────
    function restore() {
      if (!storage) {
        return;
      }
      let raw = null;
      try { raw = storage.getItem(storageKey); } catch (_error) { /* best-effort */ }
      if (!raw) {
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (_error) { /* corrupt entry ignored */ }
      if (!parsed || typeof parsed !== 'object') {
        return;
      }
      if (Number.isFinite(parsed.scale)) { state.scale = clampScale(parsed.scale); }
      if (Number.isFinite(parsed.tx)) { state.tx = parsed.tx; }
      if (Number.isFinite(parsed.ty)) { state.ty = parsed.ty; }
    }

    function subscribe(fn) {
      if (typeof fn !== 'function' || disposed) {
        return () => {};
      }
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    }

    function getState() {
      return { scale: state.scale, tx: state.tx, ty: state.ty };
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unbindEvents();
      cancelFly();
      if (rafId != null) {
        timers.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (persistTimer != null) {
        timers.clearTimeout(persistTimer);
        persistTimer = null;
      }
      subscribers.clear();
    }

    // ── init ────────────────────────────────────────────────────────────────
    restore();
    bindEvents();

    return {
      getState,
      clientToContent,
      contentToClient,
      zoomToward,
      panBy,
      panTo,
      flyTo,
      flyToFit,
      cancelFly,
      fitToContent,
      reclampToBounds,
      setBounds,
      subscribe,
      dispose,
      _internals: {
        clamp,
        SCALE_MIN,
        SCALE_MAX,
        MIN_CONTENT_VISIBLE,
        PERSIST_DEBOUNCE_MS,
        DEFAULT_STORAGE_KEY_PREFIX,
        storageKey,
        get commitReason() { return pendingReason; },
        get bounds() { return bounds; },
        forceCommitFlush: flushCommit,
      },
    };
  }

  return {
    createMapTransform,
    clamp,
    SCALE_MIN,
    SCALE_MAX,
    MIN_CONTENT_VISIBLE,
    PERSIST_DEBOUNCE_MS,
    DEFAULT_STORAGE_KEY_PREFIX,
  };
});
