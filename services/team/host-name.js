'use strict';

// A team host's DNS name, resolved on the member's side (TEAM_INTERNET_SPEC
// "Owner-entered public address", slice 5-3; plan row E44). The name comes from
// a version 2 invite or a reconnect code and sits in the client file; a
// manager looks it up on every connect (a join once per join) and the answer is
// never kept across connects, so a dynamic-DNS name follows the host's address.
// The bridge takes `ip:port` only, so the answers are appended to address sets.
// A connect never waits for the name before its first stored set (createRoute),
// and a stopping manager never waits for a lookup.
//
// A DNS answer is untrusted: at most 32 entries are read and 4 addresses used;
// anything that is not an IPv4 or IPv6 address (a zone id included), and any
// address of a class no Jenny invite carries (loopback, link-local, IPv4-mapped,
// 100.64/10: invites.js `addressClass` 'excluded'), is dropped; each caller
// waits at most 3 seconds, and one lookup per name is in flight at a time. The
// name and its answers never reach a log line, a failure or the renderer: a
// failure is the reason word `host_name_unresolved` only. Tests inject `lookup`;
// no test resolves a real name.

const dns = require('node:dns');
const net = require('node:net');

const { MAX_ADDRESSES, isSocketAddress } = require('../../server/team/transport/control-channel');
const { addressClass, isHostNameValue } = require('../../server/team/invites');

const MAX_RESOLVED = 4;
const MAX_ANSWERS_READ = 32;
const RESOLVE_TIMEOUT_MS = 3000;
const UNRESOLVED = Object.freeze({ ok: false, reason: 'host_name_unresolved' });

function socketAddressOf(entry, port) {
  if (!entry || typeof entry.address !== 'string' || entry.address.includes('%')) return null;
  const family = net.isIP(entry.address);
  if (family === 0 || entry.address === '0.0.0.0' || entry.address === '::') return null;
  const text = family === 4 ? `${entry.address}:${port}` : `[${entry.address}]:${port}`;
  return isSocketAddress(text) && addressClass(text) !== 'excluded' ? text : null;
}

// One lookup in flight per lookup function and name; a caller that comes while one runs shares it.
const inflight = new WeakMap();
function sharedLookup(lookup, name) {
  let byName = inflight.get(lookup);
  if (!byName) {
    byName = new Map();
    inflight.set(lookup, byName);
  }
  let running = byName.get(name);
  if (!running) {
    running = Promise.resolve().then(() => lookup(name, { all: true, family: 0, verbatim: true })).catch(() => null);
    byName.set(name, running);
    void running.then(() => { if (byName.get(name) === running) byName.delete(name); });
  }
  return running;
}

/**
 * Resolves `{ name, port }` to { ok: true, addresses } (one to four `ip:port` strings) or
 * { ok: false, reason: 'host_name_unresolved' }. Never throws; `lookup` is `dns.promises.lookup`'s shape.
 */
async function resolveHostName(hostName, { lookup = dns.promises.lookup, timeoutMs = RESOLVE_TIMEOUT_MS,
  timers = { setTimeout, clearTimeout } } = {}) {
  if (!hostName || !isHostNameValue(hostName)) return UNRESOLVED;
  let timer = null;
  try {
    const timeout = new Promise((resolve) => {
      timer = timers.setTimeout(() => resolve(null), timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const answers = await Promise.race([sharedLookup(lookup, hostName.name), timeout]);
    if (!Array.isArray(answers)) return UNRESOLVED;
    const addresses = [];
    for (const entry of answers.slice(0, MAX_ANSWERS_READ)) {
      const text = socketAddressOf(entry, hostName.port);
      if (text && !addresses.includes(text)) addresses.push(text);
      if (addresses.length >= MAX_RESOLVED) break;
    }
    return addresses.length > 0 ? { ok: true, addresses } : UNRESOLVED;
  } catch {
    return UNRESOLVED;
  } finally {
    if (timer !== null) timers.clearTimeout(timer);
  }
}

// The resolved addresses a resolver answered that may be dialled, at most four.
function answersOf(resolved) {
  if (!resolved || resolved.ok !== true || !Array.isArray(resolved.addresses)) return [];
  return resolved.addresses.filter(isSocketAddress).slice(0, MAX_RESOLVED);
}

// `set` with the resolved addresses appended, keeping room for them.
function appended(set, extra) {
  return [...new Set([...set.slice(0, MAX_ADDRESSES - extra.length), ...extra])];
}

/**
 * One connect's address sets for a team that may have a DNS name. `set(index)` gives the set to dial
 * at that index, or null after the last. With no name it answers synchronously from `sets`. With a
 * name the lookup starts at once and the first stored set is dialled as it is without waiting; the
 * sets after it get the answers appended, and when none is left the answers are a set of their own.
 * With no stored set the lookup is awaited. `cancel()` ends a wait for the lookup at once (null), so a
 * stopping manager never waits for a resolver. `unresolved()` is true once the lookup gave nothing.
 */
function createRoute(sets, hostName, resolveName = resolveHostName) {
  if (!hostName) return { set: (index) => sets[index] ?? null, unresolved: () => false, cancel() {} };
  let release = () => {};
  const cancelled = new Promise((resolve) => { release = () => resolve(null); });
  let unresolved = false;
  const later = Promise.resolve().then(() => resolveName(hostName)).catch(() => UNRESOLVED).then((resolved) => {
    const extra = answersOf(resolved);
    unresolved = extra.length === 0;
    if (sets.length === 0) return extra.length > 0 ? [extra] : [];
    const after = sets.slice(1);
    if (extra.length === 0) return after;
    if (after.length > 0) return after.map((set) => appended(set, extra));
    return extra.some((address) => !sets[0].includes(address)) ? [extra] : [];
  });
  return {
    set(index) {
      if (index === 0 && sets.length > 0) return sets[0];
      const offset = sets.length > 0 ? index - 1 : index;
      return Promise.race([later, cancelled]).then((rest) => (rest ? rest[offset] ?? null : null));
    },
    unresolved: () => unresolved,
    cancel: () => release(),
  };
}

/**
 * The address sets to dial once a name is resolved: each set keeps room for the resolved addresses
 * and gets them appended; with no other set, the resolved addresses are the one set. `unresolved` is
 * true when a name was set and the lookup gave nothing. With no name, `sets` is returned as is and
 * no lookup happens (a LAN team does no DNS at all).
 */
async function withHostName(sets, hostName, resolveName = resolveHostName) {
  if (!hostName) return { sets, unresolved: false };
  let resolved;
  try { resolved = await resolveName(hostName); } catch { resolved = UNRESOLVED; }
  const extra = answersOf(resolved);
  if (extra.length === 0) return { sets, unresolved: true };
  if (sets.length === 0) return { sets: [extra], unresolved: false };
  return { sets: sets.map((set) => appended(set, extra)), unresolved: false };
}

module.exports = { createRoute, resolveHostName, withHostName };
