'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const starfieldUtils = require('../renderer/shell/renderer-startup-starfield.js');

const WORDMARK_RECT = { left: 540, top: 330, width: 200, height: 40 };

function createStubContext() {
  const calls = { arc: 0, fill: 0, clearRect: 0, fillStyleWrites: 0 };
  return {
    calls,
    setTransform() {},
    clearRect() { calls.clearRect += 1; },
    beginPath() {},
    arc() { calls.arc += 1; },
    fill() { calls.fill += 1; },
    set fillStyle(_value) { calls.fillStyleWrites += 1; },
    get fillStyle() { return ''; },
    globalAlpha: 1,
  };
}

function createSky(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="startupOverlay">'
    + '<canvas id="startupOverlaySky"></canvas><div class="startup-overlay-wordmark">Jenny</div></div></body></html>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { configurable: true, value: options.innerWidth || 1280 });
  Object.defineProperty(win, 'innerHeight', { configurable: true, value: 720 });
  const frames = new Map();
  let nextFrame = 1;
  win.requestAnimationFrame = (callback) => { const id = nextFrame++; frames.set(id, callback); return id; };
  win.cancelAnimationFrame = (id) => { frames.delete(id); };
  const context = createStubContext();
  const canvas = win.document.getElementById('startupOverlaySky');
  canvas.getContext = () => context;
  const wordmark = win.document.querySelector('.startup-overlay-wordmark');
  wordmark.getBoundingClientRect = () => ({ ...WORDMARK_RECT, right: WORDMARK_RECT.left + WORDMARK_RECT.width, bottom: WORDMARK_RECT.top + WORDMARK_RECT.height });
  const curtain = win.document.getElementById('startupOverlay');
  const sky = starfieldUtils.createStartupStarfield({
    canvas,
    wordmark,
    curtain,
    window: win,
    reducedMotion: options.reducedMotion === true,
    density: options.density,
  });
  t.after(() => sky && sky.dispose());
  let clock = 0;
  function flush(stepMs = 16) {
    clock += stepMs;
    const pending = Array.from(frames.values());
    frames.clear();
    pending.forEach((callback) => callback(clock));
  }
  return { dom, win, sky, frames, flush, context, curtain, wordmark };
}

test('star count follows the density rule, measured once at mount', (t) => {
  assert.equal(createSky(t, { innerWidth: 1280 }).sky.getStarCount(), 220);
  assert.equal(createSky(t, { innerWidth: 1099 }).sky.getStarCount(), 120);
  assert.equal(createSky(t, { innerWidth: 1280, density: 'light' }).sky.getStarCount(), 120);
  assert.equal(starfieldUtils.resolveStarCount(undefined, 1100), starfieldUtils.STAR_COUNT_FULL);
});

test('collapse gives every star a destination inside the wordmark rect and lands on onDone', (t) => {
  const { sky, flush, frames, curtain } = createSky(t);
  sky.start();
  flush();
  flush();
  let done = 0;
  assert.equal(sky.collapse({ onDone() { done += 1; } }), true);
  for (const star of sky.getStars()) {
    assert.ok(star.tx >= WORDMARK_RECT.left && star.tx <= WORDMARK_RECT.left + WORDMARK_RECT.width, `tx ${star.tx} inside the wordmark`);
    assert.ok(star.ty >= WORDMARK_RECT.top && star.ty <= WORDMARK_RECT.top + WORDMARK_RECT.height, `ty ${star.ty} inside the wordmark`);
  }
  for (let i = 0; i < 60 && frames.size > 0; i += 1) { flush(16); }
  assert.equal(done, 1, 'onDone fires once when the stars land');
  assert.equal(frames.size, 0, 'the loop stops after the collapse');
  assert.equal(curtain.style.opacity, '0', 'the curtain has faded under the last stars');
});

test('resize during collapse lands at once and cancels further frames', (t) => {
  const { sky, flush, frames, win, context, curtain, wordmark } = createSky(t);
  let rect = { ...WORDMARK_RECT };
  wordmark.getBoundingClientRect = () => rect;
  sky.start();
  flush();
  let done = 0;
  sky.collapse({ onDone() { done += 1; } });
  flush();
  flush();
  assert.equal(done, 0, 'the collapse is still in progress');
  const pending = Array.from(frames.values());
  assert.equal(pending.length, 1);
  const clearsBefore = context.calls.clearRect;
  let clearedViewport;
  const clearRect = context.clearRect;
  context.clearRect = (...args) => { clearedViewport = args; clearRect(); };
  rect = { left: 300, top: 220, width: 200, height: 40 };
  Object.defineProperty(win, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(win, 'innerHeight', { configurable: true, value: 480 });
  win.dispatchEvent(new win.Event('resize'));
  assert.equal(done, 1, 'resize lands the collapse and calls onDone once');
  assert.equal(frames.size, 0, 'resize cancels the pending collapse frame');
  assert.equal(context.calls.clearRect, clearsBefore + 1, 'resize draws one final frame');
  assert.deepEqual(clearedViewport, [0, 0, 800, 480], 'the final frame uses the new viewport');
  assert.equal(wordmark.style.opacity, '0', 'the wordmark reaches the final collapse state');
  assert.equal(curtain.style.opacity, '0', 'the curtain reaches the final collapse state');
  pending.forEach((callback) => callback(100));
  assert.equal(context.calls.clearRect, clearsBefore + 1, 'a captured callback draws nothing after landing');
  assert.equal(frames.size, 0);
  win.dispatchEvent(new win.Event('resize'));
  assert.equal(done, 1, 'a second resize does not call onDone again');
  sky.dispose();
  const clearsAfterDispose = context.calls.clearRect;
  win.dispatchEvent(new win.Event('resize'));
  assert.equal(context.calls.clearRect, clearsAfterDispose, 'resize after disposal draws nothing');
  assert.equal(done, 1);
});

test('resize without a collapse keeps the swirl scheduling frames', (t) => {
  const { sky, flush, frames, win, context } = createSky(t);
  sky.start();
  flush();
  const clearsBefore = context.calls.clearRect;
  win.dispatchEvent(new win.Event('resize'));
  assert.equal(context.calls.clearRect, clearsBefore, 'a running swirl waits for its next frame');
  assert.equal(frames.size, 1, 'resize preserves the pending swirl frame');
  flush();
  assert.equal(context.calls.clearRect, clearsBefore + 1);
  assert.equal(frames.size, 1, 'the swirl keeps scheduling after resize');
});

test('dispose cancels the live frame and schedules nothing afterwards', (t) => {
  const { sky, flush, frames } = createSky(t);
  sky.start();
  assert.equal(frames.size, 1);
  flush();
  assert.equal(frames.size, 1, 'the loop reschedules while the curtain is up');
  sky.dispose();
  assert.equal(frames.size, 0, 'dispose cancels the pending frame');
  flush();
  assert.equal(frames.size, 0);
});

test('a hidden window pauses the loop and a visible one resumes it', (t) => {
  const { sky, frames, dom } = createSky(t);
  sky.start();
  assert.equal(frames.size, 1);
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(sky.isPaused(), true);
  assert.equal(frames.size, 0, 'no frame is scheduled while hidden');
  Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  assert.equal(sky.isPaused(), false);
  assert.equal(frames.size, 1);
});

// A-3: the fatal dialog holds the sky; a window coming back into view must not
// restart it behind the dialog, and a hidden window stays paused on resume().
test('a caller pause holds across visibility changes until the caller resumes', (t) => {
  const { sky, frames, dom } = createSky(t);
  const setVisibility = (value) => {
    Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => value });
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  };
  sky.start();
  sky.pause();
  assert.equal(frames.size, 0);
  setVisibility('hidden');
  setVisibility('visible');
  assert.equal(sky.isPaused(), true, 'visibility does not lift a caller pause');
  assert.equal(frames.size, 0);
  setVisibility('hidden');
  sky.resume();
  assert.equal(frames.size, 0, 'a hidden window stays paused after the caller resumes');
  setVisibility('visible');
  assert.equal(sky.isPaused(), false);
  assert.equal(frames.size, 1);
});

// A-2: a sky retired mid-swirl (kill switch landing after mount) leaves the
// plain curtain: no frozen stars, the wordmark back at full strength.
test('dispose clears the canvas and hands the wordmark back to its stylesheet', (t) => {
  const { sky, flush, context, wordmark } = createSky(t);
  sky.start();
  flush(16);
  assert.notEqual(wordmark.style.opacity, '', 'the swirl drives the wordmark fade-in');
  const clearsBefore = context.calls.clearRect;
  sky.dispose();
  assert.equal(context.calls.clearRect, clearsBefore + 1, 'the last frame is wiped');
  assert.equal(wordmark.style.opacity, '');
  assert.equal(wordmark.style.textShadow, '');
});

test('reduced motion paints the stars once and never starts a loop', (t) => {
  const { sky, frames, context } = createSky(t, { reducedMotion: true });
  sky.start();
  assert.equal(frames.size, 0);
  assert.equal(context.calls.arc, 220, 'every star is painted once, still');
  assert.equal(sky.isAnimated(), false);
  let done = 0;
  assert.equal(sky.collapse({ onDone() { done += 1; } }), false);
  assert.equal(done, 1, 'a still sky hands straight back to the plain dismissal');
});

test('a frame makes no Array.prototype.push calls and exactly three fill-style writes', (t) => {
  const { sky, flush, context } = createSky(t);
  sky.start();
  flush();
  sky.drawFrameForTest(800); // past the fade-in, so the wordmark is settled
  const originalPush = Array.prototype.push;
  let pushes = 0;
  Array.prototype.push = function countingPush(...items) { pushes += 1; return originalPush.apply(this, items); };
  const fillWritesBefore = context.calls.fillStyleWrites;
  try {
    sky.drawFrameForTest(900);
  } finally {
    Array.prototype.push = originalPush;
  }
  assert.equal(pushes, 0, 'no Array.prototype.push during a draw');
  assert.equal(context.calls.fillStyleWrites - fillWritesBefore, 3, 'one fillStyle per colour group');
});

test('measured (log only): one draw at 220 stars under the 2D stub (real-canvas number is an owner-run gate)', (t) => {
  const { sky, flush } = createSky(t);
  sky.start();
  flush();
  const samples = [];
  for (let i = 0; i < 200; i += 1) {
    const started = performance.now();
    sky.drawFrameForTest(400 + i * 16);
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  // Logged for the test record only (spec budget 0.5 ms under the stub): a
  // wall-clock assertion flakes on a loaded runner; the push/fill-style test above
  // is the deterministic gate.
  console.log(`startup starfield stub draw @220 stars: median ${median.toFixed(4)} ms, p95 ${samples[Math.floor(samples.length * 0.95)].toFixed(4)} ms`);
  assert.ok(Number.isFinite(median));
});
