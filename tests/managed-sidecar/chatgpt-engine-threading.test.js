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

function makeFakeService({ engineType, model, chatgptAuthService, secureStore } = {}) {
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
    configService: {
      getState: () => ({ localEngines: {} }),
    },
    _emitServiceLog: () => {},
  };
}

test('normalizePreferredEngineType accepts chatgpt', () => {
  assert.equal(normalizePreferredEngineType('chatgpt'), 'chatgpt');
  assert.equal(normalizePreferredEngineType(' ChatGPT '), 'chatgpt');
});

test('normalizePreferredEngineType still rejects unknown engine tokens', () => {
  assert.equal(normalizePreferredEngineType('chatgpt-plus'), '');
  assert.equal(normalizePreferredEngineType('bogus'), '');
});

test('resolveManagedConfiguredModel returns empty startup model for chatgpt, mirroring ollama', () => {
  const fake = makeFakeService({ engineType: 'chatgpt', model: '' });
  assert.equal(resolveManagedConfiguredModel(fake), '');
});

test('resolveManagedConfiguredModel passes an explicitly selected chatgpt model through unchanged', () => {
  const fake = makeFakeService({ engineType: 'chatgpt', model: 'gpt-5.6' });
  assert.equal(resolveManagedConfiguredModel(fake), 'gpt-5.6');
});

test('buildManagedSidecarConfig threads the chatgpt account id and omits chatgpt_base_url', () => {
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
