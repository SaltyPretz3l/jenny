'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const remoteCrypto = require('../services/remote/remote-crypto');
const contracts = require('../services/remote/remote-contracts');
const { createRemoteControlService } = require('../services/remote/remote-control-service');

const ROOT = path.resolve(__dirname, '..');
const vectors = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'remote', 'crypto-vectors.json'),
  'utf8'
));

function unrefTimer(callback, delay) {
  const timer = setTimeout(callback, delay);
  timer.unref();
  return timer;
}

function withTimeout(promise, delay = 2_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('protocol_timeout')), delay);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loadPortalConnection() {
  const built = buildSync({
    absWorkingDir: ROOT,
    entryPoints: ['remote/portal/portal-connection.js'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    write: false,
  }).outputFiles[0].text;
  const filename = path.join(ROOT, '.tmp-portal-connection.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = module.paths;
  loaded._compile(built, filename);
  return loaded.exports;
}

function waitFor(predicate, label) {
  return withTimeout((async () => {
    while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
    return predicate();
  })(), 2_000).catch((error) => {
    error.message = `${label}: ${error.message}`;
    throw error;
  });
}

function portalProbe() {
  const sockets = [];
  const timers = new Map();
  const snapshots = [];
  const states = [];
  let timerId = 0;
  let requestId = 0;
  let blockOpen = null;
  let blockSeal = null;
  let openStarted = 0, sealStarted = 0;
  const route = vectors.route_credentials;
  const pairingId = 'pairing_probe_1234';
  const connectionId = 'connection_probe_1234';
  const epoch = 'epoch_probe_1234';
  const secretText = route.desktop_secret;
  let record = null;
  let mutation = Promise.resolve();
  let releaseSave = null;

  class ProbeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      this.listeners = new Map();
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); });
    }
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    emit(name, event) { for (const callback of this.listeners.get(name) || []) callback(event); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close(code, reason) { this.readyState = 3; this.closed = { code, reason }; }
    serverClose() { this.readyState = 3; this.emit('close', { code: 1006 }); }
  }

  const fakeCrypto = {
    ...remoteCrypto,
    randomId: () => `request_probe_${++requestId}`,
    generateEphemeral: async () => ({
      publicKey: new Uint8Array(32), privateKey: { type: 'private' },
    }),
    deriveHandshake: async () => ({
      sendKey: 'send-key', recvKey: 'receive-key', transcriptHash: new Uint8Array(32),
    }),
    proveHandshake: async () => new Uint8Array(32),
    sealFrame: async ({ plaintext, counter }) => {
      if (blockSeal && counter >= 1) { sealStarted += 1; await blockSeal; }
      return plaintext;
    },
    openFrame: async ({ ciphertext }) => {
      if (blockOpen) { openStarted += 1; await blockOpen; }
      return ciphertext;
    },
  };
  const enqueue = (operation) => {
    const current = mutation.then(operation, operation);
    mutation = current.then(() => undefined, () => undefined);
    return current;
  };
  const store = {
    getCredential: async () => record && {
      route_id: record.route_id, device_id: record.device_id,
      label: record.label, relay_origin: record.relay_origin,
    },
    saveCredential: (value) => enqueue(async () => {
      if (releaseSave) await new Promise((resolve) => { releaseSave.resolve = resolve; });
      record = {
        route_id: value.routeId, device_id: value.deviceId, label: value.label,
        relay_origin: value.relayOrigin, secret: value.secret.slice(),
      };
      return store.getCredential();
    }),
    withDeviceSecret: async (callback) => callback(record.secret.slice()),
    forgetThisPhone: () => enqueue(async () => { record = null; }),
  };
  const clock = {
    setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    runDelay(delay) {
      const found = [...timers].find(([, entry]) => entry.delay === delay);
      if (!found) return false;
      timers.delete(found[0]);
      found[1].callback();
      return true;
    },
  };
  const { createPortalConnection } = loadPortalConnection();
  const portal = createPortalConnection({
    crypto: fakeCrypto,
    contracts,
    store,
    location: {
      host: 'relay.test', pathname: '/', search: '',
      hash: `#p=${pairingId}.${secretText}.${route.route_id}`,
    },
    history: { state: null, replaceState() {} },
    navigator: { userAgent: 'Mobile Safari' },
    WebSocketCtor: ProbeSocket,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onState: (state) => states.push(state),
    onSnapshot: async (snapshot) => snapshots.push(structuredClone(snapshot)),
  });

  function emitPlain(socket, seq, value) {
    socket.emit('message', { data: JSON.stringify({
      v: 1, route_id: route.route_id, connection_id: connectionId, epoch, seq,
      ciphertext: remoteCrypto.toBase64Url(Buffer.from(JSON.stringify(value))),
    }) });
  }
  async function handshake(socket, head = 5, includeSecret = true) {
    await waitFor(() => socket.sent[0]?.kind === 'join', 'join');
    socket.emit('message', { data: JSON.stringify({ v: 1, kind: 'joined', connection_id: connectionId }) });
    await waitFor(() => socket.sent.some((item) => item.kind === 'hs1'), 'hs1');
    socket.emit('message', { data: JSON.stringify({
      v: 1, kind: 'hs2', connection_id: connectionId,
      eph_pub: remoteCrypto.toBase64Url(new Uint8Array(32)), epoch,
    }) });
    await waitFor(() => socket.sent.some((item) => item.seq === 0), 'hs proof');
    emitPlain(socket, 0, {
      v: 1, kind: 'hs_ok', device_id: 'device_probe_1234',
      access_expires_at: Date.now() + 600_000, event_seq_head: head,
      ...(includeSecret ? { device_secret: secretText } : {}),
    });
  }
  function commands(socket) {
    return socket.sent.filter((item) => !item.kind && item.seq >= 1).map((item) => (
      JSON.parse(Buffer.from(item.ciphertext, 'base64url').toString('utf8'))
    ));
  }
  return {
    portal, sockets, timers, snapshots, states, store, clock, emitPlain, handshake, commands,
    route, connectionId, epoch,
    suspendSave() {
      releaseSave = {};
      return async () => {
        await waitFor(() => typeof releaseSave.resolve === 'function', 'save suspension');
        releaseSave.resolve();
      };
    },
    record: () => record,
    blockFrames() {
      let release;
      blockOpen = new Promise((resolve) => { release = resolve; });
      return () => { blockOpen = null; release(); };
    },
    blockSends() {
      let release;
      blockSeal = new Promise((resolve) => { release = resolve; });
      return () => { blockSeal = null; release(); };
    },
    openStarted: () => openStarted,
    sealStarted: () => sealStarted,
  };
}

function portalMemoryStore() {
  let record = null;
  return {
    async getCredential() {
      if (!record) return null;
      const { secret, ...metadata } = record;
      return structuredClone(metadata);
    },
    async saveCredential({ routeId, deviceId, label, relayOrigin, secret }) {
      record = {
        route_id: routeId, device_id: deviceId, label, relay_origin: relayOrigin, secret: secret.slice(),
      };
      const { secret: ignored, ...metadata } = record;
      return structuredClone(metadata);
    },
    async withDeviceSecret(callback) {
      const secret = record.secret.slice();
      try { return await callback(secret); } finally { secret.fill(0); }
    },
    async forgetThisPhone() { record = null; },
  };
}

function desktopDeviceStore(sessionId) {
  const route = vectors.route_credentials;
  const record = { relay_url: 'wss://relay.test', shared_sessions: [sessionId], devices: [] };
  return {
    load: async () => ({ ok: true }),
    getRecord: () => structuredClone(record),
    desktopSecret: () => remoteCrypto.fromBase64Url(route.desktop_secret),
    deviceSecret(deviceId) {
      const device = record.devices.find((candidate) => candidate.device_id === deviceId);
      return device ? remoteCrypto.fromBase64Url(device.device_secret) : null;
    },
    isDeviceTrusted: (deviceId) => record.devices.some((device) => device.device_id === deviceId),
    async addDevice(device) {
      record.devices.push({
        device_id: device.device_id,
        device_secret: remoteCrypto.toBase64Url(device.device_secret),
        label: device.label,
        paired_at: Date.now(),
        last_seen_at: Date.now(),
      });
      return { ok: true };
    },
    touchDevice: async () => ({ ok: true }),
    shareSession: async () => ({ ok: true }),
    unshareSession: async () => ({ ok: true }),
    revokeDevice: async () => ({ ok: true }),
    forgetAll: async () => ({ ok: true }),
    setRelayUrl: async () => ({ ok: true }),
  };
}

test('real RemoteControlService pairs and routes commands, events, and denial', async () => {
  const shim = await import('../remote/relay/test/relay-room.test.js');
  shim.installCloudflareShim();
  const route = vectors.route_credentials;
  const { room } = shim.makeRoom(route.route_id, Date.now());

  class RelaySocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = new Map();
      queueMicrotask(async () => {
        const parsed = new URL(url);
        const response = await room.fetch(new Request(
          `https://${parsed.host}${parsed.pathname}${parsed.search}`,
          { headers: { Upgrade: 'websocket' } }
        ));
        this.server = response.webSocket.peer;
        this.server.send = (text) => this.emit('message', { data: text });
        this.server.close = (code, reason) => {
          this.server.readyState = 3;
          this.readyState = 3;
          this.emit('close', { code, reason });
        };
        this.readyState = 1;
        this.emit('open', {});
      });
    }

    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    }

    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    emit(name, event) { for (const callback of this.listeners.get(name) || []) callback(event); }
    send(text) { void room.webSocketMessage(this.server, text); }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.server.readyState = 3;
      void room.webSocketClose(this.server);
      this.emit('close', { code: 1000 });
    }
    get bufferedAmount() { return 0; }
  }

  const session = {
    id: 'session_test_1234',
    title: 'Shared',
    session_type: 'chat',
    archived_at: null,
    lockdown: false,
    plan_mode: false,
    preferred_model: 'local-model',
    reasoning_effort: 'medium',
    context_preferences: {},
    run_mode: 'ask',
    tool_category_overrides: {},
  };
  const backend = new EventEmitter();
  backend.sessionStore = { getSession: (id) => (id === session.id ? session : null) };
  backend.pendingToolApprovals = new Map();
  backend.pendingUserQuestions = new Map();
  backend.listSessions = async () => ({ data: [session] });
  backend.createSession = async () => ({ data: session });
  backend.getSessionMessages = async () => [];
  backend.getActiveTurnState = async () => ({ stream_id: 'stream_test_1234' });
  let cancelled = 0;
  backend.cancelChatStream = async () => { cancelled += 1; return true; };

  const service = createRemoteControlService({
    backendService: backend,
    secureStore: {},
    featureFlags: () => ({ remote_control: true, session_offline_lockdown: true }),
    isPluginActive: () => true,
    isWindowAlive: () => true,
    now: Date.now,
    setTimer: unrefTimer,
    clearTimer: clearTimeout,
    WebSocketCtor: RelaySocket,
    portalOriginFor: () => 'https://relay.test',
    factories: { createDeviceStore: () => desktopDeviceStore(session.id) },
  });
  let portal = null;
  try {
    assert.equal((await withTimeout(service.enable())).ok, true);
    const pairing = service.openPairing();
    assert.equal(pairing.ok, true);
    const pairingUrl = new URL(pairing.pairing.url);
    const historyCalls = [];
    const portalEvents = [];
    const { createPortalConnection } = loadPortalConnection();
    portal = createPortalConnection({
      crypto: remoteCrypto,
      contracts,
      store: portalMemoryStore(),
      location: {
        host: pairingUrl.host,
        pathname: pairingUrl.pathname,
        search: pairingUrl.search,
        hash: pairingUrl.hash,
      },
      history: { state: null, replaceState: (...args) => historyCalls.push(args) },
      navigator: { userAgent: 'Mobile Safari' },
      WebSocketCtor: RelaySocket,
      setTimer: unrefTimer,
      clearTimer: clearTimeout,
      onEvent: (event) => portalEvents.push(event),
    });
    await portal.start();
    await withTimeout(portal.waitUntilReady());
    assert.equal(historyCalls.length, 1);
    assert.equal(historyCalls[0][2], '/');

    const sessions = await withTimeout(portal.sendCommand('session.list', null, {}));
    assert.equal(sessions.ok, true);
    assert.equal(sessions.data.sessions[0].id, session.id);
    const stopped = await withTimeout(portal.sendCommand('chat.stop', session.id, {}));
    assert.equal(stopped.ok, true);
    assert.equal(cancelled, 1);

    backend.emit('chat-stream', {
      type: 'delta', sessionId: session.id, streamId: 'stream_test_1234', content: 'hello from Jenny',
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(portalEvents.at(-1).payload.text, 'hello from Jenny');

    const denial = service.denyAdmission('test_denial');
    assert.equal(service.status().reachable, false);
    await denial;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.notEqual(portal.getState(), 'ready');
  } finally {
    portal?.disconnect();
    await service.dispose();
  }
});

test('forget fences an in-flight pairing save and leaves no credential or timer', async () => {
  const probe = portalProbe();
  const releaseSave = probe.suspendSave();
  await probe.portal.start();
  await waitFor(() => probe.sockets.length === 1, 'portal socket');
  await probe.handshake(probe.sockets[0]);
  await waitFor(() => probe.states.includes('proof_pending'), 'proof pending');
  const forgetting = probe.portal.forgetThisPhone();
  await releaseSave();
  await forgetting;
  await waitFor(() => probe.portal.getState() === 'pairing_required', 'pairing required');
  assert.equal(probe.record(), null);
  assert.equal(probe.timers.size, 0);
  assert.equal(probe.portal.getDeviceId(), null);
});

test('snapshot reconciliation applies head-equal state and recovers truncated replay before cursor', async () => {
  const probe = portalProbe();
  await probe.portal.start();
  await waitFor(() => probe.sockets.length === 1, 'first socket');
  const first = probe.sockets[0];
  await probe.handshake(first, 5);
  await waitFor(() => probe.portal.getState() === 'ready', 'first ready');
  probe.emitPlain(first, 1, {
    v: 1, kind: 'event', event_seq: 5, type: 'session_shared',
    session_id: 'session_probe_1234',
    payload: {
      event_seq_head: 5,
      sessions: [{
        session_id: 'session_probe_1234',
        transcript: { messages: [{ id: 'message_1', role: 'assistant', content: 'snapshot' }] },
        active_turn: { stream_id: 'stream_probe_1234', turn_id: '', status: 'running' },
        pending: { tool: [{ approval_id: 'approval_probe_1234' }], questions: [], plan: [] },
      }],
    },
  });
  await waitFor(() => probe.snapshots.length === 1, 'initial snapshot');
  assert.equal(probe.portal.getLastEventSeq(), 5);
  assert.equal(probe.snapshots[0].sessions[0].id, 'session_probe_1234');
  assert.equal(probe.snapshots[0].transcripts[0].page.messages[0].content, 'snapshot');
  assert.equal(probe.snapshots[0].pending[0].active_turn.status, 'running');

  first.serverClose();
  assert.equal(probe.clock.runDelay(1_000), true);
  await waitFor(() => probe.sockets.length === 2, 'reconnect socket');
  const second = probe.sockets[1];
  await probe.handshake(second, 10, false);
  await waitFor(() => probe.portal.getState() === 'ready', 'reconnect ready');
  probe.emitPlain(second, 1, {
    v: 1, kind: 'event', event_seq: 10, type: 'session_shared',
    session_id: 'session_probe_1234',
    payload: { event_seq_head: 10, sessions: [{
      session_id: 'session_probe_1234', transcript: null, active_turn: null,
      pending: { tool: [], questions: [], plan: [] },
    }] },
  });
  await waitFor(() => probe.commands(second).some((item) => item.operation === 'resync'), 'resync');
  assert.equal(probe.portal.getLastEventSeq(), 5);
  const resync = probe.commands(second).find((item) => item.operation === 'resync');
  probe.emitPlain(second, 2, {
    v: 1, kind: 'result', request_id: resync.request_id, ok: true,
    data: {
      event_seq_head: 10,
      events: [],
      sessions: [{
        session_id: 'session_probe_1234', transcript: null, transcript_truncated: true,
        active_turn: null, pending: { tool: [], questions: [], plan: [] },
      }],
    },
  });
  await waitFor(() => probe.commands(second).some(
    (item) => item.operation === 'transcript.page'
  ), 'truncated transcript page');
  assert.equal(probe.portal.getLastEventSeq(), 5);
  const page = probe.commands(second).find((item) => item.operation === 'transcript.page');
  probe.emitPlain(second, 3, {
    v: 1, kind: 'event', event_seq: 11, type: 'delta',
    session_id: 'session_probe_1234', stream_id: 'stream_probe_1234', payload: { text: 'live' },
  });
  probe.emitPlain(second, 4, {
    v: 1, kind: 'result', request_id: page.request_id, ok: true,
    data: { messages: [{ id: 'message_2', role: 'assistant', content: 'recovered' }] },
  });
  await waitFor(() => probe.portal.getLastEventSeq() === 11, 'recovered cursor');
  assert.equal(probe.snapshots.at(-1).transcripts[0].page.messages[0].content, 'recovered');
  probe.portal.disconnect();
});

test('portal reserves inbound queue count and bytes before asynchronous frame opening', async () => {
  const probe = portalProbe();
  await probe.portal.start();
  await waitFor(() => probe.sockets.length === 1, 'portal socket');
  const socket = probe.sockets[0];
  await probe.handshake(socket, 0);
  await waitFor(() => probe.portal.getState() === 'ready', 'ready');
  probe.emitPlain(socket, 1, {
    v: 1, kind: 'event', event_seq: 0, type: 'session_shared',
    session_id: 'session_probe_1234', payload: { event_seq_head: 0, sessions: [] },
  });
  await waitFor(() => probe.snapshots.length === 1, 'snapshot');
  const release = probe.blockFrames();
  for (let index = 0; index < 17; index += 1) {
    probe.emitPlain(socket, 2, {
      v: 1, kind: 'event', event_seq: index + 1, type: 'delta',
      session_id: 'session_probe_1234', stream_id: 'stream_probe_1234', payload: { text: 'x' },
    });
  }
  assert.equal(socket.closed.reason, 'inbound_overflow');
  release();
  probe.portal.disconnect();

  const byteProbe = portalProbe();
  await byteProbe.portal.start();
  await waitFor(() => byteProbe.sockets.length === 1, 'byte probe socket');
  const byteSocket = byteProbe.sockets[0];
  await byteProbe.handshake(byteSocket, 0);
  await waitFor(() => byteProbe.portal.getState() === 'ready', 'byte probe ready');
  const releaseBytes = byteProbe.blockFrames();
  const largeFrame = JSON.stringify({
    v: 1,
    route_id: byteProbe.route.route_id,
    connection_id: byteProbe.connectionId,
    epoch: byteProbe.epoch,
    seq: 1,
    ciphertext: 'A'.repeat(800_000),
  });
  for (let index = 0; index < 3; index += 1) {
    byteSocket.emit('message', { data: largeFrame });
  }
  assert.equal(byteSocket.closed.reason, 'inbound_overflow');
  releaseBytes();
  byteProbe.portal.disconnect();
});

test('portal drops stale decrypt and seal continuations across reconnects', async () => {
  const inbound = portalProbe();
  await inbound.portal.start();
  await waitFor(() => inbound.sockets.length === 1, 'inbound socket');
  await inbound.handshake(inbound.sockets[0], 0);
  await waitFor(() => inbound.portal.getState() === 'ready', 'inbound ready');
  const releaseOpen = inbound.blockFrames();
  inbound.emitPlain(inbound.sockets[0], 1, {
    v: 1, kind: 'event', event_seq: 1, type: 'delta', session_id: 'session_probe_1234',
    stream_id: 'stream_probe_1234', payload: { text: 'old' },
  });
  await waitFor(() => inbound.openStarted() === 1, 'decrypt suspended');
  inbound.sockets[0].serverClose();
  assert.equal(inbound.clock.runDelay(1_000), true);
  await waitFor(() => inbound.sockets.length === 2, 'new inbound socket');
  releaseOpen();
  await inbound.handshake(inbound.sockets[1], 0, false);
  await waitFor(() => inbound.portal.getState() === 'ready', 'new inbound ready');
  assert.equal(inbound.sockets[1].closed, undefined);
  inbound.portal.disconnect();

  const outbound = portalProbe();
  await outbound.portal.start();
  await waitFor(() => outbound.sockets.length === 1, 'outbound socket');
  await outbound.handshake(outbound.sockets[0], 0);
  await waitFor(() => outbound.portal.getState() === 'ready', 'outbound ready');
  const releaseSeal = outbound.blockSends();
  const command = outbound.portal.sendCommand('session.list', null, {});
  await waitFor(() => outbound.sealStarted() === 1, 'seal suspended');
  outbound.sockets[0].serverClose();
  assert.equal(outbound.clock.runDelay(1_000), true);
  await waitFor(() => outbound.sockets.length === 2, 'new outbound socket');
  await outbound.handshake(outbound.sockets[1], 0, false);
  releaseSeal();
  const result = await command;
  assert.equal(result.error.reason, 'connection_changed');
  assert.equal(outbound.commands(outbound.sockets[1]).some(
    (value) => value.operation === 'session.list'
  ), false);
  outbound.portal.disconnect();
});
