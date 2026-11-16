'use strict';

// Force local's transitions (row 123, owner decision E64; review fix list items 1 to 6 and 15 to 17): a join or a
// recovery dialling when the mode turns on, a host start a hold meets during a release, on, off, on while a hold is
// still stopping, a hold step that throws, fails or never finishes, the host's "it was running" memory across a cut
// release, the start paths no other case reaches, and the host release with the real team service. The member side
// runs over the real team host of the client tests or the fake managers of the Force local world; the host side over
// the fake fork.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { clientFilePath, loadClientFile, saveClientFile } = require('../services/team/client-file');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { parseInvite } = require('../server/team/invites');
const { createTeamClientHost, createMemorySecureStore, joinAs, readTree, tempProfile, waitUntil } = require('./helpers/team-client-host');
const { BOUNDS, createFakeFork, createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { fakeManagers, reasonOf, savedRecord, tick, world } = require('./helpers/team-force-local-world');
const { createForceLocalHold } = require('../services/team/force-local-hold');
const { RECHECK_MS } = require('../services/team/team-deleted');
const { registerTeam } = require('../services/main/team-registration');

const keyName = (teamId) => `team_device_key:${teamId}`;

// ---------------------------------------------------------------- the gate

test('6. a hold step that never finishes is bounded and tried three times, then logged; the gate still releases', async () => {
  let mode = 'disabled';
  const logs = [];
  const steps = [];
  const gate = createForceLocalHold({ readMode: () => mode, holdMs: 20, releaseMs: 20, log: (level, event, fields) => logs.push([level, event, fields]) });
  gate.attach('host', { hold: () => { steps.push('host.hold'); return new Promise(() => {}); }, release: async () => { steps.push('host.release'); } });
  gate.attach('service', { hold: async () => { steps.push('service.hold'); }, release: async () => { steps.push('service.release'); } });
  mode = 'local_only';
  await Promise.race([gate.changed(), tick(1000)]);
  assert.equal(steps.filter((step) => step === 'host.hold').length, 3, 'tried three times');
  assert.equal(logs.filter(([, event]) => event === 'team.force_local.step_timeout').length, 3);
  assert.deepEqual(logs.filter(([, event]) => event === 'team.force_local.hold_failed'), [['ERROR', 'team.force_local.hold_failed', { part: 'host' }]]);
  mode = 'disabled';
  await Promise.race([gate.changed(), tick(1000)]);
  assert.deepEqual(steps.slice(-2), ['host.release', 'service.release'], 'the gate is not pinned');
});

// ---------------------------------------------------------------- the team service

test('3. on, off, on while the hold is still stopping: a manager started in the off gap is stopped too', async (t) => {
  const w = world(t, { teams: 3, sharingOn: false });
  const fixedPath = clientFilePath(w.dir, w.records[2].team_id);
  const good = fs.readFileSync(fixedPath, 'utf8');
  fs.writeFileSync(fixedPath, '{"broken":'); // read as needs_repair by the launch
  await tick(20);
  assert.equal(w.managers.live().length, 2);
  let releaseStop = () => {};
  t.after(() => releaseStop());
  w.managers.made[0].stopWith = () => new Promise((resolve) => { releaseStop = resolve; });
  w.emit('local_only');
  await tick();
  w.emit('disabled');
  fs.writeFileSync(fixedPath, good);
  assert.equal((await w.service().handle('status', {})).ok, true);
  assert.equal(w.managers.made.length, 3, 'status started the fixed team in the off gap');
  w.emit('local_only');
  releaseStop();
  await w.registered.forceLocalIdle();
  await tick(20);
  assert.equal(w.managers.live().length, 0, 'every manager stopped, the one from the gap too');
  assert.deepEqual(w.service().snapshot().teams.map((row) => row.state), ['force_local', 'force_local', 'force_local']);
});

test('4. a name that cannot be read and a stop that fails once keep no manager running', async (t) => {
  const w = world(t, { teams: 3, sharingOn: false });
  await tick(20);
  const [first, second] = w.managers.made;
  first.snapshotThrows = true;
  let failures = 0;
  second.stopWith = async () => { if (failures === 0) { failures += 1; throw new Error('stop failed once'); } };
  await w.flip('local_only');
  await tick(20);
  assert.equal(failures, 1);
  assert.equal(w.managers.live().length, 0, 'all three stopped, the failed stop on its second try');
  const rows = w.service().snapshot().teams;
  assert.deepEqual(rows.map((row) => row.state), ['force_local', 'force_local', 'force_local']);
  assert.equal(rows.find((row) => row.team_id === first.teamId).team_name, null, 'a name that could not be read is null');
});

test('15. while held: Remove of a needs_repair row whose file now loads starts nothing and the row is held', async (t) => {
  const w = world(t, { teams: 1, sharingOn: false });
  const [record] = w.records;
  const good = fs.readFileSync(clientFilePath(w.dir, record.team_id), 'utf8');
  fs.writeFileSync(clientFilePath(w.dir, record.team_id), '{"broken":');
  await tick(20);
  assert.equal(w.service().snapshot().teams[0].state, 'needs_repair');
  await w.flip('local_only');
  fs.writeFileSync(clientFilePath(w.dir, record.team_id), good);
  const answer = await w.service().handle('removeTeam', { team_id: record.team_id });
  assert.equal(reasonOf(answer), 'team_join_in_progress', 'the removal is refused: the team is back, held');
  assert.equal(w.managers.made.length, 0, 'no manager');
  assert.deepEqual(w.service().snapshot().teams.map((row) => [row.team_id, row.state]), [[record.team_id, 'force_local']]);
  assert.equal(loadClientFile(w.dir, record.team_id).ok, true, 'its file stays');
});

const deletedNotice = (w, i) => { for (const listener of w.managers.made[i].listeners) listener({ event_type: 'team_deleted', owner_name: 'Olive', deleted_at: 5 }); };

test('21. a deleted row whose recheck probe a hold stops stays one row, the deleted one', async (t) => {
  const w = world(t, { teams: 1, sharingOn: false });
  await tick(20);
  const deletedId = w.records[0].team_id;
  deletedNotice(w, 0);
  await tick(10);
  w.state.clock += RECHECK_MS + 1;
  assert.equal((await w.service().handle('status', {})).ok, true);
  assert.equal(w.managers.live().length, 1, 'the recheck runs a probe');
  await w.flip('local_only');
  assert.equal(w.managers.live().length, 0, 'the hold stops the probe');
  assert.deepEqual(w.service().snapshot().teams.map((row) => [row.team_id, row.state]), [[deletedId, 'deleted']], 'one row, the deleted one');
});

test('15. a held launch with a team marked deleted builds no probe and lists it once; the release probes it', async (t) => {
  const first = world(t, { teams: 2, sharingOn: false });
  await tick(20);
  const deletedId = first.records[0].team_id;
  deletedNotice(first, 0);
  await tick(10);
  await first.shutdown[0]();
  const w = world(t, { dir: first.dir, records: first.records, mode: 'local_only' });
  await tick(20);
  assert.equal(w.managers.made.length, 0, 'no probe while held');
  assert.deepEqual(w.service().snapshot().teams.map((row) => row.team_id).sort(), first.records.map((r) => r.team_id).sort(), 'each team once');
  await w.flip('disabled');
  await tick(20);
  assert.deepEqual(w.managers.made.map((m) => m.teamId).sort(), first.records.map((r) => r.team_id).sort(), 'the marked team probed, the other started');
  assert.ok(w.managers.made.some((m) => m.teamId === deletedId));
});

test('15. a chat call for a held team answers as for a detached team and queues nothing', async (t) => {
  const w = world(t, { teams: 1, sharingOn: false });
  await tick(20);
  await w.flip('local_only');
  const before = readTree(w.dir);
  const answer = await w.service().handle('chatPost', { team_id: w.records[0].team_id, channel_id: 'chan_team', text: 'while held' });
  assert.equal(reasonOf(answer), 'team_not_found');
  assert.deepEqual(readTree(w.dir), before, 'nothing queued or written');
});

test('16. through the registration\'s gate an unknown mode word holds', async (t) => {
  const w = world(t, { mode: 'sometimes' });
  await tick(20);
  assert.equal(w.managers.made.length, 0);
  assert.equal((await w.service().handle('status', {})).force_local, true);
});

// ---------------------------------------------------------------- a join and a recovery dialling (the real team host)

async function liveService(t) {
  const host = await createTeamClientHost(t);
  let mode = 'disabled';
  const gate = createForceLocalHold({ readMode: () => mode });
  const service = host.createService({ gate });
  gate.attach('service', { hold: () => service.holdForceLocal(), release: () => service.releaseForceLocal(),
    interrupt: () => service.interruptForceLocal() });
  const turnOn = async () => { mode = 'local_only'; await gate.changed(); };
  // From the `n`th dial on, every dial waits (the check after a redeem, when n is the redeem's dial plus one).
  const holdFrom = (n) => {
    const push = host.reach.dials.push.bind(host.reach.dials);
    host.reach.dials.push = (...items) => { const count = push(...items); if (count === n) host.holdDials(); return count; };
  };
  return { host, service, gate, turnOn, holdFrom };
}

test('1. a join dialling when the mode turns on: the dial is cut, nothing more is dialled, no key or file is kept', async (t) => {
  const { host, service, turnOn } = await liveService(t);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  host.holdDials();
  const joining = service.handle('join', { invite, display_name: 'Olive Owner', label: 'Desk' });
  assert.ok(await waitUntil(() => host.reach.dials.length === 1), 'the redeem dial is out');
  await turnOn();
  host.releaseDials();
  const answer = await joining;
  assert.equal(reasonOf(answer), 'team_force_local', JSON.stringify(answer));
  await tick(50);
  assert.equal(host.reach.dials.length, 1, 'no dial after the hold');
  assert.equal(host.secureStore.values.has(keyName(teamId)), false, 'no device key');
  assert.equal(fs.existsSync(clientFilePath(host.userData, teamId)), false, 'no client file');
});

test('1c. a join the host accepted before the hold is kept and answers ok with the team held', async (t) => {
  const { host, service, turnOn, holdFrom } = await liveService(t);
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  holdFrom(2);
  const joining = service.handle('join', { invite, display_name: 'Olive Owner', label: 'Desk' });
  assert.ok(await waitUntil(() => host.reach.dials.length === 2), 'redeemed; the check is dialling');
  await turnOn();
  host.releaseDials();
  const answer = await joining;
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual([answer.team.team_id, answer.team.state, answer.team.reason], [teamId, 'force_local', 'team_force_local']);
  assert.equal(loadClientFile(host.userData, teamId).ok, true, 'the membership the host accepted is kept');
  assert.equal(host.secureStore.values.has(keyName(teamId)), true);
  await tick(50);
  assert.equal(host.reach.dials.length, 2, 'nothing dialled after');
  assert.deepEqual(service.snapshot().teams.map((row) => [row.team_id, row.state]), [[teamId, 'force_local']]);
});

async function ownerOnline(t) {
  const live = await liveService(t);
  const owner = await joinAs(live.host, live.service);
  await live.host.waitForState(owner.teamId, 'online');
  return { ...live, owner };
}

test('1. a recovery dialling when the mode turns on: cut, nothing written, the team held from its unchanged file', async (t) => {
  const { host, service, turnOn, owner } = await ownerOnline(t);
  const name = service.snapshot().teams[0].team_name;
  assert.ok(name, 'the host named the team');
  const key = host.secureStore.values.get(keyName(owner.teamId));
  const { invite } = await host.invite({ kind: 'recovery' });
  host.holdDials();
  const dials = host.reach.dials.length;
  const recovering = service.ownerRecover({ invite, display_name: 'Olive Owner', label: 'New desk' });
  assert.ok(await waitUntil(() => host.reach.dials.length > dials), 'the recovery dial is out');
  const out = host.reach.dials.length;
  await turnOn();
  host.releaseDials();
  assert.equal(reasonOf(await recovering), 'team_force_local');
  await tick(50);
  assert.equal(host.reach.dials.length, out, 'no dial after the hold');
  assert.equal(host.secureStore.values.get(keyName(owner.teamId)), key, 'the key is unchanged');
  assert.equal(loadClientFile(host.userData, owner.teamId).record.device_id, owner.device_id, 'the file is unchanged');
  assert.deepEqual(service.snapshot().teams.map((row) => [row.team_id, row.state, row.team_name]), [[owner.teamId, 'force_local', name]]);
});

test('1c. a recovery the host accepted before the hold is kept and answers ok, held under the team\'s name', async (t) => {
  const { host, service, turnOn, holdFrom, owner } = await ownerOnline(t);
  const name = service.snapshot().teams[0].team_name;
  assert.ok(name, 'the host named the team');
  const { invite } = await host.invite({ kind: 'recovery' });
  // The manager stops first (it may still be dialling); the recovery's redeem is the next dial, its check the one after.
  const recovering = service.ownerRecover({ invite, display_name: 'Olive Owner', label: 'New desk' });
  holdFrom(host.reach.dials.length + 2);
  assert.ok(await waitUntil(() => host.reach.gate !== null), 'redeemed; the check is dialling');
  await turnOn();
  host.releaseDials();
  const answer = await recovering;
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual([answer.team.team_id, answer.team.state, answer.team.team_name], [owner.teamId, 'force_local', name]);
  assert.notEqual(loadClientFile(host.userData, owner.teamId).record.device_id, owner.device_id, 'the new device is kept');
});

// ---------------------------------------------------------------- the team host this Jenny runs

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });

// A deployed, running host behind a gate. `ctl.slow` holds a child's `ready` until `ctl.ready()`; `ctl.failFork` makes
// the next fork throw; `ctl.holdProbe()` makes the next port probe wait until `ctl.releaseProbe()`.
async function hostWorld(t) {
  const userDataPath = tempProfile(t, 'jenny-force-local-host-');
  const state = { mode: 'disabled' };
  const gate = createForceLocalHold({ readMode: () => state.mode });
  const healthy = healthyHostScript({ teamId: 'team_x' });
  const ctl = { slow: false, failFork: false, pending: [], probe: null };
  const fake = createFakeFork({ script: (child, message) => {
    if (message.type === 'start' && ctl.slow) { ctl.pending.push(child); return; }
    healthy(child, message);
  } });
  const fork = (...args) => {
    if (ctl.failFork) { ctl.failFork = false; throw new Error('spawn failed'); }
    return fake.fork(...args);
  };
  ctl.holdProbe = () => { ctl.probe = {}; ctl.probe.wait = new Promise((resolve) => { ctl.probe.release = resolve; }); };
  ctl.releaseProbe = () => { const held = ctl.probe; ctl.probe = null; held?.release(); };
  const made = createTestHostController(t, { userDataPath, secureStore: createMemorySecureStore(), fork, gate,
    probeDirectPort: async () => { if (ctl.probe) await ctl.probe.wait; return true; } });
  gate.attach('host', { hold: () => made.controller.holdForceLocal(), release: () => made.controller.releaseForceLocal(),
    interrupt: () => made.controller.interruptForceLocal?.() });
  assert.equal((await made.controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const hostFlip = async (mode) => { state.mode = mode; await gate.changed(); await tick(20); };
  const hostState = async () => (await made.controller.handle('hostStatus', undefined)).host;
  const restartLogs = () => made.logs.filter((entry) => entry.event === 'team.force_local.host_restart_failed').map((entry) => entry.fields.reason);
  return { ...made, fake, gate, state, ctl, hostFlip, hostState, restartLogs };
}

test('2. the mode on while a release is starting the host: the start is cut at once and the child never comes up', async (t) => {
  const w = await hostWorld(t);
  await w.hostFlip('local_only');
  w.ctl.slow = true;
  const forks = w.fake.calls.length;
  w.state.mode = 'disabled';
  void w.gate.changed();
  assert.ok(await waitUntil(() => w.fake.calls.length === forks + 1), 'the release forked');
  const child = w.fake.last();
  w.state.mode = 'local_only';
  void w.gate.changed();
  assert.ok(await waitUntil(() => child.exited, { attempts: 25, interval: 10 }), 'the child stopped at once, not at the start bound');
  await w.gate.idle();
  await tick(20);
  const host = await w.hostState();
  assert.deepEqual([host.state, host.force_local], ['stopped', true]);
  assert.equal(child.posted.some((message) => message.type === 'start') && w.ctl.pending.includes(child), true, 'it never said ready');
});

test('5. on, off, on before the restart finished, off: the host runs', async (t) => {
  const w = await hostWorld(t);
  await w.hostFlip('local_only');
  w.ctl.slow = true;
  const forks = w.fake.calls.length;
  w.state.mode = 'disabled';
  void w.gate.changed();
  assert.ok(await waitUntil(() => w.fake.calls.length === forks + 1));
  w.state.mode = 'local_only';
  void w.gate.changed();
  await w.gate.idle();
  await tick(20);
  w.ctl.slow = false;
  await w.hostFlip('disabled');
  await tick(50);
  assert.equal((await w.hostState()).state, 'running');
});

test('5. a release that finds the mode on again starts nothing and keeps the memory for the next one', async (t) => {
  const w = await hostWorld(t);
  await w.hostFlip('local_only');
  await w.controller.releaseForceLocal();
  assert.equal((await w.hostState()).state, 'stopped', 'skipped while the mode reads on');
  await w.hostFlip('disabled');
  await tick(50);
  assert.equal((await w.hostState()).state, 'running');
});

test('5. a restart refused as busy and one that failed are logged and kept; the next release starts the host', async (t) => {
  const w = await hostWorld(t);
  await w.hostFlip('local_only');
  // A release whose start is still choosing its port holds the lock when the gate's own release runs.
  w.ctl.holdProbe();
  w.ctl.failFork = true;
  w.state.mode = 'disabled';
  const earlier = w.controller.releaseForceLocal();
  await tick();
  await w.gate.changed();
  assert.deepEqual(w.restartLogs(), ['team_host_busy']);
  w.ctl.releaseProbe();
  await earlier;
  assert.deepEqual(w.restartLogs(), ['team_host_busy', 'team_host_spawn_failed']);
  assert.notEqual((await w.hostState()).state, 'running');
  await w.hostFlip('local_only');
  await w.hostFlip('disabled');
  await tick(50);
  assert.equal((await w.hostState()).state, 'running');
});

test('5. a hold after a failed restart still knows the host ran: the next release starts it', async (t) => {
  const w = await hostWorld(t);
  await w.hostFlip('local_only');
  w.ctl.failFork = true;
  await w.hostFlip('disabled');
  assert.deepEqual(w.restartLogs(), ['team_host_spawn_failed']);
  await w.hostFlip('local_only');
  await w.hostFlip('disabled');
  await tick(50);
  assert.equal((await w.hostState()).state, 'running');
});

test('17. with the real team service: the release restarts the host without --team-init for an owner who holds the team, then the owner reconnects', async (t) => {
  const dir = tempProfile(t, 'jenny-force-local-owner-');
  const secureStore = createMemorySecureStore();
  const { createHostKeyStore } = require('../services/team/host/host-key-store');
  const seed = createHostKeyStore({ getSecureStore: () => secureStore }).create();
  const hostKey = keyPairFromSeed(seed).publicKey;
  seed.fill(0);
  const teamId = deriveTeamId(hostKey);
  assert.equal(saveClientFile(dir, { ...savedRecord(), team_id: teamId, host_public_key: hostKey }).ok, true);
  // Hosted here before (a saved config), so Deploy keeps the stored key (E75: with no config it would make a fresh one).
  const { buildHostConfig, prepareHostLayout, writeHostConfig } = require('../services/team/host/host-layout');
  const layout = prepareHostLayout(dir);
  writeHostConfig(layout, buildHostConfig({ layout, name: 'Studio', directPort: 45123 }));
  const state = { mode: 'disabled' };
  const config = new (require('node:events').EventEmitter)();
  const fake = createFakeFork({ script: healthyHostScript({ teamId }) });
  const managers = fakeManagers();
  const handlers = new Map();
  const shutdown = [];
  const backend = Object.assign(new (require('node:events').EventEmitter)(), { featureFlags: { team: true }, options: {},
    getBackendStatus: () => ({ phase: 'ready' }) });
  const registered = registerTeam({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    featureFlags: { team: true }, backendService: backend, userDataPath: dir, getSecureStore: () => secureStore,
    getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }), readOfflineMode: () => state.mode,
    subscribeConfig: (fn) => { config.on('changed', fn); return () => config.off('changed', fn); },
    serviceOptions: { createManager: managers.createManager },
    loadHostLaunch: () => ({ electronIsPackaged: () => false, electronFork: fake.fork, HOST_ENTRY: 'C:\\app\\host-entry.js',
      hostEnvironment: () => ({ SystemRoot: 'C:\\Windows' }), desktopPythonExecutable: () => process.execPath }),
    hostOptions: { platform: 'win32', pickDirectPort: async () => 45123, probeDirectPort: async () => true, bounds: BOUNDS },
  });
  t.after(() => shutdown[0]?.());
  await tick(20);
  assert.equal(managers.live().length, 1, 'the owner\'s own membership connects');
  const deployed = await handlers.get('team:host-deploy')({ sender: {} }, { ...DEPLOY });
  assert.equal(deployed.ok, true, JSON.stringify(deployed));
  assert.equal(fake.calls[0].args.includes('--team-init'), false, 'a member owner starts without --team-init');
  const flip = async (mode) => { state.mode = mode; config.emit('changed', {}, { reason: 'x' }); await registered.forceLocalIdle(); await tick(30); };
  await flip('local_only');
  assert.equal(managers.live().length, 0);
  assert.ok(fake.last().exited, 'the host stopped');
  assert.equal(registered.getService().holds(teamId), true, 'still held: its key or directory is on disk');
  await flip('disabled');
  await tick(50);
  assert.equal(fake.calls.length, 2, 'started again');
  assert.equal(fake.calls[1].args.includes('--team-init'), false, 'again without --team-init');
  assert.equal((await handlers.get('team:host-status')({ sender: {} }, undefined)).host.state, 'running');
  assert.deepEqual(managers.live().map((m) => m.teamId), [teamId], 'then the owner\'s own connection comes back');
});
