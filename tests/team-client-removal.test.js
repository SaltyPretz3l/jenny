'use strict';

// Leaving a team, removing it and learning this member was revoked each delete
// that team's drafts, outbox and cached history at once (slice 2a-4b), and
// nothing of a team's history is ever on disk: the profile folder is walked for
// every message text the member received. Through the real team service and
// connection manager, against the in-process team host with the real host chat
// dispatcher (tests/helpers/team-chat-hook.js).

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadChatState, loadClientFile } = require('../services/team/client-file');
const { attachTeamChat } = require('./helpers/team-chat-hook');
const { createTeamClientHost, joinAs, readTree, waitUntil } = require('./helpers/team-client-host');

const HISTORY = ['history-marker-alpha', 'history-marker-beta', 'history-marker-gamma'];

// The host bridge refuses a refused key again for its cooldown without asking, so a refusal is confirmed past it
// (review round two, R11-F01): the fake child and every service of `host` get a short cooldown.
function cooled(host) {
  host.hostSpawner.options.refusedCooldownMs = 300;
  const base = host.serviceOptions;
  host.serviceOptions = (extra) => base({ refusedCooldownMs: 300, ...extra });
  return host;
}

// A member online with a cached channel holding the owner's messages, a draft and a queued post.
async function memberWithChat(t, extra = {}) {
  const host = cooled(await createTeamClientHost(t));
  await attachTeamChat(t, host);
  const owner = await host.ownerDirect();
  const pushes = [];
  const service = host.createService({ sendChat: (payload) => pushes.push(payload), ...extra });
  const me = await joinAs(host, service, { owner });
  await host.waitForState(me.teamId, 'online');
  const call = (method, payload = {}) => service.handle(method, { team_id: me.teamId, ...payload });
  assert.equal((await call('chatOverview')).ok, true);
  assert.equal((await call('chatHistory', { channel_id: 'chan_team' })).ok, true);
  return { host, owner, service, me, call, pushes };
}

// The owner posts through the host's command hook as a registered client of the owner's device.
async function postAsOwner(host, owner, text) {
  const clients = host.env.context.clients;
  const auth = clients.register(owner.device_id);
  const answer = await host.env.commandHook({ api_version: 1, operation: 'team.chat.post', request_id: `req_${text}`,
    client_id: auth.client_id, boot_epoch: host.env.core.bootEpoch, params: { channel_id: 'chan_team', text } });
  assert.equal(answer.ok, true, JSON.stringify(answer));
}

async function seeded(t, extra = {}) {
  const s = await memberWithChat(t, extra);
  for (const text of HISTORY) await postAsOwner(s.host, s.owner, text);
  assert.ok(await waitUntil(() => s.service.chatResources().chatMessages >= HISTORY.length), 'the history is cached');
  assert.equal((await s.call('chatDraftSet', { channel_id: 'chan_team', text: 'my unsent draft' })).ok, true);
  await s.service.flushChat();
  assert.equal(loadChatState(s.host.userData, s.me.teamId).drafts.length, 1);
  return s;
}

function assertNoHistoryOnDisk(host) {
  for (const file of readTree(host.userData)) {
    for (const text of HISTORY) assert.equal(file.text.includes(text), false, `${file.path} holds team history`);
  }
}

test('nothing of the history is on disk while connected, and leave deletes drafts, outbox and cache', async (t) => {
  const s = await seeded(t);
  assertNoHistoryOnDisk(s.host);
  const left = await s.service.handle('leave', { team_id: s.me.teamId });
  assert.equal(left.ok, true, JSON.stringify(left));
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).ok, false, 'the team file is gone');
  assert.equal(s.service.chatResources().chatMessages, 0, 'no cached message');
  assert.equal(s.service.chatResources().chatClients, 0);
  assert.ok(s.pushes.some((push) => push.team_id === s.me.teamId && push.type === 'cleared'));
  assertNoHistoryOnDisk(s.host);
});

test('remove team deletes drafts, outbox and cache', async (t) => {
  const s = await seeded(t);
  assert.equal((await s.service.handle('removeTeam', { team_id: s.me.teamId })).ok, true);
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).ok, false);
  assert.equal(s.service.chatResources().chatMessages, 0);
  assert.ok(s.pushes.some((push) => push.team_id === s.me.teamId && push.type === 'cleared'));
  assertNoHistoryOnDisk(s.host);
});

test('learning this member was revoked deletes drafts, outbox and cache at once', async (t) => {
  const s = await seeded(t);
  const revoked = await s.host.env.store.revokeMember({ actorMemberId: s.owner.member_id, memberId: s.me.member_id });
  assert.equal(revoked.ok, true);
  await s.host.waitForState(s.me.teamId, 'revoked');
  assert.ok(await waitUntil(() => s.service.chatResources().chatMessages === 0), 'the cache is dropped');
  const chat = loadChatState(s.host.userData, s.me.teamId);
  assert.deepEqual({ drafts: chat.drafts, outbox: chat.outbox }, { drafts: [], outbox: [] });
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).record.state_seen, 'revoked', 'the membership file stays');
  assert.ok(s.pushes.some((push) => push.team_id === s.me.teamId && push.type === 'cleared'));
  assertNoHistoryOnDisk(s.host);
});

// ---------------------------------------------------------------- rejoin after removal (two-PC run 3)
// A PC the host removed holds the team in its terminal revoked state; a new invite for that team replaces
// the old membership (key, relay token, directory, chat client) and runs as a first join with a new key.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { clientFilePath } = require('../services/team/client-file');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { holdRedeem } = require('./helpers/team-saved');
const { createConnectionManager } = require('../services/team/connection-manager');
const { encodeReconnectCode } = require('../services/team/reconnect-code');
const { hostFailure } = require('../server/api-contract');

const keyName = (teamId) => `team_device_key:${teamId}`;
const teamDir = (host, teamId) => path.dirname(clientFilePath(host.userData, teamId));
const rejoinPayload = (invite) => ({ invite, display_name: 'Mika Member', label: 'Laptop' });

// A member online with cached history, then removed by the owner: the row is revoked.
async function removedMember(t, extra = {}) {
  const s = await seeded(t, extra);
  assert.equal((await s.host.env.store.revokeMember({ actorMemberId: s.owner.member_id, memberId: s.me.member_id })).ok, true);
  await s.host.waitForState(s.me.teamId, 'revoked');
  const rejoin = async () => s.service.handle('join', rejoinPayload((await s.host.invite({ actor: s.owner.member_id })).invite));
  return { ...s, oldSeed: s.host.secureStore.values.get(keyName(s.me.teamId)), rejoin };
}

// Every secure-store write and delete, in order.
function storeOrder(t, store) {
  const order = [];
  const { set, delete: del } = store;
  store.set = (key, value) => { order.push(['set', key]); return set.call(store, key, value); };
  store.delete = (key) => { order.push(['delete', key]); return del.call(store, key); };
  t.after(() => { store.set = set; store.delete = del; });
  return order;
}

test('a join for a team held revoked replaces it: old key gone before the new one, new device, cache gone, pending', async (t) => {
  const s = await removedMember(t);
  const order = storeOrder(t, s.host.secureStore);
  const cleared = s.pushes.length;
  const joined = await s.rejoin();
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.team.team_id, s.me.teamId);
  assert.notEqual(joined.team.device_id, s.me.device_id, 'a new device');
  assert.notEqual(joined.team.member_id, s.me.member_id, 'a new member');
  assert.equal(joined.team.member_state, 'pending');
  const name = keyName(s.me.teamId);
  const removedAt = order.findIndex(([op, key]) => op === 'delete' && key === name);
  const savedAt = order.findIndex(([op, key]) => op === 'set' && key === name);
  assert.ok(removedAt >= 0 && savedAt > removedAt, 'the old key is removed before the new one is saved');
  const newSeed = s.host.secureStore.values.get(name);
  assert.ok(newSeed && newSeed !== s.oldSeed);
  assert.equal([...s.host.secureStore.values.values()].includes(s.oldSeed), false, 'the old seed is nowhere in the store');
  const device = s.host.env.store.snapshot().devices.find((entry) => entry.device_id === joined.team.device_id);
  assert.equal(device.public_key, keyPairFromSeed(Buffer.from(newSeed, 'base64url')).publicKey);
  assert.ok(s.pushes.slice(cleared).some((push) => push.team_id === s.me.teamId && push.type === 'cleared'), 'old chat dropped');
  assert.equal(s.service.chatResources().chatMessages, 0);
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).record.device_id, joined.team.device_id);
  assertNoHistoryOnDisk(s.host);
  await s.host.waitForState(s.me.teamId, 'pending');
  assert.equal(s.service.snapshot().teams.length, 1);
});

// Each held state but revoked, reached through the real host: `setup` runs after the member joined.
const HELD = {
  online: {}, pending: { admit: false, settle: 'pending' },
  offline: { setup: async (host) => { await host.stopHostBridge(); } },
  reconnecting: { setup: async (host) => { host.holdDials(); await host.stopHostBridge(); } },
  connecting: { restart: true, setup: async (host) => { host.holdDials(); } },
  update_required: { restart: true, extra: { protocolVersion: 2 } },
  needs_repair: { restart: true, setup: async (host, teamId) => { fs.writeFileSync(clientFilePath(host.userData, teamId), '{broken'); } },
};
for (const [mode, how] of Object.entries(HELD)) {
  test(`a join while the team is held ${mode} answers team_already_joined and changes nothing`, async (t) => {
    const host = await createTeamClientHost(t);
    const owner = await host.ownerDirect();
    let service = host.createService();
    const me = await joinAs(host, service, { owner, admit: how.admit !== false });
    await host.waitForState(me.teamId, how.settle || 'online');
    if (how.restart) await service.stopAll();
    if (how.setup) await how.setup(host, me.teamId);
    if (how.restart) { service = host.createService(how.extra || {}); await service.startExisting(); }
    if (mode !== 'needs_repair') await host.waitForState(me.teamId, mode);
    const held = () => ({ key: host.secureStore.values.get(keyName(me.teamId)),
      file: fs.readFileSync(clientFilePath(host.userData, me.teamId), 'latin1') });
    const before = held();
    const { invite } = await host.invite({ actor: owner.member_id });
    const answer = await service.handle('join', rejoinPayload(invite));
    assert.equal(answer.error?.reason, 'team_already_joined', JSON.stringify(answer));
    assert.deepEqual(held(), before, 'nothing changed');
    assert.equal(host.env.redeemCalls.length, 1, 'no second redeem');
  });
}

test('a revoked team whose old key cannot be removed refuses the join and keeps its revoked row', async (t) => {
  const s = await removedMember(t);
  const { invite } = await s.host.invite({ actor: s.owner.member_id });
  const redeems = s.host.env.redeemCalls.length;
  s.host.secureStore.status = 'unavailable';
  const answer = await s.service.handle('join', rejoinPayload(invite));
  s.host.secureStore.status = 'ready';
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_device_key_unavailable', JSON.stringify(answer));
  assert.equal(s.host.env.redeemCalls.length, redeems, 'nothing redeemed');
  assert.equal(s.host.secureStore.values.get(keyName(s.me.teamId)), s.oldSeed, 'the old key stays');
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).record.state_seen, 'revoked', 'the file stays');
  assert.equal(s.service.snapshot().teams.find((team) => team.team_id === s.me.teamId)?.state, 'revoked');
});

test('accepted loss: a redeem that fails after the revoked row was removed leaves no row, no key and no directory', async (t) => {
  const s = await removedMember(t);
  const created = await s.host.invite({ actor: s.owner.member_id });
  assert.equal((await s.host.env.store.revokeInvite({ actorMemberId: s.owner.member_id, inviteId: created.inviteId })).ok, true);
  const answer = await s.service.handle('join', rejoinPayload(created.invite));
  assert.equal(answer.error?.reason, 'invite_not_valid', 'the join\'s own failure sentence');
  assert.deepEqual(s.service.snapshot().teams, [], 'no row');
  assert.equal(s.host.secureStore.values.has(keyName(s.me.teamId)), false, 'no key');
  assert.equal(fs.existsSync(teamDir(s.host, s.me.teamId)), false, 'no directory');
});

test('removeTeam, leave, a reconnect code and a second join while a revoked team is replaced answer team_join_in_progress', async (t) => {
  const s = await removedMember(t);
  const { record } = loadClientFile(s.host.userData, s.me.teamId);
  const code = encodeReconnectCode({ hostPublicKey: record.host_public_key, hints: record.address_hints }).code;
  const held = holdRedeem(t, s.host);
  const joining = s.rejoin();
  await held.reached;
  const teamId = s.me.teamId;
  for (const [method, payload] of [['removeTeam', { team_id: teamId }], ['leave', { team_id: teamId }],
    ['teamReconnectCode', { team_id: teamId, code }]]) {
    assert.equal((await s.service.handle(method, payload)).error?.reason, 'team_join_in_progress', method);
  }
  assert.equal((await s.rejoin()).error?.reason, 'team_join_in_progress');
  held.release();
  const joined = await joining;
  assert.equal(joined.ok, true, JSON.stringify(joined));
});

test('a revoked team at the limit of four teams can still be replaced', async (t) => {
  const s = await removedMember(t);
  await s.service.stopAll();
  for (let n = 0; n < 3; n += 1) {
    const other = deriveTeamId(keyPairFromSeed(crypto.randomBytes(32)).publicKey);
    fs.mkdirSync(teamDir(s.host, other), { recursive: true });
    fs.writeFileSync(clientFilePath(s.host.userData, other), '{broken');
  }
  const service = s.host.createService();
  await service.startExisting();
  await s.host.waitForState(s.me.teamId, 'revoked');
  assert.equal(service.snapshot().teams.length, 4);
  const { invite } = await s.host.invite({ actor: s.owner.member_id });
  const joined = await service.handle('join', rejoinPayload(invite));
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(service.snapshot().teams.length, 4);
});

// Fails within `ms` instead of hanging the file when a step is never reached.
function within(promise, ms = 3000) {
  return Promise.race([promise, new Promise((_, reject) => { setTimeout(() => reject(new Error('never reached')), ms); })]);
}

// A manager factory whose next stop of a revoked manager waits on `release()` or rejects (`fail`).
function gatedStops() {
  const gate = { fail: false, armed: true };
  gate.reached = new Promise((resolve) => { gate.arrive = resolve; });
  gate.open = new Promise((resolve) => { gate.release = resolve; });
  gate.createManager = (options) => {
    const manager = createConnectionManager(options);
    const stop = manager.stop;
    manager.stop = async () => {
      if (!gate.armed || manager.snapshot().state !== 'revoked') return stop();
      gate.armed = false;
      gate.arrive();
      if (gate.fail) throw Object.assign(new Error('stop refused'), { code: 'EBUSY' });
      await gate.open;
      return stop();
    };
    return manager;
  };
  return gate;
}

// After a refused replacement: the team is listed revoked again (Remove this team is offered) and a fresh
// invite replaces it once the fault is gone.
async function stillGetsOut(host, service, owner, teamId) {
  await host.waitForState(teamId, 'revoked');
  const joined = await service.handle('join', rejoinPayload((await host.invite({ actor: owner.member_id })).invite));
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.team.member_state, 'pending');
}

test('a team directory that cannot be removed refuses the join; the key stays and the row comes back revoked', async (t) => {
  const s = await removedMember(t);
  const dir = path.resolve(teamDir(s.host, s.me.teamId));
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.resolve(String(target)).startsWith(dir)) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return unlink(target, ...rest);
  };
  t.after(() => { fs.unlinkSync = unlink; });
  const answer = await s.rejoin();
  fs.unlinkSync = unlink;
  assert.equal(answer.error?.reason, 'team_client_write_failed', JSON.stringify(answer));
  assert.equal(s.host.secureStore.values.get(keyName(s.me.teamId)), s.oldSeed, 'nothing irreversible happened: the key stays');
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).record.state_seen, 'revoked');
  await stillGetsOut(s.host, s.service, s.owner, s.me.teamId);
});

// E64 (Force local): the same refused replacement when Force local turns on during it brings the team back held,
// with no manager started, and the join answers what the removal answered.
test('a revoked team brought back after a refused replacement while Force local turned on is held, not started', async (t) => {
  let mode = 'disabled';
  const s = await removedMember(t, { gate: { held: () => mode !== 'disabled' } });
  const dir = path.resolve(teamDir(s.host, s.me.teamId));
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.resolve(String(target)).startsWith(dir)) { mode = 'local_only'; throw Object.assign(new Error('locked'), { code: 'EPERM' }); }
    return unlink(target, ...rest);
  };
  t.after(() => { fs.unlinkSync = unlink; });
  const answer = await s.rejoin();
  fs.unlinkSync = unlink;
  assert.equal(answer.error?.reason, 'team_client_write_failed', JSON.stringify(answer));
  assert.equal(s.service.resources().managers, 0, 'no manager started');
  assert.deepEqual(s.service.snapshot().teams.map((row) => [row.team_id, row.state]), [[s.me.teamId, 'force_local']]);
});

test('the app stopping while the old manager stops leaves key and file; the next start shows it revoked', async (t) => {
  const gate = gatedStops();
  const s = await removedMember(t, { createManager: gate.createManager });
  const joining = s.rejoin();
  await within(gate.reached);
  const stopping = s.service.stopAll();
  gate.release();
  const answer = await joining;
  await stopping;
  assert.equal(answer.error?.reason, 'team_connection_stopped', JSON.stringify(answer));
  assert.equal(s.host.secureStore.values.get(keyName(s.me.teamId)), s.oldSeed, 'the key stays');
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).record.state_seen, 'revoked', 'the file stays');
  const next = s.host.createService();
  await next.startExisting();
  await stillGetsOut(s.host, next, s.owner, s.me.teamId);
});

test('an old manager whose stop rejects refuses the join and changes nothing on disk', async (t) => {
  const gate = gatedStops();
  gate.fail = true;
  const s = await removedMember(t, { createManager: gate.createManager });
  const answer = await within(s.rejoin());
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(s.host.secureStore.values.get(keyName(s.me.teamId)), s.oldSeed, 'the key stays');
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).record.state_seen, 'revoked', 'the file stays');
  await stillGetsOut(s.host, s.service, s.owner, s.me.teamId);
});

// A real version 2 invite carrying a relay token (internet joining on).
async function tokenInvite(host, owner, token) {
  const created = await host.env.context.invites.create({ kind: 'new_member', actorMemberId: owner.member_id,
    role: 'member', hints: ['192.0.2.7:4242'], internet: { hostName: null, relayUrl: 'https://relay.example.net', relayToken: token } });
  assert.equal(created.ok, true);
  return host.env.context.invites.reveal(created.invite_id).invite;
}

test('the old relay token is removed before the new invite\'s token is saved', async (t) => {
  const host = cooled(await createTeamClientHost(t));
  const owner = await host.ownerDirect();
  const service = host.createService();
  const first = await service.handle('join', rejoinPayload(await tokenInvite(host, owner, 'tok_First-111')));
  assert.equal(first.ok, true, JSON.stringify(first));
  const teamId = first.team.team_id;
  const tokenName = `team_relay_token:${teamId}`;
  assert.equal(host.secureStore.values.has(tokenName), true);
  assert.equal((await host.env.store.revokeMember({ actorMemberId: owner.member_id, memberId: first.team.member_id })).ok, true);
  await host.waitForState(teamId, 'revoked');
  const order = storeOrder(t, host.secureStore);
  const again = await service.handle('join', rejoinPayload(await tokenInvite(host, owner, 'tok_Second-222')));
  assert.equal(again.ok, true, JSON.stringify(again));
  const removedAt = order.findIndex(([op, key]) => op === 'delete' && key === tokenName);
  const savedAt = order.findIndex(([op, key]) => op === 'set' && key === tokenName);
  assert.ok(removedAt >= 0 && savedAt > removedAt, 'the old token goes before the new one is saved');
  assert.equal(host.secureStore.values.get(tokenName), 'tok_Second-222');
});

// The rate-limit check before the removal guards a state no join reaches (a limit is set only for a team
// not held); this is the reachable case: a rejoin the host rate-limits loses the row (accepted), and the
// next paste within the window is refused without dialling.
test('accepted loss: a rejoin the host rate-limits leaves no row, and the next paste is refused before any dial', async (t) => {
  const s = await removedMember(t);
  const { invites } = s.host.env.context;
  const redeem = invites.redeem;
  invites.redeem = async () => hostFailure('limit', 'team_rate_limit');
  t.after(() => { invites.redeem = redeem; });
  assert.equal((await s.rejoin()).error?.reason, 'team_rate_limit');
  assert.deepEqual(s.service.snapshot().teams, []);
  invites.redeem = redeem;
  const redeems = s.host.env.redeemCalls.length;
  assert.equal((await s.rejoin()).error?.reason, 'team_rate_limit');
  assert.equal(s.host.env.redeemCalls.length, redeems, 'nothing redeemed');
});

// Review round two (R10-F02): Remove team never answers ok while the team's folder stays, and never deletes the key
// first; a row an older removal left (a file with no key) is a row that offers Remove, and Remove clears it.
test('Remove team whose folder cannot be removed answers the failure and keeps the key; the row stays removable', async (t) => {
  const s = await removedMember(t);
  const dir = path.resolve(teamDir(s.host, s.me.teamId));
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.resolve(String(target)).startsWith(dir)) throw Object.assign(new Error('locked'), { code: 'EPERM' });
    return unlink(target, ...rest);
  };
  t.after(() => { fs.unlinkSync = unlink; });
  const removed = await s.service.handle('removeTeam', { team_id: s.me.teamId });
  fs.unlinkSync = unlink;
  assert.equal(removed.ok, false, JSON.stringify(removed));
  assert.equal(s.host.secureStore.values.get(keyName(s.me.teamId)), s.oldSeed, 'the key stays');
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).ok, true, 'the file stays');
  await s.host.waitForState(s.me.teamId, 'revoked');
  assert.deepEqual(await s.service.handle('removeTeam', { team_id: s.me.teamId }), { ok: true }, 'Remove works again');
  assert.equal(s.host.secureStore.values.has(keyName(s.me.teamId)), false);
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).ok, false);
});

test('Remove team that the app stop overtakes answers the failure and changes nothing on disk', async (t) => {
  const gate = gatedStops();
  const s = await removedMember(t, { createManager: gate.createManager });
  const removing = s.service.handle('removeTeam', { team_id: s.me.teamId });
  await within(gate.reached);
  const stopping = s.service.stopAll();
  gate.release();
  const answer = await removing;
  await stopping;
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(s.host.secureStore.values.get(keyName(s.me.teamId)), s.oldSeed, 'the key stays');
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).record.state_seen, 'revoked', 'the file stays');
});

test('a team file left with no key is a needs_repair row that Remove clears', async (t) => {
  const s = await removedMember(t);
  await s.service.stopAll();
  s.host.secureStore.values.delete(keyName(s.me.teamId)); // what an older Remove left behind
  const next = s.host.createService();
  await next.startExisting();
  assert.ok(await waitUntil(() => next.snapshot().teams.some((row) => row.team_id === s.me.teamId && row.state !== 'connecting')));
  const row = next.snapshot().teams.find((entry) => entry.team_id === s.me.teamId);
  assert.deepEqual([row.state, row.reason], ['needs_repair', 'team_device_key_missing'], 'a row the Settings page offers Remove on');
  assert.deepEqual(await next.handle('removeTeam', { team_id: s.me.teamId }), { ok: true });
  assert.equal(loadClientFile(s.host.userData, s.me.teamId).ok, false, 'the file is gone');
  assert.deepEqual(next.snapshot().teams, []);
});
