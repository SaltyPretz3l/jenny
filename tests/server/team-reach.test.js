'use strict';

// The reachability verdict of a deployed host (TEAM_INTERNET_SPEC, "Reachability at Deploy"): one
// pure function over what the bridge, the owner and the interface list say, first match wins, and an
// address counts as the host's own only when it is on an interface.

const assert = require('node:assert/strict');
const test = require('node:test');

const { REACH_REASONS, REACH_RESULTS, judgeReach } = require('../../server/team/transport/reach');

const ON = Object.freeze({ map_port: true });
const LAN = Object.freeze({
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
  eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false },
    { address: 'fe80::1c2d:3e4f:5a6b:7c8d', family: 'IPv6', internal: false }],
});
const PUBLIC_V4 = Object.freeze({ ...LAN, wan: [{ address: '198.51.100.20', family: 'IPv4', internal: false }] });

// Every field at its "nothing seen" value, with internet joining on and no relay.
function base(overrides = {}) {
  return { internet: ON, mapping: null, entered: null, interfaces: LAN, direct_external: null,
    relay_configured: false, relay: null, ...overrides };
}

const verdict = (overrides) => judgeReach(base(overrides));

test('the word lists are frozen and hold every result and reason', () => {
  assert.deepEqual(REACH_RESULTS, ['reachable', 'probably_reachable', 'relay', 'not_reachable']);
  assert.deepEqual(REACH_REASONS, ['direct_seen', 'mapped', 'public_interface', 'public_entered', 'relay_connected',
    'internet_off', 'relay_connecting', 'relay_denied', 'relay_unreachable', 'shared_address', 'mapping_unavailable', 'checking',
    'checking_unknown']);
  assert.equal(Object.isFrozen(REACH_RESULTS), true);
  assert.equal(Object.isFrozen(REACH_REASONS), true);
});

test('each row of the table, in order of precedence: the row above wins over everything below it', () => {
  const everything = { direct_external: 1, mapping: { state: 'mapped', external: '203.0.113.7:4444' },
    interfaces: PUBLIC_V4, entered: { ok: true, host_name: { name: 'team.example.com', port: 4444 } },
    relay_configured: true, relay: 'connected' };
  assert.deepEqual(verdict(everything), { result: 'reachable', reason: 'direct_seen' });
  assert.deepEqual(verdict({ ...everything, direct_external: 0 }), { result: 'probably_reachable', reason: 'mapped' });
  assert.deepEqual(verdict({ ...everything, direct_external: 0, mapping: null }),
    { result: 'probably_reachable', reason: 'public_interface' });
  assert.deepEqual(verdict({ ...everything, direct_external: null, mapping: null, interfaces: LAN }),
    { result: 'probably_reachable', reason: 'public_entered' });
  assert.deepEqual(verdict({ ...everything, direct_external: 0, mapping: null, interfaces: LAN, entered: null }),
    { result: 'relay', reason: 'relay_connected' });
  for (const [relay, reason] of [['denied', 'relay_denied'], ['unreachable', 'relay_unreachable'],
    ['connecting', 'relay_connecting'], ['off', 'relay_connecting'], [null, 'relay_connecting']]) {
    assert.deepEqual(verdict({ relay_configured: true, relay, mapping: { state: 'mapped', external: '192.168.1.5:4444' } }),
      { result: 'not_reachable', reason }, `a configured relay's word wins over the mapping: ${relay}`);
  }
  assert.deepEqual(verdict({ mapping: { state: 'mapped', external: '192.168.1.5:4444' } }),
    { result: 'not_reachable', reason: 'shared_address' });
  assert.deepEqual(verdict({ mapping: { state: 'unavailable', external: null } }),
    { result: 'not_reachable', reason: 'mapping_unavailable' });
  assert.deepEqual(verdict({}), { result: 'not_reachable', reason: 'mapping_unavailable' });
});

test('internet joining off is internet_off whatever else is set', () => {
  assert.deepEqual(verdict({ internet: null, relay_configured: true, relay: 'connected', interfaces: PUBLIC_V4 }),
    { result: 'not_reachable', reason: 'internet_off' });
  assert.deepEqual(verdict({ internet: null, direct_external: 3, mapping: { state: 'mapped', external: '203.0.113.7:1' } }),
    { result: 'not_reachable', reason: 'internet_off' });
});

test('a mapping to a shared or private address is shared_address, never mapped', () => {
  for (const external of ['100.64.0.1:4444', '192.168.1.5:4444', '10.0.0.9:4444', '172.16.4.4:4444']) {
    assert.deepEqual(verdict({ mapping: { state: 'mapped', external } }), { result: 'not_reachable', reason: 'shared_address' },
      external);
  }
});

test('a public address only the bridge reported is never public_interface', () => {
  // In the external field of a mapping that is not `mapped` (the bridge's own report).
  for (const state of ['requesting', 'unavailable', 'off']) {
    // Slice 5-6: while the mapping is still `requesting` the reason is `checking` (finding 5), never a public interface.
    assert.deepEqual(verdict({ mapping: { state, external: '203.0.113.7:4444' } }),
      { result: 'not_reachable', reason: state === 'requesting' ? 'checking' : 'mapping_unavailable' }, state);
  }
  // Nowhere on an interface: the interface list here holds only LAN, loopback and link-local addresses.
  assert.deepEqual(verdict({ relay_configured: true, relay: 'connected' }), { result: 'relay', reason: 'relay_connected' });
});

// A global IPv6 address is on most PCs while the router lets nothing in: it must not hide the router's refusal.
test('only a public IPv4 interface address is public_interface; a global IPv6 one, fe80, fc00, ::1 and 169.254 are not', () => {
  const only = (address, family = 'IPv6') => ({ eth0: [{ address, family, internal: false }] });
  for (const address of ['2001:db8:1234::20', '2a01:4f8::1%eth0', '::ffff:198.51.100.7']) {
    assert.deepEqual(verdict({ interfaces: only(address) }), { result: 'not_reachable', reason: 'mapping_unavailable' }, address);
    assert.deepEqual(verdict({ interfaces: only(address), mapping: { state: 'mapped', external: '203.0.113.9:4455' } }),
      { result: 'probably_reachable', reason: 'mapped' }, address);
  }
  for (const [address, family] of [['fe80::1', 'IPv6'], ['fd12:3456::1', 'IPv6'], ['fc00::1', 'IPv6'], ['::1', 'IPv6'],
    ['169.254.10.10', 'IPv4'], ['127.0.0.1', 'IPv4'], ['10.1.2.3', 'IPv4'], ['172.31.0.1', 'IPv4'], ['100.100.0.1', 'IPv4']]) {
    assert.deepEqual(verdict({ interfaces: only(address, family) }), { result: 'not_reachable', reason: 'mapping_unavailable' },
      address);
  }
  assert.deepEqual(verdict({ interfaces: only('172.32.0.1', 'IPv4') }), { result: 'probably_reachable', reason: 'public_interface' },
    '172.32 is outside 172.16/12');
});

test('an entered literal or name is public_entered, and only a parsed entry counts', () => {
  assert.deepEqual(verdict({ entered: { ok: true, hint: '198.51.100.9:4444' } }), { result: 'probably_reachable', reason: 'public_entered' });
  assert.deepEqual(verdict({ entered: { ok: true, host_name: { name: 'team.example.com', port: 4444 } } }),
    { result: 'probably_reachable', reason: 'public_entered' });
  for (const entered of [{ ok: false, reason: 'team_public_address_invalid' }, { ok: true }, { hint: 7 }, 'team.example.com']) {
    assert.deepEqual(verdict({ entered }), { result: 'not_reachable', reason: 'mapping_unavailable' }, JSON.stringify(entered));
  }
});

test('garbage in every field answers a not_reachable verdict and never throws', () => {
  const garbage = [undefined, null, 42, 'text', [], {}, { state: 'mapped', external: 9 }, Symbol('x'), () => {},
    Object.create(null), { eth0: 'no list' }, { eth0: [null, 7, { address: 3 }] }, NaN, -1, 1.5, true];
  assert.equal(judgeReach(undefined).result, 'not_reachable');
  assert.equal(judgeReach(null).result, 'not_reachable');
  assert.equal(judgeReach('x').result, 'not_reachable');
  for (const value of garbage) {
    const all = { internet: value, mapping: value, entered: value, interfaces: value, direct_external: value,
      relay_configured: value, relay: value };
    const answer = judgeReach(all);
    assert.equal(answer.result, 'not_reachable', String(typeof value));
    assert.ok(REACH_REASONS.includes(answer.reason), answer.reason);
    for (const field of Object.keys(all)) {
      const one = judgeReach(base({ [field]: value }));
      assert.ok(REACH_RESULTS.includes(one.result) && REACH_REASONS.includes(one.reason), `${field}: ${String(typeof value)}`);
    }
  }
  const throwing = { get mapping() { throw new Error('boom'); }, internet: ON };
  assert.equal(judgeReach(throwing).result, 'not_reachable');
});

const NOT_AN_ADDRESS = Object.freeze([['0.0.0.0', 4], ['0.255.1.2', 4], ['224.0.0.1', 4], ['239.255.255.250', 4],
  ['240.0.0.1', 4], ['255.255.255.255', 4], ['::', 6], ['ff02::1', 6], ['ff0e::1', 6]]);

test('an entered literal counts only when its address is public; a name counts as before', () => {
  const entered = (hint) => ({ entered: { ok: true, hint }, relay_configured: true, relay: 'connected' });
  for (const hint of ['192.168.1.5:4444', '[fd00::1]:4444', '127.0.0.1:4444', '10.0.0.2:1', '[fe80::1]:4444']) {
    assert.deepEqual(verdict(entered(hint)), { result: 'relay', reason: 'relay_connected' }, `${hint} falls through to the relay`);
    assert.deepEqual(verdict({ entered: { ok: true, hint } }), { result: 'not_reachable', reason: 'mapping_unavailable' },
      `${hint} falls through to the mapping`);
  }
  for (const hint of ['198.51.100.9:4444', '[2001:db8::9]:4444']) {
    assert.deepEqual(verdict({ entered: { ok: true, hint } }), { result: 'probably_reachable', reason: 'public_entered' }, hint);
  }
  assert.deepEqual(verdict({ entered: { ok: true, host_name: { name: 'team.example.com', port: 4444 } } }),
    { result: 'probably_reachable', reason: 'public_entered' });
  for (const hint of ['198.51.100.9', 'nonsense:1', '[198.51.100.9]:1']) {
    assert.deepEqual(verdict({ entered: { ok: true, hint } }), { result: 'not_reachable', reason: 'mapping_unavailable' }, hint);
  }
});

test('an unspecified, multicast or reserved address is not an address in the mapping, the interfaces or an entry', () => {
  for (const [address, family] of NOT_AN_ADDRESS) {
    const literal = family === 4 ? `${address}:4444` : `[${address}]:4444`;
    const interfaces = { eth0: [{ address, family: `IPv${family}`, internal: false }] };
    assert.deepEqual(verdict({ interfaces }), { result: 'not_reachable', reason: 'mapping_unavailable' }, `interface ${address}`);
    assert.deepEqual(verdict({ entered: { ok: true, hint: literal } }), { result: 'not_reachable', reason: 'mapping_unavailable' },
      `entered ${address}`);
    if (family === 4) {
      assert.deepEqual(verdict({ mapping: { state: 'mapped', external: literal } }),
        { result: 'not_reachable', reason: 'mapping_unavailable' }, `mapping ${address}: neither mapped nor shared`);
    }
  }
});

test('the range edges and an IPv4-mapped IPv6 address', () => {
  const kind = (address) => {
    const family = address.includes(':') ? 'IPv6' : 'IPv4';
    return verdict({ interfaces: { eth0: [{ address, family, internal: false }] } }).reason === 'public_interface' ? 'public' : 'private';
  };
  for (const address of ['172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '9.255.255.255', '11.0.0.0']) {
    assert.equal(kind(address), 'public', address);
  }
  for (const address of ['172.16.0.0', '172.31.255.255', '100.64.0.0', '100.127.255.255', '169.254.0.1', '169.254.255.254',
    '127.0.0.1', '127.255.255.254', '10.0.0.0', '192.168.255.255', '::ffff:10.0.0.1', '::ffff:192.168.1.5']) {
    assert.equal(kind(address), 'private', address);
  }
  assert.equal(kind('::ffff:198.51.100.7'), 'private', 'only an IPv4 interface address counts');
});

test('internet as true, a string or an array is internet_off', () => {
  for (const internet of [true, 'on', [], [ON]]) {
    assert.deepEqual(verdict({ internet, direct_external: 2, interfaces: PUBLIC_V4 }), { result: 'not_reachable', reason: 'internet_off' },
      JSON.stringify(internet));
  }
});

// Slice 5-6 (finding 5): probing is not failing. Until the router answers, the verdict says Jenny is checking; the
// rows above it still win, and a relay that is set keeps its own reasons.
test('a mapping still requesting is checking, below every row that already knows', () => {
  const requesting = { mapping: { state: 'requesting' } };
  assert.deepEqual(verdict(requesting), { result: 'not_reachable', reason: 'checking' });
  assert.deepEqual(verdict({ ...requesting, interfaces: PUBLIC_V4 }), { result: 'probably_reachable', reason: 'public_interface' });
  assert.deepEqual(verdict({ ...requesting, relay_configured: true, relay: 'connecting' }),
    { result: 'not_reachable', reason: 'relay_connecting' });
  assert.deepEqual(verdict({ mapping: { state: 'unavailable' } }), { result: 'not_reachable', reason: 'mapping_unavailable' });
  assert.deepEqual(verdict({ mapping: { state: 'mapped', external: '10.0.0.2:4444' } }), { result: 'not_reachable', reason: 'shared_address' });
  // Review of 5-6 (item 24): past the check's own bound the router that never answered is "could not tell".
  assert.deepEqual(verdict({ ...requesting, checking_expired: true }), { result: 'not_reachable', reason: 'checking_unknown' });
  assert.deepEqual(verdict({ ...requesting, checking_expired: true, interfaces: PUBLIC_V4 }), { result: 'probably_reachable', reason: 'public_interface' });
});
