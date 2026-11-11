'use strict';

// The curtain handoff contract: background isolation, pointer interception and
// the shell-interactive mark last until the curtain is removed; normal dismissal
// needs both readiness inputs (STARTUP_ANIMATION_REVIEW STA-001..003).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button.js');
const lifecycleUtils = require('../renderer/shell/renderer-lifecycle-progress-utils.js');
const starfieldUtils = require('../renderer/shell/renderer-startup-starfield.js');

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
    + '</body></html>', { pretendToBeVisual: true, ...(options.url ? { url: options.url } : {}) });
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

function createControlledHandoff(t, animated = false, { fullSkySeen, now = 0 } = {}) {
  const dom = createCurtainDom('<main id="appShell"></main>', {
    sky: animated,
    ...(fullSkySeen === undefined ? {} : { url: 'https://jenny.test/' }),
  });
  if (fullSkySeen) dom.window.localStorage.setItem('jenny.startup.fullSkySeen', '1');
  const previous = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    rendererStartupStarfield: global.rendererStartupStarfield,
    __jennyStartupAudit: global.__jennyStartupAudit,
  };
  const scheduled = [];
  const cleared = new Set();
  const marks = [];
  let collapseOptions = null;
  let readyCalls = 0;
  let removedCalls = 0;
  const sky = {
    startedAt: 0,
    pause() {}, resume() {}, dispose() {},
    isAnimated() { return true; },
    collapse(options) { collapseOptions = options; },
  };
  global.setTimeout = (callback, delay) => {
    const id = scheduled.length + 1;
    scheduled.push({ callback, delay, id });
    return id;
  };
  global.clearTimeout = (id) => cleared.add(id);
  global.rendererStartupStarfield = animated
    ? { createStartupStarfield() { return sky; }, resolveStartupExit: starfieldUtils.resolveStartupExit }
    : null;
  global.__jennyStartupAudit = { mark(name) { marks.push(name); } };
  const overlay = dom.window.document.getElementById('startupOverlay');
  overlay.classList.add('startup-overlay');
  const controller = createController(dom.window.document, {
    onStartupReady() { readyCalls += 1; },
    onStartupRemoved() { removedCalls += 1; },
  }, { now: () => now });
  t.after(() => {
    controller.dispose();
    Object.assign(global, previous);
    dom.window.close();
  });
  return {
    dom, overlay, controller, marks, scheduled, cleared,
    background: dom.window.document.getElementById('appShell'),
    get readyCalls() { return readyCalls; },
    get removedCalls() { return removedCalls; },
    get collapseOptions() { return collapseOptions; },
    finishFade() { overlay.dispatchEvent(new dom.window.Event('transitionend')); },
    dismiss() {
      controller.notifyBootViewReady();
      controller.notifyShellHydrated();
      if (animated) { scheduled.find((entry) => entry.delay === 900).callback(); }
    },
  };
}

for (const animated of [false, true]) {
  test(`${animated ? 'collapse' : 'plain fade'} keeps isolation and delays the audit mark until removal`, (t) => {
    const h = createControlledHandoff(t, animated);
    h.dismiss();
    assert.equal(h.overlay.classList.contains('hidden'), true);
    assert.equal(h.readyCalls, 1);
    assert.equal(h.background.inert, true, 'dismissal must retain isolation until removal');
    assert.deepEqual(h.marks, [], 'dismissal must not mark the shell interactive');
    h.finishFade();
    assert.equal(h.overlay.parentNode, null);
    assert.equal(h.background.inert, false);
    assert.deepEqual(h.marks, ['shell-interactive']);
    assert.equal(h.removedCalls, 1);
    h.finishFade();
    assert.deepEqual(h.marks, ['shell-interactive'], 'removal is idempotent');
    assert.equal(h.removedCalls, 1);
  });

  test(`${animated ? 'collapse' : 'plain fade'} fallback completes the isolated handoff`, (t) => {
    const h = createControlledHandoff(t, animated);
    h.dismiss();
    assert.equal(h.background.inert, true, 'fallback must own the isolation release');
    h.scheduled.find((entry) => entry.delay === (animated ? 1000 : lifecycleUtils.STARTUP_OVERLAY_REMOVAL_FALLBACK_MS)).callback();
    assert.equal(h.overlay.parentNode, null);
    assert.equal(h.background.inert, false);
    assert.deepEqual(h.marks, ['shell-interactive']);
  });
}

test('dispose mid-collapse removes the curtain without notifying removal', (t) => {
  const h = createControlledHandoff(t, true);
  h.dismiss();
  assert.ok(h.overlay.parentNode);
  h.controller.dispose();
  assert.equal(h.overlay.parentNode, null, 'dispose must finish an in-flight handoff');
  assert.equal(h.background.inert, false);
  assert.equal(h.removedCalls, 0);
  assert.equal(h.overlay.__jennyStartupSky, undefined);
});

test('a hidden window, where no fade can finish, still removes the curtain and releases isolation', (t) => {
  const dom = createCurtainDom('<main id="appShell"></main>', { sky: true });
  const previous = { starfield: global.rendererStartupStarfield, setTimeout: global.setTimeout };
  global.rendererStartupStarfield = starfieldUtils;
  const scheduled = [];
  global.setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; };
  dom.window.HTMLCanvasElement.prototype.transferControlToOffscreen = () => ({});
  const worker = { posts: [], postMessage(message) { this.posts.push(message); }, terminate() {} };
  dom.window.Worker = function FakeWorker() { return worker; };
  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  let now = 0;
  let removedCalls = 0;
  const controller = createController(dom.window.document, {
    onStartupRemoved() { removedCalls += 1; },
  }, { now: () => now });
  t.after(() => {
    controller.dispose();
    global.rendererStartupStarfield = previous.starfield;
    global.setTimeout = previous.setTimeout;
    dom.window.close();
  });
  const overlay = dom.window.document.getElementById('startupOverlay');
  overlay.__jennyStartupSky.pause();
  assert.equal(overlay.__jennyStartupSky.isPaused(), true);
  now = 900;
  controller.notifyBootViewReady();
  controller.notifyShellHydrated();
  assert.equal(overlay.classList.contains('hidden'), true);
  scheduled.find((entry) => entry.delay === 1000).callback();
  assert.equal(overlay.parentNode, null);
  assert.equal(dom.window.document.getElementById('appShell').inert, false);
  assert.equal(removedCalls, 1);
  assert.equal(overlay.__jennyStartupSky, undefined);
});

test('the hidden mounted curtain continues to intercept pointers', (t) => {
  const h = createControlledHandoff(t);
  const style = h.dom.window.document.createElement('style');
  style.textContent = fs.readFileSync(path.join(__dirname, '..', 'styles', 'startup-overlay.css'), 'utf8');
  h.dom.window.document.head.appendChild(style);
  h.dismiss();
  assert.notEqual(h.dom.window.getComputedStyle(h.overlay).pointerEvents, 'none', 'a mounted dismissing curtain must intercept pointers');
});

for (const first of ['notifyBootViewReady', 'notifyShellHydrated']) {
  test(`combined readiness is idempotent with ${first} first and keeps the backstop until both`, (t) => {
    const h = createControlledHandoff(t);
    const second = first === 'notifyBootViewReady' ? 'notifyShellHydrated' : 'notifyBootViewReady';
    const backstop = h.scheduled.find((entry) => entry.delay === 20000);
    h.controller[first]();
    h.controller[first]();
    assert.equal(h.overlay.classList.contains('hidden'), false, 'one readiness input cannot dismiss the curtain');
    assert.equal(h.cleared.has(backstop.id), false, 'one readiness input cannot cancel the backstop');
    h.controller[second]();
    h.controller[second]();
    assert.equal(h.overlay.classList.contains('hidden'), true);
    assert.equal(h.readyCalls, 1);
    assert.equal(h.cleared.has(backstop.id), true);
  });
}

test('readiness notifications after dispose cannot dismiss an undismissed curtain', (t) => {
  const h = createControlledHandoff(t);
  h.controller.dispose();
  h.controller.notifyBootViewReady();
  h.controller.notifyShellHydrated();
  assert.equal(h.overlay.classList.contains('hidden'), false);
  assert.equal(h.readyCalls, 0);
});

test('fatal recovery with only view readiness keeps pending hydration isolated', (t) => {
  const h = createControlledHandoff(t);
  h.controller.handleBackendStatus({ phase: 'failed' });
  h.controller.handleBackendStatus({ phase: 'sidecar_spawned' });
  h.controller.notifyBootViewReady();
  assert.equal(h.background.inert, true, 'recovered startup must retain isolation while hydration is pending');
  assert.equal(h.overlay.getAttribute('role'), 'status');
  assert.equal(h.overlay.classList.contains('hidden'), false);
});

test('dispose in fatal mode clears the dialog and explicitly restores reachability', (t) => {
  const h = createControlledHandoff(t);
  h.controller.handleBackendStatus({ phase: 'failed' });
  h.controller.dispose();
  assert.equal(h.overlay.getAttribute('role'), 'status');
  assert.equal(h.background.inert, false);
});

test('the first launch on a profile plays the full sky and records it', (t) => {
  const first = createControlledHandoff(t, true, { fullSkySeen: false });
  first.controller.notifyBootViewReady();
  first.controller.notifyShellHydrated();
  assert.equal(first.overlay.classList.contains('hidden'), false, 'the first launch holds for the minimum sky');
  first.scheduled.find((entry) => entry.delay === 900).callback();
  assert.equal(first.collapseOptions.durationMs, 750, 'the full collapse');
  assert.equal(first.background.inert, true, 'the full sky keeps the shell isolated until removal');
  assert.equal(first.dom.window.localStorage.getItem('jenny.startup.fullSkySeen'), '1');
  assert.equal(first.overlay.getAttribute('data-exit'), 'collapse');
  assert.equal(first.overlay.style.getPropertyValue('--startup-exit-delay-ms'), '375ms');
});

test('a fast returning launch dissolves quietly after the floor, with input released at shell ready', (t) => {
  const h = createControlledHandoff(t, true, { fullSkySeen: true });
  h.controller.notifyBootViewReady();
  h.controller.notifyShellHydrated();
  assert.equal(h.overlay.classList.contains('hidden'), false, 'the name never flashes');
  assert.equal(h.background.inert, false, 'the floor does not hold input back');
  assert.equal(h.overlay.style.pointerEvents, 'none');
  h.scheduled.find((entry) => entry.delay === 260).callback();
  assert.equal(h.overlay.classList.contains('hidden'), true);
  assert.equal(h.overlay.getAttribute('data-exit'), 'quiet');
  assert.equal(h.collapseOptions, null, 'no collapse without a sky to collapse');
  assert.equal(h.overlay.style.getPropertyValue('--startup-exit-fade-ms'), '220ms');
  h.finishFade();
  assert.equal(h.overlay.parentNode, null);
  assert.deepEqual(h.marks, ['shell-interactive']);
});

test('a longer returning launch collapses for as long as the sky has earned', (t) => {
  const h = createControlledHandoff(t, true, { fullSkySeen: true, now: 5000 });
  h.controller.notifyBootViewReady();
  h.controller.notifyShellHydrated();
  assert.equal(h.overlay.classList.contains('hidden'), true, 'past the floor nothing waits');
  assert.equal(h.scheduled.some((entry) => entry.delay === 900), false);
  assert.equal(h.collapseOptions.durationMs, 720);
  assert.equal(h.overlay.getAttribute('data-exit'), 'collapse');
  assert.equal(h.overlay.style.getPropertyValue('--startup-name-delay-ms'), '518ms');
  assert.equal(h.background.inert, false, 'input reaches the shell during the collapse');
  h.finishFade();
  assert.equal(h.overlay.parentNode, null);
  assert.equal(h.removedCalls, 1);
});

test('the curtain clock starts when the sky started, not when the controller mounted', (t) => {
  const dom = createCurtainDom('<main id="appShell"></main>', { sky: true, url: 'https://jenny.test/' });
  dom.window.localStorage.setItem('jenny.startup.fullSkySeen', '1');
  const previous = global.rendererStartupStarfield;
  let collapse = null;
  const sky = { startedAt: 1000, pause() {}, resume() {}, dispose() {}, isAnimated: () => true, collapse(options) { collapse = options; } };
  global.rendererStartupStarfield = { getEarlySky: () => sky, resolveStartupExit: starfieldUtils.resolveStartupExit };
  const controller = createController(dom.window.document, {}, { now: () => 2200 });
  t.after(() => {
    controller.dispose();
    global.rendererStartupStarfield = previous;
    dom.window.close();
  });
  controller.notifyBootViewReady();
  controller.notifyShellHydrated();
  assert.ok(collapse && collapse.durationMs > 600, 'the sky that ran during script loads counts');
});

test('a failure during the returning-launch floor gives the dialog its clicks back', (t) => {
  const h = createControlledHandoff(t, true, { fullSkySeen: true });
  h.controller.notifyBootViewReady();
  h.controller.notifyShellHydrated();
  assert.equal(h.overlay.style.pointerEvents, 'none', 'input was handed over at shell ready');
  h.controller.handleBackendStatus({ phase: 'failed', detail: 'CMP-SIDECAR-0007 spawn failed' });
  assert.equal(h.overlay.getAttribute('role'), 'alertdialog');
  assert.equal(h.overlay.style.pointerEvents, '', 'pointer-events is inherited, so Retry would be mouse-dead');
});

test('a composition failure before the controller mounts still stops the early sky', (t) => {
  const dom = createCurtainDom('', { sky: true });
  const previous = global.rendererStartupStarfield;
  let pauses = 0;
  global.rendererStartupStarfield = { getEarlySky: () => ({ pause() { pauses += 1; } }) };
  t.after(() => {
    global.rendererStartupStarfield = previous;
    dom.window.close();
  });
  lifecycleUtils.presentStartupOverlayFatalError(dom.window.document.getElementById('startupOverlay'), {});
  assert.equal(pauses, 1);
});

test('a first launch that showed no sky does not use up the full sky', (t) => {
  const h = createControlledHandoff(t, false, { fullSkySeen: false });
  h.controller.notifyBootViewReady();
  h.controller.notifyShellHydrated();
  h.finishFade();
  assert.equal(h.dom.window.localStorage.getItem('jenny.startup.fullSkySeen'), null);
});
