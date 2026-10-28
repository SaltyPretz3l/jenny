'use strict';

// Endpoint policy for user API-key providers (row 78). The Electron twin of
// sidecar/ai/engines/provider_descriptor_v6.py validate_provider_endpoint:
// https is required, plain http only when every address the host resolves to
// is loopback, private or link-local. Credentials, query strings and fragments
// are refused so a key can never ride the URL. Rejections never echo the
// value: a caller bug could pass a key here.

const dns = require('dns');
const net = require('net');

const MAX_URL_CHARS = 2048;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function endpointError(reason) {
  return Object.assign(new Error('Provider endpoint rejected.'), { code: 'invalid_endpoint', reason });
}

function isLocalAddress(address) {
  const value = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(value);
  if (family === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (family === 6) {
    if (value === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isLocalAddress(mapped[1]);
    // fc00::/7 unique local, fe80::/10 link-local.
    return /^f[cd][0-9a-f]{0,2}:/.test(value) || /^fe[89ab][0-9a-f]?:/.test(value);
  }
  return false;
}

async function hostResolvesOnlyToLocalAddresses(hostname, { lookup = dns.promises.lookup } = {}) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || isLocalAddress(host)) return true;
  if (net.isIP(host)) return false;
  try {
    const rows = await lookup(host, { all: true, verbatim: true });
    const addresses = (Array.isArray(rows) ? rows : [rows]).map((row) => row?.address).filter(Boolean);
    return addresses.length > 0 && addresses.every(isLocalAddress);
  } catch (_error) {
    return false;
  }
}

// Synchronous shape check: everything except the DNS step for plain http.
function parseProviderEndpoint(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) throw endpointError('shape');
  if (CONTROL_RE.test(value) || value !== value.trim()) throw endpointError('shape');
  if (value.includes('?') || value.includes('#')) throw endpointError('query');
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    throw endpointError('shape');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) throw endpointError('scheme');
  if (url.username || url.password || /@/.test(value.split('/').slice(0, 3).join('/'))) {
    throw endpointError('credentials');
  }
  return { url, normalized: value.replace(/\/+$/, '') };
}

// Returns the normalized endpoint (no trailing slash) or throws `invalid_endpoint`.
async function validateProviderEndpoint(value, { lookup } = {}) {
  const { url, normalized } = parseProviderEndpoint(value);
  if (url.protocol === 'http:' && !(await hostResolvesOnlyToLocalAddresses(url.hostname, { lookup }))) {
    throw endpointError('insecure');
  }
  return normalized;
}

function endpointOrigin(value) {
  return parseProviderEndpoint(value).url.origin;
}

module.exports = {
  MAX_URL_CHARS,
  endpointOrigin,
  hostResolvesOnlyToLocalAddresses,
  isLocalAddress,
  parseProviderEndpoint,
  validateProviderEndpoint,
};
