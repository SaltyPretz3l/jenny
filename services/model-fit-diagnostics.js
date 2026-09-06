'use strict';

// Builds diagnostics.modelFitEstimates: a pure-estimator fit for every
// installed local (Ollama) model, catalog-matched or not, so a model with no
// config/model-recommendation-catalog.json entry still gets a fit reading.
// Kept out of offline-intelligence-service.js to hold that file under the
// 600-line soft cap. Never throws — every failure degrades to [].
const { buildFeatureFlags } = require('./feature-flags');
const { estimateModelFit, estimateDivergence, resolveModelFit } = require('./model-fit-estimator');
const { normalizeString } = require('./backend/path-utils');

const DIVERGENCE_LOG_THRESHOLD = 0.25;

function canonicalModelId(value) {
  const modelId = normalizeString(value).toLowerCase();
  if (!modelId) return '';
  const lastSegment = modelId.slice(modelId.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? modelId : `${modelId}:latest`;
}

function isModelFitEstimatesEnabled(configService) {
  try {
    const overrides = configService && typeof configService.getState === 'function'
      ? configService.getState()?.featureOverrides || {}
      : {};
    return buildFeatureFlags(process.env, overrides).model_fit_estimates === true;
  } catch (_) {
    return false;
  }
}

function findRecommendationForModel(modelRecommendations, modelId) {
  const canonical = canonicalModelId(modelId);
  if (!canonical) return null;
  return (Array.isArray(modelRecommendations) ? modelRecommendations : []).find(
    (rec) => canonicalModelId(rec?.pullTag || rec?.modelId) === canonical
  ) || null;
}

// Minimal local GPU-identity extractor (name/type/vramMb) for the
// observation-store lookup key. Deliberately not shared with
// model-fit-estimator.js's internal `_extractGpu` (unexported) — this only
// needs identity fields, not the unified-memory budget math.
function _extractGpuIdentity(hardwareProfile) {
  const source = hardwareProfile && typeof hardwareProfile === 'object' ? hardwareProfile : {};
  const gpu = source.gpu && typeof source.gpu === 'object' ? source.gpu : {};
  const name = String(gpu.name || '').trim();
  const type = String(gpu.type || '').trim().toLowerCase();
  const vramMb = Number(gpu.vram_mb ?? gpu.vramMb);
  return { name, type, vramMb: Number.isFinite(vramMb) && vramMb > 0 ? Math.floor(vramMb) : 0 };
}

/**
 * Look up a stored measured-footprint observation for `modelId`/`digest`
 * under the CURRENT gpu identity, and shape it into the recommendation-like
 * fields resolveModelFit()/the renderer expect (see model-fit-observer.js's
 * companion comment for the same derivation at record time).
 */
function findObservationForModel(observationStore, { modelId, digest, gpu }) {
  if (!observationStore || typeof observationStore.get !== 'function') return null;
  if (!gpu.name) return null;
  let raw;
  try {
    raw = observationStore.get({
      modelId,
      digest,
      gpuName: gpu.name,
      gpuVramMb: gpu.vramMb,
    });
  } catch (_) {
    return null;
  }
  if (!raw) return null;
  const metal = gpu.type === 'metal';
  const offloadedMb = Number(raw.offloadedMb) || 0;
  const sizeMb = Number(raw.sizeMb) || 0;
  return {
    vramRequiredMb: sizeMb,
    ramRequiredMb: Math.round(sizeMb * 1.2),
    contextLength: Number(raw.contextLength) || 0,
    fits: true,
    fitsInVram: offloadedMb === 0 && !metal,
    fitsInAccelerator: metal,
    fitsOnCpu: offloadedMb > 0,
    observedVramMb: Number(raw.vramMb) || 0,
    offloadedMb,
    observedContextLength: Number(raw.contextLength) || 0,
    observedAt: Number(raw.observedAt) || 0,
  };
}

function emitDivergenceLog(backend, { modelId, estimate, recommendation }) {
  const ratio = estimateDivergence(estimate, recommendation);
  if (!(ratio > DIVERGENCE_LOG_THRESHOLD)) return;
  try {
    if (backend && typeof backend._emitServiceLog === 'function') {
      backend._emitServiceLog('INFO', 'model_fit.estimate_catalog_divergence', {
        modelId: String(modelId || '').slice(0, 240),
        estimatedVramMb: estimate.vramRequiredMb,
        catalogVramMb: recommendation.vramRequiredMb,
        ratio: Math.round(ratio * 1000) / 1000,
      });
    }
  } catch (_) {
    // logging must never break diagnostics
  }
}

/**
 * @param {object} deps
 * @param {object} deps.backend backendService (for listModelsForEngine + logging)
 * @param {object|null} deps.hardwareProfile raw sidecar hardware profile payload
 * @param {object} deps.memory normalized {totalMb, availableMb}
 * @param {Array} deps.modelRecommendations camelCase recommendation entries
 * @param {object|null} deps.configService for feature-flag overrides
 * @param {Array|null} deps.installedModels pre-fetched normalized ollama models (optional)
 * @param {object|null} deps.observationStore ModelFitObservationStore (Wave 4 self-catalog, optional)
 * @returns {Promise<Array>} modelFitEstimates entries
 */
async function buildModelFitEstimates({
  backend,
  hardwareProfile,
  memory,
  modelRecommendations,
  configService,
  installedModels = null,
  observationStore = null,
} = {}) {
  if (!isModelFitEstimatesEnabled(configService)) {
    return [];
  }
  try {
    let models = installedModels;
    if (!Array.isArray(models)) {
      if (!backend || typeof backend.listModelsForEngine !== 'function') return [];
      const payload = await backend.listModelsForEngine('ollama').catch(() => null);
      models = Array.isArray(payload?.data) ? payload.data : [];
    }

    const gpu = _extractGpuIdentity(hardwareProfile);
    const results = [];
    for (const entry of models) {
      if (!entry || typeof entry !== 'object') continue;
      const engineType = normalizeString(entry.engine_type || entry.engineType).toLowerCase();
      if (engineType && engineType !== 'ollama') continue;
      const modelId = normalizeString(entry.id || entry.name || entry.model);
      if (!modelId) continue;

      const recommendation = findRecommendationForModel(modelRecommendations, modelId);
      const catalogMatched = Boolean(recommendation);

      const estimate = estimateModelFit({
        sizeBytes: entry.size,
        params: entry.parameterSize || entry.parameter_size,
        quant: entry.quantizationLevel || entry.quantization_level,
        contextLength: recommendation?.contextLength,
        hardware: hardwareProfile,
        memory,
      });
      if (!estimate) continue;

      if (catalogMatched) {
        emitDivergenceLog(backend, { modelId, estimate, recommendation });
      }

      // Wave 4 "record on first load, then self-catalog": an observed
      // runtime measurement for this exact (model, GPU) wins over the pure
      // estimate — see model-fit-estimator.js::resolveModelFit. A GPU/vram
      // mismatch (different machine, different card) means
      // findObservationForModel already returned null, so this falls back to
      // the estimate exactly as if no observation had ever been recorded.
      const digest = normalizeString(entry.digest);
      const observation = findObservationForModel(observationStore, { modelId, digest, gpu });
      // Pass the matched catalog recommendation through too: resolveModelFit's
      // precedence is observation > recommendation > estimate, so a
      // catalog-matched model with no observation yet resolves to
      // fitSource:'catalog' instead of falling through to 'estimated'.
      const resolved = resolveModelFit({ observation, recommendation, estimate });

      results.push({
        ...estimate,
        ...(observation ? resolved : {}),
        // An observation's contextLength can be 0 (never recorded pre-Wave-4,
        // or genuinely unknown at record time) — never let that clobber the
        // estimate's real contextLength.
        contextLength: observation ? (observation.contextLength || estimate.contextLength) : estimate.contextLength,
        sizeBytes: Number(entry.size) || 0,
        modelId,
        catalogMatched,
        fitSource: resolved.fitSource,
        fitConfidence: resolved.fitConfidence,
      });
    }
    return results;
  } catch (_) {
    return [];
  }
}

module.exports = {
  buildModelFitEstimates,
  isModelFitEstimatesEnabled,
  canonicalModelId,
};
