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
const { RuntimeProjectionError, projectWorkRecord } = require('../../services/session-runtime/projections');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
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
  assert.equal(result.work[0].admission_wait, null);
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
    'submission_sequence', 'created_at', 'updated_at', 'admission_wait', 'resumable', 'prompt_preview', 'attempt', 'checkpoint',
    'control', 'recovery',
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'super-secret-prompt', 'secret_idempotency', 'private-1', 'private_authority_revision',
    'private cancellation explanation', 'checkpoint_1', 'aaaaaaaa',
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

// FG-007: a restored paused send names what Resume would send. The preview is
// derived from the visible prompt on the work read; snapshot rows stay
// prompt-free (a paused row reads its record only for the `resumable` boolean).
test('work detail carries a short single-line visible-prompt preview and snapshot rows stay record-free', () => {
  const store = createStore();
  const submitPrompt = (suffix, request) => store.submit({ idempotencyKey: `preview_key_${suffix}`,
    projectId: 'project_p', sessionId: 'session_p', purpose: 'chat', input: { request },
    authority: authority('project_p', '7'), workId: `work_p${suffix}`, turnId: `turn_p${suffix}` }).record;
  const long = submitPrompt('1', { visiblePrompt: `Reconcile   the March\nstatement\t\u0000against the ledger ${'x'.repeat(200)}`,
    prompt: 'expanded-hidden-prompt' });
  const short = submitPrompt('2', { visiblePrompt: '  Continue G1  ' });
  const emoji = submitPrompt('3', { visiblePrompt: `${'a'.repeat(118)}\u{1F600}\u{1F600}tail` });
  const hidden = submitPrompt('4', { prompt: 'only-an-expanded-prompt' });
  const blank = submitPrompt('5', { visiblePrompt: ' \n\t ' });
  const service = new RuntimeApplicationService({ getRuntime: () => runtimeFor(store) });
  const preview = record => service.getWork({ work_id: record.work_id }).work.prompt_preview;

  assert.equal(preview(long), `Reconcile the March statement against the ledger ${'x'.repeat(70)}…`);
  assert.equal([...preview(long)].length, 120);
  assert.equal(preview(short), 'Continue G1');
  assert.equal(preview(emoji), `${'a'.repeat(118)}\u{1F600}…`, 'a cut never splits a surrogate pair');
  assert.equal(preview(hidden), null, 'the expanded model prompt is never previewed');
  assert.equal(preview(blank), null);
  assert.equal(JSON.stringify(service.getWork({ work_id: long.work_id })).includes('expanded-hidden-prompt'), false);
  store.get = undefined;
  const snapshot = service.getSnapshot({});
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.work.some(row => Object.hasOwn(row, 'prompt_preview')), false);
});

test('quarantined lane cleanup is projected until backend-restart reclaim dispatches pending work', async () => {
  const store = createStore('jenny-runtime-application-admission-wait-');
  const lanes = new RuntimeLaneAdmission({ now: () => Date.UTC(2026, 8, 10, 12, 30) });
  const route = captureRuntimeRoute({ engine_type: 'ollama', provider_id: 'ollama',
    configuration_revision: 'revision_1', requires_gpu: true, resource_class: 'local' });
  const producerCalls = [];
  const scheduler = new SessionRuntimeScheduler({ store, lanes, resolveRoute: () => route,
    validateWork: () => {}, claimCanonical: work => ({ streamId: `stream_${work.work_id}`,
      authorityRevision: 'authority_1', rollbackBeforeStart: () => true, assertCurrent: () => {} }),
    startProducer: () => new Promise((resolve, reject) => producerCalls.push({ resolve, reject })) });
  const resourceBroker = new ResourceBroker();
  const runtime = { store, lanes, resourceBroker, scheduler };
  const service = new RuntimeApplicationService({ getRuntime: () => runtime });
  const active = submit(store, '1', { sessionId: 'session_shared' });
  const started = scheduler.tryDispatch(active.work_id);
  await Promise.resolve();
  producerCalls[0].reject(new Error('sidecar exited'));
  await started.completion;

  const pending = submit(store, '2', { sessionId: 'session_shared' });
  assert.equal(scheduler.tryDispatch(pending.work_id).reason, 'session_busy');
  const expected = { reason: 'cleanup_unconfirmed', since: '2026-09-10T12:30:00.000Z',
    blocking_session_id: 'session_shared' };
  assert.deepEqual(service.getSnapshot().work.find(item => item.work_id === pending.work_id).admission_wait,
    expected);
  assert.deepEqual(service.getWork({ work_id: pending.work_id }).work.admission_wait, expected);

  scheduler.reclaimAbandoned({ reason: 'backend_restart' });
  const [resumed] = scheduler.pump();
  assert.equal(resumed.status, 'started');
  assert.equal(service.getSnapshot().work.find(item => item.work_id === pending.work_id).admission_wait, null);
  assert.equal(service.getWork({ work_id: pending.work_id }).work.admission_wait, null);
  await Promise.resolve();
  producerCalls[1].resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
  await resumed.completion;
});

test('invalid scheduler admission waits fail closed while absent or throwing access projects null', () => {
  const store = createStore('jenny-runtime-application-admission-validation-');
  const work = submit(store, '1');
  const runtime = runtimeFor(store);
  const service = new RuntimeApplicationService({ getRuntime: () => runtime });
  for (const invalidWait of [
    { reason: 'unknown', since: 1, blocking_session_id: null },
    { reason: 'session_busy', since: Number.NaN, blocking_session_id: null },
    { reason: 'model_busy', since: 1, blocking_session_id: 'not valid' },
  ]) {
    runtime.scheduler.admissionWait = () => invalidWait;
    assert.equal(service.getWork({ work_id: work.work_id }).error.reason, 'runtime_projection_unavailable');
  }
  runtime.scheduler.admissionWait = () => { throw new Error('inspection failed'); };
  assert.equal(service.getWork({ work_id: work.work_id }).work.admission_wait, null);
  delete runtime.scheduler.admissionWait;
  assert.equal(service.getWork({ work_id: work.work_id }).work.admission_wait, null);
});

test('pause answers "requested" for a running turn and pauses queued work outright', () => {
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

// Owner gate P4: the chat-turn admission refusal while an image render holds
// the GPU (`gpu_busy_plugin`) reaches the composer by name, so it can say why.
test('a submission refused because the GPU is leased to an image render keeps its reason', async () => {
  const store = createStore('jenny-runtime-application-submit-gpu-');
  const runtime = { store, submit: async () => { throw Object.assign(new Error('A privileged local workload is using the GPU.'), { code: 'gpu_busy_plugin', submissionOutcome: 'rejected' }); } };
  const result = await new RuntimeApplicationService({ getRuntime: () => runtime }).submit({ ...SUBMISSION_PAYLOAD });
  assert.equal(result.acceptance, 'rejected');
  assert.equal(result.error.reason, 'gpu_busy_plugin');
  assert.equal(JSON.stringify(result).includes('privileged'), false);
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

// 2026-10-05 live recheck: the queue strip offered Resume on restart-paused
// work the scheduler refuses (runtime_checkpoint_required). Every summary now
// carries the scheduler's own answer; a paused row costs one record read and
// still carries no prompt.
test('snapshot rows say whether paused work can resume, by the scheduler rule', () => {
  const root = createTrackedTempDir('jenny-runtime-application-resumable-');
  const store = new RuntimeStore(root, { createId: idFactory(), now: clock() });
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'private_authority_revision' };
  const move = (record, options) => store.transition(record.work_id, { expectedRevision: record.revision, ...options }).record;
  // (a) was running, no checkpoint: the restart below pauses it with nothing to continue from.
  move(submit(store, '1'), { to: 'running', reason: 'started', attempt });
  // (b) paused on a checkpoint written by its own attempt.
  move(move(submit(store, '2'), { to: 'running', reason: 'started', attempt }), { to: 'paused',
    reason: 'resource_wait', expectedAttempt: attempt, checkpointRef: { schema_version: 1,
      checkpoint_id: 'checkpoint_2', sha256: 'b'.repeat(64), bytes: 64, source_attempt: attempt } });
  // (c) never attempted: the restart pauses it and it resumes from its prompt.
  submit(store, '3');
  const reopened = new RuntimeStore(root, { createId: idFactory(), now: clock() });
  // (d) still pending.
  submit(reopened, '4');
  const scheduler = new SessionRuntimeScheduler({
    store: reopened,
    lanes: new RuntimeLaneAdmission({ limits: { local: { runnable_turns: 1, inference_requests: 1,
      descendants: 0, descendant_depth: 0 } }, maxRunnableTurns: 1, maxInferenceRequests: 1 }),
    resolveRoute: () => null, validateWork: () => true, claimCanonical: () => true,
    startProducer: () => true, pauseProducer: () => true,
  });
  const inspection = runtimeFor(reopened);
  const runtime = { ...inspection, scheduler: { ...inspection.scheduler, canResume: work => scheduler.canResume(work) } };
  const service = new RuntimeApplicationService({ getRuntime: () => runtime });
  const expected = { work_1: false, work_2: true, work_3: true, work_4: null };

  for (const request of [{ limit: 100 }, { view: 'runs', limit: 100, finished_since: '2026-09-10T00:00:00.000Z' }]) {
    const result = service.getSnapshot(request);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(Object.fromEntries(result.work.map(row => [row.work_id, row.resumable])), expected, JSON.stringify(request));
    assert.deepEqual(Object.fromEntries(result.work.map(row => [row.work_id, row.status])),
      { work_1: 'paused', work_2: 'paused', work_3: 'paused', work_4: 'pending' });
    const serialized = JSON.stringify(result);
    for (const forbidden of ['super-secret-prompt', 'private_authority_revision', 'checkpoint_2']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  }
  for (const [workId, resumable] of Object.entries(expected)) {
    assert.equal(service.getWork({ work_id: workId }).work.resumable, resumable, workId);
  }
  // A runtime whose scheduler cannot answer says so with null, never with a guess.
  const silent = new RuntimeApplicationService({ getRuntime: () => inspection });
  assert.equal(silent.getWork({ work_id: 'work_1' }).work.resumable, null);
  // The projection refuses a claim on work that is not paused, and a non-boolean claim.
  assert.throws(() => projectWorkRecord({ ...reopened.get('work_4'), resumable: true }), RuntimeProjectionError);
  assert.throws(() => projectWorkRecord({ ...reopened.get('work_1'), resumable: 'yes' }), RuntimeProjectionError);
  assert.equal(projectWorkRecord({ ...reopened.get('work_1'), resumable: true }).work.resumable, true);
});
