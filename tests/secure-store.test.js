const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const {
  SecureStore,
  pluginRemoteMcpCredentialKeyName,
  pluginFullHostSecretKeyName,
} = require('../services/backend/secure-store');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createSafeStorageStub(overrides = {}) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(String(value), 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8'),
    ...overrides,
  };
}

test('full-host secrets use a separate safeStorage namespace and never plaintext', async () => {
  const { store, filePath } = createSecureStoreFixture();
  const source = 'a'.repeat(64);
  assert.equal(pluginFullHostSecretKeyName(source), `plugin_full_host:${source}`);
  await store.setPluginFullHostSecret(source, 'synthetic-stage8-secret');
  assert.equal(await store.getPluginFullHostSecret(source), 'synthetic-stage8-secret');
  const persisted = fs.readFileSync(filePath, 'utf8');
  assert.equal(persisted.includes('synthetic-stage8-secret'), false);
  await store.deletePluginFullHostSecret(source);
  assert.equal(await store.getPluginFullHostSecret(source), '');
});

function createSecureStoreFixture({
  prefix = 'jenny-secure-store-',
  safeStorage = createSafeStorageStub(),
  isSafeStorageReady = () => true,
  nowProvider = () => new Date(),
  seed,
} = {}) {
  const tempDir = createTrackedTempDir(prefix);
  const filePath = path.join(tempDir, 'secure-state.json');
  if (seed) {
    fs.writeFileSync(filePath, JSON.stringify(seed), 'utf8');
  }
  return {
    filePath,
    store: new SecureStore({
      filePath,
      safeStorage,
      isSafeStorageReady,
      nowProvider,
    }),
  };
}

function pluginCredentialBinding(overrides = {}) {
  return {
    publisher_id: 'acme-labs', plugin_id: 'remote',
    descriptor_digest: '1'.repeat(64), resource_digest: '2'.repeat(64),
    issuer_digest: '3'.repeat(64), ...overrides,
  };
}

test('secure store fails loudly before Electron safeStorage readiness', () => {
  const { store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-not-ready-',
    isSafeStorageReady: () => false,
  });

  const status = store.getStatus();
  assert.equal(status.status, 'not_ready');
  assert.equal(status.ready, false);
  assert.equal(status.encryptionAvailable, false);
  assert.match(status.recoveryHint, /restart Jenny/i);

  assert.throws(
    () => store.get('jwt_secret'),
    /safeStorage is not ready/i
  );
  assert.throws(
    () => store.set('jwt_secret', 'secret-value'),
    /safeStorage is not ready/i
  );
});

test('secure store fails loudly when isSafeStorageReady predicate is missing', () => {
  const tempDir = createTrackedTempDir('jenny-secure-store-no-predicate-');
  const filePath = path.join(tempDir, 'secure-state.json');
  const store = new SecureStore({
    filePath,
    safeStorage: createSafeStorageStub(),
  });

  const status = store.getStatus();
  assert.equal(status.status, 'not_ready');
  assert.equal(status.ready, false);
  assert.equal(status.encryptionAvailable, false);

  assert.throws(() => store.get('sentry_dsn'), /safeStorage is not ready/i);
  assert.throws(() => store.set('sentry_dsn', 'value'), /safeStorage is not ready/i);
  assert.throws(() => store.delete('sentry_dsn'), /safeStorage is not ready/i);
});

test('secure store reports encrypted credential storage readiness', () => {
  const { store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-ready-',
    isSafeStorageReady: () => true,
  });

  const status = store.getStatus();
  assert.equal(status.status, 'ready');
  assert.equal(status.ready, true);
  assert.equal(status.encryptionAvailable, true);
  assert.equal(status.source, 'electron_safe_storage');
});

test('secure store reports unavailable encryption and refuses writes', () => {
  const { store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-unavailable-',
    safeStorage: createSafeStorageStub({
      isEncryptionAvailable: () => false,
    }),
    isSafeStorageReady: () => true,
  });

  const status = store.getStatus();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.ready, false);
  assert.equal(status.encryptionAvailable, false);
  assert.match(status.recoveryHint, /credential store/i);
  assert.throws(
    () => store.set('jwt_secret', 'secret-value'),
    /encryption unavailable/i
  );
});

test('secure store treats Linux basic_text backend as unavailable', () => {
  const { store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-basic-text-',
    safeStorage: createSafeStorageStub({
      getSelectedStorageBackend: () => 'basic_text',
    }),
    isSafeStorageReady: () => true,
  });

  const status = store.getStatus();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.ready, false);
  assert.equal(status.encryptionAvailable, false);
  assert.equal(status.storageBackend, 'basic_text');
  assert.throws(
    () => store.set('jwt_secret', 'secret-value'),
    /encryption unavailable/i
  );
});

test('secure store delete fails loudly before Electron safeStorage readiness', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-delete-not-ready-',
    isSafeStorageReady: () => false,
  });

  assert.throws(
    () => store.delete('jwt_secret'),
    /safeStorage is not ready/i
  );
  assert.equal(fs.existsSync(filePath), false);
});

test('secure store delete remains available when encryption is unavailable after readiness', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-delete-unavailable-',
    safeStorage: createSafeStorageStub({
      isEncryptionAvailable: () => false,
    }),
    isSafeStorageReady: () => true,
    seed: {
      jwt_secret: {
        encrypted: true,
        value: Buffer.from('secret-value', 'utf8').toString('base64'),
      },
    },
  });

  assert.doesNotThrow(() => store.delete('jwt_secret'));

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.jwt_secret, undefined);
});

test('secure store status does not expose raw safeStorage errors', () => {
  const { store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-status-error-',
    safeStorage: createSafeStorageStub({
      isEncryptionAvailable() {
        throw new Error('platform secret store path C:\\Users\\testuser\\sensitive');
      },
    }),
    isSafeStorageReady: () => true,
  });

  const status = store.getStatus();
  assert.equal(status.status, 'unavailable');
  assert.equal(status.detail, 'safeStorage availability check failed.');
  assert.equal(status.detail.includes('testuser'), false);
});

test('secure store clears unreadable encrypted values instead of throwing', () => {
  const { filePath, store } = createSecureStoreFixture({
    seed: {
      jwt_secret: {
        encrypted: true,
        value: Buffer.from('bad-ciphertext', 'utf8').toString('base64'),
      },
    },
    safeStorage: createSafeStorageStub({
      decryptString() {
        throw new Error('decrypt failed');
      },
    }),
  });

  assert.equal(store.get('jwt_secret'), '');

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.jwt_secret, undefined);
});

test('secure store rejects plaintext records and removes them from disk', () => {
  const { filePath, store } = createSecureStoreFixture({
    seed: {
      jwt_secret: {
        encrypted: false,
        value: 'plaintext-secret',
      },
    },
  });

  assert.equal(store.get('jwt_secret'), '');

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.jwt_secret, undefined);
});

test('secure store keeps Sentry DSN encrypted and exposes only display-safe audit metadata', () => {
  const dsn = 'https://public@o123.ingest.sentry.io/456';
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-sentry-dsn-',
    nowProvider: () => new Date('2026-05-06T12:00:00.000Z'),
  });

  store.setSentryDsn(dsn);

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.sentry_dsn.encrypted, true);
  assert.equal(payload.sentry_dsn.secretType, 'sentry_dsn');
  assert.equal(payload.sentry_dsn.updatedAt, '2026-05-06T12:00:00.000Z');
  assert.notEqual(payload.sentry_dsn.value, dsn);
  assert.equal(store.getSentryDsn(), dsn);

  const audit = store.getCredentialAudit();
  assert.equal(audit.sentryDsn.configured, true);
  assert.equal(audit.sentryDsn.secretType, 'sentry_dsn');
  assert.equal(audit.sentryDsn.updatedAt, '2026-05-06T12:00:00.000Z');
  assert.match(audit.sentryDsn.fingerprint, /^sha256:[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(audit), /public@o123/);

  const status = store.getStatus();
  assert.equal(status.audit.sentryDsn.configured, true);
  assert.doesNotMatch(JSON.stringify(status), /public@o123/);
});

test('secure store can clear Sentry DSN while encryption is unavailable after readiness', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-sentry-clear-unavailable-',
    safeStorage: createSafeStorageStub({
      isEncryptionAvailable: () => false,
    }),
    isSafeStorageReady: () => true,
    seed: {
      sentry_dsn: {
        encrypted: true,
        value: Buffer.from('encrypted-dsn', 'utf8').toString('base64'),
        secretType: 'sentry_dsn',
      },
    },
  });

  assert.doesNotThrow(() => store.setSentryDsn(''));

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.sentry_dsn, undefined);
});

test('secure store clears Sentry DSN without probing encryption availability', () => {
  let availabilityProbeCount = 0;
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-sentry-clear-no-probe-',
    safeStorage: createSafeStorageStub({
      isEncryptionAvailable: () => {
        availabilityProbeCount += 1;
        return false;
      },
    }),
    isSafeStorageReady: () => true,
    seed: {
      sentry_dsn: {
        encrypted: true,
        value: Buffer.from('encrypted-dsn', 'utf8').toString('base64'),
        secretType: 'sentry_dsn',
      },
    },
  });

  assert.doesNotThrow(() => store.setSentryDsn(''));

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(availabilityProbeCount, 0);
  assert.equal(payload.sentry_dsn, undefined);
});

test('secure store round-trips web search provider keys under prefixed key names', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-web-search-roundtrip-',
    nowProvider: () => new Date('2026-06-30T09:00:00.000Z'),
  });

  store.setWebSearchProviderKey('brave', ' brave-api-key-123 ');

  assert.equal(store.getWebSearchProviderKey('brave'), 'brave-api-key-123');

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(payload['web_search_provider_key:brave']);
  assert.equal(payload['web_search_provider_key:brave'].encrypted, true);
  assert.equal(payload['web_search_provider_key:brave'].secretType, 'web_search_provider_key');
  assert.notEqual(payload['web_search_provider_key:brave'].value, 'brave-api-key-123');
});

test('secure store deletes a web search provider key', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-web-search-delete-',
  });

  store.setWebSearchProviderKey('tavily', 'tavily-secret');
  assert.equal(store.getWebSearchProviderKey('tavily'), 'tavily-secret');

  store.deleteWebSearchProviderKey('tavily');

  assert.equal(store.getWebSearchProviderKey('tavily'), '');
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload['web_search_provider_key:tavily'], undefined);
});

test('secure store setting an empty web search provider key value removes the record', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-web-search-empty-set-',
  });

  store.setWebSearchProviderKey('serper', 'serper-secret');
  assert.equal(store.getWebSearchProviderKey('serper'), 'serper-secret');

  store.setWebSearchProviderKey('serper', '');

  assert.equal(store.getWebSearchProviderKey('serper'), '');
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload['web_search_provider_key:serper'], undefined);
});

test('secure store rejects an unknown web search provider key id without echoing it', () => {
  const { store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-web-search-unknown-id-',
  });
  const bogusId = 'totally-not-a-real-provider-xyz';

  assert.throws(
    () => store.getWebSearchProviderKey(bogusId),
    (error) => {
      assert.match(error.message, /unknown web search provider key id/i);
      assert.equal(error.message.includes(bogusId), false);
      return true;
    }
  );
  assert.throws(
    () => store.setWebSearchProviderKey(bogusId, 'some-value'),
    (error) => {
      assert.match(error.message, /unknown web search provider key id/i);
      assert.equal(error.message.includes(bogusId), false);
      return true;
    }
  );
  assert.throws(
    () => store.deleteWebSearchProviderKey(bogusId),
    (error) => {
      assert.match(error.message, /unknown web search provider key id/i);
      assert.equal(error.message.includes(bogusId), false);
      return true;
    }
  );
});

test('secure store stores each web search provider key under its own prefixed key name', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-web-search-multi-',
  });

  store.setWebSearchProviderKey('google_pse', 'pse-key');
  store.setWebSearchProviderKey('google_pse_cx', 'pse-cx-value');

  assert.equal(store.getWebSearchProviderKey('google_pse'), 'pse-key');
  assert.equal(store.getWebSearchProviderKey('google_pse_cx'), 'pse-cx-value');

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(payload['web_search_provider_key:google_pse']);
  assert.ok(payload['web_search_provider_key:google_pse_cx']);
});

test('secure store round-trips an MCP auth token under a secret_ref-namespaced key name', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-mcp-auth-roundtrip-',
    nowProvider: () => new Date('2026-07-02T09:00:00.000Z'),
  });

  store.setMcpAuthToken('mcp:remote-tools', ' bearer-token-abc123 ');

  assert.equal(store.getMcpAuthToken('mcp:remote-tools'), 'bearer-token-abc123');

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(payload['mcp_auth_token:mcp:remote-tools']);
  assert.equal(payload['mcp_auth_token:mcp:remote-tools'].encrypted, true);
  assert.equal(payload['mcp_auth_token:mcp:remote-tools'].secretType, 'mcp_auth_token');
  assert.equal(payload['mcp_auth_token:mcp:remote-tools'].updatedAt, '2026-07-02T09:00:00.000Z');
  assert.notEqual(payload['mcp_auth_token:mcp:remote-tools'].value, 'bearer-token-abc123');
});

test('secure store deletes an MCP auth token', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-mcp-auth-delete-',
  });

  store.setMcpAuthToken('mcp:remote-tools', 'client-secret-xyz');
  assert.equal(store.getMcpAuthToken('mcp:remote-tools'), 'client-secret-xyz');

  store.deleteMcpAuthToken('mcp:remote-tools');

  assert.equal(store.getMcpAuthToken('mcp:remote-tools'), '');
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload['mcp_auth_token:mcp:remote-tools'], undefined);
});

test('secure store setting an empty MCP auth token value removes the record', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-mcp-auth-empty-set-',
  });

  store.setMcpAuthToken('mcp:remote-tools', 'some-secret');
  assert.equal(store.getMcpAuthToken('mcp:remote-tools'), 'some-secret');

  store.setMcpAuthToken('mcp:remote-tools', '');

  assert.equal(store.getMcpAuthToken('mcp:remote-tools'), '');
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload['mcp_auth_token:mcp:remote-tools'], undefined);
});

test('secure store MCP auth token trio no-ops on an empty/absent secret_ref instead of throwing', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-mcp-auth-empty-ref-',
  });

  assert.equal(store.getMcpAuthToken(''), '');
  assert.equal(store.getMcpAuthToken(undefined), '');
  assert.equal(store.getMcpAuthToken('   '), '');
  assert.doesNotThrow(() => store.setMcpAuthToken('', 'should-not-persist'));
  assert.doesNotThrow(() => store.deleteMcpAuthToken(''));

  assert.equal(fs.existsSync(filePath), false);
});

test('secure store stores MCP auth tokens for distinct secret_refs independently', () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-mcp-auth-multi-',
  });

  store.setMcpAuthToken('mcp:remote-tools', 'bearer-token-1');
  store.setMcpAuthToken('mcp:other-server', 'client-secret-2');

  assert.equal(store.getMcpAuthToken('mcp:remote-tools'), 'bearer-token-1');
  assert.equal(store.getMcpAuthToken('mcp:other-server'), 'client-secret-2');

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.ok(payload['mcp_auth_token:mcp:remote-tools']);
  assert.ok(payload['mcp_auth_token:mcp:other-server']);
});

test('secure store audit ignores tampered display metadata', () => {
  const { store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-audit-tamper-',
    seed: {
      sentry_dsn: {
        encrypted: true,
        value: Buffer.from('ciphertext', 'utf8').toString('base64'),
        secretType: 'https://public@o123.ingest.sentry.io/456',
        updatedAt: 'not-a-date',
        fingerprint: 'https://public@o123.ingest.sentry.io/456',
      },
    },
  });

  const audit = store.getCredentialAudit();
  assert.equal(audit.sentryDsn.configured, true);
  assert.equal(audit.sentryDsn.secretType, 'sentry_dsn');
  assert.equal(audit.sentryDsn.updatedAt, '');
  assert.equal(audit.sentryDsn.fingerprint, '');
  assert.doesNotMatch(JSON.stringify(audit), /ingest\.sentry\.io/);
});

test('plugin remote MCP credentials use an isolated digest-only async namespace', async () => {
  const { filePath, store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-plugin-mcp-',
  });
  const binding = pluginCredentialBinding();
  const key = pluginRemoteMcpCredentialKeyName(binding);
  assert.match(key, /^plugin_remote_mcp:[0-9a-f]{64}$/);
  assert.doesNotMatch(key, /acme-labs|mcp_auth_token/);

  await store.setPluginRemoteMcpCredential(binding, 'access-and-refresh-token');
  assert.equal(await store.hasPluginRemoteMcpCredential(binding), true);
  assert.equal(await store.getPluginRemoteMcpCredential(binding), 'access-and-refresh-token');
  const disk = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(disk, /access-and-refresh-token|acme-labs|mcp_auth_token/);

  await store.deletePluginRemoteMcpCredential(binding);
  assert.equal(await store.hasPluginRemoteMcpCredential(binding), false);
});

test('plugin remote MCP credentials fail closed on weak storage and malformed bindings', async () => {
  const { store } = createSecureStoreFixture({
    prefix: 'jenny-secure-store-plugin-mcp-weak-',
    safeStorage: createSafeStorageStub({ getSelectedStorageBackend: () => 'basic_text' }),
  });
  const binding = pluginCredentialBinding();
  await assert.rejects(store.setPluginRemoteMcpCredential(binding, 'secret'), /encryption unavailable/i);
  assert.equal(await store.hasPluginRemoteMcpCredential(binding), false);
  await assert.rejects(store.getPluginRemoteMcpCredential(binding), /encryption unavailable/i);
  assert.throws(
    () => pluginRemoteMcpCredentialKeyName(pluginCredentialBinding({ issuer_digest: 'raw-token' })),
    /invalid plugin remote MCP credential binding/
  );
});
