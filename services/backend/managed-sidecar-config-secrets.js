// Every SecureStore / credential read behind the managed sidecar initialize
// payload: web-search provider keys, MCP auth secrets and the secrets-only
// payload. Split out of managed-sidecar-config.js (the public entry point,
// which re-exports these). Values are secrets: never log or persist them.
const { managedServerApiKey } = require('./managed-server-owner');
const { chatgptModelsEnabled } = require('./chatgpt-models-enabled');
const { buildApiProviderSidecarSecrets } = require('./api-provider-sidecar-config');
const {
  WEB_SEARCH_PROVIDER_KEY_IDS,
} = require('./secure-store');
const {
  getConfiguredTelemetrySettings,
  getHostedModelEndpoint,
} = require('./managed-sidecar-config-readers');
const {
  resolveManagedConfiguredModel,
  resolveOpenAICompatibleApiUrl,
} = require('./managed-sidecar-config-model');

// Provider API keys come from SecureStore (never shell config / plaintext
// JSON). Returns null when nothing is configured so the sidecar parse falls
// back to its safe default. Values are secrets: this map must only ever be
// placed on the sidecar initialize payload, never logged or persisted.
function getConfiguredToolsWebSearchProviderKeys(service) {
  const secureStore = service.secureStore;
  if (!secureStore || typeof secureStore.getWebSearchProviderKey !== 'function') {
    return null;
  }
  const keyIds = Array.isArray(WEB_SEARCH_PROVIDER_KEY_IDS) ? WEB_SEARCH_PROVIDER_KEY_IDS : [];
  const keys = {};
  for (const keyId of keyIds) {
    try {
      const value = String(secureStore.getWebSearchProviderKey(keyId) || '').trim();
      if (value) {
        keys[keyId] = value;
      }
    } catch (error) {
      if (typeof service._emitServiceLog === 'function') {
        service._emitServiceLog('WARN', 'web_search.provider_key_read_failed', {
          keyId,
          errorName: String(error?.name || 'Error'),
          credentialStore: getCredentialStoreStatusForLog(secureStore),
        });
      }
    }
  }
  return Object.keys(keys).length ? keys : null;
}

// MCP HTTP Transport Step 5: resolve each sse server's `auth.secret_ref` into
// the actual secret (bearer token or OAuth client_secret) and inject it into
// a NEW forwarded server row -- the discovery-returned rows are never
// mutated. `secret_ref` itself is dropped from the forwarded shape (the
// sidecar's MCPServerAuth has no use for the ref, only the resolved value).
// Fail closed: a missing secureStore, a missing method, a thrown error, or no
// matching stored secret all resolve to "no secret" -- the auth object is
// forwarded without `token`/`client_secret` so the transport structurally
// 401s / fails to mint rather than silently going unauthenticated in a way
// that could be mistaken for success. Never log the ref value or the secret.
function resolveMcpServerAuthSecrets(service, servers) {
  if (!Array.isArray(servers) || !servers.length) {
    return servers;
  }
  const secureStore = service?.secureStore;
  return servers.map((server) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      return server;
    }
    const auth = server.auth;
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      return server;
    }
    const secretRef = String(auth.secret_ref || '').trim();
    if (!secretRef) {
      return server;
    }

    const forwardedAuth = {};
    if (auth.kind) {
      forwardedAuth.kind = auth.kind;
    }
    if (auth.token_url) {
      forwardedAuth.token_url = auth.token_url;
    }
    if (auth.client_id) {
      forwardedAuth.client_id = auth.client_id;
    }
    if (auth.scope) {
      forwardedAuth.scope = auth.scope;
    }
    // secret_ref intentionally dropped -- the sidecar consumes only the
    // resolved token/client_secret, never the pointer.

    const kind = String(auth.kind || '').trim().toLowerCase();
    const isOauthClientCredentials = kind === 'oauth_client_credentials';

    let resolvedSecret = '';
    if (secureStore && typeof secureStore.getMcpAuthToken === 'function') {
      try {
        resolvedSecret = String(secureStore.getMcpAuthToken(secretRef) || '').trim();
      } catch (error) {
        if (typeof service._emitServiceLog === 'function') {
          service._emitServiceLog('WARN', 'mcp.auth_token_read_failed', {
            server: String(server.name || '').trim(),
            errorName: String(error?.name || 'Error'),
            credentialStore: getCredentialStoreStatusForLog(secureStore),
          });
        }
        resolvedSecret = '';
      }
    }

    if (resolvedSecret) {
      if (isOauthClientCredentials) {
        forwardedAuth.client_secret = resolvedSecret;
      } else {
        forwardedAuth.token = resolvedSecret;
      }
    }
    // else: fail closed -- forward the auth object without token/client_secret.

    return { ...server, auth: forwardedAuth };
  });
}

function getCredentialStoreStatusForLog(secureStore) {
  if (!secureStore || typeof secureStore.getStatus !== 'function') {
    return null;
  }
  try {
    return secureStore.getStatus();
  } catch (_error) {
    return null;
  }
}

function buildManagedSidecarSecrets(service, { telemetrySettings = null } = {}) {
  if (service.hostMode === 'server') {
    const endpoint = getHostedModelEndpoint(service);
    if (endpoint?.engine !== 'openai-compatible') return {};
    // Host endpoint selection and credentials share the same immutable owner.
    // A read error rejects initialization instead of silently dropping a key.
    const key = service.hostPorts.credentialService.get('openai_compatible_api_key');
    return key ? { openai_compatible_api_key: String(key).trim() } : {};
  }
  const secrets = {};
  if (
    (telemetrySettings || getConfiguredTelemetrySettings(service)).crashReportingOptIn === true
    && service.secureStore
    && typeof service.secureStore.getSentryDsn === 'function'
  ) {
    try {
      const dsn = String(service.secureStore.getSentryDsn() || '').trim();
      if (dsn) {
        secrets.telemetry_dsn = dsn;
      }
    } catch (error) {
      if (typeof service._emitServiceLog === 'function') {
        service._emitServiceLog('WARN', 'telemetry.dsn_read_failed', {
          errorName: String(error?.name || 'Error'),
          credentialStore: getCredentialStoreStatusForLog(service.secureStore),
        });
      }
    }
  }
  if (service.currentEngineType === 'chatgpt' && chatgptModelsEnabled(service.configService)
    && service._chatgptLegacyChoicePending !== true) {
    secrets.chatgpt_access_token = service.chatgptAuthService?.getCachedAccessToken?.() || '';
  }
  Object.assign(secrets, buildApiProviderSidecarSecrets(service, resolveManagedConfiguredModel(service)));
  // The embedding server's per-launch key (row 41); only its own loopback
  // endpoint receives it, through the catalog config's base_url.
  if (typeof service.semanticCatalogService?.getSidecarSecrets === 'function') {
    Object.assign(secrets, service.semanticCatalogService.getSidecarSecrets());
  }
  if (service.currentEngineType === 'openai-compatible') {
    // The key belongs to the managed server process only (llama-server or
    // NInfer). The engine's api_url may point at a user-run server (explicit
    // apiUrl, or a different port), which must never receive Jenny's key.
    const apiKey = managedServerApiKey(service, resolveOpenAICompatibleApiUrl(service));
    if (apiKey) {
      secrets.openai_compatible_api_key = apiKey;
    }
  }
  return secrets;
}

module.exports = {
  buildManagedSidecarSecrets,
  getConfiguredToolsWebSearchProviderKeys,
  resolveMcpServerAuthSecrets,
};
