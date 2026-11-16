'use strict';

// What a dial reads from the secure store, just before it dials (TEAM_INTERNET_SPEC "5-5c as built"): the device
// key, and the saved relay. Read for every dial, so a key or token saved after a reconnect is used without a
// restart. A store that cannot answer is a refusal to dial, never a dial without checking: the answer then carries
// the store's reason.
//
// The relay is the saved `relay_url` with the token under `team_relay_token:<team_id>` (relay-token-store.js).
// No URL: no relay, and the token store is not read (a token with no URL is ignored). A URL with no saved token
// is `{ url, token: null }`. Once a dial answers `relay_denied` the relay is not asked again for this manager's
// lifetime (`refuse()`): later dials pass none and do not read the token, so a refused token is not presented
// again. A new manager (a new join, a recovery or a reconnect code) asks again with whatever is saved then. The
// token is handed on to the bridge and never logged, kept or put in a snapshot.

const { TeamError } = require('./team-errors');

const storeReason = (error, fallback) => (error instanceof TeamError ? error.reason : fallback);

function createDialSecrets({ deviceKeys, teamId, record }) {
  let relayRefused = false;

  return {
    /** { seed } (the caller zeroes it), or { reason, retry } when there is none or the store cannot answer. */
    key() {
      try {
        const seed = deviceKeys.load(teamId);
        return seed ? { seed } : { reason: 'team_device_key_missing' };
      } catch (error) {
        return { reason: storeReason(error, 'team_device_key_unavailable'), retry: true };
      }
    },

    /** { relay } (null, or { url, token }), or { reason } when the token store cannot answer. */
    relay() {
      const url = record.relay_url ?? null;
      if (relayRefused || !url) return { relay: null };
      try {
        return { relay: { url, token: deviceKeys.loadRelayToken(teamId) } };
      } catch (error) {
        return { reason: storeReason(error, 'team_relay_token_unavailable') };
      }
    },

    refuseRelay() { relayRefused = true; },
    relayRefused: () => relayRefused,
  };
}

module.exports = { createDialSecrets };
