'use strict';

// The host bridge supervisor against the fake bridge child: what the application
// sees (admit, drop, caps, stats, the 72-byte preamble on every loopback
// connection) with the network part on the in-memory fake transport. The
// supervisor lifecycle (start, stop, down, secrets, log filtering) is in
// team-bridge-supervisor.test.js; the real binary is in
// team-bridge-native.integration.test.js.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createHostBridge } = require('../../server/team/transport/host-bridge');
const {
  HOST_PREAMBLE_BYTES,
  decodeHostPreamble,
  encodeHostPreamble,
} = require('../../server/team/transport/preamble');
const { createFakeBridgeSpawner } = require('./helpers/fake-bridge');
const {
  createFakeTransport,
  createLoopbackProbe,
  hex,
  waitFor,
} = require('./helpers/fake-team-transport');

const ALPN = 'jenny-team/1';
const bootSecret = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const hostSecret = new Uint8Array(32).fill(9);
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');

async function setup(t, { admit, limits, probeOptions, spawnerOptions } = {}) {
  const fake = createFakeTransport();
  const spawner = createFakeBridgeSpawner(fake, spawnerOptions);
  const probe = await createLoopbackProbe(probeOptions);
  const logs = [];
  const bridge = createHostBridge({
    spawnChild: spawner,
    secretKey: hostSecret,
    alpn: ALPN,
    directPort: undefined,
    loopbackPort: probe.port,
    bootSecret,
    admit: admit || (() => 'device'),
    limits,
    log: (event, fields) => logs.push({ event, fields }),
  });
  await bridge.start();
  const hostPublicKey = fake.publicKeyOf(hostSecret);

  async function dial(seed) {
    const secretKey = new Uint8Array(32).fill(seed);
    const conn = await fake.transport.connect({ secretKey, hostPublicKey, addresses: [], alpn: ALPN });
    const closed = new Promise((resolve) => conn.onClose(resolve));
    return { conn, closed, key: fake.publicKeyOf(secretKey) };
  }

  const env = { fake, spawner, probe, logs, bridge, dial, hostPublicKey };
  t.after(async () => {
    await bridge.stop();
    await probe.close();
  });
  return env;
}

test('preamble encoder and decoder share one 72-byte layout', () => {
  const key = new Uint8Array(32).fill(5);
  const bytes = encodeHostPreamble(bootSecret, key);
  assert.equal(bytes.length, HOST_PREAMBLE_BYTES);
  assert.equal(HOST_PREAMBLE_BYTES, 72);
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'JNYT');
  assert.deepEqual([...bytes.subarray(4, 8)], [1, 0, 0, 0]);
  assert.deepEqual(new Uint8Array(bytes.subarray(8, 40)), bootSecret);
  assert.deepEqual(new Uint8Array(bytes.subarray(40, 72)), key);
  const decoded = decodeHostPreamble(bytes);
  assert.deepEqual(new Uint8Array(decoded.secret), bootSecret);
  assert.deepEqual(new Uint8Array(decoded.remoteKey), key);
  assert.equal(decodeHostPreamble(bytes.subarray(0, 71)), null);
  assert.throws(() => encodeHostPreamble(bootSecret.subarray(1), key));
  assert.throws(() => encodeHostPreamble(bootSecret, key.subarray(1)));
});

test('a stranger is closed before any stream and no loopback socket opens', async (t) => {
  const asked = [];
  const env = await setup(t, {
    admit: (key) => {
      asked.push(hex(key));
      return null;
    },
  });
  const { conn, closed, key } = await env.dial(3);
  const info = await closed;
  assert.equal(info.refused, true);
  await assert.rejects(conn.openStream());
  assert.deepEqual(asked, [hex(key)]);
  assert.equal(env.probe.records.length, 0);
  assert.equal(env.fake.openStreamCount(), 0);
  await waitFor(() => env.bridge.stats().connections === 0);
  await waitFor(() => env.bridge.stats().refusedConnections === 1);
});

test('an admit callback that throws or answers something odd refuses the connection', async (t) => {
  const answers = [
    () => { throw new Error('boom'); },
    () => 'owner',
    () => Promise.reject(new Error('x')),
    () => undefined,
  ];
  for (const answer of answers) {
    const env = await setup(t, { admit: answer });
    const { closed } = await env.dial(4);
    assert.equal((await closed).refused, true);
    assert.equal(env.probe.records.length, 0);
  }
});

test('an admit callback that never answers is refused by the supervisor itself', async (t) => {
  const env = await setup(t, {
    admit: () => new Promise(() => {}),
    limits: { admitTimeoutMs: 60 },
    spawnerOptions: { childAdmitTimeout: false },
  });
  const { closed } = await env.dial(5);
  assert.equal((await closed).refused, true);
  const child = env.spawner.last();
  const answers = child.received.filter((line) => line.t === 'admit_answer');
  assert.deepEqual(answers.map((line) => line.kind), [null]);
  assert.equal(env.probe.records.length, 0);
});

test('admit is asked with the authenticated 32-byte key', async (t) => {
  const seen = [];
  const env = await setup(t, { admit: (key) => { seen.push(key); return 'device'; } });
  const { key } = await env.dial(6);
  await waitFor(() => seen.length === 1);
  assert.ok(seen[0] instanceof Uint8Array);
  assert.equal(hex(seen[0]), hex(key));
});

test('device and invite keys are carried: exact preamble with the remote key, then payload both ways', async (t) => {
  const kinds = new Map();
  const env = await setup(t, { admit: (key) => kinds.get(hex(key)) || null });
  for (const [seed, kind] of [[11, 'device'], [12, 'invite']]) {
    const secretKey = new Uint8Array(32).fill(seed);
    kinds.set(hex(env.fake.publicKeyOf(secretKey)), kind);
  }
  const seen = [];
  for (const seed of [11, 12]) {
    const { conn, key } = await env.dial(seed);
    const stream = await conn.openStream();
    stream.write('GET / hello');
    await waitFor(() => env.probe.records.length === seen.length + 1);
    const record = env.probe.records[seen.length];
    await waitFor(() => record.total >= HOST_PREAMBLE_BYTES + 'GET / hello'.length);
    const bytes = env.probe.bytes(record);
    assert.equal(bytes.length, HOST_PREAMBLE_BYTES + 'GET / hello'.length);
    assert.deepEqual(bytes.subarray(0, HOST_PREAMBLE_BYTES), encodeHostPreamble(bootSecret, key));
    assert.equal(bytes.subarray(HOST_PREAMBLE_BYTES).toString(), 'GET / hello');
    const reply = new Promise((resolve) => stream.once('data', resolve));
    record.socket.write('HTTP/1.1 200');
    assert.equal((await reply).toString(), 'HTTP/1.1 200');
    seen.push(seed);
  }
  await waitFor(() => env.bridge.stats().connections === 2);
});

test('closing the member stream closes the loopback socket and closing the socket closes the stream', async (t) => {
  const env = await setup(t);
  const { conn } = await env.dial(21);
  const first = await conn.openStream();
  first.write('a');
  await waitFor(() => env.probe.records.length === 1 && env.probe.records[0].total > 72);
  first.destroy();
  await waitFor(() => env.probe.records[0].closed);
  await waitFor(() => env.bridge.stats().streams === 0);

  const second = await conn.openStream();
  second.write('b');
  await waitFor(() => env.probe.records.length === 2 && env.probe.records[1].total > 72);
  const gone = new Promise((resolve) => second.once('close', resolve));
  env.probe.records[1].socket.destroy();
  await gone;
  await waitFor(() => env.bridge.stats().streams === 0);
});

test('drop closes that key streams and sockets, returns the count and leaves other keys alone', async (t) => {
  const env = await setup(t);
  const a = await env.dial(31);
  const b = await env.dial(32);
  const a2 = await env.dial(31);
  const aStreams = [await a.conn.openStream(), await a2.conn.openStream()];
  const bStream = await b.conn.openStream();
  for (const s of [...aStreams, bStream]) s.write('x');
  await waitFor(() => env.probe.records.length === 3 && env.probe.records.every((r) => r.total > 72));
  await waitFor(() => env.bridge.stats().connections === 3);
  const owner = new Map();
  for (const record of env.probe.records) {
    const decoded = decodeHostPreamble(env.probe.bytes(record).subarray(0, 72));
    owner.set(record, hex(decoded.remoteKey));
  }
  assert.equal(env.bridge.drop(a.key), 2, 'two connections of that key');
  assert.equal((await a.closed).refused, true);
  assert.equal((await a2.closed).refused, true);
  await waitFor(() => env.probe.records.filter((r) => owner.get(r) === hex(a.key)).every((r) => r.closed));
  const bRecord = env.probe.records.find((r) => owner.get(r) === hex(b.key));
  assert.equal(bRecord.closed, false);
  assert.equal(bStream.destroyed, false);
  await waitFor(() => env.bridge.stats().connections === 1 && env.bridge.stats().streams === 1);
  const echoed = new Promise((resolve) => bStream.once('data', resolve));
  bRecord.socket.write('still here');
  assert.equal((await echoed).toString(), 'still here');
  const dropLogs = env.logs.filter((entry) => entry.event === 'team.bridge.dropped');
  assert.deepEqual(dropLogs.map((entry) => entry.fields), [{ connections: 2 }], 'logged once, by the child');
});

test('drop of a key with no connection returns 0 and sends nothing to the child', async (t) => {
  const env = await setup(t);
  const stranger = new Uint8Array(32).fill(77);
  assert.equal(env.bridge.drop(stranger), 0);
  assert.equal(env.spawner.last().received.some((line) => line.t === 'drop'), false);
  assert.throws(() => env.bridge.drop(new Uint8Array(31)));
});

test('a connection that is dropped while admit is pending never gets a stream', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = await setup(t, { admit: async () => { await gate; return 'device'; } });
  const a = await env.dial(41);
  await waitFor(() => env.bridge.stats().connections === 1);
  assert.equal(env.bridge.drop(a.key), 1);
  release();
  assert.equal((await a.closed).refused, true);
  assert.equal(env.probe.records.length, 0);
  await waitFor(() => env.bridge.stats().connections === 0);
});

test('per-connection and total stream caps refuse without a loopback connection', async (t) => {
  const env = await setup(t, { limits: { maxStreamsPerConnection: 2, maxStreamsTotal: 3 } });
  const a = await env.dial(51);
  const b = await env.dial(52);
  const kept = [await a.conn.openStream(), await a.conn.openStream()];
  kept.forEach((s) => s.write('k'));
  await waitFor(() => env.probe.records.length === 2);
  const over = await a.conn.openStream();
  over.write('over');
  await waitFor(() => over.destroyed);
  assert.equal(env.probe.records.length, 2, 'the per-connection cap opens no loopback socket');

  const third = await b.conn.openStream();
  third.write('t');
  await waitFor(() => env.probe.records.length === 3);
  const fourth = await b.conn.openStream();
  fourth.write('f');
  await waitFor(() => fourth.destroyed);
  assert.equal(env.probe.records.length, 3, 'the total cap opens no loopback socket');
  await waitFor(() => env.bridge.stats().streams === 3 && env.bridge.stats().refusedStreams >= 2);

  kept[0].destroy();
  await waitFor(() => env.bridge.stats().streams === 2);
  const again = await a.conn.openStream();
  again.write('again');
  await waitFor(() => env.probe.records.length === 4);
});

test('the connection cap turns a dial away before admit is asked', async (t) => {
  const asked = [];
  const env = await setup(t, {
    limits: { maxConnections: 2 },
    admit: (key) => {
      asked.push(hex(key));
      return 'device';
    },
  });
  const a = await env.dial(61);
  await env.dial(62);
  await waitFor(() => asked.length === 2);
  const c = await env.dial(63);
  await c.closed;
  assert.equal(asked.length, 2, 'the directory is not asked about a connection over the cap');
  await waitFor(() => env.bridge.stats().connections === 2 && env.bridge.stats().refusedConnections === 1);
  const refusal = env.logs.find((entry) => entry.event === 'team.bridge.connection_refused');
  assert.equal(refusal.fields.reason, 'connection_cap');

  await a.conn.close();
  await waitFor(() => env.bridge.stats().connections === 1);
  const again = await env.dial(64);
  await waitFor(() => asked.length === 3);
  const stream = await again.conn.openStream();
  stream.write('ok');
  await waitFor(() => env.probe.records.length === 1);
});

test('default caps are 16 streams per connection', async (t) => {
  const env = await setup(t);
  const { conn } = await env.dial(61);
  const streams = [];
  for (let i = 0; i < 18; i += 1) {
    const s = await conn.openStream();
    s.write('x');
    streams.push(s);
  }
  await waitFor(() => streams.filter((s) => s.destroyed).length === 2);
  await waitFor(() => env.probe.records.length === 16);
  assert.equal(env.probe.records.length, 16);
});

test('the default total cap is 128 streams', async (t) => {
  const env = await setup(t);
  const conns = [];
  for (let seed = 100; seed < 109; seed += 1) conns.push((await env.dial(seed)).conn);
  const streams = [];
  for (const conn of conns) {
    for (let i = 0; i < 15; i += 1) {
      const s = await conn.openStream();
      s.write('x');
      streams.push(s);
    }
  }
  // 9 connections x 15 streams = 135 attempts against a cap of 128.
  await waitFor(() => streams.filter((s) => s.destroyed).length === 7);
  await waitFor(() => env.probe.records.length === 128);
  await waitFor(() => env.bridge.stats().streams === 128);
});

test('backpressure: a stalled loopback reader holds back the sender', async (t) => {
  const env = await setup(t, { probeOptions: { pauseReads: true } });
  const { conn } = await env.dial(71);
  const stream = await conn.openStream();
  const chunk = Buffer.alloc(64 * 1024, 7);
  let sent = 0;
  const ceiling = 256 * 1024 * 1024;
  while (sent < ceiling) {
    if (!stream.write(chunk)) {
      const drained = await Promise.race([
        new Promise((resolve) => stream.once('drain', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 400)),
      ]);
      if (!drained) break;
    }
    sent += chunk.length;
  }
  assert.ok(sent < ceiling, 'the sender must be blocked long before the ceiling');
  assert.ok(env.fake.bufferedBytes() <= 4 * 1024 * 1024, `fake buffered ${env.fake.bufferedBytes()} bytes`);
  const record = env.probe.records[0];
  env.probe.setPaused(false);
  await waitFor(() => record.total >= HOST_PREAMBLE_BYTES + sent - chunk.length, { timeoutMs: 8000 });
});

test('stop closes every connection, stream and socket, and refuses new dials', async (t) => {
  const env = await setup(t);
  const a = await env.dial(81);
  const streams = [await a.conn.openStream(), await a.conn.openStream()];
  streams.forEach((s) => s.write('x'));
  await waitFor(() => env.probe.records.length === 2);
  await env.bridge.stop();
  // The probe sees the close a moment after the bridge's own sockets are gone.
  await waitFor(() => env.probe.records.every((r) => r.closed));
  assert.ok(streams.every((s) => s.destroyed));
  assert.deepEqual(
    { connections: env.bridge.stats().connections, streams: env.bridge.stats().streams },
    { connections: 0, streams: 0 },
  );
  await assert.rejects(env.dial(82));
  await env.bridge.stop();
  assert.equal(env.spawner.last().exited, true);
});

test('the bridge refuses malformed construction arguments', () => {
  const fake = createFakeTransport();
  const spawnChild = createFakeBridgeSpawner(fake);
  const base = {
    spawnChild,
    secretKey: hostSecret,
    alpn: ALPN,
    loopbackPort: 1234,
    bootSecret,
    admit: () => null,
  };
  assert.doesNotThrow(() => createHostBridge(base));
  assert.doesNotThrow(() => createHostBridge({ ...base, transport: {} }), 'the old transport option is ignored');
  assert.doesNotThrow(() => createHostBridge({ ...base, directPort: null }));
  assert.doesNotThrow(() => createHostBridge({ ...base, directPort: 7000 }));
  for (const directPort of [0, 70000, 1.5, '7000']) {
    assert.throws(() => createHostBridge({ ...base, directPort }), /directPort/);
  }
  assert.throws(() => createHostBridge({ ...base, secretKey: new Uint8Array(31) }), /secretKey/);
  assert.throws(() => createHostBridge({ ...base, bootSecret: new Uint8Array(31) }), /bootSecret/);
  assert.throws(() => createHostBridge({ ...base, loopbackPort: 0 }), /loopbackPort/);
  assert.throws(() => createHostBridge({ ...base, loopbackPort: 70000 }), /loopbackPort/);
  assert.throws(() => createHostBridge({ ...base, admit: null }), /admit/);
  assert.throws(() => createHostBridge({ ...base, limits: { maxConnections: 0 } }), /limits\.maxConnections/);
  assert.throws(() => createHostBridge({ ...base, limits: { dropGraceMs: 1.5 } }), /limits\.dropGraceMs/);
  assert.equal(spawnChild.spawns.length, 0, 'construction spawns nothing');
});

test('addresses() reports the listener addresses as strings and is empty before start', async (t) => {
  const fake = createFakeTransport();
  const idle = createHostBridge({
    spawnChild: createFakeBridgeSpawner(fake), secretKey: hostSecret, loopbackPort: 1234, bootSecret, admit: () => null,
  });
  assert.deepEqual(idle.addresses(), []);
  const env = await setup(t);
  const addresses = env.bridge.addresses();
  assert.deepEqual(addresses, ['192.0.2.7:4242', '[2001:db8::7]:4242']);
});

test('redaction: nothing logged contains a key, a secret, an address or traffic', async (t) => {
  const refused = new Set();
  const env = await setup(t, { admit: (key) => (refused.has(hex(key)) ? null : 'device') });
  const secret = new Uint8Array(32).fill(91);
  const key = env.fake.publicKeyOf(secret);
  const strangerSecret = new Uint8Array(32).fill(92);
  refused.add(hex(env.fake.publicKeyOf(strangerSecret)));
  const conn = await env.fake.transport.connect({
    secretKey: secret, hostPublicKey: env.hostPublicKey, addresses: [], alpn: ALPN,
  });
  const stream = await conn.openStream();
  stream.write('SUPER-SECRET-PAYLOAD');
  await waitFor(() => env.probe.records.length === 1);
  env.bridge.drop(key);
  await waitFor(() => env.bridge.stats().streams === 0);
  const bad = await env.fake.transport.connect({
    secretKey: strangerSecret, hostPublicKey: env.hostPublicKey, addresses: [], alpn: ALPN,
  });
  await new Promise((resolve) => bad.onClose(resolve));
  await env.bridge.stop();
  const text = JSON.stringify(env.logs);
  assert.ok(env.logs.length > 0, 'the bridge should log something');
  const forbidden = [
    hex(key), b64(key), Buffer.from(key).toString('base64'), hex(bootSecret), b64(bootSecret), hex(hostSecret),
    b64(hostSecret), hex(env.hostPublicKey), b64(env.hostPublicKey), '192.0.2.7', '2001:db8',
    'SUPER-SECRET-PAYLOAD', String(env.probe.port),
  ];
  for (const needle of forbidden) assert.equal(text.includes(needle), false, `log leaked ${needle.slice(0, 8)}`);
  for (const { fields } of env.logs) {
    for (const value of Object.values(fields || {})) {
      assert.ok(typeof value === 'number' || typeof value === 'boolean' || /^[a-z_]{1,32}$/.test(String(value)));
    }
  }
});
