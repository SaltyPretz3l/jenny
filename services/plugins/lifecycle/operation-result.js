'use strict';

// Bounded structured operation results (PluginOperationResultV1).
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md: "All plugin-domain failures use
// `CMP-PLUGIN-<NNNN>` codes and bounded structured results with `operation_id`,
// request fingerprint, status, authority state before/after, cleanup
// status/target, retryability, and redacted recovery guidance."
//
// Two normative rules are enforced here as code, not convention:
//
//   PLUG-D17 (cleanup is orthogonal to authority). `termination_failed` and
//   `pending_restart` are cleanup outcomes with an explicit target, never
//   effective plugin states. buildOperationResult() therefore REJECTS any
//   result whose authority_state_after was derived from a cleanup outcome, and
//   assertCleanupOrthogonality() is exported so tests can prove the property
//   over the whole cleanup x authority cross-product rather than by example.
//
//   Redaction. Raw paths, secrets, and unbounded thrown messages must not cross
//   audit/renderer surfaces. The contract bounds `recovery_guidance` and
//   `failure.reason` to 200 printable-ASCII bytes, which stops unbounded text
//   but not a short absolute path -- so redactText() additionally rejects
//   path-shaped and secret-shaped values before they can be embedded.
//
// Wire codes are imported, never inlined (check_error_codes.py); W4 mints no
// new codes -- every durability failure below already has one in the
// pre-allocated CMP-PLUGIN core block.

const { validate } = require('../contracts/generated-plugin-contracts');
const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');

const CONTRACT_NAME = 'PluginOperationResultV1';

const CLEANUP_ONLY_STATUSES = Object.freeze(['termination_failed', 'pending_restart']);

// Durability failure reason (as produced by the store modules) -> wire code.
// The store's snake_case reasons stay the internal vocabulary; this is the one
// place they become CMP codes.
const REASON_TO_WIRE_CODE = Object.freeze({
  active_pointer_corrupted: PLUGIN_ERROR_CODES.POINTER_CORRUPT,
  post_commit_reread_failed: PLUGIN_ERROR_CODES.POINTER_CORRUPT,
  post_commit_verification_mismatch: PLUGIN_ERROR_CODES.POINTER_CORRUPT,
  epoch_not_strictly_increasing: PLUGIN_ERROR_CODES.EPOCH_REGRESSION,
  invalid_candidate_epoch: PLUGIN_ERROR_CODES.EPOCH_REGRESSION,
  invalid_current_epoch: PLUGIN_ERROR_CODES.EPOCH_REGRESSION,
  busy: PLUGIN_ERROR_CODES.LEASE_BUSY,
  // Lease-ownership rejections, including the ones commitActivePointer's
  // last-instant guard raises. Losing a lease mid-commit is a lease-contention
  // outcome, so it carries the same wire code as an outright busy lease.
  lease_guard_failed: PLUGIN_ERROR_CODES.LEASE_BUSY,
  lease_lost_during_commit: PLUGIN_ERROR_CODES.LEASE_BUSY,
  lease_not_held: PLUGIN_ERROR_CODES.LEASE_BUSY,
  lease_expired: PLUGIN_ERROR_CODES.LEASE_BUSY,
  not_lease_owner: PLUGIN_ERROR_CODES.LEASE_BUSY,
  lease_record_corrupted: PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE,
  // Recovery/PLUG-D19 refusals. Each one exists to stop an epoch from being
  // reused or an authority document from being overwritten, so they classify as
  // epoch/pointer integrity rather than as a generic store failure.
  recovery_required: PLUGIN_ERROR_CODES.POINTER_CORRUPT,
  pointer_intact_recovery_refused: PLUGIN_ERROR_CODES.POINTER_CORRUPT,
  pointer_digest_mismatch: PLUGIN_ERROR_CODES.POINTER_CORRUPT,
  recovered_epoch_too_low: PLUGIN_ERROR_CODES.EPOCH_REGRESSION,
  recovered_revision_not_advancing: PLUGIN_ERROR_CODES.EPOCH_REGRESSION,
  epoch_evidence_lost: PLUGIN_ERROR_CODES.EPOCH_REGRESSION,
  no_safe_candidate_generation: PLUGIN_ERROR_CODES.GENERATION_INVALID,
  active_generation_unusable: PLUGIN_ERROR_CODES.GENERATION_INVALID,
  generation_already_exists: PLUGIN_ERROR_CODES.GENERATION_INVALID,
  // A pending receipt whose outcome is not yet known is precisely the
  // indeterminate case; it is never permission to re-execute.
  join_pending: PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE,
  reject_indeterminate: PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE,
  reject_expired: PLUGIN_ERROR_CODES.IDEMPOTENCY_EXPIRED,
  reject_fingerprint_mismatch: PLUGIN_ERROR_CODES.FINGERPRINT_MISMATCH,
  stale_active_pointer: PLUGIN_ERROR_CODES.EXPECTED_GENERATION_CONFLICT,
  generation_advanced: PLUGIN_ERROR_CODES.EXPECTED_GENERATION_CONFLICT,
  revision_not_contiguous: PLUGIN_ERROR_CODES.EXPECTED_GENERATION_CONFLICT,
  fingerprint_mismatch: PLUGIN_ERROR_CODES.FINGERPRINT_MISMATCH,
  operation_receipt_corrupted: PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE,
  operation_receipt_not_found: PLUGIN_ERROR_CODES.IDEMPOTENCY_EXPIRED,
  generation_record_corrupted: PLUGIN_ERROR_CODES.GENERATION_INVALID,
  generation_record_invalid: PLUGIN_ERROR_CODES.GENERATION_INVALID,
  graph_hash_mismatch: PLUGIN_ERROR_CODES.GENERATION_INVALID,
  plugin_checksum_mismatch: PLUGIN_ERROR_CODES.GENERATION_INVALID,
  referential_closure_violation: PLUGIN_ERROR_CODES.GENERATION_INVALID,
  store_write_failed: PLUGIN_ERROR_CODES.STORE_WRITE_FAILED,
});

// Retryability is a property of the failure, not a caller's guess. Anything not
// listed is non-retryable: a durability failure whose safety we cannot prove
// must never advertise "just try again".
const RETRYABLE_REASONS = new Set([
  'busy',
  'stale_active_pointer',
  'generation_advanced',
  'revision_not_contiguous',
  'store_write_failed',
  // Losing the lease is the archetypal retryable failure: nothing this
  // operation intended was committed, and re-acquiring the lease is exactly
  // what a retry does.
  'lease_guard_failed',
  'lease_lost_during_commit',
  'lease_not_held',
  'lease_expired',
  'not_lease_owner',
  // Both are "not now, but a well-defined step makes it possible": recovery
  // rebuilds the epoch high-water, and a pending receipt settles.
  'recovery_required',
  'join_pending',
]);

const PATH_SHAPED = /(^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\[^\s\\]|\/(?:home|users|var|etc|tmp|mnt|opt|library|volumes|private|applications|system)\/)/i;
const SECRET_SHAPED = /\b(?:secret|token|password|passwd|api[_-]?key|bearer|authorization)\b\s*[:=]/i;
const NON_PRINTABLE = /[^\x20-\x7E]/;

// Returns {ok, text} or {ok:false, reason}. Callers embed only ok:true text.
function redactText(value, { maxBytes = 200 } = {}) {
  if (value === undefined || value === null) return { ok: true, text: undefined };
  if (typeof value !== 'string') return { ok: false, reason: 'guidance_not_a_string' };
  if (NON_PRINTABLE.test(value)) return { ok: false, reason: 'guidance_not_printable_ascii' };
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return { ok: false, reason: 'guidance_too_long' };
  if (PATH_SHAPED.test(value)) return { ok: false, reason: 'guidance_contains_path' };
  if (SECRET_SHAPED.test(value)) return { ok: false, reason: 'guidance_contains_secret' };
  return { ok: true, text: value };
}

function wireCodeFor(reason) {
  return REASON_TO_WIRE_CODE[reason];
}

function isRetryable(reason) {
  return RETRYABLE_REASONS.has(reason);
}

// PLUG-D17 in one assertion. `authorityStateAfter` must have been decided by
// the authority path (the committed generation), so it may never be one of the
// cleanup-only vocabulary values, and a degraded cleanup status may not change
// it relative to what the authority path committed.
function assertCleanupOrthogonality({ authorityStateAfter, authorityStateCommitted, cleanupStatus }) {
  if (CLEANUP_ONLY_STATUSES.includes(authorityStateAfter)) {
    return {
      ok: false,
      reason: 'cleanup_status_used_as_authority_state',
      detail: { authorityStateAfter },
    };
  }
  if (authorityStateCommitted !== undefined && authorityStateAfter !== authorityStateCommitted) {
    return {
      ok: false,
      reason: 'cleanup_altered_authority_state',
      detail: { committed: authorityStateCommitted, reported: authorityStateAfter, cleanupStatus },
    };
  }
  return { ok: true };
}

function buildOperationResult({
  operationId,
  requestFingerprint,
  status,
  authorityStateBefore,
  authorityStateAfter,
  authorityStateCommitted,
  cleanupStatus,
  cleanupTarget,
  settledAt,
  failureReason,
  recoveryGuidance,
}) {
  const orthogonality = assertCleanupOrthogonality({
    authorityStateAfter,
    authorityStateCommitted,
    cleanupStatus,
  });
  if (!orthogonality.ok) {
    return { ok: false, reason: orthogonality.reason, detail: orthogonality.detail };
  }

  const guidance = redactText(recoveryGuidance);
  if (!guidance.ok) {
    return { ok: false, reason: guidance.reason };
  }

  const candidate = {
    result_schema_version: 1,
    operation_id: operationId,
    request_fingerprint: requestFingerprint,
    status,
    retryable: failureReason ? isRetryable(failureReason) : false,
    authority_state_before: authorityStateBefore,
    authority_state_after: authorityStateAfter,
    cleanup_status: cleanupStatus,
    cleanup_target: cleanupTarget,
    settled_at: settledAt,
  };

  if (failureReason) {
    const failure = { code: failureReason };
    const wireCode = wireCodeFor(failureReason);
    if (wireCode) failure.wire_code = wireCode;
    candidate.failure = failure;
  }
  if (guidance.text !== undefined) {
    candidate.recovery_guidance = guidance.text;
  }

  const validated = validate(CONTRACT_NAME, candidate);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_operation_result', detail: validated.error };
  }
  return { ok: true, result: validated.value };
}

module.exports = {
  CONTRACT_NAME,
  CLEANUP_ONLY_STATUSES,
  REASON_TO_WIRE_CODE,
  RETRYABLE_REASONS,
  redactText,
  wireCodeFor,
  isRetryable,
  assertCleanupOrthogonality,
  buildOperationResult,
};
