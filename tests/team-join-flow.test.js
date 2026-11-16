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
const { clientFilePath, loadClientFile, saveClientFile } = require('../services/team/client-file');
const { createDeviceKeyStore } = require('../services/team/device-key-store');
const { createRelayTokenStore } = require('../services/team/relay-token-store');
const { createJoin } = require('../services/team/join-flow');
const { TeamError } = require('../services/team/team-errors');
const { HINT, createTeamClientHost, joinAs, pause, waitUntil } = require('./helpers/team-client-host');
const { startLines } = require('./helpers/team-dial-helpers');
const { LOCAL_COMMAND } = require('../server/team/member-schema');

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
  assert.deepEqual([file.label, joined.team.label], [LABEL, LABEL], "this PC's name is kept and on the team row");

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

// Fault (slice 5-6): a relay refusal or an unreachable relay told to the joiner as "team unreachable".
test('a relay reason fails the join as itself and leaves nothing', async (t) => {
  for (const reason of ['relay_denied', 'relay_unreachable']) {
    const host = await createTeamClientHost(t);
    const owner = await host.ownerDirect();
    const { invite } = await host.invite({ actor: owner.member_id });
    host.failDialsWith(reason);
    const result = await host.createService().handle('join', joinPayload(invite));
    assert.deepEqual([result.ok, result.error.reason], [false, reason]);
    assertNothingKept(host, parseInvite(invite).team_id);
  }
});

test('joining a team this Jenny already belongs to is refused before the network', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const first = await host.invite({ actor: owner.member_id });
  const service = host.createService();
  assert.equal((await service.handle('join', joinPayload(first.invite))).ok, true);
  const spawns = host.memberSpawner.spawns.length;
  const keys = [...host.secureStore.values.entries()];
  const second = await host.invite({ actor: owner.member_id });
  const again = await service.handle('join', joinPayload(second.invite));
  assert.equal(again.ok, false);
  assert.equal(again.error.reason, 'team_already_joined');
  assert.deepEqual([...host.secureStore.values.entries()], keys, 'the device key is left alone');
  assert.deepEqual(host.secureStore.deletes, [], 'no key removed');
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
  const newer = { ...JSON.parse(fs.readFileSync(file, 'utf8')), schema_version: 9, drafts: [] };
  fs.writeFileSync(file, JSON.stringify(newer));
  const before = membershipBytes(host, me.teamId);
  const second = host.createService();
  await second.startExisting();
  // Member-side saved-team fixes (E47): listed as a row to repair, never loaded.
  assert.deepEqual((await second.handle('status')).teams,
    [{ team_id: me.teamId, state: 'needs_repair', reason: 'team_client_schema_unsupported' }], 'the newer file is not loaded');
  const { invite } = await host.invite({ actor: owner.member_id });
  const result = await second.handle('join', joinPayload(invite));
  assert.equal(result.error.reason, 'team_already_joined');
  assert.deepEqual(membershipBytes(host, me.teamId), before);
});

test('a failed join never removes a directory it did not create; an orphaned key is removed first', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  // An orphaned key (a leave whose key cleanup failed) and, for a second team, a leftover directory.
  const keyOnly = await host.invite({ actor: owner.member_id });
  const keyTeam = parseInvite(keyOnly.invite).team_id;
  host.secureStore.values.set(`team_device_key:${keyTeam}`, Buffer.alloc(32, 7).toString('base64url'));
  host.setReachable([]);
  // Member-side saved-team fixes (E47): the key alone is a leftover; it is removed and the join goes on.
  const first = await service.handle('join', joinPayload(keyOnly.invite));
  assert.equal(first.error.reason, 'team_unreachable', 'the join reached the network');
  assert.equal(host.secureStore.values.has(`team_device_key:${keyTeam}`), false);
  host.secureStore.values.clear();
  const spawns = host.memberSpawner.spawns.length;
  const dir = path.dirname(clientFilePath(host.userData, keyTeam));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note.txt'), 'kept');
  const second = await service.handle('join', joinPayload(keyOnly.invite));
  assert.equal(second.error.reason, 'team_already_joined');
  assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'kept');
  assert.equal(host.secureStore.values.size, 0);
  assert.equal(host.memberSpawner.spawns.length, spawns, 'refused before the network');
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

// ------------------------------------------------- version 2 invites (slice 5-3)

const RELAY = 'https://relay.example.net';
const TOKEN = 'tok_Secret-123';
const NAMED = { name: 'team.example.net', port: 4242 };

// A real version 2 invite from the host's own invite service (internet joining on).
async function v2Invite(host, owner, { hints = [HINT], hostName = null, relayUrl = null, relayToken = null } = {}) {
  const invites = host.env.context.invites;
  const created = await invites.create({ kind: 'new_member', actorMemberId: owner.member_id, role: 'member', hints,
    internet: { hostName, relayUrl, relayToken } });
  assert.equal(created.ok, true);
  return invites.reveal(created.invite_id).invite;
}

// Fault: the token written to the client file, not kept in the secure store, or left behind by Remove team.
test('a version 2 invite keeps its relay token in the secure store, never in a file, and Remove team deletes it', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const invite = await v2Invite(host, owner, { relayUrl: RELAY, relayToken: TOKEN });
  assert.ok(invite.startsWith('jteam2_'));
  const teamId = parseInvite(invite).team_id;
  const service = host.createService();
  const joined = await service.handle('join', joinPayload(invite));
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(host.secureStore.values.get(`team_relay_token:${teamId}`), TOKEN);
  const deviceKeys = createDeviceKeyStore({ getSecureStore: () => host.secureStore });
  assert.equal(deviceKeys.loadRelayToken(teamId), TOKEN, 'read back');
  const saved = loadClientFile(host.userData, teamId).record;
  assert.deepEqual([saved.schema_version, saved.host_name, saved.relay_url], [3, null, RELAY]);
  const exposed = JSON.stringify([host.files(), host.logs, host.states, joined]);
  assert.equal(exposed.includes(TOKEN), false, 'no token in a file, a log, a state or the answer');
  // Characters 50 to 85 encode the invite secret (the first 43 are the host key, which the file holds).
  assert.equal(exposed.includes(invite.slice(50, 85)), false, 'no invite secret anywhere');
  assert.equal(JSON.stringify([host.logs, host.states, joined]).includes('relay.example.net'), false);
  assert.deepEqual(await service.handle('removeTeam', { team_id: teamId }), { ok: true });
  assert.equal(host.secureStore.values.has(`team_relay_token:${teamId}`), false, 'the token went with the team');
  assert.equal(host.secureStore.values.has(`team_device_key:${teamId}`), false);
});

// Fault: a join that goes ahead (or redeems) holding a token it cannot keep.
test('a token this Jenny cannot keep stops the join with team_relay_token_unavailable and nothing redeemed', async (t) => {
  for (const block of ['not_ready', 'basic_text', 'refuse_token']) {
    const host = await createTeamClientHost(t);
    const owner = await host.ownerDirect();
    const invite = await v2Invite(host, owner, { relayUrl: RELAY, relayToken: TOKEN });
    if (block === 'refuse_token') {
      const set = host.secureStore.set;
      host.secureStore.set = (key, value) => {
        if (key.startsWith('team_relay_token:')) throw new Error(`refused ${value}`);
        return set(key, value);
      };
    } else {
      host.secureStore.status = block;
    }
    const result = await host.createService().handle('join', joinPayload(invite));
    assert.deepEqual(result.error, { code: TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE, reason: 'team_relay_token_unavailable' },
      block);
    assert.equal(host.env.redeemCalls.length, 0, block);
    assert.equal(host.memberSpawner.spawns.length, 0, block);
    host.secureStore.status = 'ready';
    assertNothingKept(host, parseInvite(invite).team_id);
    assert.equal(JSON.stringify(host.logs).includes(TOKEN), false);
  }
});

// Fault: an invite from a newer Jenny reported as merely malformed, or dialled.
test('an invite from a newer Jenny answers team_invite_too_new before any socket or key', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const result = await service.handle('join', joinPayload(`jteam3_${'A'.repeat(100)}`));
  assert.deepEqual(result.error, { code: TEAM_ERROR_CODES.INVITE_MALFORMED, reason: 'team_invite_too_new' });
  assert.equal(host.memberSpawner.spawns.length, 0);
  assert.deepEqual(host.files(), []);
  // The IPC bound moved from 256 to 512 characters with the parser: a long string reaches the parser.
  const long = await service.handle('join', joinPayload(`jteam2_${'A'.repeat(505)}`));
  assert.deepEqual(long.error, { code: TEAM_ERROR_CODES.INVITE_MALFORMED, reason: 'team_invite_malformed' });
});

function directJoin(host, resolveName) {
  return createJoin({ deviceKeys: createDeviceKeyStore({ getSecureStore: () => host.secureStore }),
    userDataPath: host.userData, spawnChild: host.memberSpawner, appVersion: '1.6.1', requestTimeoutMs: 3000,
    resolveName });
}

// Fault: the invite's name resolved once and cached, never resolved, or kept out of the client file.
test('a join resolves the invite DNS name before each of its connects and keeps the name, not the answer', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const invite = await v2Invite(host, owner, { hints: [], hostName: NAMED });
  const lookups = [];
  const flow = directJoin(host, async (name) => { lookups.push(name); return { ok: true, addresses: [HINT] }; });
  const result = await flow.join({ invite, displayName: NAME, label: LABEL },
    { admit: () => null, writeRecord: (record) => saveClientFile(host.userData, record) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(lookups.length, 1, 'one lookup per join (review item 9d), not one per connect');
  assert.ok(lookups.every((name) => JSON.stringify(name) === JSON.stringify(NAMED)));
  assert.deepEqual(host.reach.dials[0], [HINT]);
  const saved = loadClientFile(host.userData, result.record.team_id).record;
  assert.deepEqual([saved.schema_version, saved.host_name, saved.address_hints], [3, NAMED, []]);
});

// Fault: an unresolved name reported as a plain unreachable host, or a key left behind.
test('a name that does not resolve, with nothing else to dial, fails the join as host_name_unresolved', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const invite = await v2Invite(host, owner, { hints: [], hostName: NAMED });
  host.setReachable([HINT]);
  const flow = directJoin(host, async () => ({ ok: false, reason: 'host_name_unresolved' }));
  const result = await flow.join({ invite, displayName: NAME, label: LABEL },
    { admit: () => null, writeRecord: (record) => saveClientFile(host.userData, record) });
  assert.deepEqual(result.error, { code: TEAM_ERROR_CODES.CONNECTION_FAILED, reason: 'host_name_unresolved' });
  assertNothingKept(host, parseInvite(invite).team_id);
});

// Slice 5-3 review item 7. Fault: a version 1 recovery invite (the host still mints those) writing a
// record without the team's name and relay, which leaves its token in the store with nothing naming
// it; or a version 2 recovery invite with no relay keeping the old relay and token.
test('recovery keeps the saved route for a version 1 invite and takes a version 2 invite\'s route', async (t) => {
  const host = await createTeamClientHost(t);
  const invites = host.env.context.invites;
  const reveal = async (kind, internet) => {
    const created = await invites.create({ kind, actorMemberId: LOCAL_COMMAND, hints: [HINT], ...(internet ? { internet } : {}) });
    assert.equal(created.ok, true, JSON.stringify(created));
    return invites.reveal(created.invite_id).invite;
  };
  const flow = directJoin(host);
  const writeRecord = (record) => saveClientFile(host.userData, record);
  const checkFile = () => null;
  const first = await reveal('owner_first', { hostName: null, relayUrl: RELAY, relayToken: TOKEN });
  const teamId = parseInvite(first).team_id;
  assert.equal((await flow.join({ invite: first, displayName: NAME, label: LABEL }, { admit: () => null, writeRecord })).ok, true);
  const deviceKeys = createDeviceKeyStore({ getSecureStore: () => host.secureStore });
  const v1 = await flow.recover({ invite: await reveal('recovery'), displayName: NAME, label: LABEL }, { writeRecord, checkFile });
  assert.equal(v1.ok, true, JSON.stringify(v1));
  const kept = loadClientFile(host.userData, teamId).record;
  assert.deepEqual([kept.schema_version, kept.host_name, kept.relay_url], [3, null, RELAY]);
  assert.deepEqual(v1.record, kept, 'the record written is the record the manager starts from');
  assert.equal(deviceKeys.loadRelayToken(teamId), TOKEN, 'the token is still loadable');
  const v2 = await flow.recover({ invite: await reveal('recovery', { hostName: null, relayUrl: null, relayToken: null }),
    displayName: NAME, label: LABEL }, { writeRecord, checkFile });
  assert.equal(v2.ok, true, JSON.stringify(v2));
  const replaced = loadClientFile(host.userData, teamId).record;
  assert.deepEqual([replaced.schema_version, Object.hasOwn(replaced, 'relay_url'), Object.hasOwn(replaced, 'host_name')],
    [2, false, false]);
  assert.equal(host.secureStore.values.has(`team_relay_token:${teamId}`), false, 'the token is deleted');
});

// Slice 5-3 review item 13. Fault: an unresolved name answered without dialling the invite's hint that works.
test('a name that does not resolve still joins over the invite\'s reachable hint', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const invite = await v2Invite(host, owner, { hints: [HINT], hostName: NAMED });
  const flow = directJoin(host, async () => ({ ok: false, reason: 'host_name_unresolved' }));
  const result = await flow.join({ invite, displayName: NAME, label: LABEL },
    { admit: () => null, writeRecord: (record) => saveClientFile(host.userData, record) });
  assert.equal(result.ok, true, JSON.stringify(result));
});

// Slice 5-3 review item 12. Fault: the basic_text or ready check dropped, a non-token loaded, or a store
// fault swallowed (the join tests stop at deviceKeys.available() and never reach these calls).
test('the relay token store fails closed on every store fault', () => {
  const teamId = 'team_abcDEF123';
  const values = new Map();
  const base = () => ({ get: (key) => values.get(key), set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key), getStatus: () => ({ ready: true, storageBackend: 'dpapi' }) });
  const refused = (call, label) => assert.throws(call, (error) => error.reason === 'team_relay_token_unavailable', label);
  const good = createRelayTokenStore({ getSecureStore: base });
  good.save(teamId, TOKEN);
  assert.equal(good.load(teamId), TOKEN);
  good.remove(teamId);
  assert.equal(good.load(teamId), null);
  const boom = () => { throw new Error('store says C:/secret'); };
  for (const [label, store] of [
    ['basic_text', { ...base(), getStatus: () => ({ ready: true, storageBackend: 'basic_text' }) }],
    ['not ready', { ...base(), getStatus: () => ({ ready: false, storageBackend: 'dpapi' }) }],
    ['no delete', { ...base(), delete: undefined }], ['no store', null],
    ['throwing', { ...base(), get: boom, set: boom, delete: boom }],
  ]) {
    const tokens = createRelayTokenStore({ getSecureStore: () => store });
    refused(() => tokens.save(teamId, TOKEN), `${label}: save`);
    refused(() => tokens.load(teamId), `${label}: load`);
    refused(() => tokens.remove(teamId), `${label}: remove`);
  }
  values.set(`team_relay_token:${teamId}`, 'not a token!');
  refused(() => good.load(teamId), 'a stored value that is not a token');
  refused(() => good.save(teamId, 'not a token!'), 'a value that is not a token is never stored');
});

// Slice 5-5c. Fault: a join or recovery that dials without the relay its invite (or its saved route) names, so a host
// reachable only through the owner's relay cannot be joined; or a token in a log.

test('every dial of a version 2 join carries the invite\'s relay; a missing token is null; a version 1 invite carries none', async (t) => {
  // One host per case: a team is joined once.
  const startLinesOfJoin = async (makeInvite) => {
    const host = await createTeamClientHost(t);
    const owner = await host.ownerDirect();
    const invite = await makeInvite(host, owner);
    const from = host.memberSpawner.children.length;
    const result = await directJoin(host).join({ invite, displayName: NAME, label: LABEL },
      { admit: () => null, writeRecord: (record) => saveClientFile(host.userData, record) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(JSON.stringify(host.logs).includes(TOKEN), false, 'no token in a log');
    return startLines(host, from);
  };
  const withToken = await startLinesOfJoin((host, owner) => v2Invite(host, owner, { relayUrl: RELAY, relayToken: TOKEN }));
  assert.ok(withToken.length >= 2, 'the redeem and the check with the device key');
  for (const line of withToken) assert.deepEqual(line.relay, { url: RELAY, token: TOKEN });
  for (const line of await startLinesOfJoin((host, owner) => v2Invite(host, owner, { relayUrl: RELAY }))) {
    assert.deepEqual(line.relay, { url: RELAY, token: null });
  }
  for (const line of await startLinesOfJoin(async (host, owner) => (await host.invite({ actor: owner.member_id })).invite)) {
    assert.equal(Object.hasOwn(line, 'relay'), false, 'a version 1 invite');
  }
  for (const line of await startLinesOfJoin((host, owner) => v2Invite(host, owner))) {
    assert.equal(Object.hasOwn(line, 'relay'), false, 'a version 2 invite with no relay');
  }
});

test('a version 1 recovery over a saved relay dials with the saved URL and token; a token store that cannot answer stops it', async (t) => {
  const host = await createTeamClientHost(t);
  const invites = host.env.context.invites;
  const reveal = async (kind, internet) => {
    const created = await invites.create({ kind, actorMemberId: LOCAL_COMMAND, hints: [HINT], ...(internet ? { internet } : {}) });
    assert.equal(created.ok, true, JSON.stringify(created));
    return invites.reveal(created.invite_id).invite;
  };
  const flow = directJoin(host);
  const writeRecord = (record) => saveClientFile(host.userData, record);
  const checkFile = () => null;
  const first = await reveal('owner_first', { hostName: null, relayUrl: RELAY, relayToken: TOKEN });
  assert.equal((await flow.join({ invite: first, displayName: NAME, label: LABEL }, { admit: () => null, writeRecord })).ok, true);
  const from = host.memberSpawner.children.length;
  const recovered = await flow.recover({ invite: await reveal('recovery'), displayName: NAME, label: LABEL }, { writeRecord, checkFile });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  const lines = startLines(host, from);
  assert.ok(lines.length >= 2);
  for (const line of lines) assert.deepEqual(line.relay, { url: RELAY, token: TOKEN });
  // A token store that throws: nothing is dialled and the answer is the store's reason.
  const real = createDeviceKeyStore({ getSecureStore: () => host.secureStore });
  const broken = createJoin({ deviceKeys: { ...real, loadRelayToken: () => { throw new TeamError('DEVICE_KEY_UNAVAILABLE', 'team_relay_token_unavailable'); } },
    userDataPath: host.userData, spawnChild: host.memberSpawner, appVersion: '1.6.1', requestTimeoutMs: 3000 });
  const spawns = host.memberSpawner.spawns.length;
  const refused = await broken.recover({ invite: await reveal('recovery'), displayName: NAME, label: LABEL }, { writeRecord, checkFile });
  assert.deepEqual(refused.error, { code: TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE, reason: 'team_relay_token_unavailable' });
  assert.equal(host.memberSpawner.spawns.length, spawns, 'no bridge was started');
  assert.equal(JSON.stringify(host.logs).includes(TOKEN), false);
});

// Fault: this PC's name sent once and never saved, so it is asked again after a restart.
test("the owner join and a recovery save this PC's name with the membership, and the team row carries it", async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  const owned = await service.ownerJoin({ invite, display_name: 'Olive Owner', label: 'Host PC' });
  assert.equal(owned.ok, true, JSON.stringify(owned));
  assert.deepEqual([owned.team.label, loadClientFile(host.userData, teamId).record.label], ['Host PC', 'Host PC']);
  const { invites } = host.env.context;
  const created = await invites.create({ kind: 'recovery', actorMemberId: LOCAL_COMMAND, hints: [HINT] });
  const recovered = await service.ownerRecover({ invite: invites.reveal(created.invite_id).invite,
    display_name: 'Olive Owner', label: 'New PC' });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.deepEqual([recovered.team.label, loadClientFile(host.userData, teamId).record.label], ['New PC', 'New PC']);
});
