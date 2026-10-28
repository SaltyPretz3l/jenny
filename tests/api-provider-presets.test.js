const test = require('node:test');
const assert = require('node:assert/strict');

const {
  API_PROVIDER_AUTH_PROFILES,
  API_PROVIDER_PRESETS,
  API_PROVIDER_TRANSPORTS,
  CUSTOM_ENDPOINT_PRESET_ID,
  getApiProviderPreset,
} = require('../services/backend/api-provider-presets');
const { buildProviderDescriptor } = require('../services/backend/api-provider-config');
const { parseProviderEndpoint } = require('../services/backend/api-provider-endpoint');

function deepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

test('presets are listed in the contract order and deep-frozen', () => {
  assert.deepEqual(API_PROVIDER_PRESETS.map((preset) => preset.id), [
    'openai-api', 'anthropic-api', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'together', 'fireworks', 'gemini-openai',
  ]);
  assert.ok(deepFrozen(API_PROVIDER_PRESETS));
  assert.ok(deepFrozen(API_PROVIDER_TRANSPORTS));
  assert.ok(deepFrozen(API_PROVIDER_AUTH_PROFILES));
  assert.throws(() => { 'use strict'; API_PROVIDER_PRESETS[0].endpoint = 'https://evil.example/v1'; }, TypeError);
});

test('constants carry the transport vocabulary', () => {
  assert.equal(CUSTOM_ENDPOINT_PRESET_ID, 'custom');
  assert.deepEqual([...API_PROVIDER_TRANSPORTS], ['openai_chat_completions_v1', 'openai_responses_v1', 'anthropic_messages_v1']);
  assert.deepEqual([...API_PROVIDER_AUTH_PROFILES], ['api_key_bearer', 'api_key_header', 'none']);
});

// OpenAI speaks Responses and Anthropic speaks Messages with its x-api-key header; the rest are Chat Completions.
const PRESET_WIRES = {
  'openai-api': ['openai_responses_v1', 'api_key_bearer'],
  'anthropic-api': ['anthropic_messages_v1', 'api_key_header'],
};

test('every preset is https, has its transport and auth and carries exactly one catalog row for its recommended model', () => {
  for (const preset of API_PROVIDER_PRESETS) {
    assert.equal(parseProviderEndpoint(preset.endpoint).url.protocol, 'https:', preset.id);
    const [transport, authProfile] = PRESET_WIRES[preset.id] || ['openai_chat_completions_v1', 'api_key_bearer'];
    assert.equal(preset.transport, transport, preset.id);
    assert.equal(preset.authProfile, authProfile, preset.id);
    assert.ok(['max_tokens', 'max_completion_tokens'].includes(preset.tokenLimitField), preset.id);
    assert.equal(preset.modelCatalog.length, 1);
    assert.equal(preset.modelCatalog[0].id, preset.recommendedModel);
    assert.ok(preset.modelCatalog[0].maxOutputTokens <= preset.modelCatalog[0].contextLength, preset.id);
    assert.ok(preset.keyHelpHost && !preset.keyHelpHost.includes('/'), preset.id);
  }
});

test('only OpenRouter sends an attribution header', () => {
  for (const preset of API_PROVIDER_PRESETS) {
    assert.deepEqual(preset.headers, preset.id === 'openrouter' ? [{ name: 'X-Title', value: 'Jenny' }] : [], preset.id);
  }
});

test('spot-checked limits and token fields match the table', () => {
  const groq = getApiProviderPreset('groq');
  assert.equal(groq.tokenLimitField, 'max_completion_tokens');
  assert.deepEqual({ ...groq.modelCatalog[0] }, {
    id: 'openai/gpt-oss-120b', contextLength: 131072, maxOutputTokens: 65536, tools: true, vision: false, reasoning: true,
  });
  assert.equal(getApiProviderPreset('openai-api').tokenLimitField, 'max_completion_tokens');
  assert.equal(getApiProviderPreset('xai').modelCatalog[0].contextLength, 500000);
  assert.equal(getApiProviderPreset('gemini-openai').endpoint, 'https://generativelanguage.googleapis.com/v1beta/openai');
});

test('getApiProviderPreset returns null for unknown ids', () => {
  assert.equal(getApiProviderPreset('nope'), null);
  assert.equal(getApiProviderPreset(CUSTOM_ENDPOINT_PRESET_ID), null);
  assert.equal(getApiProviderPreset(undefined), null);
});

test('each preset builds a descriptor with an https endpoint and a valid token field', () => {
  for (const preset of API_PROVIDER_PRESETS) {
    const descriptor = buildProviderDescriptor({
      id: preset.id,
      presetId: preset.id,
      label: preset.label,
      endpoint: preset.endpoint,
      transport: preset.transport,
      authProfile: preset.authProfile,
      headers: [...preset.headers],
      tokenLimitField: preset.tokenLimitField,
    });
    assert.equal(descriptor.descriptor_schema_version, 6);
    assert.ok(descriptor.endpoint.startsWith('https://'), preset.id);
    assert.ok(['max_tokens', 'max_completion_tokens'].includes(descriptor.token_limit_field), preset.id);
    assert.equal(descriptor.model_catalog.length, 1);
  }
});
