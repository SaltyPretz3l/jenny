const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyFeatureSettingsPatch,
  applyWebSearchSecret,
  buildFeatureStatePayload,
  buildWebSearchSecretStatus,
  registerFeatureIpcHandlers,
} = require('../services/feature-settings-service');
const { WEB_SEARCH_PROVIDER_KEY_IDS } = require('../services/backend/secure-store');

test('feature settings payload exposes declarative tool config fields', () => {
  const payload = buildFeatureStatePayload({
    shellConfigService: {
      getState() {
        return {
          tools: {
            web: true,
          },
          featureOverrides: {},
        };
      },
      getWorkspaceRootStatus() {
        return {
          state: 'missing',
          message: 'No workspace root is configured.',
        };
      },
    },
    backendService: {},
    env: {},
    platform: 'win32',
  });

  assert.equal(payload.toolConfig.schemaVersion, 2);
  assert.deepEqual(payload.tools, {
    imageRead: false,
    fileTools: true,
    web: true,
    pythonRuntime: false,
    bash: true,
    worktree: false,
    richFiles: true,
    subagents: true,
    lsp: false,
  });
  const web = payload.toolConfig.fields.find((field) => field.key === 'web');
  assert.ok(web);
  assert.equal(web.label, 'Web tools');
  assert.equal(web.fieldType, 'toggle');
  assert.deepEqual(web.toolIds, ['web_search', 'fetch_url']);
  for (const field of payload.toolConfig.fields) {
    assert.ok(payload.availability.tools[field.key], `missing availability for ${field.key}`);
  }
  assert.deepEqual(payload.availability.tools.web, {
    managedSidecarRequired: true,
    enabled: true,
  });
  assert.deepEqual(payload.availability.tools.pythonRuntime, {
    managedSidecarRequired: true,
    windowsOnly: true,
    enabled: true,
  });
  assert.deepEqual(payload.availability.tools.worktree, {
    managedSidecarRequired: false,
    electronOnly: true,
    workspaceRootRequired: true,
    enabled: false,
  });
  assert.deepEqual(payload.availability.tools.richFiles, {
    managedSidecarRequired: true,
    workspaceRootRequired: true,
    enabled: false,
  });
  assert.deepEqual(payload.availability.tools.subagents, {
    managedSidecarRequired: true,
    workspaceRootRequired: true,
    enabled: false,
  });
  assert.deepEqual(payload.availability.tools.lsp, {
    managedSidecarRequired: true,
    workspaceRootRequired: true,
    enabled: false,
  });
});

test('feature settings payload includes the webSearch provider slice', () => {
  const payload = buildFeatureStatePayload({
    shellConfigService: {
      getState() {
        return {
          tools: {},
          featureOverrides: {},
          webSearch: { provider: 'brave', searxngUrl: 'http://127.0.0.1:8080' },
        };
      },
      getWorkspaceRootStatus() {
        return { state: 'missing', message: 'No workspace root is configured.' };
      },
    },
    backendService: {},
    env: {},
    platform: 'win32',
  });

  assert.deepEqual(payload.webSearch, { provider: 'brave', searxngUrl: 'http://127.0.0.1:8080' });
});

test('feature settings payload defaults the webSearch slice when unset', () => {
  const payload = buildFeatureStatePayload({
    shellConfigService: {
      getState() {
        return { tools: {}, featureOverrides: {} };
      },
      getWorkspaceRootStatus() {
        return { state: 'missing', message: 'No workspace root is configured.' };
      },
    },
    backendService: {},
    env: {},
    platform: 'win32',
  });

  assert.deepEqual(payload.webSearch, { provider: 'duckduckgo', searxngUrl: '' });
  assert.deepEqual(payload.memory, { captureSuggestions: true });
});

function createFeaturePatchHarness() {
  let state = {
    tools: {},
    webSearch: { provider: 'duckduckgo', searxngUrl: '' },
    featureOverrides: {},
    memory: { captureSuggestions: true },
  };
  return {
    shellConfigService: {
      getState() { return structuredClone(state); },
      getWorkspaceRootStatus() { return { state: 'missing', message: 'Missing.' }; },
      updateFeatureSettings(patch) {
        state = {
          ...state,
          ...patch,
          tools: { ...state.tools, ...(patch.tools || {}) },
          webSearch: { ...state.webSearch, ...(patch.webSearch || {}) },
          featureOverrides: { ...state.featureOverrides, ...(patch.featureOverrides || {}) },
          memory: { ...state.memory, ...(patch.memory || {}) },
        };
        return structuredClone(state);
      },
      replaceState(next) { state = structuredClone(next); },
    },
    getState() { return structuredClone(state); },
  };
}

test('memory-only feature settings persist without reconfiguring the sidecar', async () => {
  const harness = createFeaturePatchHarness();
  const calls = [];
  const payload = await applyFeatureSettingsPatch({
    patch: { memory: { captureSuggestions: false } },
    shellConfigService: harness.shellConfigService,
    backendService: {
      setFeatureFlags() { calls.push('flags'); },
      refreshManagedConfig() { calls.push('refresh'); },
    },
    env: {},
    platform: 'win32',
  });

  assert.deepEqual(calls, []);
  assert.deepEqual(payload.memory, { captureSuggestions: false });
  assert.equal(harness.getState().memory.captureSuggestions, false);
});

test('mixed memory and runtime feature settings retain managed refresh behavior', async () => {
  const harness = createFeaturePatchHarness();
  const calls = [];
  await applyFeatureSettingsPatch({
    patch: { memory: { captureSuggestions: false }, tools: { web: true } },
    shellConfigService: harness.shellConfigService,
    backendService: {
      setFeatureFlags() { calls.push('flags'); },
      refreshManagedConfig(reason) { calls.push(reason); },
    },
    env: {},
    platform: 'win32',
  });

  assert.deepEqual(calls, ['flags', 'feature_settings_updated']);
});

test('mixed memory and runtime feature settings roll back both slices when refresh fails', async () => {
  const harness = createFeaturePatchHarness();
  const flagCalls = [];
  const broadcasts = [];
  await assert.rejects(
    () => applyFeatureSettingsPatch({
      patch: { memory: { captureSuggestions: false }, tools: { web: true } },
      shellConfigService: harness.shellConfigService,
      backendService: {
        setFeatureFlags(flags) { flagCalls.push(flags); },
        async refreshManagedConfig() { throw new Error('refresh failed'); },
      },
      sendToWindow(_channel, payload) { broadcasts.push(payload); },
      env: {},
      platform: 'win32',
    }),
    /refresh failed/i
  );

  assert.equal(flagCalls.length, 2, 'next and restored flags must both reach the backend');
  assert.deepEqual(harness.getState().tools, {});
  assert.deepEqual(harness.getState().memory, { captureSuggestions: true });
  assert.deepEqual(broadcasts.at(-1).memory, { captureSuggestions: true });
});

test('failed managed feature refresh reapplies restored config and preserves the original error', async () => {
  const harness = createFeaturePatchHarness();
  const refreshReasons = [];
  const diagnostics = [];
  let runtimeTools = {};
  const originalError = new Error('apply refresh failed');
  const backendService = {
    setFeatureFlags() {},
    async refreshManagedConfig(reason) {
      refreshReasons.push(reason);
      runtimeTools = structuredClone(harness.getState().tools);
      throw refreshReasons.length === 1 ? originalError : new Error('rollback refresh failed');
    },
    _emitServiceLog(level, event, details) {
      diagnostics.push({ level, event, details });
    },
  };

  await assert.rejects(
    () => applyFeatureSettingsPatch({
      patch: { tools: { web: true } },
      shellConfigService: harness.shellConfigService,
      backendService,
      env: {},
      platform: 'win32',
    }),
    (error) => error === originalError
  );

  assert.deepEqual(refreshReasons, ['feature_settings_updated', 'feature_settings_rollback']);
  assert.deepEqual(runtimeTools, {});
  assert.deepEqual(diagnostics, [{
    level: 'ERROR',
    event: 'feature_settings.rollback_failed',
    details: {
      status: 'degraded',
      reason: 'rollback_refresh_failed',
      errorName: 'Error',
    },
  }]);
});

function createFakeSecureStore(configuredKeyValues = {}) {
  const store = new Map(Object.entries(configuredKeyValues));
  return {
    getWebSearchProviderKey(keyId) {
      return store.get(keyId) || '';
    },
    setWebSearchProviderKey(keyId, value) {
      const trimmed = String(value || '').trim();
      if (!trimmed) {
        store.delete(keyId);
        return;
      }
      store.set(keyId, trimmed);
    },
    getStatus() {
      return { status: 'ready', ready: true };
    },
  };
}

test('buildWebSearchSecretStatus reports configured booleans per key id and never leaks values', () => {
  const secureStore = createFakeSecureStore({ brave: 'brave-secret-value' });
  const status = buildWebSearchSecretStatus({ backendService: { secureStore } });

  assert.deepEqual(Object.keys(status.configured).sort(), [...WEB_SEARCH_PROVIDER_KEY_IDS].sort());
  assert.equal(status.configured.brave, true);
  assert.equal(status.configured.tavily, false);
  assert.equal(status.configured.serper, false);
  assert.deepEqual(status.storeStatus, { status: 'ready', ready: true });
  assert.equal(JSON.stringify(status).includes('brave-secret-value'), false);
});

test('buildWebSearchSecretStatus treats a missing secure store as nothing configured', () => {
  const status = buildWebSearchSecretStatus({ backendService: {} });
  for (const keyId of WEB_SEARCH_PROVIDER_KEY_IDS) {
    assert.equal(status.configured[keyId], false);
  }
  assert.equal(status.storeStatus, null);
});

test('buildWebSearchSecretStatus treats a throwing secure store read as not configured for that key', () => {
  const secureStore = {
    getWebSearchProviderKey(keyId) {
      if (keyId === 'brave') {
        throw new Error('safeStorage is not ready');
      }
      return '';
    },
  };
  const status = buildWebSearchSecretStatus({ backendService: { secureStore } });
  assert.equal(status.configured.brave, false);
});

test('applyWebSearchSecret rejects an unknown key id', async () => {
  const secureStore = createFakeSecureStore();
  await assert.rejects(
    () => applyWebSearchSecret({
      backendService: { secureStore },
      payload: { keyId: 'not-a-real-provider', value: 'x' },
    }),
    /unknown web search provider key id/i
  );
});

test('applyWebSearchSecret saves the key and refreshes managed config', async () => {
  const secureStore = createFakeSecureStore();
  const refreshCalls = [];
  const managedBackendService = {
    secureStore,
    async refreshManagedConfig(reason) {
      refreshCalls.push(reason);
    },
  };

  const status = await applyWebSearchSecret({
    backendService: managedBackendService,
    payload: { keyId: 'brave', value: 'brave-secret-value' },
  });

  assert.equal(secureStore.getWebSearchProviderKey('brave'), 'brave-secret-value');
  assert.deepEqual(refreshCalls, ['web_search_provider_keys_updated']);
  assert.equal(status.configured.brave, true);
  assert.equal(status.configRefreshed, true);
});

test('applyWebSearchSecret resolves success with configRefreshed:false when the key persisted but the managed-config refresh throws', async () => {
  const secureStore = createFakeSecureStore();
  const managedBackendService = {
    secureStore,
    async refreshManagedConfig() {
      throw new Error('sidecar unreachable');
    },
  };

  const status = await applyWebSearchSecret({
    backendService: managedBackendService,
    payload: { keyId: 'brave', value: 'brave-secret-value' },
  });

  // The key persisted despite the refresh failure.
  assert.equal(secureStore.getWebSearchProviderKey('brave'), 'brave-secret-value');
  assert.equal(status.ok !== false, true, 'must not resolve as a failure');
  assert.equal(status.configRefreshed, false);
  assert.equal(status.configured.brave, true);
});

test('applyWebSearchSecret with an empty value clears the stored key', async () => {
  const secureStore = createFakeSecureStore({ serper: 'existing-secret' });
  const backendService = { secureStore, async refreshManagedConfig() {} };

  const status = await applyWebSearchSecret({
    backendService,
    payload: { keyId: 'serper', value: '' },
  });

  assert.equal(secureStore.getWebSearchProviderKey('serper'), '');
  assert.equal(status.configured.serper, false);
});

test('registerFeatureIpcHandlers registers the web search secret handlers only when deps are provided', () => {
  const registeredWithDeps = {};
  registerFeatureIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        registeredWithDeps[channel] = handler;
      },
    },
    getState: () => ({}),
    updateSettings: () => ({}),
    getWebSearchSecretStatus: () => ({ configured: {}, storeStatus: null }),
    setWebSearchSecret: () => ({ configured: {}, storeStatus: null }),
  });
  assert.ok('features:get-web-search-secret-status' in registeredWithDeps);
  assert.ok('features:set-web-search-secret' in registeredWithDeps);

  const registeredWithoutDeps = {};
  registerFeatureIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        registeredWithoutDeps[channel] = handler;
      },
    },
    getState: () => ({}),
    updateSettings: () => ({}),
  });
  assert.equal('features:get-web-search-secret-status' in registeredWithoutDeps, false);
  assert.equal('features:set-web-search-secret' in registeredWithoutDeps, false);
  assert.ok('features:get-state' in registeredWithoutDeps);
  assert.ok('features:update-settings' in registeredWithoutDeps);
});
