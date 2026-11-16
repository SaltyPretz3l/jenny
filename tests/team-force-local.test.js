'use strict';

// Force local means no team networking (row 123, owner decision E64): while the mode is on no connection manager
// is built or kept, GPU sharing is paused without a write, the engine port stops with the chosen team model still
// chosen, and the calls that dial or send are refused with `team_force_local`; turning it off brings back what this
// hold stopped. The member side through the real registration, team service, team engine and team sharing, with
// fake connection managers and a fake engine port (no socket, no DNS, no child). The host side (the `host` cases at
// the end) over the fake fork: refused routes change no file, a hold stops a running host and its release starts it
// again as Start does, and a host that was not running is not started.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { clientFilePath } = require('../services/team/client-file');
const { sharingFilePath } = require('../services/team/node/sharing-file');
const { createMemorySecureStore, readTree, tempProfile } = require('./helpers/team-client-host');
const { createFakeFork, createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { reasonOf, tick, world } = require('./helpers/team-force-local-world');
const { registerTeam } = require('../services/main/team-registration');
const { createForceLocalHold, forceLocalOn } = require('../services/team/force-local-hold');

const sharingFile = (w, i = 0) => JSON.parse(fs.readFileSync(sharingFilePath(w.dir, w.records[i].team_id), 'utf8'));

test('1. mode on at launch: no manager, no child, no dial; each saved team is a force_local row', async (t) => {
  const w = world(t, { mode: 'local_only' });
  await tick(20);
  assert.equal(w.managers.made.length, 0, 'no manager built');
  assert.deepEqual(w.spawns, [], 'no child forked');
  const status = await w.service().handle('status', {});
  assert.equal(status.ok, true);
  assert.equal(status.force_local, true);
  assert.deepEqual(status.teams.map((row) => [row.team_id, row.state, row.reason]).sort(),
    w.records.map((r) => [r.team_id, 'force_local', 'team_force_local']).sort());
  assert.equal(w.managers.made.length, 0, 'status started nothing');
});

test('2. on: every manager stops, sharing pauses with the file still on, the port closes, the model stays chosen, no timer', async (t) => {
  const w = world(t);
  await tick(20);
  assert.equal(w.managers.live().length, 2);
  assert.equal(w.ports.open(), 2, 'one engine port per online team');
  const teamA = w.records[0].team_id;
  // A live team selection the registration can see (team-engine-models.js liveTeamSelection: openai-compatible).
  Object.assign(w.backend, { currentEngineType: 'openai-compatible', _teamEngineSelection: { teamId: teamA } });
  assert.equal(w.service().snapshot().sharing?.team_id, teamA, 'sharing armed from its file');
  w.events.length = 0;
  await w.flip('local_only');
  assert.equal(w.managers.live().length, 0, 'every manager stopped');
  assert.deepEqual(w.managers.made.map((m) => m.timers), [0, 0], 'no timer of a stopped manager left');
  assert.equal(w.service().resources().managers, 0);
  assert.equal(w.ports.open(), 0, 'engine ports closed');
  assert.deepEqual(w.backend._teamEngineSelection, { teamId: teamA }, 'the chosen team model is still chosen');
  assert.deepEqual(sharingFile(w), { schema_version: 1, on: true, claim_seq: 7 }, 'sharing.json still says on');
  assert.equal(w.service().snapshot().sharing, null, 'sharing ended');
  assert.ok(w.events.includes('host.hold'), 'the host was held too');
  const snap = w.service().snapshot();
  assert.equal(snap.force_local, true);
  assert.deepEqual(snap.teams.map((row) => row.state), ['force_local', 'force_local']);
  assert.deepEqual(snap.teams.map((row) => row.team_name).sort(), ['Team 0', 'Team 1'], 'listed by the names the host gave');
  const refreshed = w.backend.refreshed || 0;
  await w.flip('disabled');
  await tick(20);
  assert.deepEqual(w.backend._teamEngineSelection, { teamId: teamA }, 'still chosen after the release');
  assert.equal(w.ports.open(), 2);
  assert.ok((w.backend.refreshed || 0) > refreshed, 'the chosen team\'s port coming back re-initialized the sidecar');
});

test('3. off again: the host first, then the teams reconnect, sharing re-arms from its file, force_local goes', async (t) => {
  let hostDone = null;
  const w = world(t, { hostRelease: () => new Promise((resolve) => { hostDone = resolve; }) });
  await tick(20);
  await w.flip('local_only');
  w.events.length = 0;
  w.emit('disabled');
  await tick(20);
  assert.deepEqual(w.events, ['host.release'], 'no manager is built while the host release is still running');
  hostDone();
  await w.registered.forceLocalIdle();
  await tick(20);
  assert.equal(w.events[0], 'host.release', 'the host is released before any team');
  assert.deepEqual(w.events.slice(1).sort(), w.records.map((r) => `manager:${r.team_id}`).sort());
  assert.equal(w.managers.live().length, 2);
  assert.equal(w.ports.open(), 2);
  assert.equal(w.service().snapshot().sharing?.team_id, w.records[0].team_id, 'sharing re-armed from sharing.json');
  const snap = w.service().snapshot();
  assert.equal(Object.hasOwn(snap, 'force_local'), false);
  assert.deepEqual(snap.teams.map((row) => row.state), ['online', 'online']);
});

test('3b. a launch held then released starts the saved teams once', async (t) => {
  const w = world(t, { mode: 'local_only' });
  await tick(20);
  await w.flip('disabled');
  await tick(20);
  assert.equal(w.managers.made.length, 2, 'each saved team once');
  assert.deepEqual(w.service().snapshot().teams.map((row) => row.state), ['online', 'online']);
});

test('4. while held: join, reconnect code, host operations, pools and turning sharing on answer team_force_local', async (t) => {
  const w = world(t);
  await tick(20);
  await w.flip('local_only');
  const teamId = w.records[0].team_id;
  const before = fs.readFileSync(clientFilePath(w.dir, teamId), 'utf8');
  const calls = [
    ['join', { invite: 'jteam2_x', display_name: 'Mika', label: 'Desk' }],
    ['teamReconnectCode', { team_id: teamId, code: 'jrc1_x' }],
    ['leave', { team_id: teamId }], ['members', { team_id: teamId }], ['deviceList', { team_id: teamId }],
    ['gpuList', { team_id: teamId }], ['shareSet', { team_id: teamId, on: true }],
  ];
  for (const [method, payload] of calls) {
    assert.equal(reasonOf(await w.service().handle(method, payload)), 'team_force_local', method);
  }
  assert.equal(reasonOf(await w.service().ownerJoin({ invite: 'jteam2_x', display_name: 'O', label: 'D' })), 'team_force_local');
  assert.equal(reasonOf(await w.service().ownerRecover({ invite: 'jteam2_x', display_name: 'O', label: 'D' })), 'team_force_local');
  assert.equal(w.managers.live().length, 0, 'nothing started');
  assert.equal(fs.readFileSync(clientFilePath(w.dir, teamId), 'utf8'), before, 'the saved team is untouched');
  assert.deepEqual(sharingFile(w), { schema_version: 1, on: true, claim_seq: 7 });
});

test('4b. while held a held team can still be removed from this PC: nothing is sent, the membership goes', async (t) => {
  const w = world(t);
  await tick(20);
  await w.flip('local_only');
  const teamId = w.records[1].team_id;
  const answer = await w.service().handle('removeTeam', { team_id: teamId });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(fs.existsSync(clientFilePath(w.dir, teamId)), false);
  assert.deepEqual(w.service().snapshot().teams.map((row) => row.team_id), [w.records[0].team_id]);
  await w.flip('disabled');
  await tick(20);
  assert.equal(w.managers.live().length, 1, 'the removed team does not come back');
});

test('5. status polled while held starts nothing: a needs_repair file that now loads, a deleted-team recheck that is due', async (t) => {
  const w = world(t, { teams: 2 });
  await tick(20);
  // Team 0: the host says it was deleted; its row stays with no manager.
  const deletedId = w.records[0].team_id;
  const first = w.managers.made.find((m) => m.teamId === deletedId);
  for (const listener of first.listeners) listener({ event_type: 'team_deleted', owner_name: 'Olive', deleted_at: 5 });
  await tick(10);
  assert.equal(w.service().snapshot().teams.find((row) => row.team_id === deletedId).state, 'deleted');
  // Team 1: its file breaks, so a restart lists it as needs_repair; then it is fixed again.
  const repairId = w.records[1].team_id;
  const good = fs.readFileSync(clientFilePath(w.dir, repairId), 'utf8');
  await w.flip('local_only');
  fs.writeFileSync(clientFilePath(w.dir, repairId), '{"broken":');
  await w.flip('disabled');
  await tick(10);
  assert.equal(w.service().snapshot().teams.find((row) => row.team_id === repairId).state, 'needs_repair');
  await w.flip('local_only');
  fs.writeFileSync(clientFilePath(w.dir, repairId), good);
  const made = w.managers.made.length;
  w.state.clock += 60 * 60_000;
  for (let i = 0; i < 3; i += 1) assert.equal((await w.service().handle('status', {})).ok, true);
  assert.equal(w.managers.made.length, made, 'no manager started by status');
  assert.equal(w.managers.live().length, 0);
  const rows = w.service().snapshot().teams;
  assert.deepEqual(rows.filter((row) => row.team_id === deletedId).map((row) => row.state), ['deleted'], 'the deleted row is not probed');
  assert.deepEqual(rows.filter((row) => row.team_id === repairId).map((row) => row.state), ['force_local'], 'the fixed file is held, not started');
});

test('6. on, off, on in quick succession, and off while the hold is still stopping: the last mode wins, nothing twice', async () => {
  let mode = 'disabled';
  const steps = [];
  let releaseHostStop = null;
  const gate = createForceLocalHold({ readMode: () => mode });
  gate.attach('host', {
    hold: () => new Promise((resolve) => { steps.push('host.hold'); releaseHostStop = resolve; }),
    release: async () => { steps.push('host.release'); },
  });
  gate.attach('service', { hold: async () => { steps.push('service.hold'); }, release: async () => { steps.push('service.release'); } });
  mode = 'local_only'; void gate.changed();
  mode = 'disabled'; void gate.changed();
  mode = 'local_only'; void gate.changed();
  assert.equal(gate.held(), true, 'starts are refused from the moment the mode reads on');
  await tick();
  assert.deepEqual(steps, ['host.hold', 'service.hold'], 'one hold, not three transitions at once');
  mode = 'disabled'; void gate.changed();
  releaseHostStop();
  await gate.idle();
  await tick();
  assert.deepEqual(steps, ['host.hold', 'service.hold', 'host.release', 'service.release'], 'off during the hold: released once, host first');
  releaseHostStop = null;
  mode = 'local_only'; void gate.changed();
  mode = 'disabled'; void gate.changed();
  releaseHostStop();
  await gate.idle();
  await tick();
  assert.deepEqual(steps.slice(4), ['host.hold', 'service.hold', 'host.release', 'service.release'], 'a hold that began runs to its end, then one release');
});

test('7. fail closed: a read that throws, an unknown word and no reader are all on; the registration gates both parts', async (t) => {
  assert.equal(forceLocalOn(() => { throw new Error('config gone'); }), true);
  assert.equal(forceLocalOn(() => 'sometimes'), true);
  assert.equal(forceLocalOn(() => undefined), true);
  assert.equal(forceLocalOn(null), true);
  assert.equal(forceLocalOn(() => 'local_only'), true);
  assert.equal(forceLocalOn(() => 'disabled'), false);
  const thrown = world(t, { mode: new Error('read failed') });
  await tick(20);
  assert.equal(thrown.managers.made.length, 0, 'a read that throws is held');
  const none = world(t, { reader: false });
  await tick(20);
  assert.equal(none.managers.made.length, 0, 'no reader wired is held');
  await none.handlers.get('team:host-status')({ sender: {} }, undefined);
  assert.equal(typeof none.captured.service.gate?.held, 'function', 'the service gets the gate');
  assert.equal(none.captured.host.gate, none.captured.service.gate, 'the host controller gets the same gate');
  assert.equal(none.captured.host.gate.held(), true);
});

test('8. a changed event under any reason that flips the mode is acted on; one that keeps it does nothing; dispose unsubscribes', async (t) => {
  const w = world(t);
  await tick(20);
  const made = w.managers.made.length;
  for (const reason of ['theme', 'whole_state', 'offline_settings']) {
    w.config.emit('changed', {}, { reason });
    await w.registered.forceLocalIdle();
  }
  await tick();
  assert.equal(w.managers.live().length, 2, 'the same mode: nothing stops');
  assert.equal(w.managers.made.length, made, 'and nothing restarts');
  await w.flip('local_only', 'appearance');
  assert.equal(w.managers.live().length, 0, 'another reason that flips the mode is acted on');
  assert.equal(w.config.listenerCount('changed'), 1);
  await w.shutdown[0]();
  assert.equal(w.config.listenerCount('changed'), 0, 'the listener goes with dispose');
});

test('8b. with no team data nothing under services/team loads for a changed event', async (t) => {
  const dir = tempProfile(t, 'jenny-force-local-empty-');
  const config = new EventEmitter();
  const teamDir = path.join(path.resolve(__dirname, '..'), 'services', 'team') + path.sep;
  for (const file of Object.keys(require.cache)) if (file.startsWith(teamDir)) delete require.cache[file];
  const backend = new EventEmitter();
  Object.assign(backend, { featureFlags: { team: true }, getBackendStatus: () => ({ phase: 'ready' }) });
  const shutdown = [];
  registerTeam({ handle: () => {} }, { featureFlags: { team: true }, backendService: backend, userDataPath: dir,
    readOfflineMode: () => 'local_only', subscribeConfig: (fn) => { config.on('changed', fn); return () => config.off('changed', fn); },
    getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }) });
  config.emit('changed', {}, { reason: 'x' });
  await tick(20);
  assert.deepEqual(Object.keys(require.cache).filter((file) => file.startsWith(teamDir)), []);
  await shutdown[0]();
  assert.equal(config.listenerCount('changed'), 0);
});

// Lockdown has no path to the gate: it is a chat's own preference in the session store (backend-sessions.js), and
// session-lockdown-gate.js reads neither the shell config nor the offline mode. What this pins is the gate's side.
test('11. a saved config change of any shape that keeps the mode off leaves the team connected', async (t) => {
  const w = world(t);
  await tick(20);
  w.config.emit('changed', { sessions: { chat_1: { lockdown: true } }, offlineIntelligence: { mode: 'disabled' } }, { reason: 'session_lockdown' });
  await w.registered.forceLocalIdle();
  await tick();
  assert.equal(w.managers.live().length, 2, 'the team stays up for other chats and other members');
  assert.equal(w.service().snapshot().force_local, undefined);
});

// ---------------------------------------------------------------- the team host this Jenny runs

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });

// A deployed host behind a gate whose mode the test flips; `running` leaves it running after Deploy.
async function hostWorld(t, { running = true } = {}) {
  const userDataPath = tempProfile(t, 'jenny-force-local-host-');
  const state = { mode: 'disabled' };
  const gate = createForceLocalHold({ readMode: () => state.mode });
  const fake = createFakeFork({ script: healthyHostScript({ teamId: 'team_x' }) });
  const made = createTestHostController(t, { userDataPath, secureStore: createMemorySecureStore(), fork: fake.fork, gate });
  gate.attach('host', { hold: () => made.controller.holdForceLocal(), release: () => made.controller.releaseForceLocal() });
  assert.equal((await made.controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  if (!running) assert.equal((await made.controller.handle('hostStop', {})).ok, true);
  const hostFlip = async (mode) => { state.mode = mode; await gate.changed(); await tick(20); };
  const hostState = async () => (await made.controller.handle('hostStatus', undefined)).host;
  return { ...made, fake, gate, state, hostFlip, hostState, userDataPath };
}

test('host 4. while held: Deploy, Recover, internet, Restore and Start a new team answer team_force_local and change no file', async (t) => {
  const w = await hostWorld(t, { running: false });
  await w.hostFlip('local_only');
  const forks = w.fake.calls.length;
  const before = readTree(w.userDataPath);
  const calls = [
    ['hostDeploy', { ...DEPLOY }], ['hostRecover', { display_name: 'Olive Owner', label: 'Desk' }],
    ['hostInternet', { enabled: true, public_address: 'team.example.org', relay_url: '', token: '' }],
    ['hostRestore', { password: 'a long password', display_name: 'Olive Owner', label: 'Desk' }],
    ['hostStartNew', { ...DEPLOY }],
  ];
  for (const [method, payload] of calls) {
    const answer = await w.controller.handle(method, payload);
    assert.equal(answer.error?.reason, 'team_force_local', `${method}: ${JSON.stringify(answer)}`);
  }
  assert.deepEqual(readTree(w.userDataPath), before, 'nothing on disk changed');
  assert.equal(w.fake.calls.length, forks, 'nothing forked');
  const state = await w.hostState();
  assert.equal(state.force_local, true);
  assert.equal(state.state, 'stopped');
  assert.equal((await w.controller.handle('hostStop', {})).ok, true, 'Stop still answers');
});

test('host 2/3. a running host stops on hold and starts again on release, as Start does', async (t) => {
  const w = await hostWorld(t);
  assert.equal((await w.hostState()).state, 'running');
  const forks = w.fake.calls.length;
  await w.hostFlip('local_only');
  assert.equal((await w.hostState()).state, 'stopped', 'the child stopped');
  assert.ok(w.fake.last().exited, 'the child exited');
  assert.equal(w.pushed.at(-1).force_local, true, 'the pushed state says force_local');
  await w.hostFlip('disabled');
  await tick(50);
  const after = await w.hostState();
  assert.equal(after.state, 'running', 'started again');
  assert.equal(Object.hasOwn(after, 'force_local'), false);
  assert.equal(w.fake.calls.length, forks + 1, 'one new child');
});

test('host 3. a host that was not running when the hold began is not started at release', async (t) => {
  const w = await hostWorld(t, { running: false });
  const forks = w.fake.calls.length;
  await w.hostFlip('local_only');
  await w.hostFlip('disabled');
  await tick(50);
  assert.equal((await w.hostState()).state, 'stopped');
  assert.equal(w.fake.calls.length, forks, 'no child');
});

test('host 6. off while the hold is still stopping the host: it ends running, started once', async (t) => {
  const w = await hostWorld(t);
  const forks = w.fake.calls.length;
  w.state.mode = 'local_only';
  const holding = w.gate.changed();
  w.state.mode = 'disabled';
  void w.gate.changed();
  await holding;
  await w.gate.idle();
  await tick(50);
  assert.equal((await w.hostState()).state, 'running');
  assert.equal(w.fake.calls.length, forks + 1, 'started again exactly once');
});
