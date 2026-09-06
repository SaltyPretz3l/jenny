// spec-first: red-first test suite for
// renderer/shell/renderer-surface-gallery-utils.js (Background Effects v3,
// packet S5 slice W1c -- the DEV-ONLY, nav-unlinked surface-effect review
// gallery). Style-matches tests/renderer-app-surface-input.test.js: real
// jsdom DOM + a controllable rAF harness (borrowed from
// tests/helpers/surface-effect-router-harness.js, shared with the S2/S3
// suites) so pointer-sweep/click sequencing is deterministic, no real
// timers. Each test builds its own JSDOM window -- no shared state.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const galleryUtils = require('../renderer/shell/renderer-surface-gallery-utils.js');
const { createRafHarness, makeFakeController } = require('./helpers/surface-effect-router-harness.js');

// ── Harness ──────────────────────────────────────────────────────────────

function setupEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const raf = createRafHarness();
  window.requestAnimationFrame = raf.requestAnimationFrame;
  window.cancelAnimationFrame = raf.cancelAnimationFrame;
  window.performance.now = () => raf.now;
  return { dom, window, document: window.document, raf };
}

function makeGallery(env, registry, extraDeps) {
  return galleryUtils.installSurfaceEffectGallery(Object.assign({
    windowRef: env.window,
    documentRef: env.document,
    getEffectRegistry: () => registry,
  }, extraDeps || {}));
}

function makeSpyFactory(buildController) {
  const factory = function (options) {
    factory.calls.push(options);
    return buildController(options);
  };
  factory.calls = [];
  return factory;
}

function getGroupByLabel(doc, labelText) {
  const groups = Array.from(doc.querySelectorAll('.surface-gallery-group'));
  return groups.find((g) => g.querySelector('.surface-gallery-label').textContent === labelText) || null;
}

function fire(el, type) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event(type, { bubbles: true }));
}

function setStageRect(doc, rect) {
  doc.querySelector('.surface-gallery-stage').getBoundingClientRect = () => rect;
}

// ── install / dispose ───────────────────────────────────────────────────

test('installSurfaceEffectGallery registers window.__jennySurfaceGallery; dispose removes it', () => {
  const env = setupEnv();
  const gallery = makeGallery(env, []);

  assert.equal(typeof env.window.__jennySurfaceGallery.open, 'function');
  assert.equal(typeof env.window.__jennySurfaceGallery.close, 'function');
  assert.equal(env.window.__jennySurfaceGallery.isOpen(), false);

  gallery.dispose();
  assert.equal(env.window.__jennySurfaceGallery, undefined);
});

// ── open / close DOM lifecycle ──────────────────────────────────────────

test('open() builds the overlay and stage with data-surface-input-block; close() removes all gallery DOM', () => {
  const env = setupEnv();
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'Reactive Grid', contractVersion: 3 }]);
  env.window.rendererReactiveGridUtils = { createReactiveGridController: () => makeFakeController() };

  gallery.open();
  const overlay = env.document.querySelector('.surface-gallery');
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-label'), 'Surface effect gallery');
  const stage = env.document.querySelector('.surface-gallery-stage');
  assert.equal(stage.hasAttribute('data-surface-input-block'), true);

  gallery.close();
  assert.equal(env.document.querySelector('.surface-gallery'), null);
  assert.equal(env.document.body.children.length, 0);
});

test('open() is idempotent -- a second call builds no second overlay', () => {
  const env = setupEnv();
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'Reactive Grid', contractVersion: 3 }]);
  env.window.rendererReactiveGridUtils = { createReactiveGridController: () => makeFakeController() };

  gallery.open();
  gallery.open();
  assert.equal(env.document.querySelectorAll('.surface-gallery').length, 1);
});

test('close() before open() is a no-op', () => {
  const env = setupEnv();
  const gallery = makeGallery(env, []);
  gallery.close();
  assert.equal(env.document.querySelector('.surface-gallery'), null);
});

test('effect select excludes the "none" registry entry', () => {
  const env = setupEnv();
  const registry = [{ id: 'none', label: 'None' }, { id: 'reactive-grid', label: 'Reactive Grid', contractVersion: 3 }];
  const gallery = makeGallery(env, registry);
  env.window.rendererReactiveGridUtils = { createReactiveGridController: () => makeFakeController() };

  gallery.open();
  const values = Array.from(getGroupByLabel(env.document, 'Effect').querySelector('select').options).map((o) => o.value);
  assert.deepEqual(values, ['reactive-grid']);
});

// ── palette pin ──────────────────────────────────────────────────────────

test('palette pin sets dataset.palette and republishes tokens; close() restores the exact pre-open value', () => {
  const env = setupEnv();
  env.document.documentElement.dataset.palette = 'midnight';
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'Reactive Grid', contractVersion: 3 }]);
  let controller;
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: () => { controller = makeFakeController(); return controller; },
  };

  gallery.open();
  assert.equal(env.document.documentElement.dataset.palette, 'midnight');
  const paletteSelect = getGroupByLabel(env.document, 'Palette').querySelector('select');
  paletteSelect.value = 'obsidian';
  fire(paletteSelect, 'change');

  assert.equal(env.document.documentElement.dataset.palette, 'obsidian');
  assert.equal(controller.calls.refresh.length, 1);

  gallery.close();
  assert.equal(env.document.documentElement.dataset.palette, 'midnight');
});

test('palette pin restore deletes dataset.palette when no value existed before open', () => {
  const env = setupEnv();
  delete env.document.documentElement.dataset.palette;
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'Reactive Grid', contractVersion: 3 }]);
  env.window.rendererReactiveGridUtils = { createReactiveGridController: () => makeFakeController() };

  gallery.open();
  const paletteSelect = getGroupByLabel(env.document, 'Palette').querySelector('select');
  paletteSelect.value = 'signal';
  fire(paletteSelect, 'change');
  gallery.close();

  assert.equal('palette' in env.document.documentElement.dataset, false);
});

test('palette options fall back to the 12 hardcoded ids when appearanceUtils is unavailable', () => {
  const env = setupEnv();
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'Reactive Grid', contractVersion: 3 }]);
  env.window.rendererReactiveGridUtils = { createReactiveGridController: () => makeFakeController() };

  gallery.open();
  const values = Array.from(getGroupByLabel(env.document, 'Palette').querySelector('select').options).map((o) => o.value);
  assert.deepEqual(values, [
    'midnight', 'pewter', 'obsidian', 'darkroom', 'slate', 'paper', 'signal',
    'woolly', 'lexicon', 'rocko', 'jenny-day', 'jenny-night',
  ]);
});

// ── motion pin ───────────────────────────────────────────────────────────

test('motion pin sets dataset.motion; the reduced option flips the pinned mql without touching the axis', () => {
  const env = setupEnv();
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'Reactive Grid', contractVersion: 3 }]);
  let capturedMql;
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: (options) => { capturedMql = options.reducedMotionQuery; return makeFakeController(); },
  };

  gallery.open();
  const motionSelect = getGroupByLabel(env.document, 'Motion').querySelector('select');
  motionSelect.value = 'expressive';
  fire(motionSelect, 'change');
  assert.equal(env.document.documentElement.dataset.motion, 'expressive');
  assert.equal(capturedMql.matches, false);

  motionSelect.value = 'reduced';
  fire(motionSelect, 'change');
  assert.equal(capturedMql.matches, true);
  assert.equal(env.document.documentElement.dataset.motion, 'expressive');

  gallery.close();
  assert.equal('motion' in env.document.documentElement.dataset, false);
});

// ── native vs legacy routing ────────────────────────────────────────────

test('native routing: factory receives documentRef/runtime/rendererLaunchSeed/report and bind() gets a §3.1-shaped context', () => {
  const env = setupEnv();
  const runtimeSentinel = { marker: 'runtime' };
  const factory = makeSpyFactory(() => makeFakeController());
  env.window.rendererReactiveGridUtils = { createReactiveGridController: factory };
  env.window.rendererSurfaceEffectRuntime = runtimeSentinel;
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  assert.equal(factory.calls.length, 1);
  const callArgs = factory.calls[0];
  assert.equal(typeof callArgs.documentRef.createElement, 'function');
  assert.equal(callArgs.documentRef.defaultView.devicePixelRatio, 1);
  assert.equal(callArgs.runtime, runtimeSentinel);
  assert.equal(callArgs.rendererLaunchSeed, 1);
  assert.equal(callArgs.sceneRole, 'chat');
  assert.equal(callArgs.effectId, 'reactive-grid');
  assert.equal(typeof callArgs.report, 'function');
});

test('native routing: bind() receives hosts[0].element === stage and layout.hostRects.length === 1', () => {
  const env = setupEnv();
  let controller;
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: () => { controller = makeFakeController(); return controller; },
  };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  const stage = env.document.querySelector('.surface-gallery-stage');
  assert.equal(controller.calls.bind.length, 1);
  const context = controller.calls.bind[0][0];
  assert.equal(context.hosts.length, 1);
  assert.equal(context.hosts[0].element, stage);
  assert.equal(context.hosts[0].role, 'chat-left');
  assert.equal(context.layout.hostRects.length, 1);
  assert.equal(context.generation, 1);
  assert.equal(context.staged, false);
  assert.equal(context.surface, 'chat');
});

test('effect switch disposes the previous controller exactly once', () => {
  const env = setupEnv();
  const controllersA = [];
  const controllersB = [];
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: () => { const c = makeFakeController(); controllersA.push(c); return c; },
  };
  env.window.rendererPlaylistScrollUtils = {
    createPlaylistScrollController: () => { const c = makeFakeController(); controllersB.push(c); return c; },
  };
  const registry = [
    { id: 'reactive-grid', label: 'RG', contractVersion: 3 },
    { id: 'playlist-scroll', label: 'PS', contractVersion: 3 },
  ];
  const gallery = makeGallery(env, registry);

  gallery.open();
  assert.equal(controllersA.length, 1);
  assert.equal(controllersA[0].calls.dispose.length, 0);

  const effectSelect = getGroupByLabel(env.document, 'Effect').querySelector('select');
  effectSelect.value = 'playlist-scroll';
  fire(effectSelect, 'change');

  assert.equal(controllersA[0].calls.dispose.length, 1);
  assert.equal(controllersB.length, 1);
  assert.equal(controllersB[0].calls.dispose.length, 0);
});

// ── native-only availability gating ─────────────────────────────────────

test('phase/energy/impulse/pointer controls are enabled for a native effect', () => {
  const env = setupEnv();
  env.window.rendererReactiveGridUtils = { createReactiveGridController: () => makeFakeController() };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  const phaseSelect = getGroupByLabel(env.document, 'Phase + energy (native only)').querySelector('select');
  assert.equal(phaseSelect.disabled, false);
  const pointerButtons = getGroupByLabel(env.document, 'Pointer (native only)').querySelectorAll('.surface-gallery-btn');
  assert.equal(Array.from(pointerButtons).every((b) => !b.disabled), true);
});

// ── phase / energy / impulse ─────────────────────────────────────────────

test('phase select and energy range publish exact setActivity snapshots', () => {
  const env = setupEnv();
  let controller;
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: () => { controller = makeFakeController(); return controller; },
  };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  const phaseGroup = getGroupByLabel(env.document, 'Phase + energy (native only)');
  const phaseSelect = phaseGroup.querySelector('select');
  phaseSelect.value = 'streaming';
  fire(phaseSelect, 'change');
  assert.equal(controller.calls.setActivity.length, 1);
  assert.deepEqual(controller.calls.setActivity[0][0], {
    scopeEpoch: 1, phase: 'streaming', phaseRevision: 1, targetEnergy: 0.2, attentionScale: 1,
  });

  // Energy is an inventory number-input primitive (form controls are
  // inventory-owned repo-wide; no raw range input in shell modules).
  const energyRange = phaseGroup.querySelector('input[type=number]');
  energyRange.value = '0.65';
  fire(energyRange, 'input');
  assert.equal(controller.calls.setActivity.length, 2);
  assert.deepEqual(controller.calls.setActivity[1][0], {
    scopeEpoch: 1, phase: 'streaming', phaseRevision: 2, targetEnergy: 0.65, attentionScale: 1,
  });
});

test('impulse buttons call handleActivityImpulse with the right kind and an incrementing sequence', () => {
  const env = setupEnv();
  let controller;
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: () => { controller = makeFakeController(); return controller; },
  };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  const buttons = getGroupByLabel(env.document, 'Phase + energy (native only)').querySelectorAll('.surface-gallery-btn');
  buttons[0].click(); // First token
  buttons[2].click(); // Complete
  buttons[3].click(); // Cancel

  assert.equal(controller.calls.handleActivityImpulse.length, 3);
  const [first, second, third] = controller.calls.handleActivityImpulse.map((args) => args[0]);
  assert.equal(first.kind, 'first-token');
  assert.equal(first.sequence, 1);
  assert.equal(first.scopeEpoch, 1);
  assert.equal(second.kind, 'complete');
  assert.equal(second.sequence, 2);
  assert.equal(third.kind, 'cancel');
  assert.equal(third.sequence, 3);
});

// ── pointer pins ─────────────────────────────────────────────────────────

test("pointer 'click' emits press, release, click payloads in order with surfaceRole chat-left", () => {
  const env = setupEnv();
  let controller;
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: () => { controller = makeFakeController(); return controller; },
  };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  setStageRect(env.document, { left: 100, top: 50, width: 400, height: 300 });
  const buttons = getGroupByLabel(env.document, 'Pointer (native only)').querySelectorAll('.surface-gallery-btn');
  buttons[1].click(); // Click

  assert.equal(controller.calls.handleInput.length, 3);
  const [pressCall, releaseCall, clickCall] = controller.calls.handleInput.map((args) => args[0]);
  assert.equal(pressCall.type, 'press');
  assert.equal(releaseCall.type, 'release');
  assert.equal(clickCall.type, 'click');
  [pressCall, releaseCall, clickCall].forEach((payload) => {
    assert.equal(payload.surfaceRole, 'chat-left');
    assert.equal(payload.pointerId, 1);
    assert.equal(payload.generation, 1);
    assert.equal(payload.clientX, 300); // stage center: 100 + 400/2
  });
});

test('pointer sweep drives 24 rAF-scheduled move calls left to right then stops', () => {
  const env = setupEnv();
  let controller;
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: () => { controller = makeFakeController(); return controller; },
  };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  setStageRect(env.document, { left: 100, top: 50, width: 400, height: 300 });
  const buttons = getGroupByLabel(env.document, 'Pointer (native only)').querySelectorAll('.surface-gallery-btn');
  buttons[0].click(); // Sweep

  let iterations = 0;
  while (env.raf.size > 0 && iterations < 30) { env.raf.flush(); iterations += 1; }

  assert.equal(controller.calls.handleInput.length, 24);
  assert.equal(controller.calls.handleInput.every((args) => args[0].type === 'move'), true);
  const firstX = controller.calls.handleInput[0][0].clientX;
  const lastX = controller.calls.handleInput[23][0].clientX;
  assert.equal(lastX > firstX, true);
  assert.equal(lastX, 468); // 100 + 400 - max(400*0.08,2)
});

// ── viewport / DPR / seed / tier pins ───────────────────────────────────

test('viewport pin resizes the stage to the preset dimensions', () => {
  const env = setupEnv();
  env.window.rendererReactiveGridUtils = { createReactiveGridController: () => makeFakeController() };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3 }]);

  gallery.open();
  const stage = env.document.querySelector('.surface-gallery-stage');
  assert.equal(stage.style.width, '900px');
  assert.equal(stage.style.height, '640px');

  const viewportSelect = getGroupByLabel(env.document, 'Viewport').querySelector('select');
  viewportSelect.value = 'ultrawide';
  fire(viewportSelect, 'change');
  assert.equal(stage.style.width, '1600px');
  assert.equal(stage.style.height, '700px');
});

test('DPR pin re-instantiates the native controller with the pinned devicePixelRatio', () => {
  const env = setupEnv();
  const factory = makeSpyFactory(() => makeFakeController());
  env.window.rendererReactiveGridUtils = { createReactiveGridController: factory };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  assert.equal(factory.calls[0].documentRef.defaultView.devicePixelRatio, 1);

  const dprSelect = getGroupByLabel(env.document, 'DPR (native only)').querySelector('select');
  dprSelect.value = '2';
  fire(dprSelect, 'change');

  assert.equal(factory.calls.length, 2);
  assert.equal(factory.calls[1].documentRef.defaultView.devicePixelRatio, 2);
});

test('seed pin re-instantiates the native controller with the new rendererLaunchSeed', () => {
  const env = setupEnv();
  const factory = makeSpyFactory(() => makeFakeController());
  env.window.rendererReactiveGridUtils = { createReactiveGridController: factory };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  assert.equal(factory.calls.length, 1);
  assert.equal(factory.calls[0].rendererLaunchSeed, 1);

  const seedInput = getGroupByLabel(env.document, 'Seed (native only)').querySelector('input[type=number]');
  seedInput.value = '42';
  fire(seedInput, 'change');

  assert.equal(factory.calls.length, 2);
  assert.equal(factory.calls[1].rendererLaunchSeed, 42);
});

test('tier pin calls _internals.setQualityOverride with the numeric tier or null for auto', () => {
  const env = setupEnv();
  const overrideCalls = [];
  env.window.rendererReactiveGridUtils = {
    createReactiveGridController: () => {
      const controller = makeFakeController();
      controller._internals = { setQualityOverride: (value) => overrideCalls.push(value) };
      return controller;
    },
  };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  const tierSelect = getGroupByLabel(env.document, 'Quality tier (native only)').querySelector('select');
  tierSelect.value = '0.75';
  fire(tierSelect, 'change');
  tierSelect.value = 'auto';
  fire(tierSelect, 'change');

  assert.deepEqual(overrideCalls, [0.75, null]);
});

test('tier pin no-ops safely when the controller has no _internals.setQualityOverride', () => {
  const env = setupEnv();
  env.window.rendererReactiveGridUtils = { createReactiveGridController: () => makeFakeController() };
  const gallery = makeGallery(env, [{ id: 'reactive-grid', label: 'RG', contractVersion: 3, inputMode: 'manager' }]);

  gallery.open();
  const tierSelect = getGroupByLabel(env.document, 'Quality tier (native only)').querySelector('select');
  tierSelect.value = '0.55';
  fire(tierSelect, 'change');
  assert.equal(tierSelect.value, '0.55');
});

// ── loader-gated install ────────────────────────────────────────────────

test('install is idempotent when the lazy loader runs more than once', () => {
  const env = setupEnv();
  const cleanups = [];
  const first = makeGallery(env, [], { registerCleanup: (fn) => cleanups.push(fn) });
  const second = makeGallery(env, [], { registerCleanup: (fn) => cleanups.push(fn) });

  assert.equal(second, first);
  assert.equal(env.window.__jennySurfaceGallery, first);
  assert.equal(cleanups.length, 1);
  first.dispose();
});

test('install registers synchronously and registerCleanup receives dispose', () => {
  const env = setupEnv();
  const cleanups = [];
  const gallery = makeGallery(env, [], {
    registerCleanup: (fn) => cleanups.push(fn),
  });
  assert.equal(typeof env.window.__jennySurfaceGallery.open, 'function');
  assert.equal(cleanups.length, 1);
  cleanups[0]();
  assert.equal(env.window.__jennySurfaceGallery, undefined);
  assert.equal(gallery.dispose === cleanups[0], true);
});
