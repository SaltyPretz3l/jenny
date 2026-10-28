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

function createControlledHandoff(t, animated = false, { fullSkySeen } = {}) {
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
  let collapseDone;
  let collapseOptions = null;
  let readyCalls = 0;
  let removedCalls = 0;
  const sky = {
    start() {}, pause() {}, resume() {}, dispose() {},
    isAnimated() { return true; },
    collapse(options) { collapseOptions = options; collapseDone = options.onDone; },
  };
  global.setTimeout = (callback, delay) => {
    const id = scheduled.length + 1;
    scheduled.push({ callback, delay, id });
    return id;
  };
  global.clearTimeout = (id) => cleared.add(id);
  global.rendererStartupStarfield = animated ? { createStartupStarfield() { return sky; } } : null;
  global.__jennyStartupAudit = { mark(name) { marks.push(name); } };
  const overlay = dom.window.document.getElementById('startupOverlay');
  overlay.classList.add('startup-overlay');
  const controller = createController(dom.window.document, {
    onStartupReady() { readyCalls += 1; },
    onStartupRemoved() { removedCalls += 1; },
  }, { now: () => 0 });
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
    finishCollapse() { collapseDone(); },
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
    if (animated) { h.finishCollapse(); } else { h.overlay.dispatchEvent(new h.dom.window.Event('transitionend')); }
    assert.equal(h.overlay.parentNode, null);
    assert.equal(h.background.inert, false);
    assert.deepEqual(h.marks, ['shell-interactive']);
    assert.equal(h.removedCalls, 1);
    if (animated) { h.finishCollapse(); } else { h.overlay.dispatchEvent(new h.dom.window.Event('transitionend')); }
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

test('a hidden window completes the real sky collapse synchronously and releases isolation', (t) => {
  const dom = createCurtainDom('<main id="appShell"></main>', { sky: true });
  const previousStarfield = global.rendererStartupStarfield;
  global.rendererStartupStarfield = require('../renderer/shell/renderer-startup-starfield.js');
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({
    setTransform() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {},
  });
  Object.defineProperty(dom.window.document, 'visibilityState', { value: 'hidden', configurable: true });
  let now = 0;
  let removedCalls = 0;
  const controller = createController(dom.window.document, {
    onStartupRemoved() { removedCalls += 1; },
  }, { now: () => now });
  t.after(() => {
    controller.dispose();
    global.rendererStartupStarfield = previousStarfield;
    dom.window.close();
  });
  const overlay = dom.window.document.getElementById('startupOverlay');
  assert.equal(overlay.__jennyStartupSky.isPaused(), true);
  now = 900;
  controller.notifyBootViewReady();
  controller.notifyShellHydrated();
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

test('the first launch on a profile plays the full sky and records it; a returning launch skips the hold, collapses fast and hands input over at once', (t) => {
  const first = createControlledHandoff(t, true, { fullSkySeen: false });
  first.controller.notifyBootViewReady();
  first.controller.notifyShellHydrated();
  assert.equal(first.overlay.classList.contains('hidden'), false, 'the first launch holds for the minimum sky');
  first.scheduled.find((entry) => entry.delay === 900).callback();
  assert.equal(first.collapseOptions.durationMs, 750, 'the full collapse');
  assert.equal(first.background.inert, true, 'the full sky keeps the shell isolated until removal');
  assert.equal(first.dom.window.localStorage.getItem('jenny.startup.fullSkySeen'), '1');

  const returning = createControlledHandoff(t, true, { fullSkySeen: true });
  returning.controller.notifyBootViewReady();
  returning.controller.notifyShellHydrated();
  // Red before 2026-10-19: every launch waited out the 900 ms hold and a 750 ms collapse.
  assert.equal(returning.overlay.classList.contains('hidden'), true, 'no hold on a returning launch');
  assert.equal(returning.scheduled.some((entry) => entry.delay === 900), false);
  assert.equal(returning.collapseOptions.durationMs, 250, 'the quick collapse');
  assert.equal(returning.background.inert, false, 'input reaches the shell during the collapse');
  assert.equal(returning.overlay.style.pointerEvents, 'none');
  returning.finishCollapse();
  assert.equal(returning.overlay.parentNode, null);
  assert.deepEqual(returning.marks, ['shell-interactive']);
});
