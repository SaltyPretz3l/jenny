'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getTrustedExecutionBinding } = require('../../services/backend/session-execution-authority');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeStore } = require('../../services/session-runtime/store');
const {
  getManagedRuntimeController,
  retainManagedRuntimeController,
} = require('../../services/backend/chat-lifecycle-contracts');
const {
  AUTHORITY,
  createAdapterHarness,
  request,
  waitFor,
} = require('../helpers/session-runtime-chat-adapter-harness');

test('adapter accepts paused cleanup only from the exact idle deletion owner', t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const actors = ensureSessionTurnActorRegistry(service);
  const attempt = { attempt_id: 'attempt-delete', stream_id: 'stream-delete',
    incarnation: 'host-delete', authority_revision: 'authority-delete' };
  const work = { work_id: 'work-delete', session_id: sessionId, status: 'paused', attempt,
    checkpoint_ref: { source_attempt: attempt } };
  adapter.checkpointStore = { validate: () => true, read: () => ({}) };
  const deletionHandle = actors.beginDeletion(sessionId);

  assert.equal(adapter.provePausedCleanup(work, { deletionHandle }), true);
  assert.equal(adapter.provePausedCleanup(work, { deletionHandle: { ...deletionHandle } }), false);
  assert.equal(adapter.provePausedCleanup(work), false,
    'ordinary lifecycle proof remains fenced while deletion owns the actor');
  assert.equal(actors.rollbackDeletion(deletionHandle), true);
});

test('adapter binds the captured route and inference gateway through terminal producer proof', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, {
    workId: 'work-2', turnId: 'logical-turn-2',
  });
  adapter.register('work-2', prepared);
  const work = {
    work_id: 'work-2', turn_id: 'logical-turn-2', session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input,
  };
  const claim = adapter.claimCanonical(work, prepared.route);
  service._startManagedSidecarChatStream = async options => {
    assert.equal(options.runtimeRoute, prepared.route);
    assert.equal(options.runtimeExecutionAuthority, prepared.binding);
    assert.equal(typeof options.runtimeOperationGateway.handle, 'function');
    const baseOperation = {
      api_version: '2026-08-17', schema_version: 1, kind: 'inference',
      operation_id: 'inference-1', request_id: claim.streamId, session_id: sessionId,
      authority_revision: getTrustedExecutionBinding(prepared.binding).authorityRevision,
    };
    assert.equal(options.runtimeOperationGateway.handle({
      ...baseOperation, phase: 'admit', engine_type: 'mock',
    }).status, 'granted');
    assert.equal(options.runtimeOperationGateway.handle({
      ...baseOperation, phase: 'settle', status: 'succeeded', cleanup: 'confirmed',
      consumption: 'unknown', charge_consumption: true,
    }).status, 'settled');
    const controller = new AbortController();
    service.sessionTurnActors.attachController(options.turnLease, controller);
    controller._runtimeCompletion = Promise.resolve({
      status: 'completed', producerSettled: true, canonicalSettled: true,
    });
    const started = retainManagedRuntimeController({ sessionId, streamId: claim.streamId }, controller);
    service.sessionTurnActors.release(options.turnLease, { status: 'completed' });
    return started;
  };

  const outcome = await adapter.startProducer({
    work, route: prepared.route, assertCurrent: claim.assertCurrent,
  });
  assert.deepEqual(outcome, {
    status: 'completed', producerSettled: true, canonicalSettled: true,
  });
});

test('startup cancellation retains exact completion after stream-map removal and accepts late cleanup', async t => {
  const { adapter, lanes, service, sessionId } = createAdapterHarness(t);
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-chat-late-settlement-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const store = new RuntimeStore(runtimeRoot);
  let managedOptions;
  let finishManaged;
  let unregisterCalls = 0;
  let runtime;
  let cancellation;
  let operation;
  let controller;
  service._startManagedSidecarChatStream = async (options) => {
    managedOptions = options;
    controller = new AbortController();
    service.sessionTurnActors.attachController(options.turnLease, controller);
    controller._runtimeSettlementUnregister = () => { unregisterCalls += 1; };
    controller._runtimeCompletion = new Promise(resolve => { finishManaged = resolve; });
    const streamId = options.turnLease.identity.streamId;
    const binding = getTrustedExecutionBinding(options.runtimeExecutionAuthority);
    operation = {
      api_version: '2026-08-17', schema_version: 1, kind: 'inference',
      operation_id: 'late-inference-1', request_id: streamId, session_id: sessionId,
      authority_revision: binding.authorityRevision,
    };
    assert.equal(options.runtimeOperationGateway.handle({
      ...operation, phase: 'admit', engine_type: 'mock',
    }).status, 'granted');
    const started = retainManagedRuntimeController({ sessionId, streamId }, controller);
    queueMicrotask(() => {
      cancellation = runtime.noteStreamCancellation(streamId, 'startup cancellation');
      service.activeStreams.delete(streamId);
      controller.abort();
    });
    return started;
  };
  const scheduler = new SessionRuntimeScheduler({
    store, lanes,
    resolveRoute: work => adapter.resolveRoute(work),
    validateWork: (work, route) => adapter.validateWork(work, route),
    claimCanonical: (work, route) => adapter.claimCanonical(work, route),
    startProducer: context => adapter.startProducer(context),
    cancelProducer: (work, reason, options) => adapter.cancelProducer(work, reason, options),
  });
  runtime = new SessionRuntimeService({ store, scheduler, chatAdapter: adapter });
  await runtime.startImmediate(request(sessionId));

  const workId = store.listSummaries({ sessionId, limit: 10 }).items[0].work_id;
  const streamId = managedOptions.turnLease.identity.streamId;
  assert.equal(cancellation.status, 'requested');
  assert.equal(controller.signal.aborted, true);
  assert.equal(service.activeStreams.has(streamId), false);
  assert.equal(getManagedRuntimeController({ sessionId, streamId }), null,
    'serialized lookalikes cannot recover a retained controller');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(workId).status, 'running');
  const release = service.sessionTurnActors.release(managedOptions.turnLease, { status: 'cancelled' });
  assert.equal(release.released, true);
  finishManaged({ status: 'cancelled', producerSettled: false, canonicalSettled: true });
  await waitFor(() => store.get(workId).status === 'needs_attention',
    'cancelled runtime work did not enter needs_attention');
  assert.equal(lanes.snapshot().quarantined, 2);
  assert.equal(unregisterCalls, 0);

  const stale = managedOptions.runtimeOperationGateway.handle({
    ...operation, authority_revision: 'authority-stale', phase: 'settle',
    status: 'cancelled', cleanup: 'confirmed', consumption: 'unknown', charge_consumption: true,
  });
  assert.equal(stale.status, 'rejected');
  assert.equal(store.get(workId).status, 'needs_attention');
  assert.equal(unregisterCalls, 0);

  const settled = managedOptions.runtimeOperationGateway.handle({
    ...operation, phase: 'settle', status: 'cancelled', cleanup: 'confirmed',
    consumption: 'unknown', charge_consumption: true,
  });
  assert.equal(settled.status, 'settled');
  managedOptions.runtimeOnInferenceSettlement();
  await waitFor(() => store.get(workId).status === 'cancelled',
    'late cleanup did not settle durable runtime work');
  assert.equal(lanes.snapshot().active_leases, 0);
  assert.equal(unregisterCalls, 1);

  assert.equal(managedOptions.runtimeOperationGateway.handle({
    ...operation, phase: 'settle', status: 'cancelled', cleanup: 'confirmed',
    consumption: 'unknown', charge_consumption: true,
  }).status, 'settled');
  managedOptions.runtimeOnInferenceSettlement();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get(workId).status, 'cancelled');
  assert.equal(unregisterCalls, 1);
});
