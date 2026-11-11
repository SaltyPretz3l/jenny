'use strict';

// Slice 1h: `team.owner.transfer` through the real router, the real authorizer
// and the real member store (and, for the fan-out, the real team host start).

const assert = require('node:assert/strict');
const test = require('node:test');

const durableJson = require('../../services/host/durable-json');
const { command } = require('../helpers/command-router-fixture');
const { assertOwnerInvariant } = require('./helpers/team-store-fixture');
const { createTeamCommandsFixture } = require('./helpers/team-commands-fixture');
const { createTeamHostFixture } = require('./helpers/team-host-fixture');

const owners = (store) => store.snapshot().members.filter((member) => member.role === 'owner')
  .map((member) => member.member_id);

test('the transfer swaps the two roles and the same connections change sides at once', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice, rae } = f.seats;
  assert.equal(f.reasonOf(await f.send(alice, 'team.invite.list')), 'role_forbidden');

  const moved = await f.send(owner, 'team.owner.transfer', { member_id: alice.member_id });
  assert.deepEqual(moved, { ok: true, member_id: alice.member_id });
  assertOwnerInvariant(assert, f.store);
  assert.deepEqual(owners(f.store), [alice.member_id]);
  assert.equal(f.store.getMember(owner.member_id).role, 'member');
  assert.equal(f.store.getMember(owner.member_id).state, 'active');

  // The same registered clients, the next owner-only command each.
  assert.equal(f.reasonOf(await f.send(owner, 'team.invite.list')), 'role_forbidden');
  assert.equal(f.reasonOf(await f.send(owner, 'team.owner.transfer', { member_id: owner.member_id })), 'role_forbidden');
  assert.equal((await f.send(alice, 'team.invite.list')).ok, true);
  assert.equal(f.reasonOf(await f.send(rae, 'team.invite.list')), 'role_forbidden');
  // The old owner is an ordinary member now: member commands still work.
  assert.equal((await f.send(owner, 'team.members.list')).ok, true);

  // And back again, by the new owner.
  assert.equal((await f.send(alice, 'team.owner.transfer', { member_id: owner.member_id })).ok, true);
  assert.deepEqual(owners(f.store), [owner.member_id]);
});

test('member, read-only and pending callers are refused before the store is asked', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice, rae, pat } = f.seats;
  const before = f.store.rev();
  // The store repeats the owner rule, so only a spy shows the router refused first.
  let storeCalls = 0;
  const original = f.store.transferOwner.bind(f.store);
  f.store.transferOwner = (input) => { storeCalls += 1; return original(input); };
  assert.equal(f.reasonOf(await f.send(alice, 'team.owner.transfer', { member_id: alice.member_id })), 'role_forbidden');
  assert.equal(f.reasonOf(await f.send(rae, 'team.owner.transfer', { member_id: rae.member_id })), 'role_forbidden');
  assert.equal(f.reasonOf(await f.send(pat, 'team.owner.transfer', { member_id: pat.member_id })), 'member_pending');
  assert.equal(f.store.rev(), before, 'nothing was committed');
  assert.equal(storeCalls, 0, 'the router refused before the store was asked');
  assert.deepEqual(owners(f.store), [owner.member_id]);
  assert.equal((await f.send(owner, 'team.owner.transfer', { member_id: alice.member_id })).ok, true);
  assert.equal(storeCalls, 1, 'the spy sees an allowed call');
});

test('a target with no active device is refused, so ownership never moves to someone who cannot sign in', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice } = f.seats;
  assert.equal((await f.send(alice, 'team.device.revoke', { device_id: alice.device_id })).ok, true);
  assert.equal(f.store.getMember(alice.member_id).state, 'active');
  const before = f.store.rev();
  const answer = await f.send(owner, 'team.owner.transfer', { member_id: alice.member_id });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.code, 'CMP-HOST-0004');
  assert.equal(answer.error.reason, 'team_member_state_invalid');
  assert.equal(f.store.rev(), before, 'nothing was committed');
  assert.deepEqual(owners(f.store), [owner.member_id]);
  assert.equal(f.store.audit.read({ limit: 100 }).entries.some((entry) => entry.kind === 'owner_transferred'), false);
});

test('an unknown, pending, revoked or own target is refused with the store reason and changes nothing', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, pat } = f.seats;
  const gone = await f.join('Gwen');
  assert.equal((await f.send(owner, 'team.member.revoke', { member_id: gone.member_id })).ok, true);
  const before = f.store.rev();
  const cases = [
    ['member_unknown_1', 'CMP-HOST-0003', 'team_not_found'],
    [pat.member_id, 'CMP-HOST-0004', 'team_member_state_invalid'],
    [gone.member_id, 'CMP-HOST-0004', 'team_member_state_invalid'],
    [owner.member_id, 'CMP-HOST-0004', 'team_member_state_invalid'],
  ];
  for (const [memberId, code, reason] of cases) {
    const answer = await f.send(owner, 'team.owner.transfer', { member_id: memberId });
    assert.equal(answer.ok, false, memberId);
    assert.equal(answer.error.code, code, memberId);
    assert.equal(answer.error.reason, reason, memberId);
    assert.match(answer.error.request_id, /^request_\d+$/u);
  }
  assert.equal(f.store.rev(), before);
  assert.deepEqual(owners(f.store), [owner.member_id]);
});

test('the schema is closed: a missing or extra field is invalid parameters', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice } = f.seats;
  for (const params of [{}, { member_id: alice.member_id, extra: 1 }, { member_id: '' }, { member_id: 'a b' }]) {
    assert.equal(f.reasonOf(await f.send(owner, 'team.owner.transfer', params)), 'invalid_command_parameters');
  }
  assert.deepEqual(owners(f.store), [owner.member_id]);
});

test('an exact retry never swaps back: the demoted caller is refused by the router and the store is unchanged', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice, pat } = f.seats;

  // A refused transfer: the retry answers from the receipt.
  const refusedCmd = command(owner.auth, 'team.owner.transfer', { member_id: pat.member_id });
  const refused = await f.dispatch(owner, refusedCmd);
  assert.deepEqual(await f.dispatch(owner, refusedCmd), refused);

  const cmd = command(owner.auth, 'team.owner.transfer', { member_id: alice.member_id });
  const first = await f.dispatch(owner, cmd);
  assert.equal(first.ok, true);
  const rev = f.store.rev();
  // The router's identity step runs before the receipt lookup, and the caller
  // is no longer the owner (see "1h as built").
  const retry = await f.dispatch(owner, cmd);
  assert.equal(f.reasonOf(retry), 'role_forbidden');
  assert.equal(f.store.rev(), rev, 'the retry committed nothing');
  assert.deepEqual(owners(f.store), [alice.member_id]);
  const audit = f.store.audit.read({ limit: 100 }).entries.filter((entry) => entry.kind === 'owner_transferred');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_member_id, owner.member_id);
  assert.equal(audit[0].subject_member_id, alice.member_id);
  assert.equal(audit[0].applied, true);
});

test('a crash between the audit write and the document write leaves the old owner and an unapplied entry', async (t) => {
  let crashNext = false;
  const writeJson = (filePath, value) => {
    if (crashNext && filePath.endsWith('team-members.json')) {
      crashNext = false;
      throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
    }
    return durableJson.writeJson(filePath, value);
  };
  const f = await createTeamCommandsFixture(t, { storeOverrides: { writeJson } });
  const { owner, alice } = f.seats;
  crashNext = true;
  const answer = await f.send(owner, 'team.owner.transfer', { member_id: alice.member_id });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_store_failed');
  assert.equal(f.store.snapshot(), null, 'the store fails closed until restart');

  const reopened = f.fx.openStore();
  assertOwnerInvariant(assert, reopened);
  assert.deepEqual(owners(reopened), [owner.member_id]);
  assert.equal(reopened.getMember(alice.member_id).role, 'member');
  const entries = reopened.audit.read({ limit: 100 }).entries.filter((entry) => entry.kind === 'owner_transferred');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].applied, false);
  assert.equal(entries[0].store_rev, reopened.rev() + 1);
});

test('a recovery invite minted before the transfer no longer redeems', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice } = f.seats;
  const minted = await f.invites.create({ kind: 'recovery' });
  assert.equal(minted.ok, true);
  assert.equal((await f.send(owner, 'team.owner.transfer', { member_id: alice.member_id })).ok, true);
  const redeemed = await f.invites.redeem({ inviteId: minted.invite_id, devicePublicKey: f.fx.nextKey('recovered'),
    displayName: 'ignored', label: 'New laptop' });
  assert.equal(redeemed.ok, false);
  assert.equal(redeemed.error.reason, 'invite_not_valid');
  assert.deepEqual(owners(f.store), [alice.member_id]);
  assert.equal(f.store.listDevices(owner.member_id).filter((device) => device.state === 'active').length, 1);
});

test('no display name reaches a log line', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice } = f.seats;
  await f.send(owner, 'team.owner.transfer', { member_id: alice.member_id });
  await f.send(owner, 'team.owner.transfer', { member_id: alice.member_id });
  const text = JSON.stringify(f.fx.logs);
  assert.equal(f.fx.logs.some((entry) => entry.event === 'team_command.answered'
    && entry.fields.operation === 'team.owner.transfer'), true);
  for (const name of ['Olive Owner', 'Alice', 'Rae', 'Pat', 'Atelier']) assert.equal(text.includes(name), false, name);
});

test('the team host fan-out sees one owner_transferred event and revokes nobody', async (t) => {
  const fx = createTeamHostFixture(t);
  const client = fx.client();
  const { owner, member } = await fx.seedMembers(client.deviceKey);
  const parent = fx.newParent();
  await fx.start(parent);
  const ctx = fx.context();
  const events = [];
  ctx.store.onMembershipChange((event) => events.push(event));
  const ownerAuth = ctx.clients.register(owner.device_id);
  ctx.clients.register(member.device_id);
  const send = (operation, params) => ctx.router.dispatch(
    { ...command(ownerAuth, operation, params), boot_epoch: ctx.bootEpoch },
    { deviceId: owner.device_id, clientToken: ownerAuth.client_token, isAuthenticated: () => true,
      actor: { device_id: owner.device_id } },
  );
  const answer = await send('team.owner.transfer', { member_id: member.member_id });
  assert.deepEqual(answer, { ok: true, member_id: member.member_id });
  assert.deepEqual(events.map((event) => event.kind), ['owner_transferred']);
  assert.equal(events[0].member_id, member.member_id);
  assert.deepEqual([...events[0].device_ids].sort(), [owner.device_id, member.device_id].sort());
  assert.deepEqual(parent.sent.filter((message) => message.type === 'membership_changed'),
    [{ type: 'membership_changed', kind: 'owner_transferred', member_id: member.member_id }]);
  assert.equal(ctx.clients.clients.size, 2, 'a transfer closes no client');
  assert.equal(ctx.directory.isDegraded(), false);
  assert.equal(ctx.directory.liveActor(member.device_id).role, 'owner');
  assert.equal(ctx.directory.liveActor(owner.device_id).role, 'member');
  assert.equal(fx.logText().includes('Olive'), false);
  assert.equal(fx.logText().includes('Mika'), false);
});
