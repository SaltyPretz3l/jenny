'use strict';

// The control channel to the `jenny-team-bridge` child, shared by the host and
// member supervisors: the spawn helper, the line codec (one JSON object per line,
// at most 64 KiB, on the child's stdin and stdout) and the log allowlist. The
// bytes of a member's traffic never pass through here; this file moves control
// lines only. No secret ever goes into an argument or the environment: secrets
// travel in the `start` line on stdin and nowhere else.

const { spawn } = require('node:child_process');
const net = require('node:net');

const ALPN = 'jenny-team/1';
const MAX_LINE_BYTES = 65536;
// The binary dials at most this many direct addresses.
const MAX_ADDRESSES = 16;
const MODES = Object.freeze(['host', 'member']);
// After `exit`, a short wait lets the last lines already in the pipe arrive.
const EXIT_DRAIN_MS = 200;

const LOG_EVENTS = new Set([
  'team.bridge.started',
  'team.bridge.connection_admitted',
  'team.bridge.connection_refused',
  'team.bridge.stream_refused',
  'team.bridge.dropped',
  'team.bridge.stopped',
]);
const LOG_FIELDS = new Set(['kind', 'reason', 'connections', 'streams']);
const LOG_WORDS = new Set([
  'device', 'invite', 'not_admitted', 'connection_cap', 'handshake_cap', 'total_cap', 'closing',
]);

/** Starts the bridge binary in `mode` ('host' or 'member'). The argument list is exactly [mode]. */
function spawnBridgeChild(mode, { binaryPath } = {}) {
  if (!MODES.includes(mode)) throw new TypeError('mode must be host or member');
  if (typeof binaryPath !== 'string' || binaryPath === '') throw new TypeError('binaryPath must be a path');
  return spawn(binaryPath, [mode], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: childEnv() });
}

/** The child needs nothing from the parent's environment; Windows sockets need SystemRoot. */
function childEnv() {
  if (process.platform !== 'win32') return {};
  return process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
}

/** True for `a.b.c.d:port` or `[v6]:port` with a port in 1..65535, the forms the binary dials. */
function isSocketAddress(text) {
  if (typeof text !== 'string') return false;
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(text);
  if (!match) return false;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return false;
  return match[1] !== undefined ? net.isIPv6(match[1]) : net.isIPv4(match[2]);
}

function isLogValue(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  return typeof value === 'string' && LOG_WORDS.has(value);
}

/**
 * The child's `log` line reduced to what may be logged: a known event name and the
 * allowed fields holding an integer or a fixed word. Anything else is dropped, so a
 * key, an address or traffic cannot reach a log through the child.
 */
function filterLog(event, fields) {
  if (typeof event !== 'string' || !LOG_EVENTS.has(event)) return null;
  const kept = {};
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    for (const [name, value] of Object.entries(fields)) {
      if (LOG_FIELDS.has(name) && isLogValue(value)) kept[name] = value;
    }
  }
  return { event, fields: kept };
}

/**
 * Speaks the line protocol with `child`. `onMessage(object)` gets each parsed line;
 * `onExit(info)` fires exactly once, after the child exited or the channel failed
 * (`info.failed`, plus `info.spawnFailed` when the process never started). A line
 * over the limit, or one that is not a JSON object, kills the child by its own
 * handle and counts as a failure.
 */
function attachControl(child, { onMessage, onExit }) {
  let pending = Buffer.alloc(0);
  let finished = false;
  let failed = false;
  let closed = false;
  let exitInfo = null;
  let stdoutEnded = false;
  let drainTimer = null;

  function finish(info) {
    if (finished) return;
    finished = true;
    clearTimeout(drainTimer);
    try {
      onExit(info);
    } catch {
      // The supervisor's handler never breaks the channel.
    }
  }

  function fail() {
    if (failed || finished) return;
    failed = true;
    pending = Buffer.alloc(0);
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    finish({ code: null, signal: null, failed: true, spawnFailed: false });
  }

  function handleLine(line) {
    if (line.length > MAX_LINE_BYTES) {
      fail();
      return false;
    }
    let message;
    try {
      message = JSON.parse(line.toString('utf8'));
    } catch {
      message = null;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      fail();
      return false;
    }
    try {
      onMessage(message);
    } catch {
      // A handler that throws never breaks the channel.
    }
    return true;
  }

  const settleExit = () => {
    if (exitInfo && stdoutEnded) finish(exitInfo);
  };

  child.stdout.on('data', (chunk) => {
    if (failed || finished || closed) return;
    pending = Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (!handleLine(line)) return;
      if (failed || finished || closed) return;
      newline = pending.indexOf(0x0a);
    }
    if (pending.length > MAX_LINE_BYTES) fail();
  });
  const ended = () => {
    stdoutEnded = true;
    settleExit();
  };
  child.stdout.once('end', ended);
  child.stdout.once('close', ended);
  child.stdout.on('error', () => {});
  if (child.stdin) child.stdin.on('error', () => {});
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal, failed: false, spawnFailed: false };
    settleExit();
    if (!finished) {
      drainTimer = setTimeout(() => finish(exitInfo), EXIT_DRAIN_MS);
      drainTimer.unref();
    }
  });
  child.once('error', () => {
    finish({ code: null, signal: null, failed: true, spawnFailed: typeof child.pid !== 'number' });
  });

  return {
    /** Writes one JSON line to the child. A closed pipe is not an error. */
    send(message) {
      const stdin = child.stdin;
      if (closed || finished || !stdin || stdin.destroyed || stdin.writableEnded) return false;
      try {
        stdin.write(`${JSON.stringify(message)}\n`, () => {});
        return true;
      } catch {
        return false;
      }
    },

    /** Ends the child's stdin (a bridge exits when its input ends) and ignores what comes next. */
    close() {
      closed = true;
      try {
        if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      } catch {
        // Nothing left to close.
      }
    },
  };
}

/** True when `promise` settled within `ms`. */
function settledWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Asks the child to stop, waits `timeoutMs` for its exit, then kills it by its own
 * handle and waits again. `exited` is a promise that settles when `onExit` fired.
 */
async function stopChild({ child, control, exited, timeoutMs }) {
  control.send({ t: 'stop' });
  if (await settledWithin(exited, timeoutMs)) return;
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  await settledWithin(exited, timeoutMs);
}

const encodeKey = (bytes) => Buffer.from(bytes).toString('base64url');

module.exports = {
  ALPN,
  MAX_ADDRESSES,
  MAX_LINE_BYTES,
  attachControl,
  encodeKey,
  filterLog,
  isSocketAddress,
  spawnBridgeChild,
  stopChild,
};
