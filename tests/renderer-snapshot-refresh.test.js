'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotRefresh } = require('../renderer/shell/renderer-snapshot-refresh');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('opening a healthy ChatGPT picker refreshes discovery without changing selection', async (t) => {
  const state = { backend: { phase: 'ready' }, auth: { authenticated: true },
    preferredEngineType: 'chatgpt', selectedModel: 'gpt-5.6-sol',
    modelList: { engine_type: 'chatgpt', available: true, data: [{ id: 'gpt-5.6-sol' }] } };
  let reads = 0;
  const refresher = createSnapshotRefresh({ state, getShell: () => ({
    engines: { getSettings: async () => ({ preferredEngineType: 'chatgpt' }) },
    status: { get: async () => ({ model: 'gpt-5.6-sol' }) },
    models: { list: async () => { reads += 1; return { engine_type: 'chatgpt',
      data: [{ id: 'gpt-6.1-sol' }], available: true }; } },
  }) });
  t.after(() => refresher.dispose());
  assert.equal(await refresher.refreshModelsIfUnavailable(), true);
  assert.equal(reads, 1);
  assert.equal(state.modelList.data[0].id, 'gpt-6.1-sol');
  assert.equal(state.selectedModel, 'gpt-5.6-sol');
});

test('runtime-only terminal refresh skips the model catalog', async () => {
  let modelCalls = 0;
  let statsCalls = 0;
  const catalogUpdates = [];
  const state = {
    backend: { phase: 'ready' },
    auth: { authenticated: true },
    ui: { activeView: 'chat' },
  };
  const refresher = createSnapshotRefresh({
    state,
    onModelsUpdated: (models) => { catalogUpdates.push(models); },
    getShell: () => ({
      engines: { getSettings: async () => ({ preferredEngineType: 'ollama' }) },
      status: { get: async () => ({ model: 'ornith:9b' }) },
      models: { list: async () => { modelCalls += 1; return { data: [] }; } },
      system: { getStats: async () => { statsCalls += 1; return { memory: 1 }; } },
    }),
  });

  await refresher.refreshSnapshots({ includeModels: false });
  assert.equal(modelCalls, 0);
  assert.equal(catalogUpdates.length, 0);
  assert.equal(state.status.model, 'ornith:9b');
  assert.equal(statsCalls, 0);

  await refresher.refreshSnapshots();
  assert.equal(modelCalls, 1);
  assert.equal(catalogUpdates.length, 1);
  assert.deepEqual(catalogUpdates[0], { data: [] });
});

test('model catalog consumer failure does not block rendering', async () => {
  let rendered = 0;
  const state = {
    backend: { phase: 'ready' },
    auth: { authenticated: true },
  };
  const refresher = createSnapshotRefresh({
    state,
    onModelsUpdated() { throw new Error('consumer failed'); },
    render() { rendered += 1; },
    getShell: () => ({
      engines: { getSettings: async () => ({ preferredEngineType: 'ollama' }) },
      status: { get: async () => ({ model: 'qwen3.8:27b-q3-k-s' }) },
      models: { list: async () => ({ data: [{ id: 'qwen3.8:27b-q3-k-s' }] }) },
      system: { getStats: async () => { throw new Error('must not be called'); } },
    }),
  });

  await refresher.refreshSnapshots();

  assert.equal(rendered, 1);
});

// A failed read used to notify anyway, and the consumer answers by force-refetching
// the inline catalog -- so every timed-out models.list manufactured a second one.
// The distinction is "did the call throw", not "is the value falsy".
test('a thrown model-catalog read leaves the list null and notifies no consumer', async () => {
  const catalogUpdates = [];
  const state = { backend: { phase: 'ready' }, auth: { authenticated: true } };
  const refresher = createSnapshotRefresh({
    state,
    onModelsUpdated: (models) => { catalogUpdates.push(models); },
    getShell: () => ({
      engines: { getSettings: async () => ({ preferredEngineType: 'ollama' }) },
      status: { get: async () => ({ model: 'ornith:9b' }) },
      models: { list: async () => { throw new Error('sidecar models.list timed out'); } },
      system: { getStats: async () => ({ memory: 1 }) },
    }),
  });

  await refresher.refreshSnapshots();

  assert.equal(state.modelList, null);
  assert.equal(catalogUpdates.length, 0);
});

test('a successful model-catalog read still notifies when it returns null', async () => {
  const catalogUpdates = [];
  const state = { backend: { phase: 'ready' }, auth: { authenticated: true } };
  const refresher = createSnapshotRefresh({
    state,
    onModelsUpdated: (models) => { catalogUpdates.push(models); },
    getShell: () => ({
      engines: { getSettings: async () => ({ preferredEngineType: 'ollama' }) },
      status: { get: async () => ({ model: 'ornith:9b' }) },
      models: { list: async () => null },
      system: { getStats: async () => ({ memory: 1 }) },
    }),
  });

  await refresher.refreshSnapshots();

  assert.equal(state.modelList, null);
  assert.deepEqual(catalogUpdates, [null]);
});

test('runtime poll renders only when the settings or status snapshot changes', async () => {
  let rendered = 0;
  let settings = { preferredEngineType: 'ollama', localEngines: { ollama: {} } };
  let status = { model: 'qwen3.8:27b-q3-k-s', ready: true };
  let statsCalls = 0;
  const state = {
    backend: { phase: 'ready' },
    auth: { authenticated: true },
  };
  const refresher = createSnapshotRefresh({
    state,
    render() { rendered += 1; },
    getShell: () => ({
      engines: { getSettings: async () => settings },
      status: { get: async () => status },
      models: { list: async () => [] },
      system: { getStats: async () => { statsCalls += 1; return {}; } },
    }),
  });

  await refresher.refreshSnapshots({ includeModels: false });
  assert.equal(rendered, 1, 'the first snapshot pair renders');

  await refresher.refreshSnapshots({ includeModels: false });
  assert.equal(rendered, 1, 'an unchanged snapshot pair skips rendering');

  status = { ...status, ready: false };
  await refresher.refreshSnapshots({ includeModels: false });
  assert.equal(rendered, 2, 'a changed backend-status snapshot renders');

  settings = { ...settings, preferredEngineType: 'vllm' };
  await refresher.refreshSnapshots({ includeModels: false });
  assert.equal(rendered, 3, 'a changed engine-settings snapshot renders');
  assert.equal(statsCalls, 0, 'the poll never invokes system.getStats');
});

test('an older concurrent snapshot refresh cannot overwrite a newer completed refresh', async () => {
  const settingsRequests = [];
  const statusRequests = [];
  let rendered = 0;
  const state = {
    backend: { phase: 'ready' },
    auth: { authenticated: true },
  };
  const refresher = createSnapshotRefresh({
    state,
    render() { rendered += 1; },
    getShell: () => ({
      engines: { getSettings() {
        const request = deferred();
        settingsRequests.push(request);
        return request.promise;
      } },
      status: { get() {
        const request = deferred();
        statusRequests.push(request);
        return request.promise;
      } },
    }),
  });

  const older = refresher.refreshSnapshots({ includeModels: false });
  const newer = refresher.refreshSnapshots({ includeModels: false });
  settingsRequests[1].resolve({ preferredEngineType: 'newer' });
  await Promise.resolve();
  statusRequests[0].resolve({ model: 'newer-model' });
  await newer;
  settingsRequests[0].resolve({ preferredEngineType: 'older' });
  await older;

  assert.equal(statusRequests.length, 1);
  assert.equal(state.preferredEngineType, 'newer');
  assert.deepEqual(state.status, { model: 'newer-model' });
  assert.equal(rendered, 1);
});

// Split view gate Â§D side finding (2026-09-26): after a relaunch the one
// model-inclusive refresh per ready transition read "Managed sidecar is not
// ready yet." and nothing re-read it (the 15 s poller skips models), so both
// pickers listed only Default for 10+ minutes while models.list() had 14.
function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(fn, delay) { const timer = { fn, delay, cleared: false }; pending.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    async fireNext() {
      const timer = pending.find((entry) => !entry.cleared && !entry.fired);
      if (!timer) return null;
      timer.fired = true;
      timer.fn();
      for (let i = 0; i < 50; i += 1) await Promise.resolve();
      return timer.delay;
    },
    live() { return pending.filter((entry) => !entry.cleared && !entry.fired); },
  };
}

function sidecarShell(listResults) {
  const calls = { list: 0 };
  return {
    calls,
    shell: {
      engines: { getSettings: async () => ({ preferredEngineType: 'ollama' }) },
      status: { get: async () => ({ model: 'qwen3.5:4b' }) },
      models: { list: async () => { calls.list += 1; return listResults.length > 1 ? listResults.shift() : listResults[0]; } },
    },
  };
}

const NOT_READY = { available: false, reason: 'Managed sidecar is not ready yet.', data: [] };
const READY = { available: true, data: [{ id: 'qwen3.5:4b' }, { id: 'ornith:9b' }] };

test('an unavailable catalog re-reads on a backoff until the sidecar is ready, then renders in full once', async () => {
  const timers = fakeTimers();
  const { shell, calls } = sidecarShell([NOT_READY, NOT_READY, READY]);
  const state = { backend: { phase: 'ready' }, auth: { authenticated: true } };
  let renders = 0;
  let fullRenders = 0;
  const refresher = createSnapshotRefresh({
    state, getShell: () => shell, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    render() { renders += 1; }, onModelCatalogRecovered() { fullRenders += 1; },
  });

  await refresher.refreshSnapshots();
  assert.equal(state.modelList.available, false);
  assert.equal(timers.live().length, 1, 'one retry is scheduled, not a loop');
  assert.equal(await timers.fireNext(), 2000);
  assert.equal(calls.list, 2);
  assert.equal(state.modelList.available, false);
  assert.equal(await timers.fireNext(), 4000, 'the delay backs off');
  assert.equal(calls.list, 3);
  assert.deepEqual(state.modelList, READY, 'the list refreshed once the sidecar was ready');
  assert.equal(fullRenders, 1, 'the recovery renders in full (both panes rebuild their model carriers)');
  assert.equal(renders, 2, 'the unavailable reads rendered as before');
  assert.equal(timers.live().length, 0, 'no retry once the list is available');
  refresher.dispose();
});

test('the catalog retry is bounded and the 15 s runtime poll never reads models', async () => {
  const timers = fakeTimers();
  const { shell, calls } = sidecarShell([NOT_READY]);
  const state = { backend: { phase: 'ready' }, auth: { authenticated: true } };
  const refresher = createSnapshotRefresh({ state, getShell: () => shell, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await refresher.refreshSnapshots({ includeModels: false });
  assert.equal(calls.list, 0);
  assert.equal(timers.live().length, 0, 'a runtime-only poll schedules nothing');
  await refresher.refreshSnapshots();
  let fired = 0;
  while (await timers.fireNext() !== null) fired += 1;
  assert.equal(fired, 14, 'fourteen retries (~10 min) then it stops');
  assert.equal(calls.list, 15);
  refresher.dispose();
});

test('a picker open re-reads an unavailable list at once and skips an available one', async () => {
  const timers = fakeTimers();
  const { shell, calls } = sidecarShell([NOT_READY, READY]);
  const state = { backend: { phase: 'ready' }, auth: { authenticated: true } };
  let fullRenders = 0;
  const refresher = createSnapshotRefresh({
    state, getShell: () => shell, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    onModelCatalogRecovered() { fullRenders += 1; },
  });
  await refresher.refreshSnapshots();
  const retry = timers.live()[0];
  assert.equal(await refresher.refreshModelsIfUnavailable(), true);
  assert.equal(calls.list, 2);
  assert.equal(retry.cleared, true, 'the pending backoff is replaced by the read');
  assert.deepEqual(state.modelList, READY);
  assert.equal(fullRenders, 1);
  assert.equal(await refresher.refreshModelsIfUnavailable(), false, 'an available list is not re-read');
  assert.equal(calls.list, 2);
  refresher.dispose();
});
