'use strict';

// new-test-file: bulk streams (row 123 slice 6-6) are a new surface that crosses the member client, both bridge supervisors and the host; tests/team-http-client.test.js is near the line cap.
//
// A model part goes to the member bridge's bulk port only when the host's hello allowed it and the bridge has such
// a port; everything else, and everything against an older host or an older bridge binary, goes the ordinary way.
// The bridges are the fake children over the in-memory transport; the host's HTTP layer is a loopback server that
// records each request's first byte after the 72-byte host preamble.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const test = require('node:test');

const { createHostBridge } = require('../server/team/transport/host-bridge');
const { encodeMemberPreamble, HOST_PREAMBLE_BYTES, MEMBER_PREAMBLE_BYTES } = require('../server/team/transport/preamble');
const { openLink } = require('../services/team/bridge-link');
const { createTeamHttp } = require('../services/team/http-client');
const { createTeamSession } = require('../services/team/team-session');
const { createFakeBridgeSpawner } = require('./server/helpers/fake-bridge');
const { createFakeTransport, waitFor } = require('./server/helpers/fake-team-transport');
const { createTeamHostFixture } = require('./server/helpers/team-host-fixture');

const ALPN = 'jenny-team/1';
const PART = '/api/v1/team/models/transfers/mxfer_0123456789abcdefABCD_-/files/0/parts/3';
const hostSecret = new Uint8Array(32).fill(9);
const memberSecret = new Uint8Array(32).fill(4);
const launchSecret = new Uint8Array(crypto.randomBytes(32));

function answer(socket, body) {
  const text = JSON.stringify(body);
  socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\n`
    + `Connection: close\r\n\r\n${text}`);
}

// A loopback server that answers every whole request `{ ok: true }` after `skip` leading bytes (a preamble), and
// records each request's first byte and request line. `extra(line)` adds fields to an answer. `seen.connections`
// counts every connection, whether or not a request came on it.
async function httpStandIn(t, skip, extra = () => ({})) {
  const seen = [];
  seen.connections = 0;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    seen.connections += 1;
    const chunks = [];
    let answered = false;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const all = Buffer.concat(chunks);
      const text = all.subarray(skip).toString('latin1');
      const head = text.indexOf('\r\n\r\n');
      const length = Number(/\r\ncontent-length: (\d+)/iu.exec(text)?.[1] || 0);
      if (answered || head === -1 || text.length < head + 4 + length) return;
      answered = true;
      const line = text.slice(0, text.indexOf('\r\n'));
      seen.push({ first: all[skip], line });
      answer(socket, { ok: true, ...extra(line) });
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  return { port: server.address().port, seen };
}

// A host bridge and one member link over fake children. `host.saysBulk` is what the hello answer follows: the
// bridge's own word by default, as server/team/team-routes.js answers a device.
async function world(t, { hostOptions = {}, memberOptions = {} } = {}) {
  const fake = createFakeTransport();
  const hostSpawner = createFakeBridgeSpawner(fake, hostOptions);
  const memberSpawner = createFakeBridgeSpawner(fake, memberOptions);
  const host = { saysBulk: () => hostBridge.bulk() };
  const layer = await httpStandIn(t, HOST_PREAMBLE_BYTES,
    (line) => (line.startsWith('POST /api/v1/team/hello ') && host.saysBulk() ? { bulk_streams: 1 } : {}));
  const hostBridge = createHostBridge({ spawnChild: hostSpawner, secretKey: hostSecret, alpn: ALPN,
    loopbackPort: layer.port, bootSecret: new Uint8Array(32).fill(7), admit: () => 'device' });
  await hostBridge.start();
  const opened = await openLink({ secretKey: memberSecret, hostPublicKey: fake.publicKeyOf(hostSecret),
    addresses: ['192.0.2.7:4242'], spawnChild: memberSpawner, appVersion: '1.7.0', requestTimeoutMs: 3000 });
  assert.equal(opened.ok, true);
  t.after(async () => { await opened.link.close(); await hostBridge.stop(); });
  return { fake, host, hostBridge, hostSpawner, memberSpawner, link: opened.link, seen: layer.seen };
}

const lines = (seen) => seen.map((entry) => entry.line.split(' ').slice(0, 2).join(' '));
const firsts = (seen) => seen.map((entry) => String.fromCharCode(entry.first)).join('');

test('a model part rides a bulk stream once the host said so; nothing else does', async (t) => {
  const env = await world(t);
  assert.ok(env.link.bridge.bulkPort() > 0);
  // Before any hello the member knows nothing about the host: the ordinary port.
  assert.equal((await env.link.http.getPart(PART)).status, 200);
  assert.deepEqual(env.memberSpawner.bulk, { sockets: 0, streams: 0 });
  assert.deepEqual(await env.link.session.hello(), { ok: true, bulk_streams: 1 });
  assert.equal(env.link.session.bulk(), true);
  assert.equal((await env.link.http.getPart(PART)).status, 200);
  assert.equal(env.memberSpawner.bulk.sockets, 1, 'the part went through the bulk port');
  assert.equal(env.hostSpawner.bulk.streams, 1, 'the host bridge read its class byte');
  await env.link.session.status();
  await env.link.session.bootstrap();
  assert.equal(env.memberSpawner.bulk.sockets, 1, 'chat and commands stay ordinary');
  assert.equal(env.hostSpawner.bulk.streams, 1);
  // The HTTP layer never sees the class byte: every request starts with its method.
  assert.deepEqual(lines(env.seen), [`GET ${PART}`, 'POST /api/v1/team/hello', `GET ${PART}`, 'POST /api/v1/team/status',
    'GET /api/v1/team/bootstrap']);
  assert.equal(firsts(env.seen), 'GPGPG');
  // A later hello from a host that no longer says so (a reconnect to an older build): ordinary again.
  env.host.saysBulk = () => false;
  assert.deepEqual(await env.link.session.hello(), { ok: true });
  assert.equal((await env.link.http.getPart(PART)).status, 200);
  assert.equal(env.memberSpawner.bulk.sockets, 1);
  assert.equal(env.hostSpawner.bulk.streams, 1);
  // Nothing left behind once the requests are over.
  await waitFor(() => env.link.http.openSockets() === 0 && env.hostBridge.stats().streams === 0);
});

test('skew, new member and older host bridge: no stream starts with the class byte', async (t) => {
  const env = await world(t, { hostOptions: { noBulk: true } });
  assert.equal(env.hostBridge.bulk(), false);
  assert.ok(env.link.bridge.bulkPort() > 0, 'the member bridge has a bulk port all the same');
  assert.deepEqual(await env.link.session.hello(), { ok: true });
  assert.equal(env.link.session.bulk(), false);
  assert.equal((await env.link.http.getPart(PART)).status, 200);
  await env.link.session.status();
  assert.equal(env.memberSpawner.bulk.sockets, 0);
  assert.equal(firsts(env.seen), 'PGP', 'an older bridge passes every byte on: none of them is 0x01');
});

test('skew, older member bridge and new host: no bulk port, no error, requests intact', async (t) => {
  const env = await world(t, { memberOptions: { noBulk: true } });
  assert.equal(env.link.bridge.bulkPort(), null);
  assert.deepEqual(await env.link.session.hello(), { ok: true, bulk_streams: 1 });
  assert.equal(env.link.session.bulk(), true);
  assert.equal((await env.link.http.getPart(PART)).status, 200);
  await env.link.session.status();
  assert.deepEqual(lines(env.seen), ['POST /api/v1/team/hello', `GET ${PART}`, 'POST /api/v1/team/status']);
  assert.equal(firsts(env.seen), 'PGP');
  assert.deepEqual(env.hostSpawner.bulk, { sockets: 0, streams: 0 }, 'the host bridge marked nothing bulk');
});

test('the fake host bridge reads the first byte as the binary does, and an older one does not', async (t) => {
  for (const noBulk of [false, true]) {
    const env = await world(t, { hostOptions: { noBulk } });
    const conn = await env.fake.transport.connect({ secretKey: new Uint8Array(32).fill(5),
      hostPublicKey: env.fake.publicKeyOf(hostSecret), addresses: [], alpn: ALPN });
    for (const first of ['\x01', 'P', 'G', 'D', 'H', 'O']) {
      const stream = await conn.openStream();
      stream.on('error', () => {});
      stream.resume();
      stream.write(`${first}ET /api/v1/x HTTP/1.1\r\n\r\n`);
    }
    // The class byte is taken off by a bridge that knows it and passed on by one that does not; a request's own
    // first byte always arrives in place.
    const expected = noBulk ? ['\x01ET', 'PET', 'GET', 'DET', 'HET', 'OET'] : ['ET', 'PET', 'GET', 'DET', 'HET', 'OET'];
    await waitFor(() => env.seen.length === 6);
    assert.deepEqual(env.seen.map((entry) => entry.line.split(' ')[0]).sort(), [...expected].sort());
    assert.equal(env.hostSpawner.bulk.streams, noBulk ? 0 : 1);
    await waitFor(() => env.hostBridge.stats().streams === 0);
    const connections = env.seen.connections;
    if (!noBulk) {
      // A stream that ends with no request byte, with or without the class byte, is never carried: no loopback
      // connection opens for it, and its slot is given back.
      for (const start of ['', '\x01']) {
        const empty = await conn.openStream();
        empty.on('error', () => {});
        empty.resume();
        await waitFor(() => env.hostBridge.stats().streams === 1);
        empty.end(start);
        await waitFor(() => env.hostBridge.stats().streams === 0);
      }
      assert.equal(env.seen.connections, connections, 'no loopback connection for an empty stream');
    }
    await conn.close();
  }
});

// Fault: a stream that never sends its request byte keeps its slot, or reaches the HTTP layer as an empty connection.
test('the fake host bridge gives up on a silent stream when its window ends, as the binary does', async (t) => {
  const env = await world(t, { hostOptions: { firstByteMs: 150 } });
  const conn = await env.fake.transport.connect({ secretKey: new Uint8Array(32).fill(5),
    hostPublicKey: env.fake.publicKeyOf(hostSecret), addresses: [], alpn: ALPN });
  const connections = env.seen.connections;
  for (const start of [null, '\x01']) {
    const silent = await conn.openStream();
    let closed = false;
    silent.on('error', () => {});
    silent.on('close', () => { closed = true; });
    silent.resume();
    if (start !== null) silent.write(start);
    await waitFor(() => env.hostBridge.stats().streams === 1);
    const opened = Date.now();
    await waitFor(() => env.hostBridge.stats().streams === 0);
    assert.ok(Date.now() - opened >= 100, 'not before the window ended');
    await waitFor(() => closed);
  }
  assert.equal(env.seen.connections, connections, 'neither reached the HTTP layer');
  assert.equal(env.hostSpawner.bulk.streams, 0, 'a class byte with no request is not a carried bulk stream');
  await conn.close();
});

// Fault: a chat request sent to the bulk port (it would wait behind every model byte), or a model part sent there
// when the getter names no port.
test('the http client: only a model part route uses the bulk port, and only while the getter names one', async (t) => {
  const ordinary = await httpStandIn(t, MEMBER_PREAMBLE_BYTES);
  const bulk = await httpStandIn(t, MEMBER_PREAMBLE_BYTES);
  let bulkPort = bulk.port;
  const http = createTeamHttp({ port: ordinary.port, launchSecret, bulkPort: () => bulkPort });
  assert.equal((await http.getPart(PART)).status, 200);
  assert.equal((await http.putPart(PART, Buffer.from('part'))).status, 200);
  // Slice 6-5: a model part goes only through the two part calls; the other calls refuse its path before a socket.
  await assert.rejects(http.request('POST', PART, { body: {} }), /team_request_invalid/u);
  await assert.rejects(http.openRequestStream('GET', PART), /team_path_invalid/u);
  assert.deepEqual([ordinary.seen.length, bulk.seen.length], [0, 2]);
  assert.deepEqual(bulk.seen[0], { first: 'G'.charCodeAt(0), line: `GET ${PART} HTTP/1.1` });
  // Every other route stays on the ordinary port: hello, commands, a project part, the event stream, and near
  // misses of the part route (another method, a transfer id or a number not in the host's shape, more or fewer
  // segments).
  const transfers = '/api/v1/team/models/transfers';
  const others = ['/api/v1/team/hello', '/api/v1/commands', PART.replace('mxfer_', 'offer_'),
    `${transfers}/mxfer_1/files/0/parts/3`, PART.replace('/files/0/', '/files/00/'), PART.replace(/3$/u, '03'),
    PART.replace(/3$/u, 'x'), PART.replace(/\/3$/u, ''), `${PART}/x`, PART.replace('/transfers/', '/offers/')];
  for (const path of others) await http.request('POST', path, { body: {} });
  await http.getPart('/api/v1/projects/project_p1/downloads/m1/files/0/parts/0');
  await http.openStream('/api/v1/events').then((events) => events.close());
  assert.deepEqual([ordinary.seen.length, bulk.seen.length], [others.length + 2, 2]);
  // No bulk port (the host did not allow it, the bridge has none, or an odd value): the ordinary port.
  for (const none of [null, undefined, 0, 65536, '4567', 1.5]) {
    bulkPort = none;
    assert.equal((await http.getPart(PART)).status, 200);
  }
  assert.deepEqual([ordinary.seen.length, bulk.seen.length], [others.length + 8, 2]);
  // Without the option nothing changes.
  const plain = createTeamHttp({ port: ordinary.port, launchSecret });
  await plain.getPart(PART);
  assert.equal(bulk.seen.length, 2);
  // The preamble opens a bulk socket as it opens any other.
  assert.equal(encodeMemberPreamble(launchSecret).length, MEMBER_PREAMBLE_BYTES);
  http.dispose();
  plain.dispose();
});

test('the session records what the latest hello said about bulk streams', async () => {
  const answers = [];
  const fakeHttp = { request: async () => ({ status: 200, json: answers.shift() }) };
  const session = createTeamSession({ http: fakeHttp, appVersion: '1.7.0' });
  assert.equal(session.bulk(), false, 'not before a hello');
  for (const [json, expected] of [[{ ok: true, bulk_streams: 1 }, true], [{ ok: true }, false],
    [{ ok: true, bulk_streams: true }, false], [{ ok: true, bulk_streams: 1 }, true],
    [{ ok: false, error: { code: 'CMP-HOST-0005', reason: 'team_client_too_old' }, bulk_streams: 1 }, false]]) {
    answers.push(json);
    await session.hello();
    assert.equal(session.bulk(), expected, JSON.stringify(json));
  }
  // A hello with no answer leaves nothing recorded.
  answers.push({ ok: true, bulk_streams: 1 });
  await session.hello();
  fakeHttp.request = async () => { throw new Error('reset'); };
  await assert.rejects(session.hello());
  assert.equal(session.bulk(), false);
  // The retry hello after a `team_hello_required` answer records too.
  const queue = [{ ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_hello_required' } },
    { ok: true, bulk_streams: 1 }, { ok: true }];
  fakeHttp.request = async () => ({ status: 200, json: queue.shift() });
  assert.deepEqual(await session.status(), { ok: true });
  assert.equal(session.bulk(), true);
});

test('team-main gives the routes the running bridge\'s word, and nothing once it stopped', async (t) => {
  const fx = createTeamHostFixture(t);
  const host = await fx.start();
  assert.equal(fx.context().bulkStreams(), true);
  await host.stop();
  assert.equal(fx.context().bulkStreams(), false);

  const old = createTeamHostFixture(t);
  await old.start(null, { spawnBridge: createFakeBridgeSpawner(old.fake, { noBulk: true }) });
  assert.equal(old.context().bulkStreams(), false, 'a bridge binary from before bulk streams');
});
