'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildResourceBudgetFacet } = require('../services/backend/resource-budget-facade');

test('resource budget facade always exposes the nullable resources shape', () => {
  const facet = buildResourceBudgetFacet({});
  assert.deepEqual(facet.resources, {
    app_memory_bytes: null,
    model_memory: null,
    workers: null,
    retained_caches: null,
    system_memory: null,
  });
  assert.equal(facet.inputs.resources, false);
});

test('resource budget facade surfaces resource, tool, usage, and percentile pressure', () => {
  const facet = buildResourceBudgetFacet({
    usage: {
      available: true,
      session: { total_tokens: 21, provider_cost_usd: 0.21 },
      cumulative: { total_tokens: 44, provider_cost_usd: 0.44 },
    },
    resources: {
      available: true,
      sidecar: {
        available: true,
        system_pressure: {
          status: 'pressured',
          warnings: ['cpu_saturation_high'],
        },
      },
    },
    tool_observability: {
      available: true,
      tools: {
        web_search: {
          count: 4,
          error_count: 1,
          latency_ms: { p50: 100, p95: 2500, p99: 4000 },
        },
      },
    },
    phase_percentiles: {
      available: true,
      phases: {
        provider_request_start_to_first_chunk: {
          count: 3,
          p50: 250,
          p95: 700,
          p99: 900,
        },
      },
    },
    slow_operations: {
      available: true,
      count: 1,
      items: [{ kind: 'tool', id: 'web_search', metric: 'p95' }],
    },
  });

  assert.equal(facet.available, true);
  assert.equal(facet.status, 'warn');
  assert.equal(facet.inputs.resources, true);
  assert.equal(facet.percentiles.tools.web_search.p95, 2500);
  assert.equal(facet.percentiles.phases.provider_request_start_to_first_chunk.p99, 900);
  assert.equal(facet.items.some((item) => item.kind === 'resource_pressure'), true);
  assert.equal(facet.items.find((item) => item.kind === 'resource_pressure').status, 'high');
  assert.equal(facet.resources.system_memory.pressure, 'high');
  assert.equal(facet.items.some((item) => item.kind === 'slow_operations'), false);
});

test('resource budget facade fails open when inputs are unavailable', () => {
  const facet = buildResourceBudgetFacet({
    usage: { available: false },
    resources: { available: false },
    tool_observability: { available: false },
    phase_percentiles: { available: false },
    slow_operations: { available: false },
  });

  assert.equal(facet.available, true);
  assert.equal(facet.status, 'ok');
  assert.deepEqual(facet.inputs, {
    usage: false,
    resources: false,
    tool_observability: false,
    phase_percentiles: false,
    slow_operations: false,
  });
  assert.deepEqual(facet.items, []);
});

for (const [status, pressure, budgetStatus, itemCount] of [
  ['critical', 'critical', 'critical', 1],
  ['ok', 'normal', 'ok', 0],
  ['unknown', null, 'ok', 0],
  ['disabled', null, 'ok', 0],
]) {
  test(`resource pressure maps ${status} without coercing absent RAM to zero`, () => {
    const facet = buildResourceBudgetFacet({ resources: {
      available: true, sidecar: { system_pressure: { status, memory: { percent: 62 } } },
    } });
    assert.deepEqual(facet.resources.system_memory, { percent: 62, pressure });
    assert.equal(facet.status, budgetStatus);
    assert.equal(facet.items.length, itemCount);
    const absent = buildResourceBudgetFacet({ resources: { sidecar: { system_pressure: { status } } } });
    assert.deepEqual(absent.resources.system_memory, pressure === null ? null : { percent: null, pressure });
  });
}

test('resource measurements preserve nulls and zeros and sum model memory', () => {
  const models = [
    { name: 'alpha', size_bytes: 100, vram_bytes: null },
    { name: 'beta', size_bytes: null, vram_bytes: 20 },
    { name: 'empty', size_bytes: 0, vram_bytes: 0 },
  ];
  const facet = buildResourceBudgetFacet({ resources: {
    available: true, app_memory_bytes: 0, resident_models: models,
    system: { ramPercent: 0, gpuMemory: { available: true, totalMb: 8192 } },
    sidecar: { system_pressure: { status: 'ok', memory: { percent: 80 } } },
  } });
  assert.deepEqual(facet.resources, {
    app_memory_bytes: 0,
    model_memory: { ram_bytes: 100, vram_bytes: 20, vram_total_bytes: 8192 * 1024 * 1024, models },
    workers: null, retained_caches: null, system_memory: { percent: 0, pressure: 'normal' },
  });
});

test('unknown model sizes and unavailable GPU totals stay null; an empty resident list is a real zero', () => {
  const models = [{ name: 'unknown', size_bytes: null, vram_bytes: null }];
  for (const gpuMemory of [{ available: false, totalMb: 8192 }, { available: true, totalMb: 0 }, { available: true, totalMb: Infinity }]) {
    const facet = buildResourceBudgetFacet({ resources: { resident_models: models, system: { gpuMemory } } });
    assert.deepEqual(facet.resources.model_memory, { ram_bytes: null, vram_bytes: null, vram_total_bytes: null, models });
    const empty = buildResourceBudgetFacet({ resources: { resident_models: [], system: { gpuMemory } } });
    assert.deepEqual(empty.resources.model_memory, { ram_bytes: 0, vram_bytes: 0, vram_total_bytes: null, models: [] });
  }
});

test('model RAM is the resident size less the VRAM part, so a model on the GPU is not counted twice', () => {
  const GB = 1024 * 1024 * 1024;
  const facet = buildResourceBudgetFacet({ resources: { resident_models: [
    { name: 'on-gpu', size_bytes: 8 * GB, vram_bytes: 8 * GB },
    { name: 'split', size_bytes: 4 * GB, vram_bytes: 3 * GB },
    { name: 'cpu-only', size_bytes: 2 * GB, vram_bytes: null },
    { name: 'odd', size_bytes: 1 * GB, vram_bytes: 2 * GB },
  ] } });
  assert.equal(facet.resources.model_memory.ram_bytes, 3 * GB, '0 + 1 + 2 + 0 (never negative)');
  assert.equal(facet.resources.model_memory.vram_bytes, 13 * GB);
});

test('non-finite and non-numeric resource measurements never become wire numbers', () => {
  const facet = buildResourceBudgetFacet({ resources: {
    app_memory_bytes: Infinity,
    resident_models: [{ name: 'invalid', size_bytes: NaN, vram_bytes: '12' }],
    system: { ramPercent: null },
    sidecar: { system_pressure: { status: 'unknown', memory: { percent: NaN } } },
  } });
  assert.equal(facet.resources.app_memory_bytes, null);
  assert.equal(facet.resources.system_memory, null);
  assert.equal(facet.resources.model_memory.ram_bytes, null);
  assert.equal(facet.resources.model_memory.vram_bytes, null);
});
