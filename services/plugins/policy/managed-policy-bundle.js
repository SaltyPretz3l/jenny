'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../package/canonical-metadata');

const MAX_BUNDLE_BYTES = 256 * 1024;
const MAX_ARRAY_ITEMS = 32;
const MAX_VALIDITY_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SOURCE_KINDS = new Set([
  'local_package', 'https_url', 'git', 'signed_catalog', 'offline_mirror',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validTimestamp(value) {
  return typeof value === 'string' && value.length <= 40
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validIdArray(value, pattern = ID_RE) {
  return Array.isArray(value) && value.length <= MAX_ARRAY_ITEMS
    && new Set(value).size === value.length
    && value.every((item) => typeof item === 'string' && pattern.test(item));
}

function validatePolicy(policy, nowMs) {
  if (!exactKeys(policy, [
    'policy_schema_version', 'revision', 'issued_at', 'expires_at',
    'privileged_execution', 'installation', 'update_ring', 'allowed_source_kinds',
    'allowed_publishers', 'procurement', 'audit_max_entries',
    'managed_source_fingerprints',
  ])) return 'managed_policy_payload_malformed';
  if (policy.policy_schema_version !== 1) return 'managed_policy_version_unsupported';
  if (!Number.isSafeInteger(policy.revision) || policy.revision < 1) {
    return 'managed_policy_revision_invalid';
  }
  if (!validTimestamp(policy.issued_at) || !validTimestamp(policy.expires_at)) {
    return 'managed_policy_freshness_invalid';
  }
  const issued = Date.parse(policy.issued_at);
  const expires = Date.parse(policy.expires_at);
  if (issued > nowMs + MAX_FUTURE_SKEW_MS || expires <= nowMs
    || expires <= issued || expires - issued > MAX_VALIDITY_MS) {
    return 'managed_policy_stale';
  }
  if (!['allow', 'deny'].includes(policy.privileged_execution)
    || !['allow_inactive', 'deny'].includes(policy.installation)
    || !['stable', 'preview', 'frozen'].includes(policy.update_ring)) {
    return 'managed_policy_posture_invalid';
  }
  if (!Array.isArray(policy.allowed_source_kinds) || policy.allowed_source_kinds.length > MAX_ARRAY_ITEMS
    || new Set(policy.allowed_source_kinds).size !== policy.allowed_source_kinds.length
    || policy.allowed_source_kinds.some((item) => !SOURCE_KINDS.has(item))) {
    return 'managed_policy_sources_invalid';
  }
  if (!validIdArray(policy.allowed_publishers)) return 'managed_policy_publishers_invalid';
  if (!exactKeys(policy.procurement, ['require_sbom', 'require_build_provenance'])
    || typeof policy.procurement.require_sbom !== 'boolean'
    || typeof policy.procurement.require_build_provenance !== 'boolean') {
    return 'managed_policy_procurement_invalid';
  }
  if (!Number.isSafeInteger(policy.audit_max_entries)
    || policy.audit_max_entries < 1 || policy.audit_max_entries > 1000) {
    return 'managed_policy_audit_bound_invalid';
  }
  if (!validIdArray(policy.managed_source_fingerprints, DIGEST_RE)) {
    return 'managed_policy_source_fingerprints_invalid';
  }
  return null;
}

function verifyManagedPolicyBundle(bytes, { now = () => new Date().toISOString() } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_BUNDLE_BYTES) {
    return { ok: false, reason: 'managed_policy_bundle_size_invalid' };
  }
  let bundle;
  try { bundle = JSON.parse(bytes.toString('utf8')); }
  catch (_error) { return { ok: false, reason: 'managed_policy_bundle_malformed' }; }
  if (!exactKeys(bundle, ['managed_policy_bundle_version', 'policy', 'signature'])) {
    return { ok: false, reason: 'managed_policy_bundle_malformed' };
  }
  if (bundle.managed_policy_bundle_version !== 1) {
    return { ok: false, reason: 'managed_policy_bundle_version_unsupported' };
  }
  const nowMs = Date.parse(now());
  if (!Number.isFinite(nowMs)) return { ok: false, reason: 'managed_policy_clock_invalid' };
  const policyError = validatePolicy(bundle.policy, nowMs);
  if (policyError) return { ok: false, reason: policyError };
  const signature = bundle.signature;
  if (!exactKeys(signature, [
    'algorithm', 'key_id', 'public_key_spki_base64', 'signature_base64',
  ]) || signature.algorithm !== 'ed25519' || !DIGEST_RE.test(String(signature.key_id || ''))
    || typeof signature.public_key_spki_base64 !== 'string'
    || typeof signature.signature_base64 !== 'string') {
    return { ok: false, reason: 'managed_policy_signature_malformed' };
  }
  let publicBytes;
  let signatureBytes;
  try {
    publicBytes = Buffer.from(signature.public_key_spki_base64, 'base64');
    signatureBytes = Buffer.from(signature.signature_base64, 'base64');
  } catch (_error) {
    return { ok: false, reason: 'managed_policy_signature_malformed' };
  }
  if (publicBytes.length < 32 || publicBytes.length > 256 || signatureBytes.length !== 64
    || sha256(publicBytes) !== signature.key_id) {
    return { ok: false, reason: 'managed_policy_key_binding_invalid' };
  }
  const canonical = Buffer.from(stableStringify(bundle.policy), 'utf8');
  let verified;
  try {
    const key = crypto.createPublicKey({ key: publicBytes, format: 'der', type: 'spki' });
    verified = key.asymmetricKeyType === 'ed25519'
      && crypto.verify(null, canonical, key, signatureBytes);
  } catch (_error) { verified = false; }
  if (!verified) return { ok: false, reason: 'managed_policy_signature_invalid' };
  return {
    ok: true,
    policy: Object.freeze({ ...bundle.policy,
      procurement: Object.freeze({ ...bundle.policy.procurement }),
      allowed_source_kinds: Object.freeze([...bundle.policy.allowed_source_kinds]),
      allowed_publishers: Object.freeze([...bundle.policy.allowed_publishers]),
      managed_source_fingerprints: Object.freeze([...bundle.policy.managed_source_fingerprints]),
    }),
    policy_digest: sha256(canonical),
    key_id: signature.key_id,
  };
}

module.exports = {
  validatePolicy,
  verifyManagedPolicyBundle,
};
