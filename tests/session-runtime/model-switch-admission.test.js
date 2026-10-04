'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAdapterHarness } = require('../helpers/session-runtime-chat-adapter-harness');

// Split view gate B8 (2026-09-25): with two local turns admitted at once, the
// second turn's model lazy-load re-initialized the one sidecar stack under the
// first stream, whose reply then came from the other model under its own label.
const ROUTE = Object.freeze({ engine_type: 'ollama' });
const AUTHORITY = Object.freeze({ project_id: 'project_general' });

function context(workId, sessionId, model, extra = {}) {
  return { workId, sessionId, turnId: `turn_${workId}`, authority: AUTHORITY, route: ROUTE,
    request: { runtimePreferredModel: model }, ...extra };
}

function work(workId, sessionId, status = 'pending') {
  return { work_id: workId, session_id: sessionId, turn_id: `turn_${workId}`,
    project_id: 'project_general', status };
}

function isModelWait(error) {
  return error?.code === 'runtime_model_switch_busy' && error?.retryable === true;
}

function admit(adapter, workId, sessionId, model, extra) {
  const own = context(workId, sessionId, model, extra);
  adapter.contexts.set(workId, own);
  return () => adapter.assertModelAdmission(work(workId, sessionId), own);
}

test('admission: a turn on another model waits while an admitted turn runs', (t) => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  service.currentModel = 'model-a';
  adapter.contexts.set('running', context('running', 'other_session', 'model-a', { lease: { identity: {} } }));
  adapter.contexts.set('b', context('b', sessionId, 'model-b'));
  assert.throws(() => adapter.validateWork(work('b', sessionId), ROUTE), isModelWait);
  // F20: the wait names the chat holding the model, so the waiting send can say so.
  assert.throws(() => adapter.validateWork(work('b', sessionId), ROUTE), { blocking_session_id: 'other_session' });
});

test('the same model runs beside it; no preference is the bound model; another engine waits', (t) => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  service.currentModel = 'model-a';
  adapter.contexts.set('running', context('running', 'other_session', 'model-a', { lease: { identity: {} } }));
  assert.doesNotThrow(admit(adapter, 'c', sessionId, 'model-a'));
  assert.doesNotThrow(admit(adapter, 'd', sessionId, ''));
  assert.throws(admit(adapter, 'e', sessionId, 'model-a', { route: { engine_type: 'llama-server' } }), isModelWait);
});

test('only an admitted turn holds the model: a queued context does not, a reserved or resuming one does', (t) => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  service.currentModel = 'model-a';
  const tryB = admit(adapter, 'b', sessionId, 'model-b');
  adapter.contexts.set('queued', context('queued', 'other_session', 'model-a'));
  assert.doesNotThrow(tryB);
  adapter.contexts.set('queued', context('queued', 'other_session', 'model-a', { initialInferenceLease: {} }));
  assert.throws(tryB, isModelWait);
  adapter.contexts.set('queued', context('queued', 'other_session', 'model-a', { checkpointResume: {} }));
  assert.throws(tryB, isModelWait);
  adapter.contexts.delete('queued');
  assert.doesNotThrow(tryB);
});

test('a running turn is not re-checked against its neighbours', (t) => {
  const { adapter, sessionId } = createAdapterHarness(t);
  adapter.contexts.set('running', context('running', 'other_session', 'model-a', { lease: { identity: {} } }));
  adapter.contexts.set('b', context('b', sessionId, 'model-b', { lease: { identity: {} } }));
  assert.throws(() => adapter.validateWork(work('b', sessionId, 'running'), ROUTE), (error) => !isModelWait(error));
});
