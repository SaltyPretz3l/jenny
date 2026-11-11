'use strict';

// The desktop team host controller (slice 1f-2 review fixes) under races and
// refusals: a Stop pressed while Recover is stopping the old host, or while
// Deploy is still writing its config, is honoured; a saved direct port another
// process took is replaced; a host whose store already has an owner answers at
// once; every refusal path zeroes the seed it read.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { createHostKeyStore } = require('../services/team/host/host-key-store');
const { electronIsPackaged } = require('../services/team/host/host-launch');
const { BOUNDS, DIRECT_PORT, createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
const RECOVER = Object.freeze({ display_name: 'Olive Owner', label: 'Desk' });

// The real key store, with every seed it hands out kept so the test can see it was zeroed.
function trackingKeys(secureStore) {
  const real = createHostKeyStore({ getSecureStore: () => secureStore });
  const seeds = [];
  const keep = (seed) => { if (seed) seeds.push(seed); return seed; };
  return { seeds, load: () => keep(real.load()),
    loadOrCreate: () => { const made = real.loadOrCreate(); keep(made.seed); return made; } };
}

const zeroed = (seeds) => seeds.length > 0 && seeds.every((seed) => seed.every((byte) => byte === 0));

// A healthy host whose stop takes a moment, so a Stop can land while the controller waits for it.
function slowStopScript(teamId) {
  const healthy = healthyHostScript({ teamId });
  return (child, message) => {
    if (message.type === 'stop') {
      setTimeout(() => { child.reply({ type: 'stopped' }); setImmediate(() => child.exit(0)); }, 40);
      return;
    }
    healthy(child, message);
  };
}

test('a Stop pressed while Recover stops the old host is honoured: no host is started', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-race-');
  const { controller, fake } = createTestHostController(t, { userDataPath, secureStore: createMemorySecureStore(),
    script: slowStopScript('team_x') });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const recovering = controller.handle('hostRecover', { ...RECOVER });
  const stopping = controller.handle('hostStop', {});
  const [recovered, stopped] = await Promise.all([recovering, stopping]);
  assert.equal(stopped.ok, true);
  assert.deepEqual(recovered, { ok: false, error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE, reason: 'team_host_stopped' } });
  assert.equal(fake.calls.length, 1, 'Recover started no host after the Stop');
  assert.equal(controller.snapshot().state, 'stopped');
});

test('a Stop while Deploy is still writing its config is honoured, and the seed is zeroed', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-race-');
  const secureStore = createMemorySecureStore();
  const hostKeys = trackingKeys(secureStore);
  const late = {};
  const { controller, fake } = createTestHostController(t, { userDataPath, secureStore, hostKeys,
    script: healthyHostScript({ teamId: 'team_x' }),
    pickDirectPort: async () => { late.stop = late.controller.handle('hostStop', {}); return DIRECT_PORT; } });
  late.controller = controller;
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  await late.stop;
  assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE, reason: 'team_host_stopped' } });
  assert.equal(fake.calls.length, 0, 'no host is started');
  assert.equal(zeroed(hostKeys.seeds), true);
});

test('a saved direct port another process took is replaced, saved, and logged without the address', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-race-');
  const secureStore = createMemorySecureStore();
  const free = { [DIRECT_PORT]: true };
  let picks = 0;
  const { controller, logs } = createTestHostController(t, { userDataPath, secureStore,
    script: healthyHostScript({ teamId: 'team_x' }),
    pickDirectPort: async () => { picks += 1; return picks === 1 ? DIRECT_PORT : DIRECT_PORT + 7; },
    probeDirectPort: async (port) => free[port] === true });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  free[DIRECT_PORT] = false;
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const config = JSON.parse(fs.readFileSync(path.join(userDataPath, 'team-host', 'host-config.json'), 'utf8'));
  assert.equal(config.team.direct_port, DIRECT_PORT + 7, 'a new port is chosen and saved');
  const warned = logs.filter((entry) => entry.event === 'team.host.direct_port_replaced');
  assert.equal(warned.length, 1);
  assert.equal(warned[0].level, 'WARN');
  assert.equal(JSON.stringify(warned).includes(String(DIRECT_PORT)), false, 'no address in the log');
});

test('a host whose store already has an owner says so and Deploy answers at once', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-race-');
  const service = { holds: () => false, ownerJoin: async () => assert.fail('no invite, no join') };
  const { controller } = createTestHostController(t, { userDataPath, secureStore: createMemorySecureStore(), service,
    bounds: { ...BOUNDS, ownerInviteMs: 10_000 },
    script: (child, message) => {
      if (message.type === 'start') {
        setImmediate(() => {
          child.reply({ type: 'ready', boot_epoch: 'e', team_id: 'team_x', public_key: 'pk', addresses: [] });
          setImmediate(() => child.reply({ type: 'owner_exists' }));
        });
      }
      if (message.type === 'stop') setImmediate(() => { child.reply({ type: 'stopped' }); setImmediate(() => child.exit(0)); });
    } });
  const begun = Date.now();
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.ok(Date.now() - begun < 2_000, 'no wait for the invite bound');
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.owner, { state: 'failed',
    error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE, reason: 'team_owner_recover_needed' } });
});

test('a config that cannot be written zeroes the seed', async (t) => {
  const outer = tempProfile(t, 'jenny-host-race-');
  const userDataPath = path.join(outer, 'a-file');
  fs.writeFileSync(userDataPath, 'not a directory');
  const secureStore = createMemorySecureStore();
  const hostKeys = trackingKeys(secureStore);
  const { controller, fake } = createTestHostController(t, { userDataPath, secureStore, hostKeys,
    script: healthyHostScript({ teamId: 'team_x' }) });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.error.reason, 'team_host_config_write_failed');
  assert.equal(fake.calls.length, 0);
  assert.equal(zeroed(hostKeys.seeds), true);
});

test('a failure after the key is read zeroes the seed', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-race-');
  const secureStore = createMemorySecureStore();
  const hostKeys = trackingKeys(secureStore);
  const service = { holds: () => { throw new Error('boom'); } };
  const { controller, fake } = createTestHostController(t, { userDataPath, secureStore, hostKeys, service,
    script: healthyHostScript({ teamId: 'team_x' }) });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.ok, false);
  assert.equal(fake.calls.length, 0);
  assert.equal(zeroed(hostKeys.seeds), true);
});

// Deploys once, then changes the saved config with `edit` (null removes it) and asks Recover.
async function recoverAfter(t, edit) {
  const userDataPath = tempProfile(t, 'jenny-host-race-');
  const secureStore = createMemorySecureStore();
  const first = createTestHostController(t, { userDataPath, secureStore, script: healthyHostScript({ teamId: 'team_x' }) });
  assert.equal((await first.controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  await first.controller.stop();
  const configPath = path.join(userDataPath, 'team-host', 'host-config.json');
  const changed = edit(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  if (changed) fs.writeFileSync(configPath, JSON.stringify(changed)); else fs.rmSync(configPath);
  const hostKeys = trackingKeys(secureStore);
  const { controller, fake } = createTestHostController(t, { userDataPath, secureStore, hostKeys,
    script: healthyHostScript({ teamId: 'team_x' }) });
  return { answer: await controller.handle('hostRecover', { ...RECOVER }), hostKeys, fake };
}

test('Recover with no saved config zeroes the seed', async (t) => {
  const { answer, hostKeys } = await recoverAfter(t, () => null);
  assert.equal(answer.error.reason, 'team_host_not_deployed');
  assert.equal(zeroed(hostKeys.seeds), true);
});

test('Recover works on a config written before E19 (with a model_endpoint) and rewrites it without one', async (t) => {
  const { answer, fake } = await recoverAfter(t, (config) => ({ ...config,
    model_endpoint: { engine: 'ollama', model: 'm', api_url: 'http://127.0.0.1:11434' }, python_executable: process.execPath }));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(fake.calls.length, 1);
  const config = JSON.parse(fs.readFileSync(fake.calls[0].args[1], 'utf8'));
  assert.equal(Object.hasOwn(config, 'model_endpoint'), false);
  assert.equal(Object.hasOwn(config, 'python_executable'), false);
});

test('the first Deploy reads the secure store once', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-race-');
  const secureStore = createMemorySecureStore();
  let reads = 0;
  const get = secureStore.get.bind(secureStore);
  secureStore.get = (name) => { reads += 1; return get(name); };
  const { controller } = createTestHostController(t, { userDataPath, secureStore, script: healthyHostScript({ teamId: 'team_x' }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal(reads, 1);
});

test('the direct port probe sees a port another socket holds', async (t) => {
  const { pickDirectPort, probeDirectPort } = require('../services/team/host/host-layout');
  const port = await pickDirectPort();
  assert.equal(await probeDirectPort(port), true);
  const holder = require('node:dgram').createSocket('udp4');
  await new Promise((resolve) => { holder.bind(port, '127.0.0.1', resolve); });
  t.after(() => holder.close());
  assert.equal(await probeDirectPort(port), false);
});

test('electronIsPackaged fails closed when Electron cannot answer', () => {
  // Under plain Node, `require('electron')` is the npm path string: no `app` to ask.
  assert.equal(electronIsPackaged(), true);
});
