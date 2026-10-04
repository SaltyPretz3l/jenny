// Atomic Burst native contractVersion-3 suite (Background Effects v3 packet S7).
// Legacy pure-field coverage remains in renderer-atomic-burst-utils.test.js.
//
// 2026-09-30 owner direction change (amends the original freeze): the activity
// channel is gone (the field never reacts to the model), shadowBlur glow, the
// completion sweep, wave particles and rotation wobble were retired, and the loop
// follows a frame budget (~30 fps idle/unfocused, full rate while the pointer or
// a ring is answering the user). Hover flare + links fade in/out, rings flare the
// sparkles they cross, and sparkles are painted in batched colour/alpha groups.

const test = require('node:test');
const assert = require('node:assert/strict');

const atomicBurstUtils = require('../renderer/shell/renderer-atomic-burst-utils.js');
const atomicBurstCore = require('../renderer/shell/renderer-atomic-burst-core.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const {
  makeFixtureDocumentRef,
  makeStyledFixtureHost,
  createEffectMediaQueryList,
  createFakeResizeObserverClass,
  buildFixtureContext,
  withStubbedGlobals,
} = require('./helpers/surface-effect-conformance.js');
const { createRafHarness } = require('./helpers/surface-effect-router-harness.js');
const { createRecordingContext, makeCoreEntry, step } = require('./helpers/atomic-burst-fixtures.js');

const EFFECT_ID = 'atomic-burst';
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

// A recording 2d context: one frame per clearRect, one record per fill()/stroke()
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
  runtimeOverride = runtime,
} = {}) {
  const documentRef = makeFixtureDocumentRef(documentOptions);
  const contexts = record ? recordCanvases(documentRef) : [];
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const reportCalls = [];
  const controller = atomicBurstUtils.createAtomicBurstController({
    effectId: EFFECT_ID,
    documentRef,
    windowRef,
    reducedMotionQuery,
    runtime: runtimeOverride,
    rendererLaunchSeed,
    sceneRole,
    report: (fault) => reportCalls.push(fault),
  });
  return { documentRef, reducedMotionQuery, controller, reportCalls, windowRef, contexts };
}

function withAtomic(envOptions, fn) {
  const raf = createRafHarness();
  const ResizeObserverRef = createFakeResizeObserverClass();
  withStubbedGlobals({ raf, ResizeObserverRef }, () => {
    fn(Object.assign({ raf, ResizeObserverRef }, makeEnv(envOptions)));
  });
}

function makeHostSpec(role, rect, styleTokens) {
  return {
    element: makeStyledFixtureHost(
      rect || { left: 0, top: 0, width: 300, height: 300 },
      Object.assign({
        '--widget-atomic-burst-size': '14px',
        '--widget-atomic-burst-density': '6.2',
      }, styleTokens || {}),
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
  assert.equal(typeof (controller._internals && controller._internals.inspect), 'function');
  return controller._internals.inspect();
}

function entryFor(controller, role = 'chat-left') {
  const entry = inspect(controller).entries.find((candidate) => candidate.role === role);
  assert.ok(entry, 'inspection snapshot contains the ' + role + ' entry');
  return entry;
}

function inputPayload(overrides = {}) {
  return Object.assign({
    type: 'move', pointerId: 1, pointerType: 'mouse', isPrimary: true,
    buttons: 0, pressure: 0, timeStamp: 16,
    clientX: 100, clientY: 100, surfaceRole: 'chat-left',
    localX: 100, localY: 100, sceneX: 100, sceneY: 100, generation: 1,
  }, overrides);
}

function click(controller, x, y = 100, overrides = {}) {
  controller.handleInput(inputPayload(Object.assign({
    type: 'click', localX: x, localY: y, sceneX: x, sceneY: y,
  }, overrides)));
}

function flushTicks(raf, count, ms = 16) {
  for (let i = 0; i < count; i += 1) { raf.flush(ms); }
}

function paintCount(contexts) { return contexts[0].frames.length; }

function lastFrame(contexts) { return contexts[0].frames.at(-1); }

// ---- controller contract --------------------------------------------------

test('factory exposes exactly the v3 API, with no activity channel, and accepts an immutable context with staged reveal', () => {
  withAtomic({}, ({ controller, raf }) => {
    assert.deepEqual(
      Object.keys(controller).sort(),
      ['_internals', 'bind', 'dispose', 'getStatus', 'handleInput', 'refresh'],
      'the controller exposes no setActivity/handleActivityImpulse: the field never reacts to the model',
    );
    assert.equal(controller.setActivity, undefined);
    assert.equal(controller.handleActivityImpulse, undefined);

    const [host] = bindHosts(controller, [{ role: 'chat-left' }], { generation: 7, staged: true });
    assert.deepEqual(controller.getStatus(), {
      state: 'ready', hostCount: 1, drawableHostCount: 1, reason: '',
    });
    assert.equal(entryFor(controller).readyShown, false);
    raf.flush(16);
    assert.equal(entryFor(controller).readyShown, false, 'staged canvases remain hidden');

    controller.refresh(buildFixtureContext({
      generation: 7,
      staged: false,
      hosts: [{ element: host.element, role: 'chat-left' }],
    }));
    raf.flush(16);
    assert.equal(entryFor(controller).readyShown, true, 'un-staging reveals on a later frame');
    assert.equal(inspect(controller).generation, 7);

    controller.bind(buildFixtureContext({ generation: 8, hosts: [] }));
    assert.deepEqual(controller.getStatus(), {
      state: 'dormant', hostCount: 0, drawableHostCount: 0, reason: 'no drawable host',
    });
    assert.equal(host.element.children.length, 0, 'bind-of-bound reconciles stale hosts');
    controller.dispose();
  });
});

test('null 2d contexts are removed (even when the runtime leaves the canvas behind) and zero-sized hosts stay dormant', () => {
  withAtomic({ documentOptions: { nullContext: true }, record: false }, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.equal(host.element.children.length, 0);
    assert.equal(controller.getStatus().state, 'dormant');
    controller.dispose();
  });
  // A runtime whose ensureCanvas2d fails WITHOUT removing the node: the controller
  // must still remove the canvas it inserted (A6).
  const leakyRuntime = Object.assign({}, runtime, { ensureCanvas2d: () => null });
  withAtomic({ runtimeOverride: leakyRuntime }, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.equal(host.element.children.length, 0, 'the inserted canvas is removed after a failed ensureCanvas2d');
    assert.equal(controller.getStatus().state, 'dormant');
    assert.equal(entryFor(controller).hasCanvas, false);
    controller.dispose();
  });
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{
      role: 'chat-left', rect: { left: 0, top: 0, width: 0, height: 0 },
    }]);
    assert.equal(controller.getStatus().state, 'dormant');
    controller.dispose();
  });
});

test('normalized manager input promotes scene coordinates into the one shared pointer without layout reads', () => {
  withAtomic({}, ({ controller, raf }) => {
    const hosts = bindAndPrime(controller, raf, [
      { role: 'chat-left' }, { role: 'chat-right' },
    ]);
    let rectReads = 0;
    const originalRect = hosts[0].element.getBoundingClientRect;
    hosts[0].element.getBoundingClientRect = () => { rectReads += 1; return originalRect(); };

    controller.handleInput(inputPayload({
      localX: 42, localY: 57, sceneX: 442, sceneY: 157, timeStamp: 20,
    }));
    let left = entryFor(controller);
    assert.deepEqual(
      [left.pointerActive, left.pointerX, left.pointerY, left.pointerSceneX, left.pointerSceneY],
      [true, 442, 157, 442, 157],
    );
    assert.equal(entryFor(controller, 'chat-right').pointerActive, true,
      'both gutter viewports inspect the same scene pointer');
    assert.equal(rectReads, 0, 'input consumes router geometry without measuring the host');

    controller.handleInput(inputPayload({ type: 'leave' }));
    left = entryFor(controller);
    assert.equal(left.pointerActive, false);
    controller.dispose();
  });
});

test('click rings use a fixed four-slot pool and evict the oldest origin', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    [10, 20, 30, 40, 50].forEach((x, index) => click(controller, x, 60, { timeStamp: 20 + index }));
    const entry = entryFor(controller);
    assert.equal(entry.waveCapacity, 4);
    assert.equal(entry.waveCount, 4);
    assert.deepEqual(entry.waveOrigins.map((wave) => wave.x), [20, 30, 40, 50]);
    assert.ok(entry.sparkleCount <= 1500, 'primitive cap is exact');
    controller.dispose();
  });
});

test('counter-parallax offsets move opposite the scene pointer and scale by depth', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput(inputPayload({
      localX: 250, localY: 250, sceneX: 250, sceneY: 250, timeStamp: 20,
    }));
    raf.flush(80);

    const offsets = entryFor(controller).parallaxOffsets;
    assert.equal(offsets.length, 3);
    offsets.forEach((offset) => {
      assert.ok(offset.x < 0, 'rightward input shifts the field left');
      assert.ok(offset.y < 0, 'downward input shifts the field up');
    });
    assert.ok(Math.abs(offsets[2].x) > Math.abs(offsets[1].x));
    assert.ok(Math.abs(offsets[1].x) > Math.abs(offsets[0].x));
    controller.dispose();
  });
});

test('blank or malformed link and wave colors inherit the resolved flare color', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{
      role: 'chat-left',
      styleTokens: {
        '--widget-atomic-burst-flare-color': 'rgb(12, 34, 56)',
        '--widget-atomic-burst-link-color': '',
        '--widget-atomic-burst-wave-color': '12garbage',
      },
    }]);
    const entry = entryFor(controller);
    assert.equal(entry.flareColor, 'rgb(12, 34, 56)');
    assert.equal(entry.linkColor, entry.flareColor);
    assert.equal(entry.waveColor, entry.flareColor);
    controller.dispose();
  });
});

test('same launch seed and scene role reproduce sparkles; chat gutters share a seed', () => {
  function capture(seed) {
    let captured;
    withAtomic({ rendererLaunchSeed: seed }, ({ controller, raf }) => {
      bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
      const entry = entryFor(controller);
      captured = { seed: entry.seed, sparkleSample: entry.sparkleSample };
      controller.dispose();
    });
    return captured;
  }
  assert.deepEqual(capture(777), capture(777));
  assert.notDeepEqual(capture(777), capture(778));

  withAtomic({ rendererLaunchSeed: 909 }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }, { role: 'chat-right' }]);
    assert.equal(entryFor(controller, 'chat-left').seed, entryFor(controller, 'chat-right').seed);
    assert.deepEqual(
      entryFor(controller, 'chat-left').sparkleSample,
      entryFor(controller, 'chat-right').sparkleSample,
    );
    controller.dispose();
  });
});

test('split gutters render one wide scene field; spawn avoidance keeps the field and skips sparkles at draw time', () => {
  const leftRect = { left: 0, top: 0, width: 240, height: 300 };
  const rightRect = { left: 560, top: 0, width: 240, height: 300 };
  const sceneRect = { left: 0, top: 0, width: 800, height: 300 };
  let baseline;
  withAtomic({ rendererLaunchSeed: 31337 }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [
      { role: 'chat-left', rect: leftRect }, { role: 'chat-right', rect: rightRect },
    ], { sceneRect, hostRects: [leftRect, rightRect] });
    const left = entryFor(controller, 'chat-left');
    const right = entryFor(controller, 'chat-right');
    assert.deepEqual(left.sparkleSample, right.sparkleSample, 'both viewports share one simulation');
    assert.ok(left.sparkleSample.some(([x]) => x > leftRect.width),
      'the scene field extends beyond the left viewport instead of duplicating a local field');
    assert.equal(left.avoidedSparkleCount, 0);
    baseline = left;
    controller.dispose();
  });

  const [blockedX, blockedY] = baseline.sparkleSample[0];
  const blockedRect = { left: blockedX - 1, top: blockedY - 1, width: 2, height: 2 };
  withAtomic({ rendererLaunchSeed: 31337 }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [
      { role: 'chat-left', rect: leftRect }, { role: 'chat-right', rect: rightRect },
    ], {
      sceneRect,
      hostRects: [leftRect, rightRect],
      spawnAvoidanceRects: [blockedRect],
    });
    const filtered = entryFor(controller);
    assert.equal(filtered.sparkleCount, baseline.sparkleCount, 'the field itself is not filtered by avoidance');
    assert.deepEqual(filtered.sparkleSample, baseline.sparkleSample);
    assert.ok(filtered.avoidedSparkleCount >= 1, 'the sparkle inside the rect is skipped at draw time');
    controller.dispose();
  });
});

test('a spawn-avoidance-only refresh keeps the field, rings and flares; avoided sparkles are skipped when drawn', () => {
  withAtomic({}, ({ controller, raf, contexts }) => {
    const rect = { left: 0, top: 0, width: 300, height: 300 };
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left', rect }], { sceneRect: rect, hostRects: [rect] });
    const before = entryFor(controller);
    const [sparkleX, sparkleY] = before.sparkleSample[0];
    click(controller, sparkleX, sparkleY, { timeStamp: raf.now });
    raf.flush(16);
    assert.equal(entryFor(controller).waveCount, 1);
    assert.ok(entryFor(controller).flareCount > 0, 'the ring flared the sparkles it crossed');

    controller.refresh(buildFixtureContext({
      generation: 1,
      hosts: [{ element: host.element, role: 'chat-left' }],
      sceneRect: rect,
      hostRects: [rect],
      layoutRevision: 2,
      spawnAvoidanceRects: [{ left: sparkleX - 1, top: sparkleY - 1, width: 2, height: 2 }],
    }));
    const after = entryFor(controller);
    assert.deepEqual(after.sparkleSample, before.sparkleSample, 'the field is not rebuilt');
    assert.equal(after.sparkleCount, before.sparkleCount);
    assert.equal(after.waveCount, 1, 'the live ring survives an avoidance-only refresh');
    assert.ok(after.avoidedSparkleCount >= 1);
    raf.flush(16);
    assert.ok(entryFor(controller).waveCount === 1 && entryFor(controller).flareCount > 0,
      'rings and flares keep running after the refresh repaint');
    assert.ok(paintCount(contexts) > 0);
    controller.dispose();
  });

  // Draw-time skip at the core: the same field, with and without an avoidance rect.
  const free = makeCoreEntry({ sparkles: [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 250, y: 50 }] });
  const avoiding = makeCoreEntry({ sparkles: [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 250, y: 50 }] });
  atomicBurstCore.setAvoidance(avoiding.simulation, [{ left: 140, top: 40, width: 20, height: 20 }]);
  const arcsOf = (entry) => step(entry, 1000) && entry.ctx.frames.at(-1).fills
    .flatMap((fill) => fill.path.filter((op) => op.type === 'arc'));
  assert.equal(arcsOf(free).length, 3);
  const skipped = arcsOf(avoiding);
  assert.equal(skipped.length, 2, 'the sparkle inside the avoidance rect is not drawn');
  assert.ok(skipped.every((arc) => Math.abs(arc.x - 150) > 1));
  assert.equal(avoiding.simulation.sparkles.length, 3, 'avoidance never removes a sparkle from the field');
});

test('one shared frame advances once while both gutter viewports paint the same scene state', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }, { role: 'chat-right' }]);
    const before = entryFor(controller, 'chat-left').drawCount;
    raf.flush(40);
    const left = entryFor(controller, 'chat-left');
    const right = entryFor(controller, 'chat-right');
    assert.equal(left.drawCount, before + 1, 'shared simulation advances once for the painted frame');
    assert.equal(right.drawCount, left.drawCount, 'both viewport snapshots observe the same frame state');
    assert.deepEqual(right.parallaxOffsets, left.parallaxOffsets);
    controller.dispose();
  });
});

test('paint occlusion clears the viewport while the shared simulation continues advancing', () => {
  withAtomic({}, ({ controller, raf }) => {
    const rect = { left: 10, top: 20, width: 300, height: 300 };
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left', rect }], {
      sceneRect: rect,
      hostRects: [rect],
    });
    const canvas = host.element.children.find((child) => child.tagName === 'CANVAS');
    const ctx = canvas.getContext('2d');
    const originalClear = ctx.clearRect.bind(ctx);
    const clears = [];
    ctx.clearRect = (...args) => { clears.push(args); originalClear(...args); };
    const before = entryFor(controller).drawCount;

    controller.refresh(buildFixtureContext({
      generation: 1,
      hosts: [host],
      sceneRect: rect,
      hostRects: [rect],
      layoutRevision: 2,
      paintOcclusionRects: [rect],
    }));
    raf.flush(40);

    assert.ok(entryFor(controller).drawCount > before, 'occlusion does not pause scene simulation');
    assert.ok(clears.length >= 2, 'the frame clear and projected occlusion clear both execute');
    assert.ok(clears.some((args) => args[0] === 0 && args[1] === 0
      && args[2] === rect.width && args[3] === rect.height));
    controller.dispose();
  });
});

test('long gaps reset transient rings without catch-up; hidden and detached entries do no work', () => {
  withAtomic({}, ({ controller, raf, documentRef }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    click(controller, 90, 90, { timeStamp: raf.now });
    raf.flush(600);
    assert.equal(entryFor(controller).waveCount, 0, 'a visible >500ms gap directly clears transient rings');

    click(controller, 90, 90, { timeStamp: raf.now });
    const before = entryFor(controller).drawCount;

    documentRef.hidden = true;
    documentRef.fire('visibilitychange');
    raf.flush(32);
    assert.equal(entryFor(controller).drawCount, before, 'hidden documents do not draw');
    documentRef.hidden = false;
    documentRef.fire('visibilitychange');
    raf.flush(1200);
    assert.equal(entryFor(controller).waveCount, 0, 'resume does not fast-forward a stale ring');

    host.element.isConnected = false;
    const detachedDraws = entryFor(controller).drawCount;
    raf.flush(16);
    assert.equal(entryFor(controller).drawCount, detachedDraws, 'detached hosts do not draw');
    controller.dispose();
  });

  const entry = makeCoreEntry({ sparkles: [{ x: 50, y: 50 }] });
  atomicBurstCore.updatePointer(entry.simulation, 50, 50);
  atomicBurstCore.spawnWave(entry.simulation, { x: 50, y: 50, startTime: 0, config: entry.config });
  step(entry, 1);
  step(entry, 2, { longGap: true, dtMs: 0 });
  const after = atomicBurstCore.inspectSimulation(entry.simulation);
  assert.equal(after.waveCount, 0);
  assert.equal(after.pointerActive, false, 'a frame-clock long gap is a hard reset');
  assert.equal(after.pointerFade, 0);
});

test('cancel clears the pointer only: rings keep settling, and a non-primary cancel leaves the primary hover alone', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'home' }], { surface: 'home' });
    controller.handleInput(inputPayload({
      type: 'move', surfaceRole: 'home', sceneX: 30, sceneY: 40,
    }));
    click(controller, 50, 60, { surfaceRole: 'home', timeStamp: raf.now });
    assert.equal(entryFor(controller, 'home').waveCount, 1);
    assert.equal(entryFor(controller, 'home').pointerActive, true);

    // A second finger or pen contact never touches the primary pointer's state.
    controller.handleInput(inputPayload({ type: 'cancel', isPrimary: false, pointerId: 2, surfaceRole: 'home' }));
    controller.handleInput(inputPayload({ type: 'move', isPrimary: false, pointerId: 2, surfaceRole: 'home', sceneX: 200, sceneY: 200 }));
    click(controller, 70, 70, { isPrimary: false, pointerId: 2, surfaceRole: 'home', timeStamp: raf.now });
    let entry = entryFor(controller, 'home');
    assert.equal(entry.pointerActive, true, 'non-primary cancel keeps the primary hover');
    assert.equal(entry.pointerX, 30, 'a non-primary move does not steal the pointer');
    assert.equal(entry.waveCount, 1, 'a non-primary click spawns no ring');

    // The primary cancel, even with a mismatched synthetic role, clears the pointer only.
    controller.handleInput(inputPayload({ type: 'cancel', surfaceRole: 'synthetic-missing-role' }));
    entry = entryFor(controller, 'home');
    assert.equal(entry.pointerActive, false);
    assert.equal(entry.waveCount, 1, 'the live ring settles on its own');
    controller.dispose();
  });
});

test('hidden reduced-motion bind/refresh resumes with one static draw and reveal only', () => {
  withAtomic({ reducedMotion: true, documentOptions: { hidden: true } }, ({
    controller, raf, documentRef,
  }) => {
    const [host] = bindHosts(controller, [{ role: 'chat-left' }], { staged: true });
    controller.refresh(buildFixtureContext({
      generation: 2,
      staged: false,
      hosts: [{ element: host.element, role: 'chat-left' }],
    }));

    let entry = entryFor(controller);
    assert.equal(entry.drawCount, 0, 'hidden reduced-motion bind/refresh performs no paint');
    assert.equal(entry.readyShown, false, 'hidden canvas is not revealed');
    assert.equal(raf.size, 0, 'hidden reduced-motion state owns no pending frame');

    documentRef.hidden = false;
    documentRef.fire('visibilitychange');
    entry = entryFor(controller);
    assert.equal(entry.drawCount, 1, 'foregrounding performs exactly one static draw');
    assert.equal(entry.readyShown, false, 'reveal remains staged until its frame');
    assert.equal(raf.size, 1, 'only the one-shot reveal frame is pending');

    raf.flush(16);
    entry = entryFor(controller);
    assert.equal(entry.drawCount, 1, 'reveal does not start an ambient reduced-motion loop');
    assert.equal(entry.readyShown, true, 'foregrounding reveals the now-painted canvas');
    assert.equal(raf.size, 0, 'no ambient frame remains after reveal');
    controller.dispose();
  });
});

test('reduced motion: no rings or loop, and a binary flare that clears the instant the pointer leaves', () => {
  withAtomic({}, ({ controller, raf, reducedMotionQuery, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    click(controller, 100, 100, { timeStamp: raf.now });
    assert.equal(entryFor(controller).waveCount, 1);
    reducedMotionQuery.simulateChange(true);
    assert.equal(entryFor(controller).waveCount, 0, 'switching to reduced motion clears rings');
    assert.equal(raf.size, 0);

    click(controller, 200, 100);
    assert.equal(entryFor(controller).waveCount, 0, 'rings stay suppressed under reduced motion');

    const flareColor = entryFor(controller).flareColor;
    const [sparkleX, sparkleY] = entryFor(controller).sparkleSample[0];
    controller.handleInput(inputPayload({ sceneX: sparkleX, sceneY: sparkleY }));
    assert.equal(entryFor(controller).pointerX, sparkleX, 'the static pointer highlight remains available');
    let frame = lastFrame(contexts);
    assert.ok(frame.fills.some((fill) => fill.fillStyle === flareColor), 'the hovered sparkle takes the flare colour');
    assert.equal(frame.strokes.length, 0, 'no links or rings under reduced motion');
    assert.ok(frame.fills.every((fill) => fill.path.every((op) => op.type !== 'arc' || op.r < 40)),
      'no halo circle under reduced motion');

    controller.handleInput(inputPayload({ type: 'leave' }));
    frame = lastFrame(contexts);
    assert.ok(frame.fills.every((fill) => fill.fillStyle !== flareColor), 'the flare clears immediately on leave');
    assert.equal(raf.size, 0, 'static highlighting never restarts an ambient loop');
    controller.dispose();
  });
});

test('draw faults are contained and reported through the runtime fault seam', () => {
  // record: false keeps the fixture's own fault-injecting 2d context.
  withAtomic({ documentOptions: { throwOnDraw: true }, record: false }, ({ controller, raf, reportCalls }) => {
    bindHosts(controller, [{ role: 'chat-left' }]);
    assert.doesNotThrow(() => raf.flush(16));
    assert.ok(reportCalls.length >= 1);
    reportCalls.forEach((fault) => {
      assert.equal(fault.effectId, EFFECT_ID);
      assert.equal(fault.stage, 'frame');
      assert.equal(fault.recoverable, true);
    });
    controller.dispose();
  });
});

test('native controller owns no pointer listeners and disposal is terminal and leak-free', () => {
  withAtomic({}, ({
    controller, raf, documentRef, reducedMotionQuery, ResizeObserverRef, windowRef,
  }) => {
    const hosts = bindAndPrime(controller, raf, [{ role: 'chat-left' }, { role: 'chat-right' }]);
    hosts.forEach(({ element }) => POINTER_EVENTS.forEach((eventName) => {
      assert.equal(element.listenerCount(eventName), 0, 'native host owns no ' + eventName + ' listener');
    }));
    assert.equal(documentRef.listenerCount('visibilitychange'), 1);
    assert.equal(reducedMotionQuery.listenerCount(), 1);
    assert.equal(windowRef.listenerCount('focus'), 1);
    assert.equal(windowRef.listenerCount('blur'), 1);
    assert.equal(ResizeObserverRef.getActiveCount(), 0);

    click(controller, 50, 50, { timeStamp: 0 });
    controller.dispose();
    assert.equal(raf.size, 0);
    assert.equal(documentRef.listenerCount('visibilitychange'), 0);
    assert.equal(reducedMotionQuery.listenerCount(), 0);
    assert.equal(windowRef.listenerCount('focus'), 0);
    assert.equal(windowRef.listenerCount('blur'), 0);
    assert.equal(ResizeObserverRef.getActiveCount(), 0);
    hosts.forEach(({ element }) => assert.equal(element.children.length, 0));

    const before = inspect(controller);
    assert.doesNotThrow(() => controller.dispose());
    controller.handleInput(inputPayload({ localX: 999 }));
    assert.deepEqual(inspect(controller), before, 'public methods are inert after dispose');
    assert.equal(before.disposed, true);
  });
});

// ---- frame budget and DPR -------------------------------------------------

test('frame budget: ~30fps at idle, every tick while the pointer is active, capped again when unfocused', () => {
  withAtomic({}, ({ controller, raf, contexts, windowRef }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);

    let before = paintCount(contexts);
    flushTicks(raf, 20);
    const idlePaints = paintCount(contexts) - before;
    assert.ok(idlePaints >= 9 && idlePaints <= 11, 'idle paints roughly every other 16ms tick (got ' + idlePaints + ')');
    assert.equal(raf.size, 1, 'the breathing loop stays alive between budgeted paints');

    controller.handleInput(inputPayload({ sceneX: 150, sceneY: 150 }));
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
  });
});

test('frame budget: a live ring holds full rate until it and its flares expire, then the loop drops back to idle', () => {
  withAtomic({}, ({ controller, raf, contexts }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    click(controller, 150, 150, { timeStamp: raf.now });
    let before = paintCount(contexts);
    flushTicks(raf, 10);
    assert.equal(paintCount(contexts) - before, 10, 'a live ring paints every tick');
    flushTicks(raf, 200);
    assert.equal(entryFor(controller).waveCount, 0);
    assert.equal(entryFor(controller).flareCount, 0);
    before = paintCount(contexts);
    flushTicks(raf, 20);
    assert.ok(paintCount(contexts) - before <= 11, 'the settled field is back on the idle budget');
    controller.dispose();
  });
});

test('a DPR-only change re-backs the canvas on the next painted frame', () => {
  const windowRef = makeFakeWindow(1);
  withAtomic({ windowRef }, ({ controller, raf, contexts }) => {
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
  withAtomic({ windowRef, reducedMotion: true }, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    const canvas = host.element.children[0];
    assert.equal(canvas.width, 300);
    windowRef.devicePixelRatio = 1.5;
    controller.handleInput(inputPayload({ sceneX: 120, sceneY: 120 }));
    assert.equal(canvas.width, 450, 'the static repaint follows the new device pixel ratio');
    controller.dispose();
  });
});
