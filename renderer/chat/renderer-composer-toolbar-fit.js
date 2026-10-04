/* renderer/chat/renderer-composer-toolbar-fit.js
 * Collapse a composer's settings into one summary pill when its one-line
 * toolbar would overflow. Split view W3-3, owner decision 2026-09-26 "B",
 * for every Chat and Workspace dock composer. A host change forgets the
 * remembered width so the verify frame measures the new layout.
 *
 *   createToolbarFit({ target, measure, apply, requestFrame, cancelFrame,
 *                      ResizeObserverCtor, getHost })
 *     -> { recheck(), isCompact(), dispose() }
 *
 * `measure()` does the ONE layout read and returns `{ available, needed }`:
 * the toolbar's width and, while expanded, the width its one-line content
 * needs. Hysteresis: expanded and `needed > available` collapses and
 * remembers `needed`; collapsed and `available >= remembered` expands, then
 * one verify frame re-measures (a label that grew while collapsed re-collapses
 * with the larger width, so the boundary never flip-flops). `available <= 0`
 * (a folded pane, display: none) decides nothing.
 *
 * Evaluation runs only from the ResizeObserver and `recheck()` (a rail label
 * changed), coalesced into one frame; never per stream frame. `apply(compact)`
 * is the only writer of the caller's attributes and runs only on a change.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerToolbarFit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TOLERANCE_PX = 1;

  function createToolbarFit(options) {
    var opts = options || {};
    var target = opts.target || null;
    var measure = typeof opts.measure === 'function' ? opts.measure : function () { return null; };
    var apply = typeof opts.apply === 'function' ? opts.apply : function () {};
    var requestFrame = typeof opts.requestFrame === 'function'
      ? opts.requestFrame
      : (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame.bind(globalThis) : function (callback) { callback(); return 0; });
    var cancelFrame = typeof opts.cancelFrame === 'function'
      ? opts.cancelFrame
      : (globalThis.cancelAnimationFrame ? globalThis.cancelAnimationFrame.bind(globalThis) : function () {});
    var getHost = typeof opts.getHost === 'function' ? opts.getHost : function () {
      return target && typeof target.closest === 'function' && target.closest('.ide-chat-dock-body') ? 'dock' : 'chat';
    };
    var ResizeObserverCtor = opts.ResizeObserverCtor !== undefined ? opts.ResizeObserverCtor : globalThis.ResizeObserver;

    var compact = false;
    var remembered = 0;
    var lastHost;
    var frame = 0;
    var scheduled = false;
    var disposed = false;
    var observer = null;

    function setCompact(next) {
      if (compact === next) return;
      compact = next;
      apply(next);
    }

    function evaluate() {
      frame = 0;
      scheduled = false;
      if (disposed) return;
      var host = getHost();
      if (host !== lastHost && compact) remembered = 0;
      lastHost = host;
      var reading = measure() || {};
      var available = Number(reading.available) || 0;
      if (available <= 0) return;
      if (!compact) {
        var needed = Number(reading.needed) || 0;
        if (needed > available + TOLERANCE_PX) {
          remembered = needed;
          setCompact(true);
        }
        return;
      }
      if (available + TOLERANCE_PX >= remembered) {
        setCompact(false);
        schedule();
      }
    }

    function schedule() {
      if (disposed || scheduled) return;
      scheduled = true;
      frame = requestFrame(evaluate) || 0;
    }

    if (typeof ResizeObserverCtor === 'function' && target) {
      observer = new ResizeObserverCtor(function onResize() { schedule(); });
      observer.observe(target);
    }
    schedule();

    return {
      recheck: schedule,
      isCompact: function isCompact() { return compact; },
      dispose: function dispose() {
        if (disposed) return;
        disposed = true;
        if (scheduled) cancelFrame(frame);
        scheduled = false;
        if (observer) observer.disconnect();
        observer = null;
      },
    };
  }

  return { createToolbarFit: createToolbarFit };
});
