'use strict';

// Team slice 1c-1b: the team host's start sequence, key handling, store
// failures and the closed placeholder listener. Fake transport, fake backend
// composition, fake profile lock and fake parent: no native library, no sidecar.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { deriveTeamId } = require('../../server/team/ids');
const { readReadyMarker } = require('../../server/team/ready-marker');
const { MEMBERS_FILE, MemberStore } = require('../../server/team/member-store');
const { createFakeBridgeSpawner } = require('./helpers/fake-bridge');
const { waitFor } = require('./helpers/fake-team-transport');
const { createClosedListener, createTeamHostFixture, randomKey } = require('./helpers/team-host-fixture');
const { LOCAL_COMMAND } = require('../../server/team/member-schema');
const { ClientRegistry } = require('../../server/client-registry');
const { ControlLeases } = require('../../server/control-leases');
const { createInviteService, parseInvite } = require('../../server/team/invites');

test('a parent-channel host starts after the start message and reports ready', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const parent = fx.newParent();
  const starting = fx.start(parent);
  parent.emit({ type: 'start', host_key: fx.hostKey });
  const host = await starting;
  // `ready` is followed by the first verdict (its words: the internet-off case below).
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach']);
  const [ready] = parent.sent;
  assert.deepEqual(Object.keys(ready), ['type', 'boot_epoch', 'team_id', 'public_key', 'addresses']);
  assert.equal(ready.type, 'ready');
  assert.equal(ready.boot_epoch, host.bootEpoch);
  assert.equal(ready.public_key, fx.hostPublicKey);
  assert.equal(host.publicKey, fx.hostPublicKey);
  assert.equal(ready.team_id, deriveTeamId(ready.public_key));
  assert.deepEqual(ready.addresses, ['192.0.2.7:4242', '[2001:db8::7]:4242']);
  assert.equal(JSON.stringify(parent.sent).includes(fx.hostKey), false);
  assert.equal(fx.lock.acquired, 1);
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null, 'a host with a parent writes no marker');
});

// Fix list T6 (row 123, slice 6-7): the owner's relay setting from the desktop reaches the host's real model sharing.
// The link's report reads the limit back from model-sharing.js itself, so 3 and then 0 coming back prove the call landed.
test('a parent-channel host: model_relay sets the limit of the real model sharing, and 0 turns the relay off', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const parent = fx.newParent();
  const starting = fx.start(parent);
  parent.emit({ type: 'start', host_key: fx.hostKey });
  await starting;
  const reports = () => parent.sent.filter((message) => message.type === 'model_relay');
  parent.emit({ type: 'model_relay', flowing: 3 });
  await waitFor(() => reports().length === 1);
  assert.deepEqual(reports()[0], { type: 'model_relay', flowing: 3, passing: 0 });
  parent.emit({ type: 'model_relay', flowing: 0 });
  await waitFor(() => reports().length === 2);
  assert.deepEqual(reports()[1], { type: 'model_relay', flowing: 0, passing: 0 }, 'the relay is gone: nothing flows');
});

test('with no start message the key wait times out, reports it and holds nothing', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const parent = fx.newParent();
  await assert.rejects(fx.start(parent, { keyTimeoutMs: 40 }), (error) => error.reason === 'team_key_timeout');
  assert.deepEqual(parent.sent, [{ type: 'error', reason: 'team_key_timeout' }]);
  assert.equal(fx.lock.acquired, 1);
  assert.equal(fx.lock.released, 1);
  assert.equal(fx.contexts.length, 0, 'no listener was created');
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
});

test('the host key is never read from the environment', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const names = ['JENNY_TEAM_HOST_KEY', 'TEAM_HOST_KEY', 'HOST_KEY', 'JENNY_HOST_KEY', 'TEAM_HOST_KEY_B64', 'JENNY_TEAM_KEY'];
  const saved = names.map((name) => [name, process.env[name]]);
  for (const name of names) process.env[name] = fx.hostKey;
  try {
    const parent = fx.newParent();
    await assert.rejects(fx.start(parent, { keyTimeoutMs: 40 }), (error) => error.reason === 'team_key_timeout');
    assert.deepEqual(parent.sent, [{ type: 'error', reason: 'team_key_timeout' }]);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('a secret-file host writes the ready marker with its boot epoch and pid, and stop removes it', async (t) => {
  const fx = createTeamHostFixture(t);
  const host = await fx.start();
  // On Linux the marker also carries this process's start time (slice 3-11); the epoch and pid hold everywhere.
  const { bootEpoch, pid } = readReadyMarker({ userDataPath: fx.profile });
  assert.deepEqual({ bootEpoch, pid }, { bootEpoch: host.bootEpoch, pid: process.pid });
  assert.equal(host.publicKey, fx.hostPublicKey);
  await host.stop();
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
  assert.equal(fx.lock.released, 1);
});

test('a missing or malformed key file is team_host_key_invalid', async (t) => {
  const missing = createTeamHostFixture(t, { writeKey: false });
  await assert.rejects(missing.start(), (error) => error.reason === 'team_host_key_invalid');
  assert.equal(missing.lock.released, 1);
  const malformed = createTeamHostFixture(t);
  for (const text of ['not a key', Buffer.alloc(16, 7).toString('base64url'), `${malformed.hostKey}=`]) {
    malformed.writeKeyFile(text);
    await assert.rejects(malformed.start(), (error) => error.reason === 'team_host_key_invalid', text);
  }
  assert.equal(malformed.lock.released, 3);
  assert.equal(malformed.contexts.length, 0);
});

test('the placeholder listener answers nothing: every request sees a close with zero bytes', async (t) => {
  const fx = createTeamHostFixture(t);
  const host = await fx.start();
  assert.equal(fx.context().isReady(), true);
  for (const request of ['GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n', 'GET /readyz HTTP/1.1\r\nHost: x\r\n\r\n',
    'GET / HTTP/1.1\r\nHost: x\r\n\r\n']) {
    assert.deepEqual(await fx.probe(host.port, request), { bytes: 0, closed: true }, request);
  }
});

test('a member file for another host key and a garbage member file both fail closed', async (t) => {
  const mismatch = createTeamHostFixture(t);
  const otherHost = new MemberStore({ userDataPath: mismatch.profile, hostPublicKey: randomKey(), teamName: 'Other' });
  const created = await otherHost.createInvite({ kind: 'owner_first', actorMemberId: LOCAL_COMMAND, invitePublicKey: randomKey() });
  assert.equal(created.ok, true);
  await assert.rejects(mismatch.start(), (error) => error.reason === 'team_host_key_mismatch');
  assert.equal(mismatch.lock.released, 1);
  assert.equal(mismatch.contexts.length, 0);

  const garbage = createTeamHostFixture(t);
  fs.writeFileSync(path.join(garbage.profile, 'team-members.json'), '{ not json');
  await assert.rejects(garbage.start(), (error) => error.reason === 'team_unavailable');
  assert.equal(garbage.lock.released, 1);
  assert.equal(garbage.contexts.length, 0);
  assert.equal(readReadyMarker({ userDataPath: garbage.profile }), null);
});

test('the bridge admits a registered device and closes an unknown key before any stream', async (t) => {
  const fx = createTeamHostFixture(t);
  const device = fx.client();
  const stranger = fx.client();
  await fx.seedMembers(device.deviceKey);
  await fx.start();

  const strangerConn = await fx.connect(stranger);
  const refused = await new Promise((resolve) => { strangerConn.onClose((info) => resolve(info)); });
  assert.deepEqual(refused, { refused: true });
  assert.equal(fx.fake.openStreamCount(), 0);
  const refusal = fx.logs.find((entry) => entry.event === 'team.bridge.connection_refused');
  assert.equal(refusal.fields.reason, 'not_admitted');

  await fx.connect(device);
  await waitFor(() => fx.logs.some((entry) => entry.event === 'team.bridge.connection_admitted'));
  const admitted = fx.logs.find((entry) => entry.event === 'team.bridge.connection_admitted');
  assert.equal(admitted.fields.kind, 'device');
});

test('a bridge child that cannot bind is team_transport_down and leaves no listener behind', async (t) => {
  const fx = createTeamHostFixture(t);
  const broken = createFakeBridgeSpawner(fx.fake, { startFails: 'bind_failed' });
  let port = null;
  await assert.rejects(fx.start(null, {
    spawnBridge: broken,
    createListener: async (context) => {
      const listener = await createClosedListener(context);
      port = listener.port;
      return listener;
    },
  }), (error) => error.reason === 'team_transport_down');
  assert.equal(typeof port, 'number');
  assert.equal(await fx.isListening(port), false);
  assert.equal(fx.lock.released, 1);
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
  assert.equal(fx.backends[0].calls.at(-1), 'dispose');
});

test('a bridge child that exits after ready reports team_transport_down and stops the host', async (t) => {
  const fx = createTeamHostFixture(t);
  const parent = fx.newParent();
  const host = await fx.start(parent);
  assert.equal(parent.sentTypes()[0], 'ready');
  assert.equal(fx.lock.released, 0);
  fx.spawner.last().crash(1);
  await host.stopped;
  assert.deepEqual(parent.sent.slice(2), [{ type: 'error', reason: 'team_transport_down' }, { type: 'stopped' }]);
  assert.equal(fx.lock.released, 1);
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
  assert.equal(fx.backends[0].calls.at(-1), 'dispose');
  assert.equal(JSON.stringify(fx.logs).includes(fx.hostKey), false);
});

// Slice 4a-4: a stop during a silent bridge start. The bridge child withholds `ready`; the start
// ends at the bridge's start timeout (10 s), the parent hears `stopped` alone, and the host leaves
// no listener, lock, ready marker or bridge child behind.
test('a stop during a silent bridge start ends with stopped alone and leaves nothing', async (t) => {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel' });
  const silent = createFakeBridgeSpawner(fx.fake, { silent: true });
  const parent = fx.newParent();
  let port = null;
  const starting = fx.start(parent, { spawnBridge: silent, createListener: async (context) => {
    const listener = await createClosedListener(context);
    port = listener.port;
    return listener;
  } });
  parent.emit({ type: 'start', host_key: fx.hostKey });
  await waitFor(() => silent.children.length === 1);
  parent.emit({ type: 'stop' });
  await assert.rejects(starting, (error) => error.reason === 'team_transport_down');
  assert.deepEqual(parent.sent, [{ type: 'stopped' }]);
  assert.equal(fx.lock.released, 1);
  assert.equal(await fx.isListening(port), false);
  assert.equal(silent.last().exited, true, 'the bridge child is gone');
  assert.equal(readReadyMarker({ userDataPath: fx.profile }), null);
  assert.equal(fx.backends[0].calls.at(-1), 'dispose');
});

test('a log field never overwrites the line\'s own timestamp, level or event', (t) => {
  const { log } = require('../../server/host-core');
  const lines = [];
  t.mock.method(process.stdout, 'write', (text) => { lines.push(text); return true; });
  log('INFO', 'host.listening', { level: 'X', event: 'y', timestamp: 'z', boot_epoch: 'boot' });
  t.mock.restoreAll();
  const line = JSON.parse(lines[0]);
  assert.equal(line.level, 'INFO');
  assert.equal(line.event, 'host.listening');
  assert.notEqual(line.timestamp, 'z');
  assert.ok(Number.isFinite(Date.parse(line.timestamp)));
  assert.equal(line.boot_epoch, 'boot');
});

test('a team start refuses a single-owner profile that holds auth.json and creates no member store', async (t) => {
  const fx = createTeamHostFixture(t);
  fs.mkdirSync(fx.profile, { recursive: true });
  fs.writeFileSync(path.join(fx.profile, 'auth.json'), '{}');
  await assert.rejects(fx.start(), (error) => error.reason === 'invalid_host_profile');
  assert.equal(fs.existsSync(path.join(fx.profile, MEMBERS_FILE)), false);
  assert.equal(fx.lock.acquired, fx.lock.released, 'the profile lock went back');
});

// Slice 5-5b: internet joining in the host child. The bridge is the fake child; the interface table is a stub.
const RELAY_URL = 'https://relay.example.org';
const RELAY_TOKEN = 'tok-relay-5b';
const PUBLIC_MAPPED = '203.0.113.7:45123';
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function internetHost(t, { internet, relayToken = RELAY_TOKEN, extra = {} } = {}) {
  const fx = createTeamHostFixture(t, { keySource: 'parent_channel', directPort: 45123 });
  if (internet) fx.writeConfig({ team: { internet } });
  const parent = fx.newParent();
  const starting = fx.start(parent, { networkInterfaces: () => ({}), reachDebounceMs: 60, ...extra });
  parent.emit({ type: 'start', host_key: fx.hostKey, ...(relayToken ? { relay_token: relayToken } : {}) });
  return { fx, parent, starting };
}

const reaches = (parent) => parent.sent.filter((message) => message.type === 'reach');

test('5-5b: with internet on, the bridge maps the port and uses the relay from start; ready is followed by one reach', async (t) => {
  const { fx, parent, starting } = internetHost(t, { internet: { map_port: true, public_address: null, relay_url: RELAY_URL } });
  await starting;
  const line = fx.spawner.last().startLine;
  assert.deepEqual(line.internet, { map_port: true });
  assert.deepEqual(line.relay, { url: RELAY_URL, token: RELAY_TOKEN }, 'the URL from the config, the token from start');
  assert.deepEqual(parent.sentTypes(), ['ready', 'reach']);
  assert.deepEqual(parent.sent[1], { type: 'reach', result: 'not_reachable', reason: 'relay_connecting' });
  assert.equal(JSON.stringify([fx.logs, parent.sent]).includes(RELAY_TOKEN), false, 'the token is in no log or message');
});

test('5-5b: a change that keeps the verdict sends nothing; ten changes inside the debounce send one', async (t) => {
  const { fx, parent, starting } = internetHost(t, { internet: { map_port: true, public_address: null, relay_url: RELAY_URL },
    extra: { reachDebounceMs: 150 } });
  await starting;
  const child = fx.spawner.last();
  assert.deepEqual(reaches(parent), [{ type: 'reach', result: 'not_reachable', reason: 'relay_connecting' }]);
  child.write({ t: 'mapping', state: 'requesting', external: null });
  await pause(250);
  assert.equal(reaches(parent).length, 1, 'still relay_connecting: nothing sent');
  // Each line moves the verdict (relay_connected, relay_connecting, ...): only the debounce holds them back.
  for (let index = 0; index < 10; index += 1) {
    child.write({ t: 'relay', state: index % 2 === 0 ? 'connected' : 'connecting' });
  }
  child.write({ t: 'relay', state: 'connected' });
  await pause(20);
  assert.equal(reaches(parent).length, 1, 'nothing before the debounce ends');
  await pause(300);
  assert.deepEqual(reaches(parent).slice(1), [{ type: 'reach', result: 'relay', reason: 'relay_connected' }]);
  child.write({ t: 'mapping', state: 'mapped', external: PUBLIC_MAPPED });
  await pause(300);
  assert.equal(fx.logText().includes('203.0.113.7'), false, 'the mapped address is in no log');
});

test('5-5b: a throw while reporting after a change is one WARN; the child lives and the last verdict sent stands', async (t) => {
  const { fx, parent, starting } = internetHost(t, { internet: { map_port: false, public_address: null, relay_url: RELAY_URL } });
  await starting;
  const child = fx.spawner.last();
  const send = parent.send.bind(parent);
  let broken = true;
  parent.send = (message) => {
    if (broken && message.type === 'reach') throw new Error('channel gone');
    return send(message);
  };
  child.write({ t: 'relay', state: 'connected' });
  await pause(200);
  assert.deepEqual(fx.logs.filter((entry) => entry.event === 'team.reach_judge_failed').map((entry) => [entry.level, entry.fields]),
    [['WARN', {}]]);
  broken = false;
  child.write({ t: 'relay', state: 'connecting' });
  await pause(200);
  assert.equal(reaches(parent).length, 1, 'relay_connecting was the last verdict sent: nothing new');
  child.write({ t: 'relay', state: 'connected' });
  await pause(200);
  assert.deepEqual(reaches(parent).slice(1), [{ type: 'reach', result: 'relay', reason: 'relay_connected' }]);
});

test('5-5b: with internet off the bridge gets no mapping and no relay, even with a token in start, and reach says internet_off', async (t) => {
  const { fx, parent, starting } = internetHost(t, {});
  await starting;
  const line = fx.spawner.last().startLine;
  assert.equal(line.internet, null);
  assert.equal(line.relay ?? null, null);
  assert.deepEqual(reaches(parent), [{ type: 'reach', result: 'not_reachable', reason: 'internet_off' }]);
});

test('5-5b: the first owner invite carries the setting (version 2, the owner address and the relay with its token)', async (t) => {
  const { parent, starting } = internetHost(t, {
    internet: { map_port: false, public_address: 'team.example.org', relay_url: RELAY_URL }, extra: { teamInit: true } });
  await starting;
  const { invite } = parent.sent.find((message) => message.type === 'owner_invite');
  const parsed = parseInvite(invite);
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.host_name, { name: 'team.example.org', port: 45123 });
  assert.equal(parsed.relay_url, RELAY_URL);
  assert.equal(parsed.relay_token, RELAY_TOKEN);
});

test('5-5b: invites.dispose() runs on every teardown path: a stop, a failed start and a transport failure', async (t) => {
  const disposals = [];
  const createInvites = (input) => {
    const service = createInviteService(input);
    return { ...service, dispose: () => { disposals.push(1); service.dispose(); } };
  };
  const stopped = createTeamHostFixture(t);
  const host = await stopped.start(null, { createInvites });
  await host.stop();
  assert.equal(disposals.length, 1, 'stop');

  const failed = createTeamHostFixture(t);
  await assert.rejects(failed.start(null, { createInvites, spawnBridge: createFakeBridgeSpawner(failed.fake, { startFails: 'bind_failed' }) }),
    (error) => error.reason === 'team_transport_down');
  assert.equal(disposals.length, 2, 'a failed start');

  const crashed = createTeamHostFixture(t);
  const running = await crashed.start(crashed.newParent(), { createInvites });
  crashed.spawner.last().crash(1);
  await running.stopped;
  assert.equal(disposals.length, 3, 'a transport failure after ready');
});

test('3-4b: a usage log refused for its content is set aside at start with the shared stamp, and the host starts', async (t) => {
  const { utcStamp } = require('../../server/team/bounded-log');
  const { USAGE_LOG_FILE } = require('../../server/team/usage-log');
  const fx = createTeamHostFixture(t);
  fs.writeFileSync(path.join(fx.profile, USAGE_LOG_FILE), '{ torn');
  const at = Date.UTC(2026, 10, 12, 9, 30);
  const host = await fx.start(null, { clock: () => at });
  const kept = fs.readdirSync(fx.profile).filter((name) => name.startsWith(`${USAGE_LOG_FILE}.unreadable-`));
  assert.deepEqual(kept, [`${USAGE_LOG_FILE}.unreadable-${utcStamp(at)}`]);
  assert.equal(fx.logs.some((entry) => entry.event === 'team_pool_usage.set_aside'), true);
  assert.equal(fx.logText().includes(fx.profile), false);
  await host.stop();
});

// Slice 3-11: the start steps the missing-root check must precede, recorded through the fixture's injected
// factories and spies on the stores' own open methods (no production hook). The pool block makes the
// pool start part of the sequence; the marker is written only after the listener and the bridge.
function recordStartSteps(t, fx) {
  const { ProjectAudit } = require('../../server/team/project-audit');
  const { UsageLog } = require('../../server/team/usage-log');
  const steps = [];
  for (const [owner, method, name] of [[MemberStore.prototype, 'openAtStart', 'member_store.open'],
    [ProjectAudit.prototype, 'openAtStart', 'approvals.open'], [UsageLog.prototype, 'openAtStart', 'usage_log.open']]) {
    const original = owner[method];
    t.mock.method(owner, method, function spy(...args) { steps.push(name); return original.apply(this, args); });
  }
  const base = fx.options();
  const record = (name, factory) => (...args) => { steps.push(name); return factory(...args); };
  const extra = {
    createFolders: record('folders', require('../../server/team/project-folders').createProjectFolders),
    createPool: record('pool.create', require('../../server/team/pool-composition').createPoolComposition),
    createBackend: record('core', fx.createBackend),
    createListener: record('listener', base.createListener),
    spawnBridge: record('bridge', fx.spawner),
  };
  return { steps, extra };
}

test('3-11: a headless host whose projects root is missing fails with team_projects_root_missing before anything is built', async (t) => {
  const fx = createTeamHostFixture(t);
  const data = path.join(fs.realpathSync.native(fx.root), 'data');
  fs.mkdirSync(data);
  const projectsRoot = path.join(data, 'projects');
  fx.writeConfig({ team: { projects_root: projectsRoot, pool: { context_length: 8192 } }, extra: { model_endpoint: undefined } });
  const { steps, extra } = recordStartSteps(t, fx);
  await assert.rejects(fx.start(null, extra), (error) => error.reason === 'team_projects_root_missing');
  // None of member store, approvals, folders, pool, usage log, core (so no disk admission), listener or
  // bridge was reached; the marker is written only after the last two, so it never was.
  assert.deepEqual(steps, []);
  assert.equal(fx.backends.length, 0);
  assert.equal(fx.contexts.length, 0);
  assert.deepEqual(fs.readdirSync(data), []);
  assert.equal(fx.lock.released, 1);
  // A headless host names the reason in its own log line; no path is logged.
  assert.deepEqual(fx.logs.filter((entry) => entry.event === 'team.start_failed').map((entry) => entry.fields),
    [{ reason: 'team_projects_root_missing' }]);
  assert.equal(JSON.stringify(fx.logs).includes(data.replace(/\\/g, '\\\\')), false);

  // With the root present the same spies see every step, in order (they are live), and the host starts.
  fs.mkdirSync(projectsRoot);
  const host = await fx.start(null, extra);
  assert.deepEqual(steps.filter((step, index) => steps.indexOf(step) === index),
    ['member_store.open', 'approvals.open', 'folders', 'pool.create', 'usage_log.open', 'core', 'listener', 'bridge']);
  assert.notEqual(readReadyMarker({ userDataPath: fx.profile }), null);
  await host.stop();
});

test('3-11: the core\'s disk admissions receive the team projects root; a non-team host\'s roots are the old two', async (t) => {
  const { createHostCore } = require('../../server/host-core');
  const { loadHostConfig } = require('../../server/config');
  const fx = createTeamHostFixture(t);
  const projectsRoot = path.join(fs.realpathSync.native(fx.root), 'data', 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fx.writeConfig({ team: { projects_root: projectsRoot } });
  const build = async (config) => {
    const received = [];
    const core = createHostCore({ config, clients: new ClientRegistry(), leases: new ControlLeases(), logger: () => {},
      createBackend: fx.createBackend, makeDiskAdmission: (roots) => { received.push([...roots]); return () => true; } });
    await core.dispose();
    return received;
  };
  const team = loadHostConfig(fx.configPath);
  // Both admissions (commands and deletions) get the same roots.
  assert.deepEqual(await build(team), [[team.userDataPath, null, projectsRoot], [team.userDataPath, null, projectsRoot]]);
  const single = { userDataPath: fx.profile, workspaceRoot: path.join(fx.root, 'workspace'), secretsDir: fx.secrets, execution: null };
  assert.deepEqual(await build(single), [[single.userDataPath, single.workspaceRoot], [single.userDataPath, single.workspaceRoot]]);
  const noRoot = loadHostConfig((fx.writeConfig(), fx.configPath));
  assert.deepEqual(await build(noRoot), [[noRoot.userDataPath, null], [noRoot.userDataPath, null]]);
});

test('3-11: a desktop (parent channel) host is not given the missing-root check', () => {
  const { assertTeamProjectsRoot } = require('../../server/host-core');
  const missing = path.join(require('node:os').tmpdir(), 'jenny-no-such-projects-root-3-11');
  assert.equal(assertTeamProjectsRoot({ team: { keySource: 'parent_channel', projectsRoot: missing } }), undefined);
  assert.equal(assertTeamProjectsRoot({ team: { keySource: 'secret_file' } }), undefined);
  assert.equal(assertTeamProjectsRoot({}), undefined);
  assert.throws(() => assertTeamProjectsRoot({ team: { keySource: 'secret_file', projectsRoot: missing } }),
    (error) => error.reason === 'team_projects_root_missing');
});

// ------------------------------------------------------------------ review round two (R09-F02)

const { DELETE_MARKER, RESTORE_MARKER } = require('../../server/team/maintenance-markers');

async function startOutcome(fx) {
  try {
    await fx.start();
    return { started: true, ready: readReadyMarker({ userDataPath: fx.profile }) !== null };
  } catch (error) {
    return { started: false, reason: error.reason || error.message, ready: readReadyMarker({ userDataPath: fx.profile }) !== null };
  }
}

test('R09-F02: a headless start over an unfinished delete or restore refuses with the marker\'s word and serves nothing', async (t) => {
  for (const [marker, reason] of [[DELETE_MARKER, 'team_delete_unfinished'], [RESTORE_MARKER, 'team_restore_unfinished']]) {
    const fx = createTeamHostFixture(t, { keySource: 'secret_file' });
    await fx.seedMembers(randomKey());
    // team-delete (or team-restore) wrote its marker and was cut; the key file is still there. The restart policy starts the server.
    fs.writeFileSync(path.join(fx.profile, marker), `${fx.teamName}\n`, { mode: 0o600 });
    assert.deepEqual(await startOutcome(fx), { started: false, reason, ready: false }, marker);
    assert.equal(fx.lock.acquired - fx.lock.released, 0, 'the profile lock is let go');
  }
  // A delete cut after the member store went still refuses, and makes no new store on the old key.
  const fx = createTeamHostFixture(t, { keySource: 'secret_file' });
  await fx.seedMembers(randomKey());
  fs.writeFileSync(path.join(fx.profile, DELETE_MARKER), `${fx.teamName}\n`, { mode: 0o600 });
  fs.rmSync(path.join(fx.profile, MEMBERS_FILE));
  assert.equal((await startOutcome(fx)).started, false);
  assert.equal(fs.existsSync(path.join(fx.profile, MEMBERS_FILE)), false);
});
