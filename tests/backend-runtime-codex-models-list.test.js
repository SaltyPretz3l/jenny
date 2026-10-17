'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listModels } = require('../services/backend/backend-runtime');
const { createProviderIntegrationRegistry } = require('../services/backend/provider-integrations');

function service({ engine = 'ollama', codexReady = true, ollamaAvailable = true, cacheable = false } = {}) {
  const calls = [];
  const catalog = [
    { id: 'codex-cli/default', provider: 'codex-cli', available: codexReady, reason: '' },
    { id: 'codex-cli/gpt-6-luna', provider: 'codex-cli', available: codexReady, reason: '' },
  ];
  return {
    calls,
    catalog,
    // A sidecar client makes the aggregate cacheable for the TTL.
    ...(cacheable ? { sidecarClient: {} } : {}),
    currentEngineType: engine,
    currentModel: '',
    defaultModel: 'qwen3:8b',
    configService: { getState: () => ({ chatgptModelsEnabled: false }) },
    providerIntegrationRegistry: createProviderIntegrationRegistry([
      { getModelCatalog: () => catalog },
    ]),
    async listModelsForEngine(engineType) {
      calls.push(engineType);
      const available = engineType === 'codex-cli' ? codexReady : ollamaAvailable;
      const data = engineType === 'codex-cli'
        ? catalog
        : ollamaAvailable ? [{ id: 'qwen3:8b', available: true }] : [];
      return { object: 'list', engine_type: engineType, available, data };
    },
  };
}

const ids = (payload) => payload.data.map((entry) => `${entry.engine_type}:${entry.id}`);
const codexIds = ['codex-cli:codex-cli/default', 'codex-cli:codex-cli/gpt-6-luna'];

test('a ready Codex integration on Ollama lists Codex models with their own engine hints', async () => {
  const svc = service();
  const payload = await listModels(svc);
  assert.deepEqual(ids(payload), ['ollama:qwen3:8b', ...codexIds]);
  assert.equal(svc._modelEngineHints.get('codex-cli/gpt-6-luna'), 'codex-cli');
  assert.equal(svc.currentEngineType, 'ollama');
  assert.deepEqual(svc.calls, ['ollama']);
});

test('ready Codex models make the aggregate available when Ollama is unavailable', async () => {
  const svc = service({ ollamaAvailable: false });
  const payload = await listModels(svc);
  assert.deepEqual(ids(payload), codexIds);
  assert.equal(payload.available, true);
  assert.equal(payload.primary_available, false);
  assert.equal(svc.currentEngineType, 'ollama');
  assert.deepEqual(svc.calls, ['ollama']);
});

test('an unavailable Codex integration is omitted from the Ollama model list', async () => {
  for (const ollamaAvailable of [true, false]) {
    const svc = service({ codexReady: false, ollamaAvailable });
    const payload = await listModels(svc);
    assert.deepEqual(payload, {
      object: 'list',
      engine_type: 'ollama',
      available: ollamaAvailable,
      primary_available: ollamaAvailable,
      data: ollamaAvailable ? [{ id: 'qwen3:8b', available: true, engine_type: 'ollama' }] : [],
    });
    assert.equal(svc.currentEngineType, 'ollama');
    assert.deepEqual(svc.calls, ['ollama']);
  }
});

test('Codex auth becoming ready inside the cache TTL is not served the earlier list', async () => {
  const svc = service({ codexReady: false, cacheable: true });
  const first = await listModels(svc);
  assert.deepEqual(ids(first), ['ollama:qwen3:8b']);
  assert.equal(await listModels(svc), first, 'unchanged availability inside the TTL is a cache hit');
  for (const entry of svc.catalog) entry.available = true;
  const second = await listModels(svc);
  assert.deepEqual(ids(second), ['ollama:qwen3:8b', ...codexIds]);
  assert.equal(await listModels(svc), second, 'the refreshed list is cached in turn');
  assert.deepEqual(svc.calls, ['ollama', 'ollama']);
});

test('a Codex engine lists ready Codex models once when its own list has the same ids', async () => {
  const svc = service({ engine: 'codex-cli', ollamaAvailable: false });
  const payload = await listModels(svc);
  assert.deepEqual(ids(payload), codexIds);
  assert.equal(svc._modelEngineHints.get('codex-cli/gpt-6-luna'), 'codex-cli');
  assert.equal(svc.currentEngineType, 'codex-cli');
  assert.deepEqual(svc.calls, ['codex-cli', 'ollama']);
});
