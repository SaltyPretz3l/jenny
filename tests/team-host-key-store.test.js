'use strict';

// The team host key store (slice 1f-2) on its own: the status check refuses a
// store that is not ready even when its get and set would work, a stored key
// is returned by load, and a new one is saved before it is handed out. Owner
// decision E75 (2026-11-14): `create` always makes a fresh key and writes it
// over whatever is stored, without reading it; no key is ever adopted.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');

const { SecureStore } = require('../services/backend/secure-store');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { HOST_KEY_NAME, HOST_RELAY_TOKEN_NAME, createHostKeyStore, createHostRelayTokenStore } = require('../services/team/host/host-key-store');
const { createDeviceKeyStore } = require('../services/team/device-key-store');
const { createMemorySecureStore, tempProfile } = require('./helpers/team-client-host');

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
  assertUnavailable(() => keys.create());
  assert.deepEqual(store.sets, []);
});

// A store that counts its reads: `create` never reads the key it replaces.
function countingReads(store) {
  const counted = { reads: 0 };
  const get = store.get;
  store.get = (name) => { counted.reads += 1; return get(name); };
  return counted;
}

test('E75: create makes a fresh key and writes it over a stored one without reading it', () => {
  const store = lenientStore(true);
  const stored = crypto.randomBytes(32);
  store.values.set(HOST_KEY_NAME, stored.toString('base64url'));
  const counted = countingReads(store);
  const keys = createHostKeyStore({ getSecureStore: () => store });
  const seed = keys.create();
  assert.equal(counted.reads, 0, 'the old key is never read');
  assert.equal(seed.length, 32);
  assert.notDeepEqual(seed, stored);
  assert.equal(store.values.get(HOST_KEY_NAME), seed.toString('base64url'));
  assert.deepEqual(store.sets, [HOST_KEY_NAME]);
  const again = keys.create();
  assert.notDeepEqual(again, seed, 'every create is a new key');
  assert.deepEqual(keys.load(), again);
});

test('E75: create replaces an undecodable stored key, which load still refuses', () => {
  const store = lenientStore(true);
  store.values.set(HOST_KEY_NAME, 'short');
  const keys = createHostKeyStore({ getSecureStore: () => store });
  assertUnavailable(() => keys.load(), 'team_host_key_invalid');
  assert.equal(store.values.get(HOST_KEY_NAME), 'short');
  const seed = keys.create();
  assert.deepEqual(keys.load(), seed);
});

test('a set that throws hands out no key', () => {
  const store = lenientStore(true);
  store.set = () => { throw new Error('disk full'); };
  const keys = createHostKeyStore({ getSecureStore: () => store });
  assertUnavailable(() => keys.create());
  assert.equal(keys.load(), null);
});

test('the real SecureStore keeps the host key name (no purge) and refuses on basic_text', (t) => {
  const dir = tempProfile(t, 'jenny-host-key-');
  const safeStorage = (backend) => ({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`e:${s}`),
    decryptString: (b) => b.toString().slice(2), getSelectedStorageBackend: () => backend });
  const ready = new SecureStore({ filePath: path.join(dir, 'a.json'), safeStorage: safeStorage('dpapi'), isSafeStorageReady: () => true });
  const keys = createHostKeyStore({ getSecureStore: () => ready });
  const seed = keys.create();
  assert.deepEqual(ready.purgeRetiredSecrets(), []);
  assert.deepEqual(keys.load(), seed);
  const basic = new SecureStore({ filePath: path.join(dir, 'b.json'), safeStorage: safeStorage('basic_text'), isSafeStorageReady: () => true });
  assertUnavailable(() => createHostKeyStore({ getSecureStore: () => basic }).create());
});

// The host's own relay token (the owner's relay), beside the host key.

test('the host relay token: save, load and remove under one name with no team id', () => {
  const store = createMemorySecureStore();
  const tokens = createHostRelayTokenStore({ getSecureStore: () => store });
  assert.equal(HOST_RELAY_TOKEN_NAME, 'team_host_relay_token');
  assert.equal(tokens.load(), null, 'none stored');
  tokens.save('owner-relay-token');
  assert.deepEqual([...store.values.keys()], [HOST_RELAY_TOKEN_NAME]);
  assert.equal(tokens.load(), 'owner-relay-token');
  tokens.remove();
  assert.equal(tokens.load(), null);
});

test('the host relay token refuses a store that is not ready or on basic_text, a bad token, and a bad stored value', () => {
  for (const status of ['unavailable', 'basic_text']) {
    const store = createMemorySecureStore({ status });
    const tokens = createHostRelayTokenStore({ getSecureStore: () => store });
    for (const call of [() => tokens.save('owner-relay-token'), () => tokens.load(), () => tokens.remove()]) {
      assertUnavailable(call, 'team_relay_token_unavailable');
    }
    assert.deepEqual(store.sets, [], status);
  }
  const lenient = lenientStore(true);
  lenient.getStatus = () => ({ ready: true, storageBackend: 'basic_text' });
  assertUnavailable(() => createHostRelayTokenStore({ getSecureStore: () => lenient }).save('owner-relay-token'),
    'team_relay_token_unavailable');
  assert.deepEqual(lenient.sets, [], 'a ready store on basic_text is refused too');
  const store = createMemorySecureStore();
  const tokens = createHostRelayTokenStore({ getSecureStore: () => store });
  for (const bad of ['', 'has space', 7, null, 'x'.repeat(49)]) assertUnavailable(() => tokens.save(bad), 'team_relay_token_unavailable');
  assert.deepEqual(store.sets, []);
  store.values.set(HOST_RELAY_TOKEN_NAME, 'not a token');
  assertUnavailable(() => tokens.load(), 'team_relay_token_unavailable');
  assert.equal(store.values.get(HOST_RELAY_TOKEN_NAME), 'not a token', 'refused, never deleted');
  assert.deepEqual(store.deletes, []);
});

test('removing a membership leaves the host relay token', () => {
  const store = createMemorySecureStore();
  const teamId = `team_${'a'.repeat(26)}`;
  const devices = createDeviceKeyStore({ getSecureStore: () => store });
  devices.save(teamId, crypto.randomBytes(32));
  createHostRelayTokenStore({ getSecureStore: () => store }).save('owner-relay-token');
  devices.remove(teamId);
  assert.equal(store.values.get(HOST_RELAY_TOKEN_NAME), 'owner-relay-token');
  assert.equal(store.deletes.includes(HOST_RELAY_TOKEN_NAME), false);
});
