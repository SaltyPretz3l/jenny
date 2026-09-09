'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('../services/remote/remote-crypto');
const contracts = require('../services/remote/remote-contracts');
const { createControlLeases } = require('../services/remote/remote-control-leases');
const { createEventBuffer } = require('../services/remote/remote-event-buffer');
const { createRemoteChatAdapter } = require('../services/remote/remote-chat-adapter');
const { createCommandRouter } = require('../services/remote/remote-command-router');
const limits = require('../services/remote/remote-limits');
const { createRemoteControlService } = require('../services/remote/remote-control-service');

function fakeClock() {
  let time = 1_000;
  let next = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) { const id = next++; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, item]) => item.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      time = target;
    },
  };
}

function secureStore() {
  let record = null;
  return {
    hasRemoteControlRecord: async () => record !== null,
    getRemoteControlRecord: async () => structuredClone(record),
    setRemoteControlRecord: async (value) => { record = structuredClone(value); },
    deleteRemoteControlRecord: async () => { record = null; },
  };
}

function backend(sessions = new Map()) {
  const emitter = new EventEmitter();
  emitter.sessionStore = { getSession: (id) => sessions.get(id) || null };
  emitter.listSessions = async () => [...sessions.values()];
  emitter.getSessionMessages = async () => [];
  emitter.getActiveTurnState = async () => null;
  emitter.cancelChatStream = () => true;
  emitter.pendingToolApprovals = new Map();
  emitter.pendingUserQuestions = new Map();
  return emitter;
}

function fixture(options = {}) {
  const clock = fakeClock();
  const sessions = options.sessions || new Map([
    ['chat-1', { id: 'chat-1', title: 'Chat', session_type: 'chat', archived_at: null }],
  ]);
  const backendService = backend(sessions);
  const relayInstances = [];
  const peerInstances = [];
  const emitted = [];
  const flagState = { remote_control: options.flag !== false, ...(options.featureFlags || {}) };
  let cancellationRegistry;
  let activeLeases;
  let projectionEmit;
  const relayFactory = (input) => {
    let relayState = 'idle';
    const value = {
      input,
      sent: [],
      closedPeers: [],
      connect() {
        relayState = 'connecting';
        if (options.echoClaimToken) {
          relayState = 'closed';
          input.onStateChange('closed', input.routeToken);
        } else if (options.claim !== false) {
          relayState = 'claimed';
          input.onStateChange('claimed');
        }
        return true;
      },
      send(message) { value.sent.push(message); return options.sendResult !== false; },
      closePeer(id) { value.closedPeers.push(id); return true; },
      disconnect() { relayState = 'closed'; },
      getState: () => relayState,
      emitMessage: (message) => input.onMessage(message),
    };
    relayInstances.push(value);
    return value;
  };
  const peerFactory = (input) => {
    let peerState = 'handshaking';
    const peerIndex = peerInstances.length;
    const value = {
      connectionId: input.connectionId,
      epoch: input.epoch,
      deviceId: options.deviceIdFor?.(peerIndex) || 'device_id1',
      get state() { return peerState; },
      handleHs1: async () => true,
      handleFrame: options.handleFrame || (async () => null),
      sendPlaintext: async () => true,
      setLastAcked: () => true,
      settleCommand: () => {},
      close() { peerState = 'closed'; return true; },
      makeReady() { peerState = 'ready'; input.onReady(); },
    };
    peerInstances.push(value);
    return value;
  };
  const factories = {
    createRelayClient: relayFactory,
    createPeerSession: peerFactory,
    createRemoteChatAdapter(input) {
      cancellationRegistry = input.cancellations;
      return {
        listSessions: async () => ({ ok: true, sessions: [] }),
        createSession: async () => ({ ok: true, data: { id: 'new-chat' } }),
        transcriptPage: async () => ({ ok: true, data: { messages: [] } }),
        send: async () => ({ ok: true, data: {} }),
        stop: async () => ({ ok: true, data: {} }),
      };
    },
    createRemoteDecisionAdapter: () => ({
      pendingFor: () => ({ tool: [], questions: [], plan: [] }),
      decideTool: async () => ({ ok: true, data: {} }),
      decidePlan: async () => ({ ok: true, data: {} }),
      answerQuestions: async () => ({ ok: true, data: {} }),
      declineQuestions: async () => ({ ok: true, data: {} }),
    }),
    createRemoteEventProjector: (input) => {
      projectionEmit = input.emit;
      return {
        dispose() {},
        emit: input.emit,
      };
    },
    createCommandRouter: options.routerFactory || (() => ({ handle: async () => null })),
    createControlLeases(input) {
      activeLeases = createControlLeases(input);
      return activeLeases;
    },
    createEventBuffer,
    ...options.factories,
  };
  const service = createRemoteControlService({
    backendService,
    secureStore: options.secureStore || secureStore(),
    featureFlags: () => ({ ...flagState }),
    isPluginActive: () => options.plugin !== false,
    isWindowAlive: () => options.window !== false,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    portalOriginFor: () => 'https://relay.example',
    factories,
    log: (_level, _event, fields) => emitted.push(fields),
  });
  return {
    service, clock, backendService, relayInstances, peerInstances, sessions, emitted,
    flagState,
    leases: () => activeLeases,
    cancellations: () => cancellationRegistry,
    projectionEmit: () => projectionEmit,
  };
}

async function configureAndEnable(fix) {
  assert.equal((await fix.service.setRelay('wss://relay.example')).ok, true);
  return fix.service.enable();
}

test('enable reaches ready only after the relay claims the route', async () => {
  const fix = fixture();
  assert.equal((await configureAndEnable(fix)).ok, true);
  assert.equal(fix.service.status().state, 'ready');
  assert.equal(fix.service.status().reachable, true);
  assert.deepEqual(fix.service.status().setup, {
    loaded: true, can_configure: false, can_enable: false, reason: 'not_off',
  });
  assert.equal(fix.relayInstances.length, 1);
  await fix.service.dispose();
});

test('relay claim failures cannot place the route token in service state', async () => {
  const fix = fixture({ echoClaimToken: true });
  await fix.service.setRelay('wss://relay.example');
  assert.equal((await fix.service.enable()).reason, 'relay_error');
  const status = fix.service.status();
  const token = fix.relayInstances[0].input.routeToken;
  assert.equal(status.reason, 'relay_error');
  assert.equal(status.last_error.code, 'relay_error');
  assert.equal(JSON.stringify(status).includes(token), false);
});

test('each availability gate fails before building a relay', async () => {
  for (const option of [{ flag: false }, { plugin: false }, { window: false }]) {
    const fix = fixture(option);
    const result = await fix.service.enable();
    assert.equal(result.ok, false);
    assert.equal(fix.relayInstances.length, 0);
  }
});

test('relay claim timeout unwinds every allocated live resource', async () => {
  const fix = fixture({ claim: false });
  await fix.service.setRelay('wss://relay.example');
  const enabling = fix.service.enable();
  for (let index = 0; index < 20 && !fix.relayInstances.length; index += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.equal(fix.relayInstances.length, 1);
  fix.clock.advance(limits.RELAY_ONLINE_LEASE_MS);
  const result = await enabling;
  assert.equal(result.ok, false);
  assert.equal(fix.service.status().state, 'off');
  assert.equal(fix.service.status().epoch_active, false);
  assert.equal(fix.relayInstances[0].getState(), 'closed');
});

test('denyAdmission establishes all security invariants synchronously and is idempotent', async () => {
  let resolveFrame;
  let routerCalls = 0;
  const fix = fixture({
    handleFrame: () => new Promise((resolve) => { resolveFrame = resolve; }),
    routerFactory: () => ({ handle: async () => { routerCalls += 1; return null; } }),
  });
  await configureAndEnable(fix);
  const pair = fix.service.openPairing();
  assert.equal(pair.ok, true);
  fix.leases().request('chat-1', 'device_id1');
  const token = fix.cancellations().create({ sessionId: 'chat-1', deviceId: 'device_id1' });
  fix.relayInstances[0].emitMessage({ v: 1, kind: 'peer_open', connection_id: 'connect_1' });
  const peer = fix.peerInstances[0];
  peer.makeReady();
  fix.relayInstances[0].emitMessage({
    v: 1, route_id: 'route_id1', connection_id: 'connect_1', epoch: peer.epoch,
    seq: 1, ciphertext: 'abcd',
  });
  const first = fix.service.denyAdmission('test_disable');
  const second = fix.service.denyAdmission('test_disable');
  assert.equal(first, second);
  const snapshot = fix.service.status();
  assert.equal(snapshot.reachable, false);
  assert.equal(snapshot.epoch_active, false);
  assert.equal(snapshot.pairing, null);
  assert.equal(fix.leases().list().length, 0);
  assert.equal(token.signal.aborted, true);
  assert.equal(peer.state, 'closed');
  resolveFrame({ command: { operation: 'heartbeat' } });
  await first;
  assert.equal(routerCalls, 0);
  assert.equal(fix.service.status().state, 'off');
});

test('revocation persistence failure leaves remote unavailable', async () => {
  const store = {
    load: async () => ({ ok: true }),
    getRecord: () => ({
      relay_url: 'wss://relay.example', shared_sessions: [],
      devices: [{ device_id: 'device_id1', label: 'Phone', paired_at: 1, last_seen_at: 1 }],
    }),
    desktopSecret: () => crypto.randomSecret(),
    isDeviceTrusted: () => true,
    revokeDevice: async () => ({ ok: false, reason: 'revocation_not_saved' }),
    unshareSession: async () => ({ ok: true }),
    forgetAll: async () => ({ ok: true }),
  };
  const fix = fixture({ factories: { createDeviceStore: () => store } });
  await fix.service.enable();
  const result = await fix.service.revokeDevice('device_id1');
  assert.equal(result.reason, 'revocation_not_saved');
  assert.equal(fix.service.status().state, 'unavailable');
  assert.equal(fix.service.status().reachable, false);
});

test('setRelay is refused while live and sharing enforces chat visibility', async () => {
  const sessions = new Map([
    ['chat-1', { id: 'chat-1', title: 'Chat', session_type: 'chat', archived_at: null }],
    ['archived', { id: 'archived', title: 'Old', session_type: 'chat', archived_at: 1 }],
    ['plugin-1', { id: 'plugin-1', title: 'Plugin', session_type: 'plugin', archived_at: null }],
    ['locked-1', { id: 'locked-1', title: 'Locked', session_type: 'chat', archived_at: null, lockdown: true }],
  ]);
  const fix = fixture({ sessions, featureFlags: { session_offline_lockdown: true } });
  await configureAndEnable(fix);
  assert.equal((await fix.service.setRelay('wss://other.example')).reason, 'not_off');
  assert.equal((await fix.service.shareSession('archived')).ok, false);
  assert.equal((await fix.service.shareSession('plugin-1')).ok, false);
  assert.equal((await fix.service.shareSession('locked-1')).ok, false);
  assert.equal((await fix.service.shareSession('missing')).ok, false);
  assert.equal((await fix.service.shareSession('chat-1')).ok, true);
  await fix.service.dispose();
});

test('takeControl revokes a phone lease and dispose is safe from off and ready', async () => {
  const fix = fixture();
  await fix.service.setRelay('wss://relay.example');
  await fix.service.shareSession('chat-1');
  await fix.service.enable();
  fix.leases().request('chat-1', 'device_id1');
  assert.equal(fix.leases().holderOf('chat-1'), 'device_id1');
  assert.equal(fix.service.takeControl('chat-1').ok, true);
  assert.equal(fix.leases().holderOf('chat-1'), null);
  await fix.service.dispose();
  assert.equal(fix.service.status().state, 'off');
  const off = fixture();
  await off.service.dispose();
  assert.equal(off.service.status().state, 'off');
});

test('failed forget-all remains a sticky enable denial until deletion succeeds', async () => {
  let forgetAttempts = 0;
  const store = {
    getRecord: () => null,
    forgetAll: async () => {
      forgetAttempts += 1;
      return forgetAttempts === 1
        ? { ok: false, reason: 'forget_not_deleted' } : { ok: true };
    },
  };
  const fix = fixture({ factories: { createDeviceStore: () => store } });
  assert.equal((await fix.service.forgetAll()).reason, 'forget_not_deleted');
  assert.equal(fix.service.status().state, 'unavailable');
  await fix.service.disable();
  assert.equal(fix.service.status().state, 'unavailable');
  assert.equal((await fix.service.enable()).reason, 'forget_not_deleted');
  assert.equal((await fix.service.forgetAll()).ok, true);
  assert.equal(fix.service.status().state, 'off');
});

test('forget-all blocks an overlapping enable before durable deletion settles', async () => {
  let releaseForget;
  const store = {
    getRecord: () => null,
    forgetAll: () => new Promise((resolve) => {
      releaseForget = () => resolve({ ok: false, reason: 'forget_not_deleted' });
    }),
  };
  const fix = fixture({ factories: { createDeviceStore: () => store } });
  const forgetting = fix.service.forgetAll();
  while (!releaseForget) await Promise.resolve();
  assert.equal((await fix.service.enable()).reason, 'forget_not_deleted');
  assert.equal(fix.relayInstances.length, 0);
  releaseForget();
  assert.equal((await forgetting).reason, 'forget_not_deleted');
  assert.equal(fix.service.status().state, 'unavailable');
});

test('event-driven lockdown aborts an unbound remote preflight token', async () => {
  const fix = fixture();
  await fix.service.setRelay('wss://relay.example');
  await fix.service.shareSession('chat-1');
  await fix.service.enable();
  const cancelled = [];
  fix.backendService.cancelChatStream = (streamId, cancelReason) => {
    cancelled.push([streamId, cancelReason]);
    return true;
  };
  fix.backendService.getActiveTurnState = async () => ({ stream_id: 'stream_01' });
  const token = fix.cancellations().create({ sessionId: 'chat-1', deviceId: 'device_id1' });
  fix.sessions.get('chat-1').lockdown = true;
  fix.flagState.session_offline_lockdown = true;
  fix.projectionEmit()(contracts.buildEvent({
    eventSeq: 1,
    type: 'complete',
    sessionId: 'chat-1',
    payload: { status: 'done', replaces_stream_text: false },
  }));
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(token.signal.aborted, true);
  assert.deepEqual(cancelled, []);
  await fix.service.dispose();
});

test('runtime construction failure rolls back its terminal listener and relay', async () => {
  const fix = fixture({
    factories: {
      createRemoteEventProjector() {
        throw new Error('projector_boom');
      },
    },
  });
  const result = await configureAndEnable(fix);
  assert.equal(result.ok, false);
  assert.equal(fix.backendService.listenerCount('chat-stream'), 0);
  assert.equal(fix.relayInstances[0].getState(), 'closed');
  assert.equal(fix.service.status().state, 'off');
});

test('a throwing runtime dispose cannot strand relay cleanup or service state', async () => {
  const fix = fixture({
    factories: {
      createLiveRuntime() {
        let admitted = true;
        return {
          denyAdmission() { admitted = false; },
          dispose: async () => { throw new Error('dispose_boom'); },
          isAdmitted: () => admitted,
          hasGrant: () => false,
          suppressGrant() {},
          leases: { controllerOf: () => null },
          peers: { values: () => [][Symbol.iterator]() },
          onRelayMessage() {},
        };
      },
    },
  });
  assert.equal((await configureAndEnable(fix)).ok, true);
  await fix.service.disable();
  assert.equal(fix.relayInstances[0].getState(), 'closed');
  assert.equal(fix.service.status().state, 'off');
});

test('device revocation aborts its unbound preflight tokens before persistence', async () => {
  const fix = fixture();
  await configureAndEnable(fix);
  const token = fix.cancellations().create({
    sessionId: 'chat-1',
    deviceId: 'device_id1',
  });
  const revoking = fix.service.revokeDevice('device_id1');
  assert.equal(token.signal.aborted, true);
  await revoking;
  await fix.service.dispose();
});

test('disable during a suspended real-adapter stop prevents backend cancellation', async () => {
  let leaseId;
  let resolveActive;
  const cancelCalls = [];
  const record = {
    relay_url: 'wss://relay.example',
    shared_sessions: ['chat-1'],
    devices: [{ device_id: 'device_id1', label: 'Phone', paired_at: 1, last_seen_at: 1 }],
  };
  const store = {
    load: async () => ({ ok: true }),
    getRecord: () => record,
    desktopSecret: () => crypto.randomSecret(),
    isDeviceTrusted: (id) => id === 'device_id1',
    addDevice: async () => ({ ok: true }),
    revokeDevice: async () => ({ ok: true }),
    unshareSession: async () => ({ ok: true }),
  };
  const fix = fixture({
    handleFrame: async () => ({
      command: {
        v: 1,
        kind: 'command',
        request_id: 'stop_after_off',
        operation: 'chat.stop',
        session_id: contracts.toWireSessionId('chat-1'),
        control_lease: leaseId,
        payload: {},
      },
    }),
    factories: {
      createDeviceStore: () => store,
      createRemoteChatAdapter,
      createCommandRouter,
    },
  });
  assert.deepEqual(await fix.service.enable(), { ok: true });
  fix.relayInstances[0].emitMessage({
    v: 1, kind: 'peer_open', connection_id: 'connect_stop',
  });
  fix.peerInstances[0].makeReady();
  leaseId = fix.leases().request('chat-1', 'device_id1').lease.lease_id;
  fix.backendService.getActiveTurnState = () => new Promise((resolve) => { resolveActive = resolve; });
  fix.backendService.cancelChatStream = (...args) => { cancelCalls.push(args); return true; };
  const dispatch = fix.relayInstances[0].emitMessage({
    v: 1, route_id: 'route_id1', connection_id: 'connect_stop',
    epoch: fix.peerInstances[0].epoch, seq: 1, ciphertext: 'abcd',
  });
  while (!resolveActive) await Promise.resolve();
  await fix.service.disable();
  resolveActive({ stream_id: 'stream_after_off' });
  await dispatch;
  assert.deepEqual(cancelCalls, []);
});

test('a stale enable continuation cannot tear down the succeeding generation', async () => {
  let deriveCalls = 0;
  let releaseFirst;
  const cryptoOverride = {
    ...crypto,
    deriveRouteCredentials(secret) {
      deriveCalls += 1;
      if (deriveCalls > 1) return crypto.deriveRouteCredentials(secret);
      const retained = new Uint8Array(secret);
      return new Promise((resolve) => {
        releaseFirst = async () => resolve(await crypto.deriveRouteCredentials(retained));
      });
    },
  };
  const fix = fixture({ factories: { crypto: cryptoOverride } });
  await fix.service.setRelay('wss://relay.example');
  const first = fix.service.enable();
  while (!releaseFirst) await Promise.resolve();
  await fix.service.disable();
  assert.equal((await fix.service.enable()).ok, true);
  const currentRelay = fix.relayInstances.at(-1);
  const token = fix.cancellations().create({ sessionId: 'chat-1', deviceId: 'device_id1' });
  await releaseFirst();
  assert.equal((await first).ok, false);
  assert.equal(fix.service.status().state, 'ready');
  assert.equal(currentRelay.getState(), 'claimed');
  assert.equal(token.signal.aborted, false);
  await fix.service.disable();
  assert.equal(token.signal.aborted, true);
});

test('a device is limited to two ready peer connections', async () => {
  const fix = fixture();
  await configureAndEnable(fix);
  for (let index = 0; index < 3; index += 1) {
    fix.relayInstances[0].emitMessage({
      v: 1,
      kind: 'peer_open',
      connection_id: `connect_${index}`,
    });
    fix.peerInstances[index].makeReady();
  }
  assert.equal(fix.peerInstances[2].state, 'closed');
  assert.ok(fix.relayInstances[0].closedPeers.includes('connect_2'));
  await fix.service.dispose();
});

test('the immutable runtime caps total peer allocation under a connection flood', async () => {
  const fix = fixture({
    deviceIdFor: (index) => `device_${String(index).padStart(2, '0')}`,
  });
  await configureAndEnable(fix);
  for (let index = 0; index < 25; index += 1) {
    const before = fix.peerInstances.length;
    fix.relayInstances[0].emitMessage({
      v: 1,
      kind: 'peer_open',
      connection_id: `connect_${String(index).padStart(2, '0')}`,
    });
    if (fix.peerInstances.length > before) fix.peerInstances.at(-1).makeReady();
  }
  assert.equal(fix.peerInstances.length, (limits.MAX_DEVICES * 2) + 2);
  assert.equal(fix.relayInstances[0].closedPeers.length, 13);
  await fix.service.dispose();
});
