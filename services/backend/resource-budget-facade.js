'use strict';

const { normalizeText: normalizeString } = require('../shared/normalize');

function normalizeFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isReadyFacet(facet) {
  return Boolean(facet && typeof facet === 'object' && facet.available === true);
}

function asPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function percentileSnapshot(stats = {}) {
  return {
    p50: normalizeFiniteNumber(stats.p50),
    p95: normalizeFiniteNumber(stats.p95),
    p99: normalizeFiniteNumber(stats.p99),
  };
}

function collectToolPercentiles(toolObservability = {}) {
  const tools = isReadyFacet(toolObservability) && toolObservability.tools
    && typeof toolObservability.tools === 'object'
    ? toolObservability.tools
    : {};
  const percentiles = {};
  for (const [toolName, stats] of Object.entries(tools)) {
    const latency = asPlainObject(stats?.latency_ms);
    percentiles[toolName] = {
      count: Number(stats?.count || 0),
      error_count: Number(stats?.error_count || 0),
      ...percentileSnapshot(latency),
    };
  }
  return percentiles;
}

function collectPhasePercentiles(phasePercentiles = {}) {
  const phases = isReadyFacet(phasePercentiles) && phasePercentiles.phases
    && typeof phasePercentiles.phases === 'object'
    ? phasePercentiles.phases
    : {};
  const percentiles = {};
  for (const [phaseName, stats] of Object.entries(phases)) {
    percentiles[phaseName] = {
      count: Number(stats?.count || 0),
      ...percentileSnapshot(stats),
    };
  }
  return percentiles;
}

function appendResourcePressure(items, resources = {}) {
  if (!isReadyFacet(resources)) {
    return;
  }
  const pressure = resources.sidecar?.system_pressure;
  if (!pressure || typeof pressure !== 'object' || Array.isArray(pressure)) {
    return;
  }
  const status = mapPressure(pressure.status);
  if (!status || status === 'normal') {
    return;
  }
  items.push({
    kind: 'resource_pressure',
    status,
    warnings: Array.isArray(pressure.warnings) ? pressure.warnings.slice(0, 8) : [],
  });
}

function appendToolPressure(items, toolObservability = {}) {
  if (!isReadyFacet(toolObservability)) {
    return;
  }
  const tools = toolObservability.tools && typeof toolObservability.tools === 'object'
    ? toolObservability.tools
    : {};
  for (const [toolName, stats] of Object.entries(tools)) {
    const errorCount = Number(stats?.error_count || 0);
    const slowCount = Number(stats?.slow_count || 0);
    if (errorCount <= 0 && slowCount <= 0) {
      continue;
    }
    items.push({
      kind: 'tool_pressure',
      id: toolName,
      error_count: errorCount,
      slow_count: slowCount,
    });
  }
}

function resourceNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapPressure(status) {
  switch (normalizeString(status).toLowerCase()) {
    case 'ok': return 'normal';
    case 'pressured': return 'high';
    case 'critical': return 'critical';
    default: return null;
  }
}

function sumModelBytes(models, read) {
  // An empty resident list is a real zero; unknown sizes stay null.
  if (models.length === 0) return 0;
  const values = models.map(read).filter((value) => value !== null);
  return values.length ? resourceNumber(values.reduce((sum, value) => sum + value, 0)) : null;
}

// Ollama's `size` is the whole resident footprint and `size_vram` the part on the GPU, so the RAM share is
// the difference (never negative); a model without a VRAM figure counts whole as RAM.
function modelRamBytes(model) {
  if (model.size_bytes === null) return null;
  return Math.max(0, model.size_bytes - (model.vram_bytes ?? 0));
}

function buildResources(resources = {}) {
  const models = Array.isArray(resources?.resident_models) ? resources.resident_models.map((model) => ({
    name: normalizeString(model?.name),
    size_bytes: resourceNumber(model?.size_bytes),
    vram_bytes: resourceNumber(model?.vram_bytes),
  })) : null;
  const gpu = resources?.system?.gpuMemory;
  const systemPressure = resources?.sidecar?.system_pressure;
  const percent = resourceNumber(resources?.system?.ramPercent) ?? resourceNumber(systemPressure?.memory?.percent);
  const pressure = mapPressure(systemPressure?.status);
  return {
    app_memory_bytes: resourceNumber(resources?.app_memory_bytes),
    model_memory: models === null ? null : {
      ram_bytes: sumModelBytes(models, modelRamBytes),
      vram_bytes: sumModelBytes(models, (model) => model.vram_bytes),
      vram_total_bytes: gpu?.available === true && resourceNumber(gpu.totalMb) > 0
        ? resourceNumber(gpu.totalMb * 1024 * 1024) : null,
      models,
    },
    workers: null,
    retained_caches: null,
    system_memory: percent === null && pressure === null ? null : { percent, pressure },
  };
}

function deriveStatus(items) {
  if (items.some((item) => item.kind === 'resource_pressure' && item.status === 'critical')) {
    return 'critical';
  }
  if (items.length > 0) {
    return 'warn';
  }
  return 'ok';
}

function buildResourceBudgetFacet(payload = {}) {
  const items = [];
  appendResourcePressure(items, payload.resources);
  appendToolPressure(items, payload.tool_observability);
  const usageSession = asPlainObject(payload.usage?.session);
  const usageCumulative = asPlainObject(payload.usage?.cumulative);
  return {
    available: true,
    status: deriveStatus(items),
    inputs: {
      usage: isReadyFacet(payload.usage),
      resources: isReadyFacet(payload.resources),
      tool_observability: isReadyFacet(payload.tool_observability),
      phase_percentiles: isReadyFacet(payload.phase_percentiles),
      slow_operations: isReadyFacet(payload.slow_operations),
    },
    items,
    resources: buildResources(payload.resources),
    usage: {
      session_total_tokens: normalizeFiniteNumber(usageSession.total_tokens),
      cumulative_total_tokens: normalizeFiniteNumber(usageCumulative.total_tokens),
      session_provider_cost_usd: normalizeFiniteNumber(usageSession.provider_cost_usd),
      cumulative_provider_cost_usd: normalizeFiniteNumber(usageCumulative.provider_cost_usd),
    },
    percentiles: {
      tools: collectToolPercentiles(payload.tool_observability),
      phases: collectPhasePercentiles(payload.phase_percentiles),
    },
  };
}

module.exports = {
  buildResourceBudgetFacet,
};
