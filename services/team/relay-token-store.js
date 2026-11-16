'use strict';

// The owner's relay token for one team, on the member's side (TEAM_INTERNET_SPEC
// I13, slice 5-3; plan row E45). It arrives in a version 2 invite and is kept in
// the app's safeStorage-backed secure store under `team_relay_token:<team_id>`,
// never in the client file, a log, an environment variable or an argument. The
// connection manager reads it before every dial, for the member bridge's `start`
// line (dial-secrets.js).
// One factory (createTokenStore) makes both token stores: the member's, named by
// team id, and the host's, named once (services/team/host/host-key-store.js).
//
// Fail closed, with the device key store's rules: a missing store, one that is
// not ready, unavailable or on basic_text, a write that throws or a stored value
// that is not a token is CMP-TEAM-0004 `team_relay_token_unavailable`, and the
// join that carried the token does not go ahead. Nothing here logs. The device
// key store composes these calls on the same store, so removing a team's key
// also removes its token (services/team/device-key-store.js).

const { isId } = require('../../server/team/ids');
const { isRelayToken } = require('../../server/team/invites');
const { TeamError } = require('./team-errors');

const RELAY_TOKEN_PREFIX = 'team_relay_token:';
const BASIC_TEXT = 'basic_text';

function relayTokenName(teamId) {
  if (!isId('team', teamId)) throw new TypeError('A relay token name needs a valid team id.');
  return `${RELAY_TOKEN_PREFIX}${teamId}`;
}

function unavailable() {
  return new TeamError('DEVICE_KEY_UNAVAILABLE', 'team_relay_token_unavailable');
}

/**
 * The secure store when it is ready and protected; throws `makeError()` otherwise. Shared with the
 * device key store. The real store already reports basic_text as not ready; the backend is checked
 * here too (defence, kept on purpose).
 */
function readySecureStore(getSecureStore, makeError) {
  let store;
  try { store = getSecureStore(); } catch { store = null; }
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function'
    || typeof store.delete !== 'function' || typeof store.getStatus !== 'function') throw makeError();
  let status;
  try { status = store.getStatus(); } catch { status = null; }
  if (!status || status.ready !== true || status.storageBackend === BASIC_TEXT) throw makeError();
  return store;
}

const readyTokenStore = (getSecureStore) => readySecureStore(getSecureStore, unavailable);

/**
 * A relay token store over the secure store: { save(key, token), load(key), remove(key) }. `nameOf(key)` makes the
 * entry's name (and may throw for a bad key); the store's rules are the ones in the header.
 */
function createTokenStore({ getSecureStore, nameOf }) {
  function save(key, token) {
    const name = nameOf(key);
    if (!isRelayToken(token)) throw unavailable();
    const store = readyTokenStore(getSecureStore);
    try { store.set(name, token); } catch { throw unavailable(); }
  }

  /** The token, or null when there is none. */
  function load(key) {
    const name = nameOf(key);
    const store = readyTokenStore(getSecureStore);
    let value;
    try { value = store.get(name); } catch { throw unavailable(); }
    if (value === '' || value === null || value === undefined) return null;
    if (!isRelayToken(value)) throw unavailable();
    return value;
  }

  function remove(key) {
    const name = nameOf(key);
    const store = readyTokenStore(getSecureStore);
    try { store.delete(name); } catch { throw unavailable(); }
  }

  return Object.freeze({ save, load, remove });
}

function createRelayTokenStore({ getSecureStore }) {
  if (typeof getSecureStore !== 'function') throw new TypeError('createRelayTokenStore requires getSecureStore.');
  return createTokenStore({ getSecureStore, nameOf: relayTokenName });
}

module.exports = { createRelayTokenStore, createTokenStore, readySecureStore, relayTokenName };
