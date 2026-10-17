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

// Row 54: an openai-compatible failure is stamped with the managed server it
// belonged to at the time, so the label never follows whatever serves later.
test('an openai-compatible failure carries the managed server kind; other engines carry none', () => {
  const managers = { ninfer: { state: 'stopped', lastError: '' }, llama: { state: 'stopped', lastError: '' } };
  const service = Object.assign(serviceForModel(), {
    currentEngineType: 'openai-compatible',
    options: { getNinferManager: () => ({ getStatus: () => managers.ninfer }), getLlamaServerManager: () => ({ getStatus: () => managers.llama }) },
  });
  const openai = (model = 'qwen3:8b') => ({ method: 'runtime.load_failure', params: { ...message(model).params, engine: 'openai-compatible' } });
  managers.ninfer = { state: 'ready', lastError: '' };
  applyRuntimeLoadFailure(service, openai());
  assert.equal(service._modelLifecycle.failure.managed, 'ninfer');
  managers.ninfer = { state: 'crashed', lastError: 'ninfer_exited:1' };
  service._modelLifecycle = { state: 'ready', requested_model: 'qwen3:8b' };
  applyRuntimeLoadFailure(service, openai());
  assert.equal(service._modelLifecycle.failure.managed, 'ninfer', 'a crash mid-load still belongs to NInfer');
  managers.ninfer = { state: 'stopped', lastError: 'exclusivity_refused' };
  managers.llama = { state: 'ready', lastError: '' };
  service._modelLifecycle = { state: 'ready', requested_model: 'qwen3:8b' };
  applyRuntimeLoadFailure(service, openai());
  assert.equal(service._modelLifecycle.failure.managed, 'llama-server', 'a live llama-server owns the failure over a stale NInfer error');
  managers.ninfer = { state: 'stopped', lastError: '' };
  managers.llama = { state: 'stopped', lastError: '' };
  service._modelLifecycle = { state: 'ready', requested_model: 'qwen3:8b' };
  applyRuntimeLoadFailure(service, openai());
  assert.equal(Object.hasOwn(service._modelLifecycle.failure, 'managed'), false, 'a user-run endpoint names no managed server');
  managers.ninfer = { state: 'ready', lastError: '' };
  service._modelLifecycle = { state: 'ready', requested_model: 'qwen3:8b' };
  applyRuntimeLoadFailure(service, message());
  assert.equal(Object.hasOwn(service._modelLifecycle.failure, 'managed'), false, 'an Ollama failure is never stamped');
  // The initialize path stamps the same way.
  service.currentEngineType = 'openai-compatible';
  const warmup = initializeLoadFailure(service, { local_runtime: { load_failure: openai().params } }, 'qwen3:8b');
  assert.equal(warmup.managed, 'ninfer');
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
