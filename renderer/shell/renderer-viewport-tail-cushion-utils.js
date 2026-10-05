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
  // At least this much real content stays in the reader-visible band.
  const TAIL_CUSHION_MIN_VISIBLE_PX = 64;
  const TAIL_CUSHION_GLIDE_MS = 200;
  // A reader gesture this recent means the reader is moving the view.
  const TAIL_CUSHION_READER_INTENT_MS = 300;
  const SENTINEL_SELECTOR = '.chat-thread-scroll-sentinel';

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
      tailNode: null,
      tailOffset: 0,
      lastScrollTop: 0,
      lastReaderIntentAt: 0,
      glideFrame: 0,
      glideFrom: 0,
      glideStartedAt: 0,
    };

    function readRect(node) {
      try { return node?.getBoundingClientRect?.() || null; } catch (_error) { return null; }
    }

    // The tail reference is the timeline's last root (a turn); the activity row
    // can sit directly in the timeline before any article exists, so skip it.
    function readTail() {
      let node = chatTimeline?.lastElementChild || null;
      while (node && node.classList?.contains?.('turn-activity-row')) node = node.previousElementSibling;
      if (!node) return { node: null, offset: 0 };
      const timelineRect = readRect(chatTimeline);
      const tailRect = readRect(node);
      return { node, offset: finite(tailRect?.top) - finite(timelineRect?.top) };
    }

    function readTimelineHeight() {
      return finite(readRect(chatTimeline)?.height);
    }

    function record() {
      const tail = readTail();
      runtime.timelineHeight = readTimelineHeight();
      runtime.tailNode = tail.node;
      runtime.tailOffset = tail.offset;
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

    function canGrow() {
      return followState.get() !== false
        && !isReaderReleaseHeld()
        && !hasRecentReaderIntent()
        && isStreaming() === true;
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

    function drop(_reason) {
      stopGlide();
      if (runtime.cushionPx > 0) {
        noteProgrammaticWrite(TAIL_CUSHION_WRITE_REASON);
        writeCushion(0);
      }
      record();
    }

    function stepGlide() {
      runtime.glideFrame = 0;
      if (runtime.disposed) return;
      const progress = Math.min(1, Math.max(0, (now() - runtime.glideStartedAt) / TAIL_CUSHION_GLIDE_MS));
      const target = runtime.glideFrom * (1 - easeOutCubic(progress));
      noteProgrammaticWrite(TAIL_CUSHION_WRITE_REASON);
      writeCushion(Math.min(runtime.cushionPx, target));
      if (progress >= 1 || runtime.cushionPx <= 0) {
        writeCushion(0);
        record();
        return;
      }
      runtime.glideFrame = requestFrame(stepGlide);
    }

    // Leftover room closes: silently when it is off-screen, instantly under
    // reduced motion, otherwise with a short glide.
    function settle(reason) {
      if (runtime.cushionPx <= 0 || runtime.glideFrame) return;
      if (isCushionOffscreen() || reducedMotionQuery.matches) {
        drop(reason);
        return;
      }
      runtime.glideFrom = runtime.cushionPx;
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
      if (!shrink || !tail.node || tail.node !== runtime.tailNode) {
        record();
        return;
      }
      // Height lost above the tail's top is not a tail shrink: there the clamp
      // keeps the visible content still on its own.
      const aboveShift = Math.max(0, runtime.tailOffset - tail.offset);
      const tailShrink = shrink - aboveShift;
      const previous = runtime.cushionPx;
      let next = previous;
      if (tailShrink < 0 || canGrow()) next = Math.min(cushionLimit(), Math.max(0, previous + tailShrink));
      if (next !== previous) {
        const keepTop = runtime.lastScrollTop - aboveShift;
        writeCushion(next);
        if (next > previous && finite(chatThreadScroll.scrollTop) < keepTop) {
          noteProgrammaticWrite(TAIL_CUSHION_WRITE_REASON);
          chatThreadScroll.scrollTop = keepTop;
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
      writeCushion(0);
      runtime.observer?.disconnect?.();
      runtime.observer = null;
      if (runtime.attached) chatThreadScroll?.removeEventListener?.('scroll', handleScroll, { passive: true });
      runtime.attached = false;
      runtime.disposed = true;
      runtime.tailNode = null;
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
