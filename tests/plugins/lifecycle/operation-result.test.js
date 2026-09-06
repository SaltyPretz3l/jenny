'use strict';

// PluginOperationResultV1 (operation-result.js): PLUG-D17 cleanup/authority
// orthogonality, write-time redaction of recovery guidance, and the
// reason -> {retryable, wire_code} derivations that make a durability
// failure's result deterministic and never caller-shaped.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTRACT_NAME,
  CLEANUP_ONLY_STATUSES,
  redactText,
  wireCodeFor,
  isRetryable,
  assertCleanupOrthogonality,
  buildOperationResult,
} = require('../../../services/plugins/lifecycle/operation-result');
const { validate } = require('../../../services/plugins/contracts/generated-plugin-contracts');
const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');

const NOW = '2026-07-31T00:00:00Z';
const DIGEST_A = 'a'.repeat(64);

// The contract's own authority_state enum (9 values). Deliberately hand-
// listed rather than re-derived from the schema, so this test fails loudly
// if the contract's enum ever drifts instead of silently tracking it.
const AUTHORITY_STATES = [
  'absent', 'staged', 'installed_disabled', 'preparing', 'active',
  'disabling', 'blocked', 'quarantined', 'uninstalling',
];

// The contract's cleanup_status enum (5 values). The cleanup-only pair is spelled
// out here rather than spread from CLEANUP_ONLY_STATUSES: deriving both the
// inputs AND the forbidden set from the constant under test made the whole
// cross-product collapse to nothing when that constant was emptied, with every
// assertion still passing. The production export is checked against this literal
// instead, so the vocabulary cannot shrink silently.
const EXPECTED_CLEANUP_ONLY = ['termination_failed', 'pending_restart'];
const CLEANUP_STATUSES = ['not_required', 'settling', 'complete', ...EXPECTED_CLEANUP_ONLY];

function baseResultInput(overrides = {}) {
  return {
    operationId: 'op-1',
    requestFingerprint: DIGEST_A,
    status: 'committed',
    authorityStateBefore: 'installed_disabled',
    authorityStateAfter: 'installed_disabled',
    cleanupStatus: 'not_required',
    cleanupTarget: { kind: 'installed_disabled' },
    settledAt: NOW,
    ...overrides,
  };
}

test('assertCleanupOrthogonality (PLUG-D17) holds over the full cleanup_status x authority_state cross-product', () => {
  for (const cleanupStatus of CLEANUP_STATUSES) {
    // A cleanup outcome is never a valid effective plugin state -- this must
    // fail for every cleanup-only string, under every cleanup_status value,
    // independent of whatever authorityStateCommitted happens to be.
    for (const cleanupOnlyState of EXPECTED_CLEANUP_ONLY) {
      const result = assertCleanupOrthogonality({
        authorityStateAfter: cleanupOnlyState,
        authorityStateCommitted: undefined,
        cleanupStatus,
      });
      assert.equal(result.ok, false, `${cleanupStatus}/${cleanupOnlyState}`);
      assert.equal(result.reason, 'cleanup_status_used_as_authority_state');
    }

    // A cleanup outcome (degraded or otherwise) must never be able to change
    // authority_state_after away from what the authority path actually
    // committed.
    for (const authorityStateAfter of AUTHORITY_STATES) {
      for (const authorityStateCommitted of AUTHORITY_STATES) {
        const result = assertCleanupOrthogonality({ authorityStateAfter, authorityStateCommitted, cleanupStatus });
        if (authorityStateAfter === authorityStateCommitted) {
          assert.equal(result.ok, true, `${cleanupStatus}/${authorityStateAfter}/${authorityStateCommitted}`);
        } else {
          assert.equal(result.ok, false, `${cleanupStatus}/${authorityStateAfter}/${authorityStateCommitted}`);
          assert.equal(result.reason, 'cleanup_altered_authority_state');
        }
      }
    }
  }
});

test('redactText rejects non-printable text', () => {
  const result = redactText('line one\nline two');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'guidance_not_printable_ascii');
});

test('redactText rejects text over the 200-byte bound', () => {
  const result = redactText('a'.repeat(201));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'guidance_too_long');
});

test('redactText rejects path-shaped text: Windows drive, POSIX absolute, and UNC', () => {
  const pathShapedExamples = [
    'See C:\\Users\\alice\\plugins\\lease.json for detail.',
    'Inspect /home/alice/.jenny/plugins for detail.',
    'Inspect /Library/Managed Preferences/com.jenny.shell for detail.',
    'Inspect /private/var/db/jenny for detail.',
    'Inspect /Volumes/Managed/Jenny for detail.',
    'Check \\\\fileserver\\share\\plugins for detail.',
  ];
  for (const text of pathShapedExamples) {
    const result = redactText(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.reason, 'guidance_contains_path', text);
  }
});

test('redactText rejects secret-shaped text', () => {
  const secretShapedExamples = ['token: abc123', 'api_key=xyz789', 'Bearer: sekret'];
  for (const text of secretShapedExamples) {
    const result = redactText(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.reason, 'guidance_contains_secret', text);
  }
});

test('redactText accepts ordinary bounded prose', () => {
  const text = 'Retry the operation once network connectivity is restored.';
  assert.deepEqual(redactText(text), { ok: true, text });
});

test('buildOperationResult refuses to embed unredacted recovery guidance and returns the specific reason', () => {
  const result = buildOperationResult(baseResultInput({
    status: 'failed',
    failureReason: 'busy',
    recoveryGuidance: 'Check C:\\Users\\alice\\plugins for the stuck lease file.',
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'guidance_contains_path');
});

test('isRetryable derives retryability from the failure reason alone', () => {
  assert.equal(isRetryable('busy'), true);
  assert.equal(isRetryable('fingerprint_mismatch'), false);
  assert.equal(isRetryable('some_unregistered_reason'), false);
});

test('buildOperationResult wires retryable from the failure reason, never a caller-supplied flag', () => {
  assert.deepEqual([...CLEANUP_ONLY_STATUSES], EXPECTED_CLEANUP_ONLY,
    'the cleanup-only vocabulary must not shrink without this test noticing');

  // "never a caller-supplied flag" needs a caller-supplied flag to disprove.
  // Both cases below now pass one that CONTRADICTS the reason-derived answer.
  const busyResult = buildOperationResult(baseResultInput({
    status: 'failed', failureReason: 'busy', retryable: false,
  }));
  assert.equal(busyResult.ok, true);
  assert.equal(busyResult.result.retryable, true);

  const fingerprintResult = buildOperationResult(baseResultInput({
    operationId: 'op-2',
    status: 'failed',
    failureReason: 'fingerprint_mismatch',
    retryable: true,
  }));
  assert.equal(fingerprintResult.ok, true);
  assert.equal(fingerprintResult.result.retryable, false);
});

test('wireCodeFor maps store failure reasons to the imported PLUGIN_ERROR_CODES constants, never a literal', () => {
  assert.equal(wireCodeFor('busy'), PLUGIN_ERROR_CODES.LEASE_BUSY);
  assert.equal(wireCodeFor('fingerprint_mismatch'), PLUGIN_ERROR_CODES.FINGERPRINT_MISMATCH);
  assert.equal(wireCodeFor('epoch_not_strictly_increasing'), PLUGIN_ERROR_CODES.EPOCH_REGRESSION);
  assert.equal(wireCodeFor('active_pointer_corrupted'), PLUGIN_ERROR_CODES.POINTER_CORRUPT);
  assert.equal(wireCodeFor('generation_record_corrupted'), PLUGIN_ERROR_CODES.GENERATION_INVALID);
  assert.equal(wireCodeFor('store_write_failed'), PLUGIN_ERROR_CODES.STORE_WRITE_FAILED);
  assert.equal(wireCodeFor('operation_receipt_not_found'), PLUGIN_ERROR_CODES.IDEMPOTENCY_EXPIRED);
  assert.equal(wireCodeFor('an_unmapped_reason_nobody_registered'), undefined);
});

test('a valid operation result round-trips through the generated validator', () => {
  const built = buildOperationResult(baseResultInput({
    authorityStateAfter: 'active',
    authorityStateCommitted: 'active',
    cleanupTarget: { kind: 'absent' },
  }));
  assert.equal(built.ok, true);

  const revalidated = validate(CONTRACT_NAME, built.result);
  assert.equal(revalidated.ok, true);
  assert.deepEqual(revalidated.value, built.result);
});
