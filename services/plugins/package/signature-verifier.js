'use strict';

// Jenny-chosen signature policy (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md,
// "Package, identity, and storage": "Jenny chooses the accepted signature
// algorithms and canonicalization version rather than trusting
// package-selected algorithms" -- program default, decision revision 6:
// Ed25519 is the accepted signature algorithm family) and stable-publisher
// key binding ("Publisher display names/slugs and signing keys are metadata:
// keys rotate underneath the stable publisher identity through delegation or
// explicit re-trust ... Signature proves publisher continuity, not safety.").
//
// This module never activates or installs anything -- it produces a verdict.
// It takes an INJECTED `verify` function (production Electron wires a
// node:crypto Ed25519 wrapper; this module never requires('crypto') itself)
// so it stays a pure, deterministic library with no ambient dependency.
//
// Every check below runs in an order chosen so a revoked key or a
// Jenny-rejected algorithm never reaches the actual cryptographic call:
// "a revoked key never verifies, even if the math checks out -- verify the
// status BEFORE the cryptographic check so a revoked key costs nothing."

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const {
  CANONICAL_METADATA_VERSION,
  serializeCanonicalPayload,
} = require('./canonical-metadata');

// Jenny's allowlist. A package names an algorithm; Jenny decides whether that
// name is accepted -- never the reverse. Frozen so no caller can widen it at
// runtime.
const ACCEPTED_ALGORITHMS = Object.freeze(['ed25519']);

/**
 * Every return path -- success or failure, at any check -- uses this same
 * key set, so the result is constant in shape regardless of failure point
 * (never a bare boolean, never an early `return true`).
 * @returns {{ok:boolean, reason:string|null, code:string|null,
 *   key_id:string|null, requires_retrust:boolean, algorithm:string|null}}
 */
function result({ ok, reason = null, code = null, key_id = null, requires_retrust = false, algorithm = null }) {
  return { ok, reason, code, key_id, requires_retrust, algorithm };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findKey(trustRecord, keyId) {
  if (!trustRecord || !Array.isArray(trustRecord.keys)) return null;
  return trustRecord.keys.find((candidate) => candidate && candidate.key_id === keyId) || null;
}

/**
 * Verifies ONE signature entry against `payload`, bound to `trustRecord`.
 * Never throws for a domain reason; `verify` is called at most once, and
 * only after every allowlist/trust check upstream of it has passed.
 * @param {unknown} signature
 * @param {object} payload the canonical signed-metadata payload (never a
 *   package-supplied "already canonical" blob -- this module serializes it
 *   itself via serializeCanonicalPayload).
 * @param {{publisher_id:string, keys:Array<object>}} trustRecord
 * @param {(args:{algorithm:string, publicKey:string, message:Buffer, signature:unknown}) => boolean} verify
 */
function verifyOne(signature, payload, trustRecord, verify) {
  if (!isPlainObject(signature)) {
    return result({ ok: false, code: PLUGIN_ERROR_CODES.SIGNATURE_INVALID, reason: 'signature_malformed' });
  }

  // 1. Algorithm allowlist, checked before ANYTHING else touches key
  // material. A package naming 'none', an unknown algorithm, or omitting the
  // field entirely all fail the same `includes` check -- rejection happens
  // on Jenny's allowlist, never by asking the package what is acceptable.
  const algorithm = typeof signature.algorithm === 'string' ? signature.algorithm : null;
  if (!algorithm || !ACCEPTED_ALGORITHMS.includes(algorithm)) {
    return result({ ok: false, code: PLUGIN_ERROR_CODES.SIGNATURE_INVALID, reason: 'unsupported_algorithm', algorithm });
  }

  // 2. Canonicalization version pinned against Jenny's own constant, not the
  // package's. A signature computed over a different canonicalization
  // version could mean the same bytes something else entirely
  // (version-confusion attack), so it is rejected here rather than trusted.
  if (signature.canonicalization_version !== CANONICAL_METADATA_VERSION) {
    return result({
      ok: false,
      code: PLUGIN_ERROR_CODES.SIGNATURE_INVALID,
      reason: 'canonicalization_version_mismatch',
      algorithm,
    });
  }

  const keyId = typeof signature.key_id === 'string' ? signature.key_id : null;

  // 3. Publisher_id binding: the signed metadata's claimed publisher must
  // match the trust record's stable publisher identity.
  if (!trustRecord || typeof trustRecord.publisher_id !== 'string' || trustRecord.publisher_id !== payload.publisher_id) {
    return result({
      ok: false,
      code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED,
      reason: 'publisher_id_mismatch',
      key_id: keyId,
      algorithm,
    });
  }

  // 4. Key resolution. Keys are metadata that rotate underneath the stable
  // publisher_id -- an unknown key_id is not trusted, full stop.
  const key = keyId ? findKey(trustRecord, keyId) : null;
  if (!key) {
    return result({ ok: false, code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED, reason: 'unknown_key_id', key_id: keyId, algorithm });
  }
  if (key.algorithm !== algorithm) {
    return result({
      ok: false,
      code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED,
      reason: 'key_algorithm_mismatch',
      key_id: keyId,
      algorithm,
    });
  }

  // 5. Revocation, checked BEFORE the cryptographic call: "a revoked key
  // never verifies, even if the math checks out." This is what makes a
  // revoked key cost nothing -- `verify` is never invoked for it.
  if (key.status === 'revoked') {
    return result({ ok: false, code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED, reason: 'key_revoked', key_id: keyId, algorithm });
  }
  if (key.status !== 'active' && key.status !== 'rotated') {
    return result({ ok: false, code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED, reason: 'key_status_invalid', key_id: keyId, algorithm });
  }

  // 6. The actual cryptographic check, over bytes THIS module serializes --
  // never a package-supplied "already canonical" blob (the classic
  // signature-bypass this guards against).
  const message = serializeCanonicalPayload(payload);
  let verified;
  try {
    verified = Boolean(verify({ algorithm, publicKey: key.public_key, message, signature: signature.signature }));
  } catch (error) {
    void error;
    verified = false;
  }
  if (!verified) {
    return result({ ok: false, code: PLUGIN_ERROR_CODES.SIGNATURE_INVALID, reason: 'signature_verification_failed', key_id: keyId, algorithm });
  }

  // A rotated key's math checking out is publisher-continuity evidence, not
  // a free pass: the caller must still surface requires_retrust to a human.
  return result({ ok: true, key_id: keyId, algorithm, requires_retrust: key.status === 'rotated' });
}

/**
 * Verifies an array of signatures over the same canonical payload. All
 * listed signatures must individually verify (one malformed/invalid entry
 * rejects the WHOLE package, never a partial accept); when more than one
 * signature is present, at least one must resolve to the current `active`
 * key rather than only ever-rotated keys.
 * @param {{signatures:unknown, payload:object, trustRecord:object,
 *   verify:Function}} args
 */
function verifySignatures({ signatures, payload, trustRecord, verify }) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    return result({ ok: false, code: PLUGIN_ERROR_CODES.SIGNATURE_INVALID, reason: 'no_signatures' });
  }

  const verified = [];
  for (const signature of signatures) {
    const outcome = verifyOne(signature, payload, trustRecord, verify);
    if (!outcome.ok) {
      // Fail closed on the FIRST bad signature: "a package presenting one
      // good and one malformed signature is rejected, not partially
      // accepted."
      return outcome;
    }
    verified.push(outcome);
  }

  if (verified.length > 1) {
    const hasActiveKeySignature = verified.some((entry) => !entry.requires_retrust);
    if (!hasActiveKeySignature) {
      return result({
        ok: false,
        code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED,
        reason: 'no_active_key_signature',
        requires_retrust: true,
      });
    }
  }

  const primary = verified[0];
  return result({
    ok: true,
    key_id: primary.key_id,
    algorithm: primary.algorithm,
    requires_retrust: verified.some((entry) => entry.requires_retrust),
  });
}

module.exports = {
  ACCEPTED_ALGORITHMS,
  verifyOne,
  verifySignatures,
};
