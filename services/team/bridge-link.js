'use strict';

// One connection to a team host: a new member bridge (the bridge never retries
// and closes its port when the host goes away, so every attempt builds its own),
// a fresh per-bridge launch secret, the HTTP client on the bridge's loopback port
// and the session on top. The secret key and the launch secret stay in the main
// process: the bridge gets them on its stdin, the HTTP client writes the launch
// secret in each socket's preamble, and this file wipes its copies on close.
//
// Review round two (R10-F01, R11-F01): what a refusal means. The host bridge refuses a key its host answered null
// once more, without asking the host, for its refused-key cooldown. A bridge from before round two says
// `host_refused` for that and for an admit the host left unanswered; this round's bridge says `host_cooldown` and
// `host_admit_timeout` (BRIDGE_OWN_REFUSALS), retryable, and only `host_refused` is the host's word. Either way a
// refusal inside one cooldown of a key's first refusal may be the bridge's memory, not the host's answer:
// `createRefusalWindow` says when a refusal counts; `createWaits` waits one out and a stop cuts it.

const crypto = require('node:crypto');

const { isSocketAddress, MAX_ADDRESSES } = require('../../server/team/transport/control-channel');
const { createMemberBridge } = require('./transport/member-bridge');
const { createTeamHttp } = require('./http-client');
const { createTeamSession } = require('./team-session');

const LAUNCH_SECRET_BYTES = 32;
const REFUSAL_WAIT_MS = 1000;
// The host bridge's refused-key cooldown: server/team/transport/host-bridge.js DEFAULT_LIMITS.refusedCooldownMs, a
// ceiling a host may only lower (the binary refuses more). Past it plus the margin, a dial is asked of the host again.
const REFUSED_COOLDOWN_MS = 60_000;
const COOLDOWN_MARGIN_MS = 500;
// The offline reasons a member bridge gives for a dial its host bridge turned away on its own: its refused-key
// cooldown (close code 3) and an admit nobody answered in time (code 4). A transient loss, never the host's refusal.
const BRIDGE_OWN_REFUSALS = Object.freeze(['host_cooldown', 'host_admit_timeout']);
// A manager's redial backoff (connection-manager.js): doubling from `initialMs` to `maxMs`, each delay shortened by up
// to the jitter share, so teams that lost one host do not redial in step.
const DEFAULT_BACKOFF = Object.freeze({ initialMs: 1000, maxMs: 60_000 });
const JITTER = 0.2;

// A zoned address (`[fe80::1%5]:1`) is left out: the binary refuses it, and one would fail the whole dial.
function cleanAddresses(list) {
  const out = [];
  for (const address of Array.isArray(list) ? list : []) {
    if (isSocketAddress(address) && !address.includes('%') && !out.includes(address)) out.push(address);
    if (out.length >= MAX_ADDRESSES) break;
  }
  return out;
}

/** The address sets to dial in order: the last working addresses, then the invite's hints. */
function addressSets(record) {
  const last = cleanAddresses(record.last_addresses);
  const hints = cleanAddresses(record.address_hints);
  const sets = [];
  if (last.length > 0) sets.push(last);
  // Hints the last set already holds were dialled with it: a second dial of the same addresses only adds a wait.
  if (hints.some((address) => !last.includes(address))) {
    sets.push(hints);
  }
  return sets;
}

/**
 * Starts a bridge with `secretKey` towards `hostPublicKey` over `addresses`.
 * Resolves { ok: true, link } once it is online, or { ok: false, reason } with the
 * bridge's reason (`host_unreachable`, `host_refused` or `closed`) after it has stopped.
 * `onBridge(bridge)` is called as soon as the bridge exists, so an owner that stops
 * can stop a dial still in progress (a stopped bridge ends `start` as `closed`).
 * `createBridge` is a test seam for a bridge whose start throws. `relay` (undefined, null or { url, token }) goes
 * to the bridge's start line as it is; a bridge that is told `relay_denied` or `relay_unreachable` says so in `reason`.
 */
async function openLink({
  secretKey, hostPublicKey, addresses, spawnChild, appVersion, protocolVersion, requestTimeoutMs, log,
  onBridge = () => {}, createBridge = createMemberBridge, relay,
}) {
  const launchSecret = crypto.randomBytes(LAUNCH_SECRET_BYTES);
  let bridge;
  try {
    bridge = createBridge({ secretKey, hostPublicKey, addresses, launchSecret, log, spawnChild, ...(relay ? { relay } : {}) });
  } catch {
    launchSecret.fill(0);
    return { ok: false, reason: 'host_unreachable' };
  }
  onBridge(bridge);
  let started;
  try {
    started = await bridge.start();
  } catch {
    started = { state: 'offline', reason: 'host_unreachable' };
  }
  const port = bridge.port();
  if (started.state !== 'online' || !port) {
    launchSecret.fill(0);
    await bridge.stop();
    return { ok: false, reason: started.reason || 'closed' };
  }
  let http;
  let session;
  try {
    // Slice 6-6: model parts go to the bridge's bulk port, only once the host's hello allowed bulk streams.
    http = createTeamHttp({ port, launchSecret, timeoutMs: requestTimeoutMs,
      bulkPort: () => (session?.bulk() ? bridge.bulkPort() : null) });
    session = createTeamSession({ http, appVersion, protocolVersion });
  } catch {
    launchSecret.fill(0);
    await bridge.stop();
    return { ok: false, reason: 'closed' };
  }
  let closing = null;
  const link = {
    bridge, http, session,
    workingAddresses: () => bridge.lastWorkingAddresses(),
    /**
     * The bridge's offline reason once it reports one, or null after a second. A host
     * that refuses a key may let the dial finish first and close the connection right
     * after, so a call with no answer asks this before calling the loss anything.
     */
    offlineReason() {
      const now = bridge.state();
      if (now.state === 'offline') return Promise.resolve(now.reason || 'closed');
      return new Promise((resolve) => {
        const timer = setTimeout(() => { unsubscribe(); resolve(null); }, REFUSAL_WAIT_MS);
        const unsubscribe = bridge.onState((next) => {
          if (next.state !== 'offline') return;
          clearTimeout(timer);
          unsubscribe();
          resolve(next.reason || 'closed');
        });
      });
    },
    /** Ends every socket, wipes the launch secret and stops the bridge; resolves once it has exited. */
    close() {
      if (!closing) {
        http.dispose();
        launchSecret.fill(0);
        closing = bridge.stop();
      }
      return closing;
    },
  };
  return { ok: true, link };
}

/** The delay before redial number `failures` (0 for the first), at least 1 ms. */
function backoffDelay(backoff, failures, random = Math.random) {
  const initial = Math.max(1, backoff.initialMs);
  const base = Math.min(backoff.maxMs, initial * (2 ** Math.min(failures, 30)));
  return Math.max(1, Math.round(base * (1 - JITTER * random())));
}

/**
 * The refusals of one key in a row. `note()` answers null for the first (retry as usual), 0 for one that came a full
 * cooldown after the first (the host was asked again: its word), else the ms until a dial would be asked again.
 * `windowMs` is that full span; `reset()` starts over once the key was admitted.
 */
function createRefusalWindow({ now = Date.now, cooldownMs = REFUSED_COOLDOWN_MS } = {}) {
  const windowMs = cooldownMs + COOLDOWN_MARGIN_MS;
  let first = null;
  return {
    windowMs,
    note() {
      const at = now();
      if (first === null) { first = at; return null; }
      return Math.max(0, first + windowMs - at);
    },
    // The ms until a dial would be asked of the host again, or null when no refusal is open.
    left: () => (first === null ? null : Math.max(1, first + windowMs - now())),
    reset() { first = null; },
  };
}

/** Waits a stop can cut short: `wait(ms)` resolves after `ms` or at `wakeAll()`; no timer outlives either. */
function createWaits(timers = { setTimeout, clearTimeout }) {
  const wakers = new Set();
  return {
    wait: (ms) => new Promise((resolve) => {
      const wake = () => { timers.clearTimeout(timer); wakers.delete(wake); resolve(); };
      const timer = timers.setTimeout(wake, ms);
      wakers.add(wake);
    }),
    wakeAll() { for (const wake of [...wakers]) wake(); },
    pending: () => wakers.size,
  };
}

module.exports = {
  BRIDGE_OWN_REFUSALS, DEFAULT_BACKOFF, REFUSED_COOLDOWN_MS, addressSets, backoffDelay, cleanAddresses,
  createRefusalWindow, createWaits, openLink,
};
