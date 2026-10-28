'use strict';

// Pure `kind:"session"` proposal records (row 59 checkpoint 5a-1): the propose_session
// input, the session binding and options, the handoff and child-creation proof, and the
// session state machine. Sibling of ./chat-proposal-command-records: every transition
// returns the next record (revision + 1) or null when it is not allowed from the current
// state, and none performs IO. The "Do it here" continuation reuses the Git helpers in
// ./chat-proposal-records (their kind guard covers session do_it_here).

const crypto = require('crypto');
const R = require('./chat-proposal-records');
const { normalizeReasoningEffort } = require('../../reasoning-effort-profiles');

const {
  isPlainObject, isHex64, isNonEmptyString, nullOr, validText, checkKeys, fail, INVISIBLE_RE, wellFormed, validCommonBinding,
} = R.primitives;
const {
  PROPOSAL_ERROR_CODES: CODES, canonicalJson, decisionFor, isUuid, nextRevision: next, pendingLive, sha256Hex,
} = R;

const INITIATIONS = Object.freeze(['offer', 'own_initiative', 'user_asked']);
const { SESSION_CHOICES } = R.primitives;
const SOURCE_RUN_MODES = Object.freeze(['ask', 'auto', 'plan', 'propose']);
const OPTION_RUN_MODES = Object.freeze(['agent', 'plan']);
const SESSION_LIMITS = Object.freeze({
  title_chars: 160,
  description_chars: 1024,
  task_bytes: 16 * 1024,
  background_bytes: 32 * 1024,
  group_max: 10,
  model_chars: 200,
  active_grants_max: 20,
  grant_prune_ms: 30 * 24 * 60 * 60 * 1000,
});
const GROUP_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GROUP_ID_RE = /^group_[0-9a-f]{64}$/;
const RETRYABLE_SESSION_REASONS = Object.freeze(['unavailable', 'dispatch_failed', 'preparation_failed']);
const PROGRESS_KEYS = Object.freeze([
  'preparation_work_id', 'preparation_turn_id', 'child_session_id', 'child_session_incarnation', 'child_creation_hash',
  'first_turn_work_id', 'first_turn_turn_id', 'continuation_work_id', 'continuation_turn_id', 'handoff',
]);

const absent = (value) => value === undefined || value === null;
const isSession = (record) => record?.kind === 'session';
const isNewSession = (record) => isSession(record) && record.decision?.choice === 'new_session';
const accepted = (record) => record.decision_state === 'accepted';
const hasKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

// ---------- identities and keys ----------

// UUID-shaped, stable per input parts (version nibble 5, variant 8..b): group decision rows, grant decisions.
function derivedUuid(...parts) {
  const hex = sha256Hex(canonicalJson(parts));
  const variant = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const computeGroupId = (incarnation, turnId, groupKey) => `group_${sha256Hex(canonicalJson([incarnation, turnId, groupKey]))}`;
const buildLocalDispatchKey = (proposalId, decisionId) => R.buildGitDispatchKey(proposalId, decisionId);
const buildPrepareDispatchKey = (proposalId, decisionId, attemptNumber) => `proposal:${proposalId}:${decisionId}:prepare:${attemptNumber}`;
const FIRST_TURN_DISPATCH_KEY = (proposalId) => `proposal:${proposalId}:first_turn`;

// ---------- input, options, handoff ----------

// The primary's destination project (row 76): a short id with no control or invisible characters.
const validProjectId = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 128
  && !/\p{Cc}/u.test(value) && !INVISIBLE_RE.test(value);

// The model the offer card is pre-filled with: one trimmed line, no control or invisible characters.
const validModelName = (value) => validText(value, SESSION_LIMITS.model_chars) && !/\p{Cc}/u.test(value) && !INVISIBLE_RE.test(value);

const SESSION_INPUT_KEYS = Object.freeze([
  'schema_version', 'initiation', 'title', 'description', 'group_key', 'authorization_ref', 'project_id',
  'preferred_model', 'reasoning_effort',
]);

function normalizeSessionProposalInput(args) {
  const bad = checkKeys(args, SESSION_INPUT_KEYS);
  if (bad) return bad;
  const { initiation, title } = args;
  if (!INITIATIONS.includes(initiation)) return fail('field_initiation');
  if (!validText(title, SESSION_LIMITS.title_chars) || /[\r\n]/.test(title) || INVISIBLE_RE.test(title)) return fail('field_title');
  const description = absent(args.description) ? null : args.description;
  if (description !== null && (!validText(description, SESSION_LIMITS.description_chars) || INVISIBLE_RE.test(description))) {
    return fail('field_description');
  }
  const groupKey = absent(args.group_key) ? null : args.group_key;
  if (groupKey !== null && (initiation !== 'own_initiative' || typeof groupKey !== 'string' || !GROUP_KEY_RE.test(groupKey))) {
    return fail('field_group_key');
  }
  const ref = absent(args.authorization_ref) ? null : args.authorization_ref;
  if (ref !== null && (initiation !== 'user_asked' || !isUuid(ref))) return fail('field_authorization_ref');
  const projectId = absent(args.project_id) ? null : args.project_id;
  if (projectId !== null && !validProjectId(projectId)) return fail('field_project_id');
  // A blank model keeps the source chat's seeding; an invalid effort is ignored ('default' reads as no pre-fill).
  const model = typeof args.preferred_model === 'string' && !args.preferred_model.trim() ? null : args.preferred_model;
  if (!absent(model) && !validModelName(model)) return fail('field_preferred_model');
  const preferredModel = absent(model) ? null : model.trim();
  const effort = typeof args.reasoning_effort === 'string' ? normalizeReasoningEffort(args.reasoning_effort) : 'default';
  // project_id and the pre-fills are carried only when set, so inputs stored before them normalize to themselves.
  return {
    ok: true,
    value: {
      schema_version: 1, initiation, title, description, group_key: groupKey, authorization_ref: ref,
      ...(projectId === null ? {} : { project_id: projectId }),
      ...(preferredModel === null ? {} : { preferred_model: preferredModel }),
      ...(effort === 'default' ? {} : { reasoning_effort: effort }),
    },
  };
}

const blankToNull = (value) => (typeof value === 'string' && value.trim() ? value : null);

// Publish default: the source's project, model and effort; Plan only when the source is in Plan.
function defaultOptions({ sourceProjectId = null, model = null, effort = null, planMode = false } = {}) {
  return {
    destination_project_id: blankToNull(sourceProjectId),
    preferred_model: blankToNull(model),
    reasoning_effort: blankToNull(effort),
    run_mode: planMode === true ? 'plan' : 'agent',
  };
}

function validOptions(options) {
  return hasKeys(options, ['destination_project_id', 'preferred_model', 'reasoning_effort', 'run_mode'])
    && nullOr(options.destination_project_id, (v) => isNonEmptyString(v, 256))
    && nullOr(options.preferred_model, (v) => isNonEmptyString(v, 256))
    && nullOr(options.reasoning_effort, (v) => isNonEmptyString(v, 64))
    && OPTION_RUN_MODES.includes(options.run_mode);
}

function sessionTextOk(text, { maxBytes, allowEmpty }) {
  if (typeof text !== 'string' || !wellFormed(text) || text.includes('\0') || INVISIBLE_RE.test(text)) return false;
  if (!allowEmpty && text.trim().length === 0) return false;
  return Buffer.byteLength(text, 'utf8') <= maxBytes;
}

// null when valid, else the failing field: 'field_task' | 'field_background'.
function handoffTextCause({ task, background } = {}) {
  if (!sessionTextOk(task, { maxBytes: SESSION_LIMITS.task_bytes, allowEmpty: false })) return 'field_task';
  if (!sessionTextOk(background, { maxBytes: SESSION_LIMITS.background_bytes, allowEmpty: true })) return 'field_background';
  return null;
}

const validHandoffText = (text) => isPlainObject(text) && handoffTextCause(text) === null;
const handoffSha256 = ({ task, background }) => sha256Hex(canonicalJson({ task, background }));

function validStoredHandoff(handoff) {
  return hasKeys(handoff, ['task', 'background', 'sha256']) && validHandoffText(handoff) && handoff.sha256 === handoffSha256(handoff);
}

function childCreationHash({ proposalId, childSessionId, childIncarnation, handoffSha256: textSha, options }) {
  return sha256Hex(canonicalJson([proposalId, childSessionId, childIncarnation, textSha, options]));
}

// ---------- binding and record validation ----------

function validSessionBinding(binding) {
  if (!validCommonBinding(binding, true) || binding.git !== null || binding.command !== null) return false;
  const info = binding.session;
  if (!hasKeys(info, ['effective_initiation', 'authorization_required', 'launch_grant_ref', 'source_run_mode', 'lockdown'])) return false;
  if (!INITIATIONS.includes(info.effective_initiation) || !SOURCE_RUN_MODES.includes(info.source_run_mode)) return false;
  if (typeof info.authorization_required !== 'boolean' || typeof info.lockdown !== 'boolean') return false;
  if (!nullOr(info.launch_grant_ref, isUuid) || (info.effective_initiation === 'user_asked') !== (info.launch_grant_ref !== null)) return false;
  return !info.authorization_required || (info.effective_initiation === 'offer' && info.launch_grant_ref === null);
}

// The binding's effective initiation must follow from what the model asked for.
function validInitiationBinding(input, info) {
  if (input.initiation !== 'user_asked') {
    return info.effective_initiation === input.initiation && !info.authorization_required;
  }
  // D7: an omitted ref consumed the calling turn's own grant; a given ref must name the consumed grant.
  if (info.effective_initiation === 'user_asked') {
    return input.authorization_ref === null || info.launch_grant_ref === input.authorization_ref;
  }
  return info.effective_initiation === 'offer' && info.authorization_required;
}

// A decision's options: the accepting snapshot for new_session, null for do_it_here and dismiss.
function validDecisionOptions(decision) {
  return decision.choice === 'new_session' ? validOptions(decision.options) : decision.options === null;
}

const optionalIds = (raw, keys) => keys.every((key) => nullOr(raw[key], (v) => isNonEmptyString(v, 256)));

// All-or-nothing handoff proof (handoff, child ids, creation hash) with the hash recomputed.
function validProof(raw) {
  const { handoff } = raw;
  if (!optionalIds(raw, ['child_session_id', 'child_session_incarnation'])) return false;
  if (!nullOr(raw.child_creation_hash, isHex64) || !nullOr(handoff, validStoredHandoff)) return false;
  const present = [handoff, raw.child_session_id, raw.child_session_incarnation, raw.child_creation_hash].filter((v) => v !== null);
  if (present.length === 0) return true;
  if (present.length !== 4 || !raw.decision || !validOptions(raw.decision.options)) return false;
  return raw.child_creation_hash === childCreationHash({
    proposalId: raw.proposal_id, childSessionId: raw.child_session_id, childIncarnation: raw.child_session_incarnation,
    handoffSha256: handoff.sha256, options: raw.decision.options,
  });
}

function validAcceptedProgress(raw) {
  const { decision, action_state: state, proposal_id: id } = raw;
  const proofSet = raw.handoff !== null;
  if (raw.attempt_id === null || raw.attempt_number < 1 || raw.dispatch_key === null) return false;
  if (decision.choice === 'do_it_here') {
    if (state === 'preparing' || state === 'child_created' || proofSet) return false;
    if (!['preparation_work_id', 'preparation_turn_id', 'first_turn_work_id', 'first_turn_turn_id'].every((key) => raw[key] === null)) return false;
    return raw.dispatch_key === buildLocalDispatchKey(id, decision.decision_id);
  }
  if (raw.continuation_work_id !== null || raw.continuation_turn_id !== null) return false;
  if (['waiting_for_source', 'queued'].includes(state) && proofSet) return false;
  if (['child_created', 'succeeded'].includes(state) && !proofSet) return false;
  if (!proofSet && (raw.first_turn_work_id !== null || raw.first_turn_turn_id !== null)) return false;
  const expected = proofSet ? FIRST_TURN_DISPATCH_KEY(id) : buildPrepareDispatchKey(id, decision.decision_id, raw.attempt_number);
  return raw.dispatch_key === expected;
}

// Session-specific record rules on top of the shared normalizer (identity, hashes, combos).
function validSessionRecord(raw) {
  const { normalized_input: input, binding } = raw;
  if (!validOptions(raw.options) || !validInitiationBinding(input, binding.session)) return false;
  const grouped = input.initiation === 'own_initiative' && input.group_key !== null;
  const expectedGroup = grouped ? computeGroupId(raw.source_session_incarnation, raw.source_turn_id, input.group_key) : null;
  if (raw.group_id !== expectedGroup || !nullOr(raw.group_id, (v) => GROUP_ID_RE.test(v))) return false;
  if (!optionalIds(raw, ['preparation_work_id', 'preparation_turn_id', 'first_turn_work_id', 'first_turn_turn_id'])) return false;
  if (!validProof(raw)) return false;
  if (!accepted(raw)) {
    return raw.attempt_id === null && raw.attempt_number === 0 && raw.dispatch_key === null
      && PROGRESS_KEYS.every((key) => raw[key] === null);
  }
  return validAcceptedProgress(raw);
}

// Fields createProposalRecord adds for a session proposal: the options and the derived group id. The
// model's pre-fill replaces the source seeding of the card's model and effort; nothing else.
function sessionCreateFields({ options, input, incarnation, turnId }) {
  const grouped = input?.initiation === 'own_initiative' && typeof input.group_key === 'string';
  return {
    options: {
      ...structuredClone(options),
      ...(typeof input?.preferred_model === 'string' ? { preferred_model: input.preferred_model } : {}),
      ...(typeof input?.reasoning_effort === 'string' ? { reasoning_effort: input.reasoning_effort } : {}),
    },
    group_id: grouped ? computeGroupId(incarnation, turnId, input.group_key) : null,
  };
}

// ---------- transitions ----------

function acceptWith(record, { decisionId, choice, now, attemptId, state }) {
  const attempt = record.attempt_number + 1;
  const key = choice === 'do_it_here'
    ? buildLocalDispatchKey(record.proposal_id, decisionId)
    : buildPrepareDispatchKey(record.proposal_id, decisionId, attempt);
  return next(record, {
    decision_state: 'accepted',
    action_state: state,
    decision: { ...decisionFor(record, { decisionId, choice, now }), options: choice === 'new_session' ? structuredClone(record.options) : null },
    attempt_id: attemptId,
    attempt_number: attempt,
    dispatch_key: key,
    dispatch_key_sha256: sha256Hex(key),
    last_error: null,
  });
}

// pending -> accepted/queued (or waiting_for_source while an ordinary offer's turn is unsettled).
function acceptSessionDecision(record, {
  decisionId, choice, now, attemptId = crypto.randomUUID(), waitForSource = false,
} = {}) {
  if (!isSession(record) || !pendingLive(record, now) || !isUuid(decisionId) || !isUuid(attemptId)) return null;
  if (choice !== 'do_it_here' && choice !== 'new_session') return null;
  return acceptWith(record, { decisionId, choice, now, attemptId, state: waitForSource ? 'waiting_for_source' : 'queued' });
}

// A consumed launch grant accepts the user_asked proposal as New session with the default options.
function acceptFromGrant(record, { grantRef, now, attemptId = crypto.randomUUID() } = {}) {
  if (!isSession(record) || !pendingLive(record, now) || !isUuid(grantRef) || !isUuid(attemptId)) return null;
  const info = record.binding.session;
  if (info.effective_initiation !== 'user_asked' || info.launch_grant_ref !== grantRef) return null;
  const decisionId = derivedUuid('launch_grant', grantRef, record.proposal_id);
  return acceptWith(record, { decisionId, choice: 'new_session', now, attemptId, state: 'queued' });
}

const isWaiting = (record) => isSession(record) && accepted(record) && record.action_state === 'waiting_for_source';
const releaseWaiting = (record) => (isWaiting(record) ? next(record, { action_state: 'queued' }) : null);
const cancelWaiting = (record) => (isWaiting(record) ? next(record, { action_state: 'cancelled' }) : null);

const isPrepQueued = (record) => isNewSession(record) && accepted(record) && record.action_state === 'queued' && record.handoff === null;

// The runtime's work and turn ids for the preparation turn. Adopted once (an event can beat the ack).
function markPrepAcknowledged(record, { workId, turnId } = {}) {
  const live = isPrepQueued(record) || (isNewSession(record) && accepted(record) && record.action_state === 'preparing' && record.handoff === null);
  if (!live || record.preparation_work_id !== null || typeof workId !== 'string' || typeof turnId !== 'string') return null;
  return next(record, { preparation_work_id: workId, preparation_turn_id: turnId });
}

// Preparation submission refused before the runtime took it: nothing ran, retryable.
function markPrepRefused(record, { runtimeUnavailable = false, causeCode = null } = {}) {
  if (!isPrepQueued(record)) return null;
  const lastError = runtimeUnavailable
    ? { code: CODES.unavailable, reason: 'unavailable', retryable: true, cause_code: causeCode || 'runtime_unavailable' }
    : { code: CODES.dispatch_failed, reason: 'dispatch_failed', retryable: true, cause_code: causeCode };
  return next(record, { action_state: 'needs_attention', last_error: lastError });
}

const markPreparing = (record) => (isPrepQueued(record) ? next(record, { action_state: 'preparing' }) : null);

// The accepted handoff: reserves the child id, incarnation and creation proof, and switches the dispatch key.
function recordHandoff(record, {
  task, background, childSessionId, childIncarnation,
} = {}) {
  if (!isNewSession(record) || !accepted(record) || record.action_state !== 'preparing' || record.handoff !== null) return null;
  if (!validHandoffText({ task, background })) return null;
  if (!isNonEmptyString(childSessionId, 256) || !isNonEmptyString(childIncarnation, 256)) return null;
  const textSha = handoffSha256({ task, background });
  const key = FIRST_TURN_DISPATCH_KEY(record.proposal_id);
  return next(record, {
    handoff: { task, background, sha256: textSha },
    child_session_id: childSessionId,
    child_session_incarnation: childIncarnation,
    child_creation_hash: childCreationHash({
      proposalId: record.proposal_id, childSessionId, childIncarnation, handoffSha256: textSha, options: record.decision.options,
    }),
    dispatch_key: key,
    dispatch_key_sha256: sha256Hex(key),
    last_error: null,
  });
}

const hasReservedChild = (record) => isNewSession(record) && accepted(record) && record.handoff !== null && record.child_session_id !== null;
const markChildCreated = (record) => (hasReservedChild(record) && record.action_state === 'preparing'
  ? next(record, { action_state: 'child_created' }) : null);

function markFirstTurnAdmitted(record, { workId, turnId } = {}) {
  if (!hasReservedChild(record) || record.action_state !== 'child_created') return null;
  if (typeof workId !== 'string' || typeof turnId !== 'string') return null;
  return next(record, { action_state: 'succeeded', first_turn_work_id: workId, first_turn_turn_id: turnId, last_error: null });
}

// The child could not be created or the first turn was refused. The reserved child is kept.
function markFirstTurnRefused(record, { causeCode = null, runtimeUnavailable = false } = {}) {
  if (!hasReservedChild(record) || !['preparing', 'child_created'].includes(record.action_state)) return null;
  const lastError = runtimeUnavailable
    ? { code: CODES.unavailable, reason: 'unavailable', retryable: true, cause_code: causeCode || 'runtime_unavailable' }
    : { code: CODES.dispatch_failed, reason: 'dispatch_failed', retryable: true, cause_code: causeCode };
  return next(record, { action_state: 'needs_attention', last_error: lastError });
}

// The preparation turn ended without an accepted handoff (no_handoff | deadline | prep_error).
function markPreparationFailed(record, { causeCode = null } = {}) {
  if (!isNewSession(record) || !accepted(record) || record.handoff !== null) return null;
  if (!['queued', 'preparing'].includes(record.action_state)) return null;
  return next(record, {
    action_state: 'needs_attention',
    last_error: { code: CODES.preparation_failed, reason: 'preparation_failed', retryable: true, cause_code: causeCode },
  });
}

// Pre-child cancel: a waiting choice, or a New session before any child is reserved; also a reserved
// child whose first turn was never admitted (needs_attention), which lifts the child's send fence.
// A Do it here continuation is cancelled through the runtime (markContinuationOutcome).
function markSessionCancelled(record) {
  if (!isSession(record) || !accepted(record)) return null;
  if (record.action_state === 'waiting_for_source') return next(record, { action_state: 'cancelled' });
  if (hasReservedChild(record) && record.action_state === 'needs_attention' && record.first_turn_work_id === null) {
    return next(record, { action_state: 'cancelled' });
  }
  const pre = isNewSession(record) && record.child_session_id === null && record.handoff === null;
  return pre && ['queued', 'preparing'].includes(record.action_state) ? next(record, { action_state: 'cancelled' }) : null;
}

function canCancelSession(record) {
  if (!isSession(record) || !accepted(record)) return false;
  if (record.decision.choice === 'do_it_here') return ['waiting_for_source', 'queued', 'admitted'].includes(record.action_state);
  return markSessionCancelled(record) !== null;
}

function canRetrySession(record) {
  if (!isSession(record) || !accepted(record) || record.action_state !== 'needs_attention') return false;
  const error = record.last_error;
  if (error?.retryable !== true) return false;
  const reasons = record.decision.choice === 'do_it_here' ? RETRYABLE_SESSION_REASONS.slice(0, 2) : RETRYABLE_SESSION_REASONS;
  return reasons.includes(error.reason);
}

// do_it_here: queued, same key (as Git). New session without a child: a fresh preparation attempt
// (new key, handoff cleared). New session with a reserved child: back to preparing with the SAME proof
// and first-turn key; the service creates the child if it is missing, then marks it created and resubmits.
function prepareSessionRetry(record, { attemptId = crypto.randomUUID() } = {}) {
  if (!canRetrySession(record) || !isUuid(attemptId)) return null;
  const attempt = record.attempt_number + 1;
  const bump = { attempt_id: attemptId, attempt_number: attempt, last_error: null };
  if (record.decision.choice === 'do_it_here') return next(record, { action_state: 'queued', ...bump });
  if (record.child_session_id !== null) return next(record, { action_state: 'preparing', ...bump });
  const key = buildPrepareDispatchKey(record.proposal_id, record.decision.decision_id, attempt);
  return next(record, {
    action_state: 'queued', ...bump, handoff: null, preparation_work_id: null, preparation_turn_id: null,
    dispatch_key: key, dispatch_key_sha256: sha256Hex(key),
  });
}

// Options are editable only while pending; the caller validates against the live capabilities.
function setSessionOptions(record, options) {
  if (!isSession(record) || record.decision_state !== 'pending' || !validOptions(options)) return null;
  return next(record, { options: structuredClone(options) });
}

// Grants expired more than 30 days ago are dropped unless an unresolved proposal still names them.
function pruneLaunchGrants(grants, records, now) {
  const nowMs = Date.parse(R.primitives.isoFromNow(now));
  const named = new Set(records.filter(R.isUnresolved).map((r) => r.binding?.session?.launch_grant_ref).filter(Boolean));
  return grants.filter((grant) => Date.parse(grant.expires_at) + SESSION_LIMITS.grant_prune_ms >= nowMs
    || named.has(grant.authorization_ref));
}

module.exports = {
  FIRST_TURN_DISPATCH_KEY,
  GROUP_ID_RE,
  INITIATIONS,
  SESSION_CHOICES,
  SESSION_LIMITS,
  acceptFromGrant,
  acceptSessionDecision,
  buildLocalDispatchKey,
  buildPrepareDispatchKey,
  canCancelSession,
  canRetrySession,
  cancelWaiting,
  childCreationHash,
  computeGroupId,
  defaultOptions,
  derivedUuid,
  handoffSha256,
  handoffTextCause,
  markChildCreated,
  markFirstTurnAdmitted,
  markFirstTurnRefused,
  markPrepAcknowledged,
  markPrepRefused,
  markPreparationFailed,
  markPreparing,
  markSessionCancelled,
  normalizeSessionProposalInput,
  prepareSessionRetry,
  pruneLaunchGrants,
  recordHandoff,
  releaseWaiting,
  sessionCreateFields,
  setSessionOptions,
  validDecisionOptions,
  validHandoffText,
  validOptions,
  validSessionBinding,
  validSessionRecord,
};
