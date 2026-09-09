'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SecureStore } = require('../services/backend/secure-store');
const remoteCrypto = require('../services/remote/remote-crypto');
const { createDeviceStore } = require('../services/remote/remote-device-store');
const { MAX_DEVICES } = require('../services/remote/remote-limits');

const directories = new Set();

test.afterEach(() => {
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

function createSafeStorageStub() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(String(value), 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8'),
  };
}

function createSecureStoreFixture({ isSafeStorageReady = () => true, filePath } = {}) {
  let targetPath = filePath;
  if (!targetPath) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-remote-device-store-'));
    directories.add(directory);
    targetPath = path.join(directory, 'secure-state.json');
  }
  return {
    filePath: targetPath,
    secureStore: new SecureStore({
      filePath: targetPath,
      safeStorage: createSafeStorageStub(),
      isSafeStorageReady,
    }),
  };
}

function createStore(secureStore, { time = 10_000, limits = { MAX_DEVICES } } = {}) {
  return createDeviceStore({ secureStore, now: () => time, limits });
}

function device(index, pairedAt = 10_000) {
  const bytes = new Uint8Array(16);
  bytes[15] = index + 1;
  return {
    device_id: remoteCrypto.toBase64Url(bytes),
    label: `Phone ${index + 1}`,
    device_secret: new Uint8Array(32).fill(index + 1),
    paired_at: pairedAt,
  };
}

test('fresh load creates and persists the exact version-one record without projecting secrets', async () => {
  const fixture = createSecureStoreFixture();
  const store = createStore(fixture.secureStore);
  assert.deepEqual(await store.load(), { ok: true, created: true });
  const record = store.getRecord();
  assert.deepEqual(Object.keys(record), [
    'record_version', 'desktop_id', 'devices', 'shared_sessions', 'relay_url',
  ]);
  assert.equal(record.record_version, 1);
  assert.match(record.desktop_id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(store.desktopSecret().byteLength, 32);
  const firstCopy = store.desktopSecret();
  firstCopy.fill(0);
  assert.notDeepEqual(store.desktopSecret(), firstCopy);
  assert.equal(fixture.secureStore.hasRemoteControlRecord(), true);
});

test('record round-trips through a real SecureStore', async () => {
  const fixture = createSecureStoreFixture();
  const first = createStore(fixture.secureStore);
  await first.load();
  const added = device(0);
  assert.deepEqual(await first.addDevice(added), { ok: true });
  assert.deepEqual(await first.shareSession('session-1'), { ok: true });
  assert.deepEqual(await first.setRelayUrl('wss://a.b.workers.dev'), { ok: true });

  const secondSecureStore = createSecureStoreFixture({ filePath: fixture.filePath }).secureStore;
  const second = createStore(secondSecureStore);
  assert.deepEqual(await second.load(), { ok: true, created: false });
  assert.equal(second.isDeviceTrusted(added.device_id), true);
  assert.deepEqual(second.deviceSecret(added.device_id), added.device_secret);
  assert.equal(second.getRecord().relay_url, 'wss://a.b.workers.dev');
  assert.deepEqual(second.getRecord().shared_sessions, ['session-1']);
});

test('unavailable safeStorage fails closed and blocks mutation', async () => {
  const fixture = createSecureStoreFixture({ isSafeStorageReady: () => false });
  const store = createStore(fixture.secureStore);
  assert.deepEqual(await store.load(), { ok: false, reason: 'secure_store_error' });
  assert.deepEqual(await store.setRelayUrl('wss://a.b.workers.dev'), {
    ok: false, reason: 'store_not_loaded',
  });
  assert.deepEqual(await store.addDevice(device(0)), { ok: false, reason: 'store_not_loaded' });
});

test('corrupt JSON and future record versions fail closed and block mutations', async () => {
  const corruptFixture = createSecureStoreFixture();
  fs.writeFileSync(corruptFixture.filePath, JSON.stringify({
    'remote_control:record': {
      encrypted: true,
      value: Buffer.from('{not-json', 'utf8').toString('base64'),
      secretType: 'remote_control_record',
    },
  }), 'utf8');
  const corruptStore = createStore(corruptFixture.secureStore);
  assert.deepEqual(await corruptStore.load(), { ok: false, reason: 'record_malformed' });
  assert.deepEqual(await corruptStore.shareSession('session-1'), {
    ok: false, reason: 'store_not_loaded',
  });

  const futureFixture = createSecureStoreFixture();
  futureFixture.secureStore.setRemoteControlRecord({ record_version: 2 });
  const futureStore = createStore(futureFixture.secureStore);
  assert.deepEqual(await futureStore.load(), {
    ok: false, reason: 'record_version_unsupported',
  });
  assert.deepEqual(await futureStore.setRelayUrl('wss://a.b.workers.dev'), {
    ok: false, reason: 'store_not_loaded',
  });
});

test('relay URL validation accepts only a credential-free wss origin', async () => {
  const fixture = createSecureStoreFixture();
  const store = createStore(fixture.secureStore);
  await store.load();
  assert.deepEqual(await store.setRelayUrl('wss://a.b.workers.dev'), { ok: true });
  assert.equal(store.getRecord().relay_url, 'wss://a.b.workers.dev');
  assert.deepEqual(await store.setRelayUrl('wss://h:8443'), { ok: true });
  assert.equal(store.getRecord().relay_url, 'wss://h:8443');
  assert.deepEqual(await store.setRelayUrl('wss://h:443'), { ok: true });
  assert.equal(store.getRecord().relay_url, 'wss://h');
  assert.deepEqual(await store.setRelayUrl('wss://xn--bcher-kva.example'), { ok: true });
  assert.equal(store.getRecord().relay_url, 'wss://xn--bcher-kva.example');
  for (const url of [
    'ws://a.b.workers.dev',
    'https://a.b.workers.dev',
    'wss://u:p@h',
    'wss://h/path?x',
    'wss://h/#f',
    'wss://h.',
    'wss://h/path/..',
    'wss://h\t',
  ]) {
    assert.deepEqual(await store.setRelayUrl(url), { ok: false, reason: 'relay_url_invalid' });
  }
});

test('addDevice enforces MAX_DEVICES', async () => {
  const fixture = createSecureStoreFixture();
  const store = createStore(fixture.secureStore);
  await store.load();
  for (let index = 0; index < MAX_DEVICES; index += 1) {
    assert.deepEqual(await store.addDevice(device(index)), { ok: true });
  }
  assert.deepEqual(await store.addDevice(device(MAX_DEVICES)), {
    ok: false, reason: 'device_limit',
  });
});

test('revocation removes trust immediately and persists the removal', async () => {
  const fixture = createSecureStoreFixture();
  const store = createStore(fixture.secureStore);
  await store.load();
  const added = device(0);
  await store.addDevice(added);
  assert.deepEqual(await store.revokeDevice(added.device_id), { ok: true });
  assert.equal(store.isDeviceTrusted(added.device_id), false);

  const reloaded = createStore(createSecureStoreFixture({ filePath: fixture.filePath }).secureStore);
  assert.deepEqual(await reloaded.load(), { ok: true, created: false });
  assert.equal(reloaded.isDeviceTrusted(added.device_id), false);
});

test('failed revocation persistence keeps the device removed in memory', async () => {
  const fixture = createSecureStoreFixture();
  const store = createStore(fixture.secureStore);
  await store.load();
  const added = device(0);
  await store.addDevice(added);
  fixture.secureStore.setRemoteControlRecord = () => {
    throw new Error('simulated write failure');
  };
  assert.deepEqual(await store.revokeDevice(added.device_id), {
    ok: false, reason: 'revocation_not_saved',
  });
  assert.equal(store.isDeviceTrusted(added.device_id), false);
  assert.equal(store.deviceSecret(added.device_id), null);
});

test('a failed pending write cannot roll back over a synchronous revocation', async () => {
  const fixture = createSecureStoreFixture();
  const store = createStore(fixture.secureStore, { time: 20_000 });
  await store.load();
  const added = device(0);
  await store.addDevice(added);

  const originalSet = fixture.secureStore.setRemoteControlRecord.bind(fixture.secureStore);
  let rejectTouch;
  let signalTouch;
  const touchStarted = new Promise((resolve) => { signalTouch = resolve; });
  fixture.secureStore.setRemoteControlRecord = (record) => {
    if (!rejectTouch) {
      signalTouch();
      return new Promise((_resolve, reject) => { rejectTouch = reject; });
    }
    return originalSet(record);
  };

  const touching = store.touchDevice(added.device_id);
  await touchStarted;
  const revoking = store.revokeDevice(added.device_id);
  assert.equal(store.isDeviceTrusted(added.device_id), false);
  assert.equal(store.deviceSecret(added.device_id), null);
  rejectTouch(new Error('simulated touch write failure'));
  assert.deepEqual(await touching, { ok: false, reason: 'secure_store_error' });
  assert.deepEqual(await revoking, { ok: true });
  assert.deepEqual(await store.save(), { ok: true });

  const persisted = fixture.secureStore.getRemoteControlRecord();
  assert.deepEqual(persisted.devices, []);
  const reloaded = createStore(createSecureStoreFixture({ filePath: fixture.filePath }).secureStore);
  assert.deepEqual(await reloaded.load(), { ok: true, created: false });
  assert.equal(reloaded.isDeviceTrusted(added.device_id), false);
});

test('forgetAll deletes the record and blocks mutations until reload', async () => {
  const fixture = createSecureStoreFixture();
  const store = createStore(fixture.secureStore);
  await store.load();
  await store.addDevice(device(0));
  assert.deepEqual(await store.forgetAll(), { ok: true });
  assert.equal(fixture.secureStore.hasRemoteControlRecord(), false);
  assert.equal(store.getRecord(), null);
  assert.deepEqual(await store.shareSession('session-1'), {
    ok: false, reason: 'store_not_loaded',
  });
  assert.deepEqual(await store.load(), { ok: true, created: true });
  assert.equal(store.getRecord().devices.length, 0);
});

test('failed forgetAll stays unloaded and a retry attempts deletion again', async () => {
  const fixture = createSecureStoreFixture();
  const store = createStore(fixture.secureStore);
  await store.load();
  const added = device(0);
  await store.addDevice(added);
  const originalDelete = fixture.secureStore.deleteRemoteControlRecord.bind(fixture.secureStore);
  let deleteAttempts = 0;
  fixture.secureStore.deleteRemoteControlRecord = () => {
    deleteAttempts += 1;
    if (deleteAttempts === 1) throw new Error('simulated delete failure');
    return originalDelete();
  };

  const forgetting = store.forgetAll();
  assert.equal(store.isDeviceTrusted(added.device_id), false);
  assert.equal(store.deviceSecret(added.device_id), null);
  assert.equal(store.desktopSecret(), null);
  assert.equal(store.getRecord(), null);
  assert.deepEqual(await forgetting, { ok: false, reason: 'forget_not_deleted' });
  assert.equal(fixture.secureStore.hasRemoteControlRecord(), true);
  assert.deepEqual(await store.shareSession('session-1'), {
    ok: false, reason: 'store_not_loaded',
  });

  assert.deepEqual(await store.forgetAll(), { ok: true });
  assert.equal(deleteAttempts, 2);
  assert.equal(fixture.secureStore.hasRemoteControlRecord(), false);
});

test('shared sessions are bounded in count and id length', async () => {
  const { secureStore } = createSecureStoreFixture();
  const store = createStore(secureStore);
  assert.equal((await store.load()).ok, true);
  assert.deepEqual(await store.shareSession('x'.repeat(129)), { ok: false, reason: 'session_id_invalid' });
  for (let index = 0; index < 64; index += 1) {
    assert.equal((await store.shareSession(`session_${index}`)).ok, true);
  }
  assert.deepEqual(await store.shareSession('session_overflow'), { ok: false, reason: 'shared_sessions_limit' });
  assert.equal((await store.shareSession('session_0')).ok, true);
  assert.equal(store.getRecord().shared_sessions.length, 64);
  const reloaded = createStore(secureStore);
  assert.equal((await reloaded.load()).ok, true);
  assert.equal(reloaded.getRecord().shared_sessions.length, 64);
});
