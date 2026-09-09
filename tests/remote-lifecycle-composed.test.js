'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('../services/remote/remote-crypto');
const contracts = require('../services/remote/remote-contracts');
const limits = require('../services/remote/remote-limits');
const { createRemoteControlService } = require('../services/remote/remote-control-service');
const { createPeerSession } = require('../services/remote/remote-peer-session');
const { createChatStartCancellation } = require('../services/backend/chat-start-cancellation');

function backendSession() {
  return {
    id: 'chat-1',
    title: 'Shared chat',
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
}

function createFixture(options = {}) {
  const desktopSecret = crypto.randomSecret();
  const deviceSecret = crypto.randomSecret();
  const session = backendSession();
  const flags = { remote_control: true, session_offline_lockdown: true };
  const backend = new EventEmitter();
  backend.sessionStore = { getSession: (id) => (id === session.id ? session : null) };
  backend.pendingToolApprovals = new Map();
  backend.pendingUserQuestions = new Map();
  backend.startCalls = [];
  backend.cancelCalls = [];
  backend.listSessions = async () => (options.listSessions
    ? options.listSessions(session) : { data: [session] });
  backend.createSession = options.createSession || (async () => ({ data: backendSession() }));
  backend.startChatStream = async (payload) => {
    backend.startCalls.push(payload);
    return { sessionId: payload.sessionId, streamId: 'stream_remote_1' };
  };
  backend.cancelChatStream = async (streamId, reason) => {
    backend.cancelCalls.push({ streamId, reason });
    return true;
  };
  backend.getSessionMessages = options.getSessionMessages || (async () => []);
  backend.getActiveTurnState = options.getActiveTurnState || (async () => ({
    stream_id: 'active_stream_1',
    turn_id: 'turn_1',
    status: 'running',
    pending_approval: {
      reason: 'LEAK_REASON_MARKER',
      summary: 'LEAK_SUMMARY_MARKER',
    },
  }));
  const record = {
    relay_url: 'wss://relay.example',
    shared_sessions: ['chat-1'],
    devices: [{
      device_id: 'device_id1',
      device_secret: crypto.toBase64Url(deviceSecret),
      label: 'Phone',
      paired_at: 1,
      last_seen_at: 1,
    }],
  };
  const store = {
    load: async () => ({ ok: true }),
    getRecord: () => structuredClone(record),
    desktopSecret: () => new Uint8Array(desktopSecret),
    deviceSecret: (id) => (id === 'device_id1' ? new Uint8Array(deviceSecret) : null),
    isDeviceTrusted: (id) => id === 'device_id1',
    touchDevice: async () => ({ ok: true }),
    addDevice: async () => ({ ok: true }),
    revokeDevice: async () => ({ ok: true }),
    shareSession: async (id) => {
      if (options.shareSession) return options.shareSession(id, record);
      if (!record.shared_sessions.includes(id)) record.shared_sessions.push(id);
      return { ok: true };
    },
    unshareSession: async (id) => {
      record.shared_sessions = record.shared_sessions.filter((item) => item !== id);
      return { ok: true };
    },
    setRelayUrl: async (url) => {
      record.relay_url = url;
      return { ok: true };
    },
    forgetAll: async () => ({ ok: true }),
  };
  let relayInput;
  let relayState = 'idle';
  const relay = {
    sent: [],
    closedPeers: [],
    connect() {
      relayState = 'claimed';
      relayInput.onStateChange('claimed');
      return true;
    },
    send(message) {
      relay.sent.push(message);
      return true;
    },
    closePeer(connectionId) {
      relay.closedPeers.push(connectionId);
      return true;
    },
    disconnect() {
      relayState = 'closed';
    },
    getState: () => relayState,
    receive(message) {
      return relayInput.onMessage(message);
    },
  };
  let nextTimer = 1;
  const timers = new Map();
  const peers = [];
  const service = createRemoteControlService({
    backendService: backend,
    secureStore: {},
    featureFlags: () => ({ ...flags }),
    isPluginActive: () => true,
    isWindowAlive: () => true,
    now: () => 100,
    setTimer(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    portalOriginFor: () => 'https://relay.example',
    factories: {
      createDeviceStore: () => store,
      createRelayClient(input) {
        relayInput = input;
        return relay;
      },
      createPeerSession(input) {
        const peer = createPeerSession(input);
        peers.push(peer);
        return peer;
      },
      ...options.factories,
    },
  });
  return {
    service,
    backend,
    session,
    flags,
    relay,
    desktopSecret,
    deviceSecret,
    peers,
    record,
  };
}

async function flushUntil(predicate, message = 'condition') {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.fail(`Timed out waiting for ${message}`);
}

async function sealPhone(keys, routeId, epoch, seq, plaintext, connectionId = 'connect_1') {
  const header = {
    v: 1,
    route_id: routeId,
    connection_id: connectionId,
    epoch,
    seq,
  };
  const ciphertext = await crypto.sealFrame({
    key: keys.sendKey,
    direction: crypto.DIRECTION_PHONE_TO_DESKTOP,
    counter: seq,
    header: crypto.encodeHeader(header),
    plaintext: new TextEncoder().encode(JSON.stringify(plaintext)),
  });
  return { ...header, ciphertext: crypto.toBase64Url(ciphertext) };
}

async function openDesktop(keys, frame) {
  const header = {
    v: frame.v,
    route_id: frame.route_id,
    connection_id: frame.connection_id,
    epoch: frame.epoch,
    seq: frame.seq,
  };
  const plaintext = await crypto.openFrame({
    key: keys.recvKey,
    direction: crypto.DIRECTION_DESKTOP_TO_PHONE,
    counter: frame.seq,
    header: crypto.encodeHeader(header),
    ciphertext: crypto.fromBase64Url(frame.ciphertext),
  });
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function connectPhone(fix, connectionId = 'connect_1', enable = true) {
  if (enable) assert.equal((await fix.service.enable()).ok, true);
  const route = await crypto.deriveRouteCredentials(fix.desktopSecret);
  fix.relay.receive({ v: 1, kind: 'peer_open', connection_id: connectionId });
  const phoneEphemeral = await crypto.generateEphemeral();
  await fix.relay.receive({
    v: 1,
    kind: 'hs1',
    connection_id: connectionId,
    eph_pub: crypto.toBase64Url(phoneEphemeral.publicKey),
    credential: { kind: 'device', device_id: 'device_id1' },
  });
  await flushUntil(
    () => fix.relay.sent.some((message) => (
      message.kind === 'hs2' && message.connection_id === connectionId
    )),
    `hs2 (${JSON.stringify({ closed: fix.relay.closedPeers, states: fix.peers.map((p) => p.state) })})`
  );
  const hs2 = fix.relay.sent.find((message) => (
    message.kind === 'hs2' && message.connection_id === connectionId
  ));
  const credential = { kind: 'device', id: 'device_id1' };
  const keys = await crypto.deriveHandshake({
    role: 'phone',
    secret: fix.deviceSecret,
    ourEphemeral: phoneEphemeral,
    theirPublicKey: crypto.fromBase64Url(hs2.eph_pub),
    relayOrigin: 'wss://relay.example',
    routeId: route.routeId,
    epoch: hs2.epoch,
    connectionId,
    credential,
  });
  const proof = await crypto.proveHandshake(fix.deviceSecret, keys.transcriptHash);
  fix.relay.receive(await sealPhone(keys, route.routeId, hs2.epoch, 0, {
    v: 1,
    kind: 'hs_proof',
    proof: crypto.toBase64Url(proof),
  }, connectionId));
  await flushUntil(
    () => fix.relay.sent.some((message) => (
      !message.kind && message.seq === 0 && message.connection_id === connectionId
    )),
    'hs_ok'
  );
  return { keys, routeId: route.routeId, epoch: hs2.epoch, nextSeq: 1, connectionId };
}

async function submitCommand(fix, phone, command) {
  const start = fix.relay.sent.length;
  const frame = await sealPhone(
    phone.keys,
    phone.routeId,
    phone.epoch,
    phone.nextSeq,
    command,
    phone.connectionId
  );
  phone.nextSeq += 1;
  return { start, pending: fix.relay.receive(frame) };
}

async function waitForResult(fix, phone, start, requestId) {
  let opened = [];
  await flushUntil(() => {
    const frames = fix.relay.sent.slice(start).filter((message) => !message.kind);
    return frames.length > 0;
  }, `result ${requestId}`);
  for (let index = 0; index < 100; index += 1) {
    const frames = fix.relay.sent.slice(start).filter((message) => !message.kind);
    opened = await Promise.all(frames.map((item) => openDesktop(phone.keys, item)));
    const result = opened.find((item) => item.kind === 'result'
      && item.request_id === requestId);
    if (result) return result;
    await Promise.resolve();
  }
  assert.fail(`No result for ${requestId}: ${JSON.stringify(opened)}`);
}

async function sendCommand(fix, phone, value) {
  const submitted = await submitCommand(fix, phone, value);
  await submitted.pending;
  return waitForResult(fix, phone, submitted.start, value.request_id);
}

function command(requestId, operation, payload = {}, sessionId) {
  return {
    v: 1,
    kind: 'command',
    request_id: requestId,
    operation,
    ...(sessionId ? { session_id: contracts.toWireSessionId(sessionId) } : {}),
    payload,
  };
}

test('real composition handshakes, redacts snapshots, and policy-gates receipt replay', async () => {
  const fix = createFixture();
  let changes = 0;
  fix.service.onChanged(() => { changes += 1; });
  const phone = await connectPhone(fix);
  await flushUntil(
    () => fix.relay.sent.some((message) => !message.kind && message.seq === 1),
    'initial snapshot'
  );
  const snapshotFrame = fix.relay.sent.find((message) => !message.kind && message.seq === 1);
  const snapshot = await openDesktop(phone.keys, snapshotFrame);
  assert.equal(snapshot.type, 'session_shared');
  assert.doesNotMatch(JSON.stringify(snapshot), /LEAK_REASON_MARKER|LEAK_SUMMARY_MARKER/);
  assert.deepEqual(
    Object.keys(snapshot.payload.sessions[0].active_turn).sort(),
    ['status', 'stream_id', 'turn_id']
  );

  const beforeControl = changes;
  const control = await sendCommand(
    fix,
    phone,
    command('request_control', 'control.request', {}, 'chat-1')
  );
  assert.equal(control.ok, true);
  assert.ok(changes > beforeControl);

  const send = command('request_send_1', 'chat.send', { prompt: 'hello' }, 'chat-1');
  assert.equal((await sendCommand(fix, phone, send)).ok, true);
  assert.equal(fix.backend.startCalls.length, 1);
  fix.session.lockdown = true;
  const replay = await sendCommand(fix, phone, send);
  assert.equal(replay.error.code, contracts.ERROR_CODES.session_not_shared);
  assert.equal(fix.backend.startCalls.length, 1);
  await fix.service.dispose();
});

test('unshare during a suspended snapshot prevents transcript publication', async () => {
  let resolveMessages;
  let messagesRequested = false;
  const fix = createFixture({
    getSessionMessages: () => new Promise((resolve) => {
      messagesRequested = true;
      resolveMessages = resolve;
    }),
  });
  await connectPhone(fix);
  await flushUntil(() => messagesRequested, 'snapshot transcript read');
  const unsharing = fix.service.unshareSession('chat-1');
  resolveMessages([]);
  await unsharing;
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
  const published = fix.relay.sent.filter((message) => !message.kind && message.seq > 0);
  assert.deepEqual(published, []);
  await fix.service.dispose();
});

test('normalized transcript responses recheck lockdown before disclosure', async () => {
  let resolveMessages;
  const fix = createFixture({
    getSessionMessages: () => new Promise((resolve) => { resolveMessages = resolve; }),
  });
  const phone = await connectPhone(fix);
  await flushUntil(() => Boolean(resolveMessages), 'initial transcript read');
  resolveMessages([]);
  await flushUntil(() => fix.relay.sent.some((message) => !message.kind && message.seq === 1));
  resolveMessages = null;
  const value = command('trimmed_page', 'transcript.page', { limit: 10 }, 'chat-1');
  value.session_id = ' chat-1 ';
  const submitted = await submitCommand(fix, phone, value);
  await flushUntil(() => Boolean(resolveMessages), 'command transcript read');
  fix.session.lockdown = true;
  resolveMessages([{ id: 'secret_message', role: 'assistant', content: 'SECRET_TRANSCRIPT' }]);
  await submitted.pending;
  const result = await waitForResult(fix, phone, submitted.start, value.request_id);
  assert.equal(result.error.code, contracts.ERROR_CODES.session_not_shared);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_TRANSCRIPT/);
  await fix.service.dispose();
});

test('session list omits a grant lost after adapter filtering', async () => {
  const fix = createFixture({
    listSessions(session) {
      const listed = { ...session };
      Object.defineProperty(listed, 'last_message_preview', {
        get() { session.lockdown = true; return 'computed before lockdown'; },
      });
      return { data: [listed] };
    },
  });
  const phone = await connectPhone(fix);
  const result = await sendCommand(fix, phone, command('list_after_lock', 'session.list'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.sessions, []);
  await fix.service.dispose();
});

test('a ready peer receives its initial snapshot without fan-out to an existing peer', async () => {
  const fix = createFixture();
  const first = await connectPhone(fix);
  await flushUntil(() => fix.relay.sent.some((message) => (
    !message.kind && message.seq === 1 && message.connection_id === first.connectionId
  )), 'first snapshot');
  const firstFrames = fix.relay.sent.filter((message) => (
    !message.kind && message.connection_id === first.connectionId
  )).length;
  const second = await connectPhone(fix, 'connect_2', false);
  await flushUntil(() => fix.relay.sent.some((message) => (
    !message.kind && message.seq === 1 && message.connection_id === second.connectionId
  )), 'second snapshot');
  assert.equal(fix.relay.sent.filter((message) => (
    !message.kind && message.connection_id === first.connectionId
  )).length, firstFrames);
  await fix.service.dispose();
});

test('a stale share continuation cannot clear a newer unshare suppression', async () => {
  let releaseShare;
  const fix = createFixture({
    shareSession: (sessionId, record) => new Promise((resolve) => {
      releaseShare = () => {
        if (!record.shared_sessions.includes(sessionId)) record.shared_sessions.push(sessionId);
        resolve({ ok: true });
      };
    }),
  });
  await fix.service.enable();
  const sharing = fix.service.shareSession('chat-1');
  await flushUntil(() => Boolean(releaseShare), 'pending share persistence');
  await fix.service.unshareSession('chat-1');
  releaseShare();
  const result = await sharing;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'grant_suppressed');
  assert.deepEqual(fix.service.status().shared_sessions, []);
  await fix.service.dispose();
});

test('a real-phone oversized resync returns a bounded transcript-free snapshot', async () => {
  const fix = createFixture();
  const phone = await connectPhone(fix);
  await flushUntil(() => fix.relay.sent.some((message) => (
    !message.kind && message.seq === 1
  )), 'initial snapshot');
  const start = fix.relay.sent.length;
  for (let index = 0; index < 3; index += 1) {
    fix.backend.emit('chat-stream', {
      type: 'complete',
      sessionId: 'chat-1',
      streamId: `stream_large_${index}`,
      status: 'completed',
      assistantMessageId: `message_large_${index}`,
      content: 'x'.repeat(300_000),
    });
  }
  await flushUntil(() => fix.relay.sent.slice(start).filter((message) => !message.kind).length >= 3,
    'large live events');
  const result = await sendCommand(
    fix,
    phone,
    command('request_resync_1', 'resync', { last_event_seq: 0 })
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.replay_truncated, true);
  assert.deepEqual(result.data.events, []);
  assert.equal(result.data.sessions[0].transcript, null);
  assert.equal(result.data.sessions[0].transcript_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8')
    <= limits.FRAME_PLAINTEXT_MAX_BYTES);
  await fix.service.dispose();
});

test('resync authorization lost during sealing closes without publishing', async () => {
  let releaseSeal;
  const guardedCrypto = {
    ...crypto,
    sealFrame(input) {
      const plaintext = JSON.parse(new TextDecoder().decode(input.plaintext));
      if (plaintext.request_id !== 'resync_lock') return crypto.sealFrame(input);
      return new Promise((resolve) => {
        releaseSeal = () => crypto.sealFrame(input).then(resolve);
      });
    },
  };
  const fix = createFixture({ factories: { crypto: guardedCrypto } });
  const phone = await connectPhone(fix);
  await flushUntil(() => fix.relay.sent.some((message) => !message.kind && message.seq === 1));
  const submitted = await submitCommand(
    fix,
    phone,
    command('resync_lock', 'resync', { last_event_seq: 0 })
  );
  await flushUntil(() => Boolean(releaseSeal), 'resync seal');
  fix.session.lockdown = true;
  releaseSeal();
  await submitted.pending;
  assert.equal(fix.peers[0].state, 'closed');
  assert.equal(fix.relay.sent.slice(submitted.start).filter((message) => !message.kind).length, 0);
  await fix.service.dispose();
});

test('device revocation fences a suspended create before its initial share', async () => {
  let resolveCreate;
  let shareCalls = 0;
  const fix = createFixture({
    createSession: () => new Promise((resolve) => { resolveCreate = resolve; }),
    shareSession: async () => { shareCalls += 1; return { ok: true }; },
  });
  const phone = await connectPhone(fix);
  const submitted = await submitCommand(fix, phone, command('create_revoked', 'session.create'));
  await flushUntil(() => Boolean(resolveCreate), 'create request');
  await fix.service.revokeDevice('device_id1');
  resolveCreate({ data: { ...backendSession(), id: 'chat-created' } });
  await submitted.pending;
  assert.equal(shareCalls, 0);
  assert.deepEqual(fix.record.shared_sessions, ['chat-1']);
  await fix.service.dispose();
});

test('a failed real-adapter start unregisters its runtime cancellation scope', async () => {
  const cancelInvocations = [];
  const fix = createFixture({
    factories: {
      createChatStartCancellation(input) {
        const base = createChatStartCancellation(input);
        return {
          signal: base.signal,
          cancel(reason) {
            cancelInvocations.push(reason);
            return base.cancel(reason);
          },
          bindStream: (streamId) => base.bindStream(streamId),
          get boundStreamId() {
            return base.boundStreamId;
          },
        };
      },
    },
  });
  const phone = await connectPhone(fix);
  await sendCommand(fix, phone, command('control_cancel', 'control.request', {}, 'chat-1'));
  fix.backend.startChatStream = async () => { throw new Error('offline'); };
  const result = await sendCommand(
    fix,
    phone,
    command('failed_send_1', 'chat.send', { prompt: 'hello' }, 'chat-1')
  );
  assert.equal(result.error.code, contracts.ERROR_CODES.not_reachable);
  assert.deepEqual(cancelInvocations, ['start_failed']);
  await fix.service.disable();
  assert.deepEqual(cancelInvocations, ['start_failed']);
});

test('terminal backend events unregister bound cancellation scopes outside the share gate', async () => {
  const cancelInvocations = [];
  const fix = createFixture({
    factories: {
      createChatStartCancellation(input) {
        const base = createChatStartCancellation(input);
        return {
          signal: base.signal,
          cancel(reason) {
            cancelInvocations.push(reason);
            return base.cancel(reason);
          },
          bindStream: (streamId) => base.bindStream(streamId),
          get boundStreamId() {
            return base.boundStreamId;
          },
        };
      },
    },
  });
  const phone = await connectPhone(fix);
  await sendCommand(fix, phone, command('control_terminal', 'control.request', {}, 'chat-1'));
  const sent = await sendCommand(
    fix,
    phone,
    command('terminal_send_1', 'chat.send', { prompt: 'hello' }, 'chat-1')
  );
  assert.equal(sent.ok, true);
  fix.session.lockdown = true;
  fix.backend.emit('chat-stream', {
    type: 'complete',
    sessionId: 'chat-1',
    streamId: 'stream_remote_1',
  });
  await fix.service.disable();
  assert.deepEqual(cancelInvocations, []);
});
