'use strict';

// The team host's Ed25519 seed (slice 1f-2), kept in the app's existing
// safeStorage-backed secure store under one key name and handed to the host
// child over the parent channel, never in a file, an argument or the
// environment. Made once, on the first Deploy; a stored key is never
// regenerated or overwritten, also when it does not decode (that is a refusal).
//
// Fail closed exactly as the device key store: a missing store, one that is not
// ready, unavailable or on basic_text, a write that throws or a stored value
// that does not decode is CMP-TEAM-0004 with nothing written. Nothing here logs.

const crypto = require('node:crypto');

const { PUBLIC_KEY_BYTES, decodeBase64url, encodeBase64url } = require('../../../server/team/ids');
const { TeamError } = require('../team-errors');

const HOST_KEY_NAME = 'team_host_key';

function unavailable(reason = 'team_host_key_unavailable') {
  return new TeamError('DEVICE_KEY_UNAVAILABLE', reason);
}

function createHostKeyStore({ getSecureStore }) {
  if (typeof getSecureStore !== 'function') throw new TypeError('createHostKeyStore requires getSecureStore.');

  function readyStore() {
    let store;
    try { store = getSecureStore(); } catch { store = null; }
    if (!store || typeof store.get !== 'function' || typeof store.set !== 'function'
      || typeof store.getStatus !== 'function') throw unavailable();
    let status;
    try { status = store.getStatus(); } catch { status = null; }
    if (!status || status.ready !== true) throw unavailable();
    return store;
  }

  // The decoded seed itself (the only copy; the caller zeroes it), or null when none is stored.
  function read(store) {
    let value;
    try { value = store.get(HOST_KEY_NAME); } catch { throw unavailable(); }
    if (value === '' || value === null || value === undefined) return null;
    const seed = decodeBase64url(value, PUBLIC_KEY_BYTES);
    if (!seed) throw unavailable('team_host_key_invalid');
    return seed;
  }

  /** The seed as a Buffer the caller zeroes, or null when none is stored. */
  function load() {
    return read(readyStore());
  }

  /** The stored seed, or a new one saved first; `created` says which. One read; never overwrites. */
  function loadOrCreate() {
    const store = readyStore();
    const existing = read(store);
    if (existing) return { seed: existing, created: false };
    const seed = crypto.randomBytes(PUBLIC_KEY_BYTES);
    try {
      store.set(HOST_KEY_NAME, encodeBase64url(seed));
    } catch {
      seed.fill(0);
      throw unavailable();
    }
    return { seed, created: true };
  }

  return Object.freeze({ load, loadOrCreate });
}

module.exports = { HOST_KEY_NAME, createHostKeyStore };
