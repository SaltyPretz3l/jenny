'use strict';

// new-test-file: the owner's project files switch (row 123, docs/plans/TEAM_HOST_FILE_TOOLS_2026-11-16.md slice 3) is a
// new desktop surface: `hostFileTools` on the host controller, its sibling host-file-tools.js, the supervisor's
// `file_tools` message and the hosted team's file-tools-link.js. team-host-model-relay.test.js is the relay's own.

const assert = require('node:assert/strict');
const test = require('node:test');

const { HOST_KEY_NAME } = require('../services/team/host/host-key-store');
const { deriveTeamId, encodeBase64url, keyPairFromSeed } = require('../server/team/ids');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');
const { isOutbound } = require('../server/team/parent-channel');
const { createFileToolsLink, fileToolsState } = require('../server/team/file-tools-link');
const { HOST_METHODS, HOST_OPERATIONS, validatePayload } = require('../services/team/ipc-methods');
const { loadHostConfig } = require('../server/config');
const { prepareHostLayout, readSavedHostConfig } = require('../services/team/host/host-layout');
const { createHostFileTools } = require('../services/team/host/host-file-tools');

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
const TEAM_ID = deriveTeamId(keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey);

function seededStore() {
  const secureStore = createMemorySecureStore();
  secureStore.values.set(HOST_KEY_NAME, encodeBase64url(Buffer.from(HOST_SEED)));
  return secureStore;
}

const savedFileTools = (userDataPath) => readSavedHostConfig(userDataPath).team.file_tools;
const report = (overrides = {}) => ({ type: 'file_tools', on: true, available: true, reason: null, turns: 0, ...overrides });

async function until(check, label) {
  for (let i = 0; i < 300; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail('timed out waiting for ' + label);
}

test('hostFileTools: the owner\'s own method, checked in main, never a host operation', () => {
  assert.equal(HOST_METHODS.includes('hostFileTools'), true);
  assert.equal(Object.hasOwn(HOST_OPERATIONS, 'hostFileTools'), false, 'nothing a member can send to a host');
  for (const on of [true, false]) assert.deepEqual(validatePayload('hostFileTools', { on }), { ok: true, value: { on } });
  for (const payload of [{}, { on: 'yes' }, { on: 1 }, { on: true, path: '/srv' }, undefined]) {
    assert.equal(validatePayload('hostFileTools', payload).ok, false, JSON.stringify(payload));
  }
});

test('on Windows after W14: a stopped team saves on where the win32 loader reads it (the refusal: host-file-tools.js below)', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-files-');
  const { controller } = createTestHostController(t, { userDataPath, secureStore: seededStore(), platform: 'win32',
    script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await controller.handle('hostFileTools', { on: true })).error.reason, 'team_host_not_deployed');
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  assert.deepEqual(controller.snapshot().file_tools, { on: false, state: 'off', reason: null });
  const on = await controller.handle('hostFileTools', { on: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(on.restarted, false);
  assert.deepEqual(on.host.file_tools, { on: true, state: 'saved', reason: null });
  const configPath = prepareHostLayout(userDataPath).configPath;
  assert.equal(loadHostConfig(configPath, { platform: 'win32' }).team.fileTools, true, 'the host reads it at its next start');
  const off = await controller.handle('hostFileTools', { on: false });
  assert.equal(off.ok, true, 'turning off is always possible');
  assert.equal(off.restarted, false);
  assert.equal(savedFileTools(userDataPath), false);
});

test('a stopped team: on saves true where the loader reads it, off saves false; neither restarts', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-files-');
  const { controller, fake, logs } = createTestHostController(t, { userDataPath, secureStore: seededStore(), platform: 'linux',
    script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  const on = await controller.handle('hostFileTools', { on: true });
  assert.equal(on.ok, true, JSON.stringify(on));
  assert.equal(on.restarted, false);
  assert.deepEqual(on.host.file_tools, { on: true, state: 'saved', reason: null });
  assert.equal(savedFileTools(userDataPath), true);
  const configPath = prepareHostLayout(userDataPath).configPath;
  assert.equal(loadHostConfig(configPath, { platform: 'linux' }).team.fileTools, true, 'the host reads it at its next start');
  const off = await controller.handle('hostFileTools', { on: false });
  assert.deepEqual(off.host.file_tools, { on: false, state: 'off', reason: null });
  assert.equal(savedFileTools(userDataPath), false, 'stated false, so the launch carry never puts true back');
  assert.equal(fake.calls.length, 1, 'no start');
  assert.deepEqual(logs.filter((entry) => entry.event === 'team.host.file_tools_saved').map((entry) => entry.fields),
    [{ on: true, restart: false }, { on: false, restart: false }]);
});

test('a running team: on restarts the host, the launch keeps the setting, and the host\'s report drives the state', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-files-');
  const { controller, fake } = createTestHostController(t, { userDataPath, secureStore: seededStore(), platform: 'linux',
    script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.deepEqual(controller.snapshot().file_tools, { on: false, state: 'off', reason: null });
  const answer = await controller.handle('hostFileTools', { on: true });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.restarted, true);
  assert.equal(fake.calls.length, 2, 'stopped and started again');
  assert.equal(savedFileTools(userDataPath), true, 'the launch wrote its config afresh and carried the setting');
  assert.deepEqual(controller.snapshot().file_tools, { on: true, state: 'starting', reason: null }, 'no report yet');
  const child = fake.last();
  child.reply(report());
  await until(() => controller.snapshot().file_tools.state === 'working', 'the working report');
  child.reply(report({ available: false, reason: 'file_access_elevated' }));
  await until(() => controller.snapshot().file_tools.state === 'not_working', 'the failing report');
  assert.deepEqual(controller.snapshot().file_tools, { on: true, state: 'not_working', reason: 'file_access_elevated' });
  child.reply(report({ turns: 1 }));
  await until(() => controller.snapshot().file_tools.state === 'working', 'a report with a running turn');
  const refused = await controller.handle('hostFileTools', { on: false });
  assert.equal(refused.error.reason, 'team_host_turn_running');
  assert.equal(savedFileTools(userDataPath), true, 'nothing written');
  assert.equal(fake.calls.length, 2, 'no restart mid-turn');
  child.reply(report({ reason: 'C:\\Users\\owner' }));
  child.reply(report({ turns: 0 }));
  await until(() => controller.snapshot().file_tools.state === 'working', 'the idle report');
  assert.equal((await controller.handle('hostFileTools', { on: false })).ok, true, 'a path was dropped, the idle report taken');
  assert.notEqual(savedFileTools(userDataPath), true, 'off (the restart\'s fresh config carries only a true)');
  assert.equal(fake.calls.length, 3);
});

test('host-file-tools.js: every state, and every refusal before anything is written', async () => {
  const written = [];
  let snapshot = { state: 'stopped', files: null };
  let saved = { team: { name: 'Studio' } };
  let restarts = 0;
  const make = (overrides = {}) => createHostFileTools({ userDataPath: 'C:\\profile', platform: 'linux', supervisor: { snapshot: () => snapshot },
    writeConfig: (_layout, config) => { written.push(config); saved = config; }, restart: async () => { restarts += 1; return { ok: true, host: {} }; },
    generation: () => 0, hostState: () => ({}), readSaved: () => saved, ...overrides });
  const files = make();
  const views = [
    [{ team: {} }, { state: 'running', files: null }, { on: false, state: 'off', reason: null }],
    [{ team: { file_tools: true } }, { state: 'stopped' }, { on: true, state: 'saved', reason: null }],
    [{ team: { file_tools: true } }, { state: 'running', files: null }, { on: true, state: 'starting', reason: null }],
    [{ team: { file_tools: true } }, { state: 'running', files: { on: false } }, { on: true, state: 'saved', reason: null }],
    [{ team: { file_tools: true } }, { state: 'running', files: { on: true, available: false, reason: null } },
      { on: true, state: 'not_working', reason: 'file_access_unavailable' }],
    [{ team: { file_tools: 'yes' } }, { state: 'stopped' }, { on: false, state: 'off', reason: null }],
  ];
  for (const [config, snap, expected] of views) assert.deepEqual(files.view(config, snap), expected, JSON.stringify([config, snap]));
  const unreviewed = make({ platform: 'win32', windowsReviewed: false }); // the constant set back to false
  assert.deepEqual(unreviewed.view({ team: { file_tools: true } }, { state: 'stopped' }),
    { on: true, state: 'unavailable', reason: 'team_file_tools_windows_unreviewed' }, 'a hand-edited true can still be turned off');
  snapshot = { state: 'stopped', files: null };
  assert.equal((await unreviewed.set({ on: true })).error.reason, 'team_file_tools_windows_unreviewed');
  assert.equal(written.length, 0, 'refused before anything is written');
  assert.deepEqual(make({ platform: 'win32' }).view({ team: {} }, { state: 'stopped' }).state, 'off', 'the reviewed default');
  assert.equal((await files.set({ on: 'yes' })).error.code, 'invalid_request');
  snapshot = { state: 'starting', files: null };
  assert.equal((await files.set({ on: true })).error.reason, 'team_host_busy');
  snapshot = { state: 'stopped', files: null };
  assert.equal((await files.set({ on: false })).ok, true, 'already off: no write');
  assert.equal(written.length, 0);
  const failing = make({ writeConfig: () => { throw new Error('disk gone'); } });
  assert.equal((await failing.set({ on: true })).error.reason, 'team_host_config_write_failed');
  const restartFails = make({ restart: async () => ({ ok: false, error: { reason: 'team_host_port_busy' } }) });
  snapshot = { state: 'running', files: { on: false, available: false, reason: null, turns: 0 } };
  assert.equal((await restartFails.set({ on: true })).error.reason, 'team_host_port_busy');
  assert.deepEqual(written.at(-1).team, { name: 'Studio', file_tools: true });
  assert.equal(restarts, 0);
});

test('the link reports closed words and counts once per change; the channel takes exactly its fields', () => {
  assert.deepEqual(fileToolsState(null), { on: false, available: false, reason: null, turns: 0 });
  const backend = { hostRootBoundary: '/srv/projects', currentStatus: { hosted_files: { available: true, reason: null } },
    activeStreams: new Map() };
  assert.deepEqual(fileToolsState(backend), { on: true, available: true, reason: null, turns: 0 });
  backend.currentStatus.hosted_files = { available: false, reason: 'C:\\Users\\owner' };
  assert.deepEqual(fileToolsState(backend), { on: true, available: false, reason: null, turns: 0 }, 'a path is not a word');
  backend.currentStatus.hosted_files = { available: true, reason: 'file_access_elevated' };
  assert.deepEqual(fileToolsState(backend), { on: true, available: false, reason: 'file_access_elevated', turns: 0 });
  backend.activeStreams = new Map(Array.from({ length: 70 }, (_v, i) => [i, {}]));
  assert.equal(fileToolsState(backend).turns, 64, 'bounded');
  assert.deepEqual(fileToolsState({ hostRootBoundary: null, currentStatus: { hosted_files: { available: true } } }),
    { on: false, available: false, reason: null, turns: 0 }, 'no boundary: off, whatever the worker says');
  const sent = [];
  let tick = null;
  const link = createFileToolsLink({ backend: () => backend, send: (message) => sent.push(message),
    timers: { setInterval: (fn) => { tick = fn; return { unref() {} }; }, clearInterval: () => { tick = null; } } });
  tick();
  assert.equal(sent.length, 1, 'once at start, then only on a change');
  backend.activeStreams = new Map();
  tick();
  assert.deepEqual(sent.map((message) => message.turns), [64, 0]);
  assert.ok(sent.every(isOutbound), 'the parent channel accepts the message');
  assert.equal(isOutbound({ ...sent[0], path: '/srv' }), false, 'and nothing more');
  link.dispose();
  assert.equal(tick, null);
  const idle = [];
  const quiet = createFileToolsLink({ backend: () => ({ hostRootBoundary: null }), send: (message) => idle.push(message),
    timers: { setInterval: () => ({}), clearInterval: () => {} } });
  assert.deepEqual(idle, [], 'the idle state (off, no turn) is never sent, so a host with project files off says nothing');
  quiet.dispose();
});
