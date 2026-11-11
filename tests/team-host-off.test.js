'use strict';

// Team host off and idle (slice 1f-2): with the `team` flag off nothing under
// services/team/host/ loads and <userData>/team-host is never read; with it on
// and no host, the host handlers exist, the member client works, and still no
// host module loads and no team-host file is read until a host method is called.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { tempProfile, createMemorySecureStore } = require('./helpers/team-client-host');

const ROOT = path.resolve(__dirname, '..');
const HOST_DIR = path.join(ROOT, 'services', 'team', 'host') + path.sep;
const REGISTRATION = require.resolve('../services/main/team-registration');

function loadedHostModules() {
  return Object.keys(require.cache).filter((file) => file.startsWith(HOST_DIR));
}

function clearModules() {
  for (const file of Object.keys(require.cache)) {
    if (file.startsWith(path.join(ROOT, 'services', 'team') + path.sep) || file === REGISTRATION) delete require.cache[file];
  }
}

function spyFs(t, root) {
  const touched = [];
  const names = ['readFileSync', 'readdirSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'realpathSync',
    'mkdirSync', 'writeFileSync', 'readFile', 'readdir', 'open', 'stat'];
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

function fakeBackend(flags) {
  const backend = new EventEmitter();
  backend.featureFlags = flags;
  backend.getBackendStatus = () => ({ phase: 'ready' });
  return backend;
}

function fakeIpcMain() {
  const handlers = new Map();
  return { handlers, handle(channel, fn) { handlers.set(channel, fn); } };
}

for (const flags of [{ team: false }, undefined]) {
  test(`flag ${flags ? 'off' : 'map missing'}: no host handler, no host module, no team-host read`, async (t) => {
    const dir = tempProfile(t, 'jenny-host-off-');
    fs.mkdirSync(path.join(dir, 'team-host'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'team-host', 'host-config.json'), '{}');
    clearModules();
    const touched = spyFs(t, path.join(dir, 'team-host'));
    const { registerTeam } = require('../services/main/team-registration');
    const ipcMain = fakeIpcMain();
    const result = registerTeam(ipcMain, { featureFlags: flags, backendService: fakeBackend(flags), userDataPath: dir,
      getSecureStore: () => { throw new Error('no secure store'); } });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(result.registered, false);
    assert.equal([...ipcMain.handlers.keys()].some((channel) => channel.startsWith('team:host')), false);
    assert.deepEqual(loadedHostModules(), []);
    assert.deepEqual(touched, []);
  });
}

test('flag on, no host: host handlers exist; member calls load no host module and read no team-host file', async (t) => {
  const dir = tempProfile(t, 'jenny-host-off-');
  clearModules();
  const touched = spyFs(t, path.join(dir, 'team-host'));
  const { registerTeam } = require('../services/main/team-registration');
  const ipcMain = fakeIpcMain();
  const shutdown = [];
  const secureStore = createMemorySecureStore();
  registerTeam(ipcMain, { featureFlags: { team: true }, backendService: fakeBackend({ team: true }), userDataPath: dir,
    getSecureStore: () => secureStore, getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }) });
  for (const channel of ['team:host-deploy', 'team:host-stop', 'team:host-status', 'team:host-recover']) {
    assert.equal(ipcMain.handlers.has(channel), true, channel);
  }
  assert.equal(shutdown.length, 1, 'still one shutdown task');
  assert.deepEqual(loadedHostModules(), [], 'registration loads no host module');
  const status = await ipcMain.handlers.get('team:status')({ sender: {} }, {});
  assert.equal(status.ok, true);
  assert.deepEqual(loadedHostModules(), [], 'a member call loads no host module');
  await shutdown[0]();
  assert.deepEqual(loadedHostModules(), [], 'the shutdown task with no host loads no host module');
  assert.deepEqual(touched, []);
});

// Since slice 1g-1 the status opens the saved config (read only) to say whether this PC hosted a team
// before; with none saved it writes nothing, makes no directory and never asks the key store.
test('flag on: hostStatus with no host answers stopped, deployed false, and only opens the config to read it', async (t) => {
  const dir = tempProfile(t, 'jenny-host-off-');
  clearModules();
  const touched = spyFs(t, path.join(dir, 'team-host'));
  const { registerTeam } = require('../services/main/team-registration');
  const ipcMain = fakeIpcMain();
  const shutdown = [];
  let storeAsked = 0;
  registerTeam(ipcMain, { featureFlags: { team: true }, backendService: fakeBackend({ team: true }), userDataPath: dir,
    getSecureStore: () => { storeAsked += 1; return createMemorySecureStore(); },
    getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
    hostOptions: { fork: () => { throw new Error('no spawn expected'); } } });
  const answer = await ipcMain.handlers.get('team:host-status')({ sender: {} }, undefined);
  assert.equal(answer.ok, true);
  assert.equal(answer.host.state, 'stopped');
  assert.equal(answer.host.deployed, false);
  assert.equal(answer.host.team_id, null);
  assert.deepEqual(touched, [['openSync', path.join(dir, 'team-host', 'host-config.json')]]);
  assert.equal(fs.existsSync(path.join(dir, 'team-host')), false, 'nothing created');
  assert.equal(storeAsked, 0, 'the key store is never asked');
  await shutdown[0]();
});

test('the shutdown task waits for both stops even when one of them fails', async (t) => {
  const dir = tempProfile(t, 'jenny-host-off-');
  clearModules();
  const { registerTeam } = require('../services/main/team-registration');
  const ipcMain = fakeIpcMain();
  const shutdown = [];
  let serviceStopped = false;
  const fakeService = { handle: async () => ({ ok: true }), startExisting: async () => {},
    stopAll: () => new Promise((resolve) => { setTimeout(() => { serviceStopped = true; resolve(); }, 50); }) };
  const fakeHost = { handle: async () => ({ ok: true }), stop: async () => { throw new Error('host stop failed'); } };
  registerTeam(ipcMain, { featureFlags: { team: true }, backendService: fakeBackend({ team: true }), userDataPath: dir,
    getSecureStore: () => createMemorySecureStore(), getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
    loadService: () => ({ createTeamService: () => fakeService }), loadHost: () => ({ createHostController: () => fakeHost }),
    loadHostLaunch: () => ({ hostEnvironment: () => ({}) }) });
  await ipcMain.handlers.get('team:status')({ sender: {} }, undefined);
  await ipcMain.handlers.get('team:host-status')({ sender: {} }, undefined);
  await assert.doesNotReject(shutdown[0]());
  assert.equal(serviceStopped, true, 'the member client stop finished');
});
