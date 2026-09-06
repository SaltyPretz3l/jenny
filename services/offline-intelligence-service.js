const {
  DEFAULT_OFFLINE_INTELLIGENCE,
  normalizeOfflineIntelligence,
} = require('./shell-config-service');
const { normalizeString } = require('./backend/path-utils');
const { buildModelFitEstimates } = require('./model-fit-diagnostics');

const DIAGNOSTICS_CACHE_TTL_MS = 5000;
const VISION_MODEL_PREFIXES = [
  'llava',
  'bakllava',
  'moondream',
  'minicpm-v',
  'llama3.2-vision',
  'gemma3',
  'qwen2-vl',
  'qwen2.5-vl',
  'qwen2.5vl',
  'qwen-vl',
  'phi-3-vision',
  'phi3-vision',
];


function normalizeEngineFallback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const requestedEngine = normalizeString(value.requested_engine || value.requestedEngine).toLowerCase();
  const reason = normalizeString(value.reason);
  if (!requestedEngine || !reason) {
    return null;
  }
  return {
    requestedEngine,
    reason,
  };
}

function _toNonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Sanitize a single hardware->model recommendation from the sidecar profile.
 * Maps the sidecar's snake_case payload to the renderer's camelCase shape.
 * Returns null for entries with no usable model id / pull tag.
 */
function normalizeModelRecommendation(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const modelId = normalizeString(entry.modelId || entry.model_id);
  const pullTag = normalizeString(entry.pullTag || entry.pull_tag) || modelId;
  if (!modelId && !pullTag) {
    return null;
  }
  return {
    tier: normalizeString(entry.tier),
    modelId: modelId || pullTag,
    displayName: normalizeString(entry.displayName || entry.display_name) || (modelId || pullTag),
    params: normalizeString(entry.params),
    quant: normalizeString(entry.quant),
    vramRequiredMb: _toNonNegInt(entry.vramRequiredMb ?? entry.vram_required_mb),
    ramRequiredMb: _toNonNegInt(entry.ramRequiredMb ?? entry.ram_required_mb),
    contextLength: _toNonNegInt(entry.contextLength ?? entry.context_length),
    fits: entry.fits === true,
    fitsInVram: (entry.fitsInVram ?? entry.fits_in_vram) === true,
    fitsInAccelerator: (entry.fitsInAccelerator ?? entry.fits_in_accelerator) === true,
    fitsOnCpu: (entry.fitsOnCpu ?? entry.fits_on_cpu) === true,
    downloadSizeMb: _toNonNegInt(entry.downloadSizeMb ?? entry.download_size_mb),
    diskRequiredMb: _toNonNegInt(entry.diskRequiredMb ?? entry.disk_required_mb),
    recommended: entry.recommended === true,
    preferred: entry.preferred === true,
    reason: normalizeString(entry.reason),
    pullTag,
  };
}

function normalizeMemory(memory) {
  const source = memory && typeof memory === 'object' && !Array.isArray(memory) ? memory : {};
  return {
    totalMb: _toNonNegInt(source.totalMb ?? source.total_mb),
    availableMb: _toNonNegInt(source.availableMb ?? source.available_mb),
  };
}

function isLikelyVisionCapableLocalModel(modelId) {
  const normalized = normalizeString(modelId).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes('vision')) {
    return true;
  }
  return VISION_MODEL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizeModelCatalogEntry(entry, fallbackEngineType = '') {
  const engineType = normalizeString(fallbackEngineType).toLowerCase();
  if (typeof entry === 'string') {
    const id = normalizeString(entry);
    return id ? { id, engineType, capabilities: {} } : null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const id = normalizeString(entry.id || entry.name || entry.model);
  if (!id) {
    return null;
  }
  const rawCapabilities =
    entry.capabilities && typeof entry.capabilities === 'object' && !Array.isArray(entry.capabilities)
      ? entry.capabilities
      : {};
  const normalizedCapabilities = {};
  for (const [key, value] of Object.entries(rawCapabilities)) {
    const normalizedKey = normalizeString(key);
    if (!normalizedKey) {
      continue;
    }
    normalizedCapabilities[normalizedKey] = value === true;
  }
  return {
    id,
    engineType: normalizeString(entry.engine_type || entry.engineType).toLowerCase() || engineType,
    capabilities: normalizedCapabilities,
  };
}

function findModelCatalogEntry(models, modelId) {
  const normalizedModelId = normalizeString(modelId);
  if (!normalizedModelId) {
    return null;
  }
  return (Array.isArray(models) ? models : []).find(
    (entry) => normalizeString(entry?.id) === normalizedModelId
  ) || null;
}

function isVisionCapableLocalModel(entry, fallbackModelId) {
  if (entry?.capabilities?.vision === true) {
    return true;
  }
  return isLikelyVisionCapableLocalModel(entry?.id || fallbackModelId);
}

function buildDisabledSummary({
  localChatReady,
  preferredLocalModel,
  unavailableReason,
}) {
  if (localChatReady && preferredLocalModel) {
    return `Local chat is ready with ${preferredLocalModel}.`;
  }
  if (preferredLocalModel) {
    return unavailableReason || `Selected local model ${preferredLocalModel} is unavailable right now.`;
  }
  return 'Choose a local inference model in Model Library.';
}

function buildUnavailableReason({
  backendPhase,
  preferredLocalModel,
  selectedLocalModelInstalled,
  catalogReason,
  ollamaFallback,
}) {
  if (backendPhase !== 'ready') {
    return 'Managed sidecar is not ready yet.';
  }
  if (!preferredLocalModel) {
    return 'Select a local inference model in Model Library.';
  }
  if (!selectedLocalModelInstalled) {
    return catalogReason
      ? `${catalogReason} Select an installed local model to continue.`
      : `Preferred local model ${preferredLocalModel} is not installed locally.`;
  }
  if (ollamaFallback) {
    return ollamaFallback.reason;
  }
  return 'Forced local inference is unavailable right now.';
}

function buildVisionUnavailableReason({
  localChatReady,
  preferredLocalModel,
  localVisionReady,
}) {
  if (!localChatReady) {
    return 'Local inference must be ready before image analysis can run locally.';
  }
  if (!preferredLocalModel) {
    return 'Select a local inference model in Model Library before using local vision.';
  }
  if (!localVisionReady) {
    return `Selected local model ${preferredLocalModel} does not appear to support vision.`;
  }
  return '';
}

function cloneModelCatalogEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  return {
    ...entry,
    capabilities: {
      ...(entry.capabilities && typeof entry.capabilities === 'object' && !Array.isArray(entry.capabilities)
        ? entry.capabilities
        : {}),
    },
  };
}

function cloneOfflineState(state = {}) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const localCatalog = source.localCatalog && typeof source.localCatalog === 'object' && !Array.isArray(source.localCatalog)
    ? source.localCatalog
    : {};
  return {
    ...source,
    localCatalog: {
      ...localCatalog,
      models: (Array.isArray(localCatalog.models) ? localCatalog.models : [])
        .map((entry) => cloneModelCatalogEntry(entry))
        .filter(Boolean),
    },
    managedSidecar: {
      ...(source.managedSidecar && typeof source.managedSidecar === 'object' && !Array.isArray(source.managedSidecar)
        ? source.managedSidecar
        : {}),
    },
    engineFallback:
      source.engineFallback && typeof source.engineFallback === 'object' && !Array.isArray(source.engineFallback)
        ? { ...source.engineFallback }
        : null,
  };
}

class OfflineIntelligenceService {
  constructor({
    configService,
    backendService,
    modelCatalogService = null,
    modelFitObservationStore = null,
    now = () => Date.now(),
  } = {}) {
    this.configService = configService || null;
    this.backendService = backendService || null;
    this.modelCatalogService = modelCatalogService || null;
    // Wave 4 "record on first load, then self-catalog": when present, feeds
    // buildModelFitEstimates() a measured-footprint store so an
    // already-observed model gets a source:'observed' fit instead of a pure
    // estimate. Optional — null when the model_fit_estimates flag is off.
    this.modelFitObservationStore = modelFitObservationStore || null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.lastState = this._buildDefaultState();
    this.stateRequestGeneration = 0;
    this._diagnosticsLastResult = null;
    this._diagnosticsInFlightPromise = null;
  }

  _buildDefaultState() {
    return {
      mode: DEFAULT_OFFLINE_INTELLIGENCE.mode,
      preferredLocalModel: DEFAULT_OFFLINE_INTELLIGENCE.preferredLocalModel,
      localCatalog: {
        available: false,
        reason: '',
        models: [],
      },
      managedSidecar: {
        mode: '',
        phase: 'stopped',
        ready: false,
      },
      currentEngine: '',
      currentModel: '',
      selectedLocalEngineType: '',
      engineFallback: null,
      selectedLocalModelInstalled: false,
      localChatReady: false,
      localVisionReady: false,
      unavailableReason: 'Managed sidecar is not ready yet.',
      visionUnavailableReason: 'Local inference must be ready before image analysis can run locally.',
      summary: 'Choose a local inference model in Model Library.',
    };
  }

  _getSettings() {
    if (!this.configService || typeof this.configService.getState !== 'function') {
      return DEFAULT_OFFLINE_INTELLIGENCE;
    }
    return normalizeOfflineIntelligence(this.configService.getState()?.offlineIntelligence);
  }

  async _probeLocalCatalog() {
    const previousModels = Array.isArray(this.lastState?.localCatalog?.models)
      ? this.lastState.localCatalog.models
      : [];
    const backend = this.backendService;
    if (!backend) {
      return {
        available: false,
        reason: 'Force local inference requires the managed local backend.',
        models: previousModels,
      };
    }
    const backendStatus = backend.getBackendStatus();
    if (String(backendStatus?.phase || '') !== 'ready') {
      return {
        available: false,
        reason: 'Managed sidecar is not ready yet.',
        models: previousModels,
      };
    }
    try {
      const ollamaPayload = await backend.listModelsForEngine('ollama');
      const ollamaModels = Array.isArray(ollamaPayload?.data)
        ? ollamaPayload.data.map((entry) => normalizeModelCatalogEntry(entry, 'ollama')).filter(Boolean)
        : [];

      const shouldProbeVllm = backend.currentEngineType === 'vllm';
      const vllmPayload = shouldProbeVllm
        ? await backend.listModelsForEngine('vllm').catch(() => null)
        : null;
      const vllmModels = Array.isArray(vllmPayload?.data)
        ? vllmPayload.data.map((entry) => normalizeModelCatalogEntry(entry, 'vllm')).filter(Boolean)
        : [];

      const models = [...ollamaModels, ...vllmModels];
      const available = (ollamaPayload?.available !== false) || (vllmPayload?.available === true);
      const reasons = [
        normalizeString(ollamaPayload?.reason),
        normalizeString(vllmPayload?.reason),
      ].filter(Boolean);
      return {
        available,
        reason: reasons.join('; '),
        models,
      };
    } catch (error) {
      return {
        available: false,
        reason: normalizeString(error?.message || error) || 'Could not query the local model catalog.',
        models: previousModels,
      };
    }
  }

  async getState() {
    const requestGeneration = ++this.stateRequestGeneration;
    const settings = this._getSettings();
    const backend = this.backendService;
    const backendStatus = backend && typeof backend.getBackendStatus === 'function'
      ? backend.getBackendStatus()
      : {};
    const managedSidecar = {
      mode: normalizeString(backendStatus?.mode),
      phase: normalizeString(backendStatus?.phase) || 'stopped',
      ready: Boolean(backend) && normalizeString(backendStatus?.phase) === 'ready',
    };

    let currentStatus = backend?.currentStatus || null;
    if (managedSidecar.ready && backend && typeof backend.refreshStatusSnapshot === 'function') {
      currentStatus = await backend.refreshStatusSnapshot().catch(() => currentStatus);
    }

    const localCatalog = await this._probeLocalCatalog();
    const currentEngine = normalizeString(currentStatus?.engine).toLowerCase();
    const currentModel = normalizeString(currentStatus?.model);
    const engineFallback = normalizeEngineFallback(currentStatus?.engine_fallback);
    const preferredLocalModel = settings.preferredLocalModel;
    const selectedModelEntry = findModelCatalogEntry(localCatalog.models, preferredLocalModel);
    const selectedLocalEngineType = normalizeString(selectedModelEntry?.engineType).toLowerCase();
    const selectedLocalModelInstalled = localCatalog.available === true
      && Boolean(selectedModelEntry)
      && (selectedLocalEngineType === 'ollama' || selectedLocalEngineType === 'vllm');
    const ollamaFallback = engineFallback && engineFallback.requestedEngine === 'ollama'
      ? engineFallback
      : null;
    const localChatReady = managedSidecar.ready
      && selectedLocalModelInstalled
      && !ollamaFallback;
    const localVisionReady = localChatReady
      && isVisionCapableLocalModel(selectedModelEntry, preferredLocalModel);
    const unavailableReason = buildUnavailableReason({
      backendPhase: managedSidecar.phase,
      preferredLocalModel,
      selectedLocalModelInstalled,
      catalogReason: localCatalog.reason,
      ollamaFallback,
    });
    const visionUnavailableReason = buildVisionUnavailableReason({
      localChatReady,
      preferredLocalModel,
      localVisionReady,
    });
    const summary = settings.mode === 'local_only'
      ? (localChatReady
        ? `Force local inference is on. Jenny will use ${preferredLocalModel} for model inference.`
        : unavailableReason)
      : buildDisabledSummary({
        localChatReady,
        preferredLocalModel,
        unavailableReason,
      });

    const state = {
      mode: settings.mode,
      preferredLocalModel,
      localCatalog,
      managedSidecar,
      currentEngine,
      currentModel,
      selectedLocalEngineType,
      engineFallback,
      selectedLocalModelInstalled,
      localChatReady,
      localVisionReady,
      unavailableReason,
      visionUnavailableReason,
      summary,
    };
    if (requestGeneration === this.stateRequestGeneration) this.lastState = state;
    return cloneOfflineState(state);
  }

  getDiagnostics(options = {}) {
    if (this._diagnosticsInFlightPromise) {
      return this._diagnosticsInFlightPromise;
    }
    const now = this.now();
    const lastResult = this._diagnosticsLastResult;
    if (options.force !== true && lastResult
        && now >= lastResult.at && now - lastResult.at < DIAGNOSTICS_CACHE_TTL_MS) {
      return Promise.resolve(lastResult.result);
    }

    const inFlightPromise = (async () => {
      try {
        const state = await this.getState();
        const backend = this.backendService;
        const catalogService = this.modelCatalogService;
        const catalog = catalogService && typeof catalogService.getCatalog === 'function'
          ? catalogService.getCatalog()
          : null;
        // Fire-and-forget, throttled refresh so opening the scan keeps the catalog fresh.
        if (catalogService && typeof catalogService.refresh === 'function') {
          Promise.resolve(catalogService.refresh()).catch(() => {});
        }
        let hardwareProfile = null;
        if (backend) {
          try {
            const { getHardwareProfile } = require('./backend/backend-runtime');
            hardwareProfile = await getHardwareProfile(backend, { modelCatalog: catalog });
          } catch (_) {
            // hardware profile unavailable — degrade gracefully
          }
        }
        const rawRecs = Array.isArray(hardwareProfile?.model_recommendations)
          ? hardwareProfile.model_recommendations
          : [];
        const modelRecommendations = rawRecs.map(normalizeModelRecommendation).filter(Boolean);
        const memory = normalizeMemory(hardwareProfile?.memory);
        const catalogMeta = catalogService && typeof catalogService.getMeta === 'function'
          ? catalogService.getMeta()
          : null;
        // localCatalog.models (from getState) is stripped down for the UI and
        // drops size/parameterSize/quantizationLevel needed here, so fetch the
        // raw Ollama list again rather than reuse it.
        const modelFitEstimates = await buildModelFitEstimates({
          backend,
          hardwareProfile,
          memory,
          modelRecommendations,
          configService: this.configService,
          observationStore: this.modelFitObservationStore,
        }).catch(() => []);
        const result = {
          ...state,
          hardwareProfile,
          modelRecommendations,
          memory,
          catalogMeta,
          modelFitEstimates,
        };
        this._diagnosticsLastResult = { result, at: this.now() };
        return result;
      } finally {
        if (this._diagnosticsInFlightPromise === inFlightPromise) {
          this._diagnosticsInFlightPromise = null;
        }
      }
    })();
    this._diagnosticsInFlightPromise = inFlightPromise;
    return inFlightPromise;
  }

  async updateSettings(patch = {}) {
    if (!this.configService || typeof this.configService.updateOfflineIntelligence !== 'function') {
      return this.getState();
    }
    this.configService.updateOfflineIntelligence(patch);
    return this.getState();
  }
}

module.exports = {
  DEFAULT_OFFLINE_INTELLIGENCE,
  OfflineIntelligenceService,
  cloneOfflineState,
  isLikelyVisionCapableLocalModel,
  normalizeModelRecommendation,
  normalizeMemory,
  normalizeOfflineIntelligence,
};
