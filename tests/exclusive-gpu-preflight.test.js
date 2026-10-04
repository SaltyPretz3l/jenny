'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { holdEventLoopUntilTestsFinish } = require('./helpers/event-loop-hold');

// Production timers in this module are unref'd; see the helper.
holdEventLoopUntilTestsFinish(test);

const {
  verifyGpuEvictedForEngine,
  verifyOllamaGpuEvicted,
} = require('../services/backend/exclusive-gpu-preflight');

function fetchPayload(payload) {
  return async () => ({ ok: true, json: async () => payload });
}

test('GPU eviction requires an explicit empty Ollama model list', async () => {
  assert.deepEqual(await verifyOllamaGpuEvicted({ fetchImpl: fetchPayload({ models: [] }) }),
    { ok: true });
  assert.deepEqual(await verifyOllamaGpuEvicted({ fetchImpl: fetchPayload({ models: [{}] }) }),
    { ok: false, reason: 'gpu_model_still_resident', resident_count: 1 });
});

test('GPU eviction proof rejects local engines without an authoritative unload proof', async () => {
  for (const engineType of ['vllm', 'openai-compatible', 'plugin_host', '']) {
    assert.deepEqual(await verifyGpuEvictedForEngine({ engineType }),
      { ok: false, reason: 'gpu_eviction_unverifiable' });
  }
  assert.deepEqual(await verifyGpuEvictedForEngine({ engineType: 'replay',
    fetchImpl: fetchPayload({ models: [] }) }),
    { ok: true, proof: 'engine_has_no_local_gpu_runtime' });
});

test('GPU eviction fails closed for malformed probe payloads', async () => {
  for (const payload of [{}, { models: null }, [], null]) {
    assert.deepEqual(await verifyOllamaGpuEvicted({ fetchImpl: fetchPayload(payload) }),
      { ok: false, reason: 'gpu_eviction_probe_failed' });
  }
});
