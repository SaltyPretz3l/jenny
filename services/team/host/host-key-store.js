'use strict';

// Slice 5-6: `remove` (the team's delete, last step) and `restore` (a backup's key, only while none is stored).
//
// The team host's Ed25519 seed (slice 1f-2), kept in the app's existing
// safeStorage-backed secure store under one key name and handed to the host
// child over the parent channel, never in a file, an argument or the
// environment. Made on a Deploy with no saved config: owner decision E75
// (2026-11-14) is that such a Deploy always makes a fresh key and writes it over
// any key found, which is never read (a crash between the key and the config, a
// stray key, one that does not decode); no key is ever adopted. Over a saved
// config a stored key is only read, and one that does not decode is a refusal.
//
// Fail closed exactly as the device key store: a missing store, one that is not
// ready, unavailable or on basic_text, a write that throws or a stored value
// that does not decode is CMP-TEAM-0004 with nothing written. Nothing here logs.
//
// The owner's relay token for the host this profile runs is kept under
// `team_host_relay_token` (one host per profile, so no team id; the member's own
// token for the same team keeps `team_relay_token:<team_id>`, and removing that
// membership leaves this one). The member token store's rules: a store that is
// not ready or on basic_text, a token that fails `isRelayToken` on save or load,
// or a call that throws is CMP-TEAM-0004 `team_relay_token_unavailable`; a stored
// value that fails the check is refused, never deleted. It reaches the host child
// only in its `start` message.

const crypto = require('node:crypto');

const { PUBLIC_KEY_BYTES, decodeBase64url, encodeBase64url } = require('../../../server/team/ids');
const { createTokenStore } = require('../relay-token-store');
const { TeamError } = require('../team-errors');

const HOST_KEY_NAME = 'team_host_key';
const HOST_RELAY_TOKEN_NAME = 'team_host_relay_token';

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

  /** A fresh seed, saved over any stored key (E75) before it is handed out; the caller zeroes it. Never reads. */
  function create() {
    const store = readyStore();
    const seed = crypto.randomBytes(PUBLIC_KEY_BYTES);
    try {
      store.set(HOST_KEY_NAME, encodeBase64url(seed));
    } catch {
      seed.fill(0);
      throw unavailable();
    }
    return seed;
  }

  /** Removes the stored key (deleting the team, slice 5-6). Only the delete's last step calls this. */
  function remove() {
    const store = readyStore();
    if (typeof store.delete !== 'function') throw unavailable();
    try { store.delete(HOST_KEY_NAME); } catch { throw unavailable(); }
  }

  /** Stores `seed` from a restored backup (slice 5-6); refused while any key is stored, so none is overwritten. */
  function restore(seed) {
    const store = readyStore();
    if (read(store)) throw unavailable('team_host_key_exists');
    try { store.set(HOST_KEY_NAME, encodeBase64url(seed)); } catch { throw unavailable(); }
  }

  return Object.freeze({ create, load, remove, restore });
}

// The member's token store (relay-token-store.js) with the one fixed name.
function createHostRelayTokenStore({ getSecureStore }) {
  if (typeof getSecureStore !== 'function') throw new TypeError('createHostRelayTokenStore requires getSecureStore.');
  const store = createTokenStore({ getSecureStore, nameOf: () => HOST_RELAY_TOKEN_NAME });
  return Object.freeze({
    save: (token) => store.save(null, token),
    /** The token, or null when none is stored. */
    load: () => store.load(null),
    remove: () => store.remove(null),
  });
}

module.exports = { HOST_KEY_NAME, HOST_RELAY_TOKEN_NAME, createHostKeyStore, createHostRelayTokenStore };
