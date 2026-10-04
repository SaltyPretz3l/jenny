'use strict';

// An uncertain canonical claim quarantines its turn lease with no active entry,
// and a retired attempt or auxiliary request can leave an inference lease
// quarantined, so the B3D-1 backend-restart reclaim (which walked only
// `active`) never confirmed them. The local lane runs one turn and one
// inference request at a time, so every later send on it waited forever,
// Restart engine included.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuntimeStore, createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { InferenceOperations } = require('../../services/session-runtime/inference-operations');

const local = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
  configuration_revision: 'config-1', resource_class: 'local', requires_gpu: true });
const cloud = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
  configuration_revision: 'config-1', resource_class: 'cloud', requires_gpu: false });

function harness(t, { uncertainClaims = 1 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-orphan-lease-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = new RuntimeStore(root, { io: { ...createRuntimeStoreIO() },
    createId: prefix => `${prefix}-${++sequence}` });
  const lanes = new RuntimeLaneAdmission();
  const producers = [];
  const attention = [];
  const scheduler = new SessionRuntimeScheduler({ store, lanes,
    createId: () => `runtime-${++sequence}`,
    resolveRoute: () => local,
    validateWork: () => {},
    claimCanonical: () => {
      if (uncertainClaims > 0) {
        uncertainClaims -= 1;
        throw Object.assign(new Error('claim outcome unknown'), { code: 'invalid_active_turn' });
      }
      return { streamId: `stream-${++sequence}`, authorityRevision: 'authority-1',
        rollbackBeforeStart: () => true, assertCurrent: () => {} };
    },
    // Each attempt owns a real inference gateway under its stream id, as the chat adapter's does.
    startProducer: context => new Promise((resolve, reject) => producers.push({ work: context.work, resolve, reject,
      gateway: new InferenceOperations({ lanes, route: local, requestId: context.attempt.stream_id,
        sessionId: context.work.session_id, authorityRevision: 'authority-1', assertCurrent: () => {} }) })),
    onAttention: event => attention.push(event) });
  const submit = sessionId => store.submit({ idempotencyKey: `submit-${++sequence}`, sessionId,
    projectId: 'project_general', purpose: 'chat', input: { prompt: 'hello' },
    authority: { project_id: 'project_general', root_path: null, root_id: null,
      root_revision: 0, device_id: null, inode: null } }).record;
  return { store, lanes, scheduler, submit, producers, attention };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
const settled = { status: 'completed', producerSettled: true, canonicalSettled: true };
function operation(gateway, id, phase, fields) {
  return gateway.handle({ api_version: '2026-08-17', schema_version: 1, kind: 'inference', operation_id: id,
    phase, request_id: gateway.requestId, session_id: gateway.sessionId,
    authority_revision: gateway.authorityRevision, ...fields });
}
const admit = (gateway, id) => operation(gateway, id, 'admit', { engine_type: 'ollama' }).status;
const settleUncertain = (gateway, id) => operation(gateway, id, 'settle', { status: 'failed',
  cleanup: 'uncertain', consumption: 'unknown', charge_consumption: true }).status;

test('backend-restart reclaim confirms a turn lease quarantined by an uncertain claim and the waiting send starts', async t => {
  const h = harness(t);
  const stuck = h.submit('a');
  assert.deepEqual(h.scheduler.tryDispatch(stuck.work_id), { status: 'rejected', reason: 'canonical_claim_failed' });
  assert.equal(h.store.get(stuck.work_id).transition.reason, 'canonical_claim_uncertain');
  assert.equal(h.scheduler.active.size, 0);
  assert.equal(h.lanes.snapshot().quarantined, 1);

  const waiting = h.submit('b');
  assert.equal(h.scheduler.tryDispatch(waiting.work_id).status, 'waiting');
  assert.equal(h.store.get(waiting.work_id).status, 'pending');

  const report = h.scheduler.reclaimAbandoned({ reason: 'backend_restart' });
  assert.deepEqual(report, { reclaimed: [], retained: [], leases_confirmed: 1 });
  assert.equal(h.lanes.snapshot().quarantined, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);

  // The lane pump runs on a microtask; the pending send dispatches by itself.
  await flush();
  assert.equal(h.store.get(waiting.work_id).status, 'running');
  assert.deepEqual(h.producers.map(producer => producer.work.work_id), [waiting.work_id]);
  // A second restart finds nothing left to confirm: no double release.
  assert.deepEqual(h.scheduler.reclaimAbandoned({ reason: 'backend_restart' }),
    { reclaimed: [], retained: [{ work_id: waiting.work_id, reason: 'runtime_producer_pending' }],
      leases_confirmed: 0 });
  assert.equal(h.lanes.snapshot().active_leases, 1);

  // The uncertain work stays paused for the user; an explicit resume runs it.
  h.producers[0].resolve(settled);
  await h.scheduler.active.get(waiting.work_id).completion;
  assert.equal(h.store.get(stuck.work_id).status, 'paused');
  assert.deepEqual(h.scheduler.resume(stuck.work_id, h.store.get(stuck.work_id).revision), { status: 'accepted' });
  await flush();
  assert.equal(h.store.get(stuck.work_id).status, 'running');
  h.producers[1].resolve(settled);
});

test('backend-restart reclaim confirms a retired attempt inference lease and the next send gets the slot', async t => {
  const h = harness(t, { uncertainClaims: 0 });
  const abandoned = h.submit('a');
  const started = h.scheduler.tryDispatch(abandoned.work_id);
  await flush();
  const old = h.producers[0].gateway;
  assert.equal(admit(old, 'op-1'), 'granted');
  assert.equal(settleUncertain(old, 'op-1'), 'settled');
  old.close();
  h.producers[0].reject(new Error('sidecar exited'));
  assert.equal((await started.completion).status, 'needs_attention');
  assert.equal(h.lanes.snapshot().quarantined, 2);
  const next = h.submit('b');
  assert.equal(h.scheduler.tryDispatch(next.work_id).status, 'waiting');

  // The loop retires the entry and confirms its turn lease; the sweep confirms its inference lease.
  assert.deepEqual(h.scheduler.reclaimAbandoned({ reason: 'backend_restart' }), {
    reclaimed: [{ work_id: abandoned.work_id, session_id: 'a', status: 'failed' }], retained: [],
    leases_confirmed: 1 });
  assert.equal(h.lanes.snapshot().quarantined, 0);
  assert.equal(h.lanes.snapshot().active_leases, 0);
  assert.deepEqual(h.scheduler.reopenAfterShutdown(), { ok: true });

  await flush();
  assert.equal(h.store.get(next.work_id).status, 'running');
  const current = h.producers[1].gateway;
  assert.equal(admit(current, 'op-2'), 'granted', 'the local inference slot is free again');
  // The retired gateway settling late cannot release capacity it no longer owns.
  old.close({ producerSettled: true });
  assert.equal(h.lanes.snapshot().active_leases, 2);
  current.close({ producerSettled: true });
  h.producers[1].resolve(settled);
});

test('backend-restart reclaim keeps a retained attempt inference leases and confirms an auxiliary one', async t => {
  const h = harness(t, { uncertainClaims: 0 });
  const running = h.submit('a');
  const started = h.scheduler.tryDispatch(running.work_id);
  await flush();
  const gateway = h.producers[0].gateway;
  assert.equal(admit(gateway, 'op-1'), 'granted');
  assert.equal(settleUncertain(gateway, 'op-1'), 'settled');
  // An initial reservation is owned by the work id; an auxiliary request by its own id.
  const reservation = h.lanes.tryAcquireInference({ ownerId: running.work_id, route: cloud }).lease;
  const auxiliary = h.lanes.tryAcquireInference({ ownerId: 'aux_compaction', route: cloud }).lease;
  for (const lease of [reservation, auxiliary]) h.lanes.release(lease, { producerSettled: false });
  assert.equal(h.lanes.snapshot().quarantined, 3);

  assert.deepEqual(h.scheduler.reclaimAbandoned({ reason: 'backend_restart' }), { reclaimed: [],
    retained: [{ work_id: running.work_id, reason: 'runtime_producer_pending' }], leases_confirmed: 1 });
  assert.equal(h.lanes.snapshot().quarantined, 2);
  assert.equal(h.lanes.release(auxiliary, { producerSettled: true }), false);

  // The retained producer still settles its own leases through the normal path.
  assert.equal(gateway.close({ producerSettled: true }).settled, 1);
  assert.equal(h.lanes.confirmCleanup(reservation), true);
  h.producers[0].resolve(settled);
  assert.equal((await started.completion).status, 'completed');
  assert.equal(h.lanes.snapshot().active_leases, 0);
});

test('orphaned-lease confirmation leaves held, active and owned inference leases alone', () => {
  const lanes = new RuntimeLaneAdmission({ limits: { local: { runnable_turns: 4, inference_requests: 4 } } });
  const orphan = lanes.tryAcquireTurn({ sessionId: 'a', route: local }).lease;
  const held = lanes.tryAcquireTurn({ sessionId: 'b', route: local }).lease;
  const running = lanes.tryAcquireTurn({ sessionId: 'c', route: local }).lease;
  const owned = lanes.tryAcquireInference({ ownerId: 'stream-held', route: local }).lease;
  const auxiliary = lanes.tryAcquireInference({ ownerId: 'aux_compaction', route: local }).lease;
  const live = lanes.tryAcquireInference({ ownerId: 'aux_live', route: local }).lease;
  for (const lease of [orphan, held, owned, auxiliary]) lanes.release(lease, { producerSettled: false });
  assert.equal(lanes.snapshot().quarantined, 4);

  assert.equal(lanes.confirmOrphaned({ heldLeases: new Set([held]), heldOwners: new Set(['stream-held']) }), 2);
  assert.equal(lanes.snapshot().active_leases, 4);
  assert.equal(lanes.snapshot().quarantined, 2);
  // The owner that quarantined an orphan releasing it late is a no-op.
  assert.equal(lanes.release(orphan, { producerSettled: true }), false);
  assert.equal(lanes.release(auxiliary, { producerSettled: true }), false);
  for (const lease of [held, owned]) assert.equal(lanes.confirmCleanup(lease), true);
  for (const lease of [running, live]) assert.equal(lanes.release(lease, { producerSettled: true }), true);
});
