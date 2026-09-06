'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { PLUGIN_ERROR_CODES } = require('../../../services/backend/error-codes');
const {
  buildCanonicalPayload,
  computeCanonicalMetadataDigest,
} = require('../../../services/plugins/package/canonical-metadata');
const { STAGES, verifyPackage } = require('../../../services/plugins/package/package-verifier.js');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const CONTRACT_VERSIONS = Object.freeze({
  package_semver: '1.0.0',
  manifest_schema_version: 1,
  contribution_contract_version: 1,
  capability_abi_version: 1,
  data_schema_version: 1,
});

// Two files, deliberately chosen so their canonical (UTF-8 byte) sort order is
// well known: 'a-first.json' sorts before 'z-second.json'.
const FILES = Object.freeze({
  'a-first.json': 'first-file-bytes',
  'z-second.json': 'second-file-bytes',
});
const DIGESTS = Object.fromEntries(Object.entries(FILES).map(([path, bytes]) => [path, sha256Hex(bytes)]));
const ARCHIVE_DIGEST = sha256Hex('whole-zip-bytes');

function makeArchiveEntries(paths = Object.keys(FILES)) {
  return paths.map((path) => ({ path, size: FILES[path].length, mode: 0o644, isDirectory: false }));
}

function makeDigestOf(overrides = {}) {
  return async (path) => (Object.hasOwn(overrides, path) ? overrides[path] : DIGESTS[path]);
}

// Builds a LEGITIMATE declaredPayload the same way a real signer would: via
// canonical-metadata.js's own buildCanonicalPayload, so entries are already
// byte-sorted and the shape matches exactly what verifyPackage expects.
function makeDeclaredPayload({
  entryPaths = Object.keys(FILES),
  digestOverrides = {},
  packageVersion = '1.0.0',
} = {}) {
  const payloadEntries = entryPaths.map((path) => ({
    canonicalPath: path,
    sha256Hex: Object.hasOwn(digestOverrides, path) ? digestOverrides[path] : DIGESTS[path],
  }));
  const built = buildCanonicalPayload({
    publisherId: 'acme-labs',
    pluginId: 'widgets',
    packageVersion,
    contractVersions: { ...CONTRACT_VERSIONS, package_semver: packageVersion },
    payloadEntries,
  });
  assert.equal(built.ok, true, 'test fixture must build a valid canonical payload');
  return built.payload;
}

function makeTrustRecord(overrides = {}) {
  return {
    publisher_id: 'acme-labs',
    keys: [
      { key_id: 'key-active', public_key: 'pub-active', algorithm: 'ed25519', status: 'active' },
      { key_id: 'key-rotated', public_key: 'pub-rotated', algorithm: 'ed25519', status: 'rotated' },
    ],
    ...overrides,
  };
}

function makeSignature(overrides = {}) {
  return {
    algorithm: 'ed25519',
    key_id: 'key-active',
    canonicalization_version: 1,
    signature: 'sig-bytes',
    ...overrides,
  };
}

function alwaysVerify(returnValue = true) {
  return () => returnValue;
}

function baseArgs(overrides = {}) {
  return {
    entries: makeArchiveEntries(),
    declaredPayload: makeDeclaredPayload(),
    signatures: [makeSignature()],
    trustRecord: makeTrustRecord(),
    digestOf: makeDigestOf(),
    verify: alwaysVerify(true),
    archiveDigest: ARCHIVE_DIGEST,
    ...overrides,
  };
}

test('STAGES has exactly one name per pipeline step, in order', () => {
  assert.deepEqual(STAGES, [
    'archive_validated',
    'reserved_path_checked',
    'manifest_validated',
    'payload_archive_agreement_checked',
    'entry_digests_verified',
    'canonical_metadata_verified',
    'signature_verified',
  ]);
});

test('verifyPackage: full happy path verifies and reports the terminal stage', async () => {
  const declaredPayload = makeDeclaredPayload();
  const result = await verifyPackage(baseArgs({ declaredPayload }));
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'signature_verified');
  assert.equal(result.code, null);
  assert.equal(result.requires_retrust, false);
  assert.equal(result.publisher_id, 'acme-labs');
  assert.equal(result.plugin_id, 'widgets');
  assert.equal(result.version, '1.0.0');
  assert.equal(result.archive_digest, ARCHIVE_DIGEST);
  assert.equal(result.canonical_metadata_digest, computeCanonicalMetadataDigest(declaredPayload));
  assert.equal(result.verified_paths_count, Object.keys(FILES).length);
});

test('verifyPackage: prerelease and build package semver reaches signature verification', async () => {
  const declaredPayload = makeDeclaredPayload({ packageVersion: '1.2.3-rc.1+build.5' });
  const result = await verifyPackage(baseArgs({ declaredPayload }));

  assert.equal(result.ok, true);
  assert.equal(result.stage, 'signature_verified');
  assert.equal(result.version, '1.2.3-rc.1+build.5');
});

test('verifyPackage: a hostile archive entry is rejected at the very first step (stage "start")', async () => {
  const result = await verifyPackage(baseArgs({
    entries: [{ path: '../escape.json', isDirectory: false }],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.ARCHIVE_REJECTED);
  assert.equal(result.stage, 'start');
});

test('verifyPackage: a signed payload list that references its own reserved signature-bundle path is rejected as a self-reference', async () => {
  const declaredPayload = makeDeclaredPayload();
  const tampered = { ...declaredPayload, entries: [...declaredPayload.entries, { path: 'META-JENNY/signature-bundle.json', sha256: 'a'.repeat(64) }] };
  const result = await verifyPackage(baseArgs({ declaredPayload: tampered }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.ARCHIVE_REJECTED);
  assert.equal(result.stage, STAGES[0]);
  assert.equal(result.reason, 'signed_payload_lists_reserved_signature_path');
});

test('verifyPackage: contract_versions missing a required axis is MANIFEST_INVALID at the manifest gate', async () => {
  const declaredPayload = makeDeclaredPayload();
  const { data_schema_version: _drop, ...incomplete } = declaredPayload.contract_versions;
  const tampered = { ...declaredPayload, contract_versions: incomplete };
  const result = await verifyPackage(baseArgs({ declaredPayload: tampered }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  assert.equal(result.stage, STAGES[1]);
});

test('verifyPackage: a contract-version axis newer than Jenny understands is UNSUPPORTED_CONTRACT_VERSION, not MANIFEST_INVALID', async () => {
  const declaredPayload = makeDeclaredPayload();
  const tampered = {
    ...declaredPayload,
    contract_versions: { ...declaredPayload.contract_versions, capability_abi_version: 2 },
  };
  const result = await verifyPackage(baseArgs({ declaredPayload: tampered }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.UNSUPPORTED_CONTRACT_VERSION);
  assert.equal(result.stage, STAGES[1]);
});

test('verifyPackage: a signed-list entry absent from the archive is INTEGRITY_FAILED (both directions, direction 1)', async () => {
  const declaredPayload = makeDeclaredPayload({ entryPaths: ['a-first.json', 'z-second.json', 'ghost.json'], digestOverrides: { 'ghost.json': 'f'.repeat(64) } });
  const result = await verifyPackage(baseArgs({ declaredPayload }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
  assert.equal(result.reason, 'signed_path_missing_from_archive');
  assert.equal(result.stage, STAGES[2]);
});

test('verifyPackage: an archive entry absent from the signed list is unsigned content riding along, INTEGRITY_FAILED (direction 2)', async () => {
  const declaredPayload = makeDeclaredPayload({ entryPaths: ['a-first.json'] });
  const entries = makeArchiveEntries(['a-first.json', 'z-second.json']);
  const result = await verifyPackage(baseArgs({ declaredPayload, entries }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
  assert.equal(result.reason, 'unsigned_archive_entry_present');
  assert.equal(result.stage, STAGES[2]);
});

test('verifyPackage: a per-entry digest mismatch is INTEGRITY_FAILED and names the offending path', async () => {
  const digestOf = makeDigestOf({ 'z-second.json': 'b'.repeat(64) });
  const result = await verifyPackage(baseArgs({ digestOf }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
  assert.equal(result.reason, 'entry_digest_mismatch');
  assert.equal(result.stage, STAGES[3]);
  assert.equal(result.detail, 'z-second.json');
});

test('verifyPackage: a declaredPayload whose entries are NOT canonically (byte-)sorted fails the canonical-metadata self-consistency check, even though it lists the exact right set of paths+digests', async () => {
  const declaredPayload = makeDeclaredPayload();
  assert.ok(declaredPayload.entries.length > 1, 'fixture needs 2+ entries to exercise ordering');
  const reordered = { ...declaredPayload, entries: [...declaredPayload.entries].reverse() };
  const result = await verifyPackage(baseArgs({ declaredPayload: reordered }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
  assert.equal(result.reason, 'canonical_metadata_digest_mismatch');
  assert.equal(result.stage, STAGES[4]);
});

test('verifyPackage: a signature over a different canonicalization version fails at the signature stage', async () => {
  const result = await verifyPackage(baseArgs({
    signatures: [makeSignature({ canonicalization_version: 2 })],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  assert.equal(result.stage, STAGES[5]);
});

test('verifyPackage: algorithm "none" and an unknown algorithm both fail at the signature stage', async () => {
  for (const algorithm of ['none', 'rsa-4096']) {
    const result = await verifyPackage(baseArgs({ signatures: [makeSignature({ algorithm })] }));
    assert.equal(result.ok, false, `expected rejection for algorithm ${algorithm}`);
    assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
    assert.equal(result.stage, STAGES[5]);
  }
});

test('verifyPackage: a revoked key is rejected as PUBLISHER_UNTRUSTED and verify() is never called', async () => {
  let calls = 0;
  const verify = () => { calls += 1; return true; };
  const trustRecord = makeTrustRecord({
    keys: [{ key_id: 'key-revoked', public_key: 'pub', algorithm: 'ed25519', status: 'revoked' }],
  });
  const result = await verifyPackage(baseArgs({
    signatures: [makeSignature({ key_id: 'key-revoked' })],
    trustRecord,
    verify,
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  assert.equal(result.stage, STAGES[5]);
  assert.equal(calls, 0);
});

test('verifyPackage: a rotated key verifies with requires_retrust true, reaching the terminal stage', async () => {
  const result = await verifyPackage(baseArgs({ signatures: [makeSignature({ key_id: 'key-rotated' })] }));
  assert.equal(result.ok, true);
  assert.equal(result.stage, STAGES[6]);
  assert.equal(result.requires_retrust, true);
});

test('verifyPackage: a publisher_id mismatch between trust record and signed metadata is PUBLISHER_UNTRUSTED', async () => {
  const result = await verifyPackage(baseArgs({ trustRecord: makeTrustRecord({ publisher_id: 'someone-else' }) }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED);
  assert.equal(result.stage, STAGES[5]);
});

test('verifyPackage: two signatures, one good and one malformed, reject the whole package (no partial accept)', async () => {
  const result = await verifyPackage(baseArgs({
    signatures: [makeSignature({ key_id: 'key-active' }), makeSignature({ algorithm: 'none' })],
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.SIGNATURE_INVALID);
  assert.equal(result.stage, STAGES[5]);
});

test('verifyPackage: every verdict (success or failure) carries the full result shape', async () => {
  const okResult = await verifyPackage(baseArgs());
  const failResult = await verifyPackage(baseArgs({ entries: [{ path: '../escape' }] }));
  const expectedKeys = [
    'ok', 'code', 'reason', 'stage', 'publisher_id', 'plugin_id', 'version',
    'requires_retrust', 'archive_digest', 'canonical_metadata_digest',
    'verified_paths_count', 'publisher_key_id', 'signature_algorithm', 'detail',
  ].sort();
  assert.deepEqual(Object.keys(okResult).sort(), expectedKeys);
  assert.deepEqual(Object.keys(failResult).sort(), expectedKeys);
});

// --- Budgets -----------------------------------------------------------------

test('verifyPackage: an archive with more entries than maxEntryCount is rejected before any entry is even inspected', async () => {
  const result = await verifyPackage(baseArgs({ limits: { maxEntryCount: 1 } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.ARCHIVE_REJECTED);
  assert.equal(result.reason, 'entry_count_budget_exceeded');
  assert.equal(result.stage, 'start');
});

test('verifyPackage: a signed payload list longer than maxPayloadListLength is MANIFEST_INVALID', async () => {
  const result = await verifyPackage(baseArgs({ limits: { maxPayloadListLength: 1 } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  assert.equal(result.reason, 'payload_list_budget_exceeded');
  assert.equal(result.stage, STAGES[1]);
});

// --- Manifest-gate adversarial shapes ----------------------------------------

test('verifyPackage: a duplicate canonical path in the signed payload list is MANIFEST_INVALID', async () => {
  const declaredPayload = makeDeclaredPayload();
  const tampered = { ...declaredPayload, entries: [...declaredPayload.entries, { ...declaredPayload.entries[0] }] };
  const result = await verifyPackage(baseArgs({ declaredPayload: tampered }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  assert.equal(result.stage, STAGES[1]);
  assert.match(result.reason, /duplicate_canonical_path/);
});

test('verifyPackage: a hostile (path-escaping) path in the signed payload list is MANIFEST_INVALID, never interpolated', async () => {
  const declaredPayload = makeDeclaredPayload();
  const tampered = { ...declaredPayload, entries: [{ path: '../escape.json', sha256: 'a'.repeat(64) }] };
  const result = await verifyPackage(baseArgs({ declaredPayload: tampered }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  assert.equal(result.stage, STAGES[1]);
  assert.match(result.reason, /parent_dir_traversal/);
});

test('verifyPackage: a malformed (wrong-length) digest in the signed payload list is MANIFEST_INVALID', async () => {
  const declaredPayload = makeDeclaredPayload();
  const tampered = { ...declaredPayload, entries: [{ path: 'a-first.json', sha256: 'deadbeef' }] };
  const result = await verifyPackage(baseArgs({ declaredPayload: tampered }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  assert.equal(result.reason, 'payload_entry_invalid_digest');
  assert.equal(result.stage, STAGES[1]);
});

test('verifyPackage: an invalid publisher_id or plugin_id shape on the declared payload is MANIFEST_INVALID', async () => {
  const declaredPayload = makeDeclaredPayload();
  const badPublisher = await verifyPackage(baseArgs({ declaredPayload: { ...declaredPayload, publisher_id: 'NOT-VALID!' } }));
  assert.equal(badPublisher.ok, false);
  assert.equal(badPublisher.code, PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  assert.equal(badPublisher.reason, 'invalid_publisher_id');

  const badPlugin = await verifyPackage(baseArgs({ declaredPayload: { ...declaredPayload, plugin_id: 'NOT VALID' } }));
  assert.equal(badPlugin.ok, false);
  assert.equal(badPlugin.code, PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  assert.equal(badPlugin.reason, 'invalid_plugin_id');
});

test('verifyPackage: declaredPayload declaring a different canonicalization_version than Jenny\'s own constant is MANIFEST_INVALID', async () => {
  const declaredPayload = makeDeclaredPayload();
  const tampered = { ...declaredPayload, canonicalization_version: declaredPayload.canonicalization_version + 1 };
  const result = await verifyPackage(baseArgs({ declaredPayload: tampered }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.MANIFEST_INVALID);
  assert.equal(result.reason, 'canonicalization_version_mismatch');
  assert.equal(result.stage, STAGES[1]);
});

// --- digestOf failure ---------------------------------------------------------

test('verifyPackage: a throwing digestOf() is treated as an integrity failure, not a crash', async () => {
  const digestOf = async (path) => {
    if (path === 'z-second.json') throw new Error('read failed');
    return DIGESTS[path];
  };
  const result = await verifyPackage(baseArgs({ digestOf }));
  assert.equal(result.ok, false);
  assert.equal(result.code, PLUGIN_ERROR_CODES.INTEGRITY_FAILED);
  assert.equal(result.reason, 'digest_computation_failed');
  assert.equal(result.stage, STAGES[3]);
});
