'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lod = require('../renderer/features/renderer-ide-map-lod.js');
const {
  createMapLod,
  tierForScale,
  nextTierForScale,
  computeViewportRect,
  REGIONS_DOTS_BOUNDARY,
  DOTS_TILES_BOUNDARY,
  HYSTERESIS_BAND,
  DEBOUNCE_MS,
} = lod;

// A minimal fake transform matching the shape the LOD orchestrator consumes:
// { subscribe(fn) -> unsub, getState() -> {scale,tx,ty}, clientToContent({x,y}) }.
function makeFakeTransform(initialScale) {
  let scale = Number.isFinite(initialScale) ? initialScale : 1;
  const subs = new Set();
  return {
    getState() {
      return { scale, tx: 0, ty: 0 };
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    // test driver: change scale and notify subscribers (like an rAF commit)
    commit(nextScale, reason) {
      scale = nextScale;
      for (const fn of subs) fn({ scale, tx: 0, ty: 0, reason: reason || 'test' });
    },
    subscriberCount() {
      return subs.size;
    },
    // content = (client - offset) / scale, offset fixed at 0 for these tests
    clientToContent(p) {
      return { x: p.x / scale, y: p.y / scale };
    },
  };
}

// Manually-flushed fake setTimeout/clearTimeout, for exercising the ~120ms
// viewport-rect debounce deterministically without real timers.
function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId;
      nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pendingCount() {
      return pending.size;
    },
    flush() {
      const fns = [...pending.values()].map((entry) => entry.fn);
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

function fakeView() {
  const tierCalls = [];
  const rectCalls = [];
  return {
    setTier(tier) { tierCalls.push(tier); },
    setViewportRect(rect) { rectCalls.push(rect); },
    tierCalls,
    rectCalls,
  };
}

function fakeViewportEl(rect) {
  return { getBoundingClientRect: () => rect };
}

// ── tierForScale (pure, no hysteresis) ───────────────────────────────────────

test('tierForScale: thresholds exported and correct', () => {
  assert.equal(REGIONS_DOTS_BOUNDARY, 0.35);
  assert.equal(DOTS_TILES_BOUNDARY, 1.0);
  assert.equal(HYSTERESIS_BAND, 0.03);
});

test('tierForScale: representative scales map to the right tier', () => {
  assert.equal(tierForScale(0.1), 'regions');
  assert.equal(tierForScale(0.34), 'regions');
  assert.equal(tierForScale(0.35), 'dots');
  assert.equal(tierForScale(0.6), 'dots');
  assert.equal(tierForScale(0.999), 'dots');
  assert.equal(tierForScale(1.0), 'tiles');
  assert.equal(tierForScale(3), 'tiles');
});

test('tierForScale: non-finite scale falls back to 1 (tiles)', () => {
  assert.equal(tierForScale(NaN), 'tiles');
  assert.equal(tierForScale(undefined), 'tiles');
});

// ── nextTierForScale (hysteresis-aware) ──────────────────────────────────────

test('nextTierForScale: sitting on the raw boundary does not flip away from the current tier', () => {
  // Currently 'dots'; scale wobbles right at the raw 0.35 boundary. Neither
  // direction has moved HYSTERESIS_BAND past it, so it stays 'dots'.
  assert.equal(nextTierForScale('dots', 0.35), 'dots');
  assert.equal(nextTierForScale('dots', 0.34), 'dots');
  assert.equal(nextTierForScale('dots', 0.36), 'dots');
  // Same for the dots/tiles boundary.
  assert.equal(nextTierForScale('dots', 1.0), 'dots');
  assert.equal(nextTierForScale('dots', 1.02), 'dots');
  assert.equal(nextTierForScale('tiles', 1.0), 'tiles');
  assert.equal(nextTierForScale('tiles', 0.98), 'tiles');
});

test('nextTierForScale: crossing past the hysteresis band flips exactly once', () => {
  // Upward crossings land exactly on the boundary-plus-band value.
  assert.equal(nextTierForScale('regions', 0.38), 'dots'); // 0.35 + 0.03
  assert.equal(nextTierForScale('regions', 0.379), 'regions');
  assert.equal(nextTierForScale('dots', 1.03), 'tiles'); // 1.0 + 0.03
  assert.equal(nextTierForScale('dots', 1.029), 'dots');
  // Downward crossings need to clear the band (strict <); values are kept
  // well clear of the boundary-minus-band float value to stay fp-safe.
  assert.equal(nextTierForScale('tiles', 0.9), 'dots'); // well under 1.0 - 0.03
  assert.equal(nextTierForScale('tiles', 0.971), 'tiles'); // just above 1.0 - 0.03
  assert.equal(nextTierForScale('dots', 0.3), 'regions'); // well under 0.35 - 0.03
  assert.equal(nextTierForScale('dots', 0.325), 'dots'); // just above 0.35 - 0.03
});

test('nextTierForScale: a single large jump cascades through an intermediate tier', () => {
  assert.equal(nextTierForScale('regions', 5), 'tiles');
  assert.equal(nextTierForScale('tiles', 0.01), 'regions');
});

test('nextTierForScale: an unknown/missing current tier falls back to the raw mapping', () => {
  assert.equal(nextTierForScale(null, 0.6), 'dots');
  assert.equal(nextTierForScale('bogus', 2), 'tiles');
});

// ── computeViewportRect ──────────────────────────────────────────────────────

test('computeViewportRect: derives {x,y,w,h} from viewportEl rect + transform.clientToContent', () => {
  const viewportEl = fakeViewportEl({ left: 0, top: 0, width: 800, height: 600 });
  const transform = makeFakeTransform(2); // scale 2 -> content is half of client
  const rect = computeViewportRect(viewportEl, transform);
  assert.deepEqual(rect, { x: 0, y: 0, w: 400, h: 300 });
});

test('computeViewportRect: null when viewportEl or transform is missing/incapable', () => {
  const viewportEl = fakeViewportEl({ left: 0, top: 0, width: 800, height: 600 });
  const transform = makeFakeTransform(1);
  assert.equal(computeViewportRect(null, transform), null);
  assert.equal(computeViewportRect(viewportEl, null), null);
  assert.equal(computeViewportRect(viewportEl, {}), null);
  assert.equal(computeViewportRect({}, transform), null);
});

// ── createMapLod: tier tracking ──────────────────────────────────────────────

test('createMapLod: applies the initial tier and schedules the initial viewport settle', () => {
  const transform = makeFakeTransform(1);
  const timers = makeFakeTimers();
  const view = fakeView();
  const viewportEl = fakeViewportEl({ left: 0, top: 0, width: 800, height: 600 });
  const controller = createMapLod({ transform, timers, view, viewportEl });

  assert.deepEqual(view.tierCalls, ['tiles']);
  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(view.rectCalls, []);
  timers.flush();
  assert.deepEqual(view.rectCalls, [{ x: 0, y: 0, w: 800, h: 600 }]);
  controller.dispose();
});

test('createMapLod: view.setTier and onLodChange fire only on a real tier crossing', () => {
  const transform = makeFakeTransform(0.6); // starts in 'dots'
  const view = fakeView();
  const calls = [];
  const controller = createMapLod({
    transform,
    view,
    onLodChange: (payload) => calls.push(payload.tier),
  });
  assert.deepEqual(view.tierCalls, ['dots']);

  // commit within the same band -> no tier call
  transform.commit(0.7);
  assert.deepEqual(view.tierCalls, ['dots']);
  assert.equal(calls.length, 0);

  // commit that wobbles right at the boundary -> hysteresis holds, no flip
  transform.commit(0.34);
  assert.deepEqual(view.tierCalls, ['dots']);
  assert.equal(calls.length, 0);

  // cross decisively into 'regions' -> exactly one emit
  transform.commit(0.1);
  assert.deepEqual(view.tierCalls, ['dots', 'regions']);
  assert.deepEqual(calls, ['regions']);

  // cross decisively into 'tiles' -> exactly one more emit
  transform.commit(2);
  assert.deepEqual(view.tierCalls, ['dots', 'regions', 'tiles']);
  assert.deepEqual(calls, ['regions', 'tiles']);

  controller.dispose();
});

test('createMapLod: onLodChange payload is exactly { tier }', () => {
  const transform = makeFakeTransform(0.6);
  const payloads = [];
  const controller = createMapLod({
    transform,
    onLodChange: (payload) => payloads.push(payload),
  });
  transform.commit(0.1);
  assert.deepEqual(payloads, [{ tier: 'regions' }]);
  controller.dispose();
});

// ── createMapLod: debounced viewport-rect settle ─────────────────────────────

test('createMapLod: viewport rect settles once ~120ms after the last commit in a flurry', () => {
  const transform = makeFakeTransform(1);
  const timers = makeFakeTimers();
  const viewportEl = fakeViewportEl({ left: 0, top: 0, width: 800, height: 600 });
  const view = fakeView();
  const controller = createMapLod({ transform, view, viewportEl, timers });

  // A flurry of commits before the debounce settles: each re-schedules, none
  // should push a rect yet.
  transform.commit(1.1);
  transform.commit(1.2);
  transform.commit(1.3);
  assert.deepEqual(view.rectCalls, []);
  assert.equal(timers.pendingCount(), 1, 'only the latest debounce timer is pending');

  timers.flush();
  assert.equal(view.rectCalls.length, 1, 'exactly one settle after the flurry');
  assert.deepEqual(view.rectCalls[0], { x: 0, y: 0, w: 800 / 1.3, h: 600 / 1.3 });

  controller.dispose();
});

test('createMapLod: uses the injected debounceMs to schedule the settle timer', () => {
  const transform = makeFakeTransform(1);
  let capturedMs = null;
  const timers = {
    setTimeout: (fn, ms) => { capturedMs = ms; return 1; },
    clearTimeout: () => {},
  };
  const controller = createMapLod({ transform, timers, debounceMs: 250 });
  transform.commit(1.5);
  assert.equal(capturedMs, 250);
  controller.dispose();
});

test('createMapLod: defaults to a 120ms debounce when debounceMs is not provided', () => {
  const transform = makeFakeTransform(1);
  let capturedMs = null;
  const timers = {
    setTimeout: (fn, ms) => { capturedMs = ms; return 1; },
    clearTimeout: () => {},
  };
  const controller = createMapLod({ transform, timers });
  transform.commit(1.5);
  assert.equal(capturedMs, DEBOUNCE_MS);
  assert.equal(DEBOUNCE_MS, 120);
  controller.dispose();
});

test('createMapLod: a tier crossing is applied immediately, not gated by the debounce', () => {
  const transform = makeFakeTransform(0.6);
  const timers = makeFakeTimers();
  const view = fakeView();
  const controller = createMapLod({ transform, view, timers });

  transform.commit(0.1); // crosses to 'regions'
  assert.deepEqual(view.tierCalls, ['dots', 'regions'], 'the crossing is applied synchronously after the initial tier');
  assert.equal(timers.pendingCount(), 1, 'the viewport-rect settle is still pending, separately');

  controller.dispose();
});

test('createMapLod: without a viewportEl, no rect is ever pushed (no crash)', () => {
  const transform = makeFakeTransform(1);
  const timers = makeFakeTimers();
  const view = fakeView();
  const controller = createMapLod({ transform, view, timers });
  transform.commit(1.5);
  timers.flush();
  assert.deepEqual(view.rectCalls, []);
  controller.dispose();
});

// ── createMapLod: dispose ────────────────────────────────────────────────────

test('createMapLod: dispose unsubscribes and cancels the pending debounce', () => {
  const transform = makeFakeTransform(0.6); // 'dots', clear of any boundary
  const timers = makeFakeTimers();
  const view = fakeView();
  const controller = createMapLod({ transform, view, timers });

  transform.commit(0.7); // still 'dots'; schedules a debounce, no tier call
  assert.equal(timers.pendingCount(), 1);
  assert.equal(transform.subscriberCount(), 1);

  controller.dispose();
  assert.equal(timers.pendingCount(), 0, 'pending debounce timer is cancelled');
  assert.equal(transform.subscriberCount(), 0, 'unsubscribed from transform');

  // Flushing after dispose must not push a rect or throw.
  timers.flush();
  assert.deepEqual(view.rectCalls, []);

  // Post-dispose commits are no-ops, even ones that WOULD have crossed a
  // tier boundary if the subscription were still live.
  transform.commit(3);
  assert.deepEqual(view.tierCalls, ['dots'], 'no additional tier call fires once disposed');

  // dispose is idempotent
  controller.dispose();
});

test('createMapLod: exposes threshold internals for tests', () => {
  const transform = makeFakeTransform(1);
  const controller = createMapLod({ transform, debounceMs: 90 });
  assert.deepEqual(controller._internals, {
    REGIONS_DOTS_BOUNDARY: 0.35,
    DOTS_TILES_BOUNDARY: 1.0,
    HYSTERESIS_BAND: 0.03,
    DEBOUNCE_MS: 90,
  });
  controller.dispose();
});

test('createMapLod: tolerates a missing view dep — the tier machine still runs', () => {
  const transform = makeFakeTransform(0.6);
  const timers = makeFakeTimers();
  const calls = [];
  const controller = createMapLod({ transform, timers, onLodChange: (payload) => calls.push(payload.tier) });
  transform.commit(0.1);
  timers.flush();
  assert.deepEqual(calls, ['regions'], 'the dots->regions crossing fires with no view wired');
  controller.dispose();
});

test('createMapLod: tolerates a missing onLodChange dep — the view is still driven', () => {
  const transform = makeFakeTransform(0.6);
  const timers = makeFakeTimers();
  const view = fakeView();
  const controller = createMapLod({ transform, timers, view });
  transform.commit(0.1);
  timers.flush();
  assert.deepEqual(view.tierCalls, ['dots', 'regions'], 'the initial tier and crossing reach the view with no onLodChange wired');
  controller.dispose();
});
