const test = require('node:test');
const assert = require('node:assert/strict');

const {
  autoLoadDefaultModel,
  getHardwareProfile,
  getHardwareVramUsage,
  listModels,
  listModelsForEngine,
  loadModel,
  normalizeHardwareVramUsagePayload,
  unloadModel,
  unloadManagedModelForShutdown,
} = require('../services/backend/backend-runtime');
const {
  inferEngineTypeFromModel,
  resolveRequestedEngineType,
} = require('../services/backend/backend-service-utils');

function makeDefaultModelFallbackService(predicate) {
  const logs = [];
  return {
    defaultModel: 'gpt-5.3-codex',
    _lastEngineFallback: {
      requested_engine: 'chatgpt',
      reason: 'ResponsesDescriptorError',
    },
    ...(predicate === undefined ? {} : { _providerRuntimeApplyPending: predicate }),
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    logs,
  };
}

test('autoLoadDefaultModel defers a fallback while provider runtime apply is pending', () => {
  const service = makeDefaultModelFallbackService(() => true);

  autoLoadDefaultModel(service);

  assert.deepEqual(service.logs, [{
    level: 'INFO',
    event: 'backend.default_model_load_deferred',
    details: {
      model: 'gpt-5.3-codex',
      requested_engine: 'chatgpt',
      message: 'ResponsesDescriptorError',
    },
  }]);
});

for (const [name, predicate] of [
  ['absent', undefined],
  ['throwing', () => { throw new Error('predicate failed'); }],
  ['false', () => false],
]) {
  test(`autoLoadDefaultModel keeps the fallback warning when the provider predicate is ${name}`, () => {
    const service = makeDefaultModelFallbackService(predicate);

    autoLoadDefaultModel(service);

    assert.deepEqual(service.logs, [{
      level: 'WARN',
      event: 'backend.default_model_load_failed',
      details: { model: 'gpt-5.3-codex', message: 'ResponsesDescriptorError' },
    }]);
  });
}

// Legacy/lazy models.load callers carry only a model string. Re-deriving the
// engine from that string alone discards an explicit user pin whenever the
// heuristic falls through to its conservative 'ollama' default.
function makeLoadModelService({ preferredEngineType = '', logs = [] } = {}) {
  const initCalls = [];
  return {
    logs,
    initCalls,
    currentModel: '',
    currentEngineType: 'vllm',
    _lastEngineFallback: null,
    configService: { getState: () => ({ preferredEngineType }) },
    providerIntegrationRegistry: null,
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    async _initializeManagedSidecar(options) { initCalls.push(options); },
    async refreshStatusSnapshot() { return null; },
  };
}

test('resolveRequestedEngineType keeps a local-runtime pin the model string cannot imply', () => {
  // Verified: this HF id misses isLikelyVllmModel's prefix list.
  assert.equal(inferEngineTypeFromModel('NousResearch/Hermes-3-Llama-3.1-8B'), 'ollama');
  assert.equal(
    resolveRequestedEngineType('vllm', 'NousResearch/Hermes-3-Llama-3.1-8B'),
    'vllm',
  );
  assert.equal(
    resolveRequestedEngineType('openai-compatible', 'NousResearch/Hermes-3-Llama-3.1-8B'),
    'openai-compatible',
  );
});

test('resolveRequestedEngineType lets an id-anchored verdict override the pin', () => {
  assert.equal(resolveRequestedEngineType('vllm', 'codex-cli/gpt-5.6'), 'codex-cli');
  assert.equal(resolveRequestedEngineType('vllm', 'gpt-5.2'), 'chatgpt');
  assert.equal(resolveRequestedEngineType('vllm', 'mock-fast'), 'mock');
  assert.equal(resolveRequestedEngineType('openai-compatible', 'replay-scenario'), 'replay');
});

test('resolveRequestedEngineType falls back to the heuristic for absent or non-local pins', () => {
  assert.equal(resolveRequestedEngineType('', 'Qwen/Qwen3.5-9B'), 'vllm');
  assert.equal(resolveRequestedEngineType('', 'llama3.2:latest'), 'ollama');
  assert.equal(resolveRequestedEngineType('ollama', 'Qwen/Qwen3.5-9B'), 'vllm');
  assert.equal(resolveRequestedEngineType('chatgpt', 'llama3.2:latest'), 'ollama');
  assert.equal(resolveRequestedEngineType(null, 'llama3.2:latest'), 'ollama');
});

test('loadModel forwards the pinned engine instead of the model-derived fallback', async () => {
  const service = makeLoadModelService({ preferredEngineType: 'vllm' });

  await loadModel(service, 'NousResearch/Hermes-3-Llama-3.1-8B');

  assert.equal(service.initCalls.length, 1);
  assert.equal(service.initCalls[0].requestedEngineType, 'vllm',
    'the explicit vLLM pin must survive a models.load that names an ollama-looking id');
  const kept = service.logs.find((entry) => entry.event === 'backend.model_load_engine_pin_kept');
  assert.ok(kept, 'expected the backend.model_load_engine_pin_kept observability log');
  assert.equal(kept.details.pinned_engine, 'vllm');
  assert.equal(kept.details.inferred_engine, 'ollama');
});

test('loadModel still uses the heuristic when no engine is pinned', async () => {
  const service = makeLoadModelService({ preferredEngineType: '' });

  await loadModel(service, 'NousResearch/Hermes-3-Llama-3.1-8B');

  assert.equal(service.initCalls[0].requestedEngineType, 'ollama');
  assert.equal(
    service.logs.some((entry) => entry.event === 'backend.model_load_engine_pin_kept'),
    false,
    'no pin was kept, so no pin-kept log',
  );
});

test('loadModel honors explicit catalog engine provenance over a local-runtime pin', async () => {
  const service = makeLoadModelService({ preferredEngineType: 'vllm' });

  await loadModel(service, { model: 'ornith:9b', engine_type: 'ollama' });

  assert.equal(service.initCalls[0].requestedEngineType, 'ollama');
  assert.equal(
    service.logs.find((entry) => entry.event === 'backend.model_load_engine_hint_used')?.details?.source,
    'request'
  );
});

test('loadModel reuses bounded catalog provenance for lazy string-only session loads', async () => {
  const service = makeLoadModelService({ preferredEngineType: 'vllm' });
  service._modelEngineHints = new Map([['ornith:9b', 'ollama']]);

  await loadModel(service, 'ornith:9b');

  assert.equal(service.initCalls[0].requestedEngineType, 'ollama');
  assert.equal(
    service.logs.find((entry) => entry.event === 'backend.model_load_engine_hint_used')?.details?.source,
    'catalog'
  );
});

test('loadModel ignores an invalid explicit engine type and preserves pin resolution', async () => {
  const service = makeLoadModelService({ preferredEngineType: 'vllm' });

  await loadModel(service, { model: 'custom/model', engine_type: 'not-an-engine' });

  assert.equal(service.initCalls[0].requestedEngineType, 'vllm');
  assert.equal(
    service.logs.some((entry) => entry.event === 'backend.model_load_engine_hint_used'),
    false
  );
});

test('listModels falls back to installed Ollama models when the selected engine is unavailable', async () => {
  const calls = [];
  const service = {
    currentEngineType: 'vllm',
    currentModel: 'qwen3:latest',
    defaultModel: 'qwen3:latest',
    async listModelsForEngine(engineType) {
      calls.push(engineType);
      if (engineType === 'vllm') {
        return {
          object: 'list',
          engine_type: 'vllm',
          available: false,
          data: [],
        };
      }
      return {
        object: 'list',
        engine_type: 'ollama',
        available: true,
        data: [{ id: 'llama3.2:latest', available: true }],
      };
    },
    providerIntegrationRegistry: {
      appendModelEntries(entries) {
        return entries;
      },
    },
  };

  const payload = await listModels(service);

  assert.deepEqual(calls, ['vllm', 'ollama']);
  assert.equal(payload.available, true);
  assert.deepEqual(payload.data, [{ id: 'llama3.2:latest', available: true, engine_type: 'ollama' }]);
});

test('listModelsForEngine passes through a numeric byte size field (entry.size or entry.size_bytes)', async () => {
  const service = {
    currentEngineType: 'ollama',
    currentModel: 'llama3.2:latest',
    defaultModel: 'llama3.2:latest',
    sidecarClient: {
      async modelsList() {
        return {
          available: true,
          models: [
            { id: 'llama3.2:latest', available: true, size: 4_700_000_000 },
            { id: 'qwen3:latest', available: true, size_bytes: 5_200_000_000 },
            { id: 'no-size:latest', available: true },
            { id: 'bad-size:latest', available: true, size: -1 },
            { id: 'nan-size:latest', available: true, size: 'not-a-number' },
          ],
        };
      },
    },
    providerIntegrationRegistry: {
      appendModelEntries(entries) {
        return entries;
      },
    },
  };

  const payload = await listModelsForEngine(service, 'ollama');

  assert.equal(payload.data.find((entry) => entry.id === 'llama3.2:latest').size, 4_700_000_000);
  assert.equal(payload.data.find((entry) => entry.id === 'qwen3:latest').size, 5_200_000_000);
  assert.equal('size' in payload.data.find((entry) => entry.id === 'no-size:latest'), false);
  assert.equal('size' in payload.data.find((entry) => entry.id === 'bad-size:latest'), false);
  assert.equal('size' in payload.data.find((entry) => entry.id === 'nan-size:latest'), false);
});

test('listModelsForEngine passes through parameter_size, quantization_level, and digest as camelCase', async () => {
  const service = {
    currentEngineType: 'ollama',
    currentModel: 'llama3.2:latest',
    defaultModel: 'llama3.2:latest',
    sidecarClient: {
      async modelsList() {
        return {
          available: true,
          models: [
            {
              id: 'gemma4-12b:q6',
              available: true,
              parameter_size: '12.0B',
              quantization_level: 'Q6_K',
              digest: `sha256:${'a'.repeat(64)}`,
            },
            { id: 'no-fit-fields:latest', available: true },
            { id: 'blank-fit-fields:latest', available: true, parameter_size: '  ', quantization_level: '' },
          ],
        };
      },
    },
    providerIntegrationRegistry: { appendModelEntries: (entries) => entries },
  };

  const payload = await listModelsForEngine(service, 'ollama');

  const gemma = payload.data.find((entry) => entry.id === 'gemma4-12b:q6');
  assert.equal(gemma.parameterSize, '12.0B');
  assert.equal(gemma.quantizationLevel, 'Q6_K');
  assert.equal(gemma.digest, `sha256:${'a'.repeat(64)}`);
  assert.equal('parameter_size' in gemma, false);

  const bare = payload.data.find((entry) => entry.id === 'no-fit-fields:latest');
  assert.equal('parameterSize' in bare, false);
  assert.equal('digest' in bare, false);

  const blank = payload.data.find((entry) => entry.id === 'blank-fit-fields:latest');
  assert.equal('parameterSize' in blank, false);
  assert.equal('quantizationLevel' in blank, false);
});

test('unloadModel resets managed status shape after unloading the sidecar model', async () => {
  let unloaded = false;
  let normalized = false;
  const service = {
    defaultModel: 'qwen3:latest',
    currentModel: 'qwen3:latest',
    currentEngineType: 'ollama',
    sidecarManager: {
      getStatus() {
        return { phase: 'ready' };
      },
    },
    sidecarClient: {
      async modelsUnload() {
        unloaded = true;
      },
    },
    _buildManagedStatusSnapshot(overrides = {}) {
      return {
        model: 'old-model',
        model_loaded: true,
        reasoning_effort_support: 'supported',
        ...overrides,
      };
    },
    _normalizeManagedReasoningEfforts() {
      normalized = true;
    },
  };

  const result = await unloadModel(service);

  assert.deepEqual(result, { status: 'ok', model: '' });
  assert.equal(unloaded, true);
  assert.equal(service.currentModel, '');
  assert.equal(service.currentStatus.model, '');
  assert.equal(service.currentStatus.model_loaded, false);
  assert.equal(service.currentStatus.native_context_length, null);
  assert.equal(service.currentStatus.local_runtime.context.effective_context_length, null);
  assert.equal(normalized, true);
});

test('unloadManagedModelForShutdown clears its timeout after a fast unload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clearTimeoutMock = t.mock.method(global, 'clearTimeout');
  const service = {
    sidecarManager: {
      mode: 'managed-dev',
      getStatus() {
        return { phase: 'ready' };
      },
    },
    async unloadModel() {},
    _emitServiceLog() {},
  };

  const result = await unloadManagedModelForShutdown(service);

  assert.equal(result, true);
  assert.equal(clearTimeoutMock.mock.callCount(), 1);
});

test('getHardwareProfile returns null without logging when sidecarClient is not attached', async () => {
  const logs = [];
  const result = await getHardwareProfile({
    sidecarManager: {
      getStatus() {
        return { phase: 'ready' };
      },
    },
    sidecarClient: null,
    _emitServiceLog(...args) {
      logs.push(args);
    },
  });

  assert.equal(result, null);
  assert.deepEqual(logs, []);
});

test('getHardwareProfile logs a warning when the sidecar request rejects', async () => {
  const logs = [];
  const result = await getHardwareProfile({
    sidecarManager: {
      getStatus() {
        return { phase: 'ready' };
      },
    },
    sidecarClient: {
      async hardwareProfile() {
        throw new Error('profile failed');
      },
    },
    _emitServiceLog(...args) {
      logs.push(args);
    },
  });

  assert.equal(result, null);
  assert.deepEqual(logs, [[
    'WARN',
    'backend.hardware_profile_failed',
    { message: 'profile failed' },
  ]]);
});

test('normalizeHardwareVramUsagePayload maps sidecar snake_case fields', () => {
  const normalized = normalizeHardwareVramUsagePayload({
    available: true,
    used_mb: 3072,
    total_mb: 12288,
    util_available: true,
    util_percent: 64,
    gpu_type: 'cuda',
    source: 'nvidia-smi',
    sampled_at: '2026-01-01T00:00:00+00:00',
  });

  assert.deepEqual(normalized, {
    available: true,
    usedMb: 3072,
    totalMb: 12288,
    utilAvailable: true,
    utilPercent: 64,
    gpuType: 'cuda',
    source: 'nvidia-smi',
    sampledAt: '2026-01-01T00:00:00+00:00',
  });
});

test('normalizeHardwareVramUsagePayload defaults missing utilization fields', () => {
  const normalized = normalizeHardwareVramUsagePayload({
    available: true,
    used_mb: 3072,
    total_mb: 12288,
  });

  assert.equal(normalized.utilAvailable, false);
  assert.equal(normalized.utilPercent, 0);
});

test('getHardwareVramUsage returns null when sidecar mode is not ready', async () => {
  const result = await getHardwareVramUsage({
    sidecarManager: {
      getStatus() {
        return { phase: 'starting' };
      },
    },
    sidecarClient: {
      async hardwareVramUsage() {
        throw new Error('should not be called');
      },
    },
  });

  assert.equal(result, null);
});

test('getHardwareVramUsage returns null when sidecarClient is null despite ready status', async () => {
  const result = await getHardwareVramUsage({
    sidecarManager: {
      getStatus() {
        return { phase: 'ready' };
      },
    },
    sidecarClient: null,
  });

  assert.equal(result, null);
});

test('getHardwareVramUsage returns normalized payload from sidecar client', async () => {
  const result = await getHardwareVramUsage({
    sidecarManager: {
      getStatus() {
        return { phase: 'ready' };
      },
    },
    sidecarClient: {
      async hardwareVramUsage() {
        return {
          available: true,
          used_mb: 4096,
          total_mb: 8192,
          util_available: true,
          util_percent: 72,
          gpu_type: 'cuda',
          source: 'nvidia-smi',
          sampled_at: '2026-01-01T00:00:00+00:00',
        };
      },
    },
    _emitServiceLog() {},
  });

  assert.deepEqual(result, {
    available: true,
    usedMb: 4096,
    totalMb: 8192,
    utilAvailable: true,
    utilPercent: 72,
    gpuType: 'cuda',
    source: 'nvidia-smi',
    sampledAt: '2026-01-01T00:00:00+00:00',
  });
});

test('getHardwareVramUsage skips sidecar call while streams are active', async () => {
  let called = false;
  const result = await getHardwareVramUsage({
    activeStreams: new Map([['stream-1', {}]]),
    sidecarManager: {
      getStatus() {
        return { phase: 'ready' };
      },
    },
    sidecarClient: {
      async hardwareVramUsage() {
        called = true;
        return {};
      },
    },
    _emitServiceLog() {},
  });

  assert.equal(result, null);
  assert.equal(called, false);
});

test('getHardwareVramUsage logs timeout failures at DEBUG level', async () => {
  const logs = [];
  const result = await getHardwareVramUsage({
    activeStreams: new Map(),
    sidecarManager: {
      getStatus() {
        return { phase: 'ready' };
      },
    },
    sidecarClient: {
      async hardwareVramUsage() {
        const error = new Error('Sidecar hardware.vram_usage timed out after 5000ms');
        error.error_code = 'CMP-SIDECAR-0001';
        throw error;
      },
    },
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  assert.equal(result, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'DEBUG');
  assert.equal(logs[0].event, 'backend.hardware_vram_usage_failed');
});

test('normalizeHardwareVramUsagePayload zeroes utilPercent when utilization is unavailable', () => {
  const normalized = normalizeHardwareVramUsagePayload({
    available: true,
    used_mb: 1024,
    total_mb: 8192,
    util_available: false,
    util_percent: 55,
  });

  assert.equal(normalized.utilAvailable, false);
  assert.equal(normalized.utilPercent, 0, 'direct consumers must never see a phantom percent');
});

test('normalizeHardwareVramUsagePayload tolerates a null payload', () => {
  const normalized = normalizeHardwareVramUsagePayload(null);

  assert.equal(normalized.available, false);
  assert.equal(normalized.utilAvailable, false);
  assert.equal(normalized.utilPercent, 0);
});

test('getHardwareVramUsage treats the sidecar runtime_fallback shape as no answer', async () => {
  const result = await getHardwareVramUsage({
    activeStreams: new Map(),
    sidecarManager: {
      getStatus() {
        return { phase: 'ready' };
      },
    },
    sidecarClient: {
      async hardwareVramUsage() {
        return {
          available: false,
          used_mb: 0,
          total_mb: 0,
          util_available: false,
          util_percent: 0,
          gpu_type: '',
          source: 'runtime_fallback',
        };
      },
    },
    _emitServiceLog() {},
  });

  assert.equal(result, null, 'a laundered internal-exception sample must fall through to the direct probe');
});
