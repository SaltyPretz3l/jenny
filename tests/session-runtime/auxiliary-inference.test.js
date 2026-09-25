'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeLaneAdmission } = require('../../services/session-runtime/lanes');
const { requestRuntimeInference } = require('../../services/backend/backend-runtime-inference');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../../services/session-runtime/inference-protocol');

function fixture() {
  const calls = [];
  const client = { process: {}, runtimeOperationHandlers: new Map(), async request(method, params, options) {
    calls.push({ method, params, options });
    const context = params.inference_context;
    const handler = client.runtimeOperationHandlers.get(context.request_id);
    const base = { api_version: '2026-08-17', schema_version: 1, kind: 'inference',
      request_id: context.request_id, session_id: context.session_id,
      authority_revision: context.authority_revision, operation_id: 'inference_1' };
    assert.equal(handler({ ...base, phase: 'admit', engine_type: context.engine_type }).status, 'granted');
    if (client.run) await client.run({ handler, base });
    else handler({ ...base, phase: 'settle', status: 'succeeded', cleanup: 'confirmed',
      consumption: 'unknown', charge_consumption: true });
    return { message: 'done' };
  } };
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, { runtime_inference_admission_version: 1 });
  const scheduler = { closing: false, beginClosing() { this.closing = true; } };
  const service = { currentEngineType: 'mock', configService: { getState: () => ({}) },
    sidecarClient: client, featureFlags: { session_runtime: false },
    sessionRuntime: { lanes: new RuntimeLaneAdmission(), scheduler }, _emitServiceLog() {} };
  const request = method => requestRuntimeInference(service, method || 'commit.generate_message', { diff: 'user diff' });
  return { service, client, calls, request };
}

test('auxiliary requests reserve capacity before dispatch and carry no project authority', async () => {
  const setup = fixture();
  assert.deepEqual(await setup.request(), { message: 'done' });
  const context = setup.calls[0].params.inference_context;
  assert.deepEqual(Object.keys(context).sort(), ['authority_revision', 'engine_type', 'request_id', 'schema_version', 'session_id']);
  assert.equal(context.session_id, null);
  assert.equal(context.engine_type, 'mock');
  assert.equal(setup.calls[0].options.requestKey, context.request_id);
  assert.equal(setup.service.sessionRuntime.lanes.snapshot().active_leases, 0);
  assert.equal(setup.client.runtimeOperationHandlers.size, 0);
  // OFF still uses shared scoped/resource admission for explicit auxiliary calls.
  await setup.request('inline.complete');
  assert.equal(setup.calls[1].params.inference_context.engine_type, 'ollama');
});

test('busy auxiliary inference allocates no second sidecar request', async () => {
  const setup = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  setup.client.run = async ({ handler, base }) => {
    await gate;
    handler({ ...base, phase: 'settle', status: 'succeeded', cleanup: 'confirmed',
      consumption: 'unknown', charge_consumption: true });
  };
  const first = setup.request();
  await assert.rejects(setup.request(), error => error.code === 'CMP-RUNTIME-0001' && error.reason === 'lane_capacity');
  assert.equal(setup.calls.length, 1);
  release();
  await first;
});

test('refuses admission once the runtime is closing', async () => {
  const setup = fixture();
  setup.service.sessionRuntime.scheduler.beginClosing();
  await assert.rejects(setup.request(), error => error.code === 'CMP-RUNTIME-0001'
    && error.reason === 'runtime_closing');
  assert.equal(setup.service.sessionRuntime.lanes.snapshot().active_leases, 0);
  assert.equal(setup.calls.length, 0);
});

test('uncertain auxiliary producer remains charged after RPC return until exact late cleanup', async () => {
  const setup = fixture();
  let retained;
  setup.client.run = async value => { retained = value; };
  await setup.request();
  assert.equal(setup.service.sessionRuntime.lanes.snapshot().quarantined, 1);
  await assert.rejects(setup.request(), error => error.reason === 'lane_capacity');
  const { handler, base } = retained;
  assert.equal(handler({ ...base, phase: 'settle', status: 'cancelled', cleanup: 'confirmed',
    consumption: 'unknown', charge_consumption: true }).status, 'settled');
  assert.equal(setup.service.sessionRuntime.lanes.snapshot().quarantined, 0);
  setup.client.run = null;
  await setup.request();
});

test('missing negotiated protocol fails before allocating a worker or lease', async () => {
  const setup = fixture();
  beginRuntimeInferenceInitialization(setup.client);
  await assert.rejects(setup.request(), error => error.reason === 'runtime_inference_protocol_required');
  assert.equal(setup.calls.length, 0);
  assert.equal(setup.service.sessionRuntime.lanes.snapshot().active_leases, 0);
});

test('same-process initialization invalidates admission between auxiliary attempts', async () => {
  const setup = fixture();
  setup.client.run = async ({ handler, base }) => {
    handler({ ...base, phase: 'settle', status: 'failed', cleanup: 'confirmed',
      consumption: 'unknown', charge_consumption: true });
    const token = beginRuntimeInferenceInitialization(setup.client);
    for (const acknowledge of [false, true]) {
      if (acknowledge) completeRuntimeInferenceInitialization(setup.client, token, {});
      const result = handler({ ...base, operation_id: `retry_${acknowledge}`,
        phase: 'admit', engine_type: 'mock' });
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, 'inference_authority_stale');
      assert.equal(setup.service.sessionRuntime.lanes.snapshot().active_leases, 0);
    }
  };
  await assert.rejects(setup.request(), error => error.reason === 'runtime_inference_protocol_required');
  assert.equal(setup.client.runtimeOperationHandlers.size, 0);
});
