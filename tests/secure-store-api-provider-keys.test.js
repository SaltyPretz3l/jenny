const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { SecureStore } = require('../services/backend/secure-store');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createStore({ encryptionAvailable = true, backend = '' } = {}) {
  const filePath = path.join(createTrackedTempDir('jenny-secure-store-api-provider-'), 'secure-state.json');
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^enc:/, ''),
    getSelectedStorageBackend: () => backend,
  };
  return {
    filePath,
    store: new SecureStore({ filePath, safeStorage, isSafeStorageReady: () => true }),
  };
}

// Uppercase keeps it outside the instance-id alphabet for the refusal case.
const KEY = 'sk-or-v1-Synthetic-Key-01234';

test('an API-provider key round-trips encrypted under its instance-namespaced name', () => {
  const { filePath, store } = createStore();
  assert.equal(store.hasModelProviderApiKey('openrouter'), false);

  store.setModelProviderApiKey('openrouter', ` ${KEY} `);

  assert.equal(store.hasModelProviderApiKey('openrouter'), true);
  assert.equal(store.getModelProviderApiKey('openrouter'), KEY);
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.ok(!raw.includes(KEY));
  const record = JSON.parse(raw)['model_provider_api_key:openrouter'];
  assert.equal(record.encrypted, true);
  assert.equal(record.secretType, 'model_provider_api_key');
});

test('setting an empty value or deleting removes the key', () => {
  const { store } = createStore();
  store.setModelProviderApiKey('groq', KEY);
  store.setModelProviderApiKey('groq', '   ');
  assert.equal(store.hasModelProviderApiKey('groq'), false);
  store.setModelProviderApiKey('groq', KEY);
  store.deleteModelProviderApiKey('groq');
  assert.equal(store.getModelProviderApiKey('groq'), '');
});

test('an invalid instance id is refused without echoing it', () => {
  const { store } = createStore();
  for (const id of ['', 'A', 'x', 'Open_Router', '../escape', KEY, null]) {
    assert.throws(() => store.setModelProviderApiKey(id, KEY), (error) => {
      assert.ok(!String(error.message).includes(KEY));
      return true;
    });
    assert.throws(() => store.hasModelProviderApiKey(id));
  }
});

test('keys are refused when encryption is unavailable or the backend is basic_text', () => {
  for (const options of [{ encryptionAvailable: false }, { backend: 'basic_text' }]) {
    const { filePath, store } = createStore(options);
    assert.throws(() => store.setModelProviderApiKey('openrouter', KEY));
    assert.equal(fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(KEY), false);
  }
});

test('orphaned keys are purged and live ones kept', () => {
  const { store } = createStore();
  store.setModelProviderApiKey('openrouter', KEY);
  store.setModelProviderApiKey('groq', `${KEY}-2`);
  store.setWebSearchProviderKey('brave', 'synthetic-brave');

  assert.deepEqual(store.purgeOrphanModelProviderApiKeys(['openrouter']), ['groq']);
  assert.equal(store.hasModelProviderApiKey('openrouter'), true);
  assert.equal(store.hasModelProviderApiKey('groq'), false);
  assert.equal(store.getWebSearchProviderKey('brave'), 'synthetic-brave');
  assert.deepEqual(store.purgeOrphanModelProviderApiKeys(['openrouter']), []);
});
