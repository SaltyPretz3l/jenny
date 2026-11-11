'use strict';

// The desktop join flow (slice 1f-1) against the real host: the real member
// store, invite service, preamble listener and team routes behind the real host
// bridge supervisor with the fake bridge child, and the real member bridge
// supervisor with the fake child on the client side.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HOST_ERROR_CODES, TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { parseInvite } = require('../server/team/invites');
const { keyPairFromSeed } = require('../server/team/ids');
const { clientFilePath } = require('../services/team/client-file');
const { createTeamClientHost, joinAs, pause, waitUntil } = require('./helpers/team-client-host');

const NAME = 'Mika Member';
const LABEL = 'Work laptop';

function joinPayload(invite) {
  return { invite, display_name: NAME, label: LABEL };
}

function assertNothingKept(host, teamId) {
  assert.equal(host.secureStore.values.size, 0, 'no device key left');
  assert.equal(fs.existsSync(path.join(host.userData, 'team', teamId)), false, 'no client file left');
}

test('happy path: join ends pending, then online once the owner admits', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  const teamId = parseInvite(invite).team_id;
  const service = host.createService();

  const joined = await service.handle('join', joinPayload(invite));
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.team.team_id, teamId);
  assert.equal(joined.team.member_state, 'pending');
  assert.equal(host.env.redeemCalls.length, 1);

  // The device key in the secure store is the key the host holds for the new device.
  const seed = Buffer.from(host.secureStore.values.get(`team_device_key:${teamId}`), 'base64url');
  const device = host.env.store.snapshot().devices.find((entry) => entry.device_id === joined.team.device_id);
  assert.equal(device.public_key, keyPairFromSeed(seed).publicKey);
  const file = JSON.parse(fs.readFileSync(path.join(host.userData, 'team', teamId, 'client.json'), 'utf8'));
  assert.equal(file.member_id, joined.team.member_id);
  assert.equal(file.state_seen, 'pending');
  assert.deepEqual(file.address_hints, ['192.0.2.7:4242']);

  await host.waitForState(teamId, 'pending');
  const admitted = await host.env.store.admit({ actorMemberId: owner.member_id, memberId: joined.team.member_id });
  assert.equal(admitted.ok, true);
  const online = await host.waitForState(teamId, 'online');
  assert.equal(online.role, 'member');
  assert.equal(online.member_state, 'active');
});

test('an owner-first invite joins straight to online as the owner', async (t) => {
  const host = await createTeamClientHost(t);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  const service = host.createService();
  const joined = await service.handle('join', joinPayload(invite));
  assert.equal(joined.ok, true, JSON.stringify(joined));
  const online = await host.waitForState(teamId, 'online');
  assert.equal(online.role, 'owner');
});

test('the redeem answer lost: the device key is tried first and a recognised pending device is success', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  const teamId = parseInvite(invite).team_id;
  // The host commits the redeem and its answer never arrives.
  const redeem = host.env.context.invites.redeem;
  host.env.context.invites.redeem = async (input) => {
    await redeem(input);
    return new Promise(() => {});
  };
  const service = host.createService({ requestTimeoutMs: 300 });
  const joined = await service.handle('join', joinPayload(invite));
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.team.member_state, 'pending');
  assert.equal(host.env.redeemCalls.length, 1, 'the redeem is not repeated once the device key is recognised');
  assert.equal(host.env.store.snapshot().members.filter((member) => member.state === 'pending').length, 1);
});

test('a malformed invite fails before any socket opens or key is made', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  for (const invite of ['jteam1_garbage', 'nope', `jteam1_${'A'.repeat(240)}`]) {
    const result = await service.handle('join', joinPayload(invite));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, TEAM_ERROR_CODES.INVITE_MALFORMED);
  }
  assert.equal(host.memberSpawner.spawns.length, 0);
  assert.equal(host.secureStore.sets.length, 0);
  assert.equal(host.env.redeemCalls.length, 0);
});

test('a used invite and an expired invite fail and leave nothing', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();

  const used = await host.invite({ actor: owner.member_id });
  const spent = await host.env.store.redeem({ inviteId: used.inviteId,
    devicePublicKey: keyPairFromSeed(Buffer.alloc(32, 3)).publicKey, displayName: 'Someone Else', label: 'PC' });
  assert.equal(spent.ok, true);
  const usedResult = await service.handle('join', joinPayload(used.invite));
  assert.equal(usedResult.ok, false);
  assert.equal(usedResult.error.code, TEAM_ERROR_CODES.CONNECTION_FAILED);
  assert.equal(usedResult.error.reason, 'invite_not_valid');
  assertNothingKept(host, parseInvite(used.invite).team_id);

  const expiring = await host.invite({ actor: owner.member_id });
  host.clock.advance(8 * 24 * 60 * 60 * 1000);
  const expired = await service.handle('join', joinPayload(expiring.invite));
  assert.equal(expired.ok, false);
  assert.equal(expired.error.reason, 'invite_not_valid');
  assertNothingKept(host, parseInvite(expiring.invite).team_id);
  assert.equal(host.env.redeemCalls.length, 0);
});

test('a secure store that refuses the save stops the join with zero redeem requests', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  host.secureStore.refuseSet = true;
  const service = host.createService();
  const result = await service.handle('join', joinPayload(invite));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE);
  assert.equal(host.env.redeemCalls.length, 0);
  assert.equal(host.memberSpawner.spawns.length, 0);
  assertNothingKept(host, parseInvite(invite).team_id);
});

test('a basic_text secure store refuses the join before the network', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  host.secureStore.status = 'basic_text';
  const service = host.createService();
  const result = await service.handle('join', joinPayload(invite));
  assert.equal(result.error.code, TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE);
  assert.equal(host.memberSpawner.spawns.length, 0);
  assert.deepEqual(host.files(), []);
});

test('a redeem the host refuses keeps the host code and leaves no key and no client file', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  // The team fills up (the owner plus seven) after the invite was made: the host refuses the redeem.
  for (let index = 0; index < 7; index += 1) {
    await host.env.redeemDirect({ actor: owner.member_id, name: `Member ${index}` });
  }
  const service = host.createService();
  const result = await service.handle('join', joinPayload(invite));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, HOST_ERROR_CODES.LIMIT);
  assert.equal(result.error.reason, 'team_member_limit');
  assertNothingKept(host, parseInvite(invite).team_id);
  assert.equal(host.liveMemberChildren().length, 0, 'every join bridge stopped');
});

test('an unreachable host fails the join and leaves nothing', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  host.setReachable([]);
  const service = host.createService();
  const result = await service.handle('join', joinPayload(invite));
  assert.equal(result.ok, false);
  assert.equal(result.error.code, TEAM_ERROR_CODES.CONNECTION_FAILED);
  assert.equal(result.error.reason, 'team_unreachable');
  assertNothingKept(host, parseInvite(invite).team_id);
});

test('joining a team this Jenny already belongs to is refused before the network', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const first = await host.invite({ actor: owner.member_id });
  const service = host.createService();
  assert.equal((await service.handle('join', joinPayload(first.invite))).ok, true);
  const spawns = host.memberSpawner.spawns.length;
  const second = await host.invite({ actor: owner.member_id });
  const again = await service.handle('join', joinPayload(second.invite));
  assert.equal(again.ok, false);
  assert.equal(again.error.reason, 'team_already_joined');
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(host.env.redeemCalls.length, 1);
  assert.ok(host.memberSpawner.spawns.length <= spawns + 1, 'no join bridge for the refused join');
});

// A saved membership's key and file, byte for byte.
function membershipBytes(host, teamId) {
  const file = clientFilePath(host.userData, teamId);
  return { key: host.secureStore.values.get(`team_device_key:${teamId}`),
    file: fs.existsSync(file) ? fs.readFileSync(file, 'latin1') : null };
}

test('a join before the saved teams were loaded never replaces that membership', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const first = host.createService();
  const me = await joinAs(host, first, { owner });
  await host.waitForState(me.teamId, 'online');
  await first.stopAll();
  const before = membershipBytes(host, me.teamId);
  assert.ok(before.key && before.file);
  // A new service, before the backend-ready start: the join still sees the saved team.
  const second = host.createService();
  const { invite } = await host.invite({ actor: owner.member_id });
  const result = await second.handle('join', joinPayload(invite));
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'team_already_joined');
  assert.deepEqual(membershipBytes(host, me.teamId), before);
  assert.equal(host.env.redeemCalls.length, 1, 'no second redeem');
});

test('a join for a team whose client file is a newer schema is refused and changes nothing', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const first = host.createService();
  const me = await joinAs(host, first, { owner });
  await host.waitForState(me.teamId, 'online');
  await first.stopAll();
  const file = clientFilePath(host.userData, me.teamId);
  const newer = { ...JSON.parse(fs.readFileSync(file, 'utf8')), schema_version: 2, drafts: [] };
  fs.writeFileSync(file, JSON.stringify(newer));
  const before = membershipBytes(host, me.teamId);
  const second = host.createService();
  await second.startExisting();
  assert.deepEqual((await second.handle('status')).teams, [], 'the newer file is skipped, not loaded');
  const { invite } = await host.invite({ actor: owner.member_id });
  const result = await second.handle('join', joinPayload(invite));
  assert.equal(result.error.reason, 'team_already_joined');
  assert.deepEqual(membershipBytes(host, me.teamId), before);
});

test('a failed join never removes a key or a directory it did not create', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  // An orphaned key (a leave whose key cleanup failed) and, for a second team, a leftover directory.
  const keyOnly = await host.invite({ actor: owner.member_id });
  const keyTeam = parseInvite(keyOnly.invite).team_id;
  host.secureStore.values.set(`team_device_key:${keyTeam}`, Buffer.alloc(32, 7).toString('base64url'));
  host.setReachable([]);
  const first = await service.handle('join', joinPayload(keyOnly.invite));
  assert.equal(first.error.reason, 'team_already_joined');
  assert.equal(host.secureStore.values.get(`team_device_key:${keyTeam}`), Buffer.alloc(32, 7).toString('base64url'));
  host.secureStore.values.clear();
  const dir = path.dirname(clientFilePath(host.userData, keyTeam));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note.txt'), 'kept');
  const second = await service.handle('join', joinPayload(keyOnly.invite));
  assert.equal(second.error.reason, 'team_already_joined');
  assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'kept');
  assert.equal(host.secureStore.values.size, 0);
  assert.equal(host.memberSpawner.spawns.length, 0, 'refused before the network');
});

test('stopping the service during a join stops its dialling and leaves no key and no file', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  const teamId = parseInvite(invite).team_id;
  const service = host.createService();
  host.holdDials();
  const joining = service.handle('join', joinPayload(invite));
  assert.ok(await waitUntil(() => host.memberSpawner.spawns.length === 1), 'the invite dial started');
  await service.stopAll();
  const result = await joining;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, TEAM_ERROR_CODES.HOST_STOPPED);
  assert.equal(host.liveMemberChildren().length, 0, 'the join bridge is stopped');
  host.releaseDials();
  await pause(150);
  assert.equal(host.memberSpawner.spawns.length, 1, 'no bridge spawned after the stop');
  assertNothingKept(host, teamId);
  assert.equal(host.env.redeemCalls.length, 0);
});
