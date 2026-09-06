'use strict';

// PLUG-D18 / invariant 21's structural seam (consent/high-consequence.js):
// full-host enable, secret-value delivery, publisher re-trust, explicit
// downgrade, and quarantine release must be impossible to approve except
// through a value explicitly tagged as having come from the main-process
// consent surface, bound to the exact authority/operation/request, inside a
// bounded validity window.

const test = require('node:test');
const assert = require('node:assert/strict');

const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const {
  HIGH_CONSEQUENCE_OPERATIONS,
  ORDINARY_OPERATIONS,
  NEUTRAL_DISPLAY_NAME_PLACEHOLDER,
  classifyOperation,
  requireConsent,
  assertConsentSatisfied,
  sanitizeConsentPrompt,
} = require('../../../services/plugins/consent/high-consequence');

const AUTHORITY_A = { publisherId: 'acme', pluginId: 'widgets', contributionId: 'main' };
const AUTHORITY_B = { publisherId: 'other', pluginId: 'gadgets', contributionId: 'main' };
const OPERATION = 'full_host_enable';
const FINGERPRINT_A = 'f'.repeat(64);

function validApproval(overrides = {}) {
  return {
    surface: 'main_process_consent',
    operation: OPERATION,
    authority: AUTHORITY_A,
    requestFingerprint: FINGERPRINT_A,
    approvalId: 'approval-1',
    expiresAt: 10000,
    ...overrides,
  };
}

test('HIGH_CONSEQUENCE_OPERATIONS names exactly the five invariant-21 operations', () => {
  assert.deepEqual(
    Array.from(HIGH_CONSEQUENCE_OPERATIONS).sort(),
    [
      'downgrade_explicit',
      'full_host_enable',
      'publisher_retrust',
      'quarantine_release',
      'secret_value_delivery',
    ].sort()
  );
});

test('ORDINARY_OPERATIONS names exactly the eight Stage-4A IPC verbs', () => {
  assert.deepEqual(
    Array.from(ORDINARY_OPERATIONS).sort(),
    [
      'disable',
      'enable',
      'export_audit',
      'get_state',
      'install_local_package',
      'operation_status',
      'policy_status',
      'uninstall',
    ].sort()
  );
});

test('classifyOperation resolves each of the eight Stage-4A IPC verbs to "ordinary"', () => {
  for (const operation of ORDINARY_OPERATIONS) {
    assert.equal(classifyOperation(operation), 'ordinary');
  }
});

test('classifyOperation resolves each of the five invariant-21 operations to "high_consequence"', () => {
  for (const operation of HIGH_CONSEQUENCE_OPERATIONS) {
    assert.equal(classifyOperation(operation), 'high_consequence');
  }
});

test('classifyOperation resolves an unrecognized operation id to "unknown"', () => {
  const unknown = 'some_future_operation_nobody_taught_this_module_about';
  assert.equal(classifyOperation(unknown), 'unknown');
});

test('classifyOperation resolves malformed input to "unknown"', () => {
  assert.equal(classifyOperation(''), 'unknown');
  assert.equal(classifyOperation(undefined), 'unknown');
  assert.equal(classifyOperation(null), 'unknown');
  assert.equal(classifyOperation(42), 'unknown');
});

test('the ordinary and high-consequence vocabularies are disjoint', () => {
  for (const operation of ORDINARY_OPERATIONS) {
    assert.equal(HIGH_CONSEQUENCE_OPERATIONS.has(operation), false);
  }
});

test('requireConsent still rejects an unknown operation id when no approval record is presented', () => {
  const unknown = 'some_future_operation_nobody_taught_this_module_about';
  const result = requireConsent({
    operation: unknown,
    approval: undefined,
    now: 0,
    expectedAuthority: AUTHORITY_A,
    expectedRequestFingerprint: FINGERPRINT_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  assert.equal(result.reason, 'consent_missing');
});

test('requireConsent: absent approval is CONSENT_REQUIRED', () => {
  const result = requireConsent({
    operation: OPERATION,
    approval: undefined,
    now: 0,
    expectedAuthority: AUTHORITY_A,
    expectedRequestFingerprint: FINGERPRINT_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  assert.equal(result.reason, 'consent_missing');
});

test('requireConsent: surface "renderer" is CONSENT_ORIGIN_INVALID, never CONSENT_REQUIRED', () => {
  const result = requireConsent({
    operation: OPERATION,
    approval: validApproval({ surface: 'renderer' }),
    now: 0,
    expectedAuthority: AUTHORITY_A,
    expectedRequestFingerprint: FINGERPRINT_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_ORIGIN_INVALID);
  assert.equal(result.reason, 'consent_origin_invalid');
});

test('requireConsent: every other surface value is also CONSENT_ORIGIN_INVALID', () => {
  for (const surface of ['plugin_view', 'sidecar', '', null, undefined, 'Main_Process_Consent']) {
    const result = requireConsent({
      operation: OPERATION,
      approval: validApproval({ surface }),
      now: 0,
      expectedAuthority: AUTHORITY_A,
      expectedRequestFingerprint: FINGERPRINT_A,
    });
    assert.equal(result.ok, false, `surface ${JSON.stringify(surface)} must be rejected`);
    assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_ORIGIN_INVALID);
  }
});

test('requireConsent: an approval granted for a different operation is CONSENT_REQUIRED', () => {
  const result = requireConsent({
    operation: OPERATION,
    approval: validApproval({ operation: 'quarantine_release' }),
    now: 0,
    expectedAuthority: AUTHORITY_A,
    expectedRequestFingerprint: FINGERPRINT_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  assert.equal(result.reason, 'consent_operation_mismatch');
});

test('requireConsent: a consent granted for plugin A is rejected for plugin B', () => {
  const result = requireConsent({
    operation: OPERATION,
    approval: validApproval({ authority: AUTHORITY_A }),
    now: 0,
    expectedAuthority: AUTHORITY_B,
    expectedRequestFingerprint: FINGERPRINT_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  assert.equal(result.reason, 'consent_authority_mismatch');
});

test('requireConsent: an approval replayed against a different request fingerprint is rejected', () => {
  const result = requireConsent({
    operation: OPERATION,
    approval: validApproval({ requestFingerprint: FINGERPRINT_A }),
    now: 0,
    expectedAuthority: AUTHORITY_A,
    expectedRequestFingerprint: 'e'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  assert.equal(result.reason, 'consent_fingerprint_mismatch');
});

test('requireConsent: an expired approval is CONSENT_REQUIRED, not a soft warning', () => {
  const result = requireConsent({
    operation: OPERATION,
    approval: validApproval({ expiresAt: 1000 }),
    now: 5000,
    expectedAuthority: AUTHORITY_A,
    expectedRequestFingerprint: FINGERPRINT_A,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
  assert.equal(result.reason, 'consent_expired');
});

test('requireConsent: a well-formed, matching, unexpired main-process approval is satisfied', () => {
  const result = requireConsent({
    operation: OPERATION,
    approval: validApproval(),
    now: 5000,
    expectedAuthority: AUTHORITY_A,
    expectedRequestFingerprint: FINGERPRINT_A,
  });
  assert.equal(result.ok, true);
  assert.equal(result.approvalRef, 'approval-1');
});

test('assertConsentSatisfied throws an Error carrying the CMP code when consent is missing', () => {
  assert.throws(
    () =>
      assertConsentSatisfied({
        operation: OPERATION,
        approval: undefined,
        now: 0,
        expectedAuthority: AUTHORITY_A,
        expectedRequestFingerprint: FINGERPRINT_A,
      }),
    (error) => {
      assert.equal(error.code, PLUGIN_ERROR_CODES.CONSENT_REQUIRED);
      assert.equal(error.reason, 'consent_missing');
      return true;
    }
  );
});

test('assertConsentSatisfied returns the approvalRef and does not throw when consent is satisfied', () => {
  const approvalRef = assertConsentSatisfied({
    operation: OPERATION,
    approval: validApproval(),
    now: 5000,
    expectedAuthority: AUTHORITY_A,
    expectedRequestFingerprint: FINGERPRINT_A,
  });
  assert.equal(approvalRef, 'approval-1');
});

test('sanitizeConsentPrompt passes through a valid display name and the authority tuple', () => {
  const result = sanitizeConsentPrompt({ authority: AUTHORITY_A, displayName: "Acme Widgets" });
  assert.equal(result.displayName, 'Acme Widgets');
  assert.deepEqual(result.authority, AUTHORITY_A);
});

test('sanitizeConsentPrompt replaces a display string that fails validation with a neutral placeholder, never the raw value', () => {
  const hostile = 'Jenny‮evil-reversed-suffix';
  const result = sanitizeConsentPrompt({ authority: AUTHORITY_A, displayName: hostile });
  assert.equal(result.displayName, NEUTRAL_DISPLAY_NAME_PLACEHOLDER);
  assert.notEqual(result.displayName, hostile);

  const reserved = sanitizeConsentPrompt({ authority: AUTHORITY_A, displayName: 'Jenny' });
  assert.equal(reserved.displayName, NEUTRAL_DISPLAY_NAME_PLACEHOLDER);
});

test('sanitizeConsentPrompt renders a malformed authority tuple as nulls rather than the raw invalid value', () => {
  const result = sanitizeConsentPrompt({
    authority: { publisherId: 'ACME', pluginId: 'widgets', contributionId: 'main' },
    displayName: 'Acme Widgets',
  });
  assert.deepEqual(result.authority, { publisherId: null, pluginId: null, contributionId: null });
});
