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
