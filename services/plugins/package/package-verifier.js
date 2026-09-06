'use strict';

// Ordered, fail-closed archive, metadata, digest, and signature verification.
// `stage` names the last completed step. Digest and crypto operations are
// injected.

const { PLUGIN_ERROR_CODES } = require('../../backend/error-codes');
const {
  createArchiveEntryTracker,
  validateArchiveEntry,
} = require('./archive-entry-validator');
const {
  CANONICAL_METADATA_VERSION,
  isReservedSignaturePath,
  compareUtf8Bytes,
  buildCanonicalPayload,
  computeCanonicalMetadataDigest,
} = require('./canonical-metadata');
const { verifySignatures } = require('./signature-verifier');
const { redactText } = require('../lifecycle/operation-result');
const { PUBLISHER_ID_RE, PLUGIN_ID_RE } = require('../identity/authority-id');
const { isValidDigest } = require('../store/content-store');

// `stage` values are in pipeline order. A failure at step N+1 reports
// STAGES[N], or `start` for the first step.
const STAGES = Object.freeze([
  'archive_validated',
  'reserved_path_checked',
  'manifest_validated',
  'payload_archive_agreement_checked',
  'entry_digests_verified',
  'canonical_metadata_verified',
  'signature_verified',
]);

// DEFAULT_LIMITS bound archive-entry and signed payload-list work.
const DEFAULT_LIMITS = Object.freeze({
  maxEntryCount: 4096,
  maxPayloadListLength: 4096,
});

// Legacy V1/V2 manifests use this default; newer manifest versions pass their
// explicit maxima.
const CONTRACT_VERSION_MAXIMA = Object.freeze({
  manifest_schema_version: 2,
  contribution_contract_version: 2,
  capability_abi_version: 1,
  data_schema_version: 1,
});
const CONTRACT_VERSION_MAXIMA_V3 = Object.freeze({
  manifest_schema_version: 3,
  contribution_contract_version: 3,
  capability_abi_version: 1,
  data_schema_version: 1000000,
});
const CONTRACT_VERSION_MAXIMA_V4 = Object.freeze({
  manifest_schema_version: 4,
  contribution_contract_version: 4,
  capability_abi_version: 1,
  data_schema_version: 1000000,
});
const CONTRACT_VERSION_MAXIMA_V5 = Object.freeze({
  manifest_schema_version: 5,
  contribution_contract_version: 5,
  capability_abi_version: 1,
  data_schema_version: 1000000,
});
const CONTRACT_VERSION_MAXIMA_V6 = Object.freeze({
  manifest_schema_version: 6,
  contribution_contract_version: 6,
  capability_abi_version: 1,
  data_schema_version: 1000000,
});

const CONTRACT_VERSION_KEYS = Object.freeze([
  'package_semver',
  'manifest_schema_version',
  'contribution_contract_version',
  'capability_abi_version',
  'data_schema_version',
]);
const INTEGER_CONTRACT_VERSION_KEYS = Object.freeze(
  CONTRACT_VERSION_KEYS.filter((key) => key !== 'package_semver')
);
const SEMVER_RE = /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Bounds/redacts a path before it is embedded in a verdict's `detail`. Every
// path reaching here has already passed validateArchiveEntry (relative,
// backslash-free, non-absolute), but redactText is still the last line of
// defense against attacker-controlled content leaking into an audit record.
function boundedPath(path) {
  const redacted = redactText(path, { maxBytes: 200 });
  return redacted.ok ? redacted.text : '<unrepresentable path>';
}

// Fixed-length, no-early-exit hex comparison. Digests here are always
// 64-char lowercase hex (both sides validated before this is called), so
// comparing lengths first leaks nothing an attacker does not already know.
function constantTimeHexEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

// A payload list that includes its own signature bundle is a self-reference
// attack (the bundle would sign over its own bytes). This runs BEFORE the
// manifest gate so a forged reference is rejected as an archive problem, not
// dressed up as a manifest-shape problem.
function checkReservedSignaturePaths(declaredPayload) {
  const entries = isPlainObject(declaredPayload) && Array.isArray(declaredPayload.entries)
    ? declaredPayload.entries
    : [];
  for (const entry of entries) {
    const path = entry && typeof entry.path === 'string' ? entry.path : null;
    if (path && isReservedSignaturePath(path)) {
      return { ok: false, reason: 'signed_payload_lists_reserved_signature_path' };
    }
  }
  return { ok: true };
}

// Validate the five signed contract-version axes rather than
// PluginPackageRecordV1 because record-only fields are unavailable until later
// in the pipeline.
function validateContractVersions(contractVersions, maxima = CONTRACT_VERSION_MAXIMA) {
  if (!isPlainObject(contractVersions)) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'contract_versions_not_object' };
  }
  const keys = Object.keys(contractVersions);
  const hasExactKeys = keys.length === CONTRACT_VERSION_KEYS.length
    && CONTRACT_VERSION_KEYS.every((key) => Object.hasOwn(contractVersions, key));
  if (!hasExactKeys) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'contract_versions_keys_mismatch' };
  }
  if (typeof contractVersions.package_semver !== 'string' || !SEMVER_RE.test(contractVersions.package_semver)) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'invalid_package_semver' };
  }
  for (const key of INTEGER_CONTRACT_VERSION_KEYS) {
    const value = contractVersions[key];
    if (!Number.isInteger(value) || value < 1) {
      return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: `invalid_${key}` };
    }
    if (value > maxima[key]) {
      return { ok: false, code: PLUGIN_ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION, reason: `${key}_unsupported` };
    }
  }
  return { ok: true };
}

// Validates declaredPayload's own shape (mirroring what canonical-metadata.js
// requires to build it in the first place -- this module trusts nothing the
// package claims) and every entry in its signed payload list. Reuses
// validateArchiveEntry for path-shape hostility checks and isValidDigest for
// digest shape, rather than re-declaring either check.
function validateDeclaredPayloadShape(declaredPayload, limits, maxima) {
  if (!isPlainObject(declaredPayload)) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'declared_payload_not_object' };
  }
  if (declaredPayload.canonicalization_version !== CANONICAL_METADATA_VERSION) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'canonicalization_version_mismatch' };
  }
  if (typeof declaredPayload.publisher_id !== 'string' || !PUBLISHER_ID_RE.test(declaredPayload.publisher_id)) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'invalid_publisher_id' };
  }
  if (typeof declaredPayload.plugin_id !== 'string' || !PLUGIN_ID_RE.test(declaredPayload.plugin_id)) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'invalid_plugin_id' };
  }
  if (typeof declaredPayload.package_version !== 'string' || declaredPayload.package_version.length === 0) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'invalid_package_version' };
  }
  const contractCheck = validateContractVersions(declaredPayload.contract_versions, maxima);
  if (!contractCheck.ok) return contractCheck;

  if (!Array.isArray(declaredPayload.entries)) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'entries_not_array' };
  }
  if (declaredPayload.entries.length > limits.maxPayloadListLength) {
    return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'payload_list_budget_exceeded' };
  }

  const pathTracker = createArchiveEntryTracker();
  const payloadDigestByPath = new Map();
  for (const entry of declaredPayload.entries) {
    if (!isPlainObject(entry)) {
      return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'payload_entry_not_object' };
    }
    const pathCheck = validateArchiveEntry({ rawPath: entry.path }, pathTracker);
    if (!pathCheck.ok) {
      return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: `payload_path_${pathCheck.reason}` };
    }
    if (!isValidDigest(entry.sha256)) {
      return { ok: false, code: PLUGIN_ERROR_CODES.MANIFEST_INVALID, reason: 'payload_entry_invalid_digest' };
    }
    pathTracker.canonicalPaths.add(pathCheck.canonical_path);
    pathTracker.caseFoldKeys.add(pathCheck.case_fold_key);
    payloadDigestByPath.set(pathCheck.canonical_path, entry.sha256.toLowerCase());
  }

  return { ok: true, payloadDigestByPath };
}

/**
 * Runs the full verification pipeline. See module header for the ordered
 * step list; every step fails closed at its first violation.
 * @param {{
 *   entries: Iterable<{path:string,size?:number,mode?:number,isDirectory?:boolean,isSymlink?:boolean,isHardLink?:boolean,isEncrypted?:boolean}>,
 *   declaredPayload: object,
 *   signatures: unknown[],
 *   trustRecord: {publisher_id:string, keys:Array<object>},
 *   digestOf: (entryPath:string) => Promise<string>,
 *   verify: Function,
 *   archiveDigest: string,
 *   limits?: Partial<typeof DEFAULT_LIMITS>,
 * }} args
 */
async function verifyPackage({
  entries, declaredPayload, signatures, trustRecord, digestOf, verify, archiveDigest,
  limits: limitOverrides, contractVersionMaxima = CONTRACT_VERSION_MAXIMA,
}) {
  const limits = { ...DEFAULT_LIMITS, ...(limitOverrides || {}) };
  const publisherId = isPlainObject(declaredPayload) && typeof declaredPayload.publisher_id === 'string'
    ? declaredPayload.publisher_id : null;
  const pluginId = isPlainObject(declaredPayload) && typeof declaredPayload.plugin_id === 'string'
    ? declaredPayload.plugin_id : null;
  const version = isPlainObject(declaredPayload) && typeof declaredPayload.package_version === 'string'
    ? declaredPayload.package_version : null;

  function verdict({
    ok, stage, code = null, reason = null, detail = null,
    requiresRetrust = false, canonicalMetadataDigest = null, verifiedPathsCount = 0,
    publisherKeyId = null, signatureAlgorithm = null,
  }) {
    return {
      ok,
      code,
      reason,
      stage,
      publisher_id: publisherId,
      plugin_id: pluginId,
      version,
      requires_retrust: requiresRetrust,
      archive_digest: typeof archiveDigest === 'string' ? archiveDigest : null,
      canonical_metadata_digest: canonicalMetadataDigest,
      verified_paths_count: verifiedPathsCount,
      publisher_key_id: publisherKeyId,
      signature_algorithm: signatureAlgorithm,
      detail,
    };
  }

  // --- Step 1: structural/hostile archive validation ------------------------
  // Runs FIRST: never hash or parse metadata from an archive whose entries
  // have not already been proven safe.
  const entryList = Array.from(entries || []);
  if (entryList.length > limits.maxEntryCount) {
    return verdict({ ok: false, stage: 'start', code: PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, reason: 'entry_count_budget_exceeded' });
  }
  const tracker = createArchiveEntryTracker();
  const archiveEntries = [];
  for (const raw of entryList) {
    const validated = validateArchiveEntry({
      rawPath: raw && raw.path,
      isSymlinkOrReparsePoint: Boolean(raw && (raw.isSymlink || raw.isSymlinkOrReparsePoint)),
      isHardLink: Boolean(raw && raw.isHardLink),
      isEncrypted: Boolean(raw && raw.isEncrypted),
    }, tracker);
    if (!validated.ok) {
      return verdict({ ok: false, stage: 'start', code: PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, reason: validated.reason });
    }
    tracker.canonicalPaths.add(validated.canonical_path);
    tracker.caseFoldKeys.add(validated.case_fold_key);
    archiveEntries.push({ canonicalPath: validated.canonical_path, isDirectory: Boolean(raw && raw.isDirectory) });
  }

  // --- Step 2: reserved signature-bundle path must be outside the signed list
  const reservedCheck = checkReservedSignaturePaths(declaredPayload);
  if (!reservedCheck.ok) {
    return verdict({ ok: false, stage: STAGES[0], code: PLUGIN_ERROR_CODES.ARCHIVE_REJECTED, reason: reservedCheck.reason });
  }

  // --- Step 3: manifest / contract-version gate -----------------------------
  const manifestCheck = validateDeclaredPayloadShape(declaredPayload, limits, contractVersionMaxima);
  if (!manifestCheck.ok) {
    return verdict({ ok: false, stage: STAGES[1], code: manifestCheck.code, reason: manifestCheck.reason });
  }
  const { payloadDigestByPath } = manifestCheck;

  // --- Step 4: payload-list <-> archive-entry agreement, both directions ----
  const archiveContentPaths = archiveEntries.filter((entry) => !entry.isDirectory).map((entry) => entry.canonicalPath);
  const archiveComparablePaths = archiveContentPaths.filter((path) => !isReservedSignaturePath(path));
  const sortedArchive = [...archiveComparablePaths].sort(compareUtf8Bytes);
  const sortedPayload = [...payloadDigestByPath.keys()].sort(compareUtf8Bytes);
  const archiveSet = new Set(sortedArchive);
  const payloadSet = new Set(sortedPayload);

  for (const path of sortedPayload) {
    if (!archiveSet.has(path)) {
      return verdict({
        ok: false, stage: STAGES[2], code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED,
        reason: 'signed_path_missing_from_archive', detail: boundedPath(path),
      });
    }
  }
  for (const path of sortedArchive) {
    if (!payloadSet.has(path)) {
      return verdict({
        ok: false, stage: STAGES[2], code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED,
        reason: 'unsigned_archive_entry_present', detail: boundedPath(path),
      });
    }
  }

  // --- Step 5: per-entry digest verification --------------------------------
  const verifiedDigests = new Map();
  for (const path of sortedPayload) {
    const declaredHex = payloadDigestByPath.get(path);
    let actualHex;
    try {
      actualHex = await digestOf(path);
    } catch (error) {
      void error;
      return verdict({
        ok: false, stage: STAGES[3], code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED,
        reason: 'digest_computation_failed', detail: boundedPath(path),
      });
    }
    const normalizedActual = typeof actualHex === 'string' ? actualHex.toLowerCase() : null;
    if (!normalizedActual || !constantTimeHexEqual(normalizedActual, declaredHex)) {
      return verdict({
        ok: false, stage: STAGES[3], code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED,
        reason: 'entry_digest_mismatch', detail: boundedPath(path),
      });
    }
    verifiedDigests.set(path, normalizedActual);
  }

  // --- Step 6: canonical metadata digest recomputation ----------------------
  // Rebuilds the canonical payload from the REAL, freshly-measured digests
  // (not the package's claimed ones) plus declaredPayload's own identity/
  // contract-version fields, then compares its digest to declaredPayload's.
  // A mismatch here catches a declaredPayload that isn't actually the exact
  // canonical serialization the signature was computed over (e.g. entries
  // reordered/duplicated in a way step 4's set comparison would not by
  // itself expose), which per-path digest checks alone cannot see.
  const rebuiltEntries = sortedPayload.map((path) => ({ canonicalPath: path, sha256Hex: verifiedDigests.get(path) }));
  const rebuilt = buildCanonicalPayload({
    publisherId: declaredPayload.publisher_id,
    pluginId: declaredPayload.plugin_id,
    packageVersion: declaredPayload.package_version,
    contractVersions: declaredPayload.contract_versions,
    payloadEntries: rebuiltEntries,
  });
  if (!rebuilt.ok) {
    return verdict({ ok: false, stage: STAGES[4], code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED, reason: `canonical_rebuild_${rebuilt.code}` });
  }
  const canonicalMetadataDigest = computeCanonicalMetadataDigest(rebuilt.payload);
  const declaredDigest = computeCanonicalMetadataDigest(declaredPayload);
  if (canonicalMetadataDigest !== declaredDigest) {
    return verdict({ ok: false, stage: STAGES[4], code: PLUGIN_ERROR_CODES.INTEGRITY_FAILED, reason: 'canonical_metadata_digest_mismatch' });
  }

  // --- Step 7: signature verification ---------------------------------------
  const signatureResult = verifySignatures({ signatures, payload: declaredPayload, trustRecord, verify });
  if (!signatureResult.ok) {
    return verdict({
      ok: false,
      stage: STAGES[5],
      code: signatureResult.code,
      reason: signatureResult.reason,
      canonicalMetadataDigest,
      verifiedPathsCount: sortedPayload.length,
    });
  }

  // --- Step 8: verdict. archiveDigest is recorded separately from the signed
  // payload list, exactly as the architecture requires. -----------------------
  return verdict({
    ok: true,
    stage: STAGES[6],
    requiresRetrust: signatureResult.requires_retrust,
    canonicalMetadataDigest,
    verifiedPathsCount: sortedPayload.length,
    publisherKeyId: signatureResult.key_id,
    signatureAlgorithm: signatureResult.algorithm,
  });
}

module.exports = {
  STAGES,
  DEFAULT_LIMITS,
  CONTRACT_VERSION_MAXIMA,
  CONTRACT_VERSION_MAXIMA_V3,
  CONTRACT_VERSION_MAXIMA_V4,
  CONTRACT_VERSION_MAXIMA_V5,
  CONTRACT_VERSION_MAXIMA_V6,
  verifyPackage,
};
