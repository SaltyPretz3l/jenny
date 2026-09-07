'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { holdEventLoopUntilTestsFinish } = require('./helpers/event-loop-hold');

// Production timers in this module are unref'd; see the helper.
holdEventLoopUntilTestsFinish(test);

const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const {
  createChatGptAuthServiceDefault,
  createSyntheticChatGptAuthService,
  ensureChatgptAuthService,
  syntheticAuthEnabled,
  triggerProviderSidecarReinit,
} = require('../services/provider-auth-runtime');
const { createPluginProviderAuthService } = require('../services/plugins/provider/provider-auth-service');

test('legacy chatgptAuth renderer namespace is absent after the provider retrofit', () => {
  assert.deepEqual(Object.keys(JENNY_SHELL_BRIDGE_DESCRIPTORS)
    .filter((name) => name.startsWith('chatgptAuth.')), []);
});

test('provider auth owner is composed once and retains the existing secure store', () => {
  const secureStore = { marker: true };
  const backendService = { secureStore };
  let calls = 0;
  const created = { getStatus: () => ({ state: 'signed_out' }) };
  const first = ensureChatgptAuthService({
    backendService,
    createAuthService: (options) => {
      calls += 1;
      assert.equal(options.secureStore, secureStore);
      return created;
    },
  });
  const second = ensureChatgptAuthService({ backendService, createAuthService: () => null });
  assert.equal(first, created);
  assert.equal(second, created);
  assert.equal(calls, 1);
});

test('synthetic provider auth is double-gated to agent mode and the explicit Stage 7 flag', async () => {
  assert.equal(syntheticAuthEnabled({ JENNY_AGENT_DEV: '1', JENNY_STAGE7_SYNTHETIC_OAUTH: '1' }), true);
  assert.equal(syntheticAuthEnabled({ JENNY_STAGE7_SYNTHETIC_OAUTH: '1' }), false);
  const backendService = { secureStore: {} };
  const service = ensureChatgptAuthService({
    backendService,
    createAuthService: createChatGptAuthServiceDefault,
    env: { JENNY_AGENT_DEV: '1', JENNY_STAGE7_SYNTHETIC_OAUTH: '1' },
  });
  assert.equal(service.getStatus().state, 'signed_out');
  const signingIn = service.start();
  assert.equal(service.getStatus().state, 'connecting');
  service.cancel();
  assert.equal((await signingIn).state, 'signed_out');
});

test('synthetic provider auth transitions without retaining a token after sign-out', async () => {
  const service = createSyntheticChatGptAuthService({ transitionDelayMs: 1 });
  assert.equal((await service.start()).state, 'signed_in');
  assert.equal(service.hasCredential(), true);
  assert.equal((await service.signOut()).state, 'signed_out');
  assert.equal(await service.getAccessToken(), '');
});

test('provider sidecar refresh is guarded by current or preferred ChatGPT intent', async () => {
  const calls = [];
  const backendService = {
    currentEngineType: 'mock',
    refreshManagedConfig: (...args) => { calls.push(args); return Promise.resolve(); },
  };
  triggerProviderSidecarReinit(backendService, { getState: () => ({ preferredEngineType: 'ollama' }) });
  triggerProviderSidecarReinit(backendService, { getState: () => ({ preferredEngineType: 'chatgpt' }) }, null, 'provider_auth_started');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['provider_auth_started', { requestedEngineType: 'chatgpt' }]]);
});

test('descriptor provider auth awaits reconfiguration and never returns credentials', async () => {
  const order = [];
  const owner = {
    getStatus: () => ({ state: 'signed_in', email: 'person@example.com' }),
    start: async () => { order.push('start'); return { state: 'signed_in' }; },
    cancel: () => {},
    signOut: async () => { order.push('sign_out'); return { state: 'signed_out' }; },
    getAccessToken: async () => 'secret-token',
    hasCredential: () => true,
    onStatusChange: () => () => {},
  };
  const service = createPluginProviderAuthService({
    chatgptAuthService: owner,
    isProviderActive: () => true,
    onAuthChanged: async ({ reason }) => { order.push(reason); },
  });
  const started = await service.start('chatgpt', {});
  const signedOut = await service.signOut('chatgpt');
  assert.deepEqual(order, ['start', 'provider_auth_started', 'sign_out', 'provider_auth_signed_out']);
  assert.equal(JSON.stringify([started, signedOut]).includes('secret-token'), false);
});
