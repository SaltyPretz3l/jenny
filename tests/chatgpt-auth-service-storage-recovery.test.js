'use strict';

// Credential lifecycle across secure-storage failures: a rotated refresh token
// whose save failed, a refused basic_text backend, and a credential file that is
// briefly unreadable at first access. Token values are fake placeholders and the
// assertions compare labels, so a failure never prints a credential.

const fs = require('node:fs');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { createChatGptAuthService } = require('../services/backend/chatgpt-auth-service');
const { SecureStore } = require('../services/backend/secure-store');
const { CredentialFileStore } = require('../services/backend/secure-store-file-health');

const NOW_MS = Date.parse('2026-10-11T12:00:00.000Z');
const REFRESH = ['fake-refresh-r0-placeholder', 'fake-refresh-r1-placeholder', 'fake-refresh-r2-placeholder'];
const observedLogs = [];
const observedErrors = [];

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function encodeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.fake-signature`;
}

function accessToken(index) {
  const expMs = NOW_MS + 60 * 60 * 1000;
  return encodeJwt({ exp: Math.floor(expMs / 1000), marker: `fake-access-a${index}-placeholder` });
}

const ACCESS = [accessToken(0), accessToken(1), accessToken(2)];

function label(value) {
  const refresh = REFRESH.indexOf(value);
  if (refresh >= 0) return `R${refresh}`;
  const access = ACCESS.indexOf(value);
  return access >= 0 ? `A${access}` : (value ? 'other' : 'empty');
}

function storedRecord(index = 0) {
  return JSON.stringify({ refresh_token: REFRESH[index], access_token: ACCESS[index], id_token: '',
    account_id: 'account-fixture', plan_type: 'plus', email: 'fixture@example.invalid', last_refresh_ms: NOW_MS });
}

function storedRefreshLabel(store) {
  const raw = store.getModelProviderOAuth('chatgpt');
  return raw ? label(JSON.parse(raw).refresh_token) : 'empty';
}

function createStore({ safeStorage = {}, seed = true } = {}) {
  const filePath = path.join(createTrackedTempDir('jenny-chatgpt-auth-storage-'), 'secure-state.json');
  const store = new SecureStore({
    filePath,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(String(value), 'utf8').reverse(),
      decryptString: (value) => Buffer.from(value).reverse().toString('utf8'),
      ...safeStorage,
    },
    isSafeStorageReady: () => true,
  });
  if (seed) store.setModelProviderOAuth('chatgpt', storedRecord(0));
  return { filePath, store };
}

function createService(secureStore, fetchImpl) {
  return createChatGptAuthService({
    secureStore,
    now: () => NOW_MS,
    logger: (...args) => observedLogs.push(args),
    openExternal: () => assert.fail('Recovery must not start a new OAuth flow.'),
    fetchImpl,
  });
}

function rotatingFetch(submitted) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    submitted.push(label(body.refresh_token));
    const next = submitted.length;
    return { ok: true, status: 200, json: async () => ({ access_token: ACCESS[next], refresh_token: REFRESH[next] }) };
  };
}

function failingSaves(store, failures) {
  const counter = { remaining: failures, attempts: 0 };
  return {
    counter,
    secureStore: {
      getModelProviderOAuth: (...args) => store.getModelProviderOAuth(...args),
      deleteModelProviderOAuth: (...args) => store.deleteModelProviderOAuth(...args),
      setModelProviderOAuth(...args) {
        counter.attempts += 1;
        if (counter.remaining > 0) {
          counter.remaining -= 1;
          throw new Error('EPERM: credential file could not be replaced');
        }
        return store.setModelProviderOAuth(...args);
      },
    },
  };
}

async function settle(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    observedErrors.push(String(error?.message || error));
    return { error: error?.code || 'thrown' };
  }
}

test('a rotated refresh token whose save failed is kept, re-saved, and the consumed token is never resubmitted', async () => {
  const { store } = createStore();
  const { counter, secureStore } = failingSaves(store, 2);
  const submitted = [];
  const service = createService(secureStore, rotatingFetch(submitted));

  const first = await settle(service.getAccessToken({ force: true }));
  assert.deepEqual({ token: label(first.value), stored: storedRefreshLabel(store) }, { token: 'A1', stored: 'R0' });
  assert.equal(service.hasCredential(), true);

  // The retry of the pending save fails too, so this refresh must use the
  // in-memory replacement rather than the superseded stored token.
  const second = await settle(service.getAccessToken({ force: true }));
  assert.deepEqual({ token: label(second.value), stored: storedRefreshLabel(store) }, { token: 'A2', stored: 'R2' });

  const third = await settle(service.getAccessToken());
  assert.equal(label(third.value), 'A2');
  assert.deepEqual(submitted, ['R0', 'R1']);
  assert.equal(counter.attempts, 3);
  assert.equal(service.getStatus().state, 'signed_in');
});

test('storage recovery persists the pending replacement before the next refresh', async () => {
  const { store } = createStore();
  const { secureStore } = failingSaves(store, 1);
  const submitted = [];
  const service = createService(secureStore, rotatingFetch(submitted));

  assert.equal(label((await settle(service.getAccessToken({ force: true }))).value), 'A1');
  assert.equal(label((await settle(service.getAccessToken())).value), 'A1');
  assert.equal(storedRefreshLabel(store), 'R1');
  assert.equal(label((await settle(service.getAccessToken({ force: true }))).value), 'A2');
  assert.deepEqual(submitted, ['R0', 'R1']);
  assert.equal(storedRefreshLabel(store), 'R2');
});

test('sign-out discards an unsaved rotated credential instead of re-saving it', async () => {
  const { store } = createStore();
  const { counter, secureStore } = failingSaves(store, 1);
  const submitted = [];
  const service = createService(secureStore, rotatingFetch(submitted));

  await settle(service.getAccessToken({ force: true }));
  const attemptsBeforeSignOut = counter.attempts;
  assert.equal((await service.signOut()).state, 'signed_out');

  assert.equal(label((await settle(service.getAccessToken({ force: true }))).value), 'empty');
  assert.equal(counter.attempts, attemptsBeforeSignOut);
  assert.equal(storedRefreshLabel(store), 'empty');
  assert.equal(service.hasCredential(), false);
  assert.deepEqual(submitted, ['R0']);
});

test('a basic_text backend never decrypts, never mutates storage, and never admits the credential', async () => {
  let decryptCalls = 0;
  let backend = '';
  const { filePath, store } = createStore({ safeStorage: {
    getSelectedStorageBackend: () => backend,
    decryptString: () => { decryptCalls += 1; return storedRecord(0); },
  } });
  const before = fs.readFileSync(filePath, 'utf8');
  backend = 'basic_text';
  const service = createService(store, async () => assert.fail('A refused backend must not refresh.'));

  assert.throws(() => store.getModelProviderOAuth('chatgpt'), { code: 'storage_unavailable' });
  assert.equal(service.hasCredential(), false);
  assert.equal(service.getStatus().state, 'signed_out');
  assert.equal(label((await settle(service.getAccessToken())).value), 'empty');
  assert.equal(decryptCalls, 0);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

function interceptReads(t, filePath) {
  const realRead = fs.readFileSync;
  const control = { busy: true };
  fs.readFileSync = (target, ...rest) => {
    if (control.busy && String(target) === filePath) {
      throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
    }
    return realRead(target, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });
  return control;
}

function freshProcessStore(t, store, filePath) {
  const clock = { ms: 5_000_000 };
  store.store = new CredentialFileStore(filePath, { now: () => clock.ms, logger: () => {} });
  return { clock, reads: interceptReads(t, filePath) };
}

test('an initially unreadable credential file loads once it recovers, without a new sign-in', async (t) => {
  const { filePath, store } = createStore();
  const { clock, reads } = freshProcessStore(t, store, filePath);
  const service = createService(store, async () => assert.fail('A fresh cached token needs no refresh.'));

  assert.equal(service.hasCredential(), false);
  reads.busy = false;
  assert.equal(service.hasCredential(), false, 'the file store waits out its recheck interval');
  clock.ms += 1000;

  assert.equal(service.hasCredential(), true);
  assert.equal(service.getStatus().state, 'signed_in');
  assert.equal(label((await settle(service.getAccessToken())).value), 'A0');
});

test('a sign-out before the credential file recovers keeps the process signed out', async (t) => {
  const { filePath, store } = createStore();
  const { clock, reads } = freshProcessStore(t, store, filePath);
  const service = createService(store, async () => assert.fail('A signed-out process must not refresh.'));

  assert.equal(service.hasCredential(), false);
  assert.equal((await service.signOut()).state, 'signed_out');
  reads.busy = false;
  clock.ms += 1000;

  assert.equal(service.hasCredential(), false);
  assert.equal(service.getStatus().state, 'signed_out');
  assert.equal(label((await settle(service.getAccessToken({ force: true }))).value), 'empty');
});

// The loopback callback listener without a socket: listen() reports listening
// and close() completes, so a sign-in can sit in connecting with its link.
function fakeCallbackListener(t) {
  const realCreateServer = http.createServer;
  http.createServer = () => Object.assign(new EventEmitter(), {
    listening: false,
    listen(_port, _host) { this.listening = true; setImmediate(() => this.emit('listening')); },
    close(callback) { this.listening = false; callback?.(); },
  });
  t.after(() => { http.createServer = realCreateServer; });
}

test('a credential file recovering during a sign-in keeps connecting, its link and cancellation', async (t) => {
  const { filePath, store } = createStore();
  const { clock, reads } = freshProcessStore(t, store, filePath);
  fakeCallbackListener(t);
  let openedUrl = '';
  const service = createChatGptAuthService({
    secureStore: store,
    now: () => NOW_MS,
    logger: (...args) => observedLogs.push(args),
    listenPorts: [1455],
    openExternal: (url) => { openedUrl = url; },
    fetchImpl: async () => assert.fail('A pending sign-in must not refresh or exchange.'),
  });

  assert.equal(service.getStatus().state, 'signed_out');
  const startPromise = service.start({ timeoutMs: 5000 });
  for (let tick = 0; !openedUrl && tick < 100; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(openedUrl, 'the sign-in opens its authorize link');
  assert.equal(service.getPendingAuthorizeUrl(), openedUrl);

  reads.busy = false;
  clock.ms += 1000;
  assert.equal(service.getStatus().state, 'connecting', 'a recovered credential must not overwrite connecting');
  assert.equal(service.getPendingAuthorizeUrl(), openedUrl);

  service.cancel();
  assert.equal((await startPromise).state, 'signed_out');
  assert.equal(service.getStatus().state, 'signed_in', 'loading stays retryable once the flow settles');
  assert.equal(label((await settle(service.getAccessToken())).value), 'A0');
});

test('storage-failure logs and errors never contain a token value', () => {
  const serialized = JSON.stringify({ observedLogs, observedErrors });
  for (const secret of [...REFRESH, ...ACCESS, 'placeholder']) {
    assert.equal(serialized.includes(secret), false);
  }
});
