'use strict';

const os = require('os');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePreferredEngineType } = require('../../services/shell-config-state');
const {
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
  resolveManagedConfiguredModel,
} = require('../../services/backend/managed-sidecar-config');

function makeFakeService({
  engineType, model, chatgptAuthService, secureStore, lastChatgptModel, catalogModels,
} = {}) {
  return {
    currentEngineType: engineType,
    currentModel: model || '',
    defaultModel: model || '',
    options: { userDataPath: os.tmpdir() },
    personalityWorkspace: { workspacePath: '' },
    featureFlags: {},
    providerIntegrationRegistry: { getManagedConfigPatch: () => ({}) },
    skillsService: null,
    secureStore: secureStore || null,
    chatgptAuthService: chatgptAuthService || null,
    ...(catalogModels === undefined ? {} : {
      chatgptModelCatalogService: { snapshot: () => ({ models: catalogModels }) },
    }),
    configService: {
      getState: () => ({
        localEngines: {},
        ...(lastChatgptModel === undefined ? {} : { lastChatgptModel }),
      }),
    },
    _emitServiceLog: () => {},
  };
}

const CATALOG_WITH_LUNA = Object.freeze([
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
]);

test('normalizePreferredEngineType accepts chatgpt', () => {
  assert.equal(normalizePreferredEngineType('chatgpt'), 'chatgpt');
  assert.equal(normalizePreferredEngineType(' ChatGPT '), 'chatgpt');
});

test('normalizePreferredEngineType still rejects unknown engine tokens', () => {
  assert.equal(normalizePreferredEngineType('chatgpt-plus'), '');
  assert.equal(normalizePreferredEngineType('bogus'), '');
});

test('resolveManagedConfiguredModel returns empty startup model for chatgpt with no last model, mirroring ollama', () => {
  const fake = makeFakeService({ engineType: 'chatgpt', model: '' });
  assert.equal(resolveManagedConfiguredModel(fake), '');
  const noLastModel = makeFakeService({ engineType: 'chatgpt', catalogModels: CATALOG_WITH_LUNA });
  assert.equal(resolveManagedConfiguredModel(noLastModel), '');
});

test('startup chatgpt model follows the last used catalog model', () => {
  const inCatalog = makeFakeService({
    engineType: 'chatgpt', lastChatgptModel: 'gpt-6-luna', catalogModels: CATALOG_WITH_LUNA,
  });
  assert.equal(buildManagedSidecarConfig(inCatalog).model, 'gpt-6-luna');

  // A stale or unknown id is never sent: the first turn would fail at the provider.
  const absent = makeFakeService({
    engineType: 'chatgpt', lastChatgptModel: 'gpt-6-luna', catalogModels: [{ id: 'gpt-5.5', label: 'GPT-5.5' }],
  });
  assert.equal(buildManagedSidecarConfig(absent).model, '');
  // No fetched catalog yet (snapshot models null) and no catalog service at all.
  const unfetched = makeFakeService({ engineType: 'chatgpt', lastChatgptModel: 'gpt-6-luna', catalogModels: null });
  assert.equal(buildManagedSidecarConfig(unfetched).model, '');
  const noService = makeFakeService({ engineType: 'chatgpt', lastChatgptModel: 'gpt-6-luna' });
  assert.equal(buildManagedSidecarConfig(noService).model, '');

  // An explicit selection still wins over the remembered model.
  const selected = makeFakeService({
    engineType: 'chatgpt', model: 'gpt-5.5', lastChatgptModel: 'gpt-6-luna', catalogModels: CATALOG_WITH_LUNA,
  });
  assert.equal(buildManagedSidecarConfig(selected).model, 'gpt-5.5');
});

test('the last chatgpt model never seeds ollama startup', () => {
  for (const engineType of ['ollama']) {
    const fake = makeFakeService({ engineType, lastChatgptModel: 'gpt-6-luna', catalogModels: CATALOG_WITH_LUNA });
    assert.equal(resolveManagedConfiguredModel(fake), '', engineType);
  }
});

test('resolveManagedConfiguredModel passes an explicitly selected chatgpt model through unchanged', () => {
  const fake = makeFakeService({ engineType: 'chatgpt', model: 'gpt-5.6' });
  assert.equal(resolveManagedConfiguredModel(fake), 'gpt-5.6');
});

test('buildManagedSidecarConfig threads the chatgpt account id and omits chatgpt_base_url (no last model)', () => {
  const fake = makeFakeService({
    engineType: 'chatgpt',
    chatgptAuthService: {
      getAccountId: () => 'acct_123',
    },
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.engine_type, 'chatgpt');
  assert.equal(config.chatgpt_account_id, 'acct_123');
  assert.equal(config.chatgpt_base_url, undefined);
  assert.equal(config.model, '');
  assert.equal(config.context_length, null);
});

test('buildManagedSidecarConfig defaults chatgpt_account_id to empty string when the auth service is absent', () => {
  const fake = makeFakeService({ engineType: 'chatgpt' });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.chatgpt_account_id, '');
});

test('buildManagedSidecarConfig omits chatgpt_account_id entirely for non-chatgpt engines', () => {
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    chatgptAuthService: { getAccountId: () => 'acct_123' },
  });
  const config = buildManagedSidecarConfig(fake);
  assert.equal(config.chatgpt_account_id, undefined);
  assert.equal(config.context_length, 32768);
});

for (const engineType of ['codex-cli', 'openai-compatible', 'vllm', 'replay']) {
  test(`buildManagedSidecarConfig leaves ${engineType} context length engine-owned`, () => {
    const fake = makeFakeService({ engineType, model: 'test-model' });
    const config = buildManagedSidecarConfig(fake);
    assert.equal(config.context_length, null);
  });
}

test('buildManagedSidecarSecrets carries the cached access token only for the chatgpt engine', () => {
  const fake = makeFakeService({
    engineType: 'chatgpt',
    chatgptAuthService: {
      getCachedAccessToken: () => 'sk-secret-token',
    },
  });
  const secrets = buildManagedSidecarSecrets(fake);
  assert.equal(secrets.chatgpt_access_token, 'sk-secret-token');
});

test('buildManagedSidecarSecrets omits chatgpt_access_token entirely for non-chatgpt engines', () => {
  const fake = makeFakeService({
    engineType: 'ollama',
    model: 'qwen3.5:9b',
    chatgptAuthService: { getCachedAccessToken: () => 'sk-secret-token' },
  });
  const secrets = buildManagedSidecarSecrets(fake);
  assert.equal('chatgpt_access_token' in secrets, false);
});

test('buildManagedSidecarSecrets defaults the token to empty string when the auth service is absent', () => {
  const fake = makeFakeService({ engineType: 'chatgpt' });
  const secrets = buildManagedSidecarSecrets(fake);
  assert.equal(secrets.chatgpt_access_token, '');
});

test('the chatgpt access token never leaks into the non-secrets config JSON', () => {
  const fake = makeFakeService({
    engineType: 'chatgpt',
    chatgptAuthService: {
      getAccountId: () => 'acct_123',
      getCachedAccessToken: () => 'sk-secret-token',
    },
  });
  const config = buildManagedSidecarConfig(fake);
  const secrets = buildManagedSidecarSecrets(fake);
  assert.equal(secrets.chatgpt_access_token, 'sk-secret-token');
  assert.doesNotMatch(JSON.stringify(config), /sk-secret-token/);
  // managed-sidecar-config.js never builds spawn args/argv itself — the
  // module's only outputs are the config and secrets objects above, and the
  // token is confirmed present in exactly one of them.
  for (const [moduleExport, value] of Object.entries(
    require('../../services/backend/managed-sidecar-config')
  )) {
    if (typeof value !== 'function') {
      assert.doesNotMatch(JSON.stringify(value ?? null), /sk-secret-token/, moduleExport);
    }
  }
});

test('managed sidecar treats crash-reporting opt-out independently of the chatgpt secret', () => {
  const fake = makeFakeService({
    engineType: 'chatgpt',
    chatgptAuthService: {
      getCachedAccessToken: () => 'sk-secret-token',
    },
    secureStore: {
      getSentryDsn: () => 'https://public@o123.ingest.sentry.io/456',
    },
  });
  const secrets = buildManagedSidecarSecrets(fake);
  assert.equal(secrets.telemetry_dsn, undefined);
  assert.equal(secrets.chatgpt_access_token, 'sk-secret-token');
});
