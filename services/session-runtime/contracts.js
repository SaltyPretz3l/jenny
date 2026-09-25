'use strict';

const crypto = require('node:crypto');
const { isTerminalTombstone, validTerminalTombstone } = require('./terminal-retention-contract');

const RUNTIME_STORE_SCHEMA_VERSION = 1;
const MAX_PENDING_HOST = 256;
const MAX_PENDING_PROJECT = 128;
const MAX_PENDING_SESSION = 20;
const MAX_PENDING_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_WORK_RECORD_BYTES = MAX_PENDING_INPUT_BYTES + (64 * 1024);
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_SUMMARIES = 100_000;
const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const WORK_STATUSES = Object.freeze(new Set([
  'pending', 'paused', 'running', 'completed', 'failed', 'cancelled', 'needs_attention',
]));
const PENDING_STATUSES = Object.freeze(new Set(['pending', 'paused']));
const WORK_KEYS = Object.freeze([
  'attempt', 'authority', 'checkpoint_ref', 'control_request', 'created_at', 'idempotency_key',
  'input', 'input_bytes', 'project_id', 'purpose', 'recovery', 'revision', 'schema_version',
  'session_id', 'submission_sequence', 'status', 'submission_hash', 'transition', 'turn_id',
  'updated_at', 'work_id',
].sort());
const AUTHORITY_KEYS = Object.freeze([
  'device_id', 'inode', 'project_id', 'root_id', 'root_path', 'root_revision',
].sort());
const ATTEMPT_KEYS = Object.freeze([
  'attempt_id', 'authority_revision', 'incarnation', 'stream_id',
].sort());
const CHECKPOINT_REF_KEYS = Object.freeze([
  'bytes', 'checkpoint_id', 'schema_version', 'sha256', 'source_attempt',
].sort());
const TRANSITION_KEYS = Object.freeze([
  'at', 'from', 'reason', 'to', 'transition_id',
].sort());
const RECOVERY_KEYS = Object.freeze(['at', 'kind', 'previous_status', 'reason'].sort());
const CONTROL_REQUEST_KEYS = Object.freeze(['kind', 'reason', 'requested_at'].sort());
const SUMMARY_KEYS = Object.freeze([
  'created_at', 'idempotency_key', 'input_bytes', 'project_id', 'purpose', 'revision',
  'session_id', 'status', 'submission_sequence', 'turn_id', 'updated_at', 'work_id',
].sort());
const INDEX_KEYS = Object.freeze([
  'next_submission_sequence', 'pending', 'revision', 'schema_version', 'summaries',
].sort());
const PENDING_KEYS = Object.freeze([
  'host_count', 'project_counts', 'serialized_input_bytes', 'session_counts',
].sort());
const JOURNAL_KEYS = Object.freeze([
  'at', 'index_revision', 'record', 'schema_version', 'summary', 'transaction_id', 'work_id',
].sort());

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join('\0') === keys.join('\0');
}

function validId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40
    && Number.isFinite(Date.parse(value));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
  return JSON.stringify(value);
}

function submissionHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalizeAuthority(value) {
  if (!hasExactKeys(value, AUTHORITY_KEYS) || !validId(value.project_id)
    || !Number.isSafeInteger(value.root_revision) || value.root_revision < 0) return null;
  const rootPath = value.root_path;
  const rootId = value.root_id;
  const deviceId = value.device_id;
  const inode = value.inode;
  if (rootPath === null) {
    if (rootId !== null || deviceId !== null || inode !== null) return null;
  } else if (typeof rootPath !== 'string' || !rootPath || rootPath.length > 4096
    || !validId(rootId) || ((deviceId === null) !== (inode === null))) return null;
  if ((deviceId !== null && !validId(deviceId)) || (inode !== null && !validId(inode))) return null;
  return Object.freeze({
    project_id: value.project_id,
    root_path: rootPath,
    root_id: rootId,
    root_revision: value.root_revision,
    device_id: deviceId,
    inode,
  });
}

function normalizeAttempt(value) {
  if (!hasExactKeys(value, ATTEMPT_KEYS)) return null;
  if (!validId(value.attempt_id) || !validId(value.stream_id)
    || !validId(value.incarnation) || !validId(value.authority_revision)) return null;
  return Object.freeze({ ...value });
}

function normalizeCheckpointRef(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, CHECKPOINT_REF_KEYS) || value.schema_version !== 1
    || !validId(value.checkpoint_id) || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.sha256) || !Number.isSafeInteger(value.bytes)
    || value.bytes < 2 || value.bytes > MAX_CHECKPOINT_BYTES) return undefined;
  const attempt = normalizeAttempt(value.source_attempt);
  if (!attempt) return undefined;
  return Object.freeze({ schema_version: 1, checkpoint_id: value.checkpoint_id,
    sha256: value.sha256, bytes: value.bytes, source_attempt: attempt });
}

function normalizeTransition(value) {
  if (!hasExactKeys(value, TRANSITION_KEYS) || !validId(value.transition_id)
    || (value.from !== null && !WORK_STATUSES.has(value.from)) || !WORK_STATUSES.has(value.to)
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 256
    || !validTimestamp(value.at)) return null;
  return Object.freeze({ ...value, reason: value.reason.trim() });
}

function normalizeRecovery(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, RECOVERY_KEYS)
    || !['restart_paused', 'transition_repaired'].includes(value.kind)
    || !WORK_STATUSES.has(value.previous_status)
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 256
    || !validTimestamp(value.at)) return undefined;
  return Object.freeze({ ...value, reason: value.reason.trim() });
}

function normalizeControlRequest(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, CONTROL_REQUEST_KEYS) || !['cancel', 'pause'].includes(value.kind)
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 256
    || !validTimestamp(value.requested_at)) return undefined;
  return Object.freeze({ kind: value.kind, requested_at: value.requested_at,
    reason: value.reason.trim() });
}

function validateWorkRecord(value) {
  if (value?.schema_version > RUNTIME_STORE_SCHEMA_VERSION) return { ok: false, reason: 'future_schema' };
  // Earlier unreleased v1 records can omit only these known optional fields.
  // Unknown/future data stays closed.
  if (isRecord(value) && (!Object.hasOwn(value, 'checkpoint_ref')
    || !Object.hasOwn(value, 'control_request'))) {
    value = { ...value,
      ...(!Object.hasOwn(value, 'checkpoint_ref') && { checkpoint_ref: null }),
      ...(!Object.hasOwn(value, 'control_request') && { control_request: null }) };
  }
  if (!hasExactKeys(value, WORK_KEYS) || value.schema_version !== RUNTIME_STORE_SCHEMA_VERSION
    || !validId(value.work_id) || !validId(value.turn_id) || !validId(value.idempotency_key)
    || !validId(value.project_id) || !validId(value.session_id)
    || !Number.isSafeInteger(value.submission_sequence) || value.submission_sequence < 1
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !WORK_STATUSES.has(value.status)
    || typeof value.purpose !== 'string' || !value.purpose.trim() || value.purpose.length > 256
    || !isRecord(value.input) || !Number.isSafeInteger(value.input_bytes) || value.input_bytes < 2
    || value.input_bytes > MAX_PENDING_INPUT_BYTES
    || typeof value.submission_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.submission_hash)
    || !validTimestamp(value.created_at) || !validTimestamp(value.updated_at)) {
    return { ok: false, reason: 'invalid_work_record' };
  }
  let input;
  try {
    input = cloneJson(value.input);
  } catch (_error) {
    return { ok: false, reason: 'invalid_work_input' };
  }
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') !== value.input_bytes) {
    return { ok: false, reason: 'work_input_size_mismatch' };
  }
  const authority = normalizeAuthority(value.authority);
  const attempt = value.attempt === null ? null : normalizeAttempt(value.attempt);
  const transition = normalizeTransition(value.transition);
  const recovery = normalizeRecovery(value.recovery);
  const checkpointRef = normalizeCheckpointRef(value.checkpoint_ref);
  const controlRequest = normalizeControlRequest(value.control_request);
  if (!authority || authority.project_id !== value.project_id
    || (value.attempt !== null && !attempt) || !transition || recovery === undefined
    || checkpointRef === undefined || controlRequest === undefined || (checkpointRef && !attempt)
    || transition.to !== value.status) return { ok: false, reason: 'invalid_work_contract' };
  const normalized = { ...value, purpose: value.purpose.trim(), input,
    authority, attempt, transition, recovery, checkpoint_ref: checkpointRef,
    control_request: controlRequest };
  if (isTerminalTombstone(input)) {
    if (!validTerminalTombstone(normalized)) return { ok: false, reason: 'invalid_terminal_tombstone' };
  }
  const expectedHash = isTerminalTombstone(input) ? normalized.submission_hash
    : submissionHash({ authority, input, project_id: normalized.project_id,
    purpose: normalized.purpose, session_id: normalized.session_id });
  if (normalized.submission_hash !== expectedHash) {
    return { ok: false, reason: 'submission_hash_mismatch' };
  }
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_WORK_RECORD_BYTES) {
    return { ok: false, reason: 'work_record_too_large' };
  }
  return { ok: true, record: Object.freeze(normalized) };
}

function workSummary(record) {
  return Object.freeze({
    work_id: record.work_id,
    turn_id: record.turn_id,
    idempotency_key: record.idempotency_key,
    project_id: record.project_id,
    session_id: record.session_id,
    purpose: record.purpose,
    status: record.status,
    submission_sequence: record.submission_sequence,
    revision: record.revision,
    input_bytes: record.input_bytes,
    created_at: record.created_at,
    updated_at: record.updated_at,
  });
}

function validateSummary(value) {
  if (!hasExactKeys(value, SUMMARY_KEYS) || !validId(value.work_id) || !validId(value.turn_id)
    || !validId(value.idempotency_key) || !validId(value.project_id) || !validId(value.session_id)
    || typeof value.purpose !== 'string' || !value.purpose || value.purpose.length > 256
    || !Number.isSafeInteger(value.submission_sequence) || value.submission_sequence < 1
    || !WORK_STATUSES.has(value.status) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.input_bytes) || value.input_bytes < 2
    || !validTimestamp(value.created_at) || !validTimestamp(value.updated_at)) return null;
  return Object.freeze({ ...value });
}

function pendingProjection(summaries) {
  const projectCounts = Object.create(null);
  const sessionCounts = Object.create(null);
  let hostCount = 0;
  let serializedInputBytes = 0;
  for (const summary of summaries) {
    if (!PENDING_STATUSES.has(summary.status)) continue;
    hostCount += 1;
    serializedInputBytes += summary.input_bytes;
    projectCounts[summary.project_id] = (projectCounts[summary.project_id] || 0) + 1;
    sessionCounts[summary.session_id] = (sessionCounts[summary.session_id] || 0) + 1;
  }
  return Object.freeze({
    host_count: hostCount,
    project_counts: Object.freeze(projectCounts),
    session_counts: Object.freeze(sessionCounts),
    serialized_input_bytes: serializedInputBytes,
  });
}

function validatePendingProjection(value, summaries) {
  if (!hasExactKeys(value, PENDING_KEYS) || !Number.isSafeInteger(value.host_count)
    || !Number.isSafeInteger(value.serialized_input_bytes)
    || !isRecord(value.project_counts) || !isRecord(value.session_counts)) return false;
  return stableJson(value) === stableJson(pendingProjection(summaries));
}

function validateIndexDocument(value) {
  if (value?.schema_version > RUNTIME_STORE_SCHEMA_VERSION) return { ok: false, reason: 'future_schema' };
  if (!hasExactKeys(value, INDEX_KEYS) || value.schema_version !== RUNTIME_STORE_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.next_submission_sequence) || value.next_submission_sequence < 1
    || !Array.isArray(value.summaries) || value.summaries.length > MAX_SUMMARIES) {
    return { ok: false, reason: 'invalid_index' };
  }
  const summaries = value.summaries.map(validateSummary);
  const sequences = summaries.map((entry) => entry?.submission_sequence);
  if (summaries.some((entry) => !entry)
    || new Set(summaries.map((entry) => entry.work_id)).size !== summaries.length
    || new Set(summaries.map((entry) => entry.turn_id)).size !== summaries.length
    || new Set(summaries.map((entry) => entry.idempotency_key)).size !== summaries.length
    || new Set(sequences).size !== summaries.length
    || sequences.some((sequence, index) => index > 0 && sequence <= sequences[index - 1])
    || sequences.some((sequence) => sequence >= value.next_submission_sequence)
    || !validatePendingProjection(value.pending, summaries)) {
    return { ok: false, reason: 'invalid_index' };
  }
  const document = Object.freeze({ ...value, summaries: Object.freeze(summaries),
    pending: pendingProjection(summaries) });
  if (Buffer.byteLength(JSON.stringify(document), 'utf8') > MAX_INDEX_BYTES) {
    return { ok: false, reason: 'index_too_large' };
  }
  return { ok: true, document };
}

function createIndexDocument(summaries = [], revision = 0, nextSubmissionSequence = null) {
  const ordered = summaries.map((entry) => Object.freeze({ ...entry }))
    .sort((left, right) => left.submission_sequence - right.submission_sequence);
  const derivedNext = ordered.length
    ? ordered[ordered.length - 1].submission_sequence + 1 : 1;
  const next = Number.isSafeInteger(nextSubmissionSequence) && nextSubmissionSequence >= derivedNext
    ? nextSubmissionSequence : derivedNext;
  return Object.freeze({ schema_version: RUNTIME_STORE_SCHEMA_VERSION, revision,
    next_submission_sequence: next,
    summaries: Object.freeze(ordered), pending: pendingProjection(ordered) });
}

function validateJournal(value) {
  if (value?.schema_version > RUNTIME_STORE_SCHEMA_VERSION) return { ok: false, reason: 'future_schema' };
  if (!hasExactKeys(value, JOURNAL_KEYS) || value.schema_version !== RUNTIME_STORE_SCHEMA_VERSION
    || !validId(value.transaction_id) || !validId(value.work_id)
    || !Number.isSafeInteger(value.index_revision) || value.index_revision < 1
    || !validTimestamp(value.at)) return { ok: false, reason: 'invalid_journal' };
  const work = validateWorkRecord(value.record);
  const summary = validateSummary(value.summary);
  if (!work.ok || !summary || work.record.work_id !== value.work_id
    || summary.work_id !== value.work_id || stableJson(workSummary(work.record)) !== stableJson(summary)) {
    return { ok: false, reason: work.reason || 'invalid_journal' };
  }
  return { ok: true, journal: Object.freeze({ ...value, record: work.record, summary }) };
}

function pendingCapacityReason(pending) {
  if (pending.host_count > MAX_PENDING_HOST) return 'host_pending_capacity';
  if (Object.values(pending.project_counts).some((count) => count > MAX_PENDING_PROJECT)) {
    return 'project_pending_capacity';
  }
  if (Object.values(pending.session_counts).some((count) => count > MAX_PENDING_SESSION)) {
    return 'session_pending_capacity';
  }
  if (pending.serialized_input_bytes > MAX_PENDING_INPUT_BYTES) return 'pending_input_capacity';
  return null;
}

module.exports = {
  MAX_CHECKPOINT_BYTES,
  MAX_INDEX_BYTES,
  MAX_PENDING_HOST,
  MAX_PENDING_INPUT_BYTES,
  MAX_PENDING_PROJECT,
  MAX_PENDING_SESSION,
  MAX_WORK_RECORD_BYTES,
  RUNTIME_STORE_SCHEMA_VERSION,
  cloneJson,
  createIndexDocument,
  hasExactKeys,
  normalizeAttempt,
  normalizeAuthority,
  normalizeCheckpointRef,
  normalizeControlRequest,
  normalizeRecovery,
  normalizeTransition,
  pendingCapacityReason,
  pendingProjection,
  stableJson,
  submissionHash,
  validId,
  validateIndexDocument,
  validateJournal,
  validateWorkRecord,
  workSummary,
};
