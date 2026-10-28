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
