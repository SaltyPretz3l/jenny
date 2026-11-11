'use strict';

// The per-team connection manager (slice 1f-1) against the real host routes and
// member store, through the real bridge supervisors and the fake bridge child:
// states and transitions, bounded backoff with a new bridge per attempt, the
// "check again" rule after leave and an own-device revoke, terminal states that
// never reconnect, the four-team cap and a clean stop.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { HOST_ERROR_CODES, TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { loadClientFile, saveClientFile } = require('../services/team/client-file');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { createTeamClientHost, joinAs, pause, waitUntil } = require('./helpers/team-client-host');

// Timers the manager uses, counted so a test can see what is live and every delay asked for.
function countingTimers() {
  const live = new Set();
  const delays = [];
  return {
    live, delays,
    setTimeout(fn, ms) {
      delays.push(ms);
      const handle = setTimeout(() => { live.delete(handle); fn(); }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) { live.delete(handle); clearTimeout(handle); },
  };
}

test('online, then reconnecting and offline when the host goes away, then online when it returns', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const timers = countingTimers();
  const service = host.createService({ timers });
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  const seen = () => host.states.map((snapshot) => snapshot.teams.find((team) => team.team_id === me.teamId)?.state);

  await host.stopHostBridge();
  const offline = await host.waitForState(me.teamId, 'offline');
  assert.equal(offline.reason, 'host_unreachable');
  assert.equal(offline.code, TEAM_ERROR_CODES.CONNECTION_FAILED);
  assert.equal(typeof offline.since, 'number');
  assert.ok(seen().includes('reconnecting'), 'a lost connection reports reconnecting first');

  const spawnsWhileDown = host.memberSpawner.spawns.length;
  await pause(250);
  assert.ok(host.memberSpawner.spawns.length > spawnsWhileDown + 1, 'it keeps trying, a new bridge each time');
  assert.ok(host.memberSpawner.children.slice(0, -1).every((child) => child.exited), 'every earlier bridge is gone');
  assert.ok(timers.delays.length > 2);
  assert.ok(timers.delays.every((ms) => ms <= 80), `bounded backoff: ${timers.delays}`);
  assert.ok(Math.max(...timers.delays) >= 64, 'the backoff reaches its ceiling, less at most 20% jitter');

  await host.startHostBridge();
  await host.waitForState(me.teamId, 'online');
});

test('the last working addresses are tried first, then the invite hints', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  await service.stopAll();
  // The last working address has moved away; only the invite's hint still reaches the host.
  const loaded = loadClientFile(host.userData, me.teamId);
  assert.equal(loaded.ok, true);
  assert.equal(saveClientFile(host.userData, { ...loaded.record, last_addresses: ['198.51.100.1:4242'] }).ok, true);
  host.reach.dials.length = 0;
  host.setReachable(['192.0.2.7:4242']);
  const again = host.createService();
  await again.startExisting();
  await host.waitForState(me.teamId, 'online');
  assert.deepEqual(host.reach.dials[0], ['198.51.100.1:4242']);
  assert.ok(host.reach.dials[1].includes('192.0.2.7:4242'));
  const saved = loadClientFile(host.userData, me.teamId).record;
  assert.equal(saved.last_addresses[0], '192.0.2.7:4242', 'the working address is remembered first');
});

test('update_required on a hello version mismatch, with no reconnect loop', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const first = host.createService();
  const me = await joinAs(host, first, { owner });
  await host.waitForState(me.teamId, 'online');
  await first.stopAll();
  const timers = countingTimers();
  const newer = host.createService({ protocolVersion: 2, timers });
  await newer.startExisting();
  const state = await host.waitForState(me.teamId, 'update_required');
  assert.equal(state.code, TEAM_ERROR_CODES.VERSION_MISMATCH);
  assert.equal(state.reason, 'team_server_too_old');
  const spawns = host.memberSpawner.spawns.length;
  await pause(200);
  assert.equal(host.memberSpawner.spawns.length, spawns, 'no reconnect after update_required');
  assert.equal(timers.live.size, 0);
  assert.equal(host.liveMemberChildren().length, 0);
});

test('a refused known device key is revoked, terminal, and keeps the key until the team is removed', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  await service.stopAll();
  const revoked = await host.env.store.revokeMember({ actorMemberId: owner.member_id, memberId: me.member_id });
  assert.equal(revoked.ok, true);
  const timers = countingTimers();
  const again = host.createService({ timers });
  await again.startExisting();
  await host.waitForState(me.teamId, 'revoked');
  const spawns = host.memberSpawner.spawns.length;
  await pause(200);
  assert.equal(host.memberSpawner.spawns.length, spawns, 'no reconnect after revoked');
  assert.equal(timers.live.size, 0);
  assert.equal(host.secureStore.values.size, 1, 'the device key stays until removeTeam');
  assert.deepEqual(await again.handle('removeTeam', { team_id: me.teamId }), { ok: true });
  assert.equal(host.secureStore.values.size, 0);
  assert.deepEqual((await again.handle('status')).teams, []);
});

test('a revoke in the middle of an open event stream ends in revoked', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  assert.ok(await waitUntil(() => service.resources().streams > 0), 'the event stream is open');
  const revoked = await host.env.store.revokeMember({ actorMemberId: owner.member_id, memberId: me.member_id });
  assert.equal(revoked.ok, true);
  await host.waitForState(me.teamId, 'revoked');
  const spawns = host.memberSpawner.spawns.length;
  await pause(150);
  assert.equal(host.memberSpawner.spawns.length, spawns);
});

test('leave ends with the team, its key and its file gone, also when the drop races the answer', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  const left = await service.handle('leave', { team_id: me.teamId });
  assert.deepEqual(left, { ok: true });
  assert.equal(host.env.store.snapshot().members.find((member) => member.member_id === me.member_id).state, 'revoked');
  assert.deepEqual((await service.handle('status')).teams, []);
  assert.equal(host.secureStore.values.size, 0);
  assert.deepEqual(host.files(), []);
});

test('leave answered by the host refusal keeps the host code and the membership', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const me = await joinAs(host, service, {});
  await host.waitForState(me.teamId, 'online');
  const left = await service.handle('leave', { team_id: me.teamId });
  assert.equal(left.ok, false);
  // The owner may not leave (transfer first): the host's own refusal comes back unchanged.
  assert.equal(left.error.code, HOST_ERROR_CODES.FORBIDDEN);
  assert.equal(left.error.reason, 'role_forbidden');
  assert.equal(host.lastState(me.teamId).state, 'online');
});

test('revoking the device the call came from ends in revoked, not a failure', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  const result = await service.handle('deviceRevoke', { team_id: me.teamId, device_id: me.device_id });
  assert.equal(result.ok, true, JSON.stringify(result));
  await host.waitForState(me.teamId, 'revoked');
});

test('a new request id after a failed mutation, so the retry is answered afresh', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const me = await joinAs(host, service, {});
  await host.waitForState(me.teamId, 'online');
  const created = await service.handle('inviteCreate', { team_id: me.teamId, role: 'member' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const pending = await host.env.redeemDirect({ actor: me.member_id, name: 'Pia Pending' });
  const first = await service.handle('memberSetRole', { team_id: me.teamId, member_id: pending.member_id, role: 'read_only' });
  assert.equal(first.ok, false);
  const second = await service.handle('memberSetRole', { team_id: me.teamId, member_id: pending.member_id, role: 'read_only' });
  assert.equal(second.ok, false);
  assert.notEqual(first.error.request_id, second.error.request_id);
  assert.equal((await service.handle('memberAdmit', { team_id: me.teamId, member_id: pending.member_id })).ok, true);
  const third = await service.handle('memberSetRole', { team_id: me.teamId, member_id: pending.member_id, role: 'read_only' });
  assert.equal(third.ok, true, JSON.stringify(third));
});

test('a rate-limited call is not sent again within the minute', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const me = await joinAs(host, service, {});
  await host.waitForState(me.teamId, 'online');
  let limited = null;
  for (let index = 0; index < 31 && !limited; index += 1) {
    const answer = await service.handle('inviteList', { team_id: me.teamId });
    if (!answer.ok && answer.error.reason === 'team_rate_limit') limited = answer;
  }
  assert.ok(limited, 'the host rate-limits after 30 calls');
  const count = () => host.env.logs.filter((line) => line.event === 'team_command.rate_limited').length;
  const before = count();
  const again = await service.handle('members', { team_id: me.teamId });
  assert.equal(again.ok, false);
  assert.equal(again.error.reason, 'team_rate_limit');
  assert.equal(again.error.code, HOST_ERROR_CODES.LIMIT);
  assert.equal(count(), before, 'refused in main, nothing sent');
});

test('the cap is four teams; a fifth join is refused with a plain reason before any network', async (t) => {
  const host = await createTeamClientHost(t);
  for (let index = 0; index < 4; index += 1) {
    const hostKey = keyPairFromSeed(crypto.randomBytes(32)).publicKey;
    const teamId = deriveTeamId(hostKey);
    assert.equal(saveClientFile(host.userData, { schema_version: 1, team_id: teamId, host_public_key: hostKey,
      address_hints: ['192.0.2.9:4242'], last_addresses: [], member_id: `member_m${index}`,
      device_id: `device_d${index}`, display_name: 'Me', joined_at: '2026-11-10T10:00:00.000Z',
      state_seen: 'active' }).ok, true);
    host.secureStore.values.set(`team_device_key:${teamId}`, crypto.randomBytes(32).toString('base64url'));
  }
  const service = host.createService();
  await service.startExisting();
  assert.equal((await service.handle('status')).teams.length, 4);
  const owner = await host.ownerDirect();
  const { invite } = await host.invite({ actor: owner.member_id });
  const sets = host.secureStore.sets.length;
  const result = await service.handle('join', { invite, display_name: 'Mika', label: 'Laptop' });
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'team_limit_reached');
  assert.equal(host.secureStore.sets.length, sets);
  assert.equal(host.env.redeemCalls.length, 0);
});

test('stop leaves no child, timer or socket', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const timers = countingTimers();
  const service = host.createService({ timers });
  const pendingMe = await joinAs(host, service, { owner, admit: false });
  await host.waitForState(pendingMe.teamId, 'pending');
  await service.stopAll();
  assert.equal(host.liveMemberChildren().length, 0);
  assert.equal(timers.live.size, 0);
  assert.deepEqual(service.resources(), { managers: 0, bridges: 0, timers: 0, sockets: 0, streams: 0 });
  const after = await service.handle('members', { team_id: pendingMe.teamId });
  assert.equal(after.ok, false);
  assert.equal(after.error.code, TEAM_ERROR_CODES.HOST_STOPPED);
});
