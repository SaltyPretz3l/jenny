'use strict';

// The device commands: who sees which devices, who may revoke one, and the
// add-device invite that a member creates and reveals in one call.

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseInvite } = require('../../server/team/invites');
const { createTeamCommandsFixture } = require('./helpers/team-commands-fixture');

const FIFTEEN_MINUTES = 15 * 60 * 1000;

function deviceEntry(fx, seat, device, label = 'Laptop') {
  return {
    device_id: device.device_id, member_id: seat.member_id, label, state: 'active',
    fingerprint: fx.fingerprintOf(device.key), created_at: fx.fx.clock(), last_seen_at: null,
  };
}

test('a member lists only their own devices; the owner lists everyone\'s', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice, rae, pat } = f.seats;
  const phone = await f.spareDevice(alice, 'Phone');

  const own = await f.send(alice, 'team.device.list');
  assert.deepEqual(own, { ok: true, devices: [deviceEntry(f, alice, alice), deviceEntry(f, alice, phone, 'Phone')] });
  assert.deepEqual(Object.keys(own.devices[0]), [
    'device_id', 'member_id', 'label', 'state', 'fingerprint', 'created_at', 'last_seen_at']);
  assert.match(own.devices[0].fingerprint, /^[0-9a-f]{10}$/u);
  assert.deepEqual((await f.send(rae, 'team.device.list')).devices, [deviceEntry(f, rae, rae)]);

  const all = await f.send(owner, 'team.device.list');
  assert.deepEqual(all.devices.map((device) => device.device_id), [
    owner.device_id, alice.device_id, rae.device_id, pat.device_id, phone.device_id]);
  assert.equal(f.reasonOf(await f.send(pat, 'team.device.list')), 'member_pending');
});

test('a member revoking another member\'s device is not found and the device stays active', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice, rae } = f.seats;
  const events = [];
  f.store.onMembershipChange((event) => events.push(event.kind));
  for (const target of [rae, owner, { device_id: 'device_nobody' }]) {
    const refused = await f.send(alice, 'team.device.revoke', { device_id: target.device_id });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'CMP-HOST-0003');
    assert.equal(refused.error.reason, 'team_not_found');
  }
  assert.deepEqual(f.store.listDevices(rae.member_id).map((device) => device.state), ['active']);
  assert.deepEqual(f.store.listDevices(owner.member_id).map((device) => device.state), ['active']);
  assert.deepEqual(events, []);
});

test('a member revokes their own second device and the owner revokes anyone\'s', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { owner, alice, rae } = f.seats;
  const events = [];
  f.store.onMembershipChange((event) => events.push([event.kind, event.member_id, [...event.device_ids]]));
  const phone = await f.spareDevice(alice, 'Phone');
  const tablet = await f.spareDevice(rae, 'Tablet');

  assert.deepEqual(await f.send(alice, 'team.device.revoke', { device_id: phone.device_id }), { ok: true });
  assert.deepEqual(f.store.listDevices(alice.member_id).map((device) => device.state), ['active', 'revoked']);
  assert.deepEqual(events, [['device_revoked', alice.member_id, [phone.device_id]]]);
  assert.deepEqual((await f.send(alice, 'team.device.list')).devices.map((device) => device.device_id),
    [alice.device_id]);
  // A revoked device reads like one that does not exist.
  assert.equal(f.reasonOf(await f.send(alice, 'team.device.revoke', { device_id: phone.device_id })), 'team_not_found');

  assert.deepEqual(await f.send(owner, 'team.device.revoke', { device_id: tablet.device_id }), { ok: true });
  assert.deepEqual(events[1], ['device_revoked', rae.member_id, [tablet.device_id]]);
  assert.equal(events.length, 2);
  const roster = await f.send(owner, 'team.members.list');
  const raeEntry = roster.members.find((member) => member.member_id === rae.member_id);
  assert.deepEqual(raeEntry.devices.map((device) => device.device_id), [rae.device_id]);
});

test('revoking the device a command came from commits and answers its own outcome', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { alice } = f.seats;
  const phone = await f.spareDevice(alice, 'Phone');
  const answer = await f.send(alice, 'team.device.revoke', { device_id: alice.device_id });
  assert.deepEqual(answer, { ok: true });
  assert.equal(f.store.listDevices(alice.member_id).find((device) => device.device_id === alice.device_id).state,
    'revoked');
  assert.equal(f.store.listDevices(alice.member_id).find((device) => device.device_id === phone.device_id).state,
    'active');
});

test('team.device.invite creates and reveals an add-device invite for the caller in one call', async (t) => {
  const addresses = ['192.0.2.9:7000', 'bad', '[2001:db8::7]:7001'];
  const f = await createTeamCommandsFixture(t, { addresses });
  const { owner, alice } = f.seats;
  const answer = await f.send(alice, 'team.device.invite');
  assert.equal(answer.ok, true);
  assert.deepEqual(Object.keys(answer), ['ok', 'invite_id', 'expires_at', 'invite']);
  assert.equal(answer.expires_at, f.fx.clock() + FIFTEEN_MINUTES);
  const parsed = parseInvite(answer.invite);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.host_public_key, f.fx.hostKey);
  assert.deepEqual(parsed.hints, ['192.0.2.9:7000', '[2001:db8::7]:7001']);

  // The owner sees it as a live add-device invite for Alice; it cannot be revealed again.
  const listed = await f.send(owner, 'team.invite.list');
  assert.deepEqual(listed.invites, [{
    invite_id: answer.invite_id, kind: 'add_device', role: 'member', member_id: alice.member_id,
    created_at: f.fx.clock(), expires_at: answer.expires_at,
  }]);
  assert.equal(f.reasonOf(await f.send(owner, 'team.invite.reveal', { invite_id: answer.invite_id })),
    'invite_not_valid');

  // Redeeming it adds the device to Alice's list.
  const redeemed = await f.invites.redeem({
    inviteId: answer.invite_id, devicePublicKey: f.fx.nextKey('device'), displayName: 'ignored', label: 'Phone',
  });
  assert.equal(redeemed.ok, true);
  assert.deepEqual((await f.send(alice, 'team.device.list')).devices.map((device) => device.label), ['Laptop', 'Phone']);
  assert.deepEqual((await f.send(owner, 'team.invite.list')).invites, []);
});

test('a member with all three device slots used or reserved gets team_device_limit', async (t) => {
  const f = await createTeamCommandsFixture(t);
  const { alice } = f.seats;
  await f.spareDevice(alice, 'Phone');
  assert.equal((await f.send(alice, 'team.device.invite')).ok, true);
  const refused = await f.send(alice, 'team.device.invite');
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'CMP-HOST-0007');
  assert.equal(refused.error.reason, 'team_device_limit');
});
