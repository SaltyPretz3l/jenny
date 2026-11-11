'use strict';

// The two binary preambles that start every loopback TCP connection in team
// mode. One definition, shared by the bridges, the later host listener and the
// tests.
//
//   host preamble   (72 bytes): 'JNYT' | version 1 | 3 zero bytes | per-boot
//                   secret (32) | authenticated remote public key (32)
//   member preamble (40 bytes): 'JNYT' | version 1 | 3 zero bytes | per-launch
//                   secret (32)

const crypto = require('node:crypto');

const MAGIC = Buffer.from('JNYT', 'latin1');
const VERSION = 1;
const SECRET_BYTES = 32;
const KEY_BYTES = 32;
const HEADER_BYTES = 8;
const MEMBER_PREAMBLE_BYTES = HEADER_BYTES + SECRET_BYTES;
const HOST_PREAMBLE_BYTES = HEADER_BYTES + SECRET_BYTES + KEY_BYTES;
const PREAMBLE_TIMEOUT_MS = 3000;
const MAX_PREAMBLE_SOCKETS = 16;

function requireBytes(value, length, name) {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${name} must be a ${length}-byte Uint8Array`);
  }
}

function header() {
  const bytes = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(bytes, 0);
  bytes[4] = VERSION;
  return bytes;
}

function headerIsValid(bytes) {
  if (bytes.length < HEADER_BYTES) return false;
  if (!MAGIC.equals(bytes.subarray(0, 4))) return false;
  if (bytes[4] !== VERSION) return false;
  return bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0;
}

function encodeHostPreamble(bootSecret, remoteKey) {
  requireBytes(bootSecret, SECRET_BYTES, 'bootSecret');
  requireBytes(remoteKey, KEY_BYTES, 'remoteKey');
  return Buffer.concat([header(), Buffer.from(bootSecret), Buffer.from(remoteKey)], HOST_PREAMBLE_BYTES);
}

function encodeMemberPreamble(launchSecret) {
  requireBytes(launchSecret, SECRET_BYTES, 'launchSecret');
  return Buffer.concat([header(), Buffer.from(launchSecret)], MEMBER_PREAMBLE_BYTES);
}

/** Returns { secret, remoteKey } for a well-formed 72-byte host preamble, else null. */
function decodeHostPreamble(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return null;
  if (bytes.length !== HOST_PREAMBLE_BYTES) return null;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (!headerIsValid(buffer)) return null;
  return {
    secret: buffer.subarray(HEADER_BYTES, HEADER_BYTES + SECRET_BYTES),
    remoteKey: buffer.subarray(HEADER_BYTES + SECRET_BYTES, HOST_PREAMBLE_BYTES),
  };
}

/** True when `bytes` is a well-formed 40-byte member preamble carrying `launchSecret`. */
function verifyMemberPreamble(bytes, launchSecret) {
  if (bytes.length !== MEMBER_PREAMBLE_BYTES || !headerIsValid(bytes)) return false;
  const supplied = bytes.subarray(HEADER_BYTES, MEMBER_PREAMBLE_BYTES);
  return crypto.timingSafeEqual(supplied, Buffer.from(launchSecret));
}

module.exports = {
  HOST_PREAMBLE_BYTES,
  KEY_BYTES,
  MAX_PREAMBLE_SOCKETS,
  MEMBER_PREAMBLE_BYTES,
  PREAMBLE_TIMEOUT_MS,
  SECRET_BYTES,
  decodeHostPreamble,
  encodeHostPreamble,
  encodeMemberPreamble,
  requireBytes,
  verifyMemberPreamble,
};
