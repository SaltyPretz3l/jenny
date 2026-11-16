'use strict';

// The member bridge supervisor against the fake bridge child: states and reasons,
// the 40-byte member preamble rules on the loopback port, stream caps, a lost or
// refusing host, stop, and where the secrets travel. The network part runs on the
// in-memory fake transport inside the fake child.

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');

const { createMemberBridge } = require('../services/team/transport/member-bridge');
const {
  MEMBER_PREAMBLE_BYTES,
  PREAMBLE_TIMEOUT_MS,
  encodeMemberPreamble,
} = require('../server/team/transport/preamble');
const { createFakeBridgeSpawner } = require('./server/helpers/fake-bridge');
const { createFakeTransport, hex, waitFor } = require('./server/helpers/fake-team-transport');

const ALPN = 'jenny-team/1';
const hostSecret = new Uint8Array(32).fill(9);
const memberSecret = new Uint8Array(32).fill(4);
const launchSecret = Uint8Array.from({ length: 32 }, (_, i) => i + 100);
const ADDRESSES = ['192.0.2.7:4242', '[2001:db8::7]:4242'];
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

// A fake host that echoes whatever each stream carries, prefixed with "echo:".
async function setup(t, { limits, hostOnConnection, listen = true, spawnerOptions, transportOverride, relay } = {}) {
  const fake = createFakeTransport();
  const host = { connections: [], streams: [], received: [] };
  if (listen) {
    await fake.transport.listen({
      secretKey: hostSecret,
      alpn: ALPN,
      onConnection: (conn) => {
        host.connections.push(conn);
        if (hostOnConnection) {
          hostOnConnection(conn);
          return;
        }
        (async () => {
          for (;;) {
            const stream = await conn.acceptStream();
            if (!stream) return;
            host.streams.push(stream);
            stream.on('error', () => {});
            stream.on('end', () => stream.destroy());
            stream.on('data', (chunk) => {
              host.received.push(chunk);
              stream.write(Buffer.concat([Buffer.from('echo:'), chunk]));
            });
          }
        })();
      },
    });
  }
  const spawner = createFakeBridgeSpawner(transportOverride ? { transport: transportOverride(fake) } : fake, spawnerOptions);
  const logs = [];
  const bridge = createMemberBridge({
    spawnChild: spawner,
    secretKey: memberSecret,
    hostPublicKey: fake.publicKeyOf(hostSecret),
    addresses: ADDRESSES,
    alpn: ALPN,
    launchSecret,
    limits,
    relay,
    log: (event, fields) => logs.push({ event, fields }),
  });
  const states = [];
  bridge.onState((s) => states.push(s));
  t.after(() => bridge.stop());
  return { fake, host, bridge, logs, states, spawner };
}

function dialLocal(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  const state = { closed: false, chunks: [] };
  socket.on('close', () => { state.closed = true; });
  socket.on('data', (chunk) => state.chunks.push(chunk));
  return { socket, state, text: () => Buffer.concat(state.chunks).toString() };
}

test('start dials the host, listens on loopback and reports connecting then online', async (t) => {
  const env = await setup(t);
  assert.deepEqual(env.bridge.state(), { state: 'offline', reason: 'closed' });
  assert.equal(env.bridge.port(), null);
  const result = await env.bridge.start();
  assert.deepEqual(result, { state: 'online', reason: null });
  assert.deepEqual(env.states.map((s) => s.state), ['connecting', 'online']);
  assert.ok(Number.isInteger(env.bridge.port()) && env.bridge.port() > 0);
  assert.deepEqual(env.bridge.lastWorkingAddresses(), ADDRESSES);
  await waitFor(() => env.host.connections.length === 1);
  assert.deepEqual(new Uint8Array(env.host.connections[0].remoteKey), env.fake.publicKeyOf(memberSecret));
  await assert.rejects(env.bridge.start(), /member bridge already started/);
});

test('the start line carries the keys, the addresses and the member limits, and nothing else carries a secret', async (t) => {
  const env = await setup(t);
  await env.bridge.start();
  assert.deepEqual(env.spawner.spawns, [{ mode: 'member', args: [] }]);
  const child = env.spawner.last();
  const start = child.received[0];
  assert.deepEqual(start, {
    t: 'start',
    mode: 'member',
    secret_key: b64(memberSecret),
    host_key: b64(env.fake.publicKeyOf(hostSecret)),
    addresses: ADDRESSES,
    alpn: ALPN,
    launch_secret: b64(launchSecret),
    limits: { max_preamble_sockets: 16, max_streams: 16, preamble_timeout_ms: 3000, connect_timeout_ms: 10000 },
  });
  for (const needle of [b64(memberSecret), b64(launchSecret), hex(launchSecret)]) {
    assert.equal(JSON.stringify(env.spawner.spawns).includes(needle), false, 'no secret in the spawn call');
    assert.equal(JSON.stringify(child.received.slice(1)).includes(needle), false, 'no secret in a later line');
    assert.equal(JSON.stringify(env.logs).includes(needle), false, 'no secret in a log');
    for (const value of Object.values(process.env)) assert.equal(value.includes(needle), false, 'no secret in the environment');
  }
});

test('custom limits reach the child in the start line', async (t) => {
  const env = await setup(t, { limits: { maxPreambleSockets: 3, maxStreams: 4, preambleTimeoutMs: 150, connectTimeoutMs: 900 } });
  await env.bridge.start();
  assert.deepEqual(env.spawner.last().received[0].limits,
    { max_preamble_sockets: 3, max_streams: 4, preamble_timeout_ms: 150, connect_timeout_ms: 900 });
});

test('a valid preamble opens one stream and carries bytes both ways, including bytes sent with it', async (t) => {
  const env = await setup(t);
  await env.bridge.start();
  const client = dialLocal(env.bridge.port());
  client.socket.write(Buffer.concat([encodeMemberPreamble(launchSecret), Buffer.from('first')]));
  await waitFor(() => client.text() === 'echo:first');
  client.socket.write('second');
  await waitFor(() => client.text().endsWith('echo:second'));
  assert.equal(Buffer.concat(env.host.received).toString(), 'firstsecond');
  assert.equal(env.host.streams.length, 1);
  client.socket.destroy();
  await waitFor(() => env.host.streams[0].destroyed);
});

test('wrong magic, wrong secret, a short preamble and a slow preamble each destroy the socket and open no stream', async (t) => {
  const env = await setup(t, { limits: { preambleTimeoutMs: 150 } });
  await env.bridge.start();
  const good = encodeMemberPreamble(launchSecret);
  const wrongMagic = Buffer.from(good);
  wrongMagic[0] = 0x58;
  const wrongVersion = Buffer.from(good);
  wrongVersion[4] = 2;
  const wrongReserved = Buffer.from(good);
  wrongReserved[5] = 1;
  const wrongSecret = Buffer.from(good);
  wrongSecret[39] ^= 0xff;
  const clients = [wrongMagic, wrongVersion, wrongReserved, wrongSecret].map((bytes) => {
    const client = dialLocal(env.bridge.port());
    client.socket.write(Buffer.concat([bytes, Buffer.from('GET / HTTP/1.1\r\n\r\n')]));
    return client;
  });
  const shortThenEnd = dialLocal(env.bridge.port());
  shortThenEnd.socket.end(good.subarray(0, MEMBER_PREAMBLE_BYTES - 1));
  const slow = dialLocal(env.bridge.port());
  slow.socket.write(good.subarray(0, 10));
  const silent = dialLocal(env.bridge.port());
  await waitFor(() => [...clients, shortThenEnd, slow, silent].every((c) => c.state.closed));
  assert.equal(env.host.streams.length, 0);
  assert.equal(env.fake.openStreamCount(), 0);
  assert.deepEqual(env.host.received, []);
  for (const client of [...clients, shortThenEnd, slow, silent]) assert.equal(client.text(), '');
});

test('the preamble window is 3 seconds and at most 16 sockets may be in it', async (t) => {
  assert.equal(PREAMBLE_TIMEOUT_MS, 3000);
  const env = await setup(t);
  await env.bridge.start();
  const idle = [];
  for (let i = 0; i < 16; i += 1) idle.push(dialLocal(env.bridge.port()));
  await Promise.all(idle.map((c) => new Promise((resolve) => c.socket.once('connect', resolve))));
  const seventeenth = dialLocal(env.bridge.port());
  await waitFor(() => seventeenth.state.closed);
  assert.ok(idle.every((c) => !c.state.closed), 'sockets inside the window stay open');
  idle[0].socket.destroy();
  await waitFor(() => idle[0].state.closed);
  // A freed slot is usable again.
  const again = dialLocal(env.bridge.port());
  again.socket.write(encodeMemberPreamble(launchSecret));
  again.socket.write('ping');
  await waitFor(() => again.text() === 'echo:ping');
  assert.equal(env.host.streams.length, 1);
});

test('the number of live streams is capped', async (t) => {
  const env = await setup(t, { limits: { maxStreams: 2 } });
  await env.bridge.start();
  const clients = [];
  for (let i = 0; i < 2; i += 1) {
    const client = dialLocal(env.bridge.port());
    client.socket.write(encodeMemberPreamble(launchSecret));
    client.socket.write('hi');
    await waitFor(() => client.text() === 'echo:hi');
    clients.push(client);
  }
  const over = dialLocal(env.bridge.port());
  over.socket.write(encodeMemberPreamble(launchSecret));
  over.socket.write('hi');
  await waitFor(() => over.state.closed);
  assert.equal(env.host.streams.length, 2);
  clients[0].socket.destroy();
  await waitFor(() => env.host.streams[0].destroyed);
  const next = dialLocal(env.bridge.port());
  next.socket.write(encodeMemberPreamble(launchSecret));
  next.socket.write('yo');
  await waitFor(() => next.text() === 'echo:yo');
});

test('an unreachable host reports offline with host_unreachable and never listens', async (t) => {
  const env = await setup(t, { listen: false });
  const result = await env.bridge.start();
  assert.deepEqual(result, { state: 'offline', reason: 'host_unreachable' });
  assert.deepEqual(env.states.map((s) => `${s.state}:${s.reason}`), ['connecting:null', 'offline:host_unreachable']);
  assert.equal(env.bridge.port(), null);
  assert.deepEqual(env.bridge.lastWorkingAddresses(), []);
  await env.bridge.stop();
  assert.equal(env.spawner.last().exited, true);
});

test('a host that turns the member away reports host_refused and drops local sockets', async (t) => {
  let hostConn;
  const env = await setup(t, { hostOnConnection: (conn) => { hostConn = conn; } });
  await env.bridge.start();
  const client = dialLocal(env.bridge.port());
  await new Promise((resolve) => client.socket.once('connect', resolve));
  await waitFor(() => hostConn);
  await hostConn.close('refused');
  await waitFor(() => env.bridge.state().state === 'offline');
  assert.deepEqual(env.bridge.state(), { state: 'offline', reason: 'host_refused' });
  await waitFor(() => client.state.closed);
  assert.equal(env.bridge.port(), null);
  assert.deepEqual(env.bridge.lastWorkingAddresses(), ADDRESSES, 'the last working addresses survive a refusal');
});

test('a lost connection reports offline with reason closed, and does not retry', async (t) => {
  let hostConn;
  const env = await setup(t, { hostOnConnection: (conn) => { hostConn = conn; } });
  await env.bridge.start();
  await waitFor(() => hostConn);
  await hostConn.close();
  await waitFor(() => env.bridge.state().state === 'offline');
  assert.deepEqual(env.bridge.state(), { state: 'offline', reason: 'closed' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(env.fake.state.connects, 1);
  assert.equal(env.spawner.spawns.length, 1, 'no second child either');
});

test('a child that exits while online reports offline with reason closed', async (t) => {
  const env = await setup(t);
  await env.bridge.start();
  const port = env.bridge.port();
  env.spawner.last().crash(1);
  await waitFor(() => env.bridge.state().state === 'offline');
  assert.deepEqual(env.bridge.state(), { state: 'offline', reason: 'closed' });
  assert.equal(env.bridge.port(), null);
  assert.ok(port > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(env.spawner.spawns.length, 1);
});

test('a child that exits before reporting a state makes start resolve offline with reason closed', async (t) => {
  const env = await setup(t, { spawnerOptions: { silent: true } });
  const starting = env.bridge.start();
  const child = env.spawner.last();
  await waitFor(() => child.received.length === 1);
  child.crash(1);
  assert.deepEqual(await starting, { state: 'offline', reason: 'closed' });
});

test('a child that refuses its start ends the start offline with host_unreachable', async (t) => {
  const env = await setup(t, { spawnerOptions: { startFails: 'start_invalid' } });
  assert.deepEqual(await env.bridge.start(), { state: 'offline', reason: 'host_unreachable' });
});

test('addresses must be at most 16 ip:port strings the binary can dial', () => {
  const base = {
    secretKey: new Uint8Array(32).fill(1), hostPublicKey: new Uint8Array(32).fill(2),
    launchSecret: new Uint8Array(32).fill(3), spawnChild: () => { throw new Error('never spawned'); },
  };
  for (const addresses of [['host.example:4000'], ['192.0.2.7'], ['192.0.2.7:0'], ['[zz::1]:7'],
    ['192.0.2.7:70000'], Array.from({ length: 17 }, (_, i) => `192.0.2.${i + 1}:7000`)]) {
    assert.throws(() => createMemberBridge({ ...base, addresses }), /ip:port/);
  }
  assert.doesNotThrow(() => createMemberBridge({ ...base, addresses: ['192.0.2.7:7000', '[2001:db8::7]:7000'] }));
});

// The bridge program is missing or blocked: this PC's fault, told apart from a host that does not answer.
test('a spawn that throws is offline with team_bridge_unavailable', async (t) => {
  const env = await setup(t, { spawnerOptions: { spawnThrows: Object.assign(new Error('x'), { code: 'transport_unavailable' }) } });
  assert.deepEqual(await env.bridge.start(), { state: 'offline', reason: 'team_bridge_unavailable' });
  assert.deepEqual(env.states.map((s) => s.state), ['connecting', 'offline']);
});

test('an unknown offline reason from the child becomes closed, and a garbage line ends the child', async (t) => {
  const odd = await setup(t, { spawnerOptions: { silent: true } });
  const oddStart = odd.bridge.start();
  await waitFor(() => odd.spawner.last().received.length === 1);
  odd.spawner.last().write({ t: 'state', state: 'offline', reason: 'weird' });
  assert.deepEqual(await oddStart, { state: 'offline', reason: 'closed' });

  const junk = await setup(t, { spawnerOptions: { silent: true } });
  const junkStart = junk.bridge.start();
  await waitFor(() => junk.spawner.last().received.length === 1);
  junk.spawner.last().writeRaw('garbage\n');
  assert.deepEqual(await junkStart, { state: 'offline', reason: 'closed' });
  await waitFor(() => junk.spawner.last().exited);
});

test('a child that never reports is given up on after the connect timeout plus five seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = await setup(t, { spawnerOptions: { silent: true }, limits: { connectTimeoutMs: 100 } });
  const starting = env.bridge.start();
  t.mock.timers.tick(5099);
  assert.equal(env.bridge.state().state, 'connecting', 'still waiting just before the guard');
  t.mock.timers.tick(1);
  assert.deepEqual(await starting, { state: 'offline', reason: 'host_unreachable' });
  assert.equal(env.spawner.last().exited, true, 'the supervisor killed the child');
});

test('stop leaves no listening socket, no open socket and a closed state', async (t) => {
  const env = await setup(t);
  await env.bridge.start();
  const port = env.bridge.port();
  const client = dialLocal(port);
  client.socket.write(encodeMemberPreamble(launchSecret));
  client.socket.write('x');
  await waitFor(() => client.text() === 'echo:x');
  const idle = dialLocal(port);
  await new Promise((resolve) => idle.socket.once('connect', resolve));
  await env.bridge.stop();
  assert.deepEqual(env.bridge.state(), { state: 'offline', reason: 'closed' });
  assert.equal(env.bridge.port(), null);
  assert.equal(env.spawner.last().exited, true);
  await waitFor(() => client.state.closed && idle.state.closed);
  await assert.rejects(new Promise((resolve, reject) => {
    const probe = net.connect({ host: '127.0.0.1', port });
    probe.on('connect', () => { probe.destroy(); resolve(); });
    probe.on('error', reject);
  }));
  await waitFor(() => env.host.connections[0].closed);
  await env.bridge.stop();
});

test('stop with a child that ignores it kills the child after stopTimeoutMs', async (t) => {
  const env = await setup(t, { spawnerOptions: { ignoreStop: true }, limits: { stopTimeoutMs: 60 } });
  await env.bridge.start();
  const child = env.spawner.last();
  await env.bridge.stop();
  assert.equal(child.exited, true);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.deepEqual(env.bridge.state(), { state: 'offline', reason: 'closed' });
});

test('stop during a pending dial leaves nothing listening and the start resolves offline', async (t) => {
  let releaseDial;
  const env = await setup(t, {
    transportOverride: (fake) => ({
      listen: fake.transport.listen,
      connect: (options) => new Promise((resolve, reject) => {
        releaseDial = () => fake.transport.connect(options).then(resolve, reject);
      }),
    }),
  });
  const started = env.bridge.start();
  await waitFor(() => releaseDial);
  await env.bridge.stop();
  releaseDial();
  assert.deepEqual(await started, { state: 'offline', reason: 'closed' });
  assert.equal(env.bridge.port(), null);
  assert.deepEqual(env.bridge.state(), { state: 'offline', reason: 'closed' });
});

test('onState returns an unsubscribe function', async (t) => {
  const env = await setup(t);
  const seen = [];
  const off = env.bridge.onState((s) => seen.push(s.state));
  off();
  await env.bridge.start();
  await env.bridge.stop();
  assert.deepEqual(seen, []);
  assert.throws(() => env.bridge.onState('x'), TypeError);
});

test('the bridge refuses malformed construction arguments', () => {
  const fake = createFakeTransport();
  const spawnChild = createFakeBridgeSpawner(fake);
  const base = {
    spawnChild,
    secretKey: memberSecret,
    hostPublicKey: fake.publicKeyOf(hostSecret),
    addresses: ADDRESSES,
    alpn: ALPN,
    launchSecret,
  };
  assert.doesNotThrow(() => createMemberBridge(base));
  assert.doesNotThrow(() => createMemberBridge({ ...base, transport: null }), 'the old transport option is ignored');
  assert.throws(() => createMemberBridge({ ...base, launchSecret: new Uint8Array(31) }));
  assert.throws(() => createMemberBridge({ ...base, secretKey: new Uint8Array(33) }));
  assert.throws(() => createMemberBridge({ ...base, hostPublicKey: new Uint8Array(2) }));
  assert.throws(() => createMemberBridge({ ...base, addresses: 'x' }));
  assert.throws(() => createMemberBridge({ ...base, addresses: [1] }));
  assert.throws(() => createMemberBridge({ ...base, limits: { maxStreams: 0 } }), /limits\.maxStreams/);
  assert.equal(spawnChild.spawns.length, 0, 'construction spawns nothing');
});

test('redaction: nothing the member bridge logs contains a key, a secret or an address', async (t) => {
  const env = await setup(t);
  await env.bridge.start();
  const client = dialLocal(env.bridge.port());
  client.socket.write(encodeMemberPreamble(launchSecret));
  client.socket.write('PRIVATE-TRAFFIC');
  await waitFor(() => client.text().includes('PRIVATE-TRAFFIC'));
  const port = env.bridge.port();
  await env.bridge.stop();
  const text = JSON.stringify(env.logs);
  assert.ok(env.logs.length > 0);
  const forbidden = [
    hex(launchSecret), hex(memberSecret), hex(hostSecret), hex(env.fake.publicKeyOf(hostSecret)),
    hex(env.fake.publicKeyOf(memberSecret)), b64(launchSecret), b64(memberSecret), b64(env.fake.publicKeyOf(hostSecret)),
    '192.0.2.7', '2001:db8', 'PRIVATE-TRAFFIC', String(port),
  ];
  for (const needle of forbidden) assert.equal(text.includes(needle), false, `log leaked ${needle.slice(0, 8)}`);
  for (const { fields } of env.logs) {
    for (const value of Object.values(fields)) assert.match(String(value), /^[a-z_0-9]{1,32}$/);
  }
});

// The owner's relay (TEAM_INTERNET_SPEC slice 5-4).
const RELAY = Object.freeze({ url: 'https://relay.example.com', token: 'tok-SECRET-relay' });

test('a relay goes on the member start line only, and a bad one is a TypeError naming the field', async (t) => {
  const env = await setup(t, { relay: RELAY });
  await env.bridge.start();
  assert.deepEqual(env.spawner.last().received[0].relay, { url: RELAY.url, token: RELAY.token });
  const absent = await setup(t);
  await absent.bridge.start();
  assert.equal('relay' in absent.spawner.last().received[0], false);
  await env.bridge.stop();
  const text = JSON.stringify([env.logs, env.states, env.spawner.spawns, env.spawner.last().received.slice(1)]);
  for (const needle of [RELAY.token, 'relay.example.com']) assert.equal(text.includes(needle), false, needle);
  const base = {
    secretKey: memberSecret, hostPublicKey: new Uint8Array(32).fill(2), addresses: ADDRESSES, launchSecret,
    spawnChild: () => { throw new Error('never spawned'); },
  };
  for (const [relay, pattern] of [
    [{ url: 'https://SECRET.example.com/', token: null }, /relay\.url/],
    [{ url: 'https://relay.example.com', token: 'SECRET x' }, /relay\.token/],
    [{ url: 'https://relay.example.com' }, /relay must be/],
    ['SECRET', /relay must be/],
  ]) {
    assert.throws(() => createMemberBridge({ ...base, relay }), (error) => error instanceof TypeError
      && pattern.test(error.message) && !error.message.includes('SECRET'));
  }
});

test('the path word: kept while online, only a known word on a later online line changes it', async (t) => {
  const env = await setup(t, { relay: RELAY, spawnerOptions: { silent: true } });
  const starting = env.bridge.start();
  const child = env.spawner.last();
  await waitFor(() => child.received.length === 1);
  assert.equal(env.bridge.path(), null);
  child.write({ t: 'state', state: 'online', port: 4567, path: 'relay' });
  assert.deepEqual(await starting, { state: 'online', reason: null });
  assert.equal(env.bridge.path(), 'relay');
  child.write({ t: 'state', state: 'online', port: 4567, path: 'direct' });
  await waitFor(() => env.bridge.path() === 'direct');
  child.write({ t: 'state', state: 'online', port: 4567, path: 'relay' });
  await waitFor(() => env.bridge.path() === 'relay');
  // An unknown word and a line without one change nothing.
  child.write({ t: 'state', state: 'online', port: 4567, path: 'carrier-pigeon' });
  child.write({ t: 'state', state: 'online', port: 4567 });
  child.write({ t: 'log', event: 'team.bridge.started', fields: {} });
  await waitFor(() => env.logs.some((entry) => entry.event === 'team.bridge.started'));
  assert.equal(env.bridge.path(), 'relay');
  assert.deepEqual(env.states.map((s) => s.state), ['connecting', 'online'], 'a path change is not a state change');
  child.write({ t: 'state', state: 'offline', reason: 'closed' });
  await waitFor(() => env.bridge.state().state === 'offline');
  assert.equal(env.bridge.path(), null, 'no path while offline');
});

test('the two relay reasons reach the caller as they are', async (t) => {
  for (const reason of ['relay_unreachable', 'relay_denied']) {
    const env = await setup(t, { relay: RELAY, spawnerOptions: { silent: true } });
    const starting = env.bridge.start();
    await waitFor(() => env.spawner.last().received.length === 1);
    env.spawner.last().write({ t: 'state', state: 'offline', reason });
    assert.deepEqual(await starting, { state: 'offline', reason });
  }
});

// Review round two, R11-F01: the bridge's own cooldown and a host that never answered are not the host refusing.
test('the cooldown and admit-timeout reasons reach the caller as they are, apart from host_refused', async (t) => {
  for (const reason of ['host_cooldown', 'host_admit_timeout']) {
    const env = await setup(t, { spawnerOptions: { silent: true } });
    const starting = env.bridge.start();
    await waitFor(() => env.spawner.last().received.length === 1);
    env.spawner.last().write({ t: 'state', state: 'offline', reason });
    assert.deepEqual(await starting, { state: 'offline', reason });
  }
});

// Slice 6-6. Fault: the bulk port taken from a line that names none, or kept after the bridge went offline.
test('6-6: bulkPort() is the child\'s second port while online; absent is none; a wrong one ends the child', async (t) => {
  const env = await setup(t);
  assert.equal(env.bridge.bulkPort(), null);
  await env.bridge.start();
  const bulkPort = env.bridge.bulkPort();
  assert.ok(Number.isInteger(bulkPort) && bulkPort > 0 && bulkPort !== env.bridge.port());
  // A socket on the bulk port passes the same preamble gate and reaches the host behind one class byte.
  const client = dialLocal(bulkPort);
  client.socket.write(encodeMemberPreamble(launchSecret));
  client.socket.write('x');
  await waitFor(() => env.host.received.length > 0);
  assert.deepEqual([...Buffer.concat(env.host.received)], [0x01, 'x'.charCodeAt(0)]);
  assert.deepEqual(env.spawner.bulk, { sockets: 1, streams: 0 });
  await env.bridge.stop();
  assert.equal(env.bridge.bulkPort(), null);
  await assert.rejects(new Promise((resolve, reject) => {
    const probe = net.connect({ host: '127.0.0.1', port: bulkPort });
    probe.on('connect', () => { probe.destroy(); resolve(); });
    probe.on('error', reject);
  }), 'stop closes the bulk port too');

  // A binary from before bulk streams names no bulk port: online as before, and no bulk port.
  const old = await setup(t, { spawnerOptions: { noBulk: true } });
  assert.deepEqual(await old.bridge.start(), { state: 'online', reason: null });
  assert.ok(old.bridge.port() > 0);
  assert.equal(old.bridge.bulkPort(), null);

  // A wrong `bulk_port` on the first `online` line ends the child before the bridge was ever online.
  for (const wrong of [0, 65536, 1.5, '4568', null]) {
    const bad = await setup(t, { spawnerOptions: { silent: true } });
    const starting = bad.bridge.start();
    const child = bad.spawner.last();
    await waitFor(() => child.received.length === 1);
    child.write({ t: 'state', state: 'online', port: 4567, bulk_port: wrong });
    assert.deepEqual(await starting, { state: 'offline', reason: 'closed' });
    assert.equal(child.exited, true);
    assert.equal(bad.bridge.port(), null);
    assert.equal(bad.bridge.bulkPort(), null);
  }

  // A `bulk_port` that is the ordinary port is no bulk port: online, and parts go the ordinary way.
  const same = await setup(t, { spawnerOptions: { silent: true } });
  const sameStart = same.bridge.start();
  await waitFor(() => same.spawner.last().received.length === 1);
  same.spawner.last().write({ t: 'state', state: 'online', port: 4567, bulk_port: 4567 });
  assert.deepEqual(await sameStart, { state: 'online', reason: null });
  assert.equal(same.bridge.port(), 4567);
  assert.equal(same.bridge.bulkPort(), null);

  // Each later `online` line is read again; a wrong `bulk_port` is a wrong line, like a wrong `port`.
  for (const wrong of [0, 65536, 1.5, '4568', null]) {
    const bad = await setup(t, { spawnerOptions: { silent: true } });
    const starting = bad.bridge.start();
    const child = bad.spawner.last();
    await waitFor(() => child.received.length === 1);
    child.write({ t: 'state', state: 'online', port: 4567, bulk_port: 4568 });
    assert.deepEqual(await starting, { state: 'online', reason: null });
    assert.equal(bad.bridge.bulkPort(), 4568);
    child.write({ t: 'state', state: 'online', port: 4567, bulk_port: wrong });
    await waitFor(() => bad.bridge.state().state === 'offline');
    assert.equal(child.exited, true);
    assert.deepEqual(bad.bridge.state(), { state: 'offline', reason: 'closed' });
    assert.equal(bad.bridge.bulkPort(), null);
    assert.equal(bad.bridge.port(), null);
  }
});
