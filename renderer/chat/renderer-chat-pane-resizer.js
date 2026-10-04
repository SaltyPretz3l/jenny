/* renderer/chat/renderer-chat-pane-resizer.js -- the split-view pane divider (UMD) */
/**
 * The divider between the two conversation panes (split view W1-3).
 *
 * Contract:
 *   - Everything is injected. `resizerEl` is the separator, `chatViewEl` is
 *     `#chatView` (it receives `--chat-pane-a`/`--chat-pane-b` and
 *     `data-pane-resizing`). `getSplitRatio()` reads the ratio the pane model
 *     holds; `setSplitRatio(ratio)` writes it through `normalizePaneLayout`
 *     and returns the CLAMPED ratio the model kept. The module renders only
 *     that returned value, never its own number: the model is the single
 *     source of truth for the clamp.
 *   - Once per frame. `pointermove` stores a pending ratio and schedules at
 *     most ONE animation frame; the frame does one `setSplitRatio` and one
 *     write pair (plus `aria-valuenow`). The width is read ONCE per gesture,
 *     at `pointerdown`, through `measureWidth()` when the caller injects it
 *     (the two panes plus the divider, so an open artifact or context column
 *     never slows the divider behind the pointer) and otherwise from
 *     `chatViewEl`'s own rectangle; no layout read happens during the drag.
 *   - Persist after the gesture. `onPersist(ratio)` runs once per finished
 *     gesture (pointerup, pointercancel, lostpointercapture, Escape, each
 *     keyboard step) and never during `pointermove`. Debouncing is the
 *     caller's job.
 *   - A cancelled drag (pointercancel, Escape) restores the START ratio; a
 *     lost capture finishes at the last applied ratio. Neither leaves a
 *     half-applied value behind.
 *   - Keyboard (outside a drag): ArrowLeft/ArrowRight step by KEYBOARD_STEP
 *     (inverted under RTL), Home -> HOME_RATIO, End -> END_RATIO; one key,
 *     one synchronous write, one persist.
 *   - A pixel floor (gate F3, 2026-09-27): `minPaneWidth` (px at Text size 1,
 *     default MIN_PANE_WIDTH_PX, 0 turns it off). Neither pane is dragged or
 *     stepped below it: the ratio is clamped to
 *     [floor / width, 1 - floor / width] (never past an even split) before it
 *     reaches the model, and aria-valuemin/max follow. The floor scales up
 *     with --font-scale above 1 (Text size grows the composer). The width
 *     is the gesture's one read (a key reads it once, as pointerdown does).
 *   - The module never reads or writes app state, never persists by itself,
 *     never toggles the divider's visibility and never queries the document
 *     by id. `bind()` and `dispose()` are idempotent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererChatPaneResizer = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var KEYBOARD_STEP = 0.02;
  var HOME_RATIO = 0.5;
  var END_RATIO = 0.8;
  var FALLBACK_MIN_RATIO = 0.2;
  var FALLBACK_MAX_RATIO = 0.8;
  /* The narrowest pane whose composer still lays out its one-line toolbar
     while streaming, every control kept (styles/chat-composer-fit.css):
     composer chrome 22 + Attach and Commands 70 + the summary pill at its
     mode icon and caret 44 + Pause, Stop and Send (icon only when squeezed)
     3 x 48 + three 6px gaps = 298px at zoom 1; 320 leaves room for the
     divider's share of the measured width. A ratio floor alone gave 156px
     at the gate's width. tests/renderer-composer-narrow-layout.test.js lays
     the real stylesheet out at this width. */
  var MIN_PANE_WIDTH_PX = 320;

  // The pane model is a sibling UMD module: `require` it in Node, read the
  // global it publishes in the browser. Resolved at create time, so script
  // order only matters for when the factory is called.
  function resolvePaneModel() {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      try {
        return require('../shell/renderer-pane-model');
      } catch (_) {
        return null;
      }
    }
    return (root && root.rendererPaneModel) || null;
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function round4(value) {
    return Math.round(value * 10000) / 10000;
  }

  function createChatPaneResizer(deps) {
    var resizerEl = deps && deps.resizerEl;
    var chatViewEl = deps && deps.chatViewEl;
    var getSplitRatio = deps && deps.getSplitRatio;
    var setSplitRatio = deps && deps.setSplitRatio;
    var onPersist = deps && typeof deps.onPersist === 'function' ? deps.onPersist : function () {};
    var doc = chatViewEl && chatViewEl.ownerDocument;
    var win = (doc && doc.defaultView) || null;

    var requestFrame = deps && typeof deps.requestAnimationFrame === 'function'
      ? deps.requestAnimationFrame
      : win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null;
    var cancelFrame = deps && typeof deps.cancelAnimationFrame === 'function'
      ? deps.cancelAnimationFrame
      : win && typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : function () {};
    var measureWidth = deps && typeof deps.measureWidth === 'function'
      ? deps.measureWidth
      : function () { return chatViewEl.getBoundingClientRect().width; };
    var isRtl = deps && typeof deps.isRtl === 'function'
      ? deps.isRtl
      : function () { return Boolean(doc && doc.documentElement && doc.documentElement.dir === 'rtl'); };

    var paneModel = resolvePaneModel();
    var minRatio = isFiniteNumber(deps && deps.minRatio) ? deps.minRatio
      : paneModel && isFiniteNumber(paneModel.MIN_SPLIT_RATIO) ? paneModel.MIN_SPLIT_RATIO : FALLBACK_MIN_RATIO;
    var maxRatio = isFiniteNumber(deps && deps.maxRatio) ? deps.maxRatio
      : paneModel && isFiniteNumber(paneModel.MAX_SPLIT_RATIO) ? paneModel.MAX_SPLIT_RATIO : FALLBACK_MAX_RATIO;

    var minPaneWidth = isFiniteNumber(deps && deps.minPaneWidth) ? Math.max(0, deps.minPaneWidth) : MIN_PANE_WIDTH_PX;

    var abortController = null;
    var removers = null;
    var sizeObserver = null;
    var drag = null;
    var frameId = 0;
    var framePending = false;

    function zoomFactor() {
      var view = win && typeof win.getComputedStyle === 'function' ? win : null;
      var zoom = view ? parseFloat(view.getComputedStyle(chatViewEl).getPropertyValue('--font-scale')) : NaN;
      return isFiniteNumber(zoom) && zoom > 1 ? zoom : 1;
    }

    // The ratio range that keeps both panes at least the pixel floor wide at
    // `width`, inside the model's own range; null without a floor or a width.
    function floorBounds(width) {
      if (!minPaneWidth || !isFiniteNumber(width) || width <= 0) return null;
      var share = Math.min(0.5, (minPaneWidth * zoomFactor()) / width);
      var bounds = { min: Math.max(minRatio, round4(share)), max: Math.min(maxRatio, round4(1 - share)) };
      resizerEl.setAttribute('aria-valuemin', String(Math.round(bounds.min * 100)));
      resizerEl.setAttribute('aria-valuemax', String(Math.round(bounds.max * 100)));
      return bounds;
    }

    function clampToFloor(ratio, bounds) {
      return bounds ? Math.min(bounds.max, Math.max(bounds.min, ratio)) : ratio;
    }

    function readCurrentRatio() {
      var value = typeof getSplitRatio === 'function' ? getSplitRatio() : NaN;
      return isFiniteNumber(value) ? value : HOME_RATIO;
    }

    // The only per-frame writes: the two grid tracks and aria-valuenow.
    function applyRatio(ratio) {
      chatViewEl.style.setProperty('--chat-pane-a', round4(ratio) + 'fr');
      chatViewEl.style.setProperty('--chat-pane-b', round4(1 - ratio) + 'fr');
      resizerEl.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    }

    // Hand the model a ratio, render what it kept. Returns the kept ratio, or
    // null when the model answered with something that is not a ratio.
    function commitRatio(ratio) {
      var kept = typeof setSplitRatio === 'function' ? setSplitRatio(ratio) : NaN;
      if (!isFiniteNumber(kept)) return null;
      applyRatio(kept);
      return kept;
    }

    function cancelPendingFrame() {
      if (!framePending) return;
      framePending = false;
      cancelFrame(frameId);
      frameId = 0;
    }

    function runFrame() {
      framePending = false;
      frameId = 0;
      if (!drag || drag.pending === null) return;
      var pending = drag.pending;
      drag.pending = null;
      var kept = commitRatio(pending);
      if (kept !== null) drag.applied = kept;
    }

    function scheduleFrame() {
      if (framePending) return;
      if (!requestFrame) {
        runFrame();
        return;
      }
      framePending = true;
      frameId = requestFrame(runFrame);
    }

    function clearDragMarks() {
      resizerEl.classList.remove('dragging');
      chatViewEl.removeAttribute('data-pane-resizing');
    }

    // mode: 'commit' (pointerup), 'restore' (pointercancel/Escape),
    // 'keep' (lostpointercapture: finish at the last applied ratio).
    function finishDrag(mode) {
      var ending = drag;
      if (!ending) return;
      cancelPendingFrame();
      var finalRatio = ending.applied;
      if (mode === 'commit' && ending.pending !== null) {
        var kept = commitRatio(ending.pending);
        if (kept !== null) finalRatio = kept;
      } else if (mode === 'restore') {
        var restored = commitRatio(ending.startRatio);
        finalRatio = restored !== null ? restored : ending.startRatio;
      }
      // Cleared before the capture is released, so a synchronous
      // lostpointercapture from the release finds no drag to finish twice.
      drag = null;
      clearDragMarks();
      if (mode !== 'keep') {
        try { resizerEl.releasePointerCapture(ending.pointerId); } catch (_) { /* best-effort */ }
      }
      onPersist(finalRatio);
    }

    function handlePointerDown(event) {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      var width = measureWidth();
      if (!isFiniteNumber(width) || width <= 0) return;
      var startRatio = readCurrentRatio();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startRatio: startRatio,
        width: width,
        direction: isRtl() ? -1 : 1,
        pending: null,
        applied: startRatio,
        bounds: floorBounds(width),
      };
      try { resizerEl.setPointerCapture(event.pointerId); } catch (_) { /* best-effort */ }
      resizerEl.classList.add('dragging');
      chatViewEl.setAttribute('data-pane-resizing', '');
    }

    function handlePointerMove(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.pending = clampToFloor(round4(drag.startRatio + (drag.direction * (event.clientX - drag.startX)) / drag.width), drag.bounds);
      scheduleFrame();
    }

    function handlePointerUp(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      finishDrag('commit');
    }

    function handlePointerCancel(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      finishDrag('restore');
    }

    function handleLostPointerCapture(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      finishDrag('keep');
    }

    // Capture phase on the document: during a drag the separator may not hold
    // focus (a prevented pointerdown does not focus it), so Escape is caught
    // wherever it lands.
    function handleEscape(event) {
      if (!drag || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag('restore');
    }

    function handleKeydown(event) {
      if (drag) return;
      var target;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        var sign = event.key === 'ArrowRight' ? 1 : -1;
        if (isRtl()) sign = -sign;
        target = round4(readCurrentRatio() + sign * KEYBOARD_STEP);
      } else if (event.key === 'Home') {
        target = HOME_RATIO;
      } else if (event.key === 'End') {
        target = END_RATIO;
      } else {
        return;
      }
      event.preventDefault();
      var kept = commitRatio(clampToFloor(target, minPaneWidth ? floorBounds(measureWidth()) : null));
      if (kept !== null) onPersist(kept);
    }

    function listen(target, type, handler, capture) {
      if (abortController) {
        target.addEventListener(type, handler, { signal: abortController.signal, capture: Boolean(capture) });
        return;
      }
      target.addEventListener(type, handler, Boolean(capture));
      removers.push(function () { target.removeEventListener(type, handler, Boolean(capture)); });
    }

    function bind() {
      if (!resizerEl || !chatViewEl || abortController || removers) return;
      var Controller = (win && win.AbortController) || (typeof AbortController === 'function' ? AbortController : null);
      if (Controller) abortController = new Controller();
      else removers = [];
      resizerEl.setAttribute('aria-valuemin', String(Math.round(minRatio * 100)));
      resizerEl.setAttribute('aria-valuemax', String(Math.round(maxRatio * 100)));
      listen(resizerEl, 'pointerdown', handlePointerDown);
      listen(resizerEl, 'pointermove', handlePointerMove);
      listen(resizerEl, 'pointerup', handlePointerUp);
      listen(resizerEl, 'pointercancel', handlePointerCancel);
      listen(resizerEl, 'lostpointercapture', handleLostPointerCapture);
      listen(resizerEl, 'keydown', handleKeydown);
      if (doc) listen(doc, 'keydown', handleEscape, true);
      if (!minPaneWidth) return;
      // The view's own size, not the window's: a resize while Chat is hidden
      // measures nothing, and the floor must re-apply when it shows again.
      var Observer = win && typeof win.ResizeObserver === 'function' ? win.ResizeObserver : null;
      if (Observer) {
        try {
          sizeObserver = new Observer(handleWindowResize);
          sizeObserver.observe(chatViewEl);
          var pane0 = Array.from(chatViewEl.children).find(function (el) { return el.dataset.paneId === '0'; });
          if (pane0) sizeObserver.observe(pane0);
          return;
        } catch (_) { sizeObserver = null; }
      }
      if (win && typeof win.addEventListener === 'function') listen(win, 'resize', handleWindowResize);
    }

    // Display-level floor on hydration and on a window resize: a persisted
    // ratio below the floor (saved before the floor, or on a wider window) is
    // shown clamped, never rewritten (Astra review of gate F3).
    function sync() {
      if (!resizerEl || !chatViewEl) return;
      applyRatio(clampToFloor(readCurrentRatio(), minPaneWidth ? floorBounds(measureWidth()) : null));
    }

    function handleWindowResize() {
      if (!drag) sync();
    }

    function isDragging() {
      return drag !== null;
    }

    function dispose() {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      if (removers) {
        removers.forEach(function (remove) { remove(); });
        removers = null;
      }
      if (sizeObserver) {
        try { sizeObserver.disconnect(); } catch (_) { /* best-effort */ }
        sizeObserver = null;
      }
      cancelPendingFrame();
      if (drag) {
        var pointerId = drag.pointerId;
        drag = null;
        try { resizerEl.releasePointerCapture(pointerId); } catch (_) { /* best-effort */ }
      }
      if (resizerEl && chatViewEl) clearDragMarks();
    }

    return {
      bind: bind,
      sync: sync,
      isDragging: isDragging,
      dispose: dispose,
    };
  }

  return {
    createChatPaneResizer: createChatPaneResizer,
    KEYBOARD_STEP: KEYBOARD_STEP,
    HOME_RATIO: HOME_RATIO,
    END_RATIO: END_RATIO,
    MIN_PANE_WIDTH_PX: MIN_PANE_WIDTH_PX,
  };
});
