'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_INDEX_BYTES,
  MAX_PENDING_HOST,
  MAX_PENDING_INPUT_BYTES,
  MAX_PENDING_PROJECT,
  MAX_PENDING_SESSION,
  createIndexDocument,
  pendingCapacityReason,
  pendingProjection,
} = require('../../services/session-runtime/contracts');
const { RuntimeStore, createRuntimeStoreIO } = require('../../services/session-runtime/store');
const { clone, MemoryIO, harness, authority, submission, attempt } = require('../helpers/runtime-store-fixture');
test('store IO sweeps only stale atomic-write temp files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-store-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = '.runtime-deadbeefdeadbeefdeadbeef.tmp';
  const ordinary = '.runtime-deadbeef.tmp';
  const directory = '.runtime-feedfacefeedfacefeedface.tmp';
  fs.writeFileSync(path.join(root, stale), 'stale');
  fs.writeFileSync(path.join(root, ordinary), 'keep');
  fs.mkdirSync(path.join(root, directory));
  assert.equal(createRuntimeStoreIO().sweepStaleTemp(root), 1);
  assert.deepEqual(fs.readdirSync(root).sort(), [directory, ordinary].sort());
});
test('durable submission is idempotent and summaries omit pending input', () => {
  const { io, store } = harness();
  const first = store.submit(submission({ workId: 'work_stable', turnId: 'turn_stable' }));
  const retry = store.submit(submission({ workId: 'work_different', turnId: 'turn_different' }));

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.record.work_id, 'work_stable');
  assert.equal(retry.record.turn_id, 'turn_stable');
  assert.equal(store.getStatus().pending.host_count, 1);
  io.reads.length = 0;
  const page = store.listSummaries({ limit: 10 });
  assert.deepEqual(page.items.map((entry) => entry.work_id), ['work_stable']);
  assert.equal(Object.hasOwn(page.items[0], 'input'), false);
  assert.deepEqual(io.reads, []);
  assert.throws(() => store.submit(submission({ input: { prompt: 'changed' } })),
    { code: 'idempotency_conflict' });
});

test('summary pagination is revision bound and filtered without record reads', () => {
  const { io, store } = harness();
  store.submit(submission({ idempotencyKey: 'submit_a', workId: 'work_a', turnId: 'turn_a' }));
  store.submit(submission({ idempotencyKey: 'submit_b', workId: 'work_b', turnId: 'turn_b' }));
  const first = store.listSummaries({ limit: 1, projectId: 'project_alpha' });
  assert.equal(first.items.length, 1);
  assert.ok(first.next_cursor);
  io.reads.length = 0;
  const second = store.listSummaries({ cursor: first.next_cursor, limit: 1,
    projectId: 'project_alpha' });
  assert.equal(second.items.length, 1);
  assert.deepEqual(io.reads, []);
  assert.throws(() => store.listSummaries({ cursor: first.next_cursor, limit: 1 }),
    { code: 'cursor_scope_mismatch' });
  store.submit(submission({ idempotencyKey: 'submit_c', workId: 'work_c', turnId: 'turn_c' }));
  assert.throws(() => store.listSummaries({ cursor: first.next_cursor }), { code: 'stale_cursor' });
});

test('ready candidates preserve durable FIFO across equal timestamps and index reconstruction', () => {
  const first = harness(new MemoryIO(), { now: () => new Date('2026-09-09T00:00:00.000Z') });
  for (const suffix of ['a', 'b', 'c']) {
    first.store.submit(submission({ idempotencyKey: `submit_${suffix}`, workId: `work_${suffix}`,
      turnId: `turn_${suffix}` }));
  }
  first.io.files.delete(path.join('RUNTIME', 'index.json'));
  const originalList = first.io.listJson.bind(first.io);
  first.io.listJson = (directory) => originalList(directory).reverse();
  const reopened = harness(first.io, { now: () => new Date('2026-09-09T00:00:00.000Z') }).store;
  for (const workId of ['work_c', 'work_b', 'work_a']) {
    const paused = reopened.get(workId);
    reopened.transition(workId, { expectedRevision: paused.revision, to: 'pending', reason: 'resume' });
  }

  const candidates = reopened.listReadyCandidates({ limit: 256 });
  assert.deepEqual(candidates.map((entry) => entry.work_id), ['work_a', 'work_b', 'work_c']);
  assert.deepEqual(candidates.map((entry) => entry.submission_sequence), [1, 2, 3]);
  assert.throws(() => reopened.listReadyCandidates({ limit: 257 }),
    { code: 'invalid_ready_request' });
});

test('transitions use revision CAS, fresh attempts, and the full attempt fence', () => {
  const { store } = harness();
  const submitted = store.submit(submission()).record;
  assert.throws(() => store.transition(submitted.work_id, {
    expectedRevision: 0, to: 'running', reason: 'dispatch', attempt: attempt(1),
  }), { code: 'revision_conflict' });
  const running = store.transition(submitted.work_id, {
    expectedRevision: 1, to: 'running', reason: 'dispatch', transitionId: 'transition_run_1',
    attempt: attempt(1),
  }).record;
  const retry = store.transition(submitted.work_id, {
    expectedRevision: 999, to: 'running', reason: 'dispatch', transitionId: 'transition_run_1',
    attempt: attempt(1),
  });
  assert.equal(retry.changed, false);
  assert.throws(() => store.transition(submitted.work_id, {
    expectedRevision: running.revision, to: 'paused', reason: 'pause', expectedAttempt: attempt(2),
  }), { code: 'attempt_fence_conflict' });
  const paused = store.transition(submitted.work_id, {
    expectedRevision: running.revision, to: 'paused', reason: 'pause', expectedAttempt: attempt(1),
  }).record;
  assert.throws(() => store.transition(submitted.work_id, {
    expectedRevision: paused.revision, to: 'running', reason: 'resume', attempt: attempt(1),
  }), { code: 'attempt_not_fresh' });
  const resumed = store.transition(submitted.work_id, {
    expectedRevision: paused.revision, to: 'running', reason: 'resume', attempt: attempt(2),
  }).record;
  const completed = store.transition(submitted.work_id, {
    expectedRevision: resumed.revision, to: 'completed', reason: 'settled', expectedAttempt: attempt(2),
  }).record;
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.attempt, attempt(2));
});

test('late terminal evidence settles needs-attention work behind the original attempt fence', () => {
  for (const terminalStatus of ['completed', 'failed', 'cancelled']) {
    const { store } = harness();
    const submitted = store.submit(submission()).record;
    const running = store.transition(submitted.work_id, {
      expectedRevision: submitted.revision, to: 'running', reason: 'dispatch', attempt: attempt(1),
    }).record;
    const attention = store.transition(submitted.work_id, {
      expectedRevision: running.revision, expectedAttempt: attempt(1),
      to: 'needs_attention', reason: 'settlement_unconfirmed',
    }).record;
    assert.throws(() => store.transition(submitted.work_id, {
      expectedRevision: attention.revision, expectedAttempt: attempt(2),
      to: terminalStatus, reason: 'late_settlement',
    }), { code: 'attempt_fence_conflict' });
    const settled = store.transition(submitted.work_id, {
      expectedRevision: attention.revision, expectedAttempt: attempt(1),
      to: terminalStatus, reason: 'late_settlement',
    }).record;
    assert.equal(settled.status, terminalStatus);
    assert.deepEqual(settled.attempt, attempt(1));
  }
});

test('pending capacity constants enforce host, project, session, and serialized input limits', () => {
  function summaries(count, project = (index) => `project_${index}`,
    session = (index) => `session_${index}`, bytes = 2) {
    return Array.from({ length: count }, (_, index) => ({ status: 'pending',
      project_id: project(index), session_id: session(index), input_bytes: bytes }));
  }
  assert.equal(pendingCapacityReason(pendingProjection(summaries(MAX_PENDING_HOST + 1))),
    'host_pending_capacity');
  assert.equal(pendingCapacityReason(pendingProjection(summaries(MAX_PENDING_PROJECT + 1,
    () => 'project_one'))), 'project_pending_capacity');
  assert.equal(pendingCapacityReason(pendingProjection(summaries(MAX_PENDING_SESSION + 1,
    (index) => `project_${index}`, () => 'session_one'))), 'session_pending_capacity');
  assert.equal(pendingCapacityReason(pendingProjection(summaries(1, () => 'project_one',
    () => 'session_one', MAX_PENDING_INPUT_BYTES + 1))), 'pending_input_capacity');

  const { store } = harness();
  for (let index = 0; index < MAX_PENDING_SESSION; index += 1) {
    store.submit(submission({ idempotencyKey: `submit_${index}`, workId: `work_${index}`,
      turnId: `turn_${index}` }));
  }
  assert.throws(() => store.submit(submission({ idempotencyKey: 'submit_over',
    workId: 'work_over', turnId: 'turn_over' })), { code: 'session_pending_capacity' });
});

test('pending input edits enforce aggregate byte capacity', () => {
  const { store } = harness();
  const pending = Array.from({ length: 3 }, (_, index) => store.submit(submission({
    idempotencyKey: `edit_capacity_${index}`, workId: `edit_capacity_work_${index}`,
    turnId: `edit_capacity_turn_${index}`, input: { schema_version: 1, kind: 'immediate_chat',
      request: { prompt: 'hello', visiblePrompt: 'hello' } },
  })).record);
  const prompt = 'x'.repeat(3 * 1024 * 1024);

  for (const record of pending.slice(0, 2)) {
    store.updatePending(record.work_id, { expectedRevision: record.revision, prompt });
  }
  assert.throws(() => store.updatePending(pending[2].work_id, {
    expectedRevision: pending[2].revision, prompt,
  }), { code: 'pending_input_capacity' });
  assert.ok(store.getStatus().pending.serialized_input_bytes <= MAX_PENDING_INPUT_BYTES);
});

test('a crash between work and index writes repairs the item then pauses it on restart', () => {
  const { io, store } = harness();
  io.failWrite = (filePath) => filePath.endsWith('index.json');
  assert.throws(() => store.submit(submission()), { code: 'write_failed' });
  assert.equal(store.getStatus().read_only, true);
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), true);

  io.failWrite = null;
  const reopened = harness(io).store;
  const record = reopened.get('work_1');
  assert.equal(reopened.getStatus().read_only, false);
  assert.equal(record.status, 'paused');
  assert.equal(record.recovery.kind, 'restart_paused');
  assert.equal(record.recovery.previous_status, 'pending');
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), false);
});

test('journal repair is idempotent across each repaired write boundary', async (t) => {
  for (const boundary of ['work', 'index', 'remove']) {
    await t.test(boundary, () => {
      const first = harness();
      first.io.failWrite = (filePath) => filePath.endsWith('index.json');
      assert.throws(() => first.store.submit(submission()), { code: 'write_failed' });
      first.io.failWrite = boundary === 'remove' ? null : (filePath) => (
        boundary === 'work' ? filePath.includes(`${path.sep}work${path.sep}`)
          : filePath.endsWith('index.json')
      );
      first.io.failRemove = boundary === 'remove';
      const interruptedRepair = harness(first.io).store;
      if (boundary === 'remove') {
        // The repair is fully published before the journal is removed, so a
        // stuck journal is cleanup only: the store stays writable and repaired.
        assert.equal(interruptedRepair.getStatus().read_only, false);
        assert.equal(interruptedRepair.get('work_1').revision, 3);
        assert.equal(first.io.files.has(path.join('RUNTIME', 'transition.json')), true);
      } else {
        assert.equal(interruptedRepair.getStatus().read_only, true);
      }

      first.io.failWrite = null;
      first.io.failRemove = false;
      const recovered = harness(first.io).store;
      const record = recovered.get('work_1');
      assert.equal(recovered.getStatus().read_only, false);
      assert.equal(record.status, 'paused');
      assert.equal(record.revision, 3);
      assert.equal(record.recovery.kind, 'restart_paused');
      assert.equal(first.io.files.has(path.join('RUNTIME', 'transition.json')), false);
    });
  }
});

test('a failed journal write leaves memory untouched and the store writable', () => {
  const logs = [];
  const { io, store } = harness(new MemoryIO(), {
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  const pending = store.submit(submission()).record;
  io.failWrite = filePath => filePath.endsWith('transition.json');
  assert.throws(() => store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'cancelled', reason: 'stop' }), { code: 'write_failed' });
  // The journal is the first write and memory waits for all three, so nothing
  // changed on either side: there is no inconsistency to latch against.
  assert.equal(store.getStatus().read_only, false);
  assert.equal(store.getStatus().revision, 1);
  assert.deepEqual(store.get(pending.work_id), pending);
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), false);
  assert.equal(logs.some(entry => entry.event === 'runtime_store.read_only'), false);
  assert.equal(logs.filter(entry => entry.event === 'runtime_store.write_failed_reconciled').length, 1);

  io.failWrite = null;
  const cancelled = store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'cancelled', reason: 'stop' }).record;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.revision, pending.revision + 1);
  assert.deepEqual(harness(io).store.get(pending.work_id), cancelled);
});

test('index write failure reconciles the cached record through journal repair', () => {
  const { io, store } = harness();
  const pending = store.submit(submission()).record;
  const write = io.writeJsonAtomic.bind(io);
  let failIndex = true;
  io.writeJsonAtomic = (filePath, value) => {
    if (failIndex && filePath.endsWith('index.json')) {
      failIndex = false;
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    write(filePath, value);
  };
  assert.throws(() => store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'cancelled', reason: 'stop' }), { code: 'write_failed' });
  // The reload replayed the journal, so the store stays writable; the caller
  // still saw the failure and re-reads the landed (repaired) record.
  assert.deepEqual(store.getStatus(), { read_only: false, reason: null,
    schema_version: 1, revision: 2,
    pending: { host_count: 0, project_counts: {}, session_counts: {}, serialized_input_bytes: 0 } });
  const durable = store.get(pending.work_id);
  assert.equal(durable.status, 'cancelled');
  assert.equal(durable.revision, 3);
  assert.equal(store.submit(submission({ idempotencyKey: 'after_reconcile' })).record.status, 'pending');
  const reopened = harness(io).store;
  assert.deepEqual(reopened.get(pending.work_id), durable);
  assert.equal(io.files.has(path.join('RUNTIME', 'transition.json')), false);

  const blocked = harness();
  const original = blocked.store.submit(submission()).record;
  blocked.io.failWrite = filePath => filePath.endsWith('index.json');
  assert.throws(() => blocked.store.transition(original.work_id, { expectedRevision: original.revision,
    to: 'cancelled', reason: 'stop' }), { code: 'write_failed' });
  assert.equal(blocked.store.get(original.work_id), null);
  assert.equal(blocked.store.getStatus().reason, 'write_failed');
  blocked.io.failWrite = null;
  assert.equal(harness(blocked.io).store.get(original.work_id).status, 'cancelled');
});

test('terminal bodies are loaded on demand and are not retained across reads', () => {
  const { io, store } = harness();
  const pending = store.submit(submission()).record;
  const running = store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;
  store.transition(pending.work_id, { expectedRevision: running.revision,
    to: 'completed', reason: 'settled', expectedAttempt: attempt(1) });
  const workPath = path.join('RUNTIME', 'work', `${pending.work_id}.json`);

  io.reads.length = 0;
  const reopened = harness(io).store;
  assert.equal(io.reads.filter((entry) => entry === workPath).length, 1);
  io.reads.length = 0;
  assert.equal(reopened.listSummaries().items[0].status, 'completed');
  assert.equal(reopened.listReadyCandidates().length, 0);
  assert.equal(io.reads.filter((entry) => entry === workPath).length, 0);
  assert.equal(reopened.get(pending.work_id).status, 'completed');
  assert.equal(reopened.get(pending.work_id).status, 'completed');
  assert.equal(io.reads.filter((entry) => entry === workPath).length, 2);
});

function completeWork(store, overrides = {}) {
  const pending = store.submit(submission(overrides)).record;
  const running = store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;
  return store.transition(pending.work_id, { expectedRevision: running.revision,
    to: 'completed', reason: 'complete', expectedAttempt: running.attempt }).record;
}

test('terminal future and corrupt bodies block all startup repair writes', () => {
  for (const mutation of [record => ({ ...record, schema_version: 2 }),
    record => ({ ...record, input_bytes: 999 })]) {
    const { io, store } = harness();
    const completed = completeWork(store);
    store.submit(submission({ idempotencyKey: 'still_pending' }));
    const workPath = path.join('RUNTIME', 'work', `${completed.work_id}.json`);
    io.files.set(workPath, mutation(io.files.get(workPath)));
    const before = JSON.stringify([...io.files]);
    io.writes.length = 0;
    const reopened = harness(io).store;
    assert.equal(reopened.getStatus().read_only, true);
    assert.deepEqual(io.writes, []);
    assert.equal(JSON.stringify([...io.files]), before);
  }
});

test('missing-index reconstruction discards each terminal body as it is validated', () => {
  const { io, store } = harness();
  for (let index = 0; index < 24; index += 1) {
    completeWork(store, { idempotencyKey: `history_${index}`, input: { prompt: 'x'.repeat(64 * 1024) } });
  }
  io.files.delete(path.join('RUNTIME', 'index.json'));
  class ObservedStore extends RuntimeStore {
    _rememberRecord(record) {
      super._rememberRecord(record);
      assert.ok([...this.records.values()].every(entry => entry.status !== 'completed'));
      assert.ok(this.records.size <= 8);
    }
  }
  const reopened = new ObservedStore('RUNTIME', { io });
  assert.equal(reopened.getStatus().read_only, false);
  assert.equal(reopened.listSummaries({ limit: 100 }).items.length, 24);
  assert.equal(reopened.records.size, 0);
});

test('journal repair refuses changes to an existing work submission sequence before writes', () => {
  const { io, store } = harness();
  const first = store.submit(submission()).record;
  store.submit(submission({ idempotencyKey: 'second' }));
  io.failWrite = filePath => filePath.includes(`${path.sep}work${path.sep}`);
  assert.throws(() => store.transition(first.work_id, { expectedRevision: first.revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) }), { code: 'write_failed' });
  const journalPath = path.join('RUNTIME', 'transition.json');
  const journal = io.files.get(journalPath);
  journal.record.submission_sequence = 3;
  journal.summary.submission_sequence = 3;
  io.failWrite = null;
  io.writes.length = 0;
  const reopened = harness(io).store;
  assert.equal(reopened.getStatus().reason, 'journal_immutable_identity_conflict');
  assert.deepEqual(io.writes, []);
});

test('equal-length payload tampering is refused before recovery or idempotent retry', () => {
  const { io, store } = harness();
  const first = store.submit(submission()).record;
  io.files.get(path.join('RUNTIME', 'work', `${first.work_id}.json`)).input.prompt = 'jello';
  io.writes.length = 0;
  const reopened = harness(io).store;
  assert.equal(reopened.getStatus().reason, 'submission_hash_mismatch');
  assert.deepEqual(io.writes, []);
  assert.throws(() => reopened.submit(submission()), { code: 'store_read_only' });
});

test('restart pauses persisted running work without allocating a new attempt', () => {
  const { io, store } = harness();
  const pending = store.submit(submission()).record;
  const running = store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;

  const reopened = harness(io).store;
  const paused = reopened.get(pending.work_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.recovery.kind, 'restart_paused');
  assert.equal(paused.recovery.previous_status, 'running');
  assert.deepEqual(paused.attempt, running.attempt);
});

test('restart-paused running work durably attaches its exact committed checkpoint once', () => {
  const { io, store } = harness();
  const pending = store.submit(submission()).record;
  const running = store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;
  const reopened = harness(io).store;
  const paused = reopened.get(pending.work_id);
  const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_1',
    sha256: 'a'.repeat(64), bytes: 128, source_attempt: running.attempt };

  const attached = reopened.attachRecoveredCheckpoint(paused.work_id, {
    expectedRevision: paused.revision, expectedAttempt: running.attempt, checkpointRef,
  });
  assert.equal(attached.changed, true);
  assert.deepEqual(attached.record.checkpoint_ref, checkpointRef);
  assert.equal(attached.record.status, 'paused');
  assert.equal(attached.record.recovery.kind, 'restart_paused');
  const duplicate = reopened.attachRecoveredCheckpoint(paused.work_id, {
    expectedRevision: paused.revision, expectedAttempt: running.attempt, checkpointRef,
  });
  assert.equal(duplicate.changed, false);
  assert.deepEqual(harness(io).store.get(paused.work_id).checkpoint_ref, checkpointRef);

  assert.throws(() => reopened.attachRecoveredCheckpoint(paused.work_id, {
    expectedRevision: attached.record.revision, expectedAttempt: attempt(2), checkpointRef,
  }), { code: 'checkpoint_fence_conflict' });
  assert.throws(() => reopened.attachRecoveredCheckpoint(paused.work_id, {
    expectedRevision: attached.record.revision, expectedAttempt: running.attempt,
    checkpointRef: { ...checkpointRef, checkpoint_id: 'checkpoint_other' },
  }), { code: 'checkpoint_fence_conflict' });
});

test('checkpoint attachment repair preserves resumable state across every write boundary', async t => {
  for (const boundary of ['work', 'index', 'remove']) {
    await t.test(boundary, () => {
      const first = harness();
      const pending = first.store.submit(submission()).record;
      const running = first.store.transition(pending.work_id, { expectedRevision: pending.revision,
        to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;
      const restarted = harness(first.io).store;
      const paused = restarted.get(pending.work_id);
      const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_1',
        sha256: 'a'.repeat(64), bytes: 128, source_attempt: running.attempt };
      restarted.io.failWrite = boundary === 'remove' ? null : filePath => (
        boundary === 'work' ? filePath.includes(`${path.sep}work${path.sep}`)
          : filePath.endsWith('index.json')
      );
      restarted.io.failRemove = boundary === 'remove';
      const attach = () => restarted.attachRecoveredCheckpoint(paused.work_id, {
        expectedRevision: paused.revision, expectedAttempt: running.attempt, checkpointRef,
      });
      if (boundary === 'remove') assert.equal(attach().changed, true);
      else assert.throws(attach, { code: 'write_failed' });

      restarted.io.failWrite = null;
      restarted.io.failRemove = false;
      const recovered = harness(first.io).store;
      const record = recovered.get(paused.work_id);
      assert.equal(record.recovery.kind, 'restart_paused');
      assert.equal(record.recovery.previous_status, 'running');
      assert.deepEqual(record.checkpoint_ref, checkpointRef);
      assert.equal(recovered.attachRecoveredCheckpoint(paused.work_id, {
        expectedRevision: paused.revision, expectedAttempt: running.attempt, checkpointRef,
      }).changed, false);
    });
  }
});

test('restart pause repair preserves the original running provenance at every write boundary', async t => {
  for (const boundary of ['work', 'index', 'remove']) {
    await t.test(boundary, () => {
      const first = harness();
      const pending = first.store.submit(submission()).record;
      const running = first.store.transition(pending.work_id, { expectedRevision: pending.revision,
        to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;
      first.io.failWrite = boundary === 'remove' ? null : filePath => (
        boundary === 'work' ? filePath.includes(`${path.sep}work${path.sep}`)
          : filePath.endsWith('index.json')
      );
      first.io.failRemove = boundary === 'remove';
      const interrupted = harness(first.io).store;
      assert.equal(interrupted.getStatus().read_only, boundary !== 'remove');

      first.io.failWrite = null;
      first.io.failRemove = false;
      const recovered = harness(first.io).store;
      const record = recovered.get(pending.work_id);
      assert.equal(record.status, 'paused');
      assert.equal(record.recovery.kind, 'restart_paused');
      assert.equal(record.recovery.previous_status, 'running');
      assert.deepEqual(record.attempt, running.attempt);
    });
  }
});

test('restart recovery over capacity lets each session cancel queued work', () => {
  const { io, store } = harness();
  const sessions = [];
  for (const sessionId of ['session_alpha', 'session_beta']) {
    const pending = [];
    for (let index = 0; index < MAX_PENDING_SESSION; index += 1) {
      pending.push(store.submit(submission({ sessionId,
        idempotencyKey: `${sessionId}_capacity_${index}`,
        workId: `${sessionId}_work_${index}`, turnId: `${sessionId}_turn_${index}` })).record);
    }
    store.transition(pending[0].work_id, { expectedRevision: pending[0].revision,
      to: 'running', reason: 'dispatch', attempt: attempt(sessionId === 'session_alpha' ? 1 : 2) });
    const queued = store.submit(submission({ sessionId,
      idempotencyKey: `${sessionId}_replacement`, workId: `${sessionId}_replacement`,
      turnId: `${sessionId}_replacement_turn` })).record;
    sessions.push({ pending, queued });
  }

  const reopened = harness(io).store;
  assert.equal(reopened.getStatus().read_only, false);
  for (const { pending, queued } of sessions) {
    assert.equal(reopened.get(pending[0].work_id).status, 'paused');
    const recoveredQueued = reopened.get(queued.work_id);
    const cancelled = reopened.transition(queued.work_id, {
      expectedRevision: recoveredQueued.revision, to: 'cancelled', reason: 'user_cancelled',
    }).record;
    assert.equal(cancelled.status, 'cancelled');
  }
  assert.equal(harness(io).store.getStatus().read_only, false);
});

test('an oversized next summary index is refused before journal or record writes', () => {
  const { io, store } = harness();
  const timestamp = '2026-09-09T00:00:00.000Z';
  const summaries = Array.from({ length: 33_000 }, (_, index) => ({
    work_id: `historical_work_${index}`, turn_id: `historical_turn_${index}`,
    idempotency_key: `historical_submission_${index}`, project_id: `project_${index}`,
    session_id: `session_${index}`, purpose: 'x'.repeat(256), status: 'completed',
    submission_sequence: index + 1, revision: 1, input_bytes: 2,
    created_at: timestamp, updated_at: timestamp,
  }));
  store.index = createIndexDocument(summaries, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(store.index), 'utf8') > MAX_INDEX_BYTES);
  io.writes.length = 0;
  assert.throws(() => store.submit(submission({ idempotencyKey: 'oversized_index_submit' })),
    { code: 'index_too_large' });
  assert.deepEqual(io.writes, []);
});

test('corrupt or future pending data remains intact and makes the store read only', () => {
  const first = harness();
  const record = first.store.submit(submission()).record;
  const workPath = path.join('RUNTIME', 'work', `${record.work_id}.json`);
  first.io.files.set(workPath, { ...clone(record), input_bytes: 999 });
  const corruptBytes = JSON.stringify(first.io.files.get(workPath));
  const corruptStore = harness(first.io).store;
  assert.equal(corruptStore.getStatus().read_only, true);
  assert.equal(JSON.stringify(first.io.files.get(workPath)), corruptBytes);

  const futureIO = new MemoryIO();
  const future = { ...clone(createIndexDocument()), schema_version: 2 };
  futureIO.files.set(path.join('RUNTIME', 'index.json'), future);
  const futureStore = harness(futureIO).store;
  assert.deepEqual(futureIO.files.get(path.join('RUNTIME', 'index.json')), future);
  assert.deepEqual(futureStore.getStatus(), {
    read_only: true, reason: 'future_schema', schema_version: 1, revision: 0,
    pending: { host_count: 0, project_counts: {}, session_counts: {}, serialized_input_bytes: 0 },
  });
});

test('default IO atomically reopens pending work as paused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let id = 0;
  const options = { createId: (prefix) => `${prefix}_${++id}`,
    now: () => new Date('2026-09-09T00:00:00.000Z') };
  const store = new RuntimeStore(root, options);
  const submitted = store.submit(submission()).record;

  const reopened = new RuntimeStore(root, options);
  assert.equal(reopened.getStatus().read_only, false);
  assert.equal(reopened.get(submitted.work_id).status, 'paused');
  assert.equal(fs.existsSync(path.join(root, 'transition.json')), false);
});


test('restart preserves pause intent and recovered checkpoint needs explicit resume', () => {
  const { store, io } = harness();
  const submitted = store.submit(submission()).record;
  const attempt = { attempt_id: 'attempt_pause', stream_id: 'stream_pause',
    incarnation: 'incarnation_pause', authority_revision: 'authority_pause' };
  const running = store.transition(submitted.work_id, { expectedRevision: submitted.revision,
    to: 'running', reason: 'admitted', attempt }).record;
  store.requestPause(running.work_id, { expectedRevision: running.revision,
    expectedAttempt: attempt, reason: 'user_pause' });
  const restarted = harness(io).store;
  const paused = restarted.get(running.work_id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.control_request.kind, 'pause');
  const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_pause',
    sha256: 'b'.repeat(64), bytes: 20, source_attempt: attempt };
  const recovered = restarted.attachRecoveredCheckpoint(paused.work_id, {
    expectedRevision: paused.revision, expectedAttempt: attempt, checkpointRef }).record;
  assert.equal(recovered.control_request.kind, 'pause');
  assert.throws(() => restarted.transition(paused.work_id, { expectedRevision: recovered.revision,
    to: 'pending', reason: 'automatic_resume' }), /pause_requested/);
  assert.throws(() => restarted.transition(paused.work_id, { expectedRevision: recovered.revision,
    to: 'pending', reason: 'automatic_resume', clearPause: true }), /pause_clear_state_conflict/);
  const resumed = restarted.transition(paused.work_id, { expectedRevision: recovered.revision,
    to: 'pending', reason: 'explicit_resume', clearPause: true }).record;
  assert.equal(resumed.control_request, null);
});

for (const variant of ['no_intent', 'other_failure', 'failed', 'wrong_attempt', 'stale_revision']) {
  test(`interrupted checkpoint attachment rejects ${variant}`, () => {
    const { store } = harness(); const pending = store.submit(submission()).record;
    let current = store.transition(pending.work_id, { expectedRevision: pending.revision,
      to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;
    if (variant !== 'no_intent') current = store.requestPause(current.work_id, {
      expectedRevision: current.revision, expectedAttempt: current.attempt, reason: 'user' }).record;
    current = store.transition(current.work_id, { expectedRevision: current.revision, expectedAttempt: current.attempt,
      to: variant === 'failed' ? 'failed' : 'needs_attention', reason: variant === 'other_failure' ? 'other' : 'settlement_unconfirmed' }).record;
    const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_1', sha256: 'a'.repeat(64), bytes: 128, source_attempt: attempt(1) };
    assert.throws(() => store.attachRecoveredCheckpoint(current.work_id, {
      expectedRevision: current.revision - Number(variant === 'stale_revision'),
      expectedAttempt: attempt(variant === 'wrong_attempt' ? 2 : 1), checkpointRef }));
    assert.equal(store.get(current.work_id).checkpoint_ref, null);
  });
}
