/* renderer/shell/renderer-viewport-tail-cushion-utils.js – tail cushion (UMD).
   The chat scroll sets overflow-anchor: none, so when the end of a followed live
   reply gets shorter (an approval card turning into its receipt, the reasoning
   panel closing, the activity row leaving) the browser clamps scrollTop and
   everything above drops by the lost height. While a followed reply streams,
   the lost height becomes blank room under the timeline instead (the sentinel's
   height), so what the reader sees does not move; new output fills that room
   in place, and leftover room glides away when the reply ends (HB-038).
   A ResizeObserver on the timeline runs after layout and before paint, so the
   cushion lands in the same frame as the shrink and no jump is ever drawn. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportTailCushionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TAIL_CUSHION_PROPERTY = '--chat-tail-cushion';
  const TAIL_CUSHION_WRITE_REASON = 'tail_cushion';
  const TAIL_CUSHION_DROP_REASONS = new Set(['session', 'offscreen', 'force_bottom', 'resize', 'reply_end']);
  // At least this much real content stays in the reader-visible band.
  const TAIL_CUSHION_MIN_VISIBLE_PX = 64;
  const TAIL_CUSHION_GLIDE_MS = 200;
  // A reader gesture this recent means the reader is moving the view.
  const TAIL_CUSHION_READER_INTENT_MS = 300;
  // A shrink this soon after streaming ended still becomes room (gate F29: the
  // Answers view hides the settled turn's reasoning lines in the frame after
  // the terminal render, once a plain streaming check would say no).
  const TAIL_CUSHION_SETTLE_WINDOW_MS = 250;
  const SENTINEL_SELECTOR = '.chat-thread-scroll-sentinel';
  // Visible rows remembered above the tail, so a frame that swaps the tail row
  // (a tool row replacing the activity row, a run folding the live reasoning
  // line) still has a row that survived to measure the above-the-tail shift.
  const TAIL_CUSHION_ANCHOR_ROWS = 4;

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function easeOutCubic(progress) {
    return 1 - Math.pow(1 - progress, 3);
  }

  function createViewportTailCushion(deps) {
    const settings = deps || {};
    const { chatThreadScroll = null, chatTimeline = null } = settings.dom || {};
    const followState = settings.followState || { get: () => true };
    const getSessionId = typeof settings.getSessionId === 'function' ? settings.getSessionId : () => '';
    const isStreaming = typeof settings.isStreaming === 'function' ? settings.isStreaming : () => false;
    const isReaderReleaseHeld = typeof settings.isReaderReleaseHeld === 'function'
      ? settings.isReaderReleaseHeld : () => false;
    const getComposerSafeOffset = typeof settings.getComposerSafeOffset === 'function'
      ? settings.getComposerSafeOffset : () => 0;
    const noteProgrammaticWrite = typeof settings.noteProgrammaticWrite === 'function'
      ? settings.noteProgrammaticWrite : () => {};
    const reducedMotionQuery = settings.reducedMotionQuery || { matches: false };
    const requestFrame = typeof settings.requestFrame === 'function' ? settings.requestFrame : () => 0;
    const cancelFrame = typeof settings.cancelFrame === 'function' ? settings.cancelFrame : () => {};
    const now = typeof settings.now === 'function' ? settings.now : () => Date.now();
    const ResizeObserverRef = settings.ResizeObserverRef
      || (typeof ResizeObserver === 'function' ? ResizeObserver : null);

    const runtime = {
      attached: false,
      disposed: false,
      observer: null,
      sentinel: null,
      cushionPx: 0,
      sessionId: '',
      timelineHeight: 0,
      clientHeight: 0,
      anchors: [],
      lastScrollTop: 0,
      lastReaderIntentAt: 0,
      glideFrame: 0,
      glideFrom: 0,
      glideReason: '',
      glideStartedAt: 0,
      lastStreamingAt: 0,
      streamOpen: false,
      settleFrame: 0,
    };

    function readRect(node) {
      try { return node?.getBoundingClientRect?.() || null; } catch (_error) { return null; }
    }

    // The tail reference is the last visible row of the timeline's last root
    // (a turn), else the turn itself; the activity row can sit directly in the
    // timeline before any article exists, so skip it. Measuring the row, not
    // the turn, makes a Thinking panel collapsing above a newer answer row an
    // above-the-tail shift the clamp absorbs: as a tail shrink it became room
    // that dropped the whole view at reply end (gate 2026-10-14).
    function readLastRows(turn) {
      let rows;
      try { rows = turn.querySelectorAll?.('.turn-row-list > .chat-row') || null; } catch (_error) { rows = null; }
      const visible = [];
      for (let index = (rows?.length || 0) - 1; index >= 0 && visible.length < TAIL_CUSHION_ANCHOR_ROWS; index -= 1) {
        if (finite(readRect(rows[index])?.height) > 0) visible.unshift(rows[index]);
      }
      return visible;
    }

    function readOffset(node, timelineTop) {
      return finite(readRect(node)?.top) - timelineTop;
    }

    function readTail() {
      let turn = chatTimeline?.lastElementChild || null;
      while (turn && turn.classList?.contains?.('turn-activity-row')) turn = turn.previousElementSibling;
      if (!turn) return { node: null, offset: 0, turn: null, anchors: [] };
      const rows = readLastRows(turn);
      if (!rows.length) rows.push(turn);
      const timelineTop = finite(readRect(chatTimeline)?.top);
      const anchors = rows.map((node) => ({ node, offset: readOffset(node, timelineTop) }));
      const tail = anchors[anchors.length - 1];
      return { node: tail.node, offset: tail.offset, turn, anchors };
    }

    // The newest remembered row still shown in the same turn, with its offset
    // then and now. Usually the tail itself; when the tail row was swapped, an
    // earlier row that survived the frame.
    function findSurvivingAnchor(tail) {
      if (!tail.node || !tail.turn) return null;
      const timelineTop = finite(readRect(chatTimeline)?.top);
      for (let index = runtime.anchors.length - 1; index >= 0; index -= 1) {
        const anchor = runtime.anchors[index];
        const node = anchor.node;
        if (node === tail.node) return { before: anchor.offset, after: tail.offset };
        if (node?.isConnected === false) continue;
        if (tail.turn.contains?.(node) !== true) continue;
        if (!(finite(readRect(node)?.height) > 0)) continue;
        return { before: anchor.offset, after: readOffset(node, timelineTop) };
      }
      return null;
    }

    function readTimelineHeight() {
      return finite(readRect(chatTimeline)?.height);
    }

    // Stamps the settle window: while the reply streams and, from a viewport sync (`atSync`), once
    // more when the reply is first seen to have ended. A reply can sit quiet for longer than the
    // window before its terminal render, and the Answers view hides its reasoning rows only then
    // (row 131, D6).
    function noteStreaming(atSync) {
      const streaming = isStreaming() === true;
      if (streaming || (atSync && runtime.streamOpen)) runtime.lastStreamingAt = now();
      if (streaming || atSync) runtime.streamOpen = streaming;
    }

    function record() {
      noteStreaming(false);
      const tail = readTail();
      runtime.timelineHeight = readTimelineHeight();
      runtime.anchors = tail.anchors;
      runtime.lastScrollTop = finite(chatThreadScroll?.scrollTop);
      runtime.sessionId = String(getSessionId() || '');
    }

    // A shorter timeline the observer has not processed yet: the scroll
    // position read now is already clamped, so keep the one from before.
    function hasPendingShrink() {
      return readTimelineHeight() < runtime.timelineHeight;
    }

    // A changed viewport height retires the room (true when it did change).
    function noteClientHeight() {
      const clientHeight = finite(chatThreadScroll?.clientHeight);
      if (clientHeight === runtime.clientHeight) return false;
      runtime.clientHeight = clientHeight;
      settle('resize');
      return true;
    }

    function writeCushion(px) {
      const next = Math.max(0, Math.round(finite(px)));
      runtime.cushionPx = next;
      const style = runtime.sentinel?.style;
      if (!style) return;
      if (next > 0) style.setProperty(TAIL_CUSHION_PROPERTY, `${next}px`);
      else style.removeProperty(TAIL_CUSHION_PROPERTY);
    }

    function cushionLimit() {
      return Math.max(0, finite(chatThreadScroll?.clientHeight)
        - finite(getComposerSafeOffset()) - TAIL_CUSHION_MIN_VISIBLE_PX);
    }

    function hasRecentReaderIntent() {
      const at = runtime.lastReaderIntentAt;
      return at > 0 && Date.now() - at <= TAIL_CUSHION_READER_INTENT_MS;
    }

    function isSettling() {
      return runtime.lastStreamingAt > 0 && now() - runtime.lastStreamingAt <= TAIL_CUSHION_SETTLE_WINDOW_MS;
    }

    function canGrow() {
      return followState.get() !== false
        && !isReaderReleaseHeld()
        && !hasRecentReaderIntent()
        && (isStreaming() === true || isSettling());
    }

    // The room sits wholly below the viewport: removing it moves nothing.
    function isCushionOffscreen() {
      if (!chatThreadScroll) return true;
      return finite(chatThreadScroll.scrollTop) + finite(chatThreadScroll.clientHeight)
        <= finite(chatThreadScroll.scrollHeight) - runtime.cushionPx;
    }

    function stopGlide() {
      if (runtime.glideFrame) cancelFrame(runtime.glideFrame);
      runtime.glideFrame = 0;
    }

    // `tail_cushion:<cause>` for a known call site, else plain `tail_cushion`.
    function dropWriteReason(reason) {
      return TAIL_CUSHION_DROP_REASONS.has(reason)
        ? `${TAIL_CUSHION_WRITE_REASON}:${reason}` : TAIL_CUSHION_WRITE_REASON;
    }

    function drop(reason) {
      stopGlide();
      if (runtime.cushionPx > 0) {
        noteProgrammaticWrite(dropWriteReason(reason));
        writeCushion(0);
      }
      record();
    }

    // The glide is `settle`'s, so its writes carry the reason settle was given.
    function stepGlide() {
      runtime.glideFrame = 0;
      if (runtime.disposed) return;
      const progress = Math.min(1, Math.max(0, (now() - runtime.glideStartedAt) / TAIL_CUSHION_GLIDE_MS));
      const target = runtime.glideFrom * (1 - easeOutCubic(progress));
      noteProgrammaticWrite(dropWriteReason(runtime.glideReason));
      writeCushion(Math.min(runtime.cushionPx, target));
      if (progress >= 1 || runtime.cushionPx <= 0) {
        writeCushion(0);
        record();
        return;
      }
      runtime.glideFrame = requestFrame(stepGlide);
    }

    // Leftover room closes silently when it is off-screen. On-screen it
    // stays after a reply ends; for any other cause it closes instantly under
    // reduced motion, otherwise with a short glide.
    function settle(reason) {
      if (runtime.cushionPx <= 0 || runtime.glideFrame) return;
      if (isCushionOffscreen()) {
        drop(reason);
        return;
      }
      // Row 131 (owner pick A): room under a finished reply stays, so the
      // view never drops at the end of a turn. The next message grows into
      // it, and it is dropped unseen once the reader scrolls it off-screen.
      if (reason === 'reply_end') return;
      if (reducedMotionQuery.matches) {
        drop(reason);
        return;
      }
      runtime.glideFrom = runtime.cushionPx;
      runtime.glideReason = reason;
      runtime.glideStartedAt = now();
      runtime.glideFrame = requestFrame(stepGlide);
    }

    // One pass per timeline size change, after layout and before paint.
    function handleTimelineResize() {
      if (runtime.disposed || !chatThreadScroll || !chatTimeline) return;
      if (String(getSessionId() || '') !== runtime.sessionId) {
        drop('session');
        return;
      }
      if (noteClientHeight()) {
        record();
        return;
      }
      const height = readTimelineHeight();
      const tail = readTail();
      const shrink = runtime.timelineHeight - height;
      // A rewrite can lay the page out short for one forced layout inside the
      // frame (a new Thinking panel has no height until its own pass sizes
      // it) and be taller again by now. The clamp from that layout would be
      // painted and the follow would glide back from it (replay 2026-11-10:
      // 62 px at every tool start). Nothing was lost, so undo it here.
      const growing = canGrow();
      if (shrink <= 0 && growing && finite(chatThreadScroll.scrollTop) < runtime.lastScrollTop) {
        const keptTop = Math.min(runtime.lastScrollTop,
          finite(chatThreadScroll.scrollHeight) - finite(chatThreadScroll.clientHeight));
        if (finite(chatThreadScroll.scrollTop) < keptTop) {
          noteProgrammaticWrite(`${TAIL_CUSHION_WRITE_REASON}:hold`);
          chatThreadScroll.scrollTop = keptTop;
        }
      }
      const anchor = shrink ? findSurvivingAnchor(tail) : null;
      if (!anchor) {
        // A new turn shares no row with the old tail: its height still uses
        // up room kept under the reply before it.
        if (shrink < 0 && runtime.cushionPx > 0) writeCushion(runtime.cushionPx + shrink);
        record();
        return;
      }
      // Height lost above the anchor's top is not a tail shrink: there the
      // clamp keeps the visible content still on its own.
      const aboveShift = Math.max(0, anchor.before - anchor.after);
      const tailShrink = shrink - aboveShift;
      const previous = runtime.cushionPx;
      let next = previous;
      if (tailShrink < 0 || growing) next = Math.min(cushionLimit(), Math.max(0, previous + tailShrink));
      if (next !== previous) {
        const keepTop = runtime.lastScrollTop - aboveShift;
        writeCushion(next);
        if (next > previous && finite(chatThreadScroll.scrollTop) < keepTop) {
          noteProgrammaticWrite(TAIL_CUSHION_WRITE_REASON);
          chatThreadScroll.scrollTop = keepTop;
        }
        // Room added after the reply ended is looked at next frame: it is
        // dropped if it is already off-screen and kept otherwise.
        if (next > previous && isStreaming() !== true) {
          stopGlide();
          if (!runtime.settleFrame) {
            runtime.settleFrame = requestFrame(() => {
              runtime.settleFrame = 0;
              if (!runtime.disposed) settle('reply_end');
            });
          }
        }
      }
      // The browser can hold its own clamp back for a whole collapse above
      // the tail and then apply it in one frame (replay 2026-11-10: a
      // reasoning panel closing over the first answer text slid the answer up
      // 460 px, then dropped it back). Take the lost height off the scroll
      // position in the frame it is lost, so the rows under it stay put.
      // Only within a screen of the bottom (the follow can trail a fast
      // reply by a few rows): further up, the collapse can be below what the
      // reader sees and the position must not move.
      if (aboveShift > 0 && growing) {
        const heldTop = Math.max(0, runtime.lastScrollTop - aboveShift);
        const top = finite(chatThreadScroll.scrollTop);
        const fromBottom = finite(chatThreadScroll.scrollHeight) - finite(chatThreadScroll.clientHeight) - top;
        if (top > heldTop && fromBottom <= finite(chatThreadScroll.clientHeight)) {
          noteProgrammaticWrite(`${TAIL_CUSHION_WRITE_REASON}:hold`);
          chatThreadScroll.scrollTop = heldTop;
        }
      }
      record();
    }

    function handleScroll() {
      if (runtime.disposed || hasPendingShrink()) return;
      runtime.lastScrollTop = finite(chatThreadScroll?.scrollTop);
      if (runtime.cushionPx > 0 && !runtime.glideFrame && isCushionOffscreen()) drop('offscreen');
    }

    // The live-follow animator reports each write, so a shrink in the same
    // frame keeps the position the animator just set.
    function noteScrollPosition(scrollTop) {
      if (runtime.disposed || hasPendingShrink()) return;
      runtime.lastScrollTop = finite(scrollTop);
    }

    function noteReaderIntent() {
      runtime.lastReaderIntentAt = Date.now();
    }

    // Called from each viewport sync: a new session, a resized viewport or an
    // ended reply all retire the room.
    function noteViewportSync() {
      if (runtime.disposed || !runtime.attached) return;
      if (String(getSessionId() || '') !== runtime.sessionId) {
        drop('session');
        return;
      }
      noteStreaming(true);
      if (noteClientHeight() || runtime.cushionPx <= 0) return;
      if (isStreaming() !== true) settle('reply_end');
    }

    function attach() {
      if (runtime.attached || runtime.disposed || !chatThreadScroll || !chatTimeline || !ResizeObserverRef) return false;
      runtime.sentinel = chatThreadScroll.querySelector?.(SENTINEL_SELECTOR) || null;
      if (!runtime.sentinel) return false;
      runtime.observer = new ResizeObserverRef(handleTimelineResize);
      runtime.observer.observe(chatTimeline);
      chatThreadScroll.addEventListener?.('scroll', handleScroll, { passive: true });
      runtime.attached = true;
      runtime.clientHeight = finite(chatThreadScroll.clientHeight);
      record();
      return true;
    }

    function dispose() {
      if (runtime.disposed) return;
      stopGlide();
      if (runtime.settleFrame) cancelFrame(runtime.settleFrame);
      runtime.settleFrame = 0;
      writeCushion(0);
      runtime.observer?.disconnect?.();
      runtime.observer = null;
      if (runtime.attached) chatThreadScroll?.removeEventListener?.('scroll', handleScroll, { passive: true });
      runtime.attached = false;
      runtime.disposed = true;
      runtime.anchors = [];
      runtime.sentinel = null;
    }

    return {
      attach,
      dispose,
      drop,
      settle,
      noteReaderIntent,
      noteScrollPosition,
      noteViewportSync,
      getCushionPx: () => runtime.cushionPx,
      _internals: { handleTimelineResize, handleScroll },
    };
  }

  return {
    TAIL_CUSHION_PROPERTY,
    TAIL_CUSHION_GLIDE_MS,
    TAIL_CUSHION_MIN_VISIBLE_PX,
    createViewportTailCushion,
  };
});
