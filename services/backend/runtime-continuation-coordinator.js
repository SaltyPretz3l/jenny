'use strict';

const { createHash } = require('node:crypto');
const { hasDurableProof } = require('./conversation-store-port');
const { stableJson } = require('../session-runtime/contracts');
const { encodeContinuation, normalizeContinuationContext } = require('../session-runtime/continuation-contracts');

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

// Coordinates two existing persistence owners. A successful publication proves
// only checkpoint durability; the caller still owns worker/attempt settlement.
class RuntimeContinuationCoordinator {
  constructor({ conversationStore, checkpointStore, context, getCurrentWork, assertCurrent, validateDependency = null, validateDecision = null, validateResource = null }) {
    if (typeof conversationStore?.preparePendingContinuation !== 'function'
      || typeof conversationStore?.publishPendingContinuation !== 'function'
      || typeof checkpointStore?.begin !== 'function' || typeof checkpointStore?.commit !== 'function'
      || typeof getCurrentWork !== 'function' || typeof assertCurrent !== 'function') {
      throw new TypeError('runtime_continuation_coordinator_dependencies_invalid');
    }
    this.conversationStore = conversationStore;
    this.checkpointStore = checkpointStore;
    this.context = normalizeContinuationContext(context);
    this.getCurrentWork = getCurrentWork;
    this.assertCurrent = assertCurrent;
    this.validateDependency = validateDependency;
    this.validateDecision = validateDecision;
    this.validateResource = validateResource;
  }

  publish({ proposal, position, wait, eligibility, traceId = null, completedSpawnRefs = null, dependencyProgress = null, decisionProgress = null, resourceProgress = null }) {
    const work = this._current();
    const input = structuredClone(proposal);
    if (stableJson(input?.source_attempt) !== stableJson(this.context.source_attempt)
      || input?.stream_id !== this.context.source_attempt.stream_id) {
      fail('runtime_continuation_proposal_fence_conflict');
    }
    const dependency = wait?.kind === 'dependency';
    if (dependency && this.validateDependency?.({ proposal: input, wait, completedSpawnRefs, dependencyProgress, position, eligibility }) !== true) {
      fail('runtime_continuation_dependency_unproven');
    }
    const assertDecision = () => {
      if (resourceProgress && (wait?.kind !== 'resource' || decisionProgress || dependency
        || this.validateResource?.({ ...resourceProgress, tool_calls: input.tool_calls,
          frozen_input: input.frozen_input, position, eligibility })?.valid !== true)) fail('runtime_continuation_resource_unproven');
      if (decisionProgress && (wait?.kind !== 'explicit_pause'
        || this.validateDecision?.({ ...decisionProgress, tool_calls: input.tool_calls,
          frozen_input: input.frozen_input, approval_inputs_bytes: input.approval_inputs_bytes, position, eligibility })?.valid !== true
        || stableJson(input.decision) !== stableJson(decisionProgress.decision))) fail('runtime_continuation_decision_unproven');
    };
    assertDecision();
    const candidate = this.conversationStore.preparePendingContinuation(work.session_id, input, work);
    const first = input.tool_calls?.[0];
    if (!first || stableJson(position?.ordered_call_ids) !== stableJson(input.tool_calls.map(call => call.call_id))
      || (!dependency && wait?.dependency_id !== null)) fail('runtime_continuation_batch_conflict');
    const baseVersion = resourceProgress ? 8 : decisionProgress?.mutation_ref ? 6 : dependencyProgress?.completed_effect_refs ? 5 : candidate.approvalInputsRef ? 4 : decisionProgress ? 3 : dependencyProgress ? 2 : 1;
    const { body } = encodeContinuation({ schema_version: input.quota_state ? 7 : baseVersion,
      ...(input.quota_state ? { base_schema_version: baseVersion, quota_state: input.quota_state } : {}),
      ...(candidate.approvalInputsRef || decisionProgress?.mutation_ref ? { approval_inputs_ref: candidate.approvalInputsRef || null } : {}),
      kind: decisionProgress ? 'before_decision_wait' : dependency ? 'before_dependency_wait' : 'before_tool_dispatch',
      ...(decisionProgress || resourceProgress || {}),
      ...(dependency ? { completed_spawn_refs: completedSpawnRefs, ...dependencyProgress } : {}),
      identity: { checkpoint_id: input.checkpoint_id, work_id: work.work_id, turn_id: work.turn_id,
        request_id: this.context.source_attempt.stream_id, trace_id: traceId, session_id: work.session_id },
      source_attempt: this.context.source_attempt, authority: this.context.authority, route: this.context.route,
      canonical_refs: candidate.canonicalRefs, position,
      pending_call: { call_id: first.call_id, tool_id: first.tool_id,
        effective_args_sha256: input.frozen_input?.effective_args_fingerprint,
        frozen_input_ref: candidate.frozenInputRef }, wait, eligibility,
    });
    this._current(work);
    assertDecision();
    // Reserve all continuation material before publishing the canonical artifact.
    // Failure after this point deliberately retains a preparing record and its
    // capacity charge. Never delete evidence to make a failed transaction fit.
    const reference = this.checkpointStore.begin(body, work, { canonicalBytes: candidate.encodedArtifactBytes });
    this._current(work);
    assertDecision();
    const result = this.conversationStore.publishPendingContinuation(candidate, { durable: true });
    if (!hasDurableProof(result)) fail('runtime_continuation_canonical_not_durable');
    this._current(work);
    assertDecision();
    const committed = this.checkpointStore.commit(reference, work);
    this._current(work);
    assertDecision();
    return committed;
  }

  _current(previous = null) {
    if (this.assertCurrent() !== true) fail('runtime_continuation_attempt_unavailable');
    const work = this.getCurrentWork();
    const context = this.context;
    if (!work || work.status !== 'running' || work.work_id !== context.work_id || work.turn_id !== context.turn_id
      || stableJson(work.attempt) !== stableJson(context.source_attempt)
      || work.project_id !== context.authority.project_id || work.authority?.project_id !== work.project_id
      || work.authority?.root_id !== context.authority.root_id
      || work.authority?.root_revision !== context.authority.root_revision
      || digest(work.authority) !== context.authority.sha256
      || digest(work.input?.route) !== context.route.sha256
      || work.input?.route?.configuration_revision !== context.route.route_revision
      || context.route.route_id !== `route_${context.route.sha256}`
      || (previous && (work.revision !== previous.revision || work.session_id !== previous.session_id
        || work.submission_hash !== previous.submission_hash))) {
      fail('runtime_continuation_work_fence_conflict');
    }
    return structuredClone(work);
  }
}

module.exports = { RuntimeContinuationCoordinator };
