// FROZEN RED-FIRST: Reactive Grid native contractVersion-3 suite
// (Background Effects v3 packet S6). Production work must satisfy these
// contracts without editing this file. The legacy/pure rendering coverage
// remains in renderer-reactive-grid-utils.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const reactiveGridUtils = require('../renderer/shell/renderer-reactive-grid-utils.js');
const reactiveGridCore = require('../renderer/shell/renderer-reactive-grid-core.js');
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

const EFFECT_ID = 'reactive-grid';
const IMPULSE_CAPACITY = 4;
const POINTER_EVENTS = [
  'pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup',
  'pointercancel', 'mousemove', 'mousedown', 'mouseup', 'click',
];

function makeEnv({
  reducedMotion = false,
  rendererLaunchSeed = 4242,
  documentOptions = {},
  sceneRole,
} = {}) {
  const documentRef = makeFixtureDocumentRef(documentOptions);
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const reportCalls = [];
  const controller = reactiveGridUtils.createReactiveGridController({
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

function setActivity(controller, overrides = {}) {
  controller.setActivity(Object.assign({
    scopeEpoch: 1,
    phase: 'streaming',
    phaseRevision: 1,
    targetEnergy: 0.46,
    attentionScale: 1,
  }, overrides));
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

function click(controller, x, y = 100) {
  controller.handleInput(movePayload({
    type: 'click',
    localX: x,
    localY: y,
    sceneX: x,
    sceneY: y,
  }));
}

test('factory exposes the complete native-v3 API and accepts an immutable context with staged reveal', () => {
  withGrid({}, ({ controller, raf }) => {
    ['bind', 'refresh', 'dispose', 'handleInput', 'setActivity', 'handleActivityImpulse', 'getStatus']
      .forEach((method) => assert.equal(typeof controller[method], 'function', method + ' is present'));

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

test('bind-of-bound reconciles context hosts and getStatus distinguishes dormant from drawable', () => {
  withGrid({}, ({ controller, raf }) => {
    const [first] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    const zero = makeHostSpec('chat-right', { left: 300, top: 0, width: 0, height: 0 });
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
  withGrid({ documentOptions: { nullContext: true } }, ({ controller, raf }) => {
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

test('activity snapshots drive preflight inward response and streaming amplitude without one-shot replay', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setActivity(controller, {
      scopeEpoch: 4, phase: 'preflight', phaseRevision: 1, targetEnergy: 0.28,
    });
    let snapshot = inspect(controller);
    assert.equal(snapshot.scopeEpoch, 4);
    assert.equal(snapshot.phase, 'preflight');
    assert.equal(snapshot.phaseRippleDirection, 'inward');
    assert.equal(snapshot.entries[0].impulseCount, 0, 'replayable snapshots never synthesize a one-shot impulse');

    setActivity(controller, {
      scopeEpoch: 4, phase: 'streaming', phaseRevision: 2, targetEnergy: 0.46,
    });
    snapshot = inspect(controller);
    assert.equal(snapshot.phase, 'streaming');
    const expectedScale = 1 + (0.46 - 0.08) * 0.70;
    assert.ok(Math.abs(snapshot.activityAmplitudeScale - expectedScale) < 1e-9,
      'streaming amplitude pins the 0.70-gain formula (delight pass 2026-07-22)');
    assert.ok(snapshot.activityAmplitudeScale <= 1.35, 'streaming amplitude stays visibly gentle');
    assert.equal(snapshot.entries[0].impulseCount, 0, 'phase change itself remains replay-safe');
    controller.dispose();
  });
});

test('current-epoch complete creates an outward settling wave; stale epoch is ignored and cancel damps all motion', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setActivity(controller, { scopeEpoch: 8 });
    click(controller, 120);
    assert.equal(entryFor(controller).impulseCount, 1);

    controller.handleActivityImpulse({
      scopeEpoch: 7, sequence: 1, kind: 'complete', timeStamp: 30,
    });
    assert.equal(entryFor(controller).impulseCount, 1, 'stale scopeEpoch cannot create a settling wave');

    controller.handleActivityImpulse({
      scopeEpoch: 8, sequence: 2, kind: 'complete', timeStamp: 31,
    });
    let entry = entryFor(controller);
    assert.equal(entry.impulseCount, 2, 'current complete adds exactly one automatic wave');
    assert.equal(entry.impulseOrigins.at(-1).kind, 'complete');
    assert.equal(entry.impulseOrigins.at(-1).direction, 'outward');

    controller.handleInput(movePayload({ localX: 200, sceneX: 200, timeStamp: 40 }));
    controller.handleInput(movePayload({ localX: 240, sceneX: 240, timeStamp: 56 }));
    raf.flush(16);
    controller.handleActivityImpulse({
      scopeEpoch: 8, sequence: 3, kind: 'cancel', timeStamp: 60,
    });
    entry = entryFor(controller);
    assert.equal(entry.impulseCount, 0, 'cancel clears click and lifecycle waves');
    assert.equal(entry.pointerActive, false, 'cancel clears pointer attraction');
    assert.equal(entry.pointerVelocityX, 0, 'cancel damps horizontal pointer velocity');
    assert.equal(entry.pointerVelocityY, 0, 'cancel damps vertical pointer velocity');
    assert.equal(entry.maxAbsDotVelocity, 0, 'cancel settles the dot field instead of celebrating completion');
    controller.dispose();
  });
});

function makeCoreEntry() {
  const config = {
    cellSize: 24, hitRadius: 192, strength: 1, idleAmplitude: 0.42, motionScale: 1,
    friction: 0.86, springK: 0.04, pushStrength: 0.9, glowBlur: 14, glowCurve: 3,
    fadeRiseMs: 240, fadeDecayMs: 520, breathAmplitude: 0.05,
    idleColor: 'rgba(157, 197, 255, 0.18)', activeColor: 'rgba(160, 230, 255, 0.96)',
    glowColor: 'rgba(155, 170, 255, 0.42)',
  };
  const simulation = reactiveGridCore.createSimulationState();
  const geometry = reactiveGridCore.resolveGridGeometry(240, 240, 24, reactiveGridCore.MAX_GRID_DOTS);
  reactiveGridCore.rebuildField(simulation, geometry, 42, runtime.makeRng);
  return { simulation, config, w: 240, h: 240, seed: 42 };
}

function coreEnv(extra = {}) {
  return Object.assign({
    timestamp: 1000, dtMs: 16.7, longGap: false, reducedMotion: false, phase: 'idle',
    activityAmplitudeScale: 1, attentionScale: 1,
  }, extra);
}

test('complete blooms briefly when its impulse lands; time and cancel both clear it', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setActivity(controller, { scopeEpoch: 5 });
    controller.handleActivityImpulse({ scopeEpoch: 5, sequence: 1, kind: 'complete', timeStamp: 20 });
    assert.equal(entryFor(controller).bloomActive, true, 'an accepted complete arms the bloom');
    for (let i = 0; i < 12; i += 1) { raf.flush(80); }
    assert.equal(entryFor(controller).bloomActive, false, 'the bloom decays inside its 600ms window');
    controller.handleActivityImpulse({ scopeEpoch: 5, sequence: 2, kind: 'complete', timeStamp: raf.now });
    assert.equal(entryFor(controller).bloomActive, true);
    controller.handleActivityImpulse({ scopeEpoch: 5, sequence: 3, kind: 'cancel', timeStamp: raf.now });
    assert.equal(entryFor(controller).bloomActive, false, 'cancel clears the bloom with the rest of the motion');
    controller.dispose();
  });
});

test('a center-blocked complete never arms the bloom', () => {
  withGrid({}, ({ controller, raf }) => {
    const rect = { left: 100, top: 40, width: 300, height: 300 };
    bindAndPrime(controller, raf, [{ role: 'chat-left', rect }], {
      sceneRect: rect,
      hostRects: [rect],
      spawnAvoidanceRects: [{ left: 240, top: 180, width: 20, height: 20 }],
    });
    setActivity(controller, { scopeEpoch: 4 });
    controller.handleActivityImpulse({ scopeEpoch: 4, sequence: 1, kind: 'complete', timeStamp: 30 });
    const entry = entryFor(controller);
    assert.equal(entry.impulseCount, 0);
    assert.equal(entry.bloomActive, false, 'no impulse, no bloom');
    controller.dispose();
  });
});

test('the traveling wave and idle tint engage under streaming and terminate through settling alone', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    let snapshot = inspect(controller);
    assert.equal(snapshot.streamEnvelope, 0);
    assert.equal(snapshot.waveStrength, 0);
    assert.equal(snapshot.tintActive, false);
    setActivity(controller, { scopeEpoch: 2 });
    for (let i = 0; i < 30; i += 1) { raf.flush(50); }
    snapshot = inspect(controller);
    assert.equal(snapshot.streamEnvelope, 1);
    assert.ok(snapshot.waveStrength > 0.5, 'streaming energy drives the wave');
    assert.equal(snapshot.tintActive, true, 'sustained streaming warms the idle ramp');
    setActivity(controller, { scopeEpoch: 2, phase: 'settling', phaseRevision: 2, targetEnergy: 0.18 });
    for (let i = 0; i < 40; i += 1) { raf.flush(50); }
    snapshot = inspect(controller);
    assert.equal(snapshot.streamEnvelope, 0,
      'settling terminates the envelope by phase (energy alone never decays to idle)');
    assert.equal(snapshot.waveStrength, 0);
    assert.equal(snapshot.tintActive, false);
    controller.dispose();
  });
});

test('reduced-motion and scope transitions cannot resurrect wave, tint, or bloom', () => {
  withGrid({}, ({ controller, raf, reducedMotionQuery }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setActivity(controller, { scopeEpoch: 6 });
    for (let i = 0; i < 30; i += 1) { raf.flush(50); }
    assert.equal(inspect(controller).streamEnvelope, 1);
    reducedMotionQuery.simulateChange(true);
    assert.equal(inspect(controller).streamEnvelope, 0, 'entering reduced motion clears the envelope');
    setActivity(controller, { scopeEpoch: 6, phase: 'settling', phaseRevision: 2, targetEnergy: 0.18 });
    reducedMotionQuery.simulateChange(false);
    raf.flush(16);
    const snapshot = inspect(controller);
    assert.equal(snapshot.streamEnvelope, 0, 'settling after a blind stretch does not resume the wave');
    assert.equal(snapshot.tintActive, false);
    controller.dispose();
  });
});

test('failed phases and scope changes clear an armed bloom', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setActivity(controller, { scopeEpoch: 7 });
    controller.handleActivityImpulse({ scopeEpoch: 7, sequence: 1, kind: 'complete', timeStamp: 20 });
    assert.equal(entryFor(controller).bloomActive, true);
    setActivity(controller, { scopeEpoch: 7, phase: 'failed', phaseRevision: 2, targetEnergy: 0.04 });
    assert.equal(entryFor(controller).bloomActive, false, 'failed hushes the bloom quietly');
    setActivity(controller, { scopeEpoch: 7, phase: 'streaming', phaseRevision: 3 });
    controller.handleActivityImpulse({ scopeEpoch: 7, sequence: 2, kind: 'complete', timeStamp: 40 });
    assert.equal(entryFor(controller).bloomActive, true);
    setActivity(controller, { scopeEpoch: 8 });
    assert.equal(entryFor(controller).bloomActive, false, 'a new scope never inherits a bloom');
    controller.dispose();
  });
});

test('reduced motion zeroes wave, tint, and bloom', () => {
  withGrid({ reducedMotion: true }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setActivity(controller, { scopeEpoch: 3 });
    const snapshot = inspect(controller);
    assert.equal(snapshot.waveStrength, 0);
    assert.equal(snapshot.tintActive, false);
    controller.handleActivityImpulse({ scopeEpoch: 3, sequence: 1, kind: 'complete', timeStamp: 20 });
    assert.equal(entryFor(controller).bloomActive, false, 'reduced motion never arms the bloom');
    controller.dispose();
  });
});

test('the streaming tint warms the idle ramp entry in RGB only, holding effective idle alpha', () => {
  const config = { idleColor: 'rgba(157, 197, 255, 0.18)', activeColor: 'rgba(160, 230, 255, 0.96)' };
  const base = reactiveGridCore.ensureFrameColors(config);
  const tinted = reactiveGridCore.ensureTintFrameColors(config);
  assert.notEqual(tinted[0], base[0], 'the idle entry is warmed');
  for (let i = 1; i < base.length; i += 1) {
    assert.equal(tinted[i], base[i], 'active ramp entries are untouched');
  }
  const alphaOf = (rgba) => Number(/([\d.]+)\)$/.exec(rgba)[1]);
  assert.equal(alphaOf(tinted[0]), alphaOf(base[0]),
    'effective idle alpha is unchanged by the tint (color-temperature only)');
  const tintedFrame = reactiveGridCore.advanceFrame(makeCoreEntry(), coreEnv({ tintActive: true }));
  const plainFrame = reactiveGridCore.advanceFrame(makeCoreEntry(), coreEnv({}));
  assert.notEqual(tintedFrame.frameColors[0], plainFrame.frameColors[0]);
});

test('the streaming wave rides on radius with a bounded gain and vanishes at zero strength', () => {
  const calm = makeCoreEntry();
  const wavy = makeCoreEntry();
  reactiveGridCore.advanceFrame(calm, coreEnv({ waveStrength: 0 }));
  reactiveGridCore.advanceFrame(wavy, coreEnv({ waveStrength: 1 }));
  let maxDiff = 0;
  for (let i = 0; i < calm.simulation.dotCount; i += 1) {
    maxDiff = Math.max(maxDiff, wavy.simulation.dotRadius[i] - calm.simulation.dotRadius[i]);
  }
  assert.ok(maxDiff > 0.1, 'full wave strength visibly lifts crest radii');
  assert.ok(maxDiff <= 0.35, 'the radius term stays a shimmer, not a bulge');
  const reduced = makeCoreEntry();
  reactiveGridCore.advanceFrame(reduced, coreEnv({ waveStrength: 1, reducedMotion: true }));
  for (let i = 0; i < reduced.simulation.dotCount; i += 1) {
    assert.ok(Math.abs(reduced.simulation.dotRadius[i] - 1.2) < 1e-6,
      'reduced motion pins the base radius regardless of wave strength');
  }
});

test('preflight strength deepens the inward gather and dims the frame deterministically', () => {
  const still = makeCoreEntry();
  const strong = makeCoreEntry();
  const preflight = (extra) => coreEnv(Object.assign({ phase: 'preflight' }, extra));
  let dimless = null, dimmed = null;
  for (let i = 0; i < 40; i += 1) {
    const timestamp = 1000 + i * 16.7;
    dimless = reactiveGridCore.advanceFrame(still, preflight({ preflightStrength: 0, timestamp }));
    dimmed = reactiveGridCore.advanceFrame(strong, preflight({ preflightStrength: 1, timestamp }));
  }
  assert.equal(dimless.dim, 1);
  assert.ok(Math.abs(dimmed.dim - 0.94) < 1e-9, 'full preflight dims draw output to 94%');
  const maxDisplacement = (sim) => {
    let max = 0;
    for (let i = 0; i < sim.dotCount; i += 1) {
      max = Math.max(max, Math.hypot(sim.dotDx[i], sim.dotDy[i]));
    }
    return max;
  };
  const stillPull = maxDisplacement(still.simulation);
  const strongPull = maxDisplacement(strong.simulation);
  assert.equal(stillPull, 0, 'zero-strength preflight exerts no pull at all');
  assert.ok(strongPull > 1, 'full preflight strength escapes rest and visibly gathers the field');
  assert.ok(strongPull < 8, 'the gather stays a hold, not a collapse toward center');
  [50, 80].forEach((frameMs) => {
    const dead = makeCoreEntry();
    for (let i = 0; i < 40; i += 1) {
      reactiveGridCore.advanceFrame(dead, preflight({
        preflightStrength: 0, dtMs: frameMs, timestamp: 1000 + i * frameMs,
      }));
    }
    assert.equal(maxDisplacement(dead.simulation), 0,
      'zero strength stays at rest even at ' + frameMs + 'ms frame deltas');
  });
  const trough = makeCoreEntry();
  for (let i = 0; i < 40; i += 1) {
    reactiveGridCore.advanceFrame(trough, preflight({ preflightStrength: 1, timestamp: i * 16.7 }));
  }
  assert.ok(maxDisplacement(trough.simulation) > 0.3,
    'full strength gathers at 60Hz even when the pulse starts in its sine trough');
});

test('failed activity damps an already-moving field while energy approaches the snapshot target', () => {
  withGrid({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    setActivity(controller, { scopeEpoch: 3, targetEnergy: 0.46 });
    controller.handleInput(movePayload({ localX: 80, sceneX: 80, timeStamp: 10 }));
    controller.handleInput(movePayload({ localX: 220, sceneX: 220, timeStamp: 26 }));
    raf.flush(16);
    const moving = entryFor(controller).maxAbsDotVelocity;
    assert.ok(moving > 0, 'fixture has actual motion before failed damping is asserted');

    setActivity(controller, {
      scopeEpoch: 3, phase: 'failed', phaseRevision: 2, targetEnergy: 0.04,
    });
    raf.flush(16);
    const snapshot = inspect(controller);
    assert.equal(snapshot.phase, 'failed');
    assert.equal(snapshot.targetEnergy, 0.04);
    assert.ok(snapshot.currentEnergy > snapshot.targetEnergy, 'energy approaches rather than snaps to the target');
    assert.ok(snapshot.entries[0].maxAbsDotVelocity < moving, 'failed state damps the existing velocity field');
    controller.dispose();
  });
});

test('same launch seed and role reproduce the field, while a different launch seed diverges', () => {
  function capture(seed) {
    let captured;
    withGrid({ rendererLaunchSeed: seed }, ({ controller, raf }) => {
      bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
      const entry = entryFor(controller);
      captured = { seed: entry.seed, dotCount: entry.dotCount, dotPhaseSample: entry.dotPhaseSample };
      controller.dispose();
    });
    return captured;
  }

  const first = capture(777);
  const repeat = capture(777);
  assert.deepEqual(repeat, first, 'same rendererLaunchSeed|effectId|sceneRole reproduces the field');
  const other = capture(778);
  assert.notEqual(other.seed, first.seed, 'a different renderer launch seed changes the scene seed');
  assert.notDeepEqual(other.dotPhaseSample, first.dotPhaseSample, 'different seed changes primitive phases');
});

test('chat-left and chat-right share one scene seed; home remains a separate deterministic scene', () => {
  let chatSeed;
  withGrid({ rendererLaunchSeed: 909 }, ({ controller, raf }) => {
    const rect = { left: 0, top: 0, width: 300, height: 300 };
    bindAndPrime(controller, raf, [{ role: 'chat-left', rect }, { role: 'chat-right', rect }]);
    const left = entryFor(controller, 'chat-left');
    const right = entryFor(controller, 'chat-right');
    assert.equal(right.seed, left.seed, 'both gutters use sceneRole=chat, not per-host seeds');
    assert.deepEqual(right.dotPhaseSample, left.dotPhaseSample, 'equal-sized chat gutters start from the same field');
    chatSeed = left.seed;
    controller.dispose();
  });

  withGrid({ rendererLaunchSeed: 909 }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'home' }], { surface: 'home' });
    assert.notEqual(entryFor(controller, 'home').seed, chatSeed, 'home uses a separate sceneRole seed');
    controller.dispose();
  });
});

test('split gutters share one wide field and advance the scene exactly once per frame', () => {
  withGrid({ rendererLaunchSeed: 909 }, ({ controller, raf }) => {
    const leftRect = { left: 100, top: 40, width: 240, height: 300 };
    const rightRect = { left: 660, top: 40, width: 240, height: 300 };
    const sceneRect = { left: 100, top: 40, width: 800, height: 300 };
    bindAndPrime(controller, raf, [
      { role: 'chat-left', rect: leftRect },
      { role: 'chat-right', rect: rightRect },
    ], { sceneRect, hostRects: [leftRect, rightRect] });

    const expectedSceneCount = reactiveGridCore.resolveGridGeometry(
      sceneRect.width, sceneRect.height, 36, reactiveGridCore.MAX_GRID_DOTS,
    ).dotCount;
    const localCount = reactiveGridCore.resolveGridGeometry(
      leftRect.width, leftRect.height, 36, reactiveGridCore.MAX_GRID_DOTS,
    ).dotCount;
    const left = entryFor(controller, 'chat-left');
    const right = entryFor(controller, 'chat-right');
    assert.equal(left.dotCount, expectedSceneCount);
    assert.ok(left.dotCount > localCount, 'the field spans the hidden middle instead of duplicating a gutter');
    assert.deepEqual(right.dotPhaseSample, left.dotPhaseSample);

    const originalAdvance = reactiveGridCore.advanceFrame;
    let advanceCalls = 0;
    reactiveGridCore.advanceFrame = (...args) => {
      advanceCalls += 1;
      return originalAdvance(...args);
    };
    try {
      raf.flush(16);
    } finally {
      reactiveGridCore.advanceFrame = originalAdvance;
    }
    assert.equal(advanceCalls, 1, 'one scene tick paints both host viewports');
    controller.dispose();
  });
});

test('spawn avoidance rejects automatic and pointer impulse origins without emptying the scene', () => {
  withGrid({}, ({ controller, raf }) => {
    const rect = { left: 100, top: 40, width: 300, height: 300 };
    const blockedCenter = { left: 240, top: 180, width: 20, height: 20 };
    bindAndPrime(controller, raf, [{ role: 'chat-left', rect }], {
      sceneRect: rect,
      hostRects: [rect],
      spawnAvoidanceRects: [blockedCenter],
    });
    setActivity(controller, { scopeEpoch: 4 });
    controller.handleActivityImpulse({
      scopeEpoch: 4, sequence: 1, kind: 'complete', timeStamp: 30,
    });
    assert.equal(entryFor(controller).impulseCount, 0, 'blocked centered completion is skipped');

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
  withGrid({ documentOptions: { throwOnDraw: true } }, ({ controller, raf, reportCalls }) => {
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
    const hosts = bindAndPrime(controller, raf, [{ role: 'chat-left' }, { role: 'chat-right' }]);
    hosts.forEach(({ element }, index) => {
      POINTER_EVENTS.forEach((eventName) => {
        assert.equal(element.listenerCount(eventName), 0, 'host ' + index + ' has no own ' + eventName + ' listener');
      });
    });
    assert.equal(documentRef.listenerCount('visibilitychange'), 1, 'runtime visibility listener is bound once');
    assert.equal(reducedMotionQuery.listenerCount(), 1, 'runtime reduced-motion listener is bound once');
    assert.equal(ResizeObserverRef.getActiveCount(), 0, 'manager layout snapshots replace effect-owned observers');

    setActivity(controller, { scopeEpoch: 5 });
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
    setActivity(controller, { scopeEpoch: 6 });
    controller.handleActivityImpulse({ scopeEpoch: 6, sequence: 1, kind: 'complete', timeStamp: 0 });
    assert.deepEqual(inspect(controller), before, 'all public methods are inert after dispose');
    assert.equal(before.disposed, true);
  });
});
