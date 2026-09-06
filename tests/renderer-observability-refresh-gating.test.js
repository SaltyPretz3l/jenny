const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createObservabilityController } = require('../renderer/shell/renderer-observability-utils');

function makeSnapshot() {
  return {
    generated_at: '2026-08-25T12:00:00.000Z',
    tool_observability: { available: true, tools: {} },
    slow_operations: { available: true, count: 0, items: [] },
    trace_timing: { available: true, count: 0, recent: [] },
  };
}

function createTimers() {
  let nextId = 1;
  const pending = new Map();
  const delays = [];
  return {
    delays,
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      pending.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runAll() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      callbacks.forEach((callback) => callback());
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

function createHarness(t, { isVisible, initialNow = 10_000 } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="latency"></div>'
      + '<div id="slow"></div>'
      + '<div id="traces"></div>'
      + '</body>',
    { pretendToBeVisual: true }
  );
  const { window } = dom;
  const calls = [];
  const timers = createTimers();
  let currentNow = initialNow;
  window.jennyShell = {
    diagnostics: {
      async getJennyStatus(options) {
        calls.push(options);
        return makeSnapshot();
      },
    },
  };
  const callbacks = typeof isVisible === 'function' ? { isVisible } : {};
  const controller = createObservabilityController({
    window,
    dom: {
      toolLatencyTable: window.document.getElementById('latency'),
      slowOperationsList: window.document.getElementById('slow'),
      recentTracesList: window.document.getElementById('traces'),
    },
    callbacks,
    now: () => currentNow,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  t.after(() => controller.dispose());
  return {
    calls,
    controller,
    timers,
    setNow(value) { currentNow = value; },
  };
}

test('notifyTurnSettled skips and clears refresh work while observability is hidden', (t) => {
  const harness = createHarness(t, { isVisible: () => false });

  assert.equal(harness.controller.notifyTurnSettled(), undefined);
  harness.timers.runAll();

  assert.equal(harness.timers.pendingCount, 0);
  assert.equal(harness.calls.length, 0);
});

test('notifyTurnSettled clears a pending refresh when observability becomes hidden', (t) => {
  let visible = true;
  const harness = createHarness(t, { isVisible: () => visible });

  harness.controller.notifyTurnSettled();
  visible = false;
  harness.controller.notifyTurnSettled();
  harness.timers.runAll();

  assert.equal(harness.timers.pendingCount, 0);
  assert.equal(harness.calls.length, 0);
});

test('scheduled turn refresh rechecks visibility before fetching', (t) => {
  let visible = true;
  const harness = createHarness(t, { isVisible: () => visible });

  harness.controller.notifyTurnSettled();
  visible = false;
  harness.timers.runAll();

  assert.equal(harness.calls.length, 0);
});

test('notifyTurnSettled coalesces visible turn settlements into one fetch', (t) => {
  const harness = createHarness(t, { isVisible: () => true });

  assert.equal(harness.controller.notifyTurnSettled(), undefined);
  assert.equal(harness.controller.notifyTurnSettled(), undefined);
  assert.equal(harness.timers.pendingCount, 1);

  harness.timers.runAll();

  assert.equal(harness.calls.length, 1);
});

test('notifyTurnSettled throttles from the last successful refresh', async (t) => {
  const harness = createHarness(t, { isVisible: () => true, initialNow: 10_000 });

  await harness.controller.refresh();
  harness.controller.notifyTurnSettled();
  assert.ok(harness.timers.delays[0] > 0);

  harness.timers.runAll();
  await Promise.resolve();
  harness.setNow(14_001);
  harness.controller.notifyTurnSettled();

  assert.equal(harness.timers.delays[1], 0);
});

test('dispose cancels a pending turn-settled refresh', (t) => {
  const harness = createHarness(t, { isVisible: () => true });

  harness.controller.notifyTurnSettled();
  harness.controller.dispose();
  harness.timers.runAll();

  assert.equal(harness.timers.pendingCount, 0);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.controller.notifyTurnSettled(), undefined);
  assert.equal(harness.timers.pendingCount, 0);
});

test('direct refresh remains available while hidden and excludes the harness facet', async (t) => {
  const harness = createHarness(t, { isVisible: () => false });

  const snapshot = await harness.controller.refresh({ silent: false });

  assert.ok(snapshot);
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.calls[0], {
    recentLogLimit: 50,
    includeHarness: false,
  });
});

test('notifyTurnSettled defaults to visible when no visibility callback is wired', (t) => {
  const harness = createHarness(t);

  harness.controller.notifyTurnSettled();
  harness.timers.runAll();

  assert.equal(harness.calls.length, 1);
});
