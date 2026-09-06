// Context Weave restyle (Surface Effects review, 2026-08-21, Wave 2).
//
// The effect is now a static warp/weft lattice painted at varying alpha: the
// pointer moves light, never cloth (D5). These tests were written red-first
// against the rewrite and the load-bearing oracles (pitch, rest detection,
// static geometry, the alpha cap, and band survival through bucketing) were
// each proven by deliberately breaking the production module and confirming
// the assertion reds -- an absence-assertion or a rest-detection test that
// passes against a loop which never stops is worthless, and both classes have
// bitten this repo before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contextWeave = require('../renderer/shell/renderer-context-weave-utils.js');
const weaveCore = require('../renderer/shell/renderer-context-weave-core.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const appearanceUtils = require('../renderer/shared/appearance-utils.js');
const { createRafHarness } = require('./helpers/surface-effect-router-harness.js');
const {
  createEffectMediaQueryList,
  makeStyledFixtureHost,
  buildFixtureContext,
  withStubbedGlobals,
} = require('./helpers/surface-effect-conformance.js');

const STYLE_TOKENS = {
  '--widget-context-weave-line-color': 'rgba(150, 160, 186, 0.42)',
  '--widget-context-weave-spacing': '96',
  '--widget-context-weave-density': '1',
  '--widget-context-weave-pointer-radius': '150',
  '--widget-context-weave-interlace': '3',
  '--widget-context-weave-weft-alpha': '0.7',
  '--widget-context-weave-lit-gain': '3',
};
const TOKENS = Object.keys(STYLE_TOKENS);
const RETIRED_TOKENS = [
  '--widget-context-weave-pulse-color',
  '--widget-context-weave-glow-color',
  '--widget-context-weave-bloom',
  '--widget-context-weave-tension',
  '--widget-context-weave-damping',
];

// ── a recording 2D context ──────────────────────────────────────────────────
// The shared conformance fake swallows every draw call; the alpha-cap,
// no-shadow and bucketing oracles need to SEE what was painted, so these
// tests bring their own recorder.
function createRecordingContext(record) {
  const ctx = {
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    strokeStyle: '',
    save() {}, restore() {}, clearRect() {}, setTransform() {},
    beginPath() { ctx.__pending = 0; },
    moveTo() {}, lineTo() { ctx.__pending += 1; },
    stroke() {
      record.strokes.push({ alpha: ctx.globalAlpha, segments: ctx.__pending });
      record.shadowBlurs.push(ctx.shadowBlur);
      record.shadowColors.push(ctx.shadowColor);
    },
    __pending: 0,
  };
  return ctx;
}

function makeRecordingDocumentRef(record) {
  const listeners = new Map();
  return {
    hidden: false,
    createElement() {
      const classSet = new Set();
      return {
        tagName: 'CANVAS', parentNode: null, width: 0, height: 0, style: {},
        classList: { add: (c) => classSet.add(c), remove: (c) => classSet.delete(c), contains: (c) => classSet.has(c) },
        setAttribute() {},
        getContext() { return createRecordingContext(record); },
      };
    },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) { if (listeners.has(name)) listeners.get(name).delete(fn); },
    listenerCount(name) { return listeners.has(name) ? listeners.get(name).size : 0; },
    fire(name, payload) { (listeners.get(name) || new Set()).forEach((fn) => fn(payload)); },
  };
}

function newRecord() { return { strokes: [], shadowBlurs: [], shadowColors: [] }; }

const HOST_RECT = { left: 0, top: 0, width: 900, height: 560 };

// A single full-bleed chat host -- the production shape since F1 (2026-08-21).
function mountController({ raf, record, reducedMotion = false, tokens = STYLE_TOKENS }) {
  const documentRef = makeRecordingDocumentRef(record);
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const host = makeStyledFixtureHost(HOST_RECT, { ...tokens });
  const controller = contextWeave.createContextWeaveController({
    documentRef, reducedMotionQuery, rendererLaunchSeed: 17,
  });
  controller.bind(buildFixtureContext({
    hosts: [{ element: host, role: 'chat-left' }],
    sceneRect: HOST_RECT,
    hostRects: [HOST_RECT],
    spawnAvoidanceRects: [{ left: 300, top: 200, width: 240, height: 160 }],
  }));
  raf.flush(16);
  return { controller, host, documentRef, reducedMotionQuery };
}

function input(type, x, y, overrides = {}) {
  return Object.assign({
    type, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    buttons: 0, pressure: 0, timeStamp: 32,
    clientX: x, clientY: y, surfaceRole: 'chat-left',
    localX: x, localY: y, sceneX: x, sceneY: y, generation: 1,
  }, overrides);
}

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
    pointer: { active: false, x: 0, y: 0 },
    pluck: { active: false, col: 0, row: 0, amplitude: 0 },
    age: 0, bandEnergy: 0, now: 0, radius: 150, gap,
  };
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

// ── 5: rest detection (the F2 fix) ──────────────────────────────────────────

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
    rearm('setActivity(idle)', () => controller.setActivity({
      scopeEpoch: 3, phase: 'idle', phaseRevision: 1, targetEnergy: 0.08, attentionScale: 1,
    }));
    rearm('handleActivityImpulse', () => {
      controller.handleActivityImpulse({ scopeEpoch: 3, sequence: 1, kind: 'cancel', timeStamp: 90 });
    });
    rearm('refresh', () => controller.refresh(buildFixtureContext({
      hosts: [{ element: host, role: 'chat-left' }],
      sceneRect: HOST_RECT, hostRects: [HOST_RECT],
    })));

    controller.dispose();
  });
});

test('a live pointer keeps the loop running and releasing it lets the loop stop', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    raf.flush(32); raf.flush(48);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0);

    controller.handleInput(input('move', 120, 140));
    for (let i = 0; i < 5; i += 1) {
      assert.equal(controller._internals.inspect().pendingFrameCount, 1, 'a live pointer sustains the loop');
      raf.flush(64 + i * 16);
    }
    controller.handleInput(input('leave', 120, 140, { timeStamp: 200 }));
    raf.flush(240);
    raf.flush(256);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0,
      'the pointer leaving lets the loop settle after one repaint');
    controller.dispose();
  });
});

// ── 6: geometry is static (the D5 contract) ─────────────────────────────────

test('a pointer move changes stroke alpha but leaves the lattice bit-identical', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record });
    raf.flush(32); raf.flush(48);
    const before = latticeSnapshot(controller);
    const idleAlphas = new Set(record.strokes.map((entry) => entry.alpha.toFixed(4)));

    record.strokes.length = 0;
    controller.handleInput(input('move', 440, 260));
    raf.flush(64);
    const after = latticeSnapshot(controller);
    const hoverAlphas = new Set(record.strokes.map((entry) => entry.alpha.toFixed(4)));

    assert.deepEqual(after.x, before.x, 'nodeX must not move under the pointer');
    assert.deepEqual(after.y, before.y, 'nodeY must not move under the pointer');
    assert.ok(hoverAlphas.size > idleAlphas.size,
      `hover must light threads via alpha (idle ${idleAlphas.size} -> hover ${hoverAlphas.size} distinct values)`);
    controller.dispose();
  });
});

// ── 7-8: the alpha cap and the absent shadow ────────────────────────────────

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

    controller.setActivity({ scopeEpoch: 1, phase: 'streaming', phaseRevision: 1, targetEnergy: 1, attentionScale: 1 });
    controller.handleInput(input('move', 0, 0));
    raf.flush(64);
    controller.handleInput(input('move', 0, 0, { timeStamp: 80 }));
    raf.flush(80);

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
    controller.setActivity({ scopeEpoch: 1, phase: 'streaming', phaseRevision: 1, targetEnergy: 1, attentionScale: 1 });
    controller.handleInput(input('move', 200, 200));
    raf.flush(32); raf.flush(48);
    controller.handleInput(input('click', 120, 90, { timeStamp: 64 }));
    raf.flush(64);

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

// ── 9: the reactive-grid quantisation trap ──────────────────────────────────

test('alpha bucketing does not swallow the streaming band', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record });
    raf.flush(32);

    record.strokes.length = 0;
    controller.setActivity({ scopeEpoch: 1, phase: 'idle', phaseRevision: 1, targetEnergy: 0.08, attentionScale: 1 });
    raf.flush(48);
    const idleAlphas = new Set(record.strokes.map((entry) => entry.alpha.toFixed(4)));

    record.strokes.length = 0;
    controller.setActivity({ scopeEpoch: 1, phase: 'streaming', phaseRevision: 2, targetEnergy: 0.9, attentionScale: 1 });
    raf.flush(64); raf.flush(80); raf.flush(96);
    const streamingAlphas = new Set(record.strokes.map((entry) => entry.alpha.toFixed(4)));

    // reactive-grid's 2026-07-22 lesson: an alpha-only signal that never
    // crosses a bucket boundary renders as literally nothing. If the band ever
    // stops producing MORE distinct alphas than rest, it has shipped as a
    // no-op and this reds.
    assert.ok(
      streamingAlphas.size > idleAlphas.size,
      `the streaming band must survive quantisation (idle ${idleAlphas.size} -> streaming ${streamingAlphas.size})`
    );
    controller.dispose();
  });
});

test('the streaming band decays through the phase envelope rather than waiting for a complete impulse', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    controller.setActivity({ scopeEpoch: 1, phase: 'streaming', phaseRevision: 1, targetEnergy: 0.9, attentionScale: 1 });
    raf.flush(32); raf.flush(48);
    assert.ok(controller._internals.inspect().bandEnergy > 0, 'streaming lights the band');

    // settling's target energy never returns to idle, so an energy-driven band
    // would never fade. The phase envelope is what terminates it.
    controller.setActivity({ scopeEpoch: 1, phase: 'settling', phaseRevision: 2, targetEnergy: 0.18, attentionScale: 1 });
    let now = 64;
    for (let i = 0; i < 120; i += 1) { now += 40; raf.flush(now); }
    assert.equal(controller._internals.inspect().bandEnergy, 0, 'the band settles to exactly zero');
    assert.equal(controller._internals.inspect().pendingFrameCount, 0, 'and the loop stops with it');
    controller.dispose();
  });
});

// ── 10: the pluck ───────────────────────────────────────────────────────────

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

test('a click plucks one warp and one weft thread, a second click replaces it, and the cloth returns to rest', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    raf.flush(32); raf.flush(48);
    const resting = latticeSnapshot(controller);

    controller.handleInput(input('click', 90, 80, { timeStamp: 64 }));
    let state = controller._internals.inspect();
    assert.equal(state.pluckActive, true);
    const firstCol = state.pluckCol;
    const firstRow = state.pluckRow;

    controller.handleInput(input('click', 760, 470, { timeStamp: 72 }));
    state = controller._internals.inspect();
    assert.equal(state.pluckActive, true, 'still exactly one pluck');
    assert.ok(state.pluckCol !== firstCol || state.pluckRow !== firstRow,
      'the second click replaces the first rather than stacking');

    // The pluck is closed-form, so it self-terminates -- and the lattice it
    // displaced was never written to in the first place.
    let now = 100;
    for (let i = 0; i < 80; i += 1) { now += 40; raf.flush(now); }
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

test('activity impulses pluck an interior thread with amplitude by kind', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    controller.setActivity({ scopeEpoch: 4, phase: 'streaming', phaseRevision: 1, targetEnergy: 0.7, attentionScale: 1 });
    raf.flush(32);

    controller.handleActivityImpulse({ scopeEpoch: 4, sequence: 1, kind: 'tool-start', timeStamp: 48 });
    const toolStart = controller._internals.inspect();
    assert.equal(toolStart.pluckActive, true);
    assert.ok(toolStart.pluckCol > 0 && toolStart.pluckCol < toolStart.cols - 1, 'an interior column, not the pinned selvedge');
    assert.ok(toolStart.pluckRow > 0 && toolStart.pluckRow < toolStart.rows - 1, 'an interior row');

    controller.handleActivityImpulse({ scopeEpoch: 4, sequence: 2, kind: 'complete', timeStamp: 56 });
    const complete = controller._internals.inspect();
    assert.ok(complete.pluckAmplitude > toolStart.pluckAmplitude, 'complete plucks harder than tool-start');

    controller.handleActivityImpulse({ scopeEpoch: 4, sequence: 3, kind: 'cancel', timeStamp: 64 });
    assert.equal(controller._internals.inspect().pluckActive, false, 'cancel clears the pluck');
    controller.dispose();
  });
});

// ── 11: impulse filtering ───────────────────────────────────────────────────

test('impulses with a stale scopeEpoch or a non-increasing sequence are ignored', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const { controller } = mountController({ raf, record: newRecord() });
    controller.setActivity({ scopeEpoch: 9, phase: 'streaming', phaseRevision: 1, targetEnergy: 0.7, attentionScale: 1 });
    raf.flush(32);

    controller.handleActivityImpulse({ scopeEpoch: 8, sequence: 1, kind: 'complete', timeStamp: 40 });
    assert.equal(controller._internals.inspect().pluckActive, false, 'a stale scopeEpoch is dropped');

    controller.handleActivityImpulse({ scopeEpoch: 9, sequence: 5, kind: 'complete', timeStamp: 48 });
    const after = controller._internals.inspect();
    assert.equal(after.pluckActive, true);

    controller.handleActivityImpulse({ scopeEpoch: 9, sequence: 5, kind: 'cancel', timeStamp: 56 });
    assert.equal(controller._internals.inspect().pluckActive, true, 'a repeated sequence is dropped');
    controller.handleActivityImpulse({ scopeEpoch: 9, sequence: 3, kind: 'cancel', timeStamp: 64 });
    assert.equal(controller._internals.inspect().pluckActive, true, 'a regressing sequence is dropped');
    controller.handleActivityImpulse({ scopeEpoch: 9, sequence: 6, kind: 'cancel', timeStamp: 72 });
    assert.equal(controller._internals.inspect().pluckActive, false, 'the next sequence is honored');
    controller.dispose();
  });
});

// ── 12: reduced motion ──────────────────────────────────────────────────────

test('reduced motion draws the resting lattice once and requests no frames', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller } = mountController({ raf, record, reducedMotion: true });
    assert.equal(controller._internals.inspect().reducedMotion, true);
    assert.equal(controller._internals.inspect().pendingFrameCount, 0);
    assert.ok(record.strokes.length > 0, 'the resting cloth is painted once');

    const before = record.strokes.length;
    controller.handleInput(input('move', 300, 300));
    controller.handleInput(input('click', 80, 80, { timeStamp: 48 }));
    assert.equal(controller._internals.inspect().pluckActive, false, 'reduced motion never plucks');
    assert.equal(controller._internals.inspect().pendingFrameCount, 0, 'and never requests an animation frame');
    assert.ok(record.strokes.length > before, 'it still repaints synchronously on input');
    controller.dispose();
  });
});

// ── 13: disposal ────────────────────────────────────────────────────────────

test('dispose removes canvases, cancels frames, unregisters listeners, and is safe twice', () => {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const record = newRecord();
    const { controller, host, documentRef, reducedMotionQuery } = mountController({ raf, record });
    controller.handleInput(input('move', 200, 200));
    assert.equal(controller._internals.inspect().pendingFrameCount, 1);

    controller.dispose();
    controller.dispose();
    assert.equal(host.children.length, 0);
    assert.equal(raf.size, 0);
    assert.equal(documentRef.listenerCount('visibilitychange'), 0);
    assert.equal(reducedMotionQuery.listenerCount(), 0);
    assert.equal(controller.getStatus().state, 'dormant');
  });
});

// ── token surface ───────────────────────────────────────────────────────────

test('the weave token surface has a schema, a foundation floor, and one override per palette', () => {
  const root = path.resolve(__dirname, '..');
  const foundation = fs.readFileSync(path.join(root, 'styles', 'foundation.css'), 'utf8');
  const palettes = fs.readdirSync(path.join(root, 'styles'))
    .filter((name) => /^palette-.*\.css$/.test(name));
  const paletteCss = palettes.map((name) => [
    name,
    fs.readFileSync(path.join(root, 'styles', name), 'utf8'),
  ]);
  // Derived from the appearance registry rather than a hardcoded count: every
  // preset except the `midnight` baseline (which lives in foundation.css) ships
  // a styles/palette-<id>.css override, and there are no orphan palette files.
  const expectedPaletteFiles = appearanceUtils.getPalettePresets()
    .map((preset) => preset.id)
    .filter((id) => id !== 'midnight')
    .map((id) => `palette-${id}.css`)
    .sort();
  assert.deepEqual(palettes.slice().sort(), expectedPaletteFiles);

  const registryTokens = appearanceUtils.getSurfaceEffectPresets()
    .find((preset) => preset.id === 'context-weave').requiredTokens;
  assert.deepEqual(Array.from(registryTokens).sort(), TOKENS.slice().sort(),
    'the registry, the runtime schema and these tests must agree on the token set');

  for (const token of TOKENS) {
    assert.ok(runtime.SURFACE_EFFECT_TOKEN_SCHEMAS[token], `${token} has a schema`);
    assert.match(foundation, new RegExp(`${token}:\\s*[^;]+;`), `${token} has a foundation floor`);
    for (const [palette, css] of paletteCss) {
      assert.match(css, new RegExp(`${token}:\\s*[^;]+;`), `${palette} overrides ${token}`);
    }
  }

  // The spring constants, the glow knob and the second/third hue retired with
  // the restyle; they must not survive anywhere as dead tuning.
  for (const token of RETIRED_TOKENS) {
    assert.equal(runtime.SURFACE_EFFECT_TOKEN_SCHEMAS[token], undefined, `${token} has no schema`);
    assert.doesNotMatch(foundation, new RegExp(token), `${token} is gone from foundation.css`);
    for (const [palette, css] of paletteCss) {
      assert.doesNotMatch(css, new RegExp(token), `${token} is gone from ${palette}`);
    }
  }
});
