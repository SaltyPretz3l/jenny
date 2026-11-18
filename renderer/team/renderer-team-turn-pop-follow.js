/* Team tab: the transcript popover's follow state (row 175, C1, C3, C4), modelled on the local chat's scroll coordinator
 * (renderer/chat/renderer-chat-scroll-coordinator.js, chat-scroll-utils.js): reader intent comes from the wheel, the
 * scrolling keys and a held pointer, and only a scroll inside a 180 ms intent window detaches; a scroll that lands within
 * 48 px of the bottom attaches again; the follower's own scrollTop writes are recorded so they never detach. Growth after
 * a render (a ResizeObserver on the content when there is one, else the next `afterPatch`) keeps a following reader at
 * the bottom, and a scrolled-up reader is never moved. `reset(live)` starts a turn: a live turn follows the bottom, a
 * settled one opens at its top. The scroller also carries the local live reasoning box's height variables, measured from
 * the popover instead of the chat thread. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamTurnPopFollow = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const THRESHOLD = 48; // chat-scroll-utils DEFAULT_SCROLL_FOLLOW_THRESHOLD
  const INTENT_MS = 180; // the scroll coordinator's USER_INTENT_WINDOW_MS
  const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar']);
  const HOLD_END = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'];
  const num = (v) => Number(v) || 0;

  /** Follow state for the scroller `el`. `threshold`, `now` and `ResizeObserver` are overridable (tests). */
  function createPopFollow({ el, threshold, now, ResizeObserver: RO } = {}) {
    const doc = el.ownerDocument;
    const win = doc.defaultView || globalThis;
    const limit = Number.isFinite(threshold) ? threshold : THRESHOLD;
    const clock = typeof now === 'function' ? now : () => Date.now();
    const Observer = typeof RO === 'function' ? RO : (typeof win.ResizeObserver === 'function' ? win.ResizeObserver : null);
    let following = true;
    let intentAt = -Infinity;
    let holding = false;
    let written = null;
    let viewport = '';
    const observed = new Set();

    const distance = () => num(el.scrollHeight) - num(el.scrollTop) - num(el.clientHeight);
    const intent = () => holding || clock() - intentAt <= INTENT_MS;
    function write(top) {
      el.scrollTop = top;
      written = num(el.scrollTop);
    }
    function stick() { if (following) write(num(el.scrollHeight)); }

    function onScroll() {
      const top = num(el.scrollTop);
      if (written !== null && top === written && !intent()) return;
      written = null;
      if (distance() <= limit) following = true;
      else if (intent()) following = false;
    }
    const onWheel = () => { intentAt = clock(); };
    function onKey(event) {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest('textarea, input, select, [contenteditable="true"]')) return;
      if (SCROLL_KEYS.has(event.key)) intentAt = clock();
    }
    function onHoldEnd() {
      holding = false;
      intentAt = clock();
      HOLD_END.forEach((type) => doc.removeEventListener(type, onHoldEnd, true));
    }
    function onHoldStart() {
      holding = true;
      HOLD_END.forEach((type) => doc.addEventListener(type, onHoldEnd, true));
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onWheel, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onHoldStart, { passive: true });

    // The live reasoning box caps itself from these (styles/chat-machinery.css); here they describe the popover.
    function sizeVars() {
      const height = Math.round(num(el.clientHeight));
      const next = height > 0 ? height + 'px' : '';
      if (next === viewport || !el.style || typeof el.style.setProperty !== 'function') return;
      viewport = next;
      if (next) el.style.setProperty('--chat-thread-viewport-h', next); else el.style.removeProperty('--chat-thread-viewport-h');
      el.style.setProperty('--chat-thread-offset', '0px');
      el.style.setProperty('--composer-safe-offset', '0px');
    }
    const onResize = () => { sizeVars(); stick(); };
    let observer = null;
    try { observer = Observer ? new Observer(onResize) : null; } catch (_error) { observer = null; }
    if (observer) observer.observe(el);
    // Watches the scroller's children as they are now (a patch can add or drop one).
    function track() {
      if (!observer) return;
      const kids = new Set(Array.from(el.children));
      for (const kid of observed) if (!kids.has(kid)) { observer.unobserve(kid); observed.delete(kid); }
      for (const kid of kids) if (!observed.has(kid)) { observer.observe(kid); observed.add(kid); }
    }

    return {
      /** After the body changed: re-measure, watch the new content, keep a follower at the bottom. */
      afterPatch() { sizeVars(); track(); stick(); },
      /** A new turn: a live one follows from the bottom, a settled one opens at its top. */
      reset(live) {
        following = live === true;
        intentAt = -Infinity;
        if (following) stick(); else write(0);
      },
      isFollowing: () => following,
      dispose() {
        el.removeEventListener('scroll', onScroll, { passive: true });
        el.removeEventListener('wheel', onWheel, { passive: true });
        el.removeEventListener('touchmove', onWheel, { passive: true });
        el.removeEventListener('keydown', onKey);
        el.removeEventListener('pointerdown', onHoldStart, { passive: true });
        HOLD_END.forEach((type) => doc.removeEventListener(type, onHoldEnd, true));
        if (observer) observer.disconnect();
        observer = null;
        observed.clear();
      },
    };
  }

  return { createPopFollow, THRESHOLD, INTENT_MS };
});
