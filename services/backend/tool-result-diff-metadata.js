'use strict';

const crypto = require('crypto');
const {
  MAX_DIFF_BYTES,
  MAX_DIFF_HUNKS,
  MAX_DIFF_LINES,
  MAX_DIFF_LINE_CHARS,
  STRUCTURED_DIFF_CAP_TRUNCATION_REASONS,
} = require('../tools/structured-diff');
const { normalizeSubagentMetadata } = require('./subagent-report-metadata');

const DIFF_STATUSES = new Set(['created', 'modified', 'deleted', 'renamed', 'unknown']);
const DIFF_REVIEW_STATES = new Set(['full', 'partial', 'summary_only', 'non_text', 'failed']);
const DIFF_BODY_KINDS = new Set(['inline_hunks', 'summary_only', 'lazy_ref', 'none']);
const DIFF_SIGNAL_STATUSES = new Set(['created', 'deleted', 'renamed']);
const DIFF_SIGNAL_REVIEW_STATES = new Set(['full', 'partial', 'non_text', 'failed']);
const DIFF_TRUNCATION_REASONS = new Set([
  ...STRUCTURED_DIFF_CAP_TRUNCATION_REASONS,
  'binary',
  'decode_error',
  'diff_generation_failed',
  'unknown',
]);
const DIFF_HASH_KINDS = new Set(['raw_bytes', 'diff_input_text']);
const MAX_DIFF_ID_CHARS = 200;
const MAX_DIFF_ID_SEGMENT_CHARS = 80;
const MAX_DIFF_HASH_INPUT_CHARS = 2048;
const MAX_DIFFS = 20;
const MAX_PATCH_PATHS = 20;
const MAX_PATCH_FILES = 20;
const MAX_CHANGE_SET_OPERATION_SEQUENCES = 100;
const WORKSPACE_ID_PATTERN = /^root_[0-9a-f]{24}$/;
const CHANGE_SET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHANGE_SET_STATES = new Set(['prepared', 'in_progress', 'committed', 'rolled_back', 'interrupted']);
const MAX_METADATA_STRING_CHARS = 200;
const SAFE_DIFF_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SHA256_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PATCH_ATOMICITY_VALUES = new Set(['all_or_nothing']);
const PATCH_FILE_OPERATIONS = new Set(['add', 'update', 'delete', 'unknown']);
const PATCH_ROLLBACK_STATUSES = new Set(['not_needed', 'restored', 'partial', 'failed']);
const DIFF_PATH_FIELDS = Object.freeze(['path', 'file_path', 'filePath', 'relative_path', 'relativePath']);

function safeString(value) {
  if (typeof value === 'symbol') return '';
  if (value == null) return '';
  try {
    return String(value);
  } catch (_error) {
    return '';
  }
}

function normalizeMetadataString(value) {
  return safeString(value).trim().slice(0, MAX_METADATA_STRING_CHARS);
}

function normalizeRelativePath(value) {
  const raw = normalizeMetadataString(value);
  if (!raw || raw.includes('\0')) return '';
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return '';
  if (/^\\\\/.test(raw) || /^\/\//.test(raw)) return '';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return '';
  const normalized = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.includes(':')) return '';
  if (normalized.startsWith('/')) return '';
  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return '';
    parts.push(part);
  }
  return parts.join('/');
}

function firstSafeRelativePath(...values) {
  for (const value of values) {
    const path = normalizeRelativePath(value);
    if (path) return path;
  }
  return '';
}

function hasOwnField(source, key) {
  return Boolean(source) && Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeDiffPath(value, options) {
  for (const field of DIFF_PATH_FIELDS) {
    if (hasOwnField(value, field)) {
      return normalizeRelativePath(value[field]);
    }
  }
  if (options.requireExplicitPath === true) {
    return '';
  }
  return firstSafeRelativePath(
    options.path,
    options.input?.path,
    options.input?.file_path,
    options.input?.display_path
  );
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return Math.floor(numeric);
}

function normalizeDiffStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return DIFF_STATUSES.has(status) ? status : 'unknown';
}

function normalizeReviewState(value, fallback) {
  const state = String(value || '').trim().toLowerCase();
  if (DIFF_REVIEW_STATES.has(state)) {
    return state;
  }
  return fallback;
}

function normalizeBodyKind(value, fallback) {
  const kind = String(value || '').trim().toLowerCase();
  if (DIFF_BODY_KINDS.has(kind)) {
    return kind;
  }
  return fallback;
}

function normalizeTruncationReason(value, fallback = null) {
  const reason = String(value || '').trim().toLowerCase();
  if (DIFF_TRUNCATION_REASONS.has(reason)) {
    return reason;
  }
  return fallback;
}

function normalizeHashKind(value) {
  const hashKind = String(value || '').trim().toLowerCase();
  return DIFF_HASH_KINDS.has(hashKind) ? hashKind : 'diff_input_text';
}

function normalizeOptionalHash(value) {
  if (value === null) {
    return null;
  }
  const text = String(value || '').trim().toLowerCase();
  return SHA256_HASH_PATTERN.test(text) ? text : null;
}

function estimateDiffHunksBytes(hunks) {
  return Buffer.byteLength(JSON.stringify(hunks || []), 'utf8');
}

function normalizeDiffHunks(value) {
  if (!Array.isArray(value)) {
    return { hunks: [], truncationReason: null };
  }
  if (value.length > MAX_DIFF_HUNKS) {
    return { hunks: [], truncationReason: 'hunk_limit' };
  }
  const hunks = [];
  let lineCount = 0;
  for (const rawHunk of value) {
    if (!rawHunk || typeof rawHunk !== 'object' || Array.isArray(rawHunk)) {
      continue;
    }
    const rawLines = Array.isArray(rawHunk.lines) ? rawHunk.lines : [];
    const lines = [];
    for (const rawLine of rawLines) {
      const line = String(rawLine ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (line.length > MAX_DIFF_LINE_CHARS || line.includes('\n')) {
        return { hunks: [], truncationReason: 'line_limit' };
      }
      lines.push(line);
      lineCount += 1;
      if (lineCount > MAX_DIFF_LINES) {
        return { hunks: [], truncationReason: 'line_limit' };
      }
    }
    hunks.push({
      oldStart: normalizeNonNegativeInteger(rawHunk.oldStart ?? rawHunk.old_start, 0),
      oldLines: normalizeNonNegativeInteger(rawHunk.oldLines ?? rawHunk.old_lines, 0),
      newStart: normalizeNonNegativeInteger(rawHunk.newStart ?? rawHunk.new_start, 0),
      newLines: normalizeNonNegativeInteger(rawHunk.newLines ?? rawHunk.new_lines, 0),
      lines,
    });
  }
  if (estimateDiffHunksBytes(hunks) > MAX_DIFF_BYTES) {
    return { hunks: [], truncationReason: 'byte_limit' };
  }
  return { hunks, truncationReason: null };
}

function diffIdHashInput(value) {
  const text = String(value || '');
  return `${text.length}:${text.slice(0, MAX_DIFF_HASH_INPUT_CHARS)}`;
}

function normalizeDiffIdSegment(value, fallback) {
  const text = String(value || '').trim().slice(0, MAX_DIFF_ID_SEGMENT_CHARS);
  const safe = text.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_');
  return safe || fallback;
}

function buildGeneratedDiffId({ streamId = '', callId = '', operationIndex = 0, pathKey = '' } = {}) {
  const normalizedStreamId = normalizeDiffIdSegment(streamId, 'turn');
  const normalizedCallId = normalizeDiffIdSegment(callId, 'call');
  const normalizedOperationIndex = normalizeNonNegativeInteger(operationIndex, 0);
  const digest = crypto
    .createHash('sha256')
    .update([
      diffIdHashInput(streamId),
      diffIdHashInput(callId),
      String(normalizedOperationIndex),
      diffIdHashInput(pathKey),
    ].join(':'))
    .digest('hex')
    .slice(0, 16);
  return `${normalizedStreamId}:${normalizedCallId}:${normalizedOperationIndex}:path-${digest}`;
}

function normalizeDiffId(value, fallback) {
  const text = String(value || '').trim();
  if (text && text.length <= MAX_DIFF_ID_CHARS && SAFE_DIFF_ID_PATTERN.test(text)) {
    return text;
  }
  return fallback;
}

function normalizeToolResultDiffMetadata(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const { hunks, truncationReason: capReason } = normalizeDiffHunks(value.hunks);
  const additions = normalizeNonNegativeInteger(value.additions, 0);
  const deletions = normalizeNonNegativeInteger(value.deletions, 0);
  const status = normalizeDiffStatus(value.status);
  const explicitReviewState = normalizeReviewState(value.review_state ?? value.reviewState, '');
  const explicitTruncationReason = normalizeTruncationReason(
    value.truncation_reason ?? value.truncationReason,
    null
  );
  const beforeHash = normalizeOptionalHash(value.before_hash ?? value.beforeHash);
  const afterHash = normalizeOptionalHash(value.after_hash ?? value.afterHash);
  const hasDiffSignal = (
    additions > 0
    || deletions > 0
    || hunks.length > 0
    || DIFF_SIGNAL_STATUSES.has(status)
    || DIFF_SIGNAL_REVIEW_STATES.has(explicitReviewState)
    || explicitTruncationReason === 'diff_generation_failed'
    || beforeHash
    || afterHash
    || value.truncated === true
    || value.reviewable === true
  );
  if (!hasDiffSignal) {
    return null;
  }
  const operationIndex = normalizeNonNegativeInteger(
    value.operation_index ?? value.operationIndex,
    0
  );
  const truncated = value.truncated === true || Boolean(capReason);
  const truncationReason = truncated
    ? normalizeTruncationReason(value.truncation_reason ?? value.truncationReason, capReason || 'unknown')
    : null;
  const bodyFallback = truncated ? 'summary_only' : (hunks.length ? 'inline_hunks' : 'none');
  const bodyKind = normalizeBodyKind(value.body_kind ?? value.bodyKind, bodyFallback);
  const reviewFallback = (() => {
    if (value.reviewable === false) return 'summary_only';
    if (truncated) return 'summary_only';
    if (bodyKind === 'inline_hunks' && hunks.length) return 'full';
    return 'summary_only';
  })();
  const reviewState = normalizeReviewState(
    value.review_state ?? value.reviewState,
    reviewFallback
  );
  const path = normalizeDiffPath(value, options);
  const oldPath = firstSafeRelativePath(value.old_path, value.oldPath);
  const pathKey = path || String(
    options.path
    || options.input?.path
    || options.input?.file_path
    || options.input?.display_path
    || ''
  ).trim();
  const fallbackDiffId = buildGeneratedDiffId({
    streamId: options.streamId,
    callId: options.callId,
    operationIndex,
    pathKey,
  });
  const normalized = {
    diff_id: normalizeDiffId(value.diff_id || value.diffId, fallbackDiffId),
    operation_index: operationIndex,
    status,
    review_state: reviewState,
    body_kind: truncated ? 'summary_only' : bodyKind,
    additions,
    deletions,
    truncated,
    truncation_reason: truncationReason,
    before_hash: beforeHash,
    after_hash: afterHash,
    hash_kind: normalizeHashKind(value.hash_kind ?? value.hashKind),
    hunks: truncated ? [] : hunks,
  };
  if (path) {
    normalized.path = path;
  }
  if (oldPath) {
    normalized.old_path = oldPath;
  }
  return normalized;
}

function normalizeToolResultDiffsMetadata(value, options = {}) {
  if (!Array.isArray(value)) {
    return [];
  }
  const diffs = [];
  for (const entry of value.slice(0, MAX_DIFFS)) {
    const diff = normalizeToolResultDiffMetadata(entry, {
      ...options,
      requireExplicitPath: true,
    });
    if (diff && diff.path) {
      diffs.push(diff);
    }
  }
  return diffs;
}

function normalizePatchMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const operationCount = normalizeNonNegativeInteger(value.operation_count ?? value.operationCount, 0);
  const changedFileCount = normalizeNonNegativeInteger(value.changed_file_count ?? value.changedFileCount, 0);
  const changedPaths = Array.isArray(value.changed_paths ?? value.changedPaths)
    ? (value.changed_paths ?? value.changedPaths)
      .slice(0, MAX_PATCH_PATHS)
      .map((entry) => normalizeRelativePath(entry))
      .filter(Boolean)
    : [];
  const atomicity = normalizeMetadataString(value.atomicity).toLowerCase();
  const hasSignal = (
    operationCount > 0
    || changedFileCount > 0
    || changedPaths.length > 0
    || PATCH_ATOMICITY_VALUES.has(atomicity)
    || typeof value.success === 'boolean'
  );
  if (!hasSignal) {
    return null;
  }
  return {
    operation_count: operationCount,
    changed_file_count: changedFileCount,
    changed_paths: changedPaths,
    atomicity: PATCH_ATOMICITY_VALUES.has(atomicity) ? atomicity : 'all_or_nothing',
    success: value.success === true,
  };
}

function normalizePatchFileOperation(value) {
  const operation = normalizeMetadataString(value).toLowerCase();
  return PATCH_FILE_OPERATIONS.has(operation) ? operation : 'unknown';
}

function normalizePatchRollbackStatus(value) {
  const status = normalizeMetadataString(value).toLowerCase();
  return PATCH_ROLLBACK_STATUSES.has(status) ? status : null;
}

function normalizePatchFileMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const path = firstSafeRelativePath(
    value.path,
    value.file_path,
    value.filePath,
    value.relative_path,
    value.relativePath
  );
  if (!path) {
    return null;
  }
  const checkpointDisplayPath = normalizeRelativePath(
    value.checkpoint_display_path ?? value.checkpointDisplayPath
  );
  const rollbackStatus = normalizePatchRollbackStatus(
    value.rollback_status ?? value.rollbackStatus
  );
  const payload = {
    path,
    operation: normalizePatchFileOperation(value.operation),
    changed: value.changed === true,
    checkpoint_created: value.checkpoint_created === true || value.checkpointCreated === true,
  };
  const checkpointVersion = normalizeNonNegativeInteger(
    value.checkpoint_version ?? value.checkpointVersion,
    -1
  );
  if (checkpointVersion >= 0) {
    payload.checkpoint_version = checkpointVersion;
  }
  if (checkpointDisplayPath) {
    payload.checkpoint_display_path = checkpointDisplayPath;
  }
  const failureCode = normalizeMetadataString(value.failure_code ?? value.failureCode);
  if (failureCode) {
    payload.failure_code = failureCode;
  }
  if (rollbackStatus && rollbackStatus !== 'not_needed') {
    payload.rollback_status = rollbackStatus;
  }
  return payload;
}

function normalizePatchFilesMetadata(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const files = [];
  for (const entry of value.slice(0, MAX_PATCH_FILES)) {
    const file = normalizePatchFileMetadata(entry);
    if (file) {
      files.push(file);
    }
  }
  return files;
}

function normalizeUserQuestionsResultMetadata(source) {
  const kind = typeof source.result_kind === 'string' ? source.result_kind.trim() : '';
  if (kind !== 'user_questions_answered' && kind !== 'user_questions_declined') return null;
  const normalized = { result_kind: kind };
  if (Array.isArray(source.answers)) {
    const answers = [];
    for (const entry of source.answers.slice(0, 8)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const answer = { id: String(entry.id == null ? '' : entry.id).slice(0, 120) };
      answer.value = Array.isArray(entry.value)
        ? entry.value.slice(0, 8).map((value) => String(value == null ? '' : value).slice(0, 500))
        : String(entry.value == null ? '' : entry.value).slice(0, 500);
      const other = String(entry.other == null ? '' : entry.other).slice(0, 500);
      if (other) answer.other = other;
      answers.push(answer);
    }
    if (answers.length) normalized.answers = answers;
  }
  return normalized;
}

function containsPrivateRecoveryLocation(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_error) {
    return true;
  }
  return /(?:[a-zA-Z]:[\\/]|\\\\|\buserData\b|\.jenny[\\/](?:trash|backups))/i.test(text || '');
}

function normalizeWorkspaceChangeSetMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (containsPrivateRecoveryLocation(value)) return null;
  const changeSetId = safeString(value.change_set_id).trim().toLowerCase();
  const state = safeString(value.state).trim();
  if (value.schema_version !== 1 || !CHANGE_SET_ID_PATTERN.test(changeSetId)) return null;
  if (!CHANGE_SET_STATES.has(state)) return null;
  if (typeof value.protected !== 'boolean' || typeof value.partially_undoable !== 'boolean') {
    return null;
  }
  if (!Array.isArray(value.operation_sequences)) return null;
  const operationSequences = [];
  for (const entry of value.operation_sequences.slice(0, MAX_CHANGE_SET_OPERATION_SEQUENCES)) {
    if (!Number.isInteger(entry) || entry < 1 || entry > 10000) return null;
    if (!operationSequences.includes(entry)) operationSequences.push(entry);
  }
  const warning = safeString(value.warning).trim().slice(0, 512);
  return {
    schema_version: 1,
    change_set_id: changeSetId,
    state,
    operation_sequences: operationSequences,
    protected: value.protected,
    partially_undoable: value.partially_undoable,
    warning,
  };
}

function normalizePersistedToolResultMetadata(metadata, options = {}) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
  const diff = normalizeToolResultDiffMetadata(source.diff, options);
  const diffs = normalizeToolResultDiffsMetadata(source.diffs, options);
  const patch = normalizePatchMetadata(source.patch);
  const files = normalizePatchFilesMetadata(source.files);
  const subagent = normalizeSubagentMetadata(source);
  const userQuestions = normalizeUserQuestionsResultMetadata(source);
  const workspaceChangeSet = normalizeWorkspaceChangeSetMetadata(source.workspace_change_set);
  const result = {};
  const workspaceId = String(source.workspace_id || '').trim().toLowerCase();
  if ((diff || diffs.length) && WORKSPACE_ID_PATTERN.test(workspaceId)) {
    result.workspace_id = workspaceId;
  }
  if (diff) result.diff = diff;
  if (diffs.length) result.diffs = diffs;
  if (patch) result.patch = patch;
  if (files.length) result.files = files;
  if (subagent) Object.assign(result, subagent);
  if (userQuestions) Object.assign(result, userQuestions);
  if (workspaceChangeSet) result.workspace_change_set = workspaceChangeSet;
  return Object.keys(result).length ? result : null;
}

function normalizeToolResultMetadataForStorage(metadata, options = {}, precomputedStructured) {
  const source = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : {};
  const result = { ...source };
  delete result.diff;
  delete result.diffs;
  delete result.patch;
  delete result.files;
  delete result.subagent_report;
  delete result.subagent_batch_report;
  delete result.workspace_change_set;
  // Reuse a supplied normalized result to avoid a second hunk pass; undefined
  // means not supplied, while null explicitly means no structured metadata.
  const structured = precomputedStructured !== undefined
    ? precomputedStructured
    : normalizePersistedToolResultMetadata(source, options);
  if (structured) {
    Object.assign(result, structured);
  }
  return result;
}

module.exports = {
  normalizeToolResultMetadataForStorage,
  normalizePersistedToolResultMetadata,
  normalizeToolResultDiffsMetadata,
  normalizeToolResultDiffMetadata,
};
