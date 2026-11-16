'use strict';

// One Ed25519 device seed per team, kept in the app's existing safeStorage-backed
// secure store (TEAM_MEMBERSHIP_SPEC "Desktop client (M15)"). The store is
// resolved on every call because it does not exist before the backend service is
// created. Only the generic get/set/delete are used, under a team-owned key name
// built from a validated team id; the value is base64url of the 32-byte seed.
//
// Fail closed: a missing store, one that is not ready, unavailable or on
// basic_text, a write that throws or a stored value that does not decode is
// CMP-TEAM-0004. There is no plaintext file, no environment variable and no key
// held in memory that was not saved. Nothing here logs.
//
// Slice 5-3: the team's relay token (relay-token-store.js) lives beside the key
// in the same store, so the join flow and every removal path, which all hold
// this object, keep and drop it together: `remove` deletes the token first, then
// the key, and a removed team leaves neither behind.

const { PUBLIC_KEY_BYTES, decodeBase64url, encodeBase64url, isId } = require('../../server/team/ids');
const { createRelayTokenStore, readySecureStore, relayTokenName } = require('./relay-token-store');
const { TeamError } = require('./team-errors');

const DEVICE_KEY_PREFIX = 'team_device_key:';

function deviceKeyName(teamId) {
  if (!isId('team', teamId)) throw new TypeError('A device key name needs a valid team id.');
  return `${DEVICE_KEY_PREFIX}${teamId}`;
}

function unavailable(reason = 'team_device_key_unavailable') {
  return new TeamError('DEVICE_KEY_UNAVAILABLE', reason);
}

function createDeviceKeyStore({ getSecureStore }) {
  if (typeof getSecureStore !== 'function') throw new TypeError('createDeviceKeyStore requires getSecureStore.');

  // The relay token store's check (slice 5-3 review item 17), so a ready store on basic_text is refused here too.
  const readyStore = () => readySecureStore(getSecureStore, () => unavailable());

  function save(teamId, seed) {
    const name = deviceKeyName(teamId);
    if (!(seed instanceof Uint8Array) || seed.length !== PUBLIC_KEY_BYTES) {
      throw new TypeError('A device seed is 32 bytes.');
    }
    const store = readyStore();
    try {
      store.set(name, encodeBase64url(seed));
    } catch {
      throw unavailable();
    }
  }

  /** The seed as a Buffer, or null when this team has none. */
  function load(teamId) {
    const name = deviceKeyName(teamId);
    const store = readyStore();
    let value;
    try {
      value = store.get(name);
    } catch {
      throw unavailable();
    }
    if (value === '' || value === null || value === undefined) return null;
    const seed = decodeBase64url(value, PUBLIC_KEY_BYTES);
    if (!seed) throw unavailable('team_device_key_invalid');
    return seed;
  }

  function remove(teamId) {
    const name = deviceKeyName(teamId);
    const store = readyStore();
    try {
      store.delete(relayTokenName(teamId));
      store.delete(name);
    } catch {
      throw unavailable();
    }
  }

  /** True when this team has a stored key (also an unreadable one); throws when the store is unavailable. */
  function has(teamId) {
    try {
      const seed = load(teamId);
      if (!seed) return false;
      seed.fill(0);
      return true;
    } catch (error) {
      if (error instanceof TeamError && error.reason === 'team_device_key_invalid') return true;
      throw error;
    }
  }

  function available() {
    try {
      readyStore();
      return true;
    } catch {
      return false;
    }
  }

  const relayTokens = createRelayTokenStore({ getSecureStore });

  return Object.freeze({
    save, load, has, remove, available,
    saveRelayToken: relayTokens.save, loadRelayToken: relayTokens.load, removeRelayToken: relayTokens.remove,
  });
}

module.exports = { createDeviceKeyStore, deviceKeyName };
