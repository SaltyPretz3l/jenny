'use strict';

/**
 * URL and address rules for model-driven browsing (roadmap row 114).
 *
 * This is the Refuse tier: what the browser may never reach, whoever asks. The
 * Ask tier (new sites, risky actions) lives in consent-gate.js and runs only
 * after this module has allowed the target.
 *
 * The address ranges mirror sidecar/ai/tools/builtins/web_url_policy.py and are
 * held to it by tests/fixtures/browser-use-address-cases.json, which both test
 * suites read. Only global unicast can be public here, so a new IETF range is
 * refused until someone decides otherwise.
 */

const MAX_URL_LENGTH = 4096;
const MAX_DNS_CACHE_ENTRIES = 256;
const DNS_CACHE_TTL_MS = 30_000;

const NAVIGATION_SCHEMES = new Set(['http:', 'https:']);
const NETWORK_SUBRESOURCE_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
// Inline content a page builds for itself. It reaches no host, so no address
// rule applies; none of these can be a top-level destination.
const LOCAL_SUBRESOURCE_SCHEMES = new Set(['data:', 'blob:']);
const LOCAL_ABOUT_PAGES = new Set(['about:blank', 'about:srcdoc']);
const SECURE_DEFAULT_PORT = 443;
const PLAIN_DEFAULT_PORT = 80;

const INTERNAL_NAME_SUFFIXES = Object.freeze([
  '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.onion', '.localdomain', '.home.arpa',
]);

function ipv4(text, prefix) {
  return { base: parseIpv4(text), prefix };
}

function parseIpv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function parseIpv6(text) {
  let raw = String(text).trim();
  if (raw.includes('.')) {
    const lastColon = raw.lastIndexOf(':');
    if (lastColon < 0) return null;
    const embedded = parseIpv4(raw.slice(lastColon + 1));
    if (embedded === null) return null;
    const high = Math.floor(embedded / 65536).toString(16);
    const low = (embedded % 65536).toString(16);
    raw = `${raw.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = raw.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups = head;
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return null;
    groups = [...head, ...new Array(8 - head.length - tail.length).fill('0'), ...tail];
  }
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function ipv6(text, prefix) {
  return { base: parseIpv6(text), prefix: BigInt(prefix) };
}

const IPV4_NON_PUBLIC = Object.freeze([
  ipv4('0.0.0.0', 8), ipv4('10.0.0.0', 8), ipv4('100.64.0.0', 10), ipv4('127.0.0.0', 8),
  ipv4('169.254.0.0', 16), ipv4('172.16.0.0', 12), ipv4('192.0.0.0', 24), ipv4('192.0.2.0', 24),
  ipv4('192.168.0.0', 16), ipv4('198.18.0.0', 15), ipv4('198.51.100.0', 24), ipv4('203.0.113.0', 24),
  ipv4('224.0.0.0', 4), ipv4('240.0.0.0', 4),
]);
const IPV4_LOOPBACK = ipv4('127.0.0.0', 8);

const IPV6_LOOPBACK = parseIpv6('::1');
const IPV6_GLOBAL_UNICAST = ipv6('2000::', 3);
const IPV6_NON_PUBLIC_GLOBAL = Object.freeze([ipv6('2001::', 23), ipv6('2001:db8::', 32)]);
const IPV6_6TO4 = ipv6('2002::', 16);
const ISATAP_MARKERS = new Set([0x00005efen, 0x02005efen]);
const LOW_32_BITS = 0xffffffffn;
const SIXTY_FOUR_TO_FOUR_SHIFT = 80n;
const ISATAP_MARKER_SHIFT = 32n;
const IPV6_BITS = 128n;

function inIpv4Network(value, network) {
  const size = 2 ** (32 - network.prefix);
  return value >= network.base && value < network.base + size;
}

function inIpv6Network(value, network) {
  const shift = IPV6_BITS - network.prefix;
  return (value >> shift) === (network.base >> shift);
}

function isPublicIpv4(value) {
  return !IPV4_NON_PUBLIC.some(network => inIpv4Network(value, network));
}

function isPublicIpv6(value) {
  if (!inIpv6Network(value, IPV6_GLOBAL_UNICAST)) return false;
  if (IPV6_NON_PUBLIC_GLOBAL.some(network => inIpv6Network(value, network))) return false;
  if (inIpv6Network(value, IPV6_6TO4)
    && !isPublicIpv4(Number((value >> SIXTY_FOUR_TO_FOUR_SHIFT) & LOW_32_BITS))) return false;
  if (ISATAP_MARKERS.has((value >> ISATAP_MARKER_SHIFT) & LOW_32_BITS)
    && !isPublicIpv4(Number(value & LOW_32_BITS))) return false;
  return true;
}

/**
 * @returns {'public'|'loopback'|'blocked'|null} null when the text is not an IP address.
 * A loopback wrapped in IPv4-mapped or tunnelled IPv6 is 'blocked', never 'loopback'.
 */
function classifyAddress(text) {
  const value4 = parseIpv4(text);
  if (value4 !== null) {
    if (inIpv4Network(value4, IPV4_LOOPBACK)) return 'loopback';
    return isPublicIpv4(value4) ? 'public' : 'blocked';
  }
  const value6 = parseIpv6(text);
  if (value6 === null) return null;
  if (value6 === IPV6_LOOPBACK) return 'loopback';
  return isPublicIpv6(value6) ? 'public' : 'blocked';
}

function normalizeHostname(hostname) {
  let host = String(hostname || '').toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

function classifyHost(host) {
  if (!host) return { allowed: false, reason: 'missing_host' };
  const addressClass = classifyAddress(host);
  if (addressClass === 'blocked') return { allowed: false, reason: 'private_address' };
  if (addressClass) return { allowed: true, isLoopback: addressClass === 'loopback', needsDns: false };
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { allowed: true, isLoopback: true, needsDns: false };
  }
  if (!host.includes('.')) return { allowed: false, reason: 'internal_name' };
  if (INTERNAL_NAME_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return { allowed: false, reason: 'internal_name' };
  }
  return { allowed: true, isLoopback: false, needsDns: true };
}

function refused(reason, fields = {}) {
  return { allowed: false, reason, host: '', port: 0, scheme: '', isLoopback: false, needsDns: false, ...fields };
}

function effectivePort(parsed) {
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? SECURE_DEFAULT_PORT : PLAIN_DEFAULT_PORT;
}

// A bare `localhost[:port][/path]` or `127.0.0.1[:port][/path]` is the address a model types for a dev
// server; read it as http://. Nothing else is touched: the result goes through the same checks as an
// explicit http:// address, so every refusal that applies to that address still applies.
const BARE_LOCAL_ADDRESS = /^(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?(?:[/?#]|$)/i;

function withDefaultScheme(rawUrl) {
  if (typeof rawUrl !== 'string') return rawUrl;
  const text = rawUrl.trim();
  return BARE_LOCAL_ADDRESS.test(text) ? `http://${text}` : rawUrl;
}

/**
 * Pure classification, with no DNS. `kind: 'navigation'` is a top-level destination;
 * `kind: 'subresource'` also permits inline schemes and sockets.
 *
 * @param {string} rawUrl
 * @param {{kind?: 'navigation'|'subresource', reservedPorts?: Iterable<number>}} [options]
 */
function classifyUrl(rawUrl, options = {}) {
  const text = String(rawUrl || '');
  const subresource = options.kind === 'subresource';
  if (!text || text.length > MAX_URL_LENGTH) return refused('invalid_url');
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_error) {
    return refused('invalid_url');
  }
  const scheme = parsed.protocol;
  if (subresource && (LOCAL_SUBRESOURCE_SCHEMES.has(scheme) || LOCAL_ABOUT_PAGES.has(parsed.href))) {
    return { allowed: true, reason: 'inline_content', host: '', port: 0, scheme, isLoopback: false, needsDns: false };
  }
  const permitted = subresource ? NETWORK_SUBRESOURCE_SCHEMES : NAVIGATION_SCHEMES;
  if (!permitted.has(scheme)) return refused('unsupported_scheme', { scheme });
  if (parsed.username || parsed.password) return refused('credentialed_url', { scheme });

  const host = normalizeHostname(parsed.hostname);
  const hostVerdict = classifyHost(host);
  if (!hostVerdict.allowed) return refused(hostVerdict.reason, { host, scheme });
  const port = effectivePort(parsed);
  if (hostVerdict.isLoopback && new Set(options.reservedPorts || []).has(port)) {
    return refused('reserved_port', { host, port, scheme, isLoopback: true });
  }
  return {
    allowed: true,
    reason: hostVerdict.isLoopback ? 'loopback' : 'public_target',
    host, port, scheme,
    isLoopback: hostVerdict.isLoopback,
    needsDns: hostVerdict.needsDns,
  };
}

/**
 * @param {object} deps
 * @param {(host: string) => Promise<{endpoints: Array<{address: string}>}>} deps.resolveHost
 *   Electron `session.resolveHost`, bound to the view's own session.
 * @param {() => Iterable<number>} [deps.reservedPorts] Read per check: engine ports move.
 * @param {() => number} [deps.now]
 */
function createUrlGuard({ resolveHost, reservedPorts, now = Date.now } = {}) {
  const dnsCache = new Map();

  async function lookup(host) {
    if (typeof resolveHost !== 'function') return { ok: false, reason: 'resolver_unavailable' };
    try {
      const answer = await resolveHost(host);
      const endpoints = Array.isArray(answer?.endpoints) ? answer.endpoints : [];
      if (!endpoints.length) return { ok: false, reason: 'unresolved_host' };
      // Every answer must be public: a browser may use any of them, and a public
      // name answering with loopback is the classic way past a port rule.
      const safe = endpoints.every(endpoint => classifyAddress(String(endpoint?.address || '')) === 'public');
      return safe ? { ok: true, reason: '' } : { ok: false, reason: 'resolves_to_private_address' };
    } catch (_error) {
      return { ok: false, reason: 'unresolved_host' };
    }
  }

  function checkName(host) {
    const at = now();
    const cached = dnsCache.get(host);
    if (cached && cached.expires > at) return cached.result;
    dnsCache.delete(host);
    while (dnsCache.size >= MAX_DNS_CACHE_ENTRIES) dnsCache.delete(dnsCache.keys().next().value);
    const result = lookup(host);
    dnsCache.set(host, { result, expires: at + DNS_CACHE_TTL_MS });
    return result;
  }

  /** Synchronous and DNS-free, for `will-navigate`, which must answer before it returns. */
  function classify(rawUrl, { kind = 'navigation' } = {}) {
    const ports = typeof reservedPorts === 'function' ? reservedPorts() : [];
    return classifyUrl(rawUrl, { kind, reservedPorts: ports });
  }

  /** The Refuse-tier verdict for one request, including the DNS check. */
  async function check(rawUrl, { kind = 'navigation' } = {}) {
    const verdict = classify(rawUrl, { kind });
    if (!verdict.allowed || !verdict.needsDns) return verdict;
    const dns = await checkName(verdict.host);
    return dns.ok ? verdict : { ...verdict, allowed: false, reason: dns.reason };
  }

  /**
   * The after-the-fact check against the address Chromium really connected to.
   * An empty `ip` means no socket was used (cache), so there is nothing to refute.
   */
  function checkObservedIp(rawUrl, ip) {
    const address = normalizeHostname(ip);
    if (!address) return { withhold: false, reason: '' };
    const addressClass = classifyAddress(address);
    if (addressClass === 'public') return { withhold: false, reason: '' };
    if (addressClass === 'loopback' && classify(rawUrl, { kind: 'subresource' }).isLoopback) {
      return { withhold: false, reason: '' };
    }
    return { withhold: true, reason: 'landed_on_private_address' };
  }

  return { check, checkObservedIp, classify };
}

module.exports = {
  MAX_URL_LENGTH,
  classifyAddress,
  classifyUrl,
  createUrlGuard,
  normalizeHostname,
  withDefaultScheme,
};
