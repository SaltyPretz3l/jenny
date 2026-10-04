// Circuit Trace -- native contractVersion-3 controller suite for the routed-PCB
// redesign (2026-09-30). Exercises the REAL controller
// (renderer-circuit-trace-utils.js) against the fake-object environment of
// tests/helpers/surface-effect-conformance.js (no jsdom: it has no 2d canvas
// backend, so a jsdom canvas never survives ensureCanvas2d's null-context
// removal). Every canvas gets a recording 2d context so draws are countable.
//
// Production publishes one host per surface, so most cases bind one host.
// The pure board / gesture logic is covered by
// tests/renderer-circuit-trace-native.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const circuitTraceUtils = require('../renderer/shell/renderer-circuit-trace-utils.js');
const circuitTraceCore = require('../renderer/shell/renderer-circuit-trace-core.js');
const circuitTraceGestures = require('../renderer/shell/renderer-circuit-trace-gestures.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const {
  makeFixtureDocumentRef,
  makeStyledFixtureHost,
  createEffectMediaQueryList,
  buildFixtureContext,
  withStubbedGlobals,
} = require('./helpers/surface-effect-conformance.js');
const { createRafHarness, makeFakeEventTarget } = require('./helpers/surface-effect-router-harness.js');

// ── harness ─────────────────────────────────────────────────────────────────

function makeRecordingContext() {
  const target = { calls: [], sets: [], values: new Map([['globalCompositeOperation', 'source-over']]) };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) { return obj[prop]; }
      if (typeof prop === 'symbol') { return undefined; }
      if (obj.values.has(prop)) { return obj.values.get(prop); }
      return (...args) => { obj.calls.push([prop, ...args]); };
    },
    set(obj, prop, value) {
      obj.sets.push([prop, value]);
      obj.values.set(prop, value);
      return true;
    },
  });
}

function setsOf(ctx, prop) {
  return ctx.sets.filter((entry) => entry[0] === prop).map((entry) => entry[1]);
}

function callsOf(ctx, name) {
  return ctx.calls.filter((entry) => entry[0] === name);
}

function makeDocumentRef(focused) {
  const documentRef = makeFixtureDocumentRef();
  documentRef.hasFocus = () => focused;
  const createElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag) => {
    const element = createElement(tag);
    if (String(tag).toLowerCase() === 'canvas') {
      const ctx = makeRecordingContext();
      element.getContext = () => ctx;
    }
    return element;
  };
  return documentRef;
}

function makeFakeWindow() {
  return Object.assign(makeFakeEventTarget(), { devicePixelRatio: 1 });
}

function withCircuit(envOpts, fn) {
  const { reducedMotion = false, rendererLaunchSeed = 4242, focused = true } = envOpts || {};
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeDocumentRef(focused);
    const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
    const windowRef = makeFakeWindow();
    const reportCalls = [];
    const controller = circuitTraceUtils.createCircuitTraceController({
      effectId: 'circuit-trace',
      documentRef,
      windowRef,
      reducedMotionQuery,
      runtime,
      rendererLaunchSeed,
      report: (fault) => reportCalls.push(fault),
    });
    try {
      fn({ raf, documentRef, windowRef, reducedMotionQuery, controller, reportCalls });
    } finally {
      controller.dispose();
    }
  });
}

const RECT = { left: 0, top: 0, width: 800, height: 400 };
const ROLE = 'chat-left';

function contextFor(host, role, extra) {
  return buildFixtureContext(Object.assign({ hosts: [{ element: host, role: role || ROLE }] }, extra || {}));
}

function bindHost(controller, { rect = RECT, role = ROLE, tokens = {}, context = {} } = {}) {
  const host = makeStyledFixtureHost(rect, Object.assign({}, tokens));
  controller.bind(contextFor(host, role, context));
  return host;
}

function bindAndPrime(controller, raf, opts) {
  const host = bindHost(controller, opts);
  raf.flush(16);
  return host;
}

function frames(raf, count, ms = 16) {
  for (let i = 0; i < count; i += 1) { raf.flush(ms); }
}

const inspect = (controller) => controller._internals.inspect();
const bakeCtx = (host) => host.children[0].getContext('2d');
const liveCtx = (host) => host.children[1].getContext('2d');

function input(controller, type, x, y, extra = {}) {
  controller.handleInput(Object.assign({
    type, surfaceRole: ROLE, localX: x, localY: y, sceneX: x, sceneY: y,
  }, extra));
}

function netTraces(controller) {
  return controller._internals.board().traces.filter((t) => t.layer === 0 && t.bus < 0 && t.len > 60);
}

function pointOn(trace, s) {
  return circuitTraceCore.pointAt(trace, s === undefined ? trace.len / 2 : s, { x: 0, y: 0, i: 1 });
}

function keyOf(trace) {
  return trace.bus >= 0 ? `b${trace.bus}` : `t${trace.id}`;
}

// A point further than the probe keep radius from every top trace.
function emptyPoint(board) {
  const out = { t: null, s: 0, d: 0 };
  for (let y = 10; y < board.h - 10; y += 6) {
    for (let x = 10; x < board.w - 10; x += 6) {
      if (!circuitTraceCore.nearestTrace(board, x, y, 22, out)) { return { x, y }; }
    }
  }
  return null;
}

// Paints happen on frames that advance the live clock.
function countPaints(controller, raf, count) {
  let paints = 0;
  for (let i = 0; i < count; i += 1) {
    const before = inspect(controller).liveTime;
    raf.flush(16);
    if (inspect(controller).liveTime !== before) { paints += 1; }
  }
  return paints;
}

function runUntilPackets(controller, raf) {
  for (let i = 0; i < 400 && inspect(controller).packetCount === 0; i += 1) { raf.flush(16); }
  assert.ok(inspect(controller).packetCount > 0, 'idle packets started');
}

// ── two canvases per host ───────────────────────────────────────────────────

test('bind creates a baked-board canvas then a live canvas, both pointer-transparent; dispose removes both', () => {
  withCircuit({}, ({ controller, raf }) => {
    const host = bindHost(controller);
    assert.equal(host.children.length, 2, 'two canvases per host');
    const [baked, liveCanvas] = host.children;
    assert.equal(baked.className, 'widget-circuit-trace-canvas', 'the baked board is first');
    assert.deepEqual(liveCanvas.className.split(' '), ['widget-circuit-trace-canvas', 'widget-circuit-trace-live'], 'the live layer is second');
    assert.equal(baked.style.pointerEvents, 'none');
    assert.equal(liveCanvas.style.pointerEvents, 'none');
    assert.equal(inspect(controller).entries[0].hasCanvas, true);
    raf.flush(16);
    assert.equal(baked.classList.contains('surface-canvas-ready'), true, 'both canvases reveal after the first frame');
    assert.equal(liveCanvas.classList.contains('surface-canvas-ready'), true);

    controller.dispose();
    assert.equal(host.children.length, 0, 'dispose removes both canvases');
    assert.equal(raf.size, 0);
  });
});

// ── bake once ───────────────────────────────────────────────────────────────

test('the board bakes once; frames, hover and chains never re-bake; palette, DPR, placement and occlusion changes do', () => {
  withCircuit({}, ({ controller, raf, windowRef }) => {
    const scene = RECT;
    const host = makeStyledFixtureHost(Object.assign({}, RECT));
    const ctxOf = (overrides) => buildFixtureContext(Object.assign({
      hosts: [{ element: host, role: ROLE }], sceneRect: scene, hostRects: [host.rect],
    }, overrides || {}));
    controller.bind(ctxOf());
    assert.equal(inspect(controller).bakeCount, 0, 'nothing bakes until the first frame');
    raf.flush(16);
    assert.equal(inspect(controller).bakeCount, 1, 'one bake per host after the first frame');
    assert.equal(inspect(controller).buildCount, 1);
    const callsAfterBake = bakeCtx(host).calls.length;
    assert.ok(callsAfterBake > 500, 'the bake drew the board');

    const t = netTraces(controller)[0];
    const p = pointOn(t);
    input(controller, 'move', p.x, p.y);
    input(controller, 'click', p.x, p.y);
    frames(raf, 200);
    assert.equal(inspect(controller).bakeCount, 1, '200 animated frames with a hover and a chain never re-bake');
    assert.equal(bakeCtx(host).calls.length, callsAfterBake, 'and never touch the baked canvas');

    controller.refresh(ctxOf());
    frames(raf, 4);
    assert.equal(inspect(controller).bakeCount, 1, 'an identical refresh does not re-bake');

    host.style.setProperty('--widget-circuit-trace-grid-color', 'rgba(10, 20, 30, 0.5)');
    controller.refresh(ctxOf());
    frames(raf, 4);
    assert.equal(inspect(controller).bakeCount, 2, 'a palette colour change bakes again');
    assert.ok(setsOf(bakeCtx(host), 'strokeStyle').includes('rgba(10, 20, 30, 0.5)'), 'with the new colour');
    frames(raf, 40);
    assert.equal(inspect(controller).bakeCount, 2, 'once');

    host.style.setProperty('--widget-circuit-trace-line-color', 'rgba(1, 2, 3, 0.5)');
    controller.refresh(ctxOf());
    frames(raf, 4);
    assert.equal(inspect(controller).bakeCount, 2, 'the live-layer colours are not baked: a line colour change does not re-bake');

    windowRef.devicePixelRatio = 1.5;
    frames(raf, 4);
    assert.equal(inspect(controller).bakeCount, 3, 'a DPR-only change re-bakes once');
    assert.equal(host.children[0].width, 1200, 'the backing store followed the ratio');
    frames(raf, 40);
    assert.equal(inspect(controller).bakeCount, 3);

    host.rect = { left: 40, top: 0, width: 800, height: 400 };
    controller.refresh(ctxOf({ hostRects: [host.rect] }));
    frames(raf, 4);
    assert.equal(inspect(controller).bakeCount, 4, 'a moved host window re-bakes');
    assert.equal(inspect(controller).buildCount, 1, 'without rebuilding the board');

    controller.refresh(ctxOf({ hostRects: [host.rect], paintOcclusionRects: [{ left: 240, top: 100, width: 100, height: 60 }] }));
    frames(raf, 4);
    assert.equal(inspect(controller).bakeCount, 5, 'a new paint occlusion re-bakes');
    const clears = callsOf(bakeCtx(host), 'clearRect');
    assert.deepEqual(clears.at(-1), ['clearRect', 200, 100, 100, 60],
      'and the occlusion (projected into host space) is cleared from the baked board after the draw');
    assert.ok(clears.length >= 2, 'after the full-window clear that precedes the draw');
  });
});

test('with two hosts every host bakes once per change', () => {
  withCircuit({}, ({ controller, raf }) => {
    const left = makeStyledFixtureHost({ left: 0, top: 0, width: 400, height: 400 });
    const right = makeStyledFixtureHost({ left: 400, top: 0, width: 400, height: 400 });
    controller.bind(buildFixtureContext({
      hosts: [{ element: left, role: ROLE }, { element: right, role: ROLE }],
      sceneRect: { left: 0, top: 0, width: 800, height: 400 },
      hostRects: [left.rect, right.rect],
    }));
    raf.flush(16);
    assert.equal(inspect(controller).bakeCount, 2, 'one bake per host');
    frames(raf, 100);
    assert.equal(inspect(controller).bakeCount, 2);
    assert.notDeepEqual(bakeCtx(left).calls, bakeCtx(right).calls, 'each host baked its own window of the scene');
  });
});

// ── frame budget ────────────────────────────────────────────────────────────

test('frame cap: full while packets move, idle (30 fps) when nothing moves or the window is unfocused', () => {
  withCircuit({}, ({ controller, raf, windowRef }) => {
    bindAndPrime(controller, raf);
    const quiet = countPaints(controller, raf, 12);
    assert.equal(inspect(controller).packetCount, 0, 'nothing is moving yet');
    assert.equal(inspect(controller).responding, false);
    assert.equal(inspect(controller).frameCap, 'idle', 'focused with nothing moving takes the idle cap');
    assert.ok(quiet >= 5 && quiet <= 7, `idle paints about every other 60 Hz frame, got ${quiet}/12`);

    runUntilPackets(controller, raf);
    raf.flush(16);
    assert.equal(inspect(controller).responding, true);
    assert.equal(inspect(controller).frameCap, 'full', 'focused with packets moving runs at full rate');
    assert.equal(countPaints(controller, raf, 15), 15, 'every frame paints at full rate');

    windowRef.fire('blur');
    raf.flush(16);
    assert.equal(inspect(controller).windowFocused, false);
    assert.equal(inspect(controller).responding, true, 'still moving, but unfocused');
    assert.equal(inspect(controller).frameCap, 'idle', 'an unfocused window always takes the idle cap');
    const blurred = countPaints(controller, raf, 20);
    assert.ok(blurred >= 9 && blurred <= 11, `unfocused paints at about 30 fps, got ${blurred}/20`);

    windowRef.fire('focus');
    raf.flush(16);
    assert.equal(inspect(controller).frameCap, 'full', 'refocus restores full rate while packets move');
  });
});

// ── input ───────────────────────────────────────────────────────────────────

test('a non-primary pointer is ignored first: neither its moves, clicks nor cancel touch the primary hover', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    const t = netTraces(controller)[0];
    const p = pointOn(t);
    input(controller, 'move', p.x, p.y, { isPrimary: false });
    input(controller, 'click', p.x, p.y, { isPrimary: false });
    assert.equal(inspect(controller).pointerOn, false, 'a secondary move never starts a hover');
    assert.equal(inspect(controller).litCount, 0, 'a secondary click lights nothing');

    input(controller, 'move', p.x, p.y, { isPrimary: true });
    assert.equal(inspect(controller).pointerOn, true);
    input(controller, 'cancel', 0, 0, { isPrimary: false });
    input(controller, 'leave', 0, 0, { isPrimary: false });
    assert.equal(inspect(controller).pointerOn, true, 'a secondary cancel/leave keeps the primary hover');
    input(controller, 'cancel', 0, 0, { isPrimary: true });
    assert.equal(inspect(controller).pointerOn, false, 'the primary cancel clears it');
  });
});

test('hover over a trace probes its signal; moving off clears the key; leave drops the pointer', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    const board = controller._internals.board();
    const t = netTraces(controller)[0];
    const p = pointOn(t);
    input(controller, 'enter', p.x, p.y);
    assert.equal(inspect(controller).pointerOn, true);
    assert.equal(inspect(controller).probeKey, keyOf(t), 'enter over a trace probes it');
    assert.equal(inspect(controller).probes.length, 1);

    const bus = board.buses.find((b) => !b.pair && b.traces.length >= 2);
    const lane = pointOn(board.traces[bus.traces[0]]);
    input(controller, 'move', lane.x, lane.y);
    assert.equal(inspect(controller).probeKey, `b${bus.id}`, 'move onto a bus probes the whole bus');

    const away = emptyPoint(board);
    assert.ok(away, 'the fixture board has open copper-free space');
    input(controller, 'move', away.x, away.y);
    assert.equal(inspect(controller).probeKey, '', 'off the copper nothing is probed');

    input(controller, 'move', p.x, p.y);
    assert.equal(inspect(controller).probeKey, keyOf(t));
    input(controller, 'leave', p.x, p.y);
    assert.equal(inspect(controller).pointerOn, false, 'leave clears the pointer');
    frames(raf, 150);
    assert.equal(inspect(controller).probes.length, 0, 'and the probe fades away');
  });
});

test('click on a trace schedules lit segments; cancel clears the pointer but the chain in flight keeps lighting', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    const t = netTraces(controller)[0];
    const p = pointOn(t);
    assert.equal(inspect(controller).litCount, 0);
    input(controller, 'click', p.x, p.y);
    const snapshot = inspect(controller);
    assert.ok(snapshot.litCount > 0, 'the click scheduled lit segments');
    assert.ok(snapshot.flashCount > 0, 'and arrival flashes');
    assert.equal(snapshot.pointerOn, true, 'a click also places the pointer');
    assert.ok(snapshot.quietUntil > snapshot.liveTime, 'and holds idle packets off');

    input(controller, 'cancel', 0, 0);
    assert.equal(inspect(controller).pointerOn, false, 'cancel clears the pointer');
    assert.equal(inspect(controller).litCount, snapshot.litCount, 'a chain in flight keeps its lit segments');
    frames(raf, 2);
    assert.equal(inspect(controller).litCount, snapshot.litCount, 'and they survive the following frames');
  });
});

test('a click inside a spawn-avoidance rect does nothing; one elsewhere still fires', () => {
  withCircuit({}, ({ controller, raf }) => {
    const rect = { left: 100, top: 40, width: 800, height: 400 };
    const host = makeStyledFixtureHost(rect);
    controller.bind(buildFixtureContext({ hosts: [{ element: host, role: ROLE }], sceneRect: rect, hostRects: [rect] }));
    raf.flush(16);
    const traces = netTraces(controller);
    const p = pointOn(traces[0]);
    const blocked = { left: rect.left + p.x - 10, top: rect.top + p.y - 10, width: 20, height: 20 };
    controller.refresh(buildFixtureContext({
      hosts: [{ element: host, role: ROLE }], sceneRect: rect, hostRects: [rect], spawnAvoidanceRects: [blocked],
    }));
    input(controller, 'click', p.x, p.y);
    assert.equal(inspect(controller).litCount, 0, 'no chain starts inside the avoidance rect');
    assert.equal(inspect(controller).pointerOn, false, 'and the click places no pointer');
    const far = traces.find((t) => Math.hypot(pointOn(t).x - p.x, pointOn(t).y - p.y) > 60);
    const q = pointOn(far);
    input(controller, 'click', q.x, q.y);
    assert.ok(inspect(controller).litCount > 0, 'the same click elsewhere keeps the oracle non-vacuous');
  });
});

test('press and release carry no gesture: nothing lights and no state changes', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    const p = pointOn(netTraces(controller)[0]);
    const before = inspect(controller);
    input(controller, 'press', p.x, p.y, { buttons: 1, isPrimary: true });
    input(controller, 'release', p.x, p.y);
    assert.deepEqual(inspect(controller), before, 'press/release leave the controller exactly as it was');
    assert.equal(inspect(controller).litCount, 0);
    assert.equal(inspect(controller).probeKey, '');
  });
});

test('input for a role with no host is a safe no-op, and handleInput never reads host layout', () => {
  withCircuit({}, ({ controller, raf }) => {
    const host = bindAndPrime(controller, raf);
    let layoutReads = 0;
    const original = host.getBoundingClientRect;
    host.getBoundingClientRect = (...args) => { layoutReads += 1; return original.apply(host, args); };
    const before = inspect(controller);
    controller.handleInput({ type: 'move', surfaceRole: 'home', localX: 1, localY: 1 });
    assert.deepEqual(inspect(controller), before);
    const p = pointOn(netTraces(controller)[0]);
    input(controller, 'move', p.x, p.y);
    input(controller, 'click', p.x, p.y);
    assert.equal(layoutReads, 0, 'router-normalized payloads only');
  });
});

test('after a click and a wait, hover over the same signal lights again once the pointer moves on', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    const t = netTraces(controller)[0];
    const p = pointOn(t, t.len * 0.4);
    const q = pointOn(t, t.len * 0.4 + 12);
    input(controller, 'move', p.x, p.y);
    frames(raf, 30);
    input(controller, 'click', p.x, p.y);
    frames(raf, 100);
    assert.equal(inspect(controller).probes.length, 0, 'the click quieted the probe and it faded out');
    input(controller, 'move', q.x, q.y);
    frames(raf, 30);
    const slot = inspect(controller).probes.find((entry) => entry.key === keyOf(t));
    assert.ok(slot && slot.fade > 0.9, 'hover is alive again after the wait');
  });
});

// ── reduced motion ──────────────────────────────────────────────────────────

test('reduced motion: no loop runs, a click pins the planned chain statically, hover is binary', () => {
  withCircuit({ reducedMotion: true }, ({ controller, raf }) => {
    const host = bindHost(controller);
    assert.equal(inspect(controller).bakeCount, 1, 'the static frame bakes at bind');
    raf.flush(16);
    assert.equal(raf.size, 0, 'only the one-shot reveal frame ran; no loop is scheduled');
    frames(raf, 5);
    assert.equal(raf.size, 0);

    const t = netTraces(controller)[0];
    const p = pointOn(t);
    input(controller, 'move', p.x, p.y);
    const hovered = inspect(controller);
    assert.equal(hovered.probes.length, 1);
    assert.equal(hovered.probes[0].fade, 1, 'the probe is binary: fully on at once');
    assert.equal(hovered.frameCap, 'full', 'no frame was scheduled');

    const glow = runtime.readStyleToken(null, '--widget-circuit-trace-glow-color');
    const strokesBefore = callsOf(liveCtx(host), 'stroke').length;
    assert.equal(setsOf(liveCtx(host), 'strokeStyle').includes(glow), false, 'no chain drawn yet');
    input(controller, 'click', p.x, p.y);
    const clicked = inspect(controller);
    assert.ok(clicked.pinnedCount > 0, 'the click pins the planned chain');
    assert.equal(clicked.litCount, 0, 'nothing is scheduled to animate');
    assert.equal(clicked.packetCount, 0);
    assert.ok(callsOf(liveCtx(host), 'stroke').length > strokesBefore, 'the chain was drawn at once');
    assert.ok(setsOf(liveCtx(host), 'strokeStyle').includes(glow), 'in the glow colour on the live canvas');
    assert.equal(raf.size, 0, 'and still no loop');

    input(controller, 'leave', p.x, p.y);
    assert.equal(inspect(controller).probes.length, 0, 'the binary probe is gone right after leave');
    assert.equal(raf.size, 0);
  });
});

test('switching to reduced motion mid-hover freezes the loop and keeps a binary probe; switching back resumes', () => {
  withCircuit({}, ({ controller, raf, reducedMotionQuery }) => {
    bindAndPrime(controller, raf);
    const p = pointOn(netTraces(controller)[0]);
    input(controller, 'move', p.x, p.y);
    frames(raf, 3);
    reducedMotionQuery.simulateChange(true);
    assert.equal(raf.size, 0, 'the loop stops at once');
    assert.equal(inspect(controller).probes[0].fade, 1, 'the live pointer is answered with the binary probe');
    assert.equal(inspect(controller).packetCount, 0, 'packets in flight are dropped');
    reducedMotionQuery.simulateChange(false);
    assert.ok(raf.size > 0, 'leaving reduced motion restarts the loop');
  });
});

// ── no activity channel ─────────────────────────────────────────────────────

test('the controller has no activity channel: no setActivity, no handleActivityImpulse', () => {
  withCircuit({}, ({ controller, raf }) => {
    assert.equal(controller.setActivity, undefined);
    assert.equal(controller.handleActivityImpulse, undefined);
    assert.deepEqual(Object.keys(controller).sort(), ['_internals', 'bind', 'dispose', 'getStatus', 'handleInput', 'refresh']);
    bindAndPrime(controller, raf);
    const snapshot = inspect(controller);
    ['scopeEpoch', 'currentEnergy', 'targetEnergy', 'attentionScale', 'visualBoost', 'activityFactor', 'pointerEnergy']
      .forEach((key) => assert.equal(key in snapshot, false, `${key} is not part of inspect()`));
  });
});

// ── resize settle ───────────────────────────────────────────────────────────

test('a size-only resize rebuilds once after it settles for 150 ms, not once per refresh', () => {
  withCircuit({}, ({ controller, raf }) => {
    const host = bindAndPrime(controller, raf);
    const first = controller._internals.board();
    assert.equal(inspect(controller).buildCount, 1);
    for (const width of [820, 860, 900]) {
      host.rect = { left: 0, top: 0, width, height: 400 };
      controller.refresh(contextFor(host));
      assert.equal(inspect(controller).buildCount, 1, `a refresh at ${width}px does not rebuild`);
    }
    assert.equal(inspect(controller).resizePending, true);
    assert.equal(controller._internals.board(), first, 'the old board keeps painting while the drag continues');
    frames(raf, 4);
    assert.equal(inspect(controller).buildCount, 1, 'still inside the settle window');
    frames(raf, 16);
    const settled = inspect(controller);
    assert.equal(settled.resizePending, false);
    assert.equal(settled.buildCount, 2, 'exactly one rebuild after the settle');
    assert.equal(controller._internals.board().w, 900, 'for the final size');
    frames(raf, 20);
    assert.equal(inspect(controller).buildCount, 2, 'and no more');
  });
});

test('entering reduced motion mid-resize applies the pending geometry at once', () => {
  withCircuit({}, ({ controller, raf, reducedMotionQuery }) => {
    const host = bindAndPrime(controller, raf);
    host.rect = { left: 0, top: 0, width: 960, height: 400 };
    controller.refresh(contextFor(host));
    assert.equal(inspect(controller).resizePending, true);
    reducedMotionQuery.simulateChange(true);
    assert.equal(inspect(controller).resizePending, false, 'no resize is stranded');
    assert.equal(controller._internals.board().w, 960, 'the static frame paints the settled board');
    assert.equal(inspect(controller).buildCount, 2);
  });
});

// ── tokens, determinism, loop pause ─────────────────────────────────────────

test('pitch and density tokens clamp, and malformed tokens fall back to defaults without crashing', () => {
  const pitchOf = (token) => {
    let pitch = 0;
    withCircuit({}, ({ controller }) => {
      bindHost(controller, { tokens: { '--widget-circuit-trace-pitch': token } });
      pitch = controller._internals.board().pitch;
    });
    return pitch;
  };
  assert.equal(pitchOf('0px'), circuitTraceCore.MIN_PITCH, 'a zero pitch clamps to the minimum');
  assert.equal(pitchOf('9999px'), circuitTraceCore.MAX_PITCH, 'a huge pitch clamps to the maximum');
  assert.equal(pitchOf('banana'), circuitTraceCore.DEFAULT_PITCH, 'a malformed pitch falls back to the default');

  const nodesFor = (density) => {
    let count = 0;
    withCircuit({}, ({ controller }) => {
      assert.doesNotThrow(() => bindHost(controller, { tokens: { '--widget-circuit-trace-density': density } }));
      count = inspect(controller).nodeCount;
    });
    return count;
  };
  const sparse = nodesFor('0.0001');
  const dense = nodesFor('9999');
  assert.ok(dense > sparse, `density clamps to [0.1, 3]: dense=${dense} sparse=${sparse}`);
  assert.ok(nodesFor('NaNville') > 0, 'a malformed density still builds a drawable board');
});

// Regression (Astra 2026-09-30): an empty board never paints a frame, so a
// rebuild into one must wipe both canvases itself or the old board lingers.
for (const reducedMotion of [false, true]) {
  test(`a populated -> empty -> populated rebuild clears both canvases (reducedMotion=${reducedMotion})`, () => {
    withCircuit({ reducedMotion }, ({ raf, controller }) => {
      const rect = { left: 0, top: 0, width: 160, height: 100 };
      const host = bindAndPrime(controller, raf, { rect, tokens: { '--widget-circuit-trace-pitch': '10px' } });
      frames(raf, 4);
      assert.ok(inspect(controller).nodeCount > 0, 'pitch 10 builds a board in 160x100');
      const builds = inspect(controller).buildCount;
      const fullClears = (ctx) => callsOf(ctx, 'clearRect')
        .filter((c) => c[1] === 0 && c[2] === 0 && c[3] === host.children[0].width && c[4] === host.children[0].height).length;
      const bakeBefore = fullClears(bakeCtx(host));
      const liveBefore = fullClears(liveCtx(host));

      host.style.setProperty('--widget-circuit-trace-pitch', '28px');
      controller.refresh(contextFor(host));
      frames(raf, 4);
      assert.equal(inspect(controller).buildCount, builds + 1, 'the pitch change rebuilds');
      assert.equal(inspect(controller).nodeCount, 0, 'pitch 28 leaves the 160x100 host empty');
      assert.ok(fullClears(bakeCtx(host)) > bakeBefore, 'the baked board is wiped');
      assert.ok(fullClears(liveCtx(host)) > liveBefore, 'and so is the live layer');

      const bakes = inspect(controller).bakeCount;
      host.style.setProperty('--widget-circuit-trace-pitch', '10px');
      controller.refresh(contextFor(host));
      frames(raf, 4);
      assert.ok(inspect(controller).nodeCount > 0, 'back to pitch 10 rebuilds a board');
      assert.equal(inspect(controller).bakeCount, bakes + 1, 'and bakes it again');
    });
  });
}

test('the same seed and role rebuild the same board; a different role or launch seed diverges', () => {
  function build(seed, role) {
    let result;
    withCircuit({ rendererLaunchSeed: seed }, ({ controller, raf }) => {
      bindAndPrime(controller, raf, { role });
      const board = controller._internals.board();
      result = { seed: inspect(controller).entries[0].seed, shape: JSON.stringify(board.nodes.map((n) => [n.kind, n.x, n.y])) };
    });
    return result;
  }
  const a = build(4242, ROLE);
  const b = build(4242, ROLE);
  assert.equal(a.seed, b.seed);
  assert.equal(a.shape, b.shape, 'same seed and role reproduce the same board');
  assert.notEqual(build(4242, 'home').seed, a.seed, 'home and chat scenes seed differently');
  assert.notEqual(build(4243, ROLE).shape, a.shape, 'a different launch seed diverges');
});

test('the frame loop pauses while the document is hidden and resumes when visible', () => {
  withCircuit({}, ({ controller, raf, documentRef }) => {
    bindAndPrime(controller, raf);
    assert.ok(raf.size > 0, 'an animated controller keeps a frame scheduled');
    documentRef.hidden = true;
    documentRef.fire('visibilitychange');
    assert.equal(raf.size, 0, 'going hidden cancels the pending frame');
    raf.flush(5000);
    assert.equal(raf.size, 0, 'no frame is scheduled while hidden');
    documentRef.hidden = false;
    documentRef.fire('visibilitychange');
    assert.ok(raf.size > 0, 'becoming visible reschedules the loop');
  });
});

// ── faults, status, teardown ────────────────────────────────────────────────

test('an advance fault is reported and the frame loop stays scheduled', () => {
  withCircuit({}, ({ controller, raf, reportCalls }) => {
    bindAndPrime(controller, raf);
    const original = circuitTraceGestures.advanceLive;
    let thrown = false;
    circuitTraceGestures.advanceLive = (...args) => {
      if (!thrown) { thrown = true; throw new Error('induced advance fault'); }
      return original(...args);
    };
    try {
      frames(raf, 3);
    } finally {
      circuitTraceGestures.advanceLive = original;
    }
    assert.equal(thrown, true);
    assert.equal(reportCalls.length, 1, 'the fault escapes to the manager');
    assert.ok(raf.size > 0, 'the loop is still scheduled');
    frames(raf, 3);
    assert.equal(reportCalls.length, 1, 'the next frames run clean');
  });
});

test('a fault report that disposes the controller mid-frame queues no further frame', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    let controller = null;
    controller = circuitTraceUtils.createCircuitTraceController({
      effectId: 'circuit-trace',
      documentRef: makeDocumentRef(true),
      windowRef: makeFakeWindow(),
      reducedMotionQuery: createEffectMediaQueryList(false),
      runtime,
      report: () => controller.dispose(),
    });
    bindAndPrime(controller, raf);
    const original = circuitTraceGestures.advanceLive;
    circuitTraceGestures.advanceLive = () => { throw new Error('induced advance fault'); };
    try {
      frames(raf, 3);
    } finally {
      circuitTraceGestures.advanceLive = original;
    }
    assert.equal(inspect(controller).disposed, true);
    assert.equal(raf.size, 0, 'no post-dispose continuation is scheduled');
  });
});

test('a zero-size scene paints nothing and reports no fault; getStatus follows the host size', () => {
  withCircuit({}, ({ controller, raf, reportCalls }) => {
    const host = bindHost(controller, { rect: { left: 0, top: 0, width: 0, height: 0 } });
    frames(raf, 5);
    assert.deepEqual(reportCalls, []);
    assert.equal(inspect(controller).nodeCount, 0, 'no board is built for an empty scene');
    assert.deepEqual(controller.getStatus(), { state: 'dormant', hostCount: 1, drawableHostCount: 0, reason: 'no drawable host' });
    host.rect = Object.assign({}, RECT);
    controller.refresh(contextFor(host));
    raf.flush(16);
    assert.deepEqual(controller.getStatus(), { state: 'ready', hostCount: 1, drawableHostCount: 1, reason: '' });
    assert.ok(inspect(controller).nodeCount > 0, 'the board appears once the host has size');
  });
});

test('a staged bind never reveals; un-staging reveals after one frame', () => {
  withCircuit({}, ({ controller, raf }) => {
    const host = bindHost(controller, { context: { staged: true } });
    frames(raf, 2);
    assert.equal(inspect(controller).entries[0].readyShown, false, 'a staged host never shows ready');
    controller.refresh(contextFor(host, ROLE, { staged: false }));
    assert.equal(inspect(controller).entries[0].readyShown, false, 'reveal waits for the next frame');
    raf.flush(16);
    assert.equal(inspect(controller).entries[0].readyShown, true);
  });
});

test('setQualityOverride pins the tier, null clears it, and a non-numeric value is treated as null', () => {
  withCircuit({}, ({ controller, raf }) => {
    bindAndPrime(controller, raf);
    controller._internals.setQualityOverride(0.55);
    assert.equal(inspect(controller).qualityScale, 0.55);
    controller._internals.setQualityOverride(null);
    assert.equal(inspect(controller).qualityScale, 1);
    controller._internals.setQualityOverride('junk');
    assert.equal(inspect(controller).qualityScale, 1, 'a non-numeric value clears the override');
  });
});

test('dispose tears down rAF, listeners and canvases, is idempotent, and later calls are inert', () => {
  withCircuit({}, ({ controller, raf, documentRef, windowRef, reducedMotionQuery }) => {
    const host = bindAndPrime(controller, raf);
    assert.equal(windowRef.listenerCount('blur'), 1, 'bind listens for window blur');
    const p = pointOn(netTraces(controller)[0]);
    input(controller, 'click', p.x, p.y);

    controller.dispose();
    assert.equal(raf.size, 0, 'dispose cancels every pending rAF');
    assert.equal(documentRef.listenerCount('visibilitychange'), 0);
    assert.equal(reducedMotionQuery.listenerCount(), 0);
    assert.equal(windowRef.listenerCount('focus'), 0);
    assert.equal(windowRef.listenerCount('blur'), 0);
    assert.equal(host.children.length, 0, 'both canvases are removed');

    assert.doesNotThrow(() => controller.dispose(), 'a second dispose is idempotent');
    const before = inspect(controller);
    input(controller, 'move', 99, 99);
    assert.equal(inspect(controller).disposed, true);
    assert.deepEqual(inspect(controller), before, 'no post-dispose call changes observable state');
  });
});
