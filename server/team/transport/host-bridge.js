'use strict';

// Host side of the team transport bridge: a thin supervisor of the
// `jenny-team-bridge` child (host mode). The child owns the network: it accepts
// authenticated connections, asks `admit` over the control channel whether the
// remote key may talk at all, and turns every accepted stream into one loopback
// TCP connection that starts with the 72-byte host preamble. This file spawns
// the child, hands it the secrets in the `start` line on its stdin, answers its
// admit questions, forwards `drop` and `stop`, tracks counts and addresses,
// forwards allowlisted log lines, hands over the port mapping's and the owner's
// relay's state and reports a dead child. The relay URL and token travel in the
// `start` line only and never reach a log or an event. Nothing here knows
// about members, roles or HTTP, and no traffic passes through JavaScript. Logs
// carry event names, counts and fixed words only.

const { safeLogger } = require('../safe-logger');
const { defaultSpawnChild } = require('./bridge-binary');
const { resolveLimits } = require('./bridge-util');
const {
  ALPN, attachControl, encodeKey, filterLog, parseMapping, parseRelay, relayField, stopChild,
} = require('./control-channel');
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
  // Stranger pressure, bounded before the admit question (TEAM_INTERNET_SPEC I7): at most 16
  // connections waiting for an answer, 8 handshakes per source per 10 s, and a refused key is
  // refused without asking again for 60 s. These are also ceilings: a caller may only lower them.
  maxWaiting: 16,
  maxHandshakesPerSource: 8,
  refusedCooldownMs: 60_000,
  // These three stay in JavaScript and are not sent to the child. The stop bound sits above
  // the binary's own worst-case shutdown (about 9 s) so a clean stop is never cut short.
  startTimeoutMs: 10_000,
  stopTimeoutMs: 10_000,
  // While a connection admitted as an invite is open, the host asks `admit` again this often (X3b-F01).
  inviteRecheckMs: 5000,
});
const CAPPED_LIMITS = Object.freeze(['maxWaiting', 'maxHandshakesPerSource', 'refusedCooldownMs']);
const ADMIT_ANSWERS = new Set(['device', 'invite']);
const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

const transportDown = () => Object.assign(new Error('transport_down'), { code: 'transport_down' });

function decodeKey(text) {
  if (typeof text !== 'string' || !KEY_TEXT.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === KEY_BYTES ? bytes : null;
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const count = (value) => (isCount(value) ? value : 0);

/**
 * The two path counts of a `stats` line (sent with a relay configured or internet joining on): both absent is zero, both
 * counts is their values, anything else is null and the whole line is dropped.
 */
function pathCounts(message) {
  const direct = message.direct_external_connections;
  const relayed = message.relayed_connections;
  if (direct === undefined && relayed === undefined) return { directExternalConnections: 0, relayedConnections: 0 };
  if (!isCount(direct) || !isCount(relayed)) return null;
  return { directExternalConnections: direct, relayedConnections: relayed };
}

/**
 * The `internet` field of the start line: null when internet joining is off, or
 * `{ map_port: true }`, which needs the direct port it maps (TEAM_INTERNET_SPEC I5).
 */
function internetField(internet, directPort) {
  if (internet === undefined || internet === null) return null;
  const keys = internet && typeof internet === 'object' ? Object.keys(internet) : [];
  if (keys.length !== 1 || internet.mapPort !== true) throw new TypeError('internet must be null or { mapPort: true }');
  if (directPort === undefined || directPort === null) throw new TypeError('internet.mapPort needs a directPort');
  return { map_port: true };
}

/**
 * `onChange()` is called when a `mapping` line moves the held state or address, a `relay` line moves
 * the held word, or a `stats` line moves the path counts, while the bridge is ready: a consumer re-reads
 * `mapping()`, `relay()` and `stats()` then. A repeated line is not a change. A throw from it, or a
 * rejection of the promise it returns, is logged once per bridge and never reaches the line handling.
 */
function createHostBridge({
  secretKey, alpn = ALPN, directPort, loopbackPort, bootSecret, admit, limits, log, onDown, onChange, internet, relay,
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
  const internetLine = internetField(internet, directPort);
  // Held only until the `start` line is built.
  let relayLine = relayField(relay);
  // With a relay or internet joining, `stats()` also counts direct-external and relayed connections.
  const countsPaths = relayLine !== null || internetLine !== null;
  const caps = resolveLimits(DEFAULT_LIMITS, limits);
  for (const name of CAPPED_LIMITS) {
    if (caps[name] > DEFAULT_LIMITS[name]) throw new TypeError(`limits.${name} must not exceed ${DEFAULT_LIMITS[name]}`);
  }
  const emit = safeLogger(log);
  // Own copies, wiped as soon as the `start` line is built.
  const secretCopy = Uint8Array.from(secretKey);
  const bootCopy = Uint8Array.from(bootSecret);
  const wipe = () => {
    secretCopy.fill(0);
    bootCopy.fill(0);
  };

  // conn number -> { key, kind }, from `admit` until `conn_closed`; `kind` is the admit answer once sent.
  const conns = new Map();
  const noCounters = () => ({
    streams: 0, refusedStreams: 0, refusedConnections: 0,
    ...(countsPaths ? { directExternalConnections: 0, relayedConnections: 0 } : {}),
  });
  let counters = noCounters();
  let addressList = [];
  // The child's last valid `mapping` line, or null.
  let mappingState = null;
  // Callers of `mappingSettled`, released when the router's answer is in, at their bound, or with the child.
  const settleWaiters = new Set();
  const releaseSettled = () => { for (const release of [...settleWaiters]) release(); };
  // The child's last valid `relay` state word, or null.
  let relayState = null;
  let child = null;
  let control = null;
  let exited = Promise.resolve();
  let markExited = () => {};
  let hasExited = false;
  let started = false;
  let ready = false;
  // True when the running child said it reads a stream's class byte (`bulk: 1` in `ready`).
  let bulkStreams = false;
  let stopping = false;
  let downReported = false;
  let changeFailed = false;
  let stopPromise = null;
  let pendingStart = null;
  let startTimer = null;
  let recheckTimer = null;

  function clearState() {
    conns.clear();
    clearTimeout(recheckTimer);
    recheckTimer = null;
    addressList = [];
    mappingState = null;
    relayState = null;
    bulkStreams = false;
    counters = noCounters();
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
    let answer;
    try {
      answer = await withTimeout(Promise.resolve(admit(Uint8Array.from(key))), caps.admitTimeoutMs);
    } catch {
      // A throw or a timeout is the parent failing, not a refusal of the key: no answer, so the
      // child's own admit timeout refuses this connection and starts no cooldown for the key.
      return;
    }
    const kind = ADMIT_ANSWERS.has(answer) ? answer : null;
    const entry = conns.get(conn);
    // A connection that closed meanwhile (a drop, the child's own timeout) needs no answer.
    if (!entry) return;
    entry.kind = kind;
    control.send({ t: 'admit_answer', conn, kind });
    if (kind === 'invite') armRecheck();
  }

  // Review sweeps, second run (X3b-F01): a connection admitted as an invite lives only while its invite does. The
  // child asks once, at the handshake, and keeps no timer of its own, so while one is open the host asks `admit`
  // again every `inviteRecheckMs` and drops a key that is no longer a live invite (spent, revoked, expired) or whose
  // answer fails (fail closed). No timer runs while no invite connection is open.
  function armRecheck() {
    if (recheckTimer !== null || stopping || !ready) return;
    recheckTimer = setTimeout(() => {
      recheckInvites().catch(() => {}).finally(() => {
        recheckTimer = null;
        if ([...conns.values()].some((entry) => entry.kind === 'invite')) armRecheck();
      });
    }, caps.inviteRecheckMs);
    recheckTimer.unref?.();
  }

  async function recheckInvites() {
    const keys = new Map();
    for (const entry of conns.values()) if (entry.kind === 'invite') keys.set(encodeKey(entry.key), entry.key);
    await Promise.all([...keys.values()].map(async (key) => {
      const answer = await withTimeout(Promise.resolve().then(() => admit(Uint8Array.from(key))), caps.admitTimeoutMs)
        .catch(() => null);
      if (answer !== 'invite' && !stopping) drop(key);
    }));
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
    conns.set(conn, { key, kind: null });
    answerAdmit(conn, key);
  }

  function changeFailedOnce() {
    if (changeFailed) return;
    changeFailed = true;
    emit('team.bridge.on_change_failed', {});
  }

  function changed() {
    if (!ready || typeof onChange !== 'function') return;
    try {
      const result = onChange();
      if (result && typeof result.then === 'function') result.then(undefined, changeFailedOnce);
    } catch {
      changeFailedOnce();
    }
  }

  function onReady(message) {
    if (ready || !Array.isArray(message.addresses)) return;
    ready = true;
    bulkStreams = message.bulk === 1;
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
      case 'mapping': {
        const mapping = ready ? parseMapping(message) : null;
        if (!mapping) break;
        const mappingMoved = mapping.state !== mappingState?.state || mapping.external !== mappingState?.external;
        mappingState = mapping;
        if (mapping.state !== 'requesting') releaseSettled();
        const line = filterLog('team.bridge.mapping', { state: mapping.state });
        // Defence: a known state always passes the filter today.
        if (line) emit(line.event, line.fields);
        if (mappingMoved) changed();
        break;
      }
      case 'relay': {
        const state = ready ? parseRelay(message) : null;
        if (!state) break;
        const relayMoved = state !== relayState;
        relayState = state;
        const line = filterLog('team.bridge.relay', { state });
        if (line) emit(line.event, line.fields);
        if (relayMoved) changed();
        break;
      }
      case 'conn_closed':
        conns.delete(message.conn);
        break;
      case 'stats': {
        const paths = pathCounts(message);
        if (!paths) break;
        const pathsChanged = countsPaths && (paths.directExternalConnections !== counters.directExternalConnections
          || paths.relayedConnections !== counters.relayedConnections);
        counters = {
          streams: count(message.streams),
          refusedStreams: count(message.refused_streams),
          refusedConnections: count(message.refused_connections),
          ...(countsPaths ? paths : {}),
        };
        if (pathsChanged) changed();
        break;
      }
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
    releaseSettled();
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
      internet: internetLine,
      // Absent when there is no relay, so the line is the one a bridge without a relay gets.
      ...(relayLine ? { relay: relayLine } : {}),
      limits: {
        max_connections: caps.maxConnections,
        max_streams_per_connection: caps.maxStreamsPerConnection,
        max_streams_total: caps.maxStreamsTotal,
        max_handshakes: caps.maxHandshakes,
        admit_timeout_ms: caps.admitTimeoutMs,
        drop_grace_ms: caps.dropGraceMs,
        max_waiting: caps.maxWaiting,
        max_handshakes_per_source: caps.maxHandshakesPerSource,
        refused_cooldown_ms: caps.refusedCooldownMs,
      },
    };
  }

  /** Closes every connection of one key (a revoke). Returns how many connections it had. */
  function drop(publicKey) {
    requireBytes(publicKey, KEY_BYTES, 'publicKey');
    let matched = 0;
    for (const entry of conns.values()) if (Buffer.compare(entry.key, publicKey) === 0) matched += 1;
    if (matched === 0 || !control) return 0;
    control.send({ t: 'drop', key: encodeKey(publicKey) });
    return matched;
  }

  async function doStop() {
    stopping = true;
    clearTimeout(recheckTimer);
    recheckTimer = null;
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
      relayLine = null;
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

    /** True while the running child reads bulk streams: only then may a member send one. */
    bulk() {
      return ready && bulkStreams;
    },

    /** The port mapping as the child last reported it: `{ state, external }`, or null. */
    mapping() {
      return mappingState ? { ...mappingState } : null;
    },

    /** Resolves once the router has answered the mapping request, after `boundMs`, or when the child is gone. */
    mappingSettled(boundMs) {
      if (mappingState?.state !== 'requesting') return Promise.resolve();
      return new Promise((resolve) => {
        const release = () => { clearTimeout(timer); settleWaiters.delete(release); resolve(); };
        const timer = setTimeout(release, boundMs);
        timer.unref?.();
        settleWaiters.add(release);
      });
    },

    /** The owner's relay's state word as the child last reported it, or null. */
    relay() {
      return relayState;
    },

    drop,

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
