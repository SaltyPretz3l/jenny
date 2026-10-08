'use strict';

// services/main/catalog-ipc-handlers.js: Settings › Tools "Search by meaning"
// IPC. The picker validates before persisting; settings patches are bounded.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerCatalogIpcHandlers, settingsPatch } = require('../services/main/catalog-ipc-handlers');

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) { handlers.set(channel, handler); },
    invoke(channel, payload) { return handlers.get(channel)({ sender: {} }, payload); },
  };
}

function harness({ pick = 'C:\\models\\embeddinggemma.gguf', verdict = { ok: true }, enabled = true } = {}) {
  const ipc = fakeIpcMain();
  const updates = [];
  let embedding = { enabled: true, modelPath: '', profileId: '', device: 'cpu', dims: 0 };
  const calls = [];
  const service = {
    async getDetailedStatus() { return { state: 'caught_up', roots: [] }; },
    async purge(options) { calls.push(['purge', options]); return { ok: true }; },
    notifyChanged(reason) { calls.push(['notify', reason]); },
  };
  const channels = registerCatalogIpcHandlers(ipc, {
    enabled,
    getCatalogService: () => service,
    shellConfigService: {
      getLocalEngines: () => ({ embedding }),
      updateEmbeddingSettings(patch) { updates.push(patch); embedding = { ...embedding, ...patch }; return embedding; },
    },
    dialog: { showOpenDialog: async () => (pick ? { canceled: false, filePaths: [pick] } : { canceled: true, filePaths: [] }) },
    validateModel: () => verdict,
  });
  return { calls, channels, ipc, updates };
}

test('no channels are registered while the flag is off', () => {
  const { channels, ipc } = harness({ enabled: false });
  assert.deepEqual(channels, []);
  assert.equal(ipc.handlers.size, 0);
});

test('getStatus returns the persisted choice with the detailed status', async () => {
  const { ipc } = harness();
  const result = await ipc.invoke('catalog:get-status');
  assert.equal(result.ok, true);
  assert.equal(result.settings.device, 'cpu');
  assert.equal(result.status.state, 'caught_up');
  const gemma = result.profiles.find((profile) => profile.id === 'embeddinggemma');
  assert.deepEqual(gemma, { id: 'embeddinggemma', label: 'EmbeddingGemma', dims: [768, 512, 256, 128] });
  assert.ok(result.profiles.some((profile) => profile.id === 'none'));
});

test('chooseModel validates the picked file before persisting it', async () => {
  const accepted = harness();
  const ok = await accepted.ipc.invoke('catalog:choose-model');
  assert.equal(ok.ok, true);
  assert.deepEqual(accepted.updates, [{ modelPath: 'C:\\models\\embeddinggemma.gguf', profileId: '', dims: 0 }]);

  const refused = harness({ verdict: { ok: false, reason: 'not_embedding_model' } });
  assert.deepEqual(await refused.ipc.invoke('catalog:choose-model'), { ok: false, reason: 'not_embedding_model' });
  assert.deepEqual(refused.updates, []);

  const canceled = harness({ pick: '' });
  assert.deepEqual(await canceled.ipc.invoke('catalog:choose-model'), { ok: false, reason: 'canceled' });
});

test('updateSettings forwards only bounded known fields', async () => {
  assert.deepEqual(settingsPatch({ enabled: false, device: 'gpu', dims: 256, profileId: 'none', modelPath: 'C:\\x.gguf', extra: 1 }),
    { enabled: false, device: 'gpu', profileId: 'none', dims: 256 });
  assert.deepEqual(settingsPatch({ device: 'tpu', dims: -1 }), {});
  const { ipc, updates } = harness();
  assert.deepEqual(await ipc.invoke('catalog:update-settings', { device: 'tpu' }), { ok: false, reason: 'invalid_settings' });
  assert.equal((await ipc.invoke('catalog:update-settings', { device: 'gpu' })).settings.device, 'gpu');
  assert.deepEqual(updates, [{ device: 'gpu' }], 'the model path is only set through the validated picker');
});

test('rebuild, delete and retry reach the service', async () => {
  const { calls, ipc } = harness();
  await ipc.invoke('catalog:rebuild');
  await ipc.invoke('catalog:delete-catalog');
  await ipc.invoke('catalog:retry');
  assert.deepEqual(calls, [['purge', { rebuild: true }], ['purge', { rebuild: false }], ['notify', 'settings']]);
});
