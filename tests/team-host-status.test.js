'use strict';

// What `team.hostStatus` and the pushed `team.onHostState` state say about a team
// this Jenny hosted before (slice 1g-1, for the Settings Team page). A new app
// session starts every host at `stopped` with no id or name, so the controller
// adds `deployed` (a saved host config exists) and fills `team_name` from that
// config and `team_id` from the stored host key. The key is read only for a
// deployed profile, at most once, and its seed is zeroed; a failing key store
// gives `team_id: null`, never a throw or a log line with key material.

const assert = require('node:assert/strict');
const test = require('node:test');

const { HOST_KEY_NAME, createHostKeyStore } = require('../services/team/host/host-key-store');
const { deriveTeamId, encodeBase64url, keyPairFromSeed } = require('../server/team/ids');
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
  keys.loadOrCreate = () => {
    const made = real.loadOrCreate();
    keys.seeds.push(made.seed);
    return made;
  };
  return keys;
}

function seededStore() {
  const secureStore = createMemorySecureStore();
  secureStore.values.set(HOST_KEY_NAME, encodeBase64url(Buffer.from(HOST_SEED)));
  return secureStore;
}

// Deploys and stops once on `userDataPath`, as an earlier app session would have.
async function deployedBefore(t, userDataPath, secureStore) {
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
  assert.deepEqual(Object.keys(first.host).sort(), ['deployed', 'reason', 'since', 'state', 'team_id', 'team_name']);
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
  const origLoadOrCreate = hostKeys.loadOrCreate;
  hostKeys.loadOrCreate = () => {
    const made = origLoadOrCreate();
    teamId = deriveTeamId(keyPairFromSeed(made.seed).publicKey);
    return made;
  };
  const first = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(first.host.team_id, teamId);
  const stopped = await controller.handle('hostStop', {});
  assert.equal(stopped.host.state, 'stopped');
  assert.equal(stopped.host.team_id, teamId);
  assert.equal(stopped.host.deployed, true);
  const again = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(again.host.team_id, teamId);
  assert.equal(hostKeys.loads, 0, 'Deploy derived the id itself; status never read the key');
});
