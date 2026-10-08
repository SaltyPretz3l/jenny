'use strict';

// Builds diagnostics.modelFitEstimates: observed, catalog, or estimated fit
// for every installed local (Ollama) model, with provenance for the chosen
// values. Models outside the catalog still get an estimated fit reading.
// Kept out of offline-intelligence-service.js to hold that file under the
// 600-line soft cap. Never throws — every failure degrades to [].
const { estimateModelFit, estimateDivergence, resolveModelFit } = require('./model-fit-estimator');
const { normalizeString } = require('./backend/path-utils');

const DIVERGENCE_LOG_THRESHOLD = 0.25;

function canonicalModelId(value) {
  const modelId = normalizeString(value).toLowerCase();
  if (!modelId) return '';
  const lastSegment = modelId.slice(modelId.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? modelId : `${modelId}:latest`;
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
function findObservationForModel(observationStore, { modelId, digest, gpu, contextLength }) {
  if (!observationStore || typeof observationStore.get !== 'function') return null;
  if (!gpu.name) return null;
  let raw;
  try {
    raw = observationStore.get({
      modelId,
      digest,
      gpuName: gpu.name,
      gpuVramMb: gpu.vramMb,
      contextLength,
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

function resolveLoadContextLength(loadContextLengthFor, modelId) {
  if (typeof loadContextLengthFor !== 'function') return 0;
  try {
    const value = Number(loadContextLengthFor(modelId));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (_) {
    return 0;
  }
}

// An unknown window on either side (0) keeps the pre-existing precedence.
function sameWindow(fit, loadContextLength) {
  if (!fit) return false;
  const fitContext = Number(fit.contextLength) || 0;
  return !loadContextLength || !fitContext || fitContext === loadContextLength;
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
 * @param {Function|null} deps.loadContextLengthFor modelId -> the n_ctx Jenny
 *   loads that model with (optional). When given, the fit is read at that
 *   window, so the "context" label and the VRAM figure match the real load.
 * @returns {Promise<Array>} modelFitEstimates entries
 */
async function buildModelFitEstimates({
  backend,
  hardwareProfile,
  memory,
  modelRecommendations,
  installedModels = null,
  observationStore = null,
  loadContextLengthFor = null,
} = {}) {
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
      const loadContextLength = resolveLoadContextLength(loadContextLengthFor, modelId);

      const estimate = estimateModelFit({
        sizeBytes: entry.size,
        params: entry.parameterSize || entry.parameter_size,
        quant: entry.quantizationLevel || entry.quantization_level,
        contextLength: loadContextLength || recommendation?.contextLength,
        hardware: hardwareProfile,
        memory,
      });
      if (!estimate) continue;

      // A catalog or observed fit read at another window would misstate the
      // load (a 256K override reported as the catalog's 8K), so it only wins
      // when it was measured at the window Jenny loads.
      const catalogFit = sameWindow(recommendation, loadContextLength) ? recommendation : null;
      if (catalogFit) {
        emitDivergenceLog(backend, { modelId, estimate, recommendation });
      }

      // Wave 4 "record on first load, then self-catalog": an observed
      // runtime measurement for this exact (model, GPU) wins over the pure
      // estimate — see model-fit-estimator.js::resolveModelFit. A GPU/vram
      // mismatch (different machine, different card) means
      // findObservationForModel already returned null, so this falls back to
      // the estimate exactly as if no observation had ever been recorded.
      const digest = normalizeString(entry.digest);
      const observed = findObservationForModel(observationStore, {
        modelId, digest, gpu, contextLength: loadContextLength,
      });
      const observation = sameWindow(observed, loadContextLength) ? observed : null;
      // Pass the matched catalog recommendation through too: resolveModelFit's
      // precedence is observation > recommendation > estimate, so a
      // catalog-matched model with no observation yet resolves to
      // fitSource:'catalog' instead of falling through to 'estimated'.
      const resolved = resolveModelFit({ observation, recommendation: catalogFit, estimate });

      results.push({
        ...estimate,
        ...resolved,
        // An observation's contextLength can be 0 (never recorded pre-Wave-4,
        // or genuinely unknown at record time) — never let that clobber the
        // estimate's real contextLength.
        contextLength: loadContextLength || resolved.contextLength || estimate.contextLength,
        sizeBytes: Number(entry.size) || 0,
        modelId,
        catalogMatched,
        source: resolved.fitSource,
        confidence: resolved.fitConfidence,
      });
    }
    return results;
  } catch (_) {
    return [];
  }
}

module.exports = {
  buildModelFitEstimates,
  canonicalModelId,
};
