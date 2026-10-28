'use strict';

/* services/main/api-providers-registration.js (row 78): the apiProviders.* IPC
 * handlers, payload validation, the startup orphan-key purge and the wiring
 * through the cloud models owner. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeChannel, JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const { registerApiProviders } = require('../services/main/api-providers-registration');
const { registerCloudModels } = require('../services/main/cloud-models-registration');
const { normalizeApiProvidersConfig } = require('../services/backend/api-provider-config');

const KEY = 'Test-Key-Value-0123';
const publicLookup = async () => [{ address: '104.18.2.1', family: 4 }];
const METHODS = [
  'getState', 'addInstance', 'removeInstance', 'renameInstance', 'setKey', 'clearKey',
  'discover', 'setModelEnabled', 'setModelPin', 'acknowledgeNotice',
];

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    invoke(methodPath, ...args) {
      return handlers.get(getBridgeChannel(methodPath, 'invoke'))({ sender: {} }, ...args);
    },
  };
}

function setup({ keys = {}, initial = {} } = {}) {
  let apiProviders = normalizeApiProvidersConfig(initial);
  const store = new Map(Object.entries(keys));
  const purges = [];
  const events = [];
  const logs = [];
  const backendService = {
    featureFlags: {},
    secureStore: {
      hasModelProviderApiKey: (id) => store.has(id),
      getModelProviderApiKey: (id) => store.get(id) || '',
      setModelProviderApiKey: (id, value) => { store.set(id, value); },
      deleteModelProviderApiKey: (id) => { store.delete(id); },
      purgeOrphanModelProviderApiKeys: (live) => {
        purges.push([...live]);
        const removed = [...store.keys()].filter((id) => !live.includes(id));
        removed.forEach((id) => store.delete(id));
        return removed;
      },
    },
  };
  const shellConfigService = {
    getState: () => ({ apiProviders }),
    updateApiProviders(next) { apiProviders = normalizeApiProvidersConfig(next); return apiProviders; },
  };
  const ipc = fakeIpc();
  const registration = registerApiProviders(ipc, {
    backendService,
    shellConfigService,
    sendBridgeEvent: (channel, payload) => events.push({ channel, payload }),
    log: (...args) => logs.push(args),
    lookup: publicLookup,
  });
  return { ipc, registration, store, purges, events, logs, backendService, shellConfigService };
}

test('every apiProviders method has a descriptor and a registered handler', () => {
  const ctx = setup();
  for (const method of METHODS) {
    const path = `apiProviders.${method}`;
    assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS[path].kind, 'invoke', path);
    assert.equal(typeof ctx.ipc.handlers.get(getBridgeChannel(path, 'invoke')), 'function', path);
  }
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['apiProviders.onChanged'], { kind: 'subscribe', channel: 'api-providers:changed' });
});

test('startup purges keys whose instance is gone', () => {
  const ctx = setup({
    keys: { 'ghost-provider': KEY },
    initial: { instances: [{ id: 'groq', presetId: 'groq', label: 'Groq', models: [] }] },
  });
  assert.deepEqual(ctx.purges, [['groq']]);
  assert.equal(ctx.store.has('ghost-provider'), false);
});

test('a non-object payload is refused before the service runs', async () => {
  const ctx = setup();
  for (const method of METHODS.filter((name) => name !== 'getState')) {
    for (const payload of [undefined, null, 'x', 7, ['a']]) {
      assert.deepEqual(
        await ctx.ipc.invoke(`apiProviders.${method}`, payload),
        { ok: false, code: 'invalid_request' },
        `${method} ${JSON.stringify(payload)}`,
      );
    }
  }
  assert.equal(ctx.events.length, 0);
});

test('payloads map onto the service and the key is write-only', async () => {
  const ctx = setup();
  const added = await ctx.ipc.invoke('apiProviders.addInstance', { presetId: 'openai-api' });
  assert.equal(added.ok, true);
  const { instanceId } = added;
  assert.deepEqual(await ctx.ipc.invoke('apiProviders.setKey', { instanceId, key: KEY }), { ok: true });
  assert.equal(ctx.store.get(instanceId), KEY);
  assert.deepEqual(await ctx.ipc.invoke('apiProviders.renameInstance', { instanceId, label: 'Work' }), { ok: true });
  assert.deepEqual(await ctx.ipc.invoke('apiProviders.setModelEnabled', { instanceId, modelId: 'gpt-6-luna', enabled: true }), { ok: true });
  assert.deepEqual(
    await ctx.ipc.invoke('apiProviders.setModelPin', { instanceId, modelId: 'gpt-6-luna', pin: { contextLength: 64000 } }),
    { ok: true },
  );
  assert.deepEqual(await ctx.ipc.invoke('apiProviders.acknowledgeNotice', { instanceId }), { ok: true });
  const state = await ctx.ipc.invoke('apiProviders.getState');
  assert.equal(state.instances[0].label, 'Work');
  assert.equal(state.instances[0].hasKey, true);
  assert.equal(state.instances[0].models.find((m) => m.id === 'gpt-6-luna').enabled, true);
  assert.equal(JSON.stringify([state, ctx.events, ctx.logs]).includes(KEY), false);
  assert.deepEqual(await ctx.ipc.invoke('apiProviders.clearKey', { instanceId }), { ok: true });
  assert.equal(ctx.store.has(instanceId), false);
  assert.deepEqual(await ctx.ipc.invoke('apiProviders.removeInstance', { instanceId }), { ok: true });
  assert.deepEqual((await ctx.ipc.invoke('apiProviders.getState')).instances, []);
  assert.ok(ctx.events.length > 0 && ctx.events.every((event) => event.channel === 'apiProviders.onChanged'));
});

test('a failing request never logs its payload', async () => {
  const ctx = setup();
  const { instanceId } = await ctx.ipc.invoke('apiProviders.addInstance', { presetId: 'openai-api' });
  ctx.backendService.secureStore.setModelProviderApiKey = () => { throw new Error(`cannot store ${KEY}`); };
  const result = await ctx.ipc.invoke('apiProviders.setKey', { instanceId, key: KEY });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify([result, ctx.logs, ctx.events]).includes(KEY), false);
});

test('dispose stops the change pushes', async () => {
  const ctx = setup();
  await ctx.ipc.invoke('apiProviders.addInstance', { presetId: 'groq' });
  const before = ctx.events.length;
  ctx.registration.dispose();
  await ctx.ipc.invoke('apiProviders.addInstance', { presetId: 'groq' });
  assert.equal(ctx.events.length, before);
});

test('registerCloudModels registers the apiProviders handlers and chains dispose', () => {
  const ipc = fakeIpc();
  const backendService = {
    featureFlags: {},
    secureStore: {
      purgeOrphanModelProviderApiKeys: () => [],
      hasModelProviderApiKey: () => false,
    },
  };
  const shellConfigService = { getState: () => ({ chatgptModelsEnabled: true }), updateApiProviders: (next) => next };
  const cloud = registerCloudModels(ipc, {
    backendService,
    shellConfigService,
    sendBridgeEvent: () => {},
    createAuthService: () => ({
      getStatus: () => ({ state: 'signed_out' }),
      hasCredential: () => false,
      onStatusChange: () => () => {},
    }),
  });
  assert.equal(typeof ipc.handlers.get('api-providers:get-state'), 'function');
  assert.equal(typeof ipc.handlers.get('cloud-models:get-state'), 'function');
  const state = ipc.invoke('apiProviders.getState');
  assert.equal(state.enabled, true);
  assert.deepEqual(state.instances, []);
  cloud.dispose();
});
