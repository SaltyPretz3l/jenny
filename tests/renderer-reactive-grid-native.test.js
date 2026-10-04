// FROZEN RED-FIRST: Reactive Grid native contractVersion-3 suite
// (Background Effects v3 packet S6). Production work must satisfy these
// contracts without editing this file. The legacy/pure rendering coverage
// remains in renderer-reactive-grid-utils.test.js.
//
// 2026-09-30 owner direction change (amends the freeze): the activity channel is
// gone (the grid never reacts to the model), the glow pass/bloom/preflight/tint
// were removed, the ambient diagonal wave is now the only idle motion and is
// contrast-tunable, and the loop follows a frame budget (~30 fps idle/unfocused,
// full rate while the pointer or a ring is answering the user). The lifecycle
// tests were deleted; the wave, ring, reduced-motion, cancel, budget, DPR,
// parser and physics-bound contracts below replace them.

const test = require('node:test');
const assert = require('node:assert/strict');

const reactiveGridUtils = require('../renderer/shell/renderer-reactive-grid-utils.js');
const reactiveGridCore = require('../renderer/shell/renderer-reactive-grid-core.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const appearanceUtils = require('../renderer/shared/appearance-utils.js');
const {
  makeFixtureDocumentRef,
  makeStyledFixtureHost,
  createEffectMediaQueryList,
  createFakeResizeObserverClass,
  buildFixtureContext,
  withStubbedGlobals,
} = require('./helpers/surface-effect-conformance.js');
const { createRafHarness } = require('./helpers/surface-effect-router-harness.js');

const EFFECT_ID = 'reactive-grid';
const IMPULSE_CAPACITY = 4;
const ALPHA_BUCKETS = reactiveGridCore.ALPHA_BUCKETS;
const IDLE_FILL = 'rgba(157, 197, 255, 0.180)';
const POINTER_EVENTS = [
  'pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup',
  'pointercancel', 'mousemove', 'mousedown', 'mouseup', 'click',
];

function makeFakeWindow(devicePixelRatio = 1) {
  const listeners = new Map();
  return {
    devicePixelRatio,
    addEventListener(name, listener) {
      if (!listeners.has(name)) { listeners.set(name, new Set()); }
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) {
      if (listeners.has(name)) { listeners.get(name).delete(listener); }
    },
    listenerCount(name) { return listeners.has(name) ? listeners.get(name).size : 0; },
    fire(name) { Array.from(listeners.get(name) || []).forEach((listener) => listener({ type: name })); },
  };
}

// A recording 2d context: one frame per clearRect, one record per fill() with
// the arcs batched into that path, so batching and bucket use are observable.
function createRecordingContext() {
  const frames = [];
  let frame = null;
  let path = [];
  const ctx = {
    frames,
    fillStyle: '',
    globalAlpha: 1,
    shadowBlurWrites: 0,
    save() {}, restore() {}, setTransform() {}, closePath() {},
    clearRect() { frame = { fills: [], moveTos: 0 }; frames.push(frame); },
    beginPath() { path = []; },
    moveTo() { if (frame) { frame.moveTos += 1; } },
    arc(x, y, r) { path.push({ x, y, r }); },
    fill() {
      if (frame) { frame.fills.push({ fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha, arcs: path }); }
      path = [];
    },
  };
  Object.defineProperty(ctx, 'shadowBlur', {
    get() { return 0; },
    set() { ctx.shadowBlurWrites += 1; },
  });
  return ctx;
}

function recordCanvases(documentRef) {
  const contexts = [];
  const createElement = documentRef.createElement;
  documentRef.createElement = (tag) => {
    const element = createElement.call(documentRef, tag);
    if (tag === 'canvas') {
      const ctx = createRecordingContext();
      contexts.push(ctx);
      element.getContext = () => ctx;
    }
    return element;
  };
  return contexts;
}

function makeEnv({
  reducedMotion = false,
  rendererLaunchSeed = 4242,
  documentOptions = {},
  sceneRole,
  windowRef = makeFakeWindow(),
  record = true,
} = {}) {
  const documentRef = makeFixtureDocumentRef(documentOptions);
  const contexts = record ? recordCanvases(documentRef) : [];
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const reportCalls = [];
  const controller = reactiveGridUtils.createReactiveGridController({
    effectId: EFFECT_ID,
    documentRef,
    windowRef,
    reducedMotionQuery,
    runtime,
    rendererLaunchSeed,
    sceneRole,
    report: (fault) => reportCalls.push(fault),
  });
  return { documentRef, reducedMotionQuery, controller, reportCalls, windowRef, contexts };
}

function withGrid(envOptions, fn) {
  const raf = createRafHarness();
  const ResizeObserverRef = createFakeResizeObserverClass();
  withStubbedGlobals({ raf, ResizeObserverRef }, () => {
    const env = makeEnv(envOptions);
    fn(Object.assign({ raf, ResizeObserverRef }, env));
  });
}

function makeHostSpec(role, rect, styleTokens) {
  return {
    element: makeStyledFixtureHost(
      rect || { left: 0, top: 0, width: 300, height: 300 },
      Object.assign({ '--reactive-grid-cell-size': '36' }, styleTokens || {}),
    ),
    role,
  };
}

function bindHosts(controller, specs, contextOverrides = {}) {
  const hosts = specs.map((spec) => makeHostSpec(spec.role, spec.rect, spec.styleTokens));
  controller.bind(buildFixtureContext(Object.assign({ hosts }, contextOverrides)));
  return hosts;
}

function bindAndPrime(controller, raf, specs, contextOverrides) {
  const hosts = bindHosts(controller, specs, contextOverrides);
  raf.flush(16);
  return hosts;
}

function inspect(controller) {
  assert.equal(
    typeof (controller._internals && controller._internals.inspect),
    'function',
    'Reactive Grid exposes the same read-only _internals.inspect() test seam as the native Circuit Trace pilot',
  );
  return controller._internals.inspect();
}

function entryFor(controller, role = 'chat-left') {
  const entry = inspect(controller).entries.find((candidate) => candidate.role === role);
  assert.ok(entry, 'inspection snapshot contains the ' + role + ' host entry');
  return entry;
}

function movePayload(overrides = {}) {
  return Object.assign({
    type: 'move',
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: 0,
    pressure: 0,
    timeStamp: 16,
    clientX: 100,
    clientY: 100,
    surfaceRole: 'chat-left',
    localX: 100,
    localY: 100,
    sceneX: 100,
    sceneY: 100,
    generation: 1,
  }, overrides);
}

function click(controller, x, y = 100, overrides = {}) {
  controller.handleInput(movePayload(Object.assign({
    type: 'click',
    localX: x,
    localY: y,
    sceneX: x,
    sceneY: y,
  }, overrides)));
}

function flushTicks(raf, count, ms = 16) {
  for (let i = 0; i < count; i += 1) { raf.flush(ms); }
}

function paintCount(contexts) { return contexts[0].frames.length; }

function lastFrame(contexts) { return contexts[0].frames.at(-1); }

function makeCoreEntry({ width = 240, height = 240, config = {} } = {}) {
  const fullConfig = Object.assign({
    cellSize: 24, hitRadius: 170, strength: 1, motionScale: 1, waveContrast: 1.3,
    friction: 0.86, springK: 0.04, pushStrength: 0.9,
    fadeRiseMs: 240, fadeDecayMs: 520,
    idleColor: 'rgba(157, 197, 255, 0.18)', activeColor: 'rgba(160, 230, 255, 0.96)',
  }, config);
  const simulation = reactiveGridCore.createSimulationState();
  const geometry = reactiveGridCore.resolveGridGeometry(
    width, height, fullConfig.cellSize, reactiveGridCore.MAX_GRID_DOTS,
  );
  reactiveGridCore.rebuildField(simulation, geometry, 42);
  return { simulation, config: fullConfig, w: width, h: height, seed: 42 };
}

function coreEnv(extra = {}) {
  return Object.assign({ timestamp: 1000, dtMs: 16.7, longGap: false, reducedMotion: false }, extra);
}

function alphaBucketOf(simulation, index) { return simulation.dotBucket[index] % ALPHA_BUCKETS; }

function colorBucketOf(simulation, index) { return (simulation.dotBucket[index] / ALPHA_BUCKETS) | 0; }

test('factory exposes exactly the v3 API, with no activity channel, and accepts an immutable context with staged reveal', () => {
  withGrid({}, ({ controller, raf }) => {
    assert.deepEqual(
      Object.keys(controller).sort(),
      ['_internals', 'bind', 'dispose', 'getStatus', 'handleInput', 'refresh'],
      'the controller exposes no setActivity/handleActivityImpulse: the grid never reacts to the model',
    );

    const [host] = bindHosts(controller, [{ role: 'chat-left' }], { generation: 7, staged: true });
    assert.deepEqual(controller.getStatus(), {
      state: 'ready', hostCount: 1, drawableHostCount: 1, reason: '',
    });
    assert.equal(entryFor(controller).readyShown, false, 'staged bind keeps the canvas hidden');
    raf.flush(16);
    assert.equal(entryFor(controller).readyShown, false, 'staged canvas stays hidden after a frame');

    controller.refresh(buildFixtureContext({
      generation: 7,
      staged: false,
      hosts: [{ element: host.element, role: 'chat-left' }],
    }));
    assert.equal(entryFor(controller).readyShown, false, 'un-staging is not a synchronous reveal');
    raf.flush(16);
    assert.equal(entryFor(controller).readyShown, true, 'un-staged refresh reveals on the next frame');
    assert.equal(inspect(controller).generation, 7);
    controller.dispose();
  });
});

test('the registry declares no activity channel for reactive-grid', () => {
  const preset = appearanceUtils.getSurfaceEffectPresets().find((candidate) => candidate.id === EFFECT_ID);
  assert.ok(preset, 'reactive-grid stays registered');
  assert.equal(preset.activityMode, 'none');
});

test('bind-of-bound reconciles context hosts and getStatus distinguishes dormant from drawable', () => {
  withGrid({}, ({ controller, raf }) => {
    const [first] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    const zero = makeHostSpec('chat-left', { left: 300, top: 0, width: 0, height: 0 });
    controller.bind(buildFixtureContext({
      generation: 2,
      hosts: [{ element: zero.element, role: zero.role }],
    }));
    raf.flush(16);

    assert.equal(first.element.children.length, 0, 'bind-of-bound acts as refresh and removes a stale host canvas');
    assert.deepEqual(controller.getStatus(), {
      state: 'dormant', hostCount: 1, drawableHostCount: 0, reason: 'no drawable host',
    });
    controller.refresh(buildFixtureContext({ generation: 3, hosts: [] }));
    assert.deepEqual(controller.getStatus(), {
      state: 'dormant', hostCount: 0, drawableHostCount: 0, reason: 'no drawable host',
    });
    controller.dispose();
  });
});

test('runtime null-context adoption removes the unusable canvas and reports dormant', () => {
  withGrid({ documentOptions: { nullContext: true }, record: false }, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.equal(host.element.children.length, 0, 'ensureCanvas2d removes a canvas whose 2d context is null');
    assert.deepEqual(controller.getStatus(), {
      state: 'dormant', hostCount: 1, drawableHostCount: 0, reason: 'no drawable host',
    });
    controller.dispose();
  });
});

test('manager-normalized move/leave input promotes scene coordinates without reading layout', () => {
  withGrid({}, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    let rectReads = 0;
    const originalRect = host.element.getBoundingClientRect;
    host.element.getBoundingClientRect = () => { rectReads += 1; return originalRect(); };

    controller.handleInput(movePayload({
      localX: 42, localY: 57, sceneX: 442, sceneY: 157, timeStamp: 20,
    }));
    let entry = entryFor(controller);
    assert.equal(entry.pointerActive, true);
    assert.equal(entry.pointerX, 442);
    assert.equal(entry.pointerY, 157);
    assert.equal(entry.pointerSceneX, 442);
    assert.equal(entry.pointerSceneY, 157);
    assert.equal(rectReads, 0, 'handleInput consumes router coordinates and never re-measures its host');

    controller.handleInput(movePayload({ type: 'leave', localX: 0, localY: 0 }));
    entry = entryFor(controller);
    assert.equal(entry.pointerActive, false, 'leave clears pointer attraction');

    const before = inspect(controller);
    controller.handleInput(movePayload({ surfaceRole: 'chat-right', localX: 9, localY: 9 }));
    assert.deepEqual(inspect(controller), before, 'an untracked role is an inert input target');
    controller.dispose();
  });
});

test('hover and click ignore non-primary pointers', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput(movePayload({ isPrimary: false, sceneX: 120, sceneY: 120 }));
    assert.equal(entryFor(controller).pointerActive, false, 'a non-primary move never activates hover');
    click(controller, 150, 150, { isPrimary: false });
    assert.equal(entryFor(controller).impulseCount, 0, 'a non-primary click never spawns a ring');

    controller.handleInput(movePayload({ sceneX: 120, sceneY: 120 }));
    assert.equal(entryFor(controller).pointerActive, true);
    controller.handleInput(movePayload({ type: 'leave', isPrimary: false }));
    assert.equal(entryFor(controller).pointerActive, true, 'a non-primary leave cannot clear the primary hover');
    controller.handleInput(movePayload({ type: 'cancel', isPrimary: false }));
    assert.equal(entryFor(controller).pointerActive, true, 'a non-primary cancel cannot clear the primary hover');
    click(controller, 150, 150);
    assert.equal(entryFor(controller).impulseCount, 1, 'a primary click spawns a ring');
    controller.dispose();
  });
});

test('click impulses use a fixed four-slot ring and evict the oldest origin', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    let entry = entryFor(controller);
    assert.equal(entry.impulseCapacity, IMPULSE_CAPACITY, 'pool is pre-sized to four slots');
    assert.equal(entry.impulseCount, 0);

    [10, 20, 30, 40, 50].forEach((x) => click(controller, x));
    entry = entryFor(controller);
    assert.equal(entry.impulseCapacity, IMPULSE_CAPACITY, 'capacity never grows under click pressure');
    assert.equal(entry.impulseCount, IMPULSE_CAPACITY, 'only four impulses can remain active');
    assert.deepEqual(
      entry.impulseOrigins.map((origin) => origin.x),
      [20, 30, 40, 50],
      'the fifth click overwrites the oldest slot while preserving logical oldest-to-newest order',
    );
    controller.dispose();
  });
});

test('pointer velocity injects a perpendicular curl into real dot velocities', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput(movePayload({ localX: 70, sceneX: 70, timeStamp: 10 }));
    controller.handleInput(movePayload({ localX: 210, sceneX: 210, timeStamp: 26 }));
    raf.flush(16);

    const entry = entryFor(controller);
    assert.ok(entry.pointerVelocityX > 0, 'horizontal pointer velocity is measured from normalized event timestamps');
    assert.equal(entry.pointerVelocityY, 0);
    assert.ok(entry.curlEnergy > 0, 'moving pointer produces a non-zero curl term');
    assert.ok(entry.curlAffectedDotCount > 0, 'the curl term reaches at least one simulated dot');
    assert.ok(entry.maxAbsDotVelocity > 0, 'curl/repulsion changes the real velocity field');
    controller.dispose();
  });
});

test('idle wave is legible: rest dots span several alpha buckets and a radius range of at least 0.9px', () => {
  const entry = makeCoreEntry();
  const { simulation } = entry;
  const periodMs = (2 * Math.PI / 0.6) * 1000;
  const seenBuckets = new Set();
  let minRadius = Infinity;
  let maxRadius = -Infinity;
  for (let t = 0; t <= periodMs; t += 250) {
    reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: t }));
    assert.equal(simulation.movingDotCount, 0, 'an unpointed field is at rest, so the wave is the only motion');
    const frameBuckets = new Set();
    for (let i = 0; i < simulation.dotCount; i += 1) {
      assert.equal(colorBucketOf(simulation, i), 0, 'the ambient wave never leaves the idle color');
      frameBuckets.add(alphaBucketOf(simulation, i));
      seenBuckets.add(alphaBucketOf(simulation, i));
      minRadius = Math.min(minRadius, simulation.dotRadius[i]);
      maxRadius = Math.max(maxRadius, simulation.dotRadius[i]);
    }
    assert.ok(frameBuckets.size >= 3, 'one frame already carries >=3 alpha buckets (got ' + frameBuckets.size + ')');
  }
  assert.ok(seenBuckets.size >= 3, 'over a wave period rest dots occupy >=3 distinct alpha buckets');
  assert.ok(maxRadius - minRadius >= 0.9, 'radius spans >=0.9px (got ' + (maxRadius - minRadius).toFixed(3) + ')');
});

test('waveContrast 0 flattens the field to one alpha bucket and the base radius', () => {
  const entry = makeCoreEntry({ config: { waveContrast: 0 } });
  const { simulation } = entry;
  for (let t = 0; t < 10500; t += 700) {
    reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: t }));
    const buckets = new Set();
    for (let i = 0; i < simulation.dotCount; i += 1) {
      buckets.add(simulation.dotBucket[i]);
      assert.ok(Math.abs(simulation.dotRadius[i] - 1.15) < 1e-6, 'flat field pins the base radius');
    }
    assert.equal(buckets.size, 1, 'a flat field paints from a single bucket');
  }
});

test('the wave follows its law: phase from seed, time, motionScale and the (col+row) diagonal', () => {
  const entry = makeCoreEntry({ config: { motionScale: 1.5 } });
  const { simulation } = entry;
  reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: 3000 }));
  for (let row = 0; row < simulation.rows; row += 1) {
    for (let col = 0; col < simulation.cols; col += 1) {
      const wave = Math.sin(3 * 0.6 * 1.5 + (col + row) * 0.42 + 42);
      const crest = Math.max(wave, 0) ** 2;
      const expected = 1.15 + crest * 0.9 * 1.3;
      assert.ok(Math.abs(simulation.dotRadius[row * simulation.cols + col] - expected) < 1e-4,
        'radius at (' + col + ',' + row + ') matches the wave law');
    }
  }
});

test('a click ring front lights dots directly, even where displacement is ~0', () => {
  const calm = makeCoreEntry();
  reactiveGridCore.advanceFrame(calm, coreEnv({ timestamp: 1200 }));
  for (let i = 0; i < calm.simulation.dotCount; i += 1) {
    assert.equal(colorBucketOf(calm.simulation, i), 0, 'control: no ring, no lit dots');
  }

  const entry = makeCoreEntry();
  const { simulation } = entry;
  reactiveGridCore.spawnImpulse(simulation, 120, 120, 1000, 1.1, 'outward', 'click');
  reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: 1200 }));
  const displacementNorm = simulation.effectiveCellSize * 1.2;
  let lit = 0;
  let brightest = 0;
  for (let i = 0; i < simulation.dotCount; i += 1) {
    const bucket = colorBucketOf(simulation, i);
    if (bucket === 0) { continue; }
    lit += 1;
    brightest = Math.max(brightest, bucket);
    const displacementFactor = Math.hypot(simulation.dotDx[i], simulation.dotDy[i]) / displacementNorm;
    // Six color buckets: displacement alone needs a factor of 1/6 to reach bucket 1.
    assert.ok(displacementFactor < 1 / 6,
      'the lit bucket cannot be explained by displacement (factor ' + displacementFactor.toFixed(3) + ')');
  }
  assert.ok(lit > 0, 'the ring front raises dots into active color buckets');
  assert.ok(brightest >= 3, 'the front is a clear highlight, not a hint (bucket ' + brightest + ')');
});

test('rings live 1100ms, expand at 0.36px/ms from radius 12, and are skipped entirely when none is active', () => {
  const entry = makeCoreEntry({ width: 600, height: 600 });
  const { simulation } = entry;
  reactiveGridCore.spawnImpulse(simulation, 300, 300, 0, 1.1, 'outward', 'click');
  reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: 1000 }));
  assert.equal(simulation.frame.ringCount, 1, 'a 1000ms-old ring is still live (old life was 850ms)');
  assert.ok(Math.abs(simulation.rings[0].radius - (12 + 1000 * 0.36)) < 1e-9);
  assert.equal(reactiveGridCore.inspectSimulation(simulation).impulseCount, 1);
  reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: 1200 }));
  assert.equal(simulation.frame.ringCount, 0, 'the ring is released past 1100ms');
  assert.equal(reactiveGridCore.inspectSimulation(simulation).impulseCount, 0);
});

test('reactive-grid paints one batched fill per bucket, with no shadow blur anywhere', () => {
  withGrid({}, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    click(controller, 150, 150);
    controller.handleInput(movePayload({ sceneX: 150, sceneY: 150, timeStamp: 20 }));
    flushTicks(raf, 6);
    const frame = lastFrame(contexts);
    const arcs = frame.fills.reduce((sum, fill) => sum + fill.arcs.length, 0);
    assert.ok(frame.fills.length > 0 && frame.fills.length <= 6 * 8, 'at most one fill per non-empty bucket (48 max)');
    assert.ok(arcs > frame.fills.length, 'each fill batches many dots');
    assert.equal(frame.moveTos, arcs, 'every arc starts its own subpath');
    assert.equal(arcs, entryFor(controller).dotCount, 'every dot is drawn exactly once');
    assert.equal(contexts[0].shadowBlurWrites, 0, 'the glow pass is gone: shadowBlur is never written');
    controller.dispose();
  });
});

test('reduced motion: hover is a static binary highlight that vanishes on leave', () => {
  withGrid({ reducedMotion: true }, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.ok(lastFrame(contexts).fills.every((fill) => fill.fillStyle === IDLE_FILL), 'flat idle grid before hover');

    controller.handleInput(movePayload({ sceneX: 150, sceneY: 150 }));
    assert.equal(entryFor(controller).pointerFade, 1, 'fade is 1 the moment the pointer is active');
    assert.ok(lastFrame(contexts).fills.some((fill) => fill.fillStyle !== IDLE_FILL), 'hover lights dots statically');

    controller.handleInput(movePayload({ type: 'leave' }));
    assert.equal(entryFor(controller).pointerFade, 0, 'fade is 0 immediately after leave');
    const frame = lastFrame(contexts);
    assert.ok(frame.fills.length > 0);
    assert.ok(frame.fills.every((fill) => fill.fillStyle === IDLE_FILL), 'zero dots stay in non-idle color buckets');
    assert.equal(raf.size, 0, 'static hover never starts a loop');
    controller.dispose();
  });
});

test('reduced motion flattens the wave to a static grid', () => {
  const entry = makeCoreEntry();
  reactiveGridCore.advanceFrame(entry, coreEnv({ reducedMotion: true, timestamp: 3000 }));
  const buckets = new Set();
  for (let i = 0; i < entry.simulation.dotCount; i += 1) {
    buckets.add(entry.simulation.dotBucket[i]);
    assert.ok(Math.abs(entry.simulation.dotRadius[i] - 1.15) < 1e-6);
  }
  assert.equal(buckets.size, 1);
});

test('cancel clears pointer state only: displacement and rings remain and the field settles by spring', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    click(controller, 150, 150, { timeStamp: raf.now });
    controller.handleInput(movePayload({ sceneX: 100, sceneY: 150, timeStamp: raf.now }));
    controller.handleInput(movePayload({ sceneX: 160, sceneY: 150, timeStamp: raf.now + 8 }));
    flushTicks(raf, 6);
    const before = entryFor(controller);
    assert.equal(before.pointerActive, true);
    assert.equal(before.impulseCount, 1);
    assert.ok(before.maxAbsDotDisplacement > 0, 'fixture has real displacement before cancel');

    controller.handleInput(movePayload({ type: 'cancel' }));
    const after = entryFor(controller);
    assert.equal(after.pointerActive, false, 'cancel clears the pointer');
    assert.equal(after.pointerVelocityX, 0);
    assert.equal(after.impulseCount, 1, 'cancel does not clear rings');
    assert.equal(after.maxAbsDotDisplacement, before.maxAbsDotDisplacement, 'cancel does not clear displacement');

    let settled = false;
    for (let i = 0; i < 600 && !settled; i += 1) {
      raf.flush(16);
      const entry = entryFor(controller);
      settled = entry.movingDotCount === 0 && entry.maxAbsDotDisplacement === 0 && entry.impulseCount === 0;
    }
    assert.ok(settled, 'rings expire and every dot springs back to rest');
    controller.dispose();
  });
});

test('reduced-motion cancel clears the static highlight and redraws', () => {
  withGrid({ reducedMotion: true }, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput(movePayload({ sceneX: 150, sceneY: 150 }));
    const framesBefore = paintCount(contexts);
    controller.handleInput(movePayload({ type: 'cancel' }));
    assert.ok(paintCount(contexts) > framesBefore, 'cancel triggers a static redraw');
    assert.equal(entryFor(controller).pointerFade, 0);
    assert.ok(lastFrame(contexts).fills.every((fill) => fill.fillStyle === IDLE_FILL));
    controller.dispose();
  });
});

test('isResponding follows the pointer, rings and unsettled dots, then goes quiet', () => {
  const entry = makeCoreEntry();
  const { simulation } = entry;
  assert.equal(reactiveGridCore.isResponding(simulation), false, 'a fresh field is not responding');
  reactiveGridCore.advanceFrame(entry, coreEnv());
  assert.equal(reactiveGridCore.isResponding(simulation), false, 'the ambient wave alone is not a response');

  reactiveGridCore.updatePointer(simulation, 100, 100, 10);
  assert.equal(reactiveGridCore.isResponding(simulation), true, 'an active pointer responds');
  reactiveGridCore.updatePointer(simulation, 160, 100, 26);
  for (let i = 0; i < 12; i += 1) { reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: 1000 + i * 16.7 })); }
  reactiveGridCore.clearPointer(simulation);
  assert.ok(simulation.movingDotCount > 0, 'the push left dots in motion');
  assert.equal(reactiveGridCore.isResponding(simulation), true, 'fade/moving dots keep it responding');
  let t = 1300;
  for (let i = 0; i < 900 && reactiveGridCore.isResponding(simulation); i += 1) {
    t += 16.7;
    reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: t }));
  }
  assert.equal(reactiveGridCore.isResponding(simulation), false, 'the field settles and stops responding');

  reactiveGridCore.spawnImpulse(simulation, 100, 100, t, 1.1, 'outward', 'click');
  assert.equal(reactiveGridCore.isResponding(simulation), true, 'a live ring responds');
  reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: t + 2000 }));
  reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: t + 2017 }));
  assert.equal(reactiveGridCore.isResponding(simulation), false, 'an expired ring stops responding');
});

// F17: a pointer parked over the window must let the loop fall back to its
// ambient cadence once the fade is full and the pushed dots have settled.
test('a parked pointer stops responding; the next move responds again', () => {
  const entry = makeCoreEntry();
  const { simulation } = entry;
  reactiveGridCore.updatePointer(simulation, 100, 100, 1000);
  reactiveGridCore.updatePointer(simulation, 160, 100, 1016);
  let t = 1016;
  for (let i = 0; i < 900 && (simulation.movingDotCount > 0 || simulation.pointer.fade < 1 || i < 30); i += 1) {
    t += 16.7;
    reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: t }));
  }
  assert.equal(simulation.pointer.active, true);
  assert.equal(simulation.movingDotCount, 0, 'the pushed dots settled under the parked pointer');
  assert.equal(reactiveGridCore.isResponding(simulation, 1016 + 399), true, 'a fresh pointer still responds');
  assert.equal(reactiveGridCore.isResponding(simulation, t), false, 'a parked pointer is ambient-only');
  assert.equal(reactiveGridCore.isResponding(simulation), true, 'without a clock the pointer still responds');
  reactiveGridCore.updatePointer(simulation, 170, 100, t);
  assert.equal(reactiveGridCore.isResponding(simulation, t + 1), true, 'the next move responds at once');
});

test('advanceFrame reuses its frame state and params (no per-frame allocation)', () => {
  const entry = makeCoreEntry();
  const first = reactiveGridCore.advanceFrame(entry, coreEnv());
  const frame = entry.simulation.frame;
  const second = reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: 1017 }));
  assert.equal(second, first);
  assert.equal(entry.simulation.frame, frame);
  ['clamp', 'getWindow', 'getComputedStyleSafe', 'armBloom', 'clearBloom', 'ensureTintFrameColors']
    .forEach((name) => assert.equal(reactiveGridCore[name], undefined, name + ' is no longer exported'));
});

test('frame budget: ~30fps at idle, every tick while the pointer is active, capped again when unfocused', () => {
  withGrid({}, ({ controller, raf, contexts, windowRef }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.equal(windowRef.listenerCount('focus'), 1, 'window focus is bound through the runtime');
    assert.equal(windowRef.listenerCount('blur'), 1);

    let before = paintCount(contexts);
    flushTicks(raf, 20);
    const idlePaints = paintCount(contexts) - before;
    assert.ok(idlePaints >= 9 && idlePaints <= 11, 'idle paints roughly every other 16ms tick (got ' + idlePaints + ')');
    assert.equal(raf.size, 1, 'the ambient loop stays alive between budgeted paints');

    controller.handleInput(movePayload({ sceneX: 150, sceneY: 150 }));
    before = paintCount(contexts);
    flushTicks(raf, 20);
    assert.equal(paintCount(contexts) - before, 20, 'an active pointer paints every tick');

    windowRef.fire('blur');
    before = paintCount(contexts);
    flushTicks(raf, 20);
    const blurredPaints = paintCount(contexts) - before;
    assert.ok(blurredPaints >= 9 && blurredPaints <= 11, 'an unfocused window caps even with an active pointer (got ' + blurredPaints + ')');

    windowRef.fire('focus');
    before = paintCount(contexts);
    flushTicks(raf, 10);
    assert.equal(paintCount(contexts) - before, 10, 'refocus restores full rate');
    controller.dispose();
    assert.equal(windowRef.listenerCount('focus'), 0, 'dispose removes the focus listener');
    assert.equal(windowRef.listenerCount('blur'), 0, 'dispose removes the blur listener');
  });
});

test('frame budget: a ring holds full rate until it expires, then the loop drops back to idle', () => {
  withGrid({}, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    click(controller, 150, 150, { timeStamp: raf.now });
    let before = paintCount(contexts);
    flushTicks(raf, 10);
    assert.equal(paintCount(contexts) - before, 10, 'a live ring paints every tick');
    flushTicks(raf, 200);
    assert.equal(entryFor(controller).movingDotCount, 0);
    before = paintCount(contexts);
    flushTicks(raf, 20);
    assert.ok(paintCount(contexts) - before <= 11, 'the settled field is back on the idle budget');
    controller.dispose();
  });
});

test('a DPR-only change re-backs the canvas on the next painted frame', () => {
  const windowRef = makeFakeWindow(1);
  withGrid({ windowRef }, ({ controller, raf, contexts }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    const canvas = host.element.children[0];
    assert.equal(canvas.width, 300);
    assert.equal(canvas.height, 300);

    windowRef.devicePixelRatio = 1.5;
    assert.equal(canvas.width, 300, 'nothing re-backs synchronously');
    const before = paintCount(contexts);
    flushTicks(raf, 2);
    assert.ok(paintCount(contexts) > before, 'a frame was painted');
    assert.equal(canvas.width, 450, 'the backing follows the new device pixel ratio');
    assert.equal(canvas.height, 450);
    assert.equal(entryFor(controller).dpr, 1.5);
    controller.dispose();
  });
});

test('reduced-motion static paints also re-back the canvas after a DPR-only change', () => {
  const windowRef = makeFakeWindow(1);
  withGrid({ windowRef, reducedMotion: true }, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    const canvas = host.element.children[0];
    assert.equal(canvas.width, 300);
    windowRef.devicePixelRatio = 1.5;
    controller.handleInput(movePayload({ sceneX: 120, sceneY: 120 }));
    assert.equal(canvas.width, 450, 'the static repaint follows the new device pixel ratio');
    controller.dispose();
  });
});

test('color parser accepts hex/rgb/rgba forms and falls back to schema colors for anything else', () => {
  const idleOf = (value) => reactiveGridCore.ensureFrameColors({ idleColor: value, activeColor: 'rgb(0, 0, 0)' })[0];
  const activeOf = (value) => reactiveGridCore.ensureFrameColors({ idleColor: 'rgb(0, 0, 0)', activeColor: value })[5];
  assert.equal(idleOf('rgba(1,2,3,.5)'), 'rgba(1, 2, 3, 0.500)', 'leading-dot numbers parse');
  assert.equal(idleOf('rgb(1 2 3 / 50%)'), 'rgba(1, 2, 3, 0.500)', 'space syntax with percentage alpha parses');
  assert.equal(idleOf('rgb(1, 2, 3)'), 'rgba(1, 2, 3, 1.000)');
  assert.equal(idleOf('#fff'), 'rgba(255, 255, 255, 1.000)');
  assert.equal(idleOf('#ff8000'), 'rgba(255, 128, 0, 1.000)');
  assert.equal(idleOf('#ff800080'), 'rgba(255, 128, 0, 0.502)');

  const idleFallback = 'rgba(157, 197, 255, 0.180)';
  const activeFallback = 'rgba(160, 230, 255, 0.960)';
  ['hsl(210,50%,60%)', 'oklch(0.7 0.1 200)', 'var(--dot)', 'rebeccapurple', '#ffff', 'rgb(1 2)',
    'rgb(1/2/3)', 'rgb(1,,2,,3)', 'rgb(1 2 3 /)', 'rgb(1, 2 3)', 'rgb(1 2 3 4)', '', null]
    .forEach((value) => {
      assert.equal(idleOf(value), idleFallback, String(value) + ' falls back to the idle schema color');
      assert.equal(activeOf(value), activeFallback, String(value) + ' falls back to the active schema color');
    });
});

test('physics bounds follow the effective cell size when the dot cap widens the pitch', () => {
  const entry = makeCoreEntry({
    width: 2400, height: 1200, config: { strength: 4, pushStrength: 8 },
  });
  const { simulation } = entry;
  const requested = entry.config.cellSize;
  assert.ok(simulation.effectiveCellSize > requested * 1.5, 'the 1500-dot cap widened the pitch');
  reactiveGridCore.updatePointer(simulation, 1200, 600, 0);
  reactiveGridCore.updatePointer(simulation, 1230, 600, 16);
  let peak = 0;
  for (let i = 0; i < 40; i += 1) {
    reactiveGridCore.advanceFrame(entry, coreEnv({ timestamp: 1000 + i * 16.7 }));
    peak = Math.max(peak, reactiveGridCore.inspectSimulation(simulation).maxAbsDotVelocity);
  }
  const bound = simulation.effectiveCellSize * 0.4;
  assert.ok(peak <= bound + 1e-3, 'velocity is bounded by the effective pitch (' + peak + ' <= ' + bound + ')');
  assert.ok(peak > requested * 0.4 + 1, 'the bound is the wider effective one, not the requested cell size');
  assert.ok(Math.abs(simulation.frame.displacementNorm - simulation.effectiveCellSize * 1.2) < 1e-9);
});

test('same launch seed and role reproduce the field, while a different launch seed diverges', () => {
  function capture(seed) {
    let captured;
    withGrid({ rendererLaunchSeed: seed }, ({ controller, raf }) => {
      bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
      const entry = entryFor(controller);
      captured = { seed: entry.seed, dotCount: entry.dotCount, dotRadiusSample: entry.dotRadiusSample };
      controller.dispose();
    });
    return captured;
  }

  const first = capture(777);
  const repeat = capture(777);
  assert.deepEqual(repeat, first, 'same rendererLaunchSeed|effectId|sceneRole reproduces the field');
  const other = capture(778);
  assert.notEqual(other.seed, first.seed, 'a different renderer launch seed changes the scene seed');
  assert.notDeepEqual(other.dotRadiusSample, first.dotRadiusSample, 'a different seed shifts the wave phase');
});

test('chat and home scenes seed separately and deterministically', () => {
  let chatSeed;
  withGrid({ rendererLaunchSeed: 909 }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    chatSeed = entryFor(controller, 'chat-left').seed;
    controller.dispose();
  });
  withGrid({ rendererLaunchSeed: 909 }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.equal(entryFor(controller, 'chat-left').seed, chatSeed, 'the chat scene seed is stable across controllers');
    controller.dispose();
  });
  withGrid({ rendererLaunchSeed: 909 }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'home' }], { surface: 'home' });
    assert.notEqual(entryFor(controller, 'home').seed, chatSeed, 'home uses a separate sceneRole seed');
    controller.dispose();
  });
});

test('one host paints the whole scene field and the scene advances exactly once per frame', () => {
  withGrid({ rendererLaunchSeed: 909 }, ({ controller, raf }) => {
    const rect = { left: 100, top: 40, width: 480, height: 300 };
    bindAndPrime(controller, raf, [{ role: 'chat-left', rect }], { sceneRect: rect, hostRects: [rect] });

    const expected = reactiveGridCore.resolveGridGeometry(
      rect.width, rect.height, 36, reactiveGridCore.MAX_GRID_DOTS,
    ).dotCount;
    assert.equal(entryFor(controller).dotCount, expected, 'the field is sized from the scene rect');

    const originalAdvance = reactiveGridCore.advanceFrame;
    let advanceCalls = 0;
    reactiveGridCore.advanceFrame = (...args) => {
      advanceCalls += 1;
      return originalAdvance(...args);
    };
    try {
      raf.flush(16);
      raf.flush(16);
    } finally {
      reactiveGridCore.advanceFrame = originalAdvance;
    }
    assert.equal(advanceCalls, 1, 'one scene tick per painted frame (the second tick is budget-skipped at idle)');
    controller.dispose();
  });
});

test('spawn avoidance rejects pointer impulse origins without emptying the scene', () => {
  withGrid({}, ({ controller, raf }) => {
    const rect = { left: 100, top: 40, width: 300, height: 300 };
    const blockedCenter = { left: 240, top: 180, width: 20, height: 20 };
    bindAndPrime(controller, raf, [{ role: 'chat-left', rect }], {
      sceneRect: rect,
      hostRects: [rect],
      spawnAvoidanceRects: [blockedCenter],
    });

    controller.handleInput(movePayload({
      type: 'click', sceneX: 150, sceneY: 150, localX: 150, localY: 150,
    }));
    assert.equal(entryFor(controller).impulseCount, 0, 'blocked pointer spawn is skipped');
    controller.handleInput(movePayload({
      type: 'click', sceneX: 40, sceneY: 40, localX: 40, localY: 40,
    }));
    assert.deepEqual(entryFor(controller).impulseOrigins.map(({ x, y }) => [x, y]), [[40, 40]]);
    controller.dispose();
  });
});

test('reduced-motion changes stop the loop, clear waves/velocity, and retain a static pointer highlight', () => {
  withGrid({}, ({ controller, raf, reducedMotionQuery }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    click(controller, 100);
    controller.handleInput(movePayload({ localX: 40, sceneX: 40, timeStamp: 10 }));
    controller.handleInput(movePayload({ localX: 180, sceneX: 180, timeStamp: 26 }));
    raf.flush(16);
    assert.ok(entryFor(controller).maxAbsDotVelocity > 0, 'normal motion produces velocity before the preference changes');

    reducedMotionQuery.simulateChange(true);
    let entry = entryFor(controller);
    assert.equal(inspect(controller).reducedMotion, true);
    assert.equal(raf.size, 0, 'reduced motion has no ongoing animation frame');
    assert.equal(entry.impulseCount, 0, 'repeated wave motion is removed');
    assert.equal(entry.maxAbsDotVelocity, 0, 'ongoing dot motion is settled');

    click(controller, 200);
    controller.handleInput(movePayload({ localX: 33, localY: 44, sceneX: 333, sceneY: 144 }));
    entry = entryFor(controller);
    assert.equal(entry.impulseCount, 0, 'click waves stay suppressed under reduced motion');
    assert.equal(entry.pointerX, 333, 'a static scene pointer highlight remains available');
    assert.equal(entry.pointerY, 144);
    assert.equal(raf.size, 0, 'static highlighting does not restart an ambient loop');
    controller.dispose();
  });
});

test('draw faults from a throwing context are contained and reported as frame faults', () => {
  // record: false keeps the fixture's own fault-injecting 2d context.
  withGrid({ documentOptions: { throwOnDraw: true }, record: false }, ({ controller, raf, reportCalls }) => {
    bindHosts(controller, [{ role: 'chat-left' }]);
    assert.doesNotThrow(() => raf.flush(16), 'a draw fault never escapes the frame boundary');
    assert.ok(reportCalls.length >= 1, 'the injected reporter receives the draw failure');
    reportCalls.forEach((fault) => {
      assert.equal(fault.effectId, EFFECT_ID);
      assert.equal(fault.stage, 'frame');
      assert.equal(fault.recoverable, true);
    });
    controller.dispose();
  });
});

test('native controller owns zero pointer listeners and fully tears down runtime resources', () => {
  withGrid({}, ({
    controller, raf, documentRef, reducedMotionQuery, ResizeObserverRef,
  }) => {
    const hosts = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    hosts.forEach(({ element }, index) => {
      POINTER_EVENTS.forEach((eventName) => {
        assert.equal(element.listenerCount(eventName), 0, 'host ' + index + ' has no own ' + eventName + ' listener');
      });
    });
    assert.equal(documentRef.listenerCount('visibilitychange'), 1, 'runtime visibility listener is bound once');
    assert.equal(reducedMotionQuery.listenerCount(), 1, 'runtime reduced-motion listener is bound once');
    assert.equal(ResizeObserverRef.getActiveCount(), 0, 'manager layout snapshots replace effect-owned observers');

    click(controller, 50);
    controller.dispose();
    assert.equal(raf.size, 0, 'dispose cancels every pending frame');
    assert.equal(documentRef.listenerCount('visibilitychange'), 0, 'visibility listener is removed');
    assert.equal(reducedMotionQuery.listenerCount(), 0, 'motion listener is removed');
    assert.equal(ResizeObserverRef.getActiveCount(), 0, 'ResizeObserver is disconnected');
    hosts.forEach(({ element }) => assert.equal(element.children.length, 0, 'injected canvas is removed'));

    assert.doesNotThrow(() => controller.dispose(), 'dispose is idempotent');
    const before = inspect(controller);
    controller.handleInput(movePayload({ localX: 999, localY: 999 }));
    assert.deepEqual(inspect(controller), before, 'all public methods are inert after dispose');
    assert.equal(before.disposed, true);
  });
});
