'use strict';

// Team off and Team idle (slice 1f-1). With the `team` flag off no team handler
// exists, no services/team module loads and nothing under <userData>/team/ is
// read. With the flag on and no membership the handlers exist and nothing else
// happens: no services/team module until the first call, no bridge, no timer.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { FEATURE_FLAG_TABLE } = require('../services/feature-flag-table');
const { buildFeatureFlags } = require('../services/feature-flags');
const { tempProfile } = require('./helpers/team-client-host');

const TEAM_MODULE_DIR = path.join(path.resolve(__dirname, '..'), 'services', 'team') + path.sep;
const SERVER_TEAM_DIR = path.join(path.resolve(__dirname, '..'), 'server', 'team') + path.sep;
const REGISTRATION = require.resolve('../services/main/team-registration');

function loadedTeamModules() {
  return Object.keys(require.cache).filter((file) => file.startsWith(TEAM_MODULE_DIR)
    && !file.startsWith(path.join(TEAM_MODULE_DIR, 'transport') + path.sep));
}

function clearTeamModules() {
  for (const file of Object.keys(require.cache)) {
    if (file.startsWith(TEAM_MODULE_DIR) || file === REGISTRATION) delete require.cache[file];
  }
}

// Records every fs path touched under `root` while it is installed.
function spyFs(t, root) {
  const touched = [];
  const names = ['readFileSync', 'readdirSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readFile',
    'readdir', 'open', 'stat', 'mkdirSync', 'writeFileSync'];
  const originals = {};
  for (const name of names) {
    originals[name] = fs[name];
    fs[name] = function spied(target, ...rest) {
      if (typeof target === 'string' && path.resolve(target).startsWith(root)) touched.push([name, target]);
      return originals[name].call(fs, target, ...rest);
    };
  }
  t.after(() => { for (const name of names) fs[name] = originals[name]; });
  return touched;
}

const profile = (t) => tempProfile(t, 'jenny-team-off-');

function fakeBackend(flags) {
  const backend = new EventEmitter();
  backend.featureFlags = flags;
  backend.phase = 'starting';
  backend.getBackendStatus = () => ({ phase: backend.phase });
  backend.ready = () => { backend.phase = 'ready'; backend.emit('backend-status', { phase: 'ready' }); };
  return backend;
}

function options(dir, backend, extra = {}) {
  const spawns = [];
  const shutdown = [];
  return {
    spawns, shutdown,
    value: {
      featureFlags: backend.featureFlags, backendService: backend, userDataPath: dir,
      getSecureStore: () => { throw new Error('the secure store must not be touched'); },
      sendBridgeEvent: () => {}, getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
      readOfflineMode: () => 'disabled', // Force local off (E64: no reader wired counts as on)
      serviceOptions: { spawnChild: (mode) => { spawns.push(mode); throw new Error('no bridge expected'); } },
      ...extra,
    },
  };
}

test('the team flag row: key team, env TEAM, default on (owner, 2026-11-15), env-only, =1 on and =0 off', () => {
  const row = FEATURE_FLAG_TABLE.find((entry) => entry.key === 'team');
  assert.deepEqual({ ...row }, { key: 'team', env: 'TEAM', default: true, internal: true });
  assert.equal(buildFeatureFlags({}).team, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_TEAM: '1' }).team, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_TEAM: '0' }).team, false);
});

test('flag off: no handler, no services/team module, nothing under <userData>/team read', async (t) => {
  const dir = profile(t);
  fs.mkdirSync(path.join(dir, 'team', 'team_abcdefghijklmnopqrstuv'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'team', 'team_abcdefghijklmnopqrstuv', 'client.json'), '{}');
  clearTeamModules();
  const touched = spyFs(t, path.join(dir, 'team'));
  const { registerTeam } = require('../services/main/team-registration');
  assert.deepEqual(loadedTeamModules(), [], 'requiring the registration loads no services/team module');
  const backend = fakeBackend({ team: false });
  const handled = [];
  const opts = options(dir, backend);
  const result = registerTeam({ handle: (channel) => handled.push(channel) }, opts.value);
  backend.ready();
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(handled, []);
  assert.equal(result.registered, false);
  assert.deepEqual(opts.shutdown, []);
  assert.deepEqual(loadedTeamModules(), []);
  assert.deepEqual(touched, []);
  assert.deepEqual(opts.spawns, []);
  assert.equal(backend.listenerCount('backend-status'), 0, 'no listener left behind');
  // 4b member wiring: no engine port, no team row, no turn route on the backend.
  assert.equal(backend.turnRoute, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(backend, 'turnRoute'), undefined);
  const { teamModelEntries } = require('../services/backend/team-engine-models');
  assert.deepEqual(teamModelEntries(backend), []);
  assert.deepEqual(loadedTeamModules(), []);
});

test('a missing flag map is off (fail closed)', async (t) => {
  const dir = profile(t);
  clearTeamModules();
  const { registerTeam } = require('../services/main/team-registration');
  const handled = [];
  const backend = fakeBackend(undefined);
  const result = registerTeam({ handle: (channel) => handled.push(channel) }, options(dir, backend).value);
  assert.equal(result.registered, false);
  assert.deepEqual(handled, []);
});

test('flag on, no membership: handlers exist, and no module, bridge, timer or file read follows', async (t) => {
  const dir = profile(t);
  clearTeamModules();
  const timersBefore = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const { registerTeam } = require('../services/main/team-registration');
  const backend = fakeBackend({ team: true });
  const handled = [];
  const opts = options(dir, backend);
  const result = registerTeam({ handle: (channel) => handled.push(channel) }, opts.value);
  assert.equal(result.registered, true);
  assert.ok(handled.includes('team:join') && handled.includes('team:status'));
  assert.equal(opts.shutdown.length, 1, 'one shutdown task stops every bridge');
  backend.ready();
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.deepEqual(loadedTeamModules(), [], 'nothing beyond the registration until the first call');
  assert.deepEqual(opts.spawns, []);
  assert.equal(result.getService(), null);
  // 4b member wiring: the turn route reads null and loads nothing; dispose takes it off again.
  assert.equal(backend.turnRoute, null);
  assert.deepEqual(loadedTeamModules(), [], 'reading the turn route loads no team module');
  const timersAfter = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  assert.ok(timersAfter <= timersBefore, 'no timer left live');
  await opts.shutdown[0]();
  assert.equal(Object.getOwnPropertyDescriptor(backend, 'turnRoute'), undefined, 'dispose removes the getter');
});

test('flag on with a membership: it connects after the backend is ready, not at registration', async (t) => {
  const dir = profile(t);
  const teamDir = path.join(dir, 'team', 'team_abcdefghijklmnopqrstuv');
  fs.mkdirSync(teamDir, { recursive: true });
  clearTeamModules();
  const { registerTeam } = require('../services/main/team-registration');
  const backend = fakeBackend({ team: true });
  const started = [];
  const opts = options(dir, backend, { loadService: () => ({ createTeamService: () => ({
    startExisting: async () => { started.push('start'); }, stopAll: async () => { started.push('stop'); },
    handle: async () => ({ ok: true }) }) }) });
  registerTeam({ handle: () => {} }, opts.value);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.deepEqual(started, [], 'nothing at registration');
  backend.ready();
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.deepEqual(started, ['start']);
  await opts.shutdown[0]();
  assert.deepEqual(started, ['start', 'stop']);
});

test('the IPC registration path calls the team registration only when the flag is on', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'main', 'ipc-handler-registration.js'), 'utf8');
  const call = source.match(/if \(backendService\?\.featureFlags\?\.team === true\) \{?\s*require\('\.\/team-registration'\)/);
  assert.ok(call, 'the call is guarded by the flag and requires the module lazily');
  assert.equal(/^const .*team-registration/m.test(source), false, 'no top-level require of the team registration');
});

// ------------------------------------------------------------------ E50: Team on with no team loads nothing

const probe = require('../services/main/team-data-probe');
const TEAM_ID = 'team_abcdefghijklmnopqrstuv';

test('E50 the team data check: an empty profile is no, each kind of data alone is yes, a non-team name or a file is no', (t) => {
  const dir = profile(t);
  assert.equal(probe.hasTeamData(dir), false);
  fs.mkdirSync(path.join(dir, probe.TEAM_DIR, 'notes'), { recursive: true });
  assert.equal(probe.hasTeamData(dir), false, 'a team directory holding only a non-team name');
  fs.mkdirSync(path.join(dir, probe.TEAM_DIR, TEAM_ID));
  assert.equal(probe.hasTeamData(dir), true, 'a team directory');
  for (const parts of [[probe.HOST_DIR, probe.HOST_CONFIG], [probe.HOST_DIR, probe.HOST_PROFILE, probe.HOST_MEMBERS]]) {
    const other = profile(t);
    fs.mkdirSync(path.join(other, ...parts.slice(0, -1)), { recursive: true });
    fs.writeFileSync(path.join(other, ...parts), '{}');
    assert.equal(probe.hasTeamData(other), true, parts.join('/'));
  }
  const file = profile(t);
  fs.writeFileSync(path.join(file, probe.TEAM_DIR), '');
  fs.writeFileSync(path.join(file, probe.HOST_DIR), '');
  assert.equal(probe.hasTeamData(file), false, 'ENOTDIR is "not there"');
  const named = profile(t);
  fs.mkdirSync(path.join(named, probe.TEAM_DIR));
  fs.writeFileSync(path.join(named, probe.TEAM_DIR, TEAM_ID), '');
  assert.equal(probe.hasTeamData(named), true, 'a file with a team name: it cannot tell');
  const linked = profile(t);
  fs.mkdirSync(path.join(linked, probe.TEAM_DIR));
  fs.symlinkSync(profile(t), path.join(linked, probe.TEAM_DIR, TEAM_ID), 'junction');
  assert.equal(probe.hasTeamData(linked), true, 'a junction with a team name: it cannot tell');
  // Review of 5-6 (item 18): a profile holding only a team set aside after a lost key is team data, so its Delete row stays reachable.
  const aside = profile(t);
  fs.mkdirSync(path.join(aside, 'team-host-old-20261112093000000'));
  assert.equal(probe.hasTeamData(aside), true, 'an old team');
  const notOld = profile(t);
  fs.mkdirSync(path.join(notOld, 'team-host-old-123'));
  assert.equal(probe.hasTeamData(notOld), false, 'only the 17-digit name counts');
  assert.ok(probe.OLD_HOST_NAME.test('team-host-old-20261112093000000'));
});

test('E50 the check opens no file, a check that cannot tell says yes, and once yes it reads nothing again', (t) => {
  const dir = profile(t);
  const touched = spyFs(t, dir);
  assert.equal(probe.hasTeamData(dir), false);
  assert.deepEqual(touched.filter(([name]) => ['openSync', 'readFileSync', 'open', 'readFile'].includes(name)), [], 'no file is opened');
  for (const name of ['readdirSync', 'statSync']) {
    const original = fs[name];
    fs[name] = () => { const error = new Error('denied'); error.code = 'EACCES'; throw error; };
    try { assert.equal(probe.hasTeamData(dir), true, `${name} that throws EACCES`); } finally { fs[name] = original; }
  }
  const check = probe.createTeamDataProbe(() => dir);
  assert.equal(check(), false);
  let seen = touched.length;
  assert.equal(check(), false);
  assert.ok(touched.length > seen, 'read again while it is no');
  fs.mkdirSync(path.join(dir, probe.TEAM_DIR, TEAM_ID), { recursive: true });
  assert.equal(check(), true);
  seen = touched.length;
  assert.equal(check(), true);
  assert.equal(touched.length, seen, 'once yes, never read again');
  assert.equal(probe.createTeamDataProbe(() => { throw new Error('no path'); })(), true, 'no user data path: it cannot tell');
});

test('E50 the check names the paths the team modules use', (t) => {
  const { MEMBERS_FILE } = require('../server/team/member-store');
  const { listTeamIds } = require('../services/team/client-file');
  const { hostWasDeployed } = require('../services/team/host/host-layout');
  assert.equal(probe.HOST_MEMBERS, MEMBERS_FILE);
  const dir = profile(t);
  fs.mkdirSync(path.join(dir, probe.TEAM_DIR, TEAM_ID), { recursive: true });
  fs.mkdirSync(path.join(dir, probe.TEAM_DIR, 'notes'));
  assert.deepEqual(listTeamIds(dir), [TEAM_ID], 'the client file reads the same directory and the same names');
  const config = profile(t);
  fs.mkdirSync(path.join(config, probe.HOST_DIR));
  assert.equal(hostWasDeployed(config), false);
  fs.writeFileSync(path.join(config, probe.HOST_DIR, probe.HOST_CONFIG), '{}');
  assert.equal(hostWasDeployed(config), true, 'the host config file');
  const members = profile(t);
  fs.mkdirSync(path.join(members, probe.HOST_DIR, probe.HOST_PROFILE), { recursive: true });
  fs.writeFileSync(path.join(members, probe.HOST_DIR, probe.HOST_PROFILE, probe.HOST_MEMBERS), '{}');
  assert.equal(hostWasDeployed(members), true, 'the host profile member store');
});

test('E50 the host the renderer seeds is exactly what hostStatus answers on an empty profile', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const dir = profile(t);
  clearTeamModules();
  const { registerTeam } = require('../services/main/team-registration');
  const handlers = new Map();
  const opts = options(dir, fakeBackend({ team: true }), { hostOptions: { fork: () => { throw new Error('no spawn expected'); } } });
  registerTeam({ handle: (channel, fn) => handlers.set(channel, fn) }, opts.value);
  const answer = await handlers.get('team:host-status')({ sender: {} }, undefined);
  assert.deepEqual(answer, { ok: true, host: require('../renderer/team/renderer-team-store').EMPTY_HOST });
  await opts.shutdown[0]();
});

test('E50 flag on, empty profile: registration, backend ready, the feature state and the renderer boot make no team call and load nothing', async (t) => {
  const dir = profile(t);
  clearTeamModules();
  for (const file of Object.keys(require.cache)) if (file.startsWith(SERVER_TEAM_DIR)) delete require.cache[file];
  const { registerTeam } = require('../services/main/team-registration');
  const backend = fakeBackend({ team: true });
  const opts = options(dir, backend);
  const invoked = [];
  registerTeam({ handle: (channel) => invoked.push(channel) }, opts.value);
  backend.ready();
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const { createFeatureSettingsFacade } = require('../services/main/feature-settings-facade');
  const shellConfig = { getState: () => ({ featureOverrides: {} }), getWorkspaceRootStatus: () => ({ state: 'missing', message: '' }) };
  const facade = createFeatureSettingsFacade({ env: { JENNY_ENABLE_TEAM: '1' }, platform: 'win32', getShellConfigService: () => shellConfig,
    hasTeamData: probe.createTeamDataProbe(() => dir) });
  const payload = facade.buildFeatureStatePayload();
  assert.equal(payload.featureFlags.team, true);
  assert.equal(payload.teamData, false);
  const { harness, shell, flush } = require('./helpers/team-settings-harness');
  const h = harness({ show: false });
  t.after(h.restore);
  const s = shell(h, { teamData: payload.teamData, activeView: 'team' });
  await flush();
  assert.deepEqual(h.calls, [], 'no team call from the renderer');
  assert.deepEqual(s.requested, [], 'no team script');
  assert.equal(h.window.document.querySelector('link[rel="stylesheet"]'), null, 'no team style');
  assert.equal(h.listeners.state, null);
  assert.equal(h.listeners.host, null);
  assert.equal(s.state.ui.activeView, 'chat', 'a saved Team view shows Chat');
  assert.deepEqual(loadedTeamModules(), [], 'no services/team module in main');
  // Review of 5-6 (item 18): by name, nothing of the lifecycle slice (the sweep runs only once the host controller exists).
  const slice = ['host-lifecycle', 'host-sweep', 'host-delete', 'host-export', 'host-restore', 'host-backup', 'host-inventory', 'team-deleted'];
  assert.deepEqual(Object.keys(require.cache).filter((file) => slice.some((name) => path.basename(file) === `${name}.js`)), []);
  assert.deepEqual(Object.keys(require.cache).filter((file) => file.startsWith(SERVER_TEAM_DIR)), [], 'no server/team module in main');
  await opts.shutdown[0]();
});

// Review sweeps, second run (X2b-F03). Fault: the canonical session store and the approval path loaded five
// server/team modules at every desktop start with Team off, unseen because no test here loaded them. A fresh process
// (Team off) requires desktop main's backend wiring, IPC registration and runtime composition, plus the session store
// and the approval path by name, and reads a record and a preference patch with no team field and a desktop approval.
// The scheduler's rule loads only at the first allowed-node list, a team host's use.
test('flag off: desktop main\'s backend, session store and approval path load no server/team module', () => {
  const root = path.resolve(__dirname, '..');
  const script = `
    const path = require('node:path');
    const root = ${JSON.stringify(root)};
    const at = (...parts) => path.join(root, ...parts);
    const dir = at('server', 'team') + path.sep;
    const loaded = () => Object.keys(require.cache).filter((f) => f.startsWith(dir))
      .map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();
    for (const rel of ['services/main/backend-service-wiring.js', 'services/main/ipc-handler-registration.js',
      'services/main/runtime-service-composition.js', 'services/backend/electron-session-store.js',
      'services/backend/chat-stream-tool-approval.js']) require(at(...rel.split('/')));
    const nodes = require(at('services', 'backend', 'session-allowed-nodes.js'));
    const gate = require(at('services', 'backend', 'team-rule-gate.js'));
    const desktop = [nodes.allowedNodesField(undefined), nodes.allowedNodesPatch({ model: 'm' }),
      nodes.repairSessionForV28({ id: 's' }), gate.teamRuleApproves({ hostMode: 'desktop' }, { toolName: 'write_file' })];
    const atStart = loaded();
    const teamUse = nodes.allowedNodesPatch({ [nodes.ALLOWED_NODES_PREFERENCE]: ['node_a'] });
    process.stdout.write(JSON.stringify({ atStart, desktop, teamUse, afterTeamUse: loaded() }));
  `;
  const { execFileSync } = require('node:child_process');
  const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8',
    env: { ...process.env, JENNY_ENABLE_TEAM: '0' }, timeout: 120_000 }));
  assert.deepEqual(out.atStart, [], 'no server/team module in main');
  assert.deepEqual(out.desktop, [{}, {}, { id: 's' }, null], 'the desktop answers are unchanged');
  assert.deepEqual(out.teamUse, { allowed_nodes: ['node_a'] }, 'a team host still reads the scheduler\'s own rule');
  assert.deepEqual(out.afterTeamUse, ['ids.js', 'scheduler/limits.js', 'scheduler/state.js'], 'loaded at first team use');
});
