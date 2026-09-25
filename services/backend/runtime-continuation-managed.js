'use strict';

const { completedEffectRefs } = require('../session-runtime/continuation-effect-refs');
const { assertPredecessorWaitOrder } = require('../session-runtime/dependency-mixed-proof');
const { createRuntimeDecisionControl } = require('./runtime-decision-control');
const { proveDecisionPrefix, readDecisionPredecessor, assertDecisionProgress } = require('./runtime-decision-proof');
const { hasDurableProof } = require('./conversation-store-port');
const { normalizeCheckpointRef, stableJson } = require('../session-runtime/contracts');
const { normalizeContinuationContext } = require('../session-runtime/continuation-contracts');
const { RuntimeContinuationCoordinator } = require('./runtime-continuation-coordinator');
const { createRuntimeContinuationOperationHandler } = require('./runtime-continuation-operations');
const { persistRuntimeContinuationPrefix } = require('./runtime-continuation-prefix');
const { RUNTIME_ERROR_CODES } = require('./error-codes');

function fail(reason) { throw Object.assign(new Error(reason), { code: RUNTIME_ERROR_CODES.ADMISSION_REJECTED, reason }); }

// One admitted physical attempt owns this boundary. Publication does not release
// its actor: only the paired worker's post-cleanup reply can reach settlePause.
function createManagedContinuationBoundary({ context, checkpointStore, conversationStore,
  getCurrentWork, assertCurrent, assertSettlementCurrent = assertCurrent, assertProtocol,
  gateway, collector, historySelector, traceId = null, signal = null, dependencyRuntime = null, onPublicationFailure = null } = {}) {
  const captured = normalizeContinuationContext(context);
  const sessionId = collector?.sessionId;
  if (typeof checkpointStore?.validate !== 'function' || typeof gateway?.snapshot !== 'function'
    || typeof assertProtocol !== 'function') throw new TypeError('runtime_continuation_managed_dependencies_invalid');
  const decisionControl = signal ? createRuntimeDecisionControl({ context: captured, sessionId,
    getCurrentWork, assertCurrent, signal }) : null;
  const validateDecision = params => {
    if (!decisionControl?.validate(params.decision)) return null;
    const work = getCurrentWork();
    if (params.quota_state) require('../session-runtime/quota-state').assertQuotaCoverage(
      params.quota_state, params.tool_calls, params.completed_effect_refs);
    if (params.mutation_ref && dependencyRuntime?.mutationJournalProof?.verify({ work,
      reference: params.mutation_ref, decision: params.decision, completedRefs: params.completed_effect_refs, allowPreparing: true })?.valid !== true) return null;
    let priorEvents = [];
    if (params.prior_checkpoint_ref) {
      const previous = readDecisionPredecessor({ ...dependencyRuntime, checkpointStore, conversationStore }, work, params.prior_checkpoint_ref);
      assertDecisionProgress({ ...previous.checkpoint, completed_effect_refs: previous.checkpoint.completed_effect_refs || completedEffectRefs(previous.payload.turnEvents) }, params, previous.payload.toolBatch.calls, params.tool_calls,
        previous.payload, { approvalInputsBytes: params.approval_inputs_bytes, frozenFirstInput: params.frozen_input });
      assertPredecessorWaitOrder(previous.checkpoint, { ...params, source_attempt: captured.source_attempt }, collector.capturedEvents);
      priorEvents = previous.payload.turnEvents;
    } else if (params.prior_effect_count !== 0) return null;
    return proveDecisionPrefix({ work, decision: params.decision, completedRefs: params.completed_effect_refs,
      pendingCalls: params.tool_calls, events: collector.capturedEvents, priorEvents });
  };
  const validateResource = params => require('./runtime-resource-proof').validateResourceProgress({
    params, work: getCurrentWork(), runtime: { ...dependencyRuntime, checkpointStore, conversationStore },
    events: collector.capturedEvents, resourceOperations: gateway.tools });
  const coordinator = new RuntimeContinuationCoordinator({ context: captured, checkpointStore,
    conversationStore, getCurrentWork, assertCurrent, validateDecision, validateResource,
    validateDependency: ({ proposal, wait, completedSpawnRefs, dependencyProgress, position, eligibility }) => Boolean(gateway.children?.validateWait(
      wait.operation_id, proposal.tool_calls?.[0]?.tool_id, proposal.frozen_input?.visible_tool_arguments,
      completedSpawnRefs, collector.capturedEvents, dependencyProgress ? { ...dependencyProgress, position, eligibility, tool_calls: proposal.tool_calls, frozen_input: proposal.frozen_input } : null)) });
  let prefix = null;
  let published = null;
  let waitResources = null;
  let capturedEvents = null;
  let settled = null;
  const handle = createRuntimeContinuationOperationHandler({ context: captured, sessionId, traceId, onPublicationFailure,
    coordinator, resourceOperations: gateway.tools, historySelector, assertCurrent, getCurrentWork,
    validateDecision, validateResource, dependencyOperations: gateway.children, getCanonicalEvents: () => collector.capturedEvents,
    persistCanonicalPrefix: (validateDependency, pendingCalls, decisionParams) => {
      prefix = persistRuntimeContinuationPrefix({ collector, conversationStore, sessionId,
        turnId: captured.turn_id, streamId: captured.source_attempt.stream_id, assertCurrent, validateDependency, pendingCalls,
        decision: decisionParams?.decision, validateDecision: decisionParams ? () => (decisionParams.phase === 'resource_checkpoint' ? validateResource(decisionParams) : validateDecision(decisionParams))?.valid === true : null });
      capturedEvents = stableJson(collector.capturedEvents);
      return prefix;
    } });

  async function handleOperation(params) {
    if (assertProtocol() !== true) fail('runtime_continuation_protocol_required');
    const result = await handle(params);
    if (result.status === 'checkpointed') {
      published = normalizeCheckpointRef(result.checkpoint_ref);
      waitResources = params.phase === 'dependency_checkpoint'
        ? [{ type: 'dependency', work_id: params.frozen_input.visible_tool_arguments.child_work_id }]
        : ['pause_probe', 'decision_checkpoint'].includes(params.phase) ? null
        : gateway.tools?.getWaitResources?.(result.operation_id) || null;
    }
    return result;
  }

  function settlePause(result, { actorRegistry, lease, pendingToolApprovals, pendingUserQuestions } = {}) {
    if (result?.status !== 'paused') return null;
    const reference = normalizeCheckpointRef(result.checkpoint_ref);
    const wireVersion = Object.hasOwn(result, 'api_version');
    if (Object.keys(result).sort().join(',') !== (wireVersion ? 'api_version,checkpoint_ref,request_id,status' : 'checkpoint_ref,request_id,status')
      || (wireVersion && result.api_version !== '2026-08-17')
      || result.request_id !== captured.source_attempt.stream_id || !published || !reference
      || stableJson(reference) !== stableJson(published)) fail('runtime_continuation_pause_reply_invalid');
    if (settled) return settled;
    if (assertProtocol() !== true || assertSettlementCurrent() !== true
      || !lease || lease.released || lease.consumedContinuation
      || lease.identity?.sessionId !== sessionId || lease.identity?.turnId !== captured.turn_id
      || lease.identity?.streamId !== captured.source_attempt.stream_id
      || typeof actorRegistry?.pauseForCheckpoint !== 'function') fail('runtime_continuation_pause_fence_conflict');
    if (!(pendingToolApprovals instanceof Map) || !(pendingUserQuestions instanceof Map)
      || [...pendingToolApprovals.values(), ...pendingUserQuestions.values()]
        .some(waiter => waiter?.streamId === result.request_id)) {
      fail('runtime_continuation_approval_wait_active');
    }
    const resources = gateway.snapshot();
    if (resources.active !== 0 || resources.reserved !== 0 || resources.quarantined !== 0) {
      fail('runtime_continuation_producer_cleanup_unconfirmed');
    }
    if (!hasDurableProof(prefix?.commit) || capturedEvents !== stableJson(collector.capturedEvents)
      || checkpointStore.validate(getCurrentWork(), reference) !== true) {
      fail('runtime_continuation_pause_checkpoint_unavailable');
    }
    const release = actorRegistry.pauseForCheckpoint(lease, { settleJournal: () => {
      if (assertProtocol() !== true || assertSettlementCurrent() !== true
        || capturedEvents !== stableJson(collector.capturedEvents)) return false;
      if (!collector.journal) return true;
      if (typeof collector.journal.clear !== 'function') return false;
      const cleared = collector.journal.clear(sessionId, captured.turn_id, { commitResult: prefix.commit });
      return cleared?.ok === true && cleared.durable === true;
    } });
    if (release?.released !== true || release.recoveryBlocked || lease.released !== true) {
      fail('runtime_continuation_canonical_pause_unconfirmed');
    }
    settled = Object.freeze({ status: 'paused', producerSettled: true, canonicalSettled: true,
      checkpointSettled: true, checkpointRef: reference,
      ...(waitResources ? { waitResources } : {}) });
    return settled;
  }

  return Object.freeze({ handleOperation, settlePause, decisionControl });
}

module.exports = { createManagedContinuationBoundary };
