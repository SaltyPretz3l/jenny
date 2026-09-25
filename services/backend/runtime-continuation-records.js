'use strict';

const { createHash } = require('node:crypto');
const { isDeepStrictEqual, TextDecoder } = require('node:util');
const { isContinuationEvent, isContinuationTextProjection } = require('../session-runtime/continuation-events');
const { normalizeDecision, normalizeMutationRef } = require('../session-runtime/continuation-contracts');
const { contextForBody, decisionProjection, validateDecisionMaterial, validateNoPendingBatchEffects } = require('./runtime-continuation-effects');
const { normalizeCompactionSnapshot } = require('./session-compaction-snapshot');

const RUNTIME_CONTINUATION_SCHEMA_VERSION = 1;
const MAX_RUNTIME_CONTINUATION_ENTRIES = 20;
const MAX_RUNTIME_CONTINUATION_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_CALLS = 256;
const MAX_FROZEN_INPUT_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TOOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HEADER_KEYS = ['entries', 'schema_version'];
const ENTRY_KEYS = ['body', 'checkpoint_id', 'revision', 'schema_version', 'sha256'];
const BODY_KEYS = ['created_at', 'frozen_first_input', 'frozen_input_bytes', 'history_selector', 'message_selector', 'session_id',
  'session_incarnation', 'source_attempt', 'source_turn_generation', 'stream_id',
  'tool_batch', 'tool_batch_bytes', 'turn_id', 'turn_selector', 'user_message_id', 'work_id'];
const ATTEMPT_KEYS = ['attempt_id', 'authority_revision', 'incarnation', 'stream_id'];
const TOOL_CALL_KEYS = ['argument_repairs', 'arguments', 'call_id', 'coerced',
  'idempotency_key', 'malformed_arguments', 'tool_id'];
const FROZEN_KEYS = ['call_id', 'effective_args_fingerprint', 'effective_tool_arguments',
  'execution_context_payload', 'injected_arg_keys', 'tool_name', 'visible_tool_arguments'];
const HISTORY_KEYS = ['canonical_cutoff', 'compaction_ref', 'history_scope', 'schema_version'];
const CUTOFF_KEYS = ['boundary_message_count', 'boundary_message_id', 'sha256'];
const CONTEXT_KEYS = new Set(['session_id', 'authority_revision', 'project_id', 'root_id',
  'root_revision', 'logical_turn_id', '_jenny_turn_id', '_jenny_tool_call_id', '_jenny_change_set_id',
  'read_only', 'plan_artifact_write', 'expected_read_snapshot']);
const CANDIDATES = new WeakSet();
const { normalizeApprovalInputs } = require('./runtime-approval-inputs');
const { normalizeQuotaEntry, prepareQuotaEntry } = require('./runtime-continuation-quota');

class RuntimeContinuationRecordError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RuntimeContinuationRecordError';
    this.code = code;
  }
}

function fail(code) { throw new RuntimeContinuationRecordError(code); }

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exact(value, keys, name) {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    fail(`invalid_${name}`);
  }
  return value;
}

function cloneJson(value, code = 'invalid_runtime_continuation_json') {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    fail(code);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function fingerprintRuntimeHistory(messages) {
  return digest(cloneJson(Array.isArray(messages) ? messages : []));
}

function validId(value) {
  return typeof value === 'string' && ID.test(value);
}

function normalizeAttempt(value) {
  exact(value, ATTEMPT_KEYS, 'source_attempt');
  if (!ATTEMPT_KEYS.every(key => validId(value[key]))) fail('invalid_source_attempt');
  return Object.fromEntries(ATTEMPT_KEYS.map(key => [key, value[key]]));
}

function normalizeToolCall(value) {
  exact(value, TOOL_CALL_KEYS, 'tool_call');
  if (!validId(value.call_id) || typeof value.tool_id !== 'string' || !TOOL_ID.test(value.tool_id)
    || typeof value.idempotency_key !== 'string' || value.idempotency_key.length > 256
    || typeof value.coerced !== 'boolean' || typeof value.malformed_arguments !== 'boolean'
    || !isRecord(value.arguments) || !Array.isArray(value.argument_repairs)
    || value.argument_repairs.length > 16
    || value.argument_repairs.some(item => typeof item !== 'string' || item.length > 128)) {
    fail('invalid_tool_call');
  }
  return cloneJson(value, 'invalid_tool_call');
}

function normalizeFrozenInput(value, firstCall) {
  exact(value, FROZEN_KEYS, 'frozen_input');
  if (value.call_id !== firstCall.call_id || value.tool_name !== firstCall.tool_id
    || !SHA256.test(String(value.effective_args_fingerprint || ''))
    || !isRecord(value.visible_tool_arguments) || !isRecord(value.effective_tool_arguments)
    || !Array.isArray(value.injected_arg_keys)
    || value.injected_arg_keys.some(key => typeof key !== 'string' || key.length > 128)
    || new Set(value.injected_arg_keys).size !== value.injected_arg_keys.length
    || !isRecord(value.execution_context_payload)
    || !validId(value.execution_context_payload.logical_turn_id)
    || Object.keys(value.execution_context_payload).some(key => !CONTEXT_KEYS.has(key))) {
    fail('invalid_frozen_input');
  }
  const normalized = cloneJson(value, 'invalid_frozen_input');
  return normalized;
}

function normalizeFrozenBytes(value, frozenInput) {
  if (typeof value !== 'string' || value.length < 4
    || value.length > (Math.ceil(MAX_FROZEN_INPUT_BYTES / 3) * 4)) {
    fail('invalid_frozen_input_bytes');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_FROZEN_INPUT_BYTES
    || bytes.toString('base64') !== value) fail('invalid_frozen_input_bytes');
  let decoded;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_error) {
    fail('invalid_frozen_input_bytes');
  }
  if (!isDeepStrictEqual(normalizeFrozenInput(decoded, {
    call_id: frozenInput.call_id, tool_id: frozenInput.tool_name,
  }), frozenInput)) fail('frozen_input_bytes_mismatch');
  return value;
}

function normalizeToolBatchBytes(value, calls) {
  if (typeof value !== 'string' || value.length < 4
    || value.length > (Math.ceil(MAX_FROZEN_INPUT_BYTES / 3) * 4)) {
    fail('invalid_tool_batch_bytes');
  }
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_FROZEN_INPUT_BYTES
    || bytes.toString('base64') !== value) fail('invalid_tool_batch_bytes');
  let decoded;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_error) {
    fail('invalid_tool_batch_bytes');
  }
  if (!isRecord(decoded) || Object.keys(decoded).sort().join(',') !== 'calls'
    || !Array.isArray(decoded.calls)
    || !isDeepStrictEqual(decoded.calls.map(normalizeToolCall), calls)) {
    fail('tool_batch_bytes_mismatch');
  }
  return value;
}

function messageProjection(message) {
  const toolCall = isRecord(message.tool_call) ? {
    call_id: String(message.tool_call.call_id || ''),
    tool_name: String(message.tool_call.tool_name || ''),
    input: cloneJson(message.tool_call.input || {}),
    input_json: String(message.tool_call.input_json || ''),
    parent_stream_id: String(message.tool_call.parent_stream_id || ''),
  } : null;
  return {
    id: String(message.id || ''), event_seq: message.event_seq,
    turn_id: String(message.turn_id || ''), role: String(message.role || ''),
    kind: String(message.kind || ''), content: String(message.content || ''),
    client_message_id: String(message.client_message_id || ''),
    parent_stream_id: String(message.parent_stream_id || ''),
    model_used: String(message.model_used || ''), finalizedAt: message.finalizedAt ?? null,
    visible_segments: cloneJson(message.visible_segments || []),
    phases: cloneJson(message.phases || []), reasoning: cloneJson(message.reasoning || {}),
    attachments: cloneJson(message.attachments || []), tool_steps: cloneJson(message.tool_steps || []),
    tool_call: toolCall,
  };
}

function normalizeHistorySelector(value) {
  const selector = exact(value, HISTORY_KEYS, 'history_selector');
  const cutoff = exact(selector.canonical_cutoff, CUTOFF_KEYS, 'history_cutoff');
  const count = cutoff.boundary_message_count;
  if (selector.schema_version !== 1 || !['session', 'recent', 'fresh'].includes(selector.history_scope)
    || !Number.isSafeInteger(count) || count < 0 || count > 100_000
    || (count === 0 ? cutoff.boundary_message_id !== null
      : typeof cutoff.boundary_message_id !== 'string' || !CANONICAL_ID.test(cutoff.boundary_message_id))
    || !SHA256.test(String(cutoff.sha256 || ''))) fail('invalid_history_selector');
  let compactionRef = null;
  if (selector.compaction_ref !== null) {
    const ref = exact(selector.compaction_ref, CUTOFF_KEYS, 'compaction_ref');
    if (!Number.isSafeInteger(ref.boundary_message_count) || ref.boundary_message_count < 1
      || typeof ref.boundary_message_id !== 'string' || !CANONICAL_ID.test(ref.boundary_message_id)
      || !SHA256.test(String(ref.sha256 || ''))) fail('invalid_compaction_ref');
    compactionRef = { ...ref };
  }
  return { schema_version: 1, history_scope: selector.history_scope,
    canonical_cutoff: { ...cutoff }, compaction_ref: compactionRef };
}

function validateHistorySelection(session, selector) {
  const normalized = normalizeHistorySelector(selector);
  const cutoff = normalized.canonical_cutoff;
  const prefix = (session.messages || []).slice(0, cutoff.boundary_message_count);
  if (prefix.length !== cutoff.boundary_message_count
    || (cutoff.boundary_message_count > 0
      && String(prefix.at(-1)?.id || '') !== cutoff.boundary_message_id)
    || fingerprintRuntimeHistory(prefix) !== cutoff.sha256) fail('canonical_history_changed');
  if (normalized.compaction_ref) {
    const snapshot = normalizeCompactionSnapshot(session.compaction_snapshot);
    const ref = normalized.compaction_ref;
    if (!snapshot || snapshot.boundary_message_id !== ref.boundary_message_id
      || snapshot.boundary_message_count !== ref.boundary_message_count
      || digest(snapshot) !== ref.sha256) fail('canonical_compaction_changed');
  }
  return normalized;
}

function orderedMessages(session, body) {
  const byId = new Map((session.messages || []).map(message => [String(message?.id || ''), message]));
  const messages = body.message_selector.ordered_message_ids.map(id => byId.get(id));
  if (messages.some(message => !message)) fail('canonical_message_unavailable');
  return messages;
}

function orderedEvents(session, body) {
  const byId = new Map((session.turn_events || []).map(event => [String(event?.event_id || ''), event]));
  const events = body.turn_selector.ordered_event_ids.map(id => byId.get(id));
  if (events.some(event => !event)) fail('canonical_turn_event_unavailable');
  return events;
}

function eventBelongsToStream(event, streamId) {
  const eventId = String(event?.event_id || '');
  return eventId.startsWith(`${streamId}:`) || eventId.endsWith(`:${streamId}`);
}

function messageBelongsToStream(message, body) {
  return String(message?.id || '') === body.user_message_id
    || String(message?.parent_stream_id || '') === body.stream_id
    || String(message?.tool_call?.parent_stream_id || '') === body.stream_id
    || String(message?.tool_result?.parent_stream_id || '') === body.stream_id;
}

function sectionId(checkpointId, section) {
  return `${section}_${createHash('sha256').update(`${checkpointId}\0${section}`).digest('hex').slice(0, 32)}`;
}

function referencesFor(entry, session, work) {
  const body = entry.body;
  const messages = orderedMessages(session, body).map(messageProjection);
  const events = orderedEvents(session, body).map(event => cloneJson(event));
  return {
    canonicalRefs: {
      request_ref: { ref_id: work.work_id, revision: 1, sha256: work.submission_hash },
      message_ref: { ref_id: sectionId(entry.checkpoint_id, 'msg'), revision: 1,
        sha256: digest(messages) },
      turn_ref: { ref_id: sectionId(entry.checkpoint_id, 'turn'), revision: 1,
        sha256: digest(events), stream_id: body.stream_id,
        through_seq: body.turn_selector.through_seq },
      tool_batch_ref: { ref_id: sectionId(entry.checkpoint_id, 'tools'), revision: 1,
        sha256: createHash('sha256').update(Buffer.from(body.tool_batch_bytes, 'base64')).digest('hex') },
      history_ref: { ref_id: sectionId(entry.checkpoint_id, 'history'), revision: 1,
        sha256: digest(body.history_selector) },
    },
    ...(body.approval_inputs_bytes ? { approvalInputsRef: { ref_id: sectionId(entry.checkpoint_id, 'approval_inputs'), revision: 1,
      sha256: createHash('sha256').update(Buffer.from(body.approval_inputs_bytes, 'base64')).digest('hex') } } : {}),
    frozenInputRef: { ref_id: sectionId(entry.checkpoint_id, 'input'), revision: 1,
      sha256: createHash('sha256').update(Buffer.from(body.frozen_input_bytes, 'base64')).digest('hex') },
  };
}

function selectorLineage(session, body, checkpointId) {
  const header = strictHeader(session.runtime_continuations);
  const storedIndex = header.entries.findIndex(entry => entry.checkpoint_id === checkpointId);
  const index = storedIndex < 0 ? header.entries.length : storedIndex;
  const related = entry => entry.body.work_id === body.work_id
    && entry.body.turn_id === body.turn_id
    && !sameAttempt(entry.body.source_attempt, body.source_attempt);
  return {
    earlier: header.entries.slice(0, index).filter(related),
    later: storedIndex < 0 ? [] : header.entries.slice(index + 1).filter(related),
  };
}

function validateCanonicalSelection(session, body, checkpointId,
  { allowUnselectedForeignEvents = false } = {}) {
  validateHistorySelection(session, body.history_selector);
  validateNoPendingBatchEffects(session, body);
  const decisionContext = { ...contextForBody(body), events: session.turn_events || [] };
  const lineage = selectorLineage(session, body, checkpointId);
  const inheritedMessages = new Set(lineage.earlier
    .flatMap(entry => entry.body.message_selector.ordered_message_ids));
  const inheritedEvents = new Set(lineage.earlier
    .flatMap(entry => entry.body.turn_selector.ordered_event_ids));
  const laterEvents = new Set(lineage.later
    .flatMap(entry => entry.body.turn_selector.ordered_event_ids));
  const messages = orderedMessages(session, body);
  const events = orderedEvents(session, body);
  validateDecisionMaterial(body, events);
  const messageIds = messages.map(message => String(message.id || ''));
  const eventIds = events.map(event => String(event.event_id || ''));
  if (new Set(messageIds).size !== messageIds.length || new Set(eventIds).size !== eventIds.length
    || [...inheritedMessages].some(id => !messageIds.includes(id))
    || [...inheritedEvents].some(id => !eventIds.includes(id))
    || messages.some(message => String(message.turn_id || '') !== body.turn_id
      && String(message.id || '') !== body.user_message_id)
    || messages.some(message => !messageBelongsToStream(message, body)
      && !inheritedMessages.has(String(message.id || '')))
    || events.some(event => String(event.turn_id || '') !== body.turn_id
      || (!eventBelongsToStream(event, body.stream_id)
        && !inheritedEvents.has(String(event.event_id || ''))))) {
    fail('canonical_selection_mismatch');
  }
  const uncoveredForeignEvent = (session.turn_events || []).find(event => (
    String(event?.turn_id || '') === body.turn_id
      && isContinuationEvent(event)
      && !eventBelongsToStream(event, body.stream_id)
      && !inheritedEvents.has(String(event?.event_id || ''))
      && !laterEvents.has(String(event?.event_id || ''))
  ));
  if (uncoveredForeignEvent && !allowUnselectedForeignEvents) {
    fail('canonical_turn_attempt_ambiguous');
  }
  if (events.some(event => !isContinuationEvent(event) && !inheritedEvents.has(event.event_id)
    && !decisionProjection(event, decisionContext))) fail('canonical_projection_unavailable');
  const sourceSequences = events.filter(event => eventBelongsToStream(event, body.stream_id))
    .map(event => Number(event?.payload?.canonical_seq))
    .filter(Number.isSafeInteger);
  if ((body.turn_selector.through_seq === 0 && sourceSequences.length !== 0)
    || (body.turn_selector.through_seq > 0
      && !sourceSequences.includes(body.turn_selector.through_seq))) {
    fail('canonical_turn_prefix_incomplete');
  }
  const calls = body.tool_batch.calls;
  const toolRows = messages.filter(message => message.kind === 'tool_use'
    && messageBelongsToStream(message, body));
  for (const call of calls) {
    const row = toolRows.find(message => message.tool_call?.call_id === call.call_id);
    const callEvents = events.filter(event => event.tool_call_id === call.call_id
      && eventBelongsToStream(event, body.stream_id));
    if ((row && (row.tool_call?.tool_name !== call.tool_id
      || row.tool_call?.parent_stream_id !== body.stream_id))
      || callEvents.some(event => event.payload?.tool_name !== call.tool_id)) {
      fail('canonical_tool_batch_mismatch');
    }
  }
}

function normalizeEntry(value) {
  if (value?.schema_version === 5) return normalizeQuotaEntry(value, { normalizeEntry, exact, digest, fail });
  exact(value, ENTRY_KEYS, 'runtime_continuation_entry');
  if (![1, 2, 3, 4].includes(value.schema_version) || value.revision !== 1 || !validId(value.checkpoint_id)
    || !SHA256.test(String(value.sha256 || ''))) fail('invalid_runtime_continuation_entry');
  const body = exact(value.body, value.schema_version >= 2 ? [...BODY_KEYS, 'decision', ...(value.schema_version === 3 || value.schema_version === 4 ? ['approval_inputs_bytes'] : []), ...(value.schema_version === 4 ? ['mutation_ref'] : [])] : BODY_KEYS, 'runtime_continuation_body');
  for (const key of ['session_id', 'work_id', 'turn_id', 'stream_id', 'session_incarnation']) {
    if (!validId(body[key])) fail('invalid_runtime_continuation_identity');
  }
  if (!CANONICAL_ID.test(String(body.user_message_id || ''))) {
    fail('invalid_runtime_continuation_identity');
  }
  if (!Number.isSafeInteger(body.source_turn_generation) || body.source_turn_generation < 1
    || typeof body.created_at !== 'string' || !Number.isFinite(Date.parse(body.created_at))) {
    fail('invalid_runtime_continuation_identity');
  }
  const sourceAttempt = normalizeAttempt(body.source_attempt);
  if (sourceAttempt.stream_id !== body.stream_id) fail('runtime_continuation_attempt_mismatch');
  const messageSelector = exact(body.message_selector, ['ordered_message_ids'], 'message_selector');
  const messageIds = messageSelector.ordered_message_ids;
  const turnSelector = exact(body.turn_selector, ['ordered_event_ids', 'through_seq'], 'turn_selector');
  const eventIds = turnSelector.ordered_event_ids;
  if (!Array.isArray(messageIds) || !messageIds.length || messageIds.length > 1024
    || messageIds.some(id => typeof id !== 'string' || !CANONICAL_ID.test(id))
    || new Set(messageIds).size !== messageIds.length
    || !Array.isArray(eventIds) || eventIds.length > 4096
    || eventIds.some(id => typeof id !== 'string' || !CANONICAL_ID.test(id))
    || new Set(eventIds).size !== eventIds.length
    || !Number.isSafeInteger(turnSelector.through_seq) || turnSelector.through_seq < 0) {
    fail('invalid_runtime_continuation_selector');
  }
  const batch = exact(body.tool_batch, ['calls'], 'tool_batch');
  if (!Array.isArray(batch.calls) || !batch.calls.length || batch.calls.length > MAX_TOOL_CALLS
  ) fail('invalid_tool_batch');
  const calls = batch.calls.map(normalizeToolCall);
  if (new Set(calls.map(call => call.call_id)).size !== calls.length) fail('duplicate_tool_call_id');
  const frozenFirstInput = normalizeFrozenInput(body.frozen_first_input, calls[0]);
  if ((value.schema_version === 3 || (value.schema_version === 4 && body.approval_inputs_bytes !== null)) && body.decision?.kind !== 'approval') fail('invalid_approval_inputs_kind');
  const approvalInputsBytes = (value.schema_version === 3 || (value.schema_version === 4 && body.approval_inputs_bytes !== null)) ? normalizeApprovalInputs(body.approval_inputs_bytes, {
    calls, firstBytes: body.frozen_input_bytes, normalizeInput: normalizeFrozenInput, normalizeBytes: normalizeFrozenBytes,
    scope: { ...frozenFirstInput.execution_context_payload, session_id: body.session_id,
      logical_turn_id: body.turn_id, authority_revision: sourceAttempt.authority_revision },
  }) : null;
  const historySelector = normalizeHistorySelector(body.history_selector);
  const normalizedBody = cloneJson({ ...body, source_attempt: sourceAttempt,
    ...(value.schema_version >= 2 ? { decision: normalizeDecision(body.decision) } : {}),
    ...(approvalInputsBytes || value.schema_version === 4 ? { approval_inputs_bytes: approvalInputsBytes } : {}),
    ...(value.schema_version === 4 ? { mutation_ref: normalizeMutationRef(body.mutation_ref) } : {}),
    history_selector: historySelector,
    message_selector: { ordered_message_ids: [...messageIds] },
    turn_selector: { ordered_event_ids: [...eventIds], through_seq: turnSelector.through_seq },
    tool_batch: { calls },
    tool_batch_bytes: normalizeToolBatchBytes(body.tool_batch_bytes, calls),
    frozen_first_input: frozenFirstInput,
    frozen_input_bytes: normalizeFrozenBytes(body.frozen_input_bytes, frozenFirstInput) });
  if (digest(normalizedBody) !== value.sha256) fail('runtime_continuation_digest_mismatch');
  return { schema_version: value.schema_version, revision: 1, checkpoint_id: value.checkpoint_id,
    sha256: value.sha256, body: normalizedBody };
}

function strictHeader(value) {
  if (isRecord(value) && Number(value.schema_version) > 1) {
    fail('future_runtime_continuation_schema');
  }
  exact(value, HEADER_KEYS, 'runtime_continuation_header');
  if (value.schema_version !== 1 || !Array.isArray(value.entries)) {
    fail(value.schema_version > 1 ? 'future_runtime_continuation_schema'
      : 'invalid_runtime_continuation_header');
  }
  if (value.entries.length > MAX_RUNTIME_CONTINUATION_ENTRIES) {
    fail('runtime_continuation_capacity');
  }
  const normalized = { schema_version: 1, entries: value.entries.map(normalizeEntry) };
  if (new Set(normalized.entries.map(entry => entry.checkpoint_id)).size !== normalized.entries.length
    || Buffer.byteLength(stableJson(normalized), 'utf8') > MAX_RUNTIME_CONTINUATION_BYTES) {
    fail('runtime_continuation_capacity');
  }
  return normalized;
}

function preserveRuntimeContinuations(value) {
  if (value == null) return { schema_version: 1, entries: [] };
  const cloned = cloneJson(value);
  try { return strictHeader(cloned); } catch (_error) { return cloned; }
}

function artifactBytes(entry) { return Buffer.byteLength(stableJson(normalizeEntry(entry)), 'utf8'); }

function sameAttempt(left, right) {
  try { return stableJson(normalizeAttempt(left)) === stableJson(normalizeAttempt(right)); }
  catch (_error) { return false; }
}

function prepareRuntimeContinuation({ session, epochs, proposal, work, now = () => new Date() } = {}) {
  if (!session || !work || !isRecord(proposal) || !validId(proposal.checkpoint_id)
    || work.session_id !== session.id || work.turn_id !== String(proposal.turn_id || work.turn_id)
    || work.work_id !== String(proposal.work_id || work.work_id)
    || !SHA256.test(String(work.submission_hash || ''))) fail('runtime_continuation_work_mismatch');
  strictHeader(session.runtime_continuations);
  const attempt = normalizeAttempt(proposal.source_attempt);
  if (attempt.stream_id !== String(proposal.stream_id || attempt.stream_id)
    || !sameAttempt(attempt, work.attempt) || !validId(session.session_incarnation)
    || !Number.isSafeInteger(session.turn_generation) || session.turn_generation < 1
    || !Number.isSafeInteger(epochs?.dirtyEpoch) || epochs.dirtyEpoch < 1) {
    fail('runtime_continuation_fence_mismatch');
  }
  const calls = (proposal.tool_calls || []).map(normalizeToolCall);
  if (!calls.length || calls.length > MAX_TOOL_CALLS) fail('invalid_tool_batch');
  const frozen = normalizeFrozenInput(proposal.frozen_input, calls[0]);
  const frozenInputBytes = normalizeFrozenBytes(proposal.frozen_input_bytes, frozen);
  const frozenBytesSha = createHash('sha256').update(Buffer.from(frozenInputBytes, 'base64')).digest('hex');
  if (!SHA256.test(String(proposal.frozen_input_sha256 || ''))
    || proposal.frozen_input_sha256 !== frozenBytesSha) fail('frozen_input_bytes_digest_mismatch');
  const toolBatchBytes = normalizeToolBatchBytes(proposal.tool_batch_bytes, calls);
  const toolBatchSha = createHash('sha256').update(Buffer.from(toolBatchBytes, 'base64')).digest('hex');
  if (!SHA256.test(String(proposal.tool_batch_sha256 || ''))
    || proposal.tool_batch_sha256 !== toolBatchSha) fail('tool_batch_bytes_digest_mismatch');
  const throughSeq = Number(proposal.through_seq);
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) fail('invalid_turn_through_seq');
  const selectionBody = { work_id: work.work_id, turn_id: work.turn_id,
    source_attempt: attempt, stream_id: attempt.stream_id,
    user_message_id: String(session.active_turn?.user_message_id || '') };
  const earlier = selectorLineage(session, selectionBody, proposal.checkpoint_id).earlier;
  const inheritedMessageIds = new Set(earlier
    .flatMap(entry => entry.body.message_selector.ordered_message_ids));
  const inheritedEventIds = new Set(earlier
    .flatMap(entry => entry.body.turn_selector.ordered_event_ids));
  const selectedMessages = (session.messages || []).filter(message => inheritedMessageIds.has(String(message?.id || '')) || (
    (message?.turn_id === work.turn_id || message?.id === selectionBody.user_message_id)
    && messageBelongsToStream(message, selectionBody)
  )).sort((a, b) => Number(a.event_seq) - Number(b.event_seq));
  const decision = proposal.decision ? normalizeDecision(proposal.decision) : null;
  const decisionContext = { decision, sessionId: session.id, turnId: work.turn_id, streamId: attempt.stream_id, pendingCalls: calls, events: session.turn_events || [] };
  const attemptEvents = (session.turn_events || []).filter(event => (
    event?.turn_id === work.turn_id && (isContinuationEvent(event)
      || decisionProjection(event, decisionContext) || inheritedEventIds.has(event.event_id))
  ));
  if (attemptEvents.some(event => !eventBelongsToStream(event, attempt.stream_id)
    && !inheritedEventIds.has(String(event?.event_id || '')))) {
    fail('canonical_turn_attempt_ambiguous');
  }
  const projectionIds = new Set(proposal.projection_event_ids || []);
  if (projectionIds.size > 4096 || [...projectionIds].some(id => !attemptEvents.some(event =>
    event.event_id === id && eventBelongsToStream(event, attempt.stream_id) && (isContinuationTextProjection(event) || decisionProjection(event, decisionContext))))) fail('canonical_projection_unavailable');
  const selectedEvents = attemptEvents.filter(event => (
    inheritedEventIds.has(String(event?.event_id || ''))
      || (eventBelongsToStream(event, attempt.stream_id)
        && (projectionIds.has(event.event_id) || Number(event.payload.canonical_seq) <= throughSeq))
  )).sort((a, b) => Number(a.event_seq) - Number(b.event_seq));
  const mutationRef = Object.hasOwn(proposal, 'mutation_ref') ? normalizeMutationRef(proposal.mutation_ref) : null;
  if (mutationRef && !decision) fail('invalid_mutation_decision');
  const hasApprovalInputs = Object.hasOwn(proposal, 'approval_inputs_bytes');
  if (hasApprovalInputs && (decision?.kind !== 'approval'
    || createHash('sha256').update(Buffer.from(proposal.approval_inputs_bytes, 'base64')).digest('hex')
      !== proposal.approval_inputs_sha256)) fail('approval_inputs_digest_mismatch');
  const body = {
    ...(hasApprovalInputs || mutationRef ? { approval_inputs_bytes: proposal.approval_inputs_bytes || null } : {}),
    ...(mutationRef ? { mutation_ref: mutationRef } : {}),
    ...(decision ? { decision } : {}),
    session_id: session.id, work_id: work.work_id, turn_id: work.turn_id,
    stream_id: attempt.stream_id, session_incarnation: session.session_incarnation,
    user_message_id: String(session.active_turn?.user_message_id || ''),
    source_attempt: attempt, source_turn_generation: session.turn_generation,
    created_at: now().toISOString(),
    history_selector: normalizeHistorySelector(proposal.history_selector),
    message_selector: { ordered_message_ids: selectedMessages.map(message => message.id) },
    turn_selector: { ordered_event_ids: selectedEvents.map(event => event.event_id), through_seq: throughSeq },
    tool_batch: { calls },
    tool_batch_bytes: toolBatchBytes,
    frozen_first_input: frozen,
    frozen_input_bytes: frozenInputBytes,
  };
  const entry = prepareQuotaEntry(proposal, body, mutationRef ? 4 : hasApprovalInputs ? 3 : decision ? 2 : 1,
    selectedEvents, { normalizeEntry, digest });
  validateCanonicalSelection(session, entry.body, entry.checkpoint_id);
  const refs = referencesFor(entry, session, work);
  const candidate = Object.freeze({ sessionId: session.id, checkpointId: entry.checkpoint_id,
    expectedDirtyEpoch: epochs.dirtyEpoch, expectedSessionIncarnation: session.session_incarnation,
    expectedTurnGeneration: session.turn_generation, entry, workId: work.work_id,
    sourceAttempt: attempt, canonicalRefs: refs.canonicalRefs,
    frozenInputRef: refs.frozenInputRef, ...(refs.approvalInputsRef ? { approvalInputsRef: refs.approvalInputsRef } : {}),
    encodedArtifactBytes: artifactBytes(entry) });
  CANDIDATES.add(candidate);
  return candidate;
}

function assertCandidate(value) {
  if (!CANDIDATES.has(value)) fail('invalid_runtime_continuation_candidate');
  return value;
}

function validateEntryAgainst(entry, session, work, continuation = null,
  { historical = false } = {}) {
  const normalized = normalizeEntry(entry);
  if (normalized.body.session_id !== session.id || normalized.body.work_id !== work?.work_id
    || normalized.body.turn_id !== work?.turn_id || normalized.body.session_incarnation !== session.session_incarnation
    || (!historical && !sameAttempt(normalized.body.source_attempt, work?.attempt))) {
    fail('runtime_continuation_fence_mismatch');
  }
  validateCanonicalSelection(session, normalized.body, normalized.checkpoint_id, {
    allowUnselectedForeignEvents: historical,
  });
  const evidenceWork = historical ? { ...work, attempt: normalized.body.source_attempt,
    submission_hash: continuation?.canonical_refs?.request_ref?.sha256 || work.submission_hash } : work;
  const refs = referencesFor(normalized, session, evidenceWork);
  if (continuation) {
    if (stableJson(normalized.body.quota_state || null) !== stableJson(continuation.quota_state || null)
      || stableJson(normalized.body.mutation_ref || null) !== stableJson(continuation.mutation_ref || null)
      || stableJson(normalized.body.decision || null) !== stableJson(continuation.decision || null)
      || stableJson(refs.canonicalRefs) !== stableJson(continuation.canonical_refs)
      || stableJson(refs.frozenInputRef) !== stableJson(continuation.pending_call?.frozen_input_ref)
      || stableJson(refs.approvalInputsRef || null) !== stableJson(continuation.approval_inputs_ref || null)
      || !sameAttempt(continuation.source_attempt, normalized.body.source_attempt)
      || continuation.identity?.checkpoint_id !== normalized.checkpoint_id
      || continuation.pending_call?.call_id !== normalized.body.frozen_first_input.call_id
      || continuation.pending_call?.tool_id !== normalized.body.frozen_first_input.tool_name
      || continuation.pending_call?.effective_args_sha256
        !== normalized.body.frozen_first_input.effective_args_fingerprint) {
      fail('runtime_continuation_reference_mismatch');
    }
  }
  return { entry: normalized, refs, bytes: artifactBytes(normalized) };
}

function validateHistoricalEntryAgainst(entry, session, work, continuation = null) {
  return validateEntryAgainst(entry, session, work, continuation, { historical: true });
}

module.exports = {
  MAX_RUNTIME_CONTINUATION_BYTES,
  MAX_RUNTIME_CONTINUATION_ENTRIES,
  RuntimeContinuationRecordError,
  artifactBytes,
  assertCandidate,
  fingerprintRuntimeHistory,
  normalizeHistorySelector,
  prepareRuntimeContinuation,
  preserveRuntimeContinuations,
  sameAttempt,
  stableJson,
  strictHeader,
  validateEntryAgainst,
  validateHistoricalEntryAgainst,
};
