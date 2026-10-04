'use strict';

/* Status loader (area 5, 2026-09-29): the curtain is gated on the shell
 * alone, owns its copy, keeps Continue anyway stable, accepts caller fatal
 * actions, and mounts the starfield (hold, collapse, off, reduced motion). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button.js');
const lifecycleUtils = require('../renderer/shell/renderer-lifecycle-progress-utils.js');

function lifecycleState(activeView = 'chat') {
  return {
    ui: { activeView },
    backend: { phase: 'starting', detail: '' },
    lifecycleProgress: lifecycleUtils.defaultLifecycleProgress(),
  };
}

function createCurtainDom(extraBody = '', options = {}) {
  return new JSDOM('<!doctype html><html><body>'
    + '<div id="startupOverlay" role="status" aria-live="polite" aria-labelledby="startupOverlaySublabel" aria-describedby="startupOverlaySecondary">'
    + (options.sky ? '<canvas class="startup-overlay-sky" id="startupOverlaySky" aria-hidden="true"></canvas>' : '')
    + '<div class="startup-overlay-content">'
    + '<div class="startup-overlay-wordmark">Jenny</div>'
    + '<div id="startupOverlaySublabel"></div>'
    + '<div id="startupOverlaySecondary"></div>'
    + '<div class="startup-overlay-actions" id="startupOverlayActions"></div></div></div>'
    + extraBody
    + '</body></html>', { pretendToBeVisual: true, url: options.url, runScripts: options.runScripts });
}

function createController(documentRef, callbacks = {}, extra = {}) {
  return lifecycleUtils.createLifecycleProgressController({
    state: extra.state || lifecycleState(),
    now: extra.now,
    fatalActions: extra.fatalActions,
    dom: {
      startupOverlay: documentRef.getElementById('startupOverlay'),
      startupOverlaySublabel: documentRef.getElementById('startupOverlaySublabel'),
      startupOverlaySecondary: documentRef.getElementById('startupOverlaySecondary'),
    },
    callbacks: {
      onStartupReady() {},
      ...callbacks,
    },
  });
}

/* Fake timers for one test: captures every setTimeout with its delay. */
function useCapturedTimers(t) {
  const previous = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  const scheduled = [];
  const cleared = new Set();
  global.setTimeout = (callback, delay) => { scheduled.push({ callback, delay, id: scheduled.length + 1 }); return scheduled.length; };
  global.clearTimeout = (id) => { cleared.add(id); };
  t.after(() => { global.setTimeout = previous.setTimeout; global.clearTimeout = previous.clearTimeout; });
  return {
    scheduled,
    cleared,
    live(delay) { return scheduled.filter((entry) => entry.delay === delay && !cleared.has(entry.id)); },
  };
}

/* A jsdom curtain whose sky canvas has a stub 2D context and manual frames. */
function createSkyCurtain(t, options = {}) {
  const dom = createCurtainDom(options.extraBody || '', { sky: true, url: options.url, runScripts: options.runScripts });
  t.after(() => dom.window.close());
  const win = dom.window;
  Object.defineProperty(win, 'innerWidth', { configurable: true, value: 1280 });
  Object.defineProperty(win, 'innerHeight', { configurable: true, value: 720 });
  const frames = new Map();
  let nextFrame = 1;
  win.requestAnimationFrame = (callback) => { const id = nextFrame++; frames.set(id, callback); return id; };
  win.cancelAnimationFrame = (id) => { frames.delete(id); };
  const contextCalls = { getContext: 0, arc: 0 };
  win.HTMLCanvasElement.prototype.getContext = function getContext() {
    contextCalls.getContext += 1;
    return {
      setTransform() {}, clearRect() {}, beginPath() {}, fill() {},
      arc() { contextCalls.arc += 1; },
      fillStyle: '', globalAlpha: 1,
    };
  };
  const previousStarfield = global.rendererStartupStarfield;
  global.rendererStartupStarfield = require('../renderer/shell/renderer-startup-starfield.js');
  t.after(() => { global.rendererStartupStarfield = previousStarfield; });
  let clock = 0;
  return {
    dom,
    frames,
    contextCalls,
    flush(stepMs = 16) {
      clock += stepMs;
      const pending = Array.from(frames.values());
      frames.clear();
      pending.forEach((callback) => callback(clock));
    },
  };
}

test('curtain dismisses on notifyBootViewReady with the backend still model_loading', (t) => {
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const controller = createController(dom.window.document);
  t.after(() => controller.dispose());
  controller.handleBackendStatus({
    phase: 'model_loading',
    model_acquisition: { requested_model: 'qwen3:8b', stage: 'loading' },
  });
  assert.equal(dom.window.document.getElementById('startupOverlay').classList.contains('hidden'), false);
  controller.notifyBootViewReady('chat');
  controller.notifyShellHydrated();
  assert.equal(dom.window.document.getElementById('startupOverlay').classList.contains('hidden'), true,
    'the model load no longer holds the curtain');
});

test('model_unavailable no longer blocks the curtain; the shell owns the model story', (t) => {
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const controller = createController(dom.window.document);
  t.after(() => controller.dispose());
  controller.handleBackendStatus({ phase: 'model_unavailable' });
  const overlay = dom.window.document.getElementById('startupOverlay');
  assert.notEqual(overlay.dataset.state, 'blocked');
  controller.notifyBootViewReady('chat');
  controller.notifyShellHydrated();
  assert.equal(overlay.classList.contains('hidden'), true);
});

test('with the animation on, dismissal waits for 900 ms after mount, then the stars collapse', (t) => {
  const timers = useCapturedTimers(t);
  const sky = createSkyCurtain(t);
  let now = 0;
  const removed = [];
  const controller = createController(sky.dom.window.document, {
    onStartupRemoved() { removed.push(true); },
  }, { now: () => now });
  t.after(() => controller.dispose());
  const overlay = sky.dom.window.document.getElementById('startupOverlay');
  assert.equal(sky.frames.size, 1, 'the sky starts turning at mount');

  now = 100;
  controller.notifyBootViewReady('chat');
  controller.notifyShellHydrated();
  assert.equal(overlay.classList.contains('hidden'), false, 'a warm start still gets a short sky');
  const hold = timers.live(800);
  assert.equal(hold.length, 1, 'the hold timer covers the rest of the 900 ms');
  now = 900;
  hold[0].callback();
  assert.equal(overlay.classList.contains('hidden'), true);
  assert.equal(overlay.style.opacity, '1', 'the stars drive the fade, not the class');
  for (let i = 0; i < 80 && sky.frames.size > 0; i += 1) { sky.flush(16); }
  assert.equal(overlay.style.opacity, '0');
  assert.equal(overlay.parentNode, null, 'the curtain leaves the DOM when the stars land');
  assert.equal(removed.length, 1);
});

test('with the animation off, the curtain paints no stars and dismisses at once', (t) => {
  useCapturedTimers(t);
  const sky = createSkyCurtain(t);
  sky.dom.window.document.documentElement.dataset.startupAnimation = 'off';
  const controller = createController(sky.dom.window.document, {}, { now: () => 100 });
  t.after(() => controller.dispose());
  assert.equal(sky.contextCalls.getContext, 0, 'off paints no stars at all');
  controller.notifyBootViewReady('chat');
  controller.notifyShellHydrated();
  assert.equal(sky.dom.window.document.getElementById('startupOverlay').classList.contains('hidden'), true);
});

// A-2: production fetches feature flags after the curtain is built. The kill
// switch reaches the page pre-paint through the query (theme-bootstrap), and a
// flag that still lands after mount retires the sky on the next line tick.
test('the startup_animation kill switch stamped before first paint mounts no sky', (t) => {
  useCapturedTimers(t);
  const sky = createSkyCurtain(t, { url: 'file:///app/index.html?jennyStartupAnimation=off', runScripts: 'outside-only' });
  const win = sky.dom.window;
  win.eval(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'shared', 'theme-bootstrap.js'), 'utf8'));
  const controller = createController(win.document, {}, { now: () => 100 });
  t.after(() => controller.dispose());
  assert.equal(sky.contextCalls.getContext, 0, 'the kill switch paints no stars at all');
  controller.notifyBootViewReady('chat');
  controller.notifyShellHydrated();
  assert.equal(win.document.getElementById('startupOverlay').classList.contains('hidden'), true);
});

test('a startup_animation:false flag landing after mount retires the swirl', (t) => {
  const timers = useCapturedTimers(t);
  const sky = createSkyCurtain(t);
  const state = lifecycleState();
  const controller = createController(sky.dom.window.document, {}, { now: () => 100, state });
  t.after(() => controller.dispose());
  assert.equal(sky.frames.size, 1, 'flags are not known at mount: the sky turns');
  state.features = { featureFlags: { startup_animation: false } };
  timers.live(250).forEach((entry) => entry.callback());
  assert.equal(sky.frames.size, 0, 'the next line tick stops the swirl');
  controller.notifyBootViewReady('chat');
  controller.notifyShellHydrated();
  assert.equal(sky.dom.window.document.getElementById('startupOverlay').classList.contains('hidden'), true, 'no hold once the sky is gone');
});

// A-3: nothing animates behind the fatal dialog; recovery brings the sky back.
test('the fatal dialog pauses the sky and recovery resumes it', (t) => {
  useCapturedTimers(t);
  const sky = createSkyCurtain(t);
  const controller = createController(sky.dom.window.document, {}, { now: () => 100 });
  t.after(() => controller.dispose());
  assert.equal(sky.frames.size, 1);
  controller.handleBackendStatus({ phase: 'failed', detail: 'CMP-SIDECAR-0007 spawn failed' });
  assert.equal(sky.frames.size, 0, 'no frame behind the dialog');
  sky.flush(16);
  assert.equal(sky.frames.size, 0);
  controller.handleBackendStatus({ phase: 'sidecar_spawned' });
  assert.equal(sky.frames.size, 1, 'the sky turns again once the engine recovers');
});

test('reduced motion paints the stars once, still, and dismisses at once', (t) => {
  useCapturedTimers(t);
  const previousMatchMedia = global.matchMedia;
  global.matchMedia = (query) => ({ matches: String(query).includes('prefers-reduced-motion') });
  t.after(() => { global.matchMedia = previousMatchMedia; });
  const sky = createSkyCurtain(t);
  const controller = createController(sky.dom.window.document, {}, { now: () => 100 });
  t.after(() => controller.dispose());
  assert.ok(sky.contextCalls.arc > 0, 'stars are painted');
  assert.equal(sky.frames.size, 0, 'no animation loop under reduced motion');
  controller.notifyBootViewReady('chat');
  controller.notifyShellHydrated();
  assert.equal(sky.dom.window.document.getElementById('startupOverlay').classList.contains('hidden'), true);
});

test('Continue anyway keeps its node identity across ten progress updates', (t) => {
  const timers = useCapturedTimers(t);
  const previous = { slowMs: global.__JENNY_STARTUP_OVERLAY_SLOW_MS, actionButton: global.inventoryActionButton };
  global.__JENNY_STARTUP_OVERLAY_SLOW_MS = 8;
  global.inventoryActionButton = actionButton;
  t.after(() => {
    global.__JENNY_STARTUP_OVERLAY_SLOW_MS = previous.slowMs;
    global.inventoryActionButton = previous.actionButton;
  });
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const controller = createController(dom.window.document);
  t.after(() => controller.dispose());
  timers.live(8)[0].callback();
  const first = dom.window.document.querySelector('[data-action="startup-continue"]');
  assert.equal(first?.textContent, 'Continue anyway');
  assert.equal(dom.window.document.getElementById('startupOverlaySecondary').textContent, 'Taking longer than usual');
  for (let i = 0; i < 10; i += 1) {
    controller.handleBackendStatus({
      phase: 'model_acquiring',
      model_acquisition: { requested_model: 'qwen3:8b', stage: 'acquiring', completed_bytes: i * 100, total_bytes: 1000 },
    });
    controller.handleLifecycleProgress({ scenario: 'startup', phase: 'sidecar_initialize', detail: 'tick ' + i });
  }
  const after = dom.window.document.querySelector('[data-action="startup-continue"]');
  assert.equal(after, first, 'the button node survives every progress tick');
  assert.equal(dom.window.document.querySelectorAll('[data-action="startup-continue"]').length, 1);
});

test('the fatal action row accepts an extra action from the caller', (t) => {
  const previousActionButton = global.inventoryActionButton;
  global.inventoryActionButton = actionButton;
  t.after(() => { global.inventoryActionButton = previousActionButton; });
  const dom = createCurtainDom('<main id="appShell"><section></section></main>');
  t.after(() => dom.window.close());
  const clicks = [];
  const controller = createController(dom.window.document, {}, {
    fatalActions: [{ id: 'startup-extra', label: 'Extra action', onClick() { clicks.push('extra'); } }],
  });
  t.after(() => controller.dispose());
  controller.handleBackendStatus({ phase: 'failed', detail: 'spawn failed (CMP-SIDECAR-0007)' });
  const ids = Array.from(dom.window.document.querySelectorAll('#startupOverlayActions [data-action]'))
    .map((node) => node.getAttribute('data-action'));
  assert.deepEqual(ids, ['startup-retry', 'startup-view-logs', 'startup-extra']);
  dom.window.document.querySelector('[data-action="startup-extra"]').click();
  assert.deepEqual(clicks, ['extra']);
  assert.equal(dom.window.document.getElementById('startupOverlaySublabel').textContent, 'Jenny could not start');
  assert.equal(dom.window.document.getElementById('startupOverlaySecondary').textContent, 'Error code CMP-SIDECAR-0007');
});

test('the backstop fires only when the shell never reports ready', (t) => {
  const timers = useCapturedTimers(t);
  const previous = { maxMs: global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS };
  global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = 20;
  t.after(() => { global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previous.maxMs; });

  const readyDom = createCurtainDom();
  t.after(() => readyDom.window.close());
  const readyLogs = [];
  const ready = createController(readyDom.window.document, {
    appendClientLog(level, event) { readyLogs.push(event); },
  });
  t.after(() => ready.dispose());
  ready.notifyBootViewReady('chat');
  ready.notifyShellHydrated();
  assert.equal(timers.live(20).length, 0, 'a shell that reported ready leaves no backstop behind');
  assert.deepEqual(readyLogs.filter((event) => event === 'startup.curtain_backstop_dismissed'), []);

  const stuckDom = createCurtainDom();
  t.after(() => stuckDom.window.close());
  const stuckLogs = [];
  const stuck = createController(stuckDom.window.document, {
    appendClientLog(level, event) { stuckLogs.push(event); },
  });
  t.after(() => stuck.dispose());
  stuck.handleBackendStatus({ phase: 'model_loading' });
  timers.live(20).forEach((entry) => entry.callback());
  assert.equal(stuckDom.window.document.getElementById('startupOverlay').classList.contains('hidden'), true);
  assert.ok(stuckLogs.includes('startup.curtain_backstop_dismissed'));
});

test('a backstop that elapsed behind a fatal dialog dismisses on terminal recovery', (t) => {
  const timers = useCapturedTimers(t);
  const previous = { maxMs: global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS };
  global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = 20;
  t.after(() => { global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previous.maxMs; });
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const controller = createController(dom.window.document);
  t.after(() => controller.dispose());
  const overlay = dom.window.document.getElementById('startupOverlay');

  controller.handleLifecycleProgress({ scenario: 'startup', phase: 'sidecar_spawn', error: 'spawn failed' });
  timers.live(20).forEach((entry) => entry.callback());
  assert.equal(overlay.classList.contains('hidden'), false, 'the backstop never drops a fatal dialog');

  controller.handleLifecycleProgress({ scenario: 'startup', phase: 'ready' });
  assert.equal(overlay.getAttribute('role'), 'status');
  assert.equal(overlay.classList.contains('hidden'), true, 'recovery honours the elapsed backstop');
});

test('a backstop that elapsed behind a fatal dialog dismisses on a model-switch recovery', (t) => {
  const timers = useCapturedTimers(t);
  const previous = { maxMs: global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS };
  global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = 20;
  t.after(() => { global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previous.maxMs; });
  const dom = createCurtainDom();
  t.after(() => dom.window.close());
  const controller = createController(dom.window.document);
  t.after(() => controller.dispose());
  const overlay = dom.window.document.getElementById('startupOverlay');

  // Shell hydration stays pending throughout; the backend was ready once, so a
  // later load is narrated as a model switch, not startup.
  controller.handleBackendStatus({ phase: 'ready' });
  controller.handleBackendStatus({ phase: 'failed', detail: 'engine crashed' });
  timers.live(20).forEach((entry) => entry.callback());
  assert.equal(overlay.classList.contains('hidden'), false, 'the backstop never drops a fatal dialog');

  controller.handleBackendStatus({ phase: 'model_loading' });
  assert.equal(overlay.getAttribute('role'), 'status');
  assert.equal(overlay.classList.contains('hidden'), true, 'a model-switch recovery honours the elapsed backstop');
});
