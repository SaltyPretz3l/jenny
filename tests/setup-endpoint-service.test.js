'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SetupEndpointService } = require('../services/setup-endpoint-service');
const { normalizeReadinessProbe } = require('../services/setup-service-helpers');

function response(body, { status = 200, contentLength = 0 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentLength ? String(contentLength) : null },
    json: async () => body,
  };
}

test('endpoint validation requires a bounded non-empty engine-specific catalog', async () => {
  const payloads = [
    response({ models: [] }),
    response({ data: [] }),
    response({ models: [{ name: 'qwen3:8b' }] }),
  ];
  const service = new SetupEndpointService({ fetchImpl: async () => payloads.shift() });

  assert.equal((await service.validate({ engineType: 'ollama' })).code, 'empty_catalog');
  assert.equal((await service.validate({ engineType: 'vllm' })).code, 'empty_catalog');
  assert.equal((await service.validate({ engineType: 'ollama' })).ok, true);
});

test('endpoint validation authenticates only against the managed llama-server origin', async () => {
  const seenHeaders = [];
  const manager = { getApiKey: () => 'k3y', getBaseUrl: () => 'http://localhost:8033/v1' };
  const service = new SetupEndpointService({
    fetchImpl: async (_url, init) => {
      seenHeaders.push(init.headers);
      return response({ data: [{ id: 'local-model' }] });
    },
    getLlamaServerManager: () => manager,
  });

  assert.equal((await service.validate({ engineType: 'openai-compatible' })).ok, true);
  assert.equal((await service.validate({
    engineType: 'openai-compatible', apiUrl: 'http://127.0.0.1:9000/v1',
  })).ok, true);
  assert.equal((await service.validate({ engineType: 'vllm' })).ok, true);
  assert.deepEqual(seenHeaders, [
    { Accept: 'application/json', Authorization: 'Bearer k3y' },
    { Accept: 'application/json' },
    { Accept: 'application/json' },
  ]);

  // No manager, or a manager without a key, leaves the probe anonymous.
  const anonymous = new SetupEndpointService({
    fetchImpl: async (_url, init) => {
      seenHeaders.push(init.headers);
      return response({ data: [{ id: 'local-model' }] });
    },
    getLlamaServerManager: () => ({ getApiKey: () => '', getBaseUrl: () => 'http://127.0.0.1:8033/v1' }),
  });
  assert.equal((await anonymous.validate({ engineType: 'openai-compatible' })).ok, true);
  assert.deepEqual(seenHeaders.at(-1), { Accept: 'application/json' });
});

test('endpoint validation rejects oversized and public catalogs before persistence', async () => {
  let fetchCalls = 0;
  const service = new SetupEndpointService({
    fetchImpl: async () => {
      fetchCalls += 1;
      return response({}, { contentLength: 1024 * 1024 + 1 });
    },
  });

  const oversized = await service.validate({ engineType: 'openai-compatible', apiUrl: 'http://10.0.0.8:8033/v1' });
  const publicResult = await service.validate({ engineType: 'openai-compatible', apiUrl: 'https://example.com/v1' });
  assert.equal(oversized.code, 'catalog_too_large');
  assert.equal(publicResult.code, 'non_local_endpoint');
  assert.equal(fetchCalls, 1);
});

test('endpoint validation rejects bind-all hosts and noncanonical provider paths', async () => {
  let fetchCalls = 0;
  const service = new SetupEndpointService({
    fetchImpl: async () => {
      fetchCalls += 1;
      return response({ models: [{ name: 'gemma3:latest' }] });
    },
  });

  const customPath = await service.validate({
    engineType: 'ollama',
    apiUrl: 'http://127.0.0.1:11434/custom',
  });
  const bindAll = await service.validate({
    engineType: 'openai-compatible',
    apiUrl: 'http://0.0.0.0:8033/v1',
  });
  const loopbackLookalike = await service.validate({
    engineType: 'ollama',
    apiUrl: 'http://127.example:11434',
  });
  assert.equal(customPath.code, 'invalid_url');
  assert.equal(bindAll.code, 'non_local_endpoint');
  assert.equal(loopbackLookalike.code, 'non_local_endpoint');
  assert.equal(fetchCalls, 0);
});

test('endpoint validation rejects catalogs with the wrong model-entry shape', async () => {
  const responses = [
    response({ models: ['qwen3:8b'] }),
    response({ data: [{ name: 'missing-openai-id' }] }),
  ];
  const service = new SetupEndpointService({ fetchImpl: async () => responses.shift() });

  assert.equal((await service.validate({ engineType: 'ollama' })).code, 'empty_catalog');
  assert.equal((await service.validate({ engineType: 'vllm' })).code, 'empty_catalog');
});

// A server that lists no models while its engine starts reports `loaded: false` on /health.
function loadingFetch(healthReply, { calls = [], models = { data: [] } } = {}) {
  return async (url, init) => {
    calls.push({ url, init });
    if (new URL(url).pathname === '/health') {
      if (healthReply instanceof Error) throw healthReply;
      return healthReply;
    }
    return response(models);
  };
}

test('an empty OpenAI-compatible catalog on a still-loading server says it is loading', async () => {
  const calls = [];
  const service = new SetupEndpointService({
    fetchImpl: loadingFetch(response({ status: 'ok', loaded: false, service: 'strata' }), { calls }),
  });
  const result = await service.validate({ engineType: 'openai-compatible', apiUrl: 'http://127.0.0.1:8033/v1' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'model_loading');
  assert.equal(result.retryable, true);
  assert.equal(result.error_code, 'CMP-SETUP-0001');
  assert.equal(result.message, 'The server is still loading its model. Wait for it to finish, then validate again.');
  assert.deepEqual(calls.map((call) => call.url), ['http://127.0.0.1:8033/v1/models', 'http://127.0.0.1:8033/health']);
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.redirect, 'error');
  assert.ok(calls[1].init.signal, 'the health probe shares the validation abort signal');
});

test('an empty OpenAI-compatible catalog stays empty_catalog unless /health says loaded is false', async () => {
  const replies = {
    loaded: response({ loaded: true }),
    absent: response({ status: 'ok' }),
    notObject: response([{ loaded: false }]),
    notFalse: response({ loaded: 0 }),
    http404: response({ loaded: false }, { status: 404 }),
    oversized: response({ loaded: false }, { contentLength: 64 * 1024 + 1 }),
    nonJson: { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('bad json'); } },
    throws: new Error('connection refused'),
  };
  for (const [name, reply] of Object.entries(replies)) {
    const service = new SetupEndpointService({ fetchImpl: loadingFetch(reply) });
    const result = await service.validate({ engineType: 'openai-compatible' });
    assert.equal(result.code, 'empty_catalog', name);
    assert.equal(result.message, 'Endpoint returned no usable models.', name);
  }
});

test('a /health probe that times out reports empty_catalog, not a timeout', async () => {
  const service = new SetupEndpointService({
    timeoutMs: 20,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname !== '/health') return response({ data: [] });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    },
  });
  assert.equal((await service.validate({ engineType: 'openai-compatible' })).code, 'empty_catalog');
});

test('ollama and vllm empty catalogs and non-empty catalogs never request /health', async () => {
  const calls = [];
  const fetchImpl = loadingFetch(response({ loaded: false }), { calls });
  const service = new SetupEndpointService({ fetchImpl });
  assert.equal((await service.validate({ engineType: 'vllm' })).code, 'empty_catalog');
  const ollama = new SetupEndpointService({ fetchImpl: loadingFetch(response({ loaded: false }), { calls, models: { models: [] } }) });
  assert.equal((await ollama.validate({ engineType: 'ollama' })).code, 'empty_catalog');
  const full = new SetupEndpointService({
    fetchImpl: loadingFetch(response({ loaded: false }), { calls, models: { data: [{ id: 'm' }] } }),
  });
  assert.equal((await full.validate({ engineType: 'openai-compatible' })).ok, true);

  assert.equal(calls.some((call) => new URL(call.url).pathname === '/health'), false);
});

test('the /health probe carries the managed key only for the managed server origin', async () => {
  const calls = [];
  const manager = { getApiKey: () => 'k3y', getBaseUrl: () => 'http://localhost:8033/v1' };
  const service = new SetupEndpointService({
    fetchImpl: loadingFetch(response({ loaded: false }), { calls }),
    getLlamaServerManager: () => manager,
  });

  assert.equal((await service.validate({ engineType: 'openai-compatible' })).code, 'model_loading');
  assert.equal((await service.validate({
    engineType: 'openai-compatible', apiUrl: 'http://127.0.0.1:9000/v1',
  })).code, 'model_loading');
  const health = calls.filter((call) => new URL(call.url).pathname === '/health');
  assert.deepEqual(health.map((call) => call.init.headers), [
    { Accept: 'application/json', Authorization: 'Bearer k3y' },
    { Accept: 'application/json' },
  ]);
  assert.deepEqual(health.map((call) => call.url), ['http://127.0.0.1:8033/health', 'http://127.0.0.1:9000/health']);
});

test('endpoint save revalidates and persists the matching engine settings once', async () => {
  const writes = [];
  const service = new SetupEndpointService({
    fetchImpl: async () => response({ data: [{ id: 'local-model' }] }),
    configService: {
      saveSetupEndpoint(patch) {
        writes.push(patch);
        return { saved: true };
      },
    },
  });

  const result = await service.save({
    engineType: 'openai-compatible',
    apiUrl: 'http://192.168.1.8:9033/v1',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(writes, [{
    engineType: 'openai-compatible',
    port: 9033,
    apiUrl: 'http://192.168.1.8:9033/v1',
  }]);
});

test('endpoint save exposes a bounded retryable persistence failure', async () => {
  const service = new SetupEndpointService({
    fetchImpl: async () => response({ models: [{ name: 'qwen3:8b' }] }),
    configService: { saveSetupEndpoint: () => ({ saved: false }) },
  });
  const result = await service.save({ engineType: 'ollama' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'persistence_failed');
  assert.equal(result.error_code, 'CMP-SETUP-0001');
  assert.equal(result.retryable, true);
});

test('readiness normalization preserves explicit canonical false and zero aliases', () => {
  const normalized = normalizeReadinessProbe({
    local_model_available: true,
    local_model_count: 0,
    model_count: 7,
    runtime_model_loaded: false,
    model_loaded: true,
    catalog_available: false,
  });

  assert.equal(normalized.local_model_count, 0);
  assert.equal(normalized.runtime_model_loaded, false);
  assert.equal(normalized.catalog_available, false);
});

test('endpoint validation carries the key of whichever managed server owns the origin (row 200)', async () => {
  const seen = [];
  const service = new SetupEndpointService({
    fetchImpl: async (url, init) => { seen.push({ url, auth: init.headers.Authorization || '' }); return response({ data: [{ id: 'm' }] }); },
    getLlamaServerManager: () => ({ getApiKey: () => 'llama', getBaseUrl: () => 'http://127.0.0.1:8033/v1' }),
    getManagedServerManagers: () => [
      null,
      { getApiKey: () => 'strata', getBaseUrl: () => 'http://127.0.0.1:8035/v1' },
      { getApiKey: () => { throw new Error('broken'); }, getBaseUrl: () => 'http://127.0.0.1:8034/v1' },
    ],
  });
  for (const apiUrl of ['http://127.0.0.1:8035/v1', 'http://127.0.0.1:8033/v1', 'http://127.0.0.1:8034/v1', 'http://127.0.0.1:9000/v1']) {
    assert.equal((await service.validate({ engineType: 'openai-compatible', apiUrl })).ok, true, apiUrl);
  }
  assert.deepEqual(seen.map((entry) => entry.auth), ['Bearer strata', 'Bearer llama', '', '']);
});
