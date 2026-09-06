'use strict';

// Pure, dependency-free model-fit estimator for installed local models that
// have no config/model-recommendation-catalog.json entry. Mirrors the
// predicates in sidecar/runtime/hardware_profile.py::_build_model_recommendations
// (fits_in_vram / fits_in_accelerator / fits_on_cpu) so an "estimated" fit
// reads identically to a catalog-sourced "recommendation" downstream.
//
// Calibration (see tests/model-fit-estimator.test.js): against every non-MoE
// catalog model with a vramRequiredMb entry, WEIGHT_OVERHEAD=1.12 +
// RUNTIME_OVERHEAD_MB=600 + a small KV-cache term reproduces the catalog's
// hand-tuned vramRequiredMb within +/-15%.
const WEIGHT_OVERHEAD = 1.12;
const RUNTIME_OVERHEAD_MB = 600;
const KV_MB_PER_BILLION_PER_1K_CTX = 0.5;
const KV_CACHE_CAP_MB = 4096;
const RAM_OVER_VRAM = 1.2;
const UNIFIED_MODEL_MEMORY_FRACTION = 0.5;
const DEFAULT_CONTEXT_LENGTH = 8192;

const BYTES_PER_MB = 1024 * 1024;

// Matches a leading "<number><unit>" token: "9.0B", "12B", "670M", "26B-A4B".
const PARAMS_RE = /^\s*(\d+(?:\.\d+)?)\s*([BM])/i;
// MoE params encode active params as a trailing "-A<digits>[B]" token, e.g.
// "26B-A4B" (26B total, 4B active per token).
const MOE_RE = /-A\d+(?:\.\d+)?B?/i;

function parseParamsBillions(value) {
  const match = PARAMS_RE.exec(String(value == null ? '' : value));
  if (!match) return 0;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num < 0) return 0;
  return match[2].toUpperCase() === 'M' ? num / 1000 : num;
}

function isMoeParams(value) {
  return MOE_RE.test(String(value == null ? '' : value));
}

function _toNonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function _toNonNegNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Accepts either the raw sidecar profile shape ({gpu:{type,vram_mb,
// unified_memory_mb,...}}) or a flattened/camelCase equivalent.
function _extractGpu(hardware) {
  const source = hardware && typeof hardware === 'object' ? hardware : {};
  const gpu = source.gpu && typeof source.gpu === 'object' ? source.gpu : source;
  return {
    type: String(gpu?.type || '').trim().toLowerCase(),
    vramMb: _toNonNegInt(gpu?.vram_mb ?? gpu?.vramMb),
    unifiedMemoryMb: _toNonNegInt(gpu?.unified_memory_mb ?? gpu?.unifiedMemoryMb),
  };
}

function _extractMemory(memory) {
  const source = memory && typeof memory === 'object' ? memory : {};
  const totalMb = _toNonNegInt(source.totalMb ?? source.total_mb);
  const availableMb = _toNonNegInt(source.availableMb ?? source.available_mb);
  return { totalMb, availableMb: availableMb > 0 ? availableMb : totalMb };
}

/**
 * Estimate a recommendation-shaped fit for a model with no catalog entry.
 * Returns null when sizeBytes is not a usable positive number.
 */
function estimateModelFit({
  sizeBytes,
  params,
  quant,
  contextLength,
  hardware,
  memory,
} = {}) {
  const sizeMb = _toNonNegNumber(sizeBytes) / BYTES_PER_MB;
  if (!(sizeMb > 0)) return null;

  const paramsBillions = parseParamsBillions(params);
  const moe = isMoeParams(params);
  const ctx = _toNonNegInt(contextLength) || DEFAULT_CONTEXT_LENGTH;

  const kvMb = Math.min(
    KV_CACHE_CAP_MB,
    KV_MB_PER_BILLION_PER_1K_CTX * paramsBillions * (ctx / 1000)
  );
  const vramRequiredMb = Math.round(sizeMb * WEIGHT_OVERHEAD + RUNTIME_OVERHEAD_MB + kvMb);
  const ramRequiredMb = Math.round(vramRequiredMb * RAM_OVER_VRAM);

  const gpu = _extractGpu(hardware);
  const mem = _extractMemory(memory);
  const unifiedBudgetMb = gpu.type === 'metal'
    ? Math.floor(gpu.unifiedMemoryMb * UNIFIED_MODEL_MEMORY_FRACTION)
    : 0;

  const fitsInVram = gpu.vramMb > 0 && vramRequiredMb > 0 && gpu.vramMb >= vramRequiredMb;
  const fitsInAccelerator = unifiedBudgetMb > 0
    && vramRequiredMb > 0
    && Math.max(vramRequiredMb, ramRequiredMb) <= unifiedBudgetMb;
  const fitsOnCpu = ramRequiredMb > 0 ? mem.availableMb >= ramRequiredMb : true;
  const fits = fitsInVram || fitsInAccelerator || fitsOnCpu;

  return {
    vramRequiredMb,
    ramRequiredMb,
    contextLength: ctx,
    fits,
    fitsInVram,
    fitsInAccelerator,
    fitsOnCpu,
    source: 'estimated',
    confidence: (paramsBillions > 0 && !moe) ? 'medium' : 'low',
    params: String(params == null ? '' : params),
    quant: String(quant == null ? '' : quant),
    paramsBillions,
  };
}

/**
 * Single precedence point for choosing which fit to trust for a model:
 * an observed runtime measurement beats a catalog recommendation beats a
 * pure estimate. `observation` is treated as already recommendation-shaped
 * (future wave); this just tags the winner with its source/confidence.
 */
function resolveModelFit({ recommendation, observation, estimate } = {}) {
  if (observation) {
    return { ...observation, fitSource: 'observed', fitConfidence: 'high' };
  }
  if (recommendation) {
    return { ...recommendation, fitSource: 'catalog', fitConfidence: 'high' };
  }
  if (estimate) {
    return { ...estimate, fitSource: 'estimated', fitConfidence: estimate.confidence || 'low' };
  }
  return null;
}

function estimateDivergence(estimate, recommendation) {
  const estVram = _toNonNegNumber(estimate?.vramRequiredMb);
  const catVram = _toNonNegNumber(recommendation?.vramRequiredMb);
  if (!(estVram > 0) || !(catVram > 0)) return 0;
  return Math.abs(estVram - catVram) / catVram;
}

module.exports = {
  WEIGHT_OVERHEAD,
  RUNTIME_OVERHEAD_MB,
  KV_MB_PER_BILLION_PER_1K_CTX,
  KV_CACHE_CAP_MB,
  RAM_OVER_VRAM,
  UNIFIED_MODEL_MEMORY_FRACTION,
  DEFAULT_CONTEXT_LENGTH,
  parseParamsBillions,
  isMoeParams,
  estimateModelFit,
  resolveModelFit,
  estimateDivergence,
};
