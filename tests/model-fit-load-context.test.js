'use strict';

// Settings > Models must show the context window Jenny actually loads a model
// with (the per-model Settings override, else the managed 32K shell clamp),
// not the estimator's 8K fallback: a 256K override was listed as "8K context"
// while Ollama loaded n_ctx=262144 (gate sitting 2026-10-07).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildModelFitEstimates } = require('../services/model-fit-diagnostics');
const { ModelFitObservationStore } = require('../services/model-fit-observation-store');
const { OfflineIntelligenceService } = require('../services/offline-intelligence-service');
const merge = require('../renderer/shell/model-library/model-library-merge.js');

const HARDWARE = { gpu: { type: 'cuda', name: 'RTX 4080', vram_mb: 16000 } };
const MEMORY = { totalMb: 32000, availableMb: 24000 };
const ORNITH = {
  id: 'ornith15:9b-q6-256k',
  engine_type: 'ollama',
  digest: 'sha256:ornith',
  size: 7_400_000_000,
  parameterSize: '9B',
  quantizationLevel: 'Q6_K',
};

function catalogEntry(contextLength) {
  return {
    pullTag: ORNITH.id, contextLength, vramRequiredMb: 9000, ramRequiredMb: 10800,
    fits: true, fitsInVram: true, fitsInAccelerator: false, fitsOnCpu: true,
  };
}

test('a non-catalog model is estimated at the window Jenny loads it with', async () => {
  const [defaultFit] = await buildModelFitEstimates({
    hardwareProfile: HARDWARE, memory: MEMORY, modelRecommendations: [], installedModels: [ORNITH],
  });
  const [loadedFit] = await buildModelFitEstimates({
    hardwareProfile: HARDWARE,
    memory: MEMORY,
    modelRecommendations: [],
    installedModels: [ORNITH],
    loadContextLengthFor: (modelId) => (modelId === ORNITH.id ? 262144 : null),
  });
  assert.equal(defaultFit.contextLength, 8192);
  assert.equal(loadedFit.contextLength, 262144);
  assert.equal(loadedFit.fitSource, 'estimated');
  assert.ok(loadedFit.vramRequiredMb > defaultFit.vramRequiredMb);
});

test('a catalog fit measured at another window yields to an estimate at the load window', async () => {
  const [fit] = await buildModelFitEstimates({
    hardwareProfile: HARDWARE,
    memory: MEMORY,
    modelRecommendations: [catalogEntry(8192)],
    installedModels: [ORNITH],
    loadContextLengthFor: () => 32768,
  });
  assert.equal(fit.fitSource, 'estimated');
  assert.equal(fit.contextLength, 32768);
});

test('a catalog fit at the load window still wins', async () => {
  const [fit] = await buildModelFitEstimates({
    hardwareProfile: HARDWARE,
    memory: MEMORY,
    modelRecommendations: [catalogEntry(32768)],
    installedModels: [ORNITH],
    loadContextLengthFor: () => 32768,
  });
  assert.equal(fit.fitSource, 'catalog');
  assert.equal(fit.vramRequiredMb, 9000);
  assert.equal(fit.contextLength, 32768);
});

test('the observation store answers the exact window before the largest one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fit-load-ctx-'));
  const store = new ModelFitObservationStore({ filePath: path.join(dir, 'obs.json') });
  const identity = { modelId: ORNITH.id, digest: ORNITH.digest, gpuName: 'RTX 4080', gpuVramMb: 16000 };
  const base = { ...identity, engine: 'ollama', offloadedMb: 0, residentModelCount: 1 };
  store.record({ ...base, contextLength: 32768, sizeMb: 8000, vramMb: 8000 });
  store.record({ ...base, contextLength: 262144, sizeMb: 12000, vramMb: 12000 });
  assert.equal(store.get(identity).contextLength, 262144);
  assert.equal(store.get({ ...identity, contextLength: 32768 }).vramMb, 8000);
});

test('getDiagnostics reads the per-model override, else the 32K shell clamp', async () => {
  const other = { ...ORNITH, id: 'other:7b', digest: 'sha256:other', parameterSize: '7B' };
  const backend = {
    currentEngineType: 'ollama',
    currentStatus: { engine: '', model: '', engine_fallback: null },
    getBackendStatus: () => ({ mode: 'managed-dev', phase: 'ready' }),
    refreshStatusSnapshot: async () => ({}),
    listModelsForEngine: async () => ({ object: 'list', available: true, data: [ORNITH, other] }),
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: {
      hardwareProfile: async () => ({ ...HARDWARE, memory: { total_mb: 32000, available_mb: 24000 } }),
    },
  };
  const configService = {
    getState: () => ({ offlineIntelligence: { mode: 'disabled', preferredLocalModel: '' } }),
    getCompactionTuning: () => ({ contextLengthByModel: { [ORNITH.id]: 262144 } }),
  };
  const service = new OfflineIntelligenceService({ configService, backendService: backend });
  const diagnostics = await service.getDiagnostics();
  const byId = new Map(diagnostics.modelFitEstimates.map((entry) => [entry.modelId, entry]));
  assert.equal(byId.get(ORNITH.id).contextLength, 262144);
  assert.equal(byId.get('other:7b').contextLength, 32768);
});

test('an installed catalog card shows the re-estimated load window', () => {
  const result = merge.mergeModelLibrary({
    installed: [{ id: ORNITH.id, size: ORNITH.size, parameterSize: '9B', quantizationLevel: 'Q6_K' }],
    ollamaTags: [],
    recommendations: [{ ...catalogEntry(8192), displayName: 'Ornith', recommended: false, reason: '' }],
    fitEstimates: [{
      modelId: ORNITH.id, fitSource: 'estimated', fitConfidence: 'medium',
      vramRequiredMb: 13000, ramRequiredMb: 15600, contextLength: 262144,
      fits: true, fitsInVram: true, fitsInAccelerator: false, fitsOnCpu: true,
    }],
    hardware: { gpu: { type: 'cuda', name: 'Test GPU', vram_mb: 16384 } },
    memory: { totalMb: 32768, availableMb: 24576 },
    catalogMeta: null,
    activeModel: '',
    preferredLocalModel: '',
  });
  const card = result.cards.find((entry) => entry.tag === ORNITH.id);
  assert.equal(card.contextLength, 262144);
  assert.equal(card.vramRequiredMb, 13000);
  assert.equal(card.fitSource, 'estimated');
  assert.equal(card.fitConfidence, 'medium');
});
