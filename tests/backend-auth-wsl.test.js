const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { BackendService } = require('../services/backend/backend-service');
const {
  getAuthState,
  restoreAuthState,
} = require('../services/backend/backend-auth');
const { collectServiceLogs } = require('./helpers/backend-service-helpers');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

const AUTOMATIC_LOCAL_STATE = {
  authenticated: true,
  user: {
    user_id: 'usr_local',
    email: 'local@jenny.local',
    display_name: 'Local User',
  },
};

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createUnavailableManagedAuthService({ storedUser = null } = {}) {
  const service = new EventEmitter();
  const setCalls = [];
  const deleteCalls = [];
  const logCalls = [];
  service.accessToken = '';
  service.refreshPromise = null;
  service.secureStore = {
    get(key) {
      return key === 'user_json' && storedUser ? JSON.stringify(storedUser) : '';
    },
    set(key, value) {
      setCalls.push({ key, value });
      throw new Error('credential storage is unavailable');
    },
    delete(key) {
      deleteCalls.push(key);
    },
    getStatus() {
      return {
        status: 'unavailable',
        storageBackend: 'basic_text',
      };
    },
  };
  service._emitServiceLog = (level, event, details) => {
    logCalls.push({ level, event, details });
  };
  service._setCalls = setCalls;
  service._deleteCalls = deleteCalls;
  service._logCalls = logCalls;
  return service;
}

test('managed restore activates the automatic local profile without credential writes', async () => {
  const service = createUnavailableManagedAuthService();

  assert.deepEqual(await restoreAuthState(service), AUTOMATIC_LOCAL_STATE);
  assert.deepEqual(await restoreAuthState(service), AUTOMATIC_LOCAL_STATE);
  assert.equal(service.accessToken, 'local-session');
  assert.deepEqual(service._setCalls, []);
  assert.deepEqual(service._deleteCalls, []);
  assert.deepEqual(service._logCalls, [{
    level: 'WARN',
    event: 'auth.local_profile_fallback',
    details: {
      credentialStoreStatus: 'unavailable',
      storageBackend: 'basic_text',
    },
  }]);
});

test('managed auth prefers a readable encrypted named profile', () => {
  const namedUser = {
    user_id: 'usr_named',
    email: 'named@example.com',
    display_name: 'Named User',
  };
  const service = createUnavailableManagedAuthService({ storedUser: namedUser });

  assert.deepEqual(getAuthState(service), {
    authenticated: true,
    user: namedUser,
  });
  assert.equal(service.accessToken, 'local-session');
  assert.deepEqual(service._setCalls, []);
  assert.deepEqual(service._logCalls, []);
});

test('BackendService restores automatic local auth with real SecureStore basic_text handling', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-wsl-auth-'));
  trackDirectory(userDataPath);
  const safeStorageCalls = { encrypt: 0, decrypt: 0 };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString() {
      safeStorageCalls.encrypt += 1;
      throw new Error('must not encrypt with basic_text');
    },
    decryptString() {
      safeStorageCalls.decrypt += 1;
      throw new Error('must not decrypt an absent profile');
    },
  };
  const service = new BackendService({
    userDataPath,
    safeStorage,
    isSafeStorageReady: () => true,
  });
  t.after(() => service.dispose());
  const serviceLogs = collectServiceLogs(service);

  assert.deepEqual(await service.restoreAuthState(), AUTOMATIC_LOCAL_STATE);
  assert.deepEqual(service.getAuthState(), AUTOMATIC_LOCAL_STATE);
  const credentialStatus = service.getBackendStatus().credentialStore;
  assert.equal(credentialStatus.status, 'unavailable');
  assert.equal(credentialStatus.ready, false);
  assert.equal(credentialStatus.encryptionAvailable, false);
  assert.equal(credentialStatus.storageBackend, 'basic_text');
  assert.deepEqual(safeStorageCalls, { encrypt: 0, decrypt: 0 });
  assert.equal(fs.existsSync(path.join(userDataPath, 'secure-state.json')), false);
  assert.equal(fs.existsSync(path.join(userDataPath, 'local-session.json')), false);
  assert.equal(
    serviceLogs.filter((entry) => entry.event === 'auth.local_profile_fallback').length,
    1
  );

});
