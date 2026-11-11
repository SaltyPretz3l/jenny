'use strict';

// Connection manager lifecycle (slice 1f-1 review fixes) against the real host
// routes and member store, through the real bridge supervisors and the fake
// bridge child: stop ends a dial in progress and every probe, nothing is written
// after a team is removed, a bridge that throws is retried, online means the
// event stream is open, the backoff starts over only once a connection held, a
// refusal is confirmed before it counts, one client registration is shared, and
// an unchanged state is not pushed again.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemberBridge } = require('../services/team/transport/member-bridge');
const { createConnectionManager } = require('../services/team/connection-manager');
const { createDeviceKeyStore } = require('../services/team/device-key-store');
const { loadClientFile, saveClientFile } = require('../services/team/client-file');
const { createTeamClientHost, joinAs, pause, waitUntil } = require('./helpers/team-client-host');

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

// A member who joined and was admitted, with the first service stopped again.
async function savedMember(t) {
  const host = await createTeamClientHost(t);
  const owner = await host.ownerDirect();
  const first = host.createService();
  const me = await joinAs(host, first, { owner });
  await host.waitForState(me.teamId, 'online');
  await first.stopAll();
  return { host, owner, me };
}

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

test('a transient refusal of a known key reconnects and does not end in revoked', async (t) => {
  const { host, me } = await savedMember(t);
  const service = host.createService();
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
});

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
  const service = host.createService({ requestTimeoutMs: 300 });
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
