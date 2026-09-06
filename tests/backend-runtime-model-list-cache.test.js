const test = require('node:test');
const assert = require('node:assert/strict');

// Split from backend-runtime.test.js (600-line test ceiling): the
// listModels in-flight/TTL cache contract.
const { listModels } = require('../services/backend/backend-runtime');

test('listModels coalesces concurrent calls and refreshes after the successful-result TTL', async (t) => {
  let now = 1000;
  let requestCount = 0;
  let resolveRequest;
  t.mock.method(Date, 'now', () => now);
  const service = {
    currentEngineType: 'ollama',
    currentModel: 'llama3.2:latest',
    defaultModel: 'llama3.2:latest',
    listModelsForEngine() {
      requestCount += 1;
      if (requestCount === 1) {
        return new Promise((resolve) => { resolveRequest = resolve; });
      }
      return Promise.resolve({
        object: 'list',
        engine_type: 'ollama',
        available: true,
        data: [{ id: 'qwen3:latest' }],
      });
    },
    providerIntegrationRegistry: null,
  };

  const first = listModels(service);
  const second = listModels(service);
  const third = listModels(service);
  assert.equal(requestCount, 1);

  resolveRequest({
    object: 'list',
    engine_type: 'ollama',
    available: true,
    data: [{ id: 'llama3.2:latest' }],
  });
  const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
  assert.strictEqual(secondResult, firstResult);
  assert.strictEqual(thirdResult, firstResult);

  now += 2500;
  const refreshedResult = await listModels(service);
  assert.equal(requestCount, 2);
  assert.notStrictEqual(refreshedResult, firstResult);
  assert.deepEqual(refreshedResult.data, [{ id: 'qwen3:latest', engine_type: 'ollama' }]);
});

test('listModels does not reuse a cached list after the engine type changes', async (t) => {
  let now = 1000;
  const seenEngines = [];
  t.mock.method(Date, 'now', () => now);
  const service = {
    currentEngineType: 'ollama',
    currentModel: 'llama3.2:latest',
    defaultModel: 'llama3.2:latest',
    async listModelsForEngine(engineType) {
      seenEngines.push(engineType);
      return { object: 'list', engine_type: engineType, available: true, data: [{ id: `${engineType}-model` }] };
    },
    providerIntegrationRegistry: null,
  };

  const first = await listModels(service);
  assert.equal(first.data[0].id, 'ollama-model');
  service.currentEngineType = 'mock';
  now += 100;
  const second = await listModels(service);
  assert.notStrictEqual(second, first);
  // A non-ollama engine also fetches the ollama fallback list, so only assert
  // that the switch produced a fresh fetch for the new engine.
  assert.deepEqual(seenEngines.slice(0, 2), ['ollama', 'mock']);
});

test('listModels retries after a rejected request', async () => {
  let requestCount = 0;
  const expectedResult = {
    object: 'list',
    engine_type: 'ollama',
    available: true,
    data: [{ id: 'llama3.2:latest' }],
  };
  const service = {
    currentEngineType: 'ollama',
    currentModel: 'llama3.2:latest',
    defaultModel: 'llama3.2:latest',
    async listModelsForEngine() {
      requestCount += 1;
      if (requestCount === 1) {
        throw new Error('catalog unavailable');
      }
      return expectedResult;
    },
    providerIntegrationRegistry: null,
  };

  await assert.rejects(listModels(service), /catalog unavailable/);
  const result = await listModels(service);

  assert.equal(requestCount, 2);
  assert.deepEqual(result.data, [{ id: 'llama3.2:latest', engine_type: 'ollama' }]);
});
