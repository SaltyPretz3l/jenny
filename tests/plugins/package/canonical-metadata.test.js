'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_METADATA_VERSION,
  SIGNATURE_BUNDLE_PATH,
  isReservedSignaturePath,
  compareUtf8Bytes,
  buildCanonicalPayload,
  stableStringify,
  serializeCanonicalPayload,
  computeCanonicalMetadataDigest,
} = require('../../../services/plugins/package/canonical-metadata.js');

const CONTRACT_VERSIONS = {
  package_semver: '1.0.0',
  manifest_schema_version: 1,
  contribution_contract_version: 1,
  capability_abi_version: 1,
  data_schema_version: 1,
};

function baseArgs(overrides = {}) {
  return {
    publisherId: 'acme-labs',
    pluginId: 'widgets',
    packageVersion: '1.0.0',
    contractVersions: CONTRACT_VERSIONS,
    payloadEntries: [],
    ...overrides,
  };
}

test('buildCanonicalPayload stamps the Jenny-chosen canonicalization version', () => {
  const result = buildCanonicalPayload(baseArgs());
  assert.equal(result.ok, true);
  assert.equal(result.payload.canonicalization_version, CANONICAL_METADATA_VERSION);
});

test('buildCanonicalPayload byte-sorts entries, not by JS UTF-16 code-unit order', () => {
  // U+FFFF encodes to UTF-8 bytes EF BF BF; a supplementary-plane character
  // like U+10000 encodes to F0 90 80 80. EF < F0, so U+FFFF sorts FIRST in
  // true UTF-8 byte order. But U+10000 is stored as a UTF-16 surrogate pair
  // starting with the high surrogate 0xD800, and 0xD800 < 0xFFFF as a raw
  // code unit, so naive JS string comparison (`a < b`) puts the
  // supplementary character FIRST instead — the opposite order. This proves
  // the sort really compares UTF-8 bytes rather than falling back to JS's
  // default ordinal string comparison.
  const bmpEdge = '￿';
  const supplementary = '\u{10000}';
  assert.equal(bmpEdge < supplementary, false, 'test fixture assumption: JS ordinal order disagrees with byte order');
  const entries = [
    { canonicalPath: supplementary, sha256Hex: 'a'.repeat(64) },
    { canonicalPath: bmpEdge, sha256Hex: 'b'.repeat(64) },
  ];
  const result = buildCanonicalPayload(baseArgs({ payloadEntries: entries }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.entries.map((e) => e.path), [bmpEdge, supplementary]);
});

test('compareUtf8Bytes agrees with Buffer.compare on UTF-8 bytes', () => {
  assert.ok(compareUtf8Bytes('￿', '\u{10000}') < 0);
  assert.ok(compareUtf8Bytes('a', 'b') < 0);
  assert.equal(compareUtf8Bytes('same', 'same'), 0);
});

test('buildCanonicalPayload excludes the reserved signature-bundle path from the hashed entry list', () => {
  const entries = [
    { canonicalPath: 'plugin.json', sha256Hex: 'a'.repeat(64) },
    { canonicalPath: SIGNATURE_BUNDLE_PATH, sha256Hex: 'b'.repeat(64) },
  ];
  const result = buildCanonicalPayload(baseArgs({ payloadEntries: entries }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload.entries.map((e) => e.path), ['plugin.json']);
  assert.deepEqual(result.excludedSignaturePaths, [SIGNATURE_BUNDLE_PATH]);
});

test('isReservedSignaturePath matches the reserved path and its directory prefix', () => {
  assert.equal(isReservedSignaturePath(SIGNATURE_BUNDLE_PATH), true);
  assert.equal(isReservedSignaturePath('META-JENNY/signature/cert.pem'), true);
  assert.equal(isReservedSignaturePath('plugin.json'), false);
});

test('buildCanonicalPayload rejects a non-NFC-normalized entry path', () => {
  const decomposed = `cafe${String.fromCodePoint(0x0301)}.txt`;
  const result = buildCanonicalPayload(baseArgs({
    payloadEntries: [{ canonicalPath: decomposed, sha256Hex: 'a'.repeat(64) }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'entry_path_not_nfc_normalized');
});

test('buildCanonicalPayload rejects a malformed sha256 digest', () => {
  const result = buildCanonicalPayload(baseArgs({
    payloadEntries: [{ canonicalPath: 'a.txt', sha256Hex: 'not-hex' }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_entry_digest');
});

test('buildCanonicalPayload rejects a duplicate canonical path', () => {
  const result = buildCanonicalPayload(baseArgs({
    payloadEntries: [
      { canonicalPath: 'a.txt', sha256Hex: 'a'.repeat(64) },
      { canonicalPath: 'a.txt', sha256Hex: 'a'.repeat(64) },
    ],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'duplicate_entry_path');
});

test('buildCanonicalPayload rejects invalid top-level identity fields', () => {
  assert.equal(buildCanonicalPayload(baseArgs({ publisherId: '' })).code, 'invalid_publisher_id');
  assert.equal(buildCanonicalPayload(baseArgs({ pluginId: '' })).code, 'invalid_plugin_id');
  assert.equal(buildCanonicalPayload(baseArgs({ packageVersion: '' })).code, 'invalid_package_version');
  assert.equal(buildCanonicalPayload(baseArgs({ contractVersions: {} })).code, 'invalid_contract_versions');
});

test('stableStringify sorts object keys recursively regardless of insertion order', () => {
  const a = { z: 1, a: { d: 1, b: 2 } };
  const b = { a: { b: 2, d: 1 }, z: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
});

test('serializeCanonicalPayload returns a UTF-8 Buffer', () => {
  const result = buildCanonicalPayload(baseArgs());
  const serialized = serializeCanonicalPayload(result.payload);
  assert.ok(Buffer.isBuffer(serialized));
  assert.ok(serialized.length > 0);
});

test('computeCanonicalMetadataDigest is deterministic for the same payload', () => {
  const result = buildCanonicalPayload(baseArgs());
  const digestA = computeCanonicalMetadataDigest(result.payload);
  const digestB = computeCanonicalMetadataDigest(result.payload);
  assert.equal(digestA, digestB);
  assert.match(digestA, /^[0-9a-f]{64}$/);
});

test('computeCanonicalMetadataDigest differs when the entry list differs', () => {
  const resultA = buildCanonicalPayload(baseArgs({
    payloadEntries: [{ canonicalPath: 'a.txt', sha256Hex: 'a'.repeat(64) }],
  }));
  const resultB = buildCanonicalPayload(baseArgs({
    payloadEntries: [{ canonicalPath: 'a.txt', sha256Hex: 'b'.repeat(64) }],
  }));
  assert.notEqual(
    computeCanonicalMetadataDigest(resultA.payload),
    computeCanonicalMetadataDigest(resultB.payload),
  );
});
