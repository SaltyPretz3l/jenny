'use strict';

// The team.* commands that travel through POST /api/v1/commands, tested through
// a real router over a real member store.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const { command, createFixture: createRouterFixture } = require('../helpers/command-router-fixture');
const { parseInvite } = require('../../server/team/invites');
const { createRateLimiter } = require('../../server/team/rate-limit');
const { createTeamCommandsFixture } = require('./helpers/team-commands-fixture');
const { createTeamHostFixture, randomKey } = require('./helpers/team-host-fixture');

const FORBIDDEN = 'CMP-HOST-0003';

const fingerprintOf = (key) => crypto.createHash('sha256').update(Buffer.from(key, 'base64url'))
  .digest('hex').slice(0, 10);

test('the owner sees pending and active members with device fingerprints; a member sees neither', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice, rae, pat } = f.seats;

  const asOwner = await f.send(owner, 'team.members.list');
  assert.equal(asOwner.ok, true);
  assert.deepEqual(asOwner.team, { team_id: f.store.teamId(), name: 'Atelier' });
  assert.deepEqual(asOwner.members.map((member) => [member.display_name, member.role, member.state]), [
    ['Olive Owner', 'owner', 'active'], ['Alice', 'member', 'active'],
    ['Rae', 'read_only', 'active'], ['Pat', 'member', 'pending'],
  ]);
  const patEntry = asOwner.members.find((member) => member.member_id === pat.member_id);
  assert.deepEqual(Object.keys(patEntry), [
    'member_id', 'display_name', 'role', 'state', 'created_at', 'admitted_at', 'devices']);
  assert.equal(patEntry.admitted_at, null);
  assert.deepEqual(patEntry.devices, [{
    device_id: pat.device_id, label: 'Laptop', state: 'active', fingerprint: fingerprintOf(pat.key),
    created_at: f.fx.clock(), last_seen_at: null,
  }]);
  assert.match(patEntry.devices[0].fingerprint, /^[0-9a-f]{10}$/u);

  const asMember = await f.send(alice, 'team.members.list');
  assert.deepEqual(asMember.members, [
    { member_id: owner.member_id, display_name: 'Olive Owner', role: 'owner', state: 'active' },
    { member_id: alice.member_id, display_name: 'Alice', role: 'member', state: 'active' },
    { member_id: rae.member_id, display_name: 'Rae', role: 'read_only', state: 'active' },
  ]);
  assert.equal(JSON.stringify(asMember).includes('devices'), false);
  assert.equal(JSON.stringify(asMember).includes(pat.member_id), false);
  assert.deepEqual((await f.send(rae, 'team.members.list')).members, asMember.members);
});

// ------------------------------------------------------------------ matrix

// Who may send each operation (O owner, M member, R read-only); pending never.
const MATRIX = [
  ['team.members.list', 'OMR', () => ({})],
  ['team.invite.create', 'O', () => ({ role: 'member' })],
  ['team.invite.reveal', 'O', (c) => ({ invite_id: c.revealable })],
  ['team.invite.revoke', 'O', (c) => ({ invite_id: c.revocable })],
  ['team.invite.list', 'O', () => ({})],
  ['team.device.invite', 'OMR', () => ({})],
  ['team.device.list', 'OMR', () => ({})],
  ['team.device.revoke', 'OMR', (c, seat) => ({ device_id: c.spare[seat] })],
  ['team.member.admit', 'O', (c) => ({ member_id: c.quinn.member_id })],
  ['team.member.setRole', 'O', (c) => ({ member_id: c.bob.member_id, role: 'read_only' })],
  ['team.member.revoke', 'O', (c) => ({ member_id: c.carl.member_id })],
  ['team.audit.read', 'O', () => ({})],
  ['team.rename', 'O', () => ({ name: 'Renamed Studio' })],
  // Last: the owner seat hands ownership to Dana and is a member afterwards.
  ['team.owner.transfer', 'O', (c) => ({ member_id: c.dana.member_id })],
];

test('every team operation gives each seat exactly the outcome the table promises', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice, rae, pat } = f.seats;
  const created = await f.invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const other = await f.invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member' });
  const context = {
    revealable: created.invite_id,
    revocable: other.invite_id,
    bob: await f.join('Bob'),
    carl: await f.join('Carl'),
    quinn: await f.join('Quinn', { admit: false }),
    dana: await f.join('Dana'),
    spare: {
      owner: (await f.spareDevice(owner)).device_id,
      alice: (await f.spareDevice(alice)).device_id,
      rae: (await f.spareDevice(rae)).device_id,
      pat: pat.device_id,
    },
  };
  const letters = { owner: 'O', alice: 'M', rae: 'R', pat: 'P' };
  const outcomes = [];
  for (const [seatName, letter] of Object.entries(letters)) {
    for (const [operation, who, params] of MATRIX) {
      const answer = await f.send(f.seats[seatName], operation, params(context, seatName));
      let expected = 'role_forbidden';
      if (who.includes(letter)) expected = 'ok';
      else if (letter === 'P') expected = 'member_pending';
      assert.equal(f.reasonOf(answer), expected, `${seatName} ${operation}`);
      if (!answer.ok) {
        assert.equal(answer.error.code, FORBIDDEN, `${seatName} ${operation}`);
        assert.match(answer.error.request_id, /^request_\d+$/u);
      }
      outcomes.push(`${seatName} ${operation} ${expected}`);
    }
  }
  assert.equal(outcomes.length, 4 * MATRIX.length);
  // Owner: all 14. Member and read-only: members.list, device.invite, device.list, device.revoke.
  assert.equal(outcomes.filter((line) => line.endsWith(' ok')).length, 14 + 4 + 4);
});

// ----------------------------------------------------------------- invites

test('an invite is created, listed, revealed once and revoked; its string carries the address hints', async (t) => {
  const addresses = ['203.0.113.7:4455', 'not-an-address', '[2001:db8::1]:5000', '198.51.100.2:9',
    '192.0.2.44:1000', '10.0.0.5:5000'];
  const f = await createTeamCommandsFixture(t, { addresses });
  const { owner } = f.seats;
  const created = await f.send(owner, 'team.invite.create', { role: 'read_only', ttl_ms: 3_600_000 });
  assert.deepEqual(created, { ok: true, invite_id: created.invite_id, expires_at: f.fx.clock() + 3_600_000 });
  assert.match(created.invite_id, /^invite_/u);

  const listed = await f.send(owner, 'team.invite.list');
  assert.deepEqual(listed, { ok: true, invites: [{
    invite_id: created.invite_id, kind: 'new_member', role: 'read_only', member_id: null,
    created_at: f.fx.clock(), expires_at: created.expires_at,
  }] });

  const revealed = await f.send(owner, 'team.invite.reveal', { invite_id: created.invite_id });
  assert.deepEqual(Object.keys(revealed), ['ok', 'invite']);
  const parsed = parseInvite(revealed.invite);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host_public_key, f.fx.hostKey);
  assert.deepEqual(parsed.hints, ['203.0.113.7:4455', '[2001:db8::1]:5000', '198.51.100.2:9', '192.0.2.44:1000']);

  const again = await f.send(owner, 'team.invite.reveal', { invite_id: created.invite_id });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, FORBIDDEN);
  assert.equal(again.error.reason, 'invite_not_valid');

  assert.deepEqual(await f.send(owner, 'team.invite.revoke', { invite_id: created.invite_id }), { ok: true });
  assert.deepEqual((await f.send(owner, 'team.invite.list')).invites, []);
  assert.equal(f.reasonOf(await f.send(owner, 'team.invite.revoke', { invite_id: created.invite_id })), 'invite_not_valid');
  assert.equal(f.reasonOf(await f.send(owner, 'team.invite.reveal', { invite_id: 'invite_unknown' })), 'invite_not_valid');
});

test('an invite lifetime outside the bounds is refused; a new member invite uses the default lifetime', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner } = f.seats;
  const byDefault = await f.send(owner, 'team.invite.create', { role: 'member' });
  assert.equal(byDefault.expires_at, f.fx.clock() + 24 * 60 * 60 * 1000);
  for (const ttl of [59_999, 604_800_001, 1.5, '3600000']) {
    const refused = await f.send(owner, 'team.invite.create', { role: 'member', ttl_ms: ttl });
    assert.equal(refused.error.reason, 'invalid_command_parameters', String(ttl));
  }
  assert.equal((await f.send(owner, 'team.invite.create', { role: 'member', ttl_ms: 60_000 })).expires_at,
    f.fx.clock() + 60_000);
  assert.equal((await f.send(owner, 'team.invite.create', { role: 'member', ttl_ms: 604_800_000 })).expires_at,
    f.fx.clock() + 604_800_000);
});

test('an exact retry of team.invite.create returns the first answer and creates no second invite', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner } = f.seats;
  const cmd = command(owner.auth, 'team.invite.create', { role: 'member' });
  const first = await f.dispatch(owner, cmd);
  const second = await f.dispatch(owner, cmd);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.deepEqual((await f.send(owner, 'team.invite.list')).invites.map((invite) => invite.invite_id),
    [first.invite_id]);
  const changed = await f.dispatch(owner, { ...cmd, params: { role: 'read_only' } });
  assert.equal(changed.error.reason, 'request_payload_changed');
  assert.equal((await f.send(owner, 'team.invite.list')).invites.length, 1);
});

test('no invite string reaches command-receipts.json', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice } = f.seats;
  const created = await f.send(owner, 'team.invite.create', { role: 'member' });
  const revealed = await f.send(owner, 'team.invite.reveal', { invite_id: created.invite_id });
  const device = await f.send(alice, 'team.device.invite');
  assert.equal(device.ok, true);
  const receipts = f.receiptsText();
  assert.equal(receipts.includes(created.invite_id), true, 'the create was receipted');
  assert.equal(receipts.includes(revealed.invite), false);
  assert.equal(receipts.includes(device.invite), false);
  assert.equal(receipts.includes('jteam1_'), false);
});

// ---------------------------------------------------- admit, role, revoke

test('admit, set role and revoke change the store and fire one membership event each', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner } = f.seats;
  const events = [];
  f.store.onMembershipChange((event) => events.push([event.kind, event.member_id, [...event.device_ids]]));
  const quinn = await f.join('Quinn', { admit: false });

  const admit = command(owner.auth, 'team.member.admit', { member_id: quinn.member_id });
  assert.deepEqual(await f.dispatch(owner, admit), { ok: true, member_id: quinn.member_id, state: 'active' });
  assert.equal(f.store.getMember(quinn.member_id).state, 'active');
  assert.deepEqual(events, [['admitted', quinn.member_id, [quinn.device_id]]]);
  // An exact retry answers from the receipt and fires nothing.
  assert.deepEqual(await f.dispatch(owner, admit), { ok: true, member_id: quinn.member_id, state: 'active' });
  assert.equal(events.length, 1);
  assert.equal(f.reasonOf(await f.send(owner, 'team.member.admit', { member_id: quinn.member_id })),
    'team_member_state_invalid');
  assert.equal(f.reasonOf(await f.send(owner, 'team.member.admit', { member_id: 'member_unknown' })), 'team_not_found');

  assert.deepEqual(await f.send(owner, 'team.member.setRole', { member_id: quinn.member_id, role: 'read_only' }),
    { ok: true, member_id: quinn.member_id, role: 'read_only' });
  assert.equal(f.store.getMember(quinn.member_id).role, 'read_only');
  assert.deepEqual(events[1], ['role_changed', quinn.member_id, [quinn.device_id]]);

  assert.deepEqual(await f.send(owner, 'team.member.revoke', { member_id: quinn.member_id }), { ok: true });
  assert.equal(f.store.getMember(quinn.member_id).state, 'revoked');
  assert.deepEqual(events[2], ['member_revoked', quinn.member_id, [quinn.device_id]]);
  assert.equal(events.length, 3);
  const roster = await f.send(owner, 'team.members.list');
  assert.equal(roster.members.some((member) => member.member_id === quinn.member_id), false);
});

test('the owner cannot be revoked or have the role changed; the store says why', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner } = f.seats;
  const events = [];
  f.store.onMembershipChange((event) => events.push(event.kind));
  const revoke = await f.send(owner, 'team.member.revoke', { member_id: owner.member_id });
  assert.equal(revoke.ok, false);
  assert.equal(revoke.error.code, 'CMP-HOST-0004');
  assert.equal(revoke.error.reason, 'team_last_owner');
  assert.equal(f.reasonOf(await f.send(owner, 'team.member.setRole', { member_id: owner.member_id, role: 'member' })),
    'team_last_owner');
  assert.equal(f.store.getMember(owner.member_id).state, 'active');
  assert.deepEqual(events, []);
});

// ------------------------------------------------------------------ rename

test('the owner renames the team; the roster shows it, the audit log holds one entry, the store advances once', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice } = f.seats;
  const revOf = () => JSON.parse(fs.readFileSync(f.fx.memberFile, 'utf8')).rev;
  const before = revOf();
  const events = [];
  f.store.onMembershipChange((event) => events.push(event.kind));

  assert.deepEqual(await f.send(owner, 'team.rename', { name: 'Quiet Harbor' }), { ok: true });
  assert.equal((await f.send(owner, 'team.members.list')).team.name, 'Quiet Harbor');
  assert.equal((await f.send(alice, 'team.members.list')).team.name, 'Quiet Harbor');
  assert.equal(revOf(), before + 1);
  assert.deepEqual(events, []);
  const entries = f.store.audit.read({}).entries.filter((entry) => entry.kind === 'team_renamed');
  assert.deepEqual(entries.map((entry) => [entry.actor_member_id, entry.subject_member_id, entry.name, entry.detail,
    entry.store_rev, entry.applied]), [[owner.member_id, null, null, null, before + 1, true]]);

  // The same name again is not a write.
  assert.deepEqual(await f.send(owner, 'team.rename', { name: 'Quiet Harbor' }), { ok: true });
  assert.equal(revOf(), before + 1);
  assert.equal(f.store.audit.read({}).entries.filter((entry) => entry.kind === 'team_renamed').length, 1);
});

test('a member cannot rename; a name that is not clean text is team_name_invalid', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice } = f.seats;
  assert.equal(f.reasonOf(await f.send(alice, 'team.rename', { name: 'Mine' })), 'role_forbidden');
  for (const name of ['Harbor‮drah', ' padded', 'x'.repeat(41), 'line\nbreak', '​']) {
    const refused = await f.send(owner, 'team.rename', { name });
    assert.equal(refused.error.code, 'CMP-HOST-0001', JSON.stringify(name));
    assert.equal(refused.error.reason, 'team_name_invalid', JSON.stringify(name));
  }
  assert.equal(f.reasonOf(await f.send(owner, 'team.rename', { name: 'x'.repeat(129) })), 'invalid_command_parameters');
  assert.equal(f.reasonOf(await f.send(owner, 'team.rename', { name: '' })), 'invalid_command_parameters');
  assert.equal(f.store.snapshot().team.name, 'Atelier');
  assert.equal(f.store.audit.read({}).entries.some((entry) => entry.kind === 'team_renamed'), false);
});

// ------------------------------------------------------------------- audit

test('the audit log pages with a cursor and a limit; the owner alone reads it', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice } = f.seats;
  const everything = f.store.audit.read({}).entries;
  assert.ok(everything.length >= 8);

  const first = await f.send(owner, 'team.audit.read', { limit: 3 });
  assert.deepEqual(first.entries, everything.slice(0, 3));
  assert.equal(first.next_cursor, everything[2].seq);
  const collected = [...first.entries];
  let cursor = first.next_cursor;
  while (cursor !== null) {
    const page = await f.send(owner, 'team.audit.read', { cursor, limit: 3 });
    assert.ok(page.entries.length >= 1 && page.entries.length <= 3);
    collected.push(...page.entries);
    cursor = page.next_cursor;
  }
  assert.deepEqual(collected, everything);
  const whole = await f.send(owner, 'team.audit.read');
  assert.deepEqual(whole, { ok: true, entries: everything, next_cursor: null });
  assert.equal(JSON.stringify(whole).includes('jteam1_'), false);

  for (const params of [{ cursor: -1 }, { limit: 0 }, { limit: 101 }, { cursor: 1.5 }, { limit: '3' }]) {
    const refused = await f.send(owner, 'team.audit.read', params);
    assert.equal(refused.error.code, 'CMP-HOST-0001', JSON.stringify(params));
    assert.equal(refused.error.reason, 'invalid_command_parameters', JSON.stringify(params));
  }
  assert.equal(f.reasonOf(await f.send(alice, 'team.audit.read')), 'role_forbidden');
});

// -------------------------------------------------------------- rate limit

test('a member over the limit gets team_rate_limit and the store is not called', async (t) => {
  const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, maxKeys: 8 });
  const f = await createTeamCommandsFixture(t, { limiter });
  const { owner, alice } = f.seats;
  const renames = [];
  const rename = f.store.rename.bind(f.store);
  f.store.rename = (input) => { renames.push(input.name); return rename(input); };

  for (let attempt = 0; attempt < 3; attempt += 1) assert.equal((await f.send(owner, 'team.members.list')).ok, true);
  const limited = await f.send(owner, 'team.rename', { name: 'Fourth' });
  assert.equal(limited.ok, false);
  assert.equal(limited.error.code, 'CMP-HOST-0007');
  assert.equal(limited.error.reason, 'team_rate_limit');
  assert.match(limited.error.request_id, /^request_\d+$/u);
  assert.deepEqual(renames, []);
  assert.equal(f.store.snapshot().team.name, 'Atelier');
  // The count is per member.
  assert.equal((await f.send(alice, 'team.members.list')).ok, true);
});

test('a limiter that refuses everything denies every command', async (t) => {
  const f = await createTeamCommandsFixture(t, { limiter: { take: () => false } });
  for (const [operation, , params] of MATRIX.slice(0, 2)) {
    assert.equal(f.reasonOf(await f.send(f.seats.owner, operation, params({}))), 'team_rate_limit', operation);
  }
});

// ------------------------------------------------------------------ schema

test('every team schema is closed, the transfer schema included', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner } = f.seats;
  const base = {
    'team.members.list': {}, 'team.invite.create': { role: 'member' }, 'team.invite.reveal': { invite_id: 'invite_a' },
    'team.invite.revoke': { invite_id: 'invite_a' }, 'team.invite.list': {}, 'team.device.invite': {},
    'team.device.list': {}, 'team.device.revoke': { device_id: 'device_a' }, 'team.member.admit': { member_id: 'member_a' },
    'team.member.setRole': { member_id: 'member_a', role: 'member' }, 'team.member.revoke': { member_id: 'member_a' },
    'team.audit.read': {}, 'team.rename': { name: 'Harbor' }, 'team.owner.transfer': { member_id: 'member_a' },
  };
  assert.deepEqual(Object.keys(base), MATRIX.map(([operation]) => operation));
  for (const [operation, params] of Object.entries(base)) {
    const refused = await f.send(owner, operation, { ...params, extra: 1 });
    assert.equal(refused.error.code, 'CMP-HOST-0001', operation);
    assert.equal(refused.error.reason, 'invalid_command_parameters', operation);
  }
  const missing = [['team.invite.create', {}], ['team.invite.reveal', {}], ['team.device.revoke', {}],
    ['team.member.admit', {}], ['team.member.setRole', { member_id: 'member_a' }], ['team.rename', {}],
    ['team.owner.transfer', {}]];
  for (const [operation, params] of missing) {
    assert.equal(f.reasonOf(await f.send(owner, operation, params)), 'invalid_command_parameters', operation);
  }
  for (const role of ['owner', 'pending', 'admin', '']) {
    assert.equal(f.reasonOf(await f.send(owner, 'team.member.setRole', { member_id: 'member_a', role })),
      'invalid_command_parameters', role);
    assert.equal(f.reasonOf(await f.send(owner, 'team.invite.create', { role })), 'invalid_command_parameters', role);
  }
  // The transfer is a real operation now: a well-formed call reaches the store.
  const transfer = await f.send(owner, 'team.owner.transfer', { member_id: 'member_a' });
  assert.equal(transfer.error.reason, 'team_not_found');
});

// ------------------------------------------------------------ single owner

test('a router without team commands answers a team operation as unsupported', async (t) => {
  const f = await createTeamCommandsFixture(t, { withTeamCommands: false });
  const answer = await f.send(f.seats.owner, 'team.members.list');
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, 'CMP-HOST-0001');
  assert.equal(answer.error.reason, 'unsupported_operation');

  const single = createRouterFixture();
  t.after(() => single.close());
  const result = await single.router.dispatch(command(single.a, 'team.members.list'), single.contextA);
  assert.equal(result.error.reason, 'unsupported_operation');
});

// ---------------------------------------------------------------- team host

test('the team host gives its router the team commands, the live address hints and the admin rate limit', async (t) => {
  const host = createTeamHostFixture(t);
  const { owner } = await host.seedMembers(randomKey());
  await host.start();
  const ctx = host.context();
  const auth = ctx.clients.register(owner.device_id);
  const send = (operation, params = {}) => ctx.router.dispatch(
    { ...command(auth, operation, params), boot_epoch: ctx.bootEpoch },
    { deviceId: owner.device_id, clientToken: auth.client_token, isAuthenticated: () => true,
      actor: { device_id: owner.device_id } },
  );

  const roster = await send('team.members.list');
  assert.deepEqual(roster.members.map((member) => member.display_name), ['Olive Owner', 'Mika Member']);
  const created = await send('team.invite.create', { role: 'member' });
  const revealed = await send('team.invite.reveal', { invite_id: created.invite_id });
  assert.deepEqual(parseInvite(revealed.invite).hints, ['192.0.2.7:4242', '[2001:db8::7]:4242']);

  // Thirty commands a minute per member: three are spent, 27 more pass, the next is limited.
  for (let used = 4; used <= 30; used += 1) assert.equal((await send('team.invite.list')).ok, true);
  const limited = await send('team.invite.list');
  assert.equal(limited.error.code, 'CMP-HOST-0007');
  assert.equal(limited.error.reason, 'team_rate_limit');
});
