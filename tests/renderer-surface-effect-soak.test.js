// spec-first: deterministic surface-effect soak lane for Background Effects
// v3 packet S4 (BACKGROUND_EFFECTS_V3_PLAN.md §5 "Test plan" -- `test:surface-
// soak`). Drives the conformance fixture (tests/helpers/surface-effect-
// conformance.js) through a real manager + the real production input router
// (renderer/app/renderer-app-surface-input.js) with a seeded, fully
// synchronous rAF harness -- no real timers, no jsdom.
//
// The manager itself only owns an internal router when its windowRef carries
// rendererAppSurfaceInput (see createSurfaceEffectManager); this soak needs
// the router's `_internals.getPendingMoveCount()` escape hatch, which the
// manager never exposes on its returned object, so the router is
// constructed directly here (matching the established pattern in
// tests/renderer-app-surface-input.test.js's makeRouter() helper) and wired
// to a getInputTarget() that mirrors the manager's own internal one via its
// public getStatus() surface and the controller captured from the test factory. Because of
// that, router-owned pointer-state clearing that production wiring drives
// automatically (via manager.clearSurfaceInputState on effect/session
// switches) is triggered manually at the one point this test switches
// effects (see the dispose-mid-interaction block below).
//
// 10,000 pointermoves + 300 clicks across both gutters, interleaved with 20
// resizes, 10 palette-ish refreshes, visibility toggles, reduced-motion
// toggles, and one dispose-mid-interaction cycle. Asserts throughout: the
// pending-move queue never exceeds the live pointer count, the fixture's own
// bounded histories never grow past their caps, and at the end there are
// zero leaked listeners, zero leaked rAF handles, and zero leaked canvases.

const test = require('node:test');
const assert = require('node:assert/strict');

const surfaceInput = require('../renderer/app/renderer-app-surface-input.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const circuitTrace = require('../renderer/shell/renderer-circuit-trace-utils.js');
const circuitTraceCore = require('../renderer/shell/renderer-circuit-trace-core.js');
const reactiveGrid = require('../renderer/shell/renderer-reactive-grid-utils.js');
const reactiveGridCore = require('../renderer/shell/renderer-reactive-grid-core.js');
const atomicBurst = require('../renderer/shell/renderer-atomic-burst-utils.js');
const playlistScroll = require('../renderer/shell/renderer-playlist-scroll-utils.js');
const contextWeave = require('../renderer/shell/renderer-context-weave-utils.js');
const {
  createRafHarness, createClock, makeManager, makeRouterManager, makeFakeSurfaceElement,
  makePointerEvent, makeFakeEventTarget,
} = require('./helpers/surface-effect-router-harness.js');
const {
  createConformanceFixtureController, withStubbedGlobals, makeFixtureDocumentRef,
  makeStyledFixtureHost, createEffectMediaQueryList, createFakeResizeObserverClass,
} = require('./helpers/surface-effect-conformance.js');

const EFFECT_ID = 'soak-fixture';
const MOVE_COUNT = 10000;
const CLICK_COUNT = 300;
const POINTER_ID_COUNT = 4;
const MOVE_FLUSH_BATCH = 50;
const RESIZE_COUNT = 20;
const REFRESH_COUNT = 10;
const SOAK_TIME_BUDGET_MS = 20000;
const POINTER_LIKE_EVENTS = [
  'pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup',
  'pointercancel', 'lostpointercapture', 'click', 'mousemove', 'mouseleave',
  'mousedown', 'mouseup',
];
const ROUTER_SURFACE_EVENTS = new Set([
  'pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup',
  'pointercancel', 'lostpointercapture', 'click',
]);

function makeSoakDom() {
  return {
    chatView: makeFakeSurfaceElement({ left: 0, top: 0, width: 800, height: 600 }),
    homeView: makeFakeSurfaceElement({ left: 0, top: 0, width: 800, height: 600 }),
    chatSurfaceEffectLeft: makeFakeSurfaceElement({ left: 0, top: 0, width: 800, height: 600 }),
  };
}

// Mirrors createSurfaceEffectManager's private getInputTarget() using only
// the manager's PUBLIC surface -- see the file-header note on why the router
// is constructed standalone rather than through the manager here.
function makeGetInputTarget(manager, getController) {
  return function getInputTarget() {
    const controller = getController();
    if (!controller) { return null; }
    const status = manager.getStatus();
    if (status.activeEffectId === 'none') { return null; }
    const runtimeState = status.runtimeStateByEffectId[status.activeEffectId] || {};
    return {
      controller,
      effectId: status.activeEffectId,
      captureOnPress: false,
      generation: status.activationGeneration,
      inputDisabled: Boolean(runtimeState.inputDisabled),
    };
  };
}

function makeRect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function makeNativeSoakDom(styleTokens) {
  return {
    chatView: makeFakeSurfaceElement(makeRect(0, 0, 800, 600)),
    homeView: makeStyledFixtureHost(makeRect(0, 0, 800, 600), styleTokens),
    chatSurfaceEffectLeft: makeStyledFixtureHost(makeRect(0, 0, 800, 600), styleTokens),
  };
}

function assertCircuitBounds(snapshot) {
  assert.equal(snapshot.entries.length, 1, 'Circuit Trace retains exactly the one active full-bleed Chat host');
  assert.ok(snapshot.pendingGestureCount <= 2, 'Circuit Trace pending gestures stay within the two-handle gesture cap');
  const sceneWidth = snapshot.entries.reduce((width, entry) => width + entry.w, 0);
  const sceneHeight = Math.max(...snapshot.entries.map((entry) => entry.h));
  const expectedNodes = circuitTraceCore.buildHexGraph(sceneWidth, sceneHeight, 48, () => 0.5).nodes.length;
  const hexArea = (3 * circuitTraceCore.SQRT3 / 2) * 48 * 48;
  const expectedTraces = Math.max(3, Math.min(28, Math.round((sceneWidth * sceneHeight / hexArea) * 0.05)));
  snapshot.entries.forEach((entry) => {
    assert.equal(entry.nodeCount, expectedNodes, 'Circuit Trace replaces, rather than accumulates, its geometry nodes');
    assert.equal(entry.traceCount, expectedTraces, 'Circuit Trace retains the exact geometry-derived trace count');
    assert.ok(entry.waveCount <= circuitTraceCore.MAX_WAVES, 'Circuit Trace wave pool stays at MAX_WAVES');
  });
}

function assertReactiveBounds(snapshot) {
  assert.equal(snapshot.entries.length, 1, 'Reactive Grid retains exactly the one active full-bleed Chat host');
  assert.ok(snapshot.pendingGestureCount <= 2, 'Reactive Grid pending gestures stay within the two-handle gesture cap');
  const sceneWidth = snapshot.entries.reduce((width, entry) => width + entry.w, 0);
  const sceneHeight = Math.max(...snapshot.entries.map((entry) => entry.h));
  const geometry = reactiveGridCore.resolveGridGeometry(
    sceneWidth, sceneHeight, 48, reactiveGridCore.MAX_GRID_DOTS,
  );
  snapshot.entries.forEach((entry) => {
    assert.equal(entry.dotCount, geometry.dotCount, 'Reactive Grid replaces, rather than accumulates, its dot field');
    assert.equal(entry.impulseCapacity, reactiveGridCore.MAX_IMPULSES, 'Reactive Grid reports the exact impulse capacity');
    assert.ok(entry.impulseCount <= entry.impulseCapacity, 'Reactive Grid active impulses stay within capacity');
  });
}

function assertAtomicBounds(snapshot) {
  assert.equal(snapshot.entries.length, 1, 'Atomic Burst retains exactly the one active full-bleed Chat host');
  assert.equal(snapshot.pendingGestureCount, 0, 'Atomic Burst has no queued gesture handles');
  snapshot.entries.forEach((entry) => {
    assert.equal(entry.sparkleCapacity, 1500, 'Atomic Burst reports the exact sparkle capacity');
    assert.ok(entry.sparkleCount <= entry.sparkleCapacity, 'Atomic Burst sparkle fields stay within capacity');
    assert.equal(entry.waveCapacity, 4, 'Atomic Burst reports the exact wave capacity');
    assert.ok(entry.waveCount <= entry.waveCapacity, 'Atomic Burst waves stay within capacity');
  });
}

function assertPlaylistBounds(snapshot) {
  assert.equal(snapshot.entries.length, 1, 'Playlist Scroll retains exactly the one active full-bleed Chat host');
  assert.equal(snapshot.pendingGestureCount, 0, 'Playlist Scroll has no queued gesture handles');
  snapshot.entries.forEach((entry) => {
    assert.equal(entry.noteCapacity, 96, 'Playlist Scroll reports the exact note capacity');
    assert.ok(entry.noteCount <= entry.noteCapacity, 'Playlist Scroll notes stay within capacity');
    assert.equal(entry.rippleCapacity, 6, 'Playlist Scroll reports the exact ripple capacity');
    assert.ok(entry.rippleCount <= entry.rippleCapacity, 'Playlist Scroll ripples stay within capacity');
    assert.equal(entry.crossingFlareCapacity, 6, 'Playlist Scroll reports the exact crossing-flare capacity');
    assert.ok(entry.crossingFlareCount <= entry.crossingFlareCapacity,
      'Playlist Scroll crossing flares stay within capacity');
    assert.equal(entry.ghostCapacity, 128, 'Playlist Scroll reports the exact ghost-note capacity');
    assert.ok(entry.ghostCount <= entry.ghostCapacity, 'Playlist Scroll ghost notes stay within capacity');
    assert.ok(entry.previewCount === 0 || entry.previewCount === 1,
      'Playlist Scroll retains at most one snapped hover preview');
  });
}

function assertContextWeaveBounds(snapshot) {
  assert.equal(snapshot.entries.length, 1, 'Context Weave retains exactly the one active full-bleed Chat host');
  // Restyled 2026-08-21: a static warp/weft lattice with a closed-form pluck
  // replaced the elastic graph and its wave pool, so the bounds that matter
  // are the grid cap and "at most one pluck live at a time".
  assert.ok(snapshot.cols >= 3 && snapshot.rows >= 3, 'Context Weave keeps a drawable lattice');
  assert.ok(snapshot.cols * snapshot.rows <= contextWeave._internals.MAX_GRID_NODES,
    'Context Weave lattice stays under the primitive cap');
  assert.equal(snapshot.nodeCount, snapshot.cols * snapshot.rows, 'node count is exactly the lattice');
  assert.ok(snapshot.pitch >= contextWeave._internals.MIN_PITCH, 'pitch never drops below its floor');
  assert.equal(typeof snapshot.pluckActive, 'boolean', 'pluck state is a single flag, not a pool');
  assert.ok(snapshot.bandEnergy >= 0 && snapshot.bandEnergy <= 1, 'the streaming band envelope stays bounded');
  snapshot.entries.forEach((entry) => {
    assert.equal(entry.nodeCount, snapshot.nodeCount, 'Context Weave entries share one lattice');
  });
}

const REAL_NATIVE_EFFECTS = [
  {
    id: 'context-weave',
    factory: contextWeave.createContextWeaveController,
    captureOnPress: false,
    styleTokens: {
      '--widget-context-weave-line-color': 'rgba(150,160,186,0.42)',
      '--widget-context-weave-spacing': '96',
      '--widget-context-weave-density': '1',
      '--widget-context-weave-pointer-radius': '150',
      '--widget-context-weave-interlace': '3',
      '--widget-context-weave-weft-alpha': '0.7',
      '--widget-context-weave-lit-gain': '3',
    },
    refreshToken: ['--widget-context-weave-line-color', 'rgba(10,120,180,0.4)', 'rgba(220,100,180,0.5)'],
    assertBounds: assertContextWeaveBounds,
  },
  {
    id: 'circuit-trace',
    factory: circuitTrace.createCircuitTraceController,
    captureOnPress: true,
    styleTokens: {
      '--widget-circuit-trace-version': '3',
      '--widget-circuit-trace-hex-size': '48',
      '--widget-circuit-trace-density': '0.5',
      '--widget-circuit-trace-trail-length': '8',
    },
    refreshToken: ['--widget-circuit-trace-grid-color', 'rgba(10,20,30,0.2)', 'rgba(30,20,10,0.3)'],
    assertBounds: assertCircuitBounds,
  },
  {
    id: 'reactive-grid',
    factory: reactiveGrid.createReactiveGridController,
    captureOnPress: false,
    styleTokens: { '--reactive-grid-cell-size': '48' },
    refreshToken: ['--widget-reactive-grid-dot-active', 'rgba(10,200,220,0.7)', 'rgba(220,80,180,0.8)'],
    assertBounds: assertReactiveBounds,
  },
  {
    id: 'atomic-burst',
    factory: atomicBurst.createAtomicBurstController,
    captureOnPress: false,
    styleTokens: {
      '--widget-atomic-burst-size': '36',
      '--widget-atomic-burst-density': '4',
      '--widget-atomic-burst-link-max': '6',
    },
    refreshToken: ['--widget-atomic-burst-flare-color', 'rgba(255,255,255,0.9)', 'rgba(180,220,255,0.8)'],
    assertBounds: assertAtomicBounds,
  },
  {
    id: 'playlist-scroll',
    factory: playlistScroll.createPlaylistScrollController,
    captureOnPress: true,
    styleTokens: {
      '--playlist-scroll-lane-height': '48',
      '--playlist-scroll-subdivisions': '4',
      '--playlist-scroll-bar-width': '120',
      '--playlist-scroll-speed': '0.4',
    },
    refreshToken: ['--playlist-scroll-line-color', 'rgba(100,180,255,0.5)', 'rgba(220,120,255,0.55)'],
    assertBounds: assertPlaylistBounds,
  },
];

function assertControllerOwnsNoPointerListeners(effectId, dom) {
  POINTER_LIKE_EVENTS.forEach((eventName) => {
    const expectedRouterListeners = ROUTER_SURFACE_EVENTS.has(eventName) ? 1 : 0;
    assert.equal(
      dom.homeView.listenerCount(eventName),
      expectedRouterListeners,
      effectId + ' adds no listener beyond the production router on the home host',
    );
  });
  [dom.chatSurfaceEffectLeft].forEach((host) => {
    POINTER_LIKE_EVENTS.forEach((eventName) => {
      assert.equal(host.listenerCount(eventName), 0, effectId + ' adds no pointer listener to a gutter host');
    });
  });
  [dom.homeView, dom.chatSurfaceEffectLeft].forEach((host) => {
    host.children.forEach((canvas) => {
      POINTER_LIKE_EVENTS.forEach((eventName) => {
        assert.equal(canvas.listenerCount(eventName), 0, effectId + ' adds no pointer listener to an owned canvas');
      });
    });
  });
}

function assertAllSurfaceListenersRemoved(effectId, dom) {
  [dom.chatView, dom.homeView, dom.chatSurfaceEffectLeft].forEach((host) => {
    POINTER_LIKE_EVENTS.forEach((eventName) => {
      assert.equal(host.listenerCount(eventName), 0, effectId + ' leaves no ' + eventName + ' surface listener');
    });
  });
}

test('surface-effect soak: deterministic 10k-move / 300-click / interleaved lifecycle drive stays bounded and leak-free', () => {
  const startedAt = Date.now();
  const raf = createRafHarness();
  const clock = createClock();
  const ResizeObserverRef = createFakeResizeObserverClass();
  const rand = runtime.makeRng(runtime.hashSeedString('surface-effect-soak-s4'));

  withStubbedGlobals({ raf, ResizeObserverRef }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const registryEntry = { id: EFFECT_ID, contractVersion: 3, inputMode: 'manager', interaction: { captureOnPress: false } };
    const dom = makeSoakDom();
    let controller = null;

    const { manager } = makeManager({
      raf,
      clock,
      registry: [registryEntry],
      dom,
      factories: { [EFFECT_ID]: (opts) => {
        controller = createConformanceFixtureController(opts);
        return controller;
      } },
      options: {
        effectId: EFFECT_ID, documentRef, reducedMotionQuery, runtime,
        defects: {}, rendererLaunchSeed: 7, sceneRole: 'chat',
      },
    });

    const windowEvents = makeFakeEventTarget();
    const router = surfaceInput.createSurfaceInputRouter({
      windowRef: Object.assign({
        requestAnimationFrame: raf.requestAnimationFrame,
        cancelAnimationFrame: raf.cancelAnimationFrame,
      }, windowEvents),
      documentRef,
      dom,
      registerCleanup: () => {},
      getInputTarget: makeGetInputTarget(manager, () => controller),
      onInputFailure: () => {},
    });

    manager.activateSurfaceEffect(EFFECT_ID);
    raf.flush();
    assert.ok(controller, 'the fixture activates through the manager before the drive starts');

    let disposedMidway = false;
    let clicksFired = 0;
    let resizesFired = 0;
    let refreshesFired = 0;
    let visibilityToggles = 0;
    let motionToggles = 0;

    for (let i = 0; i < MOVE_COUNT; i += 1) {
      const pointerId = (i % POINTER_ID_COUNT) + 1;
      const x = 10 + Math.floor(rand() * 780);
      const y = 10 + Math.floor(rand() * 580);
      dom.chatView.fire('pointermove', makePointerEvent('pointermove', { pointerId, clientX: x, clientY: y }));

      // Bounded pending-move queue: the router coalesces at most one pending
      // move per live pointerId (a Map keyed on pointerId), so this can
      // never exceed the number of distinct pointerIds in play.
      assert.ok(router._internals.getPendingMoveCount() <= POINTER_ID_COUNT,
        'pending move queue never exceeds the live pointer count');

      if (i % MOVE_FLUSH_BATCH === 0) {
        raf.flush();
      }

      if (i % 33 === 0 && clicksFired < CLICK_COUNT) {
        const gutterX = clicksFired % 2 === 0 ? 100 : 500; // two points inside the one full-bleed chat host
        dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', { pointerId: 1, clientX: gutterX, clientY: 300, buttons: 1 }));
        dom.chatView.fire('pointerup', makePointerEvent('pointerup', { pointerId: 1, clientX: gutterX, clientY: 300, buttons: 0 }));
        dom.chatView.fire('click', makePointerEvent('click', { pointerId: 1, clientX: gutterX, clientY: 300, buttons: 0 }));
        clicksFired += 1;
      }

      if (i % 500 === 0 && resizesFired < RESIZE_COUNT) {
        // The single full-bleed chat host IS the scene, so both move together
        // -- a host that drifts from the scene rect is not a shape the layout
        // publisher can produce.
        const width = 780 + resizesFired;
        dom.chatView.rect = { left: 0, top: 0, width, height: 600 };
        dom.chatSurfaceEffectLeft.rect = { left: 0, top: 0, width, height: 600 };
        manager.refreshActiveSurfaceEffect();
        raf.flush();
        resizesFired += 1;
      }

      if (i % 700 === 0 && refreshesFired < REFRESH_COUNT) {
        // Palette-ish refresh: no geometry change, just a re-apply (mirrors
        // an appearance/palette bundle apply re-triggering refresh).
        manager.refreshActiveSurfaceEffect();
        raf.flush();
        refreshesFired += 1;
      }

      if (i % 900 === 0) {
        documentRef.hidden = !documentRef.hidden;
        documentRef.fire('visibilitychange');
        visibilityToggles += 1;
      }

      if (i % 1100 === 0) {
        reducedMotionQuery.simulateChange(!reducedMotionQuery.matches);
        motionToggles += 1;
      }

      if (!disposedMidway && i === Math.floor(MOVE_COUNT / 2)) {
        manager.setVisibleActivityScope({ sessionId: 's1', streamId: 'a' });
        manager.publishStreamImpulse({ sessionId: 's1', streamId: 'a', kind: 'first-token' });
        // Production wiring runs this automatically via the manager's own
        // internal clearSurfaceInputState() on effect switch; this router
        // is standalone (see file header), so it is driven explicitly here.
        router.clearPointerState('soak-dispose-mid-interaction');
        manager.activateSurfaceEffect('none');
        assert.equal(manager.getStatus().activeEffectId, 'none', 'dispose-mid-interaction actually disposes');
        manager.activateSurfaceEffect(EFFECT_ID);
        raf.flush();
        assert.ok(controller, 're-activation after dispose-mid-interaction succeeds');
        disposedMidway = true;
      }

      if (controller && controller._fixture && i % 777 === 0) {
        assert.ok(controller._fixture.getRecordedDts().length <= 64, 'fixture dt history stays capped');
        assert.ok(controller._fixture.getRecentInputs().length <= 32, 'fixture input history stays capped');
        assert.ok(controller._fixture.getAcceptedImpulses().length <= 32, 'fixture impulse history stays capped');
      }
    }
    raf.flush();

    assert.equal(clicksFired, CLICK_COUNT, 'fired the full 300-click budget');
    assert.equal(resizesFired, RESIZE_COUNT, 'fired the full 20-resize budget');
    assert.equal(refreshesFired, REFRESH_COUNT, 'fired the full palette-ish refresh budget');
    assert.ok(disposedMidway, 'the dispose-mid-interaction cycle ran');
    assert.ok(visibilityToggles > 0 && motionToggles > 0, 'exercised visibility and reduced-motion toggles');

    router.clearPointerState('soak-teardown');
    manager.activateSurfaceEffect('none');
    router.dispose();

    assert.equal(raf.size, 0, 'zero pending rAF after final dispose');
    assert.equal(dom.chatSurfaceEffectLeft.children.length, 0, 'zero leaked canvases on the left gutter');
    assert.equal(dom.homeView.children.length, 0, 'zero leaked canvases on the home host');
    ['pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup', 'pointercancel', 'click'].forEach((eventName) => {
      assert.equal(dom.chatSurfaceEffectLeft.listenerCount(eventName), 0, 'no leaked ' + eventName + ' listener on the left gutter');
    });
    assert.equal(ResizeObserverRef.getActiveCount(), 0, 'zero leaked ResizeObserver instances');
  });

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < SOAK_TIME_BUDGET_MS,
    'soak completes well under the ' + SOAK_TIME_BUDGET_MS + 'ms target (took ' + elapsedMs + 'ms)');
});

function runRealNativeSoak(spec) {
  const startedAt = Date.now();
  const raf = createRafHarness();
  const clock = createClock();
  const ResizeObserverRef = createFakeResizeObserverClass();
  const rand = runtime.makeRng(runtime.hashSeedString('surface-effect-soak-s7:' + spec.id));

  withStubbedGlobals({ raf, ResizeObserverRef }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const dom = makeNativeSoakDom(spec.styleTokens);
    const registryEntry = {
      id: spec.id,
      contractVersion: 3,
      inputMode: 'manager',
      interaction: { captureOnPress: spec.captureOnPress },
    };
    let controller = null;
    const built = makeRouterManager({
      raf,
      clock,
      registry: [registryEntry],
      dom,
      documentRef,
      factories: { [spec.id]: (factoryOptions) => {
        controller = spec.factory(factoryOptions);
        return controller;
      } },
      options: {
        effectId: spec.id,
        documentRef,
        reducedMotionQuery,
        runtime,
        rendererLaunchSeed: 17,
        sceneRole: 'chat',
      },
    });
    const { manager, cleanups } = built;

    manager.activateSurfaceEffect(spec.id);
    raf.flush();
    clock.value = raf.now;
    assert.ok(controller, spec.id + ' activates through the real manager');
    assert.equal(
      typeof (controller._internals && controller._internals.inspect),
      'function',
      spec.id + ' exposes the bounded-state inspection seam',
    );
    assertControllerOwnsNoPointerListeners(spec.id, dom);
    spec.assertBounds(controller._internals.inspect());

    let clicksFired = 0;
    let resizesFired = 0;
    let refreshesFired = 0;
    let visibilityToggles = 0;
    let motionToggles = 0;
    let disposedMidInteraction = false;

    for (let i = 0; i < MOVE_COUNT; i += 1) {
      const pointerId = (i % POINTER_ID_COUNT) + 1;
      const x = 10 + Math.floor(rand() * 780);
      const y = 10 + Math.floor(rand() * 580);
      dom.chatView.fire('pointermove', makePointerEvent('pointermove', {
        pointerId, clientX: x, clientY: y, timeStamp: i,
      }));

      if (i % MOVE_FLUSH_BATCH === 0) {
        raf.flush();
        clock.value = raf.now;
      }

      if (i % 33 === 0 && clicksFired < CLICK_COUNT) {
        const gutterX = clicksFired % 2 === 0 ? 100 : 500;
        const eventBase = { pointerId: 1, clientX: gutterX, clientY: 300, timeStamp: i };
        dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', Object.assign({ buttons: 1 }, eventBase)));
        dom.chatView.fire('pointerup', makePointerEvent('pointerup', Object.assign({ buttons: 0 }, eventBase)));
        dom.chatView.fire('click', makePointerEvent('click', Object.assign({ buttons: 0 }, eventBase)));
        clicksFired += 1;
      }

      if (i % 500 === 0 && resizesFired < RESIZE_COUNT) {
        const width = 780 + resizesFired;
        dom.chatView.rect = makeRect(0, 0, width, 600);
        dom.chatSurfaceEffectLeft.rect = makeRect(0, 0, width, 600);
        manager.refreshActiveSurfaceEffect();
        raf.flush();
        clock.value = raf.now;
        resizesFired += 1;
      }

      if (i % 700 === 0 && refreshesFired < REFRESH_COUNT) {
        const [tokenName, firstValue, secondValue] = spec.refreshToken;
        const tokenValue = refreshesFired % 2 === 0 ? firstValue : secondValue;
        [dom.homeView, dom.chatSurfaceEffectLeft]
          .forEach((host) => host.style.setProperty(tokenName, tokenValue));
        manager.refreshActiveSurfaceEffect();
        raf.flush();
        clock.value = raf.now;
        refreshesFired += 1;
      }

      if (i % 900 === 0) {
        documentRef.hidden = !documentRef.hidden;
        documentRef.fire('visibilitychange');
        visibilityToggles += 1;
      }

      if (i % 1100 === 0) {
        reducedMotionQuery.simulateChange(!reducedMotionQuery.matches);
        motionToggles += 1;
      }

      if (!disposedMidInteraction && i === Math.floor(MOVE_COUNT / 2)) {
        manager.setVisibleActivityScope({ sessionId: 'soak-session', streamId: 'soak-stream' });
        manager.publishActivityPhase('streaming');
        manager.publishStreamImpulse({
          sessionId: 'soak-session', streamId: 'soak-stream', kind: 'first-token', timeStamp: i,
        });
        dom.chatView.fire('pointerdown', makePointerEvent('pointerdown', {
          pointerId: 9, clientX: 100, clientY: 300, buttons: 1, timeStamp: i,
        }));
        manager.activateSurfaceEffect('none');
        assert.equal(manager.getStatus().activeEffectId, 'none',
          spec.id + ' disposes while a press is live');
        manager.activateSurfaceEffect(spec.id);
        raf.flush();
        clock.value = raf.now;
        assert.ok(controller, spec.id + ' reactivates after the mid-interaction dispose');
        disposedMidInteraction = true;
      }

      if (controller && i % 777 === 0) {
        spec.assertBounds(controller._internals.inspect());
      }
    }
    raf.flush();
    clock.value = raf.now;

    assert.equal(clicksFired, CLICK_COUNT, spec.id + ' receives the full click budget');
    assert.equal(resizesFired, RESIZE_COUNT, spec.id + ' receives the full resize budget');
    assert.equal(refreshesFired, REFRESH_COUNT, spec.id + ' receives the full refresh budget');
    assert.ok(disposedMidInteraction, spec.id + ' runs the dispose-mid-interaction cycle');
    assert.ok(visibilityToggles > 0 && motionToggles > 0,
      spec.id + ' exercises visibility and reduced-motion transitions');
    spec.assertBounds(controller._internals.inspect());
    assertControllerOwnsNoPointerListeners(spec.id, dom);

    const captures = dom.chatView.captureCalls.length;
    const releases = dom.chatView.releaseCalls.length;
    if (spec.captureOnPress) {
      assert.equal(captures, CLICK_COUNT + 1, spec.id + ' captures each press including the disposed press');
      assert.equal(releases, captures, spec.id + ' releases every captured press');
    } else {
      assert.equal(captures, 0, spec.id + ' does not request pointer capture');
      assert.equal(releases, 0, spec.id + ' has no pointer capture to release');
    }

    const ownedCanvases = [dom.homeView, dom.chatSurfaceEffectLeft]
      .flatMap((host) => host.children.slice());
    cleanups.forEach((cleanup) => cleanup());

    assert.equal(raf.size, 0, spec.id + ' leaves zero pending rAF handles');
    assert.equal(ResizeObserverRef.getActiveCount(), 0, spec.id + ' leaves zero active ResizeObservers');
    assert.equal(documentRef.listenerCount('visibilitychange'), 0,
      spec.id + ' removes controller and router visibility listeners');
    assert.equal(reducedMotionQuery.listenerCount(), 0, spec.id + ' removes the reduced-motion listener');
    assertAllSurfaceListenersRemoved(spec.id, dom);
    [dom.homeView, dom.chatSurfaceEffectLeft].forEach((host) => {
      assert.equal(host.children.length, 0, spec.id + ' removes every owned canvas');
    });
    ownedCanvases.forEach((canvas) => {
      POINTER_LIKE_EVENTS.forEach((eventName) => {
        assert.equal(canvas.listenerCount(eventName), 0,
          spec.id + ' leaves no listener on a detached canvas');
      });
    });
  });

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < SOAK_TIME_BUDGET_MS,
    spec.id + ' real-controller soak completes within ' + SOAK_TIME_BUDGET_MS + 'ms (took ' + elapsedMs + 'ms)');
}

REAL_NATIVE_EFFECTS.forEach((spec) => {
  test('surface-effect soak: real ' + spec.id + ' controller stays bounded and leak-free', () => {
    runRealNativeSoak(spec);
  });
});
