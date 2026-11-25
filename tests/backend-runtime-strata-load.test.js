'use strict';

// Strata in the model list, loadModel and unloadModel (row 200 S2 step 6): the
// model is listed only when a launch could start, with its parameter count; its
// id (or alias) loads through the Strata manager, which stops the lower managers
// itself, and records Strata as the one boot target; every other load stops a
// live Strata first, with proof, and forgets it; Unload stops it; an Ollama
// load counts Strata's server as memory it frees.

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadModel, unloadModel } = require('../services/backend/backend-runtime');
const { isStrataModel, strataModelEntries } = require('../services/backend/strata-load-path');
const { managedServerKindForModel } = require('../services/backend/ninfer-load-path');

const MODEL = { id: 'inkling-2-mini-sq-20', displayName: 'Inkling 2 Mini', aliases: ['inkling-2-mini'], paramsB: 26.4 };

function runtimeState(overrides = {}) {
  return {
    enabled: true,
    install: { found: true, reason: '', version: '0.1.67', warnings: [] },
    setup: { found: true, reason: '' },
    packs: { native: 'verified', vision: 'verified' },
    model: MODEL,
    ...overrides,
  };
}

function makeService({
  strataState = 'stopped', strataEnsureState = 'ready', strataStopError = '', strataPid = 4242,
  lastUsed = false, lastUsedTag = '', lastUsedArtifactId = '', state = runtimeState(), strataAvailable = true,
} = {}) {
  const calls = [];
  const logs = [];
  const managed = { enabled: true, profileId: 'balanced', lastUsedTag, perModel: { 'ornith-9b': { engine: 'llama-server', modelPath: 'G:\\m.gguf', tag: '', mtp: null } } };
  const strataSettings = { lastUsed, vision: true };
  const strataManager = {
    getStatus: () => ({ state: strataState, lastError: '', pid: strataState === 'stopped' ? 0 : strataPid }),
    async ensureRunning(spec) { calls.push(['strata.ensureRunning', spec]); return { state: strataEnsureState, lastError: strataEnsureState === 'ready' ? '' : 'strata_pack:sha256_mismatch' }; },
    async stop(options) { calls.push(['strata.stop', options]); return { state: 'stopped', lastError: strataStopError }; },
    cleanupUnconfirmed: () => false,
  };
  const service = {
    calls, logs, currentEngineType: 'openai-compatible', currentModel: '', _lastEngineFallback: null,
    providerIntegrationRegistry: null,
    options: {
      getLlamaServerManager: () => ({
        getStatus: () => ({ state: 'stopped', lastError: '' }),
        async ensureRunning(spec) { calls.push(['llama.ensureRunning', spec]); return { state: 'ready', lastError: '' }; },
        async stop() { calls.push(['llama.stop']); return { state: 'stopped', lastError: '' }; },
      }),
      getNinferManager: () => null,
      getStrataManager: () => (strataAvailable ? strataManager : null),
    },
    strataRuntime: { enabled: true, getState: () => state },
    sidecarClient: { async modelsUnload(model) { calls.push(['modelsUnload', model]); } },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    configService: {
      getState: () => ({ preferredEngineType: 'openai-compatible' }),
      getLocalEngines: () => ({ openaiCompatible: { managed }, strata: strataSettings }),
      updatePreferredEngineType(type) { calls.push(['updatePreferredEngineType', type]); },
      updateManagedLlamaServer(patch) { calls.push(['updateManagedLlamaServer', patch]); },
      updateStrataSettings(patch) { calls.push(['updateStrataSettings', patch]); },
    },
    _buildManagedStatusSnapshot: (extra = {}) => ({ model: '', model_loaded: false, ...extra }),
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    async _initializeManagedSidecar(options) { calls.push(['initialize', options]); },
    async refreshStatusSnapshot() { return null; },
  };
  return service;
}

test('the Strata row is listed only when a launch could start, with its parameter count and vision', () => {
  assert.deepEqual(strataModelEntries(makeService()), [{
    id: 'inkling-2-mini-sq-20', engine_type: 'openai-compatible', available: true, managed: 'strata',
    parameter_size: '26.4B', capabilities: { vision: true },
  }]);
  assert.equal(strataModelEntries(makeService({ state: runtimeState({ packs: { native: 'verified', vision: 'failed' } }) }))[0].capabilities.vision, false);
  for (const state of [
    runtimeState({ install: { found: false, reason: 'not_installed', version: '', warnings: [] } }),
    runtimeState({ setup: { found: false, reason: 'no_setup_config' } }),
    runtimeState({ packs: { native: 'failed', vision: 'verified' } }),
    runtimeState({ packs: { native: 'missing', vision: 'unknown' } }),
    runtimeState({ model: null }),
  ]) assert.deepEqual(strataModelEntries(makeService({ state })), []);
  assert.deepEqual(strataModelEntries(makeService({ strataAvailable: false })), [], 'no manager, no row');
});

test('the Strata id and its alias route to the Strata manager; nothing else does', () => {
  const service = makeService();
  assert.equal(isStrataModel(service, 'inkling-2-mini-sq-20'), true);
  assert.equal(isStrataModel(service, 'inkling-2-mini'), true);
  assert.equal(isStrataModel(service, 'ornith:9b'), false);
  assert.equal(managedServerKindForModel(service, 'inkling-2-mini', { routing: true }), 'strata');
  assert.equal(managedServerKindForModel(makeService({ strataAvailable: false }), 'inkling-2-mini', { routing: true }), '');
});

test('a Strata load goes through its manager and becomes the only boot target', async () => {
  const service = makeService({ lastUsedTag: 'ornith-9b' });
  service.configService.getState = () => ({ preferredEngineType: 'ollama' });
  await loadModel(service, 'inkling-2-mini-sq-20');
  assert.deepEqual(service.calls, [
    ['strata.ensureRunning', null],
    ['initialize', { reason: 'model_load', requestedModel: 'inkling-2-mini-sq-20', requestedEngineType: 'openai-compatible' }],
    ['updatePreferredEngineType', 'openai-compatible'],
    ['updateStrataSettings', { lastUsed: true }],
    ['updateManagedLlamaServer', { lastUsedTag: '' }],
  ]);
});

test('a Strata launch failure surfaces its typed reason and persists nothing', async () => {
  const service = makeService({ strataEnsureState: 'stopped' });
  await assert.rejects(loadModel(service, { model: 'inkling-2-mini-sq-20', engine_type: 'openai-compatible' }), (error) => {
    assert.match(error.message, /Could not start Strata for "inkling-2-mini-sq-20": strata_pack:sha256_mismatch/);
    assert.equal(error.strata_status.state, 'stopped');
    return true;
  });
  assert.deepEqual(service.calls.map(([name]) => name), ['strata.ensureRunning']);
});

test('a llama-server load stops a live Strata with proof first and forgets its boot target', async () => {
  const service = makeService({ strataState: 'ready', lastUsed: true });
  await loadModel(service, { model: 'ornith:9b', engine_type: 'openai-compatible' });
  assert.deepEqual(service.calls.map(([name]) => name),
    ['strata.stop', 'llama.ensureRunning', 'initialize', 'updateStrataSettings', 'updatePreferredEngineType', 'updateManagedLlamaServer']);
  assert.deepEqual(service.calls[0], ['strata.stop', { stoppedBy: 'engine_switch' }]);
  assert.deepEqual(service.calls[3], ['updateStrataSettings', { lastUsed: false }]);
});

test('an unconfirmed Strata stop aborts the switch before anything else launches', async () => {
  const service = makeService({ strataState: 'ready', strataStopError: 'strata_stop_unconfirmed' });
  await assert.rejects(loadModel(service, { model: 'ornith:9b', engine_type: 'openai-compatible' }),
    /The managed Strata server could not be confirmed stopped; the engine switch was aborted/);
  assert.deepEqual(service.calls.map(([name]) => name), ['strata.stop']);
});

test('an Ollama load counts the Strata server as memory it frees, then stops it', async () => {
  const service = makeService({ strataState: 'ready' });
  const seen = [];
  service.vramLoadPreflight = { check: async (request) => { seen.push(request.reclaimPids); return { ok: true }; } };
  await loadModel(service, { model: 'qwen3:8b', engine_type: 'ollama' });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes(4242), JSON.stringify(seen));
  assert.deepEqual(service.calls.slice(0, 2).map(([name]) => name), ['strata.stop', 'initialize']);
});

test('Unload stops a live Strata before the sidecar unload', async () => {
  const service = makeService({ strataState: 'ready' });
  await unloadModel(service, { stopManagedServer: true });
  assert.deepEqual(service.calls.slice(0, 2), [['strata.stop', {}], ['modelsUnload', undefined]]);
  assert.ok(service.logs.some(({ event }) => event === 'backend.model_unload_stopped_strata'));
});
