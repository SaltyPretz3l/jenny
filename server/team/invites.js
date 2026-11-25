'use strict';

// Invites: the one-time key pair, the memory slot that holds the secret for ten
// minutes, the invite string, and the redeem wrapper. The member store keeps
// only the invite's public key; the secret never reaches the disk, a receipt or
// a log line. `reveal` hands the string out once.
//
// Invite string version 1, at most 256 characters:
//   "jteam1_" + base64url( host_public_key (32) | invite_secret_key (32)
//                          | hint_count (1) | hint * hint_count | checksum (4) )
// Each address hint is one tag byte, the raw address and a big-endian port:
//   tag 4: 4 address bytes (IPv4)    tag 6: 16 address bytes (IPv6)    then 2 port bytes
// so a hint is 7 or 19 bytes and four IPv6 hints stay far inside the limit. The
// checksum is the first 4 bytes of SHA-256 over "jteam1" and every byte before
// it. It catches a mistyped or truncated code; it is not a signature. Hints are
// "ip:port" or "[ipv6]:port" text on the way in and out; an IPv6 zone id or an
// embedded IPv4 form is refused.
//
// Version 2 (TEAM_INTERNET_SPEC "Invite version 2", slice 5-3), issued only
// while the host's internet joining is on, at most 512 characters:
//   "jteam2_" + base64url( host_public_key (32) | invite_secret_key (32)
//                          | hint_count (1) | hint * hint_count            (as version 1, at most 4)
//                          | name_len (1) | name (ASCII, 0..63) | name_port (2, only when name_len > 0)
//                          | relay_len (1) | relay_url (ASCII, 0..100)
//                          | token_len (1) | token (ASCII, 0..48)
//                          | checksum (4, over "jteam2" and every byte before it) )
// A name is a lower-case DNS name the member resolves on every dial; a relay URL
// is canonical (server/team/transport/relay-url.js); a token needs a relay URL.
// `jteam<N>_` with N above 2 answers `team_invite_too_new`. Every input is
// length-checked before any decoding, and the parser is total: any value yields
// a result or a named refusal that never echoes the input.

const crypto = require('node:crypto');
const net = require('node:net');

const { hostFailure } = require('../api-contract');
const {
  PUBLIC_KEY_BYTES, decodeBase64url, encodeBase64url, deriveTeamId, keyPairFromSeed,
} = require('./ids');
const { safeLogger } = require('./safe-logger');
const {
  MAX_RELAY_TOKEN_CHARS, MAX_RELAY_URL_CHARS, isCanonicalRelayUrl, isDnsHostName, isRelayToken,
} = require('./transport/relay-url');

const INVITE_PREFIX = 'jteam1_';
const INVITE_PREFIX_V2 = 'jteam2_';
const MAX_INVITE_CHARS = 512;
const V1_MAX_CHARS = 256;
const MAX_HINTS = 4;
const MAX_HOST_NAME_CHARS = 63;
const CHECKSUM_BYTES = 4;
const SLOT_MS = 10 * 60 * 1000;
const VERSION_PREFIX = /^jteam([1-9]\d{0,3})_/u;

function malformed() {
  return hostFailure('invalid', 'team_invite_malformed');
}

function notValid() {
  return hostFailure('forbidden', 'invite_not_valid');
}

// ------------------------------------------------------------------ hints

function ipv4ToBytes(text) {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9]\d{0,2})$/u.test(part) && Number(part) <= 255)) return null;
  return Buffer.from(parts.map(Number));
}

function ipv6ToBytes(text) {
  if (!net.isIPv6(text) || text.includes('%') || text.includes('.')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  }
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-fA-F]{1,4}$/u.test(group))) return null;
  const out = Buffer.alloc(16);
  groups.forEach((group, index) => out.writeUInt16BE(parseInt(group, 16), index * 2));
  return out;
}

function bytesToIpv6(bytes) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(bytes.readUInt16BE(index).toString(16));
  let best = { start: -1, length: 0 };
  for (let start = 0; start < 8; start += 1) {
    let length = 0;
    while (start + length < 8 && groups[start + length] === '0') length += 1;
    if (length > best.length) best = { start, length };
  }
  if (best.length < 2) return groups.join(':');
  const left = groups.slice(0, best.start).join(':');
  const right = groups.slice(best.start + best.length).join(':');
  return `${left}::${right}`;
}

function hintToBytes(hint) {
  if (typeof hint !== 'string' || hint.length > 64) return null;
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/u.exec(hint);
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  if (match[2] !== undefined) {
    const address = ipv4ToBytes(match[2]);
    return address ? Buffer.concat([Buffer.from([4]), address, portBytes]) : null;
  }
  const address = ipv6ToBytes(match[1]);
  return address ? Buffer.concat([Buffer.from([6]), address, portBytes]) : null;
}

// True when the invite codec would accept this text as an address hint.
function isAddressHint(text) {
  return hintToBytes(text) !== null;
}

// Up to four hints the codec accepts, in order: what an invite may carry out of
// a list of addresses a caller holds.
function pickAddressHints(addresses) {
  return (Array.isArray(addresses) ? addresses : []).filter(isAddressHint).slice(0, MAX_HINTS);
}

// Reads one hint at `offset`; returns { text, next } or null.
function readHint(bytes, offset) {
  const tag = bytes[offset];
  const size = tag === 4 ? 4 : (tag === 6 ? 16 : 0);
  if (size === 0 || offset + 1 + size + 2 > bytes.length) return null;
  const address = bytes.subarray(offset + 1, offset + 1 + size);
  const port = bytes.readUInt16BE(offset + 1 + size);
  if (port < 1) return null;
  const text = tag === 4 ? `${[...address].join('.')}:${port}` : `[${bytesToIpv6(address)}]:${port}`;
  return { text, next: offset + 1 + size + 2 };
}

// hint_count and the hints, or null for a bad list.
function encodeHints(hints, min = 0) {
  if (!Array.isArray(hints) || hints.length < min || hints.length > MAX_HINTS) return null;
  const encoded = hints.map(hintToBytes);
  return encoded.some((entry) => entry === null) ? null : Buffer.concat([Buffer.from([hints.length]), ...encoded]);
}

// Reads hint_count and the hints at `offset`: { hints, next } or null.
function readHints(bytes, offset, min = 0) {
  if (offset >= bytes.length) return null;
  const count = bytes[offset];
  if (count < min || count > MAX_HINTS) return null;
  const hints = [];
  let next = offset + 1;
  for (let index = 0; index < count; index += 1) {
    const hint = readHint(bytes, next);
    if (!hint) return null;
    hints.push(hint.text);
    next = hint.next;
  }
  return { hints, next };
}

// ------------------------------------------------- names, relays and tokens

/** True for a lower-case DNS name of at most 63 characters that is not an address. */
function isHostName(text) {
  return isDnsHostName(text, MAX_HOST_NAME_CHARS) && text === text.toLowerCase();
}

/** True for `null` or `{ name, port }` with a host name and a port 1..65535. */
function isHostNameValue(value) {
  if (value === null) return true;
  return Boolean(value) && typeof value === 'object' && Object.keys(value).length === 2 && isHostName(value.name)
    && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535;
}

// name_len | name | name_port, or null for a bad value.
function encodeHostName(value) {
  if (!isHostNameValue(value)) return null;
  if (value === null) return Buffer.from([0]);
  const port = Buffer.alloc(2);
  port.writeUInt16BE(value.port);
  return Buffer.concat([Buffer.from([value.name.length]), Buffer.from(value.name, 'latin1'), port]);
}

// Reads name_len, name and name_port at `offset`: { value, next } or null.
function readHostName(bytes, offset) {
  if (offset >= bytes.length) return null;
  const length = bytes[offset];
  if (length === 0) return { value: null, next: offset + 1 };
  if (length > MAX_HOST_NAME_CHARS || offset + 1 + length + 2 > bytes.length) return null;
  const name = bytes.subarray(offset + 1, offset + 1 + length).toString('latin1');
  const port = bytes.readUInt16BE(offset + 1 + length);
  if (!isHostName(name) || port < 1) return null;
  return { value: { name, port }, next: offset + 1 + length + 2 };
}

// One length-prefixed ASCII field, or null when `text` fails `check` (which bounds its length).
function encodeText(text, check) {
  if (text === null) return Buffer.from([0]);
  if (typeof text !== 'string' || !check(text)) return null;
  return Buffer.concat([Buffer.from([text.length]), Buffer.from(text, 'latin1')]);
}

function readText(bytes, offset, max, check) {
  if (offset >= bytes.length) return null;
  const length = bytes[offset];
  if (length === 0) return { value: null, next: offset + 1 };
  if (length > max || offset + 1 + length > bytes.length) return null;
  const text = bytes.subarray(offset + 1, offset + 1 + length).toString('latin1');
  return check(text) ? { value: text, next: offset + 1 + length } : null;
}

// ------------------------------------------------------------------ codec

function checksumOf(body, label = 'jteam1') {
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from(label), body])).digest()
    .subarray(0, CHECKSUM_BYTES);
}

/** The checked body of `prefix` + base64url(body | checksum), or null. The caller has bounded `text`. */
function decodeChecked(text, prefix, label, minBody) {
  const encoded = text.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded || bytes.length < minBody + CHECKSUM_BYTES) return null;
  const body = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
  if (!crypto.timingSafeEqual(checksumOf(body, label), bytes.subarray(bytes.length - CHECKSUM_BYTES))) return null;
  return body;
}

function encodeInvite({
  hostPublicKey, inviteSecretKey, hints = [], version = 1, hostName = null, relayUrl = null, relayToken = null,
}) {
  const host = decodeBase64url(hostPublicKey, PUBLIC_KEY_BYTES);
  const secret = decodeBase64url(inviteSecretKey, PUBLIC_KEY_BYTES);
  const hintBytes = encodeHints(hints);
  if (!host || !secret || !hintBytes) return malformed();
  if (version === 1) {
    // A version 1 invite has no field for a name or a relay: refuse rather than drop one silently.
    if (hostName !== null || relayUrl !== null || relayToken !== null) return malformed();
    const body = Buffer.concat([host, secret, hintBytes]);
    const invite = `${INVITE_PREFIX}${encodeBase64url(Buffer.concat([body, checksumOf(body)]))}`;
    return invite.length > V1_MAX_CHARS ? malformed() : { ok: true, invite };
  }
  if (version !== 2 || (relayToken !== null && relayUrl === null)) return malformed();
  const parts = [encodeHostName(hostName), encodeText(relayUrl, isCanonicalRelayUrl), encodeText(relayToken, isRelayToken)];
  if (parts.some((part) => part === null)) return malformed();
  const body = Buffer.concat([host, secret, hintBytes, ...parts]);
  const invite = `${INVITE_PREFIX_V2}${encodeBase64url(Buffer.concat([body, checksumOf(body, 'jteam2')]))}`;
  return invite.length > MAX_INVITE_CHARS ? malformed() : { ok: true, invite };
}

// The fields after the hints of a version 2 body, or null.
function readV2Tail(body, offset) {
  const name = readHostName(body, offset);
  const relay = name && readText(body, name.next, MAX_RELAY_URL_CHARS, isCanonicalRelayUrl);
  const token = relay && readText(body, relay.next, MAX_RELAY_TOKEN_CHARS, isRelayToken);
  if (!token || token.next !== body.length || (token.value !== null && relay.value === null)) return null;
  return { host_name: name.value, relay_url: relay.value, relay_token: token.value };
}

function parseInvite(text) {
  if (typeof text !== 'string' || text.length > MAX_INVITE_CHARS) return malformed();
  const prefix = VERSION_PREFIX.exec(text);
  if (!prefix) return malformed();
  const version = Number(prefix[1]);
  if (version > 2) return hostFailure('invalid', 'team_invite_too_new');
  if (version === 1 && text.length > V1_MAX_CHARS) return malformed();
  const body = decodeChecked(text, prefix[0], `jteam${version}`, 2 * PUBLIC_KEY_BYTES + 1);
  const read = body && readHints(body, 2 * PUBLIC_KEY_BYTES);
  if (!read) return malformed();
  let tail = { host_name: null, relay_url: null, relay_token: null };
  if (version === 1 && read.next !== body.length) return malformed();
  if (version === 2) {
    tail = readV2Tail(body, read.next);
    if (!tail) return malformed();
  }
  const hostPublicKey = encodeBase64url(body.subarray(0, PUBLIC_KEY_BYTES));
  return {
    ok: true,
    version,
    team_id: deriveTeamId(hostPublicKey),
    host_public_key: hostPublicKey,
    invite_secret_key: encodeBase64url(body.subarray(PUBLIC_KEY_BYTES, 2 * PUBLIC_KEY_BYTES)),
    hints: read.hints,
    ...tail,
  };
}

// ------------------------------------------------------ hint ordering (5-3)

// Where an address may go in an invite: 'global6', 'public4', 'private4', 'private6' (a LAN address),
// or 'excluded' (loopback, link-local, 100.64/10, unspecified, multicast, reserved, IPv4-mapped).
// Spec "Public address, hints and the reconnect code".
function addressClass(hint) {
  const bytes = hintToBytes(hint);
  if (!bytes) return 'excluded';
  const a = bytes.subarray(1, bytes.length - 2);
  if (bytes[0] === 4) {
    if (a[0] === 0 || a[0] === 127 || a[0] >= 224 || (a[0] === 169 && a[1] === 254)
      || (a[0] === 100 && (a[1] & 0xc0) === 64)) return 'excluded';
    if (a[0] === 10 || (a[0] === 172 && (a[1] & 0xf0) === 16) || (a[0] === 192 && a[1] === 168)) return 'private4';
    return 'public4';
  }
  const zeroHead = a.subarray(0, 10).every((byte) => byte === 0);
  if (zeroHead && ((a[10] === 0 && a[11] === 0) || (a[10] === 0xff && a[11] === 0xff))) return 'excluded';
  if (a[0] === 0xff || (a[0] === 0xfe && (a[1] & 0xc0) === 0x80)) return 'excluded';
  if ((a[0] & 0xfe) === 0xfc) return 'private6';
  return 'global6';
}

const CLASS_ORDER = Object.freeze(['global6', 'public4', 'private4', 'private6']);

/**
 * The hints of an internet-joining invite or a reconnect code, at most four, in order: the mapped
 * address, the owner-entered literal, global IPv6, public IPv4, then private LAN addresses. Never
 * loopback, link-local or 100.64/10. A mapped address that is not public (the router sits behind another
 * router) is left out: nobody outside can dial it. Entries the codec refuses are skipped; repeats are dropped.
 */
function orderHints({ mapped = null, entered = null, addresses = [] } = {}) {
  const out = [];
  const add = (hint) => {
    if (out.length < MAX_HINTS && addressClass(hint) !== 'excluded' && !out.includes(hint)) out.push(hint);
  };
  if (addressClass(mapped) === 'public4') add(mapped);
  add(entered);
  const listed = (Array.isArray(addresses) ? addresses : []).slice(0, 64);
  for (const kind of CLASS_ORDER) for (const hint of listed) if (addressClass(hint) === kind) add(hint);
  return out;
}

const MAX_PUBLIC_ADDRESS_CHARS = 80;

function addressRefused() {
  return { ok: false, reason: 'team_public_address_invalid' };
}

/**
 * Parses an owner-entered public address (Q6 (a), plan row E44): an IPv4 or IPv6 literal or a DNS
 * name, with an optional port (default `defaultPort`, the direct port). Returns { ok, hint } for a
 * literal, { ok, host_name: { name, port } } for a name, or { ok: false, reason }. Total and bounded.
 */
function parsePublicAddress(text, defaultPort) {
  if (typeof text !== 'string' || text.length < 1 || text.length > MAX_PUBLIC_ADDRESS_CHARS) return addressRefused();
  let host = text;
  let portText = null;
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(text);
  if (bracket) {
    host = bracket[1];
    portText = bracket[2] ?? null;
  } else if (!text.includes('[') && text.split(':').length === 2) {
    [host, portText] = text.split(':');
  }
  if (portText !== null && !/^[1-9]\d{0,4}$/u.test(portText)) return addressRefused();
  const port = portText === null ? defaultPort : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return addressRefused();
  if (bracket || host.includes(':')) {
    const bytes = ipv6ToBytes(host);
    return bytes ? enteredLiteral(`[${bytesToIpv6(bytes)}]:${port}`) : addressRefused();
  }
  if (/^[\d.]+$/u.test(host)) return ipv4ToBytes(host) ? enteredLiteral(`${host}:${port}`) : addressRefused();
  const name = host.toLowerCase();
  return isHostName(name) ? { ok: true, host_name: { name, port } } : addressRefused();
}

// An entered literal of a class an internet invite never carries (loopback, link-local, 100.64/10, ...) is
// refused at entry rather than dropped from the invite without a word.
function enteredLiteral(hint) {
  return addressClass(hint) === 'excluded' ? addressRefused() : { ok: true, hint };
}

function internetInvalid() {
  return hostFailure('invalid', 'team_internet_invalid');
}

const INTERNET_KEYS = Object.freeze(['direct_port', 'mapped', 'public_address', 'relay_url', 'relay_token']);

/**
 * What an invite carries, from the host's internet setting and its address list. `internet` is null
 * while internet joining is off (only null: `undefined`, a getter with no return, is refused): today's
 * hints (the first four the codec accepts) and a version 1 invite, byte for byte. Otherwise
 * { direct_port, mapped, public_address, relay_url, relay_token }
 * (slice 5-5 supplies it): ordered hints and the version 2 part. A malformed block is refused with
 * `team_internet_invalid`, never quietly issued as version 1. Answers { ok, hints, internet }.
 */
function inviteContent(internet, addresses) {
  if (internet === null) return { ok: true, hints: pickAddressHints(addresses), internet: null };
  if (!internet || typeof internet !== 'object' || Object.keys(internet).length !== INTERNET_KEYS.length
    || !INTERNET_KEYS.every((key) => Object.hasOwn(internet, key))) return internetInvalid();
  const { direct_port: directPort, mapped, public_address: publicAddress, relay_url: relayUrl,
    relay_token: relayToken } = internet;
  if (!Number.isInteger(directPort) || directPort < 1 || directPort > 65535) return internetInvalid();
  if (mapped !== null && !isAddressHint(mapped)) return internetInvalid();
  // The router may map another outside port than the direct port: an entered IPv4 address or name without a
  // port means that one. The mapping is IPv4 only, so an IPv6 literal keeps the direct port.
  const mappedPort = mapped !== null && addressClass(mapped) === 'public4' ? Number(mapped.slice(mapped.lastIndexOf(':') + 1)) : null;
  let entered = publicAddress === null ? { ok: true } : parsePublicAddress(publicAddress, mappedPort ?? directPort);
  if (mappedPort !== null && entered.hint?.startsWith('[')) entered = parsePublicAddress(publicAddress, directPort);
  const part = { hostName: entered.host_name ?? null, relayUrl, relayToken };
  if (!entered.ok || !isInternetPart(part)) return internetInvalid();
  return { ok: true, hints: orderHints({ mapped, entered: entered.hint ?? null, addresses }), internet: part };
}

const UNREADABLE = Object.freeze({ unreadable: true });

/** The host's internet setting from its getter: its value, or a value `inviteContent` refuses when it throws. */
function readInternetSetting(getter) {
  try { return getter(); } catch { return UNREADABLE; }
}

// ---------------------------------------------------------------- service

/** True for the version 2 part of an invite slot: { hostName, relayUrl, relayToken }. */
function isInternetPart(value) {
  return Boolean(value) && typeof value === 'object' && Object.keys(value).length === 3
    && ['hostName', 'relayUrl', 'relayToken'].every((key) => Object.hasOwn(value, key)) && isHostNameValue(value.hostName)
    && (value.relayUrl === null || isCanonicalRelayUrl(value.relayUrl))
    && (value.relayToken === null || (isRelayToken(value.relayToken) && value.relayUrl !== null));
}

function createInviteService({
  store, clock = Date.now, randomBytes = crypto.randomBytes, logger = null, timers = { setTimeout, clearTimeout },
} = {}) {
  if (!store || typeof store.createInvite !== 'function') throw new TypeError('createInviteService requires a store.');
  const slots = new Map();

  const log = safeLogger(logger);

  function clearSlot(inviteId) {
    const slot = slots.get(inviteId);
    if (!slot) return;
    timers.clearTimeout(slot.timer);
    slot.secret.fill(0);
    slots.delete(inviteId);
  }

  // Each slot has one unref'd timer that clears it at SLOT_MS, so a secret never revealed does not wait
  // for the next create or reveal; the lazy sweep stays for an injected clock that moves on its own.
  function sweep() {
    const now = clock();
    for (const [inviteId, slot] of slots) {
      if (slot.expiresAt <= now) clearSlot(inviteId);
    }
  }

  // `internet` is null for a version 1 invite (internet joining off) or the version 2 part.
  // `actorMemberId` has no default: the local command passes LOCAL_COMMAND
  // (member-schema), forwarded as it is and never logged or returned.
  async function create({
    kind, actorMemberId, role, ttlMs, hints = [], internet = null,
  }) {
    sweep();
    if (encodeHints(hints) === null || (internet !== null && !isInternetPart(internet))) return malformed();
    const seed = randomBytes(PUBLIC_KEY_BYTES);
    const { secretKey, publicKey } = keyPairFromSeed(seed);
    const created = await store.createInvite({
      kind, actorMemberId, role, ttlMs, invitePublicKey: publicKey,
    });
    if (!created.ok) {
      seed.fill(0);
      return created;
    }
    const timer = timers.setTimeout(() => clearSlot(created.invite_id), SLOT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    slots.set(created.invite_id, {
      secret: Buffer.from(secretKey, 'base64url'),
      hints: [...hints],
      internet: internet === null ? null : { ...internet },
      expiresAt: clock() + SLOT_MS,
      timer,
    });
    seed.fill(0);
    log('INFO', 'team_invite.created', { kind });
    return { ok: true, invite_id: created.invite_id, expires_at: created.expires_at };
  }

  // Returns the invite string once. A second call, an expired slot, a revoked or
  // spent invite and an unknown id all fail the same way.
  function reveal(inviteId) {
    sweep();
    const slot = typeof inviteId === 'string' ? slots.get(inviteId) : undefined;
    if (!slot || !store.isInviteLive(inviteId)) {
      if (slot) clearSlot(inviteId);
      return notValid();
    }
    const encoded = encodeInvite({
      hostPublicKey: store.hostPublicKey(),
      inviteSecretKey: encodeBase64url(slot.secret),
      hints: slot.hints,
      ...(slot.internet ? { version: 2, ...slot.internet } : {}),
    });
    clearSlot(inviteId);
    if (!encoded.ok) return encoded;
    log('INFO', 'team_invite.revealed', {});
    return { ok: true, invite: encoded.invite };
  }

  async function revoke({ actorMemberId, inviteId }) {
    const revoked = await store.revokeInvite({ actorMemberId, inviteId });
    if (revoked.ok) clearSlot(inviteId);
    return revoked;
  }

  async function redeem(input) {
    const redeemed = await store.redeem(input);
    if (redeemed.ok) clearSlot(redeemed.invite_id);
    return redeemed;
  }

  // Clears every slot (zeroing its secret) and its timer; the host calls it when it tears the service down.
  function dispose() {
    for (const inviteId of [...slots.keys()]) clearSlot(inviteId);
  }

  return {
    create, reveal, revoke, redeem, dispose, pendingSlots: () => { sweep(); return slots.size; },
  };
}

module.exports = {
  INVITE_PREFIX, INVITE_PREFIX_V2, MAX_HINTS, MAX_INVITE_CHARS, SLOT_MS, addressClass, checksumOf,
  createInviteService, decodeChecked, encodeHints, encodeHostName, encodeInvite, inviteContent, isAddressHint,
  isHostNameValue, isRelayToken, keyPairFromSeed, orderHints, parseInvite, parsePublicAddress,
  pickAddressHints, readHints, readHostName, readInternetSetting,
};
