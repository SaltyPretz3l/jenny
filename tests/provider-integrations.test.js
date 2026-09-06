const test = require('node:test');
const assert = require('node:assert/strict');

const { createProviderIntegrationRegistry } = require('../services/backend/provider-integrations');

test('provider integration registry returns isolated merged model descriptors', () => {
  const providerModel = {
    id: 'qwen/custom-local',
    provider: 'openai-compatible',
    capabilities: {
      thinking: true,
    },
  };
  const seedEntry = {
    id: 'llama3.2',
    provider: 'ollama',
    metadata: {
      source: 'seed',
    },
  };
  const registry = createProviderIntegrationRegistry([
    {
      getModelCatalog() {
        return [providerModel];
      },
    },
  ]);

  const merged = registry.appendModelEntries([seedEntry], { engineType: 'openai-compatible' });
  merged[0].metadata.source = 'mutated';
  merged[1].capabilities.thinking = false;

  assert.equal(seedEntry.metadata.source, 'seed');
  assert.equal(providerModel.capabilities.thinking, true);

  const fresh = registry.appendModelEntries([seedEntry], { engineType: 'openai-compatible' });
  assert.equal(fresh[0].metadata.source, 'seed');
  assert.equal(
    fresh.find((entry) => entry.id === 'qwen/custom-local').capabilities.thinking,
    true
  );
});

test('provider integration registry returns isolated model availability snapshots', () => {
  const availability = {
    available: false,
    reason: 'Provider unavailable.',
    metadata: {
      source: 'cached',
    },
  };
  const registry = createProviderIntegrationRegistry([
    {
      isModelAvailable() {
        return availability;
      },
    },
  ]);

  const first = registry.resolveModelAvailability('qwen/custom-local');
  first.reason = 'mutated';
  first.metadata.source = 'mutated';

  const next = registry.resolveModelAvailability('qwen/custom-local');
  assert.equal(next.reason, 'Provider unavailable.');
  assert.equal(next.metadata.source, 'cached');
});

test('provider integration registry deep-clones managed config patch values', () => {
  const nestedPatch = {
    nested: {
      transport: 'stdio',
    },
  };
  const registry = createProviderIntegrationRegistry([
    {
      getManagedConfigPatch() {
        return {
          feature_flags: {
            local_test_integration: true,
          },
          local_config: nestedPatch,
        };
      },
    },
  ]);

  const first = registry.getManagedConfigPatch();
  first.local_config.nested.transport = 'mutated';

  const next = registry.getManagedConfigPatch();
  assert.equal(next.local_config.nested.transport, 'stdio');
  assert.equal(nestedPatch.nested.transport, 'stdio');
});

test('provider integration registry filters codex CLI catalog by engine type', () => {
  const registry = createProviderIntegrationRegistry([
    {
      getModelCatalog() {
        return [
          { id: 'codex-cli/default', provider: 'codex-cli' },
          { id: 'codex-cli/gpt-5.5', provider: 'codex-cli' },
        ];
      },
    },
  ]);

  assert.deepEqual(
    registry.appendModelEntries([], { engineType: 'codex-cli' }).map((entry) => entry.id),
    ['codex-cli/default', 'codex-cli/gpt-5.5']
  );
  assert.deepEqual(registry.appendModelEntries([], { engineType: 'ollama' }), []);
});
