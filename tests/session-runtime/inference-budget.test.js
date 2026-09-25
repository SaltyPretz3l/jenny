'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RootRunBudgetStore } = require('../../services/session-runtime/budgets');
const { createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { createInferenceBudget } = require('../../services/session-runtime/inference-budget');
const { InferenceOperations } = require('../../services/session-runtime/inference-operations');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');

const fingerprint = 'a'.repeat(64);
function fixture(t, { count = 2, allowedProviderIds = ['ollama'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-inference-budget-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const io = { ...createRuntimeStoreIO() };
  const store = new RootRunBudgetStore(root, { io });
  store.create({ rootRunId: 'root_1', authorityFingerprint: fingerprint, allowedProviderIds,
    limits: { inference_requests: count, input_tokens: count * 100, output_tokens: count * 50 } });
  const maxima = { inference_requests: 1, input_tokens: 100, output_tokens: 50 };
  const budget = createInferenceBudget({ store, rootRunId: 'root_1', workId: 'work_1',
    attemptId: 'attempt_1', providerId: 'ollama', authorityFingerprint: fingerprint, maxima });
  const lanes = new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
    configuration_revision: 'config:1', resource_class: 'local', requires_gpu: true });
  let live = true;
  const options = { lanes, route, requestId: 'request_1', sessionId: 'session_1',
    authorityRevision: 'authority_1', budget, assertCurrent: () => { if (!live) throw new Error('revoked'); } };
  const gateway = new InferenceOperations(options);
  const base = { schema_version: 1, api_version: '2026-08-17', kind: 'inference',
    request_id: 'request_1', session_id: 'session_1', authority_revision: 'authority_1' };
  const admit = (id = 'operation_1', target = gateway) => target.handle({ ...base,
    operation_id: id, phase: 'admit', engine_type: 'ollama' });
  const settle = (id = 'operation_1', patch = {}) => gateway.handle({ ...base,
    operation_id: id, phase: 'settle', status: 'succeeded', cleanup: 'confirmed',
    consumption: 'unknown', charge_consumption: true, ...patch });
  return { root, io, store, budget, maxima, lanes, options, gateway, base, admit, settle,
    revoke: () => { live = false; } };
}

test('fallback keeps the original root budget and cannot add provider authority', t => {
  const h = fixture(t, { allowedProviderIds: ['ollama', 'vllm'] });
  const fallback = captureRuntimeRoute({ engine_type: 'vllm', provider_id: 'vllm',
    configuration_revision: 'config:1', resource_class: 'local', requires_gpu: true });
  const gateway = new InferenceOperations({ ...h.options, fallbackRoutes: [fallback] });
  assert.equal(h.admit('primary', gateway).status, 'granted');
  gateway.close({ producerSettled: true });
  const next = new InferenceOperations({ ...h.options, fallbackRoutes: [fallback] });
  assert.equal(next.handle({ ...h.base, operation_id: 'fallback', phase: 'admit', engine_type: 'vllm' }).status, 'granted');
  next.close({ producerSettled: true });
  const root = h.store.get('root_1');
  assert.equal(root.charged.inference_requests, 2);
  assert.deepEqual(root.reservations.map(item => item.provider_id), ['ollama', 'vllm']);
  assert.throws(() => h.budget.forProvider('chatgpt'), { code: 'budget_authority_mismatch' });
  assert.equal(h.lanes.snapshot().active_leases, 0);
});

test('durable reservation precedes grant and unknown settlement charges the captured maxima once', t => {
  const h = fixture(t, { count: 1 });
  h.maxima.input_tokens = 0;
  assert.equal(h.gateway.reserveInitial().status, 'granted');
  assert.equal(h.store.get('root_1').reservations.length, 0);
  assert.equal(h.admit().status, 'granted');
  const durable = new RootRunBudgetStore(h.root).get('root_1');
  assert.deepEqual(durable.charged, { inference_requests: 1, input_tokens: 100, output_tokens: 50 });
  assert.equal(durable.reservations[0].settlement, null);
  assert.equal(h.admit().reason, 'inference_operation_duplicate');
  h.revoke();
  assert.equal(h.settle().status, 'settled');
  const revision = h.store.get('root_1').revision;
  assert.equal(h.settle().status, 'settled');
  assert.equal(h.store.get('root_1').revision, revision);
  assert.deepEqual(h.store.get('root_1').charged, durable.charged);
  assert.equal(h.settle('operation_1', { status: 'failed' }).reason, 'inference_settlement_conflict');
  assert.equal(h.lanes.snapshot().active_leases, 0);
});

test('exhausted roots reject inference without retaining physical capacity', t => {
  const h = fixture(t, { count: 1 });
  h.admit(); h.settle();
  assert.equal(h.admit('operation_2').reason, 'budget_exhausted');
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.store.get('root_1').reservations.length, 1);
});

test('new gateway or attempt cannot replay a prior durable operation ID', t => {
  const h = fixture(t);
  h.admit(); h.gateway.close({ producerSettled: true });
  const reopened = new InferenceOperations(h.options);
  assert.equal(h.admit('operation_1', reopened).reason, 'budget_operation_duplicate');
  const otherAttempt = createInferenceBudget({ store: h.store, rootRunId: 'root_1',
    workId: 'work_1', attemptId: 'attempt_2', providerId: 'ollama', authorityFingerprint: fingerprint,
    maxima: h.maxima });
  const resumed = new InferenceOperations({ ...h.options, budget: otherAttempt });
  assert.equal(h.admit('operation_1', resumed).reason, 'budget_reservation_conflict');
  assert.equal(h.admit('operation_2', resumed).status, 'granted');
  resumed.close({ producerSettled: true });
  assert.equal(h.store.get('root_1').charged.inference_requests, 2);
});

for (const written of [false, true]) test(`reservation write failure (${written ? 'after' : 'before'} publication) never grants`, t => {
  const h = fixture(t);
  const write = h.io.writeJsonAtomic;
  h.io.writeJsonAtomic = (file, value) => {
    if (written) write(file, value);
    throw new Error('disk unavailable');
  };
  assert.equal(h.admit().reason, 'budget_write_uncertain');
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.store.snapshot().read_only, true);
  h.io.writeJsonAtomic = write;
  h.store.recover();
  assert.equal(h.admit().status, written ? 'rejected' : 'granted');
  h.gateway.close({ producerSettled: true });
  assert.equal(h.store.get('root_1').charged.inference_requests, 1);
});

test('settlement write failure keeps the durable charge, releases proven physical capacity, and retries exactly', t => {
  const h = fixture(t);
  h.admit();
  const write = h.io.writeJsonAtomic;
  h.io.writeJsonAtomic = () => { throw new Error('disk unavailable'); };
  assert.equal(h.settle().reason, 'inference_budget_settlement_pending');
  assert.equal(h.gateway.snapshot().budget_settlements_pending, 1);
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(new RootRunBudgetStore(h.root).get('root_1').charged.inference_requests, 1);
  assert.equal(h.admit('operation_2').status, 'rejected');
  h.io.writeJsonAtomic = write;
  h.store.recover();
  assert.equal(h.settle().status, 'settled');
  assert.equal(h.gateway.snapshot().budget_settlements_pending, 0);
  assert.equal(h.store.get('root_1').reservations[0].settlement.consumption, 'unknown');
});

test('revocation during durable reservation prevents grant and conservatively retains its charge', t => {
  const h = fixture(t);
  const write = h.io.writeJsonAtomic;
  h.io.writeJsonAtomic = (file, value) => { write(file, value); h.revoke(); };
  assert.equal(h.admit().reason, 'inference_authority_stale');
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.store.get('root_1').charged.inference_requests, 1);
  assert.equal(h.store.get('root_1').reservations[0].settlement.consumption, 'unknown');
});

test('shutdown keeps unknown consumption charged and uncertain producers quarantined', t => {
  const h = fixture(t);
  h.admit();
  h.gateway.close();
  assert.equal(h.lanes.snapshot().quarantined, 1);
  assert.equal(h.store.get('root_1').reservations[0].settlement.consumption, 'unknown');
  h.gateway.close({ producerSettled: true });
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.equal(h.store.get('root_1').charged.inference_requests, 1);
  assert.equal(h.settle('operation_1', { cleanup: 'uncertain' }).status, 'settled');
  assert.equal(h.lanes.snapshot().quarantined, 0);
});

test('budget capability requires existing root authority and cannot route another provider or accept wire objects', t => {
  const h = fixture(t);
  for (const patch of [{ rootRunId: 'missing' }, { authorityFingerprint: 'b'.repeat(64) },
    { providerId: 'openai' }]) {
    assert.throws(() => createInferenceBudget({ store: h.store, rootRunId: 'root_1', workId: 'work_1',
      attemptId: 'attempt_1', providerId: 'ollama', authorityFingerprint: fingerprint,
      maxima: h.maxima, ...patch }));
  }
  assert.throws(() => new InferenceOperations({ ...h.options, budget: { ...h.budget } }), /binding_invalid/);
  const route = captureRuntimeRoute({ engine_type: 'openai', provider_id: 'openai',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  assert.throws(() => new InferenceOperations({ ...h.options, route }), /binding_invalid/);
  assert.equal(h.store.snapshot().root_record_count, 1);
});


test('budgeted wire admission requires closed per-operation maxima and never accepts root/provider overrides', t => {
  const h = fixture(t);
  const budget = createInferenceBudget({ store: h.store, rootRunId: 'root_1', workId: 'work_1',
    attemptId: 'attempt_1', providerId: 'ollama', authorityFingerprint: fingerprint });
  const gateway = new InferenceOperations({ ...h.options, budget });
  const params = { schema_version: 1, api_version: '2026-08-17', kind: 'inference', phase: 'admit',
    request_id: 'request_1', session_id: 'session_1', authority_revision: 'authority_1',
    operation_id: 'operation_1', engine_type: 'ollama', maxima: h.maxima };
  for (const patch of [{ maxima: undefined }, { maxima: { ...h.maxima, cost: 0 } },
    { maxima: { ...h.maxima, inference_requests: 0 } }, { root_run_id: 'other' },
    { maxima: { ...h.maxima, output_tokens: -1 } },
    { maxima: { ...h.maxima, input_tokens: 0 } }, { maxima: { ...h.maxima, output_tokens: 0 } }, { provider_id: 'openai' }]) {
    assert.equal(gateway.handle({ ...params, ...patch }).status, 'rejected');
  }
  assert.equal(h.store.get('root_1').reservations.length, 0);
  assert.equal(gateway.handle(params).status, 'granted');
  assert.deepEqual(h.store.get('root_1').charged, h.maxima);
  gateway.close({ producerSettled: true });
});
