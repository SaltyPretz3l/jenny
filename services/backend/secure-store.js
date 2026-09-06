const crypto = require('crypto');

const { FileJsonStore } = require('./file-json-store');

const SECURE_STORE_SOURCE = 'electron_safe_storage';
const BASIC_TEXT_STORAGE_BACKEND = 'basic_text';
const SENTRY_DSN_KEY = 'sentry_dsn';
const SECRET_TYPE_SENTRY_DSN = 'sentry_dsn';
const SECRET_TYPE_WEB_SEARCH_PROVIDER_KEY = 'web_search_provider_key';
const SECRET_TYPE_MCP_AUTH_TOKEN = 'mcp_auth_token';
const SECRET_TYPE_MODEL_PROVIDER_OAUTH = 'model_provider_oauth';
const SECRET_TYPE_PLUGIN_REMOTE_MCP = 'plugin_remote_mcp';
const SECRET_TYPE_PLUGIN_FULL_HOST = 'plugin_full_host';
const WEB_SEARCH_PROVIDER_KEY_PREFIX = 'web_search_provider_key:';
const MCP_AUTH_TOKEN_KEY_PREFIX = 'mcp_auth_token:';
const MODEL_PROVIDER_OAUTH_KEY_PREFIX = 'model_provider_oauth:';
const PLUGIN_REMOTE_MCP_KEY_PREFIX = 'plugin_remote_mcp:';
const PLUGIN_FULL_HOST_KEY_PREFIX = 'plugin_full_host:';
const MODEL_PROVIDER_OAUTH_IDS = Object.freeze(['chatgpt']);
// The closed set of storable web-search credential ids: the key-based search
// providers plus Google PSE's engine id (not itself a secret, but stored on
// the same encrypted path so provider config never splits across stores).
const WEB_SEARCH_PROVIDER_KEY_IDS = Object.freeze([
  'brave',
  'tavily',
  'serper',
  'google_pse',
  'google_pse_cx',
]);
const SAFE_STORAGE_NOT_READY_MESSAGE =
  'SecureStore: safeStorage is not ready. Restart Jenny if this continues after startup.';
const NOT_READY_RECOVERY = {
  recoveryTitle: 'Credential storage is not ready',
  recoveryHint: 'Restart Jenny if credential storage still is not ready after startup completes.',
};
const UNAVAILABLE_RECOVERY = {
  recoveryTitle: 'Credential storage is unavailable',
  recoveryHint: 'Restart Jenny or check the operating system credential store before saving credentials.',
};

function defaultSafeStorage() {
  return {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(String(value || ''), 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8'),
  };
}

function buildStatus({
  status,
  ready,
  appReady,
  encryptionAvailable,
  storageBackend = '',
  detail = '',
  recoveryTitle = '',
  recoveryHint = '',
  audit = {},
}) {
  return {
    source: SECURE_STORE_SOURCE,
    status,
    ready,
    appReady,
    encryptionAvailable,
    storageBackend,
    detail,
    recoveryTitle,
    recoveryHint,
    audit,
  };
}

function buildNotReadyStatus({ detail = '' } = {}) {
  return buildStatus({
    status: 'not_ready',
    ready: false,
    appReady: false,
    encryptionAvailable: false,
    detail,
    ...NOT_READY_RECOVERY,
  });
}

function buildUnavailableStatus({
  detail = '',
  storageBackend = '',
  recoveryHint = UNAVAILABLE_RECOVERY.recoveryHint,
  audit = {},
} = {}) {
  return buildStatus({
    status: 'unavailable',
    ready: false,
    appReady: true,
    encryptionAvailable: false,
    storageBackend,
    detail,
    recoveryTitle: UNAVAILABLE_RECOVERY.recoveryTitle,
    recoveryHint,
    audit,
  });
}

function isUnavailableStorageBackend(storageBackend) {
  return storageBackend === BASIC_TEXT_STORAGE_BACKEND;
}

function fingerprintSecret(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

function normalizeIsoTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  const token = String(value || '').trim();
  if (!token) {
    return '';
  }
  const parsed = new Date(token);
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toISOString();
}

const KNOWN_SECRET_TYPES = Object.freeze([
  SECRET_TYPE_SENTRY_DSN,
  SECRET_TYPE_WEB_SEARCH_PROVIDER_KEY,
  SECRET_TYPE_MCP_AUTH_TOKEN,
  SECRET_TYPE_MODEL_PROVIDER_OAUTH,
  SECRET_TYPE_PLUGIN_REMOTE_MCP,
  SECRET_TYPE_PLUGIN_FULL_HOST,
]);

function normalizeSecretType(value, fallback = '') {
  const token = String(value || '').trim();
  if (KNOWN_SECRET_TYPES.includes(token)) {
    return token;
  }
  const fallbackToken = String(fallback || '').trim();
  return KNOWN_SECRET_TYPES.includes(fallbackToken) ? fallbackToken : '';
}

function webSearchProviderKeyName(providerKeyId) {
  const token = String(providerKeyId || '').trim().toLowerCase();
  if (!WEB_SEARCH_PROVIDER_KEY_IDS.includes(token)) {
    // Do not echo the rejected value: a caller bug could pass the secret
    // itself as the id, and this message can reach logs.
    throw new Error('SecureStore: unknown web search provider key id.');
  }
  return `${WEB_SEARCH_PROVIDER_KEY_PREFIX}${token}`;
}

function normalizeFingerprint(value) {
  const token = String(value || '').trim().toLowerCase();
  return /^sha256:[0-9a-f]{12}$/.test(token) ? token : '';
}

// MCP auth tokens are keyed by the server's opaque `auth.secret_ref` (e.g.
// "mcp:remote-tools") rather than a closed id set: remote MCP servers are
// user-configured, so the ref space is open-ended. Unlike
// webSearchProviderKeyName, an empty/invalid ref is not an error — callers
// (managed-sidecar-config resolution) treat "no ref" as "no secret" and must
// be able to probe that without throwing.
function mcpAuthTokenKeyName(secretRef) {
  const token = String(secretRef || '').trim();
  if (!token) {
    return '';
  }
  return `${MCP_AUTH_TOKEN_KEY_PREFIX}${token}`;
}

function modelProviderOAuthKeyName(providerId) {
  const token = String(providerId || '').trim().toLowerCase();
  if (!MODEL_PROVIDER_OAUTH_IDS.includes(token)) {
    throw new Error('SecureStore: unknown model provider OAuth id.');
  }
  return `${MODEL_PROVIDER_OAUTH_KEY_PREFIX}${token}`;
}

function pluginRemoteMcpCredentialKeyName(binding) {
  const idsValid = /^[a-z][a-z0-9_-]{0,63}$/.test(binding?.plugin_id || '')
    && /^[a-z][a-z0-9-]{0,63}$/.test(binding?.publisher_id || '');
  const digests = [binding?.descriptor_digest, binding?.resource_digest, binding?.issuer_digest];
  if (!idsValid || digests.some((value) => !/^[0-9a-f]{64}$/.test(value || ''))) {
    throw new Error('SecureStore: invalid plugin remote MCP credential binding.');
  }
  const canonical = JSON.stringify([
    binding.publisher_id,
    binding.plugin_id,
    binding.descriptor_digest,
    binding.resource_digest,
    binding.issuer_digest,
  ]);
  const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${PLUGIN_REMOTE_MCP_KEY_PREFIX}${digest}`;
}

function pluginFullHostSecretKeyName(sourceIdDigest) {
  const digest = String(sourceIdDigest || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('SecureStore: invalid plugin full-host secret source.');
  }
  return `${PLUGIN_FULL_HOST_KEY_PREFIX}${digest}`;
}

function deferSecureStorageOperation() {
  return new Promise((resolve) => setImmediate(resolve));
}

class SecureStore {
  constructor({ filePath, safeStorage, isSafeStorageReady, nowProvider } = {}) {
    this.store = new FileJsonStore(filePath);
    this.safeStorage = safeStorage || defaultSafeStorage();
    this.isSafeStorageReady = typeof isSafeStorageReady === 'function'
      ? isSafeStorageReady
      : () => false;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
  }

  getStatus() {
    let appReady;
    try {
      appReady = this.isSafeStorageReady() === true;
    } catch (_error) {
      return buildNotReadyStatus({
        detail: 'safeStorage readiness check failed.',
      });
    }

    if (!appReady) {
      return buildNotReadyStatus();
    }

    let encryptionAvailable;
    try {
      encryptionAvailable = this.safeStorage.isEncryptionAvailable() === true;
    } catch (_error) {
      return buildUnavailableStatus({
        audit: this.getCredentialAudit(),
        detail: 'safeStorage availability check failed.',
      });
    }

    const storageBackend = this._getSelectedStorageBackend();
    const audit = this.getCredentialAudit();
    if (isUnavailableStorageBackend(storageBackend)) {
      return buildUnavailableStatus({
        audit,
        storageBackend,
        recoveryHint: 'Jenny will not save credentials while Electron is using unprotected basic_text storage.',
      });
    }

    if (!encryptionAvailable) {
      return buildUnavailableStatus({
        audit,
        storageBackend,
      });
    }

    return buildStatus({
      status: 'ready',
      ready: true,
      appReady: true,
      encryptionAvailable: true,
      storageBackend,
      audit,
    });
  }

  _getSelectedStorageBackend() {
    if (typeof this.safeStorage.getSelectedStorageBackend !== 'function') {
      return '';
    }
    try {
      return String(this.safeStorage.getSelectedStorageBackend() || '').trim();
    } catch (_error) {
      return '';
    }
  }

  _assertAppReady() {
    let appReady;
    try {
      appReady = this.isSafeStorageReady() === true;
    } catch (_error) {
      appReady = false;
    }
    if (!appReady) {
      throw new Error(SAFE_STORAGE_NOT_READY_MESSAGE);
    }
  }

  _assertSafeStorageReady() {
    const status = this.getStatus();
    if (status.status === 'not_ready') {
      throw new Error(SAFE_STORAGE_NOT_READY_MESSAGE);
    }
    return status;
  }

  _dropInvalidRecord(payload, key, message) {
    try {
      console.warn(message);
    } catch (logError) {
      void logError;
    }
    delete payload[key];
    this.store.write(payload);
    return '';
  }

  _nowIso() {
    return normalizeIsoTimestamp(this.nowProvider()) || new Date().toISOString();
  }

  _buildRecordMetadata(value, options = {}) {
    const secretType = normalizeSecretType(options.secretType);
    if (!secretType) {
      return {};
    }
    const updatedAt = normalizeIsoTimestamp(options.updatedAt) || this._nowIso();
    return {
      secretType,
      updatedAt,
      fingerprint: fingerprintSecret(value),
    };
  }

  _auditRecord(payload, key, fallbackSecretType) {
    const record = payload && typeof payload === 'object' ? payload[key] : null;
    const encrypted = record?.encrypted === true;
    return {
      key,
      source: SECURE_STORE_SOURCE,
      secretType: normalizeSecretType(record?.secretType, fallbackSecretType),
      configured: encrypted && Boolean(String(record?.value || '').trim()),
      encrypted,
      updatedAt: normalizeIsoTimestamp(record?.updatedAt),
      fingerprint: normalizeFingerprint(record?.fingerprint),
    };
  }

  getCredentialAudit() {
    const payload = this.store.read({});
    return {
      sentryDsn: this._auditRecord(payload, SENTRY_DSN_KEY, SECRET_TYPE_SENTRY_DSN),
    };
  }

  get(key) {
    this._assertAppReady();
    const payload = this.store.read({});
    const record = payload[key];
    if (!record) {
      return '';
    }

    if (!record.encrypted) {
      return this._dropInvalidRecord(
        payload,
        key,
        `SecureStore: plaintext value rejected for "${key}", removing insecure entry.`
      );
    }

    const encrypted = Buffer.from(String(record.value || ''), 'base64');
    try {
      return this.safeStorage.decryptString(encrypted);
    } catch (error) {
      return this._dropInvalidRecord(
        payload,
        key,
        `SecureStore: decryption failed for "${key}", removing corrupted entry.`
      );
    }
  }

  set(key, value, options = {}) {
    const textValue = String(value || '');
    if (!textValue) {
      this._assertAppReady();
      const payload = this.store.read({});
      delete payload[key];
      this.store.write(payload);
      return;
    }

    const status = this._assertSafeStorageReady();
    const payload = this.store.read({});

    if (status.encryptionAvailable) {
      const encrypted = this.safeStorage.encryptString(textValue);
      payload[key] = {
        encrypted: true,
        value: Buffer.from(encrypted).toString('base64'),
        ...this._buildRecordMetadata(textValue, options),
      };
    } else {
      throw new Error(
        `SecureStore: encryption unavailable. Refusing to store "${key}" in plaintext.`
      );
    }

    this.store.write(payload);
  }

  delete(key) {
    this._assertAppReady();
    const payload = this.store.read({});
    delete payload[key];
    this.store.write(payload);
  }

  getSentryDsn() {
    return this.get(SENTRY_DSN_KEY);
  }

  setSentryDsn(value) {
    return this.set(SENTRY_DSN_KEY, String(value || '').trim(), {
      secretType: SECRET_TYPE_SENTRY_DSN,
    });
  }

  deleteSentryDsn() {
    return this.delete(SENTRY_DSN_KEY);
  }

  getWebSearchProviderKey(providerKeyId) {
    return this.get(webSearchProviderKeyName(providerKeyId));
  }

  setWebSearchProviderKey(providerKeyId, value) {
    return this.set(webSearchProviderKeyName(providerKeyId), String(value || '').trim(), {
      secretType: SECRET_TYPE_WEB_SEARCH_PROVIDER_KEY,
    });
  }

  deleteWebSearchProviderKey(providerKeyId) {
    return this.delete(webSearchProviderKeyName(providerKeyId));
  }

  // MCP auth token semantics: one secret per `auth.secret_ref`. For
  // `auth.kind === "bearer"` the stored value is the bearer/PAT token; for
  // `auth.kind === "oauth_client_credentials"` it is the OAuth client_secret.
  // The ref is opaque (e.g. "mcp:remote-tools") and never itself a secret. An
  // empty/absent ref is a no-op / empty-read, not an error — the config
  // resolution path (managed-sidecar-config.js) must be able to probe a
  // server with no configured secret_ref without throwing.
  getMcpAuthToken(secretRef) {
    const keyName = mcpAuthTokenKeyName(secretRef);
    return keyName ? this.get(keyName) : '';
  }

  // Presence-only probe for a renderer-facing "configured" boolean: never
  // decrypts or returns the stored value, only whether a valid encrypted
  // record exists for this secretRef. Safe to call on any renderer-facing
  // path (unlike getMcpAuthToken, which must never be reachable from one).
  hasMcpAuthToken(secretRef) {
    const keyName = mcpAuthTokenKeyName(secretRef);
    if (!keyName) {
      return false;
    }
    this._assertAppReady();
    const payload = this.store.read({});
    const record = payload[keyName];
    return Boolean(record && record.encrypted === true && String(record.value || '').trim());
  }

  setMcpAuthToken(secretRef, value) {
    const keyName = mcpAuthTokenKeyName(secretRef);
    if (!keyName) {
      return;
    }
    return this.set(keyName, String(value || '').trim(), {
      secretType: SECRET_TYPE_MCP_AUTH_TOKEN,
    });
  }

  deleteMcpAuthToken(secretRef) {
    const keyName = mcpAuthTokenKeyName(secretRef);
    if (!keyName) {
      return;
    }
    return this.delete(keyName);
  }

  getModelProviderOAuth(providerId) {
    return this.get(modelProviderOAuthKeyName(providerId));
  }

  setModelProviderOAuth(providerId, value) {
    return this.set(modelProviderOAuthKeyName(providerId), String(value || '').trim(), {
      secretType: SECRET_TYPE_MODEL_PROVIDER_OAUTH,
    });
  }

  deleteModelProviderOAuth(providerId) {
    return this.delete(modelProviderOAuthKeyName(providerId));
  }

  async getPluginRemoteMcpCredential(binding) {
    await deferSecureStorageOperation();
    const status = this._assertSafeStorageReady();
    if (!status.ready) throw new Error('SecureStore: encryption unavailable for plugin credentials.');
    return this.get(pluginRemoteMcpCredentialKeyName(binding));
  }

  async hasPluginRemoteMcpCredential(binding) {
    await deferSecureStorageOperation();
    const status = this._assertSafeStorageReady();
    if (!status.ready) return false;
    const key = pluginRemoteMcpCredentialKeyName(binding);
    const record = this.store.read({})[key];
    return Boolean(record?.encrypted === true && String(record.value || '').trim());
  }

  async setPluginRemoteMcpCredential(binding, value) {
    await deferSecureStorageOperation();
    return this.set(pluginRemoteMcpCredentialKeyName(binding), String(value || ''), {
      secretType: SECRET_TYPE_PLUGIN_REMOTE_MCP,
    });
  }

  async deletePluginRemoteMcpCredential(binding) {
    await deferSecureStorageOperation();
    return this.delete(pluginRemoteMcpCredentialKeyName(binding));
  }

  async getPluginFullHostSecret(sourceIdDigest) {
    await deferSecureStorageOperation();
    const status = this._assertSafeStorageReady();
    if (!status.ready) throw new Error('SecureStore: encryption unavailable for plugin secrets.');
    return this.get(pluginFullHostSecretKeyName(sourceIdDigest));
  }

  async setPluginFullHostSecret(sourceIdDigest, value) {
    await deferSecureStorageOperation();
    return this.set(pluginFullHostSecretKeyName(sourceIdDigest), String(value || ''), {
      secretType: SECRET_TYPE_PLUGIN_FULL_HOST,
    });
  }

  async deletePluginFullHostSecret(sourceIdDigest) {
    await deferSecureStorageOperation();
    return this.delete(pluginFullHostSecretKeyName(sourceIdDigest));
  }
}

module.exports = {
  SECRET_TYPE_MODEL_PROVIDER_OAUTH,
  WEB_SEARCH_PROVIDER_KEY_IDS,
  SecureStore,
  pluginRemoteMcpCredentialKeyName,
  pluginFullHostSecretKeyName,
};
