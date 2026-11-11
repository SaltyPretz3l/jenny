'use strict';

// Host side of the team transport bridge: a thin supervisor of the
// `jenny-team-bridge` child (host mode). The child owns the network: it accepts
// authenticated connections, asks `admit` over the control channel whether the
// remote key may talk at all, and turns every accepted stream into one loopback
// TCP connection that starts with the 72-byte host preamble. This file spawns
// the child, hands it the secrets in the `start` line on its stdin, answers its
// admit questions, forwards `drop` and `stop`, tracks counts and addresses,
// forwards allowlisted log lines and reports a dead child. Nothing here knows
// about members, roles or HTTP, and no traffic passes through JavaScript. Logs
// carry event names, counts and fixed words only.

const { safeLogger } = require('../safe-logger');
const { defaultSpawnChild } = require('./bridge-binary');
const { resolveLimits } = require('./bridge-util');
const { ALPN, attachControl, encodeKey, filterLog, stopChild } = require('./control-channel');
const { KEY_BYTES, SECRET_BYTES, requireBytes } = require('./preamble');
const { withTimeout } = require('./with-timeout');

const DEFAULT_LIMITS = Object.freeze({
  // Eight seats with a few devices each, plus invites in flight.
  maxConnections: 64,
  maxStreamsPerConnection: 16,
  maxStreamsTotal: 128,
  maxHandshakes: 64,
  admitTimeoutMs: 5000,
  dropGraceMs: 1000,
  // These two stay in JavaScript and are not sent to the child. The stop bound sits above
  // the binary's own worst-case shutdown (about 9 s) so a clean stop is never cut short.
  startTimeoutMs: 10_000,
  stopTimeoutMs: 10_000,
});
const ADMIT_ANSWERS = new Set(['device', 'invite']);
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

const transportDown = () => Object.assign(new Error('transport_down'), { code: 'transport_down' });

function decodeKey(text) {
  if (typeof text !== 'string' || !KEY_TEXT.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === KEY_BYTES ? bytes : null;
}

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

function createHostBridge({
  secretKey, alpn = ALPN, directPort, loopbackPort, bootSecret, admit, limits, log, onDown,
  spawnChild = defaultSpawnChild,
}) {
  requireBytes(secretKey, KEY_BYTES, 'secretKey');
  requireBytes(bootSecret, SECRET_BYTES, 'bootSecret');
  if (!Number.isInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > 65535) {
    throw new TypeError('loopbackPort must be a TCP port');
  }
  if (typeof admit !== 'function') throw new TypeError('admit must be a function');
  if (directPort !== undefined && directPort !== null
    && (!Number.isInteger(directPort) || directPort < 1 || directPort > 65535)) {
    throw new TypeError('directPort must be a UDP port or null');
  }
  const caps = resolveLimits(DEFAULT_LIMITS, limits);
  const emit = safeLogger(log);
  // Own copies, wiped as soon as the `start` line is built.
  const secretCopy = Uint8Array.from(secretKey);
  const bootCopy = Uint8Array.from(bootSecret);
  const wipe = () => {
    secretCopy.fill(0);
    bootCopy.fill(0);
  };

  // conn number -> key bytes, from `admit` until `conn_closed`.
  const conns = new Map();
  let counters = { streams: 0, refusedStreams: 0, refusedConnections: 0 };
  let addressList = [];
  let child = null;
  let control = null;
  let exited = Promise.resolve();
  let markExited = () => {};
  let hasExited = false;
  let started = false;
  let ready = false;
  let stopping = false;
  let downReported = false;
  let stopPromise = null;
  let pendingStart = null;
  let startTimer = null;

  function clearState() {
    conns.clear();
    addressList = [];
    counters = { streams: 0, refusedStreams: 0, refusedConnections: 0 };
  }

  function killChild() {
    if (!child || hasExited) return;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  function settleStart(error) {
    const pending = pendingStart;
    if (!pending) return;
    pendingStart = null;
    clearTimeout(startTimer);
    if (error) {
      killChild();
      pending.reject(error);
    } else {
      pending.resolve();
    }
  }

  async function answerAdmit(conn, key) {
    let kind = null;
    try {
      const answer = await withTimeout(Promise.resolve(admit(Uint8Array.from(key))), caps.admitTimeoutMs);
      if (ADMIT_ANSWERS.has(answer)) kind = answer;
    } catch {
      kind = null;
    }
    // A connection that closed meanwhile (a drop, the child's own timeout) needs no answer.
    if (conns.has(conn)) control.send({ t: 'admit_answer', conn, kind });
  }

  function onAdmit(message) {
    const conn = message.conn;
    if (!Number.isSafeInteger(conn)) return;
    const key = decodeKey(message.key);
    // The child enforces the connection cap; counting it here too would race its conn_closed.
    if (!key) {
      control.send({ t: 'admit_answer', conn, kind: null });
      return;
    }
    conns.set(conn, key);
    answerAdmit(conn, key);
  }

  function onReady(message) {
    if (ready || !Array.isArray(message.addresses)) return;
    ready = true;
    addressList = message.addresses.filter((address) => typeof address === 'string');
    settleStart();
  }

  function onMessage(message) {
    switch (message.t) {
      case 'ready':
        onReady(message);
        break;
      case 'addresses':
        if (ready && Array.isArray(message.addresses)) {
          addressList = message.addresses.filter((address) => typeof address === 'string');
        }
        break;
      case 'admit':
        if (ready) onAdmit(message);
        break;
      case 'conn_closed':
        conns.delete(message.conn);
        break;
      case 'stats':
        counters = {
          streams: count(message.streams),
          refusedStreams: count(message.refused_streams),
          refusedConnections: count(message.refused_connections),
        };
        break;
      case 'log': {
        const line = filterLog(message.event, message.fields);
        if (line) emit(line.event, line.fields);
        break;
      }
      case 'error':
        // The child exits on its own after an error; make sure it does.
        if (pendingStart) settleStart(transportDown());
        else killChild();
        break;
      default:
        break;
    }
  }

  function onExit() {
    hasExited = true;
    markExited();
    const wasReady = ready;
    clearState();
    if (control) control.close();
    if (pendingStart) {
      settleStart(transportDown());
      return;
    }
    if (!wasReady || stopping || downReported) return;
    downReported = true;
    emit('team.bridge.down', {});
    try {
      if (typeof onDown === 'function') onDown('team_transport_down');
    } catch {
      // A failing callback never affects the supervisor.
    }
  }

  function startLine() {
    return {
      t: 'start',
      mode: 'host',
      secret_key: encodeKey(secretCopy),
      boot_secret: encodeKey(bootCopy),
      alpn,
      loopback_port: loopbackPort,
      direct_port: directPort ?? null,
      limits: {
        max_connections: caps.maxConnections,
        max_streams_per_connection: caps.maxStreamsPerConnection,
        max_streams_total: caps.maxStreamsTotal,
        max_handshakes: caps.maxHandshakes,
        admit_timeout_ms: caps.admitTimeoutMs,
        drop_grace_ms: caps.dropGraceMs,
      },
    };
  }

  async function doStop() {
    stopping = true;
    wipe();
    if (child && !hasExited) await stopChild({ child, control, exited, timeoutMs: caps.stopTimeoutMs });
    if (control) control.close();
    clearState();
  }

  return {
    async start() {
      if (started) throw new Error('host bridge already started');
      if (stopping) throw new Error('host bridge stopped');
      started = true;
      const line = startLine();
      wipe();
      child = spawnChild('host');
      exited = new Promise((resolve) => { markExited = resolve; });
      return new Promise((resolve, reject) => {
        pendingStart = { resolve, reject };
        startTimer = setTimeout(() => settleStart(transportDown()), caps.startTimeoutMs);
        control = attachControl(child, { onMessage, onExit });
        control.send(line);
      });
    },

    addresses() {
      return [...addressList];
    },

    /** Closes every connection of one key (a revoke). Returns how many connections it had. */
    drop(publicKey) {
      requireBytes(publicKey, KEY_BYTES, 'publicKey');
      let matched = 0;
      for (const key of conns.values()) if (Buffer.compare(key, publicKey) === 0) matched += 1;
      if (matched === 0 || !control) return 0;
      control.send({ t: 'drop', key: encodeKey(publicKey) });
      return matched;
    },

    stats() {
      return { connections: conns.size, ...counters };
    },

    stop() {
      if (!stopPromise) stopPromise = doStop();
      return stopPromise;
    },
  };
}

module.exports = { DEFAULT_LIMITS, createHostBridge };
