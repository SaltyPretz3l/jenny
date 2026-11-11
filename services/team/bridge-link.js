'use strict';

// One connection to a team host: a new member bridge (the bridge never retries
// and closes its port when the host goes away, so every attempt builds its own),
// a fresh per-bridge launch secret, the HTTP client on the bridge's loopback port
// and the session on top. The secret key and the launch secret stay in the main
// process: the bridge gets them on its stdin, the HTTP client writes the launch
// secret in each socket's preamble, and this file wipes its copies on close.

const crypto = require('node:crypto');

const { isSocketAddress, MAX_ADDRESSES } = require('../../server/team/transport/control-channel');
const { createMemberBridge } = require('./transport/member-bridge');
const { createTeamHttp } = require('./http-client');
const { createTeamSession } = require('./team-session');

const LAUNCH_SECRET_BYTES = 32;
const REFUSAL_WAIT_MS = 1000;

function cleanAddresses(list) {
  const out = [];
  for (const address of Array.isArray(list) ? list : []) {
    if (isSocketAddress(address) && !out.includes(address)) out.push(address);
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
  if (hints.length > 0 && !(hints.length === last.length && hints.every((address, i) => address === last[i]))) {
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
 * `createBridge` is a test seam for a bridge whose start throws.
 */
async function openLink({
  secretKey, hostPublicKey, addresses, spawnChild, appVersion, protocolVersion, requestTimeoutMs, log,
  onBridge = () => {}, createBridge = createMemberBridge,
}) {
  const launchSecret = crypto.randomBytes(LAUNCH_SECRET_BYTES);
  let bridge;
  try {
    bridge = createBridge({ secretKey, hostPublicKey, addresses, launchSecret, log, spawnChild });
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
    http = createTeamHttp({ port, launchSecret, timeoutMs: requestTimeoutMs });
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

module.exports = { addressSets, cleanAddresses, openLink };
