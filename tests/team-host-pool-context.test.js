'use strict';

// new-test-file: the owner's pool context length (row 201, OD-5) is a new desktop surface: `hostPoolContext` on the host
// controller and its sibling host-pool-context.js. The backend half (host-layout.js read/writePoolContextCap) is covered
// by tests/server/team-pool-host.test.js; this file covers the method, its bounds and what the host state says.

const assert = require('node:assert/strict');
const test = require('node:test');

const { HOST_KEY_NAME } = require('../services/team/host/host-key-store');
const { deriveTeamId, encodeBase64url, keyPairFromSeed } = require('../server/team/ids');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');
const { HOST_METHODS, HOST_OPERATIONS, validatePayload } = require('../services/team/ipc-methods');
const { loadHostConfig } = require('../server/config');
const { POOL_CONTEXT_AUTO, POOL_CONTEXT_MIN, prepareHostLayout, readPoolContextCap } = require('../services/team/host/host-layout');
const { createHostPoolContext } = require('../services/team/host/host-pool-context');

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });
const TEAM_ID = deriveTeamId(keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey);

function seededStore() {
  const secureStore = createMemorySecureStore();
  secureStore.values.set(HOST_KEY_NAME, encodeBase64url(Buffer.from(HOST_SEED)));
  return secureStore;
}

const poolOf = (userDataPath) => loadHostConfig(prepareHostLayout(userDataPath).configPath, { platform: 'linux' }).team.pool.contextLength;

test('hostPoolContext: the owner\'s own method, checked in main, never a host operation; the cap is null or a whole number in range', () => {
  assert.equal(HOST_METHODS.includes('hostPoolContext'), true);
  assert.equal(Object.hasOwn(HOST_OPERATIONS, 'hostPoolContext'), false, 'nothing a member can send to a host');
  for (const context_cap of [null, POOL_CONTEXT_MIN, 32768, POOL_CONTEXT_AUTO]) {
    assert.deepEqual(validatePayload('hostPoolContext', { context_cap }), { ok: true, value: { context_cap } }, String(context_cap));
  }
  for (const bad of [POOL_CONTEXT_MIN - 1, POOL_CONTEXT_AUTO + 1, 0, -1, 4096.5, '4096', true, NaN, Infinity, undefined, [4096], { n: 1 }]) {
    assert.equal(validatePayload('hostPoolContext', { context_cap: bad }).ok, false, String(bad));
  }
  for (const payload of [{}, null, undefined, { context_cap: 4096, path: '/srv' }, 4096]) {
    assert.equal(validatePayload('hostPoolContext', payload).ok, false, JSON.stringify(payload));
  }
});

test('a cap out of range is refused with its own reason, before anything is written', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-pool-');
  const { controller } = createTestHostController(t, { userDataPath, secureStore: seededStore(), platform: 'linux',
    script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  for (const bad of [POOL_CONTEXT_MIN - 1, POOL_CONTEXT_AUTO + 1, 4096.5, '4096', undefined]) {
    const refused = await controller.handle('hostPoolContext', { context_cap: bad });
    assert.equal(refused.ok, false, String(bad));
    assert.equal(refused.error.reason, 'team_pool_context_invalid', String(bad));
  }
  assert.equal((await controller.handle('hostPoolContext', { context_cap: 4096, path: '/srv' })).error.reason, 'team_pool_context_invalid');
  assert.equal(readPoolContextCap(userDataPath), null, 'nothing written');
});

test('before a deploy there is nothing to save into; the host state says Auto', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-pool-');
  const { controller } = createTestHostController(t, { userDataPath, secureStore: seededStore(), platform: 'linux',
    script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal(controller.snapshot().pool_context_cap, null);
  assert.equal((await controller.handle('hostPoolContext', { context_cap: 65536 })).error.reason, 'team_host_not_deployed');
  assert.equal(readPoolContextCap(userDataPath), null);
});

test('a stopped team: the cap is saved and read back, the next config carries it, Auto takes it off again', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-pool-');
  const { controller, fake, logs } = createTestHostController(t, { userDataPath, secureStore: seededStore(), platform: 'linux',
    script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal(poolOf(userDataPath), POOL_CONTEXT_AUTO, 'Auto by default');
  assert.equal(controller.snapshot().pool_context_cap, null);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  const set = await controller.handle('hostPoolContext', { context_cap: 65536 });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.restarted, false);
  assert.equal(set.host.pool_context_cap, 65536);
  assert.equal(readPoolContextCap(userDataPath), 65536);
  assert.equal(controller.snapshot().pool_context_cap, 65536, 'read back from the host state');
  assert.equal(fake.calls.length, 1, 'no start');
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal(poolOf(userDataPath), 65536, 'the next start writes it into the host config');
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  const auto = await controller.handle('hostPoolContext', { context_cap: null });
  assert.equal(auto.ok, true);
  assert.equal(auto.host.pool_context_cap, null);
  assert.equal(readPoolContextCap(userDataPath), null);
  assert.deepEqual(logs.filter((entry) => entry.event === 'team.host.pool_context_saved').map((entry) => entry.fields),
    [{ capped: true, running: false }, { capped: false, running: false }], 'no number in the log');
});

test('a running team: the cap is saved and pushed to every window; the host keeps running and takes it at its next start', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-pool-');
  const { controller, fake, pushed } = createTestHostController(t, { userDataPath, secureStore: seededStore(), platform: 'linux',
    script: healthyHostScript({ teamId: TEAM_ID }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const calls = fake.calls.length;
  const set = await controller.handle('hostPoolContext', { context_cap: 131072 });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(set.restarted, false, 'the running host is not interrupted');
  assert.equal(fake.calls.length, calls, 'no restart');
  assert.equal(controller.snapshot().state, 'running');
  assert.equal(pushed.at(-1).pool_context_cap, 131072, 'the push cache does not hide it');
  assert.equal(poolOf(userDataPath), POOL_CONTEXT_AUTO, 'the running host\'s config is the one it started with');
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal(poolOf(userDataPath), 131072, 'the next start has it');
});

test('host-pool-context.js: a payload with no cap, a write that fails, and a team that was never deployed', async () => {
  const written = [];
  let cap = null;
  const make = (overrides = {}) => createHostPoolContext({ userDataPath: 'C:\\profile', hostState: () => ({ pool_context_cap: cap }),
    pushState: () => {}, say: () => {}, readCap: () => cap, writeCap: (_dir, value) => { written.push(value); cap = value; return { ok: true }; }, ...overrides });
  const pool = make();
  assert.equal(pool.view(), null);
  assert.equal((await pool.set({})).error.reason, 'team_pool_context_invalid');
  assert.equal((await pool.set(null)).error.reason, 'team_pool_context_invalid');
  assert.equal(written.length, 0);
  assert.equal((await pool.set({ context_cap: 4096 })).ok, true);
  assert.equal(pool.view(), 4096);
  const failing = make({ writeCap: () => ({ ok: false, reason: 'team_host_config_write_failed' }) });
  assert.equal((await failing.set({ context_cap: 4096 })).error.reason, 'team_host_config_write_failed');
  const missing = make({ writeCap: () => ({ ok: false, reason: 'team_host_not_deployed' }) });
  assert.equal((await missing.set({ context_cap: null })).error.reason, 'team_host_not_deployed');
});
