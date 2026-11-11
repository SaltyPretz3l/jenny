'use strict';

// The team host key store (slice 1f-2) on its own: the status check refuses a
// store that is not ready even when its get and set would work, a stored key
// is returned and never replaced, and a new one is saved before it is handed out.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { SecureStore } = require('../services/backend/secure-store');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { HOST_KEY_NAME, createHostKeyStore } = require('../services/team/host/host-key-store');
const { tempProfile } = require('./helpers/team-client-host');

// A store whose get and set work whatever its status says: only the status check can refuse it.
function lenientStore(ready) {
  const values = new Map();
  const sets = [];
  return { values, sets, getStatus: () => ({ ready }), get: (key) => values.get(key) || '',
    set: (key, value) => { sets.push(key); values.set(key, value); }, delete: (key) => values.delete(key) };
}

function assertUnavailable(fn, reason = 'team_host_key_unavailable') {
  assert.throws(fn, (error) => error.code === TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE && error.reason === reason);
}

test('a store that is not ready is refused even when get and set would work', () => {
  const store = lenientStore(false);
  store.values.set(HOST_KEY_NAME, crypto.randomBytes(32).toString('base64url'));
  const keys = createHostKeyStore({ getSecureStore: () => store });
  assertUnavailable(() => keys.load());
  assertUnavailable(() => keys.loadOrCreate());
  assert.deepEqual(store.sets, []);
});

test('loadOrCreate returns the stored key and never writes over it', () => {
  const store = lenientStore(true);
  const stored = crypto.randomBytes(32);
  store.values.set(HOST_KEY_NAME, stored.toString('base64url'));
  const keys = createHostKeyStore({ getSecureStore: () => store });
  const { seed, created } = keys.loadOrCreate();
  assert.equal(created, false);
  assert.deepEqual(seed, stored);
  assert.deepEqual(store.sets, []);
});

test('loadOrCreate saves a new key once and later calls return it', () => {
  const store = lenientStore(true);
  const keys = createHostKeyStore({ getSecureStore: () => store });
  const first = keys.loadOrCreate();
  assert.equal(first.created, true);
  assert.equal(store.values.get(HOST_KEY_NAME), first.seed.toString('base64url'));
  const second = keys.loadOrCreate();
  assert.equal(second.created, false);
  assert.deepEqual(second.seed, first.seed);
  assert.deepEqual(store.sets, [HOST_KEY_NAME]);
});

test('loadOrCreate reads the secure store once', () => {
  const store = lenientStore(true);
  store.values.set(HOST_KEY_NAME, crypto.randomBytes(32).toString('base64url'));
  let reads = 0;
  const get = store.get;
  store.get = (name) => { reads += 1; return get(name); };
  createHostKeyStore({ getSecureStore: () => store }).loadOrCreate();
  assert.equal(reads, 1);
});

test('an undecodable stored key is refused and left as it is', () => {
  const store = lenientStore(true);
  store.values.set(HOST_KEY_NAME, 'short');
  const keys = createHostKeyStore({ getSecureStore: () => store });
  assertUnavailable(() => keys.loadOrCreate(), 'team_host_key_invalid');
  assert.equal(store.values.get(HOST_KEY_NAME), 'short');
  assert.deepEqual(store.sets, []);
});

test('a set that throws hands out no key', () => {
  const store = lenientStore(true);
  store.set = () => { throw new Error('disk full'); };
  const keys = createHostKeyStore({ getSecureStore: () => store });
  assertUnavailable(() => keys.loadOrCreate());
  assert.equal(keys.load(), null);
});

test('the real SecureStore keeps the host key name (no purge) and refuses on basic_text', (t) => {
  const dir = tempProfile(t, 'jenny-host-key-');
  const safeStorage = (backend) => ({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`e:${s}`),
    decryptString: (b) => b.toString().slice(2), getSelectedStorageBackend: () => backend });
  const ready = new SecureStore({ filePath: path.join(dir, 'a.json'), safeStorage: safeStorage('dpapi'), isSafeStorageReady: () => true });
  const keys = createHostKeyStore({ getSecureStore: () => ready });
  const { seed } = keys.loadOrCreate();
  assert.deepEqual(ready.purgeRetiredSecrets(), []);
  assert.deepEqual(keys.load(), seed);
  const basic = new SecureStore({ filePath: path.join(dir, 'b.json'), safeStorage: safeStorage('basic_text'), isSafeStorageReady: () => true });
  assertUnavailable(() => createHostKeyStore({ getSecureStore: () => basic }).loadOrCreate());
});
