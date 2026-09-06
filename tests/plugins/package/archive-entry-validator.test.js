'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PATH_SEGMENT_CHARS,
  MAX_DIRECTORY_DEPTH,
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  MAX_ENTRY_COMPRESSION_RATIO,
  createArchiveEntryTracker,
  validateArchiveEntry,
} = require('../../../services/plugins/package/archive-entry-validator.js');

test('a decompression bomb is rejected on its declared compression ratio', () => {
  const result = validateArchiveEntry({
    rawPath: 'bomb.bin',
    compressedSize: 1,
    uncompressedSize: 4294967295,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'entry_size_budget_exceeded');
});

test('an entry that inflates past the ratio ceiling but stays under the size cap is still rejected', () => {
  const compressedSize = 1024;
  const result = validateArchiveEntry({
    rawPath: 'bomb.bin',
    compressedSize,
    uncompressedSize: compressedSize * (MAX_ENTRY_COMPRESSION_RATIO + 1),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'compression_ratio_exceeded');
});

test('a zero compressed size that expands to anything is an unbounded ratio', () => {
  assert.equal(
    validateArchiveEntry({ rawPath: 'bomb.bin', compressedSize: 0, uncompressedSize: 1 }).reason,
    'compression_ratio_exceeded'
  );
  // A genuinely empty entry is fine.
  assert.equal(validateArchiveEntry({ rawPath: 'empty.bin', compressedSize: 0, uncompressedSize: 0 }).ok, true);
});

test('declared sizes within budget are accepted, and malformed ones are rejected', () => {
  assert.equal(validateArchiveEntry({ rawPath: 'ok.bin', compressedSize: 1000, uncompressedSize: 3000 }).ok, true);
  assert.equal(
    validateArchiveEntry({ rawPath: 'ok.bin', compressedSize: -1, uncompressedSize: 10 }).reason,
    'invalid_entry_size'
  );
  assert.equal(
    validateArchiveEntry({ rawPath: 'ok.bin', compressedSize: 10, uncompressedSize: 1.5 }).reason,
    'invalid_entry_size'
  );
  // One size without the other is malformed rather than silently unchecked.
  assert.equal(validateArchiveEntry({ rawPath: 'ok.bin', uncompressedSize: 10 }).reason, 'invalid_entry_size');
});

test('an entry at exactly the uncompressed size cap is accepted', () => {
  const result = validateArchiveEntry({
    rawPath: 'big.bin',
    compressedSize: MAX_ENTRY_UNCOMPRESSED_BYTES,
    uncompressedSize: MAX_ENTRY_UNCOMPRESSED_BYTES,
  });
  assert.equal(result.ok, true);
});

test('validateArchiveEntry accepts a normal nested path', () => {
  const result = validateArchiveEntry({ rawPath: 'skills/render.js' });
  assert.deepEqual(result, {
    ok: true,
    canonical_path: 'skills/render.js',
    case_fold_key: 'skills/render.js',
    reason: null,
  });
});

test('validateArchiveEntry rejects invalid entry metadata', () => {
  assert.equal(validateArchiveEntry(null).reason, 'invalid_entry_metadata');
  assert.equal(validateArchiveEntry({ rawPath: '' }).reason, 'invalid_entry_path');
  assert.equal(validateArchiveEntry({ rawPath: 42 }).reason, 'invalid_entry_path');
});

test('validateArchiveEntry rejects a UNC path before the generic absolute-path check', () => {
  const result = validateArchiveEntry({ rawPath: '//server/share/evil.txt' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unc_path_rejected');
});

test('validateArchiveEntry rejects an absolute POSIX-style path', () => {
  const result = validateArchiveEntry({ rawPath: '/etc/passwd' });
  assert.equal(result.reason, 'absolute_path_rejected');
});

test('validateArchiveEntry rejects a drive-letter path', () => {
  const result = validateArchiveEntry({ rawPath: 'C:/evil.txt' });
  assert.equal(result.reason, 'drive_letter_path_rejected');
});

test('validateArchiveEntry rejects a literal backslash path separator', () => {
  const path = ['a', 'evil.txt'].join(String.fromCharCode(92));
  const result = validateArchiveEntry({ rawPath: path });
  assert.equal(result.reason, 'backslash_path_separator_rejected');
});

test('validateArchiveEntry rejects parent-directory traversal', () => {
  assert.equal(validateArchiveEntry({ rawPath: '../../evil.txt' }).reason, 'parent_dir_traversal_rejected');
});

test('validateArchiveEntry rejects a lone current-directory segment', () => {
  assert.equal(validateArchiveEntry({ rawPath: './evil.txt' }).reason, 'current_dir_segment_rejected');
});

test('validateArchiveEntry rejects an empty path segment', () => {
  assert.equal(validateArchiveEntry({ rawPath: 'a//b.txt' }).reason, 'empty_path_segment');
});

test('validateArchiveEntry rejects a reserved device name with or without an extension, nested or not', () => {
  assert.equal(validateArchiveEntry({ rawPath: 'CON' }).reason, 'reserved_device_name_rejected');
  assert.equal(validateArchiveEntry({ rawPath: 'con.txt' }).reason, 'reserved_device_name_rejected');
  assert.equal(validateArchiveEntry({ rawPath: 'nested/COM1.dll' }).reason, 'reserved_device_name_rejected');
});

test('validateArchiveEntry accepts a name that merely starts with a reserved device name', () => {
  const result = validateArchiveEntry({ rawPath: 'CONFIG.json' });
  assert.equal(result.ok, true);
});

test('validateArchiveEntry rejects a trailing-dot alias', () => {
  assert.equal(validateArchiveEntry({ rawPath: 'evil.txt.' }).reason, 'trailing_dot_or_space_alias_rejected');
});

test('validateArchiveEntry rejects a trailing-space alias', () => {
  assert.equal(validateArchiveEntry({ rawPath: 'evil.txt ' }).reason, 'trailing_dot_or_space_alias_rejected');
});

test('validateArchiveEntry rejects an alternate-data-stream style colon in a segment', () => {
  assert.equal(validateArchiveEntry({ rawPath: 'file.txt:hidden' }).reason, 'alternate_data_stream_rejected');
});

test('validateArchiveEntry rejects a symlink/reparse-point entry', () => {
  const result = validateArchiveEntry({ rawPath: 'link', isSymlinkOrReparsePoint: true });
  assert.equal(result.reason, 'symlink_or_reparse_point_rejected');
});

test('validateArchiveEntry rejects a hard-link entry', () => {
  const result = validateArchiveEntry({ rawPath: 'link', isHardLink: true });
  assert.equal(result.reason, 'hard_link_rejected');
});

test('validateArchiveEntry rejects an encrypted entry', () => {
  const result = validateArchiveEntry({ rawPath: 'secret.bin', isEncrypted: true });
  assert.equal(result.reason, 'encrypted_entry_rejected');
});

test('validateArchiveEntry rejects a path segment over the length ceiling', () => {
  const segment = 'a'.repeat(MAX_PATH_SEGMENT_CHARS + 1);
  assert.equal(validateArchiveEntry({ rawPath: segment }).reason, 'path_segment_too_long');
});

test('validateArchiveEntry accepts a path segment exactly at the length ceiling', () => {
  const segment = 'a'.repeat(MAX_PATH_SEGMENT_CHARS);
  assert.equal(validateArchiveEntry({ rawPath: segment }).ok, true);
});

test('validateArchiveEntry accepts directory depth exactly at the ceiling and rejects one deeper', () => {
  const atLimit = Array.from({ length: MAX_DIRECTORY_DEPTH + 1 }, (_, i) => `d${i}`).join('/');
  const overLimit = Array.from({ length: MAX_DIRECTORY_DEPTH + 2 }, (_, i) => `d${i}`).join('/');
  assert.equal(validateArchiveEntry({ rawPath: atLimit }).ok, true);
  assert.equal(validateArchiveEntry({ rawPath: overLimit }).reason, 'directory_depth_exceeded');
});

test('validateArchiveEntry rejects a duplicate canonical path against prior tracker state', () => {
  let tracker = createArchiveEntryTracker();
  const first = validateArchiveEntry({ rawPath: 'dup.txt' }, tracker);
  assert.equal(first.ok, true);
  tracker.canonicalPaths.add(first.canonical_path);
  tracker.caseFoldKeys.add(first.case_fold_key);
  const second = validateArchiveEntry({ rawPath: 'dup.txt' }, tracker);
  assert.equal(second.reason, 'duplicate_canonical_path_rejected');
});

test('validateArchiveEntry rejects a case-only collision against prior tracker state', () => {
  let tracker = createArchiveEntryTracker();
  const first = validateArchiveEntry({ rawPath: 'File.txt' }, tracker);
  assert.equal(first.ok, true);
  tracker.canonicalPaths.add(first.canonical_path);
  tracker.caseFoldKeys.add(first.case_fold_key);
  const second = validateArchiveEntry({ rawPath: 'file.txt' }, tracker);
  assert.equal(second.reason, 'case_or_normalization_collision_rejected');
});

test('validateArchiveEntry treats an NFD-decomposed name as a duplicate of its NFC-composed form', () => {
  let tracker = createArchiveEntryTracker();
  const nfc = `caf${String.fromCharCode(0xe9)}.txt`;
  const nfd = `cafe${String.fromCodePoint(0x0301)}.txt`;
  const first = validateArchiveEntry({ rawPath: nfc }, tracker);
  assert.equal(first.ok, true);
  assert.equal(first.canonical_path, nfc);
  tracker.canonicalPaths.add(first.canonical_path);
  tracker.caseFoldKeys.add(first.case_fold_key);
  const second = validateArchiveEntry({ rawPath: nfd }, tracker);
  assert.equal(second.reason, 'duplicate_canonical_path_rejected');
});
