'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLocalRuntime } = require('../services/backend/managed-sidecar-status');

test('local runtime round-trips load_failure and discards unknown shapes', () => {
  const failure = { cause: 'out_of_memory', message: 'memory exhausted', context: 8192,
    engine: 'ollama', model: 'qwen3:8b', at: '2026-10-07T12:00:00.000Z' };
  assert.deepEqual(normalizeLocalRuntime({ load_failure: failure }).load_failure, failure);
  assert.equal(normalizeLocalRuntime({ load_failure: { unknown: true } }).load_failure, null);
  assert.equal(normalizeLocalRuntime({}).load_failure, null);
});
const {
  applyManagedInitializePayload,
  buildManagedStatusSnapshot,
} = require('../services/backend/managed-sidecar-lifecycle.js');

function makeService(overrides = {}) {
  return {
    currentEngineType: 'ollama',
    currentModel: '',
    defaultModel: 'qwen3:8b',
    _managedPendingModel: 'qwen3:8b',
    currentStatus: null,
    configService: null,
    ...overrides,
  };
}

// The sidecar reports its MockEngine fallback as loaded and ready.
function applyMockFallbackPayload(service, localRuntimeOverrides = {}) {
  applyManagedInitializePayload(service, {
    active_engine: 'mock',
    active_model: 'mock-model',
    engine_fallback: { requested_engine: 'ollama', reason: 'Ollama engine failed to initialize: ConnectError' },
    local_runtime: {
      engine: { type: 'mock' },
      model: { id: 'mock-model', loaded: true, configured: true, residency: 'local' },
      readiness: { status: 'ready', ready: true, model_loaded: true },
      fallback: { active: true, requested_engine: 'ollama', reason: 'x' },
      ...localRuntimeOverrides,
    },
  });
}

test('failed load snapshot drops the fallback mock readiness but keeps the fallback explanation', () => {
  const service = makeService();
  applyMockFallbackPayload(service);
  // The initialize flight's catch branch.
  service.currentModel = '';
  service.currentEngineType = 'ollama';
  service._managedPendingModel = '';
  service.currentStatus = buildManagedStatusSnapshot(service, { model: '', model_loaded: false });

  const status = service.currentStatus;
  assert.equal(status.model_loaded, false);
  assert.equal(status.local_runtime.readiness.ready, false);
  assert.equal(status.local_runtime.readiness.model_loaded, false);
  assert.notEqual(status.local_runtime.readiness.status, 'ready');
  assert.equal(status.local_runtime.model.loaded, false);
  assert.equal(status.local_runtime.fallback.active, true);
  assert.equal(status.local_runtime.fallback.requested_engine, 'ollama');
  assert.ok(status.local_runtime.fallback.reason);
  assert.equal(status.engine_fallback.requested_engine, 'ollama');
});

test('model_loaded:false keeps provider residency loaded null', () => {
  const service = makeService({ currentEngineType: 'chatgpt', currentModel: 'gpt-x' });
  service.currentStatus = buildManagedStatusSnapshot(service, {
    local_runtime: {
      engine: { type: 'chatgpt' },
      model: { id: 'gpt-x', residency: 'remote', configured: true },
      readiness: { status: 'ready', ready: true },
    },
  });
  const status = buildManagedStatusSnapshot(service, { model: '', model_loaded: false });
  assert.equal(status.local_runtime.model.loaded, null);
  assert.equal(status.local_runtime.readiness.model_loaded, null);
});

test('a snapshot without an explicit model_loaded override keeps the reported readiness', () => {
  const service = makeService({ currentEngineType: 'ollama', currentModel: 'qwen3:8b' });
  service.currentStatus = buildManagedStatusSnapshot(service, {
    local_runtime: {
      engine: { type: 'ollama' },
      model: { id: 'qwen3:8b', loaded: true, configured: true, residency: 'local' },
      readiness: { status: 'ready', ready: true, model_loaded: true },
    },
  });
  const status = buildManagedStatusSnapshot(service, {});
  assert.equal(status.local_runtime.readiness.ready, true);
  assert.equal(status.local_runtime.readiness.model_loaded, true);
  assert.equal(status.local_runtime.model.loaded, true);
});

test('unload override with its own local_runtime still reports idle and unloaded', () => {
  const service = makeService({ currentEngineType: 'ollama', currentModel: 'qwen3:8b' });
  service.currentStatus = buildManagedStatusSnapshot(service, {
    local_runtime: {
      engine: { type: 'ollama' },
      model: { id: 'qwen3:8b', loaded: true, configured: true, residency: 'local' },
      readiness: { status: 'ready', ready: true, model_loaded: true },
    },
  });
  service.currentModel = '';
  const status = buildManagedStatusSnapshot(service, {
    model: '',
    model_loaded: false,
    local_runtime: {
      context: { native_context_length: null, configured_context_length: null, effective_context_length: null },
    },
  });
  assert.equal(status.local_runtime.readiness.status, 'idle');
  assert.equal(status.local_runtime.readiness.ready, false);
  assert.equal(status.local_runtime.model.loaded, false);
});
