'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getTrustedExecutionBinding } = require('../../services/backend/session-execution-authority');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { getToolResourceOperations } = require('../../services/session-runtime/resource-operations');
const { encodeContinuation } = require('../../services/session-runtime/continuation-contracts');
const {
  AUTHORITY,
  continuationFixture,
  createAdapterHarness,
  digest,
  request,
  waitFor,
} = require('../helpers/session-runtime-chat-adapter-harness');

test('a GPT submission after mock fallback captures ChatGPT or rejects missing credentials', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const submission = { sessionId, prompt: 'resume', preferredModel: 'gpt-6-astra' };
  const identity = { workId: 'work-gpt', turnId: 'turn-gpt' };
  await assert.rejects(adapter.prepareSubmission(submission, {}, identity), {
    code: 'runtime_provider_credentials_unavailable',
  });
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
  service.chatgptAuthService = { hasCredential: () => true, getCredentialEpoch: () => 1 };
  service._chatgptRuntimeCredentialEpoch = 1;
  const prepared = await adapter.prepareSubmission(submission, {}, identity);
  assert.equal(prepared.route.engine_type, 'chatgpt');
  assert.equal(prepared.request.runtimePreferredEngineType, 'chatgpt');
  assert.equal(prepared.input.request.runtimePreferredEngineType, 'chatgpt');
  adapter.discard(prepared);
});

test('runtime model resolution retains local pins, catalog hints, and force-local selection', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  service.currentEngineType = 'vllm';
  for (const [model, hinted, expected] of [
    ['custom-local-model', '', 'vllm'],
    ['custom-local-model', 'openai-compatible', 'openai-compatible'],
  ]) {
    service._modelEngineHints = new Map(hinted ? [[model, hinted]] : []);
    const prepared = await adapter.prepareSubmission({ sessionId, prompt: 'hello', preferredModel: model }, {}, {
      workId: `work-${expected}`, turnId: `turn-${expected}`,
    });
    assert.equal(prepared.route.engine_type, expected);
    adapter.discard(prepared);
  }
  service.offlineIntelligenceService = { getState: async () => ({
    mode: 'local_only', preferredLocalModel: 'custom-local-model',
    selectedLocalEngineType: 'vllm', localCatalog: { available: true }, localChatReady: true,
  }) };
  const prepared = await adapter.prepareSubmission({ sessionId, prompt: 'hello', preferredModel: 'gpt-6-astra' }, {}, {
    workId: 'work-force-local', turnId: 'turn-force-local',
  });
  assert.equal(prepared.route.engine_type, 'vllm');
  assert.equal(prepared.request.runtimePreferredModel, 'custom-local-model');
  adapter.discard(prepared);
});

test('adapter captures authority before claim and gives the wire attempt a fresh request binding', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(request(sessionId, {
    attachments: [{ id: 'text-1', kind: 'text', bytes: [1, 2, 3] }],
  }), {}, {
    workId: 'work-1', turnId: 'logical-turn-1',
  });
  adapter.register('work-1', prepared);
  const work = {
    work_id: 'work-1', turn_id: 'logical-turn-1', session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input,
  };
  assert.equal(prepared.route.engine_type, 'mock');
  assert.deepEqual(prepared.authority, AUTHORITY);
  assert.equal(JSON.stringify(prepared.input).includes('credential'), false);
  assert.equal(JSON.stringify(prepared.input).includes('bytes'), false);
  assert.deepEqual(prepared.request.attachments[0].bytes, [1, 2, 3]);

  const route = adapter.resolveRoute(work);
  adapter.validateWork(work, route);
  const claim = adapter.claimCanonical(work, route);
  const active = service.sessionStore.getActiveTurn(sessionId);
  assert.equal(active.turn_id, 'logical-turn-1');
  assert.equal(active.request_id, 'logical-turn-1');
  assert.equal(active.stream_id, claim.streamId);
  assert.notEqual(claim.streamId, 'logical-turn-1');
  assert.equal(getTrustedExecutionBinding(prepared.binding).requestId, claim.streamId);
  assert.equal(claim.rollbackBeforeStart(), true);
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
});

test('reserveStart failure marks the unchanged error as not claimed', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, {
    workId: 'work-reserve-failure', turnId: 'turn-reserve-failure',
  });
  adapter.register(prepared.workId, prepared);
  const work = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input };
  const failure = Object.assign(new Error('recovery failed'), {
    code: 'active_turn_recovery_failed', retryable: true,
  });
  ensureSessionTurnActorRegistry(service).reserveStart = () => { throw failure; };

  assert.throws(() => adapter.claimCanonical(work, prepared.route), error => {
    assert.equal(error, failure);
    assert.equal(error.message, 'recovery failed');
    assert.equal(error.code, 'active_turn_recovery_failed');
    assert.equal(error.claimState, 'not_claimed');
    return true;
  });
});

test('reserveStart failure preserves the registry-attested uncertain claim state', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, {
    workId: 'work-reserve-uncertain', turnId: 'turn-reserve-uncertain',
  });
  adapter.register(prepared.workId, prepared);
  const work = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input };
  const failure = Object.assign(new Error('claim rollback failed'), {
    code: 'active_turn_recovery_failed', claimState: 'uncertain',
  });
  ensureSessionTurnActorRegistry(service).reserveStart = () => { throw failure; };

  assert.throws(() => adapter.claimCanonical(work, prepared.route), error => {
    assert.equal(error, failure);
    assert.equal(error.claimState, 'uncertain');
    return true;
  });
});

test('confirmed wire-binding rollback marks the unchanged error as not claimed', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, {
    workId: 'work-wire-failure', turnId: 'turn-wire-failure',
  });
  adapter.register(prepared.workId, prepared);
  const work = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input };
  const failure = Object.assign(new Error('wire binding failed'), {
    code: 'session_runtime_project_authority_changed',
  });
  service.sessionExecutionAuthority.captureSession = () => { throw failure; };

  assert.throws(() => adapter.claimCanonical(work, prepared.route), error => {
    assert.equal(error, failure);
    assert.equal(error.claimState, 'not_claimed');
    return true;
  });
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
});

test('recovery-blocked wire-binding rollback leaves claim state uncertain', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, {
    workId: 'work-wire-blocked', turnId: 'turn-wire-blocked',
  });
  adapter.register(prepared.workId, prepared);
  const work = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input };
  const registry = ensureSessionTurnActorRegistry(service);
  const release = registry.release.bind(registry);
  registry.release = (lease, options) => ({ ...release(lease, options), recoveryBlocked: true });
  const failure = new Error('wire binding failed with blocked recovery');
  service.sessionExecutionAuthority.captureSession = () => { throw failure; };

  assert.throws(() => adapter.claimCanonical(work, prepared.route), error => {
    assert.equal(error, failure);
    assert.equal(error.claimState, undefined);
    return true;
  });
});

test('adapter fences gateway and authority before delegating a live stream abort', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, {
    workId: 'work-cancel-1', turnId: 'turn-cancel-1',
  });
  adapter.register(prepared.workId, prepared);
  const work = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input };
  const claim = adapter.claimCanonical(work, prepared.route);
  const wireBinding = prepared.binding;
  const order = [];
  prepared.runtimeOperationGateway = { close(options) {
    assert.deepEqual(options, { producerSettled: false });
    order.push('gateway');
  } };
  service.cancelChatStream = (streamId, reason) => {
    assert.equal(streamId, claim.streamId);
    assert.equal(reason, 'user stop');
    assert.equal(getTrustedExecutionBinding(wireBinding), null);
    order.push('abort');
    return true;
  };

  assert.equal(adapter.cancelProducer(work, 'user stop', { abort: true }), true);
  assert.deepEqual(order, ['gateway', 'abort']);
  assert.equal(prepared.cancelled, true);
  assert.equal(claim.rollbackBeforeStart(), true);
  assert.equal(adapter.contexts.has(work.work_id), false);
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
});

test('continuation preflight failure after gateway registration releases every no-start owner', async t => {
  const { adapter, service, sessionId } = createAdapterHarness(t);
  service.featureFlags = { vision_unified_turn: true, session_runtime: true,
    canonical_bridge: true, canonical_turn_events: true };
  let producerCalls = 0;
  service._startManagedSidecarChatStream = async () => { producerCalls += 1; };
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, {
    workId: 'work-preflight-failure', turnId: 'turn-preflight-failure',
  });
  prepared.checkpointStore = {};
  prepared.conversationStore = {};
  prepared.getCurrentWork = () => work;
  prepared.started.promise.catch(() => {});
  adapter.register(prepared.workId, prepared);
  const pending = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input, authority: prepared.authority,
    status: 'pending' };
  const claim = adapter.claimCanonical(pending, prepared.route);
  const work = { ...pending, status: 'running', attempt: {
    attempt_id: 'attempt-preflight-failure', stream_id: claim.streamId,
    incarnation: 'incarnation-preflight-failure', authority_revision: claim.authorityRevision,
  } };
  const wireBinding = prepared.binding;
  const originalToExecutionContext = service.sessionExecutionAuthority.toExecutionContext;
  service.sessionExecutionAuthority.toExecutionContext = () => {
    throw new Error('injected_continuation_context_failure');
  };

  const outcome = await adapter.startProducer({ work, route: prepared.route,
    assertCurrent: () => true });
  service.sessionExecutionAuthority.toExecutionContext = originalToExecutionContext;

  assert.deepEqual(outcome, {
    status: 'failed', producerSettled: true, canonicalSettled: true,
  });
  assert.equal(producerCalls, 0);
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
  assert.equal(prepared.lease.released, true);
  assert.equal(service.activeStreams.has(claim.streamId), false);
  assert.equal(adapter.contexts.has(prepared.workId), false);
  assert.equal(getTrustedExecutionBinding(wireBinding), null);
  assert.equal(getToolResourceOperations(wireBinding), null);
});

test('explicit resume validates source A before reserving actor B and preserves the paused checkpoint outcome', async t => {
  const { adapter, lanes, service, sessionId } = createAdapterHarness(t);
  service.featureFlags = { vision_unified_turn: true, session_runtime: true,
    canonical_bridge: true, canonical_turn_events: true };
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-chat-resume-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const store = new RuntimeStore(runtimeRoot);
  const workId = 'work-resume-1';
  const turnId = 'turn-resume-1';
  const userMessageId = 'user-resume-1';
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, { workId, turnId });
  adapter.discard(prepared);
  service.sessionStore.appendMessage(sessionId, { id: userMessageId, turn_id: turnId,
    role: 'user', kind: 'message', content: 'hello', timestamp: '2026-09-10T12:00:00.000Z' });
  const submitted = store.submit({ idempotencyKey: 'resume-idempotency-1',
    projectId: prepared.authority.project_id, sessionId, purpose: 'chat',
    input: prepared.input, authority: prepared.authority, workId, turnId }).record;
  const sourceAttempt = { attempt_id: 'attempt-source-a', stream_id: 'stream-source-a',
    incarnation: 'incarnation-source-a', authority_revision: 'authority-source-a' };
  const running = store.transition(workId, { expectedRevision: submitted.revision,
    to: 'running', reason: 'fixture_admitted', attempt: sourceAttempt }).record;
  const continuation = continuationFixture(running, 'checkpoint-source-a', userMessageId);
  delete continuation._userMessageId;
  const encoded = encodeContinuation(continuation);
  const sourceReference = { schema_version: 1, checkpoint_id: 'checkpoint-source-a',
    sha256: encoded.sha256, bytes: encoded.body.length, source_attempt: sourceAttempt };
  const paused = store.transition(workId, { expectedRevision: running.revision,
    expectedAttempt: sourceAttempt, to: 'paused', reason: 'fixture_checkpointed',
    checkpointRef: sourceReference }).record;
  let sourceReads = 0;
  let checkpointValidations = 0;
  let canonicalHydrations = 0;
  const checkpointStore = {
    read(reference, current) {
      assert.deepEqual(reference, sourceReference);
      assert.equal(current.attempt.attempt_id, sourceAttempt.attempt_id);
      sourceReads += 1;
      return continuation;
    },
    validate: () => { checkpointValidations += 1; return true; },
  };
  const conversationStore = {
    resolvePendingContinuation(_continuation, current, options) {
      canonicalHydrations += 1;
      assert.equal(current.work_id, workId);
      assert.deepEqual(options, { includePayload: true });
      return {
        valid: true,
        canonicalHistoryMessages: [],
        turnMessages: [{ id: userMessageId, turn_id: turnId, role: 'user', kind: 'message', content: 'hello' }],
        turnEvents: [],
        userMessageId,
        historySelector: { schema_version: 1, history_scope: 'session',
          canonical_cutoff: { boundary_message_id: null, boundary_message_count: 0,
            sha256: digest([]) }, compaction_ref: null },
        compactionSnapshot: null,
        toolBatch: { calls: [{ call_id: 'call_1', tool_id: 'read_file', arguments: { path: 'a.txt' } }] },
        toolBatchBytes: Buffer.from('{"calls":[]}', 'utf8').toString('base64'),
        frozenInputBytes: Buffer.from('{"path":"a.txt"}', 'utf8').toString('base64'),
        frozenInputRef: { sha256: 'c'.repeat(64) },
        canonicalRefs: continuation.canonical_refs,
      };
    },
  };
  const rollbackPrepared = adapter.prepareResume(paused, { checkpointStore, conversationStore,
    getCurrentWork: () => store.get(workId) });
  adapter.register(workId, rollbackPrepared);
  adapter.prepareCanonical(paused, rollbackPrepared.route);
  assert.ok(rollbackPrepared.resumeHydration);
  assert.ok(rollbackPrepared.checkpointResume);
  const rollbackClaim = adapter.claimCanonical(paused, rollbackPrepared.route);
  assert.equal(rollbackClaim.rollbackBeforeStart(), true);
  assert.equal(rollbackPrepared.resumeHydration, null);
  assert.equal(rollbackPrepared.checkpointResume, null);
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
  adapter.discard(rollbackPrepared);
  sourceReads = 0;
  checkpointValidations = 0;
  canonicalHydrations = 0;
  let managedCalls = 0;
  let wireRequestId;
  service._startManagedSidecarChatStream = async (options) => {
    managedCalls += 1;
    wireRequestId = getTrustedExecutionBinding(options.runtimeExecutionAuthority).requestId;
    assert.equal(checkpointValidations >= 1, true);
    assert.equal(canonicalHydrations >= 1, true);
    assert.equal(sourceReads >= 2, true);
    assert.equal(options.turnLease.reuseExistingUserMessage, true);
    assert.equal(options.turnLease.identity.turnId, turnId);
    assert.equal(options.turnLease.identity.userMessageId, userMessageId);
    assert.notEqual(options.turnLease.identity.streamId, sourceAttempt.stream_id);
    assert.equal(options.normalizedInteractiveResponse, null);
    assert.equal(options.editedMessageId, '');
    assert.equal(options.failureRetry, false);
    const resumedWork = options.runtimeContinuation.getCurrentWork();
    assert.equal(resumedWork.status, 'running');
    assert.notEqual(resumedWork.attempt.attempt_id, sourceAttempt.attempt_id);
    assert.equal(options.runtimeContinuation.context.source_attempt.attempt_id,
      resumedWork.attempt.attempt_id);
    const resumeFields = options.runtimeContinuation.resumeHydration.buildResumeFields({
      work: resumedWork, context: options.runtimeContinuation.context });
    assert.deepEqual(resumeFields.resolved_source_attempt, sourceAttempt);
    assert.equal(resumeFields.checkpoint_body, encoded.body.toString('base64'));
    const nextReference = { schema_version: 1, checkpoint_id: 'checkpoint-source-b',
      sha256: 'd'.repeat(64), bytes: 400, source_attempt: resumedWork.attempt };
    const controller = new AbortController();
    service.sessionTurnActors.attachController(options.turnLease, controller);
    controller._runtimeCompletion = new Promise(resolve => setImmediate(() => {
      service.sessionTurnActors.release(options.turnLease, { status: 'completed' });
      resolve({ status: 'paused', producerSettled: true, canonicalSettled: true,
        checkpointSettled: true, checkpointRef: nextReference });
    }));
    return { sessionId, streamId: options.turnLease.identity.streamId };
  };
  const scheduler = new SessionRuntimeScheduler({ store, lanes,
    resolveRoute: work => adapter.resolveRoute(work),
    validateWork: (work, route) => adapter.validateWork(work, route),
    prepareCanonical: (work, route) => adapter.prepareCanonical(work, route),
    claimCanonical: (work, route) => adapter.claimCanonical(work, route),
    startProducer: context => adapter.startProducer(context),
    validateCheckpoint: (work, reference) => checkpointStore.validate(work, reference),
    createId: (() => { let value = 0; return () => `runtime-id-${++value}`; })(),
  });
  const runtime = new SessionRuntimeService({ store, scheduler, chatAdapter: adapter,
    checkpointStore, conversationStore });

  const held = lanes.tryAcquireTurn({ sessionId: 'blocking-session', route: prepared.route });
  assert.equal(held.status, 'granted');
  assert.deepEqual(runtime.resume(workId, paused.revision), { status: 'accepted' });
  assert.equal(store.get(workId).status, 'pending');
  assert.equal(sourceReads, 0);
  assert.equal(checkpointValidations, 0);
  assert.equal(canonicalHydrations, 0);
  assert.equal(managedCalls, 0);
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
  const pendingContext = adapter.contexts.get(workId);
  assert.equal(pendingContext.resumeHydration, null);
  assert.equal(pendingContext.checkpointResume, null);
  const blockingActor = service.sessionTurnActors.reserveStart({
    sessionId, store: service.sessionStore, activeStreams: service.activeStreams,
    logicalTurnId: 'blocking-turn', prompt: 'blocking', path: 'managed',
  });
  lanes.release(held.lease, { producerSettled: true });
  scheduler.pump();
  assert.equal(store.get(workId).status, 'pending');
  assert.equal(managedCalls, 0);
  assert.equal(pendingContext.resumeHydration, null);
  assert.equal(pendingContext.checkpointResume, null);
  assert.equal(service.sessionTurnActors.release(blockingActor, { status: 'preflight_failed' }).released, true);
  scheduler.pump();
  await waitFor(() => store.get(workId).status === 'paused'
    && store.get(workId).attempt.attempt_id !== sourceAttempt.attempt_id,
  'resumed work did not suspend as attempt B');
  const resumed = store.get(workId);
  assert.equal(resumed.checkpoint_ref.source_attempt.attempt_id, resumed.attempt.attempt_id);
  assert.equal(service.sessionStore.getSessionMessages(sessionId).length, 1);
  assert.equal(wireRequestId, resumed.attempt.stream_id);
});

test('immediate refusal cancels its durable record so a later pump cannot replay it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-immediate-busy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new RuntimeStore(root);
  const lanes = new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config-1', resource_class: 'local', requires_gpu: false });
  let prepared;
  const adapter = {
    prepareImmediate: async (_request, _options, ids) => (prepared = {
      ...ids, sessionId: 'session-1', authority: AUTHORITY, input: { route },
    }),
    register() {}, discard() {}, waitForStart() { return new Promise(() => {}); },
    resolveRoute: () => route,
    validateWork() { const error = new Error('busy'); error.code = 'gpu_busy_plugin'; error.retryable = true; throw error; },
    claimCanonical() { throw new Error('must not claim'); },
    startProducer() { throw new Error('must not start'); },
  };
  const scheduler = new SessionRuntimeScheduler({
    store, lanes, resolveRoute: work => adapter.resolveRoute(work),
    validateWork: (work, captured) => adapter.validateWork(work, captured),
    claimCanonical: (work, captured) => adapter.claimCanonical(work, captured),
    startProducer: context => adapter.startProducer(context),
  });
  const runtime = new SessionRuntimeService({ store, scheduler, chatAdapter: adapter });

  await assert.rejects(runtime.startImmediate({ prompt: 'hello' }), error => (
    error.code === 'session_busy' && error.reason === 'gpu_busy_plugin' && error.retryable === true
  ));
  const saved = store.get(prepared.workId);
  assert.equal(saved.status, 'cancelled');
  assert.equal(scheduler.pump().length, 0);
});

test('runtime busy predicates include paged session work and quarantined shared lanes', () => {
  const pages = [
    { items: Array.from({ length: 100 }, () => ({ status: 'completed' })), next_cursor: 'next' },
    { items: [{ status: 'paused' }], next_cursor: null },
  ];
  const scheduler = {
    lanes: { snapshot: () => ({ active_leases: 1 }) },
    hasPendingOrAdmittedWork: () => false,
    setEnabled() {},
  };
  const runtime = new SessionRuntimeService({
    scheduler,
    store: { listSummaries: ({ cursor }) => pages[cursor ? 1 : 0] },
    chatAdapter: { prepareImmediate() {} },
  });
  assert.equal(runtime.hasSessionWork('session-1'), true);
  assert.equal(runtime.hasPendingOrAdmittedWork(), true);
  assert.equal(runtime.lanes, scheduler.lanes);
});

test('disabled runtime refuses explicit resume before checkpoint hydration', () => {
  let prepared = false;
  const scheduler = {
    enabled: false,
    lanes: { snapshot: () => ({ active_leases: 0 }) },
    hasPendingOrAdmittedWork: () => false,
    setEnabled() {},
    resume: () => Object.freeze({ status: 'rejected', reason: 'runtime_disabled' }),
  };
  const runtime = new SessionRuntimeService({
    scheduler,
    store: { get: () => ({ work_id: 'work-paused', status: 'paused' }) },
    chatAdapter: {
      prepareImmediate() {},
      prepareResume() { prepared = true; throw new Error('must not hydrate'); },
    },
  });
  assert.deepEqual(runtime.resume('work-paused', 4),
    { status: 'rejected', reason: 'runtime_disabled' });
  assert.equal(prepared, false);
});
