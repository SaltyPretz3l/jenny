'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildResourceBudgetFacet } = require('../services/backend/resource-budget-facade');

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
  assert.equal(facet.items.some((item) => item.kind === 'slow_operations'), true);
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
