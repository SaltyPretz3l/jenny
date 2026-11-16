'use strict';

// Connection manager lifecycle (slice 1f-1 review fixes) against the real host
// routes and member store, through the real bridge supervisors and the fake
// bridge child: stop ends a dial in progress and every probe, nothing is written
// after a team is removed, a bridge that throws is retried, online means the
// event stream is open, the backoff starts over only once a connection held, a
// refusal is confirmed before it counts, one client registration is shared, and
// an unchanged state is not pushed again. Member-side saved-team fixes: an
// accepted recovery is one write of the new device and the unconfirmed marks,
// and a recover, a reconnect code or a join waits out a held removal or leave.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createMemberBridge } = require('../services/team/transport/member-bridge');
const { createConnectionManager } = require('../services/team/connection-manager');
const { createDeviceKeyStore } = require('../services/team/device-key-store');
const {
  clientFilePath, loadChatState, loadClientFile, saveChatState, saveClientFile,
} = require('../services/team/client-file');
const { createTeamClientHost, joinAs, pause, waitUntil } = require('./helpers/team-client-host');
const { deviceKeyName } = require('../services/team/device-key-store');
const { encodeReconnectCode } = require('../services/team/reconnect-code');
const { attachTeamChat } = require('./helpers/team-chat-hook');
const { queued, recover, savedTeam, watchWrites } = require('./helpers/team-saved');
const { countingTimers } = require('./helpers/team-dial-helpers');
const { deviceListView } = require('../server/team/team-views');

// A member who joined and was admitted, with the first service stopped again.
const savedMember = (t) => savedTeam(t, { member: true });

const statesOf = (host, teamId, from = 0) => host.states.slice(from)
  .map((snapshot) => snapshot.teams.find((team) => team.team_id === teamId)?.state).filter(Boolean);

test('stop during a slow first dial leaves no child and spawns none afterwards', async (t) => {
  const { host, me } = await savedMember(t);
  // Two address sets, so a loop that ignored the stop would dial the second one.
  const loaded = loadClientFile(host.userData, me.teamId).record;
  assert.equal(saveClientFile(host.userData, { ...loaded, last_addresses: ['198.51.100.1:4242'] }).ok, true);
  host.holdDials();
  const service = host.createService();
  const spawns = host.memberSpawner.spawns.length;
  await service.startExisting();
  assert.ok(await waitUntil(() => host.memberSpawner.spawns.length === spawns + 1), 'the first dial started');
  await service.stopAll();
  assert.equal(host.liveMemberChildren().length, 0, 'stop ended the dial in progress');
  host.releaseDials();
  await pause(150);
  assert.equal(host.memberSpawner.spawns.length, spawns + 1, 'no bridge spawned after stop');
  assert.equal(host.liveMemberChildren().length, 0);
});

test('a bridge whose start or state hook throws is closed and retried, not stuck connecting', async (t) => {
  const { host, me } = await savedMember(t);
  let made = 0;
  const createBridge = (options) => {
    const bridge = createMemberBridge(options);
    made += 1;
    if (made === 1) return { ...bridge, start: async () => { throw new Error('start failed'); } };
    if (made === 2) return { ...bridge, onState: () => { throw new Error('hook failed'); } };
    return bridge;
  };
  const service = host.createService({ createBridge });
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  assert.ok(made >= 3);
  await pause(50);
  assert.equal(host.liveMemberChildren().length, 1, 'the bridge of the failed attempt is gone');
});

test('a stream the host does not open is not online, and the backoff grows', async (t) => {
  const { host, me } = await savedMember(t);
  // Bootstrap and registration still work; the event stream is refused (forbidden, not 200).
  host.env.context.clients.authorize = () => false;
  const timers = countingTimers();
  const from = host.states.length;
  const service = host.createService({ timers });
  await service.startExisting();
  assert.ok(await waitUntil(() => timers.delays.length >= 3, { attempts: 100, interval: 20 }), `delays ${timers.delays}`);
  assert.equal(statesOf(host, me.teamId, from).includes('online'), false, 'never online without the stream');
  assert.ok(statesOf(host, me.teamId, from).includes('reconnecting'));
  // A host that greets and then fails is not redialled at the first delay forever.
  assert.ok(Math.max(...timers.delays) >= 32, `the backoff grows: ${timers.delays}`);
});

test('a refused client registration is a lost connection that is retried with backoff', async (t) => {
  const { host, me } = await savedMember(t);
  host.env.context.clients.register = () => null;
  const timers = countingTimers();
  const from = host.states.length;
  const spawns = host.memberSpawner.spawns.length;
  const service = host.createService({ timers });
  await service.startExisting();
  assert.ok(await waitUntil(() => host.memberSpawner.spawns.length >= spawns + 3), 'it keeps retrying');
  assert.equal(statesOf(host, me.teamId, from).includes('online'), false);
  assert.ok(Math.max(...timers.delays) >= 32, `the backoff grows: ${timers.delays}`);
});

// The host bridge (the fake child as the binary) refuses a refused key again for its cooldown without asking: the
// member's confirming dial must come after it (review round two, R11-F01). Both sides get a short cooldown here.
// `oldHost`: a host bridge from before round two, which says `host_refused` for its cooldown and admit timeout.
const COOLDOWN_MS = 300;
const cooled = (host, oldHost = false) => {
  Object.assign(host.hostSpawner.options, { refusedCooldownMs: COOLDOWN_MS, oldHost });
  return { refusedCooldownMs: COOLDOWN_MS };
};
const HOSTS = [['this round host bridge', false], ['a host bridge from before round two', true]];

for (const [hostKind, oldHost] of HOSTS) {
  test(`a transient refusal of a known key reconnects and does not end in revoked (${hostKind})`, async (t) => {
    const { host, me } = await savedMember(t);
    const service = host.createService(cooled(host, oldHost));
    await service.startExisting();
    await host.waitForState(me.teamId, 'online');
    const from = host.states.length;
    await host.stopHostBridge();
    await host.waitForState(me.teamId, 'offline');
    host.refuseNextAdmits = 1;
    await host.startHostBridge();
    await host.waitForState(me.teamId, 'online');
    assert.equal(host.refuseNextAdmits, 0, 'the refusal was seen');
    assert.equal(statesOf(host, me.teamId, from).includes('revoked'), false);
    assert.notEqual(loadClientFile(host.userData, me.teamId).record.state_seen, 'revoked');
  });

  test(`a key the host keeps refusing is revoked, and only past the cooldown (${hostKind})`, async (t) => {
    const { host, owner, me } = await savedMember(t);
    const service = host.createService(cooled(host, oldHost));
    await service.startExisting();
    await host.waitForState(me.teamId, 'online');
    await host.stopHostBridge();
    await host.waitForState(me.teamId, 'offline');
    // Revoked while the host bridge was down: no connection to drop, so every later dial is refused.
    assert.equal((await host.env.store.revokeMember({ actorMemberId: owner.member_id, memberId: me.member_id })).ok, true);
    const before = Date.now();
    await host.startHostBridge();
    await host.waitForState(me.teamId, 'revoked', { attempts: 200 });
    assert.ok(Date.now() - before >= COOLDOWN_MS, 'not before the bridge would ask the host again');
    assert.equal(loadClientFile(host.userData, me.teamId).record.state_seen, 'revoked');
  });
}

test('a leave whose answer is lost while the device is still admitted is unconfirmed and keeps everything', async (t) => {
  const { host, me } = await savedMember(t);
  host.env.store.leave = () => new Promise(() => {});
  const service = host.createService({ requestTimeoutMs: 300 });
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  const files = JSON.stringify(host.files());
  const left = await service.handle('leave', { team_id: me.teamId });
  assert.equal(left.ok, false);
  assert.equal(left.error.reason, 'team_change_unconfirmed');
  assert.equal(host.secureStore.values.size, 1, 'the key is kept');
  assert.equal(JSON.stringify(host.files()), files, 'the client file is kept');
  assert.equal((await service.handle('status')).teams.length, 1);
});

test('one refusal on the probe after a lost leave answer is not proof: unconfirmed, nothing deleted', async (t) => {
  const { host, me } = await savedMember(t);
  // The leave never commits; the probe's first dial is refused once, the second is admitted.
  host.env.store.leave = () => { host.refuseNextAdmits = 1; return new Promise(() => {}); };
  const service = host.createService({ requestTimeoutMs: 300, ...cooled(host) });
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  const left = await service.handle('leave', { team_id: me.teamId });
  assert.equal(left.ok, false, JSON.stringify(left));
  assert.equal(left.error.reason, 'team_change_unconfirmed');
  assert.equal(host.refuseNextAdmits, 0);
  assert.equal(host.secureStore.values.size, 1);
  assert.equal(loadClientFile(host.userData, me.teamId).ok, true);
});

test('an own-device revoke racing removeTeam writes nothing after the removal', async (t) => {
  const { host, me } = await savedMember(t);
  const service = host.createService();
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  // The revoke commits (the host drops the key, so its answer is lost); the probe's dial is held.
  const revokeDevice = host.env.store.revokeDevice.bind(host.env.store);
  host.env.store.revokeDevice = (input) => { host.holdDials(); return revokeDevice(input); };
  const dials = host.reach.dials.length;
  const revoking = service.handle('deviceRevoke', { team_id: me.teamId, device_id: me.device_id });
  assert.ok(await waitUntil(() => host.reach.dials.length > dials), 'the probe is dialling');
  assert.deepEqual(await service.handle('removeTeam', { team_id: me.teamId }), { ok: true });
  host.releaseDials();
  await revoking;
  await pause(200);
  assert.deepEqual(host.files(), [], 'no client file written after the removal');
  assert.equal(host.secureStore.values.size, 0);
  assert.equal(host.liveMemberChildren().length, 0);
});

test('a second start while an attempt is in flight leaves one connection and no churn', async (t) => {
  const { host, me } = await savedMember(t);
  const record = loadClientFile(host.userData, me.teamId).record;
  let pushes = 0;
  const manager = createConnectionManager({
    record, deviceKeys: createDeviceKeyStore({ getSecureStore: () => host.secureStore }),
    saveRecord: (next) => saveClientFile(host.userData, next), onChange: () => { pushes += 1; },
    spawnChild: host.memberSpawner, appVersion: '1.6.1', backoff: { initialMs: 20, maxMs: 80 },
  });
  t.after(() => manager.stop());
  const spawns = host.memberSpawner.spawns.length;
  manager.start();
  manager.start();
  assert.ok(await waitUntil(() => manager.snapshot().state === 'online'));
  await pause(200);
  assert.equal(manager.snapshot().state, 'online');
  assert.equal(host.memberSpawner.spawns.length, spawns + 2, 'the stale attempt is not retried');
  assert.equal(host.liveMemberChildren().length, 1, 'the stale attempt closed its bridge');
  assert.ok(pushes > 0);
});

test('concurrent commands after the host forgot the client share one new registration', async (t) => {
  const { host, me } = await savedMember(t);
  const service = host.createService();
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  host.env.context.clients.revokeDevice(me.device_id);
  const register = host.env.context.clients.register.bind(host.env.context.clients);
  let registrations = 0;
  host.env.context.clients.register = (deviceId) => { registrations += 1; return register(deviceId); };
  const answers = await Promise.all([
    service.handle('members', { team_id: me.teamId }),
    service.handle('deviceList', { team_id: me.teamId }),
  ]);
  assert.deepEqual(answers.map((answer) => answer.ok), [true, true], JSON.stringify(answers));
  assert.equal(registrations, 1);
});

test('the pending poll does not push or log an unchanged state again', async (t) => {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const service = host.createService();
  const me = await joinAs(host, service, { owner, admit: false });
  await host.waitForState(me.teamId, 'pending');
  const pushes = host.states.length;
  const lines = host.logs.filter((line) => line.event === 'team.connection.state').length;
  await pause(250);
  assert.equal(host.states.length, pushes, 'no repeated snapshot');
  assert.equal(host.logs.filter((line) => line.event === 'team.connection.state').length, lines);
  // A changed fact still pushes: the owner renames the team.
  assert.equal((await host.env.store.rename({ actorMemberId: owner.member_id, name: 'Calm Harbour' })).ok, true);
  assert.ok(await waitUntil(() => host.lastState(me.teamId).team_name === 'Calm Harbour'));
});

// A service whose member bridges' stop can be held open: `hold()` arms it, `stopping` resolves when an
// armed stop is called, `release()` lets it finish.
function holdableStops() {
  let gate = null;
  let release = () => {};
  let called = () => {};
  const control = {
    stopping: null,
    hold() {
      gate = new Promise((resolve) => { release = resolve; });
      control.stopping = new Promise((resolve) => { called = resolve; });
    },
    release() { const open = release; gate = null; open(); },
    createBridge(options) {
      const bridge = createMemberBridge(options);
      const wrapped = Object.create(bridge);
      wrapped.stop = () => {
        if (!gate) return bridge.stop();
        called();
        return gate.then(() => bridge.stop());
      };
      return wrapped;
    },
  };
  return control;
}

// Slice 5-3 review item 1. Fault: removeTeam or leave running while a pasted reconnect code replaces
// the team's manager, so the key and token are deleted (or the host leave sent) and a manager comes
// back with no key, or the local membership outlives the host leave.
for (const method of ['removeTeam', 'leave']) {
  test(`${method} for a team whose manager a reconnect code is replacing is refused and changes nothing`, async (t) => {
    const { host, me } = await savedMember(t);
    const stops = holdableStops();
    const service = host.createService({ createBridge: (options) => stops.createBridge(options) });
    await service.startExisting();
    await host.waitForState(me.teamId, 'online');
    const record = loadClientFile(host.userData, me.teamId).record;
    const key = host.secureStore.values.get(deviceKeyName(me.teamId));
    const code = encodeReconnectCode({ hostPublicKey: record.host_public_key, hints: record.address_hints }).code;
    stops.hold();
    // On a failure the refused call may still wait on the held stop: release it, then stop the service.
    t.after(async () => { stops.release(); await service.stopAll(); });
    const reconnecting = service.handle('teamReconnectCode', { team_id: me.teamId, code });
    await stops.stopping;
    // Raced against a pause: a removal that is not refused waits on the held stop.
    const refused = await Promise.race([service.handle(method, { team_id: me.teamId }),
      pause(500).then(() => ({ pending: true }))]);
    assert.equal(refused.error?.reason, 'team_join_in_progress', JSON.stringify(refused));
    assert.equal(host.secureStore.values.get(deviceKeyName(me.teamId)), key, 'the key is still stored');
    stops.release();
    assert.equal((await reconnecting).ok, true);
    await host.waitForState(me.teamId, 'online');
    assert.equal(host.secureStore.values.get(deviceKeyName(me.teamId)), key);
    assert.equal(loadClientFile(host.userData, me.teamId).ok, true);
    const member = host.env.store.snapshot().members.find((entry) => entry.member_id === me.member_id);
    assert.equal(member.state, 'active', 'no host leave was sent');
    await service.stopAll();
  });
}

// ---------------------------------------------------------------- member-side saved-team fixes

// An owner online with chat, whose outbox holds an entry the device already sent once and one never sent.
async function ownerWithOutbox(t) {
  const host = await createTeamClientHost(t);
  await attachTeamChat(t, host);
  const service = host.createService();
  const me = await joinAs(host, service, { name: 'Olive Owner' });
  await host.waitForState(me.teamId, 'online');
  assert.equal(saveChatState(host.userData, me.teamId, { drafts: [], outbox: [queued(1, true), queued(2, false)] }).ok, true);
  return { host, service, me, file: clientFilePath(host.userData, me.teamId) };
}

const failures = (host, teamId) => loadChatState(host.userData, teamId).outbox.map((item) => item.failed?.reason || null);

// Fault: the record and the marks written apart (two writes), or the marks skipped when the
// service stops right after the record was written, so the restarted service resends what the old device sent.
test('an accepted recovery is one write of the new device and the marks, also when stopped at that write', async (t) => {
  const { host, service, me, file } = await ownerWithOutbox(t);
  const counted = watchWrites(t, file);
  const first = await recover(host, service);
  counted.restore();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(counted.count, 1, 'one write of client.json');
  assert.notEqual(loadClientFile(host.userData, me.teamId).record.device_id, me.device_id);
  assert.deepEqual(failures(host, me.teamId), ['team_chat_outbox_unconfirmed', null]);
  await host.waitForState(me.teamId, 'online');
  await service.stopAll();

  // Again, with the service stopped at the write: the marks are in that write.
  const second = host.createService();
  await second.startExisting();
  await host.waitForState(me.teamId, 'online');
  assert.equal(saveChatState(host.userData, me.teamId, { drafts: [], outbox: [queued(3, true), queued(4, false)] }).ok, true);
  const before = loadClientFile(host.userData, me.teamId).record.device_id;
  const stopping = watchWrites(t, file, (count) => { if (count === 1) void second.stopAll(); });
  const answer = await recover(host, second);
  stopping.restore();
  assert.equal(answer.error?.reason, 'team_connection_stopped', JSON.stringify(answer));
  assert.equal(stopping.count, 1);
  assert.notEqual(loadClientFile(host.userData, me.teamId).record.device_id, before, 'the new device is saved');
  assert.deepEqual(failures(host, me.teamId), ['team_chat_outbox_unconfirmed', null]);
  const commands = host.env.commandsSeen.length;
  const third = host.createService();
  await third.startExisting();
  await host.waitForState(me.teamId, 'online');
  const sent = () => host.env.commandsSeen.slice(commands).map((command) => command.request_id);
  assert.ok(await waitUntil(() => sent().includes('req_4')), 'the entry never sent still goes');
  assert.equal(sent().includes('req_3'), false, 'the entry the old device sent is never resent');
});

// Fault: a failed one-write answered as a success, or with a reason other than today's.
test('a recovery whose one write fails answers team_recover_local_save_failed', async (t) => {
  const { host, service, file } = await ownerWithOutbox(t);
  const failing = watchWrites(t, file);
  failing.fail = true;
  const answer = await recover(host, service);
  failing.restore();
  assert.equal(answer.error?.reason, 'team_recover_local_save_failed', JSON.stringify(answer));
});

// Fault: a recover, a reconnect code or a join running while a removal or a leave of that team is
// awaiting, so it writes a key or a file the removal then deletes (or that outlives it).
for (const method of ['removeTeam', 'leave']) {
  test(`a recover, a reconnect code and a join wait out a held ${method} of that team`, async (t) => {
    const { host, owner, me } = await savedMember(t);
    const stops = holdableStops();
    const service = host.createService({ createBridge: (options) => stops.createBridge(options), ...cooled(host) });
    await service.startExisting();
    await host.waitForState(me.teamId, 'online');
    const record = loadClientFile(host.userData, me.teamId).record;
    const code = encodeReconnectCode({ hostPublicKey: record.host_public_key, hints: record.address_hints }).code;
    const { invite } = await host.invite({ actor: owner.member_id });
    const recovery = (await host.invite({ kind: 'recovery' })).invite;
    let release = () => {};
    let reached;
    if (method === 'removeTeam') {
      stops.hold();
      reached = stops.stopping;
      release = () => stops.release();
    } else {
      const leave = host.env.store.leave.bind(host.env.store);
      const gate = new Promise((resolve) => { release = resolve; });
      reached = new Promise((resolve) => {
        host.env.store.leave = async (input) => { resolve(); await gate; return leave(input); };
      });
    }
    t.after(async () => { release(); await service.stopAll(); });
    const running = service.handle(method, { team_id: me.teamId });
    await reached;
    const files = host.files();
    const keys = [...host.secureStore.values.entries()];
    const redeems = host.env.redeemCalls.length;
    const raced = (call) => Promise.race([call, pause(500).then(() => ({ pending: true }))]);
    const answers = [
      await raced(service.ownerRecover({ invite: recovery, display_name: 'Mika Member', label: 'Laptop' })),
      await raced(service.handle('teamReconnectCode', { team_id: me.teamId, code })),
      await raced(service.handle('join', { invite, display_name: 'Mika Again', label: 'Laptop' })),
    ];
    assert.deepEqual(answers.map((answer) => answer.error?.reason || JSON.stringify(answer)),
      ['team_join_in_progress', 'team_join_in_progress', 'team_join_in_progress']);
    assert.deepEqual(host.files(), files, 'no file written');
    assert.deepEqual([...host.secureStore.values.entries()], keys, 'no key written');
    assert.equal(host.env.redeemCalls.length, redeems, 'nothing redeemed');
    release();
    assert.deepEqual(await running, { ok: true });
    const again = await service.handle('join', { invite, display_name: 'Mika Again', label: 'Laptop' });
    assert.equal(again.ok, true, `admitted again after the ${method}: ${JSON.stringify(again)}`);
  });
}

// Fault: a held team that was stopped and has no manager afterwards drops out of status while its directory
// and key stay (E47): a reconnect code whose write finds the file unreadable after the stop, or a recovery
// whose one write failed. Each must end as one needs_repair row that Remove clears and Reclaim still reaches.
test('a reconnect code whose write finds the file unreadable after the stop leaves a needs_repair row', async (t) => {
  const { host, me } = await savedMember(t);
  const file = clientFilePath(host.userData, me.teamId);
  const stops = holdableStops();
  const service = host.createService({ createBridge: (options) => stops.createBridge(options) });
  await service.startExisting();
  await host.waitForState(me.teamId, 'online');
  const record = loadClientFile(host.userData, me.teamId).record;
  const code = encodeReconnectCode({ hostPublicKey: record.host_public_key, hints: record.address_hints }).code;
  stops.hold();
  t.after(async () => { stops.release(); await service.stopAll(); });
  const reconnecting = service.handle('teamReconnectCode', { team_id: me.teamId, code });
  await stops.stopping;
  fs.writeFileSync(file, '{broken');
  stops.release();
  const answer = await reconnecting;
  assert.equal(answer.ok, false, JSON.stringify(answer));
  const row = { team_id: me.teamId, state: 'needs_repair', reason: 'team_client_invalid' };
  assert.deepEqual((await service.handle('status')).teams, [row]);
  assert.deepEqual(host.states.at(-1).teams, [row]);
  const redeems = host.env.redeemCalls.length;
  assert.equal((await recover(host, service)).error?.reason, 'team_client_invalid', 'Reclaim is admitted, then refused by the file');
  assert.equal(host.env.redeemCalls.length, redeems);
  assert.deepEqual(await service.handle('removeTeam', { team_id: me.teamId }), { ok: true });
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.equal(host.secureStore.values.has(deviceKeyName(me.teamId)), false);
});

test('a recovery whose one write failed leaves a needs_repair row a status never starts; Reclaim and Remove work', async (t) => {
  const { host, service, me, file } = await ownerWithOutbox(t);
  const failing = watchWrites(t, file);
  failing.fail = true;
  assert.equal((await recover(host, service)).error?.reason, 'team_recover_local_save_failed');
  const row = { team_id: me.teamId, state: 'needs_repair', reason: 'team_recover_local_save_failed' };
  assert.deepEqual((await service.handle('status')).teams, [row]);
  assert.deepEqual((await service.handle('status')).teams, [row], 'the old file loads, but nothing starts the revoked device');
  assert.equal(service.resources().managers, 0);
  const redeems = host.env.redeemCalls.length;
  assert.equal((await recover(host, service)).error?.reason, 'team_recover_local_save_failed', 'Reclaim is admitted again');
  assert.equal(host.env.redeemCalls.length, redeems + 1);
  assert.deepEqual((await service.handle('status')).teams, [row]);
  failing.restore();
  assert.deepEqual(await service.handle('removeTeam', { team_id: me.teamId }), { ok: true });
  assert.equal(fs.existsSync(path.dirname(file)), false);
  assert.equal(host.secureStore.values.has(deviceKeyName(me.teamId)), false);
});

// Fault: a recovery refused before the redeem (here: the secure store is unavailable) leaves the held team
// stopped, with no manager, until the next start.
test('a recovery refused before the redeem brings the held manager back from its file', async (t) => {
  const { host, service, me } = await ownerWithOutbox(t);
  const redeems = host.env.redeemCalls.length;
  host.secureStore.status = 'unavailable';
  const answer = await recover(host, service);
  host.secureStore.status = 'ready';
  assert.equal(answer.error?.reason, 'team_device_key_unavailable', JSON.stringify(answer));
  assert.equal(host.env.redeemCalls.length, redeems, 'nothing redeemed');
  assert.equal(service.resources().managers, 1, 'the manager is back');
  assert.deepEqual((await service.handle('status')).teams.map((team) => [team.team_id, team.device_id]),
    [[me.teamId, me.device_id]]);
  await host.waitForState(me.teamId, 'online');
});

// Fault: a stop after the host accepted a recovery and before its write skips the write, so the key this
// device keeps is the new one while the file still names the old (revoked) device.
test('a stop after the host accepted a recovery and before its write still writes the new device', async (t) => {
  const { host, service, me, file } = await ownerWithOutbox(t);
  const set = host.secureStore.set;
  host.secureStore.set = (key, value) => {
    if (key === deviceKeyName(me.teamId)) { host.secureStore.set = set; void service.stopAll(); }
    return set(key, value);
  };
  t.after(() => { host.secureStore.set = set; });
  const counted = watchWrites(t, file);
  const answer = await recover(host, service);
  assert.equal(answer.error?.reason, 'team_connection_stopped', JSON.stringify(answer));
  assert.equal(counted.count, 1, 'the one write happened');
  assert.notEqual(loadClientFile(host.userData, me.teamId).record.device_id, me.device_id);
  assert.deepEqual(failures(host, me.teamId), ['team_chat_outbox_unconfirmed', null]);
});

// ---------------------------------------------------------------- this PC's name on a record saved without it

// A saved team whose file has no label (as one written before it was kept), started again and online.
async function unlabelled(t) {
  const s = await savedTeam(t);
  const { label, ...record } = loadClientFile(s.host.userData, s.me.teamId).record;
  assert.equal(label, 'Laptop', 'the join kept the label');
  assert.equal(saveClientFile(s.host.userData, record).ok, true);
  const service = s.host.createService();
  t.after(() => service.stopAll());
  await service.startExisting();
  const row = () => service.snapshot().teams.find((team) => team.team_id === s.me.teamId);
  assert.ok(await waitUntil(() => row()?.state === 'online'), 'online again');
  const call = (method) => service.handle(method, { team_id: s.me.teamId });
  const saved = () => loadClientFile(s.host.userData, s.me.teamId).record;
  const tries = () => s.host.logs.filter((line) => line.event === 'team.label.repaired');
  return { ...s, row, call, saved, tries };
}

// Fault: a membership saved before the label was kept asks for this PC's name after every restart.
test("a device list answer with this device's row repairs a saved record without a label, once", async (t) => {
  const s = await unlabelled(t);
  assert.equal(s.row().label, null, 'no label on the row before the repair');
  const writes = watchWrites(t, s.file);
  const before = s.host.env.commandsSeen.length;
  const listed = await s.call('deviceList');
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(s.host.env.commandsSeen.slice(before).map((seen) => seen.operation), ['team.device.list'], 'no call of its own');
  assert.equal(writes.count, 1, 'one write');
  assert.deepEqual([s.saved().label, s.row().label], ['Laptop', 'Laptop'], 'saved, and on the team row');
  assert.ok(s.host.states.at(-1).teams.some((team) => team.label === 'Laptop'), 'and pushed');
  assert.equal((await s.call('deviceList')).ok, true);
  assert.equal(writes.count, 1, 'a second answer writes nothing');
  assert.equal(JSON.stringify(s.host.logs).includes('Laptop'), false, 'no name in the logs');
});

// Fault: another device's or another member's row taken as this PC's name.
test("a row for another device or another member repairs nothing, nor does a refused answer", async (t) => {
  const s = await unlabelled(t);
  const writes = watchWrites(t, s.file);
  const real = deviceListView(s.host.env.store.snapshot(), { memberId: s.me.member_id, owner: true });
  const mine = real.find((device) => device.device_id === s.me.device_id);
  for (const devices of [
    [{ ...mine, device_id: 'device_otherZZZ999', label: 'Not this PC' }],
    [{ ...mine, member_id: 'member_otherZZZ999', label: 'Not this PC' }],
    // adminAnswer refuses these whole answers: they prove only that a refused answer repairs nothing.
    [{ ...mine, label: ' padded ' }],
    [{ ...mine, label: 'a'.repeat(41) }],
  ]) {
    s.host.env.commandHook = (command) => (command?.operation === 'team.device.list'
      ? { ok: true, devices, request_id: command.request_id } : null);
    await s.call('deviceList');
  }
  s.host.env.commandHook = null;
  assert.deepEqual([writes.count, s.tries().length, Object.hasOwn(s.saved(), 'label'), s.row().label], [0, 0, false, null]);
});

// Fault: a repair whose save fails tried again, with a warning, on every later device list answer.
test('a repair whose save fails is tried once per connection manager', async (t) => {
  const s = await unlabelled(t);
  const writes = watchWrites(t, s.file);
  writes.fail = true;
  assert.equal((await s.call('deviceList')).ok, true);
  assert.equal((await s.call('deviceList')).ok, true);
  writes.fail = false;
  assert.deepEqual(s.tries().map((line) => [line.level, line.fields.ok, line.fields.reason]),
    [['WARN', false, 'team_client_write_failed']], 'one attempt, one warning');
  assert.equal(Object.hasOwn(s.saved(), 'label'), false);
});
