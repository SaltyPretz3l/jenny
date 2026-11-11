'use strict';

// Row 34: the user-only scripted_change_review v1 record that run_command,
// run_temp_script and python_execute results carry (producer: sidecar
// scripted_change_capture.build_review). Split from tool-result-diff-metadata.js,
// which supplies its safe relative-path normalizer.

const STATES = new Set(['observed', 'partial', 'unavailable', 'unsupported']);
const CERTAINTIES = new Set(['observed_during_call', 'background_window']);
const CALL_OUTCOMES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const REASONS = new Set([
  'not_git',
  'status_over_limit',
  'probe_failed',
  'disabled',
  'no_workspace',
  'background',
  'payload_over_limit',
  // Row 106 synced workspace: write-back failed, or the run changed more than it copies back.
  'write_back_failed',
  'write_back_too_large',
]);
const MAX_PATHS = 50;
// Row 106 synced workspace (producer: services/execution/sandbox-change-review.js): the paths
// write-back refused with why, and applied files that run later on this computer.
const REFUSED_REASONS = new Set(['protected', 'conflict', 'type_changed', 'outbox_invalid', 'parent_invalid',
  'path_invalid', 'path_short_name', 'path_reserved_name', 'symlink', 'special', 'hardlink',
  'unreadable', 'not_empty', 'write_failed', 'unknown']);
const MAX_REFUSED_PATHS = 50;
const MAX_HOST_RUN_PATHS = 20;
const MAX_COUNT = 100000;
// The run's restore point (row 34 S5; sidecar scripted_restore_point.py).
const RESTORE_POINT_REASONS = new Set(['not_git', 'disabled', 'failed', 'unavailable']);
// Turn checkpoints and the synced workspace's own namespace (row 106); a segment is never only dots.
const CHECKPOINT_REF = /^refs\/jenny\/(?:checkpoints|sandbox)\/(?!\.+\/)[A-Za-z0-9._-]+\/[0-9]+$/;
const UTC_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$/;
const MAX_REF_CHARS = 200;

function token(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function boundedCount(value) {
  const numeric = Number(value);
  if (typeof value === 'boolean' || !Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(Math.floor(numeric), MAX_COUNT);
}

// One of the three restore-point shapes with only its own keys, or null.
function normalizeRestorePoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const createdAt = typeof value.created_at === 'string' && UTC_TIME.test(value.created_at) ? value.created_at : '';
  if (value.kind === 'git_checkpoint' && createdAt && typeof value.ref === 'string'
    && value.ref.length <= MAX_REF_CHARS && CHECKPOINT_REF.test(value.ref)) {
    return { kind: 'git_checkpoint', ref: value.ref, created_at: createdAt };
  }
  if (value.kind === 'head' && createdAt) return { kind: 'head', created_at: createdAt };
  if (value.kind === 'none' && RESTORE_POINT_REASONS.has(value.reason)) return { kind: 'none', reason: value.reason };
  return null;
}

// The synced write-back fields, each bounded; a path the safe normalizer drops stays in the count.
function syncedWriteBackFields(value, normalizeRelativePath) {
  const refused = [];
  for (const entry of Array.isArray(value.refused_paths) ? value.refused_paths : []) {
    if (refused.length >= MAX_REFUSED_PATHS) break;
    const path = entry && typeof entry === 'object' ? normalizeRelativePath(entry.path) : '';
    if (path) refused.push({ path, reason: REFUSED_REASONS.has(entry.reason) ? entry.reason : 'unknown' });
  }
  const hostRun = [];
  for (const entry of Array.isArray(value.host_run_paths) ? value.host_run_paths : []) {
    if (hostRun.length >= MAX_HOST_RUN_PATHS) break;
    const path = normalizeRelativePath(entry);
    if (path) hostRun.push(path);
  }
  return {
    coverage: 'synced_write_back',
    refused_paths: refused,
    refused_count: Math.max(boundedCount(value.refused_count), refused.length),
    host_run_paths: hostRun,
    host_run_count: Math.max(boundedCount(value.host_run_count), hostRun.length),
  };
}

// A new bounded record, or null. An unknown certainty falls back to the weaker
// background_window claim; an unknown outcome reads unknown; an unknown reason
// is dropped rather than shown.
function normalizeScriptedChangeReview(value, normalizeRelativePath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = token(value.state);
  if (value.schema_version !== 1 || !STATES.has(state)) return null;
  const changedPaths = [];
  for (const entry of Array.isArray(value.changed_paths) ? value.changed_paths : []) {
    if (changedPaths.length >= MAX_PATHS) break;
    const path = normalizeRelativePath(entry);
    if (path) changedPaths.push(path);
  }
  const certainty = token(value.certainty);
  const callOutcome = token(value.call_outcome);
  const reason = token(value.reason);
  const review = {
    schema_version: 1,
    state,
    certainty: CERTAINTIES.has(certainty) ? certainty : 'background_window',
    call_outcome: CALL_OUTCOMES.has(callOutcome) ? callOutcome : 'unknown',
    changed_paths: changedPaths,
    changed_path_count: Math.max(boundedCount(value.changed_path_count), changedPaths.length),
    diff_count: boundedCount(value.diff_count),
    summary_only_count: boundedCount(value.summary_only_count),
    omitted_count: boundedCount(value.omitted_count),
  };
  if (value.coverage === 'git_status_paths') review.coverage = 'git_status_paths';
  if (value.coverage === 'synced_write_back') Object.assign(review, syncedWriteBackFields(value, normalizeRelativePath));
  if (REASONS.has(reason)) review.reason = reason;
  const restorePoint = normalizeRestorePoint(value.restore_point);
  if (restorePoint) review.restore_point = restorePoint;
  return review;
}

module.exports = { CALL_OUTCOMES, MAX_HOST_RUN_PATHS, MAX_PATHS, MAX_REFUSED_PATHS, REFUSED_REASONS,
  normalizeRestorePoint, normalizeScriptedChangeReview };
