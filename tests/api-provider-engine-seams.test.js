'use strict';

// Row 78: every seam that has to treat `api-provider` as a remote cloud engine,
// the load/admission refusals and the model-list wiring.

const test = require('node:test');
const assert = require('node:assert/strict');

const { AI_ERROR_CODES, PROVIDER_CLASSIFICATIONS } = require('../services/backend/error-codes');
const {
  inferEngineTypeFromModel,
  resolveRequestedEngineType,
} = require('../services/backend/backend-service-utils');
const { normalizePreferredEngineType } = require('../services/shell-config-engines');
const { SETUP_CLOUD_ENGINES } = require('../services/main/setup-readiness');
const { CLOUD_ENGINE_TYPES } = require('../services/backend/managed-sidecar-chat-helpers');
const { verifyGpuEvictedForEngine } = require('../services/backend/exclusive-gpu-preflight');
const { assertChatTurnAdmissible } = require('../services/backend/chat-turn-admission');
const {
  assertSessionRuntimeProviderRouteCurrent,
  captureSessionRuntimeProviderRoute,
} = require('../services/backend/session-runtime-provider-route');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-config');
const { buildManagedStatusSnapshot } = require('../services/backend/managed-sidecar-status');
const { listModels, listModelsForEngine, loadModel } = require('../services/backend/backend-runtime');
const { captureRuntimeRoute } = require('../services/session-runtime/lanes');
const {
  assembleContextForChat,
  blockOfKind,
  makeOptions,
  normalizeContextPreferences,
  withProjectAuthority,
} = require('./helpers/chat-stream-active-file-harness');

const MODEL = 'api-provider/openrouter/openai/gpt-6-luna';

function providers(mutate) {
  const config = {
    instances: [{
      id: 'openrouter',
      presetId: 'openrouter',
      label: 'OpenRouter',
      noticeAcknowledgedAt: '2026-10-25T00:00:00.000Z',
      models: [{ id: 'openai/gpt-6-luna', enabled: true }, { id: 'meta/llama-5', enabled: false }],
    }, {
      id: 'lanbox',
      presetId: null,
      label: 'LAN box',
      endpoint: 'http://127.0.0.1:8080/v1',
      transport: 'openai_chat_completions_v1',
      authProfile: 'none',
      models: [{ id: 'local-7b', enabled: true }],
    }],
  };
  if (mutate) mutate(config);
  return config;
}

function makeService({
  apiProviders = providers(), keys = ['openrouter'], flags = {}, hostMode, model = MODEL,
  engine = 'api-provider', extra = {},
} = {}) {
  const calls = [];
  const logs = [];
  const service = {
    calls,
    logs,
    hostMode,
    featureFlags: flags,
    currentEngineType: engine,
    currentModel: model,
    activeStreams: new Map(),
    options: {},
    providerIntegrationRegistry: null,
    sidecarClient: {
      async modelsList(engineType) {
        calls.push(['modelsList', engineType]);
        return { available: true, models: [{ id: 'llama3:8b' }] };
      },
    },
    secureStore: { hasModelProviderApiKey: (id) => keys.includes(id) },
    configService: {
      getState: () => ({ apiProviders, preferredEngineType: '' }),
      updateApiProviders: (next) => calls.push(['updateApiProviders', next.lastSelected]),
      resolveStreamInactivitySeconds: (_model, opts) => {
        calls.push(['inactivity', opts.cloud]);
        return { seconds: opts.cloud ? 300 : 120, automatic: true };
      },
    },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    async _initializeManagedSidecar(args) { calls.push(['initialize', args.requestedEngineType, args.requestedModel]); },
    async refreshStatusSnapshot() {},
    ...extra,
  };
  service.listModelsForEngine = (engineType, options) => listModelsForEngine(service, engineType, options);
  return service;
}

test('api-provider ids are id-anchored to the api-provider engine and survive a local pin', () => {
  assert.equal(inferEngineTypeFromModel(MODEL), 'api-provider');
  assert.equal(inferEngineTypeFromModel('API-PROVIDER/x/y'), 'api-provider');
  assert.equal(resolveRequestedEngineType('vllm', MODEL), 'api-provider');
  assert.equal(resolveRequestedEngineType('openai-compatible', MODEL), 'api-provider');
  assert.equal(inferEngineTypeFromModel('api-provider'), 'ollama', 'a bare word is not a namespaced id');
});

test('the preferred engine allowlist and the cloud-engine sets include api-provider', () => {
  assert.equal(normalizePreferredEngineType('api-provider'), 'api-provider');
  assert.equal(SETUP_CLOUD_ENGINES.has('api-provider'), true);
  assert.equal(CLOUD_ENGINE_TYPES.has('api-provider'), true);
});

test('the provider classification vocabulary carries redirect_refused', () => {
  assert.equal(PROVIDER_CLASSIFICATIONS.REDIRECT_REFUSED, 'redirect_refused');
  assert.equal(PROVIDER_CLASSIFICATIONS.INVALID_API_KEY, 'invalid_api_key');
});

test('GPU eviction is free by design for api-provider (only the Ollama probe runs)', async () => {
  const urls = [];
  const result = await verifyGpuEvictedForEngine({
    engineType: 'api-provider',
    fetchImpl: async (url) => { urls.push(url); return { ok: true, json: async () => ({ models: [] }) }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.proof, 'engine_has_no_local_gpu_runtime');
  assert.equal(urls.length, 1);
});

test('managed config treats api-provider as a cloud engine for stream inactivity', () => {
  const service = makeService({ extra: { defaultModel: MODEL, options: { userDataPath: 'C:/tmp/jenny-test' } } });
  buildManagedSidecarConfig(service);
  assert.deepEqual(service.calls.filter((call) => call[0] === 'inactivity'), [['inactivity', true]]);
});

test('status residency for api-provider is remote, so loaded stays null', () => {
  const service = makeService({ extra: { currentStatus: null, configService: null } });
  const status = buildManagedStatusSnapshot(service, {
    local_runtime: {
      engine: { type: 'api-provider' },
      model: { id: MODEL, configured: true },
      readiness: { status: 'ready', ready: true },
    },
  });
  assert.equal(status.local_runtime.model.residency, 'remote');
  assert.equal(status.local_runtime.model.loaded, null);
});

test('api-provider uses the minimal system prompt like ChatGPT', async () => {
  let compiled = 0;
  const service = withProjectAuthority({
    featureFlags: {},
    _memoryRecallCache: {},
    _emitServiceLog() {},
    personalityWorkspace: { getCompiledContext: async () => { compiled += 1; return '## IDENTITY\nPersona'; } },
  });
  const prefs = normalizeContextPreferences({
    history_scope: 'fresh',
    include_personality: true,
    include_memory: false,
    include_git_context: false,
    include_codebase_context: false,
    include_active_file_context: false,
  });
  const cloud = await assembleContextForChat(service, makeOptions({
    engineType: 'api-provider', contextPreferences: prefs, activeFileContext: null,
  }));
  assert.equal(compiled, 0);
  assert.equal(blockOfKind(cloud, 'personality'), null);
  const local = await assembleContextForChat(service, makeOptions({
    engineType: 'openai-compatible', contextPreferences: prefs, activeFileContext: null,
  }));
  assert.equal(compiled, 1);
  assert.ok(blockOfKind(local, 'personality'));
});

// ---- session runtime route ----

test('the session route is a cloud, GPU-free route whose revision follows the connection and model', () => {
  const route = captureSessionRuntimeProviderRoute(makeService());
  assert.equal(route.engine_type, 'api-provider');
  assert.equal(route.resource_class, 'cloud');
  assert.equal(route.requires_gpu, false);
  assert.doesNotThrow(() => assertSessionRuntimeProviderRouteCurrent(makeService(), route));

  const revision = (service) => captureSessionRuntimeProviderRoute(service).configuration_revision;
  const base = revision(makeService({ model: 'api-provider/lanbox/local-7b' }));
  assert.equal(base, revision(makeService({ model: 'api-provider/lanbox/local-7b' })));
  for (const mutate of [
    (config) => { config.instances[1].endpoint = 'http://127.0.0.1:9090/v1'; },
    (config) => { config.instances[1].authProfile = 'api_key_bearer'; },
    (config) => { config.instances[1].models[0].enabled = false; },
  ]) {
    assert.notEqual(base, revision(makeService({ apiProviders: providers(mutate), model: 'api-provider/lanbox/local-7b' })));
  }
  assert.notEqual(revision(makeService()), revision(makeService({ model: 'api-provider/lanbox/local-7b' })));
});

test('a captured route is refused when the config changed or the key is gone, and the key never feeds the revision', () => {
  const service = makeService();
  const route = captureSessionRuntimeProviderRoute(service);

  const moved = makeService({ apiProviders: providers((config) => { config.instances[0].models[0].enabled = false; }) });
  assert.throws(() => assertSessionRuntimeProviderRouteCurrent(moved, route),
    (error) => error.code === 'runtime_provider_configuration_changed');

  const keyless = makeService({ keys: [] });
  assert.throws(() => assertSessionRuntimeProviderRouteCurrent(keyless, route),
    (error) => error.code === 'runtime_provider_credentials_unavailable');

  assert.equal(captureSessionRuntimeProviderRoute(keyless).configuration_revision, route.configuration_revision);
  const noAuth = makeService({ model: 'api-provider/lanbox/local-7b', keys: [] });
  assert.doesNotThrow(() => assertSessionRuntimeProviderRouteCurrent(noAuth, captureSessionRuntimeProviderRoute(noAuth)));
});

// ---- admission ----

function admitRoute() {
  return captureRuntimeRoute({
    engine_type: 'api-provider',
    provider_id: 'api-provider',
    configuration_revision: 'cfg:abc',
    resource_class: 'cloud',
    requires_gpu: false,
  });
}

function admissionCode(service, route = null) {
  try {
    assertChatTurnAdmissible(service, 's1', route);
  } catch (error) {
    assert.equal(error.error_code, AI_ERROR_CODES.ENGINE_CONNECTION);
    assert.equal(error.category, 'setup');
    assert.equal(error.retryable, false);
    return error.code;
  }
  return null;
}

test('chat admission passes a usable api-provider model and refuses with the four typed codes', () => {
  assert.equal(admissionCode(makeService(), admitRoute()), null);
  assert.equal(admissionCode(makeService()), null, 'also without a captured route');
  assert.equal(admissionCode(makeService({ hostMode: 'server' }), admitRoute()), 'api_providers_disabled');
  assert.equal(admissionCode(makeService({ flags: { api_providers: false } }), admitRoute()), 'api_providers_disabled');
  assert.equal(admissionCode(makeService({ model: 'api-provider/ghost/m' }), admitRoute()), 'api_provider_model_unavailable');
  assert.equal(admissionCode(makeService({
    apiProviders: providers((config) => { config.instances[0].models[0].enabled = false; }),
  }), admitRoute()), 'api_provider_model_unavailable');
  assert.equal(admissionCode(makeService({ keys: [] }), admitRoute()), 'api_provider_key_missing');
  assert.equal(admissionCode(makeService({
    apiProviders: providers((config) => { config.instances[0].noticeAcknowledgedAt = null; }),
  }), admitRoute()), 'api_provider_notice_required');
});

test('chat admission ignores other engines and only flag-checks a lazy switch to api-provider', () => {
  assert.equal(admissionCode(makeService({ engine: 'ollama', model: 'llama3:8b', keys: [] })), null);
  const lazy = makeService({ engine: 'chatgpt', model: 'gpt-6-astra', keys: [] });
  assert.equal(admissionCode(lazy, admitRoute()), null, 'loadModel validates the lazily switched model');
  lazy.hostMode = 'server';
  assert.equal(admissionCode(lazy, admitRoute()), 'api_providers_disabled');
});

// ---- load ----

async function loadCode(service, model = MODEL) {
  try {
    await loadModel(service, model);
  } catch (error) {
    return error.code;
  }
  return null;
}

test('loading a namespaced model switches to the api-provider engine and records it as lastSelected', async () => {
  const service = makeService({ engine: 'ollama', model: 'llama3:8b' });
  const result = await loadModel(service, MODEL);
  assert.equal(result.status, 'ok');
  assert.deepEqual(service.calls.filter((call) => call[0] === 'initialize'), [['initialize', 'api-provider', MODEL]]);
  assert.deepEqual(service.calls.filter((call) => call[0] === 'updateApiProviders'),
    [['updateApiProviders', { instanceId: 'openrouter', modelId: 'openai/gpt-6-luna' }]]);
});

test('a catalog engine hint for a namespaced id reaches the same path', async () => {
  const service = makeService({ engine: 'ollama', model: 'llama3:8b' });
  await loadModel(service, { model: MODEL, engine_type: 'api-provider' });
  assert.deepEqual(service.calls.filter((call) => call[0] === 'initialize'), [['initialize', 'api-provider', MODEL]]);
});

test('load refusals happen before anything is switched', async () => {
  const cases = [
    [makeService({ hostMode: 'server' }), MODEL, 'api_providers_disabled'],
    [makeService({ flags: { api_providers: false } }), MODEL, 'api_providers_disabled'],
    [makeService(), 'api-provider/ghost/m', 'api_provider_model_unavailable'],
    [makeService(), 'api-provider/openrouter/meta/llama-5', 'api_provider_model_unavailable'],
    [makeService({ keys: [] }), MODEL, 'api_provider_key_missing'],
  ];
  for (const [service, model, code] of cases) {
    assert.equal(await loadCode(service, model), code);
    assert.deepEqual(service.calls, [], `${code}: no sidecar call, no config write`);
  }
});

test('a no-auth instance loads without a key', async () => {
  const service = makeService({ keys: [] });
  assert.equal(await loadCode(service, 'api-provider/lanbox/local-7b'), null);
});

// ---- model list ----

test('listModelsForEngine(api-provider) answers from config without a sidecar round trip', async () => {
  const service = makeService({ extra: { sidecarClient: null } });
  const payload = await listModelsForEngine(service, 'api-provider');
  assert.equal(payload.engine_type, 'api-provider');
  assert.deepEqual(payload.data.map((entry) => entry.id), [MODEL, 'api-provider/lanbox/local-7b']);
});

test('the aggregate list appends api-provider rows with their extra fields, whatever engine runs', async () => {
  for (const engine of ['ollama', 'api-provider']) {
    const service = makeService({ engine, model: engine === 'ollama' ? 'llama3:8b' : MODEL });
    const payload = await listModels(service);
    const rows = payload.data.filter((entry) => entry.engine_type === 'api-provider');
    assert.deepEqual(rows.map((entry) => entry.id), [MODEL, 'api-provider/lanbox/local-7b'], engine);
    assert.equal(rows[0].apiProviderInstanceId, 'openrouter');
    assert.equal(rows[0].hasKey, true);
    assert.equal(typeof rows[0].contextLength, 'number');
    assert.equal(service._modelEngineHints.get(MODEL), 'api-provider', 'the hint lets a bare model id load');
    assert.ok(payload.data.some((entry) => entry.id === 'llama3:8b'), 'local rows stay');
  }
});

test('the list drops api-provider rows under the kill switch and in hosted mode', async () => {
  for (const options of [{ flags: { api_providers: false } }, { hostMode: 'server' }]) {
    const payload = await listModels(makeService({ engine: 'ollama', model: 'llama3:8b', ...options }));
    assert.equal(payload.data.some((entry) => entry.engine_type === 'api-provider'), false);
  }
});

test('a key saved inside the list cache window shows up on the next read', async () => {
  const keys = [];
  const service = makeService({ engine: 'ollama', model: 'llama3:8b', keys });
  const first = await listModels(service);
  assert.equal(first.data.find((entry) => entry.id === MODEL).hasKey, false);
  keys.push('openrouter');
  const second = await listModels(service);
  assert.equal(second.data.find((entry) => entry.id === MODEL).hasKey, true);
});
