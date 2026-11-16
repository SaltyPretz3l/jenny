'use strict';

// The host supervisor's lifecycle against the fake bridge child: the start line,
// where the secrets travel, the ways a start fails, a child that dies, stop with a
// child that will not stop, log filtering, plus the control-channel codec and the
// binary lookup the two supervisors share.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHostBridge, DEFAULT_LIMITS } = require('../../server/team/transport/host-bridge');
const { resolveBridgeBinary, BINARY_NAME } = require('../../server/team/transport/bridge-binary');
const { attachControl, filterLog, parseMapping, spawnBridgeChild } = require('../../server/team/transport/control-channel');
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

test('the default limits arrive in the start line as 64, 16, 128, 64, 5000, 1000, 16, 8 and 60000', async (t) => {
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
    max_waiting: 16,
    max_handshakes_per_source: 8,
    refused_cooldown_ms: 60000,
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

test('the three admission limits may be lowered and never raised past their defaults', async (t) => {
  const env = makeHost(t, { limits: { maxWaiting: 2, maxHandshakesPerSource: 1, refusedCooldownMs: 50 } });
  await env.bridge.start();
  const { limits } = env.spawner.last().received[0];
  assert.equal(limits.max_waiting, 2);
  assert.equal(limits.max_handshakes_per_source, 1);
  assert.equal(limits.refused_cooldown_ms, 50);
  const base = { secretKey: new Uint8Array(32).fill(1), bootSecret: new Uint8Array(32).fill(2), loopbackPort: 9, admit: () => null };
  for (const [name, value] of [['maxWaiting', 17], ['maxHandshakesPerSource', 9], ['refusedCooldownMs', 60_001]]) {
    assert.throws(() => createHostBridge({ ...base, limits: { [name]: value } }), new RegExp(`limits\\.${name} must not exceed`));
  }
  for (const [name, value] of [['maxWaiting', 0], ['maxHandshakesPerSource', 1.5], ['refusedCooldownMs', -1]]) {
    assert.throws(() => createHostBridge({ ...base, limits: { [name]: value } }), new RegExp(`limits\\.${name}`));
  }
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

test('the refusal summary reaches the logger as counts by cause only', async (t) => {
  const env = makeHost(t);
  await env.bridge.start();
  const child = env.spawner.last();
  const keyLike = b64(new Uint8Array(32).fill(4));
  child.write({
    t: 'log',
    event: 'team.bridge.refusal_summary',
    fields: {
      rate: 196, cooldown: 1, waiting_cap: 2, handshake_cap: 0,
      address: '203.0.113.9:4433', key: keyLike, source: '203.0.113.9', reason: keyLike, invite: 'jteam1_x',
    },
  });
  await waitFor(() => env.logs.some((entry) => entry.event === 'team.bridge.refusal_summary'));
  const summary = env.logs.find((entry) => entry.event === 'team.bridge.refusal_summary');
  assert.deepEqual(summary.fields, { rate: 196, cooldown: 1, waiting_cap: 2, handshake_cap: 0 });
  const text = JSON.stringify(env.logs);
  for (const needle of ['203.0.113.9', '4433', keyLike, 'jteam1_']) assert.equal(text.includes(needle), false, needle);
});

test('internet joining off sends internet: null, on sends map_port, and nothing else is accepted', async (t) => {
  const off = makeHost(t, { directPort: 40404 });
  await off.bridge.start();
  assert.equal(off.spawner.last().received[0].internet, null);
  const on = makeHost(t, { directPort: 40404, internet: { mapPort: true } });
  await on.bridge.start();
  assert.deepEqual(on.spawner.last().received[0].internet, { map_port: true });
  const base = { secretKey: new Uint8Array(32).fill(1), bootSecret: new Uint8Array(32).fill(2), loopbackPort: 9, admit: () => null };
  for (const internet of [{ mapPort: false }, { mapPort: 'yes' }, {}, true, 'map', { mapPort: true, relay: 'x' }]) {
    assert.throws(() => createHostBridge({ ...base, directPort: 40404, internet }), /internet/, JSON.stringify(internet));
  }
  assert.throws(() => createHostBridge({ ...base, internet: { mapPort: true } }), /internet/, 'mapping needs a direct port');
});

test('a mapped address that cannot be the router\'s outside address is refused; private ones pass', () => {
  const mapped = (external) => parseMapping({ state: 'mapped', external });
  for (const external of [
    '0.0.0.0:4444', // unspecified: the router's WAN is down
    '127.0.0.1:4444', // loopback
    '224.0.0.1:4444', // multicast
    '255.255.255.255:4444', // broadcast
    '169.254.10.20:4444', // link-local
    '[2001:db8::1]:4444', // IPv6: the mapping is IPv4 only
  ]) {
    assert.equal(mapped(external), null, external);
  }
  // Behind another router: slice 5-5 reads these, so they are reported as given.
  for (const external of ['192.168.1.5:4444', '10.0.0.1:4444', '100.64.0.1:4444', '203.0.113.7:4444']) {
    assert.deepEqual(mapped(external), { state: 'mapped', external }, external);
  }
});

test('a mapping line before ready is ignored', async (t) => {
  const env = makeHost(t, { directPort: 40404, internet: { mapPort: true }, spawnerOptions: { silent: true } });
  const starting = env.bridge.start();
  const child = env.spawner.last();
  await waitFor(() => child.received.length === 1);
  child.write({ t: 'mapping', state: 'mapped', external: '203.0.113.7:4444' });
  child.write({ t: 'ready', public_key: b64(new Uint8Array(32).fill(5)), addresses: ['127.0.0.1:40404'] });
  await starting;
  assert.equal(env.bridge.mapping(), null);
  assert.equal(env.logs.some((entry) => entry.event === 'team.bridge.mapping'), false);
});

test('a mapping line reaches the caller with its address, and the logger gets the state word only', async (t) => {
  const env = makeHost(t, { directPort: 40404, internet: { mapPort: true } });
  await env.bridge.start();
  assert.equal(env.bridge.mapping(), null, 'nothing reported yet');
  const child = env.spawner.last();
  child.write({ t: 'mapping', state: 'requesting', external: null });
  await waitFor(() => env.bridge.mapping() !== null);
  assert.deepEqual(env.bridge.mapping(), { state: 'requesting', external: null });
  child.write({ t: 'mapping', state: 'mapped', external: '203.0.113.7:4444' });
  await waitFor(() => env.bridge.mapping()?.state === 'mapped');
  assert.deepEqual(env.bridge.mapping(), { state: 'mapped', external: '203.0.113.7:4444' });
  // Malformed lines change nothing: an unknown state, a mapped line without an address, an
  // address on a state that has none.
  child.write({ t: 'mapping', state: 'open', external: null });
  child.write({ t: 'mapping', state: 'mapped', external: 'router.home:4444' });
  child.write({ t: 'mapping', state: 'off', external: '203.0.113.7:4444' });
  child.write({ t: 'mapping', state: 'unavailable', external: null });
  await waitFor(() => env.bridge.mapping()?.state === 'unavailable');
  assert.deepEqual(env.bridge.mapping(), { state: 'unavailable', external: null });
  const states = env.logs.filter((entry) => entry.event === 'team.bridge.mapping').map((entry) => entry.fields);
  assert.deepEqual(states, [{ state: 'requesting' }, { state: 'mapped' }, { state: 'unavailable' }]);
  const text = JSON.stringify(env.logs);
  for (const needle of ['203.0.113.7', '4444', 'router.home']) assert.equal(text.includes(needle), false, needle);
  child.crash();
  await waitFor(() => env.downs.length === 1);
  assert.equal(env.bridge.mapping(), null, 'a dead child holds no mapping');
});

test('filterLog keeps known events with integer or fixed-word fields and nothing else', () => {
  assert.deepEqual(filterLog('team.bridge.started', {}), { event: 'team.bridge.started', fields: {} });
  assert.deepEqual(filterLog('team.bridge.connection_refused', { reason: 'connection_cap', connections: 3 }),
    { event: 'team.bridge.connection_refused', fields: { reason: 'connection_cap', connections: 3 } });
  assert.deepEqual(filterLog('team.bridge.connection_refused', { reason: 'handshake_cap' }).fields, {},
    'handshake_cap is a summary count now, not a reason word');
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
  assert.deepEqual(filterLog('team.bridge.stream_refused', { reason: 'early_data', streams: 0 }).fields,
    { reason: 'early_data', streams: 0 });
  // A key past its share of streams (16 across its connections).
  assert.deepEqual(filterLog('team.bridge.stream_refused', { reason: 'key_cap', streams: 16 }).fields,
    { reason: 'key_cap', streams: 16 });
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

// The owner's relay (TEAM_INTERNET_SPEC slice 5-4).
const RELAY = Object.freeze({ url: 'https://relay.example.com:8443', token: 'tok-SECRET-relay.1~' });

test('a relay goes on the start line only, and no relay leaves the start line as it was', async (t) => {
  const env = makeHost(t, { relay: RELAY });
  await env.bridge.start();
  const child = env.spawner.last();
  assert.deepEqual(child.received[0].relay, { url: RELAY.url, token: RELAY.token });
  const without = makeHost(t, { relay: null });
  await without.bridge.start();
  assert.equal('relay' in without.spawner.last().received[0], false, 'null sends no relay field');
  const absent = makeHost(t);
  await absent.bridge.start();
  assert.equal('relay' in absent.spawner.last().received[0], false, 'absent sends no relay field');
  const tokenless = makeHost(t, { relay: { url: 'https://relay.example.com', token: null } });
  await tokenless.bridge.start();
  assert.deepEqual(tokenless.spawner.last().received[0].relay, { url: 'https://relay.example.com', token: null });
  child.write({ t: 'relay', state: 'connected' });
  await waitFor(() => env.bridge.relay() === 'connected');
  await env.bridge.stop();
  const text = JSON.stringify([env.logs, env.spawner.spawns, child.received.slice(1)]);
  for (const needle of [RELAY.token, 'relay.example.com']) assert.equal(text.includes(needle), false, needle);
});

test('a bad relay option is a TypeError naming the field, never the value', () => {
  const base = {
    secretKey: hostSecret, loopbackPort: 4321, bootSecret, admit: () => 'device',
    spawnChild: () => { throw new Error('never spawned'); },
  };
  const secret = 'SECRET-VALUE';
  const cases = [
    [`https://${secret}.example.com/`, /relay\.url/], [`http://${secret}.example.com`, /relay\.url/],
    [`https://user@${secret}.example.com`, /relay\.url/], [`https://${secret}.example.com/x`, /relay\.url/],
    [`https://${secret}.example.com?x=1`, /relay\.url/], [`https://${secret}.example.com#x`, /relay\.url/],
    [`https://127.0.0.1`, /relay\.url/], [`https://${'a'.repeat(93)}.com`, /relay\.url/], [7, /relay\.url/],
  ].map(([url, pattern]) => [{ url, token: null }, pattern]);
  for (const token of ['', `${secret} x`, `${secret}${'x'.repeat(257)}`, 7, undefined]) {
    cases.push([{ url: 'https://relay.example.com', token }, /relay\.token/]);
  }
  cases.push([{ url: 'https://relay.example.com' }, /relay must be/]);
  cases.push([{ url: 'https://relay.example.com', token: null, extra: secret }, /relay must be/]);
  cases.push([`https://${secret}.example.com`, /relay must be/], [[secret], /relay must be/], [false, /relay must be/]);
  for (const [relay, pattern] of cases) {
    assert.throws(() => createHostBridge({ ...base, relay }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, pattern);
      assert.equal(error.message.includes(secret), false, 'the value is not in the message');
      return true;
    });
  }
});

test('relay lines: ignored before ready, known states kept and logged as the word, the rest dropped', async (t) => {
  const env = makeHost(t, { relay: RELAY, spawnerOptions: { silent: true } });
  const starting = env.bridge.start();
  const child = env.spawner.last();
  await waitFor(() => child.received.length === 1);
  child.write({ t: 'relay', state: 'connecting' });
  child.write({ t: 'ready', public_key: b64(new Uint8Array(32).fill(5)), addresses: ['127.0.0.1:40404'] });
  await starting;
  assert.equal(env.bridge.relay(), null, 'a relay line before ready is ignored');
  for (const state of ['connected', 'denied', 'unreachable']) {
    child.write({ t: 'relay', state });
    await waitFor(() => env.bridge.relay() === state);
  }
  child.write({ t: 'relay', state: 'open' });
  child.write({ t: 'relay', state: 7 });
  child.write({ t: 'relay' });
  child.write({ t: 'relay', state: 'off' });
  await waitFor(() => env.bridge.relay() === 'off');
  const states = env.logs.filter((entry) => entry.event === 'team.bridge.relay').map((entry) => entry.fields);
  assert.deepEqual(states, [{ state: 'connected' }, { state: 'denied' }, { state: 'unreachable' }, { state: 'off' }]);
  child.crash();
  await waitFor(() => env.downs.length === 1);
  assert.equal(env.bridge.relay(), null, 'a dead child holds no relay state');
});

test('the stats line path counts: both counts are kept, a bad count drops the whole line', async (t) => {
  const env = makeHost(t, { relay: RELAY });
  await env.bridge.start();
  assert.deepEqual(env.bridge.stats(), {
    connections: 0, streams: 0, refusedStreams: 0, refusedConnections: 0, directExternalConnections: 0, relayedConnections: 0,
  });
  const child = env.spawner.last();
  const base = { t: 'stats', connections: 2, streams: 3, refused_streams: 0, refused_connections: 0 };
  child.write({ ...base, direct_external_connections: 1, relayed_connections: 1 });
  await waitFor(() => env.bridge.stats().relayedConnections === 1);
  assert.equal(env.bridge.stats().directExternalConnections, 1);
  assert.equal(env.bridge.stats().streams, 3);
  for (const bad of [
    { direct_external_connections: -1, relayed_connections: 0 }, { direct_external_connections: 0, relayed_connections: '1' },
    { direct_external_connections: 0 }, { relayed_connections: 2 }, { direct_external_connections: 0.5, relayed_connections: 0 },
  ]) {
    child.write({ ...base, streams: 9, ...bad });
  }
  child.write({ ...base, streams: 4, direct_external_connections: 0, relayed_connections: 2 });
  await waitFor(() => env.bridge.stats().relayedConnections === 2);
  assert.equal(env.bridge.stats().streams, 4, 'no dropped line changed a count');
  child.write({ ...base, streams: 5 });
  await waitFor(() => env.bridge.stats().streams === 5);
  assert.equal(env.bridge.stats().relayedConnections, 0, 'a line without path counts is zero paths');
});

// Slice 6-6. Fault: bulk() true for a binary that passes the class byte into the HTTP layer.
test('6-6: bulk() is true only while a running child said it reads bulk streams', async (t) => {
  const env = makeHost(t);
  assert.equal(env.bridge.bulk(), false, 'not before start');
  await env.bridge.start();
  assert.equal(env.bridge.bulk(), true);
  env.spawner.last().crash();
  await waitFor(() => env.downs.length === 1);
  assert.equal(env.bridge.bulk(), false, 'not after the child is gone');

  const old = makeHost(t, { spawnerOptions: { noBulk: true } });
  await old.bridge.start();
  assert.equal(old.bridge.bulk(), false, 'a binary from before bulk streams');

  // Only the number 1 counts.
  for (const value of [true, '1', 2, 0, null]) {
    const odd = makeHost(t, { spawnerOptions: { silent: true } });
    const starting = odd.bridge.start();
    await waitFor(() => odd.spawner.last().received.length === 1);
    odd.spawner.last().write({ t: 'ready', public_key: b64(new Uint8Array(32).fill(5)), addresses: ['127.0.0.1:40404'], bulk: value });
    await starting;
    assert.equal(odd.bridge.bulk(), false, String(value));
  }
});
