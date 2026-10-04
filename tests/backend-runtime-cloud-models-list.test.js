'use strict';

// Composer's model list and the Cloud models switch (plugin platform
// retirement, stage 2): signed-in ChatGPT models sit next to the local ones
// whatever engine runs, and none is listed while ChatGPT models are off.

const test = require('node:test');
const assert = require('node:assert/strict');

const { listModels } = require('../services/backend/backend-runtime');

function service({ engine = 'ollama', enabled = null, signedIn = true } = {}) {
  const calls = [];
  const lists = {
    ollama: [{ id: 'qwen3:8b', available: true }],
    chatgpt: [{ id: 'gpt-6-astra', available: true }],
  };
  return {
    calls,
    currentEngineType: engine,
    currentModel: '',
    defaultModel: 'qwen3:8b',
    configService: { getState: () => ({ chatgptModelsEnabled: enabled }) },
    chatgptAuthService: { hasCredential: () => signedIn },
    async listModelsForEngine(engineType) {
      calls.push(engineType);
      return { object: 'list', engine_type: engineType, available: true, data: lists[engineType] || [] };
    },
  };
}

const ids = (payload) => payload.data.map((entry) => `${entry.engine_type}:${entry.id}`);

test('a signed-in user on a local engine sees ChatGPT models next to the local ones', async () => {
  const svc = service();
  const payload = await listModels(svc);
  assert.deepEqual(svc.calls, ['ollama', 'chatgpt']);
  assert.deepEqual(ids(payload), ['ollama:qwen3:8b', 'chatgpt:gpt-6-astra']);
  // The engine tag is what switches engines when the model is picked.
  assert.equal(svc._modelEngineHints.get('gpt-6-astra'), 'chatgpt');
});

test('signed out, no ChatGPT models are listed or requested', async () => {
  const svc = service({ signedIn: false });
  const payload = await listModels(svc);
  assert.deepEqual(svc.calls, ['ollama']);
  assert.deepEqual(ids(payload), ['ollama:qwen3:8b']);
});

test('with ChatGPT models off none is listed, even from a ChatGPT engine', async () => {
  const local = service({ enabled: false });
  assert.deepEqual(ids(await listModels(local)), ['ollama:qwen3:8b']);
  assert.deepEqual(local.calls, ['ollama']);

  const chatgpt = service({ engine: 'chatgpt', enabled: false });
  assert.deepEqual(ids(await listModels(chatgpt)), ['ollama:qwen3:8b']);
});

test('a ChatGPT engine with the models on lists them once', async () => {
  const svc = service({ engine: 'chatgpt', enabled: true });
  const payload = await listModels(svc);
  assert.deepEqual(svc.calls, ['chatgpt', 'ollama']);
  assert.deepEqual(ids(payload), ['chatgpt:gpt-6-astra', 'ollama:qwen3:8b']);
});
