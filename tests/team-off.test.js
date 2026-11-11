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
      serviceOptions: { spawnChild: (mode) => { spawns.push(mode); throw new Error('no bridge expected'); } },
      ...extra,
    },
  };
}

test('the team flag row: key team, env TEAM, default off (owner, 2026-11-10), env-only, =1 on and =0 off', () => {
  const row = FEATURE_FLAG_TABLE.find((entry) => entry.key === 'team');
  assert.deepEqual({ ...row }, { key: 'team', env: 'TEAM', default: false, internal: true });
  assert.equal(buildFeatureFlags({}).team, false);
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
  const timersAfter = process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  assert.ok(timersAfter <= timersBefore, 'no timer left live');
  await opts.shutdown[0]();
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
