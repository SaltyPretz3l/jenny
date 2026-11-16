'use strict';

// Identifiers and key formats for the team member store. Ids are a prefix plus
// base64url of 16 random bytes. Public keys are Ed25519 keys, base64url of 32
// bytes, with no padding. The team id is derived from the host public key so a
// swapped key can never silently become the same team.

const crypto = require('node:crypto');

const ID_PATTERNS = Object.freeze({
  team: /^team_[A-Za-z0-9_-]{1,64}$/u,
  member: /^member_[A-Za-z0-9_-]{1,64}$/u,
  device: /^device_[A-Za-z0-9_-]{1,64}$/u,
  invite: /^invite_[A-Za-z0-9_-]{1,64}$/u,
  // Slice 6-3: the model relay's offer and transfer ids (16 random bytes, base64url), the same patterns as
  // model-relay-core.js MODEL_RELAY_ID_PATTERNS (pinned equal by tests/server/team-model-commands.test.js).
  model_offer: /^offer_[A-Za-z0-9_-]{22}$/u,
  model_transfer: /^mxfer_[A-Za-z0-9_-]{22}$/u,
});

const ID_PREFIX = Object.freeze({
  team: 'team_', member: 'member_', device: 'device_', invite: 'invite_',
});

const PUBLIC_KEY_BYTES = 32;
// Host conversation ids: `sess_` plus the store's suffix. One rule for the viewer store, the project
// audit and `services/host/maintenance-commands.js` (slice 3-6b). An imported conversation whose id is
// longer fails it: such a conversation is never viewing and gets no audit entry (fail closed).
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]{1,123}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
// PKCS#8 wrapper of an Ed25519 private key, followed by the 32-byte seed.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// Strict base64url decode: only the unpadded alphabet, canonical encoding, and
// the exact decoded length. Returns a Buffer or null.
function decodeBase64url(text, expectedBytes) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 1024 || !BASE64URL.test(text)) return null;
  let decoded;
  try {
    decoded = Buffer.from(text, 'base64url');
  } catch (_error) {
    return null;
  }
  if (decoded.length !== expectedBytes || decoded.toString('base64url') !== text) return null;
  return decoded;
}

function encodeBase64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function isPublicKey(value) {
  return decodeBase64url(value, PUBLIC_KEY_BYTES) !== null;
}

function isId(kind, value) {
  return typeof value === 'string' && ID_PATTERNS[kind].test(value);
}

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

function newId(kind, randomBytes = crypto.randomBytes) {
  const prefix = ID_PREFIX[kind];
  if (!prefix || prefix === ID_PREFIX.team) throw new TypeError('newId makes member, device and invite ids.');
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw new TypeError('randomBytes must return 16 bytes.');
  return `${prefix}${encodeBase64url(bytes)}`;
}

// An Ed25519 seed is the secret; the public key is derived from it, so a seeded
// `randomBytes` makes the whole key pair reproducible in tests.
function keyPairFromSeed(seed) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8',
  });
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return { secretKey: encodeBase64url(seed), publicKey: jwk.x };
}

function deriveTeamId(hostPublicKey) {
  const key = decodeBase64url(hostPublicKey, PUBLIC_KEY_BYTES);
  if (!key) throw new TypeError('The host public key must be base64url of 32 bytes.');
  const digest = crypto.createHash('sha256').update(key).digest();
  return `${ID_PREFIX.team}${encodeBase64url(digest.subarray(0, 16))}`;
}

module.exports = {
  ID_PATTERNS,
  PUBLIC_KEY_BYTES,
  decodeBase64url,
  encodeBase64url,
  isPublicKey,
  isId,
  isSessionId,
  newId,
  deriveTeamId,
  keyPairFromSeed,
};
