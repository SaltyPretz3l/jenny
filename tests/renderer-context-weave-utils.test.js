// Context Weave (Surface Effects review 2026-08-21; background-effects rework
// 2026-09-30).
//
// The effect is a static warp/weft lattice painted at varying alpha: the
// pointer moves light, never cloth (D5), as a radial sheen; a click plucks one
// warp and one weft thread. The cloth never reacts to the model and it RESTS --
// a parked pointer or a settled pluck paints zero frames. The load-bearing
// oracles (pitch, rest detection, static geometry, the alpha cap) were each
// proven by deliberately breaking the production module and confirming the
// assertion reds -- an absence-assertion or a rest-detection test that passes
// against a loop which never stops is worthless.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contextWeave = require('../renderer/shell/renderer-context-weave-utils.js');
const weaveCore = require('../renderer/shell/renderer-context-weave-core.js');
const { createRafHarness } = require('./helpers/surface-effect-router-harness.js');
const { buildFixtureContext, withStubbedGlobals } = require('./helpers/surface-effect-conformance.js');
const {
  STYLE_TOKENS,
  HOST_RECT,
  newRecord,
  mountController,
  tick,
  settle,
  alphaSet,
  input,
} = require('./helpers/context-weave-fixtures.js');

function latticeSnapshot(controller) {
  const lattice = controller._internals.getLattice();
  return { x: Array.from(lattice.nodeX), y: Array.from(lattice.nodeY) };
}

// ── 1-3: lattice geometry ───────────────────────────────────────────────────

test('the weave lattice is deterministic: identical options produce bit-identical arrays', () => {
  const options = { width: 960, height: 540, spacing: 96, density: 1, seed: 4242 };
  const first = contextWeave.buildWeaveLattice(options);
  const second = contextWeave.buildWeaveLattice(options);

  assert.ok(first.nodeX instanceof Float32Array);
  assert.ok(first.nodeY instanceof Float32Array);
  assert.equal(first.nodeCount, first.cols * first.rows);
  assert.deepEqual(Array.from(first.nodeX), Array.from(second.nodeX));
  assert.deepEqual(Array.from(first.nodeY), Array.from(second.nodeY));
});

// F4: `spacing` and `density` were provably inert -- the old node count
// saturated its cap above ~442,000 px2 of scene, i.e. at every real window
// size, so 12 palettes hand-tuned two dead knobs. This asserts at a REALISTIC
// scene (1900x1000); the old code passes a toy-sized version of this test and
// fails the real-sized one, which is exactly how the bug survived.
test('pitch actually moves the node count at a realistic scene size', () => {
  const base = contextWeave.buildWeaveLattice({ width: 1900, height: 1000, spacing: 96, density: 1, seed: 7 });
  const tighterSpacing = contextWeave.buildWeaveLattice({ width: 1900, height: 1000, spacing: 48, density: 1, seed: 7 });
  const higherDensity = contextWeave.buildWeaveLattice({ width: 1900, height: 1000, spacing: 96, density: 1.6, seed: 7 });

  assert.ok(base.nodeCount > 0);
  assert.ok(
    tighterSpacing.nodeCount > base.nodeCount,
    `halving spacing must raise the node count (${base.nodeCount} -> ${tighterSpacing.nodeCount})`
  );
  assert.ok(
    higherDensity.nodeCount > base.nodeCount,
    `raising density must raise the node count (${base.nodeCount} -> ${higherDensity.nodeCount})`
  );
  assert.ok(tighterSpacing.cols > base.cols && tighterSpacing.rows > base.rows);
});

test('MAX_GRID_NODES holds on a 4K scene at the minimum pitch', () => {
  const lattice = contextWeave.buildWeaveLattice({
    width: 3840, height: 2160, spacing: 48, density: 1.6, seed: 11,
  });
  assert.ok(lattice.cols * lattice.rows <= weaveCore.MAX_GRID_NODES,
    `${lattice.cols}x${lattice.rows} exceeds the ${weaveCore.MAX_GRID_NODES}-node cap`);
  assert.ok(lattice.pitch > weaveCore.MIN_PITCH, 'the cap is enforced by raising the pitch, not by truncating the cloth');
  assert.equal(lattice.nodeX.length, lattice.cols * lattice.rows);
});

test('edge nodes take zero jitter so the fabric meets the scene bounds cleanly', () => {
  const lattice = contextWeave.buildWeaveLattice({ width: 800, height: 600, spacing: 96, density: 1, seed: 3 });
  const { cols, rows, nodeX, nodeY } = lattice;
  for (let i = 0; i < cols; i += 1) {
    assert.ok(Math.abs(nodeY[i]) < 1e-4, `top edge node ${i} sits on y=0`);
    assert.ok(Math.abs(nodeY[(rows - 1) * cols + i] - 600) < 1e-3, `bottom edge node ${i} sits on y=height`);
  }
  for (let j = 0; j < rows; j += 1) {
    assert.ok(Math.abs(nodeX[j * cols]) < 1e-4, `left edge node ${j} sits on x=0`);
    assert.ok(Math.abs(nodeX[j * cols + cols - 1] - 800) < 1e-3, `right edge node ${j} sits on x=width`);
  }
});

// ── 4: interlace parity ─────────────────────────────────────────────────────

// A hand-built, jitter-free lattice: segment lengths are then exact, so the
// only thing that can shorten one is the interlace trim. buildWeaveLattice
// always jitters its interior nodes, which would blur the measurement.
function squareLattice(step, count) {
  const nodeX = new Float32Array(count * count);
  const nodeY = new Float32Array(count * count);
  for (let j = 0; j < count; j += 1) {
    for (let i = 0; i < count; i += 1) {
      nodeX[j * count + i] = i * step;
      nodeY[j * count + i] = j * step;
    }
  }
  return {
    width: step * (count - 1), height: step * (count - 1),
    cols: count, rows: count, pitch: step, nodeCount: count * count, nodeX, nodeY,
  };
}

function restingView(lattice, gap) {
  return {
    lattice,
    pointer: { active: false, x: 0, y: 0, fade: 0 },
    pluck: { active: false, col: 0, row: 0, amplitude: 0 },
    age: 0, motionScale: 1, radius: 150, gap,
  };
}

// Bucket index of every segment a collect pass produced: [{ bucket, midX, midY }].
function bucketedSegments(buckets) {
  const out = [];
  buckets.forEach((coords, bucket) => {
    for (let c = 0; c < coords.length; c += 4) {
      out.push({ bucket, midX: (coords[c] + coords[c + 2]) / 2, midY: (coords[c + 1] + coords[c + 3]) / 2 });
    }
  });
  return out;
}

function maxBucket(view) {
  const warp = weaveCore.createBucketPaths();
  const weft = weaveCore.createBucketPaths();
  weaveCore.collectWarp(view, warp);
  weaveCore.collectWeft(view, weft);
  return Math.max(...bucketedSegments(warp).map((entry) => entry.bucket),
    ...bucketedSegments(weft).map((entry) => entry.bucket));
}

function segmentsOf(buckets) {
  const flat = buckets.flat();
  const segments = [];
  for (let index = 0; index < flat.length; index += 4) {
    segments.push({
      x1: flat[index], y1: flat[index + 1], x2: flat[index + 2], y2: flat[index + 3],
      length: Math.hypot(flat[index + 2] - flat[index], flat[index + 3] - flat[index + 1]),
    });
  }
  return segments;
}

test('interlace parity: exactly one family is shortened at a crossing, and flipping parity flips which', () => {
  const STEP = 100;
  const GAP = 4;
  const lattice = squareLattice(STEP, 4);
  const view = restingView(lattice, GAP);
  const warpBuckets = weaveCore.createBucketPaths();
  const weftBuckets = weaveCore.createBucketPaths();
  weaveCore.collectWarp(view, warpBuckets);
  const warp = segmentsOf(warpBuckets);
  weaveCore.collectWeft(view, weftBuckets);
  const weft = segmentsOf(weftBuckets);

  assert.equal(warp.length, lattice.cols * (lattice.rows - 1));
  assert.equal(weft.length, lattice.rows * (lattice.cols - 1));

  // Each segment runs between two crossings and is trimmed at each end it
  // passes UNDER, so every length is full, full-gap, or full-2*gap.
  const allowed = [STEP, STEP - GAP, STEP - GAP * 2];
  [...warp, ...weft].forEach((segment) => {
    assert.ok(allowed.some((value) => Math.abs(segment.length - value) < 1e-6),
      `segment length ${segment.length} is one of ${allowed.join(', ')}`);
  });

  // Plain weave alternates strictly, so along one thread the trims alternate
  // ends: exactly half of every family's segments are trimmed once at each end
  // and the totals are mirror images. A "lattice of lines" with no interlace
  // would leave both totals at zero, which is what this catches.
  const trimTotal = (segments) => segments.reduce((sum, segment) => sum + (STEP - segment.length), 0);
  assert.equal(trimTotal(warp), trimTotal(weft),
    'warp and weft are exact parity complements, so they lose the same total length');
  assert.ok(trimTotal(warp) > 0, 'the weave actually interlaces rather than merely crossing');

  // At crossing (0,0), (i+j) is EVEN: warp passes over, weft passes under.
  const warp00 = warp.find((segment) => Math.abs(segment.x1) < 1e-6 && Math.abs(segment.y1) < 1e-6);
  assert.ok(warp00, 'the warp segment leaving (0,0) exists');
  assert.ok(Math.abs(warp00.y1 - 0) < 1e-6, 'warp is OVER at (0,0): its near end is not trimmed');
  assert.ok(Math.abs(warp00.y2 - (STEP - GAP)) < 1e-6, 'and UNDER at (0,1): its far end is');

  const weft00 = weft.find((segment) => Math.abs(segment.y1) < 1e-6 && segment.x1 > 0 && segment.x1 < STEP);
  assert.ok(weft00, 'the weft segment leaving (0,0) exists');
  assert.ok(Math.abs(weft00.x1 - GAP) < 1e-6, 'weft is UNDER at (0,0): its near end IS trimmed');
  assert.ok(Math.abs(weft00.x2 - STEP) < 1e-6, 'and OVER at (1,0): its far end is not');

  // Flip the parity by stepping one crossing along: at (1,0) the roles swap.
  const warp10 = warp.find((segment) => Math.abs(segment.x1 - STEP) < 1e-6 && segment.y1 > 0 && segment.y1 < STEP);
  assert.ok(warp10, 'the warp segment leaving (1,0) exists');
  assert.ok(Math.abs(warp10.y1 - GAP) < 1e-6, 'warp is UNDER at (1,0): the trimmed end flipped to the near side');
  const weft10 = weft.find((segment) => Math.abs(segment.y1) < 1e-6 && Math.abs(segment.x1 - STEP) < 1e-6);
  assert.ok(weft10, 'the weft segment leaving (1,0) exists');
  assert.ok(Math.abs(weft10.x2 - (2 * STEP - GAP)) < 1e-6,
    'weft is OVER at (1,0) and UNDER at (2,0): its trimmed end flipped to the far side');
});

test('segments shorter than 2.2x the interlace gap are skipped rather than drawn degenerate', () => {
  const lattice = squareLattice(100, 4);
  const buckets = weaveCore.createBucketPaths();
  // gap == the full step: nothing can clear the 2.2x floor.
  weaveCore.collectWarp(restingView(lattice, 100), buckets);
  assert.equal(buckets.flat().length, 0);
  // A gap just under the floor still draws.
  weaveCore.collectWarp(restingView(lattice, 100 / 2.3), buckets);
  assert.ok(buckets.flat().length > 0);
});

// ── 5: the controller surface (no model reactivity) ─────────────────────────

test('the controller exposes no activity seam: no setActivity and no handleActivityImpulse', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    assert.equal(controller.setActivity, undefined);
    assert.equal(controller.handleActivityImpulse, undefined);
    assert.deepEqual(Object.keys(controller).sort(),
      ['_internals', 'bind', 'dispose', 'getStatus', 'handleInput', 'refresh']);
    const state = controller._internals.inspect();
    ['scopeEpoch', 'phase', 'phaseRevision', 'currentEnergy', 'targetEnergy', 'attentionScale',
      'bandEnergy', 'logicalNow'].forEach((key) => assert.equal(key in state, false, `${key} is retired`));
    ['bandLevelAt', 'BAND_PERIOD_MS', 'BAND_HALF_WIDTH', 'nearestCrossing'].forEach((key) => {
      assert.equal(weaveCore[key], undefined, `${key} is retired from the core`);
    });
    controller.dispose();
  });
});

// ── 6: rest detection ───────────────────────────────────────────────────────

test('the loop stops at rest and every input seam re-arms it, while getStatus stays ready', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller, host } = mountController({ raf, record: newRecord() });

    // Settle: the bind frame paints once and then the cloth is static.
    raf.flush(32);
    raf.flush(48);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0,
      'a resting weave must not request another frame');
    assert.equal(controller._internals.inspect().pointerActive, false);
    assert.equal(controller._internals.inspect().pluckActive, false);
    // Resting is NOT dormant: a controller reporting dormant at rest reads to
    // the manager as a failed activation.
    assert.equal(controller.getStatus().state, 'ready');

    let clock = 48;
    const rearm = (label, act) => {
      act();
      assert.equal(controller._internals.inspect().pendingFrameCount, 1, `${label} re-arms the loop`);
      clock += 16;
      raf.flush(clock);
      clock += 16;
      raf.flush(clock);
      assert.equal(controller._internals.inspect().pendingFrameCount, 0, `${label} settles back to rest`);
    };

    rearm('handleInput(leave)', () => controller.handleInput(input('leave', 0, 0)));
    rearm('handleInput(cancel)', () => controller.handleInput(input('cancel', 0, 0)));
    rearm('refresh', () => controller.refresh(buildFixtureContext({
      hosts: [{ element: host, role: 'chat-left' }],
      sceneRect: HOST_RECT, hostRects: [HOST_RECT],
    })));

    controller.dispose();
  });
});

test('a parked pointer rests: once the hover fade settles no further frame is scheduled', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record });
    raf.flush(32); raf.flush(48);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0);

    controller.handleInput(input('move', 120, 140));
    assert.equal(controller._internals.inspect().pendingFrameCount, 1, 'the move starts the fade');
    const fadeTicks = settle(raf, controller);
    assert.ok(fadeTicks > 10, `the fade takes real time to settle (${fadeTicks} ticks)`);
    let state = controller._internals.inspect();
    assert.equal(state.pointerActive, true, 'the pointer is still parked on the surface');
    assert.equal(state.pointerFade, 1);
    assert.equal(state.pendingFrameCount, 0);

    const framesAtRest = record.frames;
    tick(raf, 30);
    raf.flush(60000);
    assert.equal(record.frames, framesAtRest, 'a parked pointer paints zero further frames');
    assert.equal(raf.size, 0, 'and requests none');

    // Repaint once per pointer change: a move while parked costs one frame.
    controller.handleInput(input('move', 200, 220));
    tick(raf, 5);
    assert.equal(record.frames, framesAtRest + 1, 'one pointer change is exactly one repaint');
    assert.equal(controller._internals.inspect().pendingFrameCount, 0);

    // Leaving drains the light over the fade-out, then the cloth rests again.
    controller.handleInput(input('leave', 200, 220));
    settle(raf, controller);
    state = controller._internals.inspect();
    assert.equal(state.pointerFade, 0);
    assert.equal(state.pointerActive, false);
    const framesAfterLeave = record.frames;
    tick(raf, 20);
    assert.equal(record.frames, framesAfterLeave, 'the faded cloth paints nothing more');
    controller.dispose();
  });
});

test('the first frame after a long rest clears neither the pointer nor the pluck, and pluck age is never negative', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    controller.handleInput(input('move', 120, 140));
    settle(raf, controller);
    raf.flush(60000); // a minute of rest: no frame runs, the clock just moves on

    // A click stamped slightly AHEAD of the next frame's clock.
    controller.handleInput(input('click', 90, 80, { timeStamp: raf.now + 50 }));
    raf.flush(16);
    let state = controller._internals.inspect();
    assert.equal(state.pointerActive, true, 'the parked pointer survives the first frame after rest');
    assert.equal(state.pointerFade, 1);
    assert.equal(state.pluckActive, true, 'a pluck from a future-stamped click is not expired or cleared');
    assert.ok(state.pluckAge >= 0, `pluck age is never negative (got ${state.pluckAge})`);
    for (let i = 0; i < 12; i += 1) {
      raf.flush(16);
      state = controller._internals.inspect();
      assert.ok(state.pluckAge >= 0, `pluck age stays non-negative (got ${state.pluckAge})`);
    }
    assert.ok(state.pluckAge > 0, 'the pluck does age once the clock catches up');
    assert.equal(state.pluckActive, true, 'and is still ringing ~200 ms in');

    // The core agrees: a negative age reads as the start of the pluck, not as
    // "expired" and not as an undefined offset.
    assert.equal(weaveCore.pluckExpired(-50), false);
    assert.equal(weaveCore.pluckOffset(5, 12, -50, 10), weaveCore.pluckOffset(5, 12, 0, 10));
    controller.dispose();
  });
});

// ── 7: the hover fade ───────────────────────────────────────────────────────

test('the hover fade rises with a 160 ms time constant and drains with a 420 ms one', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    raf.flush(32); raf.flush(48);

    controller.handleInput(input('move', 120, 140));
    raf.flush(20); // first frame after rest: dt is 0, nothing advances
    assert.equal(controller._internals.inspect().pointerFade, 0);
    tick(raf, 8, 20); // exactly 160 ms
    const risen = controller._internals.inspect().pointerFade;
    assert.ok(Math.abs(risen - (1 - Math.exp(-1))) < 1e-9,
      `160 ms in is 1 - 1/e = 0.632 (got ${risen})`);

    settle(raf, controller);
    assert.equal(controller._internals.inspect().pointerFade, 1);
    controller.handleInput(input('leave', 120, 140));
    raf.flush(21);
    assert.equal(controller._internals.inspect().pointerFade, 1, 'leaving starts the drain from full');
    tick(raf, 20, 21); // exactly 420 ms
    const drained = controller._internals.inspect().pointerFade;
    assert.ok(Math.abs(drained - Math.exp(-1)) < 1e-9,
      `420 ms out is 1/e = 0.368 (got ${drained})`);
    controller.dispose();
  });
});

// ── 8: geometry is static (the D5 contract) ─────────────────────────────────

test('a pointer move changes stroke alpha but leaves the lattice bit-identical', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record });
    raf.flush(32); raf.flush(48);
    const before = latticeSnapshot(controller);
    const idleAlphas = alphaSet(record);

    record.strokes.length = 0;
    controller.handleInput(input('move', 440, 260));
    settle(raf, controller);
    const after = latticeSnapshot(controller);
    const hoverAlphas = alphaSet(record);

    assert.deepEqual(after.x, before.x, 'nodeX must not move under the pointer');
    assert.deepEqual(after.y, before.y, 'nodeY must not move under the pointer');
    assert.ok(hoverAlphas.size > idleAlphas.size,
      `hover must light threads via alpha (idle ${idleAlphas.size} -> hover ${hoverAlphas.size} distinct values)`);
    controller.dispose();
  });
});

// ── 9: the radial sheen ─────────────────────────────────────────────────────

test('the sheen is radial only: a thread far from the pointer on the same column or row stays at resting alpha', () => {
  const STEP = 100;
  const lattice = squareLattice(STEP, 10);
  const view = restingView(lattice, 3);
  view.pointer = { active: true, x: 450, y: 450, fade: 1 };
  const warpBuckets = weaveCore.createBucketPaths();
  const weftBuckets = weaveCore.createBucketPaths();
  weaveCore.collectWarp(view, warpBuckets);
  weaveCore.collectWeft(view, weftBuckets);
  const warp = bucketedSegments(warpBuckets);
  const weft = bucketedSegments(weftBuckets);

  // Warp column x=400 passes within 50 px of the pointer and runs the full height.
  const column = warp.filter((entry) => Math.abs(entry.midX - 400) < 1e-6);
  assert.equal(column.length, lattice.rows - 1);
  const nearWarp = column.find((entry) => Math.abs(entry.midY - 450) < 5);
  const farWarp = column.filter((entry) => entry.midY > 700 || entry.midY < 200);
  assert.ok(nearWarp.bucket > 0, 'the warp segment under the pointer is lit');
  assert.ok(farWarp.length >= 4);
  farWarp.forEach((entry) => assert.equal(entry.bucket, 0,
    `warp at y=${entry.midY} on the pointer's own column is NOT lit (no full-length trace)`));

  const row = weft.filter((entry) => Math.abs(entry.midY - 400) < 1e-6);
  assert.equal(row.length, lattice.cols - 1);
  const nearWeft = row.find((entry) => Math.abs(entry.midX - 450) < 5);
  const farWeft = row.filter((entry) => entry.midX > 700 || entry.midX < 200);
  assert.ok(nearWeft.bucket > 0, 'the weft segment under the pointer is lit');
  assert.ok(farWeft.length >= 4);
  farWeft.forEach((entry) => assert.equal(entry.bucket, 0,
    `weft at x=${entry.midX} on the pointer's own row is NOT lit`));

  // Everything lit lies inside the pointer radius, so the sheen is a disc.
  [...warp, ...weft].filter((entry) => entry.bucket > 0).forEach((entry) => {
    assert.ok(Math.hypot(entry.midX - 450, entry.midY - 450) < view.radius + 3,
      `lit segment at (${entry.midX}, ${entry.midY}) sits inside the ${view.radius}px radius`);
  });

  // A faded-out pointer lights nothing, whatever its last position.
  view.pointer.fade = 0;
  assert.equal(maxBucket(view), 0);
});

// ── 10: alpha cap and the absent shadow ─────────────────────────────────────

test('a lit thread peaks at exactly lit-gain x its resting alpha and never above the canvas ceiling', () => {
  // The ratio is the contract (D6). Canvas pins globalAlpha to [0, 1], so a
  // cap applied AFTER a 1-to-litGain ramp would clamp the top buckets to an
  // indistinguishable 1.0 -- the gradation would silently collapse and the
  // "cap" would still read as satisfied. Asserting the exact ratio is what
  // catches that; asserting `alpha <= 1` alone is vacuous.
  [1, 2.1, 3, 4, 5].forEach((gain) => {
    const resting = weaveCore.alphaForBucket(0, gain);
    const lit = weaveCore.alphaForBucket(weaveCore.ALPHA_BUCKETS - 1, gain);
    assert.ok(Math.abs(lit - resting * gain) < 1e-9,
      `gain ${gain}: lit ${lit} must be exactly ${gain}x resting ${resting}`);
    assert.ok(lit <= 1 + 1e-9, 'a fully lit thread still fits the canvas ceiling');
    for (let bucket = 0; bucket < weaveCore.ALPHA_BUCKETS; bucket += 1) {
      const value = weaveCore.alphaForBucket(bucket, gain);
      assert.ok(value >= resting - 1e-9 && value <= lit + 1e-9,
        `gain ${gain}: bucket ${bucket} (${value}) stays inside [resting, lit]`);
    }
  });
  // Out-of-range gains are clamped, not honoured.
  assert.equal(weaveCore.alphaForBucket(0, 99), weaveCore.alphaForBucket(0, 5));
  assert.equal(weaveCore.alphaForBucket(0, 0.1), weaveCore.alphaForBucket(0, 1));

  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record });
    raf.flush(32);
    record.strokes.length = 0;

    controller.handleInput(input('move', 0, 0));
    tick(raf, 90);

    const LIT_GAIN = 3;
    const WEFT_ALPHA = 0.7;
    assert.ok(record.strokes.length > 0, 'the pass painted something to measure');
    const alphas = record.strokes.map((entry) => entry.alpha);
    // Warp peaks at 1 and weft rests at weftAlpha / litGain -- the two
    // structural bounds of the whole paint, with everything in between.
    assert.ok(Math.max(...alphas) <= 1 + 1e-9, 'nothing is painted above the canvas ceiling');
    assert.ok(Math.min(...alphas) >= WEFT_ALPHA / LIT_GAIN - 1e-9,
      'nothing is painted below the weft resting alpha');
    controller.dispose();
  });
});

test('shadowBlur and shadowColor are never set on any stroke (F3)', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record });
    controller.handleInput(input('move', 200, 200));
    tick(raf, 4);
    controller.handleInput(input('click', 120, 90, { timeStamp: raf.now }));
    raf.flush(16);

    assert.ok(record.shadowBlurs.length > 0, 'strokes were recorded');
    record.shadowBlurs.forEach((value) => assert.equal(value, undefined, 'shadowBlur must never be assigned'));
    record.shadowColors.forEach((value) => assert.equal(value, undefined, 'shadowColor must never be assigned'));
    // The source is the other half of this oracle: a renamed property would
    // make the recording assertion above vacuous. Comments are stripped first
    // -- a prose mention of shadowBlur is not an assignment, and matching it
    // would make this a false positive (the raw-primitive checker hit exactly
    // that class once already).
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'renderer', 'shell', 'renderer-context-weave-core.js'), 'utf8'
    ).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.doesNotMatch(source, /shadow(Blur|Color)/,
      'the painter must not so much as name a shadow property');
    controller.dispose();
  });
});

// ── 11: motion scale ────────────────────────────────────────────────────────

test('the motion-scale token scales pointer gain but never the resting alpha', () => {
  // Core: one pointer, three gains. A scale of 0.6 lights less, 2 lights more
  // than 1, and every case leaves far threads in bucket 0.
  const lattice = squareLattice(100, 10);
  const levelFor = (motionScale) => {
    const view = restingView(lattice, 3);
    view.pointer = { active: true, x: 400, y: 470, fade: 1 };
    view.motionScale = motionScale;
    return maxBucket(view);
  };
  assert.ok(levelFor(0.6) < levelFor(1), 'a calmer scale lights threads less');
  assert.ok(levelFor(1) < levelFor(2), 'an expressive scale lights threads more');
  const rest = restingView(lattice, 3);
  rest.motionScale = 2;
  assert.equal(maxBucket(rest), 0, 'with no pointer the scale changes nothing');

  // Controller: the painted alpha range.
  const alphaRange = (motionScale) => {
    const raf = createRafHarness();
    return withStubbedGlobals({ raf }, () => {
      const record = newRecord();
      const { controller } = mountController({
        raf, record, tokens: { ...STYLE_TOKENS, '--widget-context-weave-motion-scale': String(motionScale) },
      });
      controller.handleInput(input('move', 450, 280));
      settle(raf, controller);
      record.strokes.length = 0;
      controller.handleInput(input('move', 452, 281));
      tick(raf, 3);
      const alphas = record.strokes.map((entry) => entry.alpha);
      controller.dispose();
      return { min: Math.min(...alphas), max: Math.max(...alphas) };
    });
  };
  const calm = alphaRange(0.5);
  const expressive = alphaRange(2);
  assert.ok(expressive.max > calm.max, 'pointer gain follows the token');
  assert.ok(Math.abs(expressive.min - calm.min) < 1e-9, 'resting alpha does not');
  assert.ok(Math.abs(calm.min - 0.7 / 3) < 1e-9, 'resting alpha is weft-alpha / lit-gain');
});

// ── 12: the pluck ───────────────────────────────────────────────────────────

test('pluckOffset pins both ends and returns to exactly zero after decay', () => {
  const count = 12;
  for (let age = 0; age <= 400; age += 40) {
    assert.ok(Math.abs(weaveCore.pluckOffset(0, count, age, 10)) < 1e-9, 'the first node stays pinned');
    assert.ok(Math.abs(weaveCore.pluckOffset(count - 1, count, age, 10)) < 1e-9, 'the last node stays pinned');
  }
  const midway = weaveCore.pluckOffset(5, count, 0, 10);
  assert.ok(Math.abs(midway) > 0.01, 'an interior node actually displaces');
  assert.equal(weaveCore.pluckOffset(5, count, 5000, 10), 0, 'the pluck resolves to exactly zero');
  assert.equal(weaveCore.pluckOffset(0, count, 0, 10), 0, 'a pinned end is exactly zero, not merely small');
  assert.equal(weaveCore.pluckExpired(5000), true);
  assert.equal(weaveCore.pluckExpired(0), false);
});

test('pluck amplitude is 14 x motion scale, independent of lit-gain, and the plucked warp and weft brighten', () => {
  assert.equal(weaveCore.PLUCK_BASE_AMPLITUDE, 14);
  const amplitudeFor = (tokens) => {
    const raf = createRafHarness();
    return withStubbedGlobals({ raf }, () => {
      const { controller } = mountController({ raf, record: newRecord(), tokens: { ...STYLE_TOKENS, ...tokens } });
      controller.handleInput(input('click', 60, 60, { timeStamp: raf.now }));
      const amplitude = controller._internals.inspect().pluckAmplitude;
      controller.dispose();
      return amplitude;
    });
  };
  assert.equal(amplitudeFor({}), 14, 'default scale 1 plucks 14 px');
  assert.equal(amplitudeFor({ '--widget-context-weave-motion-scale': '0.5' }), 7);
  assert.equal(amplitudeFor({ '--widget-context-weave-motion-scale': '2' }), 28);
  [1, 3, 5].forEach((gain) => {
    assert.equal(amplitudeFor({ '--widget-context-weave-lit-gain': String(gain) }), 14,
      `lit-gain ${gain} does not change the pluck`);
  });

  // The plucked warp column and weft row light up with the wave's envelope.
  const lattice = squareLattice(100, 10);
  const view = restingView(lattice, 3);
  view.pluck = { active: true, col: 4, row: 4, amplitude: 14 };
  const top = weaveCore.ALPHA_BUCKETS - 1;
  ['collectWarp', 'collectWeft'].forEach((collect) => {
    const buckets = weaveCore.createBucketPaths();
    view.age = 0;
    weaveCore[collect](view, buckets);
    assert.equal(buckets[top].length / 4, lattice.rows - 1, `${collect}: the plucked thread is fully lit at age 0`);
    assert.equal(buckets[0].length / 4, (lattice.cols - 1) * (lattice.rows - 1),
      `${collect}: every other thread stays at resting alpha`);
    view.age = 420;
    weaveCore[collect](view, buckets);
    const lit = Math.round(Math.exp(-1) * top);
    assert.equal(buckets[lit].length / 4, lattice.rows - 1, `${collect}: the glow decays with exp(-age/420)`);
  });
});

test('a click plucks one warp and one weft thread, a second click replaces it, and the cloth returns to rest', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    raf.flush(32); raf.flush(48);
    const resting = latticeSnapshot(controller);

    controller.handleInput(input('click', 90, 80, { timeStamp: raf.now }));
    let state = controller._internals.inspect();
    assert.equal(state.pluckActive, true);
    const firstCol = state.pluckCol;
    const firstRow = state.pluckRow;

    controller.handleInput(input('click', 760, 470, { timeStamp: raf.now + 8 }));
    state = controller._internals.inspect();
    assert.equal(state.pluckActive, true, 'still exactly one pluck');
    assert.ok(state.pluckCol !== firstCol || state.pluckRow !== firstRow,
      'the second click replaces the first rather than stacking');

    // The pluck is closed-form, so it self-terminates -- and the lattice it
    // displaced was never written to in the first place.
    settle(raf, controller, 200, 40);
    assert.equal(controller._internals.inspect().pluckActive, false, 'the pluck decays away');
    assert.deepEqual(latticeSnapshot(controller), resting, 'geometry returns to exactly its resting values');
    assert.equal(controller._internals.inspect().pendingFrameCount, 0);
    controller.dispose();
  });
});

test('a click inside a spawn-avoidance rect plucks nothing', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    raf.flush(32);
    // The mounted context reserves { left: 300, top: 200, width: 240, height: 160 }.
    controller.handleInput(input('click', 400, 260, { timeStamp: 64 }));
    assert.equal(controller._internals.inspect().pluckActive, false);
    controller.handleInput(input('click', 60, 60, { timeStamp: 72 }));
    assert.equal(controller._internals.inspect().pluckActive, true, 'a click outside the cutout still plucks');
    controller.dispose();
  });
});

// ── 13: cancel and multi-touch ──────────────────────────────────────────────

test('a non-primary cancel keeps the primary hover, and non-primary input is ignored outright', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record });
    controller.handleInput(input('move', 120, 140));
    settle(raf, controller);
    const frames = record.frames;

    controller.handleInput(input('cancel', 0, 0, { isPrimary: false, pointerId: 2 }));
    controller.handleInput(input('leave', 0, 0, { isPrimary: false, pointerId: 2 }));
    controller.handleInput(input('click', 60, 60, { isPrimary: false, pointerId: 2, timeStamp: raf.now }));
    let state = controller._internals.inspect();
    assert.equal(state.pointerActive, true, 'a second contact cannot cancel the primary hover');
    assert.equal(state.pointerFade, 1);
    assert.equal(state.pluckActive, false, 'nor pluck');
    assert.equal(state.pendingFrameCount, 0, 'and it does not even wake the loop');
    tick(raf, 3);
    assert.equal(record.frames, frames);

    controller.handleInput(input('cancel', 0, 0));
    state = controller._internals.inspect();
    assert.equal(state.pointerActive, false, 'the primary cancel clears the hover');
    controller.dispose();
  });
});

test('cancel clears the pointer only: a live pluck keeps decaying on its own', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    controller.handleInput(input('move', 120, 140));
    controller.handleInput(input('click', 90, 80, { timeStamp: raf.now }));
    tick(raf, 3);
    assert.equal(controller._internals.inspect().pluckActive, true);

    controller.handleInput(input('cancel', 0, 0));
    let state = controller._internals.inspect();
    assert.equal(state.pointerActive, false);
    assert.equal(state.pluckActive, true, 'cancel does not kill the pluck');
    const ageAtCancel = state.pluckAge;
    tick(raf, 6);
    state = controller._internals.inspect();
    assert.equal(state.pluckActive, true);
    assert.ok(state.pluckAge > ageAtCancel, 'the pluck keeps aging after the cancel');
    settle(raf, controller);
    state = controller._internals.inspect();
    assert.equal(state.pluckActive, false, 'and decays away by itself');
    assert.equal(state.pointerFade, 0);
    controller.dispose();
  });
});
