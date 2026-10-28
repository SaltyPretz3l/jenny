const test = require('node:test');
const assert = require('node:assert/strict');

const {
  API_PROVIDER_MODEL_PREFIX,
  MAX_DISCOVERED_ROWS,
  MAX_ENABLED_MODELS,
  MAX_INSTANCES,
  RESERVED_INSTANCE_IDS,
  buildProviderDescriptor,
  enabledModels,
  findInstance,
  generateInstanceId,
  namespacedModelId,
  normalizeApiProvidersConfig,
  parseNamespacedModelId,
} = require('../services/backend/api-provider-config');
const { getApiProviderPreset } = require('../services/backend/api-provider-presets');

const customInstance = (overrides = {}) => ({
  id: 'lab-box',
  presetId: null,
  label: 'Lab box',
  endpoint: 'https://llm.example.com/v1/',
  transport: 'openai_chat_completions_v1',
  authProfile: 'api_key_bearer',
  tokenLimitField: 'max_tokens',
  headers: [],
  models: [],
  ...overrides,
});

const normalizeOne = (instance) => normalizeApiProvidersConfig({ instances: [instance] }).instances[0];

test('garbage input normalizes to an empty config without throwing', () => {
  for (const raw of [undefined, null, 42, 'x', [], { instances: 'nope' }, { instances: [null, 1, 'a'] }]) {
    assert.deepEqual(normalizeApiProvidersConfig(raw), { instances: [], lastSelected: null });
  }
});

test('a custom instance is normalized to the full shape', () => {
  const instance = normalizeOne(customInstance({ models: [{ id: ' m1 ', enabled: true, pin: { contextLength: 8000 } }] }));
  assert.deepEqual(instance, {
    id: 'lab-box',
    presetId: null,
    label: 'Lab box',
    endpoint: 'https://llm.example.com/v1',
    transport: 'openai_chat_completions_v1',
    authProfile: 'api_key_bearer',
    tokenLimitField: 'max_tokens',
    headers: [],
    models: [{ id: 'm1', enabled: true, pin: { contextLength: 8000 } }],
    discovery: { fetchedAt: null, rows: [], error: null },
    noticeAcknowledgedAt: null,
  });
});

test('invalid ids, reserved ids, bad connection fields and bad endpoints drop the instance', () => {
  const bad = [
    customInstance({ id: 'A' }),
    customInstance({ id: '1abc' }),
    customInstance({ id: 'x' }),
    customInstance({ id: 'a'.repeat(33) }),
    ...RESERVED_INSTANCE_IDS.map((id) => customInstance({ id })),
    customInstance({ endpoint: 'ftp://llm.example.com' }),
    customInstance({ endpoint: 'https://llm.example.com/v1?key=abc' }),
    customInstance({ endpoint: 'https://user:pw@llm.example.com/v1' }),
    customInstance({ transport: 'carrier_pigeon_v1' }),
    // Each transport admits only the auth profiles its engine accepts.
    customInstance({ transport: 'openai_responses_v1', authProfile: 'api_key_header' }),
    customInstance({ transport: 'anthropic_messages_v1', authProfile: 'api_key_bearer' }),
    customInstance({ transport: 'anthropic_messages_v1', authProfile: 'none' }),
    customInstance({ authProfile: 'oauth' }),
    customInstance({ tokenLimitField: 'max_new_tokens' }),
    customInstance({ presetId: 'not-a-preset' }),
    customInstance({ label: '' }),
    customInstance({ label: 'x'.repeat(65) }),
  ];
  for (const instance of bad) {
    assert.deepEqual(normalizeApiProvidersConfig({ instances: [instance] }).instances, [], JSON.stringify(instance.id));
  }
});

test('plain http is shape-admitted here; the DNS check is the writer job', () => {
  assert.equal(normalizeOne(customInstance({ endpoint: 'http://lab-box:8000/v1' })).endpoint, 'http://lab-box:8000/v1');
});

test('a preset instance is forced to the preset connection even when the config is tampered', () => {
  const tampered = customInstance({
    id: 'my-groq',
    presetId: 'groq',
    label: 'Groq',
    endpoint: 'https://evil.example/v1',
    transport: 'openai_responses_v1',
    authProfile: 'none',
    tokenLimitField: 'max_tokens',
    headers: [{ name: 'X-Title', value: 'evil' }],
  });
  const groq = getApiProviderPreset('groq');
  const instance = normalizeOne(tampered);
  assert.equal(instance.endpoint, groq.endpoint);
  assert.equal(instance.transport, groq.transport);
  assert.equal(instance.authProfile, groq.authProfile);
  assert.equal(instance.tokenLimitField, 'max_completion_tokens');
  assert.deepEqual(instance.headers, []);
  const router = normalizeOne({ ...tampered, id: 'router', presetId: 'openrouter', headers: [] });
  assert.deepEqual(router.headers, [{ name: 'X-Title', value: 'Jenny' }]);
});

test('a preset instance with an unusable label falls back to the preset label', () => {
  assert.equal(normalizeOne({ id: 'my-groq', presetId: 'groq', label: 42 }).label, 'Groq');
});

test('instances are capped at 16 and de-duplicated by id, first wins', () => {
  const many = Array.from({ length: 20 }, (_, i) => customInstance({ id: `prov-${i}`, label: `P${i}` }));
  const config = normalizeApiProvidersConfig({ instances: [customInstance({ label: 'First' }), customInstance({ label: 'Second' }), ...many] });
  assert.equal(config.instances.length, MAX_INSTANCES);
  assert.equal(config.instances[0].label, 'First');
  assert.equal(config.instances.filter((i) => i.id === 'lab-box').length, 1);
});

test('headers are allowlisted, canonicalized, de-duplicated and value-checked', () => {
  const instance = normalizeOne(customInstance({
    headers: [
      { name: 'x-title', value: 'Jenny' },
      { name: 'X-TITLE', value: 'dupe' },
      { name: 'http-referer', value: 'https://jenny.example' },
      { name: 'Authorization', value: 'Bearer x' },
      { name: 'Cookie', value: 'a=b' },
      { name: 'constructor', value: 'x' },
      { name: '__proto__', value: 'x' },
      { name: 'toString', value: 'x' },
    ],
  }));
  assert.deepEqual(instance.headers, [
    { name: 'X-Title', value: 'Jenny' },
    { name: 'HTTP-Referer', value: 'https://jenny.example' },
  ]);
  for (const value of ['{{key}}', 'a{b', 'a}b', 'a\nb', '', 'x'.repeat(257), 7]) {
    assert.deepEqual(normalizeOne(customInstance({ headers: [{ name: 'X-Title', value }] })).headers, [], String(value));
  }
});

test('pins are positive integers within bounds and output never exceeds context', () => {
  const pinOf = (pin) => normalizeOne(customInstance({ models: [{ id: 'm', enabled: true, pin }] })).models[0].pin;
  assert.deepEqual(pinOf({ contextLength: 8000, maxOutputTokens: 4000 }), { contextLength: 8000, maxOutputTokens: 4000 });
  assert.deepEqual(pinOf({ contextLength: 8000, maxOutputTokens: 9000 }), { contextLength: 8000 });
  assert.deepEqual(pinOf({ maxOutputTokens: 9000 }), { maxOutputTokens: 9000 });
  assert.deepEqual(pinOf({ contextLength: 0, maxOutputTokens: -1 }), {});
  assert.deepEqual(pinOf({ contextLength: 1.5 }), {});
  assert.deepEqual(pinOf({ contextLength: 10_000_001 }), {});
  assert.deepEqual(pinOf({ contextLength: '8000' }), {});
  assert.deepEqual(pinOf(null), {});
});

test('model ids are trimmed, bounded, control-free and de-duplicated, first wins', () => {
  const models = normalizeOne(customInstance({
    models: [
      { id: 'a', enabled: true },
      { id: ' a ', enabled: false },
      { id: '', enabled: true },
      { id: 'x'.repeat(201), enabled: true },
      { id: 'bad\nid', enabled: true },
      { id: 7 },
      null,
      { id: 'b/with/slash', enabled: 'yes' },
    ],
  })).models;
  assert.deepEqual(models, [
    { id: 'a', enabled: true, pin: {} },
    { id: 'b/with/slash', enabled: false, pin: {} },
  ]);
});

test('only the first 64 enabled models stay enabled', () => {
  const models = Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, enabled: true }));
  const result = normalizeOne(customInstance({ models })).models;
  assert.equal(result.length, 80);
  assert.equal(enabledModels({ models: result }).length, MAX_ENABLED_MODELS);
  assert.equal(result[63].enabled, true);
  assert.equal(result[64].enabled, false);
});

test('discovery rows are capped at 256, deduped, and carry only the closed field set', () => {
  const rows = [
    { id: 'm0', contextLength: 8000, maxOutputTokens: 1000, tools: true, vision: false, reasoning: true, secret: 'sk-leak' },
    { id: 'm0', contextLength: 1 },
    { id: '' },
    { id: 'm1', contextLength: -5, tools: 'yes' },
    ...Array.from({ length: 300 }, (_, i) => ({ id: `extra-${i}` })),
  ];
  const discovery = normalizeOne(customInstance({
    discovery: { fetchedAt: '2026-10-25T10:00:00.000Z', rows, error: { code: 'unauthorized', status: 401, body: 'leak' } },
  })).discovery;
  assert.equal(discovery.rows.length, MAX_DISCOVERED_ROWS);
  assert.deepEqual(discovery.rows[0], { id: 'm0', contextLength: 8000, maxOutputTokens: 1000, tools: true, vision: false, reasoning: true });
  assert.deepEqual(discovery.rows[1], { id: 'm1' });
  assert.equal(discovery.fetchedAt, '2026-10-25T10:00:00.000Z');
  assert.deepEqual(discovery.error, { code: 'unauthorized', status: 401 });
});

test('discovery timestamps and errors that are not well formed become null', () => {
  const discovery = normalizeOne(customInstance({
    noticeAcknowledgedAt: 'yesterday',
    discovery: { fetchedAt: 'not a date', rows: 'x', error: { code: 'Bad Code!' } },
  }));
  assert.deepEqual(discovery.discovery, { fetchedAt: null, rows: [], error: null });
  assert.equal(discovery.noticeAcknowledgedAt, null);
  const ok = normalizeOne(customInstance({ noticeAcknowledgedAt: '2026-10-25T10:00:00.000Z' }));
  assert.equal(ok.noticeAcknowledgedAt, '2026-10-25T10:00:00.000Z');
});

test('lastSelected survives only when it names an existing instance and an enabled model', () => {
  const instance = customInstance({ models: [{ id: 'on', enabled: true }, { id: 'off', enabled: false }] });
  const select = (lastSelected) => normalizeApiProvidersConfig({ instances: [instance], lastSelected }).lastSelected;
  assert.deepEqual(select({ instanceId: 'lab-box', modelId: 'on' }), { instanceId: 'lab-box', modelId: 'on' });
  assert.equal(select({ instanceId: 'lab-box', modelId: 'off' }), null);
  assert.equal(select({ instanceId: 'lab-box', modelId: 'missing' }), null);
  assert.equal(select({ instanceId: 'gone', modelId: 'on' }), null);
  assert.equal(select('lab-box/on'), null);
  assert.equal(select(undefined), null);
});

test('generateInstanceId slugs the base and avoids existing and reserved ids', () => {
  assert.equal(generateInstanceId('My Cool Provider!'), 'my-cool-provider');
  assert.equal(generateInstanceId('Groq', []), 'groq');
  assert.equal(generateInstanceId('Groq', ['groq']), 'groq-2');
  assert.equal(generateInstanceId('Groq', ['groq', 'groq-2']), 'groq-3');
  assert.equal(generateInstanceId('OpenAI'), 'openai-2');
  assert.equal(generateInstanceId('ollama', new Set(['ollama-2'])), 'ollama-3');
  assert.equal(generateInstanceId('123 start'), 'start');
  assert.equal(generateInstanceId('###'), 'provider');
  assert.equal(generateInstanceId(''), 'provider');
  assert.equal(generateInstanceId(undefined, ['provider']), 'provider-2');
  const long = generateInstanceId('a'.repeat(60));
  assert.equal(long.length, 28);
  assert.ok(/^[a-z][a-z0-9-]{1,31}$/.test(generateInstanceId('a'.repeat(60), [long])));
  assert.ok(generateInstanceId('a'.repeat(60), [long]).length <= 32);
});

test('namespaced model ids round-trip, including model ids that contain slashes', () => {
  assert.equal(API_PROVIDER_MODEL_PREFIX, 'api-provider/');
  const id = namespacedModelId('router', 'openai/gpt-6-luna');
  assert.equal(id, 'api-provider/router/openai/gpt-6-luna');
  assert.deepEqual(parseNamespacedModelId(id), { instanceId: 'router', modelId: 'openai/gpt-6-luna' });
  assert.deepEqual(parseNamespacedModelId('api-provider/fw/accounts/fireworks/models/x'), {
    instanceId: 'fw', modelId: 'accounts/fireworks/models/x',
  });
  for (const bad of ['ollama/llama', 'api-provider/', 'api-provider/router', 'api-provider/router/', 'api-provider//m', 'api-provider/Bad/m', 'api-provider/router/ m', null, 5]) {
    assert.equal(parseNamespacedModelId(bad), null, String(bad));
  }
});

test('findInstance and enabledModels tolerate missing data', () => {
  const config = normalizeApiProvidersConfig({ instances: [customInstance({ models: [{ id: 'a', enabled: true }, { id: 'b' }] })] });
  assert.equal(findInstance(config, 'lab-box').id, 'lab-box');
  assert.equal(findInstance(config, 'nope'), null);
  assert.equal(findInstance(null, 'x'), null);
  assert.deepEqual(enabledModels(config.instances[0]).map((m) => m.id), ['a']);
  assert.deepEqual(enabledModels(null), []);
});

test('buildProviderDescriptor maps a preset instance with its snake_case catalog', () => {
  const descriptor = buildProviderDescriptor(normalizeOne({ id: 'router', presetId: 'openrouter', label: 'OpenRouter' }));
  assert.deepEqual(descriptor, {
    descriptor_schema_version: 6,
    provider_id: 'router',
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1',
    transport: 'openai_chat_completions_v1',
    auth_profile: 'api_key_bearer',
    token_limit_field: 'max_tokens',
    headers: [{ name: 'X-Title', value: 'Jenny' }],
    model_catalog: [{
      id: 'openai/gpt-6-luna', context_length: 1050000, max_output_tokens: 128000, tools: true, vision: true, reasoning: true,
    }],
  });
});

test('buildProviderDescriptor for a custom instance has an empty catalog and fresh header objects', () => {
  const instance = normalizeOne(customInstance({ headers: [{ name: 'X-Title', value: 'Jenny' }] }));
  const descriptor = buildProviderDescriptor(instance);
  assert.deepEqual(descriptor.model_catalog, []);
  assert.equal(descriptor.provider_id, 'lab-box');
  assert.deepEqual(descriptor.headers, [{ name: 'X-Title', value: 'Jenny' }]);
  assert.notEqual(descriptor.headers[0], instance.headers[0]);
});
