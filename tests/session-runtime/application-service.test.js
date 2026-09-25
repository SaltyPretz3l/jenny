'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  RuntimeApplicationService,
} = require('../../services/session-runtime/application-service');
const {
  RuntimeLaneAdmission,
  captureRuntimeRoute,
} = require('../../services/session-runtime/lanes');
const {
  ResourceBroker,
  capacityResource,
} = require('../../services/session-runtime/resource-broker');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function idFactory() {
  let sequence = 0;
  return prefix => `${prefix}_${++sequence}`;
}

function clock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 10, 12, 0, tick++));
}

function authority(projectId, suffix = '1') {
  return {
    project_id: projectId,
    root_path: `G:\\private-${suffix}`,
    root_id: `root_${suffix}`,
    root_revision: Number(suffix),
    device_id: `device_${suffix}`,
    inode: `inode_${suffix}`,
  };
}

function submit(store, suffix, overrides = {}) {
  const projectId = overrides.projectId || `project_${suffix}`;
  return store.submit({
    idempotencyKey: `secret_idempotency_${suffix}`,
    projectId,
    sessionId: overrides.sessionId || `session_${suffix}`,
    purpose: 'chat',
    input: { prompt: `super-secret-prompt-${suffix}`, numeric: 1.0 },
    authority: authority(projectId, suffix),
    workId: `work_${suffix}`,
    turnId: `turn_${suffix}`,
  }).record;
}

function runtimeFor(store, { enabled = false, closing = false } = {}) {
  const limits = {
    local: { runnable_turns: 4, inference_requests: 6, descendants: 8, descendant_depth: 2 },
    cloud: { runnable_turns: 2, inference_requests: 4, descendants: 0, descendant_depth: 0 },
    resources: { tool_operations: 4, native_processes: 3, tests: 2 },
  };
  const lanes = new RuntimeLaneAdmission({
    limits,
    maxRunnableTurns: 3,
    maxInferenceRequests: 5,
    createId: () => 'secret_lane_lease',
  });
  const resourceBroker = new ResourceBroker({
    limits: limits.resources,
    createId: () => 'secret_resource_lease',
    now: () => 10,
  });
  const scheduler = {
    enabled,
    closing,
    tryDispatch() { throw new Error('dispatch must not run during inspection'); },
    pump() { throw new Error('pump must not run during inspection'); },
  };
  return { store, lanes, resourceBroker, scheduler };
}

function createStore(prefix = 'jenny-runtime-application-') {
  return new RuntimeStore(createTrackedTempDir(prefix), {
    createId: idFactory(),
    now: clock(),
  });
}

test('snapshot pages safe summaries using listSummaries without record, transcript, or dispatch reads', () => {
  const store = createStore();
  submit(store, '1');
  submit(store, '2');
  const runtime = runtimeFor(store);
  runtime.lanes.tryAcquireTurn({
    sessionId: 'active_session',
    route: captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'private_provider',
      configuration_revision: 'revision_1', requires_gpu: true, resource_class: 'local' }),
  });
  runtime.resourceBroker.tryAcquire({
    ownerId: 'secret_resource_owner',
    resources: [capacityResource('tool_operations')],
  });
  store.get = undefined;
  Object.defineProperty(runtime, 'conversationStore', {
    get() { throw new Error('transcript reads are forbidden'); },
  });
  const service = new RuntimeApplicationService({ getRuntime: () => runtime });

  const result = service.getSnapshot({ limit: 1 });

  assert.deepEqual(Object.keys(result), [
    'ok', 'schema_version', 'enabled', 'closing', 'read_only', 'revision',
    'lanes', 'resources', 'work', 'next_cursor',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 1);
  assert.equal(result.enabled, false);
  assert.equal(result.work.length, 1);
  assert.equal(typeof result.next_cursor, 'string');
  assert.deepEqual(result.lanes.downstream_limits, {
    runnable_turns: 3,
    inference_requests: 5,
  });
  assert.deepEqual(result.lanes.effective_limits.local, {
    runnable_turns: 3,
    inference_requests: 5,
    descendants: 8,
    descendant_depth: 2,
  });
  assert.deepEqual(result.lanes.effective_limits.cloud, {
    runnable_turns: 2,
    inference_requests: 4,
    descendants: 0,
    descendant_depth: 0,
  });
  assert.deepEqual(result.resources.configured_limits, {
    tool_operations: 4,
    native_processes: 3,
    tests: 2,
  });
  assert.deepEqual(result.resources.effective_limits, {
    tool_operations: 4,
    native_processes: 3,
    tests: 2,
    sandbox_commands: 1,
  });
  assert.equal(result.lanes.counts.active_leases, 1);
  assert.equal(result.resources.counts.lease_count, 1);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'super-secret', 'secret_idempotency', 'private-1', 'secret_lane_lease',
    'secret_resource_lease', 'secret_resource_owner',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('restart exposes recovered paging and rejects stale or scope-mismatched cursors', () => {
  const root = createTrackedTempDir('jenny-runtime-application-paging-');
  const store = new RuntimeStore(root, { createId: idFactory(), now: clock() });
  submit(store, '1', { projectId: 'project_shared' });
  submit(store, '2', { projectId: 'project_shared' });
  submit(store, '3', { projectId: 'project_other' });
  const firstService = new RuntimeApplicationService({ getRuntime: () => runtimeFor(store) });
  const first = firstService.getSnapshot({ project_id: 'project_shared', limit: 1 });
  assert.equal(first.work.length, 1);

  const reopened = new RuntimeStore(root, { createId: idFactory(), now: clock() });
  const service = new RuntimeApplicationService({ getRuntime: () => runtimeFor(reopened) });
  assert.equal(service.getSnapshot({
    project_id: 'project_shared', cursor: first.next_cursor,
  }).error.code, 'CMP-RUNTIME-0006');
  const restartedFirst = service.getSnapshot({ project_id: 'project_shared', limit: 1 });
  const second = service.getSnapshot({
    project_id: 'project_shared',
    cursor: restartedFirst.next_cursor,
    limit: 1,
  });
  assert.equal(second.ok, true);
  assert.equal(second.work.length, 1);
  assert.equal(second.next_cursor, null);
  assert.equal(service.getSnapshot({
    project_id: 'project_other', cursor: restartedFirst.next_cursor,
  }).error.code, 'CMP-RUNTIME-0003');

  submit(reopened, '4');
  assert.deepEqual(service.getSnapshot({
    project_id: 'project_shared', cursor: restartedFirst.next_cursor,
  }), {
    ok: false,
    error: { code: 'CMP-RUNTIME-0006', reason: 'runtime_snapshot_cursor_stale' },
  });
});

test('work detail projects attempt and recovery state without durable private content', () => {
  const root = createTrackedTempDir('jenny-runtime-application-work-');
  const store = new RuntimeStore(root, { createId: idFactory(), now: clock() });
  let record = submit(store, '1');
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'private_authority_revision' };
  record = store.transition(record.work_id, { expectedRevision: record.revision,
    to: 'running', reason: 'started', attempt }).record;
  record = store.requestPause(record.work_id, { expectedRevision: record.revision,
    expectedAttempt: attempt, reason: 'private pause explanation' }).record;
  const pausedIntent = new RuntimeApplicationService({ getRuntime: () => runtimeFor(store) })
    .getWork({ work_id: record.work_id });
  assert.deepEqual(pausedIntent.work.control, { kind: 'pause', requested_at: record.control_request.requested_at });
  assert.equal(JSON.stringify(pausedIntent).includes('private pause explanation'), false);
  record = store.transition(record.work_id, { expectedRevision: record.revision,
    expectedAttempt: attempt, to: 'paused', reason: 'resource_wait', checkpointRef: {
      schema_version: 1, checkpoint_id: 'checkpoint_1', sha256: 'a'.repeat(64), bytes: 321,
      source_attempt: attempt,
    } }).record;
  record = store.requestCancellation(record.work_id, { expectedRevision: record.revision,
    expectedAttempt: attempt, reason: 'private cancellation explanation' }).record;
  const service = new RuntimeApplicationService({ getRuntime: () => runtimeFor(store) });

  const result = service.getWork({ work_id: record.work_id });

  assert.deepEqual(result.work.attempt, {
    attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
  });
  assert.deepEqual(result.work.checkpoint, { recorded: true, bytes: 321 });
  assert.deepEqual(result.work.control, { kind: 'cancel', requested_at: record.control_request.requested_at });
  assert.equal(result.work.recovery, null);
  assert.deepEqual(Object.keys(result.work), [
    'work_id', 'project_id', 'session_id', 'turn_id', 'purpose', 'status', 'revision',
    'submission_sequence', 'created_at', 'updated_at', 'attempt', 'checkpoint', 'control', 'recovery',
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'super-secret-prompt', 'secret_idempotency', 'private-1', 'private_authority_revision',
    'private cancellation explanation', 'checkpoint_1', 'aaaaaaaa',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test('pause answers "requested" for a running turn and pauses queued work outright', () => {
  const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
  const store = createStore('jenny-runtime-application-pause-');
  const queued = submit(store, '1');
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'private_authority_revision' };
  const started = submit(store, '2');
  const live = store.transition(started.work_id, { expectedRevision: started.revision,
    to: 'running', reason: 'started', attempt }).record;
  const scheduler = new SessionRuntimeScheduler({
    store,
    lanes: new RuntimeLaneAdmission({ limits: { local: { runnable_turns: 1, inference_requests: 1,
      descendants: 0, descendant_depth: 0 } }, maxRunnableTurns: 1, maxInferenceRequests: 1 }),
    resolveRoute: () => null,
    validateWork: () => true,
    claimCanonical: () => true,
    startProducer: () => true,
    pauseProducer: () => true,
  });
  scheduler.active.set(live.work_id, { work: live, attempt: live.attempt });
  const runtime = { ...runtimeFor(store), pause: (workId, options) => scheduler.requestPause(workId, options) };
  const service = new RuntimeApplicationService({ getRuntime: () => runtime });

  // A running turn keeps its actor and lane: the intent is persisted and the
  // request settles later, at the runtime's own boundary.
  assert.deepEqual(service.pause({ work_id: live.work_id, expected_revision: live.revision }),
    { ok: true, work_id: live.work_id, status: 'requested' });
  assert.deepEqual(store.get(live.work_id).control_request.kind, 'pause');
  assert.equal(store.get(live.work_id).status, 'running');

  // Queued work never started, so it pauses at once.
  assert.deepEqual(service.pause({ work_id: queued.work_id, expected_revision: queued.revision }),
    { ok: true, work_id: queued.work_id, status: 'paused' });
  assert.equal(store.get(queued.work_id).status, 'paused');

  assert.deepEqual(service.pause({ work_id: queued.work_id, expected_revision: queued.revision }),
    { ok: false, error: { code: 'CMP-RUNTIME-0006', reason: 'revision_conflict' } });
  assert.deepEqual(service.pause({ work_id: 'work_missing', expected_revision: 1 }),
    { ok: false, error: { code: 'CMP-RUNTIME-0006', reason: 'revision_conflict' } });
});

test('restart recovery remains inspectable as bounded state without its raw reason', () => {
  const root = createTrackedTempDir('jenny-runtime-application-recovery-');
  const store = new RuntimeStore(root, { createId: idFactory(), now: clock() });
  const pending = submit(store, '1');

  const reopened = new RuntimeStore(root, { createId: idFactory(), now: clock() });
  const service = new RuntimeApplicationService({ getRuntime: () => runtimeFor(reopened) });
  const result = service.getWork({ work_id: pending.work_id });

  assert.equal(result.work.status, 'paused');
  assert.deepEqual(result.work.recovery, {
    kind: 'restart_paused',
    previous_status: 'pending',
    at: reopened.get(pending.work_id).recovery.at,
  });
  assert.equal(Object.hasOwn(result.work.recovery, 'reason'), false);
});

test('future and malformed stores remain safely inspectable as read-only empty snapshots', () => {
  for (const [name, body] of [
    ['future', JSON.stringify({ schema_version: 2 })],
    ['malformed', '{not-json'],
  ]) {
    const root = createTrackedTempDir(`jenny-runtime-application-${name}-`);
    fs.writeFileSync(path.join(root, 'index.json'), body);
    const store = new RuntimeStore(root);
    const result = new RuntimeApplicationService({
      getRuntime: () => runtimeFor(store),
    }).getSnapshot();
    assert.equal(result.ok, true, name);
    assert.equal(result.read_only, true, name);
    assert.equal(result.revision, 0, name);
    assert.deepEqual(result.work, [], name);
  }
});

test('requests are closed, bounded, late-bound, and return stable errors without caught messages', () => {
  let runtime = null;
  const service = new RuntimeApplicationService({ getRuntime: () => runtime });
  assert.deepEqual(service.getSnapshot(), {
    ok: false,
    error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_unavailable' },
  });
  assert.equal(service.getSnapshot({ unknown: true }).error.code, 'CMP-RUNTIME-0003');
  assert.equal(service.getSnapshot({ limit: 101 }).error.code, 'CMP-RUNTIME-0003');
  assert.equal(service.getSnapshot({ cursor: '%%%not-a-cursor%%%' }).error.code, 'CMP-RUNTIME-0003');
  assert.equal(service.getWork({ work_id: 'work_1', extra: true }).error.code, 'CMP-RUNTIME-0003');

  const store = createStore();
  runtime = runtimeFor(store, { enabled: false, closing: true });
  const off = service.getSnapshot({});
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);
  assert.equal(off.closing, true);
  assert.equal(service.getWork({ work_id: 'missing_work' }).error.code, 'CMP-RUNTIME-0004');

  store.get = () => { throw new Error('private C:\\profile\\runtime failure'); };
  const unavailable = service.getWork({ work_id: 'work_1' });
  assert.deepEqual(unavailable, {
    ok: false,
    error: { code: 'CMP-RUNTIME-0005', reason: 'runtime_inspection_unavailable' },
  });
  assert.equal(JSON.stringify(unavailable).includes('private'), false);
});

/* Runtime UX A1 (JEN-048): a refused submission must name a reason the
 * composer can explain. The passthrough is a closed allowlist, so an
 * unrecognised internal failure still collapses to the opaque reason. */

const { SessionRuntimeService } = require('../../services/session-runtime/service');

const SUBMISSION_PAYLOAD = Object.freeze({
  session_id: 'session_1', idempotency_key: 'send_1', prompt: 'hello',
});

function closedRuntime(store, { enabled = false, closing = false } = {}) {
  return new SessionRuntimeService({
    store,
    scheduler: { enabled, closing },
    chatAdapter: { prepareImmediate() { throw new Error('immediate start must not run'); } },
  });
}

test('a closed runtime hands its own refusal reason back to the composer', async () => {
  const store = createStore('jenny-runtime-application-submit-');
  for (const [reason, options] of [
    ['runtime_closing', { closing: true }],
    ['runtime_disabled', { enabled: false }],
  ]) {
    const runtime = closedRuntime(store, options);
    const service = new RuntimeApplicationService({ getRuntime: () => runtime });
    const result = await service.submit({ ...SUBMISSION_PAYLOAD });
    assert.equal(result.ok, false, reason);
    assert.equal(result.acceptance, 'rejected', reason);
    assert.equal(result.error.reason, reason);
    assert.equal(result.error.code, 'CMP-RUNTIME-0005', reason);
  }
});

test('the refusal passthrough is a closed allowlist, not the raw failure text', async () => {
  const store = createStore('jenny-runtime-application-submit-closed-');
  const passthrough = [
    'runtime_closing', 'runtime_disabled', 'runtime_submission_capacity', 'host_pending_capacity',
    'project_pending_capacity', 'session_pending_capacity', 'pending_input_capacity',
    'runtime_transcript_cache_pressure', 'session_busy',
  ];
  for (const code of passthrough) {
    const runtime = { store, submit: async () => { throw Object.assign(new Error(code), { code, submissionOutcome: 'rejected' }); } };
    const result = await new RuntimeApplicationService({ getRuntime: () => runtime }).submit({ ...SUBMISSION_PAYLOAD });
    assert.equal(result.error.reason, code, code);
  }
  for (const code of passthrough) {
    /* _assertSubmissionOpen throws plain Errors whose MESSAGE carries the code. */
    const runtime = { store, submit: async () => { throw Object.assign(new Error(code), { submissionOutcome: 'rejected' }); } };
    const result = await new RuntimeApplicationService({ getRuntime: () => runtime }).submit({ ...SUBMISSION_PAYLOAD });
    assert.equal(result.error.reason, code, `${code} (message only)`);
  }
  for (const thrown of [
    Object.assign(new Error('private C:\\profile\\runtime failure'), { submissionOutcome: 'rejected' }),
    Object.assign(new Error('bespoke_internal_failure'), { code: 'bespoke_internal_failure' }),
  ]) {
    const runtime = { store, submit: async () => { throw thrown; } };
    const result = await new RuntimeApplicationService({ getRuntime: () => runtime }).submit({ ...SUBMISSION_PAYLOAD });
    assert.equal(result.error.reason, 'runtime_submission_refused');
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('the refusal reason never changes the acceptance verdict', async () => {
  const store = createStore('jenny-runtime-application-submit-acceptance-');
  const unknown = { store, submit: async () => { throw Object.assign(new Error('runtime_closing'), { code: 'runtime_closing' }); } };
  const unknownResult = await new RuntimeApplicationService({ getRuntime: () => unknown }).submit({ ...SUBMISSION_PAYLOAD });
  assert.equal(unknownResult.acceptance, 'unknown', 'no submissionOutcome means the outcome stays unknown');
  assert.equal(unknownResult.error.reason, 'runtime_closing');

  const conflict = { store, submit: async () => { throw Object.assign(new Error('idempotency_conflict'), { code: 'idempotency_conflict' }); } };
  const conflictResult = await new RuntimeApplicationService({ getRuntime: () => conflict }).submit({ ...SUBMISSION_PAYLOAD });
  assert.equal(conflictResult.acceptance, 'unknown');
  assert.equal(conflictResult.error.reason, 'idempotency_conflict');
  assert.equal(conflictResult.error.code, 'CMP-RUNTIME-0006');
});
