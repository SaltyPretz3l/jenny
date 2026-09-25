'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createManagedChatServiceStub, buildManagedChatRequest } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');
const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { RootRunBudgetStore } = require('../../services/session-runtime/budgets');
const { createInferenceBudget } = require('../../services/session-runtime/inference-budget');
const { CheckpointStore } = require('../../services/session-runtime/checkpoint-store');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../../services/session-runtime/inference-protocol');
const { stableJson } = require('../../services/session-runtime/contracts');
const { hydrateRuntimeContinuation } = require('../../services/backend/runtime-continuation-resume');
const { getManagedRuntimeController } = require('../../services/backend/chat-lifecycle-contracts');

function encoded(value) {
  const body = Buffer.from(stableJson(value));
  return { bytes: body.toString('base64'), sha256: createHash('sha256').update(body).digest('hex') };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-checkpoint-'));
  const service = createManagedChatServiceStub({ featureFlags: { canonical_bridge: false, canonical_turn_events: false } });
  service.pendingUserQuestions = new Map();
  service.sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  t.after(() => { service.sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = buildManagedChatRequest();
  service.sessionStore.createSessionWithId(request.sessionId, { title: 'Checkpoint send' });
  const actor = ensureSessionTurnActorRegistry(service);
  const lease = actor.reserveStart({ sessionId: request.sessionId, store: service.sessionStore,
    activeStreams: service.activeStreams, logicalTurnId: 'turn_1', prompt: request.prompt });
  const binding = service.sessionExecutionAuthority.captureSession(request.sessionId, { requestId: lease.identity.streamId });
  const executionContext = service.sessionExecutionAuthority.toExecutionContext(binding);
  const route = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  const attempt = { attempt_id: 'attempt_1', stream_id: lease.identity.streamId,
    incarnation: 'incarnation_1', authority_revision: executionContext.authority_revision };
  const work = { work_id: 'work_1', turn_id: 'turn_1', session_id: request.sessionId, status: 'running',
    project_id: executionContext.project_id, authority: service.projectAuthority.captureSession(),
    attempt, input: { route, request }, revision: 3, submission_hash: 'd'.repeat(64) };
  const context = buildAdmittedContinuationContext({ work, attempt, route, executionContext });
  const checkpointStore = new CheckpointStore(path.join(root, 'checkpoints'), {
    validateCanonical: (continuation, current) => service.sessionStore.conversationStore.resolvePendingContinuation(continuation, current),
  });
  const gateway = { enableContinuation: () => true, snapshot: () => ({ active: 0, reserved: 0, quarantined: 0 }),
    tools: { validateResourceWait: () => ({ resource_class: 'filesystem', dependency_id: null }) } };
  service.sidecarManager = { process: { pid: 4242 }, getStatus: () => ({ phase: 'ready' }) };
  service.sidecarClient = { connected: true, process: service.sidecarManager.process };
  completeRuntimeInferenceInitialization(service.sidecarClient,
    beginRuntimeInferenceInitialization(service.sidecarClient), {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1, runtime_continuation_version: 1,
    });
  const runtimeContinuation = { context, checkpointStore, conversationStore: service.sessionStore.conversationStore,
    getCurrentWork: () => work, assertCurrent: () => true };
  return { service, request, actor, lease, binding, work, gateway, checkpointStore, runtimeContinuation };
}

async function publishFromProvider(params, options) {
  const call = { call_id: 'call_1', tool_id: 'read_file', arguments: { path: 'README.md' },
    idempotency_key: '', coerced: false, malformed_arguments: false, argument_repairs: [] };
  const context = params.continuation_context;
  const frozen = { call_id: call.call_id, tool_name: call.tool_id,
    visible_tool_arguments: call.arguments, effective_tool_arguments: call.arguments,
    injected_arg_keys: [], effective_args_fingerprint: encoded(call.arguments).sha256,
    execution_context_payload: { session_id: params.session_id, logical_turn_id: params.logical_turn_id,
      authority_revision: context.source_attempt.authority_revision,
      project_id: context.authority.project_id, root_id: context.authority.root_id, root_revision: context.authority.root_revision } };
  const batchBytes = encoded({ calls: [call] });
  const frozenBytes = encoded(frozen);
  return options.onRuntimeOperation({ api_version: '2026-08-17', schema_version: 1,
    kind: 'continuation', phase: 'checkpoint', request_id: params.request_id,
    session_id: params.session_id, authority_revision: context.source_attempt.authority_revision,
    operation_id: call.call_id, continuation_context: context, tool_calls: [call],
    tool_batch_bytes: batchBytes.bytes, tool_batch_sha256: batchBytes.sha256,
    frozen_input: frozen, frozen_input_bytes: frozenBytes.bytes, frozen_input_sha256: frozenBytes.sha256,
    position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1,
      tool_call_limit: 20, tool_calls_consumed: 1, active_budget_ms_remaining: 5000, ordered_call_ids: [call.call_id] },
    eligibility: { pending_call_index: 0, prior_outcome_count: 0, emitted_tool_execution_count: 0,
      preview_count: 0, approval_pending: false, mutation_started: false } });
}

test('production managed send publishes and pauses without running terminal finalization', async t => {
  const f = fixture(t);
  let reference;
  f.service.sidecarClient.chatSend = async (params, options) => {
    const published = await publishFromProvider(params, options);
    assert.equal(published.status, 'checkpointed');
    reference = published.checkpoint_ref;
    return { request_id: params.request_id, status: 'paused', checkpoint_ref: reference };
  };
  const stream = await startManagedSidecarChatStream(f.service, { ...f.request, turnLease: f.lease,
    runtimeExecutionAuthority: f.binding, runtimeOperationGateway: f.gateway, runtimeContinuation: f.runtimeContinuation });
  const controller = f.service.activeStreams.get(stream.streamId);
  assert.equal(getManagedRuntimeController(stream), controller);
  const outcome = await controller._runtimeCompletion;
  assert.equal(outcome.status, 'paused', JSON.stringify(f.service.serviceLogs));
  assert.equal(outcome.checkpointSettled, true);
  assert.equal(outcome.canonicalSettled, true);
  assert.equal(f.checkpointStore.validate(f.work, reference), true);
  assert.equal(f.service.sessionStore.getActiveTurn(f.work.session_id), null);
  assert.equal(f.service.activeStreams.size, 0);
  assert.equal(f.service.sessionStore.getSessionMessages(f.work.session_id).length, 1);
  controller._runtimeSettlementUnregister?.();
  f.service.sessionExecutionAuthority.close(f.binding);
});

for (const failure of ['stale_reply', 'quarantined_tool']) test(`unproven pause surfaces unknown status without releasing actor (${failure})`, async t => {
  const f = fixture(t);
  f.service.sidecarClient.chatSend = async (params, options) => {
    const published = await publishFromProvider(params, options);
    if (failure === 'quarantined_tool') f.gateway.snapshot = () => ({ active: 0, reserved: 0, quarantined: 1 });
    return { request_id: failure === 'stale_reply' ? 'stale_stream' : params.request_id,
      status: 'paused', checkpoint_ref: published.checkpoint_ref };
  };
  const stream = await startManagedSidecarChatStream(f.service, { ...f.request, turnLease: f.lease,
    runtimeExecutionAuthority: f.binding, runtimeOperationGateway: f.gateway, runtimeContinuation: f.runtimeContinuation });
  const controller = f.service.activeStreams.get(stream.streamId);
  const outcome = await controller._runtimeCompletion;
  assert.equal(outcome.canonicalSettled, false);
  assert.equal(f.lease.released, false);
  assert.equal(f.service.sessionStore.getSessionMessages(f.work.session_id).length, 1);
  assert.equal(f.service.serviceLogs.some(row => row.event === 'session_runtime.attention_required'), true);
  const notice = f.service.emittedEvents.find(row => row.eventName === 'chat-stream' && row.payload?.type === 'error');
  assert.equal(notice?.payload.terminal_status, 'unknown');
  assert.equal(notice.payload.retryable, false);
  assert.match(notice.payload.message, /needs attention/i);
  assert.equal(f.service.sessionStore.getActiveTurn(f.work.session_id)?.stream_id, stream.streamId);
  const { createHarness } = require('../helpers/renderer-stream-handler-buffering-harness');
  const renderer = createHarness();
  t.after(() => renderer.restore());
  const identity = { sessionId: 'session-1', streamId: stream.streamId };
  await renderer.emit({ ...identity, type: 'started' });
  await renderer.emit({ ...identity, type: 'delta', aggregate: 'Preserved audit progress.' });
  await renderer.emit({ ...notice.payload, ...identity });
  assert.equal(renderer.state.pendingStreams.has(stream.streamId), false);
  const row = renderer.state.messagesBySession.get('session-1').at(-1);
  assert.equal(row.terminal_status, 'unknown');
  assert.match(row.content, /Preserved audit progress/);
  controller._runtimeSettlementUnregister?.();
  f.actor.release(f.lease, { status: 'cancelled' });
  f.service.sessionExecutionAuthority.close(f.binding);
});

test('production resume preserves later canonical rows and sends the saved batch under fresh identity', async t => {
  const f = fixture(t);
  f.service.sidecarClient.chatSend = async (params, options) => {
    const published = await publishFromProvider(params, options);
    return { request_id: params.request_id, status: 'paused', checkpoint_ref: published.checkpoint_ref };
  };
  const first = await startManagedSidecarChatStream(f.service, { ...f.request, turnLease: f.lease,
    runtimeExecutionAuthority: f.binding, runtimeOperationGateway: f.gateway, runtimeContinuation: f.runtimeContinuation });
  const firstController = f.service.activeStreams.get(first.streamId);
  const paused = await firstController._runtimeCompletion;
  assert.equal(paused.status, 'paused');
  firstController._runtimeSettlementUnregister?.();
  f.service.sessionExecutionAuthority.close(f.binding);
  f.service.sessionStore.appendMessage(f.work.session_id, { id: 'later_user', turn_id: 'later_turn',
    role: 'user', content: 'Keep this later conversation.', timestamp: '2026-09-10T14:00:00Z' });
  const source = { ...f.work, status: 'paused', checkpoint_ref: paused.checkpointRef };
  const hydration = hydrateRuntimeContinuation({ work: source, checkpointStore: f.checkpointStore,
    conversationStore: f.service.sessionStore.conversationStore, assertCurrent: () => true });
  const lease = f.actor.reserveStart({ sessionId: f.work.session_id, store: f.service.sessionStore,
    activeStreams: f.service.activeStreams, checkpointResume: hydration.reserveIdentity(source) });
  const binding = f.service.sessionExecutionAuthority.captureSession(f.work.session_id, { requestId: lease.identity.streamId });
  const executionContext = f.service.sessionExecutionAuthority.toExecutionContext(binding);
  const fresh = { ...source, status: 'running', attempt: { ...source.attempt,
    attempt_id: 'attempt_2', stream_id: lease.identity.streamId, authority_revision: executionContext.authority_revision } };
  const context = buildAdmittedContinuationContext({ work: fresh, attempt: fresh.attempt,
    route: captureRuntimeRoute(fresh.input.route), executionContext });
  let dispatched = false;
  f.service.sidecarClient.chatSend = async params => {
    dispatched = true;
    assert.equal(params.logical_turn_id, 'turn_1');
    assert.equal(params.request_id, lease.identity.streamId);
    assert.equal(params.runtime_continuation_resume.resolved_source_attempt.stream_id, first.streamId);
    assert.equal(params.messages.some(row => row.content.includes('Keep this later conversation.')), false);
    assert.equal(params.messages.filter(row => row.role === 'user').length, 1);
    return { status: 'completed', response_text: 'Resumed completion.' };
  };
  const second = await startManagedSidecarChatStream(f.service, { ...f.request, turnLease: lease,
    runtimeExecutionAuthority: binding, runtimeOperationGateway: f.gateway,
    runtimeContinuation: { ...f.runtimeContinuation, context, getCurrentWork: () => fresh, resumeHydration: hydration } });
  const controller = f.service.activeStreams.get(second.streamId);
  const outcome = await controller._runtimeCompletion;
  assert.equal(dispatched, true, JSON.stringify(f.service.serviceLogs));
  assert.equal(outcome.status, 'completed', JSON.stringify(f.service.serviceLogs));
  const rows = f.service.sessionStore.getSessionMessages(f.work.session_id);
  assert.equal(rows.filter(row => row.id === hydration.userMessageId).length, 1);
  assert.equal(rows.some(row => row.id === 'later_user'), true, 'checkpoint resume never uses edit truncation');
  controller._runtimeSettlementUnregister?.();
  f.service.sessionExecutionAuthority.close(binding);
});

for (const maxima of [null, { inference_requests: 1, input_tokens: 100, output_tokens: 100 }]) {
  for (const supported of [false, true]) test(`managed budget enforcement covers fixed=${Boolean(maxima)} protocol=${supported}`, async t => {
    const f = fixture(t);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-budget-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new RootRunBudgetStore(root);
    store.create({ rootRunId: 'root_1', authorityFingerprint: 'a'.repeat(64), allowedProviderIds: ['chatgpt'],
      limits: { inference_requests: 1, input_tokens: 100, output_tokens: 100 } });
    f.gateway.inference = { budget: createInferenceBudget({ store, rootRunId: 'root_1', workId: 'work_1',
      attemptId: 'attempt_1', providerId: 'chatgpt', authorityFingerprint: 'a'.repeat(64), maxima }) };
    completeRuntimeInferenceInitialization(f.service.sidecarClient,
      beginRuntimeInferenceInitialization(f.service.sidecarClient), {
        runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1,
        ...(supported ? { runtime_inference_budget_version: 1 } : {}),
      });
    let sends = 0;
    f.service.sidecarClient.chatSend = async params => {
      sends += 1;
      assert.equal(params.inference_budget_required, true);
      return { status: 'completed', response_text: 'ok' };
    };
    const stream = await startManagedSidecarChatStream(f.service, { ...f.request, turnLease: f.lease,
      runtimeExecutionAuthority: f.binding, runtimeOperationGateway: f.gateway });
    const controller = f.service.activeStreams.get(stream.streamId) || getManagedRuntimeController(stream);
    await controller._runtimeCompletion;
    assert.equal(sends, supported ? 1 : 0);
    controller._runtimeSettlementUnregister?.();
    f.service.sessionExecutionAuthority.close(f.binding);
  });
}


for (const replaced of [false, true]) test(`unacknowledged initial send retains exactly one legacy result (replaced=${replaced})`, async t => {
  const f = fixture(t);
  if (replaced) f.service.sidecarClient.process = {};
  completeRuntimeInferenceInitialization(f.service.sidecarClient,
    beginRuntimeInferenceInitialization(f.service.sidecarClient), {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1 });
  const { buildCanonicalTurnEvent } = require('../../services/backend/canonical-turn-event');
  f.service.sidecarClient.chatSend = async (params, options) => {
    assert.equal(params.continuation_context, undefined);
    assert.equal(params.runtime_children_enabled, undefined);
    for (const [index, type, method] of [[1, 'tool_execution_started', 'tool.executing'],
      [2, 'tool_execution_completed', 'tool.result']]) {
      const payload = { tool_name: 'read_file', tool_input: { path: 'fixture.txt' },
        ...(index === 2 ? { success: true, tool_output_summary: 'Legacy output.' } : {}) };
      options.onNotification({ method: 'turn.event', params: buildCanonicalTurnEvent({ type,
        turn_id: f.work.turn_id, stream_id: params.request_id, seq: index,
        tool_call_id: 'legacy_read', payload }) });
      options.onNotification({ method, params: { ...payload, tool_call_id: 'legacy_read',
        arguments: payload.tool_input, ...(index === 2 ? { output: 'Legacy output.' } : {}) } });
    }
    return { status: 'completed', response_text: 'Finished legacy send.' };
  };
  const stream = await startManagedSidecarChatStream(f.service, { ...f.request, turnLease: f.lease,
    runtimeExecutionAuthority: f.binding, runtimeOperationGateway: f.gateway, runtimeContinuation: f.runtimeContinuation });
  const controller = getManagedRuntimeController(stream);
  const outcome = await controller._runtimeCompletion;
  assert.equal(outcome.status, 'completed', JSON.stringify(f.service.serviceLogs));
  const results = f.service.sessionStore.getSession(f.work.session_id).turn_events.filter(row => row.kind === 'tool_result');
  assert.equal(results.length, 1, JSON.stringify(results));
  assert.equal(results[0].payload.output_text, 'Legacy output.');
  controller._runtimeSettlementUnregister?.();
  f.service.sessionExecutionAuthority.close(f.binding);
});


for (const retry of [false, true]) test(`replacement after continuation activation cannot dispatch (auth retry=${retry})`, async t => {
  const f = fixture(t);
  let activated = false;
  let sends = 0;
  const replace = () => {
    f.service.sidecarClient.process = {};
    completeRuntimeInferenceInitialization(f.service.sidecarClient,
      beginRuntimeInferenceInitialization(f.service.sidecarClient), {
        runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1 });
  };
  f.gateway.enableContinuation = () => { activated = true; return true; };
  f.service.currentEngineType = 'chatgpt';
  f.service.chatgptAuthService = { getAccessToken: async () => 'fixture-refreshed-token' };
  f.service.refreshManagedConfig = async () => replace();
  f.service.sidecarClient.chatSend = async () => {
    sends += 1;
    const { CLOUD_ERROR_CODES, PROVIDER_CLASSIFICATIONS } = require('../../services/backend/error-codes');
    throw Object.assign(new Error('Fixture initial authentication rejection'), { rpc: { data: {
      classification: PROVIDER_CLASSIFICATIONS.INVALID_API_KEY, provider_code: CLOUD_ERROR_CODES.HTTP_ERROR } } });
  };
  const stream = await startManagedSidecarChatStream(f.service, { ...f.request, turnLease: f.lease,
    runtimeExecutionAuthority: f.binding, runtimeOperationGateway: f.gateway, runtimeContinuation: f.runtimeContinuation,
    runtimeAssertCurrent: () => { if (activated && !retry) replace(); } });
  const controller = getManagedRuntimeController(stream);
  const outcome = await controller._runtimeCompletion;
  assert.equal(activated, true, JSON.stringify(f.service.serviceLogs));
  assert.equal(sends, retry ? 1 : 0, 'no dispatch to an operations-only replacement');
  assert.equal(outcome.status, 'runtime_error', JSON.stringify(f.service.serviceLogs));
  controller._runtimeSettlementUnregister?.();
  f.service.sessionExecutionAuthority.close(f.binding);
});
