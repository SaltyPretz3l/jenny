const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OfflineIntelligenceService,
  normalizeOfflineIntelligence,
  normalizeModelRecommendation,
} = require('../services/offline-intelligence-service');

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

test('offline intelligence service reports optional local readiness when a local model is installed', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'disabled',
      preferredLocalModel: 'qwen3.5:9b',
    }),
    backendService: createBackendService(),
  });

  const state = await service.getState();
  assert.equal(state.mode, 'disabled');
  assert.equal(state.preferredLocalModel, 'qwen3.5:9b');
  assert.equal(state.selectedLocalModelInstalled, true);
  assert.equal(state.selectedLocalEngineType, 'ollama');
  assert.equal(state.localChatReady, true);
  assert.equal(state.summary, 'Local chat is ready with qwen3.5:9b.');
});

test('offline intelligence service does not reuse stale catalog readiness when managed sidecar stops being ready', async () => {
  const backendStatus = {
    mode: 'managed-dev',
    phase: 'ready',
  };
  const backendService = {
    currentStatus: {
      engine: '',
      model: '',
      engine_fallback: null,
    },
    getBackendStatus() {
      return backendStatus;
    },
    async refreshStatusSnapshot() {
      return this.currentStatus;
    },
    async listModelsForEngine(engineType) {
      assert.equal(engineType, 'ollama');
      return {
        object: 'list',
        engine_type: 'ollama',
        available: true,
        reason: '',
        data: [{ id: 'qwen3.5:9b' }],
      };
    },
  };
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'disabled',
      preferredLocalModel: 'qwen3.5:9b',
    }),
    backendService,
  });

  const readyState = await service.getState();
  assert.equal(readyState.localChatReady, true);

  backendStatus.phase = 'starting';
  const startingState = await service.getState();

  assert.equal(startingState.selectedLocalModelInstalled, false);
  assert.equal(startingState.localChatReady, false);
  assert.equal(startingState.unavailableReason, 'Managed sidecar is not ready yet.');
  assert.equal(startingState.summary, 'Managed sidecar is not ready yet.');
});

test('offline intelligence service keeps force-local enabled but blocked when no model is selected', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'local_only',
      preferredLocalModel: '',
    }),
    backendService: createBackendService(),
  });

  const state = await service.getState();
  assert.equal(state.localChatReady, false);
  assert.equal(
    state.unavailableReason,
    'Select a local inference model in Model Library.'
  );
  assert.equal(
    state.summary,
    'Select a local inference model in Model Library.'
  );
});

test('offline intelligence service reports force-local ready when the selected model is installed', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'local_only',
      preferredLocalModel: 'llava:7b',
    }),
    backendService: createBackendService(),
  });

  const state = await service.getState();
  assert.equal(state.localChatReady, true);
  assert.equal(state.localVisionReady, true);
  assert.equal(
    state.summary,
    'Force local inference is on. Jenny will use llava:7b for model inference.'
  );
});

test('offline intelligence service prefers catalog capability metadata for local vision readiness', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'local_only',
      preferredLocalModel: 'gemma3:4b',
    }),
    backendService: createBackendService({
      async listModelsForEngine(engineType) {
        assert.equal(engineType, 'ollama');
        return {
          object: 'list',
          engine_type: 'ollama',
          available: true,
          reason: '',
          data: [
            { id: 'gemma3:4b', capabilities: { vision: true } },
            { id: 'qwen3.5:9b' },
          ],
        };
      },
    }),
  });

  const state = await service.getState();
  assert.equal(state.localChatReady, true);
  assert.equal(state.localVisionReady, true);
  assert.equal(
    state.summary,
    'Force local inference is on. Jenny will use gemma3:4b for model inference.'
  );
});

test('offline intelligence service treats ollama engine fallback as unavailable local chat', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'local_only',
      preferredLocalModel: 'qwen3.5:9b',
    }),
    backendService: createBackendService({
      statusSnapshot: {
        engine: 'mock',
        model: 'mock-v1',
        engine_fallback: {
          requested_engine: 'ollama',
          reason: 'Ollama runtime is unavailable.',
        },
      },
    }),
  });

  const state = await service.getState();
  assert.equal(state.localChatReady, false);
  assert.deepEqual(state.engineFallback, {
    requestedEngine: 'ollama',
    reason: 'Ollama runtime is unavailable.',
  });
  assert.equal(state.unavailableReason, 'Ollama runtime is unavailable.');
});

test('offline intelligence service includes vllm catalog entries when vllm is active', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'local_only',
      preferredLocalModel: 'llama-3.1-8b',
    }),
    backendService: createBackendService({
      currentEngineType: 'vllm',
      async listModelsForEngine(engineType) {
        if (engineType === 'ollama') {
          return {
            object: 'list',
            engine_type: 'ollama',
            available: false,
            reason: 'Ollama runtime is unavailable.',
            data: [],
          };
        }
        assert.equal(engineType, 'vllm');
        return {
          object: 'list',
          engine_type: 'vllm',
          available: true,
          reason: '',
          data: [{ id: 'llama-3.1-8b' }],
        };
      },
    }),
  });

  const state = await service.getState();

  assert.equal(state.localCatalog.available, true);
  assert.equal(state.selectedLocalModelInstalled, true);
  assert.equal(state.selectedLocalEngineType, 'vllm');
  assert.equal(state.localChatReady, true);
  assert.equal(state.localCatalog.models.some((model) => model.id === 'llama-3.1-8b'), true);
});

test('offline intelligence service falls back to current status when status refresh fails', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'local_only',
      preferredLocalModel: 'qwen3.5:9b',
    }),
    backendService: createBackendService({
      statusSnapshot: {
        engine: 'mock',
        model: 'mock-v1',
        engine_fallback: {
          requested_engine: 'ollama',
          reason: 'Snapshot fallback reason.',
        },
      },
      refreshStatusSnapshot() {
        throw new Error('status probe failed');
      },
    }),
  });

  const state = await service.getState();

  assert.equal(state.localChatReady, false);
  assert.equal(state.unavailableReason, 'Snapshot fallback reason.');
});

test('getDiagnostics returns state plus hardwareProfile field', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'disabled',
      preferredLocalModel: 'qwen3.5:9b',
    }),
    backendService: createBackendService(),
  });

  const diagnostics = await service.getDiagnostics();
  assert.equal(diagnostics.mode, 'disabled');
  assert.equal(diagnostics.preferredLocalModel, 'qwen3.5:9b');
  // hardwareProfile may be null when sidecar hasn't been probed yet
  assert.ok('hardwareProfile' in diagnostics);
});

test('getDiagnostics degrades gracefully when backend is not managed', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({ mode: 'disabled' }),
    backendService: createBackendService(),
  });

  const diagnostics = await service.getDiagnostics();
  assert.equal(diagnostics.hardwareProfile, null);
});

test('getDiagnostics coalesces concurrent hardware profile fetches', async () => {
  let hardwareProfileFetches = 0;
  let releaseProfile;
  const profileGate = new Promise((resolve) => { releaseProfile = resolve; });
  const backend = createBackendService();
  backend.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
  backend.sidecarClient = {
    async hardwareProfile() {
      hardwareProfileFetches += 1;
      await profileGate;
      return { gpu: { type: 'cuda' } };
    },
  };
  const service = new OfflineIntelligenceService({
    configService: createConfigService({ mode: 'disabled' }),
    backendService: backend,
  });

  const first = service.getDiagnostics();
  const second = service.getDiagnostics();
  releaseProfile();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(hardwareProfileFetches, 1);
  assert.deepEqual(firstResult, secondResult);
});

test('getDiagnostics caches within the TTL and force bypasses the cache', async () => {
  let now = 1000;
  let hardwareProfileFetches = 0;
  const backend = createBackendService();
  backend.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
  backend.sidecarClient = {
    async hardwareProfile() {
      hardwareProfileFetches += 1;
      return { gpu: { type: 'cuda' } };
    },
  };
  const service = new OfflineIntelligenceService({
    configService: createConfigService({ mode: 'disabled' }),
    backendService: backend,
    now: () => now,
  });

  await service.getDiagnostics();
  now += 4999;
  await service.getDiagnostics();
  assert.equal(hardwareProfileFetches, 1);

  now += 2;
  await service.getDiagnostics();
  assert.equal(hardwareProfileFetches, 2);

  await service.getDiagnostics({ force: true });
  assert.equal(hardwareProfileFetches, 3);
});

test('getDiagnostics does not cache a failed diagnostics fetch', async () => {
  let stateFetches = 0;
  let hardwareProfileFetches = 0;
  const backend = createBackendService();
  backend.getBackendStatus = () => {
    stateFetches += 1;
    if (stateFetches === 1) throw new Error('status fetch failed');
    return { mode: 'managed-dev', phase: 'ready' };
  };
  backend.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
  backend.sidecarClient = {
    async hardwareProfile() {
      hardwareProfileFetches += 1;
      return { gpu: { type: 'cuda' } };
    },
  };
  const service = new OfflineIntelligenceService({
    configService: createConfigService({ mode: 'disabled' }),
    backendService: backend,
  });

  await assert.rejects(service.getDiagnostics(), /status fetch failed/);
  await service.getDiagnostics();

  assert.equal(stateFetches, 3);
  assert.equal(hardwareProfileFetches, 1);
});

test('normalizeModelRecommendation maps snake_case to camelCase and drops empty ids', () => {
  assert.equal(normalizeModelRecommendation(null), null);
  assert.equal(normalizeModelRecommendation({ params: '7B' }), null); // no id/tag
  const r = normalizeModelRecommendation({
    tier: 'daily',
    model_id: 'gemma4:12b',
    display_name: 'Gemma 4 12B',
    params: '12B',
    quant: 'Q5_K_XL',
    vram_required_mb: 13000,
    ram_required_mb: '16000',
    context_length: 32768,
    fits: true,
    fits_in_vram: true,
    fits_in_accelerator: true,
    fits_on_cpu: true,
    download_size_mb: 9800,
    disk_required_mb: 11800,
    recommended: true,
    reason: 'best fit',
    pull_tag: 'gemma4:12b',
  });
  assert.equal(r.modelId, 'gemma4:12b');
  assert.equal(r.displayName, 'Gemma 4 12B');
  assert.equal(r.vramRequiredMb, 13000);
  assert.equal(r.ramRequiredMb, 16000); // coerced from string
  assert.equal(r.contextLength, 32768);
  assert.equal(r.fitsInVram, true);
  assert.equal(r.fitsInAccelerator, true);
  assert.equal(r.fitsOnCpu, true);
  assert.equal(r.downloadSizeMb, 9800);
  assert.equal(r.diskRequiredMb, 11800);
  assert.equal(r.recommended, true);
  assert.equal(r.pullTag, 'gemma4:12b');
});

test('normalizeModelRecommendation passes through preferred: true and defaults it false', () => {
  const preferred = normalizeModelRecommendation({
    model_id: 'ornith:9b-q8_0',
    pull_tag: 'ornith:9b-q8_0',
    preferred: true,
  });
  assert.equal(preferred.preferred, true);

  const notPreferred = normalizeModelRecommendation({
    model_id: 'gemma4:12b',
    pull_tag: 'gemma4:12b',
  });
  assert.equal(notPreferred.preferred, false); // absent -> defaults false
});

test('getDiagnostics passes the catalog to the profile and surfaces normalized recs + meta', async () => {
  let receivedParams = null;
  const fakeProfile = {
    gpu: { type: 'cuda', name: 'RTX 4080', vram_mb: 16000 },
    memory: { total_mb: 32000, available_mb: 24000 },
    model_recommendations: [
      {
        tier: 'daily', model_id: 'gemma4:12b', display_name: 'Gemma', params: '12B', quant: 'Q5',
        vram_required_mb: 13000, ram_required_mb: 16000, context_length: 32768,
        fits: true, fits_in_vram: true, recommended: true, reason: 'best', pull_tag: 'gemma4:12b',
      },
      { params: '7B' }, // junk: no id -> dropped
    ],
  };
  const backend = createBackendService();
  backend.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
  backend.sidecarClient = {
    hardwareProfile: async (params) => {
      receivedParams = params;
      return fakeProfile;
    },
  };
  const modelCatalogService = {
    getCatalog: () => ({ catalogVersion: 4, updatedAt: '2026-06-13', source: 'remote', models: [] }),
    getMeta: () => ({ version: 4, updatedAt: '2026-06-13', source: 'remote' }),
    refresh: async () => {},
  };
  const service = new OfflineIntelligenceService({
    configService: createConfigService({ mode: 'local_only', preferredLocalModel: 'gemma4:12b' }),
    backendService: backend,
    modelCatalogService,
  });

  const diagnostics = await service.getDiagnostics();
  assert.ok(receivedParams && receivedParams.model_catalog, 'catalog passed to hardware profile');
  assert.equal(receivedParams.model_catalog.catalogVersion, 4);
  assert.equal(diagnostics.modelRecommendations.length, 1); // junk entry dropped
  assert.equal(diagnostics.modelRecommendations[0].pullTag, 'gemma4:12b');
  assert.equal(diagnostics.modelRecommendations[0].fitsInVram, true);
  assert.equal(diagnostics.modelRecommendations[0].recommended, true);
  assert.equal(diagnostics.memory.totalMb, 32000);
  assert.equal(diagnostics.memory.availableMb, 24000);
  assert.equal(diagnostics.catalogMeta.version, 4);
});

test('offline intelligence service returns isolated state snapshots', async () => {
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'local_only',
      preferredLocalModel: 'llava:7b',
    }),
    backendService: createBackendService(),
  });

  const state = await service.getState();
  state.localCatalog.models[0].id = 'mutated-model';
  state.engineFallback = { requestedEngine: 'mock', reason: 'mutated' };

  const fresh = await service.getState();
  assert.equal(fresh.localCatalog.models[0].id, 'qwen3.5:9b');
  assert.equal(fresh.engineFallback, null);
});

test('out-of-order state completion does not replace the newest cached snapshot', async () => {
  const configService = createConfigService({ mode: 'local_only', preferredLocalModel: 'old' });
  const service = new OfflineIntelligenceService({
    configService,
    backendService: createBackendService(),
  });
  let releaseOlder;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  let probes = 0;
  service._probeLocalCatalog = async () => {
    probes += 1;
    if (probes === 1) {
      await olderGate;
      return { available: true, models: [{ id: 'old', engineType: 'ollama' }] };
    }
    return { available: true, models: [{ id: 'new', engineType: 'ollama' }] };
  };

  const older = service.getState();
  configService.updateOfflineIntelligence({ preferredLocalModel: 'new' });
  const newer = await service.getState();
  releaseOlder();
  const olderResult = await older;

  assert.equal(olderResult.preferredLocalModel, 'old');
  assert.equal(newer.preferredLocalModel, 'new');
  assert.equal(service.lastState.preferredLocalModel, 'new');
});

test('offline intelligence service keeps stale catalog rows display-only after a probe failure', async () => {
  let failCatalogProbe = false;
  const service = new OfflineIntelligenceService({
    configService: createConfigService({
      mode: 'local_only',
      preferredLocalModel: 'qwen3.5:9b',
    }),
    backendService: createBackendService({
      async listModelsForEngine(engineType) {
        assert.equal(engineType, 'ollama');
        if (failCatalogProbe) throw new Error('catalog unavailable');
        return {
          object: 'list',
          engine_type: 'ollama',
          available: true,
          reason: '',
          data: [{ id: 'qwen3.5:9b' }],
        };
      },
    }),
  });

  const readyState = await service.getState();
  assert.equal(readyState.localChatReady, true);

  failCatalogProbe = true;
  const failedState = await service.getState();
  assert.equal(failedState.localCatalog.available, false);
  assert.equal(failedState.localCatalog.models[0].id, 'qwen3.5:9b');
  assert.equal(failedState.selectedLocalModelInstalled, false);
  assert.equal(failedState.localChatReady, false);
  assert.match(failedState.unavailableReason, /^catalog unavailable/);
});

test('offline config rejects malformed model values without weakening force-local mode', () => {
  assert.deepEqual(normalizeOfflineIntelligence({ mode: 'local_only', preferredLocalModel: {} }), {
    mode: 'local_only', preferredLocalModel: '',
  });
});

test('getDiagnostics carries modelFitEstimates for a non-catalog installed model', async () => {
  const fakeProfile = {
    gpu: { type: 'cuda', name: 'RTX 4080', vram_mb: 16000 },
    memory: { total_mb: 32000, available_mb: 24000 },
    model_recommendations: [],
  };
  const backend = createBackendService({
    listModelsForEngine: async (engineType) => {
      assert.equal(engineType, 'ollama');
      return {
        object: 'list',
        engine_type: 'ollama',
        available: true,
        reason: '',
        data: [
          {
            id: 'unknown-model:9b',
            available: true,
            engine_type: 'ollama',
            size: 9_000_000_000,
            parameterSize: '9B',
            quantizationLevel: 'Q6_K',
          },
        ],
      };
    },
  });
  backend.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
  backend.sidecarClient = { hardwareProfile: async () => fakeProfile };

  const service = new OfflineIntelligenceService({
    configService: createConfigService({ mode: 'disabled' }),
    backendService: backend,
  });

  const diagnostics = await service.getDiagnostics();
  assert.equal(diagnostics.modelFitEstimates.length, 1);
  const est = diagnostics.modelFitEstimates[0];
  assert.equal(est.modelId, 'unknown-model:9b');
  assert.equal(est.catalogMatched, false);
  assert.equal(est.source, 'estimated');
  assert.ok(est.vramRequiredMb > 0);
});

test('getDiagnostics returns an empty modelFitEstimates when the flag is off', async () => {
  const previous = process.env.JENNY_ENABLE_MODEL_FIT_ESTIMATES;
  process.env.JENNY_ENABLE_MODEL_FIT_ESTIMATES = '0';
  try {
    const backend = createBackendService({
      listModelsForEngine: async () => ({
        object: 'list',
        engine_type: 'ollama',
        available: true,
        reason: '',
        data: [{ id: 'unknown-model:9b', available: true, size: 9_000_000_000, parameterSize: '9B' }],
      }),
    });
    backend.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
    backend.sidecarClient = { hardwareProfile: async () => ({ gpu: {}, memory: {}, model_recommendations: [] }) };

    const service = new OfflineIntelligenceService({
      configService: createConfigService({ mode: 'disabled' }),
      backendService: backend,
    });

    const diagnostics = await service.getDiagnostics();
    assert.deepEqual(diagnostics.modelFitEstimates, []);
  } finally {
    if (previous === undefined) delete process.env.JENNY_ENABLE_MODEL_FIT_ESTIMATES;
    else process.env.JENNY_ENABLE_MODEL_FIT_ESTIMATES = previous;
  }
});
