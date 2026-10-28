const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FALLBACK_LIMITS,
  limitsAreUnknown,
  resolveProviderModelLimits,
} = require('../services/backend/api-provider-limits');

const instance = (pin = {}, transport = 'openai_chat_completions_v1') => ({
  id: 'lab-box',
  transport,
  models: [{ id: 'm', enabled: true, pin }],
});

const FIELDS = ['context_length', 'max_output_tokens', 'tools', 'vision', 'reasoning'];

test('with no rows every field falls back and the context is reported unknown', () => {
  const limits = resolveProviderModelLimits({ instance: instance(), modelId: 'm' });
  assert.deepEqual({ ...limits, sources: undefined }, {
    context_length: 32768, max_output_tokens: 4096, tools: true, vision: false, reasoning: false, sources: undefined,
  });
  for (const field of FIELDS) assert.equal(limits.sources[field], 'fallback');
  assert.equal(limitsAreUnknown(limits), true);
  assert.equal(FALLBACK_LIMITS.context_length, 32768);
  assert.ok(Object.isFrozen(FALLBACK_LIMITS));
});

test('tools falls back to false on a transport without the chat-completions default', () => {
  const limits = resolveProviderModelLimits({ instance: instance({}, 'anthropic_messages_v1'), modelId: 'm' });
  assert.equal(limits.tools, false);
});

test('the chain order per field is pin, preset, provider, catalog, fallback', () => {
  const presetRow = { contextLength: 200000, maxOutputTokens: 20000, tools: false };
  const providerRow = { contextLength: 100000, maxOutputTokens: 10000, tools: true, vision: true };
  const catalogRow = { contextLength: 50000, maxOutputTokens: 5000, tools: true, vision: false, reasoning: true };
  const limits = resolveProviderModelLimits({
    instance: instance({ contextLength: 300000 }), modelId: 'm', presetRow, providerRow, catalogRow,
  });
  assert.equal(limits.context_length, 300000);
  assert.equal(limits.max_output_tokens, 20000);
  assert.equal(limits.tools, false);
  assert.equal(limits.vision, true);
  assert.equal(limits.reasoning, true);
  assert.deepEqual(limits.sources, {
    context_length: 'pin', max_output_tokens: 'preset', tools: 'preset', vision: 'provider', reasoning: 'catalog',
  });
  assert.equal(limitsAreUnknown(limits), false);
});

test('provider beats catalog and catalog beats fallback when higher levels are silent', () => {
  const a = resolveProviderModelLimits({
    instance: instance(), modelId: 'm', providerRow: { contextLength: 64000 }, catalogRow: { contextLength: 8000, maxOutputTokens: 2000 },
  });
  assert.deepEqual([a.context_length, a.sources.context_length], [64000, 'provider']);
  assert.deepEqual([a.max_output_tokens, a.sources.max_output_tokens], [2000, 'catalog']);
  assert.equal(a.sources.vision, 'fallback');
});

test('a pinned output wins over every row', () => {
  const limits = resolveProviderModelLimits({
    instance: instance({ maxOutputTokens: 1000 }), modelId: 'm', presetRow: { contextLength: 100000, maxOutputTokens: 50000 },
  });
  assert.deepEqual([limits.max_output_tokens, limits.sources.max_output_tokens], [1000, 'pin']);
  assert.deepEqual([limits.context_length, limits.sources.context_length], [100000, 'preset']);
});

test('only context and output can be pinned: flags in a pin are ignored', () => {
  const limits = resolveProviderModelLimits({
    instance: instance({ tools: false, vision: true }), modelId: 'm', providerRow: { tools: true },
  });
  assert.deepEqual([limits.tools, limits.sources.tools], [true, 'provider']);
  assert.deepEqual([limits.vision, limits.sources.vision], [false, 'fallback']);
});

test('an output larger than the resolved context is clamped and keeps its source', () => {
  const limits = resolveProviderModelLimits({
    instance: instance({ contextLength: 8000 }), modelId: 'm', presetRow: { contextLength: 1000000, maxOutputTokens: 128000 },
  });
  assert.equal(limits.context_length, 8000);
  assert.equal(limits.max_output_tokens, 8000);
  assert.equal(limits.sources.max_output_tokens, 'preset');
  const fallbackClamp = resolveProviderModelLimits({ instance: instance({ contextLength: 2000 }), modelId: 'm' });
  assert.equal(fallbackClamp.max_output_tokens, 2000);
  assert.equal(fallbackClamp.sources.max_output_tokens, 'fallback');
});

test('invalid row values are skipped rather than winning', () => {
  const limits = resolveProviderModelLimits({
    instance: instance(), modelId: 'm',
    presetRow: { contextLength: 0, maxOutputTokens: 1.5, tools: 'yes' },
    providerRow: { contextLength: 20_000_000, vision: true },
  });
  assert.equal(limits.context_length, 32768);
  assert.equal(limits.sources.context_length, 'fallback');
  assert.equal(limits.sources.vision, 'provider');
  assert.equal(limits.sources.tools, 'fallback');
});

test('an unknown instance or model still resolves from the rows, and the result has exactly the sidecar shape', () => {
  const limits = resolveProviderModelLimits({ instance: instance(), modelId: 'other', presetRow: { contextLength: 4000 } });
  assert.equal(limits.context_length, 4000);
  assert.deepEqual(Object.keys(limits).sort(), [...FIELDS, 'sources'].sort());
  assert.deepEqual(Object.keys(limits.sources).sort(), [...FIELDS].sort());
  assert.equal(limitsAreUnknown(null), false);
  assert.equal(resolveProviderModelLimits({ modelId: 'm' }).sources.context_length, 'fallback');
});
