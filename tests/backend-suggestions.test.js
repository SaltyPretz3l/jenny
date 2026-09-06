const test = require('node:test');
const assert = require('node:assert/strict');
const {
  generateSuggestions,
  createSuggestionCache,
  clearSuggestionCache,
  getCachedOrGenerateSuggestions,
} = require('../services/backend/backend-suggestions');

function createMockService(overrides = {}) {
  return {
    currentStatus: { model_loaded: true },
    currentModel: 'mock-v1',
    activeStreams: new Map(),
    sidecarClient: {
      request: async () => ({ suggestions: ['Hello there', 'How can I help?', 'What are you working on?', 'Tell me more'] }),
    },
    listApprovedMemories: async () => ({ memories: [] }),
    sidecarManager: {
      getStatus: () => ({ phase: 'ready' }),
    },
    _emitServiceLog: () => {},
    ...overrides,
  };
}

function createMockCompanionState(overrides = {}) {
  return {
    mode: 'planner',
    modeMeta: { key: 'planner', label: 'Planner', description: 'Plans things', homePrompt: 'Help me plan' },
    briefing: { dateKey: '2026-03-21', items: [] },
    todayCards: [],
    ...overrides,
  };
}

// --- generateSuggestions ---

test('generateSuggestions returns empty when sidecarClient is null', async () => {
  const service = createMockService({ sidecarClient: null });
  const result = await generateSuggestions(service, createMockCompanionState());
  assert.deepEqual(result, { suggestions: [] });
});

test('generateSuggestions returns empty when sidecar is not ready', async () => {
  const service = createMockService({
    sidecarManager: {
      getStatus: () => ({ phase: 'starting' }),
    },
  });
  const result = await generateSuggestions(service, createMockCompanionState());
  assert.deepEqual(result, { suggestions: [] });
});

test('generateSuggestions returns empty when chat stream is active', async () => {
  const service = createMockService({
    activeStreams: new Map([['stream-1', {}]]),
  });
  const result = await generateSuggestions(service, createMockCompanionState());
  assert.deepEqual(result, { suggestions: [] });
});

test('generateSuggestions skips inference when chat becomes active during memory lookup', async () => {
  let releaseMemory;
  let suggestionCalls = 0;
  const service = createMockService({
    listApprovedMemories: () => new Promise((resolve) => { releaseMemory = resolve; }),
    sidecarClient: {
      request: async () => {
        suggestionCalls += 1;
        return { suggestions: ['Should not run'] };
      },
    },
  });

  const pending = generateSuggestions(service, createMockCompanionState());
  await new Promise(setImmediate);
  service.activeStreams.set('stream-live', {});
  releaseMemory({ memories: [] });

  assert.deepEqual(await pending, { suggestions: [] });
  assert.equal(suggestionCalls, 0);
});

test('generateSuggestions returns empty when model is not loaded', async () => {
  const service = createMockService({
    currentStatus: { model_loaded: false },
    currentModel: '',
  });
  const result = await generateSuggestions(service, createMockCompanionState());
  assert.deepEqual(result, { suggestions: [] });
});

test('generateSuggestions returns suggestions on success', async () => {
  const service = createMockService();
  const result = await generateSuggestions(service, createMockCompanionState());
  assert.equal(result.suggestions.length, 4);
  assert.equal(result.suggestions[0], 'Hello there');
});

test('generateSuggestions returns empty on sidecar error', async () => {
  const service = createMockService({
    sidecarClient: {
      request: async () => { throw new Error('sidecar down'); },
    },
  });
  const result = await generateSuggestions(service, createMockCompanionState());
  assert.deepEqual(result, { suggestions: [] });
});

test('generateSuggestions logs timeout failures at INFO level', async () => {
  const logs = [];
  const service = createMockService({
    sidecarClient: {
      request: async () => {
        const error = new Error('Sidecar suggestions.generate timed out after 8000ms');
        error.error_code = 'CMP-SIDECAR-0001';
        error.category = 'timeout';
        throw error;
      },
    },
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });
  const result = await generateSuggestions(service, createMockCompanionState());
  assert.deepEqual(result, { suggestions: [] });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'suggestions.generate_failed');
  assert.equal(logs[0].level, 'INFO');
  assert.equal(logs[0].details.timeout, true);
});

test('generateSuggestions filters empty string suggestions', async () => {
  const service = createMockService({
    sidecarClient: {
      request: async () => ({ suggestions: ['Valid prompt', '', '  ', 'Another valid'] }),
    },
  });
  const result = await generateSuggestions(service, createMockCompanionState());
  assert.equal(result.suggestions.length, 2);
});

test('generateSuggestions sends modeMeta.label as personality_name', async () => {
  let capturedParams = null;
  const service = createMockService({
    sidecarClient: {
      request: async (_method, params) => {
        capturedParams = params;
        return { suggestions: ['Test'] };
      },
    },
  });
  await generateSuggestions(service, createMockCompanionState());
  assert.equal(capturedParams.personality_name, 'Planner');
});

// --- createSuggestionCache / clearSuggestionCache ---

test('createSuggestionCache returns expected shape', () => {
  const cache = createSuggestionCache();
  assert.equal(cache.key, '');
  assert.deepEqual(cache.suggestions, []);
  assert.equal(cache.generatedAt, 0);
  assert.equal(cache.failedAt, 0);
  assert.equal(cache._inflight, null);
  assert.equal(cache._inflightKey, '');
});

test('clearSuggestionCache resets all fields', () => {
  const cache = createSuggestionCache();
  cache.key = 'planner:2026-03-21';
  cache.suggestions = ['a', 'b'];
  cache.generatedAt = Date.now();
  cache.failedAt = Date.now();
  cache._inflight = Promise.resolve();
  cache._inflightKey = 'planner:2026-03-21';

  clearSuggestionCache(cache);

  assert.equal(cache.key, '');
  assert.deepEqual(cache.suggestions, []);
  assert.equal(cache.generatedAt, 0);
  assert.equal(cache.failedAt, 0);
  assert.equal(cache._inflight, null);
  assert.equal(cache._inflightKey, '');
});

// --- getCachedOrGenerateSuggestions ---

test('getCachedOrGenerateSuggestions returns cached result within TTL', async () => {
  const cache = createSuggestionCache();
  cache.key = 'planner:2026-03-21';
  cache.suggestions = ['Cached prompt 1', 'Cached prompt 2'];
  cache.generatedAt = Date.now();

  const service = createMockService({
    sidecarClient: {
      request: async () => { throw new Error('should not be called'); },
    },
  });

  const result = await getCachedOrGenerateSuggestions(service, createMockCompanionState(), cache);
  assert.deepEqual(result.suggestions, ['Cached prompt 1', 'Cached prompt 2']);
});

test('getCachedOrGenerateSuggestions skips generation during failure cooldown', async () => {
  const cache = createSuggestionCache();
  cache.failedAt = Date.now();

  const service = createMockService({
    sidecarClient: {
      request: async () => { throw new Error('should not be called'); },
    },
  });

  const result = await getCachedOrGenerateSuggestions(service, createMockCompanionState(), cache);
  assert.deepEqual(result, { suggestions: [] });
});

test('getCachedOrGenerateSuggestions deduplicates in-flight requests', async () => {
  let callCount = 0;
  const service = createMockService({
    sidecarClient: {
      request: async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { suggestions: ['Prompt 1', 'Prompt 2'] };
      },
    },
  });

  const cache = createSuggestionCache();
  const state = createMockCompanionState();

  const [result1, result2] = await Promise.all([
    getCachedOrGenerateSuggestions(service, state, cache),
    getCachedOrGenerateSuggestions(service, state, cache),
  ]);

  assert.equal(callCount, 1, 'should only call sidecar once');
  assert.deepEqual(result1.suggestions, result2.suggestions);
});

test('getCachedOrGenerateSuggestions isolates interleaved in-flight cache keys', async () => {
  const pendingByMode = new Map();
  const calls = [];
  const service = createMockService({
    sidecarClient: {
      request: (_method, payload) => new Promise((resolve) => {
        calls.push(payload.companion_mode);
        pendingByMode.set(payload.companion_mode, resolve);
      }),
    },
  });
  const cache = createSuggestionCache();
  const requestA = getCachedOrGenerateSuggestions(service, createMockCompanionState({ mode: 'a', modeMeta: { label: 'A' } }), cache);
  const requestB = getCachedOrGenerateSuggestions(service, createMockCompanionState({ mode: 'b', modeMeta: { label: 'B' } }), cache);
  await new Promise(setImmediate);

  pendingByMode.get('A')({ suggestions: ['a'] });
  await requestA;
  const duplicateB = getCachedOrGenerateSuggestions(service, createMockCompanionState({ mode: 'b', modeMeta: { label: 'B' } }), cache);
  await new Promise(setImmediate);

  assert.deepEqual(calls, ['A', 'B']);
  assert.notEqual(cache.key, 'a:2026-03-21');
  pendingByMode.get('B')({ suggestions: ['b'] });
  assert.deepEqual(await Promise.all([requestB, duplicateB]), [
    { suggestions: ['b'] },
    { suggestions: ['b'] },
  ]);
  assert.equal(cache.key, 'b:2026-03-21');
});

test('getCachedOrGenerateSuggestions regenerates after TTL expires', async () => {
  const cache = createSuggestionCache();
  cache.key = 'planner:2026-03-21';
  cache.suggestions = ['Old prompt'];
  cache.generatedAt = Date.now() - (31 * 60 * 1_000); // 31 minutes ago

  const service = createMockService();
  const result = await getCachedOrGenerateSuggestions(service, createMockCompanionState(), cache);

  assert.equal(result.suggestions.length, 4);
  assert.equal(result.suggestions[0], 'Hello there');
});
