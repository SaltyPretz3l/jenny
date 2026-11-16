'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { createFixture, assertOwnerInvariant } = require('./helpers/team-store-fixture');
const { LOCAL_COMMAND } = require('../../server/team/member-schema');

function failureOf(result) {
  assert.equal(result.ok, false, 'expected a failure');
  return result.error;
}

// ---------------------------------------------------------------- invariant

test('an empty store has no members, no owner and writes no file until the first mutation', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  assert.equal(store.rev(), 0);
  assert.equal(store.snapshot().members.length, 0);
  assert.equal(fs.existsSync(fx.memberFile), false);
  assertOwnerInvariant(assert, store);
  assert.match(store.teamId(), /^team_[A-Za-z0-9_-]{22}$/u);
});

test('the first owner is created active by the owner invite on an empty store', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  assertOwnerInvariant(assert, store);
  const member = store.getMember(owner.member_id);
  assert.equal(member.role, 'owner');
  assert.equal(member.state, 'active');
  assert.match(owner.member_id, /^member_[A-Za-z0-9_-]{22}$/u);
  assert.match(owner.device_id, /^device_[A-Za-z0-9_-]{22}$/u);
  assert.deepEqual(store.directory.resolveActor(owner.key), {
    member_id: owner.member_id, device_id: owner.device_id, role: 'owner', state: 'active',
  });
  const onDisk = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  assert.equal(onDisk.schema_version, 4);
  assert.equal(onDisk.rev, store.rev());
  assert.equal(onDisk.members.length, 1);
});

test('rev is monotonic and bumps once per committed mutation', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const revs = [store.rev()];
  const owner = await fx.bootstrapOwner(store);
  revs.push(store.rev());
  const member = await fx.joinMember(store, owner.member_id, { admit: false });
  revs.push(store.rev());
  await store.admit({ actorMemberId: owner.member_id, memberId: member.member_id });
  revs.push(store.rev());
  const refused = await store.admit({ actorMemberId: owner.member_id, memberId: member.member_id });
  assert.equal(refused.ok, false);
  revs.push(store.rev());
  for (let index = 1; index < revs.length - 1; index += 1) assert.ok(revs[index] > revs[index - 1]);
  assert.equal(revs.at(-1), revs.at(-2), 'a refused mutation does not bump rev');
});

test('an owner invite for a new member is valid only while the store holds zero members', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const early = await store.createInvite({
    kind: 'owner_first', actorMemberId: LOCAL_COMMAND, invitePublicKey: fx.nextKey(),
  });
  assert.equal(early.ok, true);
  const owner = await fx.bootstrapOwner(store);
  // The earlier unused owner invite is dead the moment a member exists.
  const redeem = await store.redeem({
    inviteId: early.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Intruder', label: 'Box',
  });
  assert.equal(failureOf(redeem).reason, 'invite_not_valid');
  const second = await store.createInvite({
    kind: 'owner_first', actorMemberId: LOCAL_COMMAND, invitePublicKey: fx.nextKey(),
  });
  assert.equal(failureOf(second).reason, 'team_member_state_invalid');
  assertOwnerInvariant(assert, store);
  assert.equal(store.snapshot().members.length, 1);
  assert.ok(owner.member_id);
});

// -------------------------------------------------------------- transitions

test('redeem of a new-member invite creates a pending member with an active device', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id, { admit: false, displayName: 'Mina' });
  const member = store.getMember(joined.member_id);
  assert.equal(member.state, 'pending');
  assert.equal(member.role, 'member');
  assert.equal(member.admitted_at, null);
  assert.deepEqual(store.directory.resolveActor(joined.key), {
    member_id: joined.member_id, device_id: joined.device_id, role: 'member', state: 'pending',
  });
  assertOwnerInvariant(assert, store);
});

test('admit moves pending to active and emits one admitted event', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const events = [];
  store.onMembershipChange((event) => events.push(event));
  const joined = await fx.joinMember(store, owner.member_id, { admit: false });
  assert.deepEqual(events, [], 'a pending redeem is not a membership event');
  const admitted = await store.admit({ actorMemberId: owner.member_id, memberId: joined.member_id });
  assert.equal(admitted.ok, true);
  const member = store.getMember(joined.member_id);
  assert.equal(member.state, 'active');
  assert.equal(member.admitted_by, owner.member_id);
  assert.equal(member.admitted_at, fx.clock());
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'admitted');
  assert.equal(events[0].member_id, joined.member_id);
  assert.deepEqual(events[0].device_ids, [joined.device_id]);
  assert.equal(events[0].at, fx.clock());
  assertOwnerInvariant(assert, store);
});

test('admit refuses an active, a revoked and an unknown member', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const active = await fx.joinMember(store, owner.member_id);
  const gone = await fx.joinMember(store, owner.member_id);
  await store.revokeMember({ actorMemberId: owner.member_id, memberId: gone.member_id });
  assert.equal(failureOf(await store.admit({ actorMemberId: owner.member_id, memberId: active.member_id })).reason,
    'team_member_state_invalid');
  assert.equal(failureOf(await store.admit({ actorMemberId: owner.member_id, memberId: gone.member_id })).reason,
    'team_member_state_invalid');
  assert.equal(failureOf(await store.admit({ actorMemberId: owner.member_id, memberId: 'member_unknown' })).reason,
    'team_not_found');
});

test('setRole changes an active member and emits role_changed; the owner role is not assignable', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const events = [];
  store.onMembershipChange((event) => events.push(event));
  const changed = await store.setRole({ actorMemberId: owner.member_id, memberId: joined.member_id, role: 'read_only' });
  assert.equal(changed.ok, true);
  assert.equal(store.getMember(joined.member_id).role, 'read_only');
  assert.equal(store.directory.liveActor(joined.device_id).role, 'read_only');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'role_changed');
  assert.equal(events[0].role, 'read_only');

  assert.equal(failureOf(await store.setRole({
    actorMemberId: owner.member_id, memberId: joined.member_id, role: 'owner',
  })).reason, 'team_role_invalid');
  assert.equal(failureOf(await store.setRole({
    actorMemberId: owner.member_id, memberId: joined.member_id, role: 'admin',
  })).reason, 'team_role_invalid');
  assert.equal(failureOf(await store.setRole({
    actorMemberId: owner.member_id, memberId: owner.member_id, role: 'member',
  })).reason, 'team_last_owner');
  assert.equal(events.length, 1, 'refused changes emit nothing');
  assertOwnerInvariant(assert, store);
});

test('setRole refuses a pending or revoked member', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const pending = await fx.joinMember(store, owner.member_id, { admit: false });
  assert.equal(failureOf(await store.setRole({
    actorMemberId: owner.member_id, memberId: pending.member_id, role: 'read_only',
  })).reason, 'team_member_state_invalid');
  await store.revokeMember({ actorMemberId: owner.member_id, memberId: pending.member_id });
  assert.equal(failureOf(await store.setRole({
    actorMemberId: owner.member_id, memberId: pending.member_id, role: 'read_only',
  })).reason, 'team_member_state_invalid');
});

test('revokeMember rejects a pending member and revokes an active one with all keys dropped', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const active = await fx.joinMember(store, owner.member_id);
  const second = await fx.addDevice(store, active.member_id);
  assert.equal(second.ok, true);
  const pending = await fx.joinMember(store, owner.member_id, { admit: false });
  const events = [];
  store.onMembershipChange((event) => events.push(event));

  assert.equal((await store.revokeMember({ actorMemberId: owner.member_id, memberId: pending.member_id })).ok, true);
  assert.equal(store.directory.resolveActor(pending.key), null);
  assert.equal((await store.revokeMember({ actorMemberId: owner.member_id, memberId: active.member_id })).ok, true);
  assert.equal(store.directory.resolveActor(active.key), null);
  assert.equal(store.directory.resolveActor(second.key), null);
  assert.equal(store.directory.isDeviceActive(active.device_id), false);
  assert.equal(store.directory.liveActor(second.device_id), null);

  const member = store.getMember(active.member_id);
  assert.equal(member.state, 'revoked');
  assert.equal(member.revoked_by, owner.member_id);
  assert.deepEqual(events.map((event) => event.kind), ['member_revoked', 'member_revoked']);
  assert.deepEqual([...events[1].device_ids].sort(), [active.device_id, second.device_id].sort());
  assertOwnerInvariant(assert, store);
});

// Two-PC run 3: a removed person comes back on a new invite, as a new member under their old name.
test('a removed member rejoins with a new invite and a new device key as a new pending member', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const gone = await fx.joinMember(store, owner.member_id, { displayName: 'Mika' });
  assert.equal((await store.revokeMember({ actorMemberId: owner.member_id, memberId: gone.member_id })).ok, true);
  const invite = () => store.createInvite({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member',
    invitePublicKey: fx.nextKey('invite') });
  // The revoked device's key is refused, so the removed PC must bring a new one.
  const first = await invite();
  const oldKey = await store.redeem({ inviteId: first.invite_id, devicePublicKey: gone.key, displayName: 'Mika', label: 'Laptop' });
  assert.equal(oldKey.ok, false);
  const key = fx.nextKey('device');
  const second = await invite();
  const back = await store.redeem({ inviteId: second.invite_id, devicePublicKey: key, displayName: 'Mika', label: 'Laptop' });
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.notEqual(back.member_id, gone.member_id);
  assert.equal(store.getMember(back.member_id).state, 'pending');
  assert.equal(store.getMember(gone.member_id).state, 'revoked', 'the old record stays revoked');
  assert.equal(store.directory.admitKind(gone.key), null, 'the revoked key still cannot connect');
  assert.equal((await store.admit({ actorMemberId: owner.member_id, memberId: back.member_id })).ok, true);
  assert.equal(store.directory.admitKind(key), 'device');
  assert.equal(store.directory.resolveActor(key).state, 'active');
  assertOwnerInvariant(assert, store);
});

test('a revoked member cannot be revoked, admitted or changed again: revoked is terminal', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  await store.revokeMember({ actorMemberId: owner.member_id, memberId: joined.member_id });
  const before = store.rev();
  assert.equal(failureOf(await store.revokeMember({
    actorMemberId: owner.member_id, memberId: joined.member_id,
  })).reason, 'team_member_state_invalid');
  assert.equal(failureOf(await store.leave({ memberId: joined.member_id })).reason, 'team_member_state_invalid');
  assert.equal(store.rev(), before);
  // A removed person joins again as a new member through a new invite.
  const again = await fx.joinMember(store, owner.member_id, { displayName: 'Same Person' });
  assert.notEqual(again.member_id, joined.member_id);
});

test('the owner cannot be revoked (team_last_owner) or leave (team_owner_transfer_required)', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  assert.equal(failureOf(await store.revokeMember({
    actorMemberId: owner.member_id, memberId: owner.member_id,
  })).reason, 'team_last_owner');
  assert.equal(failureOf(await store.leave({ memberId: owner.member_id })).reason, 'team_owner_transfer_required');
  assert.equal(store.getMember(owner.member_id).state, 'active');
  assertOwnerInvariant(assert, store);
});

test('leave: an active or pending member revokes themselves and records it', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const active = await fx.joinMember(store, owner.member_id);
  const pending = await fx.joinMember(store, owner.member_id, { admit: false });
  const events = [];
  store.onMembershipChange((event) => events.push(event));
  assert.equal((await store.leave({ memberId: active.member_id })).ok, true);
  assert.equal((await store.leave({ memberId: pending.member_id })).ok, true);
  assert.equal(store.getMember(active.member_id).revoked_by, active.member_id);
  assert.equal(store.directory.resolveActor(active.key), null);
  assert.equal(store.directory.resolveActor(pending.key), null);
  assert.deepEqual(events.map((event) => event.kind), ['member_revoked', 'member_revoked']);
  assert.equal(failureOf(await store.leave({ memberId: 'member_nobody' })).reason, 'team_not_found');
});

test('revokeDevice drops one device; the member keeps the others; double revoke is refused', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const phone = await fx.addDevice(store, joined.member_id);
  const events = [];
  store.onMembershipChange((event) => events.push(event));
  assert.equal((await store.revokeDevice({ actorMemberId: joined.member_id, deviceId: phone.device_id })).ok, true);
  assert.equal(store.directory.resolveActor(phone.key), null);
  assert.ok(store.directory.resolveActor(joined.key));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'device_revoked');
  assert.deepEqual(events[0].device_ids, [phone.device_id]);
  assert.equal(failureOf(await store.revokeDevice({
    actorMemberId: joined.member_id, deviceId: phone.device_id,
  })).reason, 'team_member_state_invalid');
  assert.equal(failureOf(await store.revokeDevice({
    actorMemberId: owner.member_id, deviceId: 'device_nope',
  })).reason, 'team_not_found');
  assertOwnerInvariant(assert, store);
});

test('owner transfer swaps the two roles atomically and emits one owner_transferred event', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const events = [];
  store.onMembershipChange((event) => events.push(event));
  const before = store.rev();
  const result = await store.transferOwner({ actorMemberId: owner.member_id, memberId: joined.member_id });
  assert.equal(result.ok, true);
  assert.equal(store.rev(), before + 1, 'one mutate');
  assert.equal(store.getMember(joined.member_id).role, 'owner');
  assert.equal(store.getMember(owner.member_id).role, 'member');
  assert.equal(store.directory.liveActor(joined.device_id).role, 'owner');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'owner_transferred');
  assert.equal(events[0].member_id, joined.member_id);
  assert.equal(events[0].role, 'owner');
  assertOwnerInvariant(assert, store);
  // The former owner is no longer the owner and cannot transfer again.
  assert.equal(failureOf(await store.transferOwner({
    actorMemberId: owner.member_id, memberId: joined.member_id,
  })).reason, 'role_forbidden');
  assertOwnerInvariant(assert, store);
});

test('owner transfer refuses a pending, revoked, unknown or self target and keeps one owner', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const pending = await fx.joinMember(store, owner.member_id, { admit: false });
  const gone = await fx.joinMember(store, owner.member_id);
  await store.revokeMember({ actorMemberId: owner.member_id, memberId: gone.member_id });
  for (const memberId of [pending.member_id, gone.member_id, owner.member_id]) {
    assert.equal(failureOf(await store.transferOwner({
      actorMemberId: owner.member_id, memberId,
    })).reason, 'team_member_state_invalid');
    assertOwnerInvariant(assert, store);
  }
  assert.equal(failureOf(await store.transferOwner({
    actorMemberId: owner.member_id, memberId: 'member_unknown',
  })).reason, 'team_not_found');
});

test('add-device redeem adds an active device without touching the member', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const joined = await fx.joinMember(store, owner.member_id);
  const phone = await fx.addDevice(store, joined.member_id, 'Phone');
  assert.equal(phone.ok, true);
  assert.equal(phone.member_id, joined.member_id);
  assert.equal(store.directory.resolveActor(phone.key).state, 'active');
  assert.equal(store.getMember(joined.member_id).state, 'active');
});

test('recovery redeem revokes the owner other devices and adds the new one', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const second = await fx.addDevice(store, owner.member_id, 'Tablet');
  assert.equal(second.ok, true);
  const events = [];
  store.onMembershipChange((event) => events.push(event));
  const minted = await store.createInvite({
    kind: 'recovery', actorMemberId: LOCAL_COMMAND, invitePublicKey: fx.nextKey(),
  });
  assert.equal(minted.ok, true);
  const newKey = fx.nextKey();
  const redeemed = await store.redeem({
    inviteId: minted.invite_id, devicePublicKey: newKey, displayName: 'ignored', label: 'New PC',
  });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.member_id, owner.member_id);
  assert.equal(store.directory.resolveActor(owner.key), null);
  assert.equal(store.directory.resolveActor(second.key), null);
  assert.equal(store.directory.resolveActor(newKey).role, 'owner');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'device_revoked');
  assert.deepEqual([...events[0].device_ids].sort(), [owner.device_id, second.device_id].sort());
  assertOwnerInvariant(assert, store);
  const audit = store.audit.read({ cursor: 0, limit: 100 }).entries.map((entry) => entry.kind);
  assert.ok(audit.includes('recovery_used'));
});

test('recovery invite needs an existing active owner; an add-device invite needs an active member', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  assert.equal(failureOf(await store.createInvite({
    kind: 'recovery', actorMemberId: LOCAL_COMMAND, invitePublicKey: fx.nextKey(),
  })).reason, 'team_member_state_invalid');
  const owner = await fx.bootstrapOwner(store);
  const pending = await fx.joinMember(store, owner.member_id, { admit: false });
  assert.equal(failureOf(await store.createInvite({
    kind: 'add_device', actorMemberId: pending.member_id, invitePublicKey: fx.nextKey(),
  })).reason, 'member_pending');
});

test('a redeem with bad input is refused without burning the invite', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const created = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  const attempt = (overrides) => store.redeem({
    inviteId: created.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Rae', label: 'Desk', ...overrides,
  });
  assert.equal(failureOf(await attempt({ devicePublicKey: 'short' })).reason, 'team_public_key_invalid');
  assert.equal(failureOf(await attempt({ devicePublicKey: owner.key })).reason, 'team_public_key_invalid');
  assert.equal(failureOf(await attempt({ displayName: '  padded ' })).reason, 'team_display_name_invalid');
  assert.equal(failureOf(await attempt({ displayName: 'bad\u0007name' })).reason, 'team_display_name_invalid');
  assert.equal(failureOf(await attempt({ displayName: '' })).reason, 'team_display_name_invalid');
  assert.equal(failureOf(await attempt({ displayName: 'x'.repeat(41) })).reason, 'team_display_name_invalid');
  assert.equal(failureOf(await attempt({ label: '' })).reason, 'team_label_invalid');
  assert.equal(failureOf(await attempt({ label: 'y'.repeat(41) })).reason, 'team_label_invalid');
  assert.equal((await attempt({})).ok, true, 'the invite survived every refusal');
});

test('an unknown, used, expired or revoked invite all answer invite_not_valid', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const make = () => store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey(),
  });
  const redeem = (inviteId) => store.redeem({
    inviteId, devicePublicKey: fx.nextKey(), displayName: 'Rae', label: 'Desk',
  });
  const used = await make();
  assert.equal((await redeem(used.invite_id)).ok, true);
  const revoked = await make();
  assert.equal((await store.revokeInvite({ actorMemberId: owner.member_id, inviteId: revoked.invite_id })).ok, true);
  const expiring = await make();
  fx.advance(25 * 60 * 60 * 1000);
  for (const inviteId of [used.invite_id, revoked.invite_id, expiring.invite_id, 'invite_unknown']) {
    assert.equal(failureOf(await redeem(inviteId)).reason, 'invite_not_valid');
  }
});

// ---------------------------------------------------------------- memberActor (slice 3-3)

test('memberActor answers a member id with a fresh role and state that follow each commit', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const active = await fx.joinMember(store, owner.member_id);
  const pending = await fx.joinMember(store, owner.member_id, { admit: false });
  const { directory } = store;
  assert.deepEqual(directory.memberActor(owner.member_id), { member_id: owner.member_id, role: 'owner', state: 'active' });
  assert.deepEqual(directory.memberActor(active.member_id), { member_id: active.member_id, role: 'member', state: 'active' });
  assert.deepEqual(directory.memberActor(pending.member_id),
    { member_id: pending.member_id, role: 'member', state: 'pending' }, 'pending is returned; the caller decides');
  const answer = directory.memberActor(active.member_id);
  answer.role = 'owner';
  answer.state = 'revoked';
  assert.deepEqual(directory.memberActor(active.member_id).role, 'member', 'a fresh object on every call');
  assert.equal((await store.setRole({ actorMemberId: owner.member_id, memberId: active.member_id, role: 'read_only' })).ok, true);
  assert.equal(directory.memberActor(active.member_id).role, 'read_only', 'follows a role change');
  assert.equal((await store.admit({ actorMemberId: owner.member_id, memberId: pending.member_id })).ok, true);
  assert.equal(directory.memberActor(pending.member_id).state, 'active', 'follows a state change');
  assert.equal((await store.revokeMember({ actorMemberId: owner.member_id, memberId: active.member_id })).ok, true);
  assert.equal(directory.memberActor(active.member_id), null, 'a revoked member is null');
  for (const id of ['member_unknown', undefined, null, 42, {}]) assert.equal(directory.memberActor(id), null);
});


// ---------------------------------------------------- ended invite keys (review sweeps, second run)

test('X3b-F01: onInviteKeysEnded hears every invite a commit ends other than by a redeem, once', async (t) => {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const mel = await fx.joinMember(store, owner.member_id, { role: 'read_only' });
  const heard = [];
  const stop = store.onInviteKeysEnded((keys) => heard.push([...keys]));
  const mint = async (actor, kind = 'add_device', ttlMs = undefined) => {
    const invitePublicKey = fx.nextKey('invite');
    const created = await store.createInvite({ kind, actorMemberId: actor, invitePublicKey, ttlMs,
      ...(kind === 'new_member' ? { role: 'member' } : {}) });
    assert.equal(created.ok, true);
    return { ...created, key: invitePublicKey };
  };
  // A revoke by the member who minted it, and by the owner.
  const own = await mint(mel.member_id);
  assert.deepEqual(heard, [], 'a mint ends nothing');
  assert.equal((await store.revokeInvite({ actorMemberId: mel.member_id, inviteId: own.invite_id })).ok, true);
  const owners = await mint(owner.member_id, 'new_member');
  assert.equal((await store.revokeInvite({ actorMemberId: owner.member_id, inviteId: owners.invite_id })).ok, true);
  assert.deepEqual(heard, [[own.key], [owners.key]]);
  // A redeem is not heard: the join route ends that connection after its answer.
  const spent = await mint(owner.member_id, 'new_member');
  assert.equal((await store.redeem({ inviteId: spent.invite_id, devicePublicKey: fx.nextKey(), displayName: 'Rae',
    label: 'Desk' })).ok, true);
  assert.equal(heard.length, 2);
  // An expired invite is heard at the next commit (its prune), and only then.
  const expiring = await mint(owner.member_id, 'new_member', 1000);
  fx.advance(2000);
  // The member revoke cascade: both of Mel's live invites go with Mel, in one call.
  const [first, second] = [await mint(mel.member_id), await mint(mel.member_id)];
  assert.deepEqual(heard.at(-1), [expiring.key]);
  assert.equal((await store.revokeMember({ actorMemberId: owner.member_id, memberId: mel.member_id })).ok, true);
  assert.deepEqual(heard.at(-1).sort(), [first.key, second.key].sort());
  assert.equal(heard.length, 4);
  // A listener that throws is logged without a key and the commit stands; an unsubscribed one hears nothing more.
  stop();
  store.onInviteKeysEnded(() => { throw new Error('boom'); });
  const later = await mint(owner.member_id, 'new_member');
  assert.equal((await store.revokeInvite({ actorMemberId: owner.member_id, inviteId: later.invite_id })).ok, true);
  assert.equal(heard.length, 4);
  assert.equal(store.isInviteLive(later.invite_id), false);
  const failed = fx.logs.filter((entry) => entry.event === 'team_store.invite_listener_failed');
  assert.equal(failed.length, 1);
  assert.equal(JSON.stringify(fx.logs).includes(later.key), false);
});

// ------------------------------------------------------------- schema upgrades

// A store file as an older Jenny wrote it: `edit` turns the current document into that version's.
async function storedDoc(t, edit) {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const live = await store.createInvite({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey('i') });
  const doc = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  edit(doc);
  fs.writeFileSync(fx.memberFile, JSON.stringify(doc, null, 2));
  return { fx, doc, owner, live };
}

const backupsIn = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith('.bak'));
// What schema 4 adds to an older file's invites.
const withRefusals = (doc) => doc.invites.map((invite) => ({ ...invite, name_refusals: 0 }));
const older = (version) => (d) => {
  if (version < 2) delete d.projects;
  if (version < 3) delete d.team.model;
  for (const invite of d.invites) delete invite.name_refusals;
  d.schema_version = version;
};

// Schema 3 (row 123 slice 4e): `team.model`, null for Automatic, gained by an explicit upgrade from 1 or 2.
test('D3: a schema 2 file opens as schema 4 with team.model null and keeps every other field; one v2 backup', async (t) => {
  const { fx, doc } = await storedDoc(t, older(2));
  const store = fx.openStore();
  const { model, ...team } = store.snapshot().team;
  assert.equal(model, null);
  assert.deepEqual({ ...store.snapshot(), team }, { ...doc, schema_version: 4, invites: withRefusals(doc) }, 'nothing else changed');
  assert.deepEqual(backupsIn(fx.dir), ['team-members.json.v2.bak']);
  assert.equal((await store.setTeamModel({ actorMemberId: doc.members[0].member_id, model: 'qwen3.8-27b' })).ok, true);
  const written = JSON.parse(fs.readFileSync(fx.memberFile, 'utf8'));
  assert.deepEqual([written.schema_version, written.team.model], [4, 'qwen3.8-27b'], 'written as schema 4 by the commit');
  const one = (await storedDoc(t, older(1))).fx.openStore().snapshot(); // a schema 1 file still upgrades, straight to 4
  assert.deepEqual([one.schema_version, one.team.model, one.projects], [4, null, []]);
});

test('D3: a bad team.model is a broken file; a schema 5 file is an unsupported schema', async (t) => {
  for (const bad of ['', ' edge', 'edge ', 'x'.repeat(129), 'tab\there', 7, undefined]) {
    const { fx } = await storedDoc(t, (d) => { d.team.model = bad; });
    assert.equal(failureOf(fx.newStore().open()).reason, 'team_unavailable', JSON.stringify(bad));
  }
  const { fx: two } = await storedDoc(t, (d) => { older(2)(d); d.team.model = null; }); // a v2 file that already has a model
  assert.equal(failureOf(two.newStore().open()).reason, 'team_unavailable');
  const { fx: five } = await storedDoc(t, (d) => { d.schema_version = 5; });
  assert.equal(failureOf(five.newStore().open()).reason, 'team_store_schema_unsupported');
  assert.deepEqual(backupsIn(five.dir), [], 'nothing written for a newer file');
});

// Schema 4 (owner decision E79): each invite carries `name_refusals`, the host's count of taken-name refusals.
test('E79: a schema 3 file opens as schema 4, every invite gains name_refusals 0, nothing else changes; one v3 backup', async (t) => {
  const { fx, doc, owner, live } = await storedDoc(t, older(3));
  const store = fx.openStore();
  assert.deepEqual(store.snapshot(), { ...doc, schema_version: 4, invites: withRefusals(doc) }, 'nothing else changed');
  assert.deepEqual(backupsIn(fx.dir), ['team-members.json.v3.bak']);
  assert.equal(store.isInviteLive(live.invite_id), true, 'the live invite is kept');
  assert.equal((await store.rename({ actorMemberId: owner.member_id, name: 'Studio' })).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(fx.memberFile, 'utf8')).schema_version, 4, 'written as schema 4 by the commit');
  const { fx: early } = await storedDoc(t, (d) => { d.schema_version = 3; }); // a v3 file whose invites hold a count
  assert.equal(failureOf(early.newStore().open()).reason, 'team_unavailable');
  for (const count of [-1, 6, 1.5, '1', null]) {
    const { fx: bad } = await storedDoc(t, (d) => { d.invites[0].name_refusals = count; });
    assert.equal(failureOf(bad.newStore().open()).reason, 'team_unavailable', JSON.stringify(count));
  }
});
