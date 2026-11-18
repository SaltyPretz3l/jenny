const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApiProviderSidecarConfig,
  buildApiProviderSidecarSecrets,
} = require('../services/backend/api-provider-sidecar-config');
const {
  clearExactSecretsForTests,
  redactExactSecrets,
} = require('../services/backend/exact-secret-redaction');
const {
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
} = require('../services/backend/managed-sidecar-config');

const KEY = 'QWxwaGFCZXRhR2FtbWFEZWx0YQ9z7';
const MODEL = 'api-provider/openrouter/openai/gpt-6-luna';

test.afterEach(() => clearExactSecretsForTests());

function apiProviders(overrides = {}) {
  return {
    instances: [{
      id: 'openrouter',
      presetId: 'openrouter',
      label: 'OpenRouter',
      models: [
        { id: 'openai/gpt-6-luna', enabled: true },
        { id: 'meta/llama-5', enabled: false },
        { id: 'qwen/qwen4', enabled: true, pin: { contextLength: 65536 } },
      ],
      discovery: { rows: [{ id: 'qwen/qwen4', contextLength: 262144, maxOutputTokens: 16384, tools: true }] },
      ...overrides,
    }],
  };
}

function makeService({ engine = 'api-provider', model = MODEL, flags = {}, mode = 'off', store = {}, hostMode, providers } = {}) {
  const logs = [];
  return {
    logs,
    hostMode,
    currentEngineType: engine,
    currentModel: model,
    featureFlags: { api_providers: true, ...flags },
    offlineIntelligenceService: { getMode: () => mode },
    configService: { getState: () => ({ apiProviders: providers || apiProviders() }) },
    secureStore: {
      getModelProviderApiKey: (id) => (id === 'openrouter' ? KEY : ''),
      ...store,
    },
    _emitServiceLog: (level, event, data) => logs.push({ level, event, data }),
  };
}

test('the selected preset model gets its descriptor and preset limits', () => {
  const config = buildApiProviderSidecarConfig(makeService(), 'api-provider', MODEL);
  assert.equal(config.api_provider_descriptor.provider_id, 'openrouter');
  assert.equal(config.api_provider_descriptor.endpoint, 'https://openrouter.ai/api/v1');
  assert.equal(config.api_provider_model_limits.context_length, 1050000);
  assert.equal(config.api_provider_model_limits.sources.context_length, 'preset');
});

test('a pin beats the discovery row and the discovery row beats the fallback', () => {
  const config = buildApiProviderSidecarConfig(makeService(), 'api-provider', 'api-provider/openrouter/qwen/qwen4');
  const limits = config.api_provider_model_limits;
  assert.equal(limits.context_length, 65536);
  assert.equal(limits.sources.context_length, 'pin');
  assert.equal(limits.max_output_tokens, 16384);
  assert.equal(limits.sources.max_output_tokens, 'provider');
});

test('unknown, disabled or foreign models and other engines get nothing', () => {
  const service = makeService();
  for (const model of ['api-provider/openrouter/meta/llama-5', 'api-provider/groq/x', 'gpt-6-luna', '']) {
    assert.deepEqual(buildApiProviderSidecarConfig(service, 'api-provider', model), {});
  }
  assert.deepEqual(buildApiProviderSidecarConfig(service, 'ollama', MODEL), {});
});

test('the key is handed over only for the selected instance and is registered for redaction', () => {
  assert.deepEqual(buildApiProviderSidecarSecrets(makeService(), MODEL), { api_provider_key: KEY });
  assert.equal(redactExactSecrets(KEY), '[redacted:api-key]');
});

test('every fail-closed gate omits the key', () => {
  const cases = [
    makeService({ engine: 'ollama' }),
    makeService({ flags: { api_providers: false } }),
    makeService({ mode: 'local_only' }),
    makeService({ hostMode: 'server' }),
    makeService({ model: 'api-provider/openrouter/meta/llama-5' }),
    makeService({ store: { getModelProviderApiKey: () => '' } }),
    makeService({ providers: apiProviders({ presetId: null, endpoint: 'http://127.0.0.1:8000/v1', transport: 'openai_chat_completions_v1', authProfile: 'none' }) }),
    makeService({ store: { getModelProviderApiKey: () => { throw Object.assign(new Error('x'), { code: 'storage_unavailable' }); } } }),
    { ...makeService(), offlineIntelligenceService: { getMode: () => { throw new Error('boom'); } } },
  ];
  for (const service of cases) {
    assert.deepEqual(buildApiProviderSidecarSecrets(service, service.currentModel), {});
  }
  const failing = cases[7];
  assert.equal(failing.logs[0].event, 'api_provider.key_read_failed');
  assert.ok(!JSON.stringify(failing.logs).includes(KEY));
});

test('the managed sidecar initialize payload carries the descriptor in config and the key only in secrets', () => {
  const service = {
    ...makeService(),
    defaultModel: MODEL,
    options: { userDataPath: 'C:/tmp/jenny-test' },
  };
  const config = buildManagedSidecarConfig(service);
  assert.equal(config.engine_type, 'api-provider');
  assert.equal(config.api_provider_descriptor.provider_id, 'openrouter');
  assert.ok(!JSON.stringify(config).includes(KEY));
  assert.equal(buildManagedSidecarSecrets(service).api_provider_key, KEY);
});

test('the delegate model list carries the enabled models of the selected instance with their own limits and no key', () => {
  const config = buildApiProviderSidecarConfig(makeService(), 'api-provider', MODEL);
  const rows = config.api_provider_subagent_models;
  assert.deepEqual(rows.map((row) => row.id), ['openai/gpt-6-luna', 'qwen/qwen4']);
  assert.deepEqual(rows[0].limits, config.api_provider_model_limits);
  assert.equal(rows[1].limits.context_length, 65536);
  assert.equal(rows[1].limits.sources.context_length, 'pin');
  assert.ok(!JSON.stringify(config).includes(KEY));
  assert.ok(rows.every((row) => Object.keys(row).sort().join() === 'id,limits'));
});

test('the delegate model list is bounded to 64 models', () => {
  const models = Array.from({ length: 70 }, (_, index) => ({ id: `model-${index}`, enabled: true }));
  const service = makeService({ model: 'api-provider/openrouter/model-0', providers: apiProviders({ models }) });
  const rows = buildApiProviderSidecarConfig(service, 'api-provider', 'api-provider/openrouter/model-0').api_provider_subagent_models;
  assert.equal(rows.length, 64);
  assert.equal(rows[0].id, 'model-0');
});

test('a model whose limit resolution throws is left out of the delegate list', () => {
  const limitsPath = require.resolve('../services/backend/api-provider-limits');
  const configPath = require.resolve('../services/backend/api-provider-sidecar-config');
  const real = require(limitsPath);
  const savedLimits = require.cache[limitsPath];
  const savedConfig = require.cache[configPath];
  try {
    require.cache[limitsPath] = { ...savedLimits, exports: { ...real, resolveProviderModelLimits: (input) => {
      if (input.modelId === 'qwen/qwen4') throw new Error('unresolvable');
      return real.resolveProviderModelLimits(input);
    } } };
    delete require.cache[configPath];
    const { buildApiProviderSidecarConfig: build } = require(configPath);
    const config = build(makeService(), 'api-provider', MODEL);
    assert.deepEqual(config.api_provider_subagent_models.map((row) => row.id), ['openai/gpt-6-luna']);
  } finally {
    require.cache[limitsPath] = savedLimits;
    require.cache[configPath] = savedConfig;
  }
});

test('the delegate model list is absent in every fail-closed case', () => {
  const cases = [
    [makeService({ flags: { api_providers: false } }), MODEL],
    [makeService({ hostMode: 'server' }), MODEL],
    [makeService(), 'api-provider/openrouter/meta/llama-5'],
    [makeService(), 'api-provider/groq/x'],
    [makeService(), ''],
  ];
  for (const [service, model] of cases) {
    assert.deepEqual(buildApiProviderSidecarConfig(service, 'api-provider', model), {});
  }
  assert.deepEqual(buildApiProviderSidecarConfig(makeService(), 'ollama', MODEL), {});
});
