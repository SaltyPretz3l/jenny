// FROZEN RED-FIRST: Atomic Burst native contractVersion-3 suite
// (Background Effects v3 packet S7). Legacy pure-field coverage remains in
// renderer-atomic-burst-utils.test.js.

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

const EFFECT_ID = 'atomic-burst';
const POINTER_EVENTS = [
  'pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup',
  'pointercancel', 'mousemove', 'mousedown', 'mouseup', 'click',
];

function augmentCanvasContexts(documentRef) {
  const createElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag) => {
    const element = createElement(tag);
    if (String(tag).toLowerCase() !== 'canvas') { return element; }
    const getContext = element.getContext.bind(element);
    let contextResolved = false;
    let cachedContext = null;
    element.getContext = (...args) => {
      if (contextResolved) { return cachedContext; }
      const ctx = getContext(...args);
      contextResolved = true;
      cachedContext = ctx;
      if (!ctx) { return null; }
      if (typeof ctx.closePath !== 'function') { ctx.closePath = () => {}; }
      if (typeof ctx.rotate !== 'function') { ctx.rotate = () => {}; }
      return ctx;
    };
    return element;
  };
}

function createCoreCanvasRecorder() {
  const operations = [];
  let currentArc = null;
  const ctx = {
    globalAlpha: 1,
    lineWidth: 1,
    shadowBlur: 0,
    shadowColor: '',
    strokeStyle: '',
    fillStyle: '',
    save() {}, restore() {}, setTransform() {}, clearRect() {},
    translate() {}, rotate() {}, scale() {}, beginPath() { currentArc = null; },
    moveTo() {}, lineTo() {}, closePath() {},
    arc(x, y, radius) { currentArc = { x, y, radius }; },
    fill() {
      operations.push({
        type: 'fill', arc: currentArc, fillStyle: this.fillStyle,
        globalAlpha: this.globalAlpha, shadowBlur: this.shadowBlur,
      });
    },
    stroke() {
      operations.push({
        type: 'stroke', arc: currentArc, strokeStyle: this.strokeStyle,
        lineWidth: this.lineWidth, globalAlpha: this.globalAlpha,
        shadowBlur: this.shadowBlur, shadowColor: this.shadowColor,
      });
    },
  };
  return { ctx, operations };
}

function makeCoreEntry(simulation, recorder, configOverrides = {}) {
  return {
    canvas: {},
    ctx: recorder.ctx,
    w: 100,
    h: 100,
    dpr: 1,
    simulation,
    config: Object.assign({
      baseSize: 14,
      density: 6.2,
      colorA: 'color-a',
      colorB: 'color-b',
      colorC: 'color-c',
      flareColor: 'flare',
      linkColor: 'link',
      waveColor: 'wave',
      bloom: 1,
      linkRadius: 100,
      linkMax: 6,
      waveSpeed: 100,
      waveLifetime: 1000,
    }, configOverrides),
  };
}

function makeEnv({
  reducedMotion = false,
  rendererLaunchSeed = 4242,
  documentOptions = {},
  sceneRole,
} = {}) {
  const documentRef = makeFixtureDocumentRef(documentOptions);
  augmentCanvasContexts(documentRef);
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const reportCalls = [];
  const controller = atomicBurstUtils.createAtomicBurstController({
    effectId: EFFECT_ID,
    documentRef,
    reducedMotionQuery,
    runtime,
    rendererLaunchSeed,
    sceneRole,
    report: (fault) => reportCalls.push(fault),
  });
  return { documentRef, reducedMotionQuery, controller, reportCalls };
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

function setStreaming(controller, overrides = {}) {
  controller.setActivity(Object.assign({
    scopeEpoch: 1,
    phase: 'streaming',
    phaseRevision: 1,
    targetEnergy: 0.46,
    attentionScale: 1,
  }, overrides));
}

test('factory exposes native-v3 API, context reconciliation, staged reveal, and status', () => {
  withAtomic({}, ({ controller, raf }) => {
    ['bind', 'refresh', 'dispose', 'handleInput', 'setActivity', 'handleActivityImpulse', 'getStatus']
      .forEach((method) => assert.equal(typeof controller[method], 'function', method + ' is present'));

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

test('null 2d contexts are removed and zero-sized hosts stay dormant', () => {
  withAtomic({ documentOptions: { nullContext: true } }, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.equal(host.element.children.length, 0);
    assert.equal(controller.getStatus().state, 'dormant');
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

test('normalized manager input promotes scene coordinates into the shared simulation without layout reads', () => {
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

test('click waves use a fixed four-slot pool and evict the oldest origin', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    [10, 20, 30, 40, 50].forEach((x, index) => controller.handleInput(inputPayload({
      type: 'click', localX: x, localY: 60, sceneX: x, timeStamp: 20 + index,
    })));
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

test('core preserves eased wave expansion, dual bloom rings, particle gate, and line-distance falloff', () => {
  const earlyState = atomicBurstCore.createSimulationState();
  const earlyRecorder = createCoreCanvasRecorder();
  const earlyEntry = makeCoreEntry(earlyState, earlyRecorder);
  atomicBurstCore.spawnWave(earlyState, {
    x: 50, y: 50, startTime: 0, config: earlyEntry.config,
    sceneSeed: 1, makeRng: () => () => 0, kind: 'complete',
  });
  atomicBurstCore.drawFrame(earlyEntry, {
    timestamp: 1, dtMs: 1, reducedMotion: false,
    activityBrightnessScale: 1, sceneWidth: 100, sceneHeight: 100,
  });
  assert.equal(
    earlyRecorder.operations.filter((operation) => operation.type === 'fill').length,
    1,
    'sub-four-pixel wave draws the inner flash but gates particle dust',
  );

  const waveState = atomicBurstCore.createSimulationState();
  const waveRecorder = createCoreCanvasRecorder();
  const waveEntry = makeCoreEntry(waveState, waveRecorder);
  atomicBurstCore.spawnWave(waveState, {
    x: 50, y: 50, startTime: 0, config: waveEntry.config,
    sceneSeed: 1, makeRng: () => () => 0, kind: 'complete',
  });
  atomicBurstCore.drawFrame(waveEntry, {
    timestamp: 250, dtMs: 80, reducedMotion: false,
    activityBrightnessScale: 1, sceneWidth: 100, sceneHeight: 100,
  });
  const rings = waveRecorder.operations.filter((operation) => operation.type === 'stroke');
  assert.equal(rings.length, 2, 'wave renders a soft halo plus a crisp leading ring');
  assert.equal(rings[0].strokeStyle, 'wave');
  assert.equal(rings[1].strokeStyle, 'flare');
  assert.ok(rings[0].lineWidth > rings[1].lineWidth, 'halo is broader than the leading ring');
  assert.ok(rings[0].shadowBlur > rings[1].shadowBlur && rings[1].shadowBlur > 0);
  const expectedRadius = (1 - Math.pow(0.75, 2.4)) * 100;
  assert.ok(Math.abs(rings[0].arc.radius - expectedRadius) < 0.001, 'radius follows the legacy ease-out curve');
  assert.equal(
    waveRecorder.operations.filter((operation) => operation.type === 'fill').length,
    10,
    'mature wave draws the bounded ten-particle leading-edge dust',
  );

  const linkState = atomicBurstCore.createSimulationState();
  linkState.pointer = { active: true, x: 0, y: 0, sceneX: 0, sceneY: 0 };
  linkState.sparkles = [
    { x: 10, y: 0, depth: 0 },
    { x: 50, y: 0, depth: 0 },
  ];
  linkState.sparklesByDepth = [[], [], []];
  const linkRecorder = createCoreCanvasRecorder();
  atomicBurstCore.drawFrame(makeCoreEntry(linkState, linkRecorder, { linkMax: 2 }), {
    timestamp: 0, dtMs: 0, reducedMotion: true, activityBrightnessScale: 1,
  });
  const linkStroke = linkRecorder.operations.find((operation) => operation.type === 'stroke');
  const cursorFalloff = 1 - Math.sqrt((100 + 2500) * 0.5) / 100;
  const distanceFalloff = 1 - 40 / 70;
  const expectedAlpha = cursorFalloff * cursorFalloff * distanceFalloff * 0.55;
  assert.ok(Math.abs(linkStroke.globalAlpha - expectedAlpha) < 0.000001);
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

test('activity snapshots are replay-safe and streaming adds only a restrained brightness pulse', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setStreaming(controller, { scopeEpoch: 4 });
    raf.flush(180);
    const snapshot = inspect(controller);
    assert.equal(snapshot.scopeEpoch, 4);
    assert.equal(snapshot.phase, 'streaming');
    assert.equal(snapshot.entries[0].waveCount, 0, 'snapshot changes never synthesize a gesture');
    assert.ok(snapshot.activityBrightnessScale >= 1);
    assert.ok(snapshot.activityBrightnessScale <= 1.15, 'streaming pulse stays restrained');
    controller.dispose();
  });
});

test('only a current-epoch complete impulse creates a centered completion sweep; cancel clears motion', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setStreaming(controller, { scopeEpoch: 8 });
    controller.handleActivityImpulse({ scopeEpoch: 7, sequence: 1, kind: 'complete', timeStamp: 30 });
    assert.equal(entryFor(controller).waveCount, 0, 'stale complete is ignored');

    controller.handleActivityImpulse({ scopeEpoch: 8, sequence: 2, kind: 'complete', timeStamp: 31 });
    let entry = entryFor(controller);
    assert.equal(entry.waveCount, 1);
    assert.deepEqual(entry.waveOrigins[0], { x: 150, y: 150, kind: 'complete' });

    controller.handleInput(inputPayload({ localX: 33, localY: 44 }));
    controller.handleActivityImpulse({ scopeEpoch: 8, sequence: 3, kind: 'cancel', timeStamp: 40 });
    entry = entryFor(controller);
    assert.equal(entry.waveCount, 0);
    assert.equal(entry.pointerActive, false);
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

test('split gutters render one wide scene field and filter deterministic spawn-avoidance regions', () => {
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
    assert.ok(filtered.sparkleCount < baseline.sparkleCount);
    assert.ok(filtered.sparkleSample.every(([x, y]) => !(
      x >= blockedRect.left && x <= blockedRect.left + blockedRect.width
      && y >= blockedRect.top && y <= blockedRect.top + blockedRect.height
    )));
    controller.dispose();
  });
});

test('one shared frame advances once while both gutter viewports paint the same scene state', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }, { role: 'chat-right' }]);
    const before = entryFor(controller, 'chat-left').drawCount;
    raf.flush(16);
    const left = entryFor(controller, 'chat-left');
    const right = entryFor(controller, 'chat-right');
    assert.equal(left.drawCount, before + 1, 'shared simulation advances once for the rAF');
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
    raf.flush(17);

    assert.ok(entryFor(controller).drawCount > before, 'occlusion does not pause scene simulation');
    assert.ok(clears.length >= 2, 'the frame clear and projected occlusion clear both execute');
    assert.ok(clears.some((args) => args[0] === 0 && args[1] === 0
      && args[2] === rect.width && args[3] === rect.height));
    controller.dispose();
  });
});

test('long gaps clear transient waves without catch-up and hidden/detached entries do no work', () => {
  withAtomic({}, ({ controller, raf, documentRef }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput(inputPayload({ type: 'click', localX: 90, localY: 90 }));
    raf.flush(600);
    assert.equal(entryFor(controller).waveCount, 0, 'a visible >500ms gap directly clears transient waves');

    controller.handleInput(inputPayload({ type: 'click', localX: 90, localY: 90 }));
    const before = entryFor(controller).drawCount;

    documentRef.hidden = true;
    documentRef.fire('visibilitychange');
    raf.flush(32);
    assert.equal(entryFor(controller).drawCount, before, 'hidden documents do not draw');
    documentRef.hidden = false;
    documentRef.fire('visibilitychange');
    raf.flush(1000);
    assert.equal(entryFor(controller).waveCount, 0, 'long-gap resume clears waves instead of fast-forwarding');

    host.element.isConnected = false;
    const detachedDraws = entryFor(controller).drawCount;
    raf.flush(16);
    assert.equal(entryFor(controller).drawCount, detachedDraws, 'detached hosts do not draw');
    controller.dispose();
  });
});

test('cancel clears all hosts before role lookup, including a mismatched synthetic role', () => {
  withAtomic({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'home' }], { surface: 'home' });
    controller.handleInput(inputPayload({
      type: 'move', surfaceRole: 'home', localX: 30, localY: 40,
    }));
    controller.handleInput(inputPayload({
      type: 'click', surfaceRole: 'home', localX: 50, localY: 60,
    }));
    assert.equal(entryFor(controller, 'home').waveCount, 1);
    assert.equal(entryFor(controller, 'home').pointerActive, true);

    controller.handleInput(inputPayload({ type: 'cancel', surfaceRole: 'synthetic-missing-role' }));
    const entry = entryFor(controller, 'home');
    assert.equal(entry.waveCount, 0);
    assert.equal(entry.pointerActive, false);
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

test('reduced motion suppresses waves and continuous animation while retaining static pointer focus', () => {
  withAtomic({}, ({ controller, raf, reducedMotionQuery }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput(inputPayload({ type: 'click' }));
    assert.equal(entryFor(controller).waveCount, 1);
    reducedMotionQuery.simulateChange(true);
    assert.equal(entryFor(controller).waveCount, 0);
    assert.equal(raf.size, 0);

    controller.handleInput(inputPayload({ type: 'click', localX: 200 }));
    controller.handleInput(inputPayload({ localX: 33, localY: 44, sceneX: 333, sceneY: 144 }));
    assert.equal(entryFor(controller).waveCount, 0);
    assert.equal(entryFor(controller).pointerX, 333);
    assert.equal(raf.size, 0);
    controller.dispose();
  });
});

test('draw faults are contained and reported through the runtime fault seam', () => {
  withAtomic({ documentOptions: { throwOnDraw: true } }, ({ controller, raf, reportCalls }) => {
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
    controller, raf, documentRef, reducedMotionQuery, ResizeObserverRef,
  }) => {
    const hosts = bindAndPrime(controller, raf, [{ role: 'chat-left' }, { role: 'chat-right' }]);
    hosts.forEach(({ element }) => POINTER_EVENTS.forEach((eventName) => {
      assert.equal(element.listenerCount(eventName), 0, 'native host owns no ' + eventName + ' listener');
    }));
    assert.equal(documentRef.listenerCount('visibilitychange'), 1);
    assert.equal(reducedMotionQuery.listenerCount(), 1);
    assert.equal(ResizeObserverRef.getActiveCount(), 0);

    setStreaming(controller, { scopeEpoch: 5 });
    controller.handleActivityImpulse({ scopeEpoch: 5, sequence: 1, kind: 'complete', timeStamp: 0 });
    controller.dispose();
    assert.equal(raf.size, 0);
    assert.equal(documentRef.listenerCount('visibilitychange'), 0);
    assert.equal(reducedMotionQuery.listenerCount(), 0);
    assert.equal(ResizeObserverRef.getActiveCount(), 0);
    hosts.forEach(({ element }) => assert.equal(element.children.length, 0));

    const before = inspect(controller);
    assert.doesNotThrow(() => controller.dispose());
    controller.handleInput(inputPayload({ localX: 999 }));
    setStreaming(controller, { scopeEpoch: 6 });
    controller.handleActivityImpulse({ scopeEpoch: 6, sequence: 2, kind: 'complete', timeStamp: 1 });
    assert.deepEqual(inspect(controller), before, 'public methods are inert after dispose');
    assert.equal(before.disposed, true);
  });
});
