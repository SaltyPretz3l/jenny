'use strict';

// Whether a deployed host can be reached from the internet (TEAM_INTERNET_SPEC, "Reachability at
// Deploy"): one pure verdict over what the bridge, the owner and the interface list say. First
// match wins. An address counts as the host's own only when it is on an interface: one that only
// the bridge or a relay reported never makes a host "probably reachable" (I4). An owner-entered
// literal counts only when its address is public; a name counts as entered (no lookup here). An
// unspecified, multicast or reserved address is not an address at all. Only a public IPv4 address on an
// interface counts as `public_interface`: a global IPv6 address is on most PCs while the router still lets
// nothing in, and counting it hid `mapping_unavailable` and its fix. A malformed input never
// throws; it reads as nothing seen. `checking` (slice 5-6): the mapping is still `requesting` and nothing else
// matched, so the page says Jenny is finding out instead of "the router did not open the port". Once the caller
// says the check's own bound has passed (`checking_expired`), that is `checking_unknown`: Jenny could not tell.

const net = require('node:net');

const REACH_RESULTS = Object.freeze(['reachable', 'probably_reachable', 'relay', 'not_reachable']);
const REACH_REASONS = Object.freeze([
  'direct_seen', 'mapped', 'public_interface', 'public_entered', 'relay_connected',
  'internet_off', 'relay_connecting', 'relay_denied', 'relay_unreachable', 'shared_address', 'mapping_unavailable',
  'checking', 'checking_unknown',
]);

const PRIVATE = new net.BlockList();
for (const [prefix, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10],
  ['169.254.0.0', 16], ['127.0.0.0', 8]]) {
  PRIVATE.addSubnet(prefix, bits, 'ipv4');
}
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');
PRIVATE.addAddress('::1', 'ipv6');

// Not a usable address: unspecified, multicast and reserved (the broadcast address included).
const NOT_AN_ADDRESS = new net.BlockList();
for (const [prefix, bits] of [['0.0.0.0', 8], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
  NOT_AN_ADDRESS.addSubnet(prefix, bits, 'ipv4');
}
NOT_AN_ADDRESS.addAddress('::', 'ipv6');
NOT_AN_ADDRESS.addSubnet('ff00::', 8, 'ipv6');

const RELAY_REASONS = Object.freeze({ denied: 'relay_denied', unreachable: 'relay_unreachable' });
const MAPPED_ADDRESS = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/u;
// An entered literal hint: `ip:port` or `[v6]:port`.
const HINT_ADDRESS = /^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9A-Fa-f:.]+)\]):\d{1,5}$/u;

const verdict = (result, reason) => ({ result, reason });
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 'public', 'private', or null for something that is not a usable IP address. */
function addressKind(text) {
  if (typeof text !== 'string') return null;
  const address = text.split('%')[0];
  const family = net.isIP(address);
  if (family === 0) return null;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (NOT_AN_ADDRESS.check(address, type)) return null;
  return PRIVATE.check(address, type) ? 'private' : 'public';
}

/** The kind of a `mapped` mapping's outside address, or null when there is no such mapping. */
function mappedKind(mapping) {
  if (!isRecord(mapping) || mapping.state !== 'mapped' || typeof mapping.external !== 'string') return null;
  const match = MAPPED_ADDRESS.exec(mapping.external);
  return match ? addressKind(match[1]) : null;
}

function hasPublicInterface(interfaces) {
  if (!isRecord(interfaces)) return false;
  return Object.values(interfaces).some((list) => Array.isArray(list)
    && list.some((entry) => isRecord(entry) && net.isIPv4(entry.address) && addressKind(entry.address) === 'public'));
}

function hasEntered(entered) {
  if (!isRecord(entered) || entered.ok === false) return false;
  if (isRecord(entered.host_name) && typeof entered.host_name.name === 'string') return true;
  const match = typeof entered.hint === 'string' ? HINT_ADDRESS.exec(entered.hint) : null;
  if (!match) return false;
  const address = match[1] ?? match[2];
  // A bracketed hint holds IPv6 only.
  if (match[2] !== undefined && net.isIPv6(address) === false) return false;
  return addressKind(address) === 'public';
}

function judge(input) {
  if (!isRecord(input) || !isRecord(input.internet)) return verdict('not_reachable', 'internet_off');
  const direct = input.direct_external;
  if (Number.isSafeInteger(direct) && direct >= 1) return verdict('reachable', 'direct_seen');
  const mapped = mappedKind(input.mapping);
  if (mapped === 'public') return verdict('probably_reachable', 'mapped');
  if (hasPublicInterface(input.interfaces)) return verdict('probably_reachable', 'public_interface');
  if (hasEntered(input.entered)) return verdict('probably_reachable', 'public_entered');
  if (input.relay === 'connected') return verdict('relay', 'relay_connected');
  if (input.relay_configured === true) {
    return verdict('not_reachable', Object.hasOwn(RELAY_REASONS, input.relay) ? RELAY_REASONS[input.relay] : 'relay_connecting');
  }
  // Slice 5-6 (finding 5): while the router has not answered yet, probing is not failing.
  if (mapped === null && isRecord(input.mapping) && input.mapping.state === 'requesting') {
    return verdict('not_reachable', input.checking_expired === true ? 'checking_unknown' : 'checking');
  }
  return verdict('not_reachable', mapped === 'private' ? 'shared_address' : 'mapping_unavailable');
}

/**
 * `{ result, reason }` from `{ internet, mapping, entered, interfaces, direct_external, relay_configured,
 * relay, checking_expired }`: `internet` null is off; `mapping` and `relay` as host-bridge.js answers them; `entered` what
 * invites.js `parsePublicAddress` made of the owner's address; `interfaces` as `os.networkInterfaces()`.
 */
function judgeReach(input) {
  try {
    return judge(input);
  } catch {
    return verdict('not_reachable', 'mapping_unavailable');
  }
}

module.exports = { REACH_REASONS, REACH_RESULTS, judgeReach };
