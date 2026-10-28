const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDefaultChatModel, resolveModel } = require('../services/backend/backend-chat-model-resolution');
const { prepareLocalEngineChatRequest } = require('../services/backend/local-engine-requests');

// 2026-10-27 live incident: the primary chat sat on "Default" ('') while a
// spawned child lazy-loaded Ornith; the primary's next (wake) turn then ran on
// Ornith because '' resolved to whatever model was loaded.
function fakeService({ preferredLocalModel = 'qwen3.8-27b-nvfp4', currentModel = 'ornith15:9b-q6-256k', hints = {}, hostMode = 'desktop' } = {}) {
  return {
    hostMode,
    currentModel,
    currentEngineType: 'ollama',
    _modelEngineHints: new Map(Object.entries(hints)),
    offlineIntelligenceService: {
      getMode: () => 'auto',
      getPreferredLocalModel: () => preferredLocalModel,
    },
    configService: { getLocalEngines: () => ({}) },
    options: {},
    sessionStore: { getSessionSummary: () => null },
  };
}

test('Default resolves to the Settings default the backend can route, not the loaded model', () => {
  const service = fakeService({ hints: { 'qwen3.8-27b-nvfp4': 'openai-compatible', 'ornith15:9b-q6-256k': 'ollama' } });
  assert.equal(resolveDefaultChatModel(service), 'qwen3.8-27b-nvfp4');
});

test('Default falls back to the loaded model when the Settings default is unknown or unset', () => {
  assert.equal(resolveDefaultChatModel(fakeService({ hints: { 'ornith15:9b-q6-256k': 'ollama' } })), '');
  assert.equal(resolveDefaultChatModel(fakeService({ preferredLocalModel: '' })), '');
  const loaded = fakeService({ preferredLocalModel: 'ornith15:9b-q6-256k' });
  assert.equal(resolveDefaultChatModel(loaded), 'ornith15:9b-q6-256k', 'the loaded model needs no catalog hint');
});

test('a cloud engine keeps its own model; a managed NInfer default routes while Ollama runs', () => {
  const cloud = fakeService({ hints: { 'qwen3.8-27b-nvfp4': 'openai-compatible' } });
  cloud.currentEngineType = 'chatgpt';
  assert.equal(resolveDefaultChatModel(cloud), '');
  const ninfer = fakeService();
  ninfer.ninferRuntime = { artifacts: { artifacts: [{ id: 'qwen3.8-27b-nvfp4', model_id: 'qwen3.8-27b-nvfp4' }] } };
  ninfer.options = { getNinferManager: () => ({}) };
  assert.equal(resolveDefaultChatModel(ninfer), 'qwen3.8-27b-nvfp4', 'the Ollama catalog does not list NInfer models');
});

test('hosted servers keep their pinned model', () => {
  const service = fakeService({ hostMode: 'server', hints: { 'qwen3.8-27b-nvfp4': 'openai-compatible' } });
  assert.equal(resolveDefaultChatModel(service), '');
});

test('a Default turn pins its route to the Settings default but keeps the persisted pick empty', async () => {
  const service = fakeService({ hints: { 'qwen3.8-27b-nvfp4': 'openai-compatible' } });
  const prepared = await prepareLocalEngineChatRequest(service, {
    sessionId: 'sess_a', prompt: 'hi', preferredModel: '', contextPreferences: {},
  });
  assert.equal(prepared.runtimePreferredModel, 'qwen3.8-27b-nvfp4');
  assert.equal(prepared.normalizedPreferences.preferred_model, '');

  const explicit = await prepareLocalEngineChatRequest(service, {
    sessionId: 'sess_a', prompt: 'hi', preferredModel: 'ornith15:9b-q6-256k', contextPreferences: {},
  });
  assert.equal(explicit.runtimePreferredModel, 'ornith15:9b-q6-256k');
});

test('a lazy load refused as busy waits for the running flight once and retries', async () => {
  let releaseFlight;
  let loads = 0;
  const service = {
    currentModel: 'qwen3.8-27b-nvfp4',
    _managedInitializeFlight: { promise: new Promise((resolve) => { releaseFlight = resolve; }) },
    _emitServiceLog() {},
    async loadModel() {
      loads += 1;
      if (loads === 1) throw Object.assign(new Error('busy'), { category: 'model_busy', retryable: true });
    },
  };
  const resolving = resolveModel(service, 'ornith15:9b-q6-256k', 'ollama');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  releaseFlight();
  assert.equal(await resolving, 'ornith15:9b-q6-256k');
  assert.equal(loads, 2);
});

// 2026-10-27 live incident: a spawned child on the alias `ornith15:9b` (installed: ornith15:9b-q6-256k)
// took the current engine, stopped NInfer and failed against an unrelated endpoint. The chat route
// now refuses an id the catalog does not carry before anything is loaded or switched.
const CATALOG = [
  { id: 'qwen3.8-27b-nvfp4', engine_type: 'openai-compatible', managed: 'ninfer' },
  { id: 'ornith15:9b-q6-256k', engine_type: 'ollama' },
];
function guardService({ listing = { primary_available: true, data: CATALOG }, flags = {} } = {}) {
  const calls = { loads: [], lists: 0, logs: [] };
  const service = {
    currentModel: 'qwen3.8-27b-nvfp4', currentEngineType: 'openai-compatible', featureFlags: flags,
    _modelEngineHints: new Map(), options: {}, configService: { getLocalEngines: () => ({}) },
    _emitServiceLog: (level, event, details) => calls.logs.push({ level, event, details }),
    async listModels() {
      calls.lists += 1;
      if (listing instanceof Error) throw listing;
      return listing;
    },
    async loadModel(request) { calls.loads.push(request); },
  };
  return { service, calls };
}

test('the chat route refuses a model the catalog does not carry, before any load', async () => {
  const { service, calls } = guardService();
  await assert.rejects(resolveModel(service, 'ornith15:9b', 'openai-compatible'), (error) => {
    assert.match(error.message, /Model "ornith15:9b" is not installed/u);
    assert.equal(error.category, 'model_unavailable');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.deepEqual(calls.loads, [], 'nothing was loaded or switched');
  assert.equal(calls.lists, 1, 'one fresh catalog read');
  assert.ok(calls.logs.some((entry) => entry.event === 'backend.model_not_installed'));
  assert.equal(service.currentModel, 'qwen3.8-27b-nvfp4');

  const installed = guardService();
  assert.equal(await resolveModel(installed.service, 'ornith15:9b-q6-256k', 'ollama'), 'ornith15:9b-q6-256k');
  assert.equal(installed.calls.loads.length, 1);
});

test('the guard fails open when the catalog cannot vouch for the engine family', async () => {
  const cases = [
    guardService({ listing: new Error('sidecar down') }),
    guardService({ listing: { primary_available: false, data: CATALOG } }),
    guardService({ listing: { primary_available: true, data: [] } }),
    guardService({ listing: { primary_available: true, data: [CATALOG[1]] } }), // nothing for openai-compatible
    guardService({ flags: { model_catalog_guard: false } }),
  ];
  for (const { service, calls } of cases) {
    assert.equal(await resolveModel(service, 'my-server-model', 'openai-compatible'), 'my-server-model');
    assert.equal(calls.loads.length, 1);
  }
  const hinted = guardService();
  hinted.service._modelEngineHints.set('ornith15:9b-q6-256k', 'ollama');
  await resolveModel(hinted.service, 'ornith15:9b-q6-256k', 'ollama');
  assert.equal(hinted.calls.lists, 0, 'a catalog-hinted id needs no read');
  const cloud = guardService();
  await resolveModel(cloud.service, 'gpt-5.5', 'chatgpt');
  assert.equal(cloud.calls.lists, 0, 'a cloud engine keeps its own catalog');
});
