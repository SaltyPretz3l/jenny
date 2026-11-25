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

test('cloud engine current, Default chat resolves to the Settings default; a managed NInfer default routes while Ollama runs', () => {
  const cloud = fakeService({ hints: { 'qwen3.8-27b-nvfp4': 'openai-compatible' } });
  cloud.currentEngineType = 'chatgpt';
  cloud.currentModel = 'gpt-5.1';
  assert.equal(resolveDefaultChatModel(cloud), 'qwen3.8-27b-nvfp4', 'row 194: a Default chat reaches the cloud only when a cloud model was picked for it');
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

// 2026-11-13 live incident: a fresh profile with no model chosen started a multi-GB Ollama pull of the
// built-in default at startup, while other models were already installed. A turn with no model of its
// own now loads only an installed default (Settings default first) and never pulls one.
const BUILT_IN = 'hf.co/ornith-ai/Ornith-1.5-9B-GGUF:Q4_K_M';
const OLLAMA_CATALOG = [{ id: 'ornith15:9b-q6-256k', engine_type: 'ollama' }, { id: 'qwen3:8b', engine_type: 'ollama' }];
function defaultTurnService({ settingsDefault = '', listing = { primary_available: true, data: OLLAMA_CATALOG }, flags = {}, lifecycle = 'unloaded' } = {}) {
  const { service, calls } = guardService({ listing, flags });
  Object.assign(service, {
    currentModel: '', currentEngineType: 'ollama', defaultModel: BUILT_IN,
    _modelLifecycle: { state: lifecycle },
    offlineIntelligenceService: { getPreferredLocalModel: () => settingsDefault },
    async refreshStatusSnapshot() { return null; },
  });
  return { service, calls };
}

test('a Default turn never loads (so never pulls) a default the catalog does not carry', async () => {
  for (const lifecycle of ['unloaded', 'unavailable']) {
    const { service, calls } = defaultTurnService({ lifecycle });
    await assert.rejects(resolveModel(service, ''), (error) => {
      assert.match(error.message, /default model "hf\.co\/ornith-ai\/Ornith-1\.5-9B-GGUF:Q4_K_M" is not installed/u);
      assert.match(error.message, /Pick an installed model for this chat/u);
      assert.equal(error.category, 'model_unavailable');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.deepEqual(calls.loads, [], `${lifecycle}: nothing was loaded`);
    assert.ok(calls.logs.some((entry) => entry.event === 'backend.default_model_not_installed'));
  }
});

test('a Default turn loads the installed Settings default first, then an installed built-in default', async () => {
  const settings = defaultTurnService({ settingsDefault: 'qwen3:8b' });
  assert.equal(await resolveModel(settings.service, ''), 'qwen3:8b');
  assert.deepEqual(settings.calls.loads, ['qwen3:8b']);

  const builtIn = defaultTurnService({
    settingsDefault: 'gone:1b',
    listing: { primary_available: true, data: [...OLLAMA_CATALOG, { id: BUILT_IN, engine_type: 'ollama' }] },
  });
  assert.equal(await resolveModel(builtIn.service, ''), BUILT_IN);
  assert.deepEqual(builtIn.calls.loads, [BUILT_IN]);

  const missingSettings = defaultTurnService({ settingsDefault: 'gone:1b' });
  await assert.rejects(resolveModel(missingSettings.service, ''), /default model "gone:1b" is not installed/u);
  assert.deepEqual(missingSettings.calls.loads, [], 'the message names the Settings default');
});

test('a Default turn the catalog cannot vouch for loads nothing; the kill switch restores the old load', async () => {
  const down = defaultTurnService({ listing: new Error('sidecar down') });
  await assert.rejects(resolveModel(down.service, ''), (error) => {
    assert.match(error.message, /could not confirm the default model/u);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.deepEqual(down.calls.loads, []);

  const off = defaultTurnService({ flags: { no_silent_model_pull: false } });
  assert.equal(await resolveModel(off.service, ''), BUILT_IN);
  assert.deepEqual(off.calls.loads, [BUILT_IN]);
});

test('after a startup-load-off boot a Default turn loads the default, never the fallback engine model', async () => {
  // The boot started no server by choice, so the sidecar holds only its mock fallback and lists that as active.
  const listing = { primary_available: true, active_model: 'mock-v1', data: OLLAMA_CATALOG };
  const idle = defaultTurnService({ settingsDefault: 'qwen3:8b', listing });
  idle.service._startupIdleByChoice = true;
  assert.equal(await resolveModel(idle.service, ''), 'qwen3:8b');
  assert.deepEqual(idle.calls.loads, ['qwen3:8b']);

  const plain = defaultTurnService({ settingsDefault: 'qwen3:8b', listing });
  assert.equal(await resolveModel(plain.service, ''), 'mock-v1', 'without the idle flag the listed active model wins');
});

// Row 201 C1 / OD-1: a saved team id in the local default slot is ignored at resolution, never returned.
test('a saved team model default falls through as if unset, in Force Local too', () => {
  const TEAM_ID = 'team/team_alpha1/qwen3:8b';
  const team = (overrides = {}) => {
    const service = fakeService({ preferredLocalModel: TEAM_ID, currentModel: TEAM_ID, hints: { [TEAM_ID]: 'openai-compatible' }, ...overrides });
    service.featureFlags = { team: true };
    return service;
  };
  assert.equal(resolveDefaultChatModel(team()), '', 'the team id is neither the hinted nor the loaded default');
  const forceLocal = team();
  forceLocal.offlineIntelligenceService.getMode = () => 'local_only';
  assert.equal(resolveDefaultChatModel(forceLocal), '');
  const off = team();
  off.featureFlags = { team: false };
  assert.equal(resolveDefaultChatModel(off), TEAM_ID, 'E71: with Team off the prefix is an ordinary model id');
});
