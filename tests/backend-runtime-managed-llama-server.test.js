'use strict';

// Managed llama-server engine switching in loadModel: unload Ollama first,
// launch through the manager, persist the selection only after the sidecar
// accepted the engine, stop the server when another engine takes over.
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadModel } = require('../services/backend/backend-runtime');

function makeManagedLlamaLoadService({ managerState = 'ready', managerError = '', ensureState = 'ready',
  enabled = true, perModelEngine = 'llama-server', unloadError = null, fallbackAfterInit = null,
  lastUsedTag = 'ornith-9b', stopError = '' } = {}) {
  const calls = [], logs = [];
  const entry = { engine: perModelEngine, modelPath: 'G:\\models\\ornith.gguf', tag: '', mtp: { mode: 'mtp' } };
  const managed = { enabled, profileId: 'balanced', lastUsedTag, perModel: { 'ornith-9b': entry } };
  const manager = {
    getStatus: () => ({ state: managerState, lastError: managerError }),
    async ensureRunning(spec) { calls.push(['ensureRunning', spec]); return { state: ensureState, lastError: 'launch failed' }; },
    async stop() { calls.push(['stop']); return { state: 'stopped', lastError: stopError }; },
  };
  const service = {
    calls, logs, currentEngineType: 'ollama', currentModel: 'old:latest', _lastEngineFallback: null,
    providerIntegrationRegistry: null,
    options: { getLlamaServerManager: () => manager },
    sidecarClient: { async modelsUnload(model) { calls.push(['modelsUnload', model]); if (unloadError) throw unloadError; } },
    configService: { getState: () => ({ preferredEngineType: 'openai-compatible' }), getLocalEngines: () => ({ openaiCompatible: { managed } }), updatePreferredEngineType(type) { calls.push(['updatePreferredEngineType', type]); }, updateManagedLlamaServer(patch) { calls.push(['updateManagedLlamaServer', patch]); } },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    async _initializeManagedSidecar(options) { calls.push(['initialize', options]); service._lastEngineFallback = fallbackAfterInit; },
    async refreshStatusSnapshot() { return null; },
  };
  return service;
}
test('managed llama-server load unloads Ollama, starts the server, and persists the selection after initialization', async () => {
  const service = makeManagedLlamaLoadService();
  await loadModel(service, { model: 'ornith:9b', engine_type: 'openai-compatible' });
  assert.deepEqual(service.calls, [
    ['modelsUnload', 'old:latest'],
    ['ensureRunning', { modelTag: 'ornith:9b', modelPath: 'G:\\models\\ornith.gguf', profileId: 'balanced', mtp: { mode: 'mtp' } }],
    ['initialize', { reason: 'model_load', requestedModel: 'ornith:9b', requestedEngineType: 'openai-compatible' }],
    ['updatePreferredEngineType', 'openai-compatible'],
    ['updateManagedLlamaServer', {
      lastUsedTag: 'ornith-9b',
      perModel: { 'ornith-9b': { engine: 'llama-server', modelPath: 'G:\\models\\ornith.gguf', tag: 'ornith:9b', mtp: { mode: 'mtp' } } },
    }],
  ]);
});
test('managed llama-server load persists nothing when the sidecar falls back after the server came up', async () => {
  const service = makeManagedLlamaLoadService({ fallbackAfterInit: { reason: 'sidecar refused', requested_engine: 'openai-compatible' } });
  await assert.rejects(loadModel(service, { model: 'ornith:9b', engine_type: 'openai-compatible' }), /Could not load openai-compatible engine/);
  assert.deepEqual(service.calls.map(([name]) => name), ['modelsUnload', 'ensureRunning', 'initialize']);
});
test('managed llama-server load continues after generic unload failure but stops on launch failure', async () => {
  const service = makeManagedLlamaLoadService({ ensureState: 'crashed', unloadError: new Error('unload failed') });
  await assert.rejects(
    loadModel(service, { model: 'ornith:9b', engine_type: 'openai-compatible' }),
    /Could not start llama-server for "ornith:9b": launch failed/
  );
  assert.deepEqual(service.calls.map(([name]) => name), ['modelsUnload', 'ensureRunning']);
  assert.equal(service.logs.some(({ event }) => event === 'backend.engine_switch_unload_failed'), true);
});

// A timeout leaves GPU residency unknown; a definitive generic rejection does not.
test('managed llama-server load stops after a timed-out unload', async () => {
  const unloadError = Object.assign(new Error('unload timed out'), { category: 'timeout' });
  const service = makeManagedLlamaLoadService({ unloadError });
  await assert.rejects(
    loadModel(service, { model: 'ornith:9b', engine_type: 'openai-compatible' }),
    /could not be confirmed evicted.*aborted so the GPU is not double-loaded/i
  );
  assert.deepEqual(service.calls.map(([name]) => name), ['modelsUnload']);
  assert.equal(service.logs.some(({ event }) => event === 'backend.engine_switch_unload_failed'), true);
});

test('non-managed openai-compatible loads never launch the managed server and stop a live one', async () => {
  for (const options of [{ perModelEngine: 'ollama' }, { enabled: false }]) {
    const idle = makeManagedLlamaLoadService({ ...options, managerState: 'stopped', lastUsedTag: '' });
    await loadModel(idle, { model: 'ornith:9b', engine_type: 'openai-compatible' });
    assert.deepEqual(idle.calls.map(([name]) => name), ['initialize']);
    // A user-run endpoint takes the GPU over from a running managed server.
    const live = makeManagedLlamaLoadService(options);
    await loadModel(live, { model: 'ornith:9b', engine_type: 'openai-compatible' });
    assert.deepEqual(live.calls, [['stop'], ['initialize', { reason: 'model_load', requestedModel: 'ornith:9b', requestedEngineType: 'openai-compatible' }], ['updateManagedLlamaServer', { lastUsedTag: '' }]]);
  }
});

test('switching to Ollama stops an active llama-server first, then forgets the autostart target and pins ollama', async () => {
  const active = makeManagedLlamaLoadService();
  await loadModel(active, { model: 'ornith:9b', engine_type: 'ollama' });
  assert.deepEqual(active.calls.map(([name]) => name), ['stop', 'initialize', 'updateManagedLlamaServer', 'updatePreferredEngineType']);
  assert.deepEqual(active.calls[2], ['updateManagedLlamaServer', { lastUsedTag: '' }]);
  assert.deepEqual(active.calls[3], ['updatePreferredEngineType', 'ollama']);
  assert.equal(active.logs.some(({ event }) => event === 'backend.engine_switch_stop_llama_server'), true);
  // A server that is already down still gets the pin moved off openai-compatible;
  // with no autostart target persisted there is nothing to forget.
  const stopped = makeManagedLlamaLoadService({ managerState: 'stopped', lastUsedTag: '' });
  await loadModel(stopped, { model: 'ornith:9b', engine_type: 'ollama' });
  assert.deepEqual(stopped.calls.map(([name]) => name), ['initialize', 'updatePreferredEngineType']);
  // A parked launch failure is cleared by a stop even though the state is 'stopped'.
  const failed = makeManagedLlamaLoadService({ managerState: 'stopped', managerError: 'llama_server_binary_not_found' });
  await loadModel(failed, { model: 'ornith:9b', engine_type: 'ollama' });
  assert.deepEqual(failed.calls.map(([name]) => name), ['stop', 'initialize', 'updateManagedLlamaServer', 'updatePreferredEngineType']);
  // A stop that could not be confirmed is a WARN, not a success line; the switch still proceeds.
  const unconfirmed = makeManagedLlamaLoadService({ stopError: 'stop_unconfirmed' });
  await loadModel(unconfirmed, { model: 'ornith:9b', engine_type: 'ollama' });
  const stopLogs = unconfirmed.logs.filter(({ event }) => event.startsWith('backend.engine_switch_stop_llama_server'));
  assert.deepEqual(stopLogs.map(({ level, event }) => [level, event]), [['WARN', 'backend.engine_switch_stop_llama_server_failed']]);
  assert.equal(stopLogs[0].details.message, 'stop_unconfirmed');
  // A failed Ollama load persists nothing.
  const fell = makeManagedLlamaLoadService({ fallbackAfterInit: { reason: 'ollama down', requested_engine: 'ollama' } });
  await assert.rejects(loadModel(fell, { model: 'ornith:9b', engine_type: 'ollama' }), /Could not load ollama engine/);
  assert.deepEqual(fell.calls.map(([name]) => name), ['stop', 'initialize']);
});
