'use strict';

// Deploy, Stop and Status of the desktop team host (slice 1f-2) through the
// host controller, with a fake utility process and, for the owner's join, the
// real member client against the real host modules of
// tests/helpers/team-client-host.js. Fail closed on the secure store; the config
// is written with real paths and no secret; a Deploy with no saved config makes a fresh key over any found (E75),
// one over a saved config never overwrites it; the first-owner invite stays inside the main process.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HOST_KEY_NAME, createHostKeyStore } = require('../services/team/host/host-key-store');
const { POOL_CONTEXT_AUTO, buildHostConfig, prepareHostLayout, writeHostConfig } = require('../services/team/host/host-layout');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { loadHostConfig } = require('../server/config');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { parseInvite } = require('../server/team/invites');
const { HOST_SEED } = require('./server/helpers/team-host-fixture');
const { DIRECT_PORT, createFakeFork, createTestHostController, healthyHostScript } = require('./helpers/team-host-fakes');
const { createMemorySecureStore, createTeamClientHost, readTree, tempProfile } = require('./helpers/team-client-host');

const DEPLOY = Object.freeze({ name: 'Studio', display_name: 'Olive Owner', label: 'Desk' });

const controllerFor = createTestHostController;

function hostDir(userDataPath) {
  return path.join(userDataPath, 'team-host');
}

for (const status of ['unavailable', 'basic_text']) {
  test(`Deploy with a ${status} secure store is refused: nothing spawned, nothing written`, async (t) => {
    const userDataPath = tempProfile(t, 'jenny-host-deploy-');
    const secureStore = createMemorySecureStore({ status });
    const { controller, fake } = controllerFor(t, { userDataPath, secureStore,
      script: healthyHostScript({ teamId: 'team_x' }) });
    const answer = await controller.handle('hostDeploy', { ...DEPLOY });
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE);
    assert.equal(answer.error.reason, 'team_host_key_unavailable');
    assert.equal(fake.calls.length, 0, 'nothing spawned');
    assert.equal(fs.existsSync(hostDir(userDataPath)), false, 'nothing written');
    assert.deepEqual(secureStore.sets, []);
  });
}

test('the real SecureStore on basic_text refuses Deploy the same way', async (t) => {
  const { SecureStore } = require('../services/backend/secure-store');
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const secureStore = new SecureStore({ filePath: path.join(userDataPath, 'credentials.json'), isSafeStorageReady: () => true,
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString(),
      getSelectedStorageBackend: () => 'basic_text' } });
  const { controller, fake } = controllerFor(t, { userDataPath, secureStore, script: healthyHostScript({ teamId: 't' }) });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.error.reason, 'team_host_key_unavailable');
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(fs.readdirSync(userDataPath), []);
});

test('first Deploy: real-path config with no secret, --config and --team-init, start{host_key}', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const secureStore = createMemorySecureStore();
  const { controller, fake, logs, pushed } = controllerFor(t, { userDataPath, secureStore,
    script: healthyHostScript({ teamId: 'team_x' }) });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.host.state, 'running');
  const stored = secureStore.values.get(HOST_KEY_NAME);
  assert.equal(Buffer.from(stored, 'base64url').length, 32, 'a 32-byte seed was generated and stored');

  const root = fs.realpathSync.native(hostDir(userDataPath));
  const configPath = path.join(root, 'host-config.json');
  const call = fake.calls[0];
  assert.deepEqual(call.args, ['--config', configPath, '--team-init']);
  assert.deepEqual(call.child.posted[0], { type: 'start', host_key: stored });

  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  assert.equal(config.user_data_path, fs.realpathSync.native(path.join(root, 'profile')));
  assert.equal(config.secrets_dir, fs.realpathSync.native(path.join(root, 'secrets')));
  assert.equal(config.runtime_home, fs.realpathSync.native(path.join(root, 'runtime')));
  assert.deepEqual(fs.readdirSync(config.secrets_dir), [], 'the secrets directory stays empty');
  const projects = fs.realpathSync.native(path.join(root, 'projects'));
  // Slice 4a-5 (E65): Deploy turns the GPU pool on; the owner's own Jenny shares into it like any member.
  assert.deepEqual(config.team, { name: 'Studio', key_source: 'parent_channel', direct_port: DIRECT_PORT, projects_root: projects,
    pool: { context_length: POOL_CONTEXT_AUTO } });
  assert.equal(fs.lstatSync(path.join(root, 'trash')).isDirectory(), true, 'the trash folder is made too');
  assert.equal(loadHostConfig(configPath).team.projectsRoot, projects, 'the written root passes the desktop rule');
  assert.equal(config.workspace_root, null);
  assert.equal(config.listen_host, '127.0.0.1');
  // A pool host's endpoint is the pool gateway, built at start: the config never names one. From a
  // source checkout the hosted sidecar runs on the desktop sidecar's own interpreter (4a-5).
  assert.equal(Object.hasOwn(config, 'model_endpoint'), false);
  assert.equal(config.python_executable, process.execPath);
  const loaded = loadHostConfig(configPath);
  assert.equal(loaded.modelEndpoint, null, 'the host loader accepts the written config');
  assert.deepEqual(loaded.team.pool, { contextLength: POOL_CONTEXT_AUTO });

  const forbidden = [stored, Buffer.from(stored, 'base64url').toString('hex')];
  const everything = [raw, JSON.stringify(call.args), JSON.stringify(call.options), JSON.stringify(logs),
    JSON.stringify(pushed), JSON.stringify(answer), ...readTree(userDataPath).map((file) => file.text)];
  for (const text of everything) for (const secret of forbidden) assert.equal(text.includes(secret), false);
  assert.equal(JSON.stringify(call.options.env).includes(stored), false);
  assert.deepEqual(Object.keys(call.options.env), ['SystemRoot'], 'a minimal environment');
  for (const snapshot of [...pushed, answer.host]) assert.equal(Object.hasOwn(snapshot, 'addresses'), false, 'no address leaves main');
});

// Slice 4a-5: from a source checkout (Linux or Windows) the config names the desktop sidecar's interpreter,
// which runs the hosted sidecar (and on Linux the profile lock); a packaged app runs its packaged sidecar.
test('from a source checkout the config names the desktop sidecar interpreter, and only there', async (t) => {
  for (const [platform, isPackaged, expected] of [['linux', false, process.execPath], ['win32', false, process.execPath],
    ['win32', true, undefined]]) {
    const label = `${platform}${isPackaged ? ' packaged' : ''}`;
    const userDataPath = tempProfile(t, 'jenny-host-deploy-');
    const { controller } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(), platform, isPackaged,
      script: healthyHostScript({ teamId: 'team_x' }) });
    assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true, label);
    const config = JSON.parse(fs.readFileSync(path.join(hostDir(userDataPath), 'host-config.json'), 'utf8'));
    assert.equal(config.python_executable, expected, label);
    assert.equal(Object.hasOwn(config, 'model_endpoint'), false, label);
    assert.deepEqual(config.team.pool, { context_length: POOL_CONTEXT_AUTO }, label);
  }
});

// Deploy through the real registration (services/main/team-registration.js), whose `lockPython` is
// `launch.desktopPythonExecutable(backendService)`; answers the written config.
async function deployThroughRegistration(t, backendExtra) {
  const { registerTeam } = require('../services/main/team-registration');
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const fake = createFakeFork({ script: healthyHostScript({ teamId: 'team_x' }) });
  const handlers = new Map();
  const shutdown = [];
  const backendService = { currentModel: 'any-model', featureFlags: { team: true },
    getBackendStatus: () => ({ phase: 'ready' }), on() {}, off() {}, removeListener() {}, ...backendExtra };
  registerTeam({ handle: (channel, fn) => handlers.set(channel, fn) }, { featureFlags: { team: true }, backendService,
    userDataPath, getSecureStore: () => createMemorySecureStore(), readOfflineMode: () => 'disabled', // Force local off (E64: no reader wired counts as on)
    getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
    hostOptions: { platform: 'win32', isPackaged: () => false, fork: fake.fork, entryPath: 'e.js',
      pickDirectPort: async () => DIRECT_PORT, probeDirectPort: async () => true, bounds: { ownerInviteMs: 50 } } });
  t.after(() => shutdown[0]?.());
  const answer = await handlers.get('team:host-deploy')({ sender: {} }, { ...DEPLOY });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.host.state, 'running');
  return JSON.parse(fs.readFileSync(path.join(hostDir(userDataPath), 'host-config.json'), 'utf8'));
}

// E19: Deploy works whatever engine the desktop runs, through the real registration.
for (const engine of ['codex-cli', 'llama-server', 'ninfer', 'chatgpt', '']) {
  test(`Deploy works with the desktop engine set to ${engine || 'nothing'}`, async (t) => {
    const config = await deployThroughRegistration(t, { currentEngineType: engine });
    assert.equal(Object.hasOwn(config, 'model_endpoint'), false);
    assert.deepEqual(config.team.pool, { context_length: POOL_CONTEXT_AUTO }, 'the pool whatever the engine');
    // This fake backend has no sidecar manager, so there is no interpreter to name.
    assert.equal(Object.hasOwn(config, 'python_executable'), false);
  });
}

// Slice 4a-5: the desktop sidecar's real interpreter reaches the config through `desktopPythonExecutable`;
// a relative, empty or missing one writes no key (the host then reports its model unavailable).
test('the desktop sidecar interpreter reaches the config only when it is an absolute path to a file', async (t) => {
  const missing = path.join(path.dirname(process.execPath), 'no-such-python.exe');
  for (const [value, expected] of [[process.execPath, process.execPath], ['python.exe', undefined], ['', undefined],
    [missing, undefined]]) {
    const config = await deployThroughRegistration(t, { currentEngineType: 'llama-server',
      sidecarManager: { pythonExecutable: value } });
    assert.equal(config.python_executable, expected, JSON.stringify(value));
  }
});

test('a lockPython getter that answers a path with no file writes no python_executable', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const { controller } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(),
    lockPython: path.join(userDataPath, 'missing', 'python.exe'), script: healthyHostScript({ teamId: 'team_x' }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const config = JSON.parse(fs.readFileSync(path.join(hostDir(userDataPath), 'host-config.json'), 'utf8'));
  assert.equal(Object.hasOwn(config, 'python_executable'), false);
  assert.deepEqual(config.team.pool, { context_length: POOL_CONTEXT_AUTO });
});

test('Deploy after a stop reuses the stored key and the direct port; a second Deploy while running is refused', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const secureStore = createMemorySecureStore();
  let ports = 0;
  const { controller, fake } = controllerFor(t, { userDataPath, secureStore, script: healthyHostScript({ teamId: 'team_x' }),
    pickDirectPort: async () => { ports += 1; return DIRECT_PORT + ports; } });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const busy = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.deepEqual(busy, { ok: false, error: { code: 'invalid_request', reason: 'team_host_busy' } });
  assert.equal(fake.calls.length, 1);
  const stopped = await controller.handle('hostStop', {});
  assert.equal(stopped.ok, true);
  assert.equal(stopped.host.state, 'stopped');
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[0].child.posted[0], fake.calls[1].child.posted[0], 'the same key both times');
  assert.equal(secureStore.sets.filter((name) => name === HOST_KEY_NAME).length, 1, 'the key is written once');
  assert.equal(ports, 1, 'the direct port is chosen once and kept');
  const config = JSON.parse(fs.readFileSync(path.join(hostDir(userDataPath), 'host-config.json'), 'utf8'));
  assert.equal(config.team.direct_port, DIRECT_PORT + 1);
});

// Slice 5-5b: Deploy and Recover rewrite the whole config and carry the saved internet setting through;
// with none saved the rewritten file is the same bytes as before.
test('Deploy, Recover and Deploy again keep the saved internet setting; without one the file is rewritten byte for byte', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const { controller } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(),
    script: healthyHostScript({ teamId: 'team_x' }) });
  const configPath = path.join(hostDir(userDataPath), 'host-config.json');
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  const plain = fs.readFileSync(configPath);
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  assert.equal(Buffer.compare(fs.readFileSync(configPath), plain), 0, 'no internet: the same bytes');
  const internet = { map_port: true, public_address: 'team.example.org', relay_url: null };
  const saved = JSON.parse(plain.toString('utf8'));
  fs.writeFileSync(configPath, JSON.stringify({ ...saved, team: { ...saved.team, internet } }));
  const steps = [['hostRecover', { display_name: 'Olive Owner', label: 'Desk' }], ['hostDeploy', { ...DEPLOY }]];
  for (const [method, payload] of steps) {
    assert.equal((await controller.handle(method, payload)).ok, true, method);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')).team.internet, internet, method);
    assert.deepEqual({ ...loadHostConfig(configPath).team.internet },
      { mapPort: true, publicAddress: 'team.example.org', relayUrl: null }, method);
    assert.equal((await controller.handle('hostStop', {})).ok, true);
  }
});

test('prepareHostLayout makes projects/ and trash/ and answers their real paths; the written config loads', (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-layout-');
  const layout = prepareHostLayout(userDataPath);
  const root = fs.realpathSync.native(hostDir(userDataPath));
  assert.equal(layout.projects, path.join(root, 'projects'));
  assert.equal(layout.trash, path.join(root, 'trash'));
  assert.equal(layout.logs, path.join(root, 'logs'));
  for (const dir of [layout.projects, layout.trash, layout.logs]) assert.equal(fs.lstatSync(dir).isDirectory(), true);
  const written = buildHostConfig({ layout, name: 'Studio', directPort: null });
  assert.equal(written.team.projects_root, layout.projects);
  assert.equal(JSON.stringify(written).includes(layout.trash), false, 'nothing about the trash is written');
  writeHostConfig(layout, written);
  assert.equal(loadHostConfig(layout.configPath).team.projectsRoot, layout.projects);
  assert.deepEqual(prepareHostLayout(userDataPath), layout, 'a second prepare answers the same');
});

test('a Deploy over a saved config with no projects_root writes one with it', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const { controller } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(),
    script: healthyHostScript({ teamId: 'team_x' }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  const configPath = path.join(fs.realpathSync.native(hostDir(userDataPath)), 'host-config.json');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { projects_root: _dropped, ...oldTeam } = saved.team;
  fs.writeFileSync(configPath, JSON.stringify({ ...saved, team: oldTeam }));
  assert.equal(Object.hasOwn(loadHostConfig(configPath).team, 'projectsRoot'), false, 'a host from before loads');
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(rewritten.team.projects_root, path.join(path.dirname(configPath), 'projects'));
  assert.equal(loadHostConfig(configPath).team.projectsRoot, rewritten.team.projects_root);
});

test('a relaunch of a host deployed before 4a-5 (no pool block) writes the pool', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const { controller } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(),
    script: healthyHostScript({ teamId: 'team_x' }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  const configPath = path.join(fs.realpathSync.native(hostDir(userDataPath)), 'host-config.json');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const { pool: _dropped, ...oldTeam } = saved.team;
  const { python_executable: _python, ...oldConfig } = saved;
  fs.writeFileSync(configPath, JSON.stringify({ ...oldConfig, team: oldTeam }));
  assert.equal(Object.hasOwn(loadHostConfig(configPath).team, 'pool'), false, 'a host from before loads with no pool');
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(rewritten.team.pool, { context_length: POOL_CONTEXT_AUTO });
  assert.equal(rewritten.python_executable, process.execPath);
  assert.deepEqual(loadHostConfig(configPath).team.pool, { contextLength: POOL_CONTEXT_AUTO });
});

test('buildHostConfig always writes the pool and never a model endpoint, and the loader takes it', (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-layout-');
  const layout = prepareHostLayout(userDataPath);
  assert.equal(POOL_CONTEXT_AUTO, 1048576, 'Auto is the top of the host range: the pool follows the serving node');
  for (const options of [{}, { lockPython: process.execPath }, { internet: { relay_url: null } }]) {
    const written = buildHostConfig({ layout, name: 'Studio', directPort: 4242, ...options });
    assert.deepEqual(written.team.pool, { context_length: POOL_CONTEXT_AUTO });
    assert.equal(Object.hasOwn(written, 'model_endpoint'), false);
    assert.equal(Object.hasOwn(written.team, 'file_tools'), false, 'I11: a new deploy has file tools off');
  }
  writeHostConfig(layout, buildHostConfig({ layout, name: 'Studio', directPort: 4242 }));
  const loaded = loadHostConfig(layout.configPath);
  assert.deepEqual([loaded.modelEndpoint, loaded.team.pool], [null, { contextLength: POOL_CONTEXT_AUTO }]);
});

test('over a saved config a stored key is never regenerated: key mismatch is reported and nothing changes', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  savedConfig(userDataPath);
  const secureStore = createMemorySecureStore();
  const seed = crypto.randomBytes(32).toString('base64url');
  secureStore.values.set(HOST_KEY_NAME, seed);
  const { controller, fake } = controllerFor(t, { userDataPath, secureStore, script: (child, message) => {
    if (message.type === 'start') setImmediate(() => { child.reply({ type: 'error', reason: 'team_host_key_mismatch' }); child.exit(1); });
  } });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE, reason: 'team_host_key_mismatch' } });
  assert.equal(secureStore.values.get(HOST_KEY_NAME), seed, 'the stored key is untouched');
  assert.deepEqual(secureStore.sets, [], 'nothing is written to the secure store');
  assert.equal(fake.calls[0].child.posted[0].host_key, seed);
  assert.equal(fake.calls.length, 1, 'no retry');
});

test('over a saved config an unreadable stored key is refused, never replaced', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  savedConfig(userDataPath);
  const secureStore = createMemorySecureStore();
  secureStore.values.set(HOST_KEY_NAME, 'not-a-key');
  const { controller, fake } = controllerFor(t, { userDataPath, secureStore, script: healthyHostScript({ teamId: 't' }) });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.error.code, TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE);
  assert.equal(answer.error.reason, 'team_host_key_invalid');
  assert.equal(secureStore.values.get(HOST_KEY_NAME), 'not-a-key');
  assert.equal(fake.calls.length, 0);
});

for (const [platform, isPackaged] of [['darwin', false], ['darwin', true], ['linux', true]]) {
  test(`Deploy on ${platform}${isPackaged ? ' (packaged)' : ''} answers a plain reason before anything is spawned or written`, async (t) => {
    const userDataPath = tempProfile(t, 'jenny-host-deploy-');
    const secureStore = createMemorySecureStore();
    const { controller, fake } = controllerFor(t, { userDataPath, secureStore, platform, isPackaged,
      script: healthyHostScript({ teamId: 't' }) });
    const answer = await controller.handle('hostDeploy', { ...DEPLOY });
    assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE,
      reason: 'team_host_platform_unavailable' } });
    assert.equal(fake.calls.length, 0);
    assert.equal(fs.existsSync(hostDir(userDataPath)), false);
    assert.deepEqual(secureStore.sets, []);
    // OD-7: the page learns it before any click.
    assert.equal((await controller.handle('hostStatus', {})).host.desktop_hosting, false);
  });
}

test('ready then owner_invite: the owner joins through the loopback fallback; the invite is nowhere else', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  assert.equal(teamId, deriveTeamId(keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey));
  host.secureStore.values.set(HOST_KEY_NAME, Buffer.from(HOST_SEED).toString('base64url'));
  savedConfig(host.userData); // deployed here before, so the key is kept (E75)
  // The invite's hint is unreachable from this machine; only the loopback address reaches the host.
  host.setReachable([`127.0.0.1:${DIRECT_PORT}`]);
  const { controller, fake, logs, pushed } = controllerFor(t, { userDataPath: host.userData, secureStore: host.secureStore,
    service, script: healthyHostScript({ teamId, invite }) });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.host.state, 'running');
  assert.deepEqual(answer.owner, { state: 'joined', team_id: teamId });
  assert.deepEqual(fake.calls[0].args.slice(2), ['--team-init']);
  const team = await host.waitForState(teamId, 'online');
  assert.equal(team.role, 'owner');
  assert.ok(host.reach.dials.some((dial) => dial.includes(`127.0.0.1:${DIRECT_PORT}`)), 'the loopback address was dialled');

  const secret = parseInvite(invite).invite_secret_key;
  const places = [JSON.stringify(logs), JSON.stringify(host.logs), JSON.stringify(pushed), JSON.stringify(host.states),
    JSON.stringify(answer), JSON.stringify(controller.snapshot()), ...readTree(host.userData).map((file) => file.text),
    ...readTree(host.env.fx.profile).filter((file) => file.path.endsWith('command-receipts.json')).map((file) => file.text)];
  for (const text of places) {
    assert.equal(text.includes(invite), false);
    assert.equal(text.includes(secret), false);
  }

  // A later Deploy (this Jenny is now a member) starts without the flag and mints nothing.
  assert.equal((await controller.handle('hostStop', {})).ok, true);
  const again = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(again.ok, true);
  assert.deepEqual(fake.calls[1].args, ['--config', fake.calls[0].args[1]]);
  assert.deepEqual(again.owner, { state: 'member', team_id: teamId });
});

test('--team-init with no owner_invite (the store already has members) reports the owner as not joined', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const service = { holds: () => false, ownerJoin: async () => assert.fail('no invite, no join') };
  const { controller } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(), service,
    script: healthyHostScript({ teamId: 'team_x' }) });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.owner, { state: 'failed', error: { code: TEAM_ERROR_CODES.HOST_UNAVAILABLE, reason: 'team_owner_invite_missing' } });
});

test('hostStatus answers the public snapshot; bad payloads are refused in main', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const { controller, fake } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(),
    script: healthyHostScript({ teamId: 'team_x' }) });
  const status = await controller.handle('hostStatus', undefined);
  assert.equal(status.ok, true);
  assert.equal(status.host.state, 'stopped');
  for (const payload of [null, {}, { name: 'S' }, { ...DEPLOY, extra: 1 }, { ...DEPLOY, name: '' }, { ...DEPLOY, label: 'a\u200bb' },
    { ...DEPLOY, display_name: 'x'.repeat(41) }]) {
    assert.deepEqual(await controller.handle('hostDeploy', payload), { ok: false, error: { code: 'invalid_request', reason: 'team_request_invalid' } });
  }
  assert.deepEqual(await controller.handle('hostStop', { now: true }), { ok: false, error: { code: 'invalid_request', reason: 'team_request_invalid' } });
  assert.deepEqual(await controller.handle('hostRecover', { display_name: 'A' }), { ok: false, error: { code: 'invalid_request', reason: 'team_request_invalid' } });
  assert.equal(fake.calls.length, 0);
});

test('controller.stop (the shutdown task) runs the same stop path and leaves nothing', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
  const { controller, fake } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(),
    script: healthyHostScript({ teamId: 'team_x' }) });
  await controller.handle('hostDeploy', { ...DEPLOY });
  await controller.stop();
  assert.deepEqual(fake.last().posted.filter((m) => m.type === 'stop'), [{ type: 'stop' }]);
  assert.equal(fake.last().exited, true);
  assert.deepEqual(controller.resources(), { child: false, timers: 0, childListeners: 0 });
  const refused = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(refused.ok, false, 'no Deploy after the app began to quit');
  assert.equal(fake.calls.length, 1);
});

test('the team host profile is never swept by the desktop cleanup', async (t) => {
  const { KNOWN_USER_DATA_CHILDREN, cleanupJennyData } = require('../services/data-lifecycle/cleanup-service');
  assert.equal(KNOWN_USER_DATA_CHILDREN.includes('team-host'), false);
  const userDataPath = tempProfile(t, 'jenny-host-cleanup-');
  fs.mkdirSync(path.join(userDataPath, 'team-host', 'profile', 'team'), { recursive: true });
  fs.writeFileSync(path.join(userDataPath, 'team-host', 'profile', 'team', 'members.json'), '{}');
  const result = await cleanupJennyData({ userDataPath });
  assert.equal(fs.existsSync(path.join(userDataPath, 'team-host', 'profile', 'team', 'members.json')), true);
  assert.ok(result.unknownUserDataChildren.includes('team-host'));
});

test('a user data path reached through a junction or link is written as its real path', async (t) => {
  const outer = tempProfile(t, 'jenny-host-junction-');
  const real = path.join(outer, 'real-profile');
  fs.mkdirSync(real);
  const linked = path.join(outer, 'linked-profile');
  try {
    fs.symlinkSync(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`cannot create a junction or link here (${error.code})`);
    return;
  }
  const { controller, fake } = controllerFor(t, { userDataPath: linked, secureStore: createMemorySecureStore(),
    script: healthyHostScript({ teamId: 'team_x' }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  const realRoot = path.join(fs.realpathSync.native(real), 'team-host');
  const configPath = path.join(realRoot, 'host-config.json');
  assert.equal(fake.calls[0].args[1], configPath, '--config names the real path');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const field of ['user_data_path', 'secrets_dir', 'runtime_home']) {
    assert.ok(config[field].startsWith(realRoot), `${field} is under the real path: ${config[field]}`);
    assert.equal(config[field].includes('linked-profile'), false, field);
  }
  assert.doesNotThrow(() => loadHostConfig(configPath));
});

// Every path under the profile with its bytes, so "nothing was written" is a comparison.
function listing(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full);
      out.push(entry.isDirectory() ? `${full}/` : `${full} ${stat.mtimeMs} ${fs.readFileSync(full, 'hex')}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

function savedConfig(userDataPath) {
  fs.mkdirSync(hostDir(userDataPath), { recursive: true });
  fs.writeFileSync(path.join(hostDir(userDataPath), 'host-config.json'),
    JSON.stringify({ schema_version: 3, team: { name: 'Studio', key_source: 'parent_channel', direct_port: DIRECT_PORT } }));
}

// The real key store with its create calls counted.
function countingKeys(secureStore) {
  const real = createHostKeyStore({ getSecureStore: () => secureStore });
  const keys = { creates: 0, load: () => real.load(), create: () => { keys.creates += 1; return real.create(); } };
  return keys;
}

// Replaces fs[name] while the controller answers; `fake(original, target)` decides per path.
function swapFs(name, fake) {
  const original = fs[name];
  fs[name] = (target, ...rest) => fake(original, String(target), rest);
  return () => { fs[name] = original; };
}

async function refusedDeploy(t, prepare, { during = () => () => {} } = {}) {
  const userDataPath = tempProfile(t, 'jenny-host-lost-');
  const secureStore = createMemorySecureStore();
  prepare(userDataPath);
  const before = listing(userDataPath);
  const hostKeys = countingKeys(secureStore);
  const { controller, fake, logs } = controllerFor(t, { userDataPath, secureStore, hostKeys,
    script: healthyHostScript({ teamId: 't' }) });
  const undo = during(userDataPath);
  let answer;
  try { answer = await controller.handle('hostDeploy', { ...DEPLOY }); } finally { undo(); }
  assert.equal(hostKeys.creates, 0, 'create was never called');
  assert.equal(fake.calls.length, 0, 'nothing spawned');
  assert.deepEqual(secureStore.sets, [], 'no key was made');
  assert.equal(secureStore.values.has(HOST_KEY_NAME), false);
  assert.deepEqual(listing(userDataPath), before, 'no file or directory was created or changed');
  const said = JSON.stringify([answer, logs]);
  for (const needle of [userDataPath, 'secure-state', 'team-members', 'corrupt-']) assert.equal(said.includes(needle), false, needle);
  return answer;
}

test('a lost host key: Deploy on a deployed profile with no stored key is refused team_host_key_missing and writes nothing', async (t) => {
  const answer = await refusedDeploy(t, savedConfig);
  assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE, reason: 'team_host_key_missing' } });
});

test('a lost host key: with a set-aside secure store file beside it the refusal is team_host_key_set_aside', async (t) => {
  const answer = await refusedDeploy(t, (userDataPath) => {
    savedConfig(userDataPath);
    fs.writeFileSync(path.join(userDataPath, 'secure-state.json.corrupt-1731300000123'), '{ damaged');
  });
  assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE, reason: 'team_host_key_set_aside' } });
});

test('a lost host key: a member store file in the host profile counts as deployed with no config; other names do not', async (t) => {
  const { MEMBERS_FILE } = require('../server/team/member-store');
  const answer = await refusedDeploy(t, (userDataPath) => {
    fs.mkdirSync(path.join(hostDir(userDataPath), 'profile'), { recursive: true });
    fs.writeFileSync(path.join(hostDir(userDataPath), 'profile', MEMBERS_FILE), 'not opened');
    fs.writeFileSync(path.join(userDataPath, 'secure-state.json.corrupt-x'), 'not a set-aside name');
  });
  assert.equal(answer.error.reason, 'team_host_key_missing');

  const userDataPath = tempProfile(t, 'jenny-host-e48-');
  fs.mkdirSync(path.join(hostDir(userDataPath), 'profile'), { recursive: true });
  fs.writeFileSync(path.join(hostDir(userDataPath), 'profile', 'team-audit.json'), '{}');
  const secureStore = createMemorySecureStore();
  const { controller } = controllerFor(t, { userDataPath, secureStore, script: healthyHostScript({ teamId: 't' }) });
  const deployed = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(deployed.ok, true, 'a profile with no config and no member store deploys as today');
  assert.equal(secureStore.values.has(HOST_KEY_NAME), true, 'and makes the key');
});

test('a stored key that does not decode stays team_host_key_invalid and is never overwritten', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-e48-');
  const secureStore = createMemorySecureStore();
  savedConfig(userDataPath);
  secureStore.values.set(HOST_KEY_NAME, 'not-a-key');
  const { controller, fake } = controllerFor(t, { userDataPath, secureStore, script: healthyHostScript({ teamId: 't' }) });
  const answer = await controller.handle('hostDeploy', { ...DEPLOY });
  assert.equal(answer.error.reason, 'team_host_key_invalid');
  assert.equal(secureStore.values.get(HOST_KEY_NAME), 'not-a-key');
  assert.equal(fake.calls.length, 0);
});

test('a lost host key: a config that exists and does not parse counts as deployed', async (t) => {
  const answer = await refusedDeploy(t, (userDataPath) => {
    fs.mkdirSync(hostDir(userDataPath), { recursive: true });
    fs.writeFileSync(path.join(hostDir(userDataPath), 'host-config.json'), '{ not json');
  });
  assert.deepEqual(answer, { ok: false, error: { code: TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE, reason: 'team_host_key_missing' } });
});

test('a lost host key: a check that cannot tell (EACCES on both paths) counts as deployed; both absent deploys as today', async (t) => {
  const denied = (original, target, rest) => {
    if (/host-config\.json$|team-members\.json$/u.test(target)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(target, ...rest);
  };
  const answer = await refusedDeploy(t, () => {}, { during: () => swapFs('statSync', denied) });
  assert.equal(answer.error.reason, 'team_host_key_missing');

  const userDataPath = tempProfile(t, 'jenny-host-lost-');
  const secureStore = createMemorySecureStore();
  const hostKeys = countingKeys(secureStore);
  const { controller } = controllerFor(t, { userDataPath, secureStore, hostKeys, script: healthyHostScript({ teamId: 't' }) });
  assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true);
  assert.equal(hostKeys.creates, 1, 'with both paths absent the first Deploy makes the key');
});

test('a lost host key: a folder listing that throws still refuses, with the sentence for no set-aside store seen', async (t) => {
  const answer = await refusedDeploy(t, (userDataPath) => {
    savedConfig(userDataPath);
    fs.writeFileSync(path.join(userDataPath, 'secure-state.json.corrupt-1731300000123'), '{ damaged');
  }, { during: (userDataPath) => swapFs('readdirSync', (original, target, rest) => {
    if (target === userDataPath) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return original(target, ...rest);
  }) });
  assert.equal(answer.error.reason, 'team_host_key_missing');
});
