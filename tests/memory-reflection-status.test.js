'use strict';

// The memory_reflection Diagnostics facet (agentic memory v2, row 58 W2) rides
// on jenny_status: counters and states only, never memory text.

const assert = require('node:assert/strict');
const test = require('node:test');

const { getJennyStatus } = require('../services/backend/jenny-status-composer');
const { buildMemoryReflectionFacet } = require('../services/backend/memory-reflection-status');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function minimalService(overrides = {}) {
  return {
    getBackendStatus: () => ({ phase: 'ready', detail: '', error: '', appVersion: '1.0.0-test' }),
    currentStatus: { engine: 'ollama', model: 'llama3:8b', model_loaded: false, tools_status: {} },
    shellLogStore: { list: () => [], getCurrentDiagnosticsMetadata: () => ({ sources: {}, integrity: { complete: true, partial_reasons: [] } }) },
    toolPermissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    ...overrides,
  };
}

const SNAPSHOT = Object.freeze({ enabled: true, state: 'backing_off', last_run_at: '2026-10-15T10:00:00.000Z',
  last_outcome: 'refused:policy_stale', runs: 4, preempted: 1, saved: 2, queued: 0, skipped: 1, failed: 0,
  refused: { policy_stale: 1 }, backoffs: 1 });

test('jenny_status attaches the memory_reflection facet', async () => {
  const status = await getJennyStatus(minimalService({ memoryReflectionScheduler: { snapshot: () => SNAPSHOT } }));
  assert.deepEqual(status.memory_reflection, { available: true, ...SNAPSHOT });
  const absent = await getJennyStatus(minimalService());
  assert.equal(absent.memory_reflection.available, false);
  assert.equal(absent.memory_reflection.state, 'idle');
});

test('the facet never throws and keeps only whitelisted scalar fields', () => {
  const broken = buildMemoryReflectionFacet({ memoryReflectionScheduler: { snapshot() { throw new Error('boom'); } } });
  assert.equal(broken.available, false);
  const noisy = buildMemoryReflectionFacet({ memoryReflectionScheduler: { snapshot: () => ({
    ...SNAPSHOT, state: 'weird', last_outcome: 'I prefer tabs', text: 'secret memory', refused: { 'Bad Reason': 2, cursor_moved: 1 } }) } });
  assert.equal(noisy.state, 'idle');
  assert.equal(noisy.last_outcome, null, 'an outcome outside the vocabulary is dropped');
  assert.deepEqual(noisy.refused, { cursor_moved: 1 });
  assert.equal(Object.hasOwn(noisy, 'text'), false);
});
