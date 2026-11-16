'use strict';

// Slice 4a-4 (T6): the pool composition on a team host. The team host fixture's
// fake backend records how it was built; the pool is real (scheduler and loopback
// gateway). No sidecar, no bridge binary, no window.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const test = require('node:test');

const { createPoolComposition } = require('../../server/team/pool-composition');
const path = require('node:path');

const { ClientRegistry } = require('../../server/client-registry');
const { loadHostConfig } = require('../../server/config');
const { ControlLeases } = require('../../server/control-leases');
const { FileSecretStore } = require('../../server/file-secret-store');
const { createHostCore } = require('../../server/host-core');
const { createFakeBridgeSpawner } = require('./helpers/fake-bridge');
const { createTeamHostFixture, TEAM_NAME, writeSingleOwnerConfig } = require('./helpers/team-host-fixture');
const { registerParams } = require('./helpers/team-node-fixture');
const { command } = require('../helpers/command-router-fixture');
const { DEPLOY_POOL_CONTEXT_LENGTH, buildHostConfig } = require('../../services/team/host/host-layout');

const CONTEXT = 32768;

function poolConfig(fx, pool = { context_length: CONTEXT }) {
  fx.writeConfig({ extra: { model_endpoint: undefined,
    team: { name: TEAM_NAME, key_source: 'secret_file', direct_port: null, ...(pool ? { pool } : {}) } } });
}

// Holds every composition the host builds.
function poolSeam() {
  const built = [];
  const createPool = (input) => {
    const pool = createPoolComposition(input);
    built.push({ input, pool });
    return pool;
  };
  return { built, createPool };
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const EMPTY = Object.freeze({ listening: false, sockets: 0, timers: 0, waiters: 0, leases: 0 });

test('with pool the backend is built on the gateway endpoint, the turn route and the boot key', async (t) => {
  const fx = createTeamHostFixture(t);
  poolConfig(fx);
  const before = fs.readFileSync(fx.configPath);
  const seam = poolSeam();
  const host = await fx.start(null, { createPool: seam.createPool });
  assert.equal(seam.built.length, 1);
  const { input, pool } = seam.built[0];
  assert.equal(input.contextLength, CONTEXT);
  const { options, backend } = fx.backends[0];
  assert.equal(options.modelEndpoint.engine, 'openai-compatible');
  assert.equal(options.modelEndpoint.model, 'team-pool');
  assert.match(options.modelEndpoint.apiUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
  assert.equal(options.turnRoute, pool.turnRoute);
  const key = options.credentialService.get('openai_compatible_api_key');
  assert.match(key, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(key, pool.modelCredential());
  assert.equal(options.credentialService.get('team_host_key'), null, 'every other key reads the mounted files as before');
  assert.equal(options.credentialService.getStatus().storageBackend, 'mounted_files');
  // The gateway is the one thing the pool adds, and it answers the key.
  assert.deepEqual(pool.resources(), { listening: true, sockets: 0, timers: 1, waiters: 0, leases: 0 });
  const port = Number(new URL(options.modelEndpoint.apiUrl).port);
  assert.equal(await get(port, '/v1/models', { authorization: `Bearer ${key}` }), 200);
  // The lanes are fed (no node yet: one turn).
  assert.equal(backend.sessionRuntime.lanes.snapshot().configured.local.runnable_turns, 1);
  pool.scheduler.registerNode({ deviceId: 'device_n', memberId: 'member_node', slots: 3,
    models: [{ id: 'alpha', context_length: CONTEXT, vision: false, thinking: false }] });
  assert.equal(backend.sessionRuntime.lanes.snapshot().configured.local.runnable_turns, 3);
  pool.scheduler.registerNode({ deviceId: 'device_s', memberId: 'member_small', slots: 1,
    models: [{ id: 'small', context_length: 4096, vision: false, thinking: false }] });
  const granted = pool.scheduler.requestLease({ conversationKey: 'conv:-:s', memberId: 'member_alice', model: 'small', wantsVision: false });
  assert.equal(granted.ok, true, 'a smaller model is leased: each turn is sized for its own model (slice 4f)');
  assert.deepEqual([granted.lease.model_info.id, granted.lease.model_info.context_length], ['small', 4096],
    'the lease names that model with its own length, so the turn is sized at 4096');
  assert.equal(Buffer.compare(fs.readFileSync(fx.configPath), before), 0, 'the config file is never rewritten');
  await host.stop();
  assert.deepEqual(pool.resources(), EMPTY);
  assert.equal(pool.modelCredential(), null);
  await assert.rejects(get(port, '/v1/models'), (error) => error.code === 'ECONNREFUSED');
});

test('without pool nothing is created: no gateway, no turn route, a credential port that answers nothing', async (t) => {
  const fx = createTeamHostFixture(t);
  poolConfig(fx, null);
  const seam = poolSeam();
  await fx.start(null, { createPool: seam.createPool });
  assert.equal(seam.built.length, 0);
  const { options } = fx.backends[0];
  assert.equal(options.modelEndpoint, null);
  assert.equal(Object.hasOwn(options, 'turnRoute'), false);
  assert.equal(options.credentialService instanceof FileSecretStore, false, 'a team host holds no mounted API key');
  assert.equal(options.credentialService.get('openai_compatible_api_key'), null);
});

test('a team host with an openai-compatible endpoint never reads the mounted model key; a single-owner host does', async (t) => {
  const fx = createTeamHostFixture(t);
  fx.writeConfig({ extra: { model_endpoint: { engine: 'openai-compatible', model: 'local', api_url: 'http://127.0.0.1:8081/v1' } } });
  fs.writeFileSync(path.join(fx.secrets, 'model-api-key'), 'test-only-model-key\n', { mode: 0o600 });
  await fx.start(null, { createPool: poolSeam().createPool });
  const port = fx.backends[0].options.credentialService;
  assert.equal(fx.backends[0].options.modelEndpoint.engine, 'openai-compatible', 'a local OpenAI-compatible server is allowed');
  for (const name of ['openai_compatible_api_key', 'team_host_key', 'anything']) assert.equal(port.get(name), null, name);
  // The single-owner host composition still reads the mounted file.
  const configPath = writeSingleOwnerConfig(fx.root);
  const config = loadHostConfig(configPath);
  fs.writeFileSync(path.join(config.secretsDir, 'model-api-key'), 'test-only-model-key\n', { mode: 0o600 });
  const core = createHostCore({ config, clients: new ClientRegistry(), leases: new ControlLeases(),
    createBackend: fx.createBackend, logger: () => {} });
  t.after(() => core.dispose());
  assert.equal(fx.backends[1].options.credentialService.get('openai_compatible_api_key'), 'test-only-model-key');
});

test('a start that fails after the pool started leaves nothing listening', async (t) => {
  const fx = createTeamHostFixture(t);
  poolConfig(fx);
  const seam = poolSeam();
  const broken = createFakeBridgeSpawner(fx.fake, { startFails: 'bind_failed' });
  await assert.rejects(fx.start(null, { createPool: seam.createPool, spawnBridge: broken }),
    (error) => error.reason === 'team_transport_down');
  const { pool } = seam.built[0];
  assert.deepEqual(pool.resources(), EMPTY);
  assert.equal(pool.modelCredential(), null);
  const port = Number(new URL(fx.backends[0].options.modelEndpoint.apiUrl).port);
  assert.equal(await fx.isListening(port), false);
  assert.equal(fx.lock.released, 1);
  assert.equal(fx.backends[0].calls.at(-1), 'dispose');
});

test('a pool that is stopped even when the host core disposal throws', async (t) => {
  const fx = createTeamHostFixture(t);
  poolConfig(fx);
  const seam = poolSeam();
  const createBackend = (options) => {
    const composition = fx.createBackend(options);
    composition.dispose = async () => { throw new Error('dispose failed'); };
    return composition;
  };
  const host = await fx.start(null, { createPool: seam.createPool, createBackend });
  await assert.rejects(host.stop());
  assert.deepEqual(seam.built[0].pool.resources(), EMPTY);
});

test('a lane object that is missing refuses the start as team_pool_unavailable', async (t) => {
  const fx = createTeamHostFixture(t);
  poolConfig(fx);
  const seam = poolSeam();
  const createBackend = (options) => {
    const composition = fx.createBackend(options);
    composition.backend.sessionRuntime = null;
    return composition;
  };
  await assert.rejects(fx.start(null, { createPool: seam.createPool, createBackend }),
    (error) => error.reason === 'team_pool_unavailable');
  assert.deepEqual(seam.built[0].pool.resources(), EMPTY);
  assert.equal(fx.lock.released, 1);
});

// Slice 4a-5 (E65): there is no special host node. A host started from the config Deploy writes takes
// the owner's own Jenny as a node through `team.node.register`, and a lease then finds that node.
test('a host from Deploy\'s config accepts the owner\'s node and a lease finds it', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const real = (name) => { const dir = path.join(fx.root, name); fs.mkdirSync(dir, { recursive: true }); return fs.realpathSync.native(dir); };
  const layout = { profile: fs.realpathSync.native(fx.profile), secrets: fs.realpathSync.native(fx.secrets),
    runtime: real('runtime'), projects: real('projects') };
  // With the interpreter a source-checkout Deploy writes; the fake backend starts no sidecar.
  fs.writeFileSync(fx.configPath, JSON.stringify(buildHostConfig({ layout, name: TEAM_NAME, directPort: null,
    lockPython: process.execPath })));
  const loaded = loadHostConfig(fx.configPath);
  assert.deepEqual([loaded.team.pool, loaded.pythonExecutable], [{ contextLength: DEPLOY_POOL_CONTEXT_LENGTH }, process.execPath]);
  const { owner } = await fx.seedMembers(fx.client().deviceKey);
  const seam = poolSeam();
  const parent = fx.newParent();
  const starting = fx.start(parent, { createPool: seam.createPool });
  parent.emit({ type: 'start', host_key: fx.hostKey });
  await starting;
  assert.equal(seam.built[0].input.contextLength, DEPLOY_POOL_CONTEXT_LENGTH);
  const ctx = fx.context();
  const auth = ctx.clients.register(owner.device_id);
  const registered = await ctx.router.dispatch({ ...command(auth, 'team.node.register', registerParams()), boot_epoch: ctx.bootEpoch },
    { deviceId: owner.device_id, clientToken: auth.client_token, isAuthenticated: () => true, actor: { device_id: owner.device_id } });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const { scheduler } = seam.built[0].pool;
  assert.deepEqual(scheduler.listNodes().map((node) => [node.node_id, node.member_id]), [[registered.node_id, owner.member_id]]);
  const granted = scheduler.requestLease({ conversationKey: 'conv:-:owner', memberId: owner.member_id, model: 'alpha', wantsVision: false });
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.equal(granted.lease.node_id, registered.node_id, 'the owner\'s own GPU serves the turn');
});

test('neither the boot key nor a route token reaches a log record or a parent message', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  fx.writeConfig({ source: 'parent_channel', extra: { model_endpoint: undefined,
    team: { name: TEAM_NAME, key_source: 'parent_channel', direct_port: null, pool: { context_length: CONTEXT } } } });
  // A real owner: the pool asks the host's authorizer who may use it.
  const seeded = await fx.seedMembers(fx.client().deviceKey);
  const seam = poolSeam();
  const parent = fx.newParent();
  const starting = fx.start(parent, { createPool: seam.createPool });
  parent.emit({ type: 'start', host_key: fx.hostKey });
  const host = await starting;
  const { pool } = seam.built[0];
  const key = pool.modelCredential();
  pool.scheduler.registerNode({ deviceId: 'device_n', memberId: 'member_node', slots: 1,
    models: [{ id: 'alpha', context_length: CONTEXT, vision: false, thinking: false }] });
  const handle = await pool.turnRoute.acquire({ sessionId: 'session_1', projectId: null, memberId: seeded.owner.member_id,
    model: 'alpha', wantsVision: false });
  handle.release({ ok: true });
  await host.stop();
  const records = JSON.stringify([fx.logs, parent.sent]);
  for (const secret of [key, handle.token]) assert.equal(records.includes(secret), false);
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach', 'stopped']);
});

// Gate fault F2: the alias resolves to the team model, then Automatic (the GPU list's own chooser), then the
// only model. Eight models online, as an Ollama node offers them.
const EIGHT = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
const offer = (id, contextLength = CONTEXT) => ({ id, context_length: contextLength, vision: false, thinking: false });

async function resolvingPool(t, teamModel) {
  const pool = createPoolComposition({ contextLength: CONTEXT, mayUsePool: () => true, logger: () => {}, teamModel: () => teamModel.value });
  t.after(() => pool.stop());
  await pool.start();
  return pool;
}

const asked = (pool) => pool.scheduler.listLeases().map((lease) => lease.model);
const poolTurn = (model) => ({ sessionId: 'session_1', projectId: null, memberId: 'member_alice', model, wantsVision: false });

test('F2: eight models online: the team model, else Automatic; a team model nobody offers is refused', async (t) => {
  const teamModel = { value: 'm5' };
  const pool = await resolvingPool(t, teamModel);
  for (const [deviceId, memberId, models] of [['device_a', 'member_node', EIGHT.map((id) => offer(id))], ['device_b', 'member_two', [offer('m3', 4096)]]]) {
    assert.equal(pool.scheduler.registerNode({ deviceId, memberId, slots: 4, models }).ok, true);
  }
  for (const model of [undefined, '', 'team-pool']) (await pool.turnRoute.acquire(poolTurn(model))).release({ ok: true });
  assert.deepEqual(asked(pool), ['m5', 'm5', 'm5'], 'the stored team model');
  assert.equal((await pool.turnRoute.acquire(poolTurn('m7'))).model.id, 'm7', 'a conversation\'s own model is unchanged');
  teamModel.value = null;
  (await pool.turnRoute.acquire(poolTurn('team-pool'))).release({ ok: true });
  (await pool.engineRoute.acquire({ memberId: 'member_alice' })).release({ ok: true });
  assert.deepEqual(asked(pool).slice(4), ['m3', 'm3'], 'Automatic: the model the most hardware offers, on both routes');
  teamModel.value = 'gone';
  const leases = pool.scheduler.listLeases().length;
  for (const acquire of [() => pool.turnRoute.acquire(poolTurn()), () => pool.engineRoute.acquire({ memberId: 'member_alice' })]) {
    await assert.rejects(acquire(), (error) => error.reason === 'team_model_not_offered' && error.code === 'CMP-HOST-0007');
  }
  assert.equal(pool.scheduler.listLeases().length, leases, 'no lease requested');
});

test('F2: one model online is that model; an empty pool or only paused hardware keeps model_not_in_pool', async (t) => {
  const pool = await resolvingPool(t, { value: null });
  await assert.rejects(pool.turnRoute.acquire(poolTurn()), (error) => error.reason === 'model_not_in_pool');
  const one = pool.scheduler.registerNode({ deviceId: 'device_a', memberId: 'member_node', slots: 1, models: [offer('alpha')] });
  (await pool.turnRoute.acquire(poolTurn('team-pool'))).release({ ok: true });
  assert.deepEqual(asked(pool), ['alpha']);
  pool.scheduler.registerNode({ deviceId: 'device_b', memberId: 'member_two', slots: 1, models: [offer('beta')] });
  pool.scheduler.setNodePaused(one.node_id, { on: true });
  pool.scheduler.setNodePaused(pool.scheduler.nodeIdForDevice('device_b'), { on: true });
  await assert.rejects(pool.turnRoute.acquire(poolTurn()), (error) => error.reason === 'model_not_in_pool');
});

test('F2: on a team host, team.pool.model.set changes the next turn\'s model and Automatic matches the GPU list', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  fx.writeConfig({ source: 'parent_channel', extra: { model_endpoint: undefined,
    team: { name: TEAM_NAME, key_source: 'parent_channel', direct_port: null, pool: { context_length: CONTEXT } } } });
  const { owner } = await fx.seedMembers(fx.client().deviceKey);
  const seam = poolSeam();
  const parent = fx.newParent();
  const starting = fx.start(parent, { createPool: seam.createPool });
  parent.emit({ type: 'start', host_key: fx.hostKey });
  await starting;
  const { pool } = seam.built[0];
  pool.scheduler.registerNode({ deviceId: 'device_n', memberId: 'member_node', slots: 4, models: EIGHT.map((id) => offer(id)) });
  pool.scheduler.registerNode({ deviceId: 'device_m', memberId: 'member_two', slots: 1, models: [offer('m6', 4096)] });
  const ctx = fx.context();
  const auth = ctx.clients.register(owner.device_id);
  const send = (operation, params) => ctx.router.dispatch({ ...command(auth, operation, params), boot_epoch: ctx.bootEpoch },
    { deviceId: owner.device_id, clientToken: auth.client_token, isAuthenticated: () => true, actor: { device_id: owner.device_id } });
  const turnModel = async () => {
    const handle = await pool.turnRoute.acquire({ ...poolTurn('team-pool'), memberId: owner.member_id });
    handle.release({ ok: true });
    return handle.model.id;
  };
  const listed = await send('team.node.list', {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.automatic_model, 'm6');
  assert.equal(await turnModel(), listed.automatic_model, 'Automatic is the GPU list\'s answer');
  const set = await send('team.pool.model.set', { model: 'm2' });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(await turnModel(), 'm2', 'the next turn, with no restart');
});
