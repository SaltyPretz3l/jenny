/* renderer/chat/renderer-browser-use-placement.js - keeps the native browser view over its spot in the panel.
 *
 * A native view paints above every DOM element, so anything the app opens over the panel (a menu, a dialog) would
 * vanish behind it. A grid of hit tests notices that; the view is then swapped for a still picture of itself until
 * the panel is clear again. Bounds are sent in CSS pixels: the main process applies the app zoom.
 *
 * Loaded lazily with renderer-browser-use-panel.js, and listens to nothing while no page is on screen.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBrowserUsePlacement = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SETTLE_FRAMES = 3;
  const LATE_CHECK_MS = 150; // for a menu that opens a moment after the click that asked for it
  const THAW_POLL_MS = 250;
  const HIT_SPACING_PX = 80;
  const HIT_INSET_PX = 3;
  const MAX_HIT_POINTS_PER_AXIS = 14;
  const WATCHED_EVENTS = Object.freeze(['pointerdown', 'click', 'contextmenu', 'focusin', 'inv-popover-toggle']);
  const OPENING_KEYS = new Set(['Enter', 'Escape', 'Tab', ' ', 'ContextMenu']);
  const GONE_REASONS = new Set(['no_page', 'not_shown']);

  function measure(stage) {
    const rect = stage.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    return width > 0 && height > 0 ? { x: Math.round(rect.left), y: Math.round(rect.top), width, height } : null;
  }

  // Typing in the composer must not cost a grid of hit tests per keystroke.
  function mayOpenSomething(event) {
    return OPENING_KEYS.has(event.key) || /^F[0-9]{1,2}$/.test(event.key) || event.ctrlKey || event.metaKey || event.altKey;
  }

  function sameBounds(a, b) {
    return Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  function hitAxis(start, end) {
    const span = end - start;
    if (span <= 0) return [];
    const steps = Math.min(MAX_HIT_POINTS_PER_AXIS - 1, Math.max(1, Math.ceil(span / HIT_SPACING_PX)));
    return Array.from({ length: steps + 1 }, (_unused, index) => start + (span * index) / steps);
  }

  function createBrowserUsePlacement(deps) {
    const { windowRef, getApi, getTarget, getStage, getFrozenImage, appendClientLog = () => {} } = deps;
    const doc = windowRef.document;
    let shownSession = '';
    let lastBounds = null;
    let frozenSession = '';
    let freezeToken = 0;
    let imageOwed = false; // the still picture stays up until the live view is back in its place
    let frameId = 0;
    let settleFrames = 0;
    let lateTimer = 0;
    let thawTimer = 0;
    let watching = false;
    let watchedStage = null;
    let resizeObserver = null;
    let mutationObserver = null;
    let disposed = false;

    function call(method, payload) {
      return Promise.resolve()
        .then(() => getApi()?.[method]?.(payload) ?? null)
        .catch((error) => {
          appendClientLog('WARN', 'browser_use.panel_call_failed', { method, message: String(error?.message || error || '').slice(0, 200) });
          return null;
        });
    }

    function clearImage() {
      imageOwed = false;
      const image = getFrozenImage();
      if (!image) return;
      image.classList.add('hidden');
      image.removeAttribute('src');
    }

    function park() {
      if (shownSession) void call('hide', { session_id: shownSession });
      shownSession = '';
      lastBounds = null;
    }

    function place(sessionId, bounds) {
      const method = shownSession === sessionId ? 'setBounds' : 'show';
      shownSession = sessionId;
      lastBounds = bounds;
      void call(method, { session_id: sessionId, bounds }).then((answer) => {
        if (answer && answer.ok !== true && GONE_REASONS.has(answer.reason) && shownSession === sessionId) {
          shownSession = '';
          lastBounds = null;
        }
        if (imageOwed) clearImage();
      });
    }

    function isCovered(stage) {
      const rect = stage.getBoundingClientRect();
      const xs = hitAxis(Math.max(rect.left, 0) + HIT_INSET_PX, Math.min(rect.right, windowRef.innerWidth) - HIT_INSET_PX);
      const ys = hitAxis(Math.max(rect.top, 0) + HIT_INSET_PX, Math.min(rect.bottom, windowRef.innerHeight) - HIT_INSET_PX);
      for (const y of ys) {
        for (const x of xs) {
          const hit = doc.elementFromPoint(x, y);
          if (hit && !stage.contains(hit)) return true;
        }
      }
      return false;
    }

    function stopThawPoll() {
      if (thawTimer) windowRef.clearInterval(thawTimer);
      thawTimer = 0;
    }

    function endFreeze() {
      frozenSession = '';
      freezeToken += 1;
      stopThawPoll();
      imageOwed = true;
    }

    async function freeze(sessionId) {
      frozenSession = sessionId;
      const token = ++freezeToken;
      if (!thawTimer) thawTimer = windowRef.setInterval(() => request(1), THAW_POLL_MS);
      const shot = await call('capture', { session_id: sessionId });
      if (token !== freezeToken) return;
      const image = getFrozenImage();
      if (shot?.ok === true && typeof shot.data_url === 'string' && image) {
        image.src = shot.data_url;
        image.classList.remove('hidden');
        try {
          await image.decode?.();
        } catch (_error) { /* the live view still leaves; a blank beats covering the menu */ }
        if (token !== freezeToken) return;
      }
      park();
    }

    function onSignal() {
      request();
      if (lateTimer) windowRef.clearTimeout(lateTimer);
      lateTimer = windowRef.setTimeout(() => { lateTimer = 0; request(); }, LATE_CHECK_MS);
    }
    const onResize = () => request();
    const onKeydown = (event) => { if (mayOpenSomething(event)) onSignal(); };

    function observeStage(stage) {
      if (watchedStage === stage) return;
      resizeObserver?.disconnect();
      watchedStage = stage;
      if (typeof windowRef.ResizeObserver !== 'function') return;
      resizeObserver = resizeObserver || new windowRef.ResizeObserver(onResize);
      resizeObserver.observe(stage);
    }

    function watch(stage) {
      observeStage(stage);
      if (watching) return;
      watching = true;
      for (const type of WATCHED_EVENTS) doc.addEventListener(type, onSignal, true);
      doc.addEventListener('keydown', onKeydown, true);
      windowRef.addEventListener('resize', onResize);
      if (typeof windowRef.MutationObserver !== 'function') return;
      mutationObserver = new windowRef.MutationObserver(onSignal);
      mutationObserver.observe(doc.body, { childList: true });
      const toasts = doc.getElementById('toastViewport');
      if (toasts) mutationObserver.observe(toasts, { childList: true });
    }

    function unwatch() {
      resizeObserver?.disconnect();
      watchedStage = null;
      if (lateTimer) windowRef.clearTimeout(lateTimer);
      lateTimer = 0;
      if (!watching) return;
      watching = false;
      for (const type of WATCHED_EVENTS) doc.removeEventListener(type, onSignal, true);
      doc.removeEventListener('keydown', onKeydown, true);
      windowRef.removeEventListener('resize', onResize);
      mutationObserver?.disconnect();
      mutationObserver = null;
    }

    function standDown() {
      if (frozenSession) endFreeze();
      if (imageOwed) clearImage();
      park();
      unwatch();
    }

    // One pass. Returns whether the view moved, so the frame loop keeps following a column in motion.
    function apply() {
      const target = getTarget();
      const stage = target ? getStage() : null;
      const bounds = stage ? measure(stage) : null;
      if (!target || !bounds) {
        standDown();
        return false;
      }
      watch(stage);
      if (shownSession && shownSession !== target.sessionId) park();
      if (frozenSession && frozenSession !== target.sessionId) {
        endFreeze();
        clearImage();
      }
      const covered = isCovered(stage);
      if (frozenSession && covered) return false;
      if (covered) {
        void freeze(target.sessionId);
        return false;
      }
      if (frozenSession) endFreeze();
      if (shownSession === target.sessionId && sameBounds(bounds, lastBounds)) {
        if (imageOwed) clearImage();
        return false;
      }
      place(target.sessionId, bounds);
      return true;
    }

    function onFrame() {
      frameId = 0;
      if (disposed) return;
      settleFrames = apply() ? SETTLE_FRAMES : settleFrames - 1;
      if (settleFrames > 0) frameId = windowRef.requestAnimationFrame(onFrame);
    }

    function request(frames = SETTLE_FRAMES) {
      if (disposed) return;
      settleFrames = Math.max(settleFrames, frames);
      if (!frameId) frameId = windowRef.requestAnimationFrame(onFrame);
    }

    // The page is gone: the main process has nothing left to hide.
    function forget(sessionId) {
      if (shownSession !== sessionId) return;
      shownSession = '';
      lastBounds = null;
    }

    function dispose() {
      if (disposed) return;
      standDown();
      disposed = true;
      if (frameId) windowRef.cancelAnimationFrame(frameId);
      frameId = 0;
    }

    return { request, forget, dispose };
  }

  return { createBrowserUsePlacement };
});
