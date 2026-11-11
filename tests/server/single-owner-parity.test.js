'use strict';

// Hosted mode with one owner passes the constant owner actor through the same
// authorization function and must behave exactly as it did before that function
// existed. The existing router, HTTP and lease suites are the other half of this.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PARAM_SCHEMAS } = require('../../server/api-contract');
const { createHttpServer } = require('../../server/http-server');
const { createAssetRoutes } = require('../../server/asset-routes');
const { createArtifactRoutes } = require('../../server/artifact-routes');
const { createIdentityCheck } = require('../../server/command-router-identity');
const { EventStream } = require('../../server/event-stream');
const {
  SINGLE_OWNER_MEMBER_ID, createAuthorizer, createSingleOwnerDirectory, singleOwnerActor,
} = require('../../server/team/authorize');
const { createSingleOwnerGuard } = require('../../server/team/route-guard');
const { actionForOperation } = require('../../server/team/operation-registry');
const { createFixture, command, createSession, acquire, BOOT } = require('../helpers/command-router-fixture');

test('the single-owner directory yields the constant owner actor for any session id', () => {
  const directory = createSingleOwnerDirectory();
  assert.deepEqual(directory.liveActor('session_abc'),
    { member_id: SINGLE_OWNER_MEMBER_ID, device_id: 'session_abc', role: 'owner', state: 'active' });
  assert.deepEqual(directory.liveActor('session_abc'), singleOwnerActor('session_abc'));
  assert.equal(directory.liveActor(''), null);
  assert.equal(directory.liveActor(undefined), null);
  assert.equal(directory.isDegraded(), false);
  assert.equal(directory.isDeviceActive('session_abc'), true);
  assert.equal(SINGLE_OWNER_MEMBER_ID, 'member_single_owner');
});

// A device resource is visible only when it is named; every other operation
// is authorized on its action alone.
// A chat operation names its channel (slice 2a-3a).
const paramsFor = (operation) => {
  if (operation === 'team.device.revoke') return { device_id: 'device_1' };
  return operation.startsWith('team.chat.') && operation !== 'team.chat.overview' ? { channel_id: 'chan_team' } : {};
};

test('the constant owner is allowed every operation in the closed vocabulary', () => {
  const clients = { authorize: () => true };
  const identity = createIdentityCheck({ clients, bootEpoch: 'boot_1', disposed: { value: false } });
  const context = { deviceId: 'device_1', clientToken: 't', isAuthenticated: () => true };
  const base = { request_id: 'req_1', client_id: 'client_1', boot_epoch: 'boot_1', session_id: 'session_1' };
  for (const operation of Object.keys(PARAM_SCHEMAS)) {
    for (const takeover of [false, true]) {
      const params = operation === 'control.acquire' ? { takeover } : paramsFor(operation);
      assert.equal(typeof actionForOperation(operation, params), 'string', operation);
      assert.equal(identity({ ...base, operation, params }, context), null, `${operation} takeover=${takeover}`);
    }
  }
  // An explicit authorizer makes the check a team check: the same directory
  // allows the same operations once the context carries its actor, and a
  // context without one is refused instead of becoming the owner.
  const explicit = createIdentityCheck({ clients, bootEpoch: 'boot_1', disposed: { value: false },
    authorize: createAuthorizer({ directory: createSingleOwnerDirectory() }).authorize });
  const withActor = { ...context, actor: singleOwnerActor('device_1') };
  for (const operation of Object.keys(PARAM_SCHEMAS)) {
    assert.deepEqual(explicit({ ...base, operation, params: paramsFor(operation) }, withActor), null, operation);
  }
  assert.equal(explicit({ ...base, operation: 'sessions.list', params: {} }, context).error.reason, 'role_forbidden');
});

test('identity keeps its old order and failures for the single owner', () => {
  const calls = [];
  const clients = { authorize: (...args) => { calls.push(args); return args[1] === 'good'; } };
  const disposed = { value: false };
  const identity = createIdentityCheck({ clients, bootEpoch: 'boot_1', disposed });
  const cmd = { operation: 'sessions.list', params: {}, request_id: 'req_1', client_id: 'client_1', boot_epoch: 'boot_1' };
  const good = { deviceId: 'device_1', clientToken: 'good', isAuthenticated: () => true };
  assert.equal(identity(cmd, good), null);
  assert.deepEqual(calls[0], ['client_1', 'good', 'device_1']);
  const error = (failure) => [failure.error.code, failure.error.reason, failure.error.retryable];
  assert.deepEqual(error(identity(cmd, { ...good, isAuthenticated: () => false })), ['CMP-HOST-0002', 'client_unauthorized', false]);
  assert.deepEqual(error(identity(cmd, { ...good, isAuthenticated: () => { throw new Error('x'); } })),
    ['CMP-HOST-0002', 'client_unauthorized', false]);
  assert.deepEqual(error(identity(cmd, { ...good, clientToken: 'bad' })), ['CMP-HOST-0002', 'client_unauthorized', false]);
  assert.deepEqual(error(identity(cmd, undefined)), ['CMP-HOST-0002', 'client_unauthorized', false]);
  assert.deepEqual(error(identity({ ...cmd, boot_epoch: 'other' }, good)), ['CMP-HOST-0004', 'boot_epoch_mismatch', true]);
  disposed.value = true;
  assert.deepEqual(error(identity(cmd, good)), ['CMP-HOST-0005', 'router_disposed', false]);
});

test('single-owner router: representative commands return what they always did', async (t) => {
  const f = createFixture();
  t.after(() => f.close());
  const listed = await f.router.dispatch(command(f.a, 'sessions.list'), f.contextA);
  assert.deepEqual(Object.keys(listed).sort(), ['ok', 'sessions', 'total']);
  const sessionId = await createSession(f);
  const lease = await acquire(f, sessionId, f.a, f.contextA);
  assert.deepEqual(Object.keys(lease).sort(), ['client_id', 'device_id', 'expires_at', 'generation']);
  // A plain acquire by another device is refused by the lease, exactly as before.
  const busy = await f.router.dispatch(command(f.b, 'control.acquire', { takeover: false }, { session_id: sessionId }), f.contextB);
  assert.deepEqual([busy.error.code, busy.error.reason, busy.error.retryable],
    ['CMP-HOST-0004', 'control_lease_unavailable', true]);
  // Takeover stays an owner action in single-owner mode.
  const takeover = await acquire(f, sessionId, f.b, f.contextB, true);
  assert.equal(takeover.device_id, 'device-b');
  assert.equal(takeover.generation > lease.generation, true);
  const snapshot = await f.router.dispatch(command(f.b, 'sessions.snapshot', {}, { session_id: sessionId }), f.contextB);
  assert.equal(snapshot.ok, true);
  const renamed = await f.router.dispatch(command(f.b, 'sessions.rename', { title: 'Renamed' }, {
    session_id: sessionId, control_generation: takeover.generation,
    expected_revision: f.router.snapshot(sessionId).session.revision,
  }), f.contextB);
  assert.equal(renamed.ok, true);
  assert.equal(renamed.session.title, 'Renamed');
  assert.equal((await f.router.dispatch(command(f.a, 'projects.list'), f.contextA)).ok, true);
  const stale = await f.router.dispatch(command(f.a, 'sessions.rename', { title: 'x' }, {
    session_id: sessionId, control_generation: lease.generation, expected_revision: `${BOOT}:1` }), f.contextA);
  assert.equal(stale.error.reason, 'control_lease_required');
  const wrongEpoch = await f.router.dispatch({ ...command(f.a, 'sessions.list'), boot_epoch: 'other' }, f.contextA);
  assert.equal(wrongEpoch.error.reason, 'boot_epoch_mismatch');
  const anonymous = await f.router.dispatch(command(f.a, 'sessions.list'), { ...f.contextA, isAuthenticated: () => false });
  assert.equal(anonymous.error.reason, 'client_unauthorized');
});

// ---- Routes ------------------------------------------------------------------

function responseStub() {
  return {
    headers: {}, statusCode: null, body: null, destroyed: false, writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}

const READ = { ok: true, bytes: Buffer.from('owner bytes'),
  attachment: { mime_type: 'text/plain', display_name: 'a.txt' },
  message: { id: 'value_1', role: 'user', content: 'hello' },
  artifact: { file_name: 'a.txt', mime_type: 'text/plain' } };

async function outcome(kind, pathname, method, extra) {
  const commands = { upload: async () => ({ ok: true, attachment_id: 'att_1' }),
    readAttachment: async () => READ, readMessage: async () => READ, read: async () => READ };
  const response = responseStub();
  const request = method === 'POST'
    ? { method, headers: { 'content-type': 'text/plain' }, body: Buffer.from('x') } : { method, headers: {} };
  const route = kind === 'artifact' ? createArtifactRoutes({ commands }) : createAssetRoutes({ commands });
  const handled = await route({ request, response, pathname, deviceId: 'device_1', clientId: 'client_1',
    authorized: () => true, requestId: 'req_1', ...extra });
  const { 'Content-Disposition': _name, ...headers } = response.headers;
  return { handled, statusCode: response.statusCode, body: String(response.body), headers };
}

test('single-owner routes answer the same with the legacy context and the HTTP layer context', async () => {
  const cases = [
    ['asset', '/api/v1/sessions/session_1/attachments/value_1', 'GET'],
    ['asset', '/api/v1/sessions/session_1/messages/value_1', 'GET'],
    ['artifact', '/api/v1/sessions/session_1/artifacts/value_1', 'GET'],
    ['asset', '/api/v1/attachments', 'POST'],
  ];
  for (const [kind, pathname, method] of cases) {
    const legacy = await outcome(kind, pathname, method, {});
    const http = await outcome(kind, pathname, method, {
      actor: singleOwnerActor('device_1'), guard: createSingleOwnerGuard('device_1', 'req_1') });
    assert.deepEqual(http, legacy, `${method} ${pathname}`);
    assert.equal(legacy.handled, true);
    assert.notEqual(legacy.statusCode, 403, `${method} ${pathname}`);
  }
});

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = new Map();
    this.headersSent = false;
    this.writableEnded = false;
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
  end(body) { this.body = body; this.writableEnded = true; this.emit('finish'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}

test('the HTTP layer hands the routes the constant owner actor and a live guard', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-parity-'));
  for (const file of ['index.html', 'app.js', 'styles.css']) fs.writeFileSync(path.join(root, file), 'asset');
  const events = new EventStream({ bootEpoch: 'boot' });
  let seen = null;
  const transport = createHttpServer({
    canonicalOrigin: 'https://jenny.test', staticRoot: root, bootEpoch: 'boot',
    auth: { authenticateCookie: async () => ({ ok: true, session: { id: 'session_device' } }),
      isSessionActive: () => true },
    clients: { authorize: () => true, attach: () => () => {} }, events,
    assetRoutes: async (ctx) => {
      seen = ctx;
      ctx.response.writeHead(200, { 'Content-Type': 'text/plain' });
      ctx.response.end('routed');
      return true;
    },
  });
  t.after(async () => { events.dispose(); await transport.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const response = new FakeResponse();
  const finished = new Promise((resolve) => response.once('finish', resolve));
  transport.server.emit('request', { method: 'GET', url: '/api/v1/sessions/session_1/messages/m_1',
    headers: { host: 'jenny.test', 'x-client-id': 'client', 'x-client-token': 'token' } }, response);
  await finished;
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen.actor, { member_id: 'member_single_owner', device_id: 'session_device', role: 'owner', state: 'active' });
  assert.deepEqual(seen.guard('session.read', { kind: 'session', id: 'session_1' }), { ok: true });
  assert.deepEqual(seen.guard('session.delete', { kind: 'session', id: 'session_1' }), { ok: true });
  assert.equal(seen.guard('planted.action', { kind: 'session', id: 'session_1' }).ok, false);
});
