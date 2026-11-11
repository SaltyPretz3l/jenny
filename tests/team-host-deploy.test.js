'use strict';

// Deploy, Stop and Status of the desktop team host (slice 1f-2) through the
// host controller, with a fake utility process and, for the owner's join, the
// real member client against the real host modules of
// tests/helpers/team-client-host.js. Fail closed on the secure store; the config
// is written with real paths and no secret; the host key is made once and never
// overwritten; the first-owner invite stays inside the main process.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HOST_KEY_NAME } = require('../services/team/host/host-key-store');
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
  assert.deepEqual(config.team, { name: 'Studio', key_source: 'parent_channel', direct_port: DIRECT_PORT });
  assert.equal(config.workspace_root, null);
  assert.equal(config.listen_host, '127.0.0.1');
  // E19: a team host has no model until Phase 4, so no endpoint and no sidecar interpreter.
  assert.equal(Object.hasOwn(config, 'model_endpoint'), false);
  assert.equal(Object.hasOwn(config, 'python_executable'), false);
  assert.equal(loadHostConfig(configPath).modelEndpoint, null, 'the host loader accepts the written config');

  const forbidden = [stored, Buffer.from(stored, 'base64url').toString('hex')];
  const everything = [raw, JSON.stringify(call.args), JSON.stringify(call.options), JSON.stringify(logs),
    JSON.stringify(pushed), JSON.stringify(answer), ...readTree(userDataPath).map((file) => file.text)];
  for (const text of everything) for (const secret of forbidden) assert.equal(text.includes(secret), false);
  assert.equal(JSON.stringify(call.options.env).includes(stored), false);
  assert.deepEqual(Object.keys(call.options.env), ['SystemRoot'], 'a minimal environment');
  for (const snapshot of [...pushed, answer.host]) assert.equal(Object.hasOwn(snapshot, 'addresses'), false, 'no address leaves main');
});

test('on Linux from a source checkout the config names the profile lock interpreter, and only there', async (t) => {
  for (const [platform, expected] of [['linux', process.execPath], ['win32', undefined]]) {
    const userDataPath = tempProfile(t, 'jenny-host-deploy-');
    const { controller } = controllerFor(t, { userDataPath, secureStore: createMemorySecureStore(), platform,
      script: healthyHostScript({ teamId: 'team_x' }) });
    assert.equal((await controller.handle('hostDeploy', { ...DEPLOY })).ok, true, platform);
    const config = JSON.parse(fs.readFileSync(path.join(hostDir(userDataPath), 'host-config.json'), 'utf8'));
    assert.equal(config.python_executable, expected, platform);
    assert.equal(Object.hasOwn(config, 'model_endpoint'), false, platform);
  }
});

// E19: Deploy works whatever engine the desktop runs, through the real registration.
for (const engine of ['codex-cli', 'llama-server', 'ninfer', 'chatgpt', '']) {
  test(`Deploy works with the desktop engine set to ${engine || 'nothing'}`, async (t) => {
    const { registerTeam } = require('../services/main/team-registration');
    const userDataPath = tempProfile(t, 'jenny-host-deploy-');
    const fake = createFakeFork({ script: healthyHostScript({ teamId: 'team_x' }) });
    const handlers = new Map();
    const shutdown = [];
    const backendService = { currentEngineType: engine, currentModel: 'any-model', featureFlags: { team: true },
      getBackendStatus: () => ({ phase: 'ready' }), on() {}, off() {}, removeListener() {} };
    registerTeam({ handle: (channel, fn) => handlers.set(channel, fn) }, { featureFlags: { team: true }, backendService,
      userDataPath, getSecureStore: () => createMemorySecureStore(),
      getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
      hostOptions: { platform: 'win32', isPackaged: () => false, fork: fake.fork, entryPath: 'e.js',
        pickDirectPort: async () => DIRECT_PORT, probeDirectPort: async () => true, bounds: { ownerInviteMs: 50 } } });
    t.after(() => shutdown[0]?.());
    const answer = await handlers.get('team:host-deploy')({ sender: {} }, { ...DEPLOY });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.host.state, 'running');
    const config = JSON.parse(fs.readFileSync(path.join(hostDir(userDataPath), 'host-config.json'), 'utf8'));
    assert.equal(Object.hasOwn(config, 'model_endpoint'), false);
    assert.equal(Object.hasOwn(config, 'python_executable'), false);
  });
}

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

test('a stored key is never regenerated: key mismatch is reported and nothing changes', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
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

test('an unreadable stored key is refused, never replaced', async (t) => {
  const userDataPath = tempProfile(t, 'jenny-host-deploy-');
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
  });
}

test('ready then owner_invite: the owner joins through the loopback fallback; the invite is nowhere else', async (t) => {
  const host = await createTeamClientHost(t);
  const service = host.createService();
  const { invite } = await host.invite({ kind: 'owner_first' });
  const teamId = parseInvite(invite).team_id;
  assert.equal(teamId, deriveTeamId(keyPairFromSeed(Buffer.from(HOST_SEED)).publicKey));
  host.secureStore.values.set(HOST_KEY_NAME, Buffer.from(HOST_SEED).toString('base64url'));
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
