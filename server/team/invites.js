'use strict';

// Invites: the one-time key pair, the memory slot that holds the secret for ten
// minutes, the invite string, and the redeem wrapper. The member store keeps
// only the invite's public key; the secret never reaches the disk, a receipt or
// a log line. `reveal` hands the string out once.
//
// Invite string, at most 256 characters:
//   "jteam1_" + base64url( host_public_key (32) | invite_secret_key (32)
//                          | hint_count (1) | hint * hint_count | checksum (4) )
// Each address hint is one tag byte, the raw address and a big-endian port:
//   tag 4: 4 address bytes (IPv4)    tag 6: 16 address bytes (IPv6)    then 2 port bytes
// so a hint is 7 or 19 bytes and four IPv6 hints stay far inside the limit. The
// checksum is the first 4 bytes of SHA-256 over "jteam1" and every byte before
// it. It catches a mistyped or truncated code; it is not a signature. Hints are
// "ip:port" or "[ipv6]:port" text on the way in and out; an IPv6 zone id or an
// embedded IPv4 form is refused.

const crypto = require('node:crypto');
const net = require('node:net');

const { hostFailure } = require('../api-contract');
const {
  PUBLIC_KEY_BYTES, decodeBase64url, encodeBase64url, deriveTeamId, keyPairFromSeed,
} = require('./ids');
const { safeLogger } = require('./safe-logger');

const INVITE_PREFIX = 'jteam1_';
const MAX_INVITE_CHARS = 256;
const MAX_HINTS = 4;
const CHECKSUM_BYTES = 4;
const SLOT_MS = 10 * 60 * 1000;

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

// ------------------------------------------------------------------ codec

function checksumOf(body) {
  return crypto.createHash('sha256').update(Buffer.concat([Buffer.from('jteam1'), body])).digest()
    .subarray(0, CHECKSUM_BYTES);
}

function encodeInvite({ hostPublicKey, inviteSecretKey, hints = [] }) {
  const host = decodeBase64url(hostPublicKey, PUBLIC_KEY_BYTES);
  const secret = decodeBase64url(inviteSecretKey, PUBLIC_KEY_BYTES);
  if (!host || !secret || !Array.isArray(hints) || hints.length > MAX_HINTS) return malformed();
  const encodedHints = hints.map(hintToBytes);
  if (encodedHints.some((entry) => entry === null)) return malformed();
  const body = Buffer.concat([host, secret, Buffer.from([hints.length]), ...encodedHints]);
  const invite = `${INVITE_PREFIX}${encodeBase64url(Buffer.concat([body, checksumOf(body)]))}`;
  if (invite.length > MAX_INVITE_CHARS) return malformed();
  return { ok: true, invite };
}

function parseInvite(text) {
  if (typeof text !== 'string' || text.length > MAX_INVITE_CHARS || !text.startsWith(INVITE_PREFIX)) return malformed();
  const encoded = text.slice(INVITE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return malformed();
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded || bytes.length < 2 * PUBLIC_KEY_BYTES + 1 + CHECKSUM_BYTES) return malformed();
  const body = bytes.subarray(0, bytes.length - CHECKSUM_BYTES);
  if (!crypto.timingSafeEqual(checksumOf(body), bytes.subarray(bytes.length - CHECKSUM_BYTES))) return malformed();
  const count = body[2 * PUBLIC_KEY_BYTES];
  if (count > MAX_HINTS) return malformed();
  const hints = [];
  let offset = 2 * PUBLIC_KEY_BYTES + 1;
  for (let index = 0; index < count; index += 1) {
    const hint = readHint(body, offset);
    if (!hint) return malformed();
    hints.push(hint.text);
    offset = hint.next;
  }
  if (offset !== body.length) return malformed();
  const hostPublicKey = encodeBase64url(body.subarray(0, PUBLIC_KEY_BYTES));
  return {
    ok: true,
    team_id: deriveTeamId(hostPublicKey),
    host_public_key: hostPublicKey,
    invite_secret_key: encodeBase64url(body.subarray(PUBLIC_KEY_BYTES, 2 * PUBLIC_KEY_BYTES)),
    hints,
  };
}

// ---------------------------------------------------------------- service

function createInviteService({
  store, clock = Date.now, randomBytes = crypto.randomBytes, logger = null,
} = {}) {
  if (!store || typeof store.createInvite !== 'function') throw new TypeError('createInviteService requires a store.');
  const slots = new Map();

  const log = safeLogger(logger);

  function clearSlot(inviteId) {
    const slot = slots.get(inviteId);
    if (!slot) return;
    slot.secret.fill(0);
    slots.delete(inviteId);
  }

  // Expired slots are dropped lazily; there is no timer to leak.
  function sweep() {
    const now = clock();
    for (const [inviteId, slot] of slots) {
      if (slot.expiresAt <= now) clearSlot(inviteId);
    }
  }

  async function create({
    kind, actorMemberId = null, role, ttlMs, hints = [],
  }) {
    sweep();
    if (!Array.isArray(hints) || hints.length > MAX_HINTS || hints.some((hint) => hintToBytes(hint) === null)) {
      return malformed();
    }
    const seed = randomBytes(PUBLIC_KEY_BYTES);
    const { secretKey, publicKey } = keyPairFromSeed(seed);
    const created = await store.createInvite({
      kind, actorMemberId, role, ttlMs, invitePublicKey: publicKey,
    });
    if (!created.ok) {
      seed.fill(0);
      return created;
    }
    slots.set(created.invite_id, {
      secret: Buffer.from(secretKey, 'base64url'),
      hints: [...hints],
      expiresAt: clock() + SLOT_MS,
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

  return {
    create, reveal, revoke, redeem, pendingSlots: () => { sweep(); return slots.size; },
  };
}

module.exports = {
  INVITE_PREFIX, MAX_INVITE_CHARS, SLOT_MS, keyPairFromSeed, encodeInvite, parseInvite,
  isAddressHint, pickAddressHints, createInviteService,
};
