'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InferenceOperations } = require('../../services/session-runtime/inference-operations');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');

function fixture(options = {}) {
  const lanes = options.lanes || new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
    configuration_revision: 'config:1', resource_class: 'local', requires_gpu: true });
  let live = true;
  const gateway = new InferenceOperations({ lanes, route, requestId: 'request:1',
    sessionId: 'session:1', authorityRevision: 'authority:1',
    assertCurrent: () => { if (!live) throw new Error('revoked'); }, ...options });
  const base = { schema_version: 1, api_version: '2026-08-17', kind: 'inference',
    request_id: 'request:1', session_id: 'session:1', authority_revision: 'authority:1',
    operation_id: 'operation:1' };
  const admit = patch => gateway.handle({ ...base, phase: 'admit', engine_type: 'ollama', ...patch });
  const settle = patch => gateway.handle({ ...base, phase: 'settle', status: 'succeeded',
    cleanup: 'confirmed', consumption: 'unknown', charge_consumption: true, ...patch });
  return { lanes, gateway, admit, settle, revoke: () => { live = false; } };
}

test('configured fallback acquires its captured provider and remains fenced by current grants', () => {
  const fallback = captureRuntimeRoute({ engine_type: 'vllm', provider_id: 'vllm',
    configuration_revision: 'config:1', resource_class: 'local', requires_gpu: true });
  let current = true; const checked = [];
  const setup = fixture({ fallbackRoutes: [fallback], assertRouteCurrent: route => {
    checked.push(route); if (!current) throw new Error('configuration_changed');
  } });
  setup.admit(); setup.settle({ status: 'failed' });
  assert.equal(setup.admit({ operation_id: 'fallback', engine_type: 'vllm' }).status, 'granted');
  assert.equal(checked.at(-1), fallback);
  setup.settle({ operation_id: 'fallback' });
  current = false;
  assert.equal(setup.admit({ operation_id: 'stale', engine_type: 'vllm' }).status, 'rejected');
  assert.equal(setup.admit({ operation_id: 'cloud', engine_type: 'chatgpt' }).status, 'rejected');
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('inference admission uses the captured lane and never accepts route overrides', () => {
  const setup = fixture();
  for (const patch of [{ engine_type: 'chatgpt' }, { resource_class: 'cloud' },
    { authority_revision: 'other' }, { request_id: 'other' }, { session_id: 'other' },
    { operation_id: '' }, { api_version: 'future' }]) {
    assert.equal(setup.admit(patch).status, 'rejected');
  }
  assert.equal(setup.lanes.snapshot().active_leases, 0);
  assert.equal(setup.admit().status, 'granted');
  assert.equal(setup.admit().reason, 'inference_operation_duplicate');
  assert.equal(setup.admit({ operation_id: 'operation:2' }).status, 'waiting');
  assert.equal(setup.settle().status, 'settled');
  assert.equal(setup.admit({ operation_id: 'operation:2' }).status, 'granted');
  setup.gateway.close({ producerSettled: true });
});

test('revocation stops inference but permits exact original settlement once', () => {
  const setup = fixture();
  assert.equal(setup.admit().status, 'granted');
  setup.revoke();
  assert.equal(setup.admit({ operation_id: 'operation:2' }).reason, 'inference_authority_stale');
  assert.equal(setup.settle({ authority_revision: 'other' }).status, 'rejected');
  assert.equal(setup.lanes.snapshot().active_leases, 1);
  assert.equal(setup.settle().status, 'settled');
  assert.equal(setup.settle().status, 'settled');
  assert.equal(setup.settle({ status: 'failed' }).reason, 'inference_settlement_conflict');
  assert.equal(setup.lanes.snapshot().active_leases, 0);
  assert.equal(setup.gateway.snapshot().unknown_consumption, 1);
});

test('uncertain cleanup retains capacity until the actual producer is confirmed terminated', () => {
  const setup = fixture();
  assert.equal(setup.admit().status, 'granted');
  assert.equal(setup.settle({ cleanup: 'uncertain' }).status, 'settled');
  assert.equal(setup.lanes.snapshot().quarantined, 1);
  assert.equal(setup.gateway.close().quarantined, 1);
  assert.equal(setup.admit({ operation_id: 'operation:2' }).reason, 'inference_request_closed');
  assert.equal(setup.gateway.close({ producerSettled: true }).quarantined, 0);
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('closing an active request does not release inference on cancellation alone', () => {
  const setup = fixture();
  setup.admit();
  setup.gateway.close();
  assert.equal(setup.lanes.snapshot().quarantined, 1);
  assert.equal(setup.settle({ status: 'cancelled' }).status, 'settled');
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('operation retention is bounded without discarding settlement evidence', () => {
  const setup = fixture({ maxOperations: 1 });
  setup.admit();
  setup.settle();
  assert.equal(setup.admit({ operation_id: 'operation:2' }).reason, 'inference_operation_capacity');
  assert.equal(setup.gateway.snapshot().operations, 1);
  assert.equal(setup.settle().status, 'settled');
});

test('late uncertain settlement cannot override confirmed producer termination', () => {
  const setup = fixture();
  setup.admit();
  setup.gateway.close({ producerSettled: true });
  assert.equal(setup.settle({ cleanup: 'uncertain' }).status, 'settled');
  assert.equal(setup.gateway.snapshot().quarantined, 0);
  assert.equal(setup.gateway.snapshot().settled, 1);
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('authority is reasserted after synchronous lane observers run', () => {
  let live = true;
  const lanes = new RuntimeLaneAdmission({ onChange: () => { live = false; } });
  const setup = fixture({ lanes, assertCurrent: () => { if (!live) throw new Error('revoked'); } });
  assert.equal(setup.admit().reason, 'inference_authority_stale');
  assert.equal(lanes.snapshot().active_leases, 0);
});

test('cancellation is idempotent when lane observers synchronously close again', () => {
  const setup = fixture();
  setup.admit();
  let observations = 0;
  setup.lanes.onChange = () => {
    observations += 1;
    setup.gateway.close();
  };
  setup.gateway.close();
  assert.equal(observations, 1);
  assert.equal(setup.gateway.snapshot().quarantined, 1);
  setup.gateway.close();
  assert.equal(observations, 1);
  setup.gateway.close({ producerSettled: true });
  assert.equal(observations, 2);
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('preflight reserves only one lease under synchronous observers and transfers it once', () => {
  const setup = fixture();
  const nested = [];
  setup.lanes.onChange = () => nested.push(setup.gateway.reserveInitial().status);
  assert.equal(setup.gateway.reserveInitial().status, 'granted');
  assert.deepEqual(nested, ['rejected']);
  assert.equal(setup.gateway.snapshot().reserved, 1);
  assert.equal(setup.gateway.reserveInitial().status, 'granted');
  assert.equal(setup.admit().status, 'granted');
  assert.equal(setup.gateway.snapshot().reserved, 0);
  assert.equal(setup.lanes.snapshot().active_leases, 1);
  setup.settle();
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('preflight cancellation before a producer exists releases the unused reservation', () => {
  const setup = fixture();
  setup.lanes.onChange = () => setup.gateway.close();
  assert.equal(setup.gateway.reserveInitial().status, 'rejected');
  assert.equal(setup.gateway.snapshot().reserved, 0);
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

// A run-mode flip mid-request: the execution authority's requireCurrent throws
// with code run_mode_changed, and the refusal must carry that code so the
// sidecar's terminal error names the user's own action instead of a generic
// inference_authority_stale (2026-09-15 live gate, turn C).
test('a run-mode change is refused with its own reason on admit and on preflight', () => {
  let code = '';
  const assertCurrent = () => { if (code) throw Object.assign(new Error('mode'), { code }); };
  const setup = fixture({ assertCurrent });
  assert.equal(setup.admit().status, 'granted');
  assert.equal(setup.settle().status, 'settled');
  code = 'run_mode_changed';
  const refused = setup.admit({ operation_id: 'operation:2' });
  assert.equal(refused.status, 'rejected');
  assert.equal(refused.reason, 'run_mode_changed');
  code = 'configuration_changed';
  assert.equal(setup.admit({ operation_id: 'operation:3' }).reason, 'inference_authority_stale');
  assert.equal(setup.lanes.snapshot().active_leases, 0);

  code = 'run_mode_changed';
  const preflight = fixture({ assertCurrent });
  const reserved = preflight.gateway.reserveInitial();
  assert.equal(reserved.status, 'rejected');
  assert.equal(reserved.reason, 'run_mode_changed');
  assert.equal(preflight.lanes.snapshot().active_leases, 0);
});
