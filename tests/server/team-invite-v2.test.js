'use strict';

// Slice 5-3 (TEAM_INTERNET_SPEC "Invite version 2"): the jteam2_ codec beside
// version 1, team_invite_too_new, the 512-character bound, hint ordering, the
// owner-entered public address and what the team commands issue with internet
// joining off (version 1, byte for byte) and on (version 2). The fault each test
// catches is named in its comment.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  INVITE_PREFIX_V2, MAX_INVITE_CHARS, addressClass, checksumOf, encodeInvite, inviteContent, orderHints, parseInvite,
  parsePublicAddress, pickAddressHints,
} = require('../../server/team/invites');
const { createTeamCommandsFixture } = require('./helpers/team-commands-fixture');
const { createFixture } = require('./helpers/team-store-fixture');

const { seededRandom } = require('../helpers/seeded-random');

// Encoded by the 1.7.0 codec (server/team/invites.js at 529ceea5d) from these exact inputs.
const GOLDEN = [
  { h: 'Gxv-SSyuRc2KHAWzJ67uhH5FjWvXFCG_7LR1ipnR2Zk', s: '6LwWPILu4YczKIx9SsY22zpt6wE-8tN7aDIr4g7cRcw', hints: [],
    invite: 'jteam1_Gxv-SSyuRc2KHAWzJ67uhH5FjWvXFCG_7LR1ipnR2ZnovBY8gu7hhzMojH1KxjbbOm3rAT7y03toMiviDtxFzAAEQYLs' },
  { h: '-3zUUGOCiCsjMTjrmIUyk6PSL6lt6uSrrQh_sY7xbpw', s: 'rTKIRqoYsyozWBY3RRHKwQY8cEuMV5meUdqfkIKQp6Q',
    hints: ['192.168.1.20:41234'],
    invite: 'jteam1_-3zUUGOCiCsjMTjrmIUyk6PSL6lt6uSrrQh_sY7xbpytMohGqhizKjNYFjdFEcrBBjxwS4xXmZ5R2p-QgpCnpAEEwKgBFKES33JRSw' },
  { h: 'ClwDivE-ODhG0U1g52-N2dqIOy_tWgezZHZPfNxZyo0', s: 'QSQrn65W-tTm533-M8sY0cP8WD-YjPJe-fLZvg1EC7s',
    hints: ['192.168.1.20:41234', '[fd00::1234:5678]:9000', '10.0.0.7:1', '[2001:db8::]:65535'],
    invite: 'jteam1_ClwDivE-ODhG0U1g52-N2dqIOy_tWgezZHZPfNxZyo1BJCufrlb61Obnff4zyxjRw_xYP5iM8l758tm-DUQLuwQEwKgBFKESBv0AAAAAAAAAAAAAABI0VngjKAQKAAAHAAEGIAENuAAAAAAAAAAAAAAAAP__z4LADw' },
];

const NAME63 = `${'a'.repeat(30)}.${'b'.repeat(28)}.net`;
const RELAY100 = `https://${'r'.repeat(60)}.${'s'.repeat(27)}.net`;
const TOKEN48 = 'T'.repeat(48);
const SIX_HINTS = Array.from({ length: 4 }, (_unused, index) => `[2001:db8:1:2:3:4:5:${index + 1}]:5000${index}`);

function keys(fx) {
  return { hostPublicKey: fx.hostKey, inviteSecretKey: fx.key('secret') };
}

// A version 2 string around a hand-built body, with a valid checksum (to reach the field checks).
function v2Of(body) {
  return `${INVITE_PREFIX_V2}${Buffer.concat([body, checksumOf(body, 'jteam2')]).toString('base64url')}`;
}

function bodyHead(fx) {
  return Buffer.concat([Buffer.from(fx.hostKey, 'base64url'), Buffer.from(fx.key('secret'), 'base64url'),
    Buffer.from([0])]);
}

const text = (value) => Buffer.concat([Buffer.from([value.length]), Buffer.from(value, 'latin1')]);

// Fault: changing the version 1 layout or issuing version 2 with internet joining off.
test('version 1 output is byte-identical to 1.7.0 for a host with internet joining off (golden vectors)', () => {
  for (const vector of GOLDEN) {
    const encoded = encodeInvite({ hostPublicKey: vector.h, inviteSecretKey: vector.s, hints: vector.hints });
    assert.equal(encoded.invite, vector.invite);
    const parsed = parseInvite(vector.invite);
    assert.equal(parsed.version, 1);
    assert.deepEqual([parsed.host_name, parsed.relay_url, parsed.relay_token], [null, null, null]);
    assert.deepEqual(parsed.hints, vector.hints);
  }
  // Off keeps today's hint choice: the first four the codec accepts, loopback and all, in the bridge's order.
  const listed = ['127.0.0.1:4242', 'not an address', '100.64.0.9:4242', '[fe80::1]:4242', '10.0.0.2:4242'];
  assert.deepEqual(inviteContent(null, listed), { ok: true, hints: pickAddressHints(listed), internet: null });
  assert.deepEqual(pickAddressHints(listed), ['127.0.0.1:4242', '100.64.0.9:4242', '[fe80::1]:4242', '10.0.0.2:4242']);
  // A version 1 invite has no room for a name or a relay: asking for one is refused, never dropped silently.
  assert.equal(encodeInvite({ hostPublicKey: GOLDEN[0].h, inviteSecretKey: GOLDEN[0].s,
    hostName: { name: 'team.example.net', port: 1 } }).ok, false);
});

// Fault: a field in the wrong place, a missing name_port, or a record past the limit.
test('a version 2 invite round-trips every field; the largest record is 489 characters, inside 512', (t) => {
  const fx = createFixture(t);
  const largest = encodeInvite({ ...keys(fx), version: 2, hints: SIX_HINTS, hostName: { name: NAME63, port: 65535 },
    relayUrl: RELAY100, relayToken: TOKEN48 });
  assert.equal(largest.ok, true);
  assert.equal(largest.invite.length, 489);
  assert.ok(largest.invite.length <= MAX_INVITE_CHARS);
  const parsed = parseInvite(largest.invite);
  assert.deepEqual({ ...parsed, team_id: undefined }, { ok: true, version: 2, team_id: undefined,
    host_public_key: fx.hostKey, invite_secret_key: fx.key('secret'), hints: SIX_HINTS,
    host_name: { name: NAME63, port: 65535 }, relay_url: RELAY100, relay_token: TOKEN48 });
  const bare = parseInvite(encodeInvite({ ...keys(fx), version: 2 }).invite);
  assert.deepEqual([bare.version, bare.hints, bare.host_name, bare.relay_url, bare.relay_token], [2, [], null, null, null]);
  const relayOnly = parseInvite(encodeInvite({ ...keys(fx), version: 2, relayUrl: 'https://relay.example.net:8443' }).invite);
  assert.deepEqual([relayOnly.relay_url, relayOnly.relay_token], ['https://relay.example.net:8443', null]);
});

// Fault: a dropped bound in encodeHostName, encodeText or the token rule.
test('every version 2 field at its limit and one past it', (t) => {
  const fx = createFixture(t);
  const encode = (extra) => encodeInvite({ ...keys(fx), version: 2, ...extra });
  assert.equal(encode({ hostName: { name: NAME63, port: 1 } }).ok, true);
  assert.equal(encode({ relayUrl: RELAY100 }).ok, true);
  assert.equal(encode({ relayUrl: RELAY100, relayToken: TOKEN48 }).ok, true);
  for (const extra of [
    { hostName: { name: `a${NAME63}`, port: 1 } },
    { hostName: { name: 'Team.Example.net', port: 1 } },
    { hostName: { name: '192.0.2.7', port: 1 } },
    { hostName: { name: 'team.example.net', port: 0 } },
    { hostName: { name: 'team.example.net', port: 65536 } },
    { hostName: { name: 'team.example.net' } },
    { relayUrl: `${RELAY100}x` },
    { relayUrl: 'https://Relay.example.net' },
    { relayUrl: 'http://relay.example.net' },
    { relayUrl: RELAY100, relayToken: `${TOKEN48}T` },
    { relayUrl: RELAY100, relayToken: 'has space' },
    { relayToken: 'orphan' },
    { hints: [...SIX_HINTS, '10.0.0.1:1'] },
    { version: 3 },
  ]) {
    const result = encode(extra);
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.error.reason, 'team_invite_malformed');
  }
  // The parser refuses the same things in a body with a valid checksum.
  const head = bodyHead(fx);
  const port = Buffer.from([0x10, 0x92]);
  const none = Buffer.from([0]);
  assert.equal(parseInvite(v2Of(Buffer.concat([head, text(NAME63), port, none, none]))).ok, true);
  for (const tail of [
    Buffer.concat([text(`a${NAME63}`), port, none, none]),
    Buffer.concat([text('team.example.net'), Buffer.from([0, 0]), none, none]),
    Buffer.concat([text('team.example.net'), none, none]),
    Buffer.concat([none, none, text('orphan-token')]),
    Buffer.concat([none, text('https://relay.example.net/'), none]),
    Buffer.concat([none, none, none, Buffer.from([7])]),
    Buffer.concat([none, none]),
  ]) {
    const result = parseInvite(v2Of(Buffer.concat([head, tail])));
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'team_invite_malformed');
  }
});

// Fault: an unknown newer version read as malformed, or decoding before the length check.
test('a newer version answers team_invite_too_new; an older parser refuses version 2 by its prefix', (t) => {
  const fx = createFixture(t);
  for (const newer of ['jteam3_AAAA', 'jteam9999_x', `jteam42_${'A'.repeat(400)}`]) {
    assert.deepEqual(parseInvite(newer).error, { code: 'CMP-HOST-0001', reason: 'team_invite_too_new', retryable: false });
  }
  for (const bad of ['jteam0_AAAA', 'jteam01_AAAA', 'jteam10000_AAAA', `jteam3_${'A'.repeat(MAX_INVITE_CHARS)}`,
    'jteamaddr1_AAAA', 'JTEAM2_AAAA']) {
    assert.equal(parseInvite(bad).error.reason, 'team_invite_malformed', bad.slice(0, 16));
  }
  const v2 = encodeInvite({ ...keys(fx), version: 2, hints: ['203.0.113.9:4242'] }).invite;
  // The 1.7.0 parser's first test (invites.js:142 at 529ceea5d): a version 1 prefix and at most 256 characters.
  assert.equal(v2.startsWith('jteam1_'), false, 'an older Jenny refuses it as team_invite_malformed');
  // A version 1 body under the version 2 prefix fails its checksum (the label differs).
  const v1 = encodeInvite({ ...keys(fx), hints: ['203.0.113.9:4242'] }).invite;
  assert.equal(parseInvite(v1.replace('jteam1_', 'jteam2_')).error.reason, 'team_invite_malformed');
  assert.equal(parseInvite(`${v1}${'A'.repeat(256 - v1.length + 1)}`).error.reason, 'team_invite_malformed');
});

// Fault: a read past the end of a field (Buffer throws) or a refusal that echoes the input.
test('the invite parser is total under seeded random, truncated and flipped input', (t) => {
  const fx = createFixture(t);
  const random = seededRandom(0x5e3);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/ %é';
  const valid = encodeInvite({ ...keys(fx), version: 2, hints: SIX_HINTS.slice(0, 2),
    hostName: { name: 'team.example.net', port: 4242 }, relayUrl: 'https://relay.example.net', relayToken: 'tok_1' }).invite;
  const inputs = [];
  for (let index = 0; index < 3000; index += 1) {
    const prefix = ['jteam1_', 'jteam2_', 'jteam3_', '', 'jteam2'][Math.floor(random() * 5)];
    let body = '';
    const length = Math.floor(random() * 600);
    for (let char = 0; char < length; char += 1) body += alphabet[Math.floor(random() * alphabet.length)];
    inputs.push(`${prefix}${body}`);
  }
  for (let cut = 0; cut < valid.length; cut += 1) inputs.push(valid.slice(0, cut));
  for (let index = 7; index < valid.length; index += 1) {
    inputs.push(`${valid.slice(0, index)}${valid[index] === 'A' ? 'B' : 'A'}${valid.slice(index + 1)}`);
  }
  // Random tails behind a valid head and checksum reach every field reader.
  for (let index = 0; index < 2000; index += 1) {
    const tail = crypto.createHash('sha256').update(String(random())).digest().subarray(0, Math.floor(random() * 32));
    inputs.push(v2Of(Buffer.concat([bodyHead(fx), tail])));
  }
  for (const input of inputs) {
    const result = parseInvite(input);
    if (result.ok) { assert.equal(input, valid); continue; }
    assert.ok(['team_invite_malformed', 'team_invite_too_new'].includes(result.error.reason));
    if (input.length > 12) assert.equal(JSON.stringify(result).includes(input.slice(7, 19)), false);
  }
  assert.equal(parseInvite(valid).ok, true);
});

// Fault: a loopback, link-local or 100.64/10 hint, or the classes in the wrong order.
test('hint ordering: mapped, entered, global IPv6, public IPv4, LAN; never loopback, link-local or 100.64/10', () => {
  const listed = ['127.0.0.1:4242', '10.0.0.2:4242', '[fd12::5]:4242', '198.51.100.4:4242', '169.254.1.1:4242',
    '100.64.0.9:4242', '100.127.255.1:4242', '[fe80::1]:4242', '[::1]:4242', '[2001:db8::7]:4242', '0.0.0.0:4242',
    '224.0.0.1:4242', '[::ffff:c000:207]:4242', '172.16.0.1:4242', 'garbage'];
  assert.deepEqual(orderHints({ addresses: listed }),
    ['[2001:db8::7]:4242', '198.51.100.4:4242', '10.0.0.2:4242', '172.16.0.1:4242']);
  assert.deepEqual(orderHints({ mapped: '203.0.113.9:5000', entered: '[2001:db8::1]:5000', addresses: listed }),
    ['203.0.113.9:5000', '[2001:db8::1]:5000', '[2001:db8::7]:4242', '198.51.100.4:4242']);
  assert.deepEqual(orderHints({ mapped: '100.64.1.1:5000', addresses: ['10.0.0.2:1'] }),
    ['10.0.0.2:1'], 'a shared mapped address is dropped (only mapped may be; an entered one is refused at entry)');
  assert.deepEqual(orderHints({ mapped: '10.0.0.2:1', addresses: ['10.0.0.2:1'] }), ['10.0.0.2:1'], 'no repeats');
  assert.deepEqual(orderHints({ mapped: '192.168.1.1:5000', addresses: ['[2001:db8::7]:1', '10.0.0.2:1'] }),
    ['[2001:db8::7]:1', '10.0.0.2:1'], 'a private mapped address (a router behind a router) takes no slot');
  assert.deepEqual(orderHints({ addresses: ['[fd00::1]:1', '192.168.0.2:1'] }), ['192.168.0.2:1', '[fd00::1]:1']);
  for (const [address, kind] of [['100.63.255.255:1', 'public4'], ['100.128.0.0:1', 'public4'],
    ['172.32.0.1:1', 'public4'], ['[fc00::1]:1', 'private6'], ['[fec0::1]:1', 'global6'], ['[ff02::1]:1', 'excluded']]) {
    assert.equal(addressClass(address), kind, address);
  }
});

// Fault: a name accepted as an address (or the reverse), or a port bound off by one.
test('an owner-entered public address: literals, names and ports at their edges', () => {
  const cases = [
    ['203.0.113.9', { ok: true, hint: '203.0.113.9:4242' }],
    ['203.0.113.9:65535', { ok: true, hint: '203.0.113.9:65535' }],
    ['2001:db8::1', { ok: true, hint: '[2001:db8::1]:4242' }],
    ['[2001:DB8::1]:9', { ok: true, hint: '[2001:db8::1]:9' }],
    ['[2001:db8::1]', { ok: true, hint: '[2001:db8::1]:4242' }],
    ['Team.Example.NET', { ok: true, host_name: { name: 'team.example.net', port: 4242 } }],
    ['team.example.net:1', { ok: true, host_name: { name: 'team.example.net', port: 1 } }],
    [NAME63, { ok: true, host_name: { name: NAME63, port: 4242 } }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parsePublicAddress(input, 4242), expected, input);
  for (const input of ['', 'x'.repeat(81), `a${NAME63}`, '203.0.113.9:0', '203.0.113.9:65536', '203.0.113.9:01',
    '999.0.0.1', '1.2.3', 'team.example.net:', 'bad host', 'https://team.example.net', '[fe80::1%eth0]:1',
    'team_example.net', '-team.example.net', 42, null,
    // Review items 3 and 4: hex forms getaddrinfo reads as IPv4, and literals of a class kept out of an invite.
    '0x7f000001', '1.2.3.0x4', 'team.0X1F:4242', '100.64.1.1', '127.0.0.1:4242', '[fe80::1]', '[::1]:1', '169.254.1.1',
    '[::ffff:127.0.0.1]']) {
    assert.deepEqual(parsePublicAddress(input, 4242), { ok: false, reason: 'team_public_address_invalid' }, String(input));
  }
  assert.equal(parsePublicAddress('team.example.net', 0).ok, false, 'a bad direct port is refused');
});

const INTERNET = Object.freeze({ direct_port: 4242, mapped: '203.0.113.9:4242', public_address: 'team.example.net',
  relay_url: 'https://relay.example.net', relay_token: 'tok_Secret-123' });

// Fault: a malformed setting issued as version 1, or the entered name dropped.
test('inviteContent: on is version 2 with ordered hints; a malformed setting is team_internet_invalid', () => {
  const listed = ['127.0.0.1:4242', '10.0.0.2:4242'];
  assert.deepEqual(inviteContent(INTERNET, listed), { ok: true, hints: ['203.0.113.9:4242', '10.0.0.2:4242'],
    internet: { hostName: { name: 'team.example.net', port: 4242 }, relayUrl: 'https://relay.example.net',
      relayToken: 'tok_Secret-123' } });
  assert.deepEqual(inviteContent({ ...INTERNET, mapped: null, public_address: '198.51.100.4', relay_url: null,
    relay_token: null }, listed).hints, ['198.51.100.4:4242', '10.0.0.2:4242']);
  // The router mapped another outside port: an entered address or name without a port means that one.
  const moved = { ...INTERNET, mapped: '203.0.113.9:5999', relay_url: null, relay_token: null };
  assert.deepEqual(inviteContent({ ...moved, public_address: '198.51.100.4' }, listed).hints,
    ['203.0.113.9:5999', '198.51.100.4:5999', '10.0.0.2:4242']);
  assert.deepEqual(inviteContent({ ...moved, public_address: 'team.example.net' }, listed).internet.hostName,
    { name: 'team.example.net', port: 5999 });
  assert.deepEqual(inviteContent({ ...moved, public_address: 'team.example.net:7000' }, listed).internet.hostName,
    { name: 'team.example.net', port: 7000 }, 'a port the owner typed is kept');
  assert.deepEqual(inviteContent({ ...moved, public_address: '[2001:db8::9]' }, listed).hints,
    ['203.0.113.9:5999', '[2001:db8::9]:4242', '10.0.0.2:4242'], 'the mapping is IPv4 only: IPv6 keeps the direct port');
  assert.deepEqual(inviteContent({ ...moved, mapped: '192.168.1.1:5999', public_address: '198.51.100.4' }, listed).hints,
    ['198.51.100.4:4242', '10.0.0.2:4242'], 'a private mapped address lends no port');
  for (const bad of [{ ...INTERNET, direct_port: 0 }, { ...INTERNET, mapped: 'nope' }, { ...INTERNET, public_address: 'bad host!' },
    { ...INTERNET, relay_url: 'http://relay.example.net' }, { ...INTERNET, relay_url: null }, { ...INTERNET, extra: 1 },
    { direct_port: 4242 }, 'on', 1, undefined, { unreadable: true }, { ...INTERNET, public_address: '127.0.0.1' },
    { ...INTERNET, public_address: '100.64.1.1' }]) {
    const answer = inviteContent(bad, listed);
    assert.equal(answer.error.reason, 'team_internet_invalid', JSON.stringify(bad));
    assert.equal(JSON.stringify(answer).includes('bad host'), false);
  }
});

// Fault: the setting not reaching the invite, or a name, relay, token, address or string in a log or receipt.
test('team commands issue version 2 while internet joining is on; nothing sensitive reaches a log or a receipt', async (t) => {
  let setting = null;
  const f = await createTeamCommandsFixture(t, { addresses: ['127.0.0.1:4242', '10.0.0.2:4242'], internet: () => setting });
  const { owner, alice } = f.seats;
  const created = await f.send(owner, 'team.invite.create', { role: 'member' });
  const off = (await f.send(owner, 'team.invite.reveal', { invite_id: created.invite_id })).invite;
  assert.equal(parseInvite(off).version, 1);
  assert.deepEqual(parseInvite(off).hints, ['127.0.0.1:4242', '10.0.0.2:4242'], 'off keeps today\'s hints');

  setting = INTERNET;
  const on = await f.send(owner, 'team.invite.create', { role: 'member' });
  const invite = (await f.send(owner, 'team.invite.reveal', { invite_id: on.invite_id })).invite;
  const parsed = parseInvite(invite);
  assert.deepEqual([parsed.version, parsed.hints, parsed.host_name, parsed.relay_url, parsed.relay_token],
    [2, ['203.0.113.9:4242', '10.0.0.2:4242'], { name: 'team.example.net', port: 4242 }, 'https://relay.example.net',
      'tok_Secret-123']);
  const device = await f.send(alice, 'team.device.invite');
  assert.equal(parseInvite(device.invite).version, 2);

  setting = { ...INTERNET, public_address: 'bad host!' };
  const refused = await f.send(owner, 'team.invite.create', { role: 'member' });
  assert.equal(refused.error.reason, 'team_internet_invalid');
  const before = f.store.snapshot().invites.length;
  const unreadable = await createTeamCommandsFixture(t, { internet: () => { throw new Error('203.0.113.9'); } });
  const seededInvites = unreadable.store.snapshot().invites.length;
  const thrown = await unreadable.send(unreadable.seats.owner, 'team.invite.create', { role: 'member' });
  assert.equal(thrown.error.reason, 'team_internet_invalid');
  assert.equal(unreadable.store.snapshot().invites.length, seededInvites, 'nothing created');
  // Review item 5: a getter that forgot its `return` is not "off".
  const forgot = await createTeamCommandsFixture(t, { internet: () => undefined });
  const forgotten = await forgot.send(forgot.seats.owner, 'team.invite.create', { role: 'member' });
  assert.equal(forgotten.error?.reason, 'team_internet_invalid', JSON.stringify(forgotten));
  assert.equal(f.store.snapshot().invites.length, before, 'a refused setting creates no invite');

  const exposed = JSON.stringify([f.fx.logs, unreadable.fx.logs, forgot.fx.logs, refused, thrown]) + f.receiptsText();
  for (const secret of ['team.example.net', 'relay.example.net', 'tok_Secret-123', '203.0.113.9', '10.0.0.2', 'bad host',
    invite, invite.slice(50, 85), device.invite.slice(50, 85), 'jteam']) {
    assert.equal(exposed.includes(secret), false, `exposed: ${secret.slice(0, 20)}`);
  }
});
