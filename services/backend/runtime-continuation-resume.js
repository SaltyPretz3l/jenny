'use strict';

const { completedEffectRefs } = require('../session-runtime/continuation-effect-refs');
const { proveMixedDependencyPrefix, assertPredecessorWaitOrder } = require('../session-runtime/dependency-mixed-proof');
const { createHash } = require('node:crypto');
const { stableJson, normalizeCheckpointRef } = require('../session-runtime/contracts');
const { encodeContinuation, normalizeContinuationContext } = require('../session-runtime/continuation-contracts');
const { createCheckpointResumeIdentity } = require('./session-turn-actor-resume');
const { buildPreparedContinuationPrefix, buildPreparedMessages } = require('./chat-stream-reasoning');
const { applyCompactionSnapshotToHistory } = require('./session-compaction-snapshot');
const { proveDependencyPrefix, dependencyReady } = require('../session-runtime/dependency-proof');
const { buildDependencyPrefix } = require('./runtime-dependency-prefix');
const { readDependencyPredecessor, assertDependencyProgress } = require('../session-runtime/dependency-predecessor');
const { proveDecisionPrefix, readDecisionPredecessor, assertDecisionProgress } = require('./runtime-decision-proof');
const { buildDecisionPrefix } = require('./runtime-decision-prefix');
const { isTextAttachment } = require('../attachment-service');
const { RUNTIME_ERROR_CODES } = require('./error-codes');

function fail(reason) { throw Object.assign(new Error(reason), { code: RUNTIME_ERROR_CODES.ADMISSION_REJECTED, reason }); }
function digest(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function copy(value) { return structuredClone(value); }

function sameSubmission(left, right) {
  return ['work_id', 'turn_id', 'session_id', 'project_id', 'submission_hash'].every(key => left[key] === right[key])
    && stableJson(left.authority) === stableJson(right.authority)
    && stableJson(left.input) === stableJson(right.input);
}

// Resolve source attempt A before reserving attempt B. This object owns only
// temporary hydrated views; all durable content remains with its existing store.
function hydrateRuntimeContinuation({ work, checkpointStore, conversationStore, assertCurrent, dependencyRuntime = null } = {}) {
  if (typeof checkpointStore?.read !== 'function'
    || typeof conversationStore?.resolvePendingContinuation !== 'function'
    || typeof assertCurrent !== 'function') throw new TypeError('runtime_resume_dependencies_invalid');
  if (assertCurrent() !== true || !['paused', 'pending'].includes(work?.status)) fail('runtime_resume_source_unavailable');
  const source = copy(work);
  const reference = normalizeCheckpointRef(source.checkpoint_ref);
  if (!reference || stableJson(reference.source_attempt) !== stableJson(source.attempt)) fail('runtime_resume_source_mismatch');
  const continuation = checkpointStore.read(reference, source);
  const dependency = continuation.kind === 'before_dependency_wait';
  const decision = continuation.kind === 'before_decision_wait';
  const resource = continuation.kind === 'before_tool_dispatch' && Boolean(continuation.completed_effect_refs);
  if (continuation.kind !== 'before_tool_dispatch' && !decision && !(dependency && dependencyRuntime)) fail('runtime_resume_boundary_unsupported');
  if (continuation.authority.sha256 !== digest(source.authority)
    || continuation.route.sha256 !== digest(source.input?.route)) fail('runtime_resume_submission_changed');
  const encoded = encodeContinuation(continuation);
  if (encoded.sha256 !== reference.sha256 || encoded.body.length !== reference.bytes) fail('runtime_resume_body_changed');
  const payload = conversationStore.resolvePendingContinuation(continuation, source, { includePayload: true });
  if (payload?.valid !== true || !Array.isArray(payload.canonicalHistoryMessages)
    || !Array.isArray(payload.turnMessages) || !Array.isArray(payload.turnEvents)
    || !payload.historySelector) fail('runtime_resume_canonical_unavailable');
  const captured = copy(payload);
  if (continuation.quota_state) require('../session-runtime/quota-state').assertQuotaCoverage(
    continuation.quota_state, captured.toolBatch.calls, require('../session-runtime/quota-state').quotaEffects(captured.turnEvents));
  const assertDecision = () => {
    if (!decision && !resource) return;
    if (continuation.mutation_ref && dependencyRuntime?.mutationJournalProof?.verify({ work: source,
      reference: continuation.mutation_ref, decision: continuation.decision,
      completedRefs: continuation.completed_effect_refs })?.valid !== true) fail('runtime_mutation_journal_unproven');
    let priorEvents = [];
    if (continuation.prior_checkpoint_ref) {
      const previous = readDecisionPredecessor({ ...dependencyRuntime, checkpointStore, conversationStore }, source, continuation.prior_checkpoint_ref);
      assertDecisionProgress({ ...previous.checkpoint, completed_effect_refs: previous.checkpoint.completed_effect_refs || completedEffectRefs(previous.payload.turnEvents) }, continuation, previous.payload.toolBatch.calls, captured.toolBatch.calls, previous.payload, captured);
      const inherited = new Set(previous.payload.turnEvents.map(event => event.event_id));
      assertPredecessorWaitOrder(previous.checkpoint, continuation, captured.turnEvents.filter(event => !inherited.has(event.event_id)));
      priorEvents = previous.payload.turnEvents;
    }
    const inherited = new Set(priorEvents.map(event => event.event_id));
    (resource ? require('./runtime-resource-proof').proveResourcePrefix : proveDecisionPrefix)({ work: source, position: continuation.position, decision: continuation.decision, completedRefs: continuation.completed_effect_refs,
      pendingCalls: captured.toolBatch.calls, events: captured.turnEvents.filter(event => !inherited.has(event.event_id)), priorEvents });
  };
  const assertDependency = () => {
    assertDecision();
    if (!dependency) return;
    let priorEvents = [];
    if (continuation.prior_checkpoint_ref) {
      const previous = readDependencyPredecessor(dependencyRuntime, source, continuation.prior_checkpoint_ref);
      if (continuation.completed_effect_refs) {
        assertDecisionProgress({ ...previous.checkpoint, completed_effect_refs: previous.checkpoint.completed_effect_refs || completedEffectRefs(previous.payload.turnEvents) },
          continuation, previous.payload.toolBatch.calls, captured.toolBatch.calls, previous.payload, captured);
        assertPredecessorWaitOrder(previous.checkpoint, continuation, captured.turnEvents);
      } else assertDependencyProgress(previous.checkpoint, continuation, captured.turnEvents);
      priorEvents = previous.payload.turnEvents;
    }
    const prove = continuation.completed_effect_refs ? proveMixedDependencyPrefix : proveDependencyPrefix;
    prove({ runtime: dependencyRuntime, work: source, events: captured.turnEvents,
      dependencyId: continuation.wait.dependency_id, expectedRefs: continuation.completed_spawn_refs,
      pendingCallId: continuation.pending_call.call_id,
      expectedWaitRefs: continuation.completed_wait_refs ?? null, expectedEffects: continuation.completed_effect_refs, expectedEmittedCount: continuation.eligibility.emitted_tool_execution_count,
      permittedStreams: [...new Set(priorEvents.map(event => event.event_id.split(':')[0])), source.attempt.stream_id] });
    if (!dependencyReady(dependencyRuntime, source, continuation.wait.dependency_id)) fail('runtime_dependency_not_ready');
  };
  assertDependency();
  const users = captured.turnMessages.filter(row => row.role === 'user');
  if (users.length !== 1 || users[0].id !== captured.userMessageId) fail('runtime_resume_user_message_mismatch');

  function assertSourceCurrent(currentWork) {
    if (assertCurrent() !== true || !['paused', 'pending'].includes(currentWork?.status)
      || !sameSubmission(source, currentWork)
      || stableJson(currentWork.attempt) !== stableJson(source.attempt)
      || stableJson(currentWork.checkpoint_ref) !== stableJson(reference)) fail('runtime_resume_source_changed');
    // This rereads canonical history and pending-effect evidence, including
    // changes made while waiting for a lane, immediately before actor admission.
    checkpointStore.read(reference, currentWork);
    assertDependency();
    return true;
  }

  function reserveIdentity(currentWork) {
    assertSourceCurrent(currentWork);
    return createCheckpointResumeIdentity({ sessionId: source.session_id, turnId: source.turn_id,
      userMessageId: captured.userMessageId });
  }

  function buildMessages({ hydrateHistory = rows => rows } = {}) {
    const request = source.input?.request;
    if (!request || typeof request.prompt !== 'string' || typeof hydrateHistory !== 'function') {
      fail('runtime_resume_request_unavailable');
    }
    let history = copy(captured.canonicalHistoryMessages);
    if (captured.compactionSnapshot) {
      const compacted = applyCompactionSnapshotToHistory(captured.compactionSnapshot, history);
      if (!compacted.applied) fail('runtime_resume_compaction_unavailable');
      history = compacted.messages;
    }
    history = hydrateHistory(history);
    if (!Array.isArray(history)) fail('runtime_resume_history_unavailable');
    const pending = new Set(captured.toolBatch.calls.map(call => call.call_id));
    const prefix = captured.turnMessages.filter(row => row.id !== captured.userMessageId
      && !pending.has(row.tool_call?.call_id || row.tool_result?.call_id));
    const messages = buildPreparedMessages(history, request.prompt, {
      attachments: (request.attachments || []).filter(isTextAttachment),
      contextPreferences: { history_scope: captured.historySelector.history_scope },
    });
    messages.push(...(decision || continuation.completed_effect_refs ? buildDecisionPrefix(copy(captured.turnEvents), continuation.completed_effect_refs, copy(captured.turnMessages)) : dependency ? buildDependencyPrefix(copy(prefix), copy(captured.turnEvents.filter(event => !pending.has(event.tool_call_id))))
      : buildPreparedContinuationPrefix(copy(prefix), copy(captured.turnEvents))));
    return messages;
  }

  function buildResumeFields({ work: freshWork, context } = {}) {
    const fresh = normalizeContinuationContext(context);
    if (assertCurrent() !== true || freshWork?.status !== 'running' || !sameSubmission(source, freshWork)
      || fresh.work_id !== source.work_id || fresh.turn_id !== source.turn_id
      || stableJson(fresh.source_attempt) !== stableJson(freshWork.attempt)
      || fresh.source_attempt.attempt_id === source.attempt.attempt_id
      || fresh.source_attempt.stream_id === source.attempt.stream_id
      || stableJson(fresh.authority) !== stableJson(continuation.authority)
      || stableJson(fresh.route) !== stableJson(continuation.route)) fail('runtime_resume_fresh_attempt_mismatch');
    // Do not reinterpret the checkpoint using B: source A is still the proof
    // target, even though the canonical actor has advanced its turn generation.
    checkpointStore.read(reference, source);
    assertDependency();
    return { ...(decision || dependency || resource ? { canonical_events_bytes: Buffer.from(stableJson(captured.turnEvents)).toString('base64') } : {}),
      ...(captured.approvalInputsBytes ? { approval_inputs_bytes: captured.approvalInputsBytes } : {}),
      checkpoint_body: encoded.body.toString('base64'), checkpoint_sha256: encoded.sha256,
      checkpoint_ref: copy(reference), resolved_source_attempt: copy(source.attempt),
      tool_batch_bytes: captured.toolBatchBytes, tool_batch_sha256: captured.canonicalRefs.tool_batch_ref.sha256,
      frozen_input_bytes: captured.frozenInputBytes, frozen_input_sha256: captured.frozenInputRef.sha256 };
  }

  const historyView = () => copy({ canonicalHistoryMessages: captured.canonicalHistoryMessages,
    historySelector: captured.historySelector, compactionSnapshot: captured.compactionSnapshot });
  const planModeExited = captured.turnEvents.some(event => event.kind === 'tool_result'
    && event.payload?.tool_name === 'exit_plan_mode' && event.payload.success === true
    && event.payload.metadata?.result_kind === 'plan_mode_transition'
    && event.payload.metadata.plan_mode_cleared === true);
  return Object.freeze({ userMessageId: captured.userMessageId, assertSourceCurrent, historyView,
    reserveIdentity, buildMessages, buildResumeFields, planModeExited });
}

function pausedOutcome(managed, providerSettled) {
  if (managed?.status !== 'paused') return null;
  return {
    status: 'paused',
    producerSettled: providerSettled,
    canonicalSettled: managed.canonicalSettled === true,
    checkpointSettled: managed.checkpointSettled === true,
    checkpointRef: managed.checkpointRef,
    ...(managed.waitResources ? { waitResources: managed.waitResources } : {}),
  };
}

module.exports = { hydrateRuntimeContinuation, pausedOutcome };
