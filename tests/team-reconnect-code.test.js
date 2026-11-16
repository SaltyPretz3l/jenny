'use strict';

// Slice 5-3 (TEAM_INTERNET_SPEC I9, T6): the jteamaddr1_ reconnect code, the
// owner's code built from the host's hints, a member applying one to its client
// file, and the DNS name lookup done before every dial (host-name.js). The fault
// each test catches is named in its comment.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { checksumOf, encodeHints } = require('../server/team/invites');
const { clientFilePath, loadClientFile, saveClientFile } = require('../services/team/client-file');
const { resolveHostName, withHostName } = require('../services/team/host-name');
const {
  MAX_RECONNECT_CODE_CHARS, applyReconnectCode, buildHostReconnectCode, encodeReconnectCode, parseReconnectCode,
  writeReconnectCode,
} = require('../services/team/reconnect-code');
const { applyTeamReconnectCode } = require('../services/team/reconnect-apply');
const { tempProfile } = require('./helpers/team-client-host');
const { seededRandom } = require('./helpers/seeded-random');

const hostKey = () => keyPairFromSeed(crypto.randomBytes(32)).publicKey;
const MALFORMED = { ok: false, reason: 'team_reconnect_code_malformed' };
const NAME = { name: 'team.example.net', port: 4242 };
const FOUR = ['[2001:db8::1]:4242', '[2001:db8::2]:4242', '[2001:db8::3]:4242', '[2001:db8::4]:4242'];

function record(host = hostKey(), overrides = {}) {
  return { schema_version: 2, team_id: deriveTeamId(host), host_public_key: host, address_hints: ['192.0.2.7:4242'],
    last_addresses: ['192.0.2.7:4242'], member_id: 'member_abcDEF123', device_id: 'device_abcDEF123',
    display_name: 'Mika Member', joined_at: '2026-11-10T10:00:00.000Z', state_seen: 'active', ...overrides };
}

function codeOf(body) {
  return `jteamaddr1_${Buffer.concat([body, checksumOf(body, 'jteamaddr1')]).toString('base64url')}`;
}

// Fault: a field in the wrong place, or the name's port dropped.
test('a reconnect code round-trips the host key, one to four hints and an optional name', () => {
  const host = hostKey();
  const full = encodeReconnectCode({ hostPublicKey: host, hints: FOUR, hostName: { name: `${'a'.repeat(59)}.net`, port: 1 } });
  assert.equal(full.ok, true);
  assert.ok(full.code.startsWith('jteamaddr1_') && full.code.length <= MAX_RECONNECT_CODE_CHARS);
  assert.deepEqual(parseReconnectCode(full.code), { ok: true, team_id: deriveTeamId(host), host_public_key: host,
    hints: FOUR, host_name: { name: `${'a'.repeat(59)}.net`, port: 1 } });
  const one = parseReconnectCode(encodeReconnectCode({ hostPublicKey: host, hints: ['203.0.113.9:4242'] }).code);
  assert.deepEqual([one.hints, one.host_name], [['203.0.113.9:4242'], null]);
});

// Fault: a hint count bound dropped (zero or five hints accepted), or the 512 bound dropped.
test('every reconnect code limit at its edge and one past it', () => {
  const host = hostKey();
  assert.deepEqual(encodeReconnectCode({ hostPublicKey: host, hints: [] }), MALFORMED, 'at least one hint');
  assert.deepEqual(encodeReconnectCode({ hostPublicKey: host, hints: [...FOUR, '10.0.0.1:1'] }), MALFORMED);
  assert.deepEqual(encodeReconnectCode({ hostPublicKey: host, hints: ['10.0.0.1:1'], hostName: { name: `${'a'.repeat(60)}.net`, port: 1 } }),
    MALFORMED, 'a 64-character name');
  assert.deepEqual(encodeReconnectCode({ hostPublicKey: 'short', hints: ['10.0.0.1:1'] }), MALFORMED);
  const head = Buffer.from(host, 'base64url');
  assert.deepEqual(parseReconnectCode(codeOf(Buffer.concat([head, Buffer.from([0, 0])]))), MALFORMED, 'zero hints');
  const hint = Buffer.from([4, 10, 0, 0, 1, 0, 1]);
  assert.equal(parseReconnectCode(codeOf(Buffer.concat([head, Buffer.from([1]), hint, Buffer.from([0])]))).ok, true);
  assert.deepEqual(parseReconnectCode(codeOf(Buffer.concat([head, Buffer.from([5]), ...Array(5).fill(hint), Buffer.from([0])]))), MALFORMED);
  assert.deepEqual(parseReconnectCode(codeOf(Buffer.concat([head, Buffer.from([1]), hint, Buffer.from([0, 9])]))), MALFORMED, 'trailing byte');
  assert.deepEqual(parseReconnectCode(`jteamaddr1_${'A'.repeat(MAX_RECONNECT_CODE_CHARS)}`), MALFORMED);
  for (const bad of ['', 'jteamaddr2_AAAA', 'jteam1_AAAA', null, 42, 'jteamaddr1_', 'jteamaddr1_!!!!']) {
    assert.deepEqual(parseReconnectCode(bad), MALFORMED, String(bad));
  }
});

// Fault: a read past a field's end throwing, or a refusal that carries the input.
test('the reconnect code parser is total under seeded random, truncated and flipped input', () => {
  const random = seededRandom(0x5e3a);
  const valid = encodeReconnectCode({ hostPublicKey: hostKey(), hints: FOUR.slice(0, 2), hostName: NAME }).code;
  const inputs = [];
  for (let cut = 0; cut < valid.length; cut += 1) inputs.push(valid.slice(0, cut));
  for (let index = 11; index < valid.length; index += 1) {
    inputs.push(`${valid.slice(0, index)}${valid[index] === 'A' ? 'B' : 'A'}${valid.slice(index + 1)}`);
  }
  for (let index = 0; index < 3000; index += 1) {
    const tail = crypto.createHash('sha512').update(String(random())).digest().subarray(0, Math.floor(random() * 64));
    inputs.push(codeOf(Buffer.concat([crypto.randomBytes(32), tail])));
    inputs.push(`jteamaddr1_${tail.toString('base64url')}`);
  }
  for (const input of inputs) {
    const result = parseReconnectCode(input);
    if (!result.ok) {
      assert.deepEqual(result, MALFORMED);
      continue;
    }
    assert.ok(result.hints.length >= 1 && result.hints.length <= 4);
  }
});

// Fault: loopback or link-local hints in the owner's code, or the owner's name dropped.
test('the owner\'s code carries the host\'s ordered hints and its name; with no usable hint it says so', () => {
  // Review item 5: only null is off; undefined (a getter with no return) is refused.
  assert.deepEqual(buildHostReconnectCode({ hostPublicKey: hostKey(), addresses: ['198.51.100.4:1'], internet: undefined }),
    { ok: false, reason: 'team_internet_invalid' });
  const host = hostKey();
  const built = buildHostReconnectCode({ hostPublicKey: host,
    addresses: ['127.0.0.1:4242', '[fe80::1]:4242', '10.0.0.2:4242', '198.51.100.4:4242'], internet: null });
  assert.deepEqual(parseReconnectCode(built.code).hints, ['198.51.100.4:4242', '10.0.0.2:4242']);
  const internet = { direct_port: 4242, mapped: '203.0.113.9:4242', public_address: 'Team.Example.net',
    relay_url: null, relay_token: null };
  const withName = parseReconnectCode(buildHostReconnectCode({ hostPublicKey: host, addresses: ['10.0.0.2:4242'], internet }).code);
  assert.deepEqual([withName.hints, withName.host_name], [['203.0.113.9:4242', '10.0.0.2:4242'], NAME]);
  assert.deepEqual(buildHostReconnectCode({ hostPublicKey: host, addresses: ['127.0.0.1:4242'], internet: null }),
    { ok: false, reason: 'team_host_addresses_unavailable' });
  const refused = buildHostReconnectCode({ hostPublicKey: host, addresses: [], internet: { ...internet, public_address: 'bad host' } });
  assert.deepEqual(refused, { ok: false, reason: 'team_internet_invalid' });
});

// Fault: a code applied to a team whose host key it does not name (T6), or stale last addresses kept.
test('applying a code replaces the hints and the name, clears the stale addresses and keeps the identity', () => {
  const host = hostKey();
  const before = record(host, { schema_version: 3, host_name: null, relay_url: 'https://relay.example.net' });
  const code = encodeReconnectCode({ hostPublicKey: host, hints: ['203.0.113.9:4242'], hostName: NAME }).code;
  const applied = applyReconnectCode(before, code);
  assert.deepEqual(applied, { ok: true, record: { ...before, address_hints: ['203.0.113.9:4242'], last_addresses: [],
    host_name: NAME, relay_url: 'https://relay.example.net' } });
  // A LAN team stays schema 2 when the code names no host name.
  const lan = applyReconnectCode(record(host), encodeReconnectCode({ hostPublicKey: host, hints: ['10.0.0.9:1'] }).code);
  assert.deepEqual(lan.record, { ...record(host), address_hints: ['10.0.0.9:1'], last_addresses: [] });
  const other = applyReconnectCode(before, encodeReconnectCode({ hostPublicKey: hostKey(), hints: ['10.0.0.9:1'] }).code);
  assert.deepEqual(other, { ok: false, error: { code: 'CMP-TEAM-0003', reason: 'team_reconnect_code_other_team' } });
  assert.deepEqual(applyReconnectCode(before, 'jteamaddr1_nope'),
    { ok: false, error: { code: 'CMP-TEAM-0003', reason: 'team_reconnect_code_malformed' } });
});

// Fault: a refused code that still rewrites the client file.
test('a code naming another host key, or a malformed one, changes nothing on disk', (t) => {
  const dir = tempProfile(t, 'jenny-team-reconnect-');
  const host = hostKey();
  const value = record(host);
  assert.equal(saveClientFile(dir, value).ok, true);
  const file = clientFilePath(dir, value.team_id);
  const bytes = fs.readFileSync(file);
  for (const code of [encodeReconnectCode({ hostPublicKey: hostKey(), hints: ['10.0.0.9:1'] }).code, 'jteamaddr1_AAAA', 'x']) {
    const answer = writeReconnectCode({ userDataPath: dir, teamId: value.team_id, code });
    assert.equal(answer.ok, false);
    assert.equal(JSON.stringify(answer).includes(code.slice(11, 30) || 'never'), false, 'the code is not echoed');
    assert.deepEqual(fs.readFileSync(file), bytes, 'nothing rewritten');
  }
  const good = encodeReconnectCode({ hostPublicKey: host, hints: ['203.0.113.9:4242'], hostName: NAME }).code;
  assert.equal(writeReconnectCode({ userDataPath: dir, teamId: value.team_id, code: good }).ok, true);
  const saved = loadClientFile(dir, value.team_id).record;
  assert.deepEqual([saved.schema_version, saved.address_hints, saved.host_name, saved.relay_url],
    [3, ['203.0.113.9:4242'], NAME, null]);
  assert.equal(fs.readFileSync(file, 'utf8').includes('jteamaddr1_'), false, 'the code itself is never stored');
});

// Fault (team-service's `teamReconnectCode`): a refused code stopping the team's manager, or a valid one
// applied to the file as it was before the stop, so the stopping manager's last save is lost.
test('reconnect-apply stops nothing for a refused code and applies a valid one after the stop', async (t) => {
  const dir = tempProfile(t, 'jenny-team-reconnect-apply-');
  const host = hostKey();
  const value = record(host);
  assert.equal(saveClientFile(dir, value).ok, true);
  const file = clientFilePath(dir, value.team_id);
  const bytes = fs.readFileSync(file);
  const steps = [];
  const stop = async () => {
    steps.push('stop');
    assert.equal(saveClientFile(dir, { ...value, state_seen: 'pending' }).ok, true);
  };
  const start = (next) => steps.push(['start', next.address_hints, next.state_seen, next.last_addresses]);
  const other = encodeReconnectCode({ hostPublicKey: hostKey(), hints: ['10.0.0.9:1'] }).code;
  for (const code of [other, 'jteamaddr1_AAAA']) {
    const answer = await applyTeamReconnectCode({ userDataPath: dir, teamId: value.team_id, code, stop, start });
    assert.equal(answer.ok, false);
  }
  assert.deepEqual(steps, [], 'no manager stopped or started');
  assert.deepEqual(fs.readFileSync(file), bytes, 'nothing rewritten');
  const good = encodeReconnectCode({ hostPublicKey: host, hints: ['203.0.113.9:4242'] }).code;
  assert.deepEqual(await applyTeamReconnectCode({ userDataPath: dir, teamId: value.team_id, code: good, stop, start }),
    { ok: true });
  assert.deepEqual(steps, ['stop', ['start', ['203.0.113.9:4242'], 'pending', []]]);
});

// Slice 5-3 review items 2 and 14. Fault: a manager restarted from the record read before the stop
// after the file went away (it would write the removed team back), or no manager after a failed
// write with the file intact.
test('reconnect-apply restarts only from a file that loads now', async (t) => {
  const dir = tempProfile(t, 'jenny-team-reconnect-restart-');
  const host = hostKey();
  const value = record(host);
  const good = encodeReconnectCode({ hostPublicKey: host, hints: ['203.0.113.9:4242'] }).code;
  const started = [];
  const start = (next) => started.push(next);
  assert.equal(saveClientFile(dir, value).ok, true);
  const gone = await applyTeamReconnectCode({ userDataPath: dir, teamId: value.team_id, code: good, start,
    stop: async () => { fs.rmSync(clientFilePath(dir, value.team_id)); } });
  assert.equal(gone.ok, false);
  assert.deepEqual(started, [null], 'nothing started, the snapshot pushed');
  assert.equal(fs.existsSync(clientFilePath(dir, value.team_id)), false, 'no client file');
  assert.equal(saveClientFile(dir, value).ok, true);
  started.length = 0;
  const thrown = await applyTeamReconnectCode({ userDataPath: dir, teamId: value.team_id, code: good, start,
    stop: async () => {}, write: () => { throw new Error('disk full at C:/secret'); } });
  assert.deepEqual([thrown.ok, thrown.error?.reason], [false, 'team_client_write_failed']);
  assert.equal(JSON.stringify(thrown).includes('secret'), false);
  assert.deepEqual(started, [value], 'the old record is running again');
});

// Fault: a non-address DNS answer, a zone id or an unbounded answer list reaching the bridge.
test('a DNS answer is untrusted: non-IP entries and zone ids are dropped and at most four addresses used', async () => {
  const calls = [];
  const lookup = async (name, options) => {
    calls.push([name, options]);
    return [{ address: 'not-an-ip', family: 4 }, { address: 'fe80::1%eth0', family: 6 }, { address: '0.0.0.0', family: 4 },
      { address: '203.0.113.9', family: 4 }, { address: '2001:db8::9', family: 6 }, { address: '203.0.113.9', family: 4 },
      ...Array.from({ length: 40 }, (_unused, index) => ({ address: `198.51.100.${index + 1}`, family: 4 }))];
  };
  const resolved = await resolveHostName(NAME, { lookup });
  assert.deepEqual(resolved, { ok: true,
    addresses: ['203.0.113.9:4242', '[2001:db8::9]:4242', '198.51.100.1:4242', '198.51.100.2:4242'] });
  assert.deepEqual(calls, [['team.example.net', { all: true, family: 0, verbatim: true }]]);
  for (const answers of [[], [{ address: 'x' }], null, 'text']) {
    assert.deepEqual(await resolveHostName(NAME, { lookup: async () => answers }), { ok: false, reason: 'host_name_unresolved' });
  }
  const failing = await resolveHostName(NAME, { lookup: async () => { throw new Error('ENOTFOUND team.example.net'); } });
  assert.deepEqual(failing, { ok: false, reason: 'host_name_unresolved' }, 'the error text (with the name) is dropped');
  assert.deepEqual(await resolveHostName({ name: 'Bad Name', port: 1 }, { lookup }), { ok: false, reason: 'host_name_unresolved' });
  assert.equal(calls.length, 1, 'an invalid name is never looked up');
});

// Fault: a lookup with no timeout holding a dial forever.
test('a lookup that never answers ends as host_name_unresolved after the timeout, leaving no timer', async () => {
  const live = new Set();
  // A plain wrapper (no unref), so the pending lookup keeps this test's event loop alive.
  const timers = {
    setTimeout(fn, ms) {
      const handle = { id: null };
      handle.id = setTimeout(() => { live.delete(handle); fn(); }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) { live.delete(handle); clearTimeout(handle.id); },
  };
  const started = Date.now();
  const resolved = await resolveHostName(NAME, { lookup: () => new Promise(() => {}), timeoutMs: 30, timers });
  assert.deepEqual(resolved, { ok: false, reason: 'host_name_unresolved' });
  assert.ok(Date.now() - started < 2000);
  assert.equal(live.size, 0);
});

// Fault: resolved addresses cut off by a full set, or a lookup for a team with no name.
test('resolved addresses are appended to each set with room kept; no name means no lookup', async () => {
  let lookups = 0;
  const resolveName = async () => { lookups += 1; return { ok: true, addresses: ['203.0.113.9:4242', 'junk'] }; };
  const full = Array.from({ length: 16 }, (_unused, index) => `10.0.0.${index + 1}:1`);
  const planned = await withHostName([full, ['10.1.0.1:1']], NAME, resolveName);
  assert.equal(planned.sets[0].length, 16);
  assert.equal(planned.sets[0][15], '203.0.113.9:4242');
  assert.deepEqual(planned.sets[1], ['10.1.0.1:1', '203.0.113.9:4242']);
  assert.deepEqual((await withHostName([], NAME, resolveName)).sets, [['203.0.113.9:4242']]);
  const none = await withHostName([['10.1.0.1:1']], null, resolveName);
  assert.deepEqual(none, { sets: [['10.1.0.1:1']], unresolved: false });
  assert.equal(lookups, 2);
  const unresolved = await withHostName([['10.1.0.1:1']], NAME, async () => ({ ok: false, reason: 'host_name_unresolved' }));
  assert.deepEqual(unresolved, { sets: [['10.1.0.1:1']], unresolved: true });
});

// Slice 5-3 review item 8. Fault: a pasted code or a DNS answer pointing the member at loopback,
// link-local or an IPv4-mapped address, which no Jenny-built code or internet hint carries.
test('loopback, link-local and IPv4-mapped hints and DNS answers are dropped; none left is a refusal', async () => {
  const host = hostKey();
  const codeWith = (hints) => codeOf(Buffer.concat([Buffer.from(host, 'base64url'), encodeHints(hints, 1), Buffer.from([0])]));
  for (const hints of [['127.0.0.1:4242'], ['[fe80::1]:4242'], ['[::ffff:7f00:1]:4242'], ['127.0.0.1:1', '169.254.1.1:1']]) {
    assert.deepEqual(parseReconnectCode(codeWith(hints)), MALFORMED, hints.join());
  }
  assert.deepEqual(parseReconnectCode(codeWith(['[fe80::1]:4242', '203.0.113.9:4242'])).hints, ['203.0.113.9:4242']);
  for (const answers of [[{ address: '127.0.0.1' }], [{ address: 'fe80::1' }], [{ address: '::ffff:127.0.0.1' }]]) {
    assert.deepEqual(await resolveHostName(NAME, { lookup: async () => answers }), { ok: false, reason: 'host_name_unresolved' },
      answers[0].address);
  }
  const mixed = await resolveHostName(NAME, { lookup: async () => [{ address: '127.0.0.1' }, { address: '203.0.113.9' }] });
  assert.deepEqual(mixed, { ok: true, addresses: ['203.0.113.9:4242'] });
});

// Slice 5-3 review item 9a. Fault: every caller starting its own lookup, so a resolver that hangs fills
// the thread pool main's file work shares.
test('one lookup in flight per name: ten callers during a lookup that never answers call lookup once', async () => {
  let calls = 0;
  const lookup = () => { calls += 1; return new Promise(() => {}); };
  // A plain wrapper (no unref), so the pending lookup keeps this test's event loop alive.
  const timers = { setTimeout: (fn, ms) => ({ id: setTimeout(fn, ms) }), clearTimeout: (handle) => clearTimeout(handle.id) };
  const answers = await Promise.all(Array.from({ length: 10 }, () => resolveHostName(NAME, { lookup, timeoutMs: 20, timers })));
  assert.equal(calls, 1);
  assert.ok(answers.every((answer) => answer.reason === 'host_name_unresolved'), 'each caller has its own timeout');
});
