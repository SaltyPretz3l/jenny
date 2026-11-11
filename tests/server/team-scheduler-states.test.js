'use strict';

// Team slice 4a-1 (spec test 4a-T1): the lease and job state tables, every timed
// transition through sweep, terminal retention, the route token and the bounds.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LEASE_STATES, LEASE_TRANSITIONS, transitionLease,
} = require('../../server/team/scheduler/state');
const { JOB_STATES, JOB_TRANSITIONS, transitionJob } = require('../../server/team/scheduler/jobs');
const {
  DONE_LINE, activeLease, createScheduler, model, registerNode, requestLease, sseData,
} = require('./helpers/team-pool-fixture');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// ---------------------------------------------------------------------------
// The pure tables: every legal row passes, every other pair is refused unchanged.

function allTriggers(table) {
  return [...new Set(Object.values(table).flat())];
}

test('every lease row in the table is accepted and names from, to and trigger', () => {
  for (const [edge, triggers] of Object.entries(LEASE_TRANSITIONS)) {
    const [from, to] = edge.split('>');
    for (const trigger of triggers) {
      const record = { state: from === 'new' ? undefined : from, reason: null };
      const result = transitionLease(record, from, to, trigger, 'some_reason', 1000);
      assert.equal(result.ok, true, `${edge} ${trigger}`);
      assert.equal(record.state, to);
      assert.deepEqual(result.transition, { table: 'lease', from, to, trigger, reason: 'some_reason' });
    }
  }
});

test('every lease pair outside the table is refused with a fixed reason and changes nothing', () => {
  const triggers = allTriggers(LEASE_TRANSITIONS);
  let refused = 0;
  for (const from of ['new', ...LEASE_STATES]) {
    for (const to of LEASE_STATES) {
      for (const trigger of triggers) {
        if ((LEASE_TRANSITIONS[`${from}>${to}`] || []).includes(trigger)) continue;
        const record = { state: from === 'new' ? undefined : from, reason: 'before', node_id: 'node_x' };
        const snapshot = structuredClone(record);
        const result = transitionLease(record, from, to, trigger, 'r', 1000);
        assert.deepEqual(result, { ok: false, reason: 'lease_transition_refused' }, `${from}>${to} ${trigger}`);
        assert.deepEqual(record, snapshot);
        refused += 1;
      }
    }
  }
  assert.ok(refused > 50);
});

test('a lease transition whose named from-state is not the record state is refused', () => {
  const record = { state: 'active' };
  assert.deepEqual(transitionLease(record, 'queued', 'active', 'node_assigned', null, 1),
    { ok: false, reason: 'lease_transition_refused' });
  assert.equal(record.state, 'active');
});

test('every job row is accepted and every other pair is refused unchanged', () => {
  for (const [edge, triggers] of Object.entries(JOB_TRANSITIONS)) {
    const [from, to] = edge.split('>');
    for (const trigger of triggers) {
      const record = { state: from === 'new' ? undefined : from };
      assert.equal(transitionJob(record, from, to, trigger, null, 1).ok, true, `${edge} ${trigger}`);
      assert.equal(record.state, to);
    }
  }
  const triggers = allTriggers(JOB_TRANSITIONS);
  for (const from of ['new', ...JOB_STATES]) {
    for (const to of JOB_STATES) {
      for (const trigger of triggers) {
        if ((JOB_TRANSITIONS[`${from}>${to}`] || []).includes(trigger)) continue;
        const record = { state: from === 'new' ? undefined : from, next_seq: 3 };
        const snapshot = structuredClone(record);
        assert.deepEqual(transitionJob(record, from, to, trigger, null, 1),
          { ok: false, reason: 'job_transition_refused' }, `${from}>${to} ${trigger}`);
        assert.deepEqual(record, snapshot);
      }
    }
  }
});

test('the spec rows are present: a claimed job never returns to queued; terminal states have no exits', () => {
  assert.equal(JOB_TRANSITIONS['claimed>queued'], undefined);
  assert.equal(JOB_TRANSITIONS['streaming>queued'], undefined);
  for (const terminal of ['done', 'failed', 'cancelled']) {
    assert.equal(Object.keys(JOB_TRANSITIONS).some((edge) => edge.startsWith(`${terminal}>`)), false);
  }
  for (const terminal of ['released', 'failed', 'expired']) {
    assert.equal(Object.keys(LEASE_TRANSITIONS).some((edge) => edge.startsWith(`${terminal}>`)), false);
  }
});

// ---------------------------------------------------------------------------
// The lease rows through the facade.

test('a lease is queued then active when a node is free, and the token is minted on activation', () => {
  const { scheduler, changes } = createScheduler();
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const result = requestLease(scheduler);
  assert.equal(result.ok, true);
  assert.equal(result.lease.state, 'active');
  assert.equal(result.lease.node_id, nodeId);
  const leaseChanges = changes.filter((c) => c.type === 'lease').map((c) => `${c.from}>${c.to}`);
  assert.deepEqual(leaseChanges, ['new>queued', 'queued>active']);
  const taken = scheduler.takeRouteToken(result.lease.lease_id);
  assert.equal(taken.ok, true);
  assert.match(taken.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(Buffer.from(taken.token, 'base64url').length, 32);
  assert.equal(scheduler.takeRouteToken(result.lease.lease_id).ok, false, 'the token is handed out once');
});

test('a lease waits queued while no slot is free and becomes active when one frees', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const first = requestLease(scheduler, { conversationKey: 'conv:p:1' });
  const second = requestLease(scheduler, { conversationKey: 'conv:p:2' });
  assert.equal(second.lease.state, 'queued');
  assert.equal(second.lease.position, 1);
  assert.equal(scheduler.releaseLease(first.lease.lease_id).ok, true);
  assert.equal(scheduler.getLease(second.lease.lease_id).state, 'active', 'the terminal lease freed its slot at once');
});

test('queued leases fail on cancel and on conversation deletion', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  requestLease(scheduler, { conversationKey: 'conv:p:1' });
  const a = requestLease(scheduler, { conversationKey: 'conv:p:2' });
  const b = requestLease(scheduler, { conversationKey: 'conv:p:3' });
  assert.equal(scheduler.cancelLease(a.lease.lease_id).lease.reason, 'cancelled');
  assert.equal(scheduler.cancelLease(b.lease.lease_id, { reason: 'conversation_deleted' }).lease.reason,
    'conversation_deleted');
  assert.equal(scheduler.getLease(a.lease.lease_id).state, 'failed');
  assert.equal(scheduler.getLease(b.lease.lease_id).state, 'failed');
});

test('an active lease is released, failed by a failed job, by pause with stop, and by cancel', () => {
  const { scheduler } = createScheduler();
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n', slots: 4 });
  const released = activeLease(scheduler, { conversationKey: 'conv:p:1' });
  assert.equal(scheduler.releaseLease(released.lease.lease_id).lease.state, 'released');

  const failedByJob = activeLease(scheduler, { conversationKey: 'conv:p:2' });
  const job = scheduler.createJob(failedByJob.lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  assert.equal(scheduler.claim(nodeId, 1).job.job_id, job.job_id);
  assert.equal(scheduler.failJob(job.job_id, nodeId, 'engine_error').ok, true);
  assert.deepEqual(pick(scheduler.getLease(failedByJob.lease.lease_id)), { state: 'failed', reason: 'engine_error' });

  const cancelled = activeLease(scheduler, { conversationKey: 'conv:p:3' });
  assert.equal(scheduler.cancelLease(cancelled.lease.lease_id).lease.state, 'failed');

  const stopped = activeLease(scheduler, { conversationKey: 'conv:p:4' });
  assert.equal(scheduler.setNodePaused(nodeId, { on: true, stopRunning: true }).ok, true);
  assert.deepEqual(pick(scheduler.getLease(stopped.lease.lease_id)), { state: 'failed', reason: 'user_stopped_sharing' });
});

test('pausing without stop keeps the running lease and takes the node out of choice', () => {
  const { scheduler } = createScheduler();
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n', slots: 2 });
  const running = activeLease(scheduler, { conversationKey: 'conv:p:1' });
  scheduler.setNodePaused(nodeId, { on: true, stopRunning: false });
  assert.equal(scheduler.getLease(running.lease.lease_id).state, 'active');
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:2' }).error.reason, 'no_eligible_node');
});

test('releasing a lease while its job is claimed is refused and changes nothing', () => {
  const { scheduler } = createScheduler();
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease } = activeLease(scheduler);
  scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') });
  scheduler.claim(nodeId, 1);
  const result = scheduler.releaseLease(lease.lease_id);
  assert.equal(result.ok, false);
  assert.equal(result.error.reason, 'lease_busy');
  assert.equal(scheduler.getLease(lease.lease_id).state, 'active');
});

test('a terminal lease refuses every further lease operation with a fixed reason', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease } = activeLease(scheduler);
  scheduler.releaseLease(lease.lease_id);
  const before = scheduler.getLease(lease.lease_id);
  for (const result of [
    scheduler.releaseLease(lease.lease_id),
    scheduler.cancelLease(lease.lease_id),
    scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }),
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'lease_not_active');
  }
  assert.deepEqual(scheduler.getLease(lease.lease_id), before);
  assert.equal(scheduler.releaseLease('lease_unknown').error.reason, 'lease_not_found');
});

// ---------------------------------------------------------------------------
// The job rows through the facade.

function setupJob({ slots = 1 } = {}) {
  const fx = createScheduler();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n', slots });
  const { lease, token } = activeLease(fx.scheduler);
  const job = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{"model":"alpha"}') }).job;
  return { ...fx, nodeId, lease, token, job };
}

function pick(view) {
  return { state: view.state, reason: view.reason };
}

test('a job is queued, claimed, streaming and done; the lease stays active for the next job', () => {
  const { scheduler, nodeId, lease, job } = setupJob();
  const seen = [];
  scheduler.watchJob(job.job_id, (event) => seen.push(event.type === 'data' ? event.bytes.toString() : event.state));
  assert.equal(job.state, 'queued');
  const claim = scheduler.claim(nodeId, 7);
  assert.deepEqual(Object.keys(claim.job).sort(),
    ['first_byte_ms', 'job_id', 'lease_id', 'model', 'request_bytes', 'stall_ms', 'total_ms']);
  assert.equal(claim.job.request_bytes, 17);
  assert.equal(scheduler.getJob(job.job_id).state, 'claimed');
  assert.deepEqual(scheduler.acceptChunk(job.job_id, nodeId, 0, sseData('{"a":1}'), false),
    { ok: true, next_seq: 1, cancel: false });
  assert.equal(scheduler.getJob(job.job_id).state, 'streaming');
  assert.equal(scheduler.acceptChunk(job.job_id, nodeId, 1, DONE_LINE, true).ok, true);
  assert.equal(scheduler.getJob(job.job_id).state, 'done');
  assert.deepEqual(seen, ['data: {"a":1}\n\n', 'data: [DONE]\n\n', 'done']);
  assert.equal(scheduler.getLease(lease.lease_id).state, 'active');
  assert.equal(scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).ok, true);
});

test('a final chunk with no [DONE] in the stream fails the job and its lease', () => {
  const { scheduler, nodeId, lease, job } = setupJob();
  scheduler.claim(nodeId, 1);
  scheduler.acceptChunk(job.job_id, nodeId, 0, sseData('{"a":1}'), false);
  scheduler.acceptChunk(job.job_id, nodeId, 1, Buffer.alloc(0), true);
  assert.deepEqual(pick(scheduler.getJob(job.job_id)), { state: 'failed', reason: 'stream_incomplete' });
  assert.equal(scheduler.getLease(lease.lease_id).state, 'failed');
});

test('the same claim_seq returns the same job; another claim_seq gets no job', () => {
  const { scheduler, nodeId, job } = setupJob();
  const first = scheduler.claim(nodeId, 4);
  assert.deepEqual(scheduler.claim(nodeId, 4), first);
  assert.equal(first.job.job_id, job.job_id);
  assert.deepEqual(scheduler.claim(nodeId, 5), { ok: true, job: null });
});

test('a wrong chunk sequence number is rejected without effect', () => {
  const { scheduler, nodeId, job } = setupJob();
  scheduler.claim(nodeId, 1);
  const seen = [];
  scheduler.watchJob(job.job_id, (event) => seen.push(event));
  for (const seq of [1, -1, 2]) {
    const result = scheduler.acceptChunk(job.job_id, nodeId, seq, sseData('x'), false);
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'node_chunk_seq_invalid');
    assert.equal(result.next_seq, 0);
  }
  assert.equal(scheduler.getJob(job.job_id).state, 'claimed');
  assert.equal(seen.length, 0);
  scheduler.acceptChunk(job.job_id, nodeId, 0, sseData('x'), false);
  const replay = scheduler.acceptChunk(job.job_id, nodeId, 0, sseData('x'), false);
  assert.equal(replay.error.reason, 'node_chunk_seq_invalid', 'a repeated seq is not applied twice');
  assert.equal(seen.length, 1);
});

test('a chunk from another node, for an unknown job or for a terminal job answers a bare refusal', () => {
  const { scheduler, nodeId, job } = setupJob();
  const other = registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_o' });
  scheduler.claim(nodeId, 1);
  assert.deepEqual(scheduler.acceptChunk(job.job_id, other, 0, sseData('x'), false), { ok: false });
  assert.deepEqual(scheduler.acceptChunk('job_unknown', nodeId, 0, sseData('x'), false), { ok: false });
  scheduler.cancelJob(job.job_id);
  assert.deepEqual(scheduler.acceptChunk(job.job_id, nodeId, 0, sseData('x'), false), { ok: false });
  assert.equal(scheduler.getJob(job.job_id).state, 'cancelled');
});

test('a node fail fails the claimed job and its lease; a bad reason is refused unchanged', () => {
  const { scheduler, nodeId, lease, job } = setupJob();
  scheduler.claim(nodeId, 1);
  assert.equal(scheduler.failJob(job.job_id, nodeId, 'because').error.reason, 'node_fail_reason_invalid');
  assert.equal(scheduler.getJob(job.job_id).state, 'claimed');
  scheduler.failJob(job.job_id, nodeId, 'engine_unreachable');
  assert.deepEqual(pick(scheduler.getJob(job.job_id)), { state: 'failed', reason: 'engine_unreachable' });
  assert.equal(scheduler.getLease(lease.lease_id).state, 'failed');
});

test('cancelling a claimed or streaming job cancels it and fails its lease', () => {
  for (const streaming of [false, true]) {
    const { scheduler, nodeId, lease, job } = setupJob();
    scheduler.claim(nodeId, 1);
    if (streaming) scheduler.acceptChunk(job.job_id, nodeId, 0, sseData('x'), false);
    assert.equal(scheduler.cancelJob(job.job_id).ok, true);
    assert.deepEqual(pick(scheduler.getJob(job.job_id)), { state: 'cancelled', reason: 'cancelled' });
    assert.deepEqual(pick(scheduler.getLease(lease.lease_id)), { state: 'failed', reason: 'cancelled' });
  }
});

test('cancelling a queued job ends its lease and fails the job as lease terminal', () => {
  const { scheduler, lease, job } = setupJob();
  scheduler.cancelJob(job.job_id);
  assert.deepEqual(pick(scheduler.getJob(job.job_id)), { state: 'failed', reason: 'cancelled' });
  assert.equal(scheduler.getLease(lease.lease_id).state, 'failed');
});

test('a lease holds one live job at a time', () => {
  const { scheduler, lease } = setupJob();
  const second = scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') });
  assert.equal(second.ok, false);
  assert.equal(second.error.reason, 'lease_busy');
});

test('the job request is fetchable by the claiming node until the first chunk', () => {
  const { scheduler, nodeId, job } = setupJob();
  const other = registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_o' });
  assert.equal(scheduler.jobRequest(job.job_id, nodeId).error.reason, 'job_not_found', 'not before the claim');
  scheduler.claim(nodeId, 1);
  assert.equal(scheduler.jobRequest(job.job_id, nodeId).request.toString(), '{"model":"alpha"}');
  assert.equal(scheduler.jobRequest(job.job_id, other).error.reason, 'job_not_found');
  scheduler.acceptChunk(job.job_id, nodeId, 0, sseData('x'), false);
  assert.equal(scheduler.jobRequest(job.job_id, nodeId).error.reason, 'job_not_found');
});

// ---------------------------------------------------------------------------
// Timed transitions through sweep: one millisecond before, then at the limit.

function sweepAt(fx, at) {
  return fx.scheduler.sweep(at);
}

test('queue wait: a queued lease fails with queue_timeout at 10 minutes', () => {
  const fx = createScheduler();
  const start = fx.clock();
  registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  activeLease(fx.scheduler, { conversationKey: 'conv:p:1' });
  const waiting = requestLease(fx.scheduler, { conversationKey: 'conv:p:2' }).lease;
  // Keep the node in contact so only the queue timer fires.
  for (let t = 20 * SECOND; t < 10 * MINUTE; t += 20 * SECOND) {
    fx.clock.set(start + t); fx.scheduler.touchNode(fx.scheduler.listNodes()[0].node_id);
  }
  assert.deepEqual(sweepAt(fx, start + 10 * MINUTE - 1).filter((t) => t.id === waiting.lease_id), []);
  const at = sweepAt(fx, start + 10 * MINUTE);
  assert.deepEqual(at.filter((t) => t.id === waiting.lease_id),
    [{ table: 'lease', id: waiting.lease_id, from: 'queued', to: 'failed', trigger: 'queue_timeout', reason: 'queue_timeout' }]);
});

test('node contact: an active lease with no job expires 30 s after the last node contact', () => {
  const fx = createScheduler();
  const start = fx.clock();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease } = activeLease(fx.scheduler);
  fx.clock.set(start + 10 * SECOND);
  fx.scheduler.touchNode(nodeId);
  assert.deepEqual(sweepAt(fx, start + 40 * SECOND - 1), []);
  const at = sweepAt(fx, start + 40 * SECOND);
  assert.ok(at.some((t) => t.id === lease.lease_id && t.to === 'expired' && t.trigger === 'node_contact_timeout'));
  assert.equal(fx.scheduler.listNodes()[0].online, false);
});

test('idle: an active lease with no job for 30 minutes expires', () => {
  const fx = createScheduler();
  const start = fx.clock();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease } = activeLease(fx.scheduler);
  for (let t = 20 * SECOND; t <= 30 * MINUTE; t += 20 * SECOND) {
    fx.clock.set(start + t); fx.scheduler.touchNode(nodeId);
  }
  assert.deepEqual(sweepAt(fx, start + 30 * MINUTE - 1), []);
  assert.deepEqual(sweepAt(fx, start + 30 * MINUTE).map((t) => [t.id, t.to, t.trigger]),
    [[lease.lease_id, 'expired', 'idle_timeout']]);
});

test('first byte: a claimed job with no data fails at 120 s and fails its lease', () => {
  const fx = setupJob();
  const start = fx.clock();
  fx.scheduler.claim(fx.nodeId, 1);
  for (let t = 10 * SECOND; t <= 120 * SECOND; t += 10 * SECOND) {
    fx.clock.set(start + t); fx.scheduler.acceptChunk(fx.job.job_id, fx.nodeId, t / (10 * SECOND) - 1, Buffer.alloc(0), false);
  }
  assert.equal(fx.scheduler.getJob(fx.job.job_id).state, 'claimed', 'pings do not count as the first byte');
  assert.deepEqual(sweepAt(fx, start + 120 * SECOND - 1), []);
  const at = sweepAt(fx, start + 120 * SECOND);
  assert.deepEqual(at.map((t) => [t.table, t.to, t.reason]),
    [['job', 'failed', 'first_byte_timeout'], ['lease', 'failed', 'first_byte_timeout']]);
});

test('stall: a streaming job with no data for 60 s fails with stall_timeout', () => {
  const fx = setupJob();
  const start = fx.clock();
  fx.scheduler.claim(fx.nodeId, 1);
  fx.scheduler.acceptChunk(fx.job.job_id, fx.nodeId, 0, sseData('x'), false);
  for (let t = 5 * SECOND; t <= 60 * SECOND; t += 5 * SECOND) {
    fx.clock.set(start + t); fx.scheduler.acceptChunk(fx.job.job_id, fx.nodeId, t / (5 * SECOND), Buffer.alloc(0), false);
  }
  assert.deepEqual(sweepAt(fx, start + 60 * SECOND - 1), []);
  assert.deepEqual(sweepAt(fx, start + 60 * SECOND).map((t) => [t.table, t.to, t.reason]),
    [['job', 'failed', 'stall_timeout'], ['lease', 'failed', 'stall_timeout']]);
});

test('job total: a streaming job fails with job_timeout at 30 minutes after its claim', () => {
  const fx = setupJob();
  const start = fx.clock();
  fx.scheduler.claim(fx.nodeId, 1);
  let seq = 0;
  for (let t = 0; t < 30 * MINUTE; t += 10 * SECOND) {
    fx.clock.set(start + t); fx.scheduler.acceptChunk(fx.job.job_id, fx.nodeId, seq, sseData('x'), false); seq += 1;
  }
  fx.clock.set(start + 30 * MINUTE - 1);
  assert.deepEqual(sweepAt(fx, start + 30 * MINUTE - 1), []);
  assert.deepEqual(sweepAt(fx, start + 30 * MINUTE).map((t) => [t.table, t.to, t.reason]),
    [['job', 'failed', 'job_timeout'], ['lease', 'failed', 'job_timeout']]);
});

test('never claimed: a queued job is re-queued once after 10 s, then fails at the 120 s wait', () => {
  const fx = setupJob();
  const start = fx.clock();
  const touch = (t) => { fx.clock.set(start + t); fx.scheduler.touchNode(fx.nodeId); };
  assert.deepEqual(sweepAt(fx, start + 10 * SECOND - 1), []);
  touch(10 * SECOND);
  assert.deepEqual(sweepAt(fx, start + 10 * SECOND).map((t) => [t.from, t.to, t.trigger]),
    [['queued', 'queued', 'requeued']]);
  touch(20 * SECOND);
  assert.deepEqual(sweepAt(fx, start + 20 * SECOND), [], 'only once');
  for (let t = 40 * SECOND; t < 120 * SECOND; t += 20 * SECOND) touch(t);
  assert.deepEqual(sweepAt(fx, start + 120 * SECOND - 1), []);
  assert.deepEqual(sweepAt(fx, start + 120 * SECOND).map((t) => [t.table, t.from, t.to, t.reason]),
    [['job', 'queued', 'failed', 'job_wait_timeout'], ['lease', 'active', 'failed', 'job_wait_timeout']]);
});

test('node lost: a claimed job fails with node_lost 30 s after the last contact', () => {
  const fx = setupJob();
  const start = fx.clock();
  fx.scheduler.claim(fx.nodeId, 1);
  assert.deepEqual(sweepAt(fx, start + 30 * SECOND - 1), []);
  assert.deepEqual(sweepAt(fx, start + 30 * SECOND).map((t) => [t.table, t.to, t.reason]),
    [['job', 'failed', 'node_lost'], ['lease', 'failed', 'node_lost']]);
});

test('a terminal lease frees its slot at once and disappears after 10 minutes', () => {
  const fx = createScheduler();
  const start = fx.clock();
  registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease } = activeLease(fx.scheduler);
  fx.scheduler.releaseLease(lease.lease_id);
  assert.equal(fx.scheduler.listNodes()[0].busy_slots, 0);
  fx.scheduler.sweep(start + 10 * MINUTE - 1);
  assert.equal(fx.scheduler.getLease(lease.lease_id).state, 'released');
  fx.scheduler.sweep(start + 10 * MINUTE);
  assert.equal(fx.scheduler.getLease(lease.lease_id), null);
});

// ---------------------------------------------------------------------------
// The route token.

test('the token resolves only while its lease is active and never appears in a listing, log or error', () => {
  const fx = createScheduler();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease, token } = activeLease(fx.scheduler);
  assert.equal(fx.scheduler.resolveToken(token).lease.lease_id, lease.lease_id);
  assert.equal(fx.scheduler.resolveToken(token).status, 'active');
  assert.equal(fx.scheduler.resolveToken(`${token.slice(0, -1)}A`), null);
  assert.equal(fx.scheduler.resolveToken(''), null);
  assert.equal(fx.scheduler.resolveToken(42), null);
  const job = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  fx.scheduler.claim(nodeId, 1);
  const failures = [
    fx.scheduler.failJob(job.job_id, nodeId, 'bogus'),
    fx.scheduler.releaseLease(lease.lease_id),
    fx.scheduler.acceptChunk(job.job_id, nodeId, 9, Buffer.alloc(0), false),
  ];
  const listings = [fx.scheduler.listLeases(), fx.scheduler.listNodes(), fx.scheduler.getLease(lease.lease_id),
    fx.scheduler.getJob(job.job_id), fx.scheduler.poolSummary(), fx.scheduler.claim(nodeId, 1)];
  fx.scheduler.cancelLease(lease.lease_id);
  assert.equal(fx.scheduler.resolveToken(token).status, 'inactive', 'revoked when the lease leaves active');
  assert.deepEqual(fx.scheduler.resolveToken(token), { status: 'inactive' });
  fx.scheduler.sweep(fx.clock() + 10 * MINUTE);
  assert.equal(fx.scheduler.resolveToken(token), null, 'forgotten with the purged lease');
  const everything = JSON.stringify([failures, listings, fx.changes, fx.logger.calls]);
  assert.equal(everything.includes(token), false);
  assert.equal(everything.includes(Buffer.from(token, 'base64url').toString('hex')), false);
});

test('a queued lease has no token to take', () => {
  const fx = createScheduler();
  registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  activeLease(fx.scheduler, { conversationKey: 'conv:p:1' });
  const waiting = requestLease(fx.scheduler, { conversationKey: 'conv:p:2' }).lease;
  assert.equal(fx.scheduler.takeRouteToken(waiting.lease_id).error.reason, 'lease_not_active');
  assert.equal(fx.scheduler.takeRouteToken('lease_nope').error.reason, 'lease_not_found');
});

// ---------------------------------------------------------------------------
// Bounds.

test('the 33rd queued turn is pool_queue_full', () => {
  const fx = createScheduler();
  registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  activeLease(fx.scheduler, { conversationKey: 'conv:p:0' });
  for (let i = 1; i <= 32; i += 1) {
    assert.equal(requestLease(fx.scheduler, { conversationKey: `conv:p:${i}` }).lease.state, 'queued');
  }
  const refused = requestLease(fx.scheduler, { conversationKey: 'conv:p:33' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.reason, 'pool_queue_full');
  assert.equal(fx.scheduler.listLeases().filter((l) => l.state === 'queued').length, 32);
});

test('slots are 1 to 4: a fifth slot and zero slots are refused; models are at most 64', () => {
  const { scheduler } = createScheduler();
  for (const slots of [0, 5, 1.5, '2']) {
    const result = scheduler.registerNode({ deviceId: 'device_1', memberId: 'member_n', slots, models: [model('a')] });
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'node_slots_exceeded');
  }
  const many = Array.from({ length: 65 }, (_, i) => model(`m${i}`));
  assert.equal(scheduler.registerNode({ deviceId: 'device_1', memberId: 'member_n', slots: 1, models: many })
    .error.reason, 'node_protocol_invalid');
  assert.equal(scheduler.registerNode({ deviceId: 'device_1', memberId: 'member_n', slots: 1,
    models: many.slice(0, 64) }).ok, true);
  assert.equal(scheduler.listNodes().length, 1);
});

test('nodes from at most 8 members; a ninth member is refused', () => {
  const { scheduler } = createScheduler();
  for (let i = 0; i < 8; i += 1) registerNode(scheduler, { deviceId: `device_${i}`, memberId: `member_${i}` });
  const ninth = scheduler.registerNode({ deviceId: 'device_9', memberId: 'member_9', slots: 1, models: [model('a')] });
  assert.equal(ninth.error.reason, 'node_limit_reached');
  assert.equal(registerNode(scheduler, { deviceId: 'device_x', memberId: 'member_0' }).startsWith('node_'), true,
    'a known member may add a second device');
});

test('re-registering the same device keeps its node id and updates its inventory', () => {
  const { scheduler } = createScheduler();
  const first = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n', models: [model('alpha')] });
  const second = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n', models: [model('beta')] });
  assert.equal(second, first);
  assert.deepEqual(scheduler.listNodes()[0].models.map((m) => m.id), ['beta']);
  const other = scheduler.registerNode({ deviceId: 'device_1', memberId: 'member_z', slots: 1, models: [model('a')] });
  assert.equal(other.error.reason, 'node_not_found', 'a device id is bound to its member');
});

test('chunk, line, job and request bounds', () => {
  const fx = createScheduler();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n', slots: 4 });
  const { lease } = activeLease(fx.scheduler, { conversationKey: 'conv:p:r' });
  const tooLarge = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.alloc(8 * 1024 * 1024 + 1) });
  assert.equal(tooLarge.error.reason, 'job_request_too_large');
  assert.equal(fx.scheduler.getLease(lease.lease_id).state, 'active', 'a refused request changes nothing');

  const chunkJob = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  fx.scheduler.claim(nodeId, 1);
  const overChunk = fx.scheduler.acceptChunk(chunkJob.job_id, nodeId, 0, Buffer.alloc(64 * 1024 + 1, 0x61), false);
  assert.equal(overChunk.error.reason, 'node_chunk_too_large');
  assert.equal(fx.scheduler.getJob(chunkJob.job_id).state, 'claimed');

  // A line over 1 MiB, sent in 64 KiB pieces with no line end, fails the job.
  let seq = 0;
  let result;
  for (let sent = 0; sent <= 1024 * 1024; sent += 64 * 1024) {
    result = fx.scheduler.acceptChunk(chunkJob.job_id, nodeId, seq, Buffer.alloc(64 * 1024, 0x61), false);
    seq += 1;
  }
  assert.deepEqual(result, { ok: true, next_seq: seq, cancel: true });
  assert.deepEqual(pick(fx.scheduler.getJob(chunkJob.job_id)), { state: 'failed', reason: 'frame_too_large' });

  // A job total over 32 MiB in short lines fails with output_too_large.
  const fy = createScheduler();
  const nodeY = registerNode(fy.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const leaseY = activeLease(fy.scheduler).lease;
  const jobY = fy.scheduler.createJob(leaseY.lease_id, { requestBytes: Buffer.from('{}') }).job;
  fy.scheduler.claim(nodeY, 1);
  const piece = Buffer.alloc(64 * 1024, 0x0a);
  let last;
  for (let i = 0; i <= 512; i += 1) last = fy.scheduler.acceptChunk(jobY.job_id, nodeY, i, piece, false);
  assert.equal(last.cancel, true);
  assert.deepEqual(pick(fy.scheduler.getJob(jobY.job_id)), { state: 'failed', reason: 'output_too_large' });
});
