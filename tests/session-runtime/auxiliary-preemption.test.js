'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeLaneAdmission } = require('../../services/session-runtime/lanes');
const { SidecarClient } = require('../../services/backend/sidecar-client');
const { requestRuntimeInference, pendingRuntimeInferenceCount } = require('../../services/backend/backend-runtime-inference');
const { preemptAuxiliaryInference, preemptibleAuxiliaryCount } = require('../../services/backend/auxiliary-preemption');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../../services/session-runtime/inference-protocol');

// A real SidecarClient whose transport is replaced: frames are captured, and a
// held auxiliary request answers chat.cancel the way the sidecar does (settle
// the provider attempt first, then reject with -32000 auxiliary_cancelled).
function fixture({ answerCancel = true } = {}) {
  const frames = [];
  const live = new Map();
  const logs = [];
  const client = new SidecarClient();
  client.process = { stdin: {} };
  client.connected = true;
  client._writeFrame = frame => {
    frames.push(frame);
    const held = frame.method === 'chat.cancel' ? live.get(frame.params.request_id) : null;
    if (held && answerCancel) queueMicrotask(() => held.cancel());
    return true;
  };
  client.request = (method, params, options = {}) => new Promise((resolve, reject) => {
    const context = params.inference_context;
    const handler = client.runtimeOperationHandlers.get(context.request_id);
    const base = { api_version: '2026-10-15', schema_version: 1, kind: 'inference',
      request_id: context.request_id, session_id: context.session_id,
      authority_revision: context.authority_revision, operation_id: 'inference_1' };
    assert.equal(handler({ ...base, phase: 'admit', engine_type: context.engine_type }).status, 'granted');
    const settle = status => handler({ ...base, phase: 'settle', status, cleanup: 'confirmed',
      consumption: 'unknown', charge_consumption: true });
    live.set(context.request_id, {
      method,
      cancel() {
        settle('cancelled');
        const error = new Error('Auxiliary request cancelled.');
        error.rpc = { code: -32000, message: error.message, data: { reason: 'auxiliary_cancelled' } };
        reject(error);
      },
      finish() { settle('succeeded'); resolve({ suggestions: ['done'] }); },
    });
    options.signal?.addEventListener('abort', () => {
      const error = new Error(`Sidecar ${method} aborted.`);
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  completeRuntimeInferenceInitialization(client, beginRuntimeInferenceInitialization(client),
    { runtime_inference_admission_version: 1 });
  const lanes = new RuntimeLaneAdmission();
  const service = { currentEngineType: 'mock', configService: { getState: () => ({}) },
    sidecarClient: client, featureFlags: { session_runtime: false },
    sessionRuntime: { lanes, scheduler: { closing: false } },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }) };
  const request = (method = 'suggestions.generate', options = { preemptible: true }) => {
    const promise = requestRuntimeInference(service, method, { context: 'private prompt text' }, options);
    return { promise, outcome: promise.then(value => ({ value }), error => ({ error })) };
  };
  const cancels = () => frames.filter(frame => frame.method === 'chat.cancel');
  return { service, client, lanes, live, logs, request, cancels };
}

function manualTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { if (timer) timer.cleared = true; },
    fire() { for (const timer of timers) if (!timer.cleared) { timer.cleared = true; timer.fn(); } },
  };
}

function clock(start = 1000) {
  let value = start;
  return { now: () => value, advance(ms) { value += ms; } };
}

test('empty registry returns immediately without arming a timer', async () => {
  const setup = fixture();
  const timers = manualTimers();
  const result = await preemptAuxiliaryInference(setup.service, { reason: 'chat_admission', ...timers });
  assert.deepEqual(result, { preempted: 0, settled: 0, abandoned: 0, elapsed_ms: 0 });
  assert.equal(timers.timers.length, 0);
  assert.equal(setup.cancels().length, 0);
  assert.equal(setup.logs.length, 0);
  assert.equal(preemptibleAuxiliaryCount({}), 0);
});

test('a preemptible request registers while in flight and unregisters once settled', async () => {
  const setup = fixture();
  const held = setup.request();
  await new Promise(setImmediate);
  assert.equal(preemptibleAuxiliaryCount(setup.service), 1);
  setup.live.values().next().value.finish();
  assert.deepEqual((await held.outcome).value, { suggestions: ['done'] });
  assert.equal(preemptibleAuxiliaryCount(setup.service), 0);
  assert.equal(pendingRuntimeInferenceCount(setup.service), 0);
  assert.equal(setup.lanes.snapshot().active_leases, 0);
});

test('preemption cancels with the aux id, settles through the sidecar and releases the lease', async () => {
  const setup = fixture();
  const time = clock();
  const timers = manualTimers();
  const held = setup.request();
  await new Promise(setImmediate);
  const [requestId] = setup.live.keys();
  assert.match(requestId, /^aux_/);
  const result = await preemptAuxiliaryInference(setup.service, { reason: 'chat_admission', budgetMs: 2000,
    now: time.now, ...timers });
  assert.deepEqual(result, { preempted: 1, settled: 1, abandoned: 0, elapsed_ms: 0 });
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].ms, 2000);
  assert.equal(timers.timers[0].cleared, true);
  const cancel = setup.cancels();
  assert.equal(cancel.length, 1);
  assert.equal(cancel[0].params.request_id, requestId);
  assert.equal(cancel[0].params.cancel_reason, 'preempted');
  const { error } = await held.outcome;
  assert.equal(error.reason, 'auxiliary_preempted');
  assert.equal(preemptibleAuxiliaryCount(setup.service), 0);
  const lanes = setup.lanes.snapshot();
  assert.equal(lanes.active_leases, 0);
  assert.equal(lanes.quarantined, 0);
  const log = setup.logs.find(entry => entry.event === 'runtime.auxiliary_preempted');
  assert.equal(log.level, 'INFO');
  assert.deepEqual(log.details, { reason: 'chat_admission', preempted: 1, settled: 1, abandoned: 0, elapsed_ms: 0 });
  assert.equal(JSON.stringify(setup.logs).includes('private prompt text'), false);
});

test('an entry that never settles is abandoned at the budget and its capacity stays charged', async () => {
  const setup = fixture({ answerCancel: false });
  const time = clock();
  const timers = manualTimers();
  const held = setup.request();
  await new Promise(setImmediate);
  const preempting = preemptAuxiliaryInference(setup.service, { reason: 'chat_admission', budgetMs: 2000,
    now: time.now, ...timers });
  await new Promise(setImmediate);
  assert.equal(setup.cancels().length, 1);
  assert.equal(preemptibleAuxiliaryCount(setup.service), 1);
  time.advance(2000);
  timers.fire();
  const result = await preempting;
  assert.deepEqual(result, { preempted: 1, settled: 0, abandoned: 1, elapsed_ms: 2000 });
  const { error } = await held.outcome;
  assert.equal(error.reason, 'auxiliary_preempted');
  assert.equal(preemptibleAuxiliaryCount(setup.service), 0);
  // The provider attempt never confirmed cleanup: the lease is quarantined.
  const lanes = setup.lanes.snapshot();
  assert.equal(lanes.active_leases, 1);
  assert.equal(lanes.quarantined, 1);
});

test('non-preemptible requests are never touched by preemption', async () => {
  const setup = fixture();
  const timers = manualTimers();
  const held = setup.request('commit.generate_message', {});
  await new Promise(setImmediate);
  assert.equal(preemptibleAuxiliaryCount(setup.service), 0);
  const result = await preemptAuxiliaryInference(setup.service, { reason: 'chat_admission', ...timers });
  assert.deepEqual(result, { preempted: 0, settled: 0, abandoned: 0, elapsed_ms: 0 });
  assert.equal(setup.cancels().length, 0);
  assert.equal(timers.timers.length, 0);
  setup.live.values().next().value.finish();
  assert.deepEqual((await held.outcome).value, { suggestions: ['done'] });
});

test("a caller's own abort is not reported as preemption", async () => {
  const setup = fixture();
  const controller = new AbortController();
  const held = setup.request('suggestions.generate', { preemptible: true, signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  const { error } = await held.outcome;
  assert.notEqual(error.reason, 'auxiliary_preempted');
  assert.equal(preemptibleAuxiliaryCount(setup.service), 0);
});

test('a preemptible request that ends without an answer asks the sidecar to stop its producer', async () => {
  const { request, live, cancels, service } = fixture({ answerCancel: false });
  const controller = new AbortController();
  const aborted = request('suggestions.generate', { preemptible: true, signal: controller.signal });
  controller.abort();
  const { error } = await aborted.outcome;
  assert.equal(error.name, 'AbortError');
  assert.equal(cancels().length, 1, 'the orphaned producer is cancelled');
  assert.equal(cancels()[0].params.request_id, [...live.keys()][0]);
  assert.equal(cancels()[0].params.cancel_reason, 'transport_abort');
  assert.equal(preemptibleAuxiliaryCount(service), 0);

  // An answered request (the sidecar replied) needs no cancel.
  const answered = request();
  [...live.values()].at(-1).finish();
  await answered.outcome;
  assert.equal(cancels().length, 1);
});

test('a preemption that arrives after the answer stops the work still to do', async () => {
  const { service, live, lanes } = fixture();
  let applied = false;
  const promise = requestRuntimeInference(service, 'suggestions.generate', { context: 'x' }, {
    preemptible: true,
    async consumeResult(result, control) {
      // Admission preempts while the caller is still between answer and write.
      const preempting = preemptAuxiliaryInference(service, { reason: 'chat_admission' });
      await Promise.resolve();
      control.assertNotPreempted();
      applied = true;
      await preempting;
      return result;
    },
  });
  [...live.values()].at(-1).finish();
  const outcome = await promise.then(value => ({ value }), error => ({ error }));
  assert.equal(outcome.error?.reason, 'auxiliary_preempted');
  assert.equal(applied, false);
  assert.equal(preemptibleAuxiliaryCount(service), 0);
  assert.equal(lanes.snapshot().active_leases, 0);
});
