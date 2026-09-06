/* renderer/shared/terminal-stream-utils.js — shared bounded terminal-stream
 * primitives (sibling to ansi-stream-utils.js).
 *
 * Shared by Run Scripts and the terminal panels:
 *
 * - createBoundedScrollbackPainter — a drop-oldest bounded chunk store with
 *   rAF-coalesced incremental text-node painting into a <pre> scrollback.
 *   Evictions are mirrored into the DOM by trimming head text nodes (never a
 *   full re-render per chunk), a full repaint from the bounded store runs
 *   only when the target <pre> identity changes, and a paint that finds no
 *   visible <pre> (panel backgrounded) DISCARDS the pending deltas so a
 *   chatty stream can never grow the pending list unbounded — the next
 *   visible paint repaints in full from the bounded store instead.
 *
 * - createPreReadyEventBuffer — bounded drop-oldest buffering for stream
 *   events that race the start()/spawn reply (the window where data/exit
 *   pushes can arrive before the caller knows its own task/session id).
 *   Cumulative dropped-event/byte accounting is surfaced through onDrop so
 *   truncation is never silent (AGENTS.md section 9 — bounded state).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTerminalStreamUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Mirror a drop-oldest eviction into the painted DOM by trimming text off
  // the head text node(s) instead of re-rendering the whole scrollback.
  function trimDomHead(pre, charCount) {
    let remaining = charCount;
    while (remaining > 0 && pre.firstChild) {
      const node = pre.firstChild;
      const text = String(node.data ?? node.nodeValue ?? '');
      if (text.length <= remaining) {
        remaining -= text.length;
        pre.removeChild(node);
      } else {
        node.data = text.slice(remaining);
        remaining = 0;
      }
    }
  }

  /**
   * options:
   *   requestFrame(cb) / cancelFrame(handle) — frame scheduling (injectable
   *     for deterministic tests; callers pass their resolved rAF pair).
   *   maxChars — drop-oldest cap for the retained chunk store.
   *   getScrollbackEl() — resolves the live target <pre> (null when the
   *     owning panel is not visible; the painter discards pending deltas).
   *   applyDroppedMarkers(pre, droppedChars) — writes the panel-specific
   *     dropped-output dataset markers after each paint/reset (dataset key
   *     names differ per consumer; extra per-panel counters stay theirs).
   */
  function createBoundedScrollbackPainter(options) {
    const source = options || {};
    const requestFrame = source.requestFrame;
    const cancelFrame = source.cancelFrame;
    const maxChars = source.maxChars;
    const getScrollbackEl = source.getScrollbackEl;
    const applyDroppedMarkers = typeof source.applyDroppedMarkers === 'function'
      ? source.applyDroppedMarkers
      : function noopMarkers() {};

    let chunks = [];
    let chars = 0;
    let pendingChunks = [];
    let pendingEvictedChars = 0;
    let droppedChars = 0;
    let paintedPre = null;
    let frame = null;

    function paint() {
      frame = null;
      const pre = getScrollbackEl();
      if (!pre) {
        // Backgrounded: discard pending deltas so a chatty stream can't grow
        // pendingChunks unbounded; nulling paintedPre forces the next visible
        // paint to repaint in full from the bounded chunk store.
        pendingChunks = [];
        pendingEvictedChars = 0;
        paintedPre = null;
        return;
      }
      const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 48;
      if (paintedPre !== pre) {
        while (pre.firstChild) pre.removeChild(pre.firstChild);
        const text = chunks.join('');
        if (text) pre.appendChild(pre.ownerDocument.createTextNode(text));
        paintedPre = pre;
      } else {
        const text = pendingChunks.join('');
        if (text) pre.appendChild(pre.ownerDocument.createTextNode(text));
        trimDomHead(pre, pendingEvictedChars);
      }
      pendingChunks = [];
      pendingEvictedChars = 0;
      applyDroppedMarkers(pre, droppedChars);
      if (nearBottom || !pre.scrollTop) pre.scrollTop = pre.scrollHeight;
    }

    // Appends ALREADY-CLEAN text (the caller owns ANSI stripping / CR
    // normalization). Drop-oldest past maxChars, with the running dropped
    // total surfaced via applyDroppedMarkers — never a silent truncation.
    // Does NOT schedule: callers decide (some need a paint even for an
    // empty append, e.g. to refresh dropped-byte markers).
    function append(cleanText) {
      const cleaned = String(cleanText || '');
      if (!cleaned) return;
      chunks.push(cleaned);
      pendingChunks.push(cleaned);
      chars += cleaned.length;
      while (chars > maxChars && chunks.length) {
        const excess = chars - maxChars;
        const first = chunks[0];
        const removed = Math.min(excess, first.length);
        if (removed === first.length) chunks.shift();
        else chunks[0] = first.slice(removed);
        chars -= removed;
        pendingEvictedChars += removed;
        droppedChars += removed;
      }
    }

    function schedule() {
      if (frame !== null) return;
      frame = requestFrame(paint);
    }

    // Cancel any pending coalesced frame without painting (dispose paths).
    function cancel() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
    }

    // Synchronous paint for render passes (panel activation, state changes):
    // collapses any pending frame so the DOM is current before returning.
    function sync() {
      cancel();
      paint();
    }

    // Full reset: clears the store AND the target <pre>. Callers reset any
    // extra per-panel counters (e.g. service-side dropped bytes) BEFORE
    // calling so applyDroppedMarkers writes fresh zeros here.
    function reset() {
      cancel();
      chunks = [];
      chars = 0;
      pendingChunks = [];
      pendingEvictedChars = 0;
      droppedChars = 0;
      const pre = getScrollbackEl();
      if (pre) {
        while (pre.firstChild) pre.removeChild(pre.firstChild);
        applyDroppedMarkers(pre, 0);
      }
      paintedPre = pre;
    }

    return { append, schedule, sync, cancel, reset };
  }

  /**
   * options:
   *   maxEvents / maxBytes — drop-oldest caps.
   *   sizeOf(kind, payload) — byte size an event counts against maxBytes
   *     (absorbs the per-consumer payload field difference: data vs chunk).
   *   onDrop({ droppedEvents, droppedBytes }) — called once per push that
   *     evicted, with the CUMULATIVE dropped totals (the consumer logs it).
   */
  function createPreReadyEventBuffer(options) {
    const source = options || {};
    const maxEvents = source.maxEvents;
    const maxBytes = source.maxBytes;
    const sizeOf = typeof source.sizeOf === 'function' ? source.sizeOf : function zeroSize() { return 0; };
    const onDrop = typeof source.onDrop === 'function' ? source.onDrop : function noopDrop() {};

    let buffer = [];
    let bufferedBytes = 0;
    let droppedEvents = 0;
    let droppedBytes = 0;

    function discard() {
      buffer = [];
      bufferedBytes = 0;
      droppedEvents = 0;
      droppedBytes = 0;
    }

    function dropOldest() {
      const dropped = buffer.shift();
      if (!dropped) return;
      bufferedBytes -= dropped.size;
      droppedBytes += dropped.size;
      droppedEvents += 1;
    }

    function push(kind, payload) {
      const size = sizeOf(kind, payload);
      if (size > maxBytes) {
        droppedEvents += 1;
        droppedBytes += size;
        onDrop({ droppedEvents, droppedBytes });
        return;
      }
      let droppedNow = false;
      while (buffer.length > 0
        && (buffer.length >= maxEvents || bufferedBytes + size > maxBytes)) {
        dropOldest();
        droppedNow = true;
      }
      buffer.push({ kind, payload, size });
      bufferedBytes += size;
      if (droppedNow) {
        onDrop({ droppedEvents, droppedBytes });
      }
    }

    // Returns the buffered events ({ kind, payload, size }) in arrival order
    // and fully resets the buffer (counters included) — replay exactly once.
    function drain() {
      const events = buffer;
      discard();
      return events;
    }

    return { push, drain, discard };
  }

  return { createBoundedScrollbackPainter, createPreReadyEventBuffer };
});
