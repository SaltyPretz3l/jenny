(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSpriteMorph = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The timeline activity dot's morph engine (spec 3.3). CSS owns every form and
  // loop; this engine only freezes the looping elements at their current frame,
  // eases that frame into the next state's entry pose, and drives the done check.
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const spriteActivityUtils = globalRef.rendererSpriteActivity
    || (typeof require === 'function' ? require('./renderer-sprite-activity') : null)
    || {};
  const ACTIVITIES = new Set(spriteActivityUtils.SPRITE_ACTIVITIES || []);

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CHECK_PATH = 'M-5.5 0.5 L-1.8 4.2 L5.5 -4';
  const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';
  const DEFAULT_MORPH_MS = 280;
  const DEFAULT_URGENT_MS = 140;
  const DEFAULT_EASE = 'cubic-bezier(.2,.7,.2,1)';
  const SPIN_FACTOR = 1.8;
  const SETTLE_SLACK_MS = 20;
  const THINK_LEAVE_MS = 200;
  const DONE_DRAW_MS = 480;
  const DONE_HOLD_MS = 1000;
  const NIB_SAMPLES = 28;
  const URGENT = new Set(['approve', 'stopped', 'error']);
  const TRANSIENT = new Set(['compose', 'search', 'tool', 'check']);
  const RING_SIZE = ['width', 'height', 'border-radius'];

  function parseMs(value, fallback) {
    const match = /^\s*(\d*\.?\d+)(ms|s)\s*$/.exec(String(value || ''));
    if (!match) return fallback;
    return match[2] === 's' ? Number(match[1]) * 1000 : Number(match[1]);
  }

  // Rotation angle of a computed matrix()/matrix3d() in degrees, in [0, 360).
  function angleOf(transform) {
    const match = /^matrix(?:3d)?\(([^)]+)\)$/.exec(String(transform || ''));
    if (!match) return 0;
    const [a, b] = match[1].split(',').map(Number);
    const degrees = (Math.atan2(b, a) * 180) / Math.PI;
    return degrees < 0 ? degrees + 360 : degrees;
  }

  // One `property duration easing` entry of a transition list.
  function transitionOf(property, ms, ease) {
    return [property, `${ms}ms`, ease].join(' ');
  }

  function createNode(documentRef, tag, className) {
    const node = documentRef.createElement(tag);
    node.className = className;
    return node;
  }

  function buildDot(documentRef) {
    const dot = createNode(documentRef, 'div', 'chat-sprite-dot');
    dot.setAttribute('data-activity', 'rest');
    dot.setAttribute('aria-hidden', 'true');
    const group = createNode(documentRef, 'div', 'w');
    group.appendChild(createNode(documentRef, 'span', 'r'));
    for (const name of ['p1', 'p2', 'p3']) {
      const particle = createNode(documentRef, 'div', `p ${name}`);
      particle.appendChild(createNode(documentRef, 'div', 'q'));
      group.appendChild(particle);
    }
    const svg = documentRef.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'chat-sprite-check');
    svg.setAttribute('viewBox', '-15 -15 30 30');
    const check = documentRef.createElementNS(SVG_NS, 'path');
    check.setAttribute('class', 'ck');
    check.setAttribute('d', CHECK_PATH);
    // A unit path length keeps the dash independent of layout: a hidden rail measures 0.
    check.setAttribute('pathLength', '1');
    svg.appendChild(check);
    dot.append(group, svg);
    return dot;
  }

  function adoptOrBuildDot(spriteEl, documentRef) {
    const existing = [...spriteEl.children].find((child) => child.classList.contains('chat-sprite-dot'));
    if (existing) {
      existing.setAttribute('data-activity', 'rest');
      return existing;
    }
    const dot = buildDot(documentRef);
    spriteEl.insertBefore(dot, spriteEl.firstChild);
    return dot;
  }

  function createSpriteMorph(spriteEl, options = {}) {
    const documentRef = options.documentRef || spriteEl.ownerDocument;
    const windowRef = options.windowRef || documentRef.defaultView || globalRef;
    const setTimer = options.setTimeout || windowRef.setTimeout.bind(windowRef);
    const clearTimer = options.clearTimeout || windowRef.clearTimeout.bind(windowRef);
    const now = options.now || (() => Date.now());
    const dot = adoptOrBuildDot(spriteEl, documentRef);
    const group = dot.querySelector('.w');
    const ring = dot.querySelector('.r');
    const nib = dot.querySelector('.p1 .q');
    const check = dot.querySelector('.ck');
    const loopEls = [group, ...dot.querySelectorAll('.q')];
    const reducedQuery = windowRef.matchMedia?.(REDUCED_QUERY) || null;
    const canDraw = typeof check.getTotalLength === 'function'
      && typeof check.getPointAtLength === 'function'
      && typeof check.animate === 'function';

    let current = 'rest';
    let generation = 0;
    let disposed = false;
    let explicitSuspend = false;
    let docHidden = false;
    let suspended = false;
    let doneActive = false;
    let holdDeadline = 0;
    let settleTimer = null;
    let holdTimer = null;
    let pending = null;
    let nibAnims = [];
    let checkAnims = [];

    function hideCheck() {
      check.style.strokeDashoffset = '1';
    }
    check.style.strokeDasharray = '1';
    hideCheck();

    const reduced = () => reducedQuery?.matches === true;
    const allAnims = () => [...nibAnims, ...checkAnims];

    function clearSettle() {
      if (settleTimer !== null) clearTimer(settleTimer);
      settleTimer = null;
    }

    function clearHold() {
      if (holdTimer !== null) clearTimer(holdTimer);
      holdTimer = null;
    }

    function clearPending() {
      if (pending) clearTimer(pending.timer);
      pending = null;
    }

    function cancelTimers() {
      clearSettle();
      clearHold();
      clearPending();
    }

    function cancelNib() {
      nibAnims.forEach((anim) => anim.cancel());
      nibAnims = [];
    }

    function cancelCheck() {
      checkAnims.forEach((anim) => anim.cancel());
      checkAnims = [];
      hideCheck();
    }

    // Hand the loops back to CSS with transitions off for that one style change:
    // a CSS transform transition would otherwise replay a finished spin backward.
    function releaseLoops() {
      const els = [...loopEls, ring];
      for (const el of els) {
        el.style.transition = 'none';
        el.style.animation = '';
        el.style.transform = '';
        el.style.opacity = '';
      }
      void dot.offsetWidth;
      for (const el of els) el.style.transition = '';
    }

    function readTiming(urgent) {
      const computed = windowRef.getComputedStyle(dot);
      const base = parseMs(computed.getPropertyValue('--sprite-morph-duration'), DEFAULT_MORPH_MS);
      const fast = parseMs(computed.getPropertyValue('--sprite-morph-urgent'), DEFAULT_URGENT_MS);
      const quick = urgent || reduced();
      const ms = quick ? fast : base;
      return {
        ms,
        spinMs: quick ? ms : ms * SPIN_FACTOR,
        ease: computed.getPropertyValue('--sprite-morph-ease').trim() || DEFAULT_EASE,
      };
    }

    // Freeze every loop at its computed frame; a leaving-tool orbit keeps its angle
    // so it can keep turning forward instead of reversing.
    function freezeLoops(previous) {
      const targets = previous === 'approve' ? [...loopEls, ring] : loopEls;
      const frames = targets.map((el) => {
        const computed = windowRef.getComputedStyle(el);
        const spin = previous === 'tool' && el === group;
        const frame = { el, spin, transform: spin ? `rotate(${angleOf(computed.transform)}deg)` : computed.transform, opacity: computed.opacity };
        // The ring also changes size between forms: hold its size too, or the
        // attribute flip commits the new size before easing turns transitions on.
        if (el === ring) frame.size = RING_SIZE.map((name) => [name, computed.getPropertyValue(name)]);
        return frame;
      });
      cancelNib();
      for (const { el, transform, opacity, size } of frames) {
        el.style.transition = 'none';
        el.style.animation = 'none';
        el.style.transform = transform;
        el.style.opacity = opacity;
        size?.forEach(([name, value]) => el.style.setProperty(name, value));
      }
      return frames;
    }

    // The orbit spins forward into the next state's own group pose (search tilts
    // its magnifier). Both ends carry the same function list, so the angle stays forward.
    function composeSpin(frame) {
      const frozen = frame.el.style.transform;
      frame.el.style.transform = '';
      const pose = windowRef.getComputedStyle(frame.el).transform;
      const target = pose && pose !== 'none' ? pose : '';
      frame.el.style.transform = target ? `${frozen} matrix(1, 0, 0, 1, 0, 0)` : frozen;
      frame.target = target ? `rotate(360deg) ${target}` : 'rotate(360deg)';
    }

    function easeFrames(frames, { ms, spinMs, ease }) {
      for (const { el, spin, target, size } of frames) {
        const parts = [transitionOf('transform', spin ? spinMs : ms, ease), transitionOf('opacity', ms, ease)];
        if (size) parts.push(...RING_SIZE.map((name) => transitionOf(name, ms, ease)));
        el.style.transition = parts.join(', ');
        el.style.transform = spin ? target : '';
        el.style.opacity = '';
        size?.forEach(([name]) => el.style.removeProperty(name));
      }
    }

    function transition(next) {
      generation += 1;
      const token = generation;
      cancelTimers();
      const previous = current;
      const urgent = URGENT.has(next);
      const timing = readTiming(urgent);
      const frames = freezeLoops(previous);
      if (next === 'done') cancelCheck();
      current = next;
      doneActive = next === 'done';
      holdDeadline = 0;
      dot.setAttribute('data-activity', next);
      dot.toggleAttribute('data-morph-urgent', urgent);
      for (const frame of frames) if (frame.spin) composeSpin(frame);
      void dot.offsetWidth;
      easeFrames(frames, timing);
      const longest = previous === 'tool' ? Math.max(timing.ms, timing.spinMs) : timing.ms;
      settleTimer = setTimer(() => settle(token), longest + SETTLE_SLACK_MS);
    }

    function settle(token) {
      if (token !== generation || disposed) return;
      settleTimer = null;
      releaseLoops();
      if (current === 'done') beginDone();
      else cancelCheck();
    }

    // The nib's path is measured here, while the rail is visible, never at construction.
    function drawCheck() {
      const timing = { duration: DONE_DRAW_MS, easing: 'ease-in-out', fill: 'forwards' };
      checkAnims.push(check.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], timing));
      const length = check.getTotalLength();
      if (!(length > 0)) {
        nib.style.opacity = '0';
        return;
      }
      const start = check.getPointAtLength(0);
      const frames = [];
      for (let i = 0; i <= NIB_SAMPLES; i += 1) {
        const point = check.getPointAtLength((length * i) / NIB_SAMPLES);
        frames.push({ transform: `translate(${(point.x - start.x).toFixed(2)}px,${(point.y - start.y).toFixed(2)}px)` });
      }
      frames[0].opacity = 1;
      frames[NIB_SAMPLES].opacity = 0;
      nibAnims.push(nib.animate(frames, timing));
    }

    function showCheckStatic() {
      cancelNib();
      cancelCheck();
      check.style.strokeDashoffset = '0';
      nib.style.opacity = '0';
    }

    function beginDone() {
      const drawMs = reduced() ? 0 : DONE_DRAW_MS;
      if (reduced() || !canDraw) showCheckStatic();
      else drawCheck();
      startHold(drawMs + DONE_HOLD_MS);
      if (suspended) pauseAnims();
    }

    function startHold(ms) {
      holdDeadline = now() + ms;
      if (!suspended) armHold(ms);
    }

    function armHold(ms) {
      const token = generation;
      holdTimer = setTimer(() => {
        if (token !== generation || disposed) return;
        holdTimer = null;
        holdDeadline = 0;
        transition('rest');
      }, ms);
    }

    function pauseAnims() {
      allAnims().filter((anim) => anim.playState === 'running').forEach((anim) => anim.pause());
    }

    // The static pose of the current activity: loops released to CSS, engine
    // animations gone, and a held check shown whole.
    function reapply() {
      const midMorph = settleTimer !== null;
      clearSettle();
      releaseLoops();
      if (current === 'done') {
        showCheckStatic();
        if (midMorph) startHold(DONE_HOLD_MS);
        return;
      }
      cancelNib();
      cancelCheck();
    }

    // Straight to rest with nothing running: a hold that expired while suspended,
    // or a new session that must not inherit the old one's form.
    function reset() {
      jumpTo('rest');
    }

    // Take a form with no morph and nothing running (never done: it needs the draw).
    function jumpTo(next) {
      generation += 1;
      cancelTimers();
      doneActive = false;
      holdDeadline = 0;
      current = next;
      dot.setAttribute('data-activity', next);
      dot.toggleAttribute('data-morph-urgent', URGENT.has(next));
      cancelNib();
      cancelCheck();
      releaseLoops();
    }

    function resumeActivity() {
      if (doneActive && holdDeadline > 0) {
        const remaining = holdDeadline - now();
        if (remaining <= 0) {
          reset();
          return;
        }
        allAnims().filter((anim) => anim.playState === 'paused').forEach((anim) => anim.play());
        armHold(remaining);
        return;
      }
      reapply();
    }

    function syncSuspension() {
      const wanted = explicitSuspend || docHidden;
      if (disposed || wanted === suspended) return;
      suspended = wanted;
      if (wanted) {
        dot.setAttribute('data-suspended', '');
        pauseAnims();
        clearHold();
        // Nothing morphs while hidden: a debounced form is taken now, statically,
        // so resume re-applies the form the pipeline last asked for.
        const deferred = pending?.activity;
        clearPending();
        if (deferred) jumpTo(deferred);
        return;
      }
      dot.removeAttribute('data-suspended');
      resumeActivity();
    }

    function setActivity(next) {
      if (disposed || !ACTIVITIES.has(next)) return;
      if (doneActive && next === 'rest') return; // the hold always ends in rest
      if (pending) {
        if (pending.activity === next) return;
        clearPending();
      }
      if (next === current) return;
      if (current === 'think' && TRANSIENT.has(next)) {
        const entry = { activity: next, timer: null };
        entry.timer = setTimer(() => {
          if (pending !== entry || disposed) return;
          pending = null;
          transition(next);
        }, THINK_LEAVE_MS);
        pending = entry;
        return;
      }
      transition(next);
    }

    function onVisibility() {
      docHidden = documentRef.hidden === true;
      syncSuspension();
    }

    reducedQuery?.addEventListener?.('change', reapply);
    documentRef.addEventListener('visibilitychange', onVisibility);
    onVisibility();

    return {
      setActivity,
      reset,
      suspend() {
        explicitSuspend = true;
        syncSuspension();
      },
      resume() {
        explicitSuspend = false;
        syncSuspension();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        generation += 1;
        cancelTimers();
        reducedQuery?.removeEventListener?.('change', reapply);
        documentRef.removeEventListener('visibilitychange', onVisibility);
        cancelNib();
        cancelCheck();
        dot.remove();
      },
    };
  }

  return { createSpriteMorph };
});
