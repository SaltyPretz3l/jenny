'use strict';

// Frozen preset data for user API-key providers (row 78). Context and output
// limits come from the models.dev catalog (MIT). Presets are the only source of
// an endpoint a label can point at: the config normalizer forces these values.

const CUSTOM_ENDPOINT_PRESET_ID = 'custom';
const API_PROVIDER_TRANSPORTS = Object.freeze([
  'openai_chat_completions_v1',
  'openai_responses_v1',
  'anthropic_messages_v1',
]);
const API_PROVIDER_AUTH_PROFILES = Object.freeze(['api_key_bearer', 'api_key_header', 'none']);
// The auth profiles each transport admits; the sidecar engines refuse any other pair.
const API_PROVIDER_TRANSPORT_AUTH = Object.freeze({
  openai_chat_completions_v1: Object.freeze(['api_key_bearer', 'api_key_header', 'none']),
  openai_responses_v1: Object.freeze(['api_key_bearer']),
  anthropic_messages_v1: Object.freeze(['api_key_header']),
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function preset(id, label, endpoint, tokenLimitField, keyHelpHost, model, limits, {
  headers = [],
  transport = 'openai_chat_completions_v1',
  authProfile = 'api_key_bearer',
} = {}) {
  const [contextLength, maxOutputTokens, tools, vision, reasoning] = limits;
  return {
    id,
    label,
    endpoint,
    transport,
    authProfile,
    tokenLimitField,
    headers,
    keyHelpHost,
    recommendedModel: model,
    modelCatalog: [{ id: model, contextLength, maxOutputTokens, tools, vision, reasoning }],
  };
}

const API_PROVIDER_PRESETS = deepFreeze([
  preset('openai-api', 'OpenAI API', 'https://api.openai.com/v1', 'max_completion_tokens',
    'platform.openai.com', 'gpt-6-luna', [1050000, 128000, true, true, true], { transport: 'openai_responses_v1' }),
  preset('anthropic-api', 'Anthropic API', 'https://api.anthropic.com/v1', 'max_tokens',
    'console.anthropic.com', 'claude-sonnet-5-5', [1000000, 128000, true, true, true],
    { transport: 'anthropic_messages_v1', authProfile: 'api_key_header' }),
  preset('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'max_tokens',
    'openrouter.ai', 'openai/gpt-6-luna', [1050000, 128000, true, true, true],
    { headers: [{ name: 'X-Title', value: 'Jenny' }] }),
  preset('groq', 'Groq', 'https://api.groq.com/openai/v1', 'max_completion_tokens',
    'console.groq.com', 'openai/gpt-oss-120b', [131072, 65536, true, false, true]),
  preset('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', 'max_tokens',
    'platform.deepseek.com', 'deepseek-flash', [1048576, 393216, true, true, true]),
  preset('mistral', 'Mistral', 'https://api.mistral.ai/v1', 'max_tokens',
    'console.mistral.ai', 'mistral-medium-latest', [262144, 262144, true, true, true]),
  preset('xai', 'xAI', 'https://api.x.ai/v1', 'max_tokens',
    'console.x.ai', 'grok-4.7', [500000, 500000, true, true, true]),
  preset('together', 'Together', 'https://api.together.xyz/v1', 'max_tokens',
    'api.together.ai', 'deepseek-ai/DeepSeek-V4.1-Flash', [1048576, 384000, true, true, true]),
  preset('fireworks', 'Fireworks', 'https://api.fireworks.ai/inference/v1', 'max_tokens',
    'fireworks.ai', 'accounts/fireworks/models/deepseek-v4p1-flash-1017', [1000000, 384000, true, true, true]),
  preset('gemini-openai', 'Gemini (OpenAI-compatible)', 'https://generativelanguage.googleapis.com/v1beta/openai',
    'max_tokens', 'aistudio.google.com', 'gemini-3.8-flash', [1048576, 65536, true, true, true]),
]);

function getApiProviderPreset(id) {
  return API_PROVIDER_PRESETS.find((entry) => entry.id === id) || null;
}

module.exports = {
  API_PROVIDER_AUTH_PROFILES,
  API_PROVIDER_PRESETS,
  API_PROVIDER_TRANSPORT_AUTH,
  API_PROVIDER_TRANSPORTS,
  CUSTOM_ENDPOINT_PRESET_ID,
  getApiProviderPreset,
};
