'use strict';

// The member device key store (slice 1f-1) over the app's real SecureStore with a
// fake safeStorage: one Ed25519 seed per team under a team-owned key name, only
// through the generic get/set/delete, and CMP-TEAM-0004 with nothing written when
// the store is not ready, unavailable or on basic_text.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { SecureStore } = require('../services/backend/secure-store');
const { TEAM_ERROR_CODES } = require('../services/backend/error-codes');
const { createDeviceKeyStore, deviceKeyName } = require('../services/team/device-key-store');
const { deriveTeamId, keyPairFromSeed } = require('../server/team/ids');
const { tempProfile } = require('./helpers/team-client-host');

const TEAM_ID = deriveTeamId(keyPairFromSeed(crypto.createHash('sha256').update('host').digest()).publicKey);

function fakeSafeStorage({ backend = 'dpapi', available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
    decryptString: (buffer) => Buffer.from(buffer.toString().slice(4), 'base64').toString(),
    getSelectedStorageBackend: () => backend,
  };
}

function setup(t, { backend, available, ready = true } = {}) {
  const dir = tempProfile(t, 'jenny-team-keys-');
  const filePath = path.join(dir, 'credentials.json');
  const secureStore = new SecureStore({ filePath, safeStorage: fakeSafeStorage({ backend, available }),
    isSafeStorageReady: () => ready });
  return { dir, filePath, secureStore, keys: createDeviceKeyStore({ getSecureStore: () => secureStore }) };
}

function assertKeyUnavailable(fn) {
  assert.throws(fn, (error) => error.code === TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE
    && /^team_device_key_/.test(error.reason));
}

test('the secure store neither purges nor rejects an unknown key name', (t) => {
  const { secureStore } = setup(t);
  const name = deviceKeyName(TEAM_ID);
  secureStore.set(name, 'value-1');
  assert.deepEqual(secureStore.purgeRetiredSecrets(), []);
  assert.deepEqual(secureStore.purgeOrphanModelProviderApiKeys([]), []);
  assert.equal(secureStore.get(name), 'value-1');
});

test('save, load and remove one seed per team through the generic calls', (t) => {
  const { secureStore, keys, filePath } = setup(t);
  const seed = crypto.randomBytes(32);
  keys.save(TEAM_ID, seed);
  assert.equal(secureStore.get(deviceKeyName(TEAM_ID)), seed.toString('base64url'));
  assert.equal(fs.readFileSync(filePath, 'utf8').includes(seed.toString('base64url')), false, 'stored encrypted');
  assert.deepEqual(Buffer.from(keys.load(TEAM_ID)), seed);
  const other = deriveTeamId(keyPairFromSeed(crypto.randomBytes(32)).publicKey);
  assert.equal(keys.load(other), null);
  keys.remove(TEAM_ID);
  assert.equal(keys.load(TEAM_ID), null);
  assert.equal(keys.available(), true);
});

test('the key name is built from a validated team id only', () => {
  assert.equal(deviceKeyName(TEAM_ID), `team_device_key:${TEAM_ID}`);
  for (const bad of ['', 'team_', 'team_a/b', '../x', `team_${'a'.repeat(65)}`, null, 7]) {
    assert.throws(() => deviceKeyName(bad), TypeError);
  }
});

test('a seed that is not 32 bytes is refused before the store is touched', (t) => {
  const { keys, filePath } = setup(t);
  assert.throws(() => keys.save(TEAM_ID, Buffer.alloc(31)), TypeError);
  assert.equal(fs.existsSync(filePath), false);
});

test('a corrupt stored value is CMP-TEAM-0004, never a fresh key', (t) => {
  const { secureStore, keys } = setup(t);
  secureStore.set(deviceKeyName(TEAM_ID), 'not-a-key');
  assertKeyUnavailable(() => keys.load(TEAM_ID));
});

for (const [name, options] of [
  ['basic_text', { backend: 'basic_text' }],
  ['not ready', { ready: false }],
  ['encryption unavailable', { available: false }],
]) {
  test(`a ${name} store is CMP-TEAM-0004 with nothing written anywhere`, (t) => {
    const { keys, dir } = setup(t, options);
    const seed = crypto.randomBytes(32);
    assertKeyUnavailable(() => keys.save(TEAM_ID, seed));
    assertKeyUnavailable(() => keys.load(TEAM_ID));
    assertKeyUnavailable(() => keys.remove(TEAM_ID));
    assert.equal(keys.available(), false);
    assert.deepEqual(fs.readdirSync(dir), [], 'no credential file, no plaintext file');
    for (const value of Object.values(process.env)) assert.equal(value.includes(seed.toString('base64url')), false);
  });
}

test('a missing secure store is CMP-TEAM-0004, and the error message carries no seed', () => {
  const keys = createDeviceKeyStore({ getSecureStore: () => null });
  const seed = crypto.randomBytes(32);
  try {
    keys.save(TEAM_ID, seed);
    assert.fail('save must throw');
  } catch (error) {
    assert.equal(error.code, TEAM_ERROR_CODES.DEVICE_KEY_UNAVAILABLE);
    assert.equal(String(error.message).includes(seed.toString('base64url')), false);
  }
});

test('a store whose set throws is CMP-TEAM-0004 and nothing is kept in memory', () => {
  const values = new Map();
  const store = {
    getStatus: () => ({ ready: true }),
    get: (key) => values.get(key) || '',
    set: () => { throw new Error('disk full'); },
    delete: (key) => values.delete(key),
  };
  const keys = createDeviceKeyStore({ getSecureStore: () => store });
  assertKeyUnavailable(() => keys.save(TEAM_ID, crypto.randomBytes(32)));
  assert.equal(keys.load(TEAM_ID), null);
});
