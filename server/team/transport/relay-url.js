'use strict';

// The owner's relay URL (TEAM_INTERNET_SPEC "The owner's relay", slice 5-3):
// one `https` URL with a DNS host name and an optional port, nothing else. No
// user info, path, query or fragment; at most 100 characters. Pure: no network,
// no transport library, no URL parser that could normalise a refused form into
// an accepted one. The canonical form is lower case with no trailing slash, and
// it is the only form an invite or a client file may carry.
//
// A refusal is a reason word only: the text never reaches a log, a failure or
// an error message.
//
// Team review fixes (row 201): an invite names the relay a member's bridge dials,
// so the rule is the bridge's (native relay.rs `destination_ok`): `localhost` and
// every name under it are refused, as every address literal already is (private
// LAN addresses included: a relay a member reaches over the internet has a name).
// The relay token's one grammar lives here too, for invites.js, the owner's
// setting and the bridge's start line alike.

const MAX_RELAY_URL_CHARS = 100;
const SCHEME = 'https://';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
// An HTTP bearer token's characters (RFC 6750 b64token), so the bridge can send it as is; at most 48 of them.
const MAX_RELAY_TOKEN_CHARS = 48;
const RELAY_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/u;

function refused() {
  return { ok: false, reason: 'team_relay_url_invalid' };
}

/**
 * True for a DNS host name: dot-separated labels, at most 253 characters, not an address literal.
 * A last label of digits only or in hex (`0x7f000001`, `1.2.3.0x4`) is refused: getaddrinfo reads
 * those as IPv4 addresses.
 */
function isDnsHostName(text, maxChars = 253) {
  if (typeof text !== 'string' || text.length < 1 || text.length > maxChars) return false;
  const labels = text.toLowerCase().split('.');
  if (!labels.every((label) => LABEL.test(label))) return false;
  return !/^(?:\d+|0x[0-9a-f]*)$/iu.test(labels[labels.length - 1]);
}

/**
 * Parses an owner-entered relay URL. Returns { ok: true, url } with the canonical
 * form (`https://host` or `https://host:port`, lower case), or { ok: false, reason }.
 * Total: any input yields one of the two, in bounded work.
 */
function parseRelayUrl(text) {
  if (typeof text !== 'string' || text.length > MAX_RELAY_URL_CHARS) return refused();
  if (text.slice(0, SCHEME.length).toLowerCase() !== SCHEME) return refused();
  let rest = text.slice(SCHEME.length);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  // Anything that could start user info, a path, a query, a fragment or an IPv6 literal is refused.
  if (/[@/?#[\]\\%\s]/u.test(rest)) return refused();
  const match = /^([^:]+)(?::(\d{1,5}))?$/u.exec(rest);
  if (!match || !isDnsHostName(match[1])) return refused();
  const host = match[1].toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return refused();
  if (match[2] === undefined) return { ok: true, url: `${SCHEME}${host}` };
  if (!/^[1-9]\d*$/u.test(match[2])) return refused();
  const port = Number(match[2]);
  if (port > 65535) return refused();
  return { ok: true, url: port === 443 ? `${SCHEME}${host}` : `${SCHEME}${host}:${port}` };
}

/** True when `text` is already a relay URL in its canonical form. */
function isCanonicalRelayUrl(text) {
  const parsed = parseRelayUrl(text);
  return parsed.ok && parsed.url === text;
}

/** True for a relay token in the one grammar: 1 to 48 characters of an HTTP bearer token. */
function isRelayToken(text) {
  return typeof text === 'string' && text.length >= 1 && text.length <= MAX_RELAY_TOKEN_CHARS && RELAY_TOKEN.test(text);
}

module.exports = {
  MAX_RELAY_TOKEN_CHARS, MAX_RELAY_URL_CHARS, isCanonicalRelayUrl, isDnsHostName, isRelayToken, parseRelayUrl,
};
