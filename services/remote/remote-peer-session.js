'use strict';

/*
Relay wire protocol v1 (JSON text messages on the WebSocket; all ids match `/^[A-Za-z0-9_-]{8,64}$/`)
Endpoints: desktop `wss://<host>/r/<route_id>?role=desktop`, phone `wss://<host>/r/<route_id>?role=phone`.
- Desktop → relay first message: `{ v:1, kind:'claim', route_id, route_token, epoch }` (`route_token`/`route_id` from `crypto.deriveRouteCredentials(desktopSecret)`). Relay answers `{ v:1, kind:'claimed', route_id }` or `{ v:1, kind:'relay_error', code }` then closes. A later claim with a valid token for the same route displaces the previous desktop connection (the relay closes it with `relay_error code:'displaced'`).
- Phone → relay first message: `{ v:1, kind:'join', route_id }`; relay answers `{ v:1, kind:'joined', connection_id }` or closes (no desktop online → `relay_error code:'no_desktop'`).
- Relay → desktop: `{ v:1, kind:'peer_open', connection_id }`, `{ v:1, kind:'peer_close', connection_id }`, `{ v:1, kind:'hs1', connection_id, eph_pub, credential }` (forwarded from the phone; the relay STAMPS `connection_id`), frames `{ v:1, route_id, connection_id, epoch, seq, ciphertext }` (relay stamps `connection_id`; the desktop rejects frames whose `epoch` ≠ current epoch), `{ v:1, kind:'pong', t }`.
- Desktop → relay: `{ v:1, kind:'hs2', connection_id, eph_pub, epoch }` (relayed to that phone), frames (relayed to `connection_id`), `{ v:1, kind:'close_peer', connection_id }`, `{ v:1, kind:'ping', t }` every `HEARTBEAT_MS`.
- Relay-level messages carry no secrets except `route_token` (TLS only; grants room ownership, never message plaintext). Everything else the phone and desktop exchange after `hs2` is inside `ciphertext`.
*/

const defaultLimits = require('./remote-limits');
const defaultCrypto = require('./remote-crypto');
const defaultContracts = require('./remote-contracts');

const HANDSHAKE_TIMEOUT_MS = 10_000;
const INBOUND_QUEUE_MULTIPLIER = 2;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]{8,64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function createPeerSession(options = {}) {
  const {
    connectionId,
    epoch,
    routeId,
    relayOrigin,
    now,
    limits = defaultLimits,
    crypto = defaultCrypto,
    contracts = defaultContracts,
    resolveSecret,
    pairingConsume,
    verifyDevice,
    sendRaw,
    onReady = () => {},
    onClose = () => {},
    log = () => {},
    setTimer,
    clearTimer,
    isLive = () => true,
    eventSeqHead = () => 0,
  } = options;
  if (!IDENTIFIER_RE.test(connectionId || '') || !IDENTIFIER_RE.test(epoch || '')
    || !IDENTIFIER_RE.test(routeId || '') || typeof relayOrigin !== 'string'
    || typeof now !== 'function' || typeof resolveSecret !== 'function'
    || typeof pairingConsume !== 'function' || typeof verifyDevice !== 'function'
    || typeof sendRaw !== 'function' || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function') {
    throw new TypeError('Invalid remote peer configuration.');
  }

  let sessionState = 'handshaking';
  let peerDeviceId = null;
  let credential = null;
  let sendKey = null;
  let recvKey = null;
  let transcriptHash = null;
  let receiveNext = 0;
  const sendCounter = crypto.createSendCounter();
  let commandCount = 0;
  let ackedEventSeq = 0;
  let accessExpiresAt = 0;
  let expiryTimer = null;
  let receiveChain = Promise.resolve(null);
  let outboundChain = Promise.resolve(null);
  let queuedPlaintextBytes = 0;
  let queuedFrameCount = 0;
  let queuedFrameBytes = 0;
  let closeNotified = false;
  const handshakeTimer = setTimer(() => close('handshake_timeout'), HANDSHAKE_TIMEOUT_MS);

  function currentTime() {
    const value = Number(now());
    if (!Number.isFinite(value)) throw new TypeError('now must return a finite number');
    return value;
  }

  function boundedLog(level, event, fields = {}) {
    try { log(level, event, fields); } catch (_error) { /* optional */ }
  }

  function deviceTrusted(deviceId = peerDeviceId) {
    if (!deviceId) return true;
    try { return verifyDevice(deviceId) === true; } catch (_error) { return false; }
  }

  function live() {
    return sessionState !== 'closed' && isLive() === true && deviceTrusted();
  }

  function zero(value) {
    if (value instanceof Uint8Array) value.fill(0);
  }

  function close(reason = 'closed') {
    if (sessionState === 'closed') return false;
    sessionState = 'closed';
    clearTimer(handshakeTimer);
    if (expiryTimer != null) clearTimer(expiryTimer);
    expiryTimer = null;
    sendKey = null;
    recvKey = null;
    zero(transcriptHash);
    transcriptHash = null;
    credential = null;
    commandCount = 0;
    if (!closeNotified) {
      closeNotified = true;
      try { onClose(String(reason).slice(0, 64)); } catch (_error) { /* isolated */ }
    }
    return true;
  }

  function parseCredential(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.kind === 'pairing' && exactKeys(value, ['kind', 'pairing_id'])
      && IDENTIFIER_RE.test(value.pairing_id || '')) {
      return { kind: 'pairing', id: value.pairing_id };
    }
    if (value.kind === 'device' && exactKeys(value, ['kind', 'device_id'])
      && IDENTIFIER_RE.test(value.device_id || '')) {
      return { kind: 'device', id: value.device_id };
    }
    return null;
  }

  function decode32(value) {
    try {
      const bytes = crypto.fromBase64Url(value);
      return bytes.byteLength === 32 ? bytes : null;
    } catch (_error) {
      return null;
    }
  }

  async function handleHs1(message) {
    if (sessionState === 'deriving' || sessionState === 'proof_pending') {
      close('duplicate_hs1');
      return false;
    }
    if (sessionState !== 'handshaking'
      || !exactKeys(message, ['v', 'kind', 'connection_id', 'eph_pub', 'credential'])
      || message.v !== 1 || message.kind !== 'hs1' || message.connection_id !== connectionId) {
      const presented = parseCredential(message?.credential);
      if (presented?.kind === 'pairing') {
        try {
          await pairingConsume({
            pairingId: presented.id,
            proof: new Uint8Array(0),
            transcriptHash: new Uint8Array(0),
          });
        } catch (_error) { /* the connection still closes */ }
      }
      close('malformed_hs1');
      return false;
    }
    const normalizedCredential = parseCredential(message.credential);
    const theirPublicKey = decode32(message.eph_pub);
    if (!normalizedCredential || !theirPublicKey) {
      if (normalizedCredential?.kind === 'pairing') {
        try {
          await pairingConsume({
            pairingId: normalizedCredential.id,
            proof: new Uint8Array(0),
            transcriptHash: new Uint8Array(0),
          });
        } catch (_error) { /* the connection still closes */ }
      }
      close('malformed_hs1');
      return false;
    }
    sessionState = 'deriving';

    let secret;
    let ours;
    let derived;
    try {
      const resolved = await resolveSecret({ ...normalizedCredential });
      secret = resolved instanceof Uint8Array ? resolved : resolved?.secret;
      if (!(secret instanceof Uint8Array) || secret.byteLength !== 32
        || !live() || (normalizedCredential.kind === 'device'
          && !deviceTrusted(normalizedCredential.id))) {
        zero(secret);
        close('credential_rejected');
        return false;
      }
      ours = await crypto.generateEphemeral();
      if (!live() || (normalizedCredential.kind === 'device'
        && !deviceTrusted(normalizedCredential.id))) {
        zero(secret);
        close('admission_closed');
        return false;
      }
      derived = await crypto.deriveHandshake({
        role: 'desktop',
        secret,
        ourEphemeral: ours,
        theirPublicKey,
        relayOrigin,
        routeId,
        epoch,
        connectionId,
        credential: normalizedCredential,
      });
      zero(secret);
      secret = null;
      if (!live() || (normalizedCredential.kind === 'device'
        && !deviceTrusted(normalizedCredential.id))) {
        close('admission_closed');
        return false;
      }
      credential = normalizedCredential;
      if (credential.kind === 'device') peerDeviceId = credential.id;
      sendKey = derived.sendKey;
      recvKey = derived.recvKey;
      transcriptHash = derived.transcriptHash;
      sessionState = 'proof_pending';
      const sent = sendRaw({
        v: 1,
        kind: 'hs2',
        connection_id: connectionId,
        eph_pub: crypto.toBase64Url(ours.publicKey),
        epoch,
      });
      if (sent === false) close('backpressure');
      return sent !== false;
    } catch (_error) {
      zero(secret);
      boundedLog('WARN', 'remote.peer_handshake_failed', { phase: 'hs1' });
      close('handshake_failed');
      return false;
    }
  }

  function frameHeader(frame) {
    const validated = contracts.validateFrameHeader(frame);
    if (!validated?.ok) return null;
    const value = validated.value;
    if (value.route_id !== routeId || value.connection_id !== connectionId
      || value.epoch !== epoch || value.seq !== receiveNext) return null;
    return value;
  }

  function parsePlaintext(bytes) {
    try {
      const value = JSON.parse(decoder.decode(bytes));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_error) {
      return null;
    }
  }

  function validProof(value) {
    if (!value || value.v !== 1 || value.kind !== 'hs_proof') return null;
    const allowed = Object.hasOwn(value, 'label')
      ? ['v', 'kind', 'proof', 'label'] : ['v', 'kind', 'proof'];
    if (!exactKeys(value, allowed)) return null;
    if (Object.hasOwn(value, 'label')
      && (typeof value.label !== 'string' || Array.from(value.label).length > 64)) return null;
    const proof = decode32(value.proof);
    return proof ? { proof, label: value.label } : null;
  }

  async function countPairingFailure(label) {
    if (credential?.kind !== 'pairing' || !transcriptHash) return;
    try {
      await pairingConsume({
        pairingId: credential.id,
        proof: new Uint8Array(0),
        transcriptHash,
        label,
      });
    } catch (_error) {
      // The peer is closed regardless; the pairing service owns lock accounting.
    }
  }

  function sealAndSend(obj, allowHandshake = false, authorized = () => true) {
    if (accessExpiresAt > 0 && currentTime() >= accessExpiresAt) {
      close('access_expired');
      return Promise.resolve(false);
    }
    if ((!allowHandshake && sessionState !== 'ready') || !sendKey || !live()) {
      return Promise.resolve(false);
    }
    let plaintext;
    try { plaintext = encoder.encode(JSON.stringify(obj)); } catch (_error) { return Promise.resolve(false); }
    if (plaintext.byteLength > limits.FRAME_PLAINTEXT_MAX_BYTES) {
      return Promise.resolve({ ok: false, reason: 'payload_too_large' });
    }
    if (queuedPlaintextBytes + plaintext.byteLength > limits.OUTBOUND_QUEUE_MAX_BYTES) {
      return Promise.resolve(false);
    }
    queuedPlaintextBytes += plaintext.byteLength;
    const operation = outboundChain.then(async () => {
      if (!live() || authorized() !== true) return false;
      let seq;
      try {
        seq = sendCounter.next();
      } catch (_error) {
        close('counter_exhausted');
        return false;
      }
      if ((seq === 0) !== (obj?.kind === 'hs_ok')) {
        close('frame_kind_invalid');
        return false;
      }
      const header = { v: 1, route_id: routeId, connection_id: connectionId, epoch, seq };
      if (!live() || authorized() !== true) {
        close('authorization_lost');
        return false;
      }
      try {
        const ciphertext = await crypto.sealFrame({
          key: sendKey,
          direction: crypto.DIRECTION_DESKTOP_TO_PHONE,
          counter: seq,
          header: crypto.encodeHeader(header),
          plaintext,
        });
        if (!live() || authorized() !== true) {
          close('authorization_lost');
          return false;
        }
        return sendRaw({ ...header, ciphertext: crypto.toBase64Url(ciphertext) }) !== false;
      } catch (_error) {
        close('frame_seal_failed');
        return false;
      }
    });
    const settled = operation.finally(() => { queuedPlaintextBytes -= plaintext.byteLength; });
    outboundChain = settled.then(() => null, () => null);
    return settled;
  }

  async function acceptProof(value) {
    const proof = validProof(value);
    if (!proof || receiveNext !== 1 || sessionState !== 'proof_pending') {
      await countPairingFailure(value?.label);
      close('malformed_hs_proof');
      return null;
    }
    let deviceSecret = null;
    let accepted;
    try {
      if (credential.kind === 'pairing') {
        const result = await pairingConsume({
          pairingId: credential.id,
          proof: proof.proof,
          transcriptHash,
          label: proof.label,
        });
        if (!live() || result?.ok !== true || !result.device) {
          zero(result?.device?.device_secret);
          close('proof_rejected');
          return null;
        }
        peerDeviceId = result.device.device_id;
        deviceSecret = result.device.device_secret;
        accepted = deviceTrusted(peerDeviceId);
      } else {
        accepted = await verifyDevice(peerDeviceId, transcriptHash, proof.proof) === true;
      }
      if (!accepted || !live()) {
        zero(deviceSecret);
        close('proof_rejected');
        return null;
      }
      accessExpiresAt = currentTime() + limits.ACCESS_SESSION_MS;
      sessionState = 'ready';
      clearTimer(handshakeTimer);
      expiryTimer = setTimer(() => close('access_expired'), limits.ACCESS_SESSION_MS);
      const hsOk = {
        v: 1,
        kind: 'hs_ok',
        device_id: peerDeviceId,
        ...(deviceSecret ? { device_secret: crypto.toBase64Url(deviceSecret) } : {}),
        access_expires_at: accessExpiresAt,
        event_seq_head: Number(eventSeqHead()) || 0,
      };
      zero(deviceSecret);
      const sent = await sealAndSend(hsOk, true);
      if (sent !== true || !live()) {
        close(sent?.reason || 'backpressure');
        return null;
      }
      try { onReady({ deviceId: peerDeviceId, accessExpiresAt }); } catch (_error) { /* isolated */ }
      return null;
    } catch (_error) {
      zero(deviceSecret);
      close('proof_rejected');
      return null;
    }
  }

  async function processFrame(frame) {
    if (sessionState === 'closed') return null;
    if (isExpired()) {
      close('access_expired');
      return null;
    }
    const header = frameHeader(frame);
    if (!header) {
      close(frame?.epoch !== epoch ? 'epoch_invalid' : 'sequence_invalid');
      return null;
    }
    if (!recvKey || (header.seq === 0 && sessionState !== 'proof_pending')) {
      close('frame_kind_invalid');
      return null;
    }
    receiveNext += 1;
    let opened;
    try {
      const authenticatedHeader = {
        v: header.v,
        route_id: header.route_id,
        connection_id: header.connection_id,
        epoch: header.epoch,
        seq: header.seq,
      };
      opened = await crypto.openFrame({
        key: recvKey,
        direction: crypto.DIRECTION_PHONE_TO_DESKTOP,
        counter: header.seq,
        header: crypto.encodeHeader(authenticatedHeader),
        ciphertext: crypto.fromBase64Url(header.ciphertext),
      });
    } catch (_error) {
      if (header.seq === 0) await countPairingFailure();
      close('frame_open_failed');
      return null;
    }
    if (!live()) {
      close('admission_closed');
      return null;
    }
    const value = parsePlaintext(opened);
    if (!value) {
      if (header.seq === 0) await countPairingFailure();
      close(header.seq === 0 ? 'malformed_hs_proof' : 'plaintext_invalid');
      return null;
    }
    if (header.seq === 0) return acceptProof(value);
    if (value.kind === 'hs_proof' || value.kind === 'hs_ok') {
      close('frame_kind_invalid');
      return null;
    }
    const validated = contracts.validateCommand(value);
    if (!validated?.ok) {
      if (IDENTIFIER_RE.test(value.request_id || '')) {
        const sent = await sealAndSend(contracts.buildError(
          value.request_id, 'invalid_request', 'command_invalid', false
        ));
        if (sent !== true) close('backpressure');
      }
      return null;
    }
    if (commandCount >= limits.PENDING_COMMANDS_MAX) {
      const sent = await sealAndSend(contracts.buildError(
        validated.value.request_id, 'rate_limited', 'too_many_pending_commands', true
      ));
      if (sent !== true) close('backpressure');
      return null;
    }
    commandCount += 1;
    return { command: value };
  }

  function handleFrame(frame) {
    let bytes;
    try {
      bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
    } catch (_error) {
      close('inbound_overflow');
      return Promise.resolve(null);
    }
    const maxBytes = limits.FRAME_MAX_BYTES * INBOUND_QUEUE_MULTIPLIER;
    if (sessionState === 'closed'
      || queuedFrameCount >= limits.PENDING_COMMANDS_MAX
      || queuedFrameBytes + bytes > maxBytes) {
      if (sessionState !== 'closed') close('inbound_overflow');
      return Promise.resolve(null);
    }
    queuedFrameCount += 1;
    queuedFrameBytes += bytes;
    const operation = receiveChain.then(() => processFrame(frame), () => processFrame(frame))
      .finally(() => {
        queuedFrameCount -= 1;
        queuedFrameBytes -= bytes;
      });
    receiveChain = operation.then(() => null, () => null);
    return operation;
  }

  function sendPlaintext(obj, options = {}) {
    const authorized = typeof options.authorized === 'function'
      ? options.authorized : () => true;
    return sealAndSend(obj, false, authorized);
  }

  function settleCommand() {
    if (commandCount > 0) commandCount -= 1;
  }

  function setLastAcked(seq, head = Number(eventSeqHead()) || 0) {
    if (!Number.isSafeInteger(seq) || seq < ackedEventSeq || seq > head) return false;
    ackedEventSeq = seq;
    return true;
  }

  function isExpired() {
    return accessExpiresAt > 0 && currentTime() >= accessExpiresAt;
  }

  return Object.freeze({
    connectionId,
    epoch,
    get state() { return sessionState; },
    get deviceId() { return peerDeviceId; },
    handleHs1,
    handleFrame,
    sendPlaintext,
    get lastAckedEventSeq() { return ackedEventSeq; },
    setLastAcked,
    get pendingCommands() { return commandCount; },
    get reservations() {
      return Object.freeze({ queuedFrameCount, queuedFrameBytes });
    },
    settleCommand,
    close,
    isExpired,
  });
}

module.exports = { HANDSHAKE_TIMEOUT_MS, createPeerSession };
