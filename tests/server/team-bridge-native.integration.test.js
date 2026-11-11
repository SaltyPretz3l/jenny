'use strict';

// The real `jenny-team-bridge` binary as host and member on loopback, through the
// real supervisors. Skipped, with a reason, when the binary is not built (see
// helpers/team-bridge-binary.js for where it is looked up). Loopback and
// same-machine only; every test kills the children it started.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const dgram = require('node:dgram');
const net = require('node:net');
const test = require('node:test');

const { createHostBridge, DEFAULT_LIMITS } = require('../../server/team/transport/host-bridge');
const { attachControl, spawnBridgeChild } = require('../../server/team/transport/control-channel');
const { deriveTeamId, keyPairFromSeed } = require('../../server/team/ids');
const {
  HOST_PREAMBLE_BYTES,
  decodeHostPreamble,
  encodeHostPreamble,
  encodeMemberPreamble,
} = require('../../server/team/transport/preamble');
const { createMemberBridge } = require('../../services/team/transport/member-bridge');
const { hex, waitFor } = require('./helpers/fake-team-transport');
const { createTeamHostFixture } = require('./helpers/team-host-fixture');
const { findTeamBridgeBinary, forceLoopbackOnly } = require('./helpers/team-bridge-binary');

const ALPN = 'jenny-team/1';
const TEAM_HOST = 'jenny-team.invalid';

// A file at the expected path is not enough: an old or half-built binary that does
// not answer `--version` with the protocol line is treated as not built.
function builtBinary() {
  const found = findTeamBridgeBinary();
  if (!found) return { binaryPath: null, skip: 'jenny-team-bridge is not built (looked in build/sidecar and native/jenny-team-bridge/target)' };
  const probe = spawnSync(found, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (probe.status === 0 && /protocol 1/.test(probe.stdout || '')) return { binaryPath: found, skip: false };
  return { binaryPath: null, skip: 'jenny-team-bridge at the expected path does not report "protocol 1" for --version (stale or unfinished build)' };
}

const { binaryPath, skip } = builtBinary();
const OPTIONS = { skip, timeout: 60_000 };

const seedOf = (byte) => Uint8Array.from({ length: 32 }, (_, i) => (byte * 7 + i) & 0xff);
const publicKeyOf = (seed) => new Uint8Array(Buffer.from(keyPairFromSeed(seed).publicKey, 'base64url'));
const alive = (child) => child.exitCode === null && child.signalCode === null;

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', reject);
    socket.bind(0, '0.0.0.0', () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

function collect(stream, count) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= count) resolve(Buffer.concat(chunks));
    });
    stream.once('error', reject);
    stream.once('close', () => reject(new Error('closed early')));
  });
}

// Spawns real children and kills whatever is still running when the test ends.
function harness(t) {
  const children = [];
  const cleanups = [];
  const spawnChild = (mode) => {
    const child = forceLoopbackOnly(spawnBridgeChild(mode, { binaryPath }));
    children.push(child);
    return child;
  };
  t.after(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => {});
    for (const child of children) if (alive(child)) child.kill();
  });
  return { children, spawnChild, onCleanup: (fn) => cleanups.push(fn) };
}

// A loopback server in place of the team listener: records the 72-byte preamble of
// every connection and then echoes, or hands the payload to `onPayload`.
async function createLoopbackServer(t, { onPayload } = {}) {
  const state = { connections: 0, preambles: [], records: [] };
  const server = net.createServer((socket) => {
    state.connections += 1;
    const record = { socket, preamble: null, payload: Buffer.alloc(0) };
    state.records.push(record);
    socket.on('error', () => {});
    let head = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      if (record.preamble) {
        record.payload = Buffer.concat([record.payload, chunk]);
        if (onPayload) onPayload(record, chunk);
        else socket.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      if (head.length < HOST_PREAMBLE_BYTES) return;
      record.preamble = head.subarray(0, HOST_PREAMBLE_BYTES);
      state.preambles.push(record.preamble);
      const rest = head.subarray(HOST_PREAMBLE_BYTES);
      if (rest.length) {
        record.payload = Buffer.concat([record.payload, rest]);
        if (onPayload) onPayload(record, rest);
        else socket.write(rest);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = server.address().port;
  t.after(async () => {
    for (const { socket } of state.records) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return state;
}

async function startHost(t, h, { server, directPort, allowed = [], seed = seedOf(10), bootSecret = seedOf(13) }) {
  const allow = new Set(allowed.map((key) => hex(key)));
  const downs = [];
  const logs = [];
  const bridge = createHostBridge({
    spawnChild: h.spawnChild,
    secretKey: seed,
    alpn: ALPN,
    directPort,
    loopbackPort: server.port,
    bootSecret,
    admit: (key) => (allow.has(hex(key)) ? 'device' : null),
    log: (event, fields) => logs.push({ event, fields }),
    onDown: (reason) => downs.push(reason),
  });
  await bridge.start();
  h.onCleanup(() => bridge.stop());
  return { bridge, downs, logs, hostKey: publicKeyOf(seed), bootSecret };
}

async function startMember(h, { host, seed, launchSecret = seedOf(14), addresses }) {
  const bridge = createMemberBridge({
    spawnChild: h.spawnChild,
    secretKey: seed,
    hostPublicKey: host.hostKey,
    addresses: addresses ?? host.bridge.addresses(),
    alpn: ALPN,
    launchSecret,
  });
  h.onCleanup(() => bridge.stop());
  const result = await bridge.start();
  return { bridge, result, launchSecret };
}

test('the host binary derives its identity from the caller-chosen secret key', OPTIONS, async (t) => {
  const h = harness(t);
  const seed = seedOf(1);
  const child = h.spawnChild('host');
  const messages = [];
  const exits = [];
  const control = attachControl(child, { onMessage: (m) => messages.push(m), onExit: (info) => exits.push(info) });
  control.send({
    t: 'start',
    mode: 'host',
    secret_key: Buffer.from(seed).toString('base64url'),
    boot_secret: Buffer.from(seedOf(2)).toString('base64url'),
    alpn: ALPN,
    loopback_port: 9,
    direct_port: null,
    limits: {
      max_connections: DEFAULT_LIMITS.maxConnections,
      max_streams_per_connection: DEFAULT_LIMITS.maxStreamsPerConnection,
      max_streams_total: DEFAULT_LIMITS.maxStreamsTotal,
      max_handshakes: DEFAULT_LIMITS.maxHandshakes,
      admit_timeout_ms: DEFAULT_LIMITS.admitTimeoutMs,
      drop_grace_ms: DEFAULT_LIMITS.dropGraceMs,
    },
  });
  await waitFor(() => messages.some((m) => m.t === 'ready'), { timeoutMs: 15_000 });
  const ready = messages.find((m) => m.t === 'ready');
  assert.equal(ready.public_key, keyPairFromSeed(seed).publicKey);
  assert.ok(Array.isArray(ready.addresses) && ready.addresses.length > 0);
  control.send({ t: 'stop' });
  await waitFor(() => exits.length === 1, { timeoutMs: 15_000 });
  assert.equal(exits[0].code, 0);
  assert.equal(exits[0].failed, false);
});

for (const [name, chooseDirectPort] of [['a chosen direct port', true], ['the default ports', false]]) {
  test(`a member dials the host on ${name} and a 200 KiB echo carries the exact host preamble`, OPTIONS, async (t) => {
    const h = harness(t);
    const server = await createLoopbackServer(t);
    const memberSeed = seedOf(11);
    const directPort = chooseDirectPort ? await freeUdpPort() : undefined;
    const host = await startHost(t, h, { server, directPort, allowed: [publicKeyOf(memberSeed)] });
    if (directPort) {
      assert.ok(host.bridge.addresses().some((address) => address.endsWith(`:${directPort}`)), 'an address on the chosen port');
    }
    const member = await startMember(h, { host, seed: memberSeed });
    assert.deepEqual(member.result, { state: 'online', reason: null });
    assert.deepEqual(member.bridge.lastWorkingAddresses(), host.bridge.addresses());

    const client = net.connect({ host: '127.0.0.1', port: member.bridge.port() });
    client.on('error', () => {});
    t.after(() => client.destroy());
    const payload = Buffer.alloc(200 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 31 + 7) & 0xff;
    const echoed = collect(client, payload.length);
    client.write(Buffer.concat([encodeMemberPreamble(member.launchSecret), payload]));
    assert.deepEqual(await echoed, payload);

    assert.equal(server.preambles.length, 1);
    assert.deepEqual(Buffer.from(server.preambles[0]), encodeHostPreamble(host.bootSecret, publicKeyOf(memberSeed)));
    assert.deepEqual(new Uint8Array(decodeHostPreamble(server.preambles[0]).remoteKey), publicKeyOf(memberSeed));
    await waitFor(() => host.bridge.stats().connections === 1);
  });
}

test('a stranger is told host_refused and the loopback server sees no connection', OPTIONS, async (t) => {
  const h = harness(t);
  const server = await createLoopbackServer(t);
  const host = await startHost(t, h, { server, allowed: [publicKeyOf(seedOf(11))] });
  const stranger = await startMember(h, { host, seed: seedOf(12) });
  await waitFor(() => stranger.bridge.state().state === 'offline', { timeoutMs: 15_000 });
  assert.deepEqual(stranger.bridge.state(), { state: 'offline', reason: 'host_refused' });
  await waitFor(() => host.bridge.stats().refusedConnections >= 1);
  assert.equal(server.connections, 0);
  assert.deepEqual(host.downs, []);
});

test('drop ends the member with host_refused', OPTIONS, async (t) => {
  const h = harness(t);
  const server = await createLoopbackServer(t);
  const memberSeed = seedOf(11);
  const host = await startHost(t, h, { server, allowed: [publicKeyOf(memberSeed)] });
  const member = await startMember(h, { host, seed: memberSeed });
  assert.equal(member.result.state, 'online');
  await waitFor(() => host.bridge.stats().connections === 1);
  assert.equal(host.bridge.drop(publicKeyOf(memberSeed)), 1);
  await waitFor(() => member.bridge.state().state === 'offline', { timeoutMs: 15_000 });
  assert.deepEqual(member.bridge.state(), { state: 'offline', reason: 'host_refused' });
  await waitFor(() => host.bridge.stats().connections === 0);
});

test('drop with a finished answer: the member still receives all 4 KiB', OPTIONS, async (t) => {
  const h = harness(t);
  let seen;
  const requestSeen = new Promise((resolve) => { seen = resolve; });
  const server = await createLoopbackServer(t, { onPayload: (record) => seen(record) });
  const memberSeed = seedOf(11);
  const host = await startHost(t, h, { server, allowed: [publicKeyOf(memberSeed)] });
  const member = await startMember(h, { host, seed: memberSeed });
  assert.equal(member.result.state, 'online');

  const client = net.connect({ host: '127.0.0.1', port: member.bridge.port() });
  client.on('error', () => {});
  t.after(() => client.destroy());
  const answer = Buffer.alloc(4096, 0x61);
  const received = collect(client, answer.length);
  client.write(Buffer.concat([encodeMemberPreamble(member.launchSecret), Buffer.from('GET / HTTP/1.1\r\n\r\n')]));
  const record = await requestSeen;
  assert.equal(host.bridge.drop(publicKeyOf(memberSeed)), 1);
  // The host's HTTP layer answers after the revoke; the bridge lets the answer out first.
  record.socket.write(answer);
  record.socket.end();
  assert.deepEqual(await received, answer);
  await waitFor(() => member.bridge.state().state === 'offline', { timeoutMs: 15_000 });
  assert.equal(member.bridge.state().reason, 'host_refused');
});

test('a killed host child calls onDown and empties the addresses', OPTIONS, async (t) => {
  const h = harness(t);
  const server = await createLoopbackServer(t);
  const host = await startHost(t, h, { server });
  assert.ok(host.bridge.addresses().length > 0);
  const child = h.children[0];
  child.kill();
  await waitFor(() => host.downs.length === 1, { timeoutMs: 15_000 });
  assert.deepEqual(host.downs, ['team_transport_down']);
  assert.deepEqual(host.bridge.addresses(), []);
  await host.bridge.stop();
  assert.equal(host.downs.length, 1);
});

test('stop leaves no bridge process behind', OPTIONS, async (t) => {
  const h = harness(t);
  const server = await createLoopbackServer(t);
  const memberSeed = seedOf(11);
  const host = await startHost(t, h, { server, allowed: [publicKeyOf(memberSeed)] });
  const member = await startMember(h, { host, seed: memberSeed });
  assert.equal(member.result.state, 'online');
  await member.bridge.stop();
  await host.bridge.stop();
  assert.equal(h.children.length, 2);
  for (const child of h.children) {
    assert.equal(alive(child), false, 'the child has exited');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  }
  assert.deepEqual(host.downs, []);
});

test('end to end: a real member reaches the team host through the real binaries', OPTIONS, async (t) => {
  const h = harness(t);
  const fx = createTeamHostFixture(t);
  const memberSeed = seedOf(21);
  await fx.seedMembers(keyPairFromSeed(memberSeed).publicKey);
  const parent = fx.newParent();
  // `createListener: undefined` keeps the default, which is the real team listener.
  await fx.start(parent, { createListener: undefined, spawnBridge: h.spawnChild });
  const ready = parent.sent.find((message) => message.type === 'ready');
  assert.ok(ready && ready.addresses.length > 0);
  const member = createMemberBridge({
    spawnChild: h.spawnChild,
    secretKey: memberSeed,
    hostPublicKey: new Uint8Array(Buffer.from(fx.hostPublicKey, 'base64url')),
    addresses: ready.addresses,
    alpn: ALPN,
    launchSecret: seedOf(22),
  });
  h.onCleanup(() => member.stop());
  assert.deepEqual(await member.start(), { state: 'online', reason: null });

  const client = net.connect({ host: '127.0.0.1', port: member.port() });
  client.on('error', () => {});
  t.after(() => client.destroy());
  const chunks = [];
  client.on('data', (chunk) => chunks.push(chunk));
  const body = JSON.stringify({ protocol_version: 1, app_version: '1.6.1' });
  client.write(Buffer.concat([
    encodeMemberPreamble(seedOf(22)),
    Buffer.from(`POST /api/v1/team/hello HTTP/1.1\r\nHost: ${TEAM_HOST}\r\nContent-Type: application/json\r\n`
      + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`),
  ]));
  await waitFor(() => Buffer.concat(chunks).toString().includes('"team_id"'), { timeoutMs: 15_000 });
  const answer = Buffer.concat(chunks).toString();
  assert.equal(answer.startsWith('HTTP/1.1 200'), true);
  assert.equal(answer.includes(deriveTeamId(fx.hostPublicKey)), true);
});
