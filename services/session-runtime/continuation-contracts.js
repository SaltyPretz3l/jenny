'use strict';

const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { normalizeCheckpointRef, stableJson } = require('./contracts');

const CONTINUATION_SCHEMA_VERSION = 1;
const CONTINUATION_KIND = 'before_tool_dispatch';
const DEPENDENCY_CONTINUATION_KIND = 'before_dependency_wait';
const DECISION_CONTINUATION_KIND = 'before_decision_wait';
const MAX_CONTINUATION_BYTES = 1024 * 1024;
const MIN_CONTINUATION_BYTES = 2;
const MAX_CONTINUATION_TOOL_CALLS = 256;
const MAX_CONTINUATION_ITERATIONS = 10_000;
const MAX_ACTIVE_BUDGET_MS = 7 * 24 * 60 * 60 * 1000;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RESOURCE_CLASSES = new Set([
  'tool_operations', 'native_processes', 'tests', 'sandbox_commands', 'filesystem',
]);

const TOP_KEYS = ['authority', 'canonical_refs', 'eligibility', 'identity', 'kind',
  'pending_call', 'position', 'route', 'schema_version', 'source_attempt', 'wait'];
const IDENTITY_KEYS = ['checkpoint_id', 'request_id', 'session_id', 'trace_id', 'turn_id', 'work_id'];
const ATTEMPT_KEYS = ['attempt_id', 'authority_revision', 'incarnation', 'stream_id'];
const AUTHORITY_KEYS = ['project_id', 'root_id', 'root_revision', 'sha256'];
const ROUTE_KEYS = ['route_id', 'route_revision', 'sha256'];
const CANONICAL_KEYS = ['history_ref', 'message_ref', 'request_ref', 'tool_batch_ref', 'turn_ref'];
const REF_KEYS = ['ref_id', 'revision', 'sha256'];
const TURN_REF_KEYS = ['ref_id', 'revision', 'sha256', 'stream_id', 'through_seq'];
const POSITION_KEYS = ['active_budget_ms_remaining', 'completed_iterations', 'current_iteration',
  'ordered_call_ids', 'remaining_iterations', 'tool_call_limit', 'tool_calls_consumed'];
const PENDING_CALL_KEYS = ['call_id', 'effective_args_sha256', 'frozen_input_ref', 'tool_id'];
const WAIT_KEYS = ['dependency_id', 'kind', 'operation_id', 'resource_class'];
const ELIGIBILITY_KEYS = ['approval_pending', 'emitted_tool_execution_count', 'mutation_started',
  'pending_call_index', 'preview_count', 'prior_outcome_count'];

class ContinuationContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ContinuationContractError';
    this.code = code;
  }
}

function fail(code) {
  throw new ContinuationContractError(code);
}

function record(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid_${name}`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`invalid_${name}`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string')
    || ownKeys.slice().sort().some((key, index) => key !== keys[index])) {
    fail(`invalid_${name}_keys`);
  }
  const normalized = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail(`invalid_${name}_keys`);
    }
    normalized[key] = descriptor.value;
  }
  return normalized;
}

function identifier(value, name, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !ID.test(value)) fail(`invalid_${name}`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`invalid_${name}`);
  return value;
}

function integer(value, name, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`invalid_${name}`);
  return value;
}

function reference(value, name, { turn = false } = {}) {
  const ref = record(value, turn ? TURN_REF_KEYS : REF_KEYS, name);
  const normalized = {
    ref_id: identifier(ref.ref_id, `${name}_ref_id`),
    revision: integer(ref.revision, `${name}_revision`),
    sha256: digest(ref.sha256, `${name}_sha256`),
  };
  if (turn) {
    normalized.stream_id = identifier(ref.stream_id, `${name}_stream_id`);
    normalized.through_seq = integer(ref.through_seq, `${name}_through_seq`);
  }
  return normalized;
}

function normalizeIdentity(value) {
  const identity = record(value, IDENTITY_KEYS, 'identity');
  return {
    checkpoint_id: identifier(identity.checkpoint_id, 'identity_checkpoint_id'),
    work_id: identifier(identity.work_id, 'identity_work_id'),
    turn_id: identifier(identity.turn_id, 'identity_turn_id'),
    request_id: identifier(identity.request_id, 'identity_request_id'),
    trace_id: identifier(identity.trace_id, 'identity_trace_id', { nullable: true }),
    session_id: identifier(identity.session_id, 'identity_session_id'),
  };
}

function normalizeAttempt(value) {
  const attempt = record(value, ATTEMPT_KEYS, 'source_attempt');
  return {
    attempt_id: identifier(attempt.attempt_id, 'source_attempt_attempt_id'),
    stream_id: identifier(attempt.stream_id, 'source_attempt_stream_id'),
    incarnation: identifier(attempt.incarnation, 'source_attempt_incarnation'),
    authority_revision: identifier(
      attempt.authority_revision, 'source_attempt_authority_revision',
    ),
  };
}

function normalizeAuthority(value) {
  const authority = record(value, AUTHORITY_KEYS, 'authority');
  return {
    project_id: identifier(authority.project_id, 'authority_project_id'),
    root_id: identifier(authority.root_id, 'authority_root_id', { nullable: true }),
    root_revision: integer(authority.root_revision, 'authority_root_revision'),
    sha256: digest(authority.sha256, 'authority_sha256'),
  };
}

function normalizeRoute(value) {
  const route = record(value, ROUTE_KEYS, 'route');
  if (typeof route.route_revision !== 'string' || !REVISION.test(route.route_revision)) {
    fail('invalid_route_revision');
  }
  return {
    route_id: identifier(route.route_id, 'route_id'),
    route_revision: route.route_revision,
    sha256: digest(route.sha256, 'route_sha256'),
  };
}

function normalizeCanonicalRefs(value) {
  const refs = record(value, CANONICAL_KEYS, 'canonical_refs');
  return {
    request_ref: reference(refs.request_ref, 'request_ref'),
    history_ref: reference(refs.history_ref, 'history_ref'),
    message_ref: reference(refs.message_ref, 'message_ref'),
    turn_ref: reference(refs.turn_ref, 'turn_ref', { turn: true }),
    tool_batch_ref: reference(refs.tool_batch_ref, 'tool_batch_ref'),
  };
}

function normalizeContinuationContext(value) {
  const context = record(value, ['authority', 'route', 'schema_version', 'source_attempt', 'turn_id', 'work_id'],
    'continuation_context');
  if (context.schema_version !== CONTINUATION_SCHEMA_VERSION) fail('unsupported_continuation_context_version');
  return {
    schema_version: CONTINUATION_SCHEMA_VERSION,
    work_id: identifier(context.work_id, 'work_id'),
    turn_id: identifier(context.turn_id, 'turn_id'),
    source_attempt: normalizeAttempt(context.source_attempt),
    authority: normalizeAuthority(context.authority),
    route: normalizeRoute(context.route),
  };
}

function normalizePosition(value, completedSpawns = 0, decision = false) {
  const position = record(value, POSITION_KEYS, 'position');
  const completed = integer(position.completed_iterations, 'completed_iterations',
    { minimum: 1, maximum: MAX_CONTINUATION_ITERATIONS });
  const remaining = integer(position.remaining_iterations, 'remaining_iterations',
    { maximum: MAX_CONTINUATION_ITERATIONS });
  const current = integer(position.current_iteration, 'current_iteration',
    { minimum: 1, maximum: MAX_CONTINUATION_ITERATIONS });
  if (current !== completed || completed + remaining > MAX_CONTINUATION_ITERATIONS) {
    fail('invalid_iteration_position');
  }
  const callLimit = integer(position.tool_call_limit, 'tool_call_limit',
    { minimum: 1, maximum: MAX_CONTINUATION_TOOL_CALLS });
  const consumed = integer(position.tool_calls_consumed, 'tool_calls_consumed',
    { minimum: 1, maximum: callLimit });
  let activeBudget = position.active_budget_ms_remaining;
  if (activeBudget !== null) {
    activeBudget = integer(activeBudget, 'active_budget_ms_remaining',
      { maximum: MAX_ACTIVE_BUDGET_MS });
  }
  const callIds = position.ordered_call_ids;
  if (!Array.isArray(callIds) || callIds.length < 1
    || callIds.length > MAX_CONTINUATION_TOOL_CALLS) fail('invalid_ordered_call_ids');
  const normalizedCallIds = Array.from(callIds, callId => identifier(callId, 'ordered_call_id'));
  if (new Set(normalizedCallIds).size !== normalizedCallIds.length
    || (decision ? consumed < normalizedCallIds.length || consumed > normalizedCallIds.length + completedSpawns
      : normalizedCallIds.length + completedSpawns !== consumed)) fail('invalid_ordered_call_ids');
  return {
    completed_iterations: completed,
    remaining_iterations: remaining,
    current_iteration: current,
    tool_call_limit: callLimit,
    tool_calls_consumed: consumed,
    active_budget_ms_remaining: activeBudget,
    ordered_call_ids: normalizedCallIds,
  };
}

function normalizePendingCall(value, firstCallId) {
  const pending = record(value, PENDING_CALL_KEYS, 'pending_call');
  if (typeof pending.tool_id !== 'string' || !TOOL_ID.test(pending.tool_id)) {
    fail('invalid_pending_tool_id');
  }
  const normalized = {
    call_id: identifier(pending.call_id, 'pending_call_id'),
    tool_id: pending.tool_id,
    effective_args_sha256: digest(pending.effective_args_sha256, 'effective_args_sha256'),
    frozen_input_ref: reference(pending.frozen_input_ref, 'frozen_input_ref'),
  };
  if (normalized.call_id !== firstCallId) fail('unsupported_later_call_continuation');
  return normalized;
}

function normalizeWait(value, callId, completedSpawns = null) {
  const wait = record(value, WAIT_KEYS, 'wait');
  if (completedSpawns) {
    if (wait.kind !== 'dependency' || wait.resource_class !== null
      || !completedSpawns.some(ref => ref.child_work_id === wait.dependency_id)
      || wait.operation_id !== callId) fail('unsupported_dependency_wait');
    return { ...wait };
  }
  const explicitPause = wait.kind === 'explicit_pause'
    && wait.resource_class === null && wait.dependency_id === null;
  if (!explicitPause && (wait.kind !== 'resource' || typeof wait.resource_class !== 'string'
    || !RESOURCE_CLASSES.has(wait.resource_class))) fail('unsupported_continuation_wait');
  const normalized = {
    kind: wait.kind,
    resource_class: wait.resource_class,
    dependency_id: identifier(wait.dependency_id, 'wait_dependency_id', { nullable: true }),
    operation_id: identifier(wait.operation_id, 'wait_operation_id'),
  };
  if (normalized.operation_id !== callId) fail('operation_call_identity_mismatch');
  return normalized;
}

function normalizeEligibility(value, completedSpawns = 0, decision = null) {
  const eligibility = record(value, ELIGIBILITY_KEYS, 'eligibility');
  const zeroFields = ['pending_call_index', 'preview_count'];
  const started = decision?.execution_started ? 1 : 0;
  const emitted = decision ? integer(eligibility.emitted_tool_execution_count,
    'emitted_tool_execution_count', { minimum: started, maximum: completedSpawns + started }) : completedSpawns;
  if (zeroFields.some(key => eligibility[key] !== 0)
    || eligibility.prior_outcome_count !== completedSpawns
    || eligibility.emitted_tool_execution_count !== emitted
    || eligibility.approval_pending !== false || eligibility.mutation_started !== false) {
    fail('unsupported_continuation_state');
  }
  return {
    pending_call_index: 0,
    prior_outcome_count: completedSpawns,
    emitted_tool_execution_count: emitted,
    preview_count: 0,
    approval_pending: false,
    mutation_started: false,
  };
}

function normalizeCompletedSpawns(value, { waits = false } = {}) {
  if (!Array.isArray(value) || value.length < 1 || value.length >= MAX_CONTINUATION_TOOL_CALLS) {
    fail('invalid_completed_spawn_refs');
  }
  const refs = Array.from(value, item => {
    const ref = record(item, ['call_id', 'child_work_id', 'result_sha256'], 'completed_spawn_ref');
    return { call_id: identifier(ref.call_id, 'spawn_call_id'),
      child_work_id: identifier(ref.child_work_id, 'spawn_child_work_id'),
      result_sha256: digest(ref.result_sha256, 'spawn_result_sha256') };
  });
  if (new Set(refs.map(ref => ref.call_id)).size !== refs.length
    || (!waits && new Set(refs.map(ref => ref.child_work_id)).size !== refs.length)) fail('invalid_completed_spawn_refs');
  return refs;
}

function validateDependencyPosition(refs, identity, position, pending) {
  if (pending.tool_id !== 'session_wait' || position.ordered_call_ids.length !== 1
    || position.current_iteration < 2 || refs.some(ref => ref.call_id === pending.call_id
      || ref.child_work_id === identity.work_id)) fail('unsupported_dependency_position');
}

function normalizeDecision(value) {
  const decision = record(value, ['call_id', 'decision_id', 'execution_started', 'kind'], 'decision');
  if (!['approval', 'user_questions'].includes(decision.kind)
    || typeof decision.execution_started !== 'boolean'
    || decision.execution_started !== (decision.kind === 'user_questions')) fail('invalid_decision');
  return { kind: decision.kind, decision_id: identifier(decision.decision_id, 'decision_id'),
    call_id: identifier(decision.call_id, 'decision_call_id'), execution_started: decision.execution_started };
}
function normalizeCompletedEffects(value) {
  if (!Array.isArray(value) || value.length >= MAX_CONTINUATION_TOOL_CALLS) fail('invalid_completed_effect_refs');
  const refs = Array.from(value, item => {
    const ref = record(item, ['call_id', 'result_sha256', 'success', 'tool_id'], 'completed_effect_ref');
    if (typeof ref.success !== 'boolean' || typeof ref.tool_id !== 'string' || !TOOL_ID.test(ref.tool_id)) {
      fail('invalid_completed_effect_ref');
    }
    return { call_id: identifier(ref.call_id, 'effect_call_id'), tool_id: ref.tool_id,
      result_sha256: digest(ref.result_sha256, 'effect_result_sha256'), success: ref.success };
  });
  if (new Set(refs.map(ref => ref.call_id)).size !== refs.length) fail('invalid_completed_effect_refs');
  return refs;
}

function normalizeMutationRef(value) {
  const ref = record(value, ['change_set_id', 'operation_count', 'operations_sha256', 'schema_version', 'workspace_id'], 'mutation_ref');
  if (ref.schema_version !== 1 || !/^ws_[a-f0-9]{32}$/u.test(ref.workspace_id || '')
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(ref.change_set_id || '')) fail('invalid_mutation_ref');
  return { schema_version: 1, workspace_id: ref.workspace_id, change_set_id: ref.change_set_id,
    operation_count: integer(ref.operation_count, 'mutation_operation_count', { minimum: 1, maximum: 10000 }),
    operations_sha256: digest(ref.operations_sha256, 'mutation_operations_sha256') };
}

function normalizeContinuation(value) {
  if (Object.getOwnPropertyDescriptor(value || {}, 'schema_version')?.value === 7) {
    const wrapper = record(value, Object.keys(value).sort(), 'continuation');
    const { base_schema_version: base, quota_state: quota, ...body } = wrapper;
    if (!Number.isInteger(base) || ![1, 2, 3, 4, 5, 6, 8].includes(base)) fail('invalid_quota_base_version');
    const normalized = normalizeContinuation({ ...body, schema_version: base });
    return { ...normalized, schema_version: 7, base_schema_version: base,
      quota_state: require('./quota-state').normalizeQuotaState(quota) };
  }
  const resource = Object.getOwnPropertyDescriptor(value || {}, 'kind')?.value === CONTINUATION_KIND
    && Object.getOwnPropertyDescriptor(value || {}, 'schema_version')?.value === 8;
  const dependency = Object.getOwnPropertyDescriptor(value || {}, 'kind')?.value === DEPENDENCY_CONTINUATION_KIND;
  const decisionKind = Object.getOwnPropertyDescriptor(value || {}, 'kind')?.value === DECISION_CONTINUATION_KIND;
  const mutation = decisionKind && Object.getOwnPropertyDescriptor(value || {}, 'schema_version')?.value === 6;
  const approvalBundle = decisionKind && Object.getOwnPropertyDescriptor(value || {}, 'schema_version')?.value === 4;
  const decisionVersion = mutation || approvalBundle || (decisionKind && Object.getOwnPropertyDescriptor(value || {}, 'schema_version')?.value === 3);
  const mixed = dependency && Object.getOwnPropertyDescriptor(value || {}, 'schema_version')?.value === 5;
  const repeated = dependency && Object.getOwnPropertyDescriptor(value || {}, 'schema_version')?.value === 2;
  const extra = repeated || mixed ? ['completed_wait_refs', 'prior_checkpoint_ref', 'prior_effect_count', ...(mixed ? ['completed_effect_refs'] : [])] : [];
  const body = record(value, decisionKind ? [...TOP_KEYS, 'completed_effect_refs', 'decision', 'prior_checkpoint_ref', 'prior_effect_count', ...(approvalBundle || mutation ? ['approval_inputs_ref'] : []), ...(mutation ? ['mutation_ref'] : [])].sort() : dependency ? [...TOP_KEYS, 'completed_spawn_refs', ...extra].sort() : resource ? [...TOP_KEYS, 'completed_effect_refs', 'prior_checkpoint_ref', 'prior_effect_count'].sort() : TOP_KEYS, 'continuation');
  if (body.schema_version !== CONTINUATION_SCHEMA_VERSION && !repeated && !decisionVersion && !mixed && !resource) {
    fail('unsupported_continuation_schema_version');
  }
  if (body.kind !== CONTINUATION_KIND && !dependency && !decisionVersion) fail('unsupported_continuation_kind');
  const decision = decisionKind ? normalizeDecision(body.decision) : null;
  if ((approvalBundle || (mutation && body.approval_inputs_ref !== null)) && decision?.kind !== 'approval') fail('invalid_approval_inputs_kind');
  const approvalInputsRef = (approvalBundle || (mutation && body.approval_inputs_ref !== null)) ? reference(body.approval_inputs_ref, 'approval_inputs_ref') : null;
  const effects = decisionKind || mixed || resource ? normalizeCompletedEffects(body.completed_effect_refs) : [];
  const spawns = dependency ? normalizeCompletedSpawns(body.completed_spawn_refs) : null;
  const waits = repeated || (mixed && body.completed_wait_refs?.length) ? normalizeCompletedSpawns(body.completed_wait_refs, { waits: true }) : [];
  if (mixed && !Array.isArray(body.completed_wait_refs)) fail('invalid_completed_spawn_refs');
  const childRefs = [...(spawns || []), ...waits];
  const allRefs = mixed ? effects : [...childRefs, ...effects];
  const priorCount = decisionKind || mixed || resource ? integer(body.prior_effect_count, 'prior_effect_count', { maximum: effects.length }) : repeated ? integer(body.prior_effect_count, 'prior_effect_count',
    { minimum: 1, maximum: allRefs.length - 1 }) : 0;
  const priorRef = (repeated || ((decisionKind || mixed || resource) && body.prior_checkpoint_ref !== null)) ? record(body.prior_checkpoint_ref,
    ['bytes', 'checkpoint_id', 'schema_version', 'sha256', 'source_attempt'], 'prior_checkpoint_ref') : null;
  const predecessor = priorRef ? normalizeCheckpointRef({ ...priorRef,
    source_attempt: normalizeAttempt(priorRef.source_attempt) }) : null;
  if (priorRef && !predecessor) fail('invalid_dependency_predecessor');
  if (repeated && (!predecessor || new Set(allRefs.map(ref => ref.call_id)).size !== allRefs.length
    || waits.some(ref => !spawns.some(spawn => spawn.child_work_id === ref.child_work_id)))) {
    fail('invalid_dependency_predecessor');
  }
  if (mixed && (new Set(childRefs.map(ref => ref.call_id)).size !== childRefs.length
    || waits.some(ref => !spawns.some(spawn => spawn.child_work_id === ref.child_work_id))
    || spawns.some(ref => !effects.some(effect => effect.call_id === ref.call_id && effect.tool_id === 'session_spawn' && effect.success))
    || waits.some(ref => !effects.some(effect => effect.call_id === ref.call_id && effect.tool_id === 'session_wait' && effect.success))
    || (!predecessor && priorCount !== 0))) fail('invalid_mixed_dependency_effects');
  const identity = normalizeIdentity(body.identity);
  const sourceAttempt = normalizeAttempt(body.source_attempt);
  if (identity.request_id !== sourceAttempt.stream_id) fail('request_stream_identity_mismatch');
  const canonicalRefs = normalizeCanonicalRefs(body.canonical_refs);
  if (canonicalRefs.turn_ref.stream_id !== sourceAttempt.stream_id) {
    fail('turn_ref_stream_mismatch');
  }
  if (predecessor && (predecessor.checkpoint_id === identity.checkpoint_id
    || predecessor.source_attempt.stream_id === sourceAttempt.stream_id
    || predecessor.source_attempt.attempt_id === sourceAttempt.attempt_id)) fail('invalid_dependency_predecessor');
  const position = normalizePosition(body.position, allRefs.length, decisionKind || mixed || resource);
  const pendingCall = normalizePendingCall(body.pending_call, position.ordered_call_ids[0]);
  const wait = normalizeWait(body.wait, pendingCall.call_id, spawns);
  if (decision && (!position.ordered_call_ids.includes(decision.call_id)
    || effects.some(ref => position.ordered_call_ids.includes(ref.call_id))
    || (decision.execution_started && decision.call_id !== pendingCall.call_id)
    || (decision.kind === 'user_questions' && pendingCall.tool_id !== 'ask_user')
    || (!predecessor && priorCount !== 0) || wait.kind !== 'explicit_pause')) fail('invalid_decision_position');
  if (resource && (!effects.length || effects.some(ref => position.ordered_call_ids.includes(ref.call_id))
    || (!predecessor && priorCount !== 0) || wait.kind !== 'resource')) fail('invalid_resource_progress');
  const eligibility = normalizeEligibility(body.eligibility, allRefs.length - priorCount, decision || ((mixed || resource) ? { execution_started: false } : null));
  if (spawns) validateDependencyPosition(childRefs, identity, position, pendingCall);
  if (mixed && effects.some(ref => position.ordered_call_ids.includes(ref.call_id))) fail('invalid_mixed_dependency_effects');
  return {
    schema_version: resource ? 8 : mutation ? 6 : mixed ? 5 : approvalBundle ? 4 : decisionVersion ? 3 : repeated ? 2 : CONTINUATION_SCHEMA_VERSION,
    ...(approvalInputsRef || mutation ? { approval_inputs_ref: approvalInputsRef } : {}),
    ...(mutation ? { mutation_ref: normalizeMutationRef(body.mutation_ref) } : {}),
    kind: body.kind,
    ...(decision ? { decision, completed_effect_refs: effects, prior_checkpoint_ref: predecessor, prior_effect_count: priorCount } : {}),
    ...(mixed ? { completed_effect_refs: effects } : {}),
    ...(resource ? { completed_effect_refs: effects, prior_checkpoint_ref: predecessor, prior_effect_count: priorCount } : {}),
    ...(repeated || mixed ? { completed_wait_refs: waits, prior_checkpoint_ref: predecessor, prior_effect_count: priorCount } : {}),
    ...(spawns ? { completed_spawn_refs: spawns } : {}),
    identity,
    source_attempt: sourceAttempt,
    authority: normalizeAuthority(body.authority),
    route: normalizeRoute(body.route),
    canonical_refs: canonicalRefs,
    position,
    pending_call: pendingCall,
    wait,
    eligibility,
  };
}

function encodeContinuation(value) {
  const normalized = normalizeContinuation(value);
  const body = Buffer.from(stableJson(normalized), 'utf8');
  if (body.length < MIN_CONTINUATION_BYTES || body.length > MAX_CONTINUATION_BYTES) {
    fail('continuation_body_capacity');
  }
  return { body, sha256: createHash('sha256').update(body).digest('hex') };
}

function decodeContinuation(body) {
  if (!Buffer.isBuffer(body) || body.length < MIN_CONTINUATION_BYTES
    || body.length > MAX_CONTINUATION_BYTES) fail('continuation_body_capacity');
  let value;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof ContinuationContractError) throw error;
    fail('invalid_continuation_json');
  }
  const normalized = normalizeContinuation(value);
  const canonical = encodeContinuation(normalized).body;
  if (!canonical.equals(body)) fail('noncanonical_continuation_body');
  return normalized;
}

module.exports = {
  CONTINUATION_KIND,
  DEPENDENCY_CONTINUATION_KIND,
  DECISION_CONTINUATION_KIND,
  CONTINUATION_SCHEMA_VERSION,
  ContinuationContractError,
  MAX_CONTINUATION_BYTES,
  MAX_CONTINUATION_TOOL_CALLS,
  decodeContinuation,
  encodeContinuation,
  normalizeContinuation,
  normalizeContinuationContext,
  normalizeDecision,
  normalizeCompletedEffects,
  normalizeMutationRef,
};
