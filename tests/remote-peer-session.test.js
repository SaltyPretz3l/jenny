'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('../services/remote/remote-crypto');
const contracts = require('../services/remote/remote-contracts');
const limits = require('../services/remote/remote-limits');
const { createPeerSession } = require('../services/remote/remote-peer-session');

const routeId = 'route_id1';
const epoch = 'epoch_id1';
const connectionId = 'connect_1';
const relayOrigin = 'wss://relay.example';

function timers() {
  let next = 1;
  const active = new Map();
  return {
    setTimer(fn, ms) { const id = next++; active.set(id, { fn, ms }); return id; },
    clearTimer(id) { active.delete(id); },
    fire(ms) {
      for (const [id, timer] of [...active]) {
        if (timer.ms !== ms) continue;
        active.delete(id);
        timer.fn();
      }
    },
  };
}

async function sealPhone(keys, seq, plaintext, frameEpoch = epoch) {
  const header = { v: 1, route_id: routeId, connection_id: connectionId, epoch: frameEpoch, seq };
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
  const opened = await crypto.openFrame({
    key: keys.recvKey,
    direction: crypto.DIRECTION_DESKTOP_TO_PHONE,
    counter: frame.seq,
    header: crypto.encodeHeader(header),
    ciphertext: crypto.fromBase64Url(frame.ciphertext),
  });
  return JSON.parse(new TextDecoder().decode(opened));
}

async function pairingFixture({ proofOverride, nowRef = { value: 100 }, peerCrypto = crypto } = {}) {
  const sent = [];
  const closes = [];
  const ready = [];
  const timer = timers();
  const pairingId = 'pairing_1';
  const pairingSecret = crypto.randomSecret();
  const derivedSecret = new Uint8Array(pairingSecret);
  const deviceSecret = crypto.randomSecret();
  const deviceId = 'device_id1';
  let trusted = false;
  let consumeCount = 0;
  const peer = createPeerSession({
    connectionId,
    epoch,
    routeId,
    relayOrigin,
    now: () => nowRef.value,
    limits,
    crypto: peerCrypto,
    contracts,
    ...timer,
    isLive: () => true,
    resolveSecret: () => ({ secret: derivedSecret }),
    pairingConsume: async ({ proof, transcriptHash, label }) => {
      consumeCount += 1;
      const ok = await crypto.verifyHandshake(pairingSecret, transcriptHash, proof).catch(() => false);
      if (!ok) return { ok: false, reason: 'pairing_invalid' };
      trusted = true;
      return {
        ok: true,
        device: { device_id: deviceId, device_secret: deviceSecret, label, paired_at: nowRef.value },
      };
    },
    verifyDevice: (id) => trusted && id === deviceId,
    sendRaw: (message) => { sent.push(message); return true; },
    eventSeqHead: () => 7,
    onReady: (value) => ready.push(value),
    onClose: (value) => closes.push(value),
  });
  const phoneEphemeral = await crypto.generateEphemeral();
  await peer.handleHs1({
    v: 1,
    kind: 'hs1',
    connection_id: connectionId,
    eph_pub: crypto.toBase64Url(phoneEphemeral.publicKey),
    credential: { kind: 'pairing', pairing_id: pairingId },
  });
  assert.equal(derivedSecret.every((byte) => byte === 0), true);
  const hs2 = sent[0];
  const credential = { kind: 'pairing', id: pairingId };
  const phoneKeys = await crypto.deriveHandshake({
    role: 'phone',
    secret: pairingSecret,
    ourEphemeral: phoneEphemeral,
    theirPublicKey: crypto.fromBase64Url(hs2.eph_pub),
    relayOrigin,
    routeId,
    epoch,
    connectionId,
    credential,
  });
  const proof = proofOverride || await crypto.proveHandshake(pairingSecret, phoneKeys.transcriptHash);
  const proofFrame = await sealPhone(phoneKeys, 0, {
    v: 1, kind: 'hs_proof', proof: crypto.toBase64Url(proof), label: 'My phone',
  });
  await peer.handleFrame(proofFrame);
  return { peer, sent, closes, ready, phoneKeys, nowRef, timer, consumeCount: () => consumeCount };
}

test('full pairing handshake reserves seq zero and accepts application traffic at seq one', async () => {
  const fix = await pairingFixture();
  assert.equal(fix.peer.state, 'ready', JSON.stringify(fix.closes));
  assert.equal(fix.peer.deviceId, 'device_id1');
  assert.equal(fix.ready.length, 1);
  const hsOk = await openDesktop(fix.phoneKeys, fix.sent[1]);
  assert.equal(hsOk.kind, 'hs_ok');
  assert.equal(hsOk.event_seq_head, 7);
  assert.equal(crypto.fromBase64Url(hsOk.device_secret).byteLength, 32);
  const frame = await sealPhone(fix.phoneKeys, 1, {
    v: 1,
    kind: 'command',
    request_id: 'request_1',
    operation: 'heartbeat',
    payload: {},
  });
  const opened = await fix.peer.handleFrame(frame);
  assert.equal(opened.command.operation, 'heartbeat');
  assert.equal(fix.peer.pendingCommands, 1);
  fix.peer.settleCommand();
  assert.equal(fix.peer.pendingCommands, 0);
});

test('device credential handshake verifies proof and does not return a secret', async () => {
  const sent = [];
  const timer = timers();
  const deviceId = 'device_id1';
  const deviceSecret = crypto.randomSecret();
  const resolved = new Uint8Array(deviceSecret);
  const peer = createPeerSession({
    connectionId, epoch, routeId, relayOrigin, now: () => 1, limits, crypto, contracts, ...timer,
    resolveSecret: () => ({ secret: resolved }),
    pairingConsume: async () => ({ ok: false }),
    verifyDevice(id, hash, proof) {
      if (hash === undefined) return id === deviceId;
      return crypto.verifyHandshake(deviceSecret, hash, proof);
    },
    sendRaw: (message) => { sent.push(message); return true; },
  });
  const phone = await crypto.generateEphemeral();
  await peer.handleHs1({
    v: 1, kind: 'hs1', connection_id: connectionId,
    eph_pub: crypto.toBase64Url(phone.publicKey),
    credential: { kind: 'device', device_id: deviceId },
  });
  assert.equal(resolved.every((byte) => byte === 0), true);
  const keys = await crypto.deriveHandshake({
    role: 'phone', secret: deviceSecret, ourEphemeral: phone,
    theirPublicKey: crypto.fromBase64Url(sent[0].eph_pub), relayOrigin,
    routeId, epoch, connectionId, credential: { kind: 'device', id: deviceId },
  });
  const proof = await crypto.proveHandshake(deviceSecret, keys.transcriptHash);
  await peer.handleFrame(await sealPhone(keys, 0, {
    v: 1, kind: 'hs_proof', proof: crypto.toBase64Url(proof),
  }));
  const hsOk = await openDesktop(keys, sent[1]);
  assert.equal(peer.state, 'ready');
  assert.equal(Object.hasOwn(hsOk, 'device_secret'), false);
});

test('wrong proof closes and reaches pairing failure accounting', async () => {
  const fix = await pairingFixture({ proofOverride: crypto.randomSecret() });
  assert.equal(fix.peer.state, 'closed');
  assert.equal(fix.consumeCount(), 1);
  assert.equal(fix.closes.length, 1);
});

test('duplicate sequence, wrong epoch, and expired access each close the peer', async () => {
  const replay = await pairingFixture();
  const command = {
    v: 1, kind: 'command', request_id: 'request_1', operation: 'heartbeat', payload: {},
  };
  const frame = await sealPhone(replay.phoneKeys, 1, command);
  await replay.peer.handleFrame(frame);
  await replay.peer.handleFrame(frame);
  assert.equal(replay.peer.state, 'closed');

  const wrong = await pairingFixture();
  const wrongFrame = await sealPhone(wrong.phoneKeys, 1, command, 'other_ep1');
  await wrong.peer.handleFrame(wrongFrame);
  assert.equal(wrong.peer.state, 'closed');

  const expired = await pairingFixture();
  expired.nowRef.value += limits.ACCESS_SESSION_MS;
  assert.equal(await expired.peer.sendPlaintext(contracts.buildResult('request_1', {})), false);
  assert.equal(expired.peer.state, 'closed');
});

test('pending command limit returns rate_limited without admitting another command', async () => {
  const fix = await pairingFixture();
  for (let index = 1; index <= limits.PENDING_COMMANDS_MAX + 1; index += 1) {
    const result = await fix.peer.handleFrame(await sealPhone(fix.phoneKeys, index, {
      v: 1,
      kind: 'command',
      request_id: `request_${String(index).padStart(2, '0')}`,
      operation: 'heartbeat',
      payload: {},
    }));
    if (index <= limits.PENDING_COMMANDS_MAX) assert.equal(result.command.operation, 'heartbeat');
    else assert.equal(result, null);
  }
  assert.equal(fix.peer.pendingCommands, limits.PENDING_COMMANDS_MAX);
  const error = await openDesktop(fix.phoneKeys, fix.sent.at(-1));
  assert.equal(error.error.code, contracts.ERROR_CODES.rate_limited);
  assert.deepEqual(fix.peer.reservations, { queuedFrameCount: 0, queuedFrameBytes: 0 });
});

test('concurrent outbound frames preserve WebSocket sequence order', async () => {
  const sealCalls = [];
  let releaseFirst;
  const peerCrypto = {
    ...crypto,
    sealFrame(input) {
      sealCalls.push(input.counter);
      if (input.counter !== 1) return crypto.sealFrame(input);
      return new Promise((resolve) => {
        releaseFirst = () => { crypto.sealFrame(input).then(resolve); };
      });
    },
  };
  const fix = await pairingFixture({ peerCrypto });
  const first = fix.peer.sendPlaintext(contracts.buildResult('request_1', { order: 1 }));
  const second = fix.peer.sendPlaintext(contracts.buildResult('request_2', { order: 2 }));
  await Promise.resolve();
  assert.deepEqual(sealCalls, [0, 1]);
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.deepEqual(sealCalls, [0, 1, 2]);
  assert.deepEqual(fix.sent.slice(-2).map((frame) => frame.seq), [1, 2]);
});

test('idle ready peers expire from the armed access timer', async () => {
  const fix = await pairingFixture();
  fix.timer.fire(limits.ACCESS_SESSION_MS);
  assert.equal(fix.peer.state, 'closed');
  assert.equal(fix.closes.at(-1), 'access_expired');
});

test('a concurrent hs1 closes the deriving peer before any hs2 is sent', async () => {
  let releaseEphemeral;
  const sent = [];
  const closes = [];
  const secret = crypto.randomSecret();
  const peerCrypto = {
    ...crypto,
    generateEphemeral: () => new Promise((resolve) => { releaseEphemeral = resolve; }),
  };
  const peer = createPeerSession({
    connectionId,
    epoch,
    routeId,
    relayOrigin,
    now: () => 1,
    limits,
    crypto: peerCrypto,
    contracts,
    ...timers(),
    resolveSecret: () => ({ secret: new Uint8Array(secret) }),
    pairingConsume: async () => ({ ok: false }),
    verifyDevice: () => true,
    sendRaw: (message) => { sent.push(message); return true; },
    onClose: (reason) => closes.push(reason),
  });
  const phone = await crypto.generateEphemeral();
  const hs1 = {
    v: 1,
    kind: 'hs1',
    connection_id: connectionId,
    eph_pub: crypto.toBase64Url(phone.publicKey),
    credential: { kind: 'device', device_id: 'device_id1' },
  };
  const first = peer.handleHs1(hs1);
  await Promise.resolve();
  assert.equal(await peer.handleHs1(hs1), false);
  releaseEphemeral(await crypto.generateEphemeral());
  assert.equal(await first, false);
  assert.equal(sent.length, 0);
  assert.equal(closes.at(-1), 'duplicate_hs1');
});

test('inbound reservations close a peer when stalled frames exceed the byte budget', async () => {
  let releaseOpen;
  const peerCrypto = {
    ...crypto,
    openFrame(input) {
      if (input.counter === 0) return crypto.openFrame(input);
      return new Promise((resolve) => { releaseOpen = () => resolve(new Uint8Array()); });
    },
  };
  const fix = await pairingFixture({ peerCrypto });
  const first = await sealPhone(fix.phoneKeys, 1, {
    v: 1,
    kind: 'command',
    request_id: 'request_1',
    operation: 'heartbeat',
    payload: {},
  });
  const stalled = fix.peer.handleFrame(first);
  await Promise.resolve();
  const large = {
    v: 1,
    route_id: routeId,
    connection_id: connectionId,
    epoch,
    seq: 2,
    ciphertext: 'A'.repeat(limits.FRAME_MAX_BYTES - 100),
  };
  fix.peer.handleFrame(large);
  fix.peer.handleFrame({ ...large, seq: 3 });
  assert.equal(fix.peer.state, 'closed');
  assert.equal(fix.closes.at(-1), 'inbound_overflow');
  releaseOpen();
  await stalled;
});

test('queued outbound authorization is rechecked before sealing', async () => {
  let releaseFirst;
  const peerCrypto = {
    ...crypto,
    sealFrame(input) {
      if (input.counter !== 1) return crypto.sealFrame(input);
      return new Promise((resolve) => {
        releaseFirst = () => crypto.sealFrame(input).then(resolve);
      });
    },
  };
  const fix = await pairingFixture({ peerCrypto });
  let authorized = true;
  const first = fix.peer.sendPlaintext(contracts.buildResult('request_1', {}));
  const second = fix.peer.sendPlaintext(
    contracts.buildResult('request_2', {}),
    { authorized: () => authorized }
  );
  await Promise.resolve();
  authorized = false;
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(await second, false);
  authorized = true;
  assert.equal(await fix.peer.sendPlaintext(contracts.buildResult('request_3', {})), true);
  assert.deepEqual(fix.sent.filter((frame) => frame.seq >= 1).map((frame) => frame.seq), [1, 2]);
});

test('authorization lost during sealing closes instead of leaving a sequence hole', async () => {
  let releaseSeal;
  const peerCrypto = {
    ...crypto,
    sealFrame(input) {
      if (input.counter !== 1) return crypto.sealFrame(input);
      return new Promise((resolve) => {
        releaseSeal = () => crypto.sealFrame(input).then(resolve);
      });
    },
  };
  const fix = await pairingFixture({ peerCrypto });
  let authorized = true;
  const pending = fix.peer.sendPlaintext(
    contracts.buildResult('request_1', {}),
    { authorized: () => authorized }
  );
  while (!releaseSeal) await Promise.resolve();
  authorized = false;
  releaseSeal();
  assert.equal(await pending, false);
  assert.equal(fix.peer.state, 'closed');
  assert.equal(fix.closes.at(-1), 'authorization_lost');
  authorized = true;
  assert.equal(await fix.peer.sendPlaintext(contracts.buildResult('request_2', {})), false);
  assert.deepEqual(fix.sent.filter((frame) => frame.seq >= 1), []);
});

test('inbound reservations release after decrypt and command validation failures', async () => {
  const decrypt = await pairingFixture();
  const frame = await sealPhone(decrypt.phoneKeys, 1, {
    v: 1, kind: 'command', request_id: 'request_1', operation: 'heartbeat', payload: {},
  });
  frame.ciphertext = crypto.toBase64Url(crypto.randomSecret());
  await decrypt.peer.handleFrame(frame);
  assert.deepEqual(decrypt.peer.reservations, { queuedFrameCount: 0, queuedFrameBytes: 0 });

  const invalid = await pairingFixture();
  await invalid.peer.handleFrame(await sealPhone(invalid.phoneKeys, 1, {
    v: 1, kind: 'command', request_id: 'request_2', operation: 'unknown', payload: {},
  }));
  assert.deepEqual(invalid.peer.reservations, { queuedFrameCount: 0, queuedFrameBytes: 0 });
});

test('event acknowledgements cannot move beyond the supplied buffer head', async () => {
  const fix = await pairingFixture();
  assert.equal(fix.peer.setLastAcked(8, 7), false);
  assert.equal(fix.peer.lastAckedEventSeq, 0);
  assert.equal(fix.peer.setLastAcked(7, 7), true);
});
