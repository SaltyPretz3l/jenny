'use strict';

// Row 179 P3: a local subagent engine (NInfer or llama-server) stays running
// under a cloud primary and is brokered to the sidecar as `local_subagent_engine`.
// This file covers the module, the load path and the settings; the boot,
// re-broker and GPU handoff wiring live in local-subagent-engine-wiring.test.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadModel } = require('../services/backend/backend-model-load');
const {
  applyLocalSubagentEnginePatch, getLocalSubagentEngineStatus, localSubagentEngineApplies,
  normalizeLocalSubagentEngine, syncLocalSubagentEngine,
} = require('../services/backend/local-subagent-engine');
const { buildManagedSidecarConfig, buildManagedSidecarSecrets } = require('../services/backend/managed-sidecar-config');
const { clearExactSecretsForTests, redactExactSecrets } = require('../services/backend/exact-secret-redaction');
const { CONFIG_ERROR_CODES } = require('../services/backend/error-codes');
const { ShellConfigService } = require('../services/shell-config-service');
const { buildFeatureFlags } = require('../services/feature-flags');

const CLOUD_MODEL = 'api-provider/openrouter/openai/gpt-6-luna';
const ARTIFACT = { id: 'qwen3.8-27b-nvfp4', model_id: 'qwen3.8-27b-nvfp4', display_name: 'Qwen3.8 27B' };
const NINFER_HELPER = Object.freeze({ engine: 'ninfer', model: ARTIFACT.model_id });
const LLAMA_HELPER = Object.freeze({ engine: 'llama-server', model: 'ornith:9b' });

test.afterEach(() => clearExactSecretsForTests());

function makeManager(kind, initial = {}) {
  const calls = [];
  const port = kind === 'ninfer' ? 8034 : 8033;
  const status = { state: 'stopped', pid: 0, alias: '', artifactId: '', contextSize: 0, lastError: '', ...initial };
  const manager = {
    calls,
    status,
    baseUrl: null,
    getStatus: () => ({ ...status }),
    getBaseUrl: () => manager.baseUrl ?? (['ready', 'starting'].includes(status.state) ? `http://127.0.0.1:${port}/v1` : ''),
    getApiKey: () => (status.state === 'ready' ? `${kind}-launch-key-0123456789abcdef` : ''),
    supportsPrefillProgress: () => status.state === 'ready',
    async ensureRunning(spec) {
      calls.push(['ensureRunning', spec]);
      if (manager.failStart) {
        Object.assign(status, { state: 'stopped', lastError: manager.failStart });
        return { ...status };
      }
      Object.assign(status, kind === 'ninfer'
        ? { state: 'ready', pid: 4242, alias: ARTIFACT.model_id, artifactId: spec.artifactId, contextSize: 65536 }
        : { state: 'ready', pid: 4343, alias: String(spec.modelTag).replace(/:latest$/i, ''), servedContextSize: 32768 });
      return { ...status };
    },
    async stop(options = {}) {
      calls.push(['stop', options]);
      Object.assign(status, { state: 'stopped', pid: 0 });
      return { ...status };
    },
  };
  return manager;
}

function makeService({
  engine = 'api-provider', helper = NINFER_HELPER,
  ninferState = 'stopped', llamaState = 'stopped', flags = {}, activeStreams = [],
} = {}) {
  const calls = [];
  const logs = [];
  const ninfer = makeManager('ninfer', ninferState === 'ready'
    ? { state: 'ready', pid: 4242, alias: ARTIFACT.model_id, artifactId: ARTIFACT.id, contextSize: 65536 }
    : { state: ninferState });
  const llama = makeManager('llama-server', llamaState === 'ready'
    ? { state: 'ready', pid: 4343, alias: 'ornith:9b', servedContextSize: 32768 }
    : { state: llamaState });
  const managed = {
    enabled: true, profileId: 'balanced', lastUsedTag: '',
    perModel: { 'ornith-9b': { engine: 'llama-server', modelPath: 'G:\\models\\ornith.gguf', tag: '', mtp: null } },
  };
  const state = {
    preferredEngineType: engine,
    localSubagentEngine: helper,
    apiProviders: {
      instances: [{ id: 'openrouter', presetId: 'openrouter', label: 'OpenRouter', models: [{ id: 'openai/gpt-6-luna', enabled: true }] }],
    },
  };
  let mode = 'off';
  const service = {
    calls, logs, ninfer, llama, state, managed,
    setMode: (next) => { mode = next; },
    currentEngineType: engine, currentModel: '', _lastEngineFallback: null,
    providerIntegrationRegistry: null,
    featureFlags: { api_providers: true, local_subagent_engine: true, ...flags },
    offlineIntelligenceService: { getMode: () => mode },
    secureStore: {
      getModelProviderApiKey: (id) => (id === 'openrouter' ? 'QWxwaGFCZXRhR2FtbWFEZWx0YQ9z7' : ''),
      hasModelProviderApiKey: (id) => id === 'openrouter',
    },
    activeStreams: new Map(activeStreams.map((id) => [id, {}])),
    options: { userDataPath: os.tmpdir(), getLlamaServerManager: () => llama, getNinferManager: () => ninfer },
    ninferRuntime: { artifacts: { artifacts: [ARTIFACT] } },
    sidecarClient: { async modelsUnload(model) { calls.push(['modelsUnload', model]); } },
    configService: {
      getState: () => state,
      getLocalEngines: () => ({ openaiCompatible: { managed }, ninfer: { lastUsedArtifactId: '' } }),
      updatePreferredEngineType(type) { calls.push(['updatePreferredEngineType', type]); },
      updateManagedLlamaServer(patch) { calls.push(['updateManagedLlamaServer', patch]); },
      updateNinferSettings(patch) { calls.push(['updateNinferSettings', patch]); },
      updateApiProviders() { calls.push(['updateApiProviders']); },
    },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    async _initializeManagedSidecar(options) {
      calls.push(['initialize', options.requestedEngineType]);
      service.currentEngineType = options.requestedEngineType;
    },
    async refreshStatusSnapshot() { return null; },
    async refreshManagedConfig(reason) { calls.push(['refresh', reason]); return {}; },
  };
  return service;
}

const names = (manager) => manager.calls.map(([name]) => name);

// ---- applies / status --------------------------------------------------------

test('every fence names its reason and only a cloud primary with a resolvable pick applies', () => {
  const cases = [
    [makeService({ flags: { local_subagent_engine: false } }), 'flag_off'],
    [Object.assign(makeService(), { hostMode: 'server' }), 'hosted'],
    [(() => { const s = makeService(); s.setMode('local_only'); return s; })(), 'forced_local'],
    [Object.assign(makeService(), { offlineIntelligenceService: { getMode() { throw new Error('unreadable'); } } }), 'forced_local'],
    [makeService({ engine: 'openai-compatible' }), 'primary_local'],
    [makeService({ engine: 'ollama' }), 'primary_local'],
    [Object.assign(makeService(), { _teamEngineSelection: { modelId: 'team-model' } }), 'team'],
    [makeService({ helper: { engine: '', model: '' } }), 'not_picked'],
    [makeService({ helper: { engine: 'ninfer', model: 'no-such-artifact' } }), 'model_unavailable'],
    [makeService({ helper: { engine: 'llama-server', model: 'not-managed:1b' } }), 'model_unavailable'],
  ];
  for (const [service, reason] of cases) {
    const status = getLocalSubagentEngineStatus(service);
    assert.equal(status.applies, false, reason);
    assert.equal(status.ready, false, reason);
    assert.equal(status.reason, reason);
    assert.equal(localSubagentEngineApplies(service), false, reason);
  }
  const disabled = makeService({ helper: LLAMA_HELPER });
  disabled.managed.enabled = false;
  assert.equal(getLocalSubagentEngineStatus(disabled).reason, 'model_unavailable');
  for (const engine of ['api-provider', 'chatgpt', 'codex-cli']) {
    assert.equal(localSubagentEngineApplies(makeService({ engine })), true, engine);
  }
  assert.equal(localSubagentEngineApplies(makeService(), 'openai-compatible'), false);
});

test('status is ready only while the picked manager serves the picked model', () => {
  assert.deepEqual(getLocalSubagentEngineStatus(makeService({ ninferState: 'ready' })), {
    applies: true, engine: 'ninfer', model: ARTIFACT.model_id, state: 'ready', ready: true, reason: '',
  });
  for (const [state, reason] of [['stopped', 'stopped'], ['stopping', 'stopped'], ['starting', 'starting'], ['crashed', 'crashed']]) {
    const status = getLocalSubagentEngineStatus(makeService({ ninferState: state }));
    assert.deepEqual([status.applies, status.state, status.ready, status.reason], [true, state, false, reason]);
  }
  const other = makeService({ ninferState: 'ready' });
  other.ninfer.status.artifactId = 'some-other-artifact';
  assert.equal(getLocalSubagentEngineStatus(other).reason, 'other_model');
  const llama = makeService({ helper: LLAMA_HELPER, llamaState: 'ready' });
  assert.equal(getLocalSubagentEngineStatus(llama).ready, true);
  llama.llama.status.alias = 'gemma4:12b';
  assert.equal(getLocalSubagentEngineStatus(llama).reason, 'other_model');
});

// ---- sidecar config and secret ------------------------------------------------

test('a ready helper adds exactly seven keys to the sidecar config and its key as a separate secret', () => {
  const service = makeService({ engine: 'codex-cli', ninferState: 'ready' });
  const config = buildManagedSidecarConfig(service);
  assert.deepEqual(config.local_subagent_engine, {
    base_url: 'http://127.0.0.1:8034', model: ARTIFACT.model_id, provider_kind: 'ninfer', context_length: 65536,
    ready: true, prefill_progress: false, json_schema_response_format: false,
  });
  const key = service.ninfer.getApiKey();
  assert.equal(JSON.stringify(config).includes(key), false, 'the key never rides the config object');
  const secrets = buildManagedSidecarSecrets(service);
  assert.equal(secrets.local_subagent_api_key, key);
  assert.equal(Object.hasOwn(secrets, 'openai_compatible_api_key'), false, 'the primary key logic is unchanged');
  assert.equal(redactExactSecrets(`leak ${key}`), 'leak [redacted:api-key]');

  const llama = makeService({ engine: 'chatgpt', helper: LLAMA_HELPER, llamaState: 'ready', flags: { prefill_progress: true } });
  const llamaConfig = buildManagedSidecarConfig(llama).local_subagent_engine;
  assert.deepEqual(Object.keys(llamaConfig).sort(), ['base_url', 'context_length', 'json_schema_response_format',
    'model', 'prefill_progress', 'provider_kind', 'ready']);
  assert.deepEqual([llamaConfig.base_url, llamaConfig.model, llamaConfig.provider_kind, llamaConfig.context_length],
    ['http://127.0.0.1:8033', 'ornith:9b', 'llama-server', 32768]);
  assert.equal(llamaConfig.prefill_progress, true);
  assert.equal(llamaConfig.json_schema_response_format, true);
  llama.featureFlags.prefill_progress = false;
  assert.equal(buildManagedSidecarConfig(llama).local_subagent_engine.prefill_progress, false);
});

test('no config key and no secret when the helper is not ready or fenced', () => {
  const fenced = [
    makeService({ engine: 'codex-cli' }), // stopped
    makeService({ engine: 'codex-cli', ninferState: 'starting' }),
    Object.assign(makeService({ engine: 'codex-cli', ninferState: 'ready' }), { _teamEngineSelection: { modelId: 'team' } }),
    (() => { const s = makeService({ engine: 'codex-cli', ninferState: 'ready' }); s.setMode('local_only'); return s; })(),
    makeService({ engine: 'codex-cli', ninferState: 'ready', flags: { local_subagent_engine: false } }),
  ];
  for (const service of fenced) {
    assert.equal(Object.hasOwn(buildManagedSidecarConfig(service), 'local_subagent_engine'), false);
    assert.equal(Object.hasOwn(buildManagedSidecarSecrets(service), 'local_subagent_api_key'), false);
  }
  const hosted = Object.assign(makeService({ engine: 'codex-cli', ninferState: 'ready' }), { hostMode: 'server' });
  assert.equal(getLocalSubagentEngineStatus(hosted).reason, 'hosted');
  const remote = makeService({ engine: 'codex-cli', ninferState: 'ready' });
  remote.ninfer.baseUrl = 'http://192.168.1.20:8034/v1';
  assert.equal(Object.hasOwn(buildManagedSidecarConfig(remote), 'local_subagent_engine'), false, 'a non-loopback origin is never brokered');
  assert.deepEqual(buildManagedSidecarSecrets(remote), {});
});

// ---- cloud and local loads ------------------------------------------------------

test('a cloud load keeps a picked NInfer helper running and starts it', async () => {
  const service = makeService({ ninferState: 'ready' });
  await loadModel(service, { model: CLOUD_MODEL, engine_type: 'api-provider' });
  assert.equal(names(service.ninfer).includes('stop'), false, 'the helper manager is not stopped');
  assert.deepEqual(service.ninfer.calls.find(([name]) => name === 'ensureRunning'), ['ensureRunning', { artifactId: ARTIFACT.id }]);
  assert.equal(service.ninfer.status.state, 'ready');
});

test('a cloud load stops the other manager with proof and starts the helper after the sidecar initialized', async () => {
  const service = makeService({ llamaState: 'ready' });
  const order = [];
  service.llama.stop = async (options) => { order.push(['llama.stop', options]); service.llama.status.state = 'stopped'; return { state: 'stopped', lastError: '' }; };
  const init = service._initializeManagedSidecar;
  service._initializeManagedSidecar = async (options) => { order.push(['initialize']); return init(options); };
  const ensure = service.ninfer.ensureRunning;
  service.ninfer.ensureRunning = async (spec) => { order.push(['ninfer.ensureRunning']); return ensure(spec); };
  const result = await loadModel(service, { model: CLOUD_MODEL, engine_type: 'api-provider' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(order, [['llama.stop', { stoppedBy: 'engine_switch' }], ['initialize'], ['ninfer.ensureRunning']]);
  assert.ok(service.logs.some(({ event }) => event === 'backend.local_subagent_engine_started'));
});

test('leaving an Ollama primary evicts its model before the helper launches; a failed eviction aborts', async () => {
  const service = makeService({ engine: 'ollama' });
  service.currentModel = 'gemma4:12b';
  assert.equal((await loadModel(service, { model: CLOUD_MODEL, engine_type: 'api-provider' })).status, 'ok');
  assert.deepEqual(service.calls.slice(0, 2), [['modelsUnload', 'gemma4:12b'], ['initialize', 'api-provider']]);
  const stuck = makeService({ engine: 'ollama' });
  stuck.currentModel = 'gemma4:12b';
  stuck.sidecarClient.modelsUnload = async () => { throw new Error('unload failed'); };
  await assert.rejects(loadModel(stuck, { model: CLOUD_MODEL, engine_type: 'api-provider' }), /could not be confirmed evicted/);
  assert.equal(names(stuck.ninfer).includes('ensureRunning'), false, 'no helper launch over an unconfirmed eviction');
});

test('a llama-server helper is kept and NInfer stops first with proof', async () => {
  const service = makeService({ helper: LLAMA_HELPER, ninferState: 'ready', llamaState: 'ready' });
  await loadModel(service, { model: CLOUD_MODEL, engine_type: 'api-provider' });
  assert.deepEqual(names(service.ninfer), ['stop']);
  assert.deepEqual(service.llama.calls, [['ensureRunning', {
    modelTag: 'ornith:9b', modelPath: 'G:\\models\\ornith.gguf', profileId: 'balanced', mtp: null,
  }]]);
});

test('a helper start failure is logged without secrets and the cloud load still completes', async () => {
  const service = makeService();
  service.ninfer.failStart = 'ninfer_runtime_missing';
  const result = await loadModel(service, { model: CLOUD_MODEL, engine_type: 'api-provider' });
  assert.equal(result.status, 'ok');
  assert.equal(service.currentEngineType, 'api-provider');
  const failure = service.logs.find(({ event }) => event === 'backend.local_subagent_engine_start_failed');
  assert.deepEqual(failure.details, { engine: 'ninfer', model: ARTIFACT.model_id, reason: 'model_load', state: 'stopped', last_error: 'ninfer_runtime_missing' });
  assert.equal(service.ninfer.status.lastError, 'ninfer_runtime_missing');
  service.ninfer.ensureRunning = async () => { throw new Error('spawn failed'); };
  assert.equal((await loadModel(service, { model: CLOUD_MODEL, engine_type: 'api-provider' })).status, 'ok');
  assert.equal(JSON.stringify(service.logs).includes('launch-key'), false);
});

test('a cloud load that would launch a helper refuses while another session streams', async () => {
  const service = makeService({ activeStreams: ['other-stream'] });
  await assert.rejects(loadModel(service, { model: CLOUD_MODEL, engine_type: 'api-provider' }), /Stop the active response before switching engines/);
  assert.deepEqual(service.ninfer.calls, []);
  assert.equal(service.calls.some(([name]) => name === 'initialize'), false);
  // A helper already serving its model launches nothing, so the switch is not refused.
  const serving = makeService({ ninferState: 'ready', activeStreams: ['other-stream'] });
  assert.equal((await loadModel(serving, { model: CLOUD_MODEL, engine_type: 'api-provider' })).status, 'ok');
  const leased = makeService();
  leased.exclusiveGpuCoordinator = { getState: () => ({ state: 'privileged_resident' }) };
  await assert.rejects(loadModel(leased, { model: CLOUD_MODEL, engine_type: 'api-provider' }), (error) => error.code === 'gpu_busy_plugin');
  assert.deepEqual(leased.ninfer.calls, []);
});

test('a local load stops a running helper exactly as any managed server', async () => {
  const llamaLoad = makeService({ engine: 'api-provider', ninferState: 'ready' });
  await loadModel(llamaLoad, { model: 'ornith:9b', engine_type: 'openai-compatible' });
  assert.deepEqual(names(llamaLoad.ninfer), ['stop']);
  assert.deepEqual(names(llamaLoad.llama), ['ensureRunning']);
  const ollamaLoad = makeService({ engine: 'api-provider', ninferState: 'ready' });
  await loadModel(ollamaLoad, { model: 'gemma4:12b', engine_type: 'ollama' }).catch(() => null);
  assert.deepEqual(names(ollamaLoad.ninfer), ['stop']);
});

test('flag off: a cloud load stops every managed server as before', async () => {
  const service = makeService({ ninferState: 'ready', flags: { local_subagent_engine: false } });
  await loadModel(service, { model: CLOUD_MODEL, engine_type: 'api-provider' });
  assert.deepEqual(service.ninfer.calls, [['stop', { stoppedBy: 'engine_switch' }]]);
  assert.equal(service.logs.some(({ event }) => event.startsWith('backend.local_subagent_engine')), false);
});

// ---- runtime setting change ------------------------------------------------------

test('sync stops a helper that no longer applies, starts a new pick, then refreshes the config', async () => {
  const service = makeService({ ninferState: 'ready' });
  service.state.localSubagentEngine = LLAMA_HELPER;
  assert.deepEqual(await syncLocalSubagentEngine(service, 'settings'), { synced: true, reason: '' });
  assert.deepEqual(service.ninfer.calls, [['stop', { stoppedBy: 'engine_switch' }]]);
  assert.deepEqual(names(service.llama), ['ensureRunning']);
  assert.deepEqual(service.calls.at(-1), ['refresh', 'local_subagent_engine']);
  service.state.localSubagentEngine = { engine: '', model: '' };
  await syncLocalSubagentEngine(service, 'settings');
  assert.deepEqual(names(service.llama), ['ensureRunning', 'stop']);
});

test('sync does nothing under another stream, a GPU lease, a local primary or the flag off', async () => {
  const streaming = makeService({ activeStreams: ['s1'] });
  assert.equal((await syncLocalSubagentEngine(streaming)).reason, 'stream_active');
  const leased = makeService();
  leased.exclusiveGpuCoordinator = { getState: () => ({ state: 'privileged_resident' }) };
  assert.equal((await syncLocalSubagentEngine(leased)).reason, 'gpu_leased');
  for (const service of [makeService({ engine: 'openai-compatible' }), makeService({ flags: { local_subagent_engine: false } })]) {
    assert.equal((await syncLocalSubagentEngine(service)).reason, 'not_cloud');
  }
  for (const service of [streaming, leased]) {
    assert.deepEqual([service.ninfer.calls, service.llama.calls], [[], []]);
    assert.equal(service.calls.some(([name]) => name === 'refresh'), false);
  }
});

// ---- setting and flag --------------------------------------------------------------

test('the setting normalizes on read and every invalid value falls back to none', () => {
  assert.deepEqual(normalizeLocalSubagentEngine(), { engine: '', model: '' });
  assert.deepEqual(normalizeLocalSubagentEngine({ engine: 'llama-server', model: ' ornith:9b ' }), LLAMA_HELPER);
  for (const value of [null, [], 'ninfer', { engine: 'ollama', model: 'x' }, { engine: 'ninfer', model: '' },
    { engine: 'ninfer', model: 'x'.repeat(257) }, { engine: 'ninfer', model: 'a\u0007b' }, { engine: 'ninfer', model: 7 }]) {
    assert.deepEqual(normalizeLocalSubagentEngine(value), { engine: '', model: '' });
  }
});

test('patches merge, clear, and refuse malformed input with the config INVALID code', () => {
  assert.deepEqual(applyLocalSubagentEnginePatch(undefined, NINFER_HELPER), NINFER_HELPER);
  assert.deepEqual(applyLocalSubagentEnginePatch(NINFER_HELPER, { model: 'other-artifact' }), { engine: 'ninfer', model: 'other-artifact' });
  assert.deepEqual(applyLocalSubagentEnginePatch(NINFER_HELPER, { engine: '' }), { engine: '', model: '' });
  for (const patch of [null, [], { engine: 'ollama' }, { engine: 'ninfer', model: '' }, { model: 'x'.repeat(257) },
    { engine: 'ninfer', model: 'a\nb' }, { engine: 'ninfer', model: ' padded ' }, { engine: 'ninfer', model: 'x', extra: 1 }, { engine: 'ninfer' }]) {
    assert.throws(() => applyLocalSubagentEnginePatch({}, patch), (error) => error.code === CONFIG_ERROR_CODES.INVALID);
  }
});

test('the setting persists through the feature settings patch and survives a reload', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-local-subagent-engine-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = new ShellConfigService({ userDataPath: root, env: {} });
  assert.deepEqual(config.getState().localSubagentEngine, { engine: '', model: '' });
  const before = config.getState().subagentRouting;
  config.updateFeatureSettings({ localSubagentEngine: LLAMA_HELPER });
  assert.deepEqual(new ShellConfigService({ userDataPath: root, env: {} }).getState().localSubagentEngine, LLAMA_HELPER);
  assert.deepEqual(config.getState().subagentRouting, before, 'other settings are preserved');
  assert.throws(() => config.updateFeatureSettings({ localSubagentEngine: { engine: 'vllm', model: 'x' } }),
    (error) => error.code === CONFIG_ERROR_CODES.INVALID);
  assert.deepEqual(config.getState().localSubagentEngine, LLAMA_HELPER);
  fs.writeFileSync(path.join(root, 'shell-config.json'), JSON.stringify({ localSubagentEngine: { engine: 'ninfer', model: '\u0000' } }));
  assert.deepEqual(new ShellConfigService({ userDataPath: root, env: {} }).getState().localSubagentEngine, { engine: '', model: '' });
});

test('the flag defaults on and the env kill switch turns it off', () => {
  assert.equal(buildFeatureFlags({}, {}).local_subagent_engine, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_LOCAL_SUBAGENT_ENGINE: '0' }, {}).local_subagent_engine, false);
});
