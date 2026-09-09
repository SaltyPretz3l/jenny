'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const crypto = require('../services/remote/remote-crypto');
const contracts = require('../services/remote/remote-contracts');
const policy = require('../services/remote/remote-policy');
const { getBridgeChannel } = require('../services/ipc-contract');
const { registerRemoteIpc } = require('../services/main/remote-ipc-registration');

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function waitFor(predicate, label = 'condition') {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function createRelay() {
  const relay = {
    desktop: null,
    routeId: '',
    epoch: '',
    controls: [],
    frames: [],
    phoneClosed: false,
    fromDesktop(socket, message) {
      if (message.kind === 'claim') {
        this.desktop = socket;
        this.routeId = message.route_id;
        this.epoch = message.epoch;
        queueMicrotask(() => socket.emitMessage({
          v: 1, kind: 'claimed', route_id: message.route_id,
        }));
      } else if (message.kind === 'ping') {
        queueMicrotask(() => socket.emitMessage({ v: 1, kind: 'pong', t: message.t }));
      } else if (message.kind === 'close_peer') {
        this.phoneClosed = true;
        this.controls.push(message);
      } else if (message.kind) {
        this.controls.push(message);
      } else {
        this.frames.push(message);
      }
    },
    toDesktop(message) {
      this.desktop?.emitMessage(message);
    },
  };

  relay.WebSocketCtor = class FakeDesktopSocket {
    constructor(url) {
      this.url = url;
      this.bufferedAmount = 0;
      this.closed = false;
      this.listeners = new Map();
      queueMicrotask(() => this.emit('open', {}));
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    removeEventListener(name, listener) {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    }

    emit(name, event) {
      this.listeners.get(name)?.(event);
    }

    emitMessage(message) {
      this.emit('message', { data: JSON.stringify(message) });
    }

    send(text) {
      relay.fromDesktop(this, JSON.parse(text));
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit('close', {});
    }
  };
  return relay;
}

function createSecureStore() {
  let record = null;
  return {
    hasRemoteControlRecord: async () => record !== null,
    getRemoteControlRecord: async () => structuredClone(record),
    setRemoteControlRecord: async (value) => { record = structuredClone(value); },
    deleteRemoteControlRecord: async () => { record = null; },
  };
}

function session(id) {
  return {
    id,
    title: 'Phone chat',
    updated_at: '',
    message_count: 0,
    session_type: 'chat',
    archived_at: null,
    lockdown: false,
    plan_mode: true,
    preferred_model: 'local-model',
    reasoning_effort: 'medium',
    context_preferences: {},
    run_mode: 'ask',
    tool_category_overrides: {},
  };
}

function createBackend() {
  const backend = new EventEmitter();
  const sessions = new Map();
  backend.started = [];
  backend.approved = [];
  backend.created = 0;
  backend.pendingToolApprovals = new Map();
  backend.pendingUserQuestions = new Map();
  backend.sessionStore = { getSession: (id) => sessions.get(id) || null };
  backend.createSession = async () => {
    backend.created += 1;
    const value = session('session_remote_1');
    sessions.set(value.id, value);
    return { data: value };
  };
  backend.listSessions = async () => ({ data: [...sessions.values()] });
  backend.getSessionMessages = async () => [];
  backend.getActiveTurnState = async () => null;
  backend.cancelChatStream = async () => true;
  backend.startChatStream = async (payload) => {
    backend.started.push(payload);
    const streamId = 'stream_remote_1';
    const approval = {
      approvalId: 'approval_remote_1',
      streamId,
      sessionId: payload.sessionId,
      requestId: streamId,
      callId: 'call_remote_1',
      toolName: 'read_file',
      toolInput: { path: 'README.md' },
      policyScope: '',
      policyConsequence: '',
      resolve() {},
    };
    queueMicrotask(() => {
      backend.emit('chat-stream', {
        type: 'started', sessionId: payload.sessionId, streamId, turnId: 'turn_remote_1',
      });
      backend.emit('chat-stream', {
        type: 'delta', sessionId: payload.sessionId, streamId, content: 'hel',
      });
      backend.emit('chat-stream', {
        type: 'delta', sessionId: payload.sessionId, streamId, content: 'lo',
      });
      backend.pendingToolApprovals.set(approval.approvalId, approval);
      backend.emit('chat-stream', {
        type: 'tool_approval_needed',
        sessionId: payload.sessionId,
        streamId,
        turnId: 'turn_remote_1',
        approvalId: approval.approvalId,
        toolName: approval.toolName,
      });
      backend.emit('chat-stream', {
        type: 'complete',
        sessionId: payload.sessionId,
        streamId,
        turnId: 'turn_remote_1',
        status: 'completed',
        assistantMessageId: 'message_remote_1',
      });
    });
    return { sessionId: payload.sessionId, streamId };
  };
  backend.approveToolCall = (approvalId, options) => {
    backend.approved.push({ approvalId, options });
    backend.pendingToolApprovals.delete(approvalId);
    return true;
  };
  return backend;
}

async function sealPhone(phone, plaintext) {
  const header = {
    v: 1,
    route_id: phone.routeId,
    connection_id: phone.connectionId,
    epoch: phone.epoch,
    seq: phone.sendSeq,
  };
  const ciphertext = await crypto.sealFrame({
    key: phone.keys.sendKey,
    direction: crypto.DIRECTION_PHONE_TO_DESKTOP,
    counter: phone.sendSeq,
    header: crypto.encodeHeader(header),
    plaintext: encoder.encode(JSON.stringify(plaintext)),
  });
  phone.sendSeq += 1;
  return { ...header, ciphertext: crypto.toBase64Url(ciphertext) };
}

async function openDesktop(phone, frame) {
  const header = {
    v: frame.v,
    route_id: frame.route_id,
    connection_id: frame.connection_id,
    epoch: frame.epoch,
    seq: frame.seq,
  };
  const plaintext = await crypto.openFrame({
    key: phone.keys.recvKey,
    direction: crypto.DIRECTION_DESKTOP_TO_PHONE,
    counter: frame.seq,
    header: crypto.encodeHeader(header),
    ciphertext: crypto.fromBase64Url(frame.ciphertext),
  });
  return JSON.parse(decoder.decode(plaintext));
}

async function drainPhone(relay, phone) {
  const messages = [];
  while (phone.frameIndex < relay.frames.length) {
    const frame = relay.frames[phone.frameIndex];
    phone.frameIndex += 1;
    if (frame.connection_id === phone.connectionId) messages.push(await openDesktop(phone, frame));
  }
  phone.messages.push(...messages);
  return messages;
}

async function pairPhone(relay, pairingUrl) {
  const [pairingId, encodedSecret, routeId] = new URL(pairingUrl).hash.slice(3).split('.');
  const connectionId = 'connection_1';
  const phoneEphemeral = await crypto.generateEphemeral();
  relay.toDesktop({ v: 1, kind: 'peer_open', connection_id: connectionId });
  relay.toDesktop({
    v: 1,
    kind: 'hs1',
    connection_id: connectionId,
    eph_pub: crypto.toBase64Url(phoneEphemeral.publicKey),
    credential: { kind: 'pairing', pairing_id: pairingId },
  });
  const hs2 = await waitFor(
    () => relay.controls.find((message) => message.kind === 'hs2'),
    'desktop handshake response'
  );
  const secret = crypto.fromBase64Url(encodedSecret);
  const keys = await crypto.deriveHandshake({
    role: 'phone',
    secret,
    ourEphemeral: phoneEphemeral,
    theirPublicKey: crypto.fromBase64Url(hs2.eph_pub),
    relayOrigin: 'wss://relay.example',
    routeId,
    epoch: hs2.epoch,
    connectionId,
    credential: { kind: 'pairing', id: pairingId },
  });
  const proof = await crypto.proveHandshake(secret, keys.transcriptHash);
  const phone = {
    keys,
    routeId,
    epoch: hs2.epoch,
    connectionId,
    sendSeq: 0,
    frameIndex: 0,
    messages: [],
    controlLease: '',
  };
  relay.toDesktop(await sealPhone(phone, {
    v: 1,
    kind: 'hs_proof',
    proof: crypto.toBase64Url(proof),
    label: 'Integration phone',
  }));
  const hsOk = await waitFor(async () => {
    await drainPhone(relay, phone);
    return phone.messages.find((message) => message.kind === 'hs_ok');
  }, 'pairing completion');
  phone.deviceId = hsOk.device_id;
  phone.deviceSecret = hsOk.device_secret;
  return phone;
}

function command(phone, requestId, operation, payload = {}, sessionId = '') {
  return {
    v: 1,
    kind: 'command',
    request_id: requestId,
    operation,
    ...(sessionId ? { session_id: contracts.toWireSessionId(sessionId) } : {}),
    ...(phone.controlLease ? { control_lease: phone.controlLease } : {}),
    payload,
  };
}

async function sendCommand(relay, phone, value) {
  relay.toDesktop(await sealPhone(phone, value));
  return waitFor(async () => {
    await drainPhone(relay, phone);
    return phone.messages.find((message) => (
      message.kind === 'result' && message.request_id === value.request_id
    ));
  }, `result ${value.request_id}`);
}

test('remote IPC drives real pairing, chat, decisions, control loss, and plugin shutdown', async (t) => {
  const relay = createRelay();
  const backend = createBackend();
  backend.secureStore = createSecureStore();
  const shellConfigService = new EventEmitter();
  shellConfigService.getState = () => ({ featureOverrides: { remote_control: true } });
  const shutdownTasks = [];
  const shutdownFences = [];
  const lifecycle = {
    registerShutdownFence(fence) {
      shutdownFences.push(fence);
      return () => shutdownFences.splice(shutdownFences.indexOf(fence), 1);
    },
    registerShutdownTask(task) {
      shutdownTasks.push(task);
      return () => shutdownTasks.splice(shutdownTasks.indexOf(task), 1);
    },
  };
  const window = new EventEmitter();
  window.isDestroyed = () => false;
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const logs = [];
  let pluginState = { plugins: [{
    publisher_id: 'jenny-official', plugin_id: 'remote-control', effective_state: 'active',
  }] };
  let readPluginState = () => pluginState;
  const previousWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = relay.WebSocketCtor;
  const registration = registerRemoteIpc(ipcMain, {
    backendService: backend,
    secureStore: backend.secureStore,
    shellConfigService,
    env: { JENNY_ENABLE_REMOTE_CONTROL: '1' },
    mainLifecycle: lifecycle,
    getMainWindow: () => window,
    sendBridgeEvent: () => {},
    log: (...args) => logs.push(args),
  });
  t.after(async () => {
    await registration.teardown();
    globalThis.WebSocket = previousWebSocket;
  });
  registration.attachPluginService({ getState: () => readPluginState() });
  await new Promise((resolve) => { setImmediate(resolve); });
  const invoke = (methodPath, payload) => handlers.get(
    getBridgeChannel(methodPath, 'invoke')
  )({}, payload);

  assert.deepEqual(await invoke('remote.setRelay', { relay_url: 'wss://relay.example' }), { ok: true });
  assert.deepEqual(await invoke('remote.enable', {}), { ok: true });
  const pairing = await invoke('remote.openPairing', {});
  assert.match(pairing.pairing.qr_svg, /^<svg /);
  assert.equal(JSON.stringify(logs).includes(pairing.pairing.url), false);
  const phone = await pairPhone(relay, pairing.pairing.url);

  let resolvePluginRead;
  readPluginState = () => new Promise((resolve) => { resolvePluginRead = resolve; });
  registration.wrapBridgeEvents(() => {})('plugins.onChanged', {});
  const fenced = await sendCommand(relay, phone, command(
    phone, 'request_fenced_1', 'session.create'
  ));
  assert.equal(fenced.error.reason, 'not_reachable');
  assert.equal(backend.created, 0);
  resolvePluginRead(pluginState);
  await new Promise((resolve) => { setImmediate(resolve); });
  readPluginState = () => pluginState;

  const created = await sendCommand(relay, phone, command(
    phone, 'request_create_1', 'session.create'
  ));
  assert.equal(created.ok, true);
  const sessionId = created.data.id;
  const control = await sendCommand(relay, phone, command(
    phone, 'request_control_1', 'control.request', {}, sessionId
  ));
  assert.equal(control.ok, true);
  phone.controlLease = control.data.lease.lease_id;
  const sent = await sendCommand(relay, phone, command(
    phone, 'request_chat_1', 'chat.send', { prompt: 'hello' }, sessionId
  ));
  assert.equal(sent.ok, true);
  assert.equal(backend.started.length, 1);
  assert.equal(backend.started[0].planMode, true);
  const phoneOnlyBackendOptions = policy.FORBIDDEN_BACKEND_OPTIONS.filter(
    (key) => !['toolPreferences', 'approvalMode'].includes(key)
  );
  assert.equal(phoneOnlyBackendOptions.some(
    (key) => Object.hasOwn(backend.started[0], key)
  ), false);
  await waitFor(async () => {
    await drainPhone(relay, phone);
    return phone.messages.some((message) => message.type === 'tool_approval_needed');
  }, 'coalesced delta and approval');
  assert.equal(phone.messages.filter((message) => message.type === 'delta').length, 1);
  assert.equal(phone.messages.find((message) => message.type === 'delta').payload.text, 'hello');

  const decision = await sendCommand(relay, phone, command(
    phone,
    'request_decide_1',
    'decision.tool',
    {
      stream_id: 'stream_remote_1',
      approval_id: 'approval_remote_1',
      decision_revision: 1,
      decision: 'approve_once',
    },
    sessionId
  ));
  assert.equal(decision.ok, true);
  assert.deepEqual(backend.approved, [{
    approvalId: 'approval_remote_1', options: { decision: 'approved' },
  }]);

  assert.deepEqual(await invoke('remote.takeControl', { session_id: sessionId }), { ok: true });
  const rejected = await sendCommand(relay, phone, command(
    phone, 'request_chat_2', 'chat.send', { prompt: 'again' }, sessionId
  ));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.reason, 'control_required');

  assert.deepEqual(await invoke('remote.unshareSession', { session_id: sessionId }), { ok: true });
  await waitFor(async () => {
    await drainPhone(relay, phone);
    return phone.messages.some((message) => (
      message.type === 'session_unshared' && message.session_id === sessionId
    ));
  }, 'session unshared event');
  const unshared = phone.messages.find((message) => message.type === 'session_unshared');
  assert.deepEqual(unshared.payload, {});
  const transcript = await sendCommand(relay, phone, command(
    phone, 'request_page_1', 'transcript.page', { limit: 10 }, sessionId
  ));
  assert.equal(transcript.error.reason, 'session_not_shared');

  pluginState = { plugins: [{
    publisher_id: 'jenny-official', plugin_id: 'remote-control', effective_state: 'disabled',
  }] };
  registration.wrapBridgeEvents(() => {})('plugins.onChanged', {});
  await waitFor(() => registration.getFacade().status().state === 'off', 'plugin shutdown');
  const framesBefore = relay.frames.length;
  relay.toDesktop(await sealPhone(phone, command(
    phone, 'request_after_off', 'heartbeat'
  )));
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(relay.frames.length, framesBefore);
  assert.equal(relay.phoneClosed, true);
});
