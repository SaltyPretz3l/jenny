'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createModelLibraryRuntimeActions,
} = require('../renderer/shell/model-library/model-library-runtime-actions');

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function harness(t, model) {
  const loads = [];
  const statuses = [];
  const windowRef = {
    setTimeout,
    clearTimeout,
    jennyShell: {
      models: {
        load: async (payload) => {
          loads.push(payload);
          return { status: 'ok' };
        },
      },
      offline: {
        updateSettings: async (payload) => payload,
      },
    },
  };
  const actions = createModelLibraryRuntimeActions({
    windowRef,
    state: { offline: {} },
    findModel: () => model,
    activeModel: () => '',
    refresh: async () => null,
    refreshModelPickers: async () => null,
    render: () => {},
    setStatusMessage: (message) => statuses.push(message),
    showToastMessage: () => {},
    appendClientLog: () => {},
  });
  t.after(() => actions.dispose());
  return { actions, loads, statuses };
}

test('Use starts a selected llama-server model through openai-compatible', async (t) => {
  const h = harness(t, {
    key: 'gemma4:12b',
    tag: 'gemma4:12b',
    engineType: 'ollama',
    selectedEngine: 'llama-server',
  });

  h.actions.handleUse('gemma4:12b');
  assert.equal(h.statuses[0], 'Starting llama-server for "gemma4:12b"…');
  await flush();

  assert.deepEqual(h.loads, [{ model: 'gemma4:12b', engine_type: 'openai-compatible' }]);
});

test('Use sends an explicit Ollama hint for an available selected Ollama engine', async (t) => {
  const h = harness(t, {
    key: 'gemma4:12b',
    tag: 'gemma4:12b',
    engineType: 'openai-compatible',
    selectedEngine: 'ollama',
    engines: { ollama: { available: true } },
  });

  h.actions.handleUse('gemma4:12b');
  await flush();

  assert.deepEqual(h.loads, [{ model: 'gemma4:12b', engine_type: 'ollama' }]);
});

test('Use preserves the legacy engineType payload when selectedEngine is absent', async (t) => {
  const h = harness(t, {
    key: 'hosted:model',
    tag: 'hosted:model',
    engineType: 'plugin_host',
  });

  h.actions.handleUse('hosted:model');
  await flush();

  assert.deepEqual(h.loads, [{ model: 'hosted:model', engine_type: 'plugin_host' }]);
});

// ELC-07: the 120 s / 40 s thresholds are soft notices. The controls stay
// locked while the backend call is still running; only a long hard backstop
// gives up on a call that never settles.
const LOAD_SOFT_MS = 120000;
const LOAD_HARD_MS = 1200000;
const UNLOAD_SOFT_MS = 40000;
const UNLOAD_HARD_MS = 120000;

function createClock() {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let dueId = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (dueId === null || timer.at < timers.get(dueId).at)) dueId = id;
        }
        if (dueId === null) break;
        const timer = timers.get(dueId);
        timers.delete(dueId);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

function clockHarness(t) {
  const clock = createClock();
  const loadCalls = [];
  const unloadCalls = [];
  const pending = [];
  const statuses = [];
  const toasts = [];
  const logs = [];
  const counts = { refresh: 0, pickers: 0, render: 0 };
  const call = (list) => {
    list.push(1);
    const d = deferred();
    pending.push(d);
    return d.promise;
  };
  const windowRef = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    jennyShell: {
      models: {
        load: () => call(loadCalls),
        unload: () => call(unloadCalls),
      },
      offline: { updateSettings: async (payload) => payload },
    },
  };
  const actions = createModelLibraryRuntimeActions({
    windowRef,
    state: { offline: {} },
    findModel: () => null,
    activeModel: () => 'model-a',
    refresh: async () => { counts.refresh += 1; },
    refreshModelPickers: async () => { counts.pickers += 1; },
    render: () => { counts.render += 1; },
    setStatusMessage: (message) => statuses.push(message),
    showToastMessage: (message) => toasts.push(message),
    appendClientLog: (level, event) => logs.push(event),
  });
  t.after(() => actions.dispose());
  return { actions, clock, loadCalls, unloadCalls, pending, statuses, toasts, logs, counts };
}

const STILL_SWITCHING = 'Still switching models.';

test('Use stays locked past the soft threshold and refuses a second action', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUse('model-a');
  h.clock.advance(LOAD_SOFT_MS);
  await flush();

  assert.equal(h.actions.activationState().status, 'running');
  assert.equal(h.statuses[h.statuses.length - 1], STILL_SWITCHING);
  const statusCount = h.statuses.length;
  h.actions.handleUse('model-b');
  h.actions.handleUnload('model-a');
  assert.equal(h.loadCalls.length, 1);
  assert.equal(h.unloadCalls.length, 0);
  assert.equal(h.statuses.length, statusCount + 2);
  assert.equal(h.statuses[h.statuses.length - 1], STILL_SWITCHING);
  assert.equal(h.clock.pending(), 1, 'only the hard backstop remains armed');
});

test('a load that succeeds after the soft notice runs the full success continuation', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUse('model-a');
  h.clock.advance(LOAD_SOFT_MS);
  await flush();
  h.pending[0].resolve({ status: 'ok' });
  await flush();

  assert.equal(h.actions.activationState().status, 'idle');
  assert.deepEqual(h.toasts, ['Now chatting with "model-a"']);
  assert.ok(h.logs.includes('models.loaded'));
  assert.equal(h.counts.refresh, 1);
  assert.equal(h.statuses[h.statuses.length - 1], 'Now chatting with "model-a".');
  assert.equal(h.clock.pending(), 0);
});

test('a load that fails after the soft notice runs the failure path', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUse('model-a');
  h.clock.advance(LOAD_SOFT_MS);
  await flush();
  h.pending[0].reject(new Error('engine exploded'));
  await flush();

  assert.equal(h.actions.activationState().status, 'idle');
  assert.equal(h.actions.activationState().message, 'engine exploded');
  assert.ok(h.logs.includes('model_library.activate_failed'));
  assert.deepEqual(h.toasts, []);
  assert.equal(h.clock.pending(), 0);
});

test('the hard backstop gives up on a load that never settles and unlocks', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUse('model-a');
  h.clock.advance(LOAD_SOFT_MS);
  await flush();
  h.clock.advance(LOAD_HARD_MS - LOAD_SOFT_MS);
  await flush();

  const state = h.actions.activationState();
  assert.equal(state.status, 'idle');
  assert.equal(state.message, 'The load request timed out. Model state will be re-checked.');
  assert.ok(h.logs.includes('model_library.activate_failed'));
  assert.equal(h.clock.pending(), 0);
  h.pending[0].resolve({ status: 'ok' });
  await flush();
  assert.deepEqual(h.toasts, []);
});

test('dispose clears both load timers', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUse('model-a');
  assert.equal(h.clock.pending(), 2);
  h.actions.dispose();
  assert.equal(h.clock.pending(), 0);
  const statusCount = h.statuses.length;
  h.clock.advance(LOAD_HARD_MS);
  await flush();
  assert.equal(h.statuses.length, statusCount);
});

test('Unload stays locked past the soft threshold and refuses a second action', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUnload('model-a');
  h.clock.advance(UNLOAD_SOFT_MS);
  await flush();

  assert.equal(h.actions.activationState().status, 'running');
  assert.equal(h.statuses[h.statuses.length - 1], STILL_SWITCHING);
  h.actions.handleUnload('model-a');
  h.actions.handleUse('model-b');
  assert.equal(h.unloadCalls.length, 1);
  assert.equal(h.loadCalls.length, 0);
  assert.equal(h.statuses[h.statuses.length - 1], STILL_SWITCHING);
  assert.equal(h.clock.pending(), 1);
});

test('an unload that succeeds after the soft notice runs the full success continuation', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUnload('model-a');
  h.clock.advance(UNLOAD_SOFT_MS);
  await flush();
  h.pending[0].resolve({ status: 'ok' });
  await flush();

  assert.equal(h.actions.activationState().status, 'idle');
  assert.deepEqual(h.toasts, ['Unloaded "model-a"']);
  assert.ok(h.logs.includes('models.unloaded'));
  assert.equal(h.counts.refresh, 1);
  assert.equal(h.clock.pending(), 0);
});

test('an unload that fails after the soft notice runs the failure path', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUnload('model-a');
  h.clock.advance(UNLOAD_SOFT_MS);
  await flush();
  h.pending[0].reject(new Error('evict failed'));
  await flush();

  assert.equal(h.actions.activationState().status, 'idle');
  assert.equal(h.actions.activationState().message, 'evict failed');
  assert.ok(h.logs.includes('model_library.unload_failed'));
  assert.deepEqual(h.toasts, []);
  assert.equal(h.clock.pending(), 0);
});

test('the hard backstop gives up on an unload that never settles and unlocks', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUnload('model-a');
  h.clock.advance(UNLOAD_SOFT_MS);
  await flush();
  h.clock.advance(UNLOAD_HARD_MS - UNLOAD_SOFT_MS);
  await flush();

  const state = h.actions.activationState();
  assert.equal(state.status, 'idle');
  assert.equal(state.message, 'The unload request timed out. Model state will be re-checked.');
  assert.ok(h.logs.includes('model_library.unload_failed'));
  assert.equal(h.clock.pending(), 0);
});

test('dispose clears both unload timers', async (t) => {
  const h = clockHarness(t);
  h.actions.handleUnload('model-a');
  assert.equal(h.clock.pending(), 2);
  h.actions.dispose();
  assert.equal(h.clock.pending(), 0);
});
