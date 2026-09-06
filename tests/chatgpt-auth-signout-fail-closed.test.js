'use strict';

/**
 * H2a — fail-closed sign-out + the ChatGPT chat-turn admission gate.
 *
 * Pins two invariants that used to be silently violated:
 *  1. a secure-store delete failure left the in-memory credential LIVE, so the
 *     app kept talking to ChatGPT after the user signed out;
 *  2. nothing stopped a new chat turn from being admitted while the running
 *     sidecar still held the credential generation that was just revoked.
 */

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { createChatGptAuthService } = require('../services/backend/chatgpt-auth-service');
const { assertChatTurnAdmissible } = require('../services/backend/chat-turn-admission');
const { SecureStore } = require('../services/backend/secure-store');

const NOW_MS = Date.parse('2026-07-17T12:00:00.000Z');
const FAKE_REFRESH_TOKEN = 'fake-refresh-token-super-secret';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createSafeStorageStub() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(String(value), 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8'),
  };
}

function createStore(prefix) {
  const tempDir = createTrackedTempDir(prefix);
  return new SecureStore({
    filePath: path.join(tempDir, 'secure-state.json'),
    safeStorage: createSafeStorageStub(),
    isSafeStorageReady: () => true,
    nowProvider: () => new Date(NOW_MS),
  });
}

function encodeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

function createAccessToken(expMs = NOW_MS + 60 * 60 * 1000) {
  return encodeJwt({ exp: Math.floor(expMs / 1000) });
}

function createRecord(overrides = {}) {
  return JSON.stringify({
    refresh_token: FAKE_REFRESH_TOKEN,
    id_token: encodeJwt({ email: 'jenny@example.com' }),
    access_token: createAccessToken(),
    account_id: 'account-123',
    plan_type: 'plus',
    email: 'jenny@example.com',
    last_refresh_ms: NOW_MS,
    ...overrides,
  });
}

// Reads and writes reach the real encrypted store; only the delete fails, which
// is the exact production failure mode (keychain/DPAPI refusing the removal).
function failingDeleteStore(store, counters = {}) {
  return {
    getModelProviderOAuth: (...args) => store.getModelProviderOAuth(...args),
    setModelProviderOAuth(...args) {
      counters.sets = (counters.sets || 0) + 1;
      return store.setModelProviderOAuth(...args);
    },
    deleteModelProviderOAuth() {
      throw new Error('delete unavailable');
    },
  };
}

function createService(secureStore, overrides = {}) {
  return createChatGptAuthService({
    secureStore,
    openExternal: () => {},
    now: () => NOW_MS,
    logger: () => {},
    fetchImpl: async () => { throw new Error('unexpected token request'); },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fail-closed sign-out
// ---------------------------------------------------------------------------

test('a failed secure-store delete still clears the credential and bumps the epoch', async () => {
  const store = createStore('jenny-chatgpt-signout-storage-fail-');
  store.setModelProviderOAuth('chatgpt', createRecord());
  const service = createService(failingDeleteStore(store));
  assert.equal(service.getStatus().state, 'signed_in');
  const epochBefore = service.getCredentialEpoch();

  const status = await service.signOut();

  assert.equal(status.state, 'signed_out');
  assert.equal(status.error.code, 'storage_failed');
  assert.equal(status.email, '');
  assert.equal(service.getCachedAccessToken(), '');
  assert.equal(service.hasCredential(), false);
  assert.ok(
    service.getCredentialEpoch() > epochBefore,
    'the revocation clock must advance even when the delete failed'
  );
  assert.equal(service.getAccountId(), '');
});

test('an in-flight refresh cannot resurrect the record after a failed delete', async () => {
  const store = createStore('jenny-chatgpt-signout-refresh-race-');
  store.setModelProviderOAuth('chatgpt', createRecord());
  const counters = {};
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const service = createService(failingDeleteStore(store, counters), {
    async fetchImpl() {
      await fetchGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: createAccessToken(NOW_MS + 3 * 60 * 60 * 1000) }),
      };
    },
  });

  const refreshing = service.getAccessToken({ force: true });
  const status = await service.signOut();
  releaseFetch();
  const token = await refreshing;

  assert.equal(status.state, 'signed_out');
  assert.equal(status.error.code, 'storage_failed');
  assert.equal(token, '', 'the refresh result is discarded once the epoch moved');
  assert.equal(counters.sets || 0, 0, 'no write may re-persist the revoked credential');
  assert.equal(service.hasCredential(), false);
  assert.equal(service.getCachedAccessToken(), '');
});

test('permanentlyExpireAuth bumps the epoch so a concurrent refresh cannot re-persist', async () => {
  const store = createStore('jenny-chatgpt-permanent-expiry-');
  store.setModelProviderOAuth('chatgpt', createRecord());
  const counters = {};
  const instrumented = {
    getModelProviderOAuth: (...args) => store.getModelProviderOAuth(...args),
    deleteModelProviderOAuth: (...args) => store.deleteModelProviderOAuth(...args),
    setModelProviderOAuth(...args) {
      counters.sets = (counters.sets || 0) + 1;
      return store.setModelProviderOAuth(...args);
    },
  };
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  const service = createService(instrumented, {
    async fetchImpl() {
      await fetchGate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: createAccessToken(NOW_MS + 3 * 60 * 60 * 1000) }),
      };
    },
  });
  const refreshing = service.getAccessToken({ force: true });
  const epochBefore = service.getCredentialEpoch();

  await service.permanentlyExpireAuth();
  releaseFetch();

  assert.equal(await refreshing, '');
  assert.ok(service.getCredentialEpoch() > epochBefore);
  assert.equal(service.hasCredential(), false);
  assert.equal(counters.sets || 0, 0);
  assert.equal(store.getModelProviderOAuth('chatgpt'), '');
});

// ---------------------------------------------------------------------------
// Chat-turn admission gate
// ---------------------------------------------------------------------------

function authDouble({ credential = true, epoch = 1 } = {}) {
  return {
    hasCredential: () => credential,
    getCredentialEpoch: () => epoch,
  };
}

function refusesWithSetupError(error) {
  assert.equal(error.code, 'chatgpt_signed_out');
  assert.equal(error.error_code, 'CMP-AI-0002');
  assert.equal(error.category, 'setup');
  assert.equal(error.retryable, false);
  return true;
}

test('a stale runtime credential epoch refuses the chat turn as a setup error', () => {
  assert.throws(
    () => assertChatTurnAdmissible({
      currentEngineType: 'chatgpt',
      chatgptAuthService: authDouble({ credential: true, epoch: 4 }),
      // The sidecar was configured with generation 3; a sign-out has since
      // advanced the clock but the reconfiguration has not landed.
      _chatgptRuntimeCredentialEpoch: 3,
    }, 's1'),
    refusesWithSetupError
  );
});

test('a revoked credential refuses the chat turn even when the epoch matches', () => {
  assert.throws(
    () => assertChatTurnAdmissible({
      currentEngineType: 'chatgpt',
      chatgptAuthService: authDouble({ credential: false, epoch: 5 }),
      _chatgptRuntimeCredentialEpoch: 5,
    }, 's1'),
    refusesWithSetupError
  );
});

test('a live credential whose epoch matches the running sidecar admits the turn', () => {
  assertChatTurnAdmissible({
    currentEngineType: 'chatgpt',
    chatgptAuthService: authDouble({ credential: true, epoch: 5 }),
    _chatgptRuntimeCredentialEpoch: 5,
  }, 's1');
});

test('a non-chatgpt engine is never gated on the ChatGPT credential', () => {
  for (const engine of ['ollama', 'vllm', 'mock', '']) {
    assertChatTurnAdmissible({
      currentEngineType: engine,
      chatgptAuthService: authDouble({ credential: false, epoch: 9 }),
      _chatgptRuntimeCredentialEpoch: 1,
    }, 's1');
  }
});

test('an unwired or legacy auth service is never gated', () => {
  // No auth service at all (older composition).
  assertChatTurnAdmissible({ currentEngineType: 'chatgpt', chatgptAuthService: null }, 's1');
  // Present but without the H2a seam: not our gate.
  assertChatTurnAdmissible({
    currentEngineType: 'chatgpt',
    chatgptAuthService: { getStatus: () => ({ state: 'signed_in' }) },
  }, 's1');
});
