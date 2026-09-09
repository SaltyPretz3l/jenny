'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerRemoteIpc } = require('../services/main/remote-ipc-registration');

const INVOKES = Object.freeze({
  getState: 'remote.getState',
  enable: 'remote.enable',
  disable: 'remote.disable',
  openPairing: 'remote.openPairing',
  revokeDevice: 'remote.revokeDevice',
  forgetAll: 'remote.forgetAll',
  setRelay: 'remote.setRelay',
  shareSession: 'remote.shareSession',
  unshareSession: 'remote.unshareSession',
  takeControl: 'remote.takeControl',
});

function createIpcMain() {
  const handlers = new Map();
  const removed = [];
  return {
    handlers,
    removed,
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { removed.push(channel); handlers.delete(channel); },
  };
}

function createHarness({ secureStore = {}, lifecycle = {}, facadeOverrides = {} } = {}) {
  const ipcMain = createIpcMain();
  const calls = [];
  const bridgeEvents = [];
  const logs = [];
  const wiringState = { disposed: 0, unsubscribed: 0, pluginSource: null, listener: null };
  lifecycle.registerShutdownFence ||= () => () => {};
  lifecycle.registerShutdownTask ||= () => () => {};
  const pairingUrl = 'https://remote.example/#p=pairing_123.secret_123.route_123';
  let currentPairing = null;
  const facade = {
    status: () => ({ state: 'off', pairing: currentPairing }),
    getState: async () => ({ state: 'off', pairing: currentPairing }),
    enable: async () => ({ ok: true, operation: 'enable' }),
    disable: async () => ({ ok: true, operation: 'disable' }),
    openPairing: () => {
      currentPairing = { pairing_id: 'pairing_123', url: pairingUrl, expires_at: 10 };
      return { ok: true, pairing: currentPairing };
    },
    revokeDevice: async (value) => ({ ok: true, value }),
    forgetAll: async () => ({ ok: true, operation: 'forgetAll' }),
    setRelay: async (value) => ({ ok: true, value }),
    shareSession: async (value) => ({ ok: true, value }),
    unshareSession: async (value) => ({ ok: true, value }),
    takeControl: (value) => ({ ok: true, value }),
    onChanged(listener) {
      wiringState.listener = listener;
      return () => { wiringState.unsubscribed += 1; };
    },
    ...facadeOverrides,
  };
  for (const name of Object.keys(INVOKES)) {
    const original = facade[name];
    facade[name] = (...args) => {
      calls.push({ name, args });
      return original(...args);
    };
  }
  const registration = registerRemoteIpc(ipcMain, {
    backendService: {},
    secureStore,
    shellConfigService: {},
    env: {},
    mainLifecycle: lifecycle,
    getMainWindow: () => null,
    sendBridgeEvent: (...args) => bridgeEvents.push(args),
    log: (...args) => logs.push(args),
    createWiring(deps) {
      wiringState.pluginSource = deps.pluginStateSource;
      return { facade, dispose: async () => { wiringState.disposed += 1; } };
    },
  });
  const invoke = (name, payload) => ipcMain.handlers.get(
    getBridgeChannel(INVOKES[name], 'invoke')
  )({}, payload);
  return {
    ipcMain, calls, bridgeEvents, logs, wiringState, registration, invoke, pairingUrl,
  };
}

test('registers every invoke, routes exact payloads, and removes them on idempotent teardown', async () => {
  const fix = createHarness();
  assert.equal(fix.ipcMain.handlers.size, 10);
  assert.deepEqual(await fix.invoke('getState'), { state: 'off', pairing: null });
  assert.equal(fix.calls[0].name, 'getState');
  assert.equal((await fix.invoke('enable', {})).operation, 'enable');
  assert.equal((await fix.invoke('disable', {})).operation, 'disable');
  assert.equal((await fix.invoke('revokeDevice', { device_id: 'device_123' })).value, 'device_123');
  assert.equal((await fix.invoke('forgetAll', { confirm: true })).operation, 'forgetAll');
  assert.equal((await fix.invoke('setRelay', { relay_url: 'wss://relay.example' })).value, 'wss://relay.example');
  assert.equal((await fix.invoke('shareSession', { session_id: 'session-1' })).value, 'session-1');
  assert.equal((await fix.invoke('unshareSession', { session_id: '' })).value, '');
  assert.equal((await fix.invoke('takeControl', { session_id: 'session-1' })).value, 'session-1');
  assert.equal(fix.registration.getFacade() != null, true);

  await fix.registration.teardown();
  await fix.registration.teardown();
  assert.equal(fix.ipcMain.handlers.size, 0);
  assert.equal(fix.ipcMain.removed.length, 10);
  assert.equal(fix.wiringState.unsubscribed, 1);
  assert.equal(fix.wiringState.disposed, 1);
});

test('rejects every malformed payload without calling the facade', async () => {
  const fix = createHarness();
  const cases = [
    ['getState', {}],
    ['enable', undefined],
    ['disable', { extra: true }],
    ['openPairing', []],
    ['revokeDevice', { device_id: 'short' }],
    ['revokeDevice', { device_id: Symbol('hostile') }],
    ['revokeDevice', { device_id: 'device_123', extra: true }],
    ['forgetAll', { confirm: false }],
    ['setRelay', { relay_url: 'x'.repeat(513) }],
    ['shareSession', { session_id: 'x'.repeat(129) }],
    ['unshareSession', { session_id: 1 }],
    ['takeControl', null],
    ['takeControl', Object.defineProperty({}, 'session_id', {
      enumerable: true,
      get() { throw new Error('hostile getter'); },
    })],
  ];
  for (const [name, payload] of cases) {
    assert.deepEqual(await fix.invoke(name, payload), { ok: false, reason: 'invalid_request' });
  }
  assert.deepEqual(fix.calls, []);
  await fix.registration.teardown();
});

test('decorates pairing responses and pushed state without logging credential URLs', async () => {
  const fix = createHarness();
  const opened = await fix.invoke('openPairing', {});
  assert.match(opened.pairing.qr_svg, /^<svg /);
  const refreshed = await fix.invoke('getState');
  assert.equal(refreshed.pairing.qr_svg, opened.pairing.qr_svg);
  fix.wiringState.listener({
    state: 'ready',
    pairing: { pairing_id: 'pairing_123', url: fix.pairingUrl, expires_at: 10 },
  });
  assert.equal(fix.bridgeEvents.length, 1);
  assert.equal(fix.bridgeEvents[0][0], 'remote.onStateChanged');
  assert.equal(fix.bridgeEvents[0][1].pairing.qr_svg, opened.pairing.qr_svg);
  assert.equal(JSON.stringify(fix.logs).includes(fix.pairingUrl), false);
  await fix.registration.teardown();
});

test('bridge wrapper forwards unchanged and refreshes attached plugin state', async () => {
  const fix = createHarness();
  let refreshes = 0;
  fix.wiringState.pluginSource.subscribe(() => {
    refreshes += 1;
    void fix.wiringState.pluginSource.getState();
  });
  let stateReads = 0;
  fix.registration.attachPluginService({
    getState: async () => { stateReads += 1; return { plugins: [] }; },
  });
  const calls = [];
  const wrapped = fix.registration.wrapBridgeEvents((...args) => {
    calls.push(args);
    return 'forwarded';
  });
  assert.equal(wrapped('features.onChanged', { value: 1 }), 'forwarded');
  assert.equal(wrapped('plugins.onChanged', { value: 2 }), 'forwarded');
  await Promise.resolve();
  assert.deepEqual(calls, [
    ['features.onChanged', { value: 1 }],
    ['plugins.onChanged', { value: 2 }],
  ]);
  assert.equal(refreshes, 2);
  assert.equal(stateReads, 2);
  await fix.registration.teardown();
});

test('missing secure store or lifecycle keeps handlers available with one unavailable log', async () => {
  const ipcMain = createIpcMain();
  const logs = [];
  const registration = registerRemoteIpc(ipcMain, {
    secureStore: null,
    mainLifecycle: null,
    log: (...args) => logs.push(args),
  });
  const getState = ipcMain.handlers.get(getBridgeChannel('remote.getState', 'invoke'));
  const enable = ipcMain.handlers.get(getBridgeChannel('remote.enable', 'invoke'));
  assert.deepEqual(await getState({}, undefined), {
    state: 'unavailable', reachable: false, reason: 'remote_unavailable', relay_host: '',
    epoch_active: false, pairing: null, devices: [], shared_sessions: [], last_error: null,
    setup: {
      loaded: false, can_configure: false, can_enable: false, reason: 'remote_unavailable',
    },
  });
  assert.deepEqual(await enable({}, {}), { ok: false, reason: 'remote_unavailable' });
  assert.deepEqual(await enable({}, {}), { ok: false, reason: 'remote_unavailable' });
  assert.equal(logs.filter((entry) => entry[1] === 'remote.ipc_unavailable').length, 1);
  await registration.teardown();
});
