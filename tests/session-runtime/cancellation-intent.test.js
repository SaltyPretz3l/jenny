'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { validateWorkRecord } = require('../../services/session-runtime/contracts');
const { RuntimeStore } = require('../../services/session-runtime/store');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

class MemoryIO {
  constructor() {
    this.files = new Map();
    this.writes = [];
    this.failWrite = null;
    this.failRemove = false;
  }

  readJson(filePath) {
    if (!this.files.has(filePath)) return { status: 'missing' };
    return { status: 'ok', value: clone(this.files.get(filePath)) };
  }

  writeJsonAtomic(filePath, value) {
    this.writes.push(filePath);
    if (this.failWrite?.(filePath, value)) throw new Error('injected write failure');
    this.files.set(filePath, clone(value));
  }

  listJson(directory) {
    const prefix = `${directory}${path.sep}`;
    return [...this.files.keys()].filter(entry => entry.startsWith(prefix)
      && entry.slice(prefix.length).endsWith('.json'));
  }

  remove(filePath) {
    if (this.failRemove) throw new Error('injected remove failure');
    this.files.delete(filePath);
  }
}

function harness(io = new MemoryIO()) {
  let id = 0;
  let time = Date.parse('2026-09-10T00:00:00.000Z');
  return { io, store: new RuntimeStore('RUNTIME', { io,
    createId: prefix => `${prefix}_${++id}`,
    now: () => new Date(time += 1000) }) };
}

function authority() {
  return { project_id: 'project_alpha', root_path: 'G:\\workspace', root_id: 'root_alpha',
    root_revision: 3, device_id: '11', inode: '22' };
}

function attempt(number) {
  return { attempt_id: `attempt_${number}`, stream_id: `stream_${number}`,
    incarnation: `host_${number}`, authority_revision: `authority_${number}` };
}

function submit(store) {
  return store.submit({ idempotencyKey: 'submit_1', projectId: 'project_alpha',
    sessionId: 'session_alpha', purpose: 'chat_turn', input: { prompt: 'hello' },
    authority: authority() }).record;
}

function start(store) {
  const pending = submit(store);
  return store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;
}

test('cancellation intent uses revision and attempt fences without changing execution status', () => {
  const { store } = harness();
  const pending = submit(store);
  assert.throws(() => store.requestCancellation(pending.work_id, {
    expectedRevision: pending.revision, expectedAttempt: attempt(1), reason: 'user request',
  }), { code: 'cancellation_state_conflict' });
  const running = store.transition(pending.work_id, { expectedRevision: pending.revision,
    to: 'running', reason: 'dispatch', attempt: attempt(1) }).record;
  assert.throws(() => store.requestCancellation(running.work_id, {
    expectedRevision: running.revision, expectedAttempt: attempt(2), reason: 'user request',
  }), { code: 'attempt_fence_conflict' });
  assert.throws(() => store.requestCancellation(running.work_id, {
    expectedRevision: running.revision - 1, expectedAttempt: attempt(1), reason: 'user request',
  }), { code: 'revision_conflict' });

  const requested = store.requestCancellation(running.work_id, {
    expectedRevision: running.revision, expectedAttempt: attempt(1), reason: '  user request  ',
  });
  assert.equal(requested.changed, true);
  assert.equal(requested.record.status, 'running');
  assert.deepEqual(requested.record.attempt, running.attempt);
  assert.deepEqual(requested.record.control_request, {
    kind: 'cancel', requested_at: '2026-09-10T00:00:05.000Z', reason: 'user request',
  });
  const repeated = store.requestCancellation(running.work_id, {
    expectedRevision: requested.record.revision, expectedAttempt: attempt(1), reason: 'user request',
  });
  assert.equal(repeated.changed, false);
  assert.deepEqual(repeated.record.control_request, requested.record.control_request);
  const repeatedWithNewReason = store.requestCancellation(running.work_id, {
    expectedRevision: requested.record.revision, expectedAttempt: attempt(1), reason: 'other request',
  });
  assert.equal(repeatedWithNewReason.changed, false);
  assert.deepEqual(repeatedWithNewReason.record.control_request, requested.record.control_request);
  assert.throws(() => store.requestCancellation(running.work_id, {
    expectedRevision: running.revision, expectedAttempt: attempt(1), reason: 'user request',
  }), { code: 'revision_conflict' });
});

test('restart-paused attempted work records intent and cannot resume or attach a checkpoint', () => {
  const first = harness();
  const running = start(first.store);
  const restarted = harness(first.io).store;
  const paused = restarted.get(running.work_id);
  assert.equal(paused.status, 'paused');
  const requested = restarted.requestCancellation(paused.work_id, {
    expectedRevision: paused.revision, expectedAttempt: running.attempt, reason: 'stop after restart',
  }).record;
  const checkpointRef = { schema_version: 1, checkpoint_id: 'checkpoint_1',
    sha256: 'a'.repeat(64), bytes: 128, source_attempt: running.attempt };

  assert.throws(() => restarted.attachRecoveredCheckpoint(paused.work_id, {
    expectedRevision: requested.revision, expectedAttempt: running.attempt, checkpointRef,
  }), { code: 'cancellation_requested' });
  assert.throws(() => restarted.transition(paused.work_id, {
    expectedRevision: requested.revision, to: 'pending', reason: 'resume',
  }), { code: 'cancellation_requested' });
  assert.throws(() => restarted.transition(paused.work_id, {
    expectedRevision: requested.revision, to: 'running', reason: 'resume', attempt: attempt(2),
  }), { code: 'cancellation_requested' });
  assert.equal(restarted.get(paused.work_id).status, 'paused');
});

test('queued resumes retain cancellation ownership while unattempted pauses are rejected', () => {
  const first = harness();
  const running = start(first.store);
  const restarted = harness(first.io).store;
  const paused = restarted.get(running.work_id);
  const queued = restarted.transition(paused.work_id, {
    expectedRevision: paused.revision, to: 'pending', reason: 'queue resume',
  }).record;
  const requested = restarted.requestCancellation(queued.work_id, {
    expectedRevision: queued.revision, expectedAttempt: running.attempt, reason: 'cancel queued resume',
  }).record;
  assert.equal(requested.status, 'pending');
  assert.deepEqual(requested.attempt, running.attempt);
  assert.throws(() => restarted.transition(requested.work_id, {
    expectedRevision: requested.revision, to: 'running', reason: 'dispatch', attempt: attempt(2),
  }), { code: 'cancellation_requested' });
  assert.throws(() => restarted.transition(requested.work_id, {
    expectedRevision: requested.revision, to: 'cancelled', reason: 'cleanup assumed',
  }), { code: 'attempt_fence_conflict' });
  const settled = restarted.transition(requested.work_id, {
    expectedRevision: requested.revision, expectedAttempt: running.attempt,
    to: 'cancelled', reason: 'cleanup confirmed',
  }).record;
  assert.deepEqual(settled.control_request, requested.control_request);

  const second = harness();
  const unstarted = submit(second.store);
  const unstartedPause = second.store.transition(unstarted.work_id, {
    expectedRevision: unstarted.revision, to: 'paused', reason: 'hold queue',
  }).record;
  assert.throws(() => second.store.requestCancellation(unstartedPause.work_id, {
    expectedRevision: unstartedPause.revision, expectedAttempt: attempt(1), reason: 'cancel',
  }), { code: 'cancellation_state_conflict' });
});

test('needs-attention work accepts an intent without claiming terminal cleanup', () => {
  const { store } = harness();
  const running = start(store);
  const attention = store.transition(running.work_id, {
    expectedRevision: running.revision, expectedAttempt: running.attempt,
    to: 'needs_attention', reason: 'cleanup uncertain',
  }).record;
  const requested = store.requestCancellation(attention.work_id, {
    expectedRevision: attention.revision, expectedAttempt: running.attempt, reason: 'cancel requested',
  }).record;
  assert.equal(requested.status, 'needs_attention');
  assert.deepEqual(requested.attempt, running.attempt);
  assert.equal(requested.control_request.kind, 'cancel');
});

test('cancellation intent survives interrupted journal commits and restart repair', async t => {
  for (const boundary of ['work', 'index', 'remove']) {
    await t.test(boundary, () => {
      const first = harness();
      const running = start(first.store);
      first.io.failWrite = boundary === 'remove' ? null : filePath => (
        boundary === 'work' ? filePath.includes(`${path.sep}work${path.sep}`)
          : filePath.endsWith('index.json')
      );
      first.io.failRemove = boundary === 'remove';
      const request = () => first.store.requestCancellation(running.work_id, {
        expectedRevision: running.revision, expectedAttempt: running.attempt,
        reason: 'durable cancel',
      });
      if (boundary === 'remove') assert.equal(request().changed, true);
      else assert.throws(request, { code: 'write_failed' });

      first.io.failWrite = null;
      first.io.failRemove = false;
      const recovered = harness(first.io).store;
      const record = recovered.get(running.work_id);
      assert.equal(recovered.getStatus().read_only, false);
      assert.equal(record.status, 'paused');
      assert.deepEqual(record.attempt, running.attempt);
      assert.equal(record.control_request.kind, 'cancel');
      assert.equal(record.control_request.reason, 'durable cancel');
    });
  }
});

test('terminal settlement retains cancellation intent and requires exact attempt evidence', () => {
  const { store } = harness();
  const running = start(store);
  const requested = store.requestCancellation(running.work_id, {
    expectedRevision: running.revision, expectedAttempt: running.attempt, reason: 'cancel safely',
  }).record;
  assert.throws(() => store.transition(running.work_id, {
    expectedRevision: requested.revision, expectedAttempt: attempt(2),
    to: 'cancelled', reason: 'cleanup confirmed',
  }), { code: 'attempt_fence_conflict' });
  const settled = store.transition(running.work_id, {
    expectedRevision: requested.revision, expectedAttempt: running.attempt,
    to: 'cancelled', reason: 'cleanup confirmed',
  }).record;
  assert.equal(settled.status, 'cancelled');
  assert.deepEqual(settled.control_request, requested.control_request);
  assert.throws(() => store.requestCancellation(running.work_id, {
    expectedRevision: settled.revision, expectedAttempt: running.attempt, reason: 'cancel safely',
  }), { code: 'cancellation_state_conflict' });
});

test('legacy v1 records default control request to null while malformed fields stay closed', () => {
  const first = harness();
  const pending = submit(first.store);
  const workPath = path.join('RUNTIME', 'work', `${pending.work_id}.json`);
  const legacy = first.io.files.get(workPath);
  delete legacy.control_request;
  const reopened = harness(first.io).store;
  assert.equal(reopened.getStatus().read_only, false);
  assert.equal(reopened.get(pending.work_id).control_request, null);

  const valid = reopened.get(pending.work_id);
  assert.equal(validateWorkRecord({ ...valid, control_request: {
    kind: 'pause', requested_at: valid.updated_at, reason: 'stop' } }).ok, true);
  for (const controlRequest of [
    { kind: 'unknown', requested_at: valid.updated_at, reason: 'stop' },
    { kind: 'cancel', requested_at: 'not-a-time', reason: 'stop' },
    { kind: 'cancel', requested_at: valid.updated_at, reason: ' ' },
    { kind: 'cancel', requested_at: valid.updated_at, reason: 'stop', extra: true },
  ]) {
    assert.equal(validateWorkRecord({ ...valid, control_request: controlRequest }).ok, false);
  }
  assert.equal(validateWorkRecord({ ...valid, unexpected: true }).ok, false);

  const corrupt = harness();
  const corruptPending = submit(corrupt.store);
  const corruptPath = path.join('RUNTIME', 'work', `${corruptPending.work_id}.json`);
  corrupt.io.files.get(corruptPath).control_request = {
    kind: 'cancel', requested_at: corruptPending.updated_at, reason: 'stop', extra: true,
  };
  corrupt.io.writes.length = 0;
  const refused = harness(corrupt.io).store;
  assert.equal(refused.getStatus().read_only, true);
  assert.equal(refused.getStatus().reason, 'invalid_work_contract');
  assert.deepEqual(corrupt.io.writes, []);
});
