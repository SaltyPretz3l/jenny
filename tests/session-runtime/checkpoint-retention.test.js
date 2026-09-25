'use strict';
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { collectDataInventory } = require('../../services/data-lifecycle/data-inventory');
const { createArchive } = require('../../services/data-lifecycle/archive-service');
const { stageRestore, promotePendingRestore } = require('../../services/data-lifecycle/restore-service');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { createOfflineRuntimeArchivePort } = require('../../services/data-lifecycle/runtime-coordination-archive');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fixture } = require('../helpers/session-runtime-children-fixture');
const { dependencyFixture } = require('../helpers/session-runtime-dependency-fixture');
const { waitFor } = require('../helpers/session-runtime-chat-adapter-harness');
const { RETENTION_MS } = require('../../services/session-runtime/terminal-retention-contract');
const { readRuntimeChildResult } = require('../../services/session-runtime/child-capabilities');
const { stableJson, validateWorkRecord } = require('../../services/session-runtime/contracts');
const { CheckpointStore, readPortableCheckpointSnapshot } = require('../../services/session-runtime/checkpoint-store');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { recoverCheckpointRetirements } = require('../../services/backend/runtime-checkpoint-retention');
const { collectRuntimeLedgerPayload } = require('../../services/data-lifecycle/runtime-ledger-archive');
const { validateRuntimeCoordinationCrosslinks } = require('../../services/data-lifecycle/runtime-coordination-archive');
const { rootDefinition } = require('../../services/session-runtime/root-run-start');
const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');

async function terminalFixture(t, { repeated = false } = {}) {
  const h = await fixture(t);
  h.runtime.conversationStore = { ...h.runtime.conversationStore };
  const child = await h.spawn();
  const f = dependencyFixture(h, child);
  const pause = async (boundary, index) => {
    const reply = await boundary.boundary.handleOperation(boundary.params);
    assert.equal(reply.status, 'checkpointed', JSON.stringify(reply));
    h.starts[index].settle(boundary.boundary.settlePause({ status: 'paused', request_id: boundary.params.request_id,
      checkpoint_ref: reply.checkpoint_ref }, boundary.releaseArgs));
    return reply.checkpoint_ref;
  };
  const refs = [await pause(f, 0)];
  await waitFor(() => h.starts.length === 2, 'child starts');
  function answer(workId) {
    const work = h.runtime.store.get(workId);
    h.service.sessionStore.appendMessage(work.session_id, { id: `answer_${work.work_id}`, role: 'assistant',
      kind: 'message', content: 'Preserved canonical result', turn_id: work.turn_id });
    h.service.sessionStore.flushSession(work.session_id);
  }
  answer(child.child_work_id);
  h.starts[1].complete();
  await waitFor(() => h.starts.length === 3, () => JSON.stringify(h.logs));
  if (repeated) {
    const work = h.runtime.store.get(h.started.work_id);
    const args = { child_work_id: child.child_work_id };
    const result = readRuntimeChildResult({ runtime: h.runtime, work }, args);
    const events = ['tool_executing', 'tool_result'].map((kind, index) => ({
      event_id: `${work.attempt.stream_id}:canonical:${index + 1}`, turn_id: work.turn_id, kind,
      tool_call_id: 'wait_1', payload: { canonical_seq: index + 1, tool_name: 'session_wait', tool_input: args,
        canonical_event_type: index ? 'tool_execution_completed' : 'tool_execution_started',
        ...(index ? { success: true, tool_output_summary: JSON.stringify(result) } : {}) } }));
    const prior = { prior_checkpoint_ref: refs[0], prior_effect_count: 1,
      completed_spawn_refs: f.params.completed_spawn_refs,
      completed_wait_refs: [{ call_id: 'wait_1', child_work_id: child.child_work_id, result_sha256: hash(result) }] };
    refs.push(await pause(dependencyFixture(h, child, { entryIndex: 2, prior, currentEvents: events, waitId: 'wait_2' }), 2));
    await waitFor(() => h.starts.length === 4, () => JSON.stringify(h.logs));
  }
  answer(h.started.work_id);
  h.starts.at(-1).complete();
  await waitFor(() => !h.runtime.hasPendingOrAdmittedWork(), 'all terminal');
  const work = h.runtime.store.get(h.started.work_id);
  const future = Date.parse(work.transition.at) + RETENTION_MS;
  h.runtime.store.now = () => new Date(future);
  return { ...h, child, refs, work, future };
}
function assertRetained(h) {
  const root = h.runtime.store.get(h.started.work_id);
  const child = h.runtime.store.get(h.child.child_work_id);
  assert.equal(root.input.kind, 'terminal_tombstone', JSON.stringify(h.logs.at(-1)));
  assert.equal(root.input.schema_version, 2);
  assert.equal(child.input.kind, 'terminal_tombstone');
  assert.equal(root.submission_hash, h.work.submission_hash);
  assert.equal(validateWorkRecord(root).ok, true);
  assert.throws(() => rootDefinition(root), /definition_invalid/);
  assert.equal(h.runtime.checkpointStore.canDiscardWorkContext(root.work_id), true);
  assert.equal(h.runtime.checkpointStore.findCommittedForWork(root).status, 'none');
  for (const ref of h.refs) assert.equal(h.runtime.checkpointStore.validate(root, ref), false);
  const session = h.service.sessionStore.getSession(root.session_id);
  assert.equal(session.runtime_continuations.entries.length, 0);
  assert.equal(session.messages.at(-1).content, 'Preserved canonical result');
}

test('30-day retirement removes inherited material newest-first and preserves Start/lineage/budgets/archive identity', async t => {
  const h = await terminalFixture(t, { repeated: true });
  const budget = h.runtime.budgetStore.exportPortableSnapshot();
  const lineage = h.runtime.lineageStore.exportPortableSnapshot();
  const beforeBytes = h.runtime.checkpointStore.snapshot().body_bytes;
  const beforeEvents = structuredClone(h.service.sessionStore.getSession(h.work.session_id).turn_events);
  const order = [];
  const remove = h.runtime.conversationStore.removePendingContinuation;
  h.runtime.conversationStore.removePendingContinuation = (...args) => { order.push(args[1]); return remove(...args); };
  h.runtime.store.now = () => new Date(h.future - 1);
  h.runtime.maintainTerminalDetail();
  assert.equal(order.length, 0);
  h.runtime.store.now = () => new Date(h.future);
  h.runtime.maintainTerminalDetail();
  assertRetained(h);
  assert.deepEqual(order, h.refs.map(ref => ref.checkpoint_id).reverse());
  assert.ok(h.runtime.checkpointStore.snapshot().body_bytes < beforeBytes);
  assert.deepEqual(h.service.sessionStore.getSession(h.work.session_id).turn_events, beforeEvents);
  assert.deepEqual(h.runtime.budgetStore.exportPortableSnapshot(), budget);
  assert.deepEqual(h.runtime.lineageStore.exportPortableSnapshot(), lineage);
  const duplicate = await h.app.start({ session_id: h.sessionId, prompt: 'Inspect', idempotency_key: 'root_1',
    purpose: 'Inspect project', limits: { inference_requests: 3, input_tokens: 96, output_tokens: 96 } });
  assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.root_run_id, h.started.root_run_id);
  assert.equal(h.starts.length, 4);
  const payload = { ...h.runtime.capturePortableState(), schema_version: 2 };
  const context = { runtimeLedger: collectRuntimeLedgerPayload(h.service.options.userDataPath),
    sessions: new Map(h.service.sessionStore.listSessions().map(row => [row.id, h.service.sessionStore.getSession(row.id)])) };
  assert.deepEqual(validateRuntimeCoordinationCrosslinks(payload, context), payload);
  const offline = readPortableCheckpointSnapshot(h.runtime.checkpointStore.root);
  assert.deepEqual([...offline.records].sort((a, b) => a.checkpoint_id.localeCompare(b.checkpoint_id)),
    [...payload.checkpoints.records].sort((a, b) => a.checkpoint_id.localeCompare(b.checkpoint_id)));
  const tampered = structuredClone(payload);
  tampered.checkpoints.records[0].document.retirement.submission_hash = 'f'.repeat(64);
  assert.throws(() => validateRuntimeCoordinationCrosslinks(tampered, context), /invalid/);
  const profile = h.service.options.userDataPath;
  const inventory = collectDataInventory({ userDataPath: profile, sessionStore: h.service.sessionStore,
    runtimeArchivePort: h.runtime });
  const archive = await createArchive({ destinationRoot: path.join(profile, 'archives'),
    archiveName: 'Retired.jenny-archive', encrypted: false, entries: inventory.entries });
  const destination = path.join(profile, 'restored');
  fs.mkdirSync(destination);
  await stageRestore({ archivePath: archive.archivePath, userDataPath: destination });
  assert.equal((await promotePendingRestore({ userDataPath: destination })).status, 'promoted');
  const restoredSessions = new ElectronSessionStore(path.join(destination, 'sessions.json'));
  t.after(() => restoredSessions.dispose());
  const restoredStore = new RuntimeStore(path.join(destination, 'session-runtime'));
  assert.deepEqual(restoredStore.get(h.work.work_id), h.runtime.store.get(h.work.work_id));
  const restored = createOfflineRuntimeArchivePort({ userDataPath: destination, sessionStore: restoredSessions }).capturePortableState();
  assert.deepEqual(restored.root_run_budgets, budget);
  assert.equal(restored.lineage.records[0].document.restored, true);
  assert.ok(restored.checkpoints.records.every(row => row.document.state === 'retired'));
  assert.equal(restoredSessions.getSession(h.work.session_id).messages.at(-1).content, 'Preserved canonical result');
  const secondArchive = collectDataInventory({ userDataPath: destination, sessionStore: restoredSessions,
    runtimeArchivePort: createOfflineRuntimeArchivePort({ userDataPath: destination, sessionStore: restoredSessions }) });
  assert.ok(secondArchive.entries.some(row => row.logicalPath === 'runtime/runtime-coordination.json'));
});

for (const boundary of ['intent', 'work_reference', 'canonical', 'retired']) test(`retirement recovers interruption after ${boundary} without premature capacity release`, async t => {
  const h = await terminalFixture(t);
  const cp = h.runtime.checkpointStore;
  const before = cp.snapshot().body_bytes;
  const write = cp.io.writeJsonAtomic;
  cp.io = { ...cp.io, writeJsonAtomic(file, value) {
    write(file, value);
    if ((boundary === 'intent' && value.state === 'retiring') || (boundary === 'retired' && value.state === 'retired')) throw new Error('injected');
  } };
  if (boundary === 'work_reference') {
    const commit = h.runtime.store._commit.bind(h.runtime.store);
    h.runtime.store._commit = work => { commit(work); throw new Error('injected'); };
  }
  const removeCanonical = h.runtime.conversationStore.removePendingContinuation;
  if (boundary === 'canonical') {
    const remove = removeCanonical;
    h.runtime.conversationStore.removePendingContinuation = (...args) => { remove(...args); throw new Error('injected'); };
  }
  h.runtime.maintainTerminalDetail();
  assert.equal(cp.snapshot().body_bytes, before);
  if (boundary !== 'retired') assert.throws(() => readPortableCheckpointSnapshot(cp.root), /retirement_pending/);
  // Recreate owners against durable state; only the saved intent authorizes recovery.
  h.runtime.conversationStore.removePendingContinuation = removeCanonical;
  h.runtime.store = new RuntimeStore(h.runtime.store.root, { now: () => new Date(h.future) });
  h.runtime.checkpointStore = new CheckpointStore(cp.root, {
    validateCanonical: (continuation, work, options) => h.runtime.conversationStore.resolvePendingContinuation(continuation, work, options) });
  const recovery = recoverCheckpointRetirements(h.service, h.runtime);
  assert.equal(recovery.blocked, 0, JSON.stringify(recovery));
  h.runtime.maintainTerminalDetail();
  assertRetained(h);
  assert.ok(h.runtime.checkpointStore.snapshot().body_bytes < before);
});

for (const blocker of ['receipt', 'lineage', 'quarantine', 'publication', 'fence', 'child_age']) test(`retention preserves complete material when ${blocker} remains unresolved`, async t => {
  const h = await terminalFixture(t);
  const before = h.runtime.checkpointStore.exportPortableSnapshot();
  let restore;
  if (blocker === 'receipt') {
    const root = h.work.input.root_run;
    const args = { rootRunId: root.root_run_id, workId: h.work.work_id, attemptId: h.work.attempt.attempt_id,
      operationId: 'retention_receipt', providerId: root.allowed_provider_ids[0],
      maxima: { inference_requests: 1, input_tokens: 8, output_tokens: 8 } };
    h.runtime.budgetStore.reserve(args);
    restore = () => h.runtime.budgetStore.settle({ ...args, consumption: 'unknown', usage: null });
  } else if (blocker === 'lineage') {
    h.runtime.lineageStore.beginSpawn({ rootRunId: h.started.root_run_id, parentWorkId: h.work.work_id,
      parentTurnId: h.work.turn_id, callId: 'uncommitted_child', argsSha256: 'a'.repeat(64) });
  } else if (blocker === 'quarantine') {
    const snapshot = h.runtime.resourceBroker.snapshot.bind(h.runtime.resourceBroker);
    h.runtime.resourceBroker.snapshot = () => ({ ...snapshot(), quarantined_count: 1 });
    restore = () => { h.runtime.resourceBroker.snapshot = snapshot; };
  } else if (blocker === 'publication') {
    h.runtime.children.publications.set('in_flight', Promise.resolve());
    restore = () => h.runtime.children.publications.clear();
  } else if (blocker === 'fence') {
    h.runtime.scheduler.cancellationFences.set(h.work.work_id, {});
    restore = () => h.runtime.scheduler.cancellationFences.clear();
  } else {
    const child = h.runtime.store.get(h.child.child_work_id);
    const transition = { ...child.transition, at: new Date(h.future).toISOString() };
    h.runtime.store._commit({ ...child, transition, revision: child.revision + 1 });
  }
  h.runtime.maintainTerminalDetail();
  assert.deepEqual(h.runtime.checkpointStore.exportPortableSnapshot(), before);
  assert.equal(h.runtime.store.get(h.work.work_id).input.kind, 'root_chat');
  if (restore) {
    restore();
    const budget = h.runtime.budgetStore.exportPortableSnapshot();
    h.runtime.maintainTerminalDetail();
    assertRetained(h);
    assert.deepEqual(h.runtime.budgetStore.exportPortableSnapshot(), budget);
  }
});

test('canonical removal without durable proof never releases capacity and blocks online/offline capture', async t => {
  const h = await terminalFixture(t);
  const before = h.runtime.checkpointStore.snapshot().body_bytes;
  h.runtime.conversationStore.removePendingContinuation = () => ({ ok: true, durable: false });
  h.runtime.maintainTerminalDetail();
  assert.equal(h.runtime.checkpointStore.snapshot().body_bytes, before);
  assert.throws(() => h.runtime.capturePortableState(), /retirement_pending/);
  assert.throws(() => readPortableCheckpointSnapshot(h.runtime.checkpointStore.root), /retirement_pending/);
  assert.equal(h.service.sessionStore.getSession(h.work.session_id).runtime_continuations.entries.length, 1);
});
