'use strict';

// new-test-file: the Start with Jenny setting, the facts of a stopped server and the open-folder call are a new surface
// (services/team/host/host-autostart.js); the status and recovery files are close to their size caps.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { launchStart, readAutostart } = require('../services/team/host/host-autostart');
const { HOST_KEY_NAME } = require('../services/team/host/host-key-store');
const { buildHostConfig, prepareHostLayout, writeHostConfig } = require('../services/team/host/host-layout');
const { deriveTeamId, encodeBase64url, keyPairFromSeed } = require('../server/team/ids');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { BOUNDS, createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');
const { MAYA, seedOwnership, seedTeamFiles } = require('./helpers/team-host-seed');

const TEAM_ID_OF_SEED = deriveTeamId(keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey);

// A profile whose server was deployed before and is stopped: the saved config and the key, nothing running.
// `owner`: this Jenny's saved membership names the member store's owner (`memberId`: another member's, for a refusal).
function deployedProfile(t, { owner = false, memberId } = {}) {
  const userDataPath = tempProfile(t, 'jenny-host-autostart-');
  const secureStore = createMemorySecureStore();
  secureStore.values.set(HOST_KEY_NAME, encodeBase64url(Buffer.from(HOST_SEED)));
  if (owner || memberId) {
    seedTeamFiles(userDataPath);
    seedOwnership(userDataPath, secureStore, memberId ? { memberId } : {});
  } else {
    const layout = prepareHostLayout(userDataPath);
    writeHostConfig(layout, buildHostConfig({ layout, name: 'Studio', directPort: 45123 }));
  }
  return { userDataPath, secureStore, root: path.join(userDataPath, 'team-host') };
}

test('hostAutostart on and off: the file, the answer, the state and the pushed state', async (t) => {
  const { userDataPath, secureStore, root } = deployedProfile(t, { owner: true });
  const file = path.join(root, 'autostart.json');
  const { controller, pushed } = createTestHostController(t, { userDataPath, secureStore });
  assert.equal((await controller.handle('hostStatus', {})).host.autostart, false);

  const on = await controller.handle('hostAutostart', { enabled: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(on.host.autostart, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema_version: 1, enabled: true });
  assert.equal(pushed.at(-1).autostart, true, 'a second window is told');
  assert.equal((await controller.handle('hostStatus', {})).host.autostart, true);

  const off = await controller.handle('hostAutostart', { enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.host.autostart, false);
  assert.equal(fs.existsSync(file), false, 'turning it off removes the file');
  assert.equal(pushed.at(-1).autostart, false);
  assert.equal((await controller.handle('hostAutostart', { enabled: false })).ok, true, 'off when already off is fine');
});

test('hostAutostart is refused with no server deployed here, and writes nothing', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-autostart-');
  const { controller } = createTestHostController(t, { userDataPath, secureStore: createMemorySecureStore() });
  const answer = await controller.handle('hostAutostart', { enabled: true });
  assert.equal(answer.ok, false);
  assert.equal(answer.error.reason, 'team_host_not_deployed');
  assert.equal(readAutostart(userDataPath), false);
  assert.equal(fs.existsSync(path.join(userDataPath, 'team-host', 'autostart.json')), false);
  assert.equal((await controller.handle('hostAutostart', { enabled: 'yes' })).ok, false, 'a payload that is not a boolean');
  const status = await controller.handle('hostStatus', {});
  assert.equal(status.host.autostart, false, 'never true for a profile that is not deployed');
});

test("hostAutostart is the owner's: a member's Jenny on this profile is refused and nothing is written", async (t) => {
  const { userDataPath, secureStore, root } = deployedProfile(t, { memberId: MAYA });
  const { controller } = createTestHostController(t, { userDataPath, secureStore });
  const answer = await controller.handle('hostAutostart', { enabled: true });
  assert.deepEqual([answer.ok, answer.error?.reason], [false, 'team_owner_only'], JSON.stringify(answer));
  assert.equal(fs.existsSync(path.join(root, 'autostart.json')), false);
});

test('hostAutostart takes the lock a manual start holds: while a Deploy runs it answers team_host_busy and writes nothing', async (t) => {
  const { userDataPath, secureStore, root } = deployedProfile(t, { owner: true });
  const { controller } = createTestHostController(t, { userDataPath, secureStore, script: () => {} }); // a host that never says ready
  const deploying = controller.handle('hostDeploy', { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  const answer = await controller.handle('hostAutostart', { enabled: true });
  assert.deepEqual([answer.ok, answer.error?.reason], [false, 'team_host_busy'], JSON.stringify(answer));
  assert.equal(fs.existsSync(path.join(root, 'autostart.json')), false);
  await controller.handle('hostStop', {});
  await deploying;
});

test('a verdict-only push of a running host after the setting changed still carries the new value', async (t) => {
  const { userDataPath, secureStore } = deployedProfile(t, { owner: true });
  const { controller, pushed, fake } = createTestHostController(t, { userDataPath, secureStore,
    bounds: { ...BOUNDS, reachPushMs: 5 }, script: healthyHostScript({ teamId: TEAM_ID_OF_SEED }) });
  assert.equal((await controller.handle('hostDeploy', { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' })).ok, true);
  assert.equal(pushed.at(-1).state, 'running');
  assert.equal(pushed.at(-1).autostart, false);
  assert.equal((await controller.handle('hostAutostart', { enabled: true })).ok, true);
  const before = pushed.length;
  fake.last().reply({ type: 'reach', result: 'reachable', reason: 'direct_seen' });
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.ok(pushed.length > before, 'the verdict was pushed');
  assert.equal(pushed.at(-1).reach?.result, 'reachable');
  assert.equal(pushed.at(-1).autostart, true);
});

test('readAutostart: true only for a small file of exactly the saved shape; anything else is false and nothing is made', (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-autostart-');
  assert.equal(readAutostart(userDataPath), false, 'no folder');
  const root = path.join(userDataPath, 'team-host');
  fs.mkdirSync(root);
  const file = path.join(root, 'autostart.json');
  assert.equal(readAutostart(userDataPath), false, 'no file');
  const valid = JSON.stringify({ schema_version: 1, enabled: true });
  const cases = [
    [valid, true],
    [`${valid}${' '.repeat(4000)}`, true],
    [JSON.stringify({ schema_version: 1, enabled: false }), false],
    [JSON.stringify({ schema_version: 2, enabled: true }), false],
    [JSON.stringify({ schema_version: 1, enabled: 'true' }), false],
    [JSON.stringify({ schema_version: 1, enabled: true, extra: 1 }), false],
    [JSON.stringify({ enabled: true }), false],
    [JSON.stringify([true]), false],
    ['null', false],
    [`${valid}${' '.repeat(4100)}`, false],
    ['{ "schema_version": 1, "enabled": tru', false],
    ['', false],
  ];
  for (const [text, expected] of cases) {
    fs.writeFileSync(file, text);
    assert.equal(readAutostart(userDataPath), expected, text.slice(0, 60));
  }
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(readAutostart(userDataPath), false, 'a folder of that name');
  fs.rmdirSync(file);
  assert.deepEqual(fs.readdirSync(root), [], 'a read creates nothing');
  assert.equal(readAutostart(undefined), false);
  assert.equal(readAutostart(''), false);
});

// The members file the summary reads: an owner and a member active, one pending, one project.
function writeTeamFiles(root) {
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects', 'project_abc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'team-members.json'), JSON.stringify({
    team: { team_id: 'team_abcdefghijklmnopqrstuv', name: 'Studio' },
    members: [
      { member_id: 'member_a', state: 'active', role: 'owner', display_name: 'Olive Owner' },
      { member_id: 'member_b', state: 'active', role: 'member', display_name: 'Mika Member' },
      { member_id: 'member_c', state: 'pending', role: 'member', display_name: 'Pat Pending' },
    ],
    invites: [],
    projects: [{ project_id: 'project_abc' }, { project_id: 'not a project id' }],
  }));
  fs.writeFileSync(path.join(root, 'projects', 'project_abc', 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'profile', 'outside-projects.bin'), Buffer.alloc(1234));
}

function sizeOfTree(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
    const full = path.join(dir, entry.name);
    return sum + (entry.isDirectory() ? sizeOfTree(full) : fs.statSync(full).size);
  }, 0);
}

test('hostSummary: counts, the whole folder\'s bytes and the log\'s time, for a stopped server; no push, no write', async (t) => {
  const { userDataPath, secureStore, root } = deployedProfile(t);
  writeTeamFiles(root);
  const stamp = Date.UTC(2026, 10, 15, 8, 30, 0);
  fs.writeFileSync(path.join(root, 'logs', 'host.log'), 'INFO team.host.ready\n');
  fs.utimesSync(path.join(root, 'logs', 'host.log'), stamp / 1000, stamp / 1000);
  const { controller, pushed } = createTestHostController(t, { userDataPath, secureStore });
  const before = sizeOfTree(root);
  const answer = await controller.handle('hostSummary', {});
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.summary, { members: 2, pending: 1, projects: 1, bytes: before, last_ran: stamp });
  assert.ok(answer.summary.bytes > 1234 + 5, 'it covers a file outside projects/');
  assert.equal(sizeOfTree(root), before, 'nothing was written');
  assert.deepEqual(pushed, [], 'no state push');
  assert.equal(JSON.stringify(answer).includes('Olive'), false, 'no names');
});

test('hostSummary: a part that cannot be read is null and the call still answers ok', async (t) => {
  const { userDataPath, secureStore, root } = deployedProfile(t);
  const { controller } = createTestHostController(t, { userDataPath, secureStore });
  const bare = await controller.handle('hostSummary', {});
  assert.equal(bare.ok, true);
  assert.deepEqual({ ...bare.summary, bytes: typeof bare.summary.bytes }, { members: null, pending: null, projects: null,
    bytes: 'number', last_ran: null });
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'team-members.json'), '{ torn');
  const torn = await controller.handle('hostSummary', {});
  assert.equal(torn.ok, true);
  assert.deepEqual([torn.summary.members, torn.summary.pending, torn.summary.projects], [null, null, null]);
  const elsewhere = tempProfile(t, 'jenny-host-autostart-link-');
  try {
    fs.symlinkSync(elsewhere, path.join(root, 'linked'), 'junction');
  } catch (error) {
    t.diagnostic(`no link made (${error.code}); the link case is skipped`);
    return;
  }
  const linked = await controller.handle('hostSummary', {});
  assert.equal(linked.ok, true);
  assert.equal(linked.summary.bytes, null, 'a link in the folder: the total is not claimed');
});

test('hostSummary and hostOpenFolder: refused with no server deployed here, and for a team-host that is a link', async (t) => {
  const bare = tempProfile(t, 'jenny-host-autostart-');
  const opened = [];
  const pick = { open: async (folder) => { opened.push(folder); return true; } };
  const { controller } = createTestHostController(t, { userDataPath: bare, secureStore: createMemorySecureStore(), pick });
  const summary = await controller.handle('hostSummary', {});
  assert.equal(summary.ok, false);
  assert.equal(summary.error.reason, 'team_host_not_deployed');
  const open = await controller.handle('hostOpenFolder', {});
  assert.equal(open.ok, false);
  assert.deepEqual(opened, [], 'no folder, nothing opened');

  const profile = tempProfile(t, 'jenny-host-autostart-');
  const real = tempProfile(t, 'jenny-host-autostart-real-');
  try {
    fs.symlinkSync(real, path.join(profile, 'team-host'), 'junction');
  } catch (error) {
    t.diagnostic(`no link made (${error.code}); the link case is skipped`);
    return;
  }
  const { controller: linked } = createTestHostController(t, { userDataPath: profile, secureStore: createMemorySecureStore(), pick });
  for (const method of ['hostSummary', 'hostOpenFolder']) {
    const answer = await linked.handle(method, {});
    assert.equal(answer.ok, false, method);
    assert.equal(answer.error.reason, 'team_host_link', method);
  }
  assert.deepEqual(opened, []);
});

test('hostOpenFolder: opens the real team-host folder; a shell that cannot open it gives team_open_failed', async (t) => {
  const { userDataPath, secureStore, root } = deployedProfile(t);
  const opened = [];
  let result = true;
  const { controller } = createTestHostController(t, { userDataPath, secureStore,
    pick: { open: async (folder) => { opened.push(folder); return result; } } });
  assert.deepEqual(await controller.handle('hostOpenFolder', {}), { ok: true });
  assert.deepEqual(opened, [fs.realpathSync.native(root)]);
  result = false;
  const failed = await controller.handle('hostOpenFolder', {});
  assert.equal(failed.ok, false);
  assert.equal(failed.error.reason, 'team_open_failed');
  const { controller: noShell } = createTestHostController(t, { userDataPath, secureStore });
  assert.equal((await noShell.handle('hostOpenFolder', {})).error.reason, 'team_open_failed', 'no shell injected');
});

// ------------------------------------------------------------------ the start at launch

const TEAM_ID = 'team_abcdefghijklmnopqrstuv';
const HOSTED = Object.freeze({ deployed: true, team_name: 'Studio', team_id: TEAM_ID, state: 'stopped', key: 'ok', reason: null });
const ROW = Object.freeze({ team_id: TEAM_ID, display_name: 'Olive Owner', label: 'Desk' });

// A host controller and member service that answer from `host` and `teams`; every host call is kept.
function fakeLaunch({ host = HOSTED, teams = [ROW], deploy = { ok: true }, hostThrows = false } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls, logs,
    getHost: () => ({ handle: async (method, payload, context) => {
      calls.push({ method, payload, context });
      if (hostThrows) throw new Error('Studio exploded');
      return method === 'hostStatus' ? { ok: true, host } : deploy;
    } }),
    getService: () => ({ handle: async () => ({ ok: true, teams }) }),
    log: (level, event, fields) => logs.push({ level, event, fields }),
  };
}

test('launchStart: a stopped or failed server whose membership is held starts once with the row\'s names', async () => {
  for (const state of ['stopped', 'failed']) {
    const world = fakeLaunch({ host: { ...HOSTED, state } });
    await launchStart(world);
    const deploys = world.calls.filter((call) => call.method === 'hostDeploy');
    assert.equal(deploys.length, 1, state);
    assert.deepEqual(deploys[0].payload, { name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
    assert.equal(deploys[0].context.sender, null);
    assert.deepEqual(world.logs, [{ level: 'INFO', event: 'team.host.autostart.started', fields: undefined }]);
  }
});

test('launchStart skips, with a reason word and no name: no row, no names, a lost key, Force local, a running host', async () => {
  const cases = [
    ['no_membership', { teams: [] }],
    ['no_membership', { teams: [{ ...ROW, team_id: 'team_other' }] }],
    ['no_names', { teams: [{ ...ROW, label: '' }] }],
    ['no_names', { teams: [{ ...ROW, display_name: undefined }] }],
    ['key_lost', { host: { ...HOSTED, key: 'missing' } }],
    ['key_lost', { host: { ...HOSTED, key: 'set_aside' } }],
    ['force_local', { host: { ...HOSTED, force_local: true } }],
    ['not_stopped', { host: { ...HOSTED, state: 'running' } }],
    ['not_stopped', { host: { ...HOSTED, state: 'starting' } }],
    ['platform', { host: { ...HOSTED, reason: 'team_host_platform_unavailable' } }],
    ['not_deployed', { host: { ...HOSTED, deployed: false } }],
    ['not_deployed', { host: { ...HOSTED, team_name: 'x'.repeat(41) } }],
  ];
  for (const [reason, options] of cases) {
    const world = fakeLaunch(options);
    await launchStart(world);
    assert.deepEqual(world.calls.map((call) => call.method), ['hostStatus'], reason);
    assert.deepEqual(world.logs, [{ level: 'INFO', event: 'team.host.autostart.skipped', fields: { reason } }], reason);
    assert.equal(JSON.stringify(world.logs).includes('Studio'), false);
    assert.equal(JSON.stringify(world.logs).includes('Olive'), false);
  }
});

test('launchStart: a refused deploy logs its reason, a thrown error is caught, and neither retries', async () => {
  const refused = fakeLaunch({ deploy: { ok: false, error: { code: 'CMP-HOST-0001', reason: 'team_host_key_missing' } } });
  await launchStart(refused);
  assert.equal(refused.calls.filter((call) => call.method === 'hostDeploy').length, 1);
  assert.deepEqual(refused.logs, [{ level: 'WARN', event: 'team.host.autostart.failed', fields: { reason: 'team_host_key_missing' } }]);
  const thrown = fakeLaunch({ hostThrows: true });
  await assert.doesNotReject(launchStart(thrown));
  assert.deepEqual(thrown.logs, [{ level: 'WARN', event: 'team.host.autostart.failed', fields: { reason: 'error' } }]);
  assert.equal(JSON.stringify(thrown.logs).includes('Studio'), false);
});
