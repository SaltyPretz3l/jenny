'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { filesystemResource, capacityResource } = require('../services/session-runtime/resource-broker');
const { sandboxError } = require('../services/execution/sandbox-errors');
const { projectToolResourceWait } = require('../services/tools/tool-resource-execution');
const { createElectronStartGate } = require('../services/backend/runtime-electron-start-gate');
const { readyService, runtimeResources, fakeLauncher, attachFakeWorker } = require('./helpers/desktop-sandbox-lifecycle-fixture');

for (const stage of ['snapshot', 'worker', 'command', 'cleanup_failure']) {
  test(`managed sandbox ${stage} wait requires cleanup and never submits a command`, async t => {
    const cleanupFailure = stage === 'cleanup_failure';
    const setup = await readyService(t, cleanupFailure
      ? { launcher: fakeLauncher({ cleanupError: sandboxError('sandbox_cleanup_unconfirmed') }) } : {});
    const resources = runtimeResources(setup); resources.gateway.enableContinuation();
    let copies = 0; let executions = 0; let held;
    const snapshot = setup.service.snapshot;
    setup.service.snapshot = async options => { copies++; return snapshot(options); };
    const workers = attachFakeWorker(setup.service);
    const hold = resource => {
      held = resources.broker.tryAcquire({ ownerId: 'fixture-held', resources: [resource] });
      assert.equal(held.status, 'granted');
    };
    if (stage === 'snapshot') hold(filesystemResource(resources.pathResolver.resolve(setup.workspace)));
    if (stage === 'worker') hold(capacityResource('native_processes'));
    await assert.rejects(setup.service.execute({ command: 'true' }, {
      sessionId: 'session', streamId: 'stream', callId: 'call', projectAuthority: setup.authority,
      resourceClaim: resources.resourceClaim, beforeProducer: async () => { executions++; },
    }, async () => {
      hold(capacityResource('tool_operations', resources.broker.snapshot().limits.tool_operations));
      return { approved: true, digest: 'approved', validate() {} };
    }), error => {
      const wait = projectToolResourceWait(error);
      if (cleanupFailure) { assert.equal(wait, null); assert.equal(error.reason, 'sandbox_cleanup_unconfirmed'); }
      else assert.equal(wait?.resource_class, stage === 'snapshot' ? 'filesystem'
        : stage === 'worker' ? 'native_processes' : 'tool_operations');
      return true;
    });
    assert.equal(executions, 0); assert.equal(copies, stage === 'snapshot' ? 0 : 1);
    assert.equal(workers.length, ['command', 'cleanup_failure'].includes(stage) ? 1 : 0);
    assert.equal(workers.reduce((sum, worker) => sum + (worker.commandCount || 0), 0), 0);
    assert.equal(setup.service.receipts.pending().length, 0);
    assert.equal(setup.service.state, cleanupFailure ? 'recovery-required' : 'ready');
    assert.equal(resources.broker.snapshot().waiter_count, 0);
    if (!cleanupFailure) {
      assert.equal(resources.broker.snapshot().lease_count, 1);
      assert.equal(setup.service.pendingRuntimeCleanup, null);
      assert.deepEqual(await fs.readdir(setup.service.stagingRoot).catch(() => []), []);
    }
    let resumptions = 0;
    if (!cleanupFailure) {
      const attempt = { attempt_id: 'attempt', stream_id: 'stream', incarnation: 'current', authority_revision: 'scope' };
      const work = { work_id: 'waiting', session_id: 'session', revision: 4, submission_sequence: 1,
        status: 'paused', control_request: null, attempt, transition: { reason: 'checkpoint_suspended' },
        checkpoint_ref: { checkpoint_id: 'checkpoint', source_attempt: { ...attempt } } };
      const eligibility = new (require('../services/session-runtime/eligibility').RuntimeEligibilityCoordinator)({
        broker: resources.broker, incarnation: 'current', enabled: true, getWork: () => work,
        resume: () => { resumptions++; return { status: 'accepted' }; },
      });
      t.after(() => eligibility.dispose());
      const waitingResources = resources.gateway.getWaitResources('call');
      assert.ok(waitingResources?.length);
      assert.equal(eligibility.track('waiting', waitingResources).status, 'tracked');
      await new Promise(resolve => setImmediate(resolve)); assert.equal(resumptions, 0);
    }
    resources.broker.release(held.lease, { producerSettled: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resumptions, cleanupFailure ? 0 : 1);
    resources.gateway.close({ producerSettled: !cleanupFailure });
  });
}

test('sandbox acknowledgement precedes command submission and cancellation cleans a never-started grant', async t => {
  for (const cancel of [false, true]) {
    const setup = await readyService(t); const resources = runtimeResources(setup);
    resources.gateway.enableContinuation();
    const workers = attachFakeWorker(setup.service, { result: { status: 'completed', success: true,
      stdout: 'ok', stderr: '', cleanup_confirmed: true } });
    const controller = new AbortController();
    const gate = createElectronStartGate({
      enabled: () => true, signal: controller.signal,
      execute: (_params, beforeProducer) => setup.service.execute({ command: 'true' }, {
        sessionId: 'session', streamId: 'stream', callId: 'call', projectAuthority: setup.authority,
        resourceClaim: resources.resourceClaim, beforeProducer, signal: controller.signal,
      }, async () => ({ approved: true, digest: 'approved', validate() {} })),
    });
    const ready = (await gate({ tool_call_id: 'call', runtime_resource_gate: { schema_version: 1, phase: 'prepare' } })).runtime_resource_ready;
    assert.equal(workers[0].commandCount || 0, 0);
    assert.equal(resources.gateway.snapshot().active, 2); // command plus prepared worker
    if (cancel) {
      controller.abort();
      await setup.service.drainStream('stream');
    } else {
      assert.equal((await gate({ tool_call_id: 'call', runtime_resource_gate: {
        schema_version: 1, phase: 'start', token: ready.token,
      } })).success, true);
    }
    assert.equal(workers[0].commandCount || 0, cancel ? 0 : 1);
    assert.equal(resources.broker.snapshot().lease_count, 0);
    assert.equal(setup.service.pendingRuntimeCleanup, null);
    assert.equal(setup.service.state, 'ready');
    resources.gateway.close({ producerSettled: true });
  }
});

function isolatedGateInput(operationId, phase, token) {
  return { tool_call_id: operationId, runtime_resource_gate: {
    schema_version: 1, phase, ...(token ? { token } : {}),
  } };
}

function isolatedStartGate() {
  return createElectronStartGate({
    enabled: () => true,
    execute: async (params, beforeProducer) => {
      await beforeProducer();
      return { ok: true, operation_id: params.tool_call_id };
    },
  });
}

test('settled start-gate entries are pruned across 300 sequential calls', async () => {
  const gate = isolatedStartGate();
  for (let index = 0; index < 300; index += 1) {
    const operationId = `operation:${index}`;
    const ready = (await gate(isolatedGateInput(operationId, 'prepare'))).runtime_resource_ready;
    assert.deepEqual(await gate(isolatedGateInput(operationId, 'start', ready.token)),
      { ok: true, operation_id: operationId });
  }
});

test('settled start-gate keys remain protected from replay', async () => {
  const gate = isolatedStartGate();
  const ready = (await gate(isolatedGateInput('operation:replay', 'prepare'))).runtime_resource_ready;
  await gate(isolatedGateInput('operation:replay', 'start', ready.token));
  await assert.rejects(gate(isolatedGateInput('operation:replay', 'prepare')),
    /runtime_electron_start_invalid/u);
});

test('in-flight start-gate keys reject duplicate prepare calls', async () => {
  const gate = isolatedStartGate();
  const ready = (await gate(isolatedGateInput('operation:active', 'prepare'))).runtime_resource_ready;
  await assert.rejects(gate(isolatedGateInput('operation:active', 'prepare')),
    /runtime_electron_start_invalid/u);
  await gate(isolatedGateInput('operation:active', 'start', ready.token));
});
