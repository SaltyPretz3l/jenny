'use strict';

// The owner's internet joining setting as `hostInternet` (slice 5-5b) takes it and the host state shows it
// (slice 5-6). Checks only, no IO; moved out of host-controller.js unchanged. The relay token itself never leaves
// main: the host state says only `has_token`.

const { invalidRequest } = require('../team-errors');
const { isRelayToken, parsePublicAddress } = require('../../../server/team/invites');
const { parseRelayUrl } = require('../../../server/team/transport/relay-url');

// An owner address with no port takes the direct port; checking one before a port exists needs a stand-in.
const STAND_IN_PORT = 443;
const SETTING_FIELDS = Object.freeze(['public_address', 'relay_url', 'token']);

// The `hostInternet` payload as the record the config keeps, or a refusal; checks only, no IO. Off is null.
function internetFromPayload(value, directPort) {
  if (value.enabled !== true) {
    return SETTING_FIELDS.some((field) => Object.hasOwn(value, field)) ? invalidRequest() : { ok: true, internet: null };
  }
  const address = value.public_address ?? null;
  if (address !== null && parsePublicAddress(address, directPort ?? STAND_IN_PORT).ok !== true) {
    return invalidRequest('team_public_address_invalid');
  }
  let relayUrl = null;
  if ((value.relay_url ?? null) !== null) {
    const parsed = parseRelayUrl(value.relay_url);
    if (!parsed.ok) return invalidRequest('team_relay_url_invalid');
    relayUrl = parsed.url;
  }
  const token = value.token ?? null;
  if (token !== null && (!isRelayToken(token) || relayUrl === null)) return invalidRequest('team_relay_token_invalid');
  return { ok: true, internet: { map_port: true, public_address: address, relay_url: relayUrl } };
}

// What happens to the stored token: a new one is saved; it is kept only while the same relay stays and no
// token is named; anything else (off, no relay, `token: null`, another relay) removes it, so a token is
// never presented to a relay it was not entered for.
function tokenStepOf(value, next, previous) {
  if (next === null || next.relay_url === null) return 'remove';
  if (typeof value.token === 'string') return 'save';
  return !Object.hasOwn(value, 'token') && previous?.relay_url === next.relay_url ? 'keep' : 'remove';
}

// The saved config with the team block's `internet` replaced (null removes it); everything else as it was.
function withInternet(saved, internet) {
  const { internet: _previous, ...team } = saved.team;
  return { ...saved, team: internet ? { ...team, internet } : team };
}

/**
 * The owner's own setting as the host state shows it (slice 5-6, finding 1): null while off, else
 * `{ public_address, relay_url, has_token }`. `hasToken()` is asked only when a relay is set.
 */
function internetView(record, hasToken) {
  if (!record) return null;
  const relayUrl = typeof record.relay_url === 'string' ? record.relay_url : null;
  return { public_address: typeof record.public_address === 'string' ? record.public_address : null, relay_url: relayUrl,
    has_token: relayUrl !== null && hasToken() === true };
}

module.exports = { internetFromPayload, internetView, tokenStepOf, withInternet };
