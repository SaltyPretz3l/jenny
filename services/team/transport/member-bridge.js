'use strict';

// Member side of the team transport bridge: a thin supervisor of the
// `jenny-team-bridge` child (member mode). The child dials the host once, listens
// on a loopback port for Jenny's main process, checks the 40-byte member
// preamble (per-launch secret, 3 s window) on every local connection and carries
// each valid one as a transport stream to the host. This file spawns the child,
// hands it the secrets in the `start` line on its stdin, and turns its `state`
// lines into the states and reasons the application sees. No retries: a refused
// or lost connection reports `offline` and the caller decides what to do. Logs
// carry event names, states and counts only.

const { safeLogger } = require('../../../server/team/safe-logger');
const { defaultSpawnChild } = require('../../../server/team/transport/bridge-binary');
const { resolveLimits } = require('../../../server/team/transport/bridge-util');
const {
  ALPN, MAX_ADDRESSES, attachControl, encodeKey, filterLog, isSocketAddress, stopChild,
} = require('../../../server/team/transport/control-channel');
const {
  KEY_BYTES,
  MAX_PREAMBLE_SOCKETS,
  PREAMBLE_TIMEOUT_MS,
  SECRET_BYTES,
  requireBytes,
} = require('../../../server/team/transport/preamble');

const STATES = Object.freeze({ CONNECTING: 'connecting', ONLINE: 'online', OFFLINE: 'offline' });
const REASONS = Object.freeze(['host_unreachable', 'host_refused', 'closed']);
const DEFAULT_LIMITS = Object.freeze({
  maxPreambleSockets: MAX_PREAMBLE_SOCKETS,
  maxStreams: 16,
  preambleTimeoutMs: PREAMBLE_TIMEOUT_MS,
  connectTimeoutMs: 10_000,
  // Stays in JavaScript and is not sent to the child.
  stopTimeoutMs: 5000,
});
// The child gets its own connect timeout; this is the time it has to report it.
const GUARD_SLACK_MS = 5000;

function createMemberBridge({
  secretKey, hostPublicKey, addresses, alpn = ALPN, launchSecret, log, limits,
  spawnChild = defaultSpawnChild,
}) {
  requireBytes(secretKey, KEY_BYTES, 'secretKey');
  requireBytes(hostPublicKey, KEY_BYTES, 'hostPublicKey');
  requireBytes(launchSecret, SECRET_BYTES, 'launchSecret');
  if (!Array.isArray(addresses) || addresses.some((address) => typeof address !== 'string')) {
    throw new TypeError('addresses must be an array of strings');
  }
  if (addresses.length > MAX_ADDRESSES || !addresses.every(isSocketAddress)) {
    throw new TypeError(`addresses must be at most ${MAX_ADDRESSES} ip:port strings`);
  }
  const caps = resolveLimits(DEFAULT_LIMITS, limits);
  const emit = safeLogger(log);
  // Own copies, wiped as soon as the `start` line is built.
  const secretCopy = Uint8Array.from(secretKey);
  const hostCopy = Uint8Array.from(hostPublicKey);
  const launchCopy = Uint8Array.from(launchSecret);
  const dialAddresses = [...addresses];

  const stateListeners = new Set();
  let current = { state: STATES.OFFLINE, reason: 'closed' };
  let child = null;
  let control = null;
  let exited = Promise.resolve();
  let markExited = () => {};
  let hasExited = false;
  let localPort = null;
  let workingAddresses = [];
  let started = false;
  let stopped = false;
  let stopPromise = null;
  let pendingStart = null;
  let guardTimer = null;

  const snapshot = () => ({ ...current });

  function setState(state, reason) {
    const next = { state, reason: state === STATES.OFFLINE ? reason : null };
    if (next.state === current.state && next.reason === current.reason) return;
    current = next;
    if (state !== STATES.ONLINE) localPort = null;
    emit('team.member_bridge.state', { state: next.state, reason: next.reason || 'none' });
    for (const listener of [...stateListeners]) {
      try {
        listener({ ...next });
      } catch {
        // A failing listener never affects the bridge.
      }
    }
  }

  function settleStart() {
    const pending = pendingStart;
    if (!pending) return;
    pendingStart = null;
    clearTimeout(guardTimer);
    pending(snapshot());
  }

  function killChild() {
    if (!child || hasExited) return;
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  function onState(message) {
    if (stopped) return;
    if (message.state === STATES.ONLINE) {
      const port = message.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        killChild();
        return;
      }
      localPort = port;
      workingAddresses = [...dialAddresses];
      setState(STATES.ONLINE, null);
      settleStart();
    } else if (message.state === STATES.OFFLINE) {
      setState(STATES.OFFLINE, REASONS.includes(message.reason) ? message.reason : 'closed');
      settleStart();
    }
  }

  function onMessage(message) {
    if (message.t === 'state') {
      onState(message);
    } else if (message.t === 'log') {
      const line = filterLog(message.event, message.fields);
      if (line) emit(line.event, line.fields);
    } else if (message.t === 'error') {
      // The binary refused its start: nothing was dialled, so the host is unreachable from here.
      if (!stopped && current.state === STATES.CONNECTING) setState(STATES.OFFLINE, 'host_unreachable');
      // The child exits on its own after an error; make sure it does.
      killChild();
    }
  }

  function onExit(info) {
    hasExited = true;
    markExited();
    if (control) control.close();
    // An exit after `offline` changes nothing; one before it is a lost host.
    if (!stopped && current.state !== STATES.OFFLINE) {
      setState(STATES.OFFLINE, info && info.spawnFailed ? 'host_unreachable' : 'closed');
    }
    settleStart();
  }

  function startLine() {
    return {
      t: 'start',
      mode: 'member',
      secret_key: encodeKey(secretCopy),
      host_key: encodeKey(hostCopy),
      addresses: [...dialAddresses],
      alpn,
      launch_secret: encodeKey(launchCopy),
      limits: {
        max_preamble_sockets: caps.maxPreambleSockets,
        max_streams: caps.maxStreams,
        preamble_timeout_ms: caps.preambleTimeoutMs,
        connect_timeout_ms: caps.connectTimeoutMs,
      },
    };
  }

  function wipe() {
    secretCopy.fill(0);
    hostCopy.fill(0);
    launchCopy.fill(0);
  }

  async function doStop() {
    stopped = true;
    wipe();
    setState(STATES.OFFLINE, 'closed');
    settleStart();
    if (child && !hasExited) await stopChild({ child, control, exited, timeoutMs: caps.stopTimeoutMs });
    if (control) control.close();
  }

  return {
    async start() {
      if (started) throw new Error('member bridge already started');
      started = true;
      if (stopped) return snapshot();
      setState(STATES.CONNECTING, null);
      const line = startLine();
      wipe();
      try {
        child = spawnChild('member');
      } catch {
        setState(STATES.OFFLINE, 'host_unreachable');
        return snapshot();
      }
      exited = new Promise((resolve) => { markExited = resolve; });
      return new Promise((resolve) => {
        pendingStart = resolve;
        guardTimer = setTimeout(() => {
          killChild();
          setState(STATES.OFFLINE, 'host_unreachable');
          settleStart();
        }, caps.connectTimeoutMs + GUARD_SLACK_MS);
        control = attachControl(child, { onMessage, onExit });
        control.send(line);
      });
    },

    port() {
      return current.state === STATES.ONLINE ? localPort : null;
    },

    state: snapshot,

    onState(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    lastWorkingAddresses() {
      return [...workingAddresses];
    },

    stop() {
      if (!stopPromise) stopPromise = doStop();
      return stopPromise;
    },
  };
}

module.exports = { DEFAULT_LIMITS, REASONS, STATES, createMemberBridge };
