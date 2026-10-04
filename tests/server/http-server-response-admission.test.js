'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createHttpServer } = require('../../server/http-server');
const { createArtifactRoutes } = require('../../server/artifact-routes');
const { EventStream } = require('../../server/event-stream');

const artifactPath = '/api/v1/sessions/session_1/artifacts/artifact_1';
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

// end() queues bytes but deliberately does not flush or emit finish.
class StalledResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.headersSent = false;
    this.writableEnded = false;
    this.writableFinished = false;
    this.destroyed = false;
    this.writableLength = 0;
    this.socket = { destroyed: false, destroy() { this.destroyed = true; } };
  }

  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
  }
  flushHeaders() { this.headersSent = true; }
  write(body) { this.writableLength += Buffer.byteLength(body); return false; }
  end(body) {
    this.body = body;
    this.writableLength += Buffer.byteLength(body || '');
    this.writableEnded = true;
  }
  finish() {
    this.writableLength = 0;
    this.writableFinished = true;
    this.emit('finish');
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.socket.destroy();
    this.emit('close');
  }
}

function fixture(t, { maxConcurrentRequests = 1, responseWriteTimeoutMs,
  assetRoutes, read } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-response-admission-'));
  for (const file of ['index.html', 'app.js', 'styles.css']) fs.writeFileSync(path.join(root, file), 'asset');
  const responses = [];
  const events = new EventStream({ bootEpoch: 'boot' });
  const routes = createArtifactRoutes({ commands: { read: read || (async () => ({
    ok: true, bytes: Buffer.alloc(10 * 1024 * 1024),
    artifact: { file_name: 'artifact.bin', mime_type: 'application/octet-stream' },
  })) } });
  const transport = createHttpServer({
    canonicalOrigin: 'https://jenny.test', staticRoot: root, bootEpoch: 'boot',
    auth: { authenticateCookie: async () => ({ ok: true, session: { id: 'device' } }),
      isSessionActive: () => true },
    clients: { authorize: () => true, attach: () => () => {} },
    events, assetRoutes: assetRoutes || routes,
    resourceLimits: { maxConcurrentRequests,
      ...(responseWriteTimeoutMs === undefined ? {} : { responseWriteTimeoutMs }) },
  });
  t.after(async () => {
    for (const response of responses) response.destroy();
    events.dispose();
    await transport.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    events,
    async request(url = artifactPath) {
      const response = new StalledResponse();
      responses.push(response);
      transport.server.emit('request', { method: 'GET', url,
        headers: { host: 'jenny.test', 'x-client-id': 'client', 'x-client-token': 'token',
          'last-event-id': 'boot:0' } }, response);
      await nextTurn();
      return response;
    },
  };
}

test('stalled artifact responses retain all 32 ordinary admission slots after dispatch returns', async (t) => {
  const f = fixture(t, { maxConcurrentRequests: 32 });
  for (let i = 0; i < 32; i += 1) {
    const response = await f.request();
    assert.equal(response.statusCode, 200);
    assert.equal(response.writableEnded, true);
    assert.equal(response.writableFinished, false);
    assert.equal(response.writableLength, 10 * 1024 * 1024);
  }
  const overflow = await f.request();
  assert.equal(overflow.statusCode, 429, 'unflushed responses must still occupy admission');
  assert.equal(JSON.parse(overflow.body).error.reason, 'request_capacity');
});

for (const firstEvent of ['finish', 'close']) {
  test(`${firstEvent} releases ordinary admission exactly once across repeated settlement events`, async (t) => {
    const f = fixture(t, { maxConcurrentRequests: 2 });
    const first = await f.request('/healthz');
    await f.request('/healthz');
    assert.equal((await f.request('/healthz')).statusCode, 429);
    if (firstEvent === 'finish') first.finish();
    else first.destroy();
    first.emit('finish');
    first.emit('close');
    first.emit('close');
    assert.equal((await f.request('/healthz')).statusCode, 200);
    assert.equal((await f.request('/healthz')).statusCode, 429, 'settlement must not double-release capacity');
  });
}

test('unfinished writes are destroyed at the default 60 second deadline, restoring admission', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const stalled = await f.request('/healthz');
  t.mock.timers.tick(59_999);
  assert.equal(stalled.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal(stalled.socket.destroyed, true, 'write deadline must destroy the stalled socket');
  assert.equal((await f.request('/healthz')).statusCode, 200);
  assert.equal((await f.request('/healthz')).statusCode, 429);
});

test('the write deadline starts after awaited dispatch returns, using the timeout option', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let completeRead;
  const readResult = new Promise((resolve) => { completeRead = resolve; });
  const f = fixture(t, { responseWriteTimeoutMs: 25, read: () => readResult });
  const response = await f.request();
  t.mock.timers.tick(1000);
  assert.equal(response.destroyed, false, 'dispatch time is outside the write deadline');
  completeRead({ ok: true, bytes: Buffer.from('artifact'), artifact: {} });
  await nextTurn();
  assert.equal(response.writableEnded, true);
  t.mock.timers.tick(24);
  assert.equal(response.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal(response.socket.destroyed, true);
  assert.equal((await f.request('/healthz')).statusCode, 200);
});

test('settlement before or after dispatch returns prevents later deadline destruction', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { responseWriteTimeoutMs: 25 });
  const after = await f.request('/healthz');
  after.finish();
  t.mock.timers.tick(25);
  assert.equal(after.destroyed, false);

  const before = fixture(t, { responseWriteTimeoutMs: 25, assetRoutes: async ({ response }) => {
    response.writeHead(200);
    response.end('done');
    response.finish();
    return true;
  } });
  const response = await before.request();
  t.mock.timers.tick(25);
  assert.equal(response.destroyed, false);
  assert.equal((await before.request('/healthz')).statusCode, 200);
  assert.equal((await before.request('/healthz')).statusCode, 429);
});

test('dispatch errors retain admission for the failure body until it finishes', async (t) => {
  const f = fixture(t, { assetRoutes: async () => { throw new Error('read_failed'); } });
  const failed = await f.request();
  assert.equal(failed.statusCode, 503);
  assert.equal((await f.request('/healthz')).statusCode, 429);
  failed.finish();
  failed.emit('close');
  assert.equal((await f.request('/healthz')).statusCode, 200);
  assert.equal((await f.request('/healthz')).statusCode, 429);
});

test('dispatch errors after headers destroy the response and release admission once', async (t) => {
  const f = fixture(t, { assetRoutes: async ({ response }) => {
    response.writeHead(200);
    throw new Error('write_failed');
  } });
  const failed = await f.request();
  assert.equal(failed.socket.destroyed, true);
  failed.emit('finish');
  failed.emit('close');
  assert.equal((await f.request('/healthz')).statusCode, 200);
  assert.equal((await f.request('/healthz')).statusCode, 429);
});

test('close while dispatch is pending holds capacity until the handler returns, then releases once', async (t) => {
  let completeRoute;
  const pending = new Promise((resolve) => { completeRoute = resolve; });
  const f = fixture(t, { assetRoutes: () => pending });
  const closed = await f.request();
  closed.destroy();
  assert.equal((await f.request('/healthz')).statusCode, 429, 'a disconnect must not admit work while its handler runs');
  completeRoute(true);
  await nextTurn();
  assert.equal((await f.request('/healthz')).statusCode, 200);
  assert.equal((await f.request('/healthz')).statusCode, 429, 'the released slot is not released twice');
});

test('admitted SSE keeps its independent lifecycle and has no ordinary write deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { responseWriteTimeoutMs: 25 });
  const stream = await f.request('/api/v1/events');
  assert.equal(stream.statusCode, 200);
  assert.equal(f.events.clients.size, 1);
  t.mock.timers.tick(60_000);
  assert.equal(stream.destroyed, false);
  const ordinary = await f.request('/healthz');
  assert.equal(ordinary.statusCode, 200);
  stream.destroy();
  assert.equal(f.events.clients.size, 0);
  assert.equal((await f.request('/healthz')).statusCode, 429, 'SSE close must not release ordinary admission');
});

test('a slow response that keeps writing bytes outlives the idle write deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { responseWriteTimeoutMs: 25 });
  const slow = await f.request('/healthz');
  slow.socket.bytesWritten = 0;
  for (let i = 1; i <= 4; i += 1) {
    slow.socket.bytesWritten = i * 1024;
    t.mock.timers.tick(25);
    assert.equal(slow.socket.destroyed, false, 'progress must re-arm the deadline');
  }
  t.mock.timers.tick(25);
  assert.equal(slow.socket.destroyed, true, 'a stalled write is still destroyed');
});
