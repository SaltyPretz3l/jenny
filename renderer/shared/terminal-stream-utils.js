/* renderer/shared/terminal-stream-utils.js — shared bounded terminal-stream
 * primitives (sibling to ansi-stream-utils.js).
 *
 * Shared by Run Scripts and the terminal panels:
 *
 * - createBoundedScrollbackPainter — a drop-oldest bounded chunk store with
 *   rAF-coalesced incremental text-node painting into a <pre> scrollback.
 *   Eviction has hysteresis: past the cap the store drops to ~75% of it,
 *   line-aligned, in one step (so a log at its cap does not trim + relayout
 *   on every frame). Evictions are mirrored into the DOM by trimming head
 *   text nodes (never a full re-render per chunk), the painted node count is
 *   bounded (adjacent text nodes are merged), a full repaint from the bounded
 *   store runs only when the target <pre> identity changes, and a paint that
 *   finds no visible <pre> (panel backgrounded) DISCARDS the pending deltas so
 *   a chatty stream can never grow the pending list unbounded — the next
 *   visible paint repaints in full from the bounded store instead.
 *
 * - createPreReadyEventBuffer — bounded drop-oldest buffering for stream
 *   events that race the start()/spawn reply (the window where data/exit
 *   pushes can arrive before the caller knows its own task/session id).
 *   Cumulative dropped-event/byte accounting is surfaced through onDrop so
 *   truncation is never silent (AGENTS.md section 9 — bounded state).
 *
 * - resolveFrameScheduler — the injectable rAF pair both consumers resolve.
 * - killOutcomeConfirmed — reads a main-process kill answer: true only when
 *   the process is confirmed dead or was already gone.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTerminalStreamUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Eviction target as a fraction of maxChars (hysteresis), and the painted
  // text-node count past which adjacent nodes are merged.
  const EVICT_TO_RATIO = 0.75;
  const MAX_TEXT_NODES = 256;
  // linkify re-scans only the partial last line when a chunk continues it; past this many
  // chars (the link scanner skips longer lines anyway) the tail is left as it is.
  const MAX_RELINKIFY_TAIL = 4096;
  const DEFAULT_PRE_READY_MAX_EVENTS = 64;
  const DEFAULT_PRE_READY_MAX_BYTES = 64 * 1024; // mirrors the services' MAX_CHUNK_BYTES

  /**
   * The frame scheduler for a coalesced paint: injected impls (deterministic
   * tests), else the window's real rAF, else a synchronous fallback so output
   * is never held back forever where no rAF exists (jsdom/node).
   */
  function resolveFrameScheduler(options, windowRef) {
    const source = options || {};
    const win = windowRef || {};
    const requestFrame = typeof source.requestAnimationFrameImpl === 'function'
      ? source.requestAnimationFrameImpl
      : (typeof win.requestAnimationFrame === 'function'
        ? win.requestAnimationFrame.bind(win)
        : (callback) => { callback(0); return null; });
    const cancelFrame = typeof source.cancelAnimationFrameImpl === 'function'
      ? source.cancelAnimationFrameImpl
      : (typeof win.cancelAnimationFrame === 'function'
        ? win.cancelAnimationFrame.bind(win)
        : function noopCancel() {});
    return { requestFrame, cancelFrame };
  }

  /**
   * A main-process kill answer: confirmed dead ({ terminationConfirmed:true })
   * or already gone ({ killed:false } with no confirmation field - nothing was
   * left to kill, e.g. Stop racing a natural exit). Anything else, including a
   * refusal or a rejected request (pass undefined), is unconfirmed.
   */
  function killOutcomeConfirmed(outcome) {
    if (!outcome || typeof outcome !== 'object') return false;
    if (typeof outcome.terminationConfirmed === 'boolean') return outcome.terminationConfirmed;
    return outcome.killed === false && outcome.ok !== false;
  }

  // Mirror a drop-oldest eviction into the painted DOM by trimming text off
  // the head text node(s) instead of re-rendering the whole scrollback.
  // normalize() rewrites text nodes, which collapses a selection the user is
  // copying from; the merge waits until nothing is selected in the log.
  function selectionInside(pre) {
    const selection = pre.ownerDocument?.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && pre.contains(selection.anchorNode));
  }

  // An element node (a linkified span/button) counts its textContent; one that straddles the
  // trim is replaced by a text node holding what is left of it.
  function trimDomHead(pre, charCount) {
    let remaining = charCount;
    while (remaining > 0 && pre.firstChild) {
      const node = pre.firstChild;
      const isElement = node.nodeType === 1;
      const text = String(isElement ? node.textContent : (node.data ?? node.nodeValue ?? ''));
      if (text.length <= remaining) {
        remaining -= text.length;
        pre.removeChild(node);
      } else if (isElement) {
        pre.replaceChild(pre.ownerDocument.createTextNode(text.slice(remaining)), node);
        remaining = 0;
      } else {
        node.data = text.slice(remaining);
        remaining = 0;
      }
    }
  }

  // Detaches the partial last line (text after the final newline) from the end of the painted
  // scrollback and returns it, so a link split across two appends is re-detected whole. Walks
  // back over text and linkified element nodes; returns '' (touching nothing) when the line is
  // empty or longer than MAX_RELINKIFY_TAIL.
  function takePartialLastLine(pre) {
    let length = 0;
    let node = pre.lastChild;
    let start = null; // the node holding the line start, and the offset inside it
    while (node) {
      const text = String(node.nodeType === 1 ? node.textContent : (node.data ?? ''));
      const newline = text.lastIndexOf('\n');
      if (newline !== -1) {
        length += text.length - newline - 1;
        start = { node, offset: newline + 1 };
        break;
      }
      length += text.length;
      if (length > MAX_RELINKIFY_TAIL) return '';
      start = { node, offset: 0 };
      node = node.previousSibling;
    }
    if (!start || length === 0) return '';
    let tail = '';
    if (start.offset > 0) {
      // Only a text node can hold a newline-split line start (a link element has no newline).
      if (start.node.nodeType !== 3) return '';
      tail = start.node.data.slice(start.offset);
      start.node.data = start.node.data.slice(0, start.offset);
      node = start.node.nextSibling;
    } else {
      node = start.node;
    }
    while (node) {
      const next = node.nextSibling;
      tail += node.textContent;
      pre.removeChild(node);
      node = next;
    }
    return tail;
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
    // Optional (doc, text) -> Node. When set it builds the painted nodes in place of one text
    // node (file-link buttons); its output must be textContent-equivalent to the text.
    const linkify = typeof source.linkify === 'function' ? source.linkify : null;
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
    let normalizedAt = 0; // child count after the last normalize(): linkify keeps element nodes alive

    function textNodeFor(doc, text) {
      return linkify ? linkify(doc, text) : doc.createTextNode(text);
    }

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
        if (text) pre.appendChild(textNodeFor(pre.ownerDocument, text));
        paintedPre = pre;
      } else {
        let text = pendingChunks.join('');
        if (text && linkify) text = takePartialLastLine(pre) + text;
        if (text) pre.appendChild(textNodeFor(pre.ownerDocument, text));
        trimDomHead(pre, pendingEvictedChars);
        normalizedAt = Math.min(normalizedAt, pre.childNodes.length);
        if (pre.childNodes.length > MAX_TEXT_NODES && pre.childNodes.length - normalizedAt > MAX_TEXT_NODES / 2
          && typeof pre.normalize === 'function' && !selectionInside(pre)) {
          pre.normalize();
          normalizedAt = pre.childNodes.length;
        }
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
      if (chars > maxChars) evict(chars - Math.floor(maxChars * EVICT_TO_RATIO));
    }

    // Drop `count` chars off the head, extending the cut to the end of the
    // line it lands in so the log never starts mid-line.
    function evict(count) {
      let remaining = count;
      while (remaining > 0 && chunks.length) {
        const first = chunks[0];
        let removed = first.length;
        if (first.length > remaining) {
          const newline = first.indexOf('\n', remaining - 1);
          removed = newline === -1 ? remaining : newline + 1;
        }
        if (removed >= first.length) chunks.shift();
        else chunks[0] = first.slice(removed);
        remaining = Math.max(0, remaining - removed);
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

    // sync() only when there is something to paint: a pending frame or delta,
    // or a new target <pre> (a rebuilt panel). An idle render pass stays cheap.
    function syncIfPending() {
      if (frame === null && !pendingChunks.length && !pendingEvictedChars && paintedPre === getScrollbackEl()) return;
      sync();
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

    return { append, schedule, sync, syncIfPending, cancel, reset };
  }

  /**
   * options:
   *   maxEvents / maxBytes — drop-oldest caps (default 64 events / 64 KiB).
   *   sizeOf(kind, payload) — byte size an event counts against maxBytes
   *     (absorbs the per-consumer payload field difference: data vs chunk).
   *   onDrop({ droppedEvents, droppedBytes }) — called once per push that
   *     evicted, with the CUMULATIVE dropped totals (the consumer logs it).
   */
  function createPreReadyEventBuffer(options) {
    const source = options || {};
    const maxEvents = Number.isFinite(source.maxEvents) ? source.maxEvents : DEFAULT_PRE_READY_MAX_EVENTS;
    const maxBytes = Number.isFinite(source.maxBytes) ? source.maxBytes : DEFAULT_PRE_READY_MAX_BYTES;
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

    // Drain and hand each event, in arrival order, to handlers[kind].
    function replay(handlers) {
      for (const entry of drain()) {
        const handler = handlers && handlers[entry.kind];
        if (typeof handler === 'function') handler(entry.payload);
      }
    }

    return { push, drain, replay, discard };
  }

  return {
    createBoundedScrollbackPainter,
    createPreReadyEventBuffer,
    resolveFrameScheduler,
    killOutcomeConfirmed,
  };
});
