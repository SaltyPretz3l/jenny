'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ModelTuningService } = require('../services/model-tuning-service');

function createHarness({
  refreshFails = false,
  active = false,
  engineType = '',
  diagnosticsFails = false,
  nativeContextLength = 131072,
  modelInspection = null,
  modelRecommendations = null,
  modelFitEstimates = null,
  hardwareProfile = null,
  memory = null,
} = {}) {
  const state = {
    model: { streamInactivitySecondsByModel: {}, generationProfilesByModel: {} },
    compaction: { ratioByModel: {}, contextLengthByModel: {}, customPrompt: '' },
  };
  let refreshCalls = 0;
  const refreshOptions = [];
  const logs = [];
  const inspectionCalls = [];
  const shellConfigService = {
    getModelTuning: () => structuredClone(state.model),
    getCompactionTuning: () => structuredClone(state.compaction),
    updateModelTuning(patch) {
      const modelId = patch.modelId;
      if (Object.hasOwn(patch, 'streamInactivitySeconds')) {
        if (patch.streamInactivitySeconds == null) delete state.model.streamInactivitySecondsByModel[modelId];
        else state.model.streamInactivitySecondsByModel[modelId] = patch.streamInactivitySeconds;
      }
      if (patch.resetGenerationProfile) delete state.model.generationProfilesByModel[modelId];
      else if (patch.generationProfile) state.model.generationProfilesByModel[modelId] = { ...patch.generationProfile };
      return this.getModelTuning();
    },
    setCompactionTuning(patch) {
      if (Object.hasOwn(patch, 'contextLength')) {
        if (patch.contextLength == null) delete state.compaction.contextLengthByModel[patch.modelId];
        else state.compaction.contextLengthByModel[patch.modelId] = patch.contextLength;
      }
      if (Object.hasOwn(patch, 'ratio')) {
        if (patch.ratio == null) delete state.compaction.ratioByModel[patch.modelId];
        else state.compaction.ratioByModel[patch.modelId] = patch.ratio;
      }
      if (Object.hasOwn(patch, 'customPrompt')) state.compaction.customPrompt = String(patch.customPrompt || '');
      return this.getCompactionTuning();
    },
  };
  const backendService = {
    currentModel: 'gemma3:latest',
    currentEngineType: engineType,
    activeStreams: new Map(active ? [['stream-1', {}]] : []),
    getBackendStatus: () => ({ native_context_length: nativeContextLength }),
    async listModelsForEngine(requestedEngineType, options) {
      inspectionCalls.push({ requestedEngineType, options });
      return modelInspection ? { modelInspection } : {};
    },
    async refreshManagedConfig(_reason, options) {
      refreshCalls += 1;
      refreshOptions.push(options);
      if (refreshFails && refreshCalls === 1) throw new Error('refresh failed');
      return { status: 'ready' };
    },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
  };
  const offlineIntelligenceService = {
    async getDiagnostics() {
      if (diagnosticsFails) throw new Error('diagnostics failed with sensitive provider detail');
      return {
        modelRecommendations: modelRecommendations || [{
          modelId: 'gemma3:latest', contextLength: 65536, fits: true, fitsInVram: true,
        }],
        modelFitEstimates: modelFitEstimates || [],
        hardwareProfile: hardwareProfile || {},
        memory: memory || {},
      };
    },
  };
  return {
    service: new ModelTuningService({ shellConfigService, backendService, offlineIntelligenceService }),
    state,
    shellConfigService,
    logs,
    inspectionCalls,
    refreshOptions,
    get refreshCalls() { return refreshCalls; },
  };
}

test('applies a bounded model profile only after runtime acknowledgement', async () => {
  const harness = createHarness();
  const result = await harness.service.update({
    modelId: 'gemma3:latest', contextLength: 65536, ratio: 0.8,
    generationProfile: { temperature: 0.6, topK: 20, maxOutputTokens: 4096 },
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.preflight.fit, 'vram');
  assert.equal(harness.refreshCalls, 1);
  assert.deepEqual(harness.refreshOptions[0], {
    inactivityTimeoutMs: 30000,
    absoluteTimeoutMs: 30000,
  });
  assert.equal(harness.state.compaction.contextLengthByModel['gemma3:latest'], 65536);
});

test('rejects malformed values and active streams without persistence or cancellation', async () => {
  const malformed = createHarness();
  assert.equal((await malformed.service.update({ modelId: 'gemma3:latest', generationProfile: { topK: 1.5 } })).reason, 'malformed_generation_profile');
  assert.equal((await malformed.service.update({
    modelId: 'gemma3:latest', generationProfile: { retiredSampler: null },
  })).reason, 'malformed_generation_profile');
  assert.equal(malformed.refreshCalls, 0);
  const active = createHarness({ active: true });
  assert.equal((await active.service.update({ modelId: 'gemma3:latest', contextLength: 4096 })).reason, 'active_stream');
  assert.equal(active.refreshCalls, 0);
  assert.equal(active.service.backendService.activeStreams.size, 1);

  const unsupported = createHarness({ engineType: 'codex-cli' });
  assert.equal((await unsupported.service.update({
    modelId: 'gemma3:latest', generationProfile: { temperature: 0.5 },
  })).reason, 'unsupported_engine');
  assert.equal(unsupported.refreshCalls, 0);

  const fixedContext = createHarness({ engineType: 'vllm' });
  assert.equal((await fixedContext.service.update({
    modelId: 'gemma3:latest', contextLength: 4096,
  })).reason, 'unsupported_context_control');
  assert.equal(fixedContext.refreshCalls, 0);

  // The managed llama-server takes the window as -c on relaunch, so a context
  // change on the active openai-compatible model must not be rejected.
  const managedContext = createHarness({ engineType: 'openai-compatible' });
  assert.equal((await managedContext.service.update({
    modelId: 'gemma3:latest', contextLength: 4096,
  })).status, 'applied');
});

test('rejects when a stream starts during deferred tuning preflight', async () => {
  const harness = createHarness();
  let releasePreflight;
  harness.service.offlineIntelligenceService.getDiagnostics = () => new Promise((resolve) => {
    releasePreflight = () => resolve({ modelRecommendations: [{
      modelId: 'gemma3:latest', contextLength: 65536, fits: true, fitsInVram: true,
    }] });
  });

  const update = harness.service.update({ modelId: 'gemma3:latest', contextLength: 4096 });
  harness.service.backendService.activeStreams.set('stream-race', {});
  releasePreflight();
  const result = await update;

  assert.equal(result.reason, 'active_stream');
  assert.equal(harness.refreshCalls, 0);
  assert.equal(harness.state.compaction.contextLengthByModel['gemma3:latest'], undefined);
});

test('rolls persisted tuning back when refresh fails and fences disposed use', async () => {
  const harness = createHarness({ refreshFails: true });
  const result = await harness.service.update({
    modelId: 'gemma3:latest', contextLength: 4096,
    generationProfile: { temperature: 0.4 },
  });
  assert.equal(result.status, 'rolled_back');
  assert.equal(harness.state.compaction.contextLengthByModel['gemma3:latest'], undefined);
  assert.equal(harness.state.model.generationProfilesByModel['gemma3:latest'], undefined);
  harness.service.dispose();
  assert.equal((await harness.service.update({ modelId: 'gemma3:latest' })).reason, 'disposed');
});

test('degrades safely and emits bounded diagnostics when hardware preflight is unavailable', async () => {
  const harness = createHarness({ diagnosticsFails: true, nativeContextLength: 0 });
  const result = await harness.service.update({
    modelId: 'gemma3:latest',
    contextLength: 32768,
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.preflight.status, 'degraded');
  assert.equal(result.preflight.reason, 'hardware_profile_unavailable');
  assert.deepEqual(harness.logs[0], {
    level: 'WARN',
    event: 'model_tuning.preflight_degraded',
    details: {
      event: 'model_tuning.preflight_degraded',
      modelId: 'gemma3:latest',
      status: 'degraded',
      reason: 'diagnostics_unavailable',
      requestedContextLength: 32768,
      contextLimit: null,
    },
  });
  assert.equal(JSON.stringify(harness.logs).includes('sensitive provider detail'), false);

  const unsafe = createHarness({ diagnosticsFails: true, nativeContextLength: 0 });
  assert.equal((await unsafe.service.update({
    modelId: 'gemma3:latest',
    contextLength: 65536,
  })).reason, 'hardware_profile_unavailable');
  assert.equal(unsafe.refreshCalls, 0);
});

test('accepts an uncatalogued Ollama context up to its exact native limit with a fit warning', async () => {
  const harness = createHarness({
    nativeContextLength: 0,
    modelInspection: {
      modelId: 'ornith15:9b-q6-256k',
      available: true,
      nativeContextLength: 262144,
      reason: '',
    },
    modelRecommendations: [],
  });

  const result = await harness.service.update({
    modelId: 'ornith15:9b-q6-256k',
    contextLength: 262144,
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.preflight.fit, 'unverified');
  assert.equal(result.preflight.warning, 'hardware_fit_unverified');
  assert.equal(result.preflight.contextLimit, 262144);
  assert.equal(harness.state.compaction.contextLengthByModel['ornith15:9b-q6-256k'], 262144);
  assert.deepEqual(harness.inspectionCalls, [{
    requestedEngineType: 'ollama',
    options: { inspectModelId: 'ornith15:9b-q6-256k' },
  }]);
  assert.ok(harness.logs.some((entry) => (
    entry.event === 'model_tuning.preflight_unverified_fit'
    && entry.details.reason === 'hardware_fit_unverified'
  )));
});

test('accepts a non-catalog model whose scaled estimate fits, with the estimated fit warning', async () => {
  const harness = createHarness({
    nativeContextLength: 0,
    modelRecommendations: [],
    modelFitEstimates: [{
      modelId: 'ornith15:9b-q6-256k', sizeBytes: 9_000_000_000, params: '9B', quant: 'Q6_K',
    }],
    hardwareProfile: { gpu: { type: 'cuda', vram_mb: 24_000 } },
    memory: { totalMb: 32_000, availableMb: 32_000 },
  });

  const result = await harness.service.update({
    modelId: 'ornith15:9b-q6-256k',
    contextLength: 8192,
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.preflight.fit, 'estimated');
  assert.equal(result.preflight.warning, 'hardware_fit_estimated');
  assert.equal(harness.state.compaction.contextLengthByModel['ornith15:9b-q6-256k'], 8192);
  const logged = harness.logs.find((entry) => entry.event === 'model_tuning.preflight_estimated_fit');
  assert.ok(logged);
  assert.equal(logged.details.reason, 'hardware_fit_estimated');
  assert.ok(logged.details.estimatedVramMb > 0);
  assert.equal(logged.details.confidence, 'medium');
});

test('rejects a non-catalog model whose scaled estimate exceeds VRAM and RAM budgets', async () => {
  const harness = createHarness({
    nativeContextLength: 0,
    modelRecommendations: [],
    modelFitEstimates: [{
      modelId: 'ornith15:9b-q6-256k', sizeBytes: 9_000_000_000, params: '9B', quant: 'Q6_K',
    }],
    hardwareProfile: { gpu: { type: 'cuda', vram_mb: 512 } },
    memory: { totalMb: 512, availableMb: 512 },
  });

  const result = await harness.service.update({
    modelId: 'ornith15:9b-q6-256k',
    contextLength: 8192,
  });

  assert.equal(result.reason, 'insufficient_memory');
  assert.equal(harness.refreshCalls, 0);
  assert.equal(harness.state.compaction.contextLengthByModel['ornith15:9b-q6-256k'], undefined);
  // This case's params ('9B') parse cleanly, so the estimate is
  // 'medium'-confidence — a non-fit at that confidence is trustworthy
  // enough to hard-reject (see the low-confidence-accepts case below).
  assert.equal(harness.logs.some((entry) => (
    entry.event === 'model_tuning.preflight_rejected' && entry.details.reason === 'insufficient_memory'
  )), true);
});

test('accepts a low-confidence non-fitting estimate rather than rejecting (Ollama mmap paging can still succeed)', async () => {
  const harness = createHarness({
    nativeContextLength: 0,
    modelRecommendations: [],
    modelFitEstimates: [{
      // Unparseable params ('') -> paramsBillions === 0 -> confidence 'low',
      // even though the same tiny hardware budget as the medium-confidence
      // rejection case above makes scaled.fits === false.
      modelId: 'ornith15:9b-q6-256k', sizeBytes: 9_000_000_000, params: '', quant: 'Q6_K',
    }],
    hardwareProfile: { gpu: { type: 'cuda', vram_mb: 512 } },
    memory: { totalMb: 512, availableMb: 512 },
  });

  const result = await harness.service.update({
    modelId: 'ornith15:9b-q6-256k',
    contextLength: 8192,
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.preflight.status, 'accepted');
  assert.equal(result.preflight.fit, 'estimated');
  assert.equal(result.preflight.warning, 'hardware_fit_estimated');
  assert.equal(harness.state.compaction.contextLengthByModel['ornith15:9b-q6-256k'], 8192);
  const logged = harness.logs.find((entry) => entry.event === 'model_tuning.preflight_estimated_fit');
  assert.ok(logged);
  assert.equal(logged.details.confidence, 'low');
});

test('ignores the estimate entirely when no hardware profile is detected', async () => {
  const harness = createHarness({
    nativeContextLength: 0,
    modelRecommendations: [],
    modelFitEstimates: [{
      modelId: 'ornith15:9b-q6-256k', sizeBytes: 9_000_000_000, params: '9B', quant: 'Q6_K',
    }],
    hardwareProfile: {},
    memory: {},
  });

  const result = await harness.service.update({
    modelId: 'ornith15:9b-q6-256k',
    contextLength: 65536,
  });

  assert.equal(result.reason, 'hardware_profile_unavailable');
  assert.equal(harness.refreshCalls, 0);
  assert.equal(harness.logs.some((entry) => entry.event === 'model_tuning.preflight_estimated_fit'), false);
});

test('an empty modelFitEstimates (flag off) falls back to the old unverified behaviour', async () => {
  const harness = createHarness({
    nativeContextLength: 0,
    modelInspection: {
      modelId: 'ornith15:9b-q6-256k',
      available: true,
      nativeContextLength: 262144,
      reason: '',
    },
    modelRecommendations: [],
    modelFitEstimates: [],
    hardwareProfile: { gpu: { type: 'cuda', vram_mb: 24_000 } },
    memory: { totalMb: 32_000, availableMb: 32_000 },
  });

  const result = await harness.service.update({
    modelId: 'ornith15:9b-q6-256k',
    contextLength: 262144,
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.preflight.fit, 'unverified');
  assert.equal(result.preflight.warning, 'hardware_fit_unverified');
});

test('a catalog recommendation still wins over a conflicting fit estimate for the same model', async () => {
  const harness = createHarness({
    modelRecommendations: [{
      modelId: 'gemma3:latest', contextLength: 65536, fits: true, fitsInVram: true,
    }],
    modelFitEstimates: [{
      modelId: 'gemma3:latest', sizeBytes: 1, params: '9B', quant: 'Q6_K',
    }],
    hardwareProfile: { gpu: { type: 'cuda', vram_mb: 24_000 } },
    memory: { totalMb: 32_000, availableMb: 32_000 },
  });

  const result = await harness.service.update({
    modelId: 'gemma3:latest', contextLength: 65536,
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.preflight.fit, 'vram');
});

test('native metadata stays a hard cap and catalog-proven memory failure stays authoritative', async () => {
  const inspection = {
    modelId: 'ornith15:9b-q6-256k',
    available: true,
    nativeContextLength: 131072,
    reason: '',
  };
  const aboveNative = createHarness({
    nativeContextLength: 0,
    modelInspection: inspection,
    modelRecommendations: [],
  });
  assert.equal((await aboveNative.service.update({
    modelId: 'ornith15:9b-q6-256k', contextLength: 262144,
  })).reason, 'exceeds_native_context');
  assert.equal(aboveNative.refreshCalls, 0);

  const insufficient = createHarness({
    nativeContextLength: 0,
    modelInspection: { ...inspection, nativeContextLength: 262144 },
    modelRecommendations: [{
      modelId: 'ornith15:9b-q6-256k', contextLength: 262144, fits: false,
    }],
  });
  assert.equal((await insufficient.service.update({
    modelId: 'ornith15:9b-q6-256k', contextLength: 262144,
  })).reason, 'insufficient_memory');
  assert.equal(insufficient.refreshCalls, 0);
});

test('a delayed exact-model inspection is fenced by disposal', async () => {
  const harness = createHarness({ nativeContextLength: 0, modelRecommendations: [] });
  let releaseInspection;
  harness.service.backendService.listModelsForEngine = () => new Promise((resolve) => {
    releaseInspection = () => resolve({ modelInspection: {
      modelId: 'ornith15:9b-q6-256k', available: true, nativeContextLength: 262144, reason: '',
    } });
  });

  const update = harness.service.update({
    modelId: 'ornith15:9b-q6-256k', contextLength: 262144,
  });
  harness.service.dispose();
  releaseInspection();
  const result = await update;

  assert.equal(result.reason, 'disposed');
  assert.equal(harness.refreshCalls, 0);
  assert.equal(harness.state.compaction.contextLengthByModel['ornith15:9b-q6-256k'], undefined);
});

test('custom guidance rejects malformed or oversized values and rolls back refresh failures', async () => {
  const malformed = createHarness();
  assert.equal((await malformed.service.updateCustomPrompt({ injected: true })).reason, 'malformed_custom_prompt');
  assert.equal((await malformed.service.updateCustomPrompt('x'.repeat(20_001))).reason, 'custom_prompt_too_long');
  assert.equal(malformed.refreshCalls, 0);

  const rollback = createHarness({ refreshFails: true });
  rollback.state.compaction.customPrompt = 'Previous guidance.';
  const result = await rollback.service.updateCustomPrompt('New guidance.');
  assert.equal(result.status, 'rolled_back');
  assert.equal(rollback.state.compaction.customPrompt, 'Previous guidance.');
  assert.equal(rollback.refreshCalls, 2);
});

test('persists stream timeout preferences without waiting for runtime acknowledgement', async () => {
  const harness = createHarness({ active: true });
  const result = await harness.service.update({
    modelId: 'gemma3:latest', streamInactivitySeconds: 180,
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.runtimeAcknowledged, false);
  assert.equal(result.reason, 'saved_for_next_runtime');
  assert.equal(result.state.streamInactivitySecondsByModel['gemma3:latest'], 180);
  assert.equal(harness.refreshCalls, 0);
  assert.equal((await harness.service.update({
    modelId: 'gemma3:latest', streamInactivitySeconds: 'bad',
  })).reason, 'invalid_stream_timeout');
});

test('partial compaction patches preserve omitted sibling overrides', async () => {
  const harness = createHarness();
  harness.state.compaction.contextLengthByModel['gemma3:latest'] = 4096;
  harness.state.compaction.ratioByModel['gemma3:latest'] = 0.7;
  assert.equal((await harness.service.update({
    modelId: 'gemma3:latest', ratio: 0.8,
  })).status, 'applied');
  assert.equal(harness.state.compaction.contextLengthByModel['gemma3:latest'], 4096);
  assert.equal((await harness.service.update({
    modelId: 'gemma3:latest', contextLength: 8192,
  })).status, 'applied');
  assert.equal(harness.state.compaction.ratioByModel['gemma3:latest'], 0.8);
});

test('contains config read and write failures behind structured results', async () => {
  const harness = createHarness();
  harness.shellConfigService.updateModelTuning = () => { throw new Error('private config path'); };
  const writeResult = await harness.service.update({
    modelId: 'gemma3:latest', streamInactivitySeconds: 60,
  });
  assert.equal(writeResult.reason, 'config_write_failed');
  assert.doesNotMatch(JSON.stringify(harness.logs), /private config path/);

  const missing = new ModelTuningService({ shellConfigService: null });
  assert.equal((await missing.update({
    modelId: 'gemma3:latest', streamInactivitySeconds: 60,
  })).reason, 'config_service_unavailable');

  const unreadable = createHarness();
  unreadable.shellConfigService.getCompactionTuning = () => { throw new Error('private config path'); };
  const readResult = await unreadable.service.update({
    modelId: 'gemma3:latest', ratio: 0.8,
  });
  assert.equal(readResult.reason, 'config_read_failed');
  assert.equal(unreadable.refreshCalls, 0);
  assert.deepEqual(unreadable.state.compaction.ratioByModel, {});
});
