'use strict';

// Split out of tests/offline-intelligence-service.test.js to keep that file
// under the 600-line test-file ratchet cap. Covers Wave 4 model-fit
// self-catalog: getDiagnostics() must prefer a stored observation over the
// pure estimate on a GPU match, and ignore one recorded under a different GPU.
const test = require('node:test');
const assert = require('node:assert/strict');

const { OfflineIntelligenceService } = require('../services/offline-intelligence-service');
const { buildModelFitEstimates } = require('../services/model-fit-diagnostics');

function createConfigService(offlineIntelligence) {
  let current = {
    mode: 'disabled',
    preferredLocalModel: '',
    ...(offlineIntelligence || {}),
  };
  return {
    getState() {
      return { offlineIntelligence: current };
    },
    updateOfflineIntelligence(patch) {
      current = {
        ...current,
        ...(patch && typeof patch === 'object' ? patch : {}),
      };
      return { offlineIntelligence: current };
    },
  };
}

function createBackendService(options = {}) {
  const status = {
    mode: 'managed-dev',
    phase: 'ready',
    ...(options.backendStatus || {}),
  };
  const snapshot = {
    engine: '',
    model: '',
    engine_fallback: null,
    ...(options.statusSnapshot || {}),
  };
  return {
    currentEngineType: options.currentEngineType || 'ollama',
    currentStatus: snapshot,
    getBackendStatus() {
      return status;
    },
    async refreshStatusSnapshot() {
      if (typeof options.refreshStatusSnapshot === 'function') {
        return options.refreshStatusSnapshot();
      }
      return snapshot;
    },
    async listModelsForEngine(engineType) {
      if (typeof options.listModelsForEngine === 'function') {
        return options.listModelsForEngine(engineType);
      }
      assert.equal(engineType, 'ollama');
      return {
        object: 'list',
        engine_type: 'ollama',
        available: true,
        reason: '',
        data: [{ id: 'qwen3.5:9b' }, { id: 'llava:7b' }],
      };
    },
  };
}

function makeFakeObservationStore(observationsByKey) {
  return {
    get({ modelId, digest, gpuName, gpuVramMb }) {
      const key = `${digest || modelId}|${gpuName}|${gpuVramMb}`;
      return observationsByKey[key] || null;
    },
  };
}

test('getDiagnostics prefers an observed footprint over the pure estimate on a GPU match', async () => {
  const fakeProfile = {
    gpu: { type: 'cuda', name: 'RTX 4080', vram_mb: 16000 },
    memory: { total_mb: 32000, available_mb: 24000 },
    model_recommendations: [],
  };
  const backend = createBackendService({
    listModelsForEngine: async () => ({
      object: 'list',
      engine_type: 'ollama',
      available: true,
      reason: '',
      data: [
        {
          id: 'unknown-model:9b',
          digest: 'sha256:observed-digest',
          available: true,
          engine_type: 'ollama',
          size: 9_000_000_000,
          parameterSize: '9B',
          quantizationLevel: 'Q6_K',
        },
      ],
    }),
  });
  backend.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
  backend.sidecarClient = { hardwareProfile: async () => fakeProfile };

  const observationStore = makeFakeObservationStore({
    'sha256:observed-digest|RTX 4080|16000': {
      modelId: 'unknown-model:9b',
      digest: 'sha256:observed-digest',
      sizeMb: 5000,
      vramMb: 5000,
      offloadedMb: 0,
      contextLength: 8192,
      observedAt: 1234,
    },
  });

  const service = new OfflineIntelligenceService({
    configService: createConfigService({ mode: 'disabled' }),
    backendService: backend,
    modelFitObservationStore: observationStore,
  });

  const diagnostics = await service.getDiagnostics();
  assert.equal(diagnostics.modelFitEstimates.length, 1);
  const est = diagnostics.modelFitEstimates[0];
  assert.equal(est.fitSource, 'observed');
  assert.equal(est.fitConfidence, 'high');
  // Observed footprint (5000MB) must win over the much-larger pure estimate
  // that would otherwise be computed from the raw 9GB size.
  assert.equal(est.vramRequiredMb, 5000);
  assert.equal(est.observedVramMb, 5000);
  assert.equal(est.offloadedMb, 0);
});

test('getDiagnostics ignores an observation recorded under a different GPU', async () => {
  const fakeProfile = {
    gpu: { type: 'cuda', name: 'RTX 4080', vram_mb: 16000 },
    memory: { total_mb: 32000, available_mb: 24000 },
    model_recommendations: [],
  };
  const backend = createBackendService({
    listModelsForEngine: async () => ({
      object: 'list',
      engine_type: 'ollama',
      available: true,
      reason: '',
      data: [
        {
          id: 'unknown-model:9b',
          digest: 'sha256:observed-digest',
          available: true,
          engine_type: 'ollama',
          size: 9_000_000_000,
          parameterSize: '9B',
          quantizationLevel: 'Q6_K',
        },
      ],
    }),
  });
  backend.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
  backend.sidecarClient = { hardwareProfile: async () => fakeProfile };

  // Observation exists, but was recorded under a different GPU (e.g. a
  // laptop's dGPU vs. the current RTX 4080) — must not match.
  const observationStore = makeFakeObservationStore({
    'sha256:observed-digest|RTX 3060|12000': {
      modelId: 'unknown-model:9b',
      digest: 'sha256:observed-digest',
      sizeMb: 5000,
      vramMb: 5000,
      offloadedMb: 0,
      contextLength: 8192,
      observedAt: 1234,
    },
  });

  const service = new OfflineIntelligenceService({
    configService: createConfigService({ mode: 'disabled' }),
    backendService: backend,
    modelFitObservationStore: observationStore,
  });

  const diagnostics = await service.getDiagnostics();
  assert.equal(diagnostics.modelFitEstimates.length, 1);
  const est = diagnostics.modelFitEstimates[0];
  assert.equal(est.fitSource, 'estimated');
  assert.equal(est.source, 'estimated');
  assert.equal(est.observedVramMb, undefined);
});

function configOn() {
  return { getState: () => ({ featureOverrides: {} }) };
}

test('P2-2: a catalog-matched model with no observation resolves to fitSource catalog, not estimated', async () => {
  const results = await buildModelFitEstimates({
    configService: configOn(),
    hardwareProfile: { gpu: { type: 'cuda', name: 'RTX 4080', vram_mb: 16000 } },
    memory: { totalMb: 32000, availableMb: 24000 },
    modelRecommendations: [{
      pullTag: 'llama3.1:8b',
      contextLength: 8192,
      fits: true,
      fitsInVram: true,
      vramRequiredMb: 5000,
      ramRequiredMb: 6000,
    }],
    installedModels: [{
      id: 'llama3.1:8b',
      engine_type: 'ollama',
      digest: 'sha256:abc',
      size: 4_900_000_000,
      parameterSize: '8B',
      quantizationLevel: 'Q4_K_M',
    }],
    observationStore: null,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].catalogMatched, true);
  assert.equal(results[0].fitSource, 'catalog');
  assert.equal(results[0].fitConfidence, 'high');
});

test('P2-3: an observation with contextLength 0 falls back to the estimate contextLength', async () => {
  const observationStore = {
    get: () => ({
      modelId: 'llama3.1:8b',
      digest: 'sha256:abc',
      sizeMb: 4000,
      vramMb: 4000,
      offloadedMb: 0,
      contextLength: 0,
      observedAt: Date.now(),
    }),
  };
  const results = await buildModelFitEstimates({
    configService: configOn(),
    hardwareProfile: { gpu: { type: 'cuda', name: 'RTX 4080', vram_mb: 16000 } },
    memory: { totalMb: 32000, availableMb: 24000 },
    modelRecommendations: [],
    installedModels: [{
      id: 'llama3.1:8b',
      engine_type: 'ollama',
      digest: 'sha256:abc',
      size: 4_900_000_000,
      parameterSize: '8B',
      quantizationLevel: 'Q4_K_M',
    }],
    observationStore,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].fitSource, 'observed');
  // The observation's contextLength is 0 (never recorded); the resolved
  // entry must keep the estimate's real (nonzero) contextLength instead of
  // being clobbered to 0.
  assert.ok(results[0].contextLength > 0);
});
