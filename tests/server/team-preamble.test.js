'use strict';

// Team slice 1c-2a: the preamble listener. A raw TCP client writes the 72-byte
// host preamble itself; everything that is not a well-formed preamble carrying
// the boot secret is destroyed before the HTTP parser sees a byte.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const { createPreambleListener } = require('../../server/team/preamble-listener');
const { HOST_PREAMBLE_BYTES, encodeHostPreamble } = require('../../server/team/transport/preamble');

const BOOT_SECRET = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
const KEY = Uint8Array.from({ length: 32 }, (_, index) => 7 * index + 1);

function validPreamble(key = KEY) {
  return Buffer.from(encodeHostPreamble(BOOT_SECRET, key));
}

// A raw client: collects every byte received and reports when the socket closes.
function rawClient(port) {
  const socket = net.connect({ host: '127.0.0.1', port });
  const received = [];
  const client = { socket, received, closed: false };
  socket.on('data', (chunk) => received.push(chunk));
  socket.on('error', () => {});
  client.closedPromise = new Promise((resolve) => socket.on('close', () => { client.closed = true; resolve(); }));
  client.connected = new Promise((resolve) => socket.once('connect', resolve));
  client.bytes = () => Buffer.concat(received);
  return client;
}

function pause(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function setup(t, options = {}) {
  const sockets = [];
  const clients = [];
  const listener = await createPreambleListener({
    port: 0, bootSecret: Buffer.from(BOOT_SECRET), logger: () => {}, timeoutMs: 150,
    onSocket: (socket) => { sockets.push(socket); socket.on('error', () => {}); },
    ...options,
  });
  const connect = () => { const client = rawClient(listener.port); clients.push(client); return client; };
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    for (const socket of sockets) socket.destroy();
    await listener.close();
  });
  return { listener, sockets, connect };
}

test('the preamble listener module is discoverable and exports the factory', () => {
  assert.equal(typeof createPreambleListener, 'function');
  assert.equal(HOST_PREAMBLE_BYTES, 72);
});

for (const [name, mutate] of [
  ['wrong magic', (bytes) => { bytes[0] ^= 1; }],
  ['wrong version', (bytes) => { bytes[4] = 2; }],
  ['non-zero reserved bytes', (bytes) => { bytes[6] = 1; }],
  ['a wrong secret', (bytes) => { bytes[8 + 5] ^= 1; }],
]) {
  test(`${name} ends with the socket destroyed and zero bytes sent back`, async (t) => {
    const { listener, sockets, connect } = await setup(t);
    const client = connect();
    const bytes = validPreamble();
    mutate(bytes);
    await client.connected;
    client.socket.write(Buffer.concat([bytes, Buffer.from('GET / HTTP/1.1\r\n\r\n')]));
    await client.closedPromise;
    assert.equal(client.bytes().length, 0);
    assert.equal(sockets.length, 0, 'the HTTP layer never saw the socket');
    assert.deepEqual(listener.stats(), { pending: 0, accepted: 0, refused: 1 });
  });
}

test('a short preamble that stalls is destroyed at the timeout with nothing sent back', async (t) => {
  const { listener, sockets, connect } = await setup(t);
  const client = connect();
  await client.connected;
  client.socket.write(validPreamble().subarray(0, 40));
  await pause(30);
  assert.equal(listener.stats().pending, 1);
  await client.closedPromise;
  assert.equal(client.bytes().length, 0);
  assert.equal(sockets.length, 0);
  assert.deepEqual(listener.stats(), { pending: 0, accepted: 0, refused: 1 });
});

test('a slow preamble that passes the timeout is destroyed even if the rest arrives later', async (t) => {
  const { listener, sockets, connect } = await setup(t, { timeoutMs: 100 });
  const client = connect();
  await client.connected;
  const bytes = validPreamble();
  client.socket.write(bytes.subarray(0, 71));
  await client.closedPromise;
  client.socket.write(bytes.subarray(71));
  assert.equal(client.bytes().length, 0);
  assert.equal(sockets.length, 0);
  assert.equal(listener.stats().accepted, 0);
});

test('the seventeenth socket in the preamble phase is destroyed at once', async (t) => {
  const { listener, sockets, connect } = await setup(t, { timeoutMs: 5000 });
  const pending = Array.from({ length: 16 }, () => connect());
  await Promise.all(pending.map((client) => client.connected));
  await pause(50);
  assert.equal(listener.stats().pending, 16);
  const extra = connect();
  await extra.closedPromise;
  assert.equal(extra.bytes().length, 0);
  assert.equal(pending.some((client) => client.closed), false, 'the sixteen earlier sockets are untouched');
  assert.deepEqual(listener.stats(), { pending: 16, accepted: 0, refused: 1 });
  assert.equal(sockets.length, 0);
});

test('close destroys sockets still in the preamble phase', async (t) => {
  const { listener, connect } = await setup(t, { timeoutMs: 5000 });
  const client = connect();
  await client.connected;
  client.socket.write(validPreamble().subarray(0, 10));
  await pause(30);
  await listener.close();
  await client.closedPromise;
  assert.equal(client.bytes().length, 0);
  assert.equal(listener.stats().pending, 0);
});

// A real HTTP server behind the listener, to prove no byte after the preamble is lost.
async function withHttp(t, options) {
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ url: request.url, key: request.socket.teamKey }));
  });
  const env = await setup(t, { onSocket: (socket) => server.emit('connection', socket), ...options });
  t.after(() => { server.closeAllConnections(); });
  return env;
}

function parseResponse(bytes) {
  const text = bytes.toString('utf8');
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]);
  const body = text.includes('\r\n\r\n') ? text.split('\r\n\r\n').slice(1).join('\r\n\r\n') : '';
  return { status, text, body };
}

async function waitForBody(client) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const parsed = parseResponse(client.bytes());
    if (parsed.status === 200 && parsed.body.includes('}')) return parsed;
    await pause(20);
  }
  throw new Error('no_response');
}

const REQUEST = 'GET /one HTTP/1.1\r\nHost: jenny-team.invalid\r\n\r\n';

test('a valid preamble followed by a request in the same chunk is answered', async (t) => {
  const { listener, connect } = await withHttp(t);
  const client = connect();
  await client.connected;
  client.socket.write(Buffer.concat([validPreamble(), Buffer.from(REQUEST)]));
  const parsed = await waitForBody(client);
  assert.deepEqual(JSON.parse(parsed.body), { url: '/one', key: Buffer.from(KEY).toString('base64url') });
  assert.deepEqual(listener.stats(), { pending: 0, accepted: 1, refused: 0 });
});

test('a valid preamble followed by a request in a later chunk is answered', async (t) => {
  const { connect } = await withHttp(t);
  const client = connect();
  await client.connected;
  client.socket.write(validPreamble());
  await pause(60);
  client.socket.write(REQUEST);
  const parsed = await waitForBody(client);
  assert.deepEqual(JSON.parse(parsed.body), { url: '/one', key: Buffer.from(KEY).toString('base64url') });
});

test('a preamble split across several writes is assembled', async (t) => {
  // Eight writes 10 ms apart: the 150 ms default deadline flaked under load.
  const { sockets, connect } = await setup(t, { timeoutMs: 2000 });
  const client = connect();
  await client.connected;
  const bytes = validPreamble();
  for (let offset = 0; offset < bytes.length; offset += 9) {
    client.socket.write(bytes.subarray(offset, offset + 9));
    await pause(10);
  }
  for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) await pause(20);
  assert.equal(sockets.length, 1);
});

test('the remote key is bound to the socket as a non-writable base64url value', async (t) => {
  const { sockets, connect } = await setup(t);
  const key = crypto.randomBytes(32);
  const client = connect();
  await client.connected;
  client.socket.write(validPreamble(key));
  for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) await pause(20);
  assert.equal(sockets.length, 1);
  const descriptor = Object.getOwnPropertyDescriptor(sockets[0], 'teamKey');
  assert.equal(descriptor.value, key.toString('base64url'));
  assert.equal(descriptor.writable, false);
  assert.throws(() => { 'use strict'; sockets[0].teamKey = 'other'; }, TypeError);
});

test('stats count accepted and refused sockets and a throwing logger changes nothing', async (t) => {
  const { listener, sockets, connect } = await setup(t, { logger: () => { throw new Error('log_down'); } });
  const good = connect();
  const bad = connect();
  await Promise.all([good.connected, bad.connected]);
  const wrong = validPreamble();
  wrong[0] ^= 1;
  bad.socket.write(wrong);
  good.socket.write(validPreamble());
  await bad.closedPromise;
  for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) await pause(20);
  assert.deepEqual(listener.stats(), { pending: 0, accepted: 1, refused: 1 });
});
