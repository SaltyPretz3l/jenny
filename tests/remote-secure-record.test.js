const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  SECRET_TYPE_REMOTE_CONTROL,
  SecureStore,
  remoteControlRecordKeyName,
} = require('../services/backend/secure-store');
const { cleanupJennyData } = require('../services/data-lifecycle/cleanup-service');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createSecureStoreFixture({
  isEncryptionAvailable = true,
  decryptString,
  seed,
} = {}) {
  const tempDir = createTrackedTempDir('jenny-remote-secure-record-');
  const filePath = path.join(tempDir, 'secure-state.json');
  if (seed) fs.writeFileSync(filePath, JSON.stringify(seed), 'utf8');
  let decryptCalls = 0;
  const store = new SecureStore({
    filePath,
    isSafeStorageReady: () => true,
    safeStorage: {
      isEncryptionAvailable: () => isEncryptionAvailable,
      encryptString: (value) => Buffer.from(value, 'utf8'),
      decryptString: (value) => {
        decryptCalls += 1;
        return decryptString
          ? decryptString(value)
          : Buffer.from(value).toString('utf8');
      },
    },
  });
  return { filePath, store, getDecryptCalls: () => decryptCalls };
}

test('remote control record round-trips as encrypted JSON with its secret type', () => {
  const { filePath, store } = createSecureStoreFixture();
  const record = {
    record_version: 1,
    desktop_id: 'desktop-1',
    devices: [{ device_id: 'phone-1' }],
    shared_sessions: ['session-1'],
    relay_url: 'wss://relay.example.test',
  };

  assert.equal(remoteControlRecordKeyName(), 'remote_control:record');
  store.setRemoteControlRecord(record);
  assert.deepEqual(store.getRemoteControlRecord(), record);

  const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'))['remote_control:record'];
  assert.equal(persisted.encrypted, true);
  assert.equal(persisted.secretType, SECRET_TYPE_REMOTE_CONTROL);
});

test('remote control presence checks never decrypt the record', () => {
  const { store, getDecryptCalls } = createSecureStoreFixture();
  store.setRemoteControlRecord({ record_version: 1 });

  assert.equal(store.hasRemoteControlRecord(), true);
  assert.equal(getDecryptCalls(), 0);
});

test('remote control record validation rejects invalid shapes and versions', () => {
  const { store } = createSecureStoreFixture();
  for (const record of [null, [], 'record', {}, { record_version: 0 }, { record_version: 1.5 }]) {
    assert.throws(
      () => store.setRemoteControlRecord(record),
      /^Error: SecureStore: remote control record invalid\.$/
    );
  }
});

test('remote control record validation rejects serialized values over 64 KiB', () => {
  const { store } = createSecureStoreFixture();
  assert.throws(
    () => store.setRemoteControlRecord({ record_version: 1, payload: 'x'.repeat(64 * 1024) }),
    /remote control record invalid/
  );
});

test('corrupt remote control JSON warns, is removed, and reads as null', () => {
  const key = remoteControlRecordKeyName();
  const { filePath, store } = createSecureStoreFixture({
    seed: {
      [key]: {
        encrypted: true,
        value: Buffer.from('{not-json', 'utf8').toString('base64'),
      },
    },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(store.getRemoteControlRecord(), null);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid remote control record/);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8'))[key], undefined);
});

test('remote control record writes fail closed when encryption is unavailable', () => {
  const { filePath, store } = createSecureStoreFixture({ isEncryptionAvailable: false });
  assert.throws(
    () => store.setRemoteControlRecord({ record_version: 1 }),
    /encryption unavailable/
  );
  assert.equal(fs.existsSync(filePath), false);
});

test('remote control record deletion clears its presence marker', () => {
  const { store } = createSecureStoreFixture();
  store.setRemoteControlRecord({ record_version: 1 });
  store.deleteRemoteControlRecord();
  assert.equal(store.hasRemoteControlRecord(), false);
});

test('data cleanup invokes the remote control secure-record deletion path', async () => {
  let deleteCalls = 0;
  const result = await cleanupJennyData({
    includeUserData: false,
    secureStore: {
      deleteRemoteControlRecord() {
        deleteCalls += 1;
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(deleteCalls, 1);
  assert.deepEqual(result.results, [{
    kind: 'remote_control',
    name: 'remote control pairing record',
    status: 'removed',
  }]);
});

test('remote control record reads fail closed when encryption is unavailable', () => {
  const key = remoteControlRecordKeyName();
  const { store } = createSecureStoreFixture({
    isEncryptionAvailable: false,
    seed: {
      [key]: {
        encrypted: true,
        secretType: SECRET_TYPE_REMOTE_CONTROL,
        value: Buffer.from('{"record_version":1}', 'utf8').toString('base64'),
      },
    },
  });
  assert.throws(() => store.getRemoteControlRecord(), /encryption unavailable/);
});

test('data cleanup validates its filesystem targets before touching the pairing record', async () => {
  let deleteCalls = 0;
  await assert.rejects(cleanupJennyData({
    secureStore: {
      deleteRemoteControlRecord() {
        deleteCalls += 1;
      },
    },
  }));
  assert.equal(deleteCalls, 0);
});

test('a malformed or unencrypted envelope still counts as present so loads fail closed', () => {
  const key = remoteControlRecordKeyName();
  const { store } = createSecureStoreFixture({
    seed: { [key]: { encrypted: false, value: 'corrupt' } },
  });
  assert.equal(store.hasRemoteControlRecord(), true);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    assert.equal(store.getRemoteControlRecord(), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(store.hasRemoteControlRecord(), false);
});
