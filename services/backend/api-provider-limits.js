'use strict';

// Per-model limit resolution for user API-key providers (row 78). The result is
// snake_case because it goes to the sidecar verbatim, where
// validate_model_limits re-checks it: these numbers size a paid request.
// Per field the first hit wins: pin, preset, provider, catalog, fallback.

const FALLBACK_LIMITS = Object.freeze({
  context_length: 32768,
  max_output_tokens: 4096,
  tools: true,
  vision: false,
  reasoning: false,
});

const FIELDS = [
  { key: 'context_length', row: 'contextLength', pinKey: 'contextLength' },
  { key: 'max_output_tokens', row: 'maxOutputTokens', pinKey: 'maxOutputTokens' },
  { key: 'tools', row: 'tools' },
  { key: 'vision', row: 'vision' },
  { key: 'reasoning', row: 'reasoning' },
];

const MAX_LIMIT_TOKENS = 10_000_000;
const isValue = (field, value) => (
  field.pinKey ? Number.isInteger(value) && value > 0 && value <= MAX_LIMIT_TOKENS : typeof value === 'boolean'
);

function fallbackFor(key, instance) {
  // Tools are assumed only on the chat-completions bundle until a row says otherwise.
  if (key === 'tools') return instance?.transport === 'openai_chat_completions_v1';
  return FALLBACK_LIMITS[key];
}

function resolveField(field, instance, pin, rows) {
  if (field.pinKey && isValue(field, pin[field.pinKey])) return { value: pin[field.pinKey], source: 'pin' };
  for (const [source, row] of rows) {
    if (row && isValue(field, row[field.row])) return { value: row[field.row], source };
  }
  return { value: fallbackFor(field.key, instance), source: 'fallback' };
}

function resolveProviderModelLimits({ instance, modelId, presetRow = null, providerRow = null, catalogRow = null } = {}) {
  const model = (instance?.models || []).find((entry) => entry.id === modelId);
  const pin = model?.pin || {};
  const rows = [['preset', presetRow], ['provider', providerRow], ['catalog', catalogRow]];
  const limits = { sources: {} };
  for (const field of FIELDS) {
    const { value, source } = resolveField(field, instance, pin, rows);
    limits[field.key] = value;
    limits.sources[field.key] = source;
  }
  // A budget larger than the window is clamped; the output keeps its source.
  if (limits.max_output_tokens > limits.context_length) limits.max_output_tokens = limits.context_length;
  return {
    context_length: limits.context_length,
    max_output_tokens: limits.max_output_tokens,
    tools: limits.tools,
    vision: limits.vision,
    reasoning: limits.reasoning,
    sources: limits.sources,
  };
}

function limitsAreUnknown(limits) {
  return limits?.sources?.context_length === 'fallback';
}

module.exports = { FALLBACK_LIMITS, limitsAreUnknown, resolveProviderModelLimits };
