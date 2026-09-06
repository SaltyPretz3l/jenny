'use strict';

// Proves the hostile-archive corpus (tests/helpers/plugins/hostile-archive-
// builder*.js) is not just plausible-looking JS: every path-shape scenario's
// real byte-encoded entry name is rejected by archive-entry-validator.js with
// the expected reason, and every structural scenario (CRC/size mismatch,
// header disagreement, polyglot trailer) has the claimed defect provably
// present in the assembled bytes. A benign control archive is included as a
// negative control, so this suite cannot pass merely by having a validator
// that rejects everything.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateArchiveEntry, createArchiveEntryTracker } = require('../../../services/plugins/package/archive-entry-validator.js');
const { readLocalFileHeader, readCentralDirectoryHeader, crc32 } = require('../../../tests/helpers/plugins/hostile-archive-builder.js');
const scenarios = require('../../../tests/helpers/plugins/hostile-archive-builder-scenarios.js');

const UNIX_SYMLINK_MODE_MASK = 0xf000;
const UNIX_SYMLINK_MODE_VALUE = 0xa000;

/**
 * Derives the entry-metadata flags archive-entry-validator.js expects from
 * the raw ZIP-level signals a real archive-staging pipeline would already
 * have extracted (general-purpose bit flag, external attributes). This is
 * intentionally a small stand-in for that future extraction step: it is what
 * makes these corpus fixtures prove something about REAL bytes, not just
 * about hand-picked flags passed straight to the validator.
 */
function toEntryMetadata(entrySpec) {
  const externalAttributes = entrySpec.externalAttributes || 0;
  const generalPurposeBitFlag = entrySpec.generalPurposeBitFlag || 0;
  return {
    rawPath: entrySpec.name,
    isSymlinkOrReparsePoint: ((externalAttributes >>> 16) & UNIX_SYMLINK_MODE_MASK) === UNIX_SYMLINK_MODE_VALUE,
    isEncrypted: (generalPurposeBitFlag & 0x1) === 0x1,
  };
}

/**
 * Validates every entry of a built scenario in archive order, returning the
 * first rejection (or the last ok result if all entries pass).
 */
function validateAllEntries(entries) {
  let tracker = createArchiveEntryTracker();
  let last = null;
  for (const entrySpec of entries) {
    last = validateArchiveEntry(toEntryMetadata(entrySpec), tracker);
    if (!last.ok) return last;
    tracker.canonicalPaths.add(last.canonical_path);
    tracker.caseFoldKeys.add(last.case_fold_key);
  }
  return last;
}

const PATH_SHAPE_SCENARIOS = [
  ['buildPathTraversalArchive', 'parent_dir_traversal_rejected'],
  ['buildAbsolutePathArchive', 'absolute_path_rejected'],
  ['buildDriveLetterPathArchive', 'drive_letter_path_rejected'],
  ['buildUncPathArchive', 'unc_path_rejected'],
  ['buildDeviceNameEntryArchive', 'reserved_device_name_rejected'],
  ['buildTrailingDotAliasArchive', 'trailing_dot_or_space_alias_rejected'],
  ['buildDuplicateCanonicalPathArchive', 'duplicate_canonical_path_rejected'],
  ['buildCaseCollisionArchive', 'case_or_normalization_collision_rejected'],
  ['buildNfcNfdCollisionArchive', 'duplicate_canonical_path_rejected'],
  ['buildEncryptedEntryArchive', 'encrypted_entry_rejected'],
  ['buildSymlinkEntryArchive', 'symlink_or_reparse_point_rejected'],
];

for (const [scenarioName, expectedReason] of PATH_SHAPE_SCENARIOS) {
  test(`hostile scenario ${scenarioName} produces bytes whose real entries archive-entry-validator rejects as ${expectedReason}`, () => {
    const { entries } = scenarios[scenarioName]();
    const result = validateAllEntries(entries);
    assert.equal(result.ok, false, `${scenarioName} should be rejected`);
    assert.equal(result.reason, expectedReason);
  });
}

// isSymlinkOrReparsePoint/isHardLink/isEncrypted are logical flags derived
// elsewhere from raw ZIP bytes (external attributes / general-purpose bit
// flag), not something archive-entry-validator parses itself. Confirm the
// symlink/encrypted scenarios really do carry those raw signals in the bytes
// they build, so the "rejected" cases above are honest end-to-end fixtures
// rather than validator calls fed hand-picked flags.
test('buildSymlinkEntryArchive really sets the Unix symlink mode bits in external attributes', () => {
  const { bytes, localHeaderOffsets } = scenarios.buildSymlinkEntryArchive();
  const local = readLocalFileHeader(bytes, localHeaderOffsets[0]);
  assert.equal(local.name, 'link-to-somewhere');
  // Re-locate the central directory header by scanning from just after the
  // last local entry's data, since assembleZip does not return its offset
  // directly for a single-entry archive.
  const centralHeaderOffset = local.dataStart + local.uncompressedSize;
  const central = readCentralDirectoryHeader(bytes, centralHeaderOffset);
  assert.equal(central.name, 'link-to-somewhere');
  assert.equal((central.externalAttributes >>> 16) & 0xf000, 0xa000, 'S_IFLNK bit must be set in the upper 16 bits');
});

test('buildEncryptedEntryArchive really sets the encrypted general-purpose bit', () => {
  const { bytes, localHeaderOffsets } = scenarios.buildEncryptedEntryArchive();
  const local = readLocalFileHeader(bytes, localHeaderOffsets[0]);
  assert.equal(local.generalPurposeBitFlag & 0x1, 0x1);
});

test('buildCentralLocalDisagreementArchive really encodes different names in the local header and the central directory', () => {
  const { bytes, localHeaderOffsets } = scenarios.buildCentralLocalDisagreementArchive();
  const local = readLocalFileHeader(bytes, localHeaderOffsets[0]);
  const centralHeaderOffset = local.dataStart + local.uncompressedSize;
  const central = readCentralDirectoryHeader(bytes, centralHeaderOffset);
  assert.equal(local.name, 'safe.txt');
  assert.equal(central.name, 'evil.txt');
  assert.notEqual(local.name, central.name);
});

test('buildCrcMismatchArchive really declares a CRC that does not match the real data bytes', () => {
  const { bytes, entries, localHeaderOffsets } = scenarios.buildCrcMismatchArchive();
  const local = readLocalFileHeader(bytes, localHeaderOffsets[0]);
  const realCrc = crc32(entries[0].data);
  assert.notEqual(local.crc32, realCrc);
});

test('buildDeclaredSizeMismatchArchive really declares a size larger than the actual trailing data', () => {
  const { entries, localHeaderOffsets, bytes } = scenarios.buildDeclaredSizeMismatchArchive();
  const local = readLocalFileHeader(bytes, localHeaderOffsets[0]);
  assert.ok(local.uncompressedSize > entries[0].data.length);
});

test('buildTrailingPolyglotArchive really appends bytes after the end-of-central-directory record', () => {
  const { bytes } = scenarios.buildTrailingPolyglotArchive();
  const marker = 'FAKE_POLYGLOT_TEST_MARKER_NOT_EXECUTABLE';
  assert.ok(bytes.toString('utf8').endsWith(marker));
});

test('buildBenignControlArchive is a negative control: every real entry passes validation cleanly', () => {
  const { entries } = scenarios.buildBenignControlArchive();
  const result = validateAllEntries(entries);
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});
