// Behaviour suite for the frame helpers hoisted into the shared surface-effect
// runtime: getNow, requestFrame, cancelFrame and scheduleCanvasReady.

const test = require('node:test');
const assert = require('node:assert/strict');

const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');

function withGlobals(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: overrides[key], configurable: true, writable: true });
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key]) { Object.defineProperty(globalThis, key, saved[key]); } else { delete globalThis[key]; }
    }
  }
}

function makeCanvas() {
  const classes = new Set();
  return { classes, classList: { add: (name) => classes.add(name) } };
}

function makeFrameQueue() {
  const callbacks = [];
  return {
    callbacks,
    requestFrame(cb) { callbacks.push(cb); return callbacks.length; },
    flush() { callbacks.splice(0).forEach((cb) => cb()); },
  };
}

test('getNow prefers performance.now and falls back to Date.now', () => {
  withGlobals({ performance: { now: () => 42.5 } }, () => {
    assert.equal(runtime.getNow(), 42.5);
  });
  withGlobals({ performance: undefined }, () => {
    const before = Date.now();
    const value = runtime.getNow();
    assert.ok(value >= before && value <= Date.now());
  });
});

test('requestFrame delegates to requestAnimationFrame, or returns 0 without it', () => {
  const seen = [];
  withGlobals({ requestAnimationFrame: (cb) => { seen.push(cb); return 7; } }, () => {
    const cb = () => {};
    assert.equal(runtime.requestFrame(cb), 7);
    assert.deepEqual(seen, [cb]);
  });
  withGlobals({ requestAnimationFrame: undefined }, () => {
    assert.equal(runtime.requestFrame(() => {}), 0);
  });
});

test('cancelFrame cancels only truthy handles and tolerates a missing cancelAnimationFrame', () => {
  const cancelled = [];
  withGlobals({ cancelAnimationFrame: (handle) => cancelled.push(handle) }, () => {
    runtime.cancelFrame(0);
    runtime.cancelFrame(undefined);
    runtime.cancelFrame(9);
  });
  assert.deepEqual(cancelled, [9]);
  withGlobals({ cancelAnimationFrame: undefined }, () => {
    assert.doesNotThrow(() => runtime.cancelFrame(9));
  });
});

test('scheduleCanvasReady: happy path marks the canvas ready and clears the handle', () => {
  const queue = makeFrameQueue();
  const canvas = makeCanvas();
  const entry = { canvas, readyShown: false, markReadyHandle: 0 };
  runtime.scheduleCanvasReady(entry, { blocked: false, isLive: () => true, requestFrame: queue.requestFrame });
  assert.equal(queue.callbacks.length, 1);
  assert.equal(entry.markReadyHandle, 1, 'pending handle is recorded');
  queue.flush();
  assert.equal(entry.markReadyHandle, 0);
  assert.equal(entry.readyShown, true);
  assert.ok(canvas.classes.has('surface-canvas-ready'));
});

test('scheduleCanvasReady: blocked, canvas-less, already-ready and already-pending entries request no frame', () => {
  const queue = makeFrameQueue();
  const options = { blocked: false, isLive: () => true, requestFrame: queue.requestFrame };
  runtime.scheduleCanvasReady({ canvas: makeCanvas(), readyShown: false, markReadyHandle: 0 }, { ...options, blocked: true });
  runtime.scheduleCanvasReady({ canvas: null, readyShown: false, markReadyHandle: 0 }, options);
  runtime.scheduleCanvasReady({ canvas: makeCanvas(), readyShown: true, markReadyHandle: 0 }, options);
  const pending = { canvas: makeCanvas(), readyShown: false, markReadyHandle: 5 };
  runtime.scheduleCanvasReady(pending, options);
  assert.equal(queue.callbacks.length, 0);
  assert.equal(pending.markReadyHandle, 5, 'existing pending handle is left alone');
});

test('scheduleCanvasReady: a canvas swapped before the frame fires is not marked ready', () => {
  const queue = makeFrameQueue();
  const first = makeCanvas();
  const entry = { canvas: first, readyShown: false, markReadyHandle: 0 };
  runtime.scheduleCanvasReady(entry, { blocked: false, isLive: () => true, requestFrame: queue.requestFrame });
  entry.canvas = makeCanvas();
  queue.flush();
  assert.equal(entry.markReadyHandle, 0);
  assert.equal(entry.readyShown, false);
  assert.equal(first.classes.size, 0);
  assert.equal(entry.canvas.classes.size, 0);
});

test('scheduleCanvasReady: a controller disposed before the frame fires does not mark ready', () => {
  const queue = makeFrameQueue();
  let live = true;
  const canvas = makeCanvas();
  const entry = { canvas, readyShown: false, markReadyHandle: 0 };
  runtime.scheduleCanvasReady(entry, { blocked: false, isLive: () => live, requestFrame: queue.requestFrame });
  live = false;
  queue.flush();
  assert.equal(entry.markReadyHandle, 0);
  assert.equal(entry.readyShown, false);
  assert.equal(canvas.classes.size, 0);
});

test('scheduleCanvasReady: defaults to the runtime requestFrame when none is supplied', () => {
  const queue = makeFrameQueue();
  const canvas = makeCanvas();
  const entry = { canvas, readyShown: false, markReadyHandle: 0 };
  withGlobals({ requestAnimationFrame: queue.requestFrame }, () => {
    runtime.scheduleCanvasReady(entry, { blocked: false, isLive: () => true });
  });
  assert.equal(queue.callbacks.length, 1);
  queue.flush();
  assert.equal(entry.readyShown, true);
  assert.ok(canvas.classes.has('surface-canvas-ready'));
});
