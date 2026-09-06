'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotRefresh } = require('../renderer/shell/renderer-snapshot-refresh');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

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
