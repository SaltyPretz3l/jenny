'use strict';

// The authorization function over the real member store's directory, not a
// stand-in: the two were built apart, and this is where they meet.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAuthorizer } = require('../../server/team/authorize');
const { createFixture } = require('./helpers/team-store-fixture');

const TEAM = { kind: 'team', id: '' };

async function team(t) {
  const fx = createFixture(t);
  const store = fx.openStore();
  const { authorize } = createAuthorizer({ directory: store.directory });
  const owner = await fx.bootstrapOwner(store);
  const alice = await fx.joinMember(store, owner.member_id, { displayName: 'Alice' });
  const bob = await fx.joinMember(store, owner.member_id, { displayName: 'Bob' });
  const reader = await fx.joinMember(store, owner.member_id, { displayName: 'Rae', role: 'read_only' });
  const pending = await fx.joinMember(store, owner.member_id, { displayName: 'Pat', admit: false });
  const actor = (seat) => ({ device_id: seat.device_id });
  const reason = (verdict) => (verdict.ok ? 'ok' : verdict.error.reason);
  return { fx, store, authorize, owner, alice, bob, reader, pending, actor, reason };
}

test('each seat in the real store gets its own column of the table', async (t) => {
  const f = await team(t);
  const member = { kind: 'member', id: f.bob.member_id };
  const session = { kind: 'session', id: 'session_1' };
  assert.equal(f.reason(f.authorize(f.actor(f.owner), 'team.member.admin', member)), 'ok');
  assert.equal(f.reason(f.authorize(f.actor(f.alice), 'team.member.admin', member)), 'role_forbidden');
  assert.equal(f.reason(f.authorize(f.actor(f.alice), 'session.write', session)), 'ok');
  assert.equal(f.reason(f.authorize(f.actor(f.reader), 'session.read', session)), 'ok');
  assert.equal(f.reason(f.authorize(f.actor(f.reader), 'session.write', session)), 'role_forbidden');
  assert.equal(f.reason(f.authorize(f.actor(f.pending), 'session.read', session)), 'member_pending');
  assert.equal(f.reason(f.authorize(f.actor(f.pending), 'team.status', TEAM)), 'ok');
  assert.equal(f.reason(f.authorize({ device_id: 'device_unknown' }, 'session.read', session)), 'member_revoked');
});

test('a store change is the next answer, for the same actor object', async (t) => {
  const f = await team(t);
  const session = { kind: 'session', id: 'session_1' };
  const alice = f.actor(f.alice);
  const pat = f.actor(f.pending);
  assert.equal(f.reason(f.authorize(alice, 'session.write', session)), 'ok');
  await f.store.setRole({ actorMemberId: f.owner.member_id, memberId: f.alice.member_id, role: 'read_only' });
  assert.equal(f.reason(f.authorize(alice, 'session.write', session)), 'role_forbidden');
  await f.store.admit({ actorMemberId: f.owner.member_id, memberId: f.pending.member_id });
  assert.equal(f.reason(f.authorize(pat, 'session.write', session)), 'ok');
  await f.store.revokeMember({ actorMemberId: f.owner.member_id, memberId: f.pending.member_id });
  assert.equal(f.reason(f.authorize(pat, 'session.read', session)), 'member_revoked');
  await f.store.transferOwner({ actorMemberId: f.owner.member_id, memberId: f.bob.member_id });
  assert.equal(f.reason(f.authorize(f.actor(f.owner), 'team.audit.read', TEAM)), 'role_forbidden');
  assert.equal(f.reason(f.authorize(f.actor(f.bob), 'team.audit.read', TEAM)), 'ok');
});

test('a member sees their own devices and nobody else\'s', async (t) => {
  const f = await team(t);
  const second = await f.fx.addDevice(f.store, f.alice.member_id);
  const device = (id) => ({ kind: 'device', id });
  assert.equal(f.reason(f.authorize(f.actor(f.alice), 'team.device.revoke', device(second.device_id))), 'ok');
  assert.equal(f.reason(f.authorize(f.actor(f.alice), 'team.device.revoke', device(f.bob.device_id))), 'team_not_found');
  assert.equal(f.reason(f.authorize(f.actor(f.alice), 'team.device.revoke', device('device_none'))), 'team_not_found');
  assert.equal(f.reason(f.authorize(f.actor(f.owner), 'team.device.revoke', device(f.bob.device_id))), 'ok');
  await f.store.revokeDevice({ actorMemberId: f.alice.member_id, deviceId: second.device_id });
  assert.equal(f.reason(f.authorize({ device_id: second.device_id }, 'session.read', { kind: 'session', id: 's' })),
    'member_revoked');
  assert.equal(f.reason(f.authorize(f.actor(f.alice), 'session.read', { kind: 'session', id: 's' })), 'ok');
});

test('an invite key may redeem its own invite and nothing else, until it is spent or expires', async (t) => {
  const f = await team(t);
  const invitePublicKey = f.fx.nextKey('invite');
  const created = await f.store.createInvite({
    kind: 'new_member', actorMemberId: f.owner.member_id, role: 'member', invitePublicKey,
  });
  const principal = f.store.directory.resolveActor(invitePublicKey);
  assert.equal(principal.role, 'invite');
  assert.equal(principal.device_id, created.invite_id);
  assert.equal(f.store.directory.admitKind(invitePublicKey), 'invite');
  const own = { kind: 'invite', id: created.invite_id };
  assert.equal(f.reason(f.authorize(principal, 'team.join.redeem', own)), 'ok');
  assert.equal(f.reason(f.authorize(principal, 'team.join.redeem', { kind: 'invite', id: 'invite_other' })), 'team_not_found');
  assert.equal(f.reason(f.authorize(principal, 'session.read', { kind: 'session', id: 's' })), 'role_forbidden');
  assert.equal(f.reason(f.authorize(principal, 'team.status', TEAM)), 'role_forbidden');

  const deviceKey = f.fx.nextKey('device');
  const redeemed = await f.store.redeem({
    inviteId: created.invite_id, devicePublicKey: deviceKey, displayName: 'Newcomer', label: 'Laptop',
  });
  assert.equal(redeemed.ok, true);
  assert.equal(f.reason(f.authorize(principal, 'team.join.redeem', own)), 'member_revoked');
  assert.equal(f.store.directory.admitKind(invitePublicKey), null);
  assert.equal(f.store.directory.admitKind(deviceKey), 'device');

  const lateKey = f.fx.nextKey('invite');
  const late = await f.store.createInvite({
    kind: 'new_member', actorMemberId: f.owner.member_id, role: 'member', invitePublicKey: lateKey,
  });
  const latePrincipal = f.store.directory.resolveActor(lateKey);
  f.fx.advance(8 * 24 * 60 * 60 * 1000);
  assert.equal(f.reason(f.authorize(latePrincipal, 'team.join.redeem', { kind: 'invite', id: late.invite_id })),
    'member_revoked');
  assert.equal(f.store.directory.admitKind(lateKey), null);
});

test('a resource of the wrong kind for the action reads as not existing', async (t) => {
  const f = await team(t);
  // The device row checks ownership of the device; a weaker kind must not skip that.
  assert.equal(f.reason(f.authorize(f.actor(f.alice), 'team.device.revoke', TEAM)), 'team_not_found');
  assert.equal(f.reason(f.authorize(f.actor(f.alice), 'team.device.revoke', { kind: 'session', id: f.bob.device_id })),
    'team_not_found');
  assert.equal(f.reason(f.authorize(f.actor(f.owner), 'team.member.admin', TEAM)), 'team_not_found');
  assert.equal(f.reason(f.authorize(f.actor(f.owner), 'session.read', { kind: 'project', id: 'p' })), 'team_not_found');
  assert.equal(f.reason(f.authorize(f.actor(f.owner), 'session.read', { kind: 'session', id: 's' })), 'ok');
});
