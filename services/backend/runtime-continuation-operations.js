'use strict';

const { createHash } = require('node:crypto');
const { hasDurableProof } = require('./conversation-store-port');
const { normalizeContinuationContext } = require('../session-runtime/continuation-contracts');
const { normalizeCheckpointRef, stableJson } = require('../session-runtime/contracts');
const { normalizeHistorySelector } = require('./runtime-continuation-records');

const API_VERSION = '2026-08-17';
const MAX_REQUEST_BYTES = 1024 * 1024;
const KEYS = ['api_version', 'authority_revision', 'continuation_context', 'eligibility', 'frozen_input',
  'frozen_input_bytes', 'frozen_input_sha256', 'kind', 'operation_id', 'phase', 'position', 'request_id',
  'schema_version', 'session_id', 'tool_batch_bytes', 'tool_batch_sha256', 'tool_calls'].sort().join(',');
const DECISION_KEYS = [...KEYS.split(','), 'decision', 'completed_effect_refs', 'prior_checkpoint_ref', 'prior_effect_count'].sort().join(',');
const RESOURCE_KEYS = [...KEYS.split(','), 'completed_effect_refs', 'prior_checkpoint_ref', 'prior_effect_count'].sort().join(',');
const APPROVAL_KEYS = [...DECISION_KEYS.split(','), 'approval_inputs_bytes', 'approval_inputs_sha256'].sort().join(',');
const DEPENDENCY_KEYS = [...KEYS.split(','), 'completed_spawn_refs'].sort().join(',');
const REPEATED_KEYS = [...DEPENDENCY_KEYS.split(','), 'completed_wait_refs', 'prior_checkpoint_ref', 'prior_effect_count'].sort().join(',');
const MUTATION_KEYS = [...DECISION_KEYS.split(','), 'mutation_ref'].sort().join(',');
const MUTATION_APPROVAL_KEYS = [...APPROVAL_KEYS.split(','), 'mutation_ref'].sort().join(',');
const MIXED_KEYS = [...REPEATED_KEYS.split(','), 'completed_effect_refs'].sort().join(',');
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PUBLICATION_ERROR_CODES = new Set([
  'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'ENOENT',
  'runtime_resource_progress_unproven', 'runtime_continuation_effects_unproven',
  'runtime_continuation_prefix_ineligible', 'runtime_continuation_prefix_capacity',
  'runtime_continuation_journal_not_durable', 'runtime_continuation_prefix_fence_conflict',
  'runtime_continuation_decision_unproven', 'runtime_continuation_resource_unproven',
  'runtime_continuation_canonical_not_durable', 'runtime_continuation_work_fence_conflict',
]);

function reject(operationId, reason) {
  return { schema_version: 1, operation_id: ID.test(operationId || '') ? operationId : '',
    status: 'rejected', reason };
}

// This is an application-internal reverse request, never a model tool. It can
// checkpoint only the exact operation which this request's resource owner
// already classified as waiting, before any producer was dispatched.
function createRuntimeContinuationOperationHandler({ context, sessionId, traceId = null, coordinator,
  resourceOperations, persistCanonicalPrefix, assertCurrent, historySelector, getCurrentWork = null, dependencyOperations = null, getCanonicalEvents = null, validateDecision = null, validateResource = null, onPublicationFailure = null } = {}) {
  const captured = normalizeContinuationContext(context);
  const capturedHistory = normalizeHistorySelector(historySelector);
  if (!ID.test(sessionId || '') || typeof coordinator?.publish !== 'function'
    || typeof resourceOperations?.validateResourceWait !== 'function'
    || typeof persistCanonicalPrefix !== 'function' || typeof assertCurrent !== 'function') {
    throw new TypeError('runtime_continuation_operation_dependencies_invalid');
  }
  let pending = null;
  function pauseRequested() {
    const work = getCurrentWork?.();
    return Boolean(work?.status === 'running' && work.work_id === captured.work_id
      && work.turn_id === captured.turn_id && work.session_id === sessionId
      && stableJson(work.attempt) === stableJson(captured.source_attempt)
      && work.control_request?.kind === 'pause');
  }
  async function publish(params) {
    const id = params.operation_id;
    const quota = Object.hasOwn(params, 'quota_state') ? { quota_state: params.quota_state } : {};
    const first = params.tool_calls?.[0];
    // Resource admission owns the visible arguments. Execution adds scoped
    // identifiers/read snapshots later; those exact effective bytes are kept
    // separately in the canonical artifact and checked on resume.
    const wait = () => params.phase === 'resource_checkpoint'
      ? (validateResource?.(params)?.valid === true ? resourceOperations.validateResourceWait(id, first?.tool_id, params.frozen_input?.visible_tool_arguments) : null)
      : params.phase === 'decision_checkpoint'
      ? (pauseRequested() && validateDecision?.(params) ? { kind: 'explicit_pause', resource_class: null, dependency_id: null } : null)
      : params.phase === 'dependency_checkpoint'
      ? dependencyOperations?.validateWait(id, first?.tool_id, params.frozen_input?.visible_tool_arguments,
        params.completed_spawn_refs, getCanonicalEvents?.(), (params.prior_checkpoint_ref || Object.hasOwn(params, 'completed_effect_refs')) ? {
          completed_wait_refs: params.completed_wait_refs, prior_checkpoint_ref: params.prior_checkpoint_ref,
          ...quota, prior_effect_count: params.prior_effect_count, position: params.position, eligibility: params.eligibility,
          tool_calls: params.tool_calls, frozen_input: params.frozen_input,
          ...(Object.hasOwn(params, 'completed_effect_refs') ? { completed_effect_refs: params.completed_effect_refs } : {}) } : null)?.wait
      : params.phase === 'pause_probe'
      ? (pauseRequested() ? { kind: 'explicit_pause', resource_class: null, dependency_id: null } : null)
      : resourceOperations.validateResourceWait(id, first?.tool_id, params.frozen_input?.visible_tool_arguments);
    let stage = 'wait_validation';
    try {
      if (assertCurrent() !== true || !wait()) return reject(id, 'runtime_continuation_wait_unavailable');
      stage = 'canonical_prefix';
      const prefix = await persistCanonicalPrefix(params.phase === 'decision_checkpoint' ? DECISION_KEYS : params.phase === 'dependency_checkpoint' ? () => Boolean(wait()) : null, params.tool_calls, ['decision_checkpoint', 'resource_checkpoint'].includes(params.phase) ? params : null);
      if (!hasDurableProof(prefix?.commit) || !Number.isSafeInteger(prefix?.through_seq) || prefix.through_seq < 0) {
        return reject(id, 'runtime_continuation_prefix_not_durable');
      }
      stage = 'wait_revalidation';
      const resourceWait = wait();
      if (assertCurrent() !== true || !resourceWait) return reject(id, 'runtime_continuation_wait_unavailable');
      const checkpointId = `checkpoint_${createHash('sha256').update(stableJson({
        work_id: captured.work_id, attempt: captured.source_attempt, operation_id: id,
      })).digest('hex')}`;
      const decisionProof = params.phase === 'decision_checkpoint' ? validateDecision?.(params) : null;
      const resourceProof = params.phase === 'resource_checkpoint' ? validateResource?.(params) : null;
      stage = 'checkpoint_publication';
      const checkpoint = coordinator.publish({ resourceProgress: resourceProof ? { ...quota,
        completed_effect_refs: params.completed_effect_refs, prior_checkpoint_ref: params.prior_checkpoint_ref,
        prior_effect_count: params.prior_effect_count } : null, proposal: {
        ...quota,
        ...(decisionProof ? { decision: params.decision } : {}),
        ...(Object.hasOwn(params, 'mutation_ref') ? { mutation_ref: params.mutation_ref } : {}),
        ...(Object.hasOwn(params, 'approval_inputs_bytes') ? { approval_inputs_bytes: params.approval_inputs_bytes,
          approval_inputs_sha256: params.approval_inputs_sha256 } : {}),
        checkpoint_id: checkpointId, source_attempt: captured.source_attempt,
        stream_id: captured.source_attempt.stream_id, through_seq: prefix.through_seq,
        projection_event_ids: prefix.projection_event_ids || [],
        history_selector: structuredClone(capturedHistory),
        tool_calls: params.tool_calls, tool_batch_bytes: params.tool_batch_bytes,
        tool_batch_sha256: params.tool_batch_sha256, frozen_input: params.frozen_input,
        frozen_input_bytes: params.frozen_input_bytes, frozen_input_sha256: params.frozen_input_sha256,
      }, decisionProgress: decisionProof ? { ...quota, ...(Object.hasOwn(params, 'mutation_ref') ? { mutation_ref: params.mutation_ref } : {}), decision: params.decision, completed_effect_refs: params.completed_effect_refs,
        prior_checkpoint_ref: params.prior_checkpoint_ref, prior_effect_count: params.prior_effect_count } : null,
      completedSpawnRefs: params.completed_spawn_refs || null,
      dependencyProgress: params.phase === 'dependency_checkpoint' && (params.prior_checkpoint_ref || Object.hasOwn(params, 'completed_effect_refs')) ? {
        ...quota, ...(Object.hasOwn(params, 'completed_effect_refs') ? { completed_effect_refs: params.completed_effect_refs } : {}), completed_wait_refs: params.completed_wait_refs,
        prior_checkpoint_ref: params.prior_checkpoint_ref, prior_effect_count: params.prior_effect_count } : null, position: params.position, eligibility: decisionProof || resourceProof
        ? { ...params.eligibility, emitted_tool_execution_count: (decisionProof || resourceProof).emittedCount } : params.eligibility, traceId,
      wait: { kind: 'resource', operation_id: id, ...resourceWait } });
      stage = 'commit_validation';
      const reference = normalizeCheckpointRef(checkpoint);
      if (!reference || reference.checkpoint_id !== checkpointId
        || stableJson(reference.source_attempt) !== stableJson(captured.source_attempt)
        || assertCurrent() !== true) return reject(id, 'runtime_continuation_commit_unavailable');
      return { schema_version: 1, operation_id: id, status: 'checkpointed', checkpoint_ref: reference };
    } catch (error) {
      // Keep recovery evidence in its owning stores. Do not leak arbitrary
      // persistence exceptions, paths or user arguments into a protocol error.
      const code = PUBLICATION_ERROR_CODES.has(error?.code) ? error.code
        : PUBLICATION_ERROR_CODES.has(error?.message) ? error.message : 'unclassified';
      try {
        onPublicationFailure?.({ stage, error_code: code });
      } catch (_diagnosticError) { /* Diagnostics must not change rejection. */ }
      return reject(id, 'runtime_continuation_publication_failed');
    }
  }
  return function handle(params) {
    const id = typeof params?.operation_id === 'string' ? params.operation_id : '';
    let fingerprint;
    let copy;
    try {
      if (!params || Object.keys(params).filter(key => key !== 'quota_state').sort().join(',') !== (params.phase === 'resource_checkpoint' ? RESOURCE_KEYS : params.phase === 'decision_checkpoint' ? (Object.hasOwn(params, 'mutation_ref') ? (Object.hasOwn(params, 'approval_inputs_bytes') ? MUTATION_APPROVAL_KEYS : MUTATION_KEYS) : Object.hasOwn(params, 'approval_inputs_bytes') ? APPROVAL_KEYS : DECISION_KEYS) : params.phase === 'dependency_checkpoint' ? (Object.hasOwn(params, 'completed_effect_refs') ? MIXED_KEYS : Object.hasOwn(params, 'prior_checkpoint_ref') ? REPEATED_KEYS : DEPENDENCY_KEYS) : KEYS) || !ID.test(id)
        || (Object.hasOwn(params, 'approval_inputs_bytes') && params.decision?.kind !== 'approval')
        || (params.decision?.kind === 'approval' && params.tool_calls?.length > 1
          && !Object.hasOwn(params, 'approval_inputs_bytes'))
        || params.api_version !== API_VERSION || params.schema_version !== 1
        || params.kind !== 'continuation' || !['checkpoint', 'pause_probe', 'dependency_checkpoint', 'decision_checkpoint', 'resource_checkpoint'].includes(params.phase)
        || params.request_id !== captured.source_attempt.stream_id || params.session_id !== sessionId
        || params.authority_revision !== captured.source_attempt.authority_revision
        || stableJson(normalizeContinuationContext(params.continuation_context)) !== stableJson(captured)
        || params.tool_calls?.[0]?.call_id !== id || params.frozen_input?.call_id !== id
        || params.tool_calls?.[0]?.tool_id !== params.frozen_input?.tool_name) {
        return Promise.resolve(reject(id, 'runtime_continuation_request_invalid'));
      }
      const json = JSON.stringify(params);
      if (Buffer.byteLength(json) > MAX_REQUEST_BYTES) return Promise.resolve(reject(id, 'runtime_continuation_request_capacity'));
      copy = JSON.parse(json);
      fingerprint = createHash('sha256').update(stableJson(copy)).digest('hex');
      if (assertCurrent() !== true) return Promise.resolve(reject(id, 'runtime_continuation_attempt_unavailable'));
    } catch (_error) { return Promise.resolve(reject(id, 'runtime_continuation_request_invalid')); }
    if (copy.phase === 'pause_probe' && !pending) {
      if (typeof getCurrentWork !== 'function') return Promise.resolve(reject(id, 'runtime_pause_probe_unavailable'));
      if (!pauseRequested()) return Promise.resolve({ schema_version: 1, operation_id: id, status: 'continue' });
    }
    if (pending) {
      return pending.fingerprint === fingerprint ? pending.promise
        : Promise.resolve(reject(id, 'runtime_continuation_request_conflict'));
    }
    // One eligible first-call checkpoint per physical attempt. Equal transport
    // retries share the same transaction; a changed request cannot replace it.
    const promise = Promise.resolve().then(() => publish(copy));
    pending = { fingerprint, promise };
    return promise;
  };
}

module.exports = { createRuntimeContinuationOperationHandler };
