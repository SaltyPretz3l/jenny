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
  const status = normalizeString(pressure.status).toLowerCase();
  if (!status || status === 'ok' || status === 'unknown' || status === 'disabled') {
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

function appendSlowOperations(items, slowOperations = {}) {
  if (!isReadyFacet(slowOperations) || Number(slowOperations.count || 0) <= 0) {
    return;
  }
  items.push({
    kind: 'slow_operations',
    count: Number(slowOperations.count || 0),
    items: Array.isArray(slowOperations.items) ? slowOperations.items.slice(0, 8) : [],
  });
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
  appendSlowOperations(items, payload.slow_operations);
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
