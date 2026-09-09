'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHttpServer } = require('../../server/http-server');
const { AuthService } = require('../../server/auth-service');
const { ClientRegistry } = require('../../server/client-registry');
const { ControlLeases } = require('../../server/control-leases');
const { CommandReceipts } = require('../../server/command-receipts');
const { BackendEvents } = require('../../server/backend-events');
const { createCommandRouter } = require('../../server/command-router');
const { FileSecretStore } = require('../../server/file-secret-store');
const { createHostedBackend } = require('../../services/host/service-composition');

const canonicalOrigin = 'https://jenny.test';

async function fixture(t, isReady = () => true, routerOverride = null, executionStatus = () => false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-http-'));
  fs.chmodSync(root, 0o700);
  const staticRoot = path.join(root, 'browser');
  fs.mkdirSync(staticRoot);
  for (const file of ['index.html', 'app.js', 'styles.css']) fs.writeFileSync(path.join(staticRoot, file), 'test build');
  fs.mkdirSync(path.join(staticRoot, 'locales'));
  for (const tag of [...require('../../renderer/shared/i18n-utils').SUPPORTED_TAGS, 'qps-ploc']) {
    fs.writeFileSync(path.join(staticRoot, 'locales', `${tag}.json`), JSON.stringify({ 'common.save': tag === 'es' ? 'Guardar' : 'Save' }));
  }
  const userDataPath = path.join(root, 'profile');
  fs.mkdirSync(userDataPath, { mode: 0o700 });
  const composition = createHostedBackend({ hostMode: 'server', userDataPath,
    credentialService: new FileSecretStore(), workspaceRoot: null,
    modelEndpoint: { engine: 'replay', model: 'replay' } });
  const clients = new ClientRegistry();
  const leases = new ControlLeases();
  const bootEpoch = 'boot';
  const events = new BackendEvents({ backend: composition.backend, bootEpoch });
  const auth = new AuthService({ filePath: path.join(userDataPath, 'auth.json'), onInvalidate: (id) => {
    clients.revokeDevice(id); leases.revokeDevice(id); events.revokeDevice(id);
  } });
  assert.equal((await auth.initializePassword('test-password-strong')).ok, true);
  const router = createCommandRouter({ backend: composition.backend, clients, leases, bootEpoch,
    receipts: new CommandReceipts({ filePath: path.join(userDataPath, 'receipts.json') }), eventStream: events });
  const transport = createHttpServer({ canonicalOrigin, staticRoot, auth, clients, events, router: routerOverride || router, bootEpoch, isReady, executionStatus });
  await new Promise((resolve) => transport.server.listen(0, '127.0.0.1', resolve));
  const port = transport.server.address().port;
  t.after(async () => {
    await transport.close(); router.dispose(); events.dispose(); composition.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (method, url, body, extra = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method,
      headers: { Host: 'jenny.test', Origin: canonicalOrigin,
        ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...extra } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: response.headers,
          body: response.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
  return { request, auth, clients, leases, router, composition, events, port };
}

test('catalog routes serve only fixed shipped assets before login', async (t) => {
  const f = await fixture(t);
  const response = await f.request('GET', '/locales/es.json');
  assert.equal(response.status, 200);
  assert.equal(response.body['common.save'], 'Guardar');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  for (const url of ['/locales/unknown.json', '/locales/../auth.json', '/locales/%2e%2e/auth.json']) {
    assert.notEqual((await f.request('GET', url)).status, 200, url);
  }
});

test('real HTTP login, two clients, canonical sessions and logout fencing', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('GET', '/api/v1/bootstrap')).status, 401);
  assert.equal((await f.request('GET', '/auth.json')).status, 401);
  const login = await f.request('POST', '/api/v1/auth/login', { password: 'test-password-strong' });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /__Host-jenny=.*Secure/);
  assert.equal(login.body.token, undefined);
  const cookie = login.headers['set-cookie'][0].split(';', 1)[0];
  const headers = { Cookie: cookie, 'X-CSRF-Token': login.body.csrf_token };
  const a = await f.request('POST', '/api/v1/clients', undefined, headers);
  const b = await f.request('POST', '/api/v1/clients', undefined, headers);
  assert.notEqual(a.body.client_id, b.body.client_id);
  const command = { api_version: 1, boot_epoch: 'boot', client_id: a.body.client_id,
    request_id: 'create1', operation: 'sessions.create', params: { title: 'Across devices' } };
  const created = await f.request('POST', '/api/v1/commands', command,
    { ...headers, 'X-Client-Token': a.body.client_token });
  assert.equal(created.body.ok, true, JSON.stringify(created.body));
  const list = await f.request('POST', '/api/v1/commands', { ...command,
    client_id: b.body.client_id, request_id: 'list1', operation: 'sessions.list', params: {} },
  { ...headers, 'X-Client-Token': b.body.client_token });
  assert.equal(list.body.sessions[0].session_id, created.body.session.session_id);
  const bootstrap = await f.request('GET', '/api/v1/bootstrap', undefined, headers);
  assert.equal(bootstrap.body.csrf_token, login.body.csrf_token);
  assert.equal((await f.request('POST', '/api/v1/auth/logout', undefined, headers)).status, 200);
  assert.equal((await f.request('GET', '/api/v1/bootstrap', undefined, headers)).status, 401);
});

test('HTTP denies cross-origin requests, forged identity and oversized login before auth', async (t) => {
  const f = await fixture(t);
  for (const override of [{ Host: 'evil.test' }, { Origin: 'https://evil.test' }, { Origin: '' }]) {
    const result = await f.request('POST', '/api/v1/auth/login', { password: 'test-password-strong' }, override);
    assert.equal(result.status, 403);
  }
  const forged = await f.request('GET', '/api/v1/bootstrap', undefined,
    { 'X-Forwarded-User': 'owner', 'X-Forwarded-For': '127.0.0.1' });
  assert.equal(forged.status, 401);
  assert.equal((await f.request('POST', '/api/v1/auth/login', { password: 'x'.repeat(5000) })).status, 400);
  const asset = await f.request('GET', '/');
  assert.equal(asset.status, 200);
  assert.match(asset.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(asset.headers['cache-control'], 'no-store');
});


test('health is live while readiness reports a missing model runtime', async (t) => {
  const f = await fixture(t, () => false);
  assert.equal((await f.request('GET', '/healthz')).status, 200);
  assert.equal((await f.request('GET', '/readyz')).status, 503);
});

test('bootstrap reports the execution capability from the host status callback', async (t) => {
  const f = await fixture(t, () => true, null, () => true);
  const login = await f.request('POST', '/api/v1/auth/login', { password: 'test-password-strong' });
  const headers = { Cookie: login.headers['set-cookie'][0].split(';', 1)[0], 'X-CSRF-Token': login.body.csrf_token };
  const bootstrap = await f.request('GET', '/api/v1/bootstrap', undefined, headers);
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.tools.execution, true);
});

test('bodyless mutation routes reject framed request bodies', async (t) => {
  const f = await fixture(t);
  const login = await f.request('POST', '/api/v1/auth/login', { password: 'test-password-strong' });
  const headers = { Cookie: login.headers['set-cookie'][0].split(';', 1)[0],
    'X-CSRF-Token': login.body.csrf_token };
  assert.equal((await f.request('POST', '/api/v1/clients', {}, headers)).status, 400);
  assert.equal((await f.request('POST', '/api/v1/auth/logout', {}, headers)).status, 400);
  assert.equal((await f.request('POST', '/api/v1/clients', undefined, headers)).status, 200);
  assert.equal((await f.request('POST', '/api/v1/auth/logout', undefined, headers)).status, 200);
});


test('HTTP command failures preserve the canonical error status and retry contract', async (t) => {
  const { hostFailure } = require('../../server/api-contract');
  let result;
  const f = await fixture(t, () => true, { dispatch: async () => result });
  const login = await f.request('POST', '/api/v1/auth/login', { password: 'test-password-strong' });
  const headers = { Cookie: login.headers['set-cookie'][0].split(';', 1)[0],
    'X-CSRF-Token': login.body.csrf_token };
  for (const [kind, status] of Object.entries({ invalid: 400, unauthorized: 401,
    forbidden: 403, conflict: 409, limit: 429, persistence: 503, unavailable: 503 })) {
    result = hostFailure(kind, 'test_failure', 'test_request', true);
    const response = await f.request('POST', '/api/v1/commands', {}, headers);
    assert.equal(response.status, status, kind);
    assert.deepEqual(response.body, result);
  }
});


test('SSE capacity rejects before 200 and replacing a client releases its slot synchronously', async (t) => {
  const f = await fixture(t);
  f.events.events.maxClients = 1;
  const login = await f.request('POST', '/api/v1/auth/login', { password: 'test-password-strong' });
  const headers = { Cookie: login.headers['set-cookie'][0].split(';', 1)[0],
    'X-CSRF-Token': login.body.csrf_token };
  const a = (await f.request('POST', '/api/v1/clients', undefined, headers)).body;
  const b = (await f.request('POST', '/api/v1/clients', undefined, headers)).body;
  const streamHeaders = (client) => ({ ...headers, Host: 'jenny.test', Origin: canonicalOrigin,
    'X-Client-Id': client.client_id, 'X-Client-Token': client.client_token, 'Last-Event-ID': 'boot:0' });
  const connect = (client) => new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: f.port, path: '/api/v1/events',
      headers: streamHeaders(client) }, resolve);
    request.on('error', reject);
    t.after(() => request.destroy());
  });
  const first = await connect(a);
  assert.equal(first.statusCode, 200);
  const full = await f.request('GET', '/api/v1/events', undefined, streamHeaders(b));
  assert.equal(full.status, 429);
  assert.equal(full.body.error.code, 'CMP-HOST-0007');
  const replacement = await connect(a);
  assert.equal(replacement.statusCode, 200);
  assert.equal(f.events.events.clients.size, 1);
  f.events.dispose();
  const unavailable = await f.request('GET', '/api/v1/events', undefined, streamHeaders(b));
  assert.equal(unavailable.status, 503);
});
