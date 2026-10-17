'use strict';

// NInfer in loadModel/unloadModel (row 54 Step 6): an artifact id loads through
// the NInfer manager (which stops llama-server itself) and records the
// mutually exclusive boot target; a llama-server load stops NInfer first with
// proof; any other engine stops it; Unload stops it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadModel, unloadModel } = require('../services/backend/backend-runtime');

const ARTIFACT = { id: 'qwen3.8-27b-nvfp4', model_id: 'qwen3.8-27b-nvfp4', display_name: 'Qwen3.8 27B' };

function makeService({
  ninferState = 'stopped', ninferEnsureState = 'ready', ninferStopError = '', llamaState = 'stopped',
  lastUsedTag = '', lastUsedArtifactId = '', ninferAvailable = true, fallbackAfterInit = null,
} = {}) {
  const calls = [];
  const logs = [];
  const entry = { engine: 'llama-server', modelPath: 'G:\\models\\ornith.gguf', tag: '', mtp: null };
  const managed = { enabled: true, profileId: 'balanced', lastUsedTag, perModel: { 'ornith-9b': entry } };
  const ninfer = { lastUsedArtifactId, suggestionDismissed: false, contextSize: 65536, mtp: true, watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 } };
  const llamaManager = {
    getStatus: () => ({ state: llamaState, lastError: '' }),
    async ensureRunning(spec) { calls.push(['llama.ensureRunning', spec]); return { state: 'ready', lastError: '' }; },
    async stop() { calls.push(['llama.stop']); return { state: 'stopped', lastError: '' }; },
  };
  const ninferManager = {
    getStatus: () => ({ state: ninferState, lastError: '' }),
    async ensureRunning(spec) { calls.push(['ninfer.ensureRunning', spec]); return { state: ninferEnsureState, lastError: 'ninfer_runtime_missing' }; },
    async stop() { calls.push(['ninfer.stop']); return { state: 'stopped', lastError: ninferStopError }; },
  };
  const service = {
    calls, logs, currentEngineType: 'openai-compatible', currentModel: '', _lastEngineFallback: null,
    providerIntegrationRegistry: null,
    options: { getLlamaServerManager: () => llamaManager, getNinferManager: () => (ninferAvailable ? ninferManager : null) },
    ninferRuntime: { artifacts: { artifacts: [ARTIFACT] } },
    sidecarClient: { async modelsUnload(model) { calls.push(['modelsUnload', model]); } },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    configService: {
      getState: () => ({ preferredEngineType: 'openai-compatible' }),
      getLocalEngines: () => ({ openaiCompatible: { managed }, ninfer }),
      updatePreferredEngineType(type) { calls.push(['updatePreferredEngineType', type]); },
      updateManagedLlamaServer(patch) { calls.push(['updateManagedLlamaServer', patch]); },
      updateNinferSettings(patch) { calls.push(['updateNinferSettings', patch]); },
    },
    _buildManagedStatusSnapshot: (overrides = {}) => ({ model: '', model_loaded: false, ...overrides }),
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    async _initializeManagedSidecar(options) { calls.push(['initialize', options]); service._lastEngineFallback = fallbackAfterInit; },
    async refreshStatusSnapshot() { return null; },
  };
  return service;
}

test('a NInfer artifact id loads through the NInfer manager and records the exclusive boot target', async () => {
  const service = makeService({ lastUsedTag: 'ornith-9b' });
  await loadModel(service, { model: 'qwen3.8-27b-nvfp4', engine_type: 'openai-compatible' });
  assert.deepEqual(service.calls, [
    ['ninfer.ensureRunning', { artifactId: 'qwen3.8-27b-nvfp4' }],
    ['initialize', { reason: 'model_load', requestedModel: 'qwen3.8-27b-nvfp4', requestedEngineType: 'openai-compatible' }],
    ['updatePreferredEngineType', 'openai-compatible'],
    ['updateNinferSettings', { lastUsedArtifactId: 'qwen3.8-27b-nvfp4' }],
    ['updateManagedLlamaServer', { lastUsedTag: '' }],
  ]);
});

test('a NInfer artifact overrides the derived Ollama engine before sidecar initialization', async () => {
  const service = makeService();
  service.configService.getState = () => ({ preferredEngineType: 'ollama' });
  await loadModel(service, ARTIFACT.model_id);
  assert.deepEqual(service.calls.slice(0, 2), [
    ['ninfer.ensureRunning', { artifactId: ARTIFACT.id }],
    ['initialize', { reason: 'model_load', requestedModel: ARTIFACT.model_id, requestedEngineType: 'openai-compatible' }],
  ]);
  assert.deepEqual(service.logs.find(({ event }) => event === 'backend.model_load_engine_hint_overridden'), {
    level: 'INFO', event: 'backend.model_load_engine_hint_overridden',
    details: { model: ARTIFACT.model_id, requested_engine: 'ollama', managed_kind: 'ninfer', source: '' },
  });
});

test('a NInfer launch failure surfaces its typed reason and persists nothing', async () => {
  const service = makeService({ ninferEnsureState: 'stopped' });
  await assert.rejects(
    loadModel(service, { model: 'qwen3.8-27b-nvfp4', engine_type: 'openai-compatible' }),
    /Could not start NInfer for "qwen3.8-27b-nvfp4": ninfer_runtime_missing/
  );
  assert.deepEqual(service.calls.map(([name]) => name), ['ninfer.ensureRunning']);
  const fallback = makeService({ fallbackAfterInit: { reason: 'sidecar refused', requested_engine: 'openai-compatible' } });
  await assert.rejects(loadModel(fallback, { model: 'qwen3.8-27b-nvfp4', engine_type: 'openai-compatible' }), /Could not load openai-compatible engine/);
  assert.equal(fallback.calls.some(([name]) => name === 'updateNinferSettings'), false);
});

test('a llama-server load stops a live NInfer with proof first and clears its boot target', async () => {
  const service = makeService({ ninferState: 'ready', lastUsedArtifactId: 'qwen3.8-27b-nvfp4' });
  await loadModel(service, { model: 'ornith:9b', engine_type: 'openai-compatible' });
  assert.deepEqual(service.calls.map(([name]) => name),
    ['ninfer.stop', 'llama.ensureRunning', 'initialize', 'updateNinferSettings', 'updatePreferredEngineType', 'updateManagedLlamaServer']);
  assert.deepEqual(service.calls[3], ['updateNinferSettings', { lastUsedArtifactId: '' }]);
  assert.ok(service.logs.some(({ event }) => event === 'backend.engine_switch_stop_ninfer'));
});

test('an unconfirmed NInfer stop aborts the switch before llama-server launches', async () => {
  const service = makeService({ ninferState: 'ready', ninferStopError: 'stop_unconfirmed' });
  await assert.rejects(
    loadModel(service, { model: 'ornith:9b', engine_type: 'openai-compatible' }),
    /The managed NInfer runtime could not be confirmed stopped; the engine switch was aborted/
  );
  assert.deepEqual(service.calls.map(([name]) => name), ['ninfer.stop']);
  assert.ok(service.logs.some(({ event }) => event === 'backend.engine_switch_stop_ninfer_failed'));
});

test('switching to Ollama stops a crashed NInfer and forgets its boot target', async () => {
  const service = makeService({ ninferState: 'crashed', lastUsedArtifactId: 'qwen3.8-27b-nvfp4' });
  service.currentEngineType = 'openai-compatible';
  await loadModel(service, { model: 'gemma4:12b', engine_type: 'ollama' });
  assert.deepEqual(service.calls.map(([name]) => name), ['ninfer.stop', 'initialize', 'updateNinferSettings', 'updatePreferredEngineType']);
});

test('without the NInfer manager (flag off) an artifact id is an ordinary openai-compatible load', async () => {
  const service = makeService({ ninferAvailable: false });
  await loadModel(service, { model: 'qwen3.8-27b-nvfp4', engine_type: 'openai-compatible' });
  assert.deepEqual(service.calls.map(([name]) => name), ['initialize']);
});

test('Unload stops a live NInfer before the sidecar unload', async () => {
  const service = makeService({ ninferState: 'ready' });
  service.currentModel = 'qwen3.8-27b-nvfp4';
  service.currentStatus = { model: 'qwen3.8-27b-nvfp4', model_loaded: true };
  service._modelLifecycle = { state: 'ready', requested_model: 'qwen3.8-27b-nvfp4' };
  const result = await unloadModel(service, { stopManagedServer: true });
  assert.deepEqual(result, { status: 'ok', model: '' });
  assert.deepEqual(service.calls.map(([name]) => name), ['ninfer.stop', 'modelsUnload']);
  assert.ok(service.logs.some(({ event }) => event === 'backend.model_unload_stopped_ninfer'));
});
