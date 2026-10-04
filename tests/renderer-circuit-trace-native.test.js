// Circuit Trace -- pure-logic suite for the routed-PCB redesign (2026-09-30).
//
// Covers the two DOM-free modules directly:
//   - renderer-circuit-trace-board.js + -core.js: the seeded board (buildBoard /
//     validateBoard), the geometry helpers (pointAt / tracePath /
//     nearestTrace) and the bake (bakeBoard).
//   - renderer-circuit-trace-gestures.js: the live layer (hover probe, click
//     chain planning + scheduling, idle packets, drawLive).
// The controller (two canvases per host, bake-once, frame budget, input
// routing, reduced motion) lives in tests/renderer-circuit-trace-utils.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../renderer/shell/renderer-circuit-trace-core.js');
const boardGen = require('../renderer/shell/renderer-circuit-trace-board.js');
const gestures = require('../renderer/shell/renderer-circuit-trace-gestures.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');

// ── harness ─────────────────────────────────────────────────────────────────

// A recording 2d context: every method call and every property write is kept,
// so a test can assert which compositing modes and styles a draw pass used.
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

const boardCache = new Map();
// Boards are never mutated by the gesture/bake code under test, so one build
// per (seed, size) serves every case.
function boardFor(seed, width = 1180, height = 540) {
  const key = `${seed}|${width}|${height}`;
  if (!boardCache.has(key)) {
    boardCache.set(key, boardGen.buildBoard({ width, height, pitch: 14, rng: runtime.makeRng(seed) }));
  }
  return boardCache.get(key);
}

const ENV = { speed: 1, reducedMotion: false, netMax: 2 };

function makeLive(seed = 1) {
  return gestures.createLiveState(runtime.makeRng(seed));
}

function step(live, board, totalMs, dtMs, env) {
  for (let t = 0; t < totalMs; t += dtMs) { gestures.advanceLive(live, board, dtMs, env || ENV); }
}

function topTraces(board) {
  return board.traces.filter((t) => t.layer === 0);
}

function midPoint(trace) {
  return core.pointAt(trace, trace.len / 2, { x: 0, y: 0, i: 1 });
}

function firstWideBus(board) {
  return board.buses.find((bus) => !bus.pair && bus.traces.length >= 3);
}

function traceFrom(pts, extra) {
  const cum = [0];
  for (let i = 1; i < pts.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return Object.assign({ id: 0, pts, cum, len: cum[cum.length - 1], layer: 0, bus: -1, a: 0, b: 1 }, extra);
}

const LARGE_SIZES = [[1180, 540], [1960, 1040]];
const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);

// ── core: determinism ───────────────────────────────────────────────────────

function geometryOf(board) {
  return JSON.stringify({
    nodes: board.nodes.map((n) => [n.kind, n.x, n.y, n.chip]),
    traces: board.traces.map((t) => [t.layer, t.bus, t.tuned, t.pts.map((p) => [p.x, p.y])]),
    buses: board.buses.map((b) => [b.pair, b.traces]),
  });
}

test('buildBoard is deterministic per seed and differs between seeds', () => {
  const build = (seed) => boardGen.buildBoard({ width: 1180, height: 540, pitch: 14, rng: runtime.makeRng(seed) });
  const first = build(7);
  assert.ok(first.nodes.length > 50 && first.traces.length > 20, 'the board is a real, populated scene');
  assert.equal(geometryOf(build(7)), geometryOf(first), 'the same seed builds identical node and trace geometry');
  assert.notEqual(geometryOf(build(8)), geometryOf(first), 'a different seed builds a different board');
});

// ── core: routing validity across seeds ─────────────────────────────────────

test('seeds 1..30 at both large sizes validate clean and carry one differential pair plus at least one bus', () => {
  for (const [width, height] of LARGE_SIZES) {
    for (const seed of SEEDS) {
      const board = boardFor(seed, width, height);
      const label = `seed ${seed} ${width}x${height}`;
      assert.deepEqual(boardGen.validateBoard(board), [], `${label} has no clearance or graze violations`);
      const pairs = board.buses.filter((bus) => bus.pair);
      assert.ok(board.buses.some((bus) => !bus.pair), `${label} has at least one parallel bus`);
      assert.equal(pairs.length, 1, `${label} has exactly one differential pair`);
      assert.equal(pairs[0].traces.length, 2, `${label}: the pair has two lanes`);
    }
  }
});

test('top-layer routing is octilinear everywhere except the differential pair lanes', () => {
  let checkedSegments = 0;
  let serpentineSegments = 0;
  for (const [width, height] of LARGE_SIZES) {
    for (const seed of SEEDS) {
      const board = boardFor(seed, width, height);
      for (const t of topTraces(board)) {
        const lane = t.bus >= 0 && board.buses[t.bus].pair;
        if (lane) { continue; }
        for (let i = 1; i < t.pts.length; i += 1) {
          const dx = t.pts[i].x - t.pts[i - 1].x;
          const dy = t.pts[i].y - t.pts[i - 1].y;
          const octilinear = Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6;
          assert.ok(octilinear, `seed ${seed} ${width}x${height} trace ${t.id} segment ${i} is off-angle (dx=${dx}, dy=${dy})`);
          checkedSegments += 1;
          if (t.tuned) { serpentineSegments += 1; }
        }
      }
    }
  }
  assert.ok(checkedSegments > 5000, `the octilinear check is non-vacuous (${checkedSegments} segments)`);
  assert.ok(serpentineSegments > 0, 'the sweep included tuned serpentine segments (chamfers stay at 45 degrees too)');
});

// ── core: compact mode ──────────────────────────────────────────────────────

test('compact boards (a thin strip, a small tile) are populated, part-free and valid; a 40x40 host is empty', () => {
  for (const [width, height] of [[600, 84], [300, 300]]) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const board = boardFor(seed, width, height);
      const label = `seed ${seed} ${width}x${height}`;
      assert.ok(board.nodes.length > 0 && board.traces.length > 0, `${label} still wires a node field`);
      assert.equal(board.chips.length, 0, `${label} draws no chips`);
      assert.equal(board.headers.length, 0, `${label} draws no headers`);
      assert.deepEqual(boardGen.validateBoard(board), [], `${label} validates clean`);
      const ctx = makeRecordingContext();
      core.bakeBoard(ctx, board, { grid: 'G', accent: 'A', inner: 'I', shadow: 'S' });
      assert.ok(callsOf(ctx, 'stroke').length > 0, `${label} bakes`);
    }
  }
  const tiny = boardFor(1, 40, 40);
  assert.equal(tiny.nodes.length, 0, 'a 40x40 board has no nodes');
  assert.equal(tiny.traces.length, 0);
  assert.doesNotThrow(() => core.bakeBoard(makeRecordingContext(), tiny, { grid: 'G', accent: 'A', inner: 'I', shadow: 'S' }),
    'baking an empty board is safe');
});

// ── core: length matching ───────────────────────────────────────────────────

test('every non-pair bus with a tuned lane is length matched within half a pixel', () => {
  let tunedBuses = 0;
  for (const [width, height] of LARGE_SIZES) {
    for (const seed of SEEDS) {
      const board = boardFor(seed, width, height);
      for (const bus of board.buses) {
        if (bus.pair || !bus.traces.some((id) => board.traces[id].tuned)) { continue; }
        tunedBuses += 1;
        const lens = bus.traces.map((id) => board.traces[id].len);
        const label = `seed ${seed} ${width}x${height} bus ${bus.id}`;
        assert.ok(Math.max(...lens) - Math.min(...lens) < 0.5, `${label}: lane lengths ${lens.map((l) => l.toFixed(2)).join(', ')} agree within 0.5 px`);
        assert.ok(bus.spread < 0.5, `${label}: recorded spread ${bus.spread} is under 0.5`);
        assert.ok(bus.traces.every((id) => board.traces[id].tuned), `${label}: every lane shares the tuned stretch`);
      }
    }
  }
  assert.ok(tunedBuses >= 10, `the sweep actually tuned buses (${tunedBuses})`);
});

// ── core: geometry helpers ──────────────────────────────────────────────────

test('pointAt interpolates without rounding and tracePath passes through every corner vertex', () => {
  const pts = [{ x: 10.3, y: 5.7 }, { x: 50.3, y: 5.7 }, { x: 50.3, y: 25.7 }, { x: 70.3, y: 45.7 }];
  const t = traceFrom(pts);
  const p = core.pointAt(t, 25.25, { x: 0, y: 0, i: 0 });
  assert.ok(Math.abs(p.x - 35.55) < 1e-9 && Math.abs(p.y - 5.7) < 1e-9, 'a point inside the first segment is exact');
  assert.equal(Number.isInteger(p.x), false, 'positions are not rounded to whole pixels');
  assert.equal(p.i, 1);
  const clampedLow = core.pointAt(t, -10, { x: 0, y: 0, i: 0 });
  const clampedHigh = core.pointAt(t, t.len + 10, { x: 0, y: 0, i: 0 });
  assert.deepEqual([clampedLow.x, clampedLow.y], [10.3, 5.7], 'arc length clamps to the start');
  assert.ok(Math.abs(clampedHigh.x - 70.3) < 1e-9 && Math.abs(clampedHigh.y - 45.7) < 1e-9, 'and to the end');

  const ctx = makeRecordingContext();
  core.tracePath(ctx, t, 30, 70);
  const [move, ...lines] = ctx.calls;
  assert.equal(move[0], 'moveTo');
  assert.ok(Math.abs(move[1] - 40.3) < 1e-9 && move[2] === 5.7, 'the path opens at the fractional start point');
  assert.deepEqual(lines.map((c) => c[0]), ['lineTo', 'lineTo', 'lineTo']);
  assert.deepEqual([lines[0][1], lines[0][2]], [50.3, 5.7], 'the first corner vertex is visited');
  assert.deepEqual([lines[1][1], lines[1][2]], [50.3, 25.7], 'the second corner vertex is visited');
  const end = core.pointAt(t, 70, { x: 0, y: 0, i: 0 });
  assert.ok(Math.abs(lines[2][1] - end.x) < 1e-9 && Math.abs(lines[2][2] - end.y) < 1e-9, 'and it ends on the exact endpoint');
  assert.equal(Number.isInteger(lines[2][1]) || Number.isInteger(lines[2][2]), false, 'nothing is snapped to the pixel grid');

  const reversed = makeRecordingContext();
  core.tracePath(reversed, t, 70, 30);
  assert.deepEqual(reversed.calls, ctx.calls, 'the order of s0 and s1 does not matter');

  const within = makeRecordingContext();
  core.tracePath(within, t, 12, 20);
  assert.deepEqual(within.calls.map((c) => c[0]), ['moveTo', 'lineTo'], 'a stretch inside one segment adds no corner');
});

test('tracePath walks a real board trace through all of its bends, never a chord across one', () => {
  const board = boardFor(5);
  const bent = topTraces(board).find((t) => t.pts.length >= 4);
  assert.ok(bent, 'the fixture board has a trace with at least two bends');
  const ctx = makeRecordingContext();
  const lastStart = bent.cum[bent.pts.length - 2];
  core.tracePath(ctx, bent, bent.cum[1] * 0.25, lastStart + (bent.len - lastStart) * 0.5);
  const lineTos = callsOf(ctx, 'lineTo').map((c) => [c[1], c[2]]);
  const corners = bent.pts.slice(1, -1).map((p) => [p.x, p.y]);
  assert.deepEqual(lineTos.slice(0, corners.length), corners, 'every interior vertex is visited in order');
  assert.equal(lineTos.length, corners.length + 1, 'followed only by the endpoint');
});

test('nearestTrace returns the closest top-copper trace within maxD and null beyond it', () => {
  const a = traceFrom([{ x: 0, y: 0 }, { x: 100, y: 0 }], { id: 0, layer: 0 });
  const b = traceFrom([{ x: 0, y: 40 }, { x: 100, y: 40 }], { id: 1, layer: 0 });
  const inner = traceFrom([{ x: 0, y: 5 }, { x: 100, y: 5 }], { id: 2, layer: 1 });
  const board = { traces: [a, b, inner] };
  const out = { t: null, s: 0, d: 0 };
  const hit = core.nearestTrace(board, 30, 8, 10, out);
  assert.equal(hit, out, 'the result is written into the supplied object');
  assert.equal(out.t, a, 'the top trace wins; the nearer inner trace is ignored');
  assert.ok(Math.abs(out.s - 30) < 1e-9 && Math.abs(out.d - 8) < 1e-9, 'arc length and distance are exact');
  assert.equal(core.nearestTrace(board, 30, 8, 7.9, { t: null, s: 0, d: 0 }), null, 'beyond maxD there is no hit');
  assert.equal(core.nearestTrace(board, 30, 20.5, 40, out).t, b, 'the closer of two candidates wins');
  assert.equal(core.nearestTrace(board, 500, 500, 50, { t: null, s: 0, d: 0 }), null, 'a far point misses everything');

  const real = boardFor(3);
  const target = topTraces(real)[4];
  const p = midPoint(target);
  const onLine = core.nearestTrace(real, p.x, p.y, 1, { t: null, s: 0, d: 0 });
  assert.ok(onLine, 'a point on a real trace hits');
  assert.ok(onLine.d < 1e-6, 'at distance zero');
  assert.equal(onLine.t, target, 'and resolves to that trace');
  assert.ok(Math.abs(onLine.s - target.len / 2) < 1e-6, 'at that arc length');
});

// ── gestures: hover probe ───────────────────────────────────────────────────

test('setProbe on a bus lists every lane of the bus and their end nodes', () => {
  const board = boardFor(5);
  const bus = firstWideBus(board);
  assert.ok(bus, 'fixture board has a three-lane bus');
  const lane = board.traces[bus.traces[1]];
  const live = makeLive();
  gestures.setPointer(live, 100, 100);
  gestures.setProbe(live, board, { t: lane, s: lane.len / 2, d: 0 });
  assert.equal(live.probeKey, `b${bus.id}`);
  assert.equal(live.probes.length, 1);
  assert.deepEqual(live.probes[0].list, bus.traces, 'the probe covers every lane of the bus, not just the one under the pointer');
  const expectedEnds = new Set();
  bus.traces.forEach((id) => { expectedEnds.add(board.traces[id].a); expectedEnds.add(board.traces[id].b); });
  assert.deepEqual(new Set(live.probes[0].ends), expectedEnds, 'the probe lights every lane end');

  const single = topTraces(board).find((t) => t.bus < 0);
  gestures.setProbe(live, board, { t: single, s: single.len / 2, d: 0 });
  assert.equal(live.probeKey, `t${single.id}`);
  assert.deepEqual(live.probes.find((slot) => slot.key === `t${single.id}`).list, [single.id], 'a lone net probes only itself');
});

test('probe fade rises with a 160 ms time constant and falls with 280 ms after the pointer leaves', () => {
  const board = boardFor(5);
  const lane = board.traces[firstWideBus(board).traces[0]];
  const hit = { t: lane, s: lane.len / 2, d: 0 };
  const live = makeLive();
  gestures.setPointer(live, 100, 100);
  gestures.setProbe(live, board, hit);
  assert.equal(live.probes[0].fade, 0, 'a fresh slot starts dark');

  const rise = [];
  for (let i = 0; i < 10; i += 1) {
    gestures.advanceLive(live, board, 16, ENV);
    rise.push(live.probes[0].fade);
  }
  rise.forEach((f, i) => { if (i > 0) { assert.ok(f > rise[i - 1], `the fade rises monotonically (frame ${i})`); } });
  assert.ok(Math.abs(rise[9] - (1 - Math.exp(-1))) < 0.05, `one time constant (160 ms) reaches about 0.63, got ${rise[9]}`);
  assert.ok(rise[9] < 0.7 && rise[9] > 0.55);
  assert.equal(live.probeMoving, true, 'a rising probe counts as motion');

  step(live, board, 2000, 16);
  assert.ok(live.probes[0].fade > 0.995, 'a parked pointer settles at full');
  assert.equal(live.probeMoving, false, 'a settled probe is not motion');

  gestures.clearPointer(live);
  const start = live.probes[0].fade;
  const fall = [];
  for (let i = 0; i < 20; i += 1) {
    gestures.advanceLive(live, board, 14, ENV);
    fall.push(live.probes[0].fade);
  }
  fall.forEach((f, i) => { if (i > 0) { assert.ok(f < fall[i - 1], `the fade falls monotonically (frame ${i})`); } });
  assert.ok(Math.abs(fall[19] / start - Math.exp(-1)) < 0.05, `one fall constant (280 ms) leaves about 37 percent, got ${fall[19] / start}`);

  step(live, board, 1000, 16);
  assert.equal(live.probes.length, 1, 'still fading after a further second');
  step(live, board, 1000, 16);
  assert.equal(live.probes.length, 0, 'the slot is removed once it is dark');
});

test('a slot that faded out is recreated on the same key: hover stays alive after a click and a wait', () => {
  const board = boardFor(5);
  const bus = firstWideBus(board);
  const lane = board.traces[bus.traces[0]];
  const p = midPoint(lane);
  const hit = { t: lane, s: lane.len / 2, d: 0 };
  const live = makeLive();
  gestures.setPointer(live, p.x, p.y);
  gestures.setProbe(live, board, hit);
  step(live, board, 400, 16);
  assert.ok(live.probes[0].fade > 0.85);

  gestures.click(live, board, p.x, p.y, live.rng, { t: null, s: 0, d: 0 });
  step(live, board, 1000, 16);
  assert.equal(live.probes.length, 0, 'the click quieted the probe and its slot faded away and was removed');
  assert.equal(live.probeKey, `b${bus.id}`, 'the key is still remembered, which is what used to leave hover dead');

  gestures.setPointer(live, p.x + 20, p.y);
  gestures.setProbe(live, board, hit);
  assert.equal(live.probes.length, 1, 'the same key gets a fresh slot');
  step(live, board, 500, 16);
  assert.ok(live.probes[0].fade > 0.9, `and it lights again, got ${live.probes[0].fade}`);
});

test('after a click the probe stays quiet until the pointer moves 8 px', () => {
  const board = boardFor(5);
  const lane = board.traces[firstWideBus(board).traces[0]];
  const p = midPoint(lane);
  const hit = { t: lane, s: lane.len / 2, d: 0 };
  const live = makeLive();
  gestures.setPointer(live, p.x, p.y);
  gestures.setProbe(live, board, hit);
  step(live, board, 500, 16);
  assert.ok(live.probes[0].fade > 0.9, 'lit before the click');

  gestures.click(live, board, p.x, p.y, live.rng, { t: null, s: 0, d: 0 });
  assert.equal(live.quietX, p.x);
  assert.equal(live.quietY, p.y);
  step(live, board, 300, 16);
  assert.ok(live.probes.length === 0 || live.probes[0].fade < 0.05, 'the click drops the probe quickly (80 ms constant)');
  step(live, board, 400, 16);
  assert.equal(live.probes.length, 0, 'and its slot is gone within a second');

  // Hover keeps re-asserting the same hit, as the controller does on every move.
  gestures.setPointer(live, p.x + 7, p.y);
  for (let i = 0; i < 40; i += 1) {
    gestures.setProbe(live, board, hit);
    gestures.advanceLive(live, board, 16, ENV);
    assert.equal(live.probes.length, 0, 'seven pixels of drift is still quiet (a slot is dropped the frame it stays dark)');
  }
  gestures.setPointer(live, p.x + gestures.QUIET_PX, p.y);
  gestures.setProbe(live, board, hit);
  step(live, board, 300, 16);
  assert.ok(live.probes[0].fade > 0.5, `eight pixels releases the quiet, got ${live.probes[0].fade}`);
});

// ── gestures: chain planning ────────────────────────────────────────────────

test('planChain: starts at the hit, each segment leaves an arrival node or a sibling pin, hops and nodes are bounded', () => {
  let plans = 0;
  let longest = 0;
  let exitSegments = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const board = boardFor(seed);
    const traces = topTraces(board);
    traces.forEach((t, index) => {
      const rng = runtime.makeRng(seed * 1000 + index);
      const hit = { t, s: t.len * 0.4, d: 0 };
      const segs = gestures.planChain(board, hit, rng);
      const label = `seed ${seed} trace ${t.id}`;
      plans += 1;
      longest = Math.max(longest, segs.length);
      const pair = t.bus >= 0 && board.buses[t.bus].pair;
      const leading = pair ? 2 : 1;
      assert.ok(segs.length >= leading, `${label} plans at least its own trace`);
      assert.ok(segs.length <= gestures.MAX_HOPS * gestures.MAX_PATHS, `${label} stays within hops x paths (got ${segs.length})`);
      const own = segs.slice(0, leading).find((seg) => seg.t === t);
      assert.ok(own, `${label}: the first segment${pair ? 's are the pair lanes, one of them' : ''} rides the clicked trace`);
      assert.equal(own.s0, hit.s, `${label}: and starts at the hit position`);
      assert.ok(segs.slice(0, leading).every((seg) => seg.t0 === 0), `${label}: the opening segments launch at the click`);

      const arrivals = new Set();
      segs.forEach((seg, i) => {
        assert.equal(seg.node.id, seg.s1 >= seg.t.len ? seg.t.b : seg.t.a, `${label} seg ${i}: the arrival node is the end it runs to`);
        if (i >= leading) {
          const fromId = seg.s0 === 0 ? seg.t.a : seg.t.b;
          assert.ok(seg.s0 === 0 || seg.s0 === seg.t.len, `${label} seg ${i}: later hops run the whole trace`);
          if (seg.exit) {
            exitSegments += 1;
            const pin = board.nodes[fromId];
            assert.equal(seg.exit.id, fromId, `${label} seg ${i}: the exit pin is where the segment starts`);
            assert.ok(pin.chip >= 0 && [...arrivals].some((id) => board.nodes[id].chip === pin.chip),
              `${label} seg ${i}: an exit pin belongs to the chip the current arrived at`);
            assert.ok(board.chips[pin.chip].pins.includes(pin.id), `${label} seg ${i}: and is one of its pins`);
            assert.ok(seg.t0 > 0, `${label} seg ${i}: it leaves after the dwell`);
          } else {
            assert.ok(arrivals.has(fromId), `${label} seg ${i}: starts at node ${fromId}, which an earlier segment arrived at`);
          }
        }
        arrivals.add(seg.node.id);
      });
    });
  }
  assert.ok(plans > 300, `the sweep planned many chains (${plans})`);
  assert.ok(longest >= 3, `some chains hop onward (longest ${longest})`);
  assert.ok(exitSegments > 0, 'some chains pass through a part and leave by a sibling pin');
});

// Regression: a fork at a via once took both the top trace and the inner
// trace joining the same two vias, arriving at one node twice.
test('planChain never arrives at a node twice', () => {
  const dups = [];
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const board = boardFor(seed);
    topTraces(board).forEach((t, index) => {
      const segs = gestures.planChain(board, { t, s: t.len * 0.4, d: 0 }, runtime.makeRng(seed * 1000 + index));
      const seen = new Set();
      segs.forEach((seg, i) => {
        if (seen.has(seg.node.id)) { dups.push(`seed ${seed} trace ${t.id} seg ${i} re-arrives at node ${seg.node.id} via layer ${seg.t.layer} trace ${seg.t.id}`); }
        seen.add(seg.node.id);
      });
    });
  }
  assert.deepEqual(dups, [], 'no node is arrived at twice within one planned chain');
});

// Regression (Astra 2026-09-30): the speed token once changed only idle packets.
test('the speed token scales the click chain: doubling the speed halves a long hop', () => {
  const board = boardFor(3);
  const t = topTraces(board).filter((x) => x.bus < 0).sort((x, y) => y.len - x.len)[0];
  const hit = { t, s: t.len / 2, d: 0 };
  const slow = gestures.planChain(board, hit, runtime.makeRng(9), 0.5);
  const fast = gestures.planChain(board, hit, runtime.makeRng(9), 1);
  assert.deepEqual(fast.map((s) => s.t.id), slow.map((s) => s.t.id), 'the same route');
  const long = slow.findIndex((seg) => seg.dur > 2 * 170);
  assert.ok(long >= 0, 'the chain has a hop long enough to clear the 170 ms floor at both speeds');
  assert.ok(Math.abs(fast[long].dur - slow[long].dur / 2) < 1e-9, `double the speed halves the hop: ${fast[long].dur} vs ${slow[long].dur}`);
  assert.ok(fast[fast.length - 1].t0 < slow[slow.length - 1].t0, 'and the later hops launch sooner');
  assert.deepEqual(gestures.planChain(board, hit, runtime.makeRng(9)).map((s) => s.dur), fast.map((s) => s.dur), 'an omitted speed is speed 1');
});

test('clicking a differential pair lane plans both lanes together', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const board = boardFor(seed);
    const pair = board.buses.find((bus) => bus.pair);
    for (const laneId of pair.traces) {
      const lane = board.traces[laneId];
      const segs = gestures.planChain(board, { t: lane, s: lane.len * 0.3, d: 0 }, runtime.makeRng(seed));
      assert.equal(segs.length, 2, `seed ${seed}: a pair click plans exactly two segments`);
      assert.deepEqual(segs.map((s) => s.t.id).sort((x, y) => x - y), [...pair.traces].sort((x, y) => x - y), 'one segment per lane');
      assert.ok(segs.every((s) => s.t0 === 0), 'both lanes launch together');
      assert.equal(new Set(segs.map((s) => s.node.id)).size, 2, 'and arrive at their own pads');
    }
  }
});

// ── gestures: activate + idle suppression ───────────────────────────────────

test('activate kills idle packets, schedules the chain, and holds idle spawns until a second after it ends', () => {
  const board = boardFor(5);
  const live = makeLive(3);
  for (let i = 0; i < 400 && live.packets.length === 0; i += 1) { gestures.advanceLive(live, board, 16, ENV); }
  assert.ok(live.packets.length > 0, 'idle packets are running before the click');
  const idle = live.packets.slice();

  const target = topTraces(board).find((t) => t.bus < 0 && t.len > 60);
  const segs = gestures.planChain(board, { t: target, s: target.len / 2, d: 0 }, runtime.makeRng(1));
  const base = live.t;
  gestures.activate(live, board, segs);

  idle.forEach((p) => assert.equal(p.kill, base, 'every idle packet is told to step aside at the click'));
  assert.equal(live.lit.length, segs.length, 'one lit interval per planned segment');
  segs.forEach((seg, i) => {
    assert.equal(live.lit[i].t, seg.t);
    assert.equal(live.lit[i].t0, base + seg.t0);
    assert.equal(live.lit[i].dur, seg.dur);
  });
  const strong = live.flashes.filter((f) => f.strong);
  assert.equal(strong.length, segs.length, 'one strong arrival flash per segment');
  strong.forEach((f, i) => assert.equal(f.t, base + segs[i].t0 + segs[i].dur));
  assert.equal(live.flashes.filter((f) => !f.strong).length, segs.filter((s) => s.exit).length, 'exit pins flash as the current leaves');
  assert.equal(live.chipPulses.length, segs.filter((s) => s.node.chip >= 0).length, 'a part the current arrives at pulses');
  const chainEnd = Math.max(...segs.map((s) => base + s.t0 + s.dur + s.dwell));
  assert.ok(Math.abs(live.quietUntil - (chainEnd + 1000)) < 1e-6, 'idle stays quiet until one second after the chain ends');

  // the old packets fade within 160 ms and are gone just after
  step(live, board, 176, 16);
  idle.forEach((p) => assert.equal(live.packets.includes(p), false, 'the killed packet was removed'));
  assert.equal(live.packets.length, 0, 'and nothing new spawned during the chain');
  while (live.t < live.quietUntil - 32) {
    gestures.advanceLive(live, board, 16, ENV);
    assert.equal(live.packets.length, 0, `no idle spawn at t=${live.t.toFixed(0)} before quietUntil ${live.quietUntil.toFixed(0)}`);
  }
  step(live, board, 160, 16);
  assert.ok(live.t > live.quietUntil, 'the quiet period has passed');
  assert.ok(live.packets.length > 0, 'idle packets resume afterwards');
});

// ── gestures: idle behaviour ────────────────────────────────────────────────

function runIdle(seed, liveSeed, netMax, totalMs) {
  const board = boardFor(seed);
  const live = makeLive(liveSeed);
  const env = { speed: 1, reducedMotion: false, netMax };
  const maxLanes = Math.max(...board.buses.map((b) => b.traces.length));
  const seen = new Set();
  const stats = { busLaunches: 0, netLaunches: 0, maxPackets: 0, maxActiveNets: 0 };
  for (let t = 0; t < totalMs; t += 16) {
    gestures.advanceLive(live, board, 16, env);
    const packets = live.packets;
    stats.maxPackets = Math.max(stats.maxPackets, packets.length);
    // One bus group, plus per running net chain its head and at most one packet
    // still trailing off the previous hop.
    assert.ok(packets.length <= maxLanes + 2 * netMax,
      `seed ${seed} t=${t}: ${packets.length} packets exceeds ${maxLanes} lanes + 2 x netMax ${netMax}`);
    let activeNets = 0;
    const fresh = [];
    for (const p of packets) {
      assert.ok(p.s >= -p.len - 1e-9 && p.s <= p.t.len + p.len + 1e-9,
        `seed ${seed} t=${t}: packet position ${p.s} is outside [${-p.len}, ${p.t.len + p.len}] of its trace`);
      if (!p.bus && !p.done) { activeNets += 1; }
      if (p.bus && !seen.has(p)) { fresh.push(p); }
      seen.add(p);
    }
    stats.maxActiveNets = Math.max(stats.maxActiveNets, activeNets);
    assert.ok(activeNets <= netMax, `seed ${seed} t=${t}: ${activeNets} net packets running, netMax ${netMax}`);
    const busIds = new Set(packets.filter((p) => p.bus).map((p) => p.t.bus));
    assert.ok(busIds.size <= 1, `seed ${seed} t=${t}: only one bus group runs at a time`);
    if (fresh.length) {
      stats.busLaunches += 1;
      const bus = board.buses[fresh[0].t.bus];
      assert.equal(fresh.length, bus.traces.length, 'a bus launches every lane in the same frame');
      assert.deepEqual(fresh.map((p) => p.t.id).sort((x, y) => x - y), [...bus.traces].sort((x, y) => x - y), 'one packet per lane');
      assert.equal(new Set(fresh.map((p) => p.born)).size, 1, 'one launch time');
      assert.equal(new Set(fresh.map((p) => p.v)).size, 1, 'one speed');
      assert.equal(new Set(fresh.map((p) => p.dir)).size, 1, 'one direction');
      assert.equal(packets.filter((p) => p.bus).length, fresh.length, 'the previous group had finished');
    }
  }
  stats.netLaunches = seen.size;
  return stats;
}

test('idle packets stay bounded, on their traces, and bus groups launch whole over a 60 s run', () => {
  let launches = 0;
  for (const [seed, liveSeed] of [[2, 5], [9, 6], [17, 7]]) {
    const stats = runIdle(seed, liveSeed, 2, 60000);
    launches += stats.busLaunches;
    assert.ok(stats.maxPackets > 0, `seed ${seed}: the run produced packets`);
  }
  assert.ok(launches >= 15, `bus groups launched repeatedly (${launches})`);
});

test('with netMax 1 at most one net packet runs at a time', () => {
  let sawNet = 0;
  for (const [seed, liveSeed] of [[2, 11], [9, 12]]) {
    const stats = runIdle(seed, liveSeed, 1, 60000);
    assert.ok(stats.maxActiveNets <= 1, `seed ${seed}: never more than one running net packet`);
    sawNet += stats.maxActiveNets;
  }
  assert.ok(sawNet >= 2, 'a net packet actually ran in each run');
});

// ── drawing: compositing discipline ─────────────────────────────────────────

const BAKE_COLORS = { grid: 'GRID', accent: 'ACCENT', inner: 'INNER', shadow: 'SHADOW' };

test('bakeBoard composites only with destination-out and source-over, ends at source-over, and never uses shadowBlur', () => {
  let punched = 0;
  for (const [seed, width, height] of [[1, 1180, 540], [2, 1960, 1040], [3, 600, 84], [4, 300, 300]]) {
    const ctx = makeRecordingContext();
    core.bakeBoard(ctx, boardFor(seed, width, height), BAKE_COLORS);
    const modes = new Set(setsOf(ctx, 'globalCompositeOperation'));
    for (const mode of modes) {
      assert.ok(mode === 'destination-out' || mode === 'source-over', `${width}x${height} set unexpected composite mode ${mode}`);
    }
    if (modes.has('destination-out')) { punched += 1; }
    assert.equal(ctx.values.get('globalCompositeOperation'), 'source-over', `${width}x${height} bake leaves the context at source-over`);
    assert.deepEqual(setsOf(ctx, 'shadowBlur'), [], `${width}x${height} bake never sets shadowBlur`);
    assert.ok(callsOf(ctx, 'fill').length >= 3 && callsOf(ctx, 'stroke').length >= 3, 'the bake paints');
    const styles = new Set(setsOf(ctx, 'strokeStyle').concat(setsOf(ctx, 'fillStyle')));
    ['GRID', 'ACCENT', 'SHADOW'].forEach((c) => assert.ok(styles.has(c), `${width}x${height}: bake used the ${c} colour`));
  }
  assert.equal(punched, 4, 'every bake punches solid nodes out of its copper');
});

test('drawLive never sets shadowBlur or leaves source-over, across probes, idle packets, a click chain and reduced motion', () => {
  const board = boardFor(5);
  const colors = { line: 'LINE', glow: 'GLOW' };
  const live = makeLive(9);
  const ctx = makeRecordingContext();
  const lane = board.traces[firstWideBus(board).traces[0]];
  const p = midPoint(lane);
  gestures.setPointer(live, p.x, p.y);
  gestures.setProbe(live, board, { t: lane, s: lane.len / 2, d: 0 });
  let sawPackets = false;
  let sawLit = false;
  let sawFlash = false;
  let sawPulse = false;
  let activated = false;
  for (let i = 0; i < 400; i += 1) {
    gestures.advanceLive(live, board, 16, ENV);
    if (i === 120 && !activated) {
      activated = true;
      const chipPin = board.nodes.find((n) => n.chip >= 0 && n.traces.length && n.kind !== 'gone');
      const t = board.traces[chipPin.traces[0]];
      const s = t.a === chipPin.id ? 1 : t.len - 1;
      gestures.activate(live, board, gestures.planChain(board, { t, s, d: 0 }, runtime.makeRng(2)));
    }
    sawPackets = sawPackets || live.packets.length > 0;
    sawLit = sawLit || live.lit.length > 0;
    sawFlash = sawFlash || live.flashes.length > 0;
    sawPulse = sawPulse || live.chipPulses.length > 0;
    gestures.drawLive(ctx, live, board, colors, false);
  }
  assert.ok(sawPackets && sawLit && sawFlash && sawPulse, 'the run exercised packets, the chain, flashes and a part pulse');
  const reduced = makeLive(10);
  const hit = { t: lane, s: lane.len / 2, d: 0 };
  reduced.pinned = gestures.planChain(board, hit, runtime.makeRng(3));
  gestures.drawLive(ctx, reduced, board, colors, true);
  assert.deepEqual(setsOf(ctx, 'shadowBlur'), [], 'no shadowBlur anywhere in the live layer');
  const modes = setsOf(ctx, 'globalCompositeOperation');
  assert.ok(modes.every((m) => m === 'source-over'), 'the live layer composites only with source-over');
  const strokes = new Set(setsOf(ctx, 'strokeStyle'));
  assert.ok(strokes.has('LINE') && strokes.has('GLOW'), 'probe and packets use the line colour, the chain uses the glow colour');
  assert.ok(callsOf(ctx, 'arc').length > 0, 'chain heads and node flashes drew arcs');
});
