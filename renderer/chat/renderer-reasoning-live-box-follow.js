/* renderer/chat/renderer-reasoning-live-box-follow.js -- Row 101 Phase 2 live box: while a reasoning phase streams in the Thinking view, the panel body is capped by CSS and scrolls inside itself. This module chases the box's own bottom with the damped S3 profile, releases follow on a reader scroll-away inside the box (24 px, 300 ms intent window), resumes within 4 px of the bottom, toggles the top-fade class and keeps the marker attribute the CSS uses to hold the cap through the settle collapse. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererReasoningLiveBoxFollow = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIVE_BOX_MARKER_ATTR = 'data-live-box';
  const HAS_SCROLLED_CLASS = 'has-scrolled';
  const LIVE_BOX_BODY_SELECTOR = '.chat-timeline:not([data-transcript-view="answers"]) .reasoning-row-block[data-reasoning-status="streaming"] .reasoning-row-panel.expanded:not([hidden]) > .reasoning-row-panel-body';
  // A phase that settled open while its turn is still in flight keeps its cap
  // (found live: un-capping a long phase mid-turn grew the timeline by its
  // full height in one frame, then the next phase began seconds later). The
  // split can go through a full render, so this is a candidate test, not
  // state carried on the old node.
  const SETTLED_OPEN_BODY_SELECTOR = '.chat-timeline:not([data-transcript-view="answers"]) .reasoning-row-block:not([data-reasoning-status="streaming"]) .reasoning-row-panel.expanded:not([hidden]) > .reasoning-row-panel-body';

  // Mirrors renderer/shell/renderer-viewport-live-follow-utils.js.
  const DAMPED_RESPONSE_MS = 320, DAMPED_MAX_LAG_PX = 96, DEFAULT_RESPONSE_MS = 120;
  const MIN_STEP_PX = 2, SETTLE_PX = 1, USER_OVERRIDE_PX = 24, USER_INTENT_WINDOW_MS = 300;
  const RESUME_PX = 4, COLLAPSE_RECHECK_MS = 700, IDENTITY_RECORD_LIMIT = 8;
  const INTENT_EVENTS = ['wheel', 'keydown'];
  const HOLD_START_EVENTS = ['pointerdown', 'touchstart'];
  const HOLD_END_EVENTS = ['pointerup', 'pointercancel', 'touchend', 'touchcancel'];

  // Module-level so the static patch helpers can see per-body state.
  const states = new WeakMap();
  const releasedBodies = new Set();

  const STREAMING_BLOCK_SELECTOR = '.reasoning-row-block[data-reasoning-status="streaming"]';
  const isStreamingBody = (body) => body.matches(LIVE_BOX_BODY_SELECTOR);
  // A tool gap has no streaming message, so the live turn row list is the turn-level signal there.
  const isTurnInFlight = (body) => Boolean(body.closest('.turn-row-list[data-turn-live="true"], .chat-entry.pending')
    || body.closest('.reasoning-row-stack')?.querySelector(STREAMING_BLOCK_SELECTOR));
  const isCapCandidate = (body) => isStreamingBody(body) || (body.matches(SETTLED_OPEN_BODY_SELECTOR) && isTurnInFlight(body));
  const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);
  const maxTop = (body) => Math.max(0, (Number(body.scrollHeight) || 0) - (Number(body.clientHeight) || 0));
  const readTop = (body) => Number(body.scrollTop) || 0;

  function applyScrolledClass(body, state, top = readTop(body)) {
    state.hasScrolled = top > 1;
    body.classList.toggle(HAS_SCROLLED_CLASS, state.hasScrolled);
  }

  function stamp(body, hasScrolled) {
    // Runs on every sync: skip the attribute write (a style invalidation) when unchanged.
    if (body.getAttribute(LIVE_BOX_MARKER_ATTR) !== 'true') body.setAttribute(LIVE_BOX_MARKER_ATTR, 'true');
    body.classList.toggle(HAS_SCROLLED_CLASS, Boolean(hasScrolled));
  }

  // The provisional record keeps a synchronous scroll event (fired by the
  // write itself) from reading the write as a reader scroll-away.
  function writeTop(body, state, value) {
    state.lastProgrammaticTop = value;
    body.scrollTop = value;
    state.lastProgrammaticTop = readTop(body);
    applyScrolledClass(body, state, state.lastProgrammaticTop);
  }

  function setReleased(body, state, released) {
    state.following = !released;
    if (released) state.readerTop = readTop(body);
    releasedBodies[released ? 'add' : 'delete'](body);
  }

  function capturePatchState(body) {
    const state = body ? states.get(body) : null;
    return state ? { hasScrolled: Boolean(state.hasScrolled), following: Boolean(state.following) } : null;
  }

  function restorePatchState(body, captured, options = {}) {
    if (!body || !captured) return;
    stamp(body, captured.hasScrolled);
    const state = states.get(body);
    if (!state) return;
    state.hasScrolled = Boolean(captured.hasScrolled);
    if (options.settled === true && captured.following) writeTop(body, state, maxTop(body));
  }

  function isAnyReaderAway() {
    releasedBodies.forEach((body) => { if (!body.isConnected) releasedBodies.delete(body); });
    return releasedBodies.size > 0;
  }

  function createReasoningLiveBoxFollow(deps = {}) {
    const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : () => true;
    const reducedMotionQuery = deps.reducedMotionQuery
      || (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia('(prefers-reduced-motion: reduce)') : null);
    const requestFrame = typeof deps.requestFrame === 'function' ? deps.requestFrame
      : (typeof globalThis.requestAnimationFrame === 'function' ? (cb) => globalThis.requestAnimationFrame(cb) : () => null);
    const cancelFrame = typeof deps.cancelFrame === 'function' ? deps.cancelFrame
      : (typeof globalThis.cancelAnimationFrame === 'function' ? (h) => globalThis.cancelAnimationFrame(h) : () => {});
    const now = typeof deps.now === 'function' ? deps.now
      : (typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : () => Date.now());
    const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : (h) => clearTimeout(h);

    const owner = {};
    const held = new Set();
    const pending = new Set();
    const identityRecords = new Map();
    let frameHandle = null;
    let lastFrameTs = 0;

    const ownState = (body) => {
      const state = states.get(body);
      return state && state.owner === owner ? state : null;
    };
    const hasRecentIntent = (state) => state.holding || now() - state.intentAt <= USER_INTENT_WINDOW_MS;

    function identityOf(body) {
      const { phaseKey = '', thinkingId = '' } = body.closest('.reasoning-row-panel')?.dataset || {};
      return phaseKey ? `${thinkingId}|${phaseKey}` : '';
    }

    function scheduleChase(body) {
      pending.add(body);
      if (frameHandle === null) frameHandle = requestFrame(onFrame);
    }

    function stepBody(body, state, dt) {
      const target = maxTop(body);
      state.lastProgrammaticTop = Math.min(state.lastProgrammaticTop, target);
      if (reducedMotionQuery && reducedMotionQuery.matches) {
        writeTop(body, state, target);
        return false;
      }
      const current = readTop(body);
      if (hasRecentIntent(state) && current < state.lastProgrammaticTop - MIN_STEP_PX) return true;
      const remaining = target - current;
      if (Math.abs(remaining) <= SETTLE_PX) {
        writeTop(body, state, target);
        return false;
      }
      // Blend from the damped to the catch-up rate over one more lag span, so
      // the speed is continuous at the threshold (a hard switch read as a
      // lurch-then-stall on every burst past 96 px).
      const lag = Math.abs(remaining);
      const damped = clamp(dt / DAMPED_RESPONSE_MS, 0.04, 0.25);
      const fast = clamp(dt / DEFAULT_RESPONSE_MS, 0.12, 0.45);
      const blend = clamp((lag - DAMPED_MAX_LAG_PX) / DAMPED_MAX_LAG_PX, 0, 1);
      const alpha = damped + (fast - damped) * blend;
      const step = Math.max(lag * alpha, MIN_STEP_PX);
      writeTop(body, state, remaining > 0 ? Math.min(current + step, target) : Math.max(current - step, target));
      return true;
    }

    function onFrame(timestamp) {
      frameHandle = null;
      const ts = Number.isFinite(Number(timestamp)) ? Number(timestamp) : lastFrameTs + 16;
      const dt = lastFrameTs > 0 ? Math.max(ts - lastFrameTs, 0) : 16;
      lastFrameTs = ts;
      const batch = Array.from(pending);
      pending.clear();
      batch.forEach((body) => {
        const state = ownState(body);
        if (!state || !state.following || !body.isConnected) return;
        if (stepBody(body, state, dt)) pending.add(body);
      });
      if (pending.size > 0) frameHandle = requestFrame(onFrame);
      else lastFrameTs = 0;
    }

    function onScroll(body, state) {
      const top = readTop(body);
      applyScrolledClass(body, state, top);
      // The module's own write: nothing to release, so skip the layout reads.
      if (state.following && top === state.lastProgrammaticTop) return;
      const max = maxTop(body);
      state.lastProgrammaticTop = Math.min(state.lastProgrammaticTop, max);
      if (state.following) {
        if (hasRecentIntent(state) && top < state.lastProgrammaticTop - USER_OVERRIDE_PX) {
          setReleased(body, state, true);
          pending.delete(body);
        }
      } else if (max - top <= RESUME_PX) {
        setReleased(body, state, false);
        state.lastProgrammaticTop = top;
        scheduleChase(body);
      } else {
        state.readerTop = top;
      }
    }

    function attach(body) {
      const state = {
        owner, following: true, hasScrolled: false, intentAt: -Infinity, holding: false, lastProgrammaticTop: 0,
        readerTop: 0, identity: identityOf(body), recheck: null,
      };
      const doc = body.ownerDocument;
      state.onIntent = () => { state.intentAt = now(); };
      // A pressed scrollbar thumb or a touch pan holds until it lifts, wherever it lifts.
      state.onHoldEnd = () => {
        state.holding = false;
        state.intentAt = now();
        HOLD_END_EVENTS.forEach((type) => doc.removeEventListener(type, state.onHoldEnd, true));
      };
      state.onHoldStart = () => {
        state.holding = true;
        HOLD_END_EVENTS.forEach((type) => doc.addEventListener(type, state.onHoldEnd, true));
      };
      state.onScroll = () => onScroll(body, state);
      INTENT_EVENTS.forEach((type) => body.addEventListener(type, state.onIntent, { passive: true }));
      HOLD_START_EVENTS.forEach((type) => body.addEventListener(type, state.onHoldStart, { passive: true }));
      body.addEventListener('scroll', state.onScroll, { passive: true });
      states.set(body, state);
      held.add(body);
      const readerTop = state.identity ? identityRecords.get(state.identity) : undefined;
      if (readerTop !== undefined) {
        identityRecords.delete(state.identity);
        writeTop(body, state, Math.min(readerTop, maxTop(body)));
        setReleased(body, state, true);
      } else {
        writeTop(body, state, maxTop(body));
      }
    }

    function disarmRecheck(state) {
      if (!state.recheck) return;
      state.recheck.panel.removeEventListener('transitionend', state.recheck.onEnd);
      clearTimer(state.recheck.timer);
      state.recheck = null;
    }

    // Removes listeners, timers and state; `writeDom` false leaves a
    // disconnected node's attributes untouched.
    function release(body, state, writeDom) {
      if (!state.following && state.identity) {
        identityRecords.delete(state.identity);
        identityRecords.set(state.identity, state.readerTop);
        while (identityRecords.size > IDENTITY_RECORD_LIMIT) identityRecords.delete(identityRecords.keys().next().value);
      }
      INTENT_EVENTS.forEach((type) => body.removeEventListener(type, state.onIntent, { passive: true }));
      HOLD_START_EVENTS.forEach((type) => body.removeEventListener(type, state.onHoldStart, { passive: true }));
      HOLD_END_EVENTS.forEach((type) => body.ownerDocument.removeEventListener(type, state.onHoldEnd, true));
      body.removeEventListener('scroll', state.onScroll, { passive: true });
      disarmRecheck(state);
      pending.delete(body);
      releasedBodies.delete(body);
      held.delete(body);
      states.delete(body);
      if (writeDom) {
        body.removeAttribute(LIVE_BOX_MARKER_ATTR);
        body.classList.remove(HAS_SCROLLED_CLASS);
      }
    }

    function armRecheck(body, state, panel) {
      if (state.recheck) return;
      const fire = () => {
        disarmRecheck(state);
        evaluateStale(body);
      };
      const onEnd = (event) => {
        if (event.target === panel && event.propertyName === 'max-height') fire();
      };
      panel.addEventListener('transitionend', onEnd);
      state.recheck = { panel, onEnd, timer: setTimer(fire, COLLAPSE_RECHECK_MS) };
    }

    // A held body that may have left the live selector.
    function evaluateStale(body) {
      const state = ownState(body);
      if (!state) return;
      if (!body.isConnected) {
        release(body, state, false);
        return;
      }
      if (isCapCandidate(body)) return;
      const panel = body.closest('.reasoning-row-panel');
      if (panel && panel.getAttribute('data-collapsing') === 'true') {
        stamp(body, state.hasScrolled);
        pending.delete(body);
        armRecheck(body, state, panel);
        return;
      }
      release(body, state, true);
    }

    // `held` and the owned WeakMap entries are kept in step by attach/release.
    const detachAll = () => Array.from(held).forEach((body) => release(body, ownState(body), body.isConnected));

    function sync(rootNode) {
      if (!isEnabled()) return detachAll();
      // Candidates are filtered with matches() so a root that is itself the
      // .chat-timeline still counts as ancestor context (jsdom scopes
      // querySelectorAll to the root's subtree).
      const live = rootNode && typeof rootNode.querySelectorAll === 'function'
        ? Array.from(rootNode.querySelectorAll('.reasoning-row-panel-body')).filter(isCapCandidate)
        : [];
      const liveSet = new Set(live);
      // Stale bodies first, so a released body dropped by a rebuild leaves
      // its identity record before the rebuilt node attaches.
      Array.from(held).forEach((body) => { if (!liveSet.has(body)) evaluateStale(body); });
      // A rebuild can clone a marked body: a marker nobody holds is dropped
      // unless the body is adopted below or its panel is mid collapse.
      if (rootNode && typeof rootNode.querySelectorAll === 'function') {
        rootNode.querySelectorAll(`.reasoning-row-panel-body[${LIVE_BOX_MARKER_ATTR}]`).forEach((body) => {
          if (states.has(body) || liveSet.has(body)) return;
          if (body.closest('.reasoning-row-panel')?.getAttribute('data-collapsing') === 'true') return;
          body.removeAttribute(LIVE_BOX_MARKER_ATTR);
          body.classList.remove(HAS_SCROLLED_CLASS);
        });
      }
      live.forEach((body) => {
        let state = ownState(body);
        if (!state) {
          if (states.has(body)) return; // held by another instance
          attach(body);
          state = ownState(body);
        }
        disarmRecheck(state);
        stamp(body, state.hasScrolled);
        // A settled body is static: attach already showed its end.
        if (state.following && isStreamingBody(body)) scheduleChase(body);
      });
    }

    function dispose() {
      if (frameHandle !== null) cancelFrame(frameHandle);
      frameHandle = null;
      lastFrameTs = 0;
      detachAll();
    }

    return { sync, dispose };
  }

  return {
    LIVE_BOX_MARKER_ATTR,
    HAS_SCROLLED_CLASS,
    LIVE_BOX_BODY_SELECTOR,
    createReasoningLiveBoxFollow,
    capturePatchState,
    restorePatchState,
    isAnyReaderAway,
  };
});
