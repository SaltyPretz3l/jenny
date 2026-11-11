'use strict';

// Small shared pieces of the fake bridge child: the start-line field checks the
// real binary makes, and helpers the moved bridge logic needs.

const { MAX_ADDRESSES, isSocketAddress } = require('../../../../server/team/transport/control-channel');
const { withTimeout } = require('../../../../server/team/transport/with-timeout');

const CLOSE_REASON_REFUSED = 'refused';
const MEMBER_REASONS = Object.freeze(['host_unreachable', 'host_refused', 'closed']);

const isPositiveInt = (value) => Number.isSafeInteger(value) && value > 0;
const isPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;

/** 32 bytes from unpadded base64url, else null. */
function key32(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

const base64url = (bytes) => Buffer.from(bytes).toString('base64url');

function limitsOf(raw, names) {
  if (!raw || typeof raw !== 'object') return null;
  const limits = {};
  for (const [wire, name] of names) {
    if (!isPositiveInt(raw[wire])) return null;
    limits[name] = raw[wire];
  }
  return limits;
}

const HOST_LIMITS = [
  ['max_connections', 'maxConnections'],
  ['max_streams_per_connection', 'maxStreamsPerConnection'],
  ['max_streams_total', 'maxStreamsTotal'],
  ['max_handshakes', 'maxHandshakes'],
  ['admit_timeout_ms', 'admitTimeoutMs'],
  ['drop_grace_ms', 'dropGraceMs'],
];
const MEMBER_LIMITS = [
  ['max_preamble_sockets', 'maxPreambleSockets'],
  ['max_streams', 'maxStreams'],
  ['preamble_timeout_ms', 'preambleTimeoutMs'],
  ['connect_timeout_ms', 'connectTimeoutMs'],
];

/** The host `start` line as the binary reads it, or null when any field is wrong. */
function parseHostStart(message) {
  const secretKey = key32(message.secret_key);
  const bootSecret = key32(message.boot_secret);
  const limits = limitsOf(message.limits, HOST_LIMITS);
  const directOk = message.direct_port === null || isPort(message.direct_port);
  if (message.mode !== 'host' || !secretKey || !bootSecret || !limits || !directOk) return null;
  if (typeof message.alpn !== 'string' || message.alpn === '' || !isPort(message.loopback_port)) return null;
  return {
    secretKey, bootSecret, limits, alpn: message.alpn, loopbackPort: message.loopback_port,
    directPort: message.direct_port ?? undefined,
  };
}

/** The member `start` line as the binary reads it, or null when any field is wrong. */
function parseMemberStart(message) {
  const secretKey = key32(message.secret_key);
  const hostKey = key32(message.host_key);
  const launchSecret = key32(message.launch_secret);
  const limits = limitsOf(message.limits, MEMBER_LIMITS);
  if (message.mode !== 'member' || !secretKey || !hostKey || !launchSecret || !limits) return null;
  if (!Array.isArray(message.addresses) || message.addresses.length > MAX_ADDRESSES) return null;
  if (!message.addresses.every(isSocketAddress)) return null;
  if (typeof message.alpn !== 'string' || message.alpn === '') return null;
  return { secretKey, hostKey, launchSecret, limits, alpn: message.alpn, addresses: [...message.addresses] };
}

/** Closes a connection or listener now; a close that throws or rejects is ignored. */
function closeQuietly(target, reason) {
  try {
    return Promise.resolve(target.close(reason)).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

module.exports = {
  CLOSE_REASON_REFUSED,
  MEMBER_REASONS,
  base64url,
  closeQuietly,
  key32,
  parseHostStart,
  parseMemberStart,
  withTimeout,
};
