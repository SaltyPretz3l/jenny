'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  CLIENT_ID,
  TOKEN_URL,
  createChatGptAuthService,
} = require('../services/backend/chatgpt-auth-service');
const {
  SECRET_TYPE_MODEL_PROVIDER_OAUTH,
  SecureStore,
} = require('../services/backend/secure-store');

const NOW_MS = Date.parse('2026-07-17T12:00:00.000Z');
const FAKE_REFRESH_TOKEN = 'fake-refresh-token-super-secret';
const FAKE_ACCESS_TOKEN = 'fake-access-token-super-secret';
const FAKE_ID_TOKEN_MARKER = 'fake-id-token-super-secret';
const observedLogs = [];
const observedThrownMessages = [];

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createSafeStorageStub() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      return Buffer.from(String(value), 'utf8').reverse();
    },
    decryptString(value) {
      return Buffer.from(value).reverse().toString('utf8');
    },
  };
}

function createSecureStoreFixture(prefix = 'jenny-chatgpt-auth-') {
  const tempDir = createTrackedTempDir(prefix);
  const filePath = path.join(tempDir, 'secure-state.json');
  return {
    filePath,
    store: new SecureStore({
      filePath,
      safeStorage: createSafeStorageStub(),
      isSafeStorageReady: () => true,
      nowProvider: () => new Date(NOW_MS),
    }),
  };
}

function encodeJwt(payload, marker = '') {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', marker })}.${encode(payload)}.${marker || 'signature'}`;
}

function createIdentityToken(overrides = {}) {
  return encodeJwt({
    email: 'jenny@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'account-123',
      chatgpt_plan_type: 'plus',
    },
    ...overrides,
  }, FAKE_ID_TOKEN_MARKER);
}

function createAccessToken(expMs = NOW_MS + 60 * 60 * 1000) {
  return encodeJwt({ exp: Math.floor(expMs / 1000), marker: FAKE_ACCESS_TOKEN }, FAKE_ACCESS_TOKEN);
}

function createRecord(overrides = {}) {
  return {
    refresh_token: FAKE_REFRESH_TOKEN,
    id_token: createIdentityToken(),
    access_token: createAccessToken(),
    account_id: 'account-123',
    plan_type: 'plus',
    email: 'jenny@example.com',
    last_refresh_ms: NOW_MS,
    ...overrides,
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function createLogger() {
  return (...args) => observedLogs.push(args);
}

function createService(overrides = {}) {
  return createChatGptAuthService({
    now: () => NOW_MS,
    logger: createLogger(),
    ...overrides,
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for test condition.');
}

async function reserveUnusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function requestUrl(urlValue) {
  return new Promise((resolve, reject) => {
    const request = http.request(urlValue, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function assertPortCanBeRebound(port) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}

// A raw connection that sends part of a request line and never terminates the
// headers: the HTTP server accepts it but never emits a 'request', so an
// untracked socket would keep server.close() pending forever.
async function openHalfOpenSocket(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET /auth/callback HTTP');
  return socket;
}

async function captureRejection(promise) {
  try {
    await promise;
    assert.fail('Expected promise to reject.');
  } catch (error) {
    observedThrownMessages.push(String(error?.message || error));
    return error;
  }
}

test('OAuth happy path uses PKCE, exchanges the code, and persists an encrypted identity record', async () => {
  const { filePath, store } = createSecureStoreFixture('jenny-chatgpt-auth-happy-');
  const port = await reserveUnusedPort();
  const statuses = [];
  let openedUrl = '';
  let exchangeRequest = null;
  const service = createService({
    secureStore: store,
    listenPorts: [port],
    openExternal(url) {
      openedUrl = url;
    },
    async fetchImpl(url, options) {
      exchangeRequest = { url, options };
      return jsonResponse(200, {
        id_token: createIdentityToken(),
        access_token: createAccessToken(),
        refresh_token: FAKE_REFRESH_TOKEN,
      });
    },
  });
  service.onStatusChange((status) => statuses.push(status));

  const startPromise = service.start();
  await waitFor(() => openedUrl);
  const authUrl = new URL(openedUrl);
  const state = authUrl.searchParams.get('state');
  const callback = new URL(authUrl.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', state);
  callback.searchParams.set('code', 'fake-authorization-code');

  const callbackResponse = await requestUrl(callback);
  const status = await startPromise;

  assert.equal(callbackResponse.statusCode, 200);
  assert.match(callbackResponse.body, /Signed in to Jenny/);
  assert.equal(authUrl.origin, 'https://auth.openai.com');
  assert.equal(authUrl.pathname, '/oauth/authorize');
  assert.equal(authUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(authUrl.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(authUrl.searchParams.get('originator'), 'jenny');
  assert.equal(Buffer.from(state, 'base64url').length, 32);
  assert.equal(callback.hostname, 'localhost');
  assert.equal(callback.port, String(port));

  assert.equal(exchangeRequest.url, TOKEN_URL);
  assert.equal(exchangeRequest.options.method, 'POST');
  assert.equal(exchangeRequest.options.headers['content-type'], 'application/x-www-form-urlencoded');
  const exchangeBody = new URLSearchParams(exchangeRequest.options.body);
  assert.equal(exchangeBody.get('grant_type'), 'authorization_code');
  assert.equal(exchangeBody.get('code'), 'fake-authorization-code');
  assert.equal(exchangeBody.get('redirect_uri'), callback.toString().split('?')[0]);
  assert.equal(exchangeBody.get('client_id'), CLIENT_ID);
  assert.equal(Buffer.from(exchangeBody.get('code_verifier'), 'base64url').length, 64);
  const expectedChallenge = crypto
    .createHash('sha256')
    .update(exchangeBody.get('code_verifier'))
    .digest('base64url');
  assert.equal(authUrl.searchParams.get('code_challenge'), expectedChallenge);

  assert.deepEqual(status, {
    state: 'signed_in',
    email: 'jenny@example.com',
    planType: 'plus',
    accountId: 'account-123',
    error: null,
  });
  assert.equal(service.getAccountId(), 'account-123');
  assert.equal(service.getCachedAccessToken(), createAccessToken());
  assert.deepEqual(statuses.map((entry) => entry.state), ['connecting', 'signed_in']);

  const diskText = fs.readFileSync(filePath, 'utf8');
  const diskPayload = JSON.parse(diskText);
  const stored = diskPayload['model_provider_oauth:chatgpt'];
  assert.equal(stored.encrypted, true);
  assert.equal(stored.secretType, SECRET_TYPE_MODEL_PROVIDER_OAUTH);
  assert.equal(diskText.includes(FAKE_REFRESH_TOKEN), false);
  assert.equal(diskText.includes(FAKE_ACCESS_TOKEN), false);
  assert.equal(JSON.parse(store.getModelProviderOAuth('chatgpt')).refresh_token, FAKE_REFRESH_TOKEN);
});

test('wrong state, timeout, cancel, and a concurrent start settle with bounded statuses', async () => {
  const wrongStateFixture = createSecureStoreFixture('jenny-chatgpt-auth-wrong-state-');
  const wrongStatePort = await reserveUnusedPort();
  let wrongStateUrl = '';
  const wrongStateService = createService({
    secureStore: wrongStateFixture.store,
    listenPorts: [wrongStatePort],
    openExternal: (url) => { wrongStateUrl = url; },
    fetchImpl: async () => assert.fail('Wrong-state callback must not exchange a code.'),
  });
  const wrongStateStart = wrongStateService.start();
  await waitFor(() => wrongStateUrl);
  const wrongCallback = new URL(new URL(wrongStateUrl).searchParams.get('redirect_uri'));
  wrongCallback.searchParams.set('state', 'wrong-state');
  wrongCallback.searchParams.set('code', 'secret-code-must-not-leak');
  const wrongResponse = await requestUrl(wrongCallback);
  assert.equal(wrongResponse.statusCode, 400);
  // A wrong-state hit is ignored, not consumed: the flow must stay pending so
  // a local port-spamming process cannot grief a legitimate sign-in.
  const settledEarly = await Promise.race([
    wrongStateStart.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(settledEarly, false);
  wrongStateService.cancel();
  const wrongStatus = await wrongStateStart;
  assert.equal(wrongStatus.state, 'signed_out');
  assert.equal(wrongStatus.error.code, 'auth_cancelled');
  assert.equal(JSON.stringify(wrongStatus).includes('secret-code'), false);
  await assertPortCanBeRebound(wrongStatePort);

  const timeoutFixture = createSecureStoreFixture('jenny-chatgpt-auth-timeout-');
  const timeoutPort = await reserveUnusedPort();
  const timeoutService = createService({
    secureStore: timeoutFixture.store,
    listenPorts: [timeoutPort],
    openExternal: () => new Promise(() => {}),
    fetchImpl: async () => assert.fail('Timed-out flow must not exchange a code.'),
  });
  const timeoutStatus = await timeoutService.start({ timeoutMs: 25 });
  assert.equal(timeoutStatus.state, 'signed_out');
  assert.equal(timeoutStatus.error.code, 'auth_timeout');
  await assertPortCanBeRebound(timeoutPort);

  const cancelFixture = createSecureStoreFixture('jenny-chatgpt-auth-cancel-');
  const cancelPort = await reserveUnusedPort();
  let cancelUrl = '';
  const cancelService = createService({
    secureStore: cancelFixture.store,
    listenPorts: [cancelPort],
    openExternal: (url) => { cancelUrl = url; },
    fetchImpl: async () => assert.fail('Cancelled flow must not exchange a code.'),
  });
  const firstStart = cancelService.start({ timeoutMs: 5000 });
  await waitFor(() => cancelUrl);
  const concurrentStatus = await cancelService.start();
  assert.equal(concurrentStatus.state, 'connecting');
  assert.equal(concurrentStatus.error.code, 'already_connecting');
  cancelService.cancel();
  const cancelledStatus = await firstStart;
  assert.equal(cancelledStatus.state, 'signed_out');
  assert.equal(cancelledStatus.error.code, 'auth_cancelled');
  await assertPortCanBeRebound(cancelPort);
});

test('occupied port 1455 falls back to 1457 and uses the fallback redirect URI', async () => {
  const occupied = http.createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(1455, '127.0.0.1', resolve);
  });
  try {
    const { store } = createSecureStoreFixture('jenny-chatgpt-auth-port-fallback-');
    let openedUrl = '';
    const service = createService({
      secureStore: store,
      openExternal: (url) => { openedUrl = url; },
      fetchImpl: async () => assert.fail('Cancelled fallback flow must not exchange a code.'),
    });
    const startPromise = service.start({ timeoutMs: 5000 });
    await waitFor(() => openedUrl);
    const authUrl = new URL(openedUrl);
    assert.equal(new URL(authUrl.searchParams.get('redirect_uri')).port, '1457');
    service.cancel();
    const status = await startPromise;
    assert.equal(status.error.code, 'auth_cancelled');
    await assertPortCanBeRebound(1457);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test('refresh is JSON, preserves omitted fields, and atomically persists one full record', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-refresh-partial-');
  store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord()));
  let setCount = 0;
  let refreshRequest = null;
  const instrumentedStore = {
    getModelProviderOAuth: (...args) => store.getModelProviderOAuth(...args),
    deleteModelProviderOAuth: (...args) => store.deleteModelProviderOAuth(...args),
    setModelProviderOAuth(...args) {
      setCount += 1;
      return store.setModelProviderOAuth(...args);
    },
  };
  const newAccessToken = createAccessToken(NOW_MS + 2 * 60 * 60 * 1000);
  const service = createService({
    secureStore: instrumentedStore,
    openExternal: () => {},
    async fetchImpl(url, options) {
      refreshRequest = { url, options };
      return jsonResponse(200, { access_token: newAccessToken });
    },
  });

  const token = await service.getAccessToken({ force: true });

  assert.equal(token, newAccessToken);
  assert.equal(refreshRequest.url, TOKEN_URL);
  assert.equal(refreshRequest.options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(refreshRequest.options.body), {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: FAKE_REFRESH_TOKEN,
  });
  assert.equal(setCount, 1);
  const persisted = JSON.parse(store.getModelProviderOAuth('chatgpt'));
  assert.equal(persisted.refresh_token, FAKE_REFRESH_TOKEN);
  assert.equal(persisted.id_token, createIdentityToken());
  assert.equal(persisted.access_token, newAccessToken);
  assert.equal(persisted.account_id, 'account-123');
  assert.equal(persisted.last_refresh_ms, NOW_MS);
});

test('concurrent forced refresh calls share exactly one token request', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-refresh-single-flight-');
  store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord()));
  let fetchCount = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const refreshedAccess = createAccessToken(NOW_MS + 3 * 60 * 60 * 1000);
  const service = createService({
    secureStore: store,
    openExternal: () => {},
    async fetchImpl() {
      fetchCount += 1;
      await fetchGate;
      return jsonResponse(200, { access_token: refreshedAccess });
    },
  });

  const first = service.getAccessToken({ force: true });
  const second = service.getAccessToken({ force: true });
  await waitFor(() => fetchCount === 1);
  releaseFetch();

  assert.equal(await first, refreshedAccess);
  assert.equal(await second, refreshedAccess);
  assert.equal(fetchCount, 1);
});

test('a stalled token fetch settles at the refresh deadline and releases the single flight', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-refresh-deadline-');
  store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord()));
  let fetchCount = 0;
  const refreshed = createAccessToken(NOW_MS + 3 * 60 * 60 * 1000);
  const service = createService({
    secureStore: store,
    openExternal: () => {},
    refreshTimeoutMs: 30,
    fetchImpl() {
      fetchCount += 1;
      // The first attempt never settles and ignores the AbortSignal entirely,
      // exactly like a transport that has stopped responding.
      return fetchCount === 1
        ? new Promise(() => {})
        : Promise.resolve(jsonResponse(200, { access_token: refreshed }));
    },
  });

  const error = await captureRejection(service.getAccessToken({ force: true }));

  assert.equal(error.code, 'refresh_failed');
  assert.equal(fetchCount, 1);
  // The flight must be released, not latched: a later caller issues a NEW request.
  assert.equal(await service.getAccessToken({ force: true }), refreshed);
  assert.equal(fetchCount, 2);
});

test('a stalled response body settles at the refresh deadline instead of hanging', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-refresh-body-deadline-');
  store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord()));
  const service = createService({
    secureStore: store,
    openExternal: () => {},
    refreshTimeoutMs: 30,
    // Headers returned, body never ends.
    fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
  });

  const error = await captureRejection(service.getAccessToken({ force: true }));

  assert.equal(error.code, 'refresh_failed');
  assert.equal(service.getStatus().state, 'signed_in');
});

test('an impatient caller racing the shared refresh cannot poison the other caller', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-refresh-impatient-');
  store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord()));
  let fetchCount = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const refreshed = createAccessToken(NOW_MS + 3 * 60 * 60 * 1000);
  const service = createService({
    secureStore: store,
    openExternal: () => {},
    async fetchImpl() {
      fetchCount += 1;
      await fetchGate;
      return jsonResponse(200, { access_token: refreshed });
    },
  });

  const shared = service.getAccessToken({ force: true });
  const second = service.getAccessToken({ force: true });
  // The impatient caller stops waiting WITHOUT aborting the shared flight.
  const raced = await Promise.race([
    shared.then((token) => ({ token })),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ token: null }), 5);
      timer.unref?.();
    }),
  ]);
  assert.equal(raced.token, null);

  releaseFetch();
  assert.equal(await shared, refreshed);
  assert.equal(await second, refreshed);
  assert.equal(fetchCount, 1);
});

test('a half-open loopback socket cannot delay cancel, timeout, or port release', async () => {
  const port = await reserveUnusedPort();
  const cancelFixture = createSecureStoreFixture('jenny-chatgpt-auth-halfopen-cancel-');
  let cancelUrl = '';
  const cancelService = createService({
    secureStore: cancelFixture.store,
    listenPorts: [port],
    openExternal: (url) => { cancelUrl = url; },
    fetchImpl: async () => assert.fail('A cancelled flow must not exchange a code.'),
  });
  const cancelStart = cancelService.start({ timeoutMs: 5000 });
  await waitFor(() => cancelUrl);
  const stalledOnCancel = await openHalfOpenSocket(port);
  const cancelStartedAt = Date.now();
  cancelService.cancel();
  const cancelled = await cancelStart;
  assert.equal(cancelled.error.code, 'auth_cancelled');
  assert.ok(
    Date.now() - cancelStartedAt < 2000,
    'teardown must not wait on a socket that never finishes its headers'
  );
  stalledOnCancel.destroy();
  await assertPortCanBeRebound(port);

  const timeoutFixture = createSecureStoreFixture('jenny-chatgpt-auth-halfopen-timeout-');
  let timeoutUrl = '';
  const timeoutService = createService({
    secureStore: timeoutFixture.store,
    listenPorts: [port],
    openExternal: (url) => { timeoutUrl = url; },
    fetchImpl: async () => assert.fail('A timed-out flow must not exchange a code.'),
  });
  const timeoutStart = timeoutService.start({ timeoutMs: 300 });
  await waitFor(() => timeoutUrl);
  // The SAME port binds again: the first flow released its listener rather
  // than leaking it and forcing a fallback port.
  assert.equal(
    new URL(new URL(timeoutUrl).searchParams.get('redirect_uri')).port,
    String(port)
  );
  const stalledOnTimeout = await openHalfOpenSocket(port);
  const timedOut = await timeoutStart;
  assert.equal(timedOut.error.code, 'auth_timeout');
  stalledOnTimeout.destroy();
  await assertPortCanBeRebound(port);
});

test('signOut during an in-flight refresh wins: the refresh cannot resurrect the record', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-refresh-signout-race-');
  store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord()));
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const service = createService({
    secureStore: store,
    openExternal: () => {},
    async fetchImpl() {
      await fetchGate;
      return jsonResponse(200, { access_token: createAccessToken(NOW_MS + 3 * 60 * 60 * 1000) });
    },
  });

  const refreshing = service.getAccessToken({ force: true });
  const signedOut = await service.signOut();
  releaseFetch();
  const token = await refreshing;

  assert.equal(signedOut.state, 'signed_out');
  assert.equal(token, '');
  assert.equal(store.getModelProviderOAuth('chatgpt'), '');
  assert.equal(service.getStatus().state, 'signed_out');
  assert.equal(service.getCachedAccessToken(), '');
});

test('status subscribers hear error-payload changes even when the state name is unchanged', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-error-emit-');
  const port = await reserveUnusedPort();
  const failingDeleteStore = {
    getModelProviderOAuth: (...args) => store.getModelProviderOAuth(...args),
    setModelProviderOAuth: (...args) => store.setModelProviderOAuth(...args),
    deleteModelProviderOAuth() {
      throw new Error('delete unavailable');
    },
  };
  const service = createService({
    secureStore: failingDeleteStore,
    listenPorts: [port],
    openExternal: () => { throw new Error('no browser'); },
    fetchImpl: async () => assert.fail('These failing flows must not exchange a code.'),
  });
  const seen = [];
  service.onStatusChange((status) => seen.push(`${status.state}:${(status.error && status.error.code) || ''}`));

  const first = await service.start({ timeoutMs: 2000 });
  assert.equal(first.state, 'error');
  assert.equal(first.error.code, 'browser_open_failed');

  // Fail-closed sign-out: the credential is cleared either way, so the state is
  // 'signed_out' and the storage failure rides along as the error payload.
  const second = await service.signOut();
  assert.equal(second.state, 'signed_out');
  assert.equal(second.error.code, 'storage_failed');

  assert.equal(seen.includes('error:browser_open_failed'), true);
  assert.equal(seen.includes('signed_out:storage_failed'), true);

  // transition() suppresses no-op emissions: an identical repeat failure must
  // not push another status to subscribers.
  const seenCount = seen.length;
  const third = await service.signOut();
  assert.equal(third.state, 'signed_out');
  assert.equal(third.error.code, 'storage_failed');
  assert.equal(seen.length, seenCount);
});

test('permanent refresh failure deletes the record and reports auth_expired', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-refresh-permanent-');
  store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord()));
  const service = createService({
    secureStore: store,
    openExternal: () => {},
    fetchImpl: async () => jsonResponse(400, {
      error: { code: 'refresh_token_reused', message: FAKE_REFRESH_TOKEN },
    }),
  });

  assert.equal(await service.getAccessToken({ force: true }), '');
  assert.equal(store.getModelProviderOAuth('chatgpt'), '');
  assert.deepEqual(service.getStatus(), {
    state: 'error',
    email: '',
    planType: '',
    accountId: '',
    error: {
      code: 'auth_expired',
      message: 'Your ChatGPT sign-in has expired. Sign in again.',
    },
  });
});

test('transient refresh failure keeps the encrypted record and throws a bounded error', async () => {
  const { store } = createSecureStoreFixture('jenny-chatgpt-auth-refresh-transient-');
  const originalRecord = createRecord();
  store.setModelProviderOAuth('chatgpt', JSON.stringify(originalRecord));
  const service = createService({
    secureStore: store,
    openExternal: () => {},
    fetchImpl: async () => {
      throw new Error(`network failed with ${FAKE_REFRESH_TOKEN} and ${FAKE_ACCESS_TOKEN}`);
    },
  });

  const error = await captureRejection(service.getAccessToken({ force: true }));

  assert.equal(error.code, 'refresh_failed');
  assert.equal(error.message, 'ChatGPT credentials could not be refreshed.');
  assert.deepEqual(JSON.parse(store.getModelProviderOAuth('chatgpt')), originalRecord);
  assert.equal(service.getStatus().state, 'signed_in');
});

test('near-expiry JWTs refresh proactively and unreadable JWTs use the eight-day fallback', async () => {
  const nearFixture = createSecureStoreFixture('jenny-chatgpt-auth-expiry-near-');
  nearFixture.store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord({
    access_token: createAccessToken(NOW_MS + 4 * 60 * 1000),
  })));
  let nearFetchCount = 0;
  const nearRefreshed = createAccessToken(NOW_MS + 60 * 60 * 1000);
  const nearService = createService({
    secureStore: nearFixture.store,
    openExternal: () => {},
    fetchImpl: async () => {
      nearFetchCount += 1;
      return jsonResponse(200, { access_token: nearRefreshed });
    },
  });
  assert.equal(nearService.getCachedAccessToken(), '');
  assert.equal(await nearService.getAccessToken(), nearRefreshed);
  assert.equal(nearFetchCount, 1);

  const fallbackFreshFixture = createSecureStoreFixture('jenny-chatgpt-auth-expiry-fallback-fresh-');
  fallbackFreshFixture.store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord({
    access_token: 'unreadable-access-jwt',
    last_refresh_ms: NOW_MS - (8 * 24 * 60 * 60 * 1000) + 1000,
  })));
  let fallbackFreshFetches = 0;
  const fallbackFreshService = createService({
    secureStore: fallbackFreshFixture.store,
    openExternal: () => {},
    fetchImpl: async () => {
      fallbackFreshFetches += 1;
      return jsonResponse(200, {});
    },
  });
  assert.equal(fallbackFreshService.getCachedAccessToken(), 'unreadable-access-jwt');
  assert.equal(await fallbackFreshService.getAccessToken(), 'unreadable-access-jwt');
  assert.equal(fallbackFreshFetches, 0);

  const fallbackExpiredFixture = createSecureStoreFixture('jenny-chatgpt-auth-expiry-fallback-expired-');
  fallbackExpiredFixture.store.setModelProviderOAuth('chatgpt', JSON.stringify(createRecord({
    access_token: 'unreadable-expired-access-jwt',
    last_refresh_ms: NOW_MS - (8 * 24 * 60 * 60 * 1000) - 1,
  })));
  let fallbackExpiredFetches = 0;
  const fallbackRefreshed = createAccessToken(NOW_MS + 60 * 60 * 1000);
  const fallbackExpiredService = createService({
    secureStore: fallbackExpiredFixture.store,
    openExternal: () => {},
    fetchImpl: async () => {
      fallbackExpiredFetches += 1;
      return jsonResponse(200, { access_token: fallbackRefreshed });
    },
  });
  assert.equal(await fallbackExpiredService.getAccessToken(), fallbackRefreshed);
  assert.equal(fallbackExpiredFetches, 1);
});

test('secure store registers and round-trips model-provider OAuth only for allowlisted ids', () => {
  const { filePath, store } = createSecureStoreFixture('jenny-chatgpt-auth-secure-store-pair-');
  assert.equal(SECRET_TYPE_MODEL_PROVIDER_OAUTH, 'model_provider_oauth');

  store.setModelProviderOAuth('chatgpt', ` ${FAKE_REFRESH_TOKEN} `);
  assert.equal(store.getModelProviderOAuth('chatgpt'), FAKE_REFRESH_TOKEN);
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload['model_provider_oauth:chatgpt'].secretType, SECRET_TYPE_MODEL_PROVIDER_OAUTH);

  store.deleteModelProviderOAuth('chatgpt');
  assert.equal(store.getModelProviderOAuth('chatgpt'), '');

  const rejectedId = 'not-a-real-provider-secret-id';
  for (const invoke of [
    () => store.getModelProviderOAuth(rejectedId),
    () => store.setModelProviderOAuth(rejectedId, FAKE_REFRESH_TOKEN),
    () => store.deleteModelProviderOAuth(rejectedId),
  ]) {
    assert.throws(invoke, (error) => {
      observedThrownMessages.push(error.message);
      assert.match(error.message, /unknown model provider OAuth id/i);
      assert.equal(error.message.includes(rejectedId), false);
      return true;
    });
  }
});

test('logs and thrown errors never contain fake access, refresh, or id-token values', () => {
  const serializedLogs = JSON.stringify(observedLogs);
  const serializedErrors = JSON.stringify(observedThrownMessages);
  for (const secret of [FAKE_REFRESH_TOKEN, FAKE_ACCESS_TOKEN, FAKE_ID_TOKEN_MARKER]) {
    assert.equal(serializedLogs.includes(secret), false);
    assert.equal(serializedErrors.includes(secret), false);
  }
});
