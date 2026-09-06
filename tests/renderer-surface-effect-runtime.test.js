// spec-first: shared surface-effect runtime suite for
// renderer/shell/renderer-surface-effect-runtime.js (Background Effects v3,
// packet S4). UMD module -- require() returns the full API directly (no
// jsdom, no DOM globals). Style-matches tests/renderer-app-surface-input.test.js:
// node:test + node:assert/strict, plain-object fakes.

const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const { createRafHarness } = require('./helpers/surface-effect-router-harness.js');

// ── parseTokenValue: per-type matrix ────────────────────────────────────────

const NUMBER_SCHEMA = Object.freeze({ type: 'number', fallback: 5, min: 0, max: 10 });
const INTEGER_SCHEMA = Object.freeze({ type: 'integer', fallback: 4, min: 1, max: 20 });
const LENGTH_PX_SCHEMA = Object.freeze({ type: 'length-px', fallback: 14, min: 4, max: 200 });
const ALPHA_SCHEMA = Object.freeze({ type: 'alpha', fallback: 0.5 });
const ALPHA_SCHEMA_BOUNDED = Object.freeze({ type: 'alpha', fallback: 0.5, min: 0.2, max: 0.8 });
const ENUM_SCHEMA = Object.freeze({ type: 'enum', fallback: 'solid', values: ['solid', 'dashed', 'dotted'] });
const COLOR_SCHEMA = Object.freeze({ type: 'color', fallback: '#000000' });

test('parseTokenValue: number is unitless-strict -- px-suffixed input falls back', () => {
  assert.equal(runtime.parseTokenValue(NUMBER_SCHEMA, '7'), 7);
  assert.equal(runtime.parseTokenValue(NUMBER_SCHEMA, '24px'), NUMBER_SCHEMA.fallback);
  assert.equal(runtime.parseTokenValue(NUMBER_SCHEMA, ''), NUMBER_SCHEMA.fallback);
  assert.equal(runtime.parseTokenValue(NUMBER_SCHEMA, '-5'), 0, 'clamped to min');
  assert.equal(runtime.parseTokenValue(NUMBER_SCHEMA, '50'), 10, 'clamped to max');
  assert.equal(runtime.parseTokenValue(NUMBER_SCHEMA, '3.7'), 3.7, 'fractional numbers pass through unrounded');
});

test('parseTokenValue: length-px accepts px-suffixed and bare numbers, rejects trailing garbage', () => {
  assert.equal(runtime.parseTokenValue(LENGTH_PX_SCHEMA, '24px'), 24);
  assert.equal(runtime.parseTokenValue(LENGTH_PX_SCHEMA, '24'), 24, 'bare number is also accepted');
  assert.equal(runtime.parseTokenValue(LENGTH_PX_SCHEMA, '12garbage'), LENGTH_PX_SCHEMA.fallback);
  assert.equal(runtime.parseTokenValue(LENGTH_PX_SCHEMA, '2px'), 4, 'clamped to min 4');
  assert.equal(runtime.parseTokenValue(LENGTH_PX_SCHEMA, '9001px'), 200, 'clamped to max 200');
});

test('parseTokenValue: integer rounds then clamps', () => {
  assert.equal(runtime.parseTokenValue(INTEGER_SCHEMA, '3.4'), 3);
  assert.equal(runtime.parseTokenValue(INTEGER_SCHEMA, '3.5'), 4, 'rounds half up');
  assert.equal(runtime.parseTokenValue(INTEGER_SCHEMA, '0'), 1, 'rounded then clamped to min');
  assert.equal(runtime.parseTokenValue(INTEGER_SCHEMA, '999'), 20, 'clamped to max');
});

test('parseTokenValue: alpha clamps to [0,1] by default, or schema min/max when declared', () => {
  assert.equal(runtime.parseTokenValue(ALPHA_SCHEMA, '0.5'), 0.5);
  assert.equal(runtime.parseTokenValue(ALPHA_SCHEMA, '-3'), 0);
  assert.equal(runtime.parseTokenValue(ALPHA_SCHEMA, '3'), 1);
  assert.equal(runtime.parseTokenValue(ALPHA_SCHEMA_BOUNDED, '0'), 0.2);
  assert.equal(runtime.parseTokenValue(ALPHA_SCHEMA_BOUNDED, '1'), 0.8);
});

test('parseTokenValue: enum lowercases and requires membership', () => {
  assert.equal(runtime.parseTokenValue(ENUM_SCHEMA, 'DASHED'), 'dashed');
  assert.equal(runtime.parseTokenValue(ENUM_SCHEMA, 'dotted'), 'dotted');
  assert.equal(runtime.parseTokenValue(ENUM_SCHEMA, 'zigzag'), ENUM_SCHEMA.fallback);
  assert.equal(runtime.parseTokenValue(ENUM_SCHEMA, ''), ENUM_SCHEMA.fallback);
});

test('parseTokenValue: color -- empty falls back; transparent, hex, and functional syntax pass; garbage falls back', () => {
  assert.equal(runtime.parseTokenValue(COLOR_SCHEMA, ''), COLOR_SCHEMA.fallback);
  assert.equal(runtime.parseTokenValue(COLOR_SCHEMA, 'transparent'), 'transparent');
  ['#fff', '#ffff', '#ffffff', '#ffffff80'].forEach((hex) => {
    assert.equal(runtime.parseTokenValue(COLOR_SCHEMA, hex), hex, `${hex} is a valid hex color`);
  });
  ['#zzz', '#12345'].forEach((hex) => {
    assert.equal(runtime.parseTokenValue(COLOR_SCHEMA, hex), COLOR_SCHEMA.fallback, `${hex} is not valid hex`);
  });
  ['rgb(0,0,0)', 'rgba(0,0,0,0.5)', 'oklch(0.5 0.1 180)', 'var(--x)'].forEach((fn) => {
    assert.equal(runtime.parseTokenValue(COLOR_SCHEMA, fn), fn, `${fn} is passed through verbatim`);
  });
  assert.equal(runtime.parseTokenValue(COLOR_SCHEMA, '12 garbage 34'), COLOR_SCHEMA.fallback);
});

test('parseTokenValue: an unknown schema or an unknown schema.type returns null', () => {
  assert.equal(runtime.parseTokenValue(null, '5'), null);
  assert.equal(runtime.parseTokenValue(undefined, '5'), null);
  assert.equal(runtime.parseTokenValue({ type: 'bogus', fallback: 1 }, '5'), null);
});

// ── TOKEN FUZZ: mechanically enumerate every declared schema ───────────────

const FUZZ_CORPUS = [
  '', '   ', 'NaN', 'Infinity', '-Infinity', '0', '-5', '3.7', '1e9',
  '999999999', '24px', '12garbage', 'transparent', '#zz',
];

test('TOKEN FUZZ: every declared schema survives the full fuzz corpus within bounds, never NaN/Infinity', () => {
  const schemaNames = Object.keys(runtime.SURFACE_EFFECT_TOKEN_SCHEMAS);
  assert.ok(schemaNames.length >= 6, 'at least the 6 schemas known at S4 time');

  let enumeratedCount = 0;
  schemaNames.forEach((name) => {
    enumeratedCount += 1;
    const schema = runtime.SURFACE_EFFECT_TOKEN_SCHEMAS[name];
    const isNumeric = schema.type === 'number' || schema.type === 'integer'
      || schema.type === 'length-px' || schema.type === 'alpha';
    FUZZ_CORPUS.forEach((raw) => {
      const result = runtime.parseTokenValue(schema, raw);
      if (isNumeric) {
        assert.ok(Number.isFinite(result), `${name} <- ${JSON.stringify(raw)} produced a non-finite value: ${result}`);
        const min = typeof schema.min === 'number' ? schema.min : -Infinity;
        const max = typeof schema.max === 'number' ? schema.max : Infinity;
        const withinBounds = result >= min && result <= max;
        assert.ok(
          result === schema.fallback || withinBounds,
          `${name} <- ${JSON.stringify(raw)} = ${result} is neither the fallback nor within [${min}, ${max}]`,
        );
      } else {
        assert.equal(typeof result, 'string', `${name} <- ${JSON.stringify(raw)} should stay a string for ${schema.type}`);
      }
    });
  });
  assert.equal(enumeratedCount, schemaNames.length, 'every declared schema was exercised, none skipped');
});

// ── createFrameClock ─────────────────────────────────────────────────────────

test('createFrameClock: the first advance always reports dt 0', () => {
  const clock = runtime.createFrameClock();
  assert.deepEqual(clock.advance(1000), { dtMs: 0, longGap: false });
});

test('createFrameClock: a normal advance reports the real elapsed dt', () => {
  const clock = runtime.createFrameClock();
  clock.advance(1000);
  assert.deepEqual(clock.advance(1016), { dtMs: 16, longGap: false });
});

test('createFrameClock: dt is capped at maxDtMs (default 80)', () => {
  const clock = runtime.createFrameClock();
  clock.advance(0);
  assert.deepEqual(clock.advance(500), { dtMs: 80, longGap: false });
});

test('createFrameClock: a custom maxDtMs is honored', () => {
  const clock = runtime.createFrameClock({ maxDtMs: 30, longGapMs: 10000 });
  clock.advance(0);
  assert.deepEqual(clock.advance(1000), { dtMs: 30, longGap: false });
});

test('createFrameClock: a gap beyond longGapMs (default 500) reports {dtMs:0, longGap:true}', () => {
  const clock = runtime.createFrameClock();
  clock.advance(0);
  assert.deepEqual(clock.advance(600), { dtMs: 0, longGap: true });
});

test('createFrameClock: reset() makes the next advance report dt 0 again', () => {
  const clock = runtime.createFrameClock();
  clock.advance(0);
  clock.advance(16);
  clock.reset();
  assert.deepEqual(clock.advance(9999), { dtMs: 0, longGap: false });
});

test('createFrameClock: a monotonic-regression (nowMs going backwards) clamps dt to 0, never negative', () => {
  const clock = runtime.createFrameClock();
  clock.advance(1000);
  const result = clock.advance(900);
  assert.equal(result.dtMs, 0);
  assert.equal(result.longGap, false, 'a backwards jump is not treated as a long gap');
});

// ── approachExponential ──────────────────────────────────────────────────────

test('approachExponential: converges toward the target over repeated ticks', () => {
  let current = 0;
  for (let i = 0; i < 50; i += 1) {
    current = runtime.approachExponential(current, 100, 16, 200);
  }
  assert.ok(current > 50 && current < 100, `expected meaningful convergence, got ${current}`);
  assert.ok(Math.abs(current - 100) < 5, `expected near-convergence after 50 ticks, got ${current}`);
});

test('approachExponential: deltaMs 0 returns current unchanged', () => {
  assert.equal(runtime.approachExponential(10, 100, 0, 200), 10);
});

test('approachExponential: timeConstantMs 0 or negative returns current unchanged', () => {
  assert.equal(runtime.approachExponential(10, 100, 16, 0), 10);
  assert.equal(runtime.approachExponential(10, 100, 16, -5), 10);
});

test('approachExponential: a larger deltaMs moves strictly closer to the target than a smaller one', () => {
  const small = runtime.approachExponential(0, 100, 8, 200);
  const large = runtime.approachExponential(0, 100, 32, 200);
  assert.ok(large > small, `expected the larger dt to move further: small=${small} large=${large}`);
});

// ── advancePhaseEnvelope ─────────────────────────────────────────────────────

// The pre-extraction law, transcribed verbatim from the inline
// updateComposeEnvelope / updateStreamEnvelope bodies the helper replaced. The
// fuzz matrix below pins the helper to it exactly -- extraction must not move a
// single bit of the streaming-ambience envelope.
function referencePhaseEnvelope(current, phase, dtMs, reducedMotion) {
  if (reducedMotion) { return 0; }
  if (phase === 'streaming') { return 1; }
  if (phase === 'settling' && current > 0) {
    return Math.max(current - dtMs / 1200, 0);
  }
  return 0;
}

test('advancePhaseEnvelope: the hold phase pins the envelope at 1 regardless of dt or prior value', () => {
  assert.equal(runtime.advancePhaseEnvelope(0, 'streaming', 16.67), 1);
  assert.equal(runtime.advancePhaseEnvelope(0.4, 'streaming', 80), 1);
  assert.equal(runtime.advancePhaseEnvelope(1, 'streaming', 0), 1);
});

test('advancePhaseEnvelope: the decay phase bleeds linearly by dtMs/decayMs and floors at zero', () => {
  assert.equal(runtime.advancePhaseEnvelope(1, 'settling', 120), 0.9, '120 ms of a 1200 ms window');
  assert.equal(runtime.advancePhaseEnvelope(0.5, 'settling', 600), 0);
  assert.equal(runtime.advancePhaseEnvelope(0.05, 'settling', 600), 0, 'never goes negative');
});

test('advancePhaseEnvelope: the default window is the exported contract constant', () => {
  assert.equal(runtime.PHASE_ENVELOPE_DECAY_MS, 1200);
  const oneTick = runtime.advancePhaseEnvelope(1, 'settling', runtime.PHASE_ENVELOPE_DECAY_MS);
  assert.equal(oneTick, 0, 'one full-window tick closes the envelope outright');
  assert.equal(
    runtime.advancePhaseEnvelope(1, 'settling', 300),
    runtime.advancePhaseEnvelope(1, 'settling', 300, { decayMs: runtime.PHASE_ENVELOPE_DECAY_MS }),
    'omitting decayMs matches passing the constant explicitly',
  );
});

test('advancePhaseEnvelope: a full decay ramp reaches exactly zero over the window', () => {
  let envelope = 1;
  for (let i = 0; i < 70; i += 1) {
    envelope = runtime.advancePhaseEnvelope(envelope, 'settling', 16.67);
  }
  assert.ok(envelope > 0, `expected the envelope still open before the window elapses, got ${envelope}`);
  for (let i = 0; i < 8; i += 1) {
    envelope = runtime.advancePhaseEnvelope(envelope, 'settling', 16.67);
  }
  assert.equal(envelope, 0, 'the envelope terminates by phase alone -- no impulse required');
});

test('advancePhaseEnvelope: every phase outside hold/decay zeroes the envelope outright', () => {
  for (const phase of ['idle', 'preflight', 'awaiting-user', 'failed', 'unknown-phase', '', null, undefined]) {
    assert.equal(runtime.advancePhaseEnvelope(1, phase, 16.67), 0, `phase ${String(phase)} must zero`);
  }
});

test('advancePhaseEnvelope: reduced motion zeroes even in the hold phase', () => {
  assert.equal(runtime.advancePhaseEnvelope(1, 'streaming', 16.67, { reducedMotion: true }), 0);
  assert.equal(runtime.advancePhaseEnvelope(0.5, 'settling', 16.67, { reducedMotion: true }), 0);
});

test('advancePhaseEnvelope: an already-closed envelope stays closed in the decay phase', () => {
  assert.equal(runtime.advancePhaseEnvelope(0, 'settling', 16.67), 0);
  assert.equal(runtime.advancePhaseEnvelope(-0.2, 'settling', 16.67), 0, 'a negative value never rises');
});

test('advancePhaseEnvelope: holdPhase, decayPhase, and decayMs are caller-owned', () => {
  const options = { holdPhase: 'preflight', decayPhase: 'idle', decayMs: 400 };
  assert.equal(runtime.advancePhaseEnvelope(0, 'preflight', 16, options), 1);
  assert.equal(runtime.advancePhaseEnvelope(1, 'idle', 100, options), 0.75, '100 ms of a 400 ms window');
  assert.equal(runtime.advancePhaseEnvelope(1, 'streaming', 16, options), 0,
    'the default phases hold no privilege once overridden');
});

test('advancePhaseEnvelope: pure -- repeated calls with the same inputs return the same value', () => {
  const options = Object.freeze({ reducedMotion: false });
  const first = runtime.advancePhaseEnvelope(0.6, 'settling', 33, options);
  const second = runtime.advancePhaseEnvelope(0.6, 'settling', 33, options);
  assert.equal(first, second);
  assert.deepEqual(options, { reducedMotion: false }, 'the options object is not mutated');
});

test('advancePhaseEnvelope: bit-identical to the pre-extraction inline law across a fuzz matrix', () => {
  const phases = ['idle', 'preflight', 'streaming', 'awaiting-user', 'settling', 'failed', 'nonsense'];
  const currents = [0, -0.1, 0.0001, 0.25, 0.5, 0.999, 1];
  const deltas = [0, 1, 16.67, 33.34, 80, 1200, 5000];
  let compared = 0;
  for (const phase of phases) {
    for (const current of currents) {
      for (const dtMs of deltas) {
        for (const reducedMotion of [false, true]) {
          const actual = runtime.advancePhaseEnvelope(current, phase, dtMs, { reducedMotion });
          const expected = referencePhaseEnvelope(current, phase, dtMs, reducedMotion);
          assert.equal(actual, expected,
            `phase=${phase} current=${current} dt=${dtMs} reduced=${reducedMotion}`);
          compared += 1;
        }
      }
    }
  }
  assert.equal(compared, phases.length * currents.length * deltas.length * 2);
});

// ── makeRng ───────────────────────────────────────────────────────────────────

function referenceLcg(seed) {
  let s = ((seed ^ 0xdeadbeef) >>> 0) || 1;
  return function draw() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

test('makeRng: deterministic -- the same seed reproduces the identical sequence', () => {
  const a = runtime.makeRng(12345);
  const b = runtime.makeRng(12345);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('makeRng: different seeds diverge', () => {
  const a = runtime.makeRng(1);
  const b = runtime.makeRng(2);
  assert.notEqual(a(), b());
});

test('makeRng: output always lands in [0, 1)', () => {
  const rng = runtime.makeRng(777);
  for (let i = 0; i < 200; i += 1) {
    const value = rng();
    assert.ok(value >= 0 && value < 1, `value ${value} out of [0,1)`);
  }
});

test("makeRng PARITY: seed 12345 matches renderer-atomic-burst-utils.js's internal LCG bit-for-bit", () => {
  const runtimeRng = runtime.makeRng(12345);
  const referenceRng = referenceLcg(12345);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(runtimeRng(), referenceRng(), `draw ${i} diverged`);
  }
});

// ── hashSeedString / computeSceneSeed ───────────────────────────────────────

test('hashSeedString: always a stable, non-negative uint32', () => {
  ['', 'a', 'atomic-burst', 'home', 'chat', 'some-longer-string-value'].forEach((input) => {
    const first = runtime.hashSeedString(input);
    const second = runtime.hashSeedString(input);
    assert.equal(first, second, 'stable for the same input');
    assert.ok(Number.isInteger(first) && first >= 0 && first <= 0xffffffff, `${first} is not a valid uint32`);
  });
});

test('computeSceneSeed: the same {rendererLaunchSeed, effectId, sceneRole} always matches', () => {
  const params = { rendererLaunchSeed: 42, effectId: 'atomic-burst', sceneRole: 'chat' };
  assert.equal(runtime.computeSceneSeed(params), runtime.computeSceneSeed(Object.assign({}, params)));
});

test('computeSceneSeed: sceneRole varies the seed -- one seed per scene, not per gutter/session (Rev 2 sec 3.7)', () => {
  const base = { rendererLaunchSeed: 42, effectId: 'atomic-burst' };
  const home = runtime.computeSceneSeed(Object.assign({ sceneRole: 'home' }, base));
  const chat = runtime.computeSceneSeed(Object.assign({ sceneRole: 'chat' }, base));
  assert.notEqual(home, chat);
});

test('computeSceneSeed: effectId also varies the seed', () => {
  const base = { rendererLaunchSeed: 42, sceneRole: 'chat' };
  const a = runtime.computeSceneSeed(Object.assign({ effectId: 'atomic-burst' }, base));
  const b = runtime.computeSceneSeed(Object.assign({ effectId: 'context-weave' }, base));
  assert.notEqual(a, b);
});

test('computeSceneSeed: ignores properties outside {rendererLaunchSeed, effectId, sceneRole} (e.g. gutter/session)', () => {
  const params = { rendererLaunchSeed: 42, effectId: 'atomic-burst', sceneRole: 'chat' };
  const withExtra = Object.assign({ gutter: 'left', sessionId: 'abc' }, params);
  assert.equal(runtime.computeSceneSeed(params), runtime.computeSceneSeed(withExtra));
});

// ── ensureCanvas2d ────────────────────────────────────────────────────────────

function makeFakeCanvas({ contextResult, throwOnGetContext = false, withParent = true } = {}) {
  const removed = [];
  const parentNode = withParent ? { removeChild(child) { removed.push(child); } } : null;
  const canvas = {
    parentNode,
    getContext() {
      if (throwOnGetContext) {
        throw new Error('getContext boom');
      }
      return contextResult;
    },
  };
  return { canvas, removed };
}

test('ensureCanvas2d: returns the 2d context when getContext succeeds', () => {
  const ctx = { fakeCtx: true };
  const { canvas, removed } = makeFakeCanvas({ contextResult: ctx });
  assert.equal(runtime.ensureCanvas2d(canvas), ctx);
  assert.equal(removed.length, 0);
});

test('ensureCanvas2d: getContext returning null removes the canvas from its parentNode and returns null', () => {
  const { canvas, removed } = makeFakeCanvas({ contextResult: null });
  assert.equal(runtime.ensureCanvas2d(canvas), null);
  assert.deepEqual(removed, [canvas]);
});

test('ensureCanvas2d: getContext throwing removes the canvas and returns null', () => {
  const { canvas, removed } = makeFakeCanvas({ throwOnGetContext: true });
  assert.equal(runtime.ensureCanvas2d(canvas), null);
  assert.deepEqual(removed, [canvas]);
});

test('ensureCanvas2d: a dead canvas without a parentNode returns null and attempts no removal', () => {
  const { canvas, removed } = makeFakeCanvas({ contextResult: null, withParent: false });
  assert.equal(runtime.ensureCanvas2d(canvas), null);
  assert.deepEqual(removed, [], 'nothing to remove a parentless canvas from');
});

test('ensureCanvas2d: non-canvas input returns null without throwing', () => {
  assert.equal(runtime.ensureCanvas2d(null), null);
  assert.equal(runtime.ensureCanvas2d(undefined), null);
  assert.equal(runtime.ensureCanvas2d({}), null);
  assert.equal(runtime.ensureCanvas2d('not-a-canvas'), null);
});

// ── computeEffectiveDpr ───────────────────────────────────────────────────────

test('computeEffectiveDpr: respects dprCap when the pixel budget is not limiting', () => {
  const result = runtime.computeEffectiveDpr({ deviceDpr: 3, dprCap: 1.5, cssWidth: 100, cssHeight: 100 });
  assert.equal(result, 1.5);
});

test('computeEffectiveDpr: respects the backing-pixel cap even under the dprCap', () => {
  const result = runtime.computeEffectiveDpr({ deviceDpr: 2, cssWidth: 5120, cssHeight: 1440 });
  assert.ok(result < 2, `pixel-budget-limited dpr should sit below the raw deviceDpr, got ${result}`);
  const expected = Math.sqrt(4000000 / (5120 * 1440));
  assert.ok(Math.abs(result - expected) < 1e-9, `expected ~${expected}, got ${result}`);
});

test('computeEffectiveDpr: floors at 0.5 even when every other input would push it lower', () => {
  const result = runtime.computeEffectiveDpr({ deviceDpr: 0.01, cssWidth: 100000, cssHeight: 100000 });
  assert.equal(result, 0.5);
});

test('computeEffectiveDpr: applies documented defaults with no args', () => {
  assert.equal(runtime.computeEffectiveDpr(), 1);
  assert.equal(runtime.computeEffectiveDpr({}), 1);
});

// ── resizeCanvasBacking ───────────────────────────────────────────────────────

test('resizeCanvasBacking: sets width/height rounded, minimum 1', () => {
  const canvas = { width: 0, height: 0 };
  const result = runtime.resizeCanvasBacking(canvas, { cssWidth: 10.4, cssHeight: 0, effectiveDpr: 2 });
  assert.equal(result.width, 21, 'round(10.4*2)=round(20.8)=21');
  assert.equal(result.height, 1, 'zero css height floors to the 1px minimum');
  assert.equal(canvas.width, 21);
  assert.equal(canvas.height, 1);
  assert.equal(result.changed, true);
});

test('resizeCanvasBacking: changed is false when the computed dimensions are unchanged', () => {
  const canvas = { width: 21, height: 1 };
  const result = runtime.resizeCanvasBacking(canvas, { cssWidth: 10.4, cssHeight: 0, effectiveDpr: 2 });
  assert.equal(result.changed, false);
  assert.equal(result.width, 21);
  assert.equal(result.height, 1);
});

test('resizeCanvasBacking: changed is true when only one dimension differs', () => {
  const canvas = { width: 21, height: 1 };
  const result = runtime.resizeCanvasBacking(canvas, { cssWidth: 20, cssHeight: 0, effectiveDpr: 2 });
  assert.equal(result.changed, true);
  assert.equal(canvas.width, 40);
});

// ── createCoalescedResizeObserver ────────────────────────────────────────────

function makeFakeResizeObserverCtor() {
  const instances = [];
  function FakeResizeObserver(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    instances.push(this);
  }
  FakeResizeObserver.prototype.observe = function observe(el) { this.observed.push(el); };
  FakeResizeObserver.prototype.unobserve = function unobserve(el) {
    this.observed = this.observed.filter((entry) => entry !== el);
  };
  FakeResizeObserver.prototype.disconnect = function disconnect() { this.disconnected = true; };
  return { FakeResizeObserver, instances };
}

test('createCoalescedResizeObserver: multiple callbacks before the rAF flush collapse into one onResize with the last batch', () => {
  const raf = createRafHarness();
  const { FakeResizeObserver, instances } = makeFakeResizeObserverCtor();
  const calls = [];
  const co = runtime.createCoalescedResizeObserver({
    windowRef: raf, ResizeObserverRef: FakeResizeObserver, onResize: (entries) => calls.push(entries),
  });
  const el = { id: 'el' };
  co.observe(el);
  assert.deepEqual(instances[0].observed, [el]);

  instances[0].callback(['entriesA']);
  instances[0].callback(['entriesB']);
  instances[0].callback(['entriesC']);
  assert.equal(calls.length, 0, 'nothing fires before the rAF flush');

  raf.flush();
  assert.equal(calls.length, 1, 'exactly one onResize call');
  assert.deepEqual(calls[0], ['entriesC'], 'the last batch wins');
});

test('createCoalescedResizeObserver: disconnect cancels a pending flush', () => {
  const raf = createRafHarness();
  const { FakeResizeObserver, instances } = makeFakeResizeObserverCtor();
  const calls = [];
  const co = runtime.createCoalescedResizeObserver({
    windowRef: raf, ResizeObserverRef: FakeResizeObserver, onResize: (entries) => calls.push(entries),
  });
  co.observe({ id: 'el' });
  instances[0].callback(['entries']);
  assert.equal(raf.size, 1, 'a frame was scheduled');

  co.disconnect();
  assert.equal(instances[0].disconnected, true);
  assert.equal(raf.size, 0, 'the pending frame was cancelled');

  raf.flush();
  assert.equal(calls.length, 0, 'onResize never fires after disconnect');
});

test('createCoalescedResizeObserver: unobserve delegates to the underlying observer', () => {
  const raf = createRafHarness();
  const { FakeResizeObserver, instances } = makeFakeResizeObserverCtor();
  const co = runtime.createCoalescedResizeObserver({
    windowRef: raf, ResizeObserverRef: FakeResizeObserver, onResize: () => {},
  });
  const el = { id: 'el' };
  co.observe(el);
  co.unobserve(el);
  assert.deepEqual(instances[0].observed, []);
});

test('createCoalescedResizeObserver: a missing ResizeObserver constructor returns an inert, non-throwing API', () => {
  const raf = createRafHarness();
  const co = runtime.createCoalescedResizeObserver({
    windowRef: raf, ResizeObserverRef: undefined, onResize: () => { throw new Error('should never be called'); },
  });
  assert.equal(co.observe({}), undefined);
  assert.equal(co.unobserve({}), undefined);
  assert.equal(co.disconnect(), undefined);
  assert.equal(raf.size, 0, 'the inert API never schedules a rAF flush');
});

// ── bindVisibilityAndMotionListeners ─────────────────────────────────────────

function makeFakeDocumentRef(hidden = false) {
  const listeners = new Map();
  return {
    hidden,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type) || [];
      const idx = arr.indexOf(fn);
      if (idx !== -1) arr.splice(idx, 1);
    },
    fire(type) {
      (listeners.get(type) || []).slice().forEach((fn) => fn());
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

function makeFakeMql() {
  const listeners = [];
  return {
    addEventListener(type, fn) { listeners.push(fn); },
    removeEventListener(type, fn) {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    fire(matches) { listeners.slice().forEach((fn) => fn({ matches })); },
    listenerCount() { return listeners.length; },
  };
}

function makeLegacyMql() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) {
      const idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    fire(matches) { listeners.slice().forEach((fn) => fn({ matches })); },
    listenerCount() { return listeners.length; },
  };
}

test('bindVisibilityAndMotionListeners: fires visibility and motion callbacks with correct booleans', () => {
  const documentRef = makeFakeDocumentRef(false);
  const reducedMotionQuery = makeFakeMql();
  const visibilityCalls = [];
  const motionCalls = [];
  runtime.bindVisibilityAndMotionListeners({
    documentRef,
    reducedMotionQuery,
    onVisibilityChange: (hidden) => visibilityCalls.push(hidden),
    onMotionPreferenceChange: (matches) => motionCalls.push(matches),
  });

  documentRef.hidden = true;
  documentRef.fire('visibilitychange');
  documentRef.hidden = false;
  documentRef.fire('visibilitychange');
  assert.deepEqual(visibilityCalls, [true, false]);

  reducedMotionQuery.fire(true);
  reducedMotionQuery.fire(false);
  assert.deepEqual(motionCalls, [true, false]);
});

test('bindVisibilityAndMotionListeners: the disposer removes both listeners', () => {
  const documentRef = makeFakeDocumentRef();
  const reducedMotionQuery = makeFakeMql();
  const dispose = runtime.bindVisibilityAndMotionListeners({
    documentRef, reducedMotionQuery, onVisibilityChange: () => {}, onMotionPreferenceChange: () => {},
  });
  assert.equal(documentRef.listenerCount('visibilitychange'), 1);
  assert.equal(reducedMotionQuery.listenerCount(), 1);

  dispose();

  assert.equal(documentRef.listenerCount('visibilitychange'), 0);
  assert.equal(reducedMotionQuery.listenerCount(), 0);
});

test('bindVisibilityAndMotionListeners: the legacy addListener/removeListener mql API is also supported', () => {
  const reducedMotionQuery = makeLegacyMql();
  const motionCalls = [];
  const dispose = runtime.bindVisibilityAndMotionListeners({
    reducedMotionQuery, onMotionPreferenceChange: (matches) => motionCalls.push(matches),
  });
  reducedMotionQuery.fire(true);
  assert.deepEqual(motionCalls, [true]);
  assert.equal(reducedMotionQuery.listenerCount(), 1);

  dispose();
  assert.equal(reducedMotionQuery.listenerCount(), 0);
});

test('bindVisibilityAndMotionListeners: missing pieces leave the disposer safe to call', () => {
  const dispose = runtime.bindVisibilityAndMotionListeners();
  assert.equal(typeof dispose, 'function');
  assert.equal(dispose(), undefined, 'no-arg disposer runs to completion');
  const dispose2 = runtime.bindVisibilityAndMotionListeners({ documentRef: null, reducedMotionQuery: null });
  assert.equal(dispose2(), undefined, 'null-pieces disposer runs to completion');
  assert.equal(dispose2(), undefined, 'disposer is idempotent');
});

// ── createQualityTierMachine ──────────────────────────────────────────────────

test('createQualityTierMachine: throws on an empty tiers array', () => {
  assert.throws(() => runtime.createQualityTierMachine({
    tiers: [], degradeFrameMs: 20, recoverFrameMs: 10, degradeSustainMs: 100, recoverSustainMs: 100,
  }));
});

test('createQualityTierMachine: throws when recoverFrameMs >= degradeFrameMs', () => {
  assert.throws(() => runtime.createQualityTierMachine({
    tiers: ['high'], degradeFrameMs: 10, recoverFrameMs: 10, degradeSustainMs: 100, recoverSustainMs: 100,
  }));
  assert.throws(() => runtime.createQualityTierMachine({
    tiers: ['high'], degradeFrameMs: 10, recoverFrameMs: 15, degradeSustainMs: 100, recoverSustainMs: 100,
  }));
});

// emaAlpha: 1 makes the ema track frameMs exactly (no smoothing lag), which
// keeps every sustain-window boundary hand-derivable in the tests below.
function makeMachine(overrides = {}) {
  return runtime.createQualityTierMachine(Object.assign({
    tiers: ['high', 'medium', 'low'],
    degradeFrameMs: 20,
    recoverFrameMs: 10,
    degradeSustainMs: 100,
    recoverSustainMs: 100,
    emaAlpha: 1,
  }, overrides));
}

test('createQualityTierMachine: a single spike does not degrade', () => {
  const machine = makeMachine();
  machine.sample(25, 0);
  assert.equal(machine.getTier(), 'high');
  machine.sample(5, 50);
  assert.equal(machine.getTier(), 'high', 'the spike never sustained degradeSustainMs, so no demotion happened');
});

test('createQualityTierMachine: degrade requires a SUSTAINED ema >= degradeFrameMs for degradeSustainMs', () => {
  const machine = makeMachine();
  machine.sample(25, 0);
  assert.equal(machine.getTier(), 'high', 'first bad sample only starts the window');
  machine.sample(25, 50);
  assert.equal(machine.getTier(), 'high', 'window not yet elapsed');
  machine.sample(25, 100);
  assert.equal(machine.getTier(), 'medium', 'window elapsed -- demoted exactly one tier');
});

test('createQualityTierMachine: demotion promotes exactly one tier per sustain window, never below the last tier', () => {
  const machine = makeMachine();
  machine.sample(25, 0);
  machine.sample(25, 100);
  assert.equal(machine.getTier(), 'medium');
  machine.sample(25, 200);
  assert.equal(machine.getTier(), 'low', 'a second full sustain window demotes again');
  machine.sample(25, 300);
  machine.sample(25, 1000);
  assert.equal(machine.getTier(), 'low', 'already at the worst tier -- never demotes further');
});

test('createQualityTierMachine: recovery requires a SUSTAINED ema <= recoverFrameMs for recoverSustainMs, one tier at a time', () => {
  const machine = makeMachine();
  machine.sample(25, 0);
  machine.sample(25, 100);
  machine.sample(25, 200);
  assert.equal(machine.getTier(), 'low');

  machine.sample(5, 300);
  assert.equal(machine.getTier(), 'low', 'first good sample only starts the recovery window');
  machine.sample(5, 350);
  assert.equal(machine.getTier(), 'low', 'window not yet elapsed');
  machine.sample(5, 400);
  assert.equal(machine.getTier(), 'medium', 'window elapsed -- promoted exactly one tier');
  machine.sample(5, 450);
  assert.equal(machine.getTier(), 'medium', 'promotion resets the sustain window -- needs its own full quiet period');
  machine.sample(5, 500);
  assert.equal(machine.getTier(), 'high', 'second full quiet window promotes again');
});

test('createQualityTierMachine: never promotes above the first tier', () => {
  const machine = makeMachine();
  machine.sample(5, 0);
  machine.sample(5, 500);
  machine.sample(5, 1000);
  assert.equal(machine.getTier(), 'high', 'already at the best tier -- stays put');
});

test('createQualityTierMachine: an ema strictly between the two thresholds holds the tier and resets the recovery window', () => {
  const machine = makeMachine();
  machine.sample(25, 0);
  machine.sample(25, 100);
  assert.equal(machine.getTier(), 'medium');

  machine.sample(5, 150); // starts a recovery window
  machine.sample(15, 200); // mid-band (10 < 15 < 20) -- holds, resets the recovery window
  assert.equal(machine.getState().recoverSince, null, 'the mid-band sample reset the recovery window');
  assert.equal(machine.getTier(), 'medium');

  machine.sample(5, 250); // starts a fresh recovery window
  machine.sample(5, 340);
  assert.equal(machine.getTier(), 'medium', 'the fresh window has not elapsed recoverSustainMs yet (90ms)');
  machine.sample(5, 350);
  assert.equal(machine.getTier(), 'high', 'the fresh window elapsed exactly recoverSustainMs (100ms)');
});

test('createQualityTierMachine: resetSampling() clears ema and both windows -- a post-reset spike does not instantly degrade', () => {
  const machine = makeMachine();
  machine.sample(25, 0);
  machine.sample(25, 50);
  assert.notEqual(machine.getState().frameMsEma, null);

  machine.resetSampling();
  const stateAfterReset = machine.getState();
  assert.equal(stateAfterReset.frameMsEma, null);
  assert.equal(stateAfterReset.degradeSince, null);
  assert.equal(stateAfterReset.recoverSince, null);

  machine.sample(25, 9999);
  assert.equal(machine.getTier(), 'high', 'stale pre-reset state cannot combine with the post-reset spike to degrade instantly');
});

test('createQualityGovernor: S11 defaults degrade at 750ms and recover at 3000ms one tier at a time', () => {
  assert.equal(runtime.QUALITY_GOVERNOR_DEFAULTS.degradeSustainMs, 750);
  assert.equal(runtime.QUALITY_GOVERNOR_DEFAULTS.recoverSustainMs, 3000);
  const governor = runtime.createQualityGovernor({
    tiers: ['high', 'balanced', 'low'],
    degradeFrameMs: 20,
    recoverFrameMs: 10,
    emaAlpha: 1,
  });
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 0 });
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 749 });
  assert.equal(governor.getTier(), 'high');
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 750 });
  assert.equal(governor.getTier(), 'balanced');
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 1500 });
  assert.equal(governor.getTier(), 'low');
  governor.sampleFrame({ frameIntervalMs: 5, nowMs: 1600 });
  governor.sampleFrame({ frameIntervalMs: 5, nowMs: 4599 });
  assert.equal(governor.getTier(), 'low');
  governor.sampleFrame({ frameIntervalMs: 5, nowMs: 4600 });
  assert.equal(governor.getTier(), 'balanced');
  governor.sampleFrame({ frameIntervalMs: 5, nowMs: 7600 });
  assert.equal(governor.getTier(), 'high');
});

test('createQualityGovernor: visibility changes and long gaps reset sampling windows', () => {
  const governor = runtime.createQualityGovernor({
    tiers: ['high', 'low'],
    degradeFrameMs: 20,
    recoverFrameMs: 10,
    degradeSustainMs: 100,
    recoverSustainMs: 100,
    emaAlpha: 1,
  });
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 0 });
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 90 });
  governor.setVisible(false);
  governor.setVisible(true);
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 100 });
  assert.equal(governor.getTier(), 'high', 'visibility transition discarded the old degrade window');
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 190, longGap: true });
  governor.sampleFrame({ frameIntervalMs: 25, nowMs: 200 });
  assert.equal(governor.getTier(), 'high', 'long gap discarded the second degrade window');
  assert.equal(governor.getState().samplingResets, 3);
});

// ── createFaultReporter ───────────────────────────────────────────────────────

test('createFaultReporter: forwards to report() with the full payload', () => {
  const calls = [];
  const reporter = runtime.createFaultReporter({ report: (payload) => calls.push(payload) });
  const error = new Error('boom');
  const result = reporter.reportFault({
    effectId: 'atomic-burst', stage: 'frame', recoverable: false, error,
  });
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    effectId: 'atomic-burst', stage: 'frame', recoverable: false, error,
  });
});

test('createFaultReporter: identical (effectId|stage|message) within windowMs is suppressed', () => {
  const calls = [];
  let now = 0;
  const reporter = runtime.createFaultReporter({ report: (p) => calls.push(p), windowMs: 50, nowFn: () => now });
  const fault = { effectId: 'a', stage: 'frame', error: new Error('boom') };
  assert.equal(reporter.reportFault(fault), true);
  now = 10;
  assert.equal(reporter.reportFault(fault), false, 'duplicate within the window is suppressed');
  assert.equal(reporter.getSuppressedCount(), 1);
  assert.equal(calls.length, 1);
});

test('createFaultReporter: a different message, stage, or effectId is NOT suppressed', () => {
  const calls = [];
  let now = 0;
  const reporter = runtime.createFaultReporter({ report: (p) => calls.push(p), windowMs: 50, nowFn: () => now });
  reporter.reportFault({ effectId: 'a', stage: 'frame', error: new Error('boom') });
  now = 1;
  assert.equal(
    reporter.reportFault({ effectId: 'a', stage: 'frame', error: new Error('different') }),
    true,
    'different message',
  );
  now = 2;
  assert.equal(
    reporter.reportFault({ effectId: 'a', stage: 'resize', error: new Error('boom') }),
    true,
    'different stage',
  );
  now = 3;
  assert.equal(
    reporter.reportFault({ effectId: 'b', stage: 'frame', error: new Error('boom') }),
    true,
    'different effectId',
  );
  assert.equal(calls.length, 4);
  assert.equal(reporter.getSuppressedCount(), 0);
});

test('createFaultReporter: after windowMs elapses, the same key forwards again', () => {
  const calls = [];
  let now = 0;
  const reporter = runtime.createFaultReporter({ report: (p) => calls.push(p), windowMs: 50, nowFn: () => now });
  const fault = { effectId: 'a', stage: 'frame', error: new Error('boom') };
  reporter.reportFault(fault);
  now = 49;
  assert.equal(reporter.reportFault(fault), false, 'still inside the window');
  now = 50;
  assert.equal(reporter.reportFault(fault), true, 'the window has fully elapsed');
  assert.equal(calls.length, 2);
});

test('createFaultReporter: recoverable defaults to true and is passed through when explicitly set', () => {
  const calls = [];
  const reporter = runtime.createFaultReporter({ report: (p) => calls.push(p) });
  reporter.reportFault({ effectId: 'a', stage: 'frame', error: 'boom' });
  assert.equal(calls[0].recoverable, true);
  reporter.reportFault({
    effectId: 'b', stage: 'frame', error: 'other', recoverable: false,
  });
  assert.equal(calls[1].recoverable, false);
});

// ── mapClientToScene / mapSceneToHost ─────────────────────────────────────────

test('mapClientToScene: subtracts the scene rect origin', () => {
  const rect = { left: 10, top: 20 };
  assert.deepEqual(runtime.mapClientToScene(rect, 110, 220), { sceneX: 100, sceneY: 200 });
});

test('mapClientToScene: a null sceneRect is treated as zero origin', () => {
  assert.deepEqual(runtime.mapClientToScene(null, 50, 60), { sceneX: 50, sceneY: 60 });
});

test('mapSceneToHost: converts scene-local coords through client space to host-local coords', () => {
  const hostRect = { left: 5, top: 5 };
  const sceneRect = { left: 10, top: 20 };
  // scene (100, 200) -> client (110, 220) -> host-local (105, 215).
  assert.deepEqual(runtime.mapSceneToHost(hostRect, sceneRect, 100, 200), { localX: 105, localY: 215 });
});

test('mapSceneToHost: a null hostRect and/or sceneRect is treated as zero origin', () => {
  assert.deepEqual(runtime.mapSceneToHost(null, null, 100, 200), { localX: 100, localY: 200 });
  const hostRect = { left: 5, top: 5 };
  assert.deepEqual(runtime.mapSceneToHost(hostRect, null, 100, 200), { localX: 95, localY: 195 });
});

test('mapHostToScene round-trips non-zero shared-scene and gutter offsets', () => {
  const sceneRect = { left: 30, top: 40, width: 900, height: 600 };
  const hostRect = { left: 650, top: 60, width: 280, height: 560 };
  const scenePoint = runtime.mapHostToScene(hostRect, sceneRect, 25, 35);
  assert.deepEqual(scenePoint, { sceneX: 645, sceneY: 55 });
  assert.deepEqual(runtime.mapSceneToHost(
    hostRect, sceneRect, scenePoint.sceneX, scenePoint.sceneY,
  ), { localX: 25, localY: 35 });
});

test('projectClientRectsToHost clips per item and preserves a valid tail after malformed rows', () => {
  const hostRect = { left: 100, top: 50, width: 200, height: 100 };
  const projected = runtime.projectClientRectsToHost([
    null,
    { left: Number.NaN, top: 0, width: -5, height: 4 },
    { left: 90, top: 40, width: 30, height: 30 },
    { left: 250, top: 100, width: 100, height: 100 },
    { left: 500, top: 500, width: 20, height: 20 },
  ], hostRect);
  assert.deepEqual(projected, [
    { left: 0, top: 0, width: 20, height: 20 },
    { left: 150, top: 50, width: 50, height: 50 },
  ]);
});

test('scenePointInClientRects maps scene coordinates before containment checks', () => {
  const sceneRect = { left: 30, top: 40, width: 900, height: 600 };
  const rects = [{ left: 100, top: 100, width: 50, height: 50 }];
  assert.equal(runtime.scenePointInClientRects(rects, sceneRect, 70, 60), true);
  assert.equal(runtime.scenePointInClientRects(rects, sceneRect, 69, 60), false);
});

test('clearCanvasOcclusions clears projected paint only and tolerates missing context', () => {
  const calls = [];
  const ctx = { clearRect: (...args) => calls.push(args) };
  assert.equal(runtime.clearCanvasOcclusions(ctx, [
    { left: 0, top: 0, width: 10, height: 20 },
    { left: 5, top: 6, width: 0, height: 7 },
  ]), 1);
  assert.deepEqual(calls, [[0, 0, 10, 20]]);
  assert.equal(runtime.clearCanvasOcclusions(null, [{ left: 0, top: 0, width: 1, height: 1 }]), 0);
});

test('clearCanvasOcclusions applies the backing-store scale before clearing CSS-pixel regions', () => {
  const operations = [];
  const ctx = {
    save: () => operations.push(['save']),
    restore: () => operations.push(['restore']),
    setTransform: (...args) => operations.push(['setTransform', ...args]),
    clearRect: (...args) => operations.push(['clearRect', ...args]),
  };

  assert.equal(runtime.clearCanvasOcclusions(ctx, [
    { left: 3, top: 4, width: 5, height: 6 },
  ], 2), 1);
  assert.deepEqual(operations, [
    ['save'],
    ['setTransform', 2, 0, 0, 2, 0, 0],
    ['clearRect', 3, 4, 5, 6],
    ['restore'],
  ]);
});
