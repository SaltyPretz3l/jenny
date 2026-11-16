'use strict';

// The member store repeats the owner-only rules behind the one authorization
// function, so a wiring mistake in a later slice cannot let a member admit,
// promote, revoke or cancel on someone else's behalf.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFixture, assertOwnerInvariant } = require('./helpers/team-store-fixture');
const { LOCAL_COMMAND } = require('../../server/team/member-schema');

function reasonOf(result) {
  assert.equal(result.ok, false, 'expected a failure');
  return result.error.reason;
}

async function team(t) {
  const fx = createFixture(t);
  const store = fx.openStore();
  const owner = await fx.bootstrapOwner(store);
  const alice = await fx.joinMember(store, owner.member_id, { displayName: 'Alice' });
  const bob = await fx.joinMember(store, owner.member_id, { displayName: 'Bob' });
  const pending = await fx.joinMember(store, owner.member_id, { displayName: 'Pat', admit: false });
  return { fx, store, owner, alice, bob, pending };
}

test('only the owner admits, changes a role or revokes a member', async (t) => {
  const { store, alice, bob, pending } = await team(t);
  const before = store.rev();
  assert.equal(reasonOf(await store.admit({ actorMemberId: alice.member_id, memberId: pending.member_id })), 'role_forbidden');
  assert.equal(reasonOf(await store.setRole({
    actorMemberId: alice.member_id, memberId: bob.member_id, role: 'read_only',
  })), 'role_forbidden');
  assert.equal(reasonOf(await store.revokeMember({ actorMemberId: alice.member_id, memberId: bob.member_id })), 'role_forbidden');
  assert.equal(store.getMember(pending.member_id).state, 'pending');
  assert.equal(store.getMember(bob.member_id).role, 'member');
  assert.equal(store.getMember(bob.member_id).state, 'active');
  assert.equal(store.rev(), before, 'a refused transition commits nothing');
  assertOwnerInvariant(assert, store);
});

test('a member revokes only their own device; another member\'s reads as missing', async (t) => {
  const { store, owner, alice, bob } = await team(t);
  const missing = await store.revokeDevice({ actorMemberId: alice.member_id, deviceId: 'device_does_not_exist' });
  const foreign = await store.revokeDevice({ actorMemberId: alice.member_id, deviceId: bob.device_id });
  assert.deepEqual(foreign, missing, 'not visible answers exactly like not existing');
  assert.equal(store.directory.isDeviceActive(bob.device_id), true);
  assert.equal((await store.revokeDevice({ actorMemberId: alice.member_id, deviceId: alice.device_id })).ok, true);
  assert.equal(store.directory.isDeviceActive(alice.device_id), false);
  assert.equal((await store.revokeDevice({ actorMemberId: owner.member_id, deviceId: bob.device_id })).ok, true);
  assert.equal(store.directory.isDeviceActive(bob.device_id), false);
});

test('a member revokes only an invite they created; the owner revokes any', async (t) => {
  const { fx, store, owner, alice, bob } = await team(t);
  const own = await store.createInvite({ kind: 'add_device', actorMemberId: alice.member_id, invitePublicKey: fx.nextKey('i') });
  const bobs = await store.createInvite({ kind: 'add_device', actorMemberId: bob.member_id, invitePublicKey: fx.nextKey('i') });
  const team1 = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey('i'),
  });
  assert.equal(reasonOf(await store.revokeInvite({ actorMemberId: alice.member_id, inviteId: bobs.invite_id })), 'invite_not_valid');
  assert.equal(reasonOf(await store.revokeInvite({ actorMemberId: alice.member_id, inviteId: team1.invite_id })), 'invite_not_valid');
  assert.equal(store.isInviteLive(bobs.invite_id), true);
  assert.equal(store.isInviteLive(team1.invite_id), true);
  assert.equal((await store.revokeInvite({ actorMemberId: alice.member_id, inviteId: own.invite_id })).ok, true);
  assert.equal((await store.revokeInvite({ actorMemberId: owner.member_id, inviteId: bobs.invite_id })).ok, true);
  assert.equal(store.isInviteLive(bobs.invite_id), false);
});

test('a recovery invite is void once ownership has moved', async (t) => {
  const { fx, store, owner, alice } = await team(t);
  const minted = await store.createInvite({ kind: 'recovery', actorMemberId: LOCAL_COMMAND, invitePublicKey: fx.nextKey('r') });
  assert.equal(minted.ok, true);
  assert.equal((await store.transferOwner({ actorMemberId: owner.member_id, memberId: alice.member_id })).ok, true);
  const redeemed = await store.redeem({
    inviteId: minted.invite_id, devicePublicKey: fx.nextKey('d'), displayName: 'ignored', label: 'New PC',
  });
  assert.equal(reasonOf(redeemed), 'invite_not_valid');
  assert.equal(store.directory.isDeviceActive(owner.device_id), true, 'the former owner keeps their device');
  assert.equal(store.directory.liveActor(alice.device_id).role, 'owner');
  assertOwnerInvariant(assert, store);
});

test('an invite kind is one of the four in the table, never an inherited property name', async (t) => {
  const { fx, store, alice } = await team(t);
  const before = store.rev();
  for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty', undefined, null, 7]) {
    const minted = await store.createInvite({
      kind, actorMemberId: alice.member_id, ttlMs: 7 * 24 * 60 * 60 * 1000, invitePublicKey: fx.nextKey('i'),
    });
    assert.equal(reasonOf(minted), 'team_invite_malformed', String(kind));
  }
  assert.equal(store.rev(), before);
});

test('a name the owner reads cannot be blank, hidden or reordered', async (t) => {
  const { fx, store, owner } = await team(t);
  const join = async (displayName) => {
    const created = await store.createInvite({
      kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey('i'),
    });
    const redeemed = await store.redeem({
      inviteId: created.invite_id, devicePublicKey: fx.nextKey('d'), displayName, label: 'Laptop',
    });
    await store.revokeInvite({ actorMemberId: owner.member_id, inviteId: created.invite_id });
    return redeemed;
  };
  const refused = ['‍', '​', 'Al​ice', '‮ecila', 'Ali⁦ce', 'A﻿lice', '‏Alice'];
  for (const name of refused) {
    assert.equal(reasonOf(await join(name)), 'team_display_name_invalid', JSON.stringify(name));
  }
  // Joiners inside an emoji sequence and inside a script stay legal.
  const family = await join('Sam \u{1F468}‍\u{1F469}‍\u{1F467}');
  assert.equal(family.ok, true);
});

test('a failed write of "last seen" does not take the team offline', async (t) => {
  const fx = createFixture(t);
  const first = fx.openStore();
  const owner = await fx.bootstrapOwner(first);
  let failing = false;
  const { writeJson } = require('../../services/host/durable-json');
  const store = fx.openStore({
    writeJson(filePath, value) {
      if (failing) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return writeJson(filePath, value);
    },
  });
  const rev = store.rev();
  fx.advance(2 * 60 * 1000);
  failing = true;
  const touched = await store.touchDevice(owner.device_id);
  assert.equal(reasonOf(touched), 'team_store_failed');
  assert.equal(store.rev(), rev);
  assert.equal(store.directory.liveActor(owner.device_id).role, 'owner', 'the directory still answers');
  failing = false;
  assert.equal((await store.touchDevice(owner.device_id)).written, true);
  // A real membership change that cannot be written still fails closed.
  failing = true;
  const invite = await store.createInvite({
    kind: 'new_member', actorMemberId: owner.member_id, role: 'member', invitePublicKey: fx.nextKey('i'),
  });
  assert.equal(reasonOf(invite), 'team_store_failed');
  assert.equal(store.directory.liveActor(owner.device_id), null);
});

test('only the local command marker mints an owner invite; null, undefined and the marker elsewhere are refused', async (t) => {
  const { fx, store, alice } = await team(t);
  const before = store.rev();
  for (const kind of ['recovery', 'owner_first']) {
    for (const actorMemberId of [null, undefined]) {
      const refused = await store.createInvite({ kind, actorMemberId, invitePublicKey: fx.nextKey('o') });
      assert.equal(reasonOf(refused), 'role_forbidden', `${kind} ${String(actorMemberId)}`);
    }
  }
  for (const kind of ['new_member', 'add_device']) {
    const refused = await store.createInvite({ kind, actorMemberId: LOCAL_COMMAND, role: 'member', invitePublicKey: fx.nextKey('m') });
    assert.equal(reasonOf(refused), 'team_not_found', kind);
  }
  assert.equal(store.rev(), before, 'nothing was written');
  assert.equal((await store.createInvite({ kind: 'recovery', actorMemberId: LOCAL_COMMAND, invitePublicKey: fx.nextKey('r') })).ok,
    true);
  assert.equal(reasonOf(await store.createInvite({ kind: 'owner_first', actorMemberId: LOCAL_COMMAND,
    invitePublicKey: fx.nextKey('f') })), 'team_member_state_invalid', 'past the actor check: the team has an owner');
  assert.equal((await store.createInvite({ kind: 'new_member', actorMemberId: alice.member_id, role: 'member',
    invitePublicKey: fx.nextKey('n') })).error?.reason, 'role_forbidden', 'a member is still not the owner');
});

test('the local command marker is refused by every other transition family, without a throw', async (t) => {
  const { store, owner, alice } = await team(t);
  const before = store.rev();
  assert.equal(reasonOf(await store.setRole({ actorMemberId: LOCAL_COMMAND, memberId: alice.member_id, role: 'read_only' })),
    'team_not_found', 'an owner-only transition');
  assert.equal(reasonOf(await store.revokeDevice({ actorMemberId: LOCAL_COMMAND, deviceId: owner.device_id })),
    'team_not_found', 'an active-member transition');
  assert.equal(reasonOf(await store.createProject({ actorMemberId: LOCAL_COMMAND, name: 'Atlas' })),
    'team_not_found', 'a project transition');
  assert.equal(store.rev(), before);
});

test('a local mint and a local revoke are audited with a null actor, and the written log loads again', async (t) => {
  const { fx, store } = await team(t);
  const minted = await store.createInvite({ kind: 'recovery', actorMemberId: LOCAL_COMMAND, invitePublicKey: fx.nextKey('r') });
  assert.equal((await store.revokeInvite({ actorMemberId: LOCAL_COMMAND, inviteId: minted.invite_id })).ok, true);
  const [created, revoked] = store.audit.read({}).entries.slice(-2);
  assert.deepEqual([created.kind, created.actor_member_id, revoked.kind, revoked.actor_member_id],
    ['invite_created', null, 'invite_revoked', null]);
  const reread = fx.openStore().audit.read({});
  assert.equal(reread.ok, true, 'the audit schema accepts the written file');
  assert.deepEqual(reread.entries.slice(-2).map((entry) => entry.actor_member_id), [null, null]);
});
