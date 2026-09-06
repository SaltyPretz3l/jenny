// Circuit Trace -- native contractVersion-3 interactive-behavior suite
// (Background Effects v3 packet S5 slice W2). Exercises handleInput,
// setActivity, handleActivityImpulse, getStatus, and dispose against the
// REAL native controller (no jsdom -- these fakes are the same ones
// tests/helpers/surface-effect-conformance.js exports for real controllers
// elsewhere). See tests/renderer-circuit-trace-utils.test.js for core/pure
// geometry helpers and readStyles()-style token clamping.

const test = require('node:test');
const assert = require('node:assert/strict');

const circuitTraceUtils = require('../renderer/shell/renderer-circuit-trace-utils.js');
const circuitTraceCore = require('../renderer/shell/renderer-circuit-trace-core.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const {
  makeFixtureDocumentRef,
  createEffectMediaQueryList,
  createFakeResizeObserverClass,
  buildFixtureContext,
  withStubbedGlobals,
} = require('./helpers/surface-effect-conformance.js');
const { createRafHarness, makeFakeSurfaceElement } = require('./helpers/surface-effect-router-harness.js');

function stabilizeCanvasContexts(documentRef) {
  const createElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag) => {
    const element = createElement(tag);
    if (String(tag).toLowerCase() !== 'canvas') return element;
    const getContext = element.getContext.bind(element);
    let resolved = false;
    let cached = null;
    element.getContext = (...args) => {
      if (resolved) return cached;
      cached = getContext(...args);
      resolved = true;
      if (!cached) return null;
      cached.__clears = [];
      const clearRect = cached.clearRect.bind(cached);
      cached.clearRect = (...values) => { cached.__clears.push(values); clearRect(...values); };
      return cached;
    };
    return element;
  };
}

// ── shared harness ──────────────────────────────────────────────────────────

function makeEnv({ reducedMotion = false, rendererLaunchSeed = 4242, sceneRole } = {}) {
  const documentRef = makeFixtureDocumentRef();
  stabilizeCanvasContexts(documentRef);
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const reportCalls = [];
  const controller = circuitTraceUtils.createCircuitTraceController({
    effectId: 'circuit-trace',
    documentRef,
    reducedMotionQuery,
    runtime,
    rendererLaunchSeed,
    sceneRole,
    report: (fault) => reportCalls.push(fault),
  });
  return {
    documentRef, reducedMotionQuery, controller, reportCalls,
  };
}

// Runs `fn` inside a stubbed rAF + ResizeObserver global environment, the
// bare-global convention every S5 native controller shares (§3.1).
function withCircuit(envOpts, fn) {
  const raf = createRafHarness();
  const ResizeObserverRef = createFakeResizeObserverClass();
  withStubbedGlobals({ raf, ResizeObserverRef }, () => {
    const env = makeEnv(envOpts);
    fn(Object.assign({ raf, ResizeObserverRef }, env));
  });
}

function bindHosts(controller, specs, contextOverrides = {}) {
  const hosts = specs.map(({ rect, role }) => ({
    element: makeFakeSurfaceElement(rect || { left: 0, top: 0, width: 300, height: 300 }),
    role,
  }));
  controller.bind(buildFixtureContext(Object.assign({ hosts }, contextOverrides)));
  return hosts.map((h) => h.element);
}

// bind + one settled frame, so the frame clock's dt=0 priming frame is
// already consumed before a test starts asserting per-frame deltas.
function bindAndPrime(controller, raf, specs, contextOverrides) {
  const hosts = bindHosts(controller, specs, contextOverrides);
  raf.flush(16);
  return hosts;
}

function activate(controller, epoch, targetEnergy = 0.3) {
  controller.setActivity({
    scopeEpoch: epoch, phase: 'streaming', phaseRevision: 1, targetEnergy, attentionScale: 1,
  });
}

// ── hover / input plumbing ──────────────────────────────────────────────────

test('handleInput move sets exact pointerX/Y and raises pointerEnergy; an unknown role is a safe no-op', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput({
      type: 'move', surfaceRole: 'chat-left', localX: 40, localY: 50, sceneX: 440, sceneY: 150,
    });
    const entry = controller._internals.inspect().entries[0];
    assert.equal(entry.pointerX, 440);
    assert.equal(entry.pointerY, 150);
    assert.ok(entry.pointerEnergy > 0, 'pointer movement raises pointerEnergy');

    const before = controller._internals.inspect();
    controller.handleInput({ type: 'move', surfaceRole: 'chat-right', localX: 1, localY: 1 });
    assert.deepEqual(controller._internals.inspect(), before, 'input to a role with no tracked entry is a safe no-op');
    controller.dispose();
  });
});

test('handleInput never reads host layout (no getBoundingClientRect calls after bind)', () => {
  withCircuit({}, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    let calls = 0;
    const original = host.getBoundingClientRect;
    host.getBoundingClientRect = (...args) => { calls += 1; return original.apply(host, args); };
    controller.handleInput({ type: 'move', surfaceRole: 'chat-left', localX: 5, localY: 5 });
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 5, localY: 5 });
    controller.handleInput({ type: 'press', surfaceRole: 'chat-left', localX: 5, localY: 5 });
    controller.handleInput({ type: 'release', surfaceRole: 'chat-left' });
    assert.equal(calls, 0, 'handleInput must never read host layout (router-normalized payloads only, §3.3)');
    controller.dispose();
  });
});

// ── click waves + press/release charge ──────────────────────────────────────

test('a click spawns a wave; a fifth click evicts the oldest (MAX_WAVES=4 ring buffer)', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 10, localY: 10 });
    assert.equal(controller._internals.inspect().entries[0].waveCount, 1);
    for (let i = 0; i < 4; i += 1) {
      controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 10 + i, localY: 10 });
    }
    assert.equal(controller._internals.inspect().entries[0].waveCount, 4, 'five total clicks cap at MAX_WAVES=4');
    controller.dispose();
  });
});

test('press charges over time (strictly increasing, < 1); release discharges a wave and raises pointerEnergy', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput({ type: 'press', surfaceRole: 'chat-left', localX: 20, localY: 20 });
    let entry = controller._internals.inspect().entries[0];
    assert.equal(entry.chargeActive, true);
    assert.equal(entry.chargeValue, 0);

    let previous = 0;
    for (let i = 0; i < 5; i += 1) {
      raf.flush(50);
      entry = controller._internals.inspect().entries[0];
      assert.ok(entry.chargeValue > previous, `chargeValue should strictly increase on frame ${i}`);
      assert.ok(entry.chargeValue < 1, 'chargeValue never reaches 1');
      previous = entry.chargeValue;
    }

    const pointerEnergyBefore = entry.pointerEnergy;
    const waveCountBefore = entry.waveCount;
    controller.handleInput({ type: 'release', surfaceRole: 'chat-left' });
    entry = controller._internals.inspect().entries[0];
    assert.equal(entry.chargeActive, false);
    assert.equal(entry.waveCount, waveCountBefore + 1, 'release spawns exactly one discharge wave');
    assert.ok(entry.pointerEnergy > pointerEnergyBefore, 'release kicks pointerEnergy');
    controller.dispose();
  });
});

test('a cancel input drops an active charge without a discharge wave and resets pointer position', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput({ type: 'press', surfaceRole: 'chat-left', localX: 15, localY: 15 });
    raf.flush(50);
    const waveCountBefore = controller._internals.inspect().entries[0].waveCount;
    controller.handleInput({ type: 'cancel', surfaceRole: 'chat-left' });
    const entry = controller._internals.inspect().entries[0];
    assert.equal(entry.chargeActive, false);
    assert.equal(entry.waveCount, waveCountBefore, 'cancel must not spawn a discharge wave');
    assert.equal(entry.pointerX, -1);
    assert.equal(entry.pointerY, -1);
    controller.dispose();
  });
});

test('reduced motion suppresses click waves but pointer move still updates position', () => {
  withCircuit({ reducedMotion: true }, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 5, localY: 5 });
    assert.equal(controller._internals.inspect().entries[0].waveCount, 0, 'reduced motion suppresses click-spawned waves');
    controller.handleInput({ type: 'move', surfaceRole: 'chat-left', localX: 33, localY: 44 });
    const entry = controller._internals.inspect().entries[0];
    assert.equal(entry.pointerX, 33);
    assert.equal(entry.pointerY, 44);
    controller.dispose();
  });
});

// ── activity: energy approach + visual boost ────────────────────────────────

test('setActivity moves currentEnergy toward targetEnergy over frames and drives a positive visualBoost', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.equal(controller._internals.inspect().visualBoost, 0, 'idle-at-construction visualBoost is exactly 0');

    activate(controller, 1, 0.46);
    let snapshot = controller._internals.inspect();
    assert.equal(snapshot.targetEnergy, 0.46);
    assert.equal(snapshot.currentEnergy, 0.08, 'currentEnergy has not moved yet -- only setActivity ran, no frame yet');

    let previous = snapshot.currentEnergy;
    for (let i = 0; i < 8; i += 1) {
      raf.flush(50);
      snapshot = controller._internals.inspect();
      assert.ok(snapshot.currentEnergy > previous, `currentEnergy should approach the target on frame ${i}`);
      assert.ok(snapshot.currentEnergy < 0.46, 'currentEnergy approaches but never overshoots the target');
      previous = snapshot.currentEnergy;
    }
    assert.ok(snapshot.visualBoost > 0, 'visualBoost is positive once streaming has pushed energy above the idle target');
    controller.dispose();
  });
});

// ── activity impulses: scope-epoch rules ────────────────────────────────────

test('an activity impulse before any setActivity is ignored; a stale scopeEpoch is ignored; a current-epoch complete fires one settle wave', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    const before = controller._internals.inspect().entries[0];

    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'complete', sequence: 1 });
    let after = controller._internals.inspect().entries[0];
    assert.equal(after.waveCount, before.waveCount, 'an impulse before any setActivity has no scope to match, so it is ignored');
    assert.equal(after.pulsedNodeCount, before.pulsedNodeCount);

    activate(controller, 1);
    controller.handleActivityImpulse({ scopeEpoch: 0, kind: 'complete', sequence: 2 });
    after = controller._internals.inspect().entries[0];
    assert.equal(after.waveCount, before.waveCount, 'a stale-epoch impulse (0) after scope 1 is ignored');

    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'complete', sequence: 3 });
    after = controller._internals.inspect().entries[0];
    assert.equal(after.waveCount, before.waveCount + 1, 'a current-epoch complete impulse fires exactly one settle wave');
    controller.dispose();
  });
});

test('first-token waits two rAFs before its settle wave, and a scope change mid-flight aborts the gesture', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    activate(controller, 1);
    raf.flush(16); // consume the frame setActivity scheduled, so raf.size stabilizes at 1

    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'first-token', sequence: 1 });
    let snapshot = controller._internals.inspect();
    assert.ok(snapshot.pendingGestureCount > 0, 'a first-token impulse registers a pending double-rAF gesture');
    assert.equal(snapshot.entries[0].waveCount, 0, 'no wave yet immediately after the impulse');

    raf.flush(16); // outer rAF: schedules the inner rAF, no wave yet
    assert.equal(controller._internals.inspect().entries[0].waveCount, 0, 'still no wave after only the outer rAF');

    raf.flush(16); // inner rAF: the settle wave spawns now
    assert.equal(controller._internals.inspect().entries[0].waveCount, 1, 'the settle wave spawns once both rAFs have fired');

    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'first-token', sequence: 2 });
    activate(controller, 2); // scope moves before the second gesture's rAFs flush
    raf.flush(16);
    raf.flush(16);
    assert.equal(controller._internals.inspect().entries[0].waveCount, 1,
      'a scope change before both rAFs flush aborts the gesture -- no new wave');
    controller.dispose();
  });
});

test('tool-start pulses a deterministic subset of nodes, reproducible for the same seed + sequence', () => {
  function pulsedCountFor(seed, sequence) {
    let pulsed;
    withCircuit({ rendererLaunchSeed: seed }, ({ controller, raf }) => {
      bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
      activate(controller, 1);
      controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'tool-start', sequence });
      pulsed = controller._internals.inspect().entries[0].pulsedNodeCount;
      controller.dispose();
    });
    return pulsed;
  }
  const first = pulsedCountFor(777, 7);
  assert.ok(first > 0, 'a tool-start impulse pulses at least one node');
  const second = pulsedCountFor(777, 7);
  assert.equal(second, first, 'the same seed + sequence pulses an identical node count (determinism)');
});

test('a cancel impulse clears in-flight waves and any active charge for the current epoch', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 5, localY: 5 });
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 6, localY: 6 });
    assert.equal(controller._internals.inspect().entries[0].waveCount, 2);

    activate(controller, 1);
    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'cancel', sequence: 1 });
    const entry = controller._internals.inspect().entries[0];
    assert.equal(entry.waveCount, 0, 'cancel clears all in-flight waves');
    assert.equal(entry.chargeActive, false, 'cancel clears any active charge');
    controller.dispose();
  });
});

// ── staged reveal + status ──────────────────────────────────────────────────

test('a staged bind keeps readyShown false across rAF flushes; an un-staged refresh reveals it after one flush', () => {
  withCircuit({}, ({ controller, raf }) => {
    const [host] = bindHosts(controller, [{ role: 'chat-left' }], { staged: true });
    raf.flush(16);
    raf.flush(16);
    assert.equal(controller._internals.inspect().entries[0].readyShown, false, 'a staged host never shows ready, however many frames flush');

    controller.refresh(buildFixtureContext({ staged: false, hosts: [{ element: host, role: 'chat-left' }] }));
    assert.equal(controller._internals.inspect().entries[0].readyShown, false, 'readyShown flips on the NEXT rAF, not synchronously');
    raf.flush(16);
    assert.equal(controller._internals.inspect().entries[0].readyShown, true, 'un-staging reveals the canvas after one flush');
    controller.dispose();
  });
});

test('getStatus reports dormant for a 0x0 host and ready with exact counts once a drawable host joins', () => {
  withCircuit({}, ({ controller, raf }) => {
    const zeroHost = makeFakeSurfaceElement({ left: 0, top: 0, width: 0, height: 0 });
    controller.bind(buildFixtureContext({ hosts: [{ element: zeroHost, role: 'chat-left' }] }));
    raf.flush(16);
    assert.deepEqual(controller.getStatus(), {
      state: 'dormant', hostCount: 1, drawableHostCount: 0, reason: 'no drawable host',
    });

    const sizedHost = makeFakeSurfaceElement({ left: 0, top: 0, width: 300, height: 300 });
    controller.refresh(buildFixtureContext({
      hosts: [{ element: zeroHost, role: 'chat-left' }, { element: sizedHost, role: 'chat-right' }],
    }));
    raf.flush(16);
    const status = controller.getStatus();
    assert.equal(status.state, 'ready');
    assert.equal(status.hostCount, 2);
    assert.equal(status.drawableHostCount, 1);
    controller.dispose();
  });
});

// ── determinism (§3.7) ──────────────────────────────────────────────────────

test('same seed + role reproduces entry seed/nodeCount/traceCount; a different role or seed diverges', () => {
  function buildAndInspect(seed, role) {
    let inspected;
    withCircuit({ rendererLaunchSeed: seed }, ({ controller, raf }) => {
      bindAndPrime(controller, raf, [{ role }]);
      inspected = controller._internals.inspect().entries[0];
      controller.dispose();
    });
    return inspected;
  }
  const a = buildAndInspect(4242, 'chat-left');
  const b = buildAndInspect(4242, 'chat-left');
  assert.equal(a.seed, b.seed);
  assert.equal(a.nodeCount, b.nodeCount);
  assert.equal(a.traceCount, b.traceCount);

  const homeRole = buildAndInspect(4242, 'home');
  assert.notEqual(homeRole.seed, a.seed, 'a home-scene host seeds differently than a chat-scene host (scene-role separation)');

  const otherSeed = buildAndInspect(4243, 'chat-left');
  assert.notEqual(otherSeed.seed, a.seed, 'a different rendererLaunchSeed produces a different scene seed');
});

test('offset chat gutters share one wide scene graph instead of duplicate local graphs', () => {
  withCircuit({}, ({ controller, raf }) => {
    const leftRect = { left: 100, top: 40, width: 240, height: 300 };
    const rightRect = { left: 660, top: 40, width: 240, height: 300 };
    const sceneRect = { left: 100, top: 40, width: 800, height: 300 };
    bindAndPrime(controller, raf, [
      { role: 'chat-left', rect: leftRect }, { role: 'chat-right', rect: rightRect },
    ], { sceneRect, hostRects: [leftRect, rightRect] });
    const [left, right] = controller._internals.inspect().entries;
    assert.equal(left.seed, right.seed, 'both gutters of one chat scene share one seed');
    assert.equal(left.nodeCount, right.nodeCount);
    const localNodeCount = circuitTraceCore.buildHexGraph(
      leftRect.width, leftRect.height, circuitTraceCore.DEFAULT_HEX_SIZE,
      circuitTraceCore.makeRng(1),
    ).nodes.length;
    assert.ok(left.nodeCount > localNodeCount,
      'the graph spans the hidden middle instead of duplicating a gutter-local topology');
    controller.dispose();
  });
});

test('spawn avoidance blocks scene-coordinate waves with a nonzero client origin', () => {
  withCircuit({}, ({ controller, raf }) => {
    const rect = { left: 100, top: 40, width: 300, height: 300 };
    const blocked = { left: 240, top: 180, width: 20, height: 20 };
    bindAndPrime(controller, raf, [{ role: 'chat-left', rect }], {
      sceneRect: rect,
      hostRects: [rect],
      spawnAvoidanceRects: [blocked],
    });
    controller.handleInput({
      type: 'click', surfaceRole: 'chat-left', localX: 150, localY: 150, sceneX: 150, sceneY: 150,
    });
    assert.equal(controller._internals.inspect().entries[0].waveCount, 0);
    controller.handleInput({
      type: 'click', surfaceRole: 'chat-left', localX: 40, localY: 40, sceneX: 40, sceneY: 40,
    });
    assert.equal(controller._internals.inspect().entries[0].waveCount, 1,
      'an allowed origin keeps the avoidance oracle non-vacuous');
    controller.dispose();
  });
});

test('paint occlusion clears the viewport after drawing while scene dynamics continue', () => {
  withCircuit({}, ({ controller, raf }) => {
    const rect = { left: 100, top: 40, width: 300, height: 300 };
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left', rect }], {
      sceneRect: rect,
      hostRects: [rect],
    });
    const context = host.children[0].getContext('2d');
    controller.handleInput({
      type: 'move', surfaceRole: 'chat-left', localX: 40, localY: 40, sceneX: 40, sceneY: 40,
    });
    const beforeEnergy = controller._internals.inspect().entries[0].pointerEnergy;
    const beforeClears = context.__clears.length;
    controller.refresh(buildFixtureContext({
      generation: 1,
      hosts: [{ element: host, role: 'chat-left' }],
      sceneRect: rect,
      hostRects: [rect],
      layoutRevision: 2,
      paintOcclusionRects: [rect],
    }));
    raf.flush(16);
    const after = controller._internals.inspect().entries[0];
    assert.ok(after.pointerEnergy < beforeEnergy, 'occlusion does not pause shared scene advancement');
    assert.ok(context.__clears.length >= beforeClears + 2, 'draw clear and occlusion clear both execute');
    assert.deepEqual(context.__clears.at(-1), [0, 0, rect.width, rect.height]);
    controller.dispose();
  });
});

// ── dataset mirror ───────────────────────────────────────────────────────────

test('a bound host gets a canvas whose dataset mirrors the resolved version, re-mirrored on refresh', () => {
  withCircuit({}, ({ controller, raf }) => {
    const [host] = bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    const canvas = host.children[0];
    assert.ok(canvas, 'bind injects a canvas');
    assert.equal(canvas.dataset.circuitTraceVersion, '2', 'no CSS tokens set -> resolveVersion defaults to 2');

    controller.refresh(buildFixtureContext({ hosts: [{ element: host, role: 'chat-left' }] }));
    assert.equal(canvas.dataset.circuitTraceVersion, '2', 'the dataset value re-mirrors identically on refresh');
    controller.dispose();
  });
});

// ── quality override ─────────────────────────────────────────────────────────

test('setQualityOverride accepts a numeric pin, null clears it, and a non-numeric value is treated as null', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf, [{ role: 'chat-left' }]);
    assert.doesNotThrow(() => controller._internals.setQualityOverride(0.55), 'a valid override is accepted');
    controller.handleInput({ type: 'move', surfaceRole: 'chat-left', localX: 12, localY: 13 });
    let entry = controller._internals.inspect().entries[0];
    assert.equal(entry.pointerX, 12, 'ordinary pointer behavior is unaffected by a pinned quality override');
    assert.equal(entry.pointerY, 13);
    raf.flush(16);
    raf.flush(16);

    assert.doesNotThrow(() => controller._internals.setQualityOverride(null), 'clearing the override is accepted');
    assert.doesNotThrow(() => controller._internals.setQualityOverride('junk'), 'a non-numeric override is treated as null, not thrown');
    controller.handleInput({ type: 'move', surfaceRole: 'chat-left', localX: 20, localY: 21 });
    entry = controller._internals.inspect().entries[0];
    assert.equal(entry.pointerX, 20, 'behavior stays correct with a garbage override value in effect');
    assert.equal(entry.pointerY, 21);
    controller.dispose();
  });
});

// ── dispose: full teardown + idempotency + post-dispose inertness ──────────

test('dispose tears down rAF/listeners/canvases/ResizeObserver and is idempotent; post-dispose calls are no-ops', () => {
  withCircuit({}, ({
    controller, raf, documentRef, reducedMotionQuery, ResizeObserverRef,
  }) => {
    const [hostA, hostB] = bindAndPrime(controller, raf, [{ role: 'chat-left' }, { role: 'chat-right' }]);
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 1, localY: 1 });
    activate(controller, 1);
    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'tool-start', sequence: 1 });

    controller.dispose();
    assert.equal(raf.size, 0, 'dispose cancels every pending rAF');
    assert.equal(documentRef.listenerCount('visibilitychange'), 0, 'dispose removes the visibilitychange listener');
    assert.equal(reducedMotionQuery.listenerCount(), 0, 'dispose removes the reduced-motion listener');
    assert.equal(hostA.children.length, 0, 'dispose removes the injected canvas from hostA');
    assert.equal(hostB.children.length, 0, 'dispose removes the injected canvas from hostB');
    assert.equal(ResizeObserverRef.getActiveCount(), 0, 'dispose disconnects the ResizeObserver');

    assert.doesNotThrow(() => controller.dispose(), 'a second dispose is idempotent');
    assert.equal(raf.size, 0);
    assert.equal(hostA.children.length, 0);

    const before = controller._internals.inspect();
    controller.handleInput({ type: 'move', surfaceRole: 'chat-left', localX: 99, localY: 99 });
    activate(controller, 2, 0.5);
    controller.handleActivityImpulse({ scopeEpoch: 2, kind: 'complete', sequence: 1 });
    const after = controller._internals.inspect();
    assert.equal(after.disposed, true);
    assert.deepEqual(after, before, 'no post-dispose call changes any observable state');
  });
});

// ── v3 grid-native gesture grammar + waiting state (2026-07-22) ─────────────

const { makeStyledFixtureHost } = require('./helpers/surface-effect-conformance.js');

// Binds one 300x300 chat-left host carrying the v3 version token (plus any
// extra tokens) and consumes the priming frame, mirroring bindAndPrime.
function bindV3Host(controller, raf, extraTokens = {}) {
  const host = makeStyledFixtureHost(
    { left: 0, top: 0, width: 300, height: 300 },
    Object.assign({ '--widget-circuit-trace-version': '3' }, extraTokens),
  );
  controller.bind(buildFixtureContext({ hosts: [{ element: host, role: 'chat-left' }] }));
  raf.flush(16);
  return host;
}

test('a v3 version token resolves to version 3 and mirrors onto the canvas dataset', () => {
  withCircuit({}, ({ controller, raf }) => {
    const host = bindV3Host(controller, raf);
    assert.equal(controller._internals.inspect().entries[0].version, 3);
    assert.equal(host.children[0].dataset.circuitTraceVersion, '3');
    controller.dispose();
  });
});

test('v3: press keys the nearest cell; a quick release vents locally (no wave) and owns the follow-up click', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    controller.handleInput({ type: 'press', surfaceRole: 'chat-left', localX: 20, localY: 20 });
    let entry = controller._internals.inspect().entries[0];
    assert.equal(entry.chargeActive, true);
    assert.ok(entry.chargeCellIdx >= 0, 'a v3 press keys the nearest hex cell for the capacitor lattice');

    raf.flush(16); // short hold -> quick release stays below the fork threshold
    controller.handleInput({ type: 'release', surfaceRole: 'chat-left' });
    entry = controller._internals.inspect().entries[0];
    assert.equal(entry.chargeActive, false);
    assert.equal(entry.chargeCellIdx, -1, 'release resets the keyed cell');
    assert.equal(entry.waveCount, 0, 'a quick release spawns NO expanding wave -- it vents as a local tap flash');
    assert.ok(entry.pulsedNodeCount > 0, 'the tap flash pulses the keyed cell vertices in place');

    const pulsedBefore = entry.pulsedNodeCount;
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 220, localY: 220 });
    entry = controller._internals.inspect().entries[0];
    assert.equal(entry.waveCount, 0);
    assert.equal(entry.pulsedNodeCount, pulsedBefore,
      'the click that follows a discharging release is suppressed -- one gesture, one emission');
    controller.dispose();
  });
  withCircuit({}, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 20, localY: 20 });
    const entry = controller._internals.inspect().entries[0];
    assert.equal(entry.waveCount, 0, 'a bare click never spawns an expanding wave at v3');
    assert.ok(entry.pulsedNodeCount > 0,
      'a bare click with no preceding press/release still acknowledges with a local tap flash');
    controller.dispose();
  });
});

test('v3: a charged hold forks packet traces instead of a wave, and the transients decay back to ambient', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    // Pin full quality: the synthetic 80-100ms flushes below would otherwise
    // degrade the tier and park any fork beyond the quality-active window.
    controller._internals.setQualityOverride(1);
    controller.handleInput({ type: 'press', surfaceRole: 'chat-left', localX: 150, localY: 150 });
    for (let i = 0; i < 30; i += 1) { raf.flush(100); } // dt clamps at 80ms -> ~2.4s hold, charge ~0.97
    let entry = controller._internals.inspect().entries[0];
    assert.ok(entry.chargeValue > circuitTraceCore.FORK_BRANCH_TIER_3,
      'a long hold charges past the 3-branch tier, got ' + entry.chargeValue);

    const waveCountBefore = entry.waveCount;
    controller.handleInput({ type: 'release', surfaceRole: 'chat-left' });
    entry = controller._internals.inspect().entries[0];
    assert.equal(entry.chargeActive, false);
    assert.equal(entry.waveCount, waveCountBefore, 'a charged release dispatches forks, not another wave');
    assert.ok(entry.forkActiveCount >= 1 && entry.forkActiveCount <= 3,
      '1-3 forked packet traces are active, got ' + entry.forkActiveCount);

    for (let i = 0; i < 400 && controller._internals.inspect().entries[0].forkActiveCount > 0; i += 1) {
      raf.flush(80);
    }
    assert.equal(controller._internals.inspect().entries[0].forkActiveCount, 0,
      'fork transients consume their hop budget and return to ambient behavior');
    controller.dispose();
  });
});

test('v3: an activity settle wave rides the hex shell -- ring vertices pulse and the wave expires after the shell budget', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    // Clicks no longer spawn waves at v3; the streaming impulses (settle /
    // first-token) are the remaining hex-shell sources.
    activate(controller, 1);
    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'complete', sequence: 1 });
    assert.equal(controller._internals.inspect().entries[0].waveCount, 1);
    raf.flush(16);
    assert.ok(controller._internals.inspect().entries[0].pulsedNodeCount > 0,
      'the expanding shell pulses the vertices of the ring it is crossing');
    for (let i = 0; i < 9; i += 1) { raf.flush(80); }
    assert.equal(controller._internals.inspect().entries[0].waveCount, 0,
      'the shell wave expires after SHELL_COUNT (' + circuitTraceCore.SHELL_COUNT + ') steps');
    controller.dispose();
  });
});

test('v3 idle stays inert: zero activity factor, zero visual boost, and no rendezvous across frames', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    for (let i = 0; i < 20; i += 1) { raf.flush(80); }
    const snapshot = controller._internals.inspect();
    assert.equal(snapshot.activityFactor, 0, 'idle energy pins the activity factor at exactly 0');
    assert.equal(snapshot.visualBoost, 0);
    assert.equal(snapshot.rendezvousActive, false);
    assert.equal(snapshot.rendezvousTargetIdx, -1, 'no rendezvous is ever scheduled or fired at idle');
    controller.dispose();
  });
});

test('v3 streaming raises the activity factor and eventually fires a deterministic rendezvous', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    activate(controller, 1, 0.46);
    for (let i = 0; i < 25; i += 1) { raf.flush(80); }
    assert.ok(controller._internals.inspect().activityFactor > 0.9,
      'sustained streaming energy drives the activity factor toward 1');
    for (let i = 0; i < 70; i += 1) { raf.flush(800); } // now advances ~56s, past the 25-45s jittered gap
    assert.ok(controller._internals.inspect().rendezvousTargetIdx >= 0,
      'a rendezvous target was chosen within the jittered long-wait window');
    controller.dispose();
  });
});

test('v3 reduced motion: press activates no charge and click spawns no shell wave', () => {
  withCircuit({ reducedMotion: true }, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    controller.handleInput({ type: 'press', surfaceRole: 'chat-left', localX: 20, localY: 20 });
    const entry = controller._internals.inspect().entries[0];
    assert.equal(entry.chargeActive, false);
    assert.equal(entry.chargeCellIdx, -1);
    controller.handleInput({ type: 'click', surfaceRole: 'chat-left', localX: 20, localY: 20 });
    const clicked = controller._internals.inspect().entries[0];
    assert.equal(clicked.waveCount, 0);
    assert.equal(clicked.pulsedNodeCount, 0, 'reduced motion suppresses the tap flash too');
    controller.dispose();
  });
});

test('v3: a cancel impulse clears fork transients along with waves and charge', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    controller.handleInput({ type: 'press', surfaceRole: 'chat-left', localX: 150, localY: 150 });
    for (let i = 0; i < 30; i += 1) { raf.flush(100); }
    controller.handleInput({ type: 'release', surfaceRole: 'chat-left' });
    assert.ok(controller._internals.inspect().entries[0].forkActiveCount >= 1);

    activate(controller, 1);
    controller.handleActivityImpulse({ scopeEpoch: 1, kind: 'cancel', sequence: 1 });
    const entry = controller._internals.inspect().entries[0];
    assert.equal(entry.forkActiveCount, 0, 'cancel resets fork transients to ambient');
    assert.equal(entry.waveCount, 0);
    assert.equal(entry.chargeActive, false);
    controller.dispose();
  });
});

test('v3: a scope-epoch change resets fork transients and any scheduled rendezvous', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindV3Host(controller, raf);
    controller._internals.setQualityOverride(1);
    activate(controller, 1, 0.46);
    controller.handleInput({ type: 'press', surfaceRole: 'chat-left', localX: 150, localY: 150 });
    for (let i = 0; i < 30; i += 1) { raf.flush(100); }
    controller.handleInput({ type: 'release', surfaceRole: 'chat-left' });
    assert.ok(controller._internals.inspect().entries[0].forkActiveCount >= 1, 'forks are live before the scope moves');

    activate(controller, 2, 0.46); // scope moves to a new stream
    const snapshot = controller._internals.inspect();
    assert.equal(snapshot.entries[0].forkActiveCount, 0, 'fork transients never cross a scope boundary');
    assert.equal(snapshot.rendezvousActive, false);
    assert.equal(snapshot.rendezvousTargetIdx, -1, 'any scheduled rendezvous is dropped with its scope');
    controller.dispose();
  });
});
