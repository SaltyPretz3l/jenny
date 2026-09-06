'use strict';

// Builds the canonical signed-metadata payload described in
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md, "Package, identity, and
// storage": "Canonical signed metadata binds stable publisher identity,
// plugin_id, package version, contract versions, and a UTF-8-NFC, byte-sorted
// list of normalized payload paths and SHA-256 digests. The signature bundle
// is outside that payload list to avoid self-reference; the final ZIP digest
// is recorded separately. Jenny chooses the accepted signature algorithms and
// canonicalization version rather than trusting package-selected algorithms."
//
// This module does not read a filesystem or compute file digests itself: it
// takes an already-digested entry list (canonical path + sha256 hex, as
// produced by archive-entry-validator.js plus a caller-owned hashing step)
// and assembles/sorts/serializes the canonical payload deterministically.
// Hashing the assembled canonical payload uses node:crypto, which is a pure,
// hermetic computation (no fs/net/child_process/ambient clock).

const { createHash } = require('node:crypto');

// Jenny-chosen canonicalization version, stamped explicitly on every
// assembled payload so a future revision to the canonicalization algorithm
// (sort order, serialization form, exclusion rules) never silently
// reinterprets an older signed payload under new rules.
const CANONICAL_METADATA_VERSION = 1;

// Reserved location for the signature bundle within package payload paths.
// Any entry at this path, or nested under this reserved directory, is
// excluded from the hashed entry list to avoid the bundle signing over its
// own bytes (self-reference).
const SIGNATURE_BUNDLE_PATH = 'META-JENNY/signature-bundle.json';
const SIGNATURE_BUNDLE_DIR_PREFIX = 'META-JENNY/signature/';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * @param {string} canonicalPath
 */
function isReservedSignaturePath(canonicalPath) {
  return canonicalPath === SIGNATURE_BUNDLE_PATH || canonicalPath.startsWith(SIGNATURE_BUNDLE_DIR_PREFIX);
}

/**
 * Byte-wise (UTF-8) comparator, as opposed to JS's default UTF-16 code-unit
 * string comparison. For characters outside the Basic Multilingual Plane
 * (surrogate pairs) the two orders can diverge, and the architecture is
 * explicit that the canonical list is "byte-sorted", so sorting must compare
 * actual UTF-8 bytes rather than JS string ordinals.
 * @param {string} a
 * @param {string} b
 */
function compareUtf8Bytes(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * @param {{contractVersions:Record<string,unknown>}} args
 */
function isValidContractVersions(contractVersions) {
  if (contractVersions === null || typeof contractVersions !== 'object') return false;
  const required = [
    'package_semver',
    'manifest_schema_version',
    'contribution_contract_version',
    'capability_abi_version',
    'data_schema_version',
  ];
  return required.every((key) => Object.hasOwn(contractVersions, key));
}

/**
 * Assembles the canonical signed-metadata payload from an already-digested
 * entry list. Every input is treated as hostile: malformed entries fail
 * closed with a structured reason rather than being silently coerced.
 * @param {{
 *   publisherId: string,
 *   pluginId: string,
 *   packageVersion: string,
 *   contractVersions: Record<string, unknown>,
 *   payloadEntries: Array<{canonicalPath: string, sha256Hex: string}>,
 * }} args
 * @returns {{ok:true,payload:object,excludedSignaturePaths:string[]}
 *          |{ok:false,code:string,path?:string}}
 */
function buildCanonicalPayload({ publisherId, pluginId, packageVersion, contractVersions, payloadEntries }) {
  if (typeof publisherId !== 'string' || publisherId.length === 0) {
    return { ok: false, code: 'invalid_publisher_id' };
  }
  if (typeof pluginId !== 'string' || pluginId.length === 0) {
    return { ok: false, code: 'invalid_plugin_id' };
  }
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    return { ok: false, code: 'invalid_package_version' };
  }
  if (!isValidContractVersions(contractVersions)) {
    return { ok: false, code: 'invalid_contract_versions' };
  }
  if (!Array.isArray(payloadEntries)) {
    return { ok: false, code: 'invalid_payload_entries' };
  }

  const excludedSignaturePaths = [];
  const includedEntries = [];
  const seenCanonicalPaths = new Set();

  for (const entry of payloadEntries) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, code: 'invalid_payload_entry' };
    }
    const { canonicalPath, sha256Hex } = entry;
    if (typeof canonicalPath !== 'string' || canonicalPath.length === 0) {
      return { ok: false, code: 'invalid_entry_path' };
    }
    if (canonicalPath.normalize('NFC') !== canonicalPath) {
      return { ok: false, code: 'entry_path_not_nfc_normalized', path: canonicalPath };
    }
    if (typeof sha256Hex !== 'string' || !SHA256_HEX_RE.test(sha256Hex)) {
      return { ok: false, code: 'invalid_entry_digest', path: canonicalPath };
    }
    if (isReservedSignaturePath(canonicalPath)) {
      excludedSignaturePaths.push(canonicalPath);
      continue;
    }
    if (seenCanonicalPaths.has(canonicalPath)) {
      return { ok: false, code: 'duplicate_entry_path', path: canonicalPath };
    }
    seenCanonicalPaths.add(canonicalPath);
    includedEntries.push({ path: canonicalPath, sha256: sha256Hex });
  }

  includedEntries.sort((a, b) => compareUtf8Bytes(a.path, b.path));

  const payload = {
    canonicalization_version: CANONICAL_METADATA_VERSION,
    publisher_id: publisherId,
    plugin_id: pluginId,
    package_version: packageVersion,
    contract_versions: { ...contractVersions },
    entries: includedEntries,
  };

  return { ok: true, payload, excludedSignaturePaths };
}

/**
 * Deterministic canonical JSON serialization: object keys are recursively
 * sorted (arrays keep their given order, since `entries` is already
 * byte-sorted above), with no incidental whitespace, so the same logical
 * payload always serializes to the same bytes for hashing/signing.
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * @param {object} payload
 * @returns {Buffer} the canonical UTF-8 bytes that get hashed/signed.
 */
function serializeCanonicalPayload(payload) {
  return Buffer.from(stableStringify(payload), 'utf8');
}

/**
 * @param {object} payload
 * @returns {string} lowercase hex SHA-256 of the canonical serialization.
 */
function computeCanonicalMetadataDigest(payload) {
  return createHash('sha256').update(serializeCanonicalPayload(payload)).digest('hex');
}

module.exports = {
  CANONICAL_METADATA_VERSION,
  SIGNATURE_BUNDLE_PATH,
  SIGNATURE_BUNDLE_DIR_PREFIX,
  isReservedSignaturePath,
  compareUtf8Bytes,
  buildCanonicalPayload,
  stableStringify,
  serializeCanonicalPayload,
  computeCanonicalMetadataDigest,
};
