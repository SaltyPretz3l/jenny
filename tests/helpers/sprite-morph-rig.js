'use strict';

// The sprite-morph test rig: a JSDOM dot root driven by a manual clock, with
// computed-style, WAAPI, matchMedia and visibility stubs the engine reads.
const { JSDOM } = require('jsdom');

const { createSpriteMorph } = require('../../renderer/chat/renderer-sprite-morph');

const SVG_NS = 'http://www.w3.org/2000/svg';
const EASE = 'cubic-bezier(.2,.7,.2,1)';

function createClock({ clearWorks = true } = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      nextId += 1;
      timers.set(nextId, { fn, at: now + ms });
      return nextId;
    },
    clearTimeout(id) {
      if (clearWorks) timers.delete(id);
    },
    get pending() { return timers.size; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        timers.delete(next.id);
        now = next.timer.at;
        next.timer.fn();
      }
      now = end;
    },
  };
}

function createRig({ reduced = false, drawing = false, clearWorks = true } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body><div id="sprite"><span class="chat-assistant-sprite-glyph">J</span></div></body>'
  );
  const { window } = dom;
  const { document } = window;
  const clock = createClock({ clearWorks });
  const computed = new Map();
  const props = {};
  const animations = [];
  const mediaListeners = new Set();
  const media = { matches: reduced };
  const docListeners = { added: 0, removed: 0 };
  let hidden = false;

  window.getComputedStyle = (el) => ({
    // With the animation and the inline transform off, an element computes its static pose.
    transform: el.style.animation === 'none' && el.style.transform === ''
      ? computed.get(el)?.pose ?? 'none'
      : computed.get(el)?.transform ?? 'none',
    opacity: computed.get(el)?.opacity ?? '1',
    getPropertyValue: (name) => (el.classList.contains('chat-sprite-dot') ? props[name] ?? '' : computed.get(el)?.[name] ?? ''),
  });
  window.Element.prototype.animate = function animate(frames, opts) {
    const anim = {
      el: this, frames, opts, cancelled: false, paused: false, plays: 0, playState: 'running',
      cancel() { anim.cancelled = true; anim.playState = 'idle'; },
      pause() { anim.paused = true; anim.playState = 'paused'; },
      play() { anim.paused = false; anim.plays += 1; anim.playState = 'running'; },
      finish() { anim.playState = 'finished'; },
    };
    animations.push(anim);
    return anim;
  };
  if (drawing) {
    window.SVGElement.prototype.getTotalLength = () => 20;
    window.SVGElement.prototype.getPointAtLength = (length) => ({ x: length * 0.5, y: length * 0.25 });
  }
  window.matchMedia = () => ({
    get matches() { return media.matches; },
    addEventListener: (type, fn) => mediaListeners.add(fn),
    removeEventListener: (type, fn) => mediaListeners.delete(fn),
  });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const addEventListener = document.addEventListener.bind(document);
  const removeEventListener = document.removeEventListener.bind(document);
  document.addEventListener = (type, ...rest) => {
    if (type === 'visibilitychange') docListeners.added += 1;
    return addEventListener(type, ...rest);
  };
  document.removeEventListener = (type, ...rest) => {
    if (type === 'visibilitychange') docListeners.removed += 1;
    return removeEventListener(type, ...rest);
  };

  const sprite = document.getElementById('sprite');
  const morph = createSpriteMorph(sprite, {
    windowRef: window,
    documentRef: document,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
  });
  const root = sprite.querySelector('.chat-sprite-dot');
  return {
    window,
    document,
    sprite,
    root,
    morph,
    clock,
    computed,
    props,
    animations,
    mediaListeners,
    docListeners,
    w: root.querySelector('.w'),
    r: root.querySelector('.r'),
    qs: [...root.querySelectorAll('.q')],
    ck: root.querySelector('path.ck'),
    nibAnims: () => animations.filter((a) => a.el === root.querySelector('.p1 .q')),
    pathAnims: () => animations.filter((a) => a.el === root.querySelector('path.ck')),
    setReduced(value) {
      media.matches = value;
      for (const fn of [...mediaListeners]) fn({ matches: value });
    },
    setHidden(value) {
      hidden = value;
      document.dispatchEvent(new window.Event('visibilitychange'));
    },
    // Records inline styles at the forced reflow, after the switch and before the ease.
    watchReflow(read) {
      const snapshots = [];
      Object.defineProperty(root, 'offsetWidth', {
        configurable: true,
        get() { snapshots.push(read()); return 0; },
      });
      return snapshots;
    },
    close() { morph.dispose(); window.close(); },
  };
}

const activity = (rig) => rig.root.dataset.activity;

const TOOL_FORMS = new Set(['search', 'make', 'run', 'tool']);

// Settled in the form, past a tool form's 800 ms minimum hold.
function settledIn(rig, name) {
  rig.morph.setActivity(name);
  rig.clock.advance(TOOL_FORMS.has(name) ? 900 : 400);
}

module.exports = { SVG_NS, EASE, TOOL_FORMS, createClock, createRig, activity, settledIn };
