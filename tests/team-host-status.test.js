'use strict';

// What `team.hostStatus` and the pushed `team.onHostState` state say about a team
// this Jenny hosted before (slice 1g-1, for the Settings Team page). A new app
// session starts every host at `stopped` with no id or name, so the controller
// adds `deployed` (a saved host config exists) and fills `team_name` from that
// config and `team_id` from the stored host key. The key is read only for a
// deployed profile, at most once, and its seed is zeroed; a failing key store
// gives `team_id: null`, never a throw or a log line with key material.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HOST_KEY_NAME, createHostKeyStore } = require('../services/team/host/host-key-store');
const { buildHostConfig, prepareHostLayout, writeHostConfig } = require('../services/team/host/host-layout');
const { decodeBase64url, deriveTeamId, encodeBase64url, keyPairFromSeed } = require('../server/team/ids');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
const TEAM_ID = deriveTeamId(keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey);

// The real key store with its reads counted and every seed it handed out kept.
function countingKeys(secureStore, { throwOnLoad = false } = {}) {
  const real = createHostKeyStore({ getSecureStore: () => secureStore });
  const keys = { loads: 0, seeds: [] };
  keys.load = () => {
    keys.loads += 1;
    if (throwOnLoad) throw new Error('store exploded');
    const seed = real.load();
    if (seed) keys.seeds.push(seed);
    return seed;
  };
  keys.create = () => {
    const seed = real.create();
    keys.seeds.push(seed);
    return seed;
  };
  return keys;
}

function seededStore() {
  const secureStore = createMemorySecureStore();
  secureStore.values.set(HOST_KEY_NAME, encodeBase64url(Buffer.from(HOST_SEED)));
  return secureStore;
}

// Deploys and stops once on `userDataPath`, as an earlier app session would have. The saved config comes first so the
// Deploy keeps the seeded key (E75: a Deploy with no config makes a fresh one).
async function deployedBefore(t, userDataPath, secureStore) {
  const layout = prepareHostLayout(userDataPath);
  writeHostConfig(layout, buildHostConfig({ layout, name: 'Studio', directPort: 45123 }));
  const { controller } = createTestHostController(t, { userDataPath, secureStore,
    script: healthyHostScript({ teamId: TEAM_ID }) });
  const deployed = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(deployed.ok, true, JSON.stringify(deployed));
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  await controller.stop();
}

const zeroed = (seeds) => seeds.every((seed) => seed.every((byte) => byte === 0));

test('a never-deployed profile: deployed false, no id or name, and the key store is never read', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-status-');
  const secureStore = seededStore();
  const hostKeys = countingKeys(secureStore);
  const { controller } = createTestHostController(t, { userDataPath, secureStore, hostKeys,
    script: healthyHostScript({ teamId: TEAM_ID }) });
  const answer = await controller.handle('hostStatus', {});
  assert.equal(answer.ok, true);
  assert.equal(answer.host.state, 'stopped');
  assert.equal(answer.host.deployed, false);
  assert.equal(answer.host.team_id, null);
  assert.equal(answer.host.team_name, null);
  assert.equal(hostKeys.loads, 0, 'no key read for a profile that never deployed');
  assert.equal(controller.snapshot().deployed, false);
});

test('after a restart: a new controller on a deployed profile answers deployed, the saved name and the key\'s team id', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-status-');
  const secureStore = seededStore();
  await deployedBefore(t, userDataPath, secureStore);

  const hostKeys = countingKeys(secureStore);
  const { controller, logs } = createTestHostController(t, { userDataPath, secureStore, hostKeys,
    script: healthyHostScript({ teamId: TEAM_ID }) });
  const first = await controller.handle('hostStatus', {});
  assert.deepEqual({ state: first.host.state, deployed: first.host.deployed, team_id: first.host.team_id,
    team_name: first.host.team_name }, { state: 'stopped', deployed: true, team_id: TEAM_ID, team_name: 'Studio' });
  const second = await controller.handle('hostStatus', {});
  assert.equal(second.host.team_id, TEAM_ID);
  assert.equal(hostKeys.loads, 1, 'the key is read once and only the team id is kept');
  assert.equal(zeroed(hostKeys.seeds), true, 'the seed is zeroed after deriving');
  const serialized = JSON.stringify({ first, second, logs });
  assert.equal(serialized.includes(secureStore.values.get(HOST_KEY_NAME)), false, 'no key material anywhere');
  assert.deepEqual(Object.keys(first.host).sort(),
    ['autostart', 'deployed', 'desktop_hosting', 'direct_port', 'file_tools', 'internet', 'internet_draft', 'key', 'model_relay', 'old_teams', 'operation', 'owner',
      'pool_context_cap', 'reach', 'reason', 'since', 'state', 'team_id', 'team_name']);
  // Slice 6-7: the owner's model relay setting (the default 2 when the config names none), nothing passing while stopped.
  assert.deepEqual(first.host.model_relay, { flowing: 2, passing: 0, live: false });
  // Slice 5-6: the key's state is read without pressing Start; a stopped team with its key says 'ok'.
  assert.equal(first.host.key, 'ok');
  assert.equal(first.host.internet, null);
  assert.deepEqual(first.host.old_teams, []);
});

test('a key store that throws: deployed true, team_id null, the call answers and logs nothing of the key', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-status-');
  const secureStore = seededStore();
  await deployedBefore(t, userDataPath, secureStore);

  const hostKeys = countingKeys(secureStore, { throwOnLoad: true });
  const { controller, logs } = createTestHostController(t, { userDataPath, secureStore, hostKeys,
    script: healthyHostScript({ teamId: TEAM_ID }) });
  const answer = await controller.handle('hostStatus', {});
  assert.equal(answer.ok, true);
  assert.equal(answer.host.deployed, true);
  assert.equal(answer.host.team_id, null);
  assert.equal(answer.host.team_name, 'Studio');
  assert.equal(JSON.stringify(logs).includes('exploded'), false);
});

test('the pushed state carries deployed, team_id and team_name too', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-status-');
  const secureStore = seededStore();
  await deployedBefore(t, userDataPath, secureStore);

  const { controller, pushed } = createTestHostController(t, { userDataPath, secureStore,
    script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  assert.ok(pushed.length >= 3, JSON.stringify(pushed));
  for (const state of pushed) {
    assert.equal(state.deployed, true, JSON.stringify(state));
    assert.equal(state.team_id, TEAM_ID, JSON.stringify(state));
    assert.equal(state.team_name, 'Studio', JSON.stringify(state));
  }
  assert.deepEqual(pushed.map((state) => state.state).filter((s, i, all) => all.indexOf(s) === i),
    ['starting', 'running', 'stopping', 'stopped']);
});

test('a Deploy after a Stop reports the same team id as before, with no extra key read', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-status-');
  const secureStore = createMemorySecureStore();
  const hostKeys = countingKeys(secureStore);
  let teamId = null;
  const script = (child, message) => healthyHostScript({ teamId })(child, message);
  const { controller } = createTestHostController(t, { userDataPath, secureStore, hostKeys, script });
  // The first Deploy makes the key; the fake host reports the id derived from it.
  const origCreate = hostKeys.create;
  hostKeys.create = () => {
    const seed = origCreate();
    teamId = deriveTeamId(keyPairFromSeed(seed).publicKey);
    return seed;
  };
  const first = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(first.host.team_id, teamId);
  const stopped = await controller.handle('hostStop', {});
  assert.equal(stopped.host.state, 'stopped');
  assert.equal(stopped.host.team_id, teamId);
  assert.equal(stopped.host.deployed, true);
  const again = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(again.host.team_id, teamId);
  // A Deploy on a deployed profile reads its key with load(), never create().
  assert.equal(hostKeys.loads, 1, 'only the second Deploy read the key; status never did');
});

// Owner decision E75 (2026-11-14): a Deploy on a PC with no saved host config always makes a fresh key and writes it
// over any key found in the secure store (a crash between the key and the config, a stray key, one that does not
// decode); none is adopted, and nothing of either key is logged. A Deploy over a saved config that reads keeps its key
// (the test above).
test('E75: a Deploy with no saved config replaces a key found in the secure store and adopts none', async (t) => {
  for (const found of [encodeBase64url(Buffer.from(HOST_SEED)), 'not.a.key']) {
    const userDataPath = tempProfile(t, 'jenny-host-e75-');
    const secureStore = createMemorySecureStore();
    secureStore.values.set(HOST_KEY_NAME, found);
    const { controller, fake, logs, pushed } = createTestHostController(t, { userDataPath, secureStore,
      script: healthyHostScript({ teamId: 't' }) });
    const answer = await controller.handle('hostDeploy', { ...DEPLOY });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const stored = secureStore.values.get(HOST_KEY_NAME);
    assert.notEqual(stored, found, 'the key found was replaced');
    const seed = decodeBase64url(stored, 32);
    assert.ok(seed, 'a whole new key is stored');
    assert.notEqual(deriveTeamId(keyPairFromSeed(seed).publicKey), TEAM_ID);
    assert.equal(fake.last().posted.find((m) => m.type === 'start').host_key, stored, 'the child got the new key');
    const said = JSON.stringify([answer, logs, pushed]);
    for (const key of [found, stored]) assert.equal(said.includes(key), false, 'no key material logged or answered');
    assert.equal((await controller.handle('hostStop', {})).ok, true);
    // The next Deploy runs over the saved config and keeps the key.
    assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
    assert.equal(secureStore.values.get(HOST_KEY_NAME), stored);
  }
});

test('reach and direct_port are in every state; reach only while running, direct_port from the saved config', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-status-');
  const secureStore = seededStore();
  const script = (child, message) => {
    healthyHostScript({ teamId: TEAM_ID })(child, message);
    if (message.type === 'start') setTimeout(() => child.reply({ type: 'reach', result: 'relay', reason: 'relay_connected' }), 20);
  };
  const { controller, pushed } = createTestHostController(t, { userDataPath, secureStore, script });
  const never = await controller.handle('hostStatus', {});
  assert.equal(never.host.reach, null);
  assert.equal(never.host.direct_port, null, 'no saved config, no port');
  const deployed = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(deployed.ok, true, JSON.stringify(deployed));
  const running = await controller.handle('hostStatus', {});
  assert.deepEqual(running.host.reach, { result: 'relay', reason: 'relay_connected' });
  assert.equal(running.host.direct_port, 45123);
  await controller.handle('hostStop', {});
  const stopped = await controller.handle('hostStatus', {});
  assert.equal(stopped.host.reach, null);
  assert.equal(stopped.host.direct_port, 45123, 'the saved port stays after a stop');
  assert.ok(pushed.length > 0);
  for (const state of pushed) {
    assert.equal(Object.hasOwn(state, 'reach') && Object.hasOwn(state, 'direct_port'), true, state.state);
    if (state.state !== 'running') assert.equal(state.reach, null, state.state);
  }
  assert.ok(pushed.some((state) => state.reach?.reason === 'relay_connected'), 'the verdict was pushed');
});

// Review sweeps, second run (X4b-F02, first-run X4-F07): a saved config that is there but does not read (torn, not
// JSON, a newer schema) is never "not deployed". The page says so, Deploy, Recover and the internet setting refuse
// with `team_host_config_unreadable` (so do the inventory, Delete and Export), and nothing rewrites the file. A config that reads keeps internet joining, the
// direct port and the model relay setting through a Deploy.
const configFile = (userDataPath) => path.join(userDataPath, 'team-host', 'host-config.json');
const readConfig = (userDataPath) => JSON.parse(fs.readFileSync(configFile(userDataPath), 'utf8'));
const INTERNET = Object.freeze({ map_port: true, public_address: 'team.example.org', relay_url: null });

async function deployedWithSettings(t) {
  const userDataPath = tempProfile(t, 'x4b-f02-');
  let picks = 0;
  const made = createTestHostController(t, { userDataPath, secureStore: seededStore(),
    script: healthyHostScript({ teamId: TEAM_ID }), pickDirectPort: async () => { picks += 1; return 45000 + picks; } });
  assert.equal((await made.controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await made.controller.handle('hostModelRelay', { flowing: 0 })).ok, true);
  assert.equal((await made.controller.handle('hostStop', {})).ok, true);
  const config = readConfig(userDataPath);
  config.team.internet = { ...INTERNET };
  fs.writeFileSync(configFile(userDataPath), JSON.stringify(config));
  return { ...made, userDataPath };
}

test('X4b-F02: a config that reads keeps internet joining, the direct port and the relay setting through a Deploy', async (t) => {
  const host = await deployedWithSettings(t);
  assert.equal((await host.controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const team = readConfig(host.userDataPath).team;
  assert.deepEqual({ internet: team.internet, port: team.direct_port, flowing: team.model_relay_flowing },
    { internet: INTERNET, port: 45001, flowing: 0 });
});

test('X4b-F02: a config that does not read is deployed on the page; Deploy, Recover, the internet setting and the lifecycle refuse and leave it', async (t) => {
  for (const damage of [(text) => `${text}x`, () => Buffer.alloc(512), (text) => text.slice(0, 40)]) {
    const host = await deployedWithSettings(t);
    const bytes = Buffer.from(damage(fs.readFileSync(configFile(host.userDataPath), 'utf8')));
    fs.writeFileSync(configFile(host.userDataPath), bytes);
    const status = (await host.controller.handle('hostStatus', {})).host;
    assert.deepEqual({ deployed: status.deployed, reason: status.reason, key: status.key },
      { deployed: true, reason: 'team_host_config_unreadable', key: 'ok' });
    const reasons = [];
    for (const [method, payload] of [['hostDeploy', DEPLOY], ['hostRecover', { display_name: 'Olive Owner', label: 'Desk' }],
      ['hostInternet', { enabled: false }], ['hostInventory', {}], ['hostDelete', { name: DEPLOY.name }],
      ['hostExport', { password: 'a long backup password' }]]) {
      const answer = await host.controller.handle(method, { ...payload });
      reasons.push(answer.ok ? 'ok' : answer.error.reason);
    }
    assert.deepEqual(reasons, Array(6).fill('team_host_config_unreadable'));
    // Known limit: the relay setting still says not deployed; it writes nothing either way (the bytes below).
    assert.equal((await host.controller.handle('hostModelRelay', { flowing: 2 })).error?.reason, 'team_host_not_deployed');
    assert.deepEqual(fs.readFileSync(configFile(host.userDataPath)), bytes, 'the damaged file is left as it was');
  }
});

test('X4b-F02: a config from a newer Jenny is never rewritten as schema 3', async (t) => {
  const host = await deployedWithSettings(t);
  const bytes = JSON.stringify({ ...readConfig(host.userDataPath), schema_version: 4, later_field: { kept: true } });
  fs.writeFileSync(configFile(host.userDataPath), bytes);
  const answer = await host.controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.ok ? 'ok' : answer.error.reason, 'team_host_config_unreadable');
  assert.equal((await host.controller.handle('hostStatus', {})).host.deployed, true);
  assert.equal(fs.readFileSync(configFile(host.userDataPath), 'utf8'), bytes, 'the newer file is unchanged');
});
