'use strict';

// The host supervisor's lifecycle against the fake bridge child: the start line,
// where the secrets travel, the ways a start fails, a child that dies, stop with a
// child that will not stop, log filtering, plus the control-channel codec and the
// binary lookup the two supervisors share.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHostBridge, DEFAULT_LIMITS } = require('../../server/team/transport/host-bridge');
const { resolveBridgeBinary, BINARY_NAME } = require('../../server/team/transport/bridge-binary');
const { attachControl, filterLog, spawnBridgeChild } = require('../../server/team/transport/control-channel');
const { FakeChildProcess } = require('./helpers/fake-bridge/fake-child');
const { createFakeBridgeSpawner } = require('./helpers/fake-bridge');
const { createFakeTransport, waitFor } = require('./helpers/fake-team-transport');

const bootSecret = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const hostSecret = new Uint8Array(32).fill(9);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

function makeHost(t, { spawnerOptions, ...options } = {}) {
  const fake = createFakeTransport();
  const spawner = createFakeBridgeSpawner(fake, spawnerOptions);
  const logs = [];
  const downs = [];
  const bridge = createHostBridge({
    spawnChild: spawner,
    secretKey: hostSecret,
    loopbackPort: 4321,
    bootSecret,
    admit: () => 'device',
    log: (event, fields) => logs.push({ event, fields }),
    onDown: (reason) => downs.push(reason),
    ...options,
  });
  t.after(() => bridge.stop());
  return { fake, spawner, bridge, logs, downs };
}

const transportDown = (error) => error.code === 'transport_down';

test('start sends the secrets only in the start line', async (t) => {
  const env = makeHost(t, { directPort: 40404 });
  await env.bridge.start();
  const child = env.spawner.last();
  assert.deepEqual(env.spawner.spawns, [{ mode: 'host', args: [] }], 'the spawn receives the mode and nothing else');
  assert.equal(child.mode, 'host');
  const start = child.received[0];
  assert.equal(start.t, 'start');
  assert.equal(start.mode, 'host');
  assert.equal(start.secret_key, b64(hostSecret));
  assert.equal(start.boot_secret, b64(bootSecret));
  assert.equal(start.alpn, 'jenny-team/1');
  assert.equal(start.loopback_port, 4321);
  assert.equal(start.direct_port, 40404);
  const secrets = [b64(hostSecret), b64(bootSecret), Buffer.from(hostSecret).toString('hex')];
  for (const needle of secrets) {
    assert.equal(JSON.stringify(env.spawner.spawns).includes(needle), false, 'no secret in the spawn call');
    assert.equal(JSON.stringify(env.logs).includes(needle), false, 'no secret in a log');
    assert.equal(JSON.stringify(child.received.slice(1)).includes(needle), false, 'no secret in a later line');
    for (const value of Object.values(process.env)) assert.equal(value.includes(needle), false, 'no secret in the environment');
  }
  await env.bridge.stop();
});

test('the default limits arrive in the start line as 64, 16, 128, 64, 5000 and 1000', async (t) => {
  const env = makeHost(t);
  await env.bridge.start();
  const start = env.spawner.last().received[0];
  assert.deepEqual(start.limits, {
    max_connections: 64,
    max_streams_per_connection: 16,
    max_streams_total: 128,
    max_handshakes: 64,
    admit_timeout_ms: 5000,
    drop_grace_ms: 1000,
  });
  assert.equal(start.direct_port, null);
  assert.equal(DEFAULT_LIMITS.startTimeoutMs, 10000);
  assert.equal(DEFAULT_LIMITS.stopTimeoutMs, 10_000);
});

test('limits are mapped to snake_case and the JavaScript-only limits are not sent', async (t) => {
  const env = makeHost(t, { limits: { maxConnections: 3, maxHandshakes: 5, dropGraceMs: 7, startTimeoutMs: 900 } });
  await env.bridge.start();
  const { limits } = env.spawner.last().received[0];
  assert.equal(limits.max_connections, 3);
  assert.equal(limits.max_handshakes, 5);
  assert.equal(limits.drop_grace_ms, 7);
  assert.equal('start_timeout_ms' in limits, false);
  assert.equal('stop_timeout_ms' in limits, false);
});

test('start twice throws, and a stop before start resolves at once', async (t) => {
  const env = makeHost(t);
  await env.bridge.start();
  await assert.rejects(env.bridge.start(), /host bridge already started/);
  const idle = makeHost(t);
  await idle.bridge.stop();
  assert.equal(idle.spawner.spawns.length, 0);
});

test('start rejects with transport_down when the child reports an error', async (t) => {
  const env = makeHost(t, { spawnerOptions: { startFails: 'bind_failed' } });
  await assert.rejects(env.bridge.start(), transportDown);
  assert.deepEqual(env.bridge.addresses(), []);
  await waitFor(() => env.spawner.last().exited);
});

test('start rejects with transport_down when the child exits before ready, and kills nothing twice', async (t) => {
  const env = makeHost(t, { spawnerOptions: { silent: true } });
  const starting = env.bridge.start();
  const child = env.spawner.last();
  await waitFor(() => child.received.length === 1);
  child.crash(1);
  await assert.rejects(starting, transportDown);
  assert.deepEqual(env.downs, [], 'a failed start is not a down event');
});

test('start rejects with transport_down after the start timeout and kills the silent child', async (t) => {
  const env = makeHost(t, { spawnerOptions: { silent: true }, limits: { startTimeoutMs: 60 } });
  await assert.rejects(env.bridge.start(), transportDown);
  const child = env.spawner.last();
  await waitFor(() => child.exited);
  assert.equal(child.signalCode, 'SIGTERM', 'killed by the supervisor through its own handle');
  assert.deepEqual(env.downs, []);
});

test('a non-JSON line before ready fails the start and kills the child', async (t) => {
  const env = makeHost(t, { spawnerOptions: { silent: true } });
  const starting = env.bridge.start();
  const child = env.spawner.last();
  await waitFor(() => child.received.length === 1);
  child.writeRaw('this is not json\n');
  await assert.rejects(starting, transportDown);
  await waitFor(() => child.exited);
});

test('a spawn that throws rejects start with that error', async (t) => {
  const failure = Object.assign(new Error('no binary'), { code: 'transport_unavailable' });
  const env = makeHost(t, { spawnerOptions: { spawnThrows: failure } });
  await assert.rejects(env.bridge.start(), (error) => error === failure);
  await env.bridge.stop();
});

test('a child that exits after ready calls onDown once and empties addresses', async (t) => {
  const env = makeHost(t, {
    onDown: (reason) => { env.downs.push(reason); throw new Error('onDown must not break the supervisor'); },
  });
  await env.bridge.start();
  assert.equal(env.bridge.addresses().length, 2);
  env.spawner.last().crash(1);
  await waitFor(() => env.downs.length === 1);
  assert.deepEqual(env.downs, ['team_transport_down']);
  assert.deepEqual(env.bridge.addresses(), []);
  assert.deepEqual(env.bridge.stats(), { connections: 0, streams: 0, refusedStreams: 0, refusedConnections: 0 });
  assert.equal(env.logs.filter((entry) => entry.event === 'team.bridge.down').length, 1);
  await env.bridge.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.downs.length, 1, 'onDown fires once');
});

test('a child that crashes right after ready is down even when start has just resolved', async (t) => {
  const env = makeHost(t, { spawnerOptions: { crashAfterReady: true } });
  await env.bridge.start();
  await waitFor(() => env.downs.length === 1);
  assert.deepEqual(env.downs, ['team_transport_down']);
});

test('a stop that the supervisor asked for is not a down event', async (t) => {
  const env = makeHost(t);
  await env.bridge.start();
  await env.bridge.stop();
  assert.equal(env.spawner.last().received.at(-1).t, 'stop');
  assert.equal(env.spawner.last().exitCode, 0);
  assert.deepEqual(env.downs, []);
  assert.deepEqual(env.bridge.addresses(), []);
});

test('stop with a child that ignores it kills the child after stopTimeoutMs', async (t) => {
  const env = makeHost(t, { spawnerOptions: { ignoreStop: true }, limits: { stopTimeoutMs: 60 } });
  await env.bridge.start();
  const child = env.spawner.last();
  const began = Date.now();
  await env.bridge.stop();
  assert.ok(Date.now() - began >= 50, 'the supervisor waited for the child first');
  assert.equal(child.exited, true);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.deepEqual(env.downs, []);
});

test('a garbage line from the child after ready is treated as down', async (t) => {
  const env = makeHost(t, { spawnerOptions: { garbageAfterReady: true } });
  await env.bridge.start();
  await waitFor(() => env.downs.length === 1);
  const child = env.spawner.last();
  await waitFor(() => child.exited);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.deepEqual(env.bridge.addresses(), []);
});

test('only allowlisted log lines reach the logger, and only their allowed fields', async (t) => {
  const env = makeHost(t);
  await env.bridge.start();
  const child = env.spawner.last();
  const keyLike = b64(new Uint8Array(32).fill(3));
  child.write({ t: 'log', event: 'team.evil', fields: { reason: 'device' } });
  child.write({ t: 'log', event: 'team.bridge.connection_admitted', fields: { kind: keyLike, connections: 2, address: '1.2.3.4:5' } });
  child.write({ t: 'log', event: 'team.bridge.connection_refused', fields: { reason: 'not_admitted', connections: -1 } });
  await waitFor(() => env.logs.some((entry) => entry.event === 'team.bridge.connection_refused'));
  assert.equal(env.logs.some((entry) => entry.event === 'team.evil'), false);
  const admitted = env.logs.find((entry) => entry.event === 'team.bridge.connection_admitted');
  assert.deepEqual(admitted.fields, { connections: 2 });
  const refused = env.logs.find((entry) => entry.event === 'team.bridge.connection_refused');
  assert.deepEqual(refused.fields, { reason: 'not_admitted' });
  assert.equal(JSON.stringify(env.logs).includes(keyLike), false);
});

test('filterLog keeps known events with integer or fixed-word fields and nothing else', () => {
  assert.deepEqual(filterLog('team.bridge.started', {}), { event: 'team.bridge.started', fields: {} });
  assert.deepEqual(filterLog('team.bridge.connection_refused', { reason: 'handshake_cap', connections: 3 }),
    { event: 'team.bridge.connection_refused', fields: { reason: 'handshake_cap', connections: 3 } });
  assert.equal(filterLog('team.bridge.unknown', {}), null);
  assert.equal(filterLog('team.member_bridge.state', {}), null);
  assert.equal(filterLog(42, {}), null);
  const ok = filterLog('team.bridge.stream_refused', { reason: 'total_cap', streams: 128, kind: 'invite' });
  assert.deepEqual(ok.fields, { reason: 'total_cap', streams: 128, kind: 'invite' });
  const key = b64(new Uint8Array(32).fill(8));
  const dirty = filterLog('team.bridge.connection_admitted', {
    kind: key, reason: 'closing', connections: 1.5, streams: -2, address: '10.0.0.1:1', extra: 3,
  });
  assert.deepEqual(dirty.fields, { reason: 'closing' });
  assert.deepEqual(filterLog('team.bridge.dropped', null).fields, {});
  assert.deepEqual(filterLog('team.bridge.dropped', { connections: Number.MAX_SAFE_INTEGER + 1 }).fields, {});
});

// A scripted child for the codec tests.
function attached(options = {}) {
  const child = new FakeChildProcess();
  const messages = [];
  const exits = [];
  const control = attachControl(child, {
    onMessage: (message) => messages.push(message),
    onExit: (info) => exits.push(info),
    ...options,
  });
  return { child, control, messages, exits };
}

test('the codec joins split lines, parses each JSON object and calls onExit exactly once', async () => {
  const { child, messages, exits } = attached();
  child.stdout.push('{"t":"ready","addr');
  child.stdout.push('esses":[]}\n{"t":"log"');
  child.stdout.push(',"event":"x","fields":{}}\n');
  await waitFor(() => messages.length === 2);
  assert.deepEqual(messages.map((message) => message.t), ['ready', 'log']);
  child.exit(0);
  await waitFor(() => exits.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].failed, false);
  assert.equal(exits[0].code, 0);
});

test('a line over 65536 bytes, a non-object line and a blank line are protocol failures that kill the child', async () => {
  const cases = [
    `${JSON.stringify({ t: 'log', pad: 'x'.repeat(70000) })}\n`,
    '[1,2]\n',
    '"text"\n',
    'null\n',
    'not json\n',
    '\n',
    'x'.repeat(70000),
  ];
  for (const text of cases) {
    const { child, messages, exits } = attached();
    child.stdout.push(text);
    await waitFor(() => exits.length === 1);
    assert.equal(exits[0].failed, true);
    assert.equal(child.signalCode, 'SIGTERM', 'the supervisor killed its own child');
    assert.equal(messages.length, 0);
  }
});

test('nothing after a protocol failure is delivered, and send is a no-op once the child is gone', async () => {
  const { child, control, messages, exits } = attached();
  child.stdout.push('garbage\n{"t":"ready"}\n');
  await waitFor(() => exits.length === 1);
  assert.deepEqual(messages, []);
  assert.doesNotThrow(() => control.send({ t: 'stop' }));
  assert.doesNotThrow(() => control.close());
  child.stdin.destroy(new Error('EPIPE'));
});

test('send writes one JSON line per message', async () => {
  const { child, control } = attached();
  control.send({ t: 'stop' });
  control.send({ t: 'drop', key: 'abc' });
  await waitFor(() => child.received.length === 2);
  assert.deepEqual(child.received, [{ t: 'stop' }, { t: 'drop', key: 'abc' }]);
  child.exit(0);
});

test('a spawn error event is reported through onExit as a spawn failure', async () => {
  const { child, exits } = attached();
  child.pid = undefined;
  child.emit('error', Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }));
  await waitFor(() => exits.length === 1);
  assert.equal(exits[0].failed, true);
  assert.equal(exits[0].spawnFailed, true);
});

test('spawnBridgeChild passes the mode as the only argument', async () => {
  const child = spawnBridgeChild('host', { binaryPath: process.execPath });
  try {
    assert.deepEqual(child.spawnargs.slice(1), ['host']);
    assert.ok(child.stdin && child.stdout, 'stdin and stdout are pipes');
    assert.equal(child.stderr, null, 'standard error is ignored');
  } finally {
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once('exit', resolve)));
  }
});

test('the binary is looked up in resources/sidecar, then build/sidecar, else not found', () => {
  const calls = [];
  const exists = (candidate) => {
    calls.push(candidate);
    return false;
  };
  assert.equal(resolveBridgeBinary({ resourcesPath: '/res', root: '/repo', exists }), null);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].replaceAll('\\', '/').endsWith(`/res/sidecar/${BINARY_NAME}`));
  assert.ok(calls[1].replaceAll('\\', '/').endsWith(`/repo/build/sidecar/${BINARY_NAME}`));
  const onlyBuild = resolveBridgeBinary({ resourcesPath: '/res', root: '/repo', exists: (c) => c.replaceAll('\\', '/').includes('/repo/') });
  assert.ok(onlyBuild.replaceAll('\\', '/').endsWith(`/repo/build/sidecar/${BINARY_NAME}`));
  const packaged = resolveBridgeBinary({ resourcesPath: '/res', root: '/repo', exists: () => true });
  assert.ok(packaged.replaceAll('\\', '/').endsWith(`/res/sidecar/${BINARY_NAME}`));
  const noResources = [];
  resolveBridgeBinary({ resourcesPath: undefined, root: '/repo', exists: (c) => { noResources.push(c); return false; } });
  assert.equal(noResources.length, 1, 'no resources path, no packaged lookup');
  assert.equal(BINARY_NAME, process.platform === 'win32' ? 'jenny-team-bridge.exe' : 'jenny-team-bridge');
});
