const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchModelListing, parseModelListing } = require('../services/backend/api-provider-discovery');

const KEY = 'sk-live-SUPERSECRETKEY-0123456789';
const publicLookup = async () => [{ address: '104.18.2.1', family: 4 }];
const privateLookup = async () => [{ address: '192.168.1.20', family: 4 }];
const T = 'openai_chat_completions_v1';

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetchImpl, calls };
}

const baseOptions = (fetchImpl, extra = {}) => ({
  endpoint: 'https://api.example.com/v1/',
  transport: T,
  authProfile: 'api_key_bearer',
  apiKey: KEY,
  lookup: publicLookup,
  fetchImpl,
  ...extra,
});

test('OpenAI style listing yields id-only rows', () => {
  assert.deepEqual(parseModelListing(T, { object: 'list', data: [{ id: 'gpt-6-luna', object: 'model', owned_by: 'x' }, { id: 'gpt-6-nano' }] }), [
    { id: 'gpt-6-luna' }, { id: 'gpt-6-nano' },
  ]);
});

test('OpenRouter listing reads context, output, tools, vision and reasoning', () => {
  const rows = parseModelListing(T, {
    data: [{
      id: 'openai/gpt-6-luna',
      context_length: 1050000,
      top_provider: { context_length: 999, max_completion_tokens: 128000 },
      supported_parameters: ['tools', 'reasoning', 'temperature'],
      architecture: { input_modalities: ['text', 'image'] },
      pricing: { prompt: '0.1' },
    }],
  });
  assert.deepEqual(rows, [{
    id: 'openai/gpt-6-luna', contextLength: 1050000, maxOutputTokens: 128000, tools: true, vision: true, reasoning: true,
  }]);
});

test('OpenRouter top_provider fields are used when the top-level ones are absent; include_reasoning counts', () => {
  const [row] = parseModelListing(T, {
    data: [{ id: 'm', top_provider: { context_length: 64000, max_completion_tokens: 8000 }, supported_parameters: ['include_reasoning'] }],
  });
  assert.deepEqual(row, { id: 'm', contextLength: 64000, maxOutputTokens: 8000, reasoning: true });
});

test('Groq listing reads context_window and max_completion_tokens', () => {
  assert.deepEqual(parseModelListing(T, { data: [{ id: 'openai/gpt-oss-120b', context_window: 131072, max_completion_tokens: 65536, active: true }] }), [
    { id: 'openai/gpt-oss-120b', contextLength: 131072, maxOutputTokens: 65536 },
  ]);
});

test('Mistral listing reads max_context_length and capabilities', () => {
  assert.deepEqual(parseModelListing(T, {
    data: [{ id: 'mistral-medium-latest', max_context_length: 262144, capabilities: { function_calling: true, vision: true, completion_chat: true } }],
  }), [{ id: 'mistral-medium-latest', contextLength: 262144, tools: true, vision: true }]);
});

test('vllm style max_model_len and the supports_* flags are honoured', () => {
  assert.deepEqual(parseModelListing(T, { data: [{ id: 'local', max_model_len: 32768, supports_tools: true, supports_image_input: true }] }), [
    { id: 'local', contextLength: 32768, tools: true, vision: true },
  ]);
});

test('Together returns a top-level array', () => {
  assert.deepEqual(parseModelListing(T, [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash', context_length: 1048576 }, { id: 'b' }]), [
    { id: 'deepseek-ai/DeepSeek-V4.1-Flash', contextLength: 1048576 }, { id: 'b' },
  ]);
});

test('Gemini ids lose the models/ prefix', () => {
  assert.deepEqual(parseModelListing(T, { data: [{ id: 'models/gemini-3.8-flash' }] }), [{ id: 'gemini-3.8-flash' }]);
});

test('bad rows and numbers are skipped, unknown fields are never copied, rows cap at 256', () => {
  const rows = parseModelListing(T, {
    data: [
      { id: 7 }, { id: '' }, { id: 'a\nb' }, null, 'x', { name: 'no-id' },
      { id: 'ok', context_length: -1, max_completion_tokens: 1.5, max_model_len: 20_000_000, secret: 'sk-leak', supported_parameters: 'tools' },
      { id: 'ok' },
      ...Array.from({ length: 300 }, (_, i) => ({ id: `m${i}` })),
    ],
  });
  assert.deepEqual(rows[0], { id: 'ok' });
  assert.equal(rows.length, 256);
  assert.ok(!JSON.stringify(rows).includes('sk-leak'));
});

test('unrecognized bodies parse to no rows', () => {
  for (const body of [null, 'x', 5, {}, { data: 'nope' }, { models: [{ id: 'a' }] }]) assert.deepEqual(parseModelListing(T, body), []);
});

test('a 200 listing returns rows and sends the bearer header with redirect refused', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse({ data: [{ id: 'm1', context_length: 8000 }] }));
  const result = await fetchModelListing(baseOptions(fetchImpl, { headers: [{ name: 'x-title', value: 'Jenny' }, { name: 'Cookie', value: 'a=b' }] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.rows, [{ id: 'm1', contextLength: 8000 }]);
  assert.ok(!Number.isNaN(Date.parse(result.fetchedAt)));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.example.com/v1/models');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'error');
  assert.ok(calls[0].init.signal);
  assert.deepEqual(calls[0].init.headers, { Accept: 'application/json', 'X-Title': 'Jenny', Authorization: `Bearer ${KEY}` });
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('the api_key_header profile sends x-api-key and the none profile sends no key', async () => {
  const header = recorder(() => jsonResponse({ data: [] }));
  await fetchModelListing(baseOptions(header.fetchImpl, { authProfile: 'api_key_header' }));
  assert.deepEqual(header.calls[0].init.headers, { Accept: 'application/json', 'x-api-key': KEY });
  const none = recorder(() => jsonResponse({ data: [] }));
  const result = await fetchModelListing(baseOptions(none.fetchImpl, { authProfile: 'none', apiKey: '' }));
  assert.equal(result.ok, true);
  assert.deepEqual(none.calls[0].init.headers, { Accept: 'application/json' });
});

test('plain http to a private host is allowed through the injected lookup', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse({ data: [{ id: 'local' }] }));
  const result = await fetchModelListing(baseOptions(fetchImpl, { endpoint: 'http://lab-box:8000/v1', lookup: privateLookup }));
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://lab-box:8000/v1/models');
});

test('HTTP failures are classified, carry the status, and never leak the key or body', async () => {
  const cases = [[401, 'unauthorized'], [403, 'unauthorized'], [429, 'rate_limited'], [500, 'provider_unavailable'], [503, 'provider_unavailable'], [404, 'http_error'], [400, 'http_error'], [307, 'redirect_refused'], [302, 'redirect_refused']];
  for (const [status, code] of cases) {
    const { fetchImpl } = recorder(() => new Response(`upstream said ${KEY}`, { status }));
    const result = await fetchModelListing(baseOptions(fetchImpl));
    assert.deepEqual(result, { ok: false, error: { code, status } }, String(status));
    assert.ok(!JSON.stringify(result).includes(KEY));
  }
});

test('a redirect TypeError from fetch maps to redirect_refused', async () => {
  const { fetchImpl } = recorder(() => { throw new TypeError('fetch failed', { cause: new Error(`unexpected redirect to https://x/?key=${KEY}`) }); });
  const result = await fetchModelListing(baseOptions(fetchImpl));
  assert.deepEqual(result, { ok: false, error: { code: 'redirect_refused' } });
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('other network errors map to network_error without echoing the message', async () => {
  const { fetchImpl } = recorder(() => { throw new TypeError(`connect ECONNREFUSED with ${KEY}`); });
  const result = await fetchModelListing(baseOptions(fetchImpl));
  assert.deepEqual(result, { ok: false, error: { code: 'network_error' } });
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('a hung request times out through the abort signal', async () => {
  const { fetchImpl } = recorder((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error(`aborted ${KEY}`), { name: 'AbortError' })));
  }));
  const result = await fetchModelListing(baseOptions(fetchImpl, { timeoutMs: 20 }));
  assert.deepEqual(result, { ok: false, error: { code: 'timeout' } });
});

test('an oversized body is rejected as soon as the cap is crossed', async () => {
  let cancelled = false;
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new TextEncoder().encode('x'.repeat(64)));
    },
    cancel() { cancelled = true; },
  });
  const { fetchImpl } = recorder(() => new Response(stream, { status: 200 }));
  const result = await fetchModelListing(baseOptions(fetchImpl, { maxBytes: 200 }));
  assert.deepEqual(result, { ok: false, error: { code: 'too_large' } });
  assert.equal(cancelled, true);
  assert.ok(pulled < 20, `stream was drained (${pulled} pulls)`);
});

test('a declared content-length over the cap is rejected without reading', async () => {
  const { fetchImpl } = recorder(() => new Response('{"data":[]}', { status: 200, headers: { 'content-length': '999999' } }));
  const result = await fetchModelListing(baseOptions(fetchImpl, { maxBytes: 100 }));
  assert.deepEqual(result, { ok: false, error: { code: 'too_large' } });
});

test('invalid JSON or the wrong shape is invalid_response without echoing the body', async () => {
  for (const text of [`not json ${KEY}`, '{"nope":true}', '"string"', 'null']) {
    const { fetchImpl } = recorder(() => new Response(text, { status: 200 }));
    const result = await fetchModelListing(baseOptions(fetchImpl));
    assert.deepEqual(result, { ok: false, error: { code: 'invalid_response' } }, text);
    assert.ok(!JSON.stringify(result).includes(KEY));
  }
});

test('a key profile with an empty or unusable key is key_missing and never fetches', async () => {
  for (const apiKey of ['', '   ', undefined, null, 'bad\nkey', 42]) {
    const { fetchImpl, calls } = recorder(() => jsonResponse({ data: [] }));
    const result = await fetchModelListing(baseOptions(fetchImpl, { apiKey }));
    assert.deepEqual(result, { ok: false, error: { code: 'key_missing' } });
    assert.equal(calls.length, 0);
  }
});

test('an invalid endpoint is refused before any fetch and the key is not echoed', async () => {
  const bad = ['http://public.example.com/v1', 'https://user:pw@api.example.com/v1', `https://api.example.com/v1?key=${KEY}`, 'ftp://x', '', undefined];
  for (const endpoint of bad) {
    const { fetchImpl, calls } = recorder(() => jsonResponse({ data: [] }));
    const result = await fetchModelListing(baseOptions(fetchImpl, { endpoint }));
    assert.deepEqual(result, { ok: false, error: { code: 'invalid_endpoint' } }, String(endpoint));
    assert.equal(calls.length, 0);
    assert.ok(!JSON.stringify(result).includes(KEY));
  }
});

test('an unknown auth profile is refused without fetching', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse({ data: [] }));
  const result = await fetchModelListing(baseOptions(fetchImpl, { authProfile: 'oauth' }));
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('the Anthropic transport sends x-api-key and anthropic-version and asks for one full page', async () => {
  const { fetchImpl, calls } = recorder(() => jsonResponse({
    data: [{ id: 'claude-sonnet-5-5', type: 'model', display_name: 'Claude Sonnet 5.5' }], has_more: false,
  }));
  const result = await fetchModelListing(baseOptions(fetchImpl, {
    endpoint: 'https://api.anthropic.com/v1', transport: 'anthropic_messages_v1', authProfile: 'api_key_header',
  }));
  assert.deepEqual(result.rows, [{ id: 'claude-sonnet-5-5' }]);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(calls[0].init.headers['x-api-key'], KEY);
  assert.equal(calls[0].init.headers['anthropic-version'], '2026-10-21');
  assert.equal(calls[0].init.headers.Authorization, undefined);
});
