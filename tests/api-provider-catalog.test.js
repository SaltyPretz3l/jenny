const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApiProviderCatalog,
  defaultApiProviderCatalog,
} = require('../services/backend/api-provider-catalog');
const { resolveSelectionCost, resolveSelectionLimits } = require('../services/backend/api-provider-sidecar-config');
const { API_PROVIDER_PRESETS } = require('../services/backend/api-provider-presets');

function catalogFrom(payload) {
  return createApiProviderCatalog({ readFileSync: () => JSON.stringify(payload) });
}

const SNAPSHOT = {
  schema_version: 1,
  providers: {
    openrouter: [
      { id: 'qwen/qwen4', context_length: 262144, max_output_tokens: 999999, tools: true, vision: false, reasoning: true,
        cost_per_mtok_usd: { input: 0.2, output: 0.8 } },
      { id: 'qwen/qwen4', context_length: 1 },
      { id: 'bad/row', context_length: -5 },
      { id: 'priced/badly', context_length: 1000, cost_per_mtok_usd: { input: Number.MAX_VALUE, output: 1 } },
    ],
  },
};

test('rows are matched on the exact preset and model id and re-validated', () => {
  const catalog = catalogFrom(SNAPSHOT);
  const row = catalog.lookup('openrouter', 'qwen/qwen4');
  assert.equal(row.contextLength, 262144);
  assert.equal(row.maxOutputTokens, 262144);
  assert.deepEqual(row.costPerMtokUsd, { input: 0.2, output: 0.8 });
  assert.equal(catalog.lookup('openrouter', 'qwen/qwen4:free'), null);
  assert.equal(catalog.lookup('groq', 'qwen/qwen4'), null);
  assert.equal(catalog.lookup('openrouter', 'bad/row'), null);
  assert.equal(catalog.lookup('openrouter', 'priced/badly').costPerMtokUsd, undefined);
  assert.equal(catalog.size(), 2);
});

test('a damaged or unknown-shape file degrades to no catalog', () => {
  for (const readFileSync of [() => '{not json', () => JSON.stringify({ schema_version: 2, providers: {} }), () => { throw new Error('ENOENT'); }]) {
    const catalog = createApiProviderCatalog({ readFileSync });
    assert.equal(catalog.lookup('openrouter', 'qwen/qwen4'), null);
    assert.equal(catalog.size(), 0);
  }
});

test('the catalog is level 4 of the chain: below preset and provider, above the fallback', () => {
  const catalog = catalogFrom(SNAPSHOT);
  const instance = {
    presetId: 'openrouter',
    transport: 'openai_chat_completions_v1',
    models: [{ id: 'qwen/qwen4', enabled: true, pin: {} }],
    discovery: { rows: [] },
  };
  const limits = resolveSelectionLimits({ instance, modelId: 'qwen/qwen4' }, { catalog });
  assert.equal(limits.context_length, 262144);
  assert.equal(limits.sources.context_length, 'catalog');
  assert.equal(limits.reasoning, true);
  assert.equal(limits.sources.reasoning, 'catalog');

  const withProvider = { ...instance, discovery: { rows: [{ id: 'qwen/qwen4', contextLength: 131072 }] } };
  assert.equal(resolveSelectionLimits({ instance: withProvider, modelId: 'qwen/qwen4' }, { catalog }).sources.context_length, 'provider');
  const custom = { ...instance, presetId: null };
  assert.equal(resolveSelectionLimits({ instance: custom, modelId: 'qwen/qwen4' }, { catalog }).sources.context_length, 'fallback');
  assert.deepEqual(resolveSelectionCost({ instance, modelId: 'qwen/qwen4' }, { catalog }), { input: 0.2, output: 0.8 });
  assert.equal(resolveSelectionCost({ instance: custom, modelId: 'qwen/qwen4' }, { catalog }), null);
});

test('the shipped snapshot loads and covers every preset recommended model', () => {
  const catalog = defaultApiProviderCatalog();
  assert.ok(catalog.size() > 100);
  for (const preset of API_PROVIDER_PRESETS) {
    const row = catalog.lookup(preset.id, preset.recommendedModel);
    assert.ok(row, `${preset.id}/${preset.recommendedModel}`);
    assert.ok(row.contextLength > 0);
  }
});
