'use strict';

// The reconnect code (TEAM_INTERNET_SPEC I9, slice 5-3): where a team's host can
// be reached now, for a member whose stored addresses went stale.
//
//   "jteamaddr1_" + base64url( host_public_key (32) | hint_count (1, 1..4) | hint * hint_count
//                              | name_len (1) | name (0..63) | name_port (2, only when name_len > 0)
//                              | checksum (4, SHA-256 over "jteamaddr1" | body) )
//
// Hints and the name use the invite codec's encodings (server/team/invites.js).
// No secret: the code grants nothing. It changes where a member dials, never who
// the host is: a code is applied only to the team whose host key it names, and
// the bridge still checks that key on every connection (T6). Input is
// length-checked (512 characters) before any decoding; the parser is total and
// a refusal is a reason word only. A code never reaches a log, a failure, the
// host or `command-receipts.json`: the owner builds it in main from the host's
// own hints, and the member applies it to its client file in main.

const { PUBLIC_KEY_BYTES, decodeBase64url, deriveTeamId, encodeBase64url } = require('../../server/team/ids');
const {
  addressClass, checksumOf, decodeChecked, encodeHints, encodeHostName, inviteContent, orderHints, readHints, readHostName,
} = require('../../server/team/invites');
const { loadClientFile, saveClientFile, withRoute } = require('./client-file');
const { teamFailure } = require('./team-errors');

const RECONNECT_PREFIX = 'jteamaddr1_';
const RECONNECT_LABEL = 'jteamaddr1';
const MAX_RECONNECT_CODE_CHARS = 512;

const malformed = () => ({ ok: false, reason: 'team_reconnect_code_malformed' });

/** { ok: true, code } or { ok: false, reason }: a code needs the host key and one to four hints. */
function encodeReconnectCode({ hostPublicKey, hints, hostName = null }) {
  const host = decodeBase64url(hostPublicKey, PUBLIC_KEY_BYTES);
  const hintBytes = encodeHints(hints, 1);
  const nameBytes = encodeHostName(hostName);
  if (!host || !hintBytes || !nameBytes) return malformed();
  const body = Buffer.concat([host, hintBytes, nameBytes]);
  const code = `${RECONNECT_PREFIX}${encodeBase64url(Buffer.concat([body, checksumOf(body, RECONNECT_LABEL)]))}`;
  return code.length > MAX_RECONNECT_CODE_CHARS ? malformed() : { ok: true, code };
}

/** { ok: true, team_id, host_public_key, hints, host_name } or { ok: false, reason: 'team_reconnect_code_malformed' }. */
function parseReconnectCode(text) {
  if (typeof text !== 'string' || text.length > MAX_RECONNECT_CODE_CHARS || !text.startsWith(RECONNECT_PREFIX)) {
    return malformed();
  }
  const body = decodeChecked(text, RECONNECT_PREFIX, RECONNECT_LABEL, PUBLIC_KEY_BYTES + 1);
  const read = body && readHints(body, PUBLIC_KEY_BYTES, 1);
  const name = read && readHostName(body, read.next);
  if (!name || name.next !== body.length) return malformed();
  // The code is unsigned and every member knows the host key: hints of a class no Jenny-built code
  // carries (loopback, link-local, IPv4-mapped, 100.64/10) are dropped, and none left is a refusal.
  const hints = read.hints.filter((hint) => addressClass(hint) !== 'excluded');
  if (hints.length === 0) return malformed();
  const hostPublicKey = encodeBase64url(body.subarray(0, PUBLIC_KEY_BYTES));
  return { ok: true, team_id: deriveTeamId(hostPublicKey), host_public_key: hostPublicKey, hints,
    host_name: name.value };
}

/**
 * The owner's code for its running host (IPC `hostReconnectCode`): the host's current hints, ordered
 * as an internet invite's are, and the owner-entered name when there is one. `internet` is the host's
 * internet setting as invites.js `inviteContent` takes it (null while off; slice 5-5 supplies it).
 * { ok: true, code } or { ok: false, reason } (`team_host_addresses_unavailable` with no usable hint).
 */
function buildHostReconnectCode({ hostPublicKey, addresses, internet }) {
  const content = internet === null ? { ok: true, hints: orderHints({ addresses }), internet: null }
    : inviteContent(internet, addresses);
  if (!content.ok) return { ok: false, reason: content.error.reason };
  if (content.hints.length === 0) return { ok: false, reason: 'team_host_addresses_unavailable' };
  return encodeReconnectCode({ hostPublicKey, hints: content.hints, hostName: content.internet?.hostName ?? null });
}

/**
 * The member's client file record after a pasted code (IPC `teamReconnectCode`): the code's hints
 * and name replace `address_hints` and `host_name`, and the stale `last_addresses` are cleared, so
 * the next dial goes to the new place first. Everything else, the relay URL included, is kept.
 * A code that does not parse is CMP-TEAM-0003 `team_reconnect_code_malformed`; one naming another
 * host key is `team_reconnect_code_other_team`. Pure: the caller writes the record.
 */
function applyReconnectCode(record, code) {
  const parsed = parseReconnectCode(code);
  if (!parsed.ok) return teamFailure('INVITE_MALFORMED', parsed.reason);
  if (!record || parsed.host_public_key !== record.host_public_key || parsed.team_id !== record.team_id) {
    return teamFailure('INVITE_MALFORMED', 'team_reconnect_code_other_team');
  }
  return { ok: true, record: withRoute({ ...record, address_hints: [...parsed.hints], last_addresses: [] },
    { host_name: parsed.host_name, relay_url: record.relay_url ?? null }) };
}

/**
 * The member's `teamReconnectCode`: loads the team's client file, applies the code and saves it.
 * Resolves { ok: true, record } or a failure; a refused code (malformed, another team's) reads the
 * file and writes nothing. The caller stops the team's connection manager before and starts a new
 * one from the saved file after, so a running manager never writes its old addresses back.
 */
function writeReconnectCode({ userDataPath, teamId, code }) {
  const loaded = loadClientFile(userDataPath, teamId);
  if (!loaded.ok) return teamFailure('CONNECTION_FAILED', loaded.reason);
  const applied = applyReconnectCode(loaded.record, code);
  if (!applied.ok) return applied;
  const saved = saveClientFile(userDataPath, applied.record);
  return saved.ok ? { ok: true, record: applied.record } : teamFailure('CONNECTION_FAILED', saved.reason);
}

module.exports = {
  MAX_RECONNECT_CODE_CHARS, applyReconnectCode, buildHostReconnectCode, encodeReconnectCode,
  parseReconnectCode, writeReconnectCode,
};
