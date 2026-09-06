/* renderer/shell/renderer-log-list-virtualizer.js
 *
 * Diagnostics Activity list virtualization. Modeled on
 * renderer/chat/renderer-chat-timeline-virtualizer.js but leaner. Activity may incrementally append
 * rows or perform a bounded rebuild, and has no streaming-bubble morph hazard.
 *
 * Off-viewport `.log-entry[data-log-index]` articles get their inner content
 * replaced by a sized placeholder so a 500-row buffer only keeps the visible
 * window (+/- ~2 viewports) materialized. The article SHELL stays mounted so
 * data-log-index and tabindex survive. Callers can ensureMounted() before
 * focusing an off-screen row.
 *
 * Pin invariant (never unmount): selected and focused rows remain materialized.
 *
 * This is the canonical behavior with no feature-flag branch. When
 * IntersectionObserver is unavailable, rebuild() is a no-op and the list stays
 * fully mounted as a graceful fallback.
 *
 * Disposal (AGENTS.md §5): dispose() disconnects the IntersectionObserver + the
 * class MutationObserver, clears the pending invalidation timer, removes the
 * resize listener, and flips a `disposed` flag that short-circuits
 * rebuild()/onIntersect().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLogListVirtualizer = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VIRT_THRESHOLD = 80;
  var DEFAULT_ROOT_MARGIN = '2000px 0px';
  var HEIGHT_CACHE_CAP = 1000;
  var ROW_SELECTOR = '.log-entry[data-log-index]';
  var PLACEHOLDER_HTML = '<div class="log-entry-virtualized" aria-hidden="true"></div>';

  function createLogListVirtualizer(deps) {
    var options = deps || {};
    var logList = options.logList || null;
    var scrollContainer = options.scrollContainer
      || (logList && logList.parentElement)
      || null;
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (doc && doc.defaultView) || (typeof globalThis !== 'undefined' ? globalThis : null);
    var threshold = typeof options.threshold === 'number' && options.threshold >= 0
      ? options.threshold
      : VIRT_THRESHOLD;
    var rootMargin = typeof options.rootMargin === 'string' && options.rootMargin
      ? options.rootMargin
      : DEFAULT_ROOT_MARGIN;
    var heightCacheCap = typeof options.heightCacheCap === 'number' && options.heightCacheCap > 0
      ? options.heightCacheCap
      : HEIGHT_CACHE_CAP;

    // logId -> last measured outer height in px. Insertion-ordered Map doubles
    // as an LRU when paired with delete-then-set on touch.
    var heightCache = new Map();
    // article element -> unmount stash. WeakMap so a full innerHTML rebuild
    // (which discards every old article) lets the stashes GC automatically.
    var entryStates = new WeakMap();
    var pausedReasons = new Set();
    var observer = null;
    var resizeTimer = null;
    var classObserver = null;
    var disposed = false;
    var engaged = false;

    function getRows() {
      if (!logList || typeof logList.querySelectorAll !== 'function') { return []; }
      return Array.from(logList.querySelectorAll(ROW_SELECTOR));
    }

    function getLogId(el) {
      if (!el || typeof el.getAttribute !== 'function') { return ''; }
      return el.getAttribute('data-log-index') || '';
    }

    function recordHeight(logId, height) {
      if (!logId) { return; }
      if (heightCache.has(logId)) { heightCache.delete(logId); }
      heightCache.set(logId, height);
      while (heightCache.size > heightCacheCap) {
        var oldest = heightCache.keys().next().value;
        heightCache.delete(oldest);
      }
    }

    // Read a cached height (LRU-touch). Used only as a fallback when a live
    // measurement is 0 — e.g. unmounting while the Logs view is display:none, so
    // a row that was sized on a prior visit can still reserve its scroll space.
    function readCachedHeight(logId) {
      if (!logId || !heightCache.has(logId)) { return 0; }
      var h = heightCache.get(logId);
      heightCache.delete(logId);
      heightCache.set(logId, h);
      return h;
    }

    function hasAttribute(el, name) {
      if (!el) { return false; }
      if (typeof el.hasAttribute === 'function') { return el.hasAttribute(name); }
      return el.getAttribute && el.getAttribute(name) !== null;
    }

    function isPinned(el) {
      if (!el) { return true; }
      if (el.getAttribute && el.getAttribute('aria-selected') === 'true') return true;
      var activeEl = doc && doc.activeElement;
      if (activeEl && (activeEl === el || (el.contains && el.contains(activeEl)))) {
        return true;
      }
      return false;
    }

    function measureHeight(el) {
      if (!el || typeof el.getBoundingClientRect !== 'function') { return 0; }
      var rect = el.getBoundingClientRect();
      return Math.max(0, Math.round(rect.height || 0));
    }

    function applyUnmount(el, height) {
      var logId = getLogId(el);
      recordHeight(logId, height);
      entryStates.set(el, {
        originalHtml: el.innerHTML,
        logId: logId,
        previousMinHeight: el.style ? el.style.minHeight : '',
        hadInlineMinHeight: Boolean(el.style && el.style.minHeight),
        previousTabindex: el.getAttribute ? el.getAttribute('tabindex') : null,
        hadTabindex: hasAttribute(el, 'tabindex'),
        previousAriaHidden: el.getAttribute ? el.getAttribute('aria-hidden') : null,
        hadAriaHidden: hasAttribute(el, 'aria-hidden'),
      });
      if (el.style) { el.style.minHeight = height + 'px'; }
      el.innerHTML = PLACEHOLDER_HTML;
      el.setAttribute('data-virtualized', 'true');
      el.setAttribute('tabindex', '-1');
      el.setAttribute('aria-hidden', 'true');
    }

    function applyMount(el) {
      var stash = entryStates.get(el);
      if (!stash) { return null; }
      el.innerHTML = stash.originalHtml;
      el.removeAttribute('data-virtualized');
      if (el.style) {
        el.style.minHeight = stash.hadInlineMinHeight ? stash.previousMinHeight : '';
      }
      if (stash.hadTabindex) {
        el.setAttribute('tabindex', stash.previousTabindex);
      } else {
        el.removeAttribute('tabindex');
      }
      if (stash.hadAriaHidden) {
        el.setAttribute('aria-hidden', stash.previousAriaHidden);
      } else {
        el.removeAttribute('aria-hidden');
      }
      entryStates.delete(el);
      return stash;
    }

    function mountEntry(el) {
      if (!el || disposed) { return false; }
      var stash = applyMount(el);
      if (!stash) { return false; }
      var nextHeight = measureHeight(el);
      if (nextHeight > 0) { recordHeight(stash.logId, nextHeight); }
      return true;
    }

    function ensureMounted(el) {
      return mountEntry(el);
    }

    function ensureMountedForId(logId) {
      var id = String(logId == null ? '' : logId).trim();
      if (!id || !logList || typeof logList.querySelector !== 'function') { return false; }
      var safe = id.replace(/"/g, '\\"');
      var el = logList.querySelector('[data-log-index="' + safe + '"]');
      return el ? ensureMounted(el) : false;
    }

    // Read/write split — measure all unmount candidates first (DOM reads), then
    // mutate (DOM writes), so a scroll burst doesn't force a layout per row.
    function onIntersect(records) {
      if (disposed || pausedReasons.size > 0) { return; }
      var unmountPlans = [];
      var mountTargets = [];
      for (var i = 0; i < records.length; i++) {
        var record = records[i];
        var target = record && record.target;
        if (!target) { continue; }
        if (record.isIntersecting) {
          if (entryStates.has(target)) { mountTargets.push(target); }
        } else {
          if (entryStates.has(target) || isPinned(target)) { continue; }
          var height = measureHeight(target);
          // Fall back to the last cached height when the live measurement is 0
          // (e.g. the view is hidden) so we can still reserve scroll space.
          if (height <= 0) { height = readCachedHeight(getLogId(target)); }
          if (height <= 0) { continue; }
          unmountPlans.push({ target: target, height: height });
        }
      }
      for (var u = 0; u < unmountPlans.length; u++) {
        applyUnmount(unmountPlans[u].target, unmountPlans[u].height);
      }
      for (var m = 0; m < mountTargets.length; m++) {
        applyMount(mountTargets[m]);
      }
    }

    function buildObserver() {
      var IO = (win && win.IntersectionObserver)
        || (typeof IntersectionObserver !== 'undefined' ? IntersectionObserver : null);
      if (!IO) { return null; }
      try {
        return new IO(onIntersect, { root: scrollContainer || null, rootMargin: rootMargin });
      } catch (_e) {
        try {
          return new IO(onIntersect, { rootMargin: rootMargin });
        } catch (__e) {
          return null;
        }
      }
    }

    function disconnectObserver() {
      if (observer) {
        try { observer.disconnect(); } catch (_e) { /* best-effort */ }
        observer = null;
      }
    }

    function setEngaged(on) {
      engaged = on;
      if (!logList || typeof logList.setAttribute !== 'function') { return; }
      if (on) {
        logList.setAttribute('data-logs-virtualized', 'true');
      } else if (typeof logList.removeAttribute === 'function') {
        logList.removeAttribute('data-logs-virtualized');
      }
    }

    // Call after each full list render. Re-observes the freshly-built rows
    // (old observed elements are gone with the old innerHTML). Below threshold,
    // disengages and remounts anything left stashed.
    function rebuild() {
      if (disposed || pausedReasons.size > 0) { return; }
      var rows = getRows();
      if (rows.length < threshold) {
        disconnectObserver();
        for (var r = 0; r < rows.length; r++) {
          if (entryStates.has(rows[r])) { mountEntry(rows[r]); }
        }
        setEngaged(false);
        return;
      }
      disconnectObserver();
      observer = buildObserver();
      if (!observer) { setEngaged(false); return; }
      setEngaged(true);
      for (var i = 0; i < rows.length; i++) {
        observer.observe(rows[i]);
      }
    }

    function pause(reason) {
      if (disposed) { return; }
      pausedReasons.add(String(reason || 'default'));
      disconnectObserver();
      var rows = getRows();
      for (var i = 0; i < rows.length; i++) {
        if (entryStates.has(rows[i])) { applyMount(rows[i]); }
      }
    }

    function resume(reason) {
      if (disposed) { return; }
      pausedReasons.delete(String(reason || 'default'));
      if (pausedReasons.size > 0) { return; }
      rebuild();
    }

    function clearResizeTimer() {
      if (resizeTimer == null) { return; }
      var clear = win && typeof win.clearTimeout === 'function' ? win.clearTimeout.bind(win) : clearTimeout;
      try { clear(resizeTimer); } catch (_e) { /* best-effort */ }
      resizeTimer = null;
    }

    // Row heights change on viewport resize, so clear cached placeholder heights
    // and rebuild. Debounced to coalesce resize storms.
    function scheduleInvalidate() {
      if (disposed) { return; }
      clearResizeTimer();
      var setT = win && typeof win.setTimeout === 'function' ? win.setTimeout.bind(win) : setTimeout;
      resizeTimer = setT(function invalidate() {
        resizeTimer = null;
        if (disposed) { return; }
        heightCache.clear();
        rebuild();
      }, 150);
    }

    function connectInvalidationHooks() {
      if (win && typeof win.addEventListener === 'function') {
        try { win.addEventListener('resize', scheduleInvalidate, { passive: true }); } catch (_e) { /* best-effort */ }
      }
      var MO = win && typeof win.MutationObserver === 'function'
        ? win.MutationObserver
        : (typeof MutationObserver === 'function' ? MutationObserver : null);
      var shell = logList && typeof logList.closest === 'function' ? logList.closest('.logs-shell') : null;
      if (MO && shell) {
        try {
          classObserver = new MO(scheduleInvalidate);
          classObserver.observe(shell, { attributes: true, attributeFilter: ['class'] });
        } catch (_e2) {
          classObserver = null;
        }
      }
    }

    function dispose() {
      if (disposed) { return; }
      disposed = true;
      disconnectObserver();
      clearResizeTimer();
      if (win && typeof win.removeEventListener === 'function') {
        try { win.removeEventListener('resize', scheduleInvalidate); } catch (_e) { /* best-effort */ }
      }
      if (classObserver) {
        try { classObserver.disconnect(); } catch (_e2) { /* best-effort */ }
        classObserver = null;
      }
      // Don't restore innerHTML on dispose — teardown is about to wipe logList
      // (post-dispose mutation hazard). Just drop bookkeeping.
      heightCache.clear();
      pausedReasons.clear();
      setEngaged(false);
    }

    connectInvalidationHooks();

    return {
      rebuild: rebuild,
      pause: pause,
      resume: resume,
      ensureMounted: ensureMounted,
      ensureMountedForId: ensureMountedForId,
      dispose: dispose,
      _internals: {
        isPinned: isPinned,
        isEngaged: function () { return engaged; },
        hasObserver: function () { return observer !== null; },
        isVirtualized: function (el) { return entryStates.has(el); },
        getHeightCache: function () { return heightCache; },
        getPausedReasons: function () { return pausedReasons; },
      },
    };
  }

  return { createLogListVirtualizer: createLogListVirtualizer };
});
