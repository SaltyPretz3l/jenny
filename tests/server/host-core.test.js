'use strict';

// Team slice 1c-1b: the composition shared by the single-owner and team hosts,
// the `main` argument rules, and the hand-off of a team config.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BackendHarness } = require('../helpers/command-router-fixture');
const { ClientRegistry } = require('../../server/client-registry');
const { ControlLeases } = require('../../server/control-leases');
const { createHostCore, acquireConfiguredProfile } = require('../../server/host-core');
const { main, startHostedServer } = require('../../server/main');
const { createTeamHostFixture, writeSingleOwnerConfig } = require('./helpers/team-host-fixture');

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function buildCore(t, extra = {}) {
  const root = makeRoot(t);
  const calls = [];
  const backend = new BackendHarness(root);
  backend.sidecarManager = { process: null };
  const composition = {
    backend,
    start: async () => { calls.push('composition.start'); },
    stop: async () => { calls.push('composition.stop'); return { exitConfirmed: extra.exitConfirmed !== false }; },
    dispose: async () => { calls.push('composition.dispose'); backend.dispose(); },
  };
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const broker = { close: async () => { calls.push('broker.close'); } };
  const config = { userDataPath: root, workspaceRoot: null, secretsDir: null, execution: null, pythonExecutable: 'python' };
  const options = { config, clients, leases, logger: () => {}, createBackend: () => composition, ...extra.options };
  if (extra.withBroker) options.executionBroker = broker;
  const core = createHostCore(options);
  t.after(async () => { await core.dispose().catch(() => {}); });
  return { core, calls, clients, leases, composition, root };
}

async function sessionsList(core, clients, deviceId, context = {}) {
  const auth = clients.register(deviceId);
  return core.router.dispatch({ api_version: 1, operation: 'sessions.list', request_id: 'request_list',
    client_id: auth.client_id, boot_epoch: core.bootEpoch, params: {} },
  { deviceId, clientToken: auth.client_token, isAuthenticated: () => true, ...context });
}

test('a core built without authorize behaves as the single owner', async (t) => {
  const { core, clients } = buildCore(t);
  const result = await sessionsList(core, clients, 'device-a');
  assert.equal(result.ok, true);
  assert.deepEqual(result.sessions, []);
  assert.equal(typeof core.assetRoutes, 'function');
  assert.equal(typeof core.bootEpoch, 'string');
});

test('a core built with authorize denies a command that carries no actor', async (t) => {
  const verdicts = [];
  const authorize = (actor) => { verdicts.push(actor); return { ok: true }; };
  const { core, clients } = buildCore(t, { options: { authorize, guardRequired: true, maxEventClients: 64 } });
  const denied = await sessionsList(core, clients, 'device-a');
  assert.equal(denied.ok, false);
  assert.equal(denied.error.reason, 'role_forbidden');
  assert.deepEqual(verdicts, []);
  const actor = { member_id: 'member_x', device_id: 'device-a', role: 'owner', state: 'active' };
  const allowed = await sessionsList(core, clients, 'device-b', { actor: { ...actor, device_id: 'device-b' } });
  assert.equal(allowed.ok, true);
  assert.equal(verdicts.length > 0, true);
  assert.equal(core.events.events.maxClients, 64);
});

test('dispose runs the steps in the single-owner order and reports readiness', async (t) => {
  const order = [];
  t.mock.method(global, 'clearInterval', (timer) => { order.push('sweep'); return clearTimeout(timer); });
  const { core, calls, clients, composition } = buildCore(t, { withBroker: true });
  assert.equal(composition.backend.listenerCount('chat-stream') > 0, true, 'the core listens to the backend');
  const originalStop = composition.stop;
  composition.stop = async () => {
    // By the time the child is stopped the router refuses work and the event stream let go of the backend.
    const refused = await sessionsList(core, clients, 'device-late');
    order.push(`router_${refused.error?.reason}`);
    order.push(`listeners_left_${composition.backend.listenerCount('chat-stream')}`);
    return originalStop();
  };
  assert.equal(core.canReleaseLock(), false);
  const first = core.dispose();
  assert.equal(core.dispose(), first, 'one disposal');
  await first;
  assert.deepEqual(order, ['sweep', 'router_router_disposed', 'listeners_left_0']);
  assert.deepEqual(calls, ['composition.stop', 'broker.close', 'composition.dispose']);
  assert.equal(core.canReleaseLock(), true);
});

test('an unconfirmed child exit throws host_child_exit_unconfirmed and keeps the lock', async (t) => {
  const { core, calls } = buildCore(t, { exitConfirmed: false, withBroker: true });
  await assert.rejects(core.dispose(), (error) => error.message === 'host_child_exit_unconfirmed');
  assert.deepEqual(calls, ['composition.stop'], 'neither the broker nor the composition is touched after it');
  assert.equal(core.canReleaseLock(), false);
});

test('startBackend swallows a model that is down, and isBackendReady needs the sidecar process', async (t) => {
  const warnings = [];
  const { core, composition } = buildCore(t, { options: { logger: (level, event) => warnings.push(`${level} ${event}`) } });
  composition.start = async () => { throw new Error('model down'); };
  await core.startBackend();
  assert.equal(warnings.filter((line) => line === 'WARN host.model_unavailable').length, 1);
  assert.equal(core.isBackendReady(), false);
  const child = {};
  composition.backend.sidecarManager.process = child;
  assert.equal(core.isBackendReady(), false, 'the hosted policy process must be the same process');
  composition.backend._hostedPolicyProcess = child;
  assert.equal(core.isBackendReady(), true);
});

test('a failure while building leaves the built parts reachable for cleanup', async (t) => {
  const root = makeRoot(t);
  const calls = [];
  const backend = new BackendHarness(root);
  const composition = { backend, stop: async () => { calls.push('stop'); return { exitConfirmed: true }; },
    dispose: async () => { calls.push('dispose'); backend.dispose(); } };
  let caught;
  try {
    createHostCore({ config: { userDataPath: root, workspaceRoot: null, secretsDir: null, execution: null },
      clients: {}, leases: new ControlLeases(), logger: () => {}, createBackend: () => composition });
  } catch (error) { caught = error; }
  assert.equal(caught instanceof TypeError, true);
  assert.equal(caught.hostCore.canReleaseLock(), false);
  await caught.hostCore.dispose();
  assert.deepEqual(calls, ['stop', 'dispose']);
  assert.equal(caught.hostCore.canReleaseLock(), true);
});

test('acquireConfiguredProfile hands onLost to the lock implementation', async (t) => {
  const fx = createTeamHostFixture(t);
  const onLost = () => {};
  let seen;
  const { config, lock } = await acquireConfiguredProfile(fx.configPath, { onLost, acquireProfileImpl: (input) => {
    seen = input;
    return { release() {} };
  } });
  assert.equal(seen.onLost, onLost);
  assert.equal(seen.userDataPath, fx.profile);
  assert.equal(config.team.name, fx.teamName);
  lock.release();
});

test('main rejects --team-init and --team-recover for a single-owner config, both together, and any unknown argument', async (t) => {
  const root = makeRoot(t);
  const single = writeSingleOwnerConfig(root);
  const reason = (error) => error.message === 'invalid_arguments';
  const quiet = { processLike: {} };
  await assert.rejects(main(['--config', single, '--team-init'], quiet), reason);
  await assert.rejects(main(['--config', single, '--team-start'], quiet), reason);
  await assert.rejects(main(['--config', single, '--ready'], quiet), reason);
  await assert.rejects(main(['--config', single, '--team-init', 'extra'], quiet), reason);
  await assert.rejects(main(['--config', 'relative.json'], quiet), reason);
  await assert.rejects(main(['--team-init', '--config', single], quiet), reason);
  await assert.rejects(main([], quiet), reason);
  await assert.rejects(startHostedServer(single, { teamInit: true }), reason);
  await assert.rejects(main(['--config', single, '--team-recover'], quiet), reason);
  await assert.rejects(main(['--config', single, '--team-init', '--team-recover'], quiet), reason);
  await assert.rejects(main(['--config', single, '--team-recover', '--team-recover'], quiet), reason);
  await assert.rejects(startHostedServer(single, { teamRecover: true }), reason);
  await assert.rejects(startHostedServer(single, { teamInit: true, teamRecover: true }), reason);
});

test('a team config with both owner flags is invalid_arguments and takes nothing', async (t) => {
  const fx = createTeamHostFixture(t);
  const reason = (error) => error.message === 'invalid_arguments';
  await assert.rejects(main(['--config', fx.configPath, '--team-init', '--team-recover'], { processLike: {} }), reason);
  await assert.rejects(startHostedServer(fx.configPath, { ...fx.options(), parent: fx.newParent(),
    teamInit: true, teamRecover: true }), reason);
  // The team host's own check, reached without startHostedServer's.
  const { startTeamHost } = require('../../server/team/team-main');
  const parent = fx.newParent();
  await assert.rejects(startTeamHost(fx.configPath, parent, { ...fx.options(), teamInit: true, teamRecover: true }),
    (error) => error.reason === 'invalid_arguments');
  assert.deepEqual(parent.sent, [{ type: 'error', reason: 'invalid_arguments' }]);
  assert.equal(fx.lock.acquired, 0);
});

test('startHostedServer gives a team host the parent channel it was handed', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const messages = new (require('node:events').EventEmitter)();
  messages.connected = true;
  messages.sent = [];
  messages.send = (message, callback) => { messages.sent.push(message); callback?.(); return true; };
  messages.disconnect = () => { messages.connected = false; };
  // A team config that needs a key and a parent that never sends one: the start must fail and let go.
  await assert.rejects(startHostedServer(fx.configPath, { ...fx.options({ keyTimeoutMs: 30 }),
    parent: require('../../server/team/parent-channel').createParentChannel(messages) }),
  (error) => error.reason === 'team_key_timeout');
  assert.deepEqual(messages.sent, [{ type: 'error', reason: 'team_key_timeout' }]);
});

test('startHostedServer hands a team config to the team host', async (t) => {
  const fx = createTeamHostFixture(t);
  const host = await startHostedServer(fx.configPath, fx.options());
  assert.equal(typeof host.publicKey, 'string');
  assert.equal(host.publicKey, fx.hostPublicKey);
  assert.equal(typeof host.stopped.then, 'function');
  await host.stop();
  assert.equal(fx.lock.released, 1);
});
