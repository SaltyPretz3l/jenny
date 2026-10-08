'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { applyRuntimeLoadFailure, initializeLoadFailure, setModelLifecycle } = require('../services/backend/local-engine-status');
const { createSidecarClient, disposeSidecarClient } = require('../services/backend/managed-sidecar-lifecycle');

function serviceForModel() {
  return Object.assign(new EventEmitter(), {
    currentEngineType: 'ollama', currentModel: 'qwen3:8b', currentStatus: {},
    _modelLifecycle: { state: 'ready', requested_model: 'qwen3:8b' },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) }, _emitServiceLog() {},
  });
}

function message(model = 'qwen3:8b') {
  return { method: 'runtime.load_failure', params: {
    cause: 'out_of_memory', message: 'model requires more system memory', context: 8192,
    engine: 'ollama', model, at: '2026-10-07T12:00:00.000Z',
  } };
}

test('runtime failure makes the model unavailable and emits its cause, then loading clears it', () => {
  const service = serviceForModel();
  const events = [];
  service.on('backend-status', (status) => events.push(status));
  applyRuntimeLoadFailure(service, message());
  assert.equal(service._modelLifecycle.state, 'unavailable');
  assert.equal(service.currentModel, '', 'the next send loads a model instead of reusing the failed one');
  assert.equal(events.at(-1).phase, 'model_unavailable');
  assert.equal(events.at(-1).model_lifecycle.failure.cause, 'out_of_memory');
  assert.equal(service.currentStatus.model_loaded, false);
  setModelLifecycle(service, { state: 'loading' });
  assert.equal(service._modelLifecycle.failure, null);
});

test('another model, active initialization, and invalid envelopes are ignored', () => {
  const service = serviceForModel();
  const before = service._modelLifecycle;
  for (const invalid of [message('another:8b'), { method: 'runtime.progress', params: {} }, { method: 'runtime.load_failure', params: [] }, { method: 'runtime.load_failure', params: { unknown: true } }]) {
    applyRuntimeLoadFailure(service, invalid);
    assert.equal(service._modelLifecycle, before);
  }
  service._managedInitializeFlight = {};
  applyRuntimeLoadFailure(service, message());
  assert.equal(service._modelLifecycle, before);
});

test('a failure pushed during the init flight is kept for the flight, and the payload snapshot carries one too', () => {
  const service = serviceForModel();
  const before = service._modelLifecycle;
  service._managedPendingModel = 'qwen3:8b';
  service._managedInitializeFlight = { requestedModel: 'qwen3:8b' };
  applyRuntimeLoadFailure(service, message('another:8b'));
  assert.equal(service._managedInitializeFlight.loadFailure, undefined, 'a foreign model is not kept');
  applyRuntimeLoadFailure(service, message());
  assert.equal(service._modelLifecycle, before, 'the flight owns the lifecycle while open');
  assert.equal(service._managedInitializeFlight.loadFailure.cause, 'out_of_memory');
  assert.equal(initializeLoadFailure(service, { local_runtime: {} }, 'qwen3:8b').cause, 'out_of_memory');
  assert.equal(initializeLoadFailure(service, { local_runtime: {} }, 'other:8b'), null);
  service._managedInitializeFlight = { requestedModel: 'qwen3:8b' };
  const snapshot = { local_runtime: { load_failure: message().params } };
  assert.equal(initializeLoadFailure(service, snapshot, 'qwen3:8b').message, 'model requires more system memory');
  assert.equal(initializeLoadFailure(service, snapshot, ''), null);
});

test('the sidecar notification entry point routes background load failures', () => {
  const service = serviceForModel();
  service.sidecarClient = createSidecarClient(service);
  try {
    service.sidecarClient.emit('notification', message());
    assert.equal(service._modelLifecycle.failure.cause, 'out_of_memory');
  } finally {
    disposeSidecarClient(service);
  }
});
