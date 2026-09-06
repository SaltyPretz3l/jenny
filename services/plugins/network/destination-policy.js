'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const DESTINATION_SCOPES = Object.freeze(['loopback', 'lan', 'internet']);
const MAX_URL_BYTES = 2048;
const IPV4_LAN_RANGES = Object.freeze([
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
]);
const IPV4_BLOCKED_RANGES = Object.freeze([
  ['0.0.0.0', 8],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]);

function digestText(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function parseIpv4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255
    || String(part) !== parts[index])) return null;
  return bytes;
}

function ipv4Value(bytes) {
  return (((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]) >>> 0;
}

function inIpv4Range(bytes, [baseAddress, prefixLength]) {
  const base = parseIpv4(baseAddress);
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4Value(bytes) & mask) === (ipv4Value(base) & mask);
}

function classifyIpv4(address) {
  const bytes = parseIpv4(address);
  if (!bytes) return { ok: false, reason: 'invalid_ip_address' };
  if (inIpv4Range(bytes, ['127.0.0.0', 8])) return { ok: true, scope: 'loopback' };
  if (IPV4_LAN_RANGES.some((range) => inIpv4Range(bytes, range))) return { ok: true, scope: 'lan' };
  if (IPV4_BLOCKED_RANGES.some((range) => inIpv4Range(bytes, range))) {
    return { ok: false, reason: 'special_address_blocked' };
  }
  return { ok: true, scope: 'internet' };
}

function ipv4FromMappedIpv6(address) {
  const token = String(address).toLowerCase();
  const match = token.match(/^::ffff:(.+)$/);
  if (!match) return null;
  if (net.isIP(match[1]) === 4) return match[1];
  const hex = match[1].split(':');
  if (hex.length !== 2 || hex.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const high = Number.parseInt(hex[0], 16);
  const low = Number.parseInt(hex[1], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function classifyIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return classifyIpv4(address);
  if (family !== 6) return { ok: false, reason: 'invalid_ip_address' };
  let token;
  try {
    token = normalizeHostname(new URL(`http://[${address}]/`).hostname);
  } catch (_error) {
    return { ok: false, reason: 'invalid_ip_address' };
  }
  const mapped = ipv4FromMappedIpv6(token);
  if (mapped) return classifyIpv4(mapped);
  if (token === '::1') return { ok: true, scope: 'loopback' };
  const ipv6Parts = token.split(':');
  const secondPart = Number.parseInt(ipv6Parts[1] || '0', 16);
  const nonGlobal2001 = ipv6Parts[0] === '2001'
    && (secondPart === 0 || secondPart === 2 || (secondPart >= 0x10 && secondPart <= 0x2f)
      || secondPart === 0xdb8);
  if (token.startsWith('::') || token.startsWith('ff') || token.startsWith('100:')
    || token.startsWith('64:ff9b:') || nonGlobal2001 || token.startsWith('2002:')) {
    return { ok: false, reason: 'special_address_blocked' };
  }
  const first = Number.parseInt(ipv6Parts[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) {
    return { ok: true, scope: 'lan' };
  }
  return { ok: true, scope: 'internet' };
}

function normalizeHostname(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function normalizeDestination(rawUrl, { allowLoopbackHttp = false } = {}) {
  if (typeof rawUrl !== 'string' || Buffer.byteLength(rawUrl, 'utf8') > MAX_URL_BYTES) {
    return { ok: false, reason: 'destination_invalid' };
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch (_error) {
    return { ok: false, reason: 'destination_invalid' };
  }
  if (url.username || url.password) return { ok: false, reason: 'embedded_credentials_blocked' };
  if (url.hash) return { ok: false, reason: 'url_fragment_blocked' };
  if (!['https:', 'http:'].includes(url.protocol)) return { ok: false, reason: 'scheme_blocked' };
  const hostname = normalizeHostname(url.hostname);
  const literalFamily = net.isIP(hostname);
  const literalClassification = literalFamily ? classifyIpAddress(hostname) : null;
  if (literalClassification && !literalClassification.ok) return literalClassification;
  if (url.protocol === 'http:' && (!allowLoopbackHttp || literalClassification?.scope !== 'loopback')) {
    return { ok: false, reason: 'https_required' };
  }
  url.hostname = hostname;
  const normalizedOrigin = url.origin.toLowerCase();
  return {
    ok: true,
    url,
    hostname,
    literal_address: literalFamily ? hostname : null,
    literal_scope: literalClassification?.scope || null,
    origin: normalizedOrigin,
    origin_digest: digestText(normalizedOrigin),
    destination_digest: digestText(url.href),
  };
}

function consentAllowsScope(consent, scope) {
  return DESTINATION_SCOPES.includes(scope)
    && consent && consent.granted === true && Array.isArray(consent.allowed_scopes)
    && consent.allowed_scopes.includes(scope);
}

function validateScopeConsent(consent, scope) {
  return consentAllowsScope(consent, scope)
    ? { ok: true }
    : { ok: false, reason: 'network_consent_required', scope };
}

module.exports = {
  DESTINATION_SCOPES,
  MAX_URL_BYTES,
  IPV4_LAN_RANGES,
  IPV4_BLOCKED_RANGES,
  digestText,
  parseIpv4,
  inIpv4Range,
  classifyIpAddress,
  normalizeDestination,
  consentAllowsScope,
  validateScopeConsent,
};
