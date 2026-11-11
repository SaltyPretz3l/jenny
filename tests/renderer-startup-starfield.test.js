'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const starter = require('../renderer/shell/renderer-startup-starfield.js');
const workerSky = require('../renderer/shell/renderer-startup-starfield-worker.js');

const WORDMARK_RECT = { left: 540, top: 330, width: 200, height: 40 };
const VIEWPORT = { width: 1600, height: 930, dpr: 1, wordmark: WORDMARK_RECT };

function createStubContext() {
  const calls = { arc: 0, fill: 0, clearRect: 0, fillStyleWrites: 0, fillRect: 0, lastArc: null, cleared: null };
  return {
    calls,
    setTransform() {},
    clearRect(...args) { calls.clearRect += 1; calls.cleared = args; },
    beginPath() {},
    arc(...args) { calls.arc += 1; calls.lastArc = args; },
    fill() { calls.fill += 1; },
    fillRect() { calls.fillRect += 1; },
    save() {},
    restore() {},
    translate() {},
    createRadialGradient() { return { addColorStop() {} }; },
    set fillStyle(_value) { calls.fillStyleWrites += 1; },
    get fillStyle() { return ''; },
    globalAlpha: 1,
  };
}

function createSky(options = {}) {
  const context = createStubContext();
  const canvas = { width: 0, height: 0, getContext: () => context };
  const sky = workerSky.createSky({ canvas, viewport: options.viewport || VIEWPORT, density: options.density, random: options.random });
  return { sky, context, canvas };
}

function createWorkerScope() {
  const frames = new Map();
  let nextFrame = 1;
  const posted = [];
  const scope = {
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    postMessage(message) { posted.push(message); },
  };
  workerSky.attachToWorker(scope);
  const context = createStubContext();
  const canvas = { width: 0, height: 0, getContext: () => context };
  let clock = 0;
  return {
    scope, frames, posted, context, canvas,
    send(data) { scope.onmessage({ data }); },
    init(extra = {}) { scope.onmessage({ data: { type: 'init', canvas, viewport: VIEWPORT, ...extra } }); },
    flush(stepMs = 16) {
      clock += stepMs;
      const pending = Array.from(frames.values());
      frames.clear();
      pending.forEach((callback) => callback(clock));
    },
  };
}

class FakeWorker {
  constructor(url) { this.url = url; this.posts = []; this.transfers = []; this.terminated = 0; }
  postMessage(message, transfer) { this.posts.push(message); this.transfers.push(transfer); }
  terminate() { this.terminated += 1; }
  ofType(type) { return this.posts.filter((message) => message.type === type); }
}

function createHandle(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="startupOverlay">'
    + '<canvas id="startupOverlaySky"></canvas><div class="startup-overlay-wordmark">Jenny</div></div></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const win = dom.window;
  const canvas = win.document.getElementById('startupOverlaySky');
  const offscreen = { offscreen: true };
  if (options.transferable !== false) { canvas.transferControlToOffscreen = () => offscreen; }
  const wordmark = win.document.querySelector('.startup-overlay-wordmark');
  wordmark.getBoundingClientRect = () => WORDMARK_RECT;
  const curtain = win.document.getElementById('startupOverlay');
  curtain.style.setProperty('--startup-text', '#111111');
  curtain.style.setProperty('--startup-cyan', '#86c3e4');
  curtain.style.setProperty('--startup-accent', '#222222');
  const worker = new FakeWorker('');
  const handle = starter.createStartupStarfield({
    canvas, wordmark, curtain, window: win,
    reducedMotion: options.reducedMotion === true,
    createWorker: options.createWorker || (() => worker),
    now: () => 1234,
  });
  t.after(() => handle && handle.dispose());
  const setVisibility = (value) => {
    Object.defineProperty(win.document, 'visibilityState', { configurable: true, get: () => value });
    win.document.dispatchEvent(new win.Event('visibilitychange'));
  };
  return { win, canvas, offscreen, worker, handle, setVisibility };
}

test('star count keeps stars per area constant, within the light and max bounds', () => {
  const count = (width, height, density) => createSky({ viewport: { width, height, dpr: 1 }, density }).sky.getStars().length;
  assert.equal(count(1600, 930), 220, 'the reference window gets the full sky');
  assert.equal(count(1280, 720), 136);
  assert.equal(count(800, 600), 120, 'a small window keeps the light floor');
  assert.equal(count(3840, 2160), 440, 'a 4K window is capped');
  assert.equal(count(3840, 2160, 'light'), 120);
  assert.equal(workerSky.resolveStarCount(undefined, 1600, 930), workerSky.STAR_COUNT_FULL);
});

test('the page and the worker agree on when the stars have arrived', () => {
  assert.equal(starter.SKY_GRACE_MS, workerSky.SKY_GRACE_MS);
  assert.equal(starter.SKY_FADE_MS, workerSky.SKY_FADE_MS);
});

test('the stars wait out the grace period, then arrive', () => {
  assert.equal(workerSky.skyVisibility(0), 0);
  assert.equal(workerSky.skyVisibility(workerSky.SKY_GRACE_MS), 0, 'a fast launch sees no half-formed stars');
  assert.ok(workerSky.skyVisibility(workerSky.SKY_GRACE_MS + 300) > 0);
  assert.equal(workerSky.skyVisibility(workerSky.SKY_GRACE_MS + workerSky.SKY_FADE_MS), 1);
});

test('the disc and the stars scale with the viewport, without changing the count', () => {
  const { sky, context } = createSky({ density: 4, random: () => 0.999 });
  const centreX = WORDMARK_RECT.left + WORDMARK_RECT.width / 2;
  sky.drawStill();
  const [referenceX, , referenceSize] = context.calls.lastArc;
  assert.ok(Math.abs(referenceX - centreX - 710) < 5, `reference outer edge ${referenceX - centreX} ~ 710px`);
  sky.setViewport({ width: 3200, height: 1860, dpr: 1, wordmark: WORDMARK_RECT });
  sky.drawStill();
  const [wideX, , wideSize] = context.calls.lastArc;
  assert.ok(Math.abs(wideX - centreX - 1350) < 5, `doubled window outer edge ${wideX - centreX} ~ 1350px`);
  assert.ok(Math.abs(wideSize / referenceSize - 1.5) < 1e-9, 'star size scales, capped at 1.5x');
  assert.equal(sky.getStars().length, 4);
});

test('collapse gives every star a destination inside the wordmark rect', () => {
  const { sky } = createSky();
  sky.drawFrame(800, 16);
  sky.beginCollapse({ durationMs: 500, wordmark: WORDMARK_RECT }, 800);
  assert.equal(sky.getCollapseDuration(), 500);
  for (const star of sky.getStars()) {
    assert.ok(star.tx >= WORDMARK_RECT.left && star.tx <= WORDMARK_RECT.left + WORDMARK_RECT.width, `tx ${star.tx} inside the wordmark`);
    assert.ok(star.ty >= WORDMARK_RECT.top && star.ty <= WORDMARK_RECT.top + WORDMARK_RECT.height, `ty ${star.ty} inside the wordmark`);
  }
});

test('a frame makes no Array.prototype.push calls and exactly three star fill-style writes', () => {
  const { sky, context } = createSky();
  sky.drawFrame(800, 16);
  const originalPush = Array.prototype.push;
  let pushes = 0;
  Array.prototype.push = function countingPush(...items) { pushes += 1; return originalPush.apply(this, items); };
  const fillWritesBefore = context.calls.fillStyleWrites;
  try {
    sky.drawFrame(900, 16);
  } finally {
    Array.prototype.push = originalPush;
  }
  assert.equal(pushes, 0, 'no Array.prototype.push during a draw');
  assert.equal(context.calls.fillStyleWrites - fillWritesBefore, 3, 'one fillStyle per colour group');
});

test('the flare is drawn on the canvas during a collapse and never while swirling', () => {
  const { sky, context } = createSky();
  sky.drawFrame(1200, 16);
  assert.equal(context.calls.fillRect, 0, 'no flare while the sky turns');
  sky.beginCollapse({ durationMs: 500, wordmark: WORDMARK_RECT }, 1200);
  sky.advanceCollapse(200);
  sky.drawFrame(1216, 0);
  assert.equal(context.calls.fillRect, 1, 'the flare rises behind the name');
});

test('the worker loop runs until the collapse lands, then stops', () => {
  const w = createWorkerScope();
  w.init();
  assert.equal(w.frames.size, 1, 'the sky turns from init');
  w.flush();
  assert.deepEqual(w.posted[0], { type: 'first-frame' });
  assert.equal(w.posted.filter((message) => message.type === 'first-frame').length, 1);
  w.flush();
  w.send({ type: 'collapse', durationMs: 100, wordmark: WORDMARK_RECT });
  for (let i = 0; i < 40 && w.frames.size > 0; i += 1) { w.flush(16); }
  assert.equal(w.frames.size, 0, 'the loop stops when the stars land');
  const framesDrawn = w.context.calls.clearRect;
  w.flush(16);
  assert.equal(w.context.calls.clearRect, framesDrawn);
});

test('a resize redraws in the same task so the cleared canvas never reaches the screen', () => {
  const w = createWorkerScope();
  w.init();
  w.flush();
  const before = w.context.calls.clearRect;
  w.send({ type: 'resize', viewport: { width: 800, height: 480, dpr: 1, wordmark: WORDMARK_RECT } });
  assert.equal(w.context.calls.clearRect, before + 1);
  assert.deepEqual(w.context.calls.cleared, [0, 0, 800, 480]);
  assert.equal(w.frames.size, 1, 'the swirl keeps its pending frame');
});

test('pause cancels the live frame and resume restarts it without a time jump', () => {
  const w = createWorkerScope();
  w.init();
  w.flush();
  w.send({ type: 'pause' });
  assert.equal(w.frames.size, 0);
  w.send({ type: 'resume' });
  assert.equal(w.frames.size, 1);
  w.flush(5000);
  w.send({ type: 'report' });
  const report = w.posted.find((message) => message.type === 'frames');
  assert.equal(report.maxGapMs, 0, 'the paused stretch is not reported as a dropped frame');
});

test('the frame report records the worst gap and frames over budget', () => {
  const w = createWorkerScope();
  w.init();
  w.flush(16);
  w.flush(16);
  w.flush(50);
  w.send({ type: 'report' });
  const report = w.posted.find((message) => message.type === 'frames');
  assert.equal(report.maxGapMs, 50);
  assert.equal(report.overBudget, 1);
});

test('a still sky paints once and never starts a loop', () => {
  const w = createWorkerScope();
  w.init({ still: true });
  assert.equal(w.frames.size, 0);
  assert.equal(w.context.calls.arc, 220, 'every star is painted once, still');
  w.send({ type: 'collapse', durationMs: 100 });
  assert.equal(w.frames.size, 0);
});

test('a launch that beat the stars dissolves quietly', () => {
  const exit = starter.resolveStartupExit({ skyElapsedMs: starter.QUIET_SKY_MS - 1 });
  assert.equal(exit.kind, 'quiet');
  assert.equal(exit.durationMs, starter.QUIET_DISSOLVE_MS);
  assert.equal(exit.curtainDelayMs, 0);
  assert.equal(exit.curtainFadeMs, starter.QUIET_DISSOLVE_MS);
});

test('the collapse lasts as long as the sky has earned, within its range', () => {
  const early = starter.resolveStartupExit({ skyElapsedMs: starter.QUIET_SKY_MS });
  const later = starter.resolveStartupExit({ skyElapsedMs: 700 });
  const settled = starter.resolveStartupExit({ skyElapsedMs: 5000 });
  assert.equal(early.kind, 'earned');
  assert.ok(early.durationMs > 300 && early.durationMs < later.durationMs, `${early.durationMs} < ${later.durationMs}`);
  assert.equal(settled.durationMs, 720);
  assert.equal(settled.curtainDelayMs + settled.curtainFadeMs, settled.durationMs);
  assert.equal(settled.curtainDelayMs, Math.round(720 * 0.4));
  assert.equal(settled.nameDelayMs, Math.round(720 * 0.72));
});

test('the first-ever launch keeps the full collapse whatever the elapsed time', () => {
  const exit = starter.resolveStartupExit({ firstLaunch: true, skyElapsedMs: 0 });
  assert.equal(exit.kind, 'full');
  assert.equal(exit.durationMs, starter.COLLAPSE_MS);
  assert.equal(exit.curtainDelayMs, Math.round(750 * 0.5));
  assert.equal(exit.nameDelayMs, Math.round(750 * 0.8));
});

test('the handle hands the canvas to the worker with the curtain colours', (t) => {
  const { worker, offscreen, handle } = createHandle(t);
  const [init] = worker.ofType('init');
  assert.equal(init.canvas, offscreen);
  assert.deepEqual(worker.transfers[0], [offscreen]);
  assert.deepEqual(init.colors, ['#111111', '#86c3e4', '#222222']);
  assert.equal(init.flareRgb, '134, 195, 228');
  assert.equal(init.still, false);
  assert.equal(handle.startedAt, 1234);
  assert.equal(handle.isAnimated(), true);
});

test('collapse measures the wordmark at the moment it is asked', (t) => {
  const { worker, handle } = createHandle(t);
  handle.collapse({ durationMs: 500 });
  const [collapse] = worker.ofType('collapse');
  assert.equal(collapse.durationMs, 500);
  assert.deepEqual(collapse.wordmark, WORDMARK_RECT);
});

test('no transferable canvas or no worker leaves the curtain plain', (t) => {
  assert.equal(createHandle(t, { transferable: false }).handle, null);
  assert.equal(createHandle(t, { createWorker: () => null }).handle, null);
  assert.equal(createHandle(t, { createWorker: () => { throw new Error('blocked'); } }).handle, null);
});

test('a worker failure hides the sky and falls back to the plain exit', (t) => {
  const { worker, handle, canvas } = createHandle(t);
  worker.onerror(new Error('load failed'));
  assert.equal(handle.isAnimated(), false);
  assert.equal(canvas.style.display, 'none');
  assert.equal(worker.terminated, 1);
});

test('a hidden window pauses the sky and a visible one resumes it', (t) => {
  const { worker, handle, setVisibility } = createHandle(t);
  setVisibility('hidden');
  assert.equal(handle.isPaused(), true);
  assert.equal(worker.ofType('pause').length, 1);
  setVisibility('visible');
  assert.equal(handle.isPaused(), false);
  assert.equal(worker.ofType('resume').length, 1);
});

// A-3: the fatal dialog holds the sky; a window coming back into view must not
// restart it behind the dialog, and a hidden window stays paused on resume().
test('a caller pause holds across visibility changes until the caller resumes', (t) => {
  const { handle, worker, setVisibility } = createHandle(t);
  handle.pause();
  setVisibility('hidden');
  setVisibility('visible');
  assert.equal(handle.isPaused(), true, 'visibility does not lift a caller pause');
  assert.equal(worker.ofType('resume').length, 0);
  setVisibility('hidden');
  handle.resume();
  assert.equal(handle.isPaused(), true, 'a hidden window stays paused after the caller resumes');
  setVisibility('visible');
  assert.equal(handle.isPaused(), false);
});

test('dispose terminates the worker, hides the canvas and stops posting', (t) => {
  const { worker, handle, canvas, win } = createHandle(t);
  handle.dispose();
  assert.equal(worker.terminated, 1);
  assert.equal(canvas.style.display, 'none');
  assert.equal(handle.isAnimated(), false);
  const posts = worker.posts.length;
  win.dispatchEvent(new win.Event('resize'));
  handle.collapse({ durationMs: 100 });
  assert.equal(worker.posts.length, posts, 'nothing is sent after disposal');
  handle.dispose();
  assert.equal(worker.terminated, 1, 'dispose is idempotent');
});

test('reduced motion asks for a still sky and reports not animated', (t) => {
  const { worker, handle } = createHandle(t, { reducedMotion: true });
  assert.equal(worker.ofType('init')[0].still, true);
  assert.equal(handle.isAnimated(), false, 'the controller then uses its plain fade');
});

test('the early sky starts from its own tag, and not when the animation is off', (t) => {
  const previous = { document: globalThis.document, Worker: globalThis.Worker };
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.Worker = previous.Worker;
  });
  function bootWith(setup) {
    const dom = new JSDOM('<!doctype html><html><body><div id="startupOverlay"><canvas id="startupOverlaySky"></canvas></div></body></html>', { pretendToBeVisual: true });
    t.after(() => dom.window.close());
    const created = [];
    dom.window.Worker = class extends FakeWorker { constructor(url) { super(url); created.push(this); } };
    dom.window.document.getElementById('startupOverlaySky').transferControlToOffscreen = () => ({});
    setup(dom.window.document.documentElement);
    globalThis.document = dom.window.document;
    const sky = starter.startEarlySky();
    t.after(() => sky && sky.dispose());
    return { sky, created };
  }
  const on = bootWith(() => {});
  assert.equal(on.created.length, 1);
  assert.match(on.created[0].url, /renderer-startup-starfield-worker\.js$/);
  assert.equal(starter.getEarlySky(), on.sky);
  const off = bootWith((root) => { root.dataset.startupAnimation = 'off'; });
  assert.equal(off.sky, null);
  assert.equal(off.created.length, 0);
  const flagged = bootWith((root) => { root.dataset.startupAnimationFlag = 'off'; });
  assert.equal(flagged.created.length, 0);
});
