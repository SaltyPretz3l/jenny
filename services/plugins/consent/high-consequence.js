'use strict';

// PLUG-D18 / invariant 21, the structural seam: "High-consequence consent
// (full-host enable, secret-value delivery, publisher re-trust, explicit
// downgrade, quarantine release) is approved only through a main-process-
// owned consent surface that renders no plugin-derived content beyond
// sanitized, length-bounded identity strings; a message from the main
// renderer is a request, never an approval." Architecture doc line ~385
// (the IPC handler paragraph): "Handlers for high-consequence consent
// additionally verify that approval originated from the main-process
// consent surface; a well-formed renderer message alone never constitutes
// approval (PLUG-D18)."
//
// Stage 3B's IPC layer will call this from the main process; THIS module
// has no idea Electron/IPC/renderer exist (lane rule 5 -- no reference to
// main/renderer/electron) and never will. What it guarantees, independent of
// any caller, is that the five named operations cannot be approved by
// anything other than a value explicitly tagged `surface:
// 'main_process_consent'`, bound to the exact authority/operation/request it
// was granted for, inside a bounded validity window. `assertConsentSatisfied`
// is the throwing guard meant to sit at the top of every one of these
// operation code paths specifically so a caller cannot forget the check and
// silently proceed: forgetting to call it is the only way to skip consent,
// and forgetting an explicit call is a far easier defect to catch in review
// (or by a coverage/lint rule) than an implicitly-passing conditional would
// be.
//
// The approval record itself is Stage-2/3B-internal wiring passed in-process
// from the consent surface to this check -- like mutation-lease.js's lease
// record, it crosses no durable/cross-principal boundary in this packet, so
// it has no generated contract of its own (rule 10: no new contract schema)
// and gets a hand-rolled shape check instead.
//
// STAGE SCOPING: `ORDINARY_OPERATIONS` below is the complete Stage-4A IPC
// operation vocabulary -- exactly the eight verbs the Stage-4A control plane
// exposes -- not a general-purpose allowlist this module
// invents or grows on its own. It is deliberately closed, not extensible from
// outside this file: a Stage-4+ author who introduces a new operation id
// (activation, per-contribution toggles, etc.) MUST add it here, explicitly
// classified as ordinary or high-consequence, before it is anything other
// than `unknown`. Forgetting to do that is safe by construction --
// `classifyOperation` resolves an unlisted id to `'unknown'`, so a forgotten
// classification fails closed instead of silently slipping through as
// ordinary.

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const { canonicalAuthorityTuple, authorityKey } = require('../identity/authority-id');
const { validateDisplayString } = require('../identity/display-strings');

// Exactly the five operations named by invariant 21 / PLUG-D18. snake_case ids
// are this module's own vocabulary for "operation requiring the consent
// surface" -- deliberately NOT the dotted PluginGrantV1.capability spelling
// (`full_host.enable`, `downgrade.explicit`, `quarantine.release`), because an
// operation id and a capability id are different vocabularies for different
// concerns (a request to DO something bounded in time vs. a durable authority
// grant); collapsing them would let a coincidental string match stand in for
// an actual mapping that does not exist here.
const HIGH_CONSEQUENCE_OPERATIONS = Object.freeze(
  new Set([
    'full_host_enable', // invariant 21 / PLUG-D18: "full-host enable"
    'secret_value_delivery', // invariant 21 / PLUG-D18: "secret-value delivery"
    'publisher_retrust', // invariant 21 / PLUG-D18: "publisher re-trust"
    'downgrade_explicit', // invariant 21 / PLUG-D18: "explicit downgrade"
    'quarantine_release', // invariant 21 / PLUG-D18: "quarantine release"
  ])
);

// The complete Stage-4A IPC operation vocabulary that is NOT one of the five
// above -- ordinary because none of them grants, changes, or reveals
// authority at this stage. See the STAGE SCOPING note above: this set is
// fixed to Stage 4A and must be re-examined, not silently trusted, when the
// activation scope expands.
const ORDINARY_OPERATIONS = Object.freeze(
  new Set([
    'get_state', // read-only inspection of installed/generation state
    'policy_status', // read-only: reports the evaluated policy snapshot, grants nothing
    'operation_status', // read-only: queries an existing operation id/receipt, mints nothing
    // Ordinary specifically BECAUSE Stage 3 is disabled-only: a local package
    // install lands the plugin at `installed_disabled` and grants no
    // execution authority (no contribution activates, per PLUG-D22 / the
    // program's "installing or activating a real plugin remains forbidden"
    // stage gate). A Stage-4 author must NOT assume this stays ordinary once
    // activation exists -- installing a plugin that can actually run is a
    // materially different authority event and belongs back on the
    // high-consequence side of this line if Stage 4 doesn't gate it some
    // other way.
    'install_local_package',
    'uninstall', // logical disable + authority teardown of an already-inert (disabled-only) plugin; no execution authority is ever live to revoke at this stage
    // Stage 4A activation is limited to re-verified first-party, current-key,
    // permissionless, dependency-free skill/prompt declarations. These verbs
    // cannot grant full-host, network, code, MCP, secret, or view authority.
    'enable',
    'disable',
    'export_audit', // read-only bounded export of evidence already on disk (lifecycle/audit-export.js); reveals no new authority
  ])
);

const NEUTRAL_DISPLAY_NAME_PLACEHOLDER = '(unnamed plugin)';

// Three-way, fail-closed classifier. Only an EXACT match against the fixed
// Stage-3 ordinary vocabulary resolves to `'ordinary'`; only an exact match
// against the five invariant-21 ids resolves to `'high_consequence'`.
// Everything else -- a malformed/non-string value, a typo, or a
// plausible-looking operation id this module has simply never been taught
// about -- resolves to `'unknown'`. This makes forgetting to classify a new
// Stage-4 operation here safe rather than a silent authority hole: an
// unclassified id can never be mistaken for `'ordinary'`.
function classifyOperation(operation) {
  if (typeof operation !== 'string' || operation.length === 0) return 'unknown';
  if (HIGH_CONSEQUENCE_OPERATIONS.has(operation)) return 'high_consequence';
  if (ORDINARY_OPERATIONS.has(operation)) return 'ordinary';
  return 'unknown';
}

function authorityMatches(candidate, expected) {
  const candidateTuple = canonicalAuthorityTuple(candidate || {});
  const expectedTuple = canonicalAuthorityTuple(expected || {});
  if (!candidateTuple.ok || !expectedTuple.ok) return false;
  return authorityKey(candidate) === authorityKey(expected);
}

function denyConsentRequired(reason) {
  return { ok: false, code: PLUGIN_ERROR_CODES.CONSENT_REQUIRED, reason };
}

/**
 * Checks a consent APPROVAL (never a bare request) against everything it must
 * be bound to. Returns a result object; never throws (see
 * assertConsentSatisfied for the throwing form).
 *
 * @param {object} params
 * @param {string} params.operation - one of HIGH_CONSEQUENCE_OPERATIONS
 * @param {object|null|undefined} params.approval - the candidate approval
 *   record: { surface, operation, authority:{publisherId,pluginId,
 *   contributionId}, requestFingerprint, approvalId, expiresAt }.
 *   `expiresAt` is a monotonic-clock reading -- never an ISO wall-clock
 *   string, so wall-clock rollback can never extend an approval's life.
 * @param {number} params.now - the current monotonic-clock reading (injected;
 *   this module never reads a clock itself).
 * @param {object} params.expectedAuthority - the authority tuple this
 *   specific request is FOR; the approval must have been granted to this
 *   exact tuple, not merely to A plugin.
 * @param {string} params.expectedRequestFingerprint - the canonical
 *   fingerprint of the exact request being authorized; binds the approval to
 *   this request payload so it cannot be replayed against a different one.
 * @returns {{ok:false,code:string,reason:string}|{ok:true,approvalRef:string|null}}
 */
function requireConsent({ operation, approval, now, expectedAuthority, expectedRequestFingerprint }) {
  if (!approval || typeof approval !== 'object') {
    return denyConsentRequired('consent_missing');
  }

  // Origin check first and unconditionally, and checked BEFORE anything else
  // about the approval's content is trusted: a message that did not
  // originate from the main-process consent surface is never evidence of
  // anything, no matter how well-formed the rest of it looks (PLUG-D18). A
  // renderer-origin (or any other non-`main_process_consent`) value gets its
  // own distinct code precisely so a caller reviewing a rejection can tell
  // "this came from the wrong place" apart from "there simply is no
  // approval yet".
  if (approval.surface !== 'main_process_consent') {
    return { ok: false, code: PLUGIN_ERROR_CODES.CONSENT_ORIGIN_INVALID, reason: 'consent_origin_invalid' };
  }

  if (typeof operation !== 'string' || operation.length === 0 || approval.operation !== operation) {
    return denyConsentRequired('consent_operation_mismatch');
  }

  if (!authorityMatches(approval.authority, expectedAuthority)) {
    // Covers both "malformed expectedAuthority/approval.authority" and "a
    // well-formed but DIFFERENT authority" -- a consent granted for plugin A
    // must never authorize plugin B, and a malformed expectation must never
    // vacuously match.
    return denyConsentRequired('consent_authority_mismatch');
  }

  if (
    typeof expectedRequestFingerprint !== 'string' ||
    expectedRequestFingerprint.length === 0 ||
    approval.requestFingerprint !== expectedRequestFingerprint
  ) {
    // Binds the approval to the exact request payload it was shown for; an
    // approval minted for one set of arguments must not authorize a
    // different request that merely shares the same operation+authority.
    return denyConsentRequired('consent_fingerprint_mismatch');
  }

  if (
    typeof now !== 'number' ||
    !Number.isFinite(now) ||
    typeof approval.expiresAt !== 'number' ||
    !Number.isFinite(approval.expiresAt) ||
    now >= approval.expiresAt
  ) {
    // An expired approval is CONSENT_REQUIRED, not a soft warning -- there is
    // no partial-credit state between "consent satisfied" and "consent
    // required".
    return denyConsentRequired('consent_expired');
  }

  const approvalRef = typeof approval.approvalId === 'string' && approval.approvalId ? approval.approvalId : null;
  return { ok: true, approvalRef };
}

/**
 * Throwing guard intended to be the FIRST line of any high-consequence
 * operation path. Its entire purpose is that a caller who forgets to invoke
 * it cannot silently proceed as though consent had been checked: there is no
 * boolean to ignore, no result object to leave unexamined -- either this
 * returns normally (consent satisfied) or the operation never continues
 * (thrown error carrying the CMP-PLUGIN wire code). Callers should invoke
 * this unconditionally at the top of the operation, before any
 * authority-bearing side effect.
 *
 * @throws {Error} with `.code` set to the CMP-PLUGIN wire code and `.reason`
 *   set to the bounded internal reason string, when consent is not satisfied.
 * @returns {string|null} the approvalRef, when consent is satisfied.
 */
function assertConsentSatisfied({ operation, approval, now, expectedAuthority, expectedRequestFingerprint }) {
  const verdict = requireConsent({ operation, approval, now, expectedAuthority, expectedRequestFingerprint });
  if (!verdict.ok) {
    const error = new Error(`high-consequence operation '${String(operation)}' blocked: ${verdict.reason}`);
    error.code = verdict.code;
    error.reason = verdict.reason;
    throw error;
  }
  return verdict.approvalRef;
}

/**
 * Produces the ONLY plugin-derived content this consent surface may render:
 * a sanitized authority tuple plus an NFC-normalized, length-bounded display
 * name routed through identity/display-strings.js. A display string that
 * fails validation (control/bidi/zero-width codepoints, reserved Jenny/
 * official label, not NFC, too long, not a string) never falls back to the
 * raw value -- it becomes a neutral placeholder, because the raw value is
 * exactly the thing a hostile publisher would have crafted to spoof this
 * surface's chrome.
 *
 * @param {object} params
 * @param {object} params.authority - {publisherId, pluginId, contributionId}
 * @param {unknown} params.displayName - untrusted, plugin-supplied display name
 * @returns {{authority:{publisherId:string|null,pluginId:string|null,contributionId:string|null},displayName:string}}
 */
function sanitizeConsentPrompt({ authority, displayName }) {
  const tupleCheck = canonicalAuthorityTuple(authority || {});
  const safeAuthority = tupleCheck.ok
    ? {
        publisherId: authority.publisherId,
        pluginId: authority.pluginId,
        contributionId: authority.contributionId,
      }
    : { publisherId: null, pluginId: null, contributionId: null };

  const validated = validateDisplayString(displayName);
  const safeDisplayName = validated.ok ? validated.value : NEUTRAL_DISPLAY_NAME_PLACEHOLDER;

  return Object.freeze({
    authority: Object.freeze(safeAuthority),
    displayName: safeDisplayName,
  });
}

module.exports = {
  HIGH_CONSEQUENCE_OPERATIONS,
  ORDINARY_OPERATIONS,
  NEUTRAL_DISPLAY_NAME_PLACEHOLDER,
  classifyOperation,
  requireConsent,
  assertConsentSatisfied,
  sanitizeConsentPrompt,
};
