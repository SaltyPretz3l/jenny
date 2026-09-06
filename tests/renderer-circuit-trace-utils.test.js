// Circuit Trace -- core/pure-behavior + native-path style suite (Background
// Effects v3 packet S5 slice W2 surgery).
//
// The legacy suite this file replaces exercised a root-discovery / setPointer
// / own-listener controller API that no longer exists: circuit-trace is now
// the native contractVersion-3 controller (renderer-circuit-trace-utils.js +
// renderer-circuit-trace-core.js), whose input arrives exclusively through
// the manager's router (handleInput/setActivity/handleActivityImpulse) and
// whose hosts arrive through bind(context)/refresh(context) -- see
// tests/renderer-circuit-trace-native.test.js for that interactive surface.
//
// This file keeps (and rehomes) the tests of durable core/pure behavior:
//   - renderer-circuit-trace-core.js's pure geometry/trail/version helpers,
//     unit-tested directly with no DOM at all.
//   - readStyles()-style CSS token clamping, version-dataset mirroring on
//     refresh, and malformed-token tolerance, driven through the real native
//     controller against the SAME fake-object environment
//     tests/helpers/surface-effect-conformance.js uses elsewhere (jsdom has
//     no real 2d canvas backend, so a jsdom-rendered canvas never survives
//     runtime.ensureCanvas2d's null-context removal -- these fakes do).
//   - the frame-loop's reduced-motion / document-hidden pause behavior, the
//     replacement for the deleted "own mousemove listener" + "own
//     ResizeObserver instance" tests (input and resize are manager-owned now;
//     the loop-pause contract is the piece of that surface still owned here).
//
// Deleted outright (behavior removed, no replacement needed): setPointer/
// clearPointer, root-based host discovery via querySelectorAll, the
// controller's own mousemove/mouseleave DOM listeners, and per-host
// ResizeObserver instance bookkeeping (bare bind() with no context).

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../renderer/shell/renderer-circuit-trace-core.js');
const circuitTraceUtils = require('../renderer/shell/renderer-circuit-trace-utils.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const {
  makeFixtureDocumentRef,
  makeStyledFixtureHost,
  createEffectMediaQueryList,
  buildFixtureContext,
  withStubbedGlobals,
} = require('./helpers/surface-effect-conformance.js');
const { createRafHarness, makeFakeSurfaceElement } = require('./helpers/surface-effect-router-harness.js');

test('core.makeRng remains half-open for a seed whose first state is uint32 max', () => {
  const value = core.makeRng(0xf85809cf)();
  assert.ok(value >= 0 && value < 1, `expected [0, 1), got ${value}`);
  assert.equal(Math.floor(value * 10) < 10, true, 'array index remains in bounds');
});

// ── core.js: pure geometry / graph helpers ─────────────────────────────────

test('core.buildHexGraph builds a deduplicated node/edge/cell graph covering the requested bounds', () => {
  const rng = core.makeRng(7);
  const graph = core.buildHexGraph(200, 150, 32, rng);
  assert.ok(graph.nodes.length > 0, 'graph has nodes');
  assert.ok(graph.edges.length > 0, 'graph has edges');
  assert.ok(graph.cells.length > 0, 'graph has cells');
  for (const cell of graph.cells) {
    assert.equal(cell.edgeIdxs.length, 6, 'each cell has 6 edge slots');
    cell.edgeIdxs.forEach((idx) => {
      assert.ok(idx >= 0 && idx < graph.edges.length, 'edge index resolves into the shared edges array');
    });
  }
  const seen = new Set();
  graph.edges.forEach((edge) => {
    const key = `${Math.min(edge.a, edge.b)}|${Math.max(edge.a, edge.b)}`;
    assert.equal(seen.has(key), false, 'no duplicate edge for a given node pair');
    seen.add(key);
  });
});

test('core.buildHexGraph clamps an out-of-range hex radius before building', () => {
  const tooSmall = core.buildHexGraph(300, 300, 1, core.makeRng(1));
  const tooLarge = core.buildHexGraph(300, 300, 5000, core.makeRng(1));
  // A radius clamped to MIN_HEX_SIZE produces a far denser graph than one
  // clamped to MAX_HEX_SIZE over the same area -- the only externally
  // observable signature of the internal clamp(r, MIN_HEX_SIZE, MAX_HEX_SIZE).
  assert.ok(tooSmall.nodes.length > tooLarge.nodes.length,
    `expected a MIN-clamped radius to be denser than a MAX-clamped one: small=${tooSmall.nodes.length} large=${tooLarge.nodes.length}`);
});

test('core.pickNeighbor avoids the forbidden index when an alternative exists', () => {
  const node = { neighbors: [2, 5] };
  assert.equal(core.pickNeighbor(node, 2, () => 0), 5, 'the only non-forbidden neighbor is picked regardless of rng value');
  assert.equal(core.pickNeighbor(node, 2, () => 0.999), 5);
});

test('core.pickNeighbor falls back to the forbidden index when it is the only neighbor', () => {
  const node = { neighbors: [9] };
  assert.equal(core.pickNeighbor(node, 9, () => 0.5), 9, 'a single-neighbor node has no alternative to avoid the forbidden index');
});

test('core.pickNeighbor returns -1 for a node with no neighbors', () => {
  assert.equal(core.pickNeighbor({ neighbors: [] }, 0, () => 0.5), -1);
});

test('core.buildTraces returns no traces when every node is isolated', () => {
  const nodes = [{ neighbors: [] }, { neighbors: [] }, { neighbors: [] }];
  assert.equal(core.buildTraces({ nodes }, 5, core.makeRng(1)).length, 0);
});

test('core.buildTraces builds exactly the requested count when every node has a neighbor', () => {
  const nodes = [{ neighbors: [1] }, { neighbors: [0] }, { neighbors: [1] }];
  const traces = core.buildTraces({ nodes }, 7, core.makeRng(1));
  assert.equal(traces.length, 7);
  traces.forEach((tr) => {
    assert.ok(tr.speed >= 0.00045 && tr.speed < 0.00045 + 0.0006, 'trace speed lands within the configured range');
    assert.ok(tr.t >= 0 && tr.t < 1, 'initial trace progress t is within [0,1)');
  });
});

test('core.buildTraces returns an empty array for an empty graph', () => {
  assert.deepEqual(core.buildTraces({ nodes: [] }, 5, () => 0.5), []);
});

test('core.colorForTrace maps trace hue to the correct entry color', () => {
  const entry = { lineColor: 'LINE', glowColor: 'GLOW', accentColor: 'ACCENT' };
  assert.equal(core.colorForTrace(entry, { hue: 0 }), 'LINE');
  assert.equal(core.colorForTrace(entry, { hue: 1 }), 'GLOW');
  assert.equal(core.colorForTrace(entry, { hue: 2 }), 'ACCENT');
});

// ── core.js: trail buffer + path helpers ───────────────────────────────────

test('core.pushTrailPoint/getTrailPoint maintain a circular buffer with correct offsets', () => {
  const tr = { trailPoints: Array.from({ length: 3 }, () => ({ x: 0, y: 0 })), trailHead: -1, trailSize: 0 };
  assert.equal(core.getTrailPoint(tr, 0), null, 'empty buffer returns null');
  core.pushTrailPoint(tr, 1, 1);
  core.pushTrailPoint(tr, 2, 2);
  core.pushTrailPoint(tr, 3, 3);
  assert.deepEqual(core.getTrailPoint(tr, 0), { x: 3, y: 3 }, 'offset 0 is the most recent point');
  assert.deepEqual(core.getTrailPoint(tr, 1), { x: 2, y: 2 });
  assert.deepEqual(core.getTrailPoint(tr, 2), { x: 1, y: 1 }, 'offset 2 is the oldest retained point');
  core.pushTrailPoint(tr, 4, 4);
  assert.deepEqual(core.getTrailPoint(tr, 0), { x: 4, y: 4 });
  assert.deepEqual(core.getTrailPoint(tr, 2), { x: 2, y: 2 }, 'the oldest point rotates out once capacity is exceeded');
  assert.equal(tr.trailSize, 3, 'trailSize caps at buffer capacity');
});

function makePathRecorder() {
  const calls = [];
  return {
    calls,
    beginPath() { calls.push(['beginPath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    quadraticCurveTo(cx, cy, x, y) { calls.push(['quadraticCurveTo', cx, cy, x, y]); },
  };
}

function freshTrail(capacity) {
  return { trailPoints: Array.from({ length: capacity }, () => ({ x: 0, y: 0 })), trailHead: -1, trailSize: 0 };
}

test('core.strokeTrailPath returns false and draws nothing for fewer than 2 points', () => {
  const tr = freshTrail(4);
  const ctx = makePathRecorder();
  assert.equal(core.strokeTrailPath(ctx, tr, 40), false, 'zero points is not a path');
  assert.equal(ctx.calls.length, 0);
  core.pushTrailPoint(tr, 1, 1);
  assert.equal(core.strokeTrailPath(ctx, tr, 40), false, 'a single point is not a path');
});

test('core.strokeTrailPath draws a straight segment for exactly 2 points', () => {
  const tr = freshTrail(4);
  core.pushTrailPoint(tr, 0, 0);
  core.pushTrailPoint(tr, 10, 10);
  const ctx = makePathRecorder();
  assert.equal(core.strokeTrailPath(ctx, tr, 40), true);
  // Drawing walks from the newest point (offset 0) back to the oldest.
  assert.deepEqual(ctx.calls, [['beginPath'], ['moveTo', 10, 10], ['lineTo', 0, 0]]);
});

test('core.strokeTrailPath uses a quadratic curve to smooth 3+ point trails', () => {
  const tr = freshTrail(4);
  core.pushTrailPoint(tr, 0, 0);
  core.pushTrailPoint(tr, 10, 0);
  core.pushTrailPoint(tr, 20, 0);
  const ctx = makePathRecorder();
  assert.equal(core.strokeTrailPath(ctx, tr, 40), true);
  const kinds = ctx.calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['beginPath', 'moveTo', 'quadraticCurveTo', 'lineTo'],
    'a 3-point trail draws one smoothing curve then a final lineTo to the newest point');
});

test('core.strokeTrailPath respects the maxLength cap even with a larger trailSize', () => {
  const tr = freshTrail(6);
  [0, 1, 2, 3, 4, 5].forEach((n) => core.pushTrailPoint(tr, n, n));
  const ctx = makePathRecorder();
  core.strokeTrailPath(ctx, tr, 2);
  assert.deepEqual(ctx.calls, [['beginPath'], ['moveTo', 5, 5], ['lineTo', 4, 4]],
    'count = min(trailSize=6, maxLength=2) draws only the newest 2-point segment');
});

// ── core.js: version resolution + numeric helpers ──────────────────────────

test('core.resolveVersion resolves known versions and falls back to DEFAULT_VERSION otherwise', () => {
  assert.equal(core.resolveVersion('2'), 2);
  assert.equal(core.resolveVersion('3'), 3);
  assert.equal(core.resolveVersion('4'), 4);
  assert.equal(core.resolveVersion('5'), core.DEFAULT_VERSION, 'an unsupported integer falls back to the default');
  assert.equal(core.resolveVersion('banana'), core.DEFAULT_VERSION, 'a non-numeric token falls back to the default');
  assert.equal(core.resolveVersion(''), core.DEFAULT_VERSION, 'an empty token falls back to the default');
  assert.equal(core.resolveVersion(undefined), core.DEFAULT_VERSION, 'a missing token falls back to the default');
  assert.equal(core.resolveVersion('2.9'), 2, 'a fractional token truncates via parseInt before the allow-list check');
});

test('core.clamp bounds a value into [lo, hi]', () => {
  assert.equal(core.clamp(5, 0, 10), 5);
  assert.equal(core.clamp(-5, 0, 10), 0);
  assert.equal(core.clamp(50, 0, 10), 10);
});

test('core.parseNumber parses a numeric string and falls back on garbage', () => {
  assert.equal(core.parseNumber('42.5', -1), 42.5);
  assert.equal(core.parseNumber('  8px', -1), 8, 'parseFloat reads the leading numeric run');
  assert.equal(core.parseNumber('garbage', -1), -1);
  assert.equal(core.parseNumber('', -1), -1);
});

test('core.easeInOutQuad is 0 at t=0, 1 at t=1, and 0.5 at the midpoint', () => {
  assert.equal(core.easeInOutQuad(0), 0);
  assert.equal(core.easeInOutQuad(1), 1);
  assert.equal(core.easeInOutQuad(0.5), 0.5);
});

// ── native path: readStyles()-style token clamping + version mirroring ─────
// Driven through the real native controller, against the fake-object
// environment tests/helpers/surface-effect-conformance.js exports elsewhere
// (jsdom has no real 2d canvas backend -- see that file's header comment).

function makeController(documentRef, reducedMotionQuery) {
  return circuitTraceUtils.createCircuitTraceController({
    effectId: 'circuit-trace', documentRef, reducedMotionQuery, runtime,
  });
}

test('circuit-trace native controller clamps an out-of-range hex-size token read from host style', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const smallHexHost = makeStyledFixtureHost({ left: 0, top: 0, width: 300, height: 300 },
      { '--widget-circuit-trace-hex-size': '0' });
    const largeHexHost = makeStyledFixtureHost({ left: 0, top: 0, width: 300, height: 300 },
      { '--widget-circuit-trace-hex-size': '9999' });
    const controllerA = makeController(documentRef, reducedMotionQuery);
    const controllerB = makeController(documentRef, reducedMotionQuery);
    controllerA.bind(buildFixtureContext({ hosts: [{ element: smallHexHost, role: 'chat-left' }] }));
    controllerB.bind(buildFixtureContext({ hosts: [{ element: largeHexHost, role: 'chat-left' }] }));
    const nodeCountSmallHex = controllerA._internals.inspect().entries[0].nodeCount;
    const nodeCountLargeHex = controllerB._internals.inspect().entries[0].nodeCount;
    assert.ok(nodeCountSmallHex > nodeCountLargeHex,
      `a hex-size of 0 clamps to MIN_HEX_SIZE (denser grid) vs 9999 clamping to MAX_HEX_SIZE: small=${nodeCountSmallHex} large=${nodeCountLargeHex}`);
    controllerA.dispose();
    controllerB.dispose();
  });
});

test('circuit-trace native controller clamps an out-of-range density token read from host style', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const lowDensityHost = makeStyledFixtureHost({ left: 0, top: 0, width: 400, height: 400 },
      { '--widget-circuit-trace-density': '0.0001' });
    const highDensityHost = makeStyledFixtureHost({ left: 0, top: 0, width: 400, height: 400 },
      { '--widget-circuit-trace-density': '9999' });
    const controllerA = makeController(documentRef, reducedMotionQuery);
    const controllerB = makeController(documentRef, reducedMotionQuery);
    controllerA.bind(buildFixtureContext({ hosts: [{ element: lowDensityHost, role: 'chat-left' }] }));
    controllerB.bind(buildFixtureContext({ hosts: [{ element: highDensityHost, role: 'chat-left' }] }));
    const traceCountLow = controllerA._internals.inspect().entries[0].traceCount;
    const traceCountHigh = controllerB._internals.inspect().entries[0].traceCount;
    assert.ok(traceCountLow >= 3 && traceCountLow <= 28, 'traceCount stays within its own hard bounds regardless of clamp');
    assert.ok(traceCountHigh >= 3 && traceCountHigh <= 28);
    assert.ok(traceCountHigh > traceCountLow,
      `density clamped to MAX_DENSITY should out-trace density clamped to MIN_DENSITY: low=${traceCountLow} high=${traceCountHigh}`);
    controllerA.dispose();
    controllerB.dispose();
  });
});

test('circuit-trace native controller tolerates malformed graph CSS tokens without crashing', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const host = makeStyledFixtureHost({ left: 0, top: 0, width: 300, height: 300 }, {
      '--widget-circuit-trace-hex-size': 'banana',
      '--widget-circuit-trace-density': 'NaNville',
    });
    const controller = makeController(documentRef, reducedMotionQuery);
    assert.doesNotThrow(() => controller.bind(buildFixtureContext({ hosts: [{ element: host, role: 'chat-left' }] })),
      'malformed CSS tokens must not crash bind()');
    raf.flush(16);
    raf.flush(16);
    const entry = controller._internals.inspect().entries[0];
    assert.ok(entry.nodeCount > 0 && entry.traceCount >= 3 && entry.traceCount <= 28,
      'malformed tokens fall back to defaults and still build a bounded, drawable graph');
    controller.dispose();
  });
});

test('circuit-trace native controller mirrors the resolved version onto canvas dataset and re-reads it on refresh', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const tokenBag = { '--widget-circuit-trace-version': '3' };
    const host = makeStyledFixtureHost({ left: 0, top: 0, width: 300, height: 300 }, tokenBag);
    const controller = makeController(documentRef, reducedMotionQuery);
    controller.bind(buildFixtureContext({ hosts: [{ element: host, role: 'chat-left' }] }));
    const canvas = host.children[0];
    assert.ok(canvas, 'bind injects a canvas into the host');
    assert.equal(canvas.dataset.circuitTraceVersion, '3');
    assert.equal(controller._internals.inspect().entries[0].version, 3);

    tokenBag['--widget-circuit-trace-version'] = '4';
    controller.refresh(buildFixtureContext({ hosts: [{ element: host, role: 'chat-left' }] }));
    assert.equal(host.children[0], canvas, 'refresh reuses the existing canvas, it does not remount');
    assert.equal(canvas.dataset.circuitTraceVersion, '4', 'refresh re-reads the version token and remirrors it');
    assert.equal(controller._internals.inspect().entries[0].version, 4);
    controller.dispose();
  });
});

// ── native path: frame-loop pause behavior (reduced motion / hidden doc) ───

test('circuit-trace native controller does not keep scheduling frames under reduced motion', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(true);
    const host = makeFakeSurfaceElement({ left: 0, top: 0, width: 300, height: 300 });
    const controller = makeController(documentRef, reducedMotionQuery);
    controller.bind(buildFixtureContext({ hosts: [{ element: host, role: 'chat-left' }] }));
    raf.flush(16);
    assert.equal(raf.size, 0, 'a reduced-motion controller does not reschedule after its one settled frame');
    raf.flush(16);
    raf.flush(16);
    assert.equal(raf.size, 0, 'no frames accumulate on subsequent empty flushes');
    controller.dispose();
  });
});

test('circuit-trace native controller pauses its frame loop while the document is hidden and resumes visible', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const host = makeFakeSurfaceElement({ left: 0, top: 0, width: 300, height: 300 });
    const controller = makeController(documentRef, reducedMotionQuery);
    controller.bind(buildFixtureContext({ hosts: [{ element: host, role: 'chat-left' }] }));
    raf.flush(16);
    assert.ok(raf.size > 0, 'an un-reduced controller keeps a frame scheduled');

    documentRef.hidden = true;
    documentRef.fire('visibilitychange');
    assert.equal(raf.size, 0, 'going hidden cancels the pending frame');
    raf.flush(5000);
    assert.equal(raf.size, 0, 'no frame gets scheduled while hidden');

    documentRef.hidden = false;
    documentRef.fire('visibilitychange');
    assert.ok(raf.size > 0, 'becoming visible again reschedules the frame loop');
    controller.dispose();
  });
});

// ── core.js + gestures.js: v3+ gesture-grammar pure helpers (2026-07-22) ───

const gestures = require('../renderer/shell/renderer-circuit-trace-gestures.js');

test('core.hexAxialDistance is zero for a cell against itself, one for adjacent cells, and symmetric', () => {
  const graph = core.buildHexGraph(300, 300, 32, core.makeRng(3));
  const a = graph.cells[10];
  assert.equal(core.hexAxialDistance(a.q, a.r, a.q, a.r), 0);
  let adjacentCount = 0;
  for (const b of graph.cells) {
    const d = core.hexAxialDistance(a.q, a.r, b.q, b.r);
    assert.equal(d, core.hexAxialDistance(b.q, b.r, a.q, a.r), 'hex distance is symmetric');
    assert.ok(Number.isInteger(d) && d >= 0, 'hex distance is a non-negative integer');
    if (d === 1) { adjacentCount += 1; }
  }
  assert.equal(adjacentCount, 6, 'an interior cell has exactly six hex-distance-1 neighbors');
});

test('core.nearestCellIndex and nearestNodeIndex return the closest element and -1 on an empty graph', () => {
  const graph = core.buildHexGraph(300, 300, 32, core.makeRng(3));
  const cellIdx = core.nearestCellIndex(graph, 150, 150);
  assert.ok(cellIdx >= 0);
  const picked = graph.cells[cellIdx];
  for (const cell of graph.cells) {
    const dPicked = (picked.cx - 150) ** 2 + (picked.cy - 150) ** 2;
    const dOther = (cell.cx - 150) ** 2 + (cell.cy - 150) ** 2;
    assert.ok(dPicked <= dOther, 'no other cell is strictly closer than the picked one');
  }
  const nodeIdx = core.nearestNodeIndex(graph, 150, 150);
  assert.ok(nodeIdx >= 0 && nodeIdx < graph.nodes.length);
  assert.equal(core.nearestCellIndex({ cells: [] }, 1, 1), -1);
  assert.equal(core.nearestNodeIndex(null, 1, 1), -1);
});

test('core.capacitorCurve is monotonically increasing, bounded below 1, and front-loaded', () => {
  let previous = -1;
  for (let t = 0; t <= 3000; t += 50) {
    const q = core.capacitorCurve(t);
    assert.ok(q > previous, `curve increases at t=${t}`);
    assert.ok(q < 1, 'curve never reaches 1');
    previous = q;
  }
  assert.equal(core.capacitorCurve(-100), 0, 'negative hold time clamps to 0');
  assert.ok(core.capacitorCurve(180) > 0.4, 'fast stage front-loads the acknowledgment');
});

test('core.pickNeighborAligned favors the direction vector; pickNeighborToward favors the target; both skip the forbidden index', () => {
  const nodes = [
    { x: 0, y: 0, neighbors: [1, 2, 3] },
    { x: 10, y: 0, neighbors: [0] },
    { x: -10, y: 0, neighbors: [0] },
    { x: 0, y: 10, neighbors: [0] },
  ];
  assert.equal(core.pickNeighborAligned(nodes, nodes[0], -1, 1, 0), 1, 'east direction picks the east neighbor');
  assert.equal(core.pickNeighborAligned(nodes, nodes[0], 1, 1, 0), 3,
    'with east forbidden, the next-most-aligned (south, dot 0) beats west (dot -10)');
  assert.equal(core.pickNeighborToward(nodes, nodes[0], -1, -40, 0), 2, 'toward-west target picks the west neighbor');
  assert.equal(core.pickNeighborToward(nodes, nodes[0], 2, -40, 0), 3,
    'a forbidden closest neighbor falls back to the next-closest (south beats east on distance to the west target)');
});

test('core.retaskTraceFork retasks distinct-neighbor branches with transient speed and cleared trails', () => {
  const graph = core.buildHexGraph(300, 300, 32, core.makeRng(5));
  const traces = core.buildTraces(graph, 6, core.makeRng(5));
  const entry = { graph, traces };
  const nodeIdx = core.nearestNodeIndex(graph, 150, 150);
  const count = core.retaskTraceFork(entry, nodeIdx, 3, core.makeRng(9), 1.7, 5);
  assert.ok(count >= 1 && count <= 3, `fork count ${count} bounded by branches and node degree`);
  const targets = new Set();
  for (let i = 0; i < count; i += 1) {
    const tr = traces[i];
    assert.equal(tr.fromIdx, nodeIdx, 'each fork starts at the origin node');
    assert.equal(tr.forkHopsLeft, 5);
    assert.equal(tr.forkSpeedMul, 1.7);
    assert.equal(tr.trailSize, 0, 'the old trail is cleared');
    assert.ok(graph.nodes[nodeIdx].neighbors.includes(tr.toIdx), 'each fork heads to a real neighbor');
    targets.add(tr.toIdx);
  }
  assert.equal(targets.size, count, 'branches take distinct outgoing neighbors');
});

test('gestures.updateRoutingCurrent derives a seed-stable jittered period and rotates direction per epoch deterministically', () => {
  const a = { periodMs: 0, epoch: null, dirX: 1, dirY: 0 };
  const b = { periodMs: 0, epoch: null, dirX: 1, dirY: 0 };
  gestures.updateRoutingCurrent(a, 4242, 0);
  gestures.updateRoutingCurrent(b, 4242, 0);
  assert.ok(a.periodMs >= core.ROUTING_PERIOD_BASE_MS
    && a.periodMs < core.ROUTING_PERIOD_BASE_MS + core.ROUTING_PERIOD_JITTER_MS,
  `period ${a.periodMs} lies in the jitter window`);
  assert.deepEqual({ x: a.dirX, y: a.dirY }, { x: b.dirX, y: b.dirY }, 'same seed + time yields the same direction');
  assert.ok(Math.abs(Math.hypot(a.dirX, a.dirY) - 1) < 1e-9, 'the direction is a unit vector');

  const firstDir = { x: a.dirX, y: a.dirY };
  let rotated = false;
  for (let epoch = 1; epoch <= 6 && !rotated; epoch += 1) {
    gestures.updateRoutingCurrent(a, 4242, a.periodMs * epoch + 1);
    rotated = a.dirX !== firstDir.x || a.dirY !== firstDir.y;
  }
  assert.ok(rotated, 'the direction rotates within a few epochs');
  const other = { periodMs: 0, epoch: null, dirX: 1, dirY: 0 };
  gestures.updateRoutingCurrent(other, 777, 0);
  assert.notEqual(other.periodMs, a.periodMs, 'a different seed jitters a different period');
});

test('gestures.updateRendezvous only schedules under sustained activity, fires deterministically, and pulses on arrival', () => {
  const graph = core.buildHexGraph(300, 300, 32, core.makeRng(11));
  const traces = core.buildTraces(graph, 6, core.makeRng(11));
  const entry = {
    graph, traces, seed: 4242, nodePulses: new Float32Array(graph.nodes.length),
  };
  const allowAll = () => true;
  const rv = { active: false, targetIdx: -1, endAt: 0, nextAt: 0, counter: 0 };

  gestures.updateRendezvous(entry, rv, 1000, 0, allowAll);
  assert.equal(rv.nextAt, 0, 'idle activity never schedules a rendezvous');

  gestures.updateRendezvous(entry, rv, 1000, 1, allowAll);
  assert.ok(rv.nextAt >= 1000 + core.RENDEZVOUS_GAP_BASE_MS, 'high activity schedules a jittered future firing');
  const scheduledAt = rv.nextAt;

  gestures.updateRendezvous(entry, rv, scheduledAt - 1, 1, allowAll);
  assert.equal(rv.active, false, 'nothing fires before the scheduled time');
  gestures.updateRendezvous(entry, rv, scheduledAt + 1, 1, allowAll);
  assert.equal(rv.active, true, 'the rendezvous activates at its scheduled time');
  assert.ok(rv.targetIdx >= 0 && rv.targetIdx < graph.nodes.length);

  traces[0].fromIdx = rv.targetIdx;
  gestures.updateRendezvous(entry, rv, scheduledAt + 2, 1, allowAll);
  assert.equal(rv.active, false, 'first arrival resolves the rendezvous');
  assert.ok(entry.nodePulses[rv.targetIdx] >= core.RENDEZVOUS_PULSE, 'arrival stacks the target node pulse');
});

test('core.applyCapacitorLattice lifts the keyed cell and pulses its vertices; an inactive charge writes nothing', () => {
  const graph = core.buildHexGraph(300, 300, 32, core.makeRng(13));
  const cellIdx = core.nearestCellIndex(graph, 150, 150);
  const entry = {
    graph,
    cellLifts: new Float32Array(graph.cells.length),
    nodePulses: new Float32Array(graph.nodes.length),
    charge: { active: true, cellIdx, heldMs: 500 },
    liftsSettled: true,
  };
  core.applyCapacitorLattice(entry);
  assert.ok(entry.cellLifts[cellIdx] > 0, 'the keyed cell lifts');
  assert.equal(entry.liftsSettled, false, 'the lift pass is re-armed so decay/edge rebuild runs');
  let pulsedVerts = 0;
  for (const vi of graph.cells[cellIdx].vertIdxs) {
    if (entry.nodePulses[vi] > 0) { pulsedVerts += 1; }
  }
  assert.equal(pulsedVerts, 6, 'all six cell vertices brighten');

  const idle = {
    graph,
    cellLifts: new Float32Array(graph.cells.length),
    nodePulses: new Float32Array(graph.nodes.length),
    charge: { active: false, cellIdx, heldMs: 500 },
    liftsSettled: true,
  };
  core.applyCapacitorLattice(idle);
  assert.equal(idle.cellLifts[cellIdx], 0, 'an inactive charge never writes lifts');
  assert.equal(idle.liftsSettled, true);
});
