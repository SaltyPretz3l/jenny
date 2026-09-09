'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('../services/remote/remote-crypto');
const { createRemoteControlService } = require('../services/remote/remote-control-service');

function record(relayUrl = '') {
  return {
    record_version: 1,
    desktop_id: crypto.randomId(),
    desktop_secret: crypto.toBase64Url(crypto.randomSecret()),
    devices: [],
    shared_sessions: [],
    relay_url: relayUrl,
  };
}

function secureStore({ initialRecord = null, holdRead = false, readError = false,
  deleteError = false } = {}) {
  let stored = initialRecord ? structuredClone(initialRecord) : null;
  let releaseRead = null;
  const calls = { has: 0, get: 0, set: 0, delete: 0 };
  return {
    calls,
    releaseRead: () => releaseRead?.(),
    hasRemoteControlRecord: async () => { calls.has += 1; return stored !== null; },
    getRemoteControlRecord: async () => {
      calls.get += 1;
      if (holdRead) await new Promise((resolve) => { releaseRead = resolve; });
      if (readError) throw new Error('secure store unavailable');
      return structuredClone(stored);
    },
    setRemoteControlRecord: async (value) => { calls.set += 1; stored = structuredClone(value); },
    deleteRemoteControlRecord: async () => {
      calls.delete += 1;
      if (deleteError) throw new Error('delete failed');
      stored = null;
    },
  };
}

function fixture(options = {}) {
  const flags = { remote_control: options.feature !== false };
  const authority = { plugin: options.plugin !== false, window: options.window !== false };
  const store = options.secureStore || secureStore({ initialRecord: options.record || null });
  const service = createRemoteControlService({
    backendService: { sessionStore: { getSession: () => null } },
    secureStore: store,
    featureFlags: () => flags,
    isPluginActive: () => authority.plugin,
    isWindowAlive: () => authority.window,
    now: () => 1_000,
    portalOriginFor: () => 'https://relay.example',
    WebSocketCtor: options.websocket === false ? undefined : function FakeWebSocket() {},
  });
  return { service, store, flags, authority };
}

test('getState hydrates a returning user record and projects an enabled setup gate', async () => {
  const fix = fixture({ record: record('wss://relay.example') });
  const state = await fix.service.getState();
  assert.equal(state.relay_host, 'relay.example');
  assert.deepEqual(state.setup, {
    loaded: true, can_configure: true, can_enable: true, reason: '',
  });
});

test('concurrent getState calls share one secure-store read', async () => {
  const store = secureStore({ initialRecord: record('wss://relay.example'), holdRead: true });
  const fix = fixture({ secureStore: store });
  const first = fix.service.getState();
  const second = fix.service.getState();
  while (store.calls.get === 0) await Promise.resolve();
  assert.equal(store.calls.get, 1);
  store.releaseRead();
  const [firstState, secondState] = await Promise.all([first, second]);
  assert.equal(firstState.setup.loaded, true);
  assert.equal(secondState.setup.loaded, true);
  assert.equal(store.calls.get, 1);
});

test('getState does not start a store load while enable is starting', async () => {
  const store = secureStore({ initialRecord: record(), holdRead: true });
  const fix = fixture({ secureStore: store });
  const enabling = fix.service.enable();
  while (store.calls.get === 0) await Promise.resolve();
  const reads = { ...store.calls };
  const state = await fix.service.getState();
  assert.equal(state.state, 'starting');
  assert.equal(state.setup.reason, 'not_off');
  assert.deepEqual(store.calls, reads);
  store.releaseRead();
  assert.equal((await enabling).reason, 'relay_not_set');
});

test('forget success suppresses read hydration until an owner operation loads again', async () => {
  const fix = fixture({ record: record('wss://relay.example') });
  await fix.service.getState();
  assert.equal((await fix.service.forgetAll()).ok, true);
  const reads = { ...fix.store.calls };
  const state = await fix.service.getState();
  assert.equal(state.setup.reason, 'store_not_loaded');
  assert.deepEqual(fix.store.calls, reads);
  assert.equal((await fix.service.setRelay('wss://relay.example')).ok, true);
  assert.equal(fix.store.calls.has, reads.has + 1);
  assert.equal(fix.service.status().setup.loaded, true);
});

test('forget failure remains the first blocking setup gate', async () => {
  const store = secureStore({ initialRecord: record('wss://relay.example'), deleteError: true });
  const fix = fixture({ secureStore: store });
  assert.equal((await fix.service.forgetAll()).reason, 'forget_not_deleted');
  const state = await fix.service.getState();
  assert.deepEqual(state.setup, {
    loaded: false, can_configure: false, can_enable: false, reason: 'forget_not_deleted',
  });
});

test('secure-store read failures remain authoritative through enable', async () => {
  const store = secureStore({ initialRecord: record('wss://relay.example'), readError: true });
  const fix = fixture({ secureStore: store });
  assert.equal((await fix.service.getState()).setup.reason, 'secure_store_error');
  assert.deepEqual(await fix.service.enable(), { ok: false, reason: 'secure_store_error' });
  assert.equal(fix.service.status().setup.reason, 'secure_store_error');
});

test('setup gate precedence is feature, plugin, then relay configuration', async () => {
  const fix = fixture({ record: record(), feature: false, plugin: false });
  assert.equal((await fix.service.getState()).setup.reason, 'feature_disabled');
  fix.flags.remote_control = true;
  assert.equal(fix.service.status().setup.reason, 'plugin_inactive');
  fix.authority.plugin = true;
  assert.deepEqual(fix.service.status().setup, {
    loaded: true, can_configure: true, can_enable: false, reason: 'relay_not_set',
  });
});

test('runtime availability gates preserve relay configuration authority', async () => {
  const noWebSocket = fixture({ record: record('wss://relay.example'), websocket: false });
  assert.deepEqual((await noWebSocket.service.getState()).setup, {
    loaded: true, can_configure: true, can_enable: false, reason: 'websocket_unavailable',
  });
  const noWindow = fixture({ record: record('wss://relay.example'), window: false });
  assert.deepEqual((await noWindow.service.getState()).setup, {
    loaded: true, can_configure: true, can_enable: false, reason: 'window_unavailable',
  });
});

test('onChanged notifications include the authoritative setup projection', async () => {
  const fix = fixture();
  const snapshots = [];
  fix.service.onChanged((state) => snapshots.push(state));
  assert.equal((await fix.service.setRelay('wss://relay.example')).ok, true);
  assert.deepEqual(snapshots.at(-1).setup, {
    loaded: true, can_configure: true, can_enable: true, reason: '',
  });
});
