'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStartupSafeRuntimeCoordinator } = require('../services/main/plugins-startup-runtime');
const { createRuntimeApplyCoordinator } = require('../services/plugins/runtime/runtime-apply-coordinator');

for (const method of ['prepare', 'reconcile']) {
  test(`${method} waits for startup without entering the apply coordinator`, async () => {
    const service = { _managedReadyOnce: false, sidecarClient: { connected: true, initialize() {} } };
    let calls = 0;
    const coordinator = createStartupSafeRuntimeCoordinator(service, {
      [method]: async (...args) => { calls += 1; return args; },
      getState: () => ({ runtime_status: 'inactive' }),
    });
    const flight = coordinator[method]('request', 'reason');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 0);
    assert.deepEqual(coordinator.getState(), { runtime_status: 'inactive' });
    service._managedReadyOnce = true;
    // The readiness poll is unref'ed in production; keep this test alive.
    const [result] = await Promise.all([flight, new Promise(resolve => setTimeout(resolve, 60))]);
    assert.deepEqual(result, ['request', 'reason']);
    assert.equal(calls, 1);
  });

  test(`${method} cannot apply after disposal while startup is pending`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const service = { _managedReadyOnce: false };
    const coordinator = createStartupSafeRuntimeCoordinator(service, {
      [method]: () => { calls += 1; },
    }, { signal: controller.signal });
    const flight = coordinator[method]({});
    controller.abort();
    assert.equal((await flight).ok, false);
    service._managedReadyOnce = true;
    assert.equal((await coordinator[method]({})).ok, false);
    assert.equal(calls, 0);
  });
}

test('startup readiness leaves the actual reconciliation timeout and late-result rejection intact', async () => {
  let completeApply;
  const actualApply = new Promise(resolve => { completeApply = resolve; });
  const core = createRuntimeApplyCoordinator({
    runtimeAdapter: { apply: () => actualApply, reconcile: () => actualApply }, timeoutMs: 10,
  });
  const guarded = createStartupSafeRuntimeCoordinator({ _managedReadyOnce: true }, core);
  const result = await guarded.reconcile({ envelope: {}, snapshot: {} }, 'restart_rehydration');
  assert.deepEqual(result, { ok: false, reason: 'runtime_reconciliation_timeout' });
  completeApply({ ok: true, attestation: {} });
  assert.equal(result.ok, false);
});

test('stopping backend rejects new apply without entering the coordinator', async () => {
  const guarded = createStartupSafeRuntimeCoordinator({ _stopping: true }, {
    prepare() { throw new Error('must not apply'); },
  });
  assert.equal((await guarded.prepare({})).ok, false);
});
