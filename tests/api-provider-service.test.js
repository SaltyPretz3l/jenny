'use strict';

/* services/backend/api-provider-service.js (row 78): the main-process owner of
 * the apiProviders.* operations. Fakes only: an in-memory shell config that
 * runs the real normalizer, a fake secure store, a fake fetch and DNS lookup.
 * The key never appears in a returned value, a pushed event, a log call or the
 * stored config. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApiProviderService, MAX_KEY_CHARS } = require('../services/backend/api-provider-service');
const { MAX_INSTANCES, normalizeApiProvidersConfig, namespacedModelId } = require('../services/backend/api-provider-config');
const { ShellConfigService } = require('../services/shell-config-service');

const KEY = 'Test-Key-Value-0123';
const publicLookup = async () => [{ address: '104.18.2.1', family: 4 }];
const NOW = new Date('2026-10-25T12:00:00.000Z');

function fakeSecureStore() {
  const keys = new Map();
  return {
    keys,
    hasModelProviderApiKey: (id) => keys.has(id),
    getModelProviderApiKey: (id) => keys.get(id) || '',
    setModelProviderApiKey: (id, value) => { keys.set(id, value); },
    deleteModelProviderApiKey: (id) => { keys.delete(id); },
    purgeOrphanModelProviderApiKeys: (live) => {
      const removed = [...keys.keys()].filter((id) => !live.includes(id));
      removed.forEach((id) => keys.delete(id));
      return removed;
    },
  };
}

function fakeShellConfig(initial = {}) {
  let state = { offlineIntelligence: { mode: 'off' }, apiProviders: normalizeApiProvidersConfig(initial) };
  return {
    getState: () => state,
    updateApiProviders(next) {
      state = { ...state, apiProviders: normalizeApiProvidersConfig(next) };
      return state.apiProviders;
    },
  };
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup({ backend, config, fetchImpl } = {}) {
  const shellConfigService = fakeShellConfig(config);
  const secureStore = fakeSecureStore();
  const events = [];
  const logs = [];
  const backendService = backend === undefined ? { featureFlags: {} } : backend;
  const service = createApiProviderService({
    shellConfigService,
    secureStore,
    backendService,
    sendBridgeEvent: (channel, payload) => events.push({ channel, payload }),
    fetchImpl: fetchImpl || (async () => jsonResponse({ data: [] })),
    lookup: publicLookup,
    nowProvider: () => NOW,
    log: (...args) => logs.push(args),
  });
  return { service, shellConfigService, secureStore, events, logs, backendService };
}

const stored = (ctx) => ctx.shellConfigService.getState().apiProviders;

test('the real ShellConfigService exposes the updater the service writes through', () => {
  assert.equal(typeof ShellConfigService.prototype.updateApiProviders, 'function');
});

test('getState exposes hasKey booleans and never a key', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  assert.equal(ctx.service.getState().instances[0].hasKey, false);
  await ctx.service.setKey(instanceId, KEY);
  const state = ctx.service.getState();
  assert.equal(state.instances[0].hasKey, true);
  assert.equal(state.enabled, true);
  assert.equal(state.maxInstances, MAX_INSTANCES);
  assert.equal(JSON.stringify(state).includes(KEY), false);
  assert.ok(state.presets.some((preset) => preset.id === 'openai-api'));
});

test('a preset instance seeds the recommended model enabled', async () => {
  const ctx = setup();
  const result = await ctx.service.addInstance({ presetId: 'openrouter' });
  assert.equal(result.ok, true);
  const [instance] = ctx.service.getState().instances;
  assert.equal(instance.id, result.instanceId);
  assert.equal(instance.presetId, 'openrouter');
  assert.deepEqual(instance.models.map((model) => [model.id, model.enabled]), [['openai/gpt-6-luna', true]]);
  assert.equal(instance.models[0].limitsUnknown, false);
});

test('an unknown preset is refused', async () => {
  const ctx = setup();
  assert.deepEqual(await ctx.service.addInstance({ presetId: 'nope' }), { ok: false, code: 'invalid_request' });
  assert.deepEqual(await ctx.service.addInstance(), { ok: false, code: 'invalid_request' });
});

test('a custom instance refuses http to a public host and accepts https', async () => {
  const ctx = setup();
  const refused = await ctx.service.addInstance({
    presetId: 'custom', label: 'Mine', endpoint: 'http://api.example.com/v1', authProfile: 'api_key_bearer',
  });
  assert.deepEqual(refused, { ok: false, code: 'invalid_endpoint' });
  assert.equal(ctx.service.getState().instances.length, 0);
  const accepted = await ctx.service.addInstance({
    presetId: 'custom', label: 'Mine', endpoint: 'https://api.example.com/v1/', authProfile: 'api_key_bearer',
  });
  assert.equal(accepted.ok, true);
  const [instance] = ctx.service.getState().instances;
  assert.equal(instance.endpoint, 'https://api.example.com/v1');
  assert.equal(instance.presetId, null);
  assert.equal(instance.label, 'Mine');
  const badLabel = await ctx.service.addInstance({
    presetId: 'custom', label: '   ', endpoint: 'https://api.example.com/v1', authProfile: 'none',
  });
  assert.deepEqual(badLabel, { ok: false, code: 'invalid_label' });
});

test('a custom instance takes an API format with an auth profile that format admits', async () => {
  const ctx = setup();
  const base = { presetId: 'custom', label: 'Gateway', endpoint: 'https://gw.example.com/v1' };
  assert.deepEqual(await ctx.service.addInstance({ ...base, transport: 'anthropic_messages_v1', authProfile: 'api_key_bearer' }),
    { ok: false, code: 'invalid_request' });
  assert.deepEqual(await ctx.service.addInstance({ ...base, transport: 'smoke_signals_v1', authProfile: 'none' }),
    { ok: false, code: 'invalid_request' });
  assert.equal((await ctx.service.addInstance({ ...base, transport: 'anthropic_messages_v1', authProfile: 'api_key_header' })).ok, true);
  assert.equal((await ctx.service.addInstance({ ...base, label: 'Resp', transport: 'openai_responses_v1', authProfile: 'api_key_bearer' })).ok, true);
  assert.deepEqual(ctx.service.getState().instances.map((instance) => [instance.transport, instance.authProfile]), [
    ['anthropic_messages_v1', 'api_key_header'], ['openai_responses_v1', 'api_key_bearer'],
  ]);
});

test('the instance limit refuses the next add', async () => {
  const ctx = setup();
  for (let n = 0; n < MAX_INSTANCES; n += 1) {
    assert.equal((await ctx.service.addInstance({ presetId: 'openrouter' })).ok, true, `add ${n}`);
  }
  assert.deepEqual(await ctx.service.addInstance({ presetId: 'openrouter' }), { ok: false, code: 'limit_reached' });
  assert.equal(ctx.service.getState().instances.length, MAX_INSTANCES);
});

test('concurrent mutations are serialized into distinct instances', async () => {
  const ctx = setup();
  const [a, b] = await Promise.all([
    ctx.service.addInstance({ presetId: 'openai-api' }),
    ctx.service.addInstance({ presetId: 'openai-api' }),
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.instanceId, b.instanceId);
  assert.equal(ctx.service.getState().instances.length, 2);
});

test('setKey refuses empty, whitespace, control-character and oversized keys', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  const bad = ['', '   ', 'has space', 'tab\tinside', 'new\nline', 'ctl\u0007x', 'a'.repeat(MAX_KEY_CHARS + 1), 42, null, undefined];
  for (const value of bad) {
    assert.deepEqual(await ctx.service.setKey(instanceId, value), { ok: false, code: 'invalid_key' }, JSON.stringify(value));
  }
  assert.equal(ctx.secureStore.keys.size, 0);
  assert.deepEqual(await ctx.service.setKey('missing-id', KEY), { ok: false, code: 'unknown_instance' });
});

test('setKey stores a valid key and never returns, pushes or logs it', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  const result = await ctx.service.setKey(instanceId, `  ${KEY}  `);
  assert.deepEqual(result, { ok: true });
  assert.equal(ctx.secureStore.keys.get(instanceId), KEY);
  const everything = JSON.stringify([result, ctx.events, ctx.logs, ctx.service.getState(), stored(ctx)]);
  assert.equal(everything.includes(KEY), false);
  assert.equal(ctx.events.at(-1).channel, 'apiProviders.onChanged');
  assert.equal(ctx.events.at(-1).payload.instances[0].hasKey, true);
});

test('a key-less (authProfile none) instance takes no key', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({
    presetId: 'custom', label: 'Local', endpoint: 'https://models.example.com/v1', authProfile: 'none',
  });
  assert.deepEqual(await ctx.service.setKey(instanceId, KEY), { ok: false, code: 'invalid_request' });
  assert.equal(ctx.service.getState().instances[0].hasKey, false);
});

test('clearKey and removeInstance delete the key', async () => {
  const ctx = setup();
  const first = await ctx.service.addInstance({ presetId: 'openai-api' });
  const second = await ctx.service.addInstance({ presetId: 'groq' });
  await ctx.service.setKey(first.instanceId, KEY);
  await ctx.service.setKey(second.instanceId, `${KEY}-2`);
  assert.deepEqual(await ctx.service.clearKey(first.instanceId), { ok: true });
  assert.equal(ctx.secureStore.keys.has(first.instanceId), false);
  assert.equal(ctx.service.getState().instances.find((i) => i.id === first.instanceId).hasKey, false);
  assert.deepEqual(await ctx.service.removeInstance(second.instanceId), { ok: true });
  assert.equal(ctx.secureStore.keys.has(second.instanceId), false);
  assert.deepEqual(ctx.service.getState().instances.map((i) => i.id), [first.instanceId]);
  assert.deepEqual(await ctx.service.removeInstance('missing-id'), { ok: false, code: 'unknown_instance' });
});

test('renameInstance trims, bounds and applies the label', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({ presetId: 'groq' });
  assert.deepEqual(await ctx.service.renameInstance(instanceId, '  Work Groq '), { ok: true });
  assert.equal(ctx.service.getState().instances[0].label, 'Work Groq');
  assert.deepEqual(await ctx.service.renameInstance(instanceId, ''), { ok: false, code: 'invalid_label' });
  assert.deepEqual(await ctx.service.renameInstance(instanceId, 'x'.repeat(65)), { ok: false, code: 'invalid_label' });
});

test('discover stores rows on success', async () => {
  const requests = [];
  const ctx = setup({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse({ data: [{ id: 'gpt-6-luna' }, { id: 'gpt-6-nano', context_length: 64000 }] });
    },
  });
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  await ctx.service.setKey(instanceId, KEY);
  const result = await ctx.service.discover(instanceId);
  assert.deepEqual(result, { ok: true, count: 2 });
  assert.equal(requests.length, 1);
  const [instance] = ctx.service.getState().instances;
  assert.deepEqual(instance.discovery.rows.map((row) => row.id), ['gpt-6-luna', 'gpt-6-nano']);
  assert.equal(instance.discovery.error, null);
  assert.ok(Number.isFinite(Date.parse(instance.discovery.fetchedAt)));
  assert.equal(JSON.stringify([ctx.events, ctx.logs, stored(ctx)]).includes(KEY), false);
  // The enable list is every listed row with its resolved limits; only the recommended one is on.
  assert.deepEqual(instance.models.map((model) => [model.id, model.enabled, model.discovered]), [
    ['gpt-6-luna', true, true], ['gpt-6-nano', false, true],
  ]);
  assert.equal(instance.models[1].limits.context_length, 64000);
  assert.equal(instance.models[1].limits.sources.context_length, 'provider');
  assert.equal(stored(ctx).instances[0].models.length, 1);
});

test('discover stores only the error code on 401, never the key or a body', async () => {
  const ctx = setup({ fetchImpl: async () => new Response(`bad key ${KEY}`, { status: 401 }) });
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  await ctx.service.setKey(instanceId, KEY);
  const result = await ctx.service.discover(instanceId);
  assert.deepEqual(result, { ok: false, code: 'unauthorized', status: 401 });
  const [instance] = ctx.service.getState().instances;
  assert.deepEqual(instance.discovery.error, { code: 'unauthorized', status: 401 });
  assert.equal(JSON.stringify([result, ctx.events, ctx.logs, stored(ctx), ctx.service.getState()]).includes(KEY), false);
  assert.equal(JSON.stringify(stored(ctx)).includes('bad key'), false);
});

test('discover without a key reports key_missing and stores that code', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  const result = await ctx.service.discover(instanceId);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'key_missing');
  assert.equal(ctx.service.getState().instances[0].discovery.error.code, 'key_missing');
});

test('setModelEnabled, setModelPin and acknowledgeNotice update the config', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  assert.deepEqual(await ctx.service.setModelEnabled(instanceId, 'gpt-6-luna', true), { ok: true });
  assert.deepEqual(await ctx.service.setModelEnabled(instanceId, 'my-custom', true), { ok: true });
  assert.deepEqual(await ctx.service.setModelEnabled(instanceId, 'my-custom', false), { ok: true });
  const models = () => ctx.service.getState().instances[0].models;
  assert.equal(models().find((m) => m.id === 'gpt-6-luna').enabled, true);
  assert.equal(models().find((m) => m.id === 'my-custom').enabled, false);
  assert.deepEqual(await ctx.service.setModelEnabled(instanceId, '', true), { ok: false, code: 'invalid_model' });
  assert.deepEqual(await ctx.service.setModelEnabled(instanceId, 'gpt-6-luna', 'yes'), { ok: false, code: 'invalid_model' });

  assert.deepEqual(await ctx.service.setModelPin(instanceId, 'my-custom', { contextLength: 32000, maxOutputTokens: 4000 }), { ok: true });
  const pinned = models().find((m) => m.id === 'my-custom');
  assert.equal(pinned.pin.contextLength, 32000);
  assert.equal(pinned.pin.maxOutputTokens, 4000);
  assert.equal(pinned.limits.context_length, 32000);
  assert.equal(pinned.limits.sources.context_length, 'pin');
  assert.deepEqual(await ctx.service.setModelPin(instanceId, 'my-custom', null), { ok: true });
  assert.deepEqual(models().find((m) => m.id === 'my-custom').pin || {}, {});

  assert.equal(ctx.service.getState().instances[0].noticeAcknowledgedAt, null);
  assert.deepEqual(await ctx.service.acknowledgeNotice(instanceId), { ok: true });
  assert.equal(ctx.service.getState().instances[0].noticeAcknowledgedAt, NOW.toISOString());
  assert.deepEqual(await ctx.service.acknowledgeNotice('missing-id'), { ok: false, code: 'unknown_instance' });
});

test('mutations return disabled when the api_providers flag is off or the host is a server', async () => {
  for (const backend of [{ featureFlags: { api_providers: false } }, { hostMode: 'server', featureFlags: {} }]) {
    const ctx = setup({ backend });
    assert.deepEqual(await ctx.service.addInstance({ presetId: 'openai-api' }), { ok: false, code: 'disabled' });
    assert.deepEqual(await ctx.service.setKey('openai-api', KEY), { ok: false, code: 'disabled' });
    assert.deepEqual(await ctx.service.removeInstance('openai-api'), { ok: false, code: 'disabled' });
    assert.deepEqual(await ctx.service.discover('openai-api'), { ok: false, code: 'disabled' });
    const state = ctx.service.getState();
    assert.equal(state.enabled, false);
    assert.deepEqual(state.instances, []);
    assert.equal(stored(ctx).instances.length, 0);
  }
});

test('a disabled service hides stored instances from getState', async () => {
  const ctx = setup();
  await ctx.service.addInstance({ presetId: 'openai-api' });
  ctx.backendService.featureFlags.api_providers = false;
  assert.deepEqual(ctx.service.getState().instances, []);
});

test('a change to the instance the active engine uses re-initializes the sidecar; another does not', async () => {
  const ctx = setup({ backend: { featureFlags: {}, currentEngineType: 'api-provider', currentModel: '' } });
  const calls = [];
  ctx.backendService.refreshManagedConfig = async (reason, options) => { calls.push([reason, options]); };
  const active = await ctx.service.addInstance({ presetId: 'openai-api' });
  const other = await ctx.service.addInstance({ presetId: 'groq' });
  ctx.backendService.currentModel = namespacedModelId(active.instanceId, 'gpt-6-luna');

  await ctx.service.setKey(other.instanceId, KEY);
  await ctx.service.setModelEnabled(other.instanceId, 'openai/gpt-oss-120b', true);
  assert.equal(calls.length, 0);

  await ctx.service.setKey(active.instanceId, KEY);
  assert.deepEqual(calls.at(-1), ['api_provider_key_updated', { requestedEngineType: 'api-provider' }]);
  // A toggle or pin on another model of the active instance leaves the running engine alone.
  await ctx.service.setModelEnabled(active.instanceId, 'gpt-6-luna-mini', true);
  await ctx.service.setModelPin(active.instanceId, 'gpt-6-luna-mini', { contextLength: 65536 });
  assert.equal(calls.length, 1);
  await ctx.service.setModelEnabled(active.instanceId, 'gpt-6-luna', true);
  assert.equal(calls.at(-1)[0], 'api_provider_models_updated');
  await ctx.service.clearKey(active.instanceId);
  assert.equal(calls.at(-1)[0], 'api_provider_key_cleared');
  await ctx.service.removeInstance(active.instanceId);
  assert.equal(calls.at(-1)[0], 'api_provider_removed');
  assert.equal(calls.length, 4);
});

test('no re-initialization when a different engine is active', async () => {
  const ctx = setup({ backend: { featureFlags: {}, currentEngineType: 'ollama', currentModel: 'llama' } });
  let refreshed = 0;
  ctx.backendService.refreshManagedConfig = async () => { refreshed += 1; };
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  await ctx.service.setKey(instanceId, KEY);
  assert.equal(refreshed, 0);
});

test('a storage failure reports a code, not the message, and the chain keeps going', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  ctx.secureStore.setModelProviderApiKey = () => { throw Object.assign(new Error(`cannot store ${KEY}`), { code: 'storage_unavailable' }); };
  const result = await ctx.service.setKey(instanceId, KEY);
  assert.deepEqual(result, { ok: false, code: 'storage_unavailable' });
  assert.equal(JSON.stringify([result, ctx.logs, ctx.events]).includes(KEY), false);
  assert.deepEqual(await ctx.service.renameInstance(instanceId, 'Still works'), { ok: true });
});

test('purgeOrphanKeys drops keys without an instance and never throws', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.service.addInstance({ presetId: 'openai-api' });
  ctx.secureStore.keys.set(instanceId, KEY);
  ctx.secureStore.keys.set('ghost-provider', KEY);
  ctx.service.purgeOrphanKeys();
  assert.deepEqual([...ctx.secureStore.keys.keys()], [instanceId]);
  assert.equal(ctx.logs.some((entry) => entry[1] === 'api_provider.orphan_keys_purged'), true);
  ctx.secureStore.purgeOrphanModelProviderApiKeys = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => ctx.service.purgeOrphanKeys());
});
