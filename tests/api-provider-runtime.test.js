'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  apiProviderCatalogKey,
  apiProviderCredentialState,
  apiProviderListPayload,
  apiProviderRouteIdentity,
  assertApiProviderAdmissible,
  assertApiProviderUsable,
  buildApiProviderModelEntries,
  persistApiProviderLoad,
  withApiProviderEntries,
} = require('../services/backend/api-provider-runtime');

const KEY_FRAGMENT = 'ZmFrZS1rZXktdmFsdWU';
const MODEL = 'api-provider/openrouter/openai/gpt-6-luna';

function apiProviders({ instances } = {}) {
  return {
    instances: instances || [{
      id: 'openrouter',
      presetId: 'openrouter',
      label: 'OpenRouter',
      models: [
        { id: 'openai/gpt-6-luna', enabled: true },
        { id: 'meta/llama-5', enabled: false },
        { id: 'qwen/qwen4', enabled: true, pin: { contextLength: 65536 } },
      ],
      discovery: { rows: [{ id: 'qwen/qwen4', contextLength: 262144, tools: true }] },
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
}

function makeService({
  hostMode, flags = {}, providers = apiProviders(), keys = [], engine = 'api-provider', model = MODEL,
  storeThrows = false,
} = {}) {
  const probes = [];
  return {
    probes,
    hostMode,
    featureFlags: flags,
    currentEngineType: engine,
    currentModel: model,
    configService: { getState: () => ({ apiProviders: providers }) },
    secureStore: {
      hasModelProviderApiKey(id) {
        probes.push(id);
        if (storeThrows) throw new Error('store not ready');
        return keys.includes(id);
      },
      getModelProviderApiKey() { throw new Error('the key must never be read here'); },
    },
  };
}

function refusalCode(service, modelId) {
  try {
    assertApiProviderUsable(service, modelId);
  } catch (error) {
    return error.code;
  }
  return null;
}

test('model entries list every enabled model, namespaced, with limits, capabilities and key presence', () => {
  const entries = buildApiProviderModelEntries(makeService({ keys: ['openrouter'] }));

  assert.deepEqual(entries.map((entry) => entry.id), [
    'api-provider/openrouter/openai/gpt-6-luna',
    'api-provider/openrouter/qwen/qwen4',
    'api-provider/lanbox/local-7b',
  ]);
  const [luna, qwen, lan] = entries;
  assert.equal(luna.engine_type, 'api-provider');
  assert.equal(luna.provider, 'OpenRouter');
  assert.equal(luna.apiProviderInstanceId, 'openrouter');
  assert.equal(luna.apiProviderModelId, 'openai/gpt-6-luna');
  assert.equal(luna.hasKey, true);
  assert.equal(luna.available, true);
  assert.equal(typeof luna.contextLength, 'number');
  assert.equal(typeof luna.capabilities.vision, 'boolean');
  assert.equal(typeof luna.capabilities.tools, 'boolean');
  assert.equal(typeof luna.capabilities.reasoning, 'boolean');
  assert.equal(qwen.contextLength, 65536, 'a user pin wins over discovery');
  assert.equal(qwen.limitsUnknown, false);
  assert.equal(lan.hasKey, true, 'authProfile none needs no key');
  assert.equal(lan.limitsUnknown, true, 'a model with no source row falls back to the default window');
  assert.equal(lan.contextLength, 32768);
});

test('a key profile without a stored key reports hasKey false and a store error counts as no key', () => {
  const noKey = buildApiProviderModelEntries(makeService({ keys: [] }));
  assert.deepEqual(noKey.map((entry) => entry.hasKey), [false, false, true]);
  const broken = buildApiProviderModelEntries(makeService({ storeThrows: true }));
  assert.deepEqual(broken.map((entry) => entry.hasKey), [false, false, true]);
});

test('hosted mode and the kill switch list nothing', () => {
  assert.deepEqual(buildApiProviderModelEntries(makeService({ hostMode: 'server' })), []);
  assert.deepEqual(buildApiProviderModelEntries(makeService({ flags: { api_providers: false } })), []);
});

test('withApiProviderEntries replaces stripped api-provider rows and keeps every other row', () => {
  const service = makeService({ keys: ['openrouter'] });
  const data = [
    { id: 'llama3', engine_type: 'ollama' },
    { id: MODEL, engine_type: 'api-provider' },
    { id: 'gpt-6-astra', engine_type: 'chatgpt' },
  ];
  const merged = withApiProviderEntries(service, data);
  assert.deepEqual(merged.slice(0, 2).map((entry) => entry.id), ['llama3', 'gpt-6-astra']);
  assert.equal(merged.filter((entry) => entry.engine_type === 'api-provider').length, 3);
  assert.equal(merged.find((entry) => entry.id === MODEL).apiProviderInstanceId, 'openrouter');
  assert.equal(data.length, 3, 'the input list is not mutated');

  const off = withApiProviderEntries(makeService({ flags: { api_providers: false } }), data);
  assert.deepEqual(off.map((entry) => entry.id), ['llama3', 'gpt-6-astra']);
});

test('Force local inference keeps the rows listed, like the ChatGPT rows', () => {
  const service = makeService({ keys: ['openrouter'] });
  service.offlineIntelligenceService = { getMode: () => 'local_only' };
  assert.equal(buildApiProviderModelEntries(service).length, 3);
});

test('listing payload answers without a sidecar and carries the active model', () => {
  const payload = apiProviderListPayload(makeService({ keys: ['openrouter'] }));
  assert.equal(payload.object, 'list');
  assert.equal(payload.engine_type, 'api-provider');
  assert.equal(payload.available, true);
  assert.equal(payload.active_model, MODEL);
  assert.equal(payload.data.length, 3);
});

test('catalog key moves with key presence, models and limits', () => {
  const base = apiProviderCatalogKey(makeService({ keys: [] }));
  assert.notEqual(base, apiProviderCatalogKey(makeService({ keys: ['openrouter'] })));
  const fewer = apiProviders();
  fewer.instances[0].models[0].enabled = false;
  assert.notEqual(base, apiProviderCatalogKey(makeService({ providers: fewer })));
  assert.equal(apiProviderCatalogKey(makeService({ flags: { api_providers: false } })), '');
});

test('assertApiProviderUsable passes a valid model and never reads the key', () => {
  const service = makeService({ keys: ['openrouter'] });
  const selection = assertApiProviderUsable(service, MODEL);
  assert.equal(selection.instance.id, 'openrouter');
  assert.equal(selection.modelId, 'openai/gpt-6-luna');
  assert.deepEqual(service.probes, ['openrouter']);
  assert.equal(refusalCode(makeService(), 'api-provider/lanbox/local-7b'), null);
});

test('assertApiProviderUsable refuses with the typed codes', () => {
  assert.equal(refusalCode(makeService({ hostMode: 'server', keys: ['openrouter'] }), MODEL), 'api_providers_disabled');
  assert.equal(refusalCode(makeService({ flags: { api_providers: false }, keys: ['openrouter'] }), MODEL), 'api_providers_disabled');
  const service = makeService({ keys: ['openrouter'] });
  assert.equal(refusalCode(service, 'api-provider/ghost/m'), 'api_provider_model_unavailable');
  assert.equal(refusalCode(service, 'api-provider/openrouter/meta/llama-5'), 'api_provider_model_unavailable');
  assert.equal(refusalCode(service, 'api-provider/openrouter/not-listed'), 'api_provider_model_unavailable');
  assert.equal(refusalCode(service, 'gpt-6-astra'), 'api_provider_model_unavailable');
  assert.equal(refusalCode(makeService({ keys: [] }), MODEL), 'api_provider_key_missing');
  assert.equal(refusalCode(makeService({ storeThrows: true }), MODEL), 'api_provider_key_missing');
});

test('refusals are setup errors that never carry key material', () => {
  let caught;
  try { assertApiProviderUsable(makeService({ keys: [] }), MODEL); } catch (error) { caught = error; }
  assert.equal(caught.category, 'setup');
  assert.equal(caught.retryable, false);
  assert.ok(caught.error_code);
  assert.equal(JSON.stringify({ message: caught.message, code: caught.code }).includes(KEY_FRAGMENT), false);
});

test('route identity changes with endpoint, auth profile, transport and model, and carries no key data', () => {
  const identity = (mutate, model = MODEL) => {
    const providers = apiProviders();
    if (mutate) mutate(providers.instances[1]);
    return JSON.stringify(apiProviderRouteIdentity(makeService({ providers, keys: ['openrouter'], model })));
  };
  const lan = 'api-provider/lanbox/local-7b';
  const base = identity(null, lan);
  assert.equal(base, identity(null, lan), 'stable for unchanged config');
  assert.notEqual(base, identity((i) => { i.endpoint = 'http://127.0.0.1:9090/v1'; }, lan));
  assert.notEqual(base, identity((i) => { i.authProfile = 'api_key_bearer'; }, lan));
  assert.notEqual(base, identity((i) => { i.models[0].enabled = false; }, lan));
  assert.notEqual(identity(null, MODEL), identity(null, 'api-provider/openrouter/qwen/qwen4'));
  assert.notEqual(base, identity(null, MODEL));
  assert.equal(base.includes(KEY_FRAGMENT), false);
});

test('route identity is minimal when the selected model is not an api-provider model', () => {
  const identity = apiProviderRouteIdentity(makeService({ model: 'llama3' }));
  assert.equal(identity.engine_type, 'api-provider');
  assert.equal(identity.provider, null);
});

test('credential state follows the auth profile and key presence, without key-derived data', () => {
  const withKey = apiProviderCredentialState(makeService({ keys: ['openrouter'] }));
  assert.deepEqual({ ...withKey }, { required: true, available: true, revision: 'present' });
  const without = apiProviderCredentialState(makeService({ keys: [] }));
  assert.deepEqual({ ...without }, { required: true, available: false, revision: 'unavailable' });
  const none = apiProviderCredentialState(makeService({ model: 'api-provider/lanbox/local-7b' }));
  assert.deepEqual({ ...none }, { required: false, available: true, revision: 'none' });
  const missing = apiProviderCredentialState(makeService({ model: 'api-provider/ghost/m' }));
  assert.equal(missing.available, false);
  assert.equal(missing.required, true);
  assert.ok(Object.isFrozen(withKey));
});

test('route identity and credentials follow the turn model while another engine is still running', () => {
  const lan = 'api-provider/lanbox/local-7b';
  const service = makeService({ engine: 'replay', model: 'mock-v1' });
  assert.equal(apiProviderRouteIdentity(service).provider, null, 'no turn model: the running model decides');
  assert.equal(apiProviderRouteIdentity(service, lan).provider.model_id, 'local-7b');
  assert.deepEqual({ ...apiProviderCredentialState(service, lan) }, { required: false, available: true, revision: 'none' });
  const keyed = makeService({ engine: 'replay', model: 'mock-v1', keys: ['openrouter'] });
  assert.equal(apiProviderCredentialState(keyed, MODEL).available, true);
});

test('a Composer pick of an api-provider model is admitted before the lazy switch (gate 2026-10-25)', () => {
  const {
    assertSessionRuntimeProviderRouteCurrent,
    captureSessionRuntimeProviderRoute,
    captureSessionRuntimeProviderSelection,
    restoreSessionRuntimeProviderRoute,
  } = require('../services/backend/session-runtime-provider-route');
  const lan = 'api-provider/lanbox/local-7b';
  const service = makeService({ engine: 'replay', model: 'mock-v1' });
  const route = captureSessionRuntimeProviderSelection(service, 'api-provider', lan)('api-provider');
  assert.equal(assertSessionRuntimeProviderRouteCurrent(service, route), route);
  // The lazy load then makes the turn's model the running one: the captured route still holds.
  service.currentEngineType = 'api-provider';
  service.currentModel = lan;
  assert.equal(assertSessionRuntimeProviderRouteCurrent(service, route), route);
  // A keyed provider without its key is still refused for the turn's model.
  const keyless = makeService({ engine: 'replay', model: 'mock-v1' });
  const keyedRoute = captureSessionRuntimeProviderRoute(keyless, { engineType: 'api-provider', model: MODEL });
  assert.throws(() => assertSessionRuntimeProviderRouteCurrent(keyless, keyedRoute),
    (error) => error.code === 'runtime_provider_credentials_unavailable');
  // A paused turn restores against its own model, not the running one.
  const restored = restoreSessionRuntimeProviderRoute(makeService({ engine: 'replay', model: 'mock-v1' }),
    { ...route }, lan);
  assert.equal(restored.configuration_revision, route.configuration_revision);
  assert.throws(() => captureSessionRuntimeProviderRoute(service, { engineType: 'api-provider', model: 7 }),
    (error) => error.code === 'runtime_provider_capture_invalid');
});

test('persistApiProviderLoad records lastSelected once, skips an unknown model and never throws', () => {
  const writes = [];
  const logs = [];
  const service = makeService();
  service.configService.updateApiProviders = (next) => writes.push(next);
  service._emitServiceLog = (...args) => logs.push(args);
  persistApiProviderLoad(service, MODEL);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].lastSelected, { instanceId: 'openrouter', modelId: 'openai/gpt-6-luna' });
  assert.equal(writes[0].instances.length, 2, 'the rest of the block is carried unchanged');

  persistApiProviderLoad(service, 'api-provider/ghost/m');
  assert.equal(writes.length, 1);

  const already = makeService({ providers: { ...apiProviders(), lastSelected: { instanceId: 'openrouter', modelId: 'openai/gpt-6-luna' } } });
  already.configService.updateApiProviders = (next) => writes.push(next);
  persistApiProviderLoad(already, MODEL);
  assert.equal(writes.length, 1, 'an unchanged selection writes nothing');

  service.configService.updateApiProviders = () => { throw new Error('disk full'); };
  persistApiProviderLoad(service, MODEL);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], 'backend.last_api_provider_model_save_failed');

  persistApiProviderLoad(makeService(), MODEL);
});

test('a turn on the active provider is refused until its first-send notice was acknowledged', () => {
  const admissionCode = (service) => {
    try { assertApiProviderAdmissible(service); } catch (error) { return error.code; }
    return null;
  };
  assert.equal(admissionCode(makeService({ keys: ['openrouter'] })), 'api_provider_notice_required');
  const acknowledged = apiProviders();
  acknowledged.instances[0].noticeAcknowledgedAt = '2026-10-25T00:00:00Z';
  assert.equal(admissionCode(makeService({ providers: acknowledged, keys: ['openrouter'] })), null);
  assert.equal(admissionCode(makeService({ engine: 'ollama', model: 'qwen3.8:27b' })), null);
});
