'use strict';

// The per-team connection manager (slice 1f-1) against the real host routes and
// member store, through the real bridge supervisors and the fake bridge child:
// states and transitions, bounded backoff with a new bridge per attempt, the
// "check again" rule after leave and an own-device revoke, terminal states that
// never reconnect, the four-team cap and a clean stop.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HOST_ERROR_CODES, TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const {
  clientFilePath, loadChatState, loadClientFile, saveChatState, saveClientFile,
} = require('../services/team/client-file');
const { createConnectionManager } = require('../services/team/connection-manager');
const { createDeviceKeyStore } = require('../services/team/device-key-store');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { createTeamClientHost, joinAs, pause, waitUntil } = require('./helpers/team-client-host');
const { attachTeamChat } = require('./helpers/team-chat-hook');
const { queued, savedTeam, watchWrites } = require('./helpers/team-saved');
const { countingTimers } = require('./helpers/team-dial-helpers');

// The host bridge refuses a refused key again for its cooldown without asking, so a refusal is confirmed past it
// (review round two, R11-F01): the fake child and every service of `host` get a short cooldown.
function cooled(host) {
  host.hostSpawner.options.refusedCooldownMs = 300;
  const base = host.serviceOptions;
  host.serviceOptions = (extra) => base({ refusedCooldownMs: 300, ...extra });
  return host;
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
  const again = cooled(host).createService({ timers });
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
  const host = cooled(await createTeamClientHost(t));
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
  const host = cooled(await createTeamClientHost(t));
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
  // The renderer's answer carries no request id (E49): the ids are the ones the host saw.
  const seen = host.env.commandsSeen.length;
  const first = await service.handle('memberSetRole', { team_id: me.teamId, member_id: pending.member_id, role: 'read_only' });
  assert.equal(first.ok, false);
  const second = await service.handle('memberSetRole', { team_id: me.teamId, member_id: pending.member_id, role: 'read_only' });
  assert.equal(second.ok, false);
  assert.equal(Object.hasOwn(first.error, 'request_id'), false);
  const ids = host.env.commandsSeen.slice(seen).filter((command) => command.operation === 'team.member.setRole')
    .map((command) => command.request_id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal((await service.handle('memberAdmit', { team_id: me.teamId, member_id: pending.member_id })).ok, true);
  const third = await service.handle('memberSetRole', { team_id: me.teamId, member_id: pending.member_id, role: 'read_only' });
  assert.equal(third.ok, true, JSON.stringify(third));
});

test('a rename this device made shows in its own team row at once, without a reconnect', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const me = await joinAs(host, service, {});
  await host.waitForState(me.teamId, 'online');
  const nameNow = async () => (await service.handle('status', {})).teams.find((team) => team.team_id === me.teamId).team_name;
  const before = await nameNow();
  assert.notEqual(before, 'Studio Two');
  const renamed = await service.handle('rename', { team_id: me.teamId, name: 'Studio Two' });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  assert.equal(await nameNow(), 'Studio Two');
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

test('team.presence.set is limited by the host with chat, so an admin rate-limit hold never answers it locally', async (t) => {
  const { attachTeamChat } = require('./helpers/team-chat-hook');
  const host = await createTeamClientHost(t);
  await attachTeamChat(t, host);
  const service = host.createService();
  const me = await joinAs(host, service, {});
  await host.waitForState(me.teamId, 'online');
  assert.equal((await service.handle('chatOverview', { team_id: me.teamId })).ok, true);
  let limited = null;
  for (let index = 0; index < 31 && !limited; index += 1) {
    const answer = await service.handle('inviteList', { team_id: me.teamId });
    if (!answer.ok && answer.error.reason === 'team_rate_limit') limited = answer;
  }
  assert.ok(limited, 'the admin hold is on');
  const before = host.env.commandsSeen.filter((seen) => seen.operation === 'team.presence.set').length;
  const answer = await service.handle('presenceSet', { team_id: me.teamId, state: 'idle' });
  assert.deepEqual(answer, { ok: true });
  assert.equal(host.env.commandsSeen.filter((seen) => seen.operation === 'team.presence.set').length, before + 1,
    'the presence report reached the host during the hold');
});

// ------------------------------------------------- a team's DNS name (slice 5-3)

const NAMED = { name: 'team.example.net', port: 4242 };

// A saved member whose stored addresses went stale, given a DNS name, with only the old hint reachable.
async function namedMember(t) {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  await service.stopAll();
  const record = { ...loadClientFile(host.userData, me.teamId).record, schema_version: 3, host_name: NAMED,
    relay_url: null, address_hints: ['198.51.100.1:4242'], last_addresses: ['198.51.100.2:4242'] };
  assert.equal(saveClientFile(host.userData, record).ok, true);
  host.setReachable(['192.0.2.7:4242']);
  host.reach.dials.length = 0;
  return { host, me, record };
}

function namedManager(host, record, resolveName) {
  return createConnectionManager({
    record, deviceKeys: createDeviceKeyStore({ getSecureStore: () => host.secureStore }),
    saveRecord: (next) => saveClientFile(host.userData, next), spawnChild: host.memberSpawner, appVersion: '1.6.1',
    backoff: { initialMs: 20, maxMs: 80 }, resolveName,
  });
}

// Fault: the name resolved once and the answer reused, so a moved host is never found again.
test('a team with a DNS name looks it up before every connect and never caches the answer', async (t) => {
  const { host, record } = await namedMember(t);
  let lookups = 0;
  const manager = namedManager(host, record, async (name) => {
    assert.deepEqual(name, NAMED);
    lookups += 1;
    return { ok: true, addresses: ['192.0.2.7:4242'] };
  });
  t.after(() => manager.stop());
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  assert.equal(lookups, 1);
  assert.deepEqual(host.reach.dials[0], ['198.51.100.2:4242'], 'the first stored set is dialled as it is');
  assert.deepEqual(host.reach.dials[1], ['198.51.100.1:4242', '192.0.2.7:4242'], 'the answers join the sets after it');
  await host.stopHostBridge();
  assert.ok(await waitUntil(() => lookups >= 3), 'each reconnect attempt looks the name up again');
  await host.startHostBridge();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  const saved = loadClientFile(host.userData, record.team_id).record;
  assert.deepEqual(saved.host_name, NAMED, 'the name stays; the answer is not written as a hint');
  assert.deepEqual(saved.address_hints, ['198.51.100.1:4242']);
});

// Fault: an unresolved name shown as a plain unreachable host, or a name or address in a log or state.
test('a name that does not resolve, with nothing else reachable, is offline with host_name_unresolved', async (t) => {
  const { host, record } = await namedMember(t);
  const manager = namedManager(host, record, async () => ({ ok: false, reason: 'host_name_unresolved' }));
  const logs = [];
  t.after(() => manager.stop());
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'offline'));
  assert.deepEqual([manager.snapshot().reason, manager.snapshot().code],
    ['host_name_unresolved', TEAM_ERROR_CODES.CONNECTION_FAILED]);
  logs.push(...host.logs);
  const exposed = JSON.stringify([logs, manager.snapshot()]);
  for (const secret of ['team.example.net', '198.51.100', '192.0.2.7']) assert.equal(exposed.includes(secret), false, secret);
});

// Slice 5-3 review items 9b and 13. Fault: every connect waiting for the lookup before its first dial
// (a dead resolver holds a reachable team offline), a lookup for a team whose key is missing, or an
// unresolved name answered without dialling the stored address that works.
test('a stored address that answers is dialled without waiting for the name; a missing key looks nothing up', async (t) => {
  const { host, record } = await namedMember(t);
  const working = { ...record, last_addresses: ['192.0.2.7:4242'] };
  let lookups = 0;
  const hanging = namedManager(host, working, () => { lookups += 1; return new Promise(() => {}); });
  t.after(() => hanging.stop());
  hanging.start();
  assert.ok(await waitUntil(() => hanging.snapshot().state === 'online', { attempts: 50 }), 'online with the lookup pending');
  await hanging.stop();
  const unresolved = namedManager(host, working, async () => ({ ok: false, reason: 'host_name_unresolved' }));
  t.after(() => unresolved.stop());
  unresolved.start();
  assert.ok(await waitUntil(() => unresolved.snapshot().state === 'online'), 'an unresolved name still dials the literal');
  await unresolved.stop();
  host.secureStore.values.clear();
  lookups = 0;
  const keyless = namedManager(host, working, () => { lookups += 1; return new Promise(() => {}); });
  t.after(() => keyless.stop());
  keyless.start();
  assert.ok(await waitUntil(() => keyless.snapshot().reason === 'team_device_key_missing'));
  assert.equal(lookups, 0, 'no lookup without a key');
});

// Slice 5-3 review item 9c. Fault: stop waiting for a lookup that never answers.
test('stop during a pending lookup resolves at once', async (t) => {
  const { host, record } = await namedMember(t);
  let asked = false;
  const manager = namedManager(host, { ...record, address_hints: [], last_addresses: [] },
    () => { asked = true; return new Promise(() => {}); });
  manager.start();
  assert.ok(await waitUntil(() => asked));
  const stopped = await Promise.race([manager.stop().then(() => 'stopped'), pause(1000).then(() => 'waiting')]);
  assert.equal(stopped, 'stopped');
});

// A member with chat whose saved device id is not the one the host names, and whose outbox holds an entry
// the device already sent once and one never sent.
async function staleDevice(t) {
  const saved = await savedTeam(t, { member: true, chat: true });
  const record = loadClientFile(saved.host.userData, saved.me.teamId).record;
  assert.equal(saveClientFile(saved.host.userData, { ...record, device_id: 'device_staleAAAA1111' }).ok, true);
  assert.equal(saveChatState(saved.host.userData, saved.me.teamId, { drafts: [], outbox: [queued(1, true), queued(2)] }).ok,
    true);
  return saved;
}

// Fault: a saved device id that differs from the one the host
// names (team.status) kept, so the old device's attempted entries are resent and isOwnDevice answers for a
// device that is gone; or the new id and the marks written apart, or after a chat command.
test('a saved device id the host does not name is replaced, with the marks, in one write before any chat send', async (t) => {
  const { host, me, file } = await staleDevice(t);
  cooled(host);

  // Each write of client.json that changes the device id: what it held and how many chat commands came before it.
  const changes = [];
  const commands = host.env.commandsSeen.length;
  const chatCommands = () => host.env.commandsSeen.slice(commands).filter((seen) => seen.operation?.startsWith('team.chat.'));
  let lastDevice = 'device_staleAAAA1111';
  const writes = watchWrites(t, file, () => {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.device_id === lastDevice) return;
    lastDevice = value.device_id;
    changes.push({ device: value.device_id, failed: value.outbox.map((item) => item.failed?.reason || null),
      chatBefore: chatCommands().length });
  });
  const service = host.createService();
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  assert.ok(await waitUntil(() => chatCommands().some((seen) => seen.request_id === 'req_2')), 'the entry never sent goes');
  writes.restore();
  assert.deepEqual(changes, [{ device: me.device_id, failed: ['team_chat_outbox_unconfirmed', null], chatBefore: 0 }],
    'one write with the host\'s device id and the marks, before any chat command');
  assert.equal(chatCommands().some((seen) => seen.request_id === 'req_1'), false, 'the attempted entry is never resent');
  assert.ok(await waitUntil(() => loadChatState(host.userData, me.teamId).outbox.map((item) => item.request_id).join() === 'req_1'));
  assert.equal(host.lastState(me.teamId).device_id, me.device_id);
  // isOwnDevice answers for the host's id: revoking it is the own-device path, which ends in revoked.
  const revoked = await service.handle('deviceRevoke', { team_id: me.teamId, device_id: me.device_id });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  await host.waitForState(me.teamId, 'revoked');
});

// Fault: a failed adoption write answered as a success (the old id kept while the manager goes on), or the
// manager going on and sending before the write, or never trying again.
test('a failed adoption write drops the link, sends nothing, keeps the saved id and is retried', async (t) => {
  const { host, me, file } = await staleDevice(t);
  const writes = watchWrites(t, file);
  writes.fail = true;
  const commands = host.env.commandsSeen.length;
  const from = host.states.length;
  const service = host.createService();
  await service.startExisting();
  const failed = () => host.logs.filter((line) => line.event === 'team.device.adopted' && line.fields.ok === false);
  assert.ok(await waitUntil(() => failed().length >= 2), 'tried again');
  assert.deepEqual(failed()[0].fields, { team_id: me.teamId, ok: false, reason: 'team_client_write_failed' });
  assert.equal(host.env.commandsSeen.slice(commands).some((seen) => seen.operation?.startsWith('team.chat.')), false);
  assert.equal(loadClientFile(host.userData, me.teamId).record.device_id, 'device_staleAAAA1111');
  assert.equal(host.states.slice(from).some((snapshot) => snapshot.teams.some((team) => team.state === 'online')), false);
  writes.fail = false;
  await host.waitForState(me.teamId, 'online');
  assert.equal(loadClientFile(host.userData, me.teamId).record.device_id, me.device_id);
});

// Fault: a host whose team.status names no valid device id treated as naming this one (fail open).
test('a status that names no device keeps the link down, says so once per try and goes on once it does', async (t) => {
  const { host, me } = await savedTeam(t, { member: true });
  const { directory } = host.env.store;
  const liveActor = directory.liveActor;
  directory.liveActor = (deviceId) => {
    const live = liveActor.call(directory, deviceId);
    return live ? { ...live, device_id: 'not a device' } : live;
  };
  t.after(() => { directory.liveActor = liveActor; });
  const from = host.states.length;
  const service = host.createService();
  await service.startExisting();
  const unnamed = () => host.logs.filter((line) => line.event === 'team.device.unnamed');
  assert.ok(await waitUntil(() => unnamed().length >= 2), 'tried again');
  assert.deepEqual(unnamed()[0], { level: 'WARN', event: 'team.device.unnamed', fields: { team_id: me.teamId } });
  assert.equal(host.states.slice(from).some((snapshot) => snapshot.teams.some((team) => team.state === 'online')), false);
  directory.liveActor = liveActor;
  await host.waitForState(me.teamId, 'online');
});

test('4b member wiring: an online team gets an engine port whose forward rides that connection; stop takes it down', async (t) => {
  const { createTeamEngine } = require('../services/team/team-engine');
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const changes = [];
  const events = [];
  const teamEngine = createTeamEngine({ onPortChange: (teamId) => changes.push(teamId),
    log: (_level, event, fields) => events.push([event, fields]) });
  const service = host.createService({ teamEngine });
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  assert.ok(await waitUntil(() => teamEngine.teamState(me.teamId)?.portReady === true), 'the engine port');
  assert.deepEqual(changes, [me.teamId]);
  const port = teamEngine.portFor(me.teamId);
  // The real host here runs no pool: the models read reaches it, is refused, and the list is empty.
  assert.ok(await waitUntil(() => events.some(([event]) => event === 'team.engine.models_read')), 'the read');
  assert.deepEqual(events.find(([event]) => event === 'team.engine.models_unavailable')?.[1],
    { team_id: me.teamId, reason: 'team_engine_models_refused' });
  assert.deepEqual(teamEngine.listTeams(), []);
  const url = new URL(`${port.getBaseUrl()}/models`);
  const answer = await new Promise((resolve, reject) => {
    const request = require('node:http').request({ host: url.hostname, port: url.port, path: url.pathname, agent: false,
      headers: { host: url.host, authorization: `Bearer ${port.getApiKey()}` } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(answer.status, 404, `the host's own route_not_found came back through the connection: ${answer.text}`);
  assert.match(answer.text, /route_not_found/u);
  const key = port.getApiKey();
  await service.stopAll();
  assert.equal(port.getStatus().state, 'stopped');
  assert.deepEqual(teamEngine.resources(), { teams: 0, ports: 0, stopping: 0 });
  assert.equal(teamEngine.portFor(me.teamId), null);
  assert.equal(JSON.stringify(events).includes(key), false, 'no log record holds the port key');
});

// Item 15 of the 4b fix list: every way a team's manager goes takes its own engine port down with it.
test('4b member wiring: a reconnect code, leave, removeTeam and a revoke each stop that team\'s old port', async (t) => {
  const { createTeamEngine } = require('../services/team/team-engine');
  const { loadClientFile } = require('../services/team/client-file');
  const { encodeReconnectCode } = require('../services/team/reconnect-code');
  const host = cooled(await createTeamClientHost(t));
  const owner = await host.ownerDirect();
  const gone = [];
  const teamEngine = createTeamEngine({ onTeamGone: (teamId) => gone.push(teamId) });
  const service = host.createService({ teamEngine });
  t.after(() => service.stopAll());
  const readyPort = async (teamId, not = null) => {
    assert.ok(await waitUntil(() => teamEngine.teamState(teamId)?.portReady === true && teamEngine.portFor(teamId) !== not),
      'the engine port');
    return teamEngine.portFor(teamId);
  };
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  const first = await readyPort(me.teamId);
  const record = loadClientFile(host.userData, me.teamId).record;
  const code = encodeReconnectCode({ hostPublicKey: record.host_public_key, hints: record.address_hints }).code;
  assert.equal((await service.handle('teamReconnectCode', { team_id: me.teamId, code })).ok, true);
  assert.ok(await waitUntil(() => first.getStatus().state === 'stopped'), 'stopHeld stopped the old port');
  await host.waitForState(me.teamId, 'online');
  const second = await readyPort(me.teamId, first);
  assert.deepEqual(await service.handle('leave', { team_id: me.teamId }), { ok: true });
  assert.ok(await waitUntil(() => second.getStatus().state === 'stopped'), 'leave (forget) stopped the port');
  assert.equal(teamEngine.portFor(me.teamId), null);

  const other = await joinAs(host, service, { owner, name: 'Rae Rejoin' });
  await host.waitForState(other.teamId, 'online');
  const third = await readyPort(other.teamId);
  assert.deepEqual(await service.handle('removeTeam', { team_id: other.teamId }), { ok: true });
  assert.ok(await waitUntil(() => third.getStatus().state === 'stopped'), 'removeTeam stopped the port');

  const last = await joinAs(host, service, { owner, name: 'Ode Last' });
  await host.waitForState(last.teamId, 'online');
  const fourth = await readyPort(last.teamId);
  assert.equal((await host.env.store.revokeMember({ actorMemberId: owner.member_id, memberId: last.member_id })).ok, true);
  await host.waitForState(last.teamId, 'revoked');
  assert.ok(await waitUntil(() => fourth.getStatus().state === 'stopped'), 'revoked stopped the port');
  assert.ok(gone.includes(me.teamId) && gone.includes(other.teamId) && gone.includes(last.teamId));
  assert.ok(await waitUntil(() => JSON.stringify(teamEngine.resources()) === '{"teams":1,"ports":0,"stopping":0}'),
    'the revoked team stays listed, portless');
});

// A second dial of addresses the first set already tried only adds a wait; a zone would fail every dial.
test('the hints are a second set only when they add an address; a zoned address is never dialled', () => {
  const { addressSets, cleanAddresses } = require('../services/team/bridge-link');
  const hints = ['203.0.113.9:4455', '192.168.1.5:4455'];
  assert.deepEqual(addressSets({ last_addresses: ['[2001:db8::7]:4455', ...hints], address_hints: hints }),
    [['[2001:db8::7]:4455', ...hints]]);
  assert.deepEqual(addressSets({ last_addresses: ['198.51.100.2:4455'], address_hints: hints }), [['198.51.100.2:4455'], hints]);
  assert.deepEqual(addressSets({ last_addresses: [], address_hints: hints }), [hints]);
  assert.deepEqual(cleanAddresses(['[fe80::1%5]:4455', '[fe80::1]:4455', '10.0.0.5:4455']), ['[fe80::1]:4455', '10.0.0.5:4455']);
});

test('retryNow after stop leaves no timer, child or socket', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const me = await joinAs(host, service, { owner: await host.ownerDirect() }).finally(() => service.stopAll());
  const manager = namedManager(host, loadClientFile(host.userData, me.teamId).record);
  manager.start();
  await manager.stop();
  assert.equal(manager.retryNow(), false);
  await pause(50);
  assert.deepEqual([manager.resources(), host.liveMemberChildren().length], [{ bridges: 0, timers: 0, sockets: 0, streams: 0 }, 0]);
});
