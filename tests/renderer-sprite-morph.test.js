'use strict';

// The timeline activity dot's morph engine (spec 3.3): DOM build, freeze and ease,
// urgent timing, debounce, the done draw and hold, reduced motion, visibility and cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSpriteMorph } = require('../renderer/chat/renderer-sprite-morph');
const { SPRITE_ACTIVITIES } = require('../renderer/chat/renderer-sprite-activity');

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

function settledIn(rig, name) {
  rig.morph.setActivity(name);
  rig.clock.advance(400);
}

test('builds the dot root once, in front of the J, at rest with no animation', () => {
  const rig = createRig({ drawing: true });
  const { root, sprite } = rig;
  assert.equal(sprite.firstElementChild, root);
  assert.equal(root.className, 'chat-sprite-dot');
  assert.equal(activity(rig), 'rest');
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.ok(root.nextElementSibling.classList.contains('chat-assistant-sprite-glyph'));
  assert.equal(root.querySelectorAll(':scope > .w > .r').length, 1);
  assert.deepEqual(
    [...root.querySelectorAll(':scope > .w > .p')].map((p) => [p.className, p.children.length, p.firstElementChild.className]),
    [['p p1', 1, 'q'], ['p p2', 1, 'q'], ['p p3', 1, 'q']]
  );
  const svg = root.querySelector(':scope > svg.chat-sprite-check');
  assert.equal(svg.namespaceURI, SVG_NS);
  assert.equal(svg.getAttribute('viewBox'), '-15 -15 30 30');
  assert.equal(rig.ck.namespaceURI, SVG_NS);
  assert.equal(rig.ck.getAttribute('d'), 'M-5.5 0.5 L-1.8 4.2 L5.5 -4');
  assert.equal(rig.animations.length, 0);

  const again = createSpriteMorph(sprite, { windowRef: rig.window, documentRef: rig.document });
  assert.equal(sprite.querySelectorAll('.chat-sprite-dot').length, 1, 'idempotent: the existing root is reused');
  again.dispose();
  rig.window.close();
});

test('unknown activities and a repeat of the current one change nothing', () => {
  const rig = createRig();
  const snapshots = rig.watchReflow(() => 1);
  rig.morph.setActivity('bogus');
  rig.morph.setActivity('');
  rig.morph.setActivity(undefined);
  rig.morph.setActivity('rest');
  assert.equal(activity(rig), 'rest');
  assert.equal(snapshots.length, 0, 'no morph started');
  assert.equal(rig.clock.pending, 0);
  settledIn(rig, 'compose');
  const count = snapshots.length;
  rig.morph.setActivity('compose');
  assert.equal(snapshots.length, count);
  assert.ok(SPRITE_ACTIVITIES.includes(activity(rig)));
  rig.close();
});

test('a change mid-loop freezes the frame inline, eases it home, then clears the inline styles', () => {
  const rig = createRig();
  const { w, r, qs, root } = rig;
  rig.computed.set(w, { transform: 'matrix(1, 0, 0, 1, 3, 4)', opacity: '0.5' });
  rig.computed.set(qs[1], { transform: 'matrix(1, 0, 0, 1, 0, -2)', opacity: '0.8' });
  const frozen = rig.watchReflow(() => ({
    activity: root.dataset.activity,
    wTransform: w.style.transform,
    wOpacity: w.style.opacity,
    wTransition: w.style.transition,
    wAnimation: w.style.animation,
    q1Transform: qs[1].style.transform,
    q1Opacity: qs[1].style.opacity,
    rTransition: r.style.transition,
    pTransition: root.querySelector('.p1').style.transition,
  }));

  rig.morph.setActivity('compose');
  assert.deepEqual(frozen, [{
    activity: 'compose',
    wTransform: 'matrix(1, 0, 0, 1, 3, 4)',
    wOpacity: '0.5',
    wTransition: 'none',
    wAnimation: 'none',
    q1Transform: 'matrix(1, 0, 0, 1, 0, -2)',
    q1Opacity: '0.8',
    rTransition: '',
    pTransition: '',
  }], 'frozen at the computed frame after the state switch; .r and .p are not frozen');
  assert.ok(w.style.transition.includes(`transform 280ms ${EASE}`));
  assert.ok(w.style.transition.includes(`opacity 280ms ${EASE}`));
  assert.equal(w.style.transform, '', 'inline value released so the new pose is the transition target');
  assert.equal(w.style.opacity, '');

  rig.clock.advance(250);
  assert.notEqual(w.style.transition, '', 'still easing');
  rig.clock.advance(100);
  assert.equal(w.style.transition, '');
  assert.equal(w.style.animation, '');
  assert.equal(qs[1].style.transition, '');
  assert.equal(qs[1].style.transform, '');
  rig.close();
});

test('the engine reads durations and ease from the custom properties on the root', () => {
  const rig = createRig();
  rig.props['--sprite-morph-duration'] = '0.2s';
  rig.props['--sprite-morph-ease'] = 'ease-out';
  rig.morph.setActivity('compose');
  assert.ok(rig.w.style.transition.includes('transform 200ms ease-out'));
  rig.close();
});

test('leaving tool spins the orbit forward to 360 degrees from its current angle', () => {
  const rig = createRig();
  settledIn(rig, 'tool');
  rig.computed.set(rig.w, { transform: 'matrix(0, 1, -1, 0, 0, 0)', opacity: '1' });
  const frozen = rig.watchReflow(() => [rig.w.style.transform, rig.w.style.transition]);
  rig.morph.setActivity('compose');
  assert.deepEqual(frozen, [['rotate(90deg)', 'none']]);
  assert.equal(rig.w.style.transform, 'rotate(360deg)');
  assert.ok(rig.w.style.transition.includes('504ms'), 'the spin eases 1.8x the morph duration');
  rig.clock.advance(600);
  assert.deepEqual(frozen[1], ['', 'none'], 'the 360deg is released with transitions off, so CSS cannot spin it back');
  assert.equal(rig.w.style.transform, '');
  assert.equal(rig.w.style.transition, '');

  settledIn(rig, 'tool');
  rig.computed.set(rig.w, { transform: 'matrix(0, -1, 1, 0, 0, 0)', opacity: '1' });
  const negative = rig.watchReflow(() => rig.w.style.transform);
  rig.morph.setActivity('search');
  assert.deepEqual(negative, ['rotate(270deg)'], 'the angle is normalized into [0, 360)');
  rig.close();
});

test('urgent states settle within 140 ms, set data-morph-urgent, and cap the spin-down', () => {
  const rig = createRig();
  settledIn(rig, 'tool');
  rig.computed.set(rig.w, { transform: 'matrix(0, 1, -1, 0, 0, 0)', opacity: '1' });
  rig.morph.setActivity('approve');
  assert.equal(activity(rig), 'approve');
  assert.ok(rig.root.hasAttribute('data-morph-urgent'));
  assert.ok(rig.w.style.transition.includes('transform 140ms'), 'the spin-down is capped at the urgent duration');
  assert.ok(rig.w.style.transition.includes('opacity 140ms'));
  rig.clock.advance(165);
  assert.equal(rig.w.style.transition, '', 'inline settle done within the urgent window');

  rig.computed.set(rig.r, { transform: 'matrix(2, 0, 0, 2, 0, 0)', opacity: '0.4' });
  const frozen = rig.watchReflow(() => [rig.r.style.transition, rig.r.style.transform, rig.r.style.opacity]);
  rig.morph.setActivity('stopped');
  assert.deepEqual(frozen, [['none', 'matrix(2, 0, 0, 2, 0, 0)', '0.4']], '.r is frozen while leaving approve');
  assert.ok(rig.root.hasAttribute('data-morph-urgent'));
  rig.morph.setActivity('error');
  assert.ok(rig.root.hasAttribute('data-morph-urgent'));
  rig.clock.advance(400);
  rig.morph.setActivity('compose');
  assert.equal(rig.root.hasAttribute('data-morph-urgent'), false);
  assert.ok(rig.w.style.transition.includes('280ms'));
  rig.close();
});

test('leaving think for a transient form needs 200 ms of persistence; a newer change cancels', () => {
  const rig = createRig();
  settledIn(rig, 'think');
  rig.morph.setActivity('tool');
  assert.equal(activity(rig), 'think');
  rig.clock.advance(199);
  assert.equal(activity(rig), 'think');
  rig.clock.advance(2);
  assert.equal(activity(rig), 'tool');

  settledIn(rig, 'think');
  rig.morph.setActivity('tool');
  rig.clock.advance(100);
  rig.morph.setActivity('think');
  rig.clock.advance(600);
  assert.equal(activity(rig), 'think', 'a flicker back to think cancels the pending change');

  rig.morph.setActivity('tool');
  rig.clock.advance(100);
  rig.morph.setActivity('tool');
  rig.clock.advance(101);
  assert.equal(activity(rig), 'tool', 'repeating the pending activity does not restart its window');

  settledIn(rig, 'think');
  rig.morph.setActivity('tool');
  rig.clock.advance(150);
  rig.morph.setActivity('search');
  rig.clock.advance(150);
  assert.equal(activity(rig), 'think');
  rig.clock.advance(60);
  assert.equal(activity(rig), 'search', 'the latest transient wins after its own 200 ms');
  rig.close();
});

test('approve, stopped, error, wait, stuck, done and the other forms are never delayed', () => {
  for (const name of ['approve', 'stopped', 'error', 'wait', 'stuck', 'done', 'write', 'compact', 'rest']) {
    const rig = createRig();
    settledIn(rig, 'think');
    rig.morph.setActivity(name);
    assert.equal(activity(rig), name, `${name} is immediate`);
    rig.close();
  }
  const rig = createRig();
  settledIn(rig, 'think');
  rig.morph.setActivity('tool');
  rig.clock.advance(50);
  rig.morph.setActivity('approve');
  rig.clock.advance(1000);
  assert.equal(activity(rig), 'approve', 'an urgent change cancels the pending transient');
  rig.close();
});

test('done draws the check and the nib, holds 1000 ms, then goes to rest', () => {
  const rig = createRig({ drawing: true });
  rig.morph.setActivity('done');
  assert.equal(activity(rig), 'done');
  assert.equal(rig.animations.length, 0, 'the draw waits for the morph to settle');
  rig.clock.advance(300);
  const [pathAnim] = rig.pathAnims();
  assert.equal(rig.ck.getAttribute('pathLength'), '1', 'the dash never depends on a layout measurement');
  assert.deepEqual(pathAnim.frames.map((f) => Number(f.strokeDashoffset)), [1, 0]);
  assert.deepEqual(
    { duration: pathAnim.opts.duration, easing: pathAnim.opts.easing, fill: pathAnim.opts.fill },
    { duration: 480, easing: 'ease-in-out', fill: 'forwards' }
  );
  const [nibAnim] = rig.nibAnims();
  assert.equal(nibAnim.opts.duration, 480);
  assert.equal(nibAnim.opts.fill, 'forwards');
  assert.deepEqual(nibAnim.frames[0], { transform: 'translate(0.00px,0.00px)', opacity: 1 });
  assert.equal(nibAnim.frames.at(-1).opacity, 0);
  assert.equal(nibAnim.frames.at(-1).transform, 'translate(10.00px,5.00px)', 'relative to the start point');
  rig.clock.advance(1479);
  assert.equal(activity(rig), 'done');
  rig.clock.advance(2);
  assert.equal(activity(rig), 'rest');
  assert.equal(nibAnim.cancelled, true);
  rig.clock.advance(400);
  assert.equal(pathAnim.cancelled, true, 'the check stays drawn until the rest morph has settled');
  assert.equal(rig.clock.pending, 0);
  rig.close();
});

test('done keeps its timing where the SVG geometry and WAAPI are unavailable', () => {
  const rig = createRig({ drawing: false });
  rig.morph.setActivity('done');
  rig.clock.advance(300 + 1479);
  assert.equal(activity(rig), 'done');
  rig.clock.advance(2);
  assert.equal(activity(rig), 'rest');
  assert.equal(rig.animations.length, 0);
  rig.close();
});

test('rest during the draw or hold is deferred; any other activity preempts the done', () => {
  const rig = createRig({ drawing: true });
  rig.morph.setActivity('done');
  rig.morph.setActivity('rest');
  rig.clock.advance(300);
  rig.morph.setActivity('rest');
  rig.clock.advance(700);
  assert.equal(activity(rig), 'done', 'still holding');
  rig.clock.advance(800);
  assert.equal(activity(rig), 'rest', 'the deferred rest lands when the hold ends');
  rig.clock.advance(400);

  rig.morph.setActivity('done');
  rig.clock.advance(300 + 600);
  rig.morph.setActivity('approve');
  assert.equal(activity(rig), 'approve');
  assert.ok(rig.nibAnims().every((a) => a.cancelled));
  rig.clock.advance(5000);
  assert.equal(activity(rig), 'approve', 'the hold timer is gone');
  rig.close();
});

test('a reduced-motion change re-applies the static pose with no engine animation left', () => {
  const rig = createRig({ drawing: true });
  settledIn(rig, 'tool');
  rig.w.style.transition = 'transform 280ms ease';
  rig.w.style.transform = 'rotate(40deg)';
  rig.setReduced(true);
  assert.equal(activity(rig), 'tool', 'the activity itself is unchanged');
  assert.equal(rig.w.style.transform, '');
  assert.equal(rig.w.style.transition, '');
  rig.setReduced(false);

  rig.morph.setActivity('done');
  rig.clock.advance(600);
  assert.ok(rig.animations.some((a) => !a.cancelled));
  rig.setReduced(true);
  assert.ok(rig.animations.every((a) => a.cancelled || a.playState === 'finished'), 'nothing keeps running');
  assert.equal(rig.ck.style.strokeDashoffset, '0', 'the full check is shown immediately');
  rig.clock.advance(1403);
  assert.equal(activity(rig), 'done', 'the hold keeps its original deadline');
  rig.clock.advance(2);
  assert.equal(activity(rig), 'rest');
  rig.close();
});

test('while reduced, morphs use the urgent duration and done shows the full check, holds, then rests', () => {
  const rig = createRig({ reduced: true, drawing: true });
  rig.morph.setActivity('compose');
  assert.ok(rig.w.style.transition.includes('transform 140ms'));
  rig.clock.advance(165);
  rig.morph.setActivity('done');
  rig.clock.advance(160);
  assert.equal(rig.animations.length, 0, 'no WAAPI draw under reduced motion');
  assert.equal(rig.ck.style.strokeDashoffset, '0');
  rig.clock.advance(999);
  assert.equal(activity(rig), 'done');
  rig.clock.advance(2);
  assert.equal(activity(rig), 'rest');
  rig.close();
});

test('suspend pauses and stops the hold; resume never replays an expired done', () => {
  const rig = createRig({ drawing: true });
  rig.morph.setActivity('done');
  rig.clock.advance(300 + 500);
  rig.morph.suspend();
  assert.ok(rig.root.hasAttribute('data-suspended'));
  assert.ok(rig.animations.every((a) => a.paused));
  rig.clock.advance(5000);
  assert.equal(activity(rig), 'done', 'the hold timer does not run while suspended');
  const started = rig.animations.length;
  rig.morph.resume();
  assert.equal(rig.root.hasAttribute('data-suspended'), false);
  assert.equal(activity(rig), 'rest', 'an expired hold resolves straight to rest');
  assert.equal(rig.animations.length, started, 'never replayed');
  assert.ok(rig.animations.every((a) => a.cancelled));
  rig.close();
});

test('resume continues an unexpired done for the remaining hold', () => {
  const rig = createRig({ drawing: true });
  rig.morph.setActivity('done');
  rig.clock.advance(300 + 100);
  rig.morph.suspend();
  rig.clock.advance(200);
  rig.morph.resume();
  assert.ok(rig.animations.every((a) => !a.paused && !a.cancelled));
  assert.ok(rig.animations.every((a) => a.plays === 1));
  rig.clock.advance(1179);
  assert.equal(activity(rig), 'done');
  rig.clock.advance(2);
  assert.equal(activity(rig), 'rest');
  rig.close();
});

test('resume re-applies a looping activity from its static pose', () => {
  const rig = createRig();
  settledIn(rig, 'compose');
  rig.morph.suspend();
  rig.w.style.transform = 'rotate(10deg)';
  rig.morph.resume();
  assert.equal(activity(rig), 'compose');
  assert.equal(rig.w.style.transform, '');
  rig.close();
});

test('document visibility suspends and resumes without overriding an explicit suspend', () => {
  const rig = createRig();
  settledIn(rig, 'compose');
  rig.setHidden(true);
  assert.ok(rig.root.hasAttribute('data-suspended'));
  rig.setHidden(false);
  assert.equal(rig.root.hasAttribute('data-suspended'), false);

  rig.morph.suspend();
  rig.setHidden(true);
  rig.setHidden(false);
  assert.ok(rig.root.hasAttribute('data-suspended'), 'the explicit suspend still holds');
  rig.morph.resume();
  assert.equal(rig.root.hasAttribute('data-suspended'), false);
  rig.close();
});

test('callbacks from a stale generation do nothing, even if a timer could not be cleared', () => {
  const rig = createRig({ drawing: true, clearWorks: false });
  rig.morph.setActivity('done');
  rig.clock.advance(100);
  rig.morph.setActivity('tool');
  rig.clock.advance(1000);
  assert.equal(activity(rig), 'tool');
  assert.equal(rig.animations.length, 0, 'the stale settle never started the draw');

  rig.morph.setActivity('done');
  rig.clock.advance(300 + 100);
  rig.morph.setActivity('approve');
  rig.clock.advance(5000);
  assert.equal(activity(rig), 'approve', 'the stale hold never moved on to rest');

  rig.morph.setActivity('stopped');
  rig.morph.dispose();
  rig.clock.advance(5000);
  assert.equal(rig.sprite.querySelector('.chat-sprite-dot'), null);
  rig.window.close();
});

test('dispose removes the root, listeners, timers and animations', () => {
  const rig = createRig({ drawing: true });
  assert.equal(rig.mediaListeners.size, 1);
  rig.morph.setActivity('done');
  rig.clock.advance(300);
  const running = rig.animations.filter((a) => !a.cancelled);
  assert.ok(running.length > 0);
  rig.morph.dispose();
  assert.equal(rig.sprite.querySelector('.chat-sprite-dot'), null);
  assert.ok(rig.sprite.querySelector('.chat-assistant-sprite-glyph'));
  assert.equal(rig.mediaListeners.size, 0);
  assert.equal(rig.docListeners.removed, rig.docListeners.added);
  assert.ok(running.every((a) => a.cancelled));
  assert.equal(rig.clock.pending, 0);
  rig.morph.setActivity('tool');
  rig.morph.suspend();
  rig.morph.resume();
  rig.morph.dispose();
  assert.equal(rig.sprite.querySelector('.chat-sprite-dot'), null, 'every call is inert after dispose');
  rig.setHidden(true);
  rig.window.close();
});

test('reset goes straight to rest and drops a done in flight', () => {
  const rig = createRig({ drawing: true });
  rig.morph.setActivity('done');
  rig.clock.advance(400);
  rig.morph.suspend();
  rig.morph.reset();
  assert.equal(activity(rig), 'rest');
  rig.morph.resume();
  rig.clock.advance(2000);
  assert.equal(activity(rig), 'rest', 'the old hold never fires');
  rig.morph.setActivity('think');
  assert.equal(activity(rig), 'think', 'rest is no longer held');
  rig.close();
});

test('review fixes: tool -> search spins into the magnifier pose; approve ring eases size; suspend takes a pending form', () => {
  const rig = createRig();
  settledIn(rig, 'tool');
  rig.computed.set(rig.w, { transform: 'matrix(0, 1, -1, 0, 0, 0)', opacity: '1', pose: 'matrix(0.99, -0.1, 0.1, 0.99, -2.5, 0)' });
  rig.morph.setActivity('search');
  assert.equal(rig.w.style.transform, 'rotate(360deg) matrix(0.99, -0.1, 0.1, 0.99, -2.5, 0)');
  settledIn(rig, 'approve');
  rig.computed.set(rig.r, { transform: 'matrix(1, 0, 0, 1, 0, 0)', opacity: '0.9', width: '8px', height: '8px', 'border-radius': '50%' });
  const atFlip = rig.watchReflow(() => [rig.r.style.transition, rig.r.style.width]);
  rig.morph.setActivity('stuck');
  assert.deepEqual(atFlip[0], ['none', '8px'], 'the ring holds its size through the attribute flip');
  assert.equal(rig.r.style.width, '', 'easing hands the size back to the new form');
  assert.ok(['width', 'height', 'border-radius'].every((name) => rig.r.style.transition.includes(`${name} 280ms`)));
  settledIn(rig, 'think');
  rig.morph.setActivity('tool');
  rig.morph.suspend();
  assert.equal(activity(rig), 'tool', 'a debounced form is taken statically, not lost');
  rig.clock.advance(400);
  rig.morph.resume();
  assert.equal(activity(rig), 'tool');
  rig.close();
});
