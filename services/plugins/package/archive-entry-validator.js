'use strict';

// Pure per-entry archive validation against the rejection matrix in
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md, "Distribution and supply-chain
// security": "Archive validation canonicalizes UTF-8 NFC paths and rejects
// absolute/drive/UNC paths, dot traversal, links and reparse points, hard
// links, alternate data streams, device names, trailing-dot/space aliases,
// case/normalization collisions, ... duplicate canonical paths, over-limit
// path length or directory depth (Windows long-path aware, including the
// deep userData/plugins/packages/<sha256>/ prefix), encrypted entries, ...".
//
// This module never reads a filesystem or parses raw ZIP bytes: it takes
// already-extracted entry metadata (name, link/encryption flags) and a
// caller-owned snapshot of previously validated canonical paths in the same
// archive, and returns a bounded structured verdict. Every input is treated
// as hostile.

const { hasForbiddenCodepoint } = require('../identity/display-strings.js');

// These finite limits bound hostile archives and must remain aligned with the
// frozen package budgets.

// NTFS per-component name limit.
const MAX_PATH_SEGMENT_CHARS = 255;
// Bounded nesting depth; not a documented Windows limit, just a sane ceiling.
const MAX_DIRECTORY_DEPTH = 32;
// Conservative reservation for `<userData>\plugins\packages\<sha256-hex>\`
// plus a typical Windows user-profile prefix, so the *materialized* path
// (prefix + relative entry path) is what gets bounded, not just the entry's
// own relative length. Windows long-path awareness raises the practical
// ceiling well above classic MAX_PATH (260), but Jenny still wants a finite
// bound rather than trusting an archive to declare arbitrarily long paths.
const ASSUMED_PACKAGE_STORE_PREFIX_CHARS = 128;
const MAX_TOTAL_WINDOWS_PATH_CHARS = 32000;
const MAX_ENTRY_RELATIVE_PATH_CHARS = MAX_TOTAL_WINDOWS_PATH_CHARS - ASSUMED_PACKAGE_STORE_PREFIX_CHARS;

// Decompression-bomb ceilings. `compressedSize`/`uncompressedSize` are the
// entry's DECLARED header sizes; when the caller supplies them these bounds
// reject a single entry that inflates absurdly or is simply too large to
// materialize. Callers that omit both skip only these two checks.
//
// NOT owned here: a header that LIES about its size (declares N, expands to M).
// This module never sees the compressed bytes, so detecting that belongs to
// whatever streams the entry out and must compare bytes written against the
// declaration. The threat matrix tracks that as a separate, later row.
const MAX_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_COMPRESSION_RATIO = 100;

// Reserved Windows device names: reserved for any path segment regardless of
// extension or casing (`CON.txt`, `nested/com1.dll`, ... are all reserved).
const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isReservedDeviceSegment(segment) {
  const dotIndex = segment.indexOf('.');
  const baseName = dotIndex === -1 ? segment : segment.slice(0, dotIndex);
  return RESERVED_DEVICE_NAMES.has(baseName.toUpperCase());
}

/**
 * Creates a fresh, empty duplicate/case-collision tracking snapshot. Callers
 * fold each successfully validated entry's canonical_path/case_fold_key into
 * their own copy between calls; this module never mutates the snapshot it is
 * given.
 * @returns {{canonicalPaths:Set<string>,caseFoldKeys:Set<string>}}
 */
function createArchiveEntryTracker() {
  return { canonicalPaths: new Set(), caseFoldKeys: new Set() };
}

function fail(reason) {
  return { ok: false, canonical_path: null, reason };
}

function isDeclaredSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * @returns {string|null} a rejection reason, or null when the declared sizes
 *   are absent or within budget.
 */
function declaredSizeRejection(entry) {
  const { compressedSize, uncompressedSize } = entry;
  if (compressedSize === undefined && uncompressedSize === undefined) return null;
  if (!isDeclaredSize(compressedSize) || !isDeclaredSize(uncompressedSize)) return 'invalid_entry_size';
  if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) return 'entry_size_budget_exceeded';
  // A zero compressed size that expands to anything is an unbounded ratio.
  if (compressedSize === 0) return uncompressedSize === 0 ? null : 'compression_ratio_exceeded';
  if (uncompressedSize / compressedSize > MAX_ENTRY_COMPRESSION_RATIO) return 'compression_ratio_exceeded';
  return null;
}

/**
 * Validates one canonicalized archive entry against the rejection matrix.
 * @param {{
 *   rawPath: unknown,
 *   isDirectory?: boolean,
 *   isSymlinkOrReparsePoint?: boolean,
 *   isHardLink?: boolean,
 *   isEncrypted?: boolean,
 *   compressedSize?: number,
 *   uncompressedSize?: number,
 * }} entry declared header sizes are optional; supply both to get the
 *   decompression-bomb checks, or neither to skip them.
 * @param {{canonicalPaths:Set<string>,caseFoldKeys:Set<string>}} [tracker]
 * @returns {{ok:true,canonical_path:string,case_fold_key:string,reason:null}
 *          |{ok:false,canonical_path:null,reason:string}}
 */
function validateArchiveEntry(entry, tracker = createArchiveEntryTracker()) {
  if (entry === null || typeof entry !== 'object') return fail('invalid_entry_metadata');
  const { rawPath } = entry;
  if (typeof rawPath !== 'string' || rawPath.length === 0) return fail('invalid_entry_path');
  if (hasForbiddenCodepoint(rawPath)) return fail('forbidden_codepoint_in_path');
  if (rawPath.includes('\\')) return fail('backslash_path_separator_rejected');
  if (rawPath.startsWith('//')) return fail('unc_path_rejected');
  if (rawPath.startsWith('/')) return fail('absolute_path_rejected');
  if (/^[A-Za-z]:/.test(rawPath)) return fail('drive_letter_path_rejected');

  const segments = rawPath.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return fail('empty_path_segment');
    if (segment === '.') return fail('current_dir_segment_rejected');
    if (segment === '..') return fail('parent_dir_traversal_rejected');
    if (Buffer.byteLength(segment, 'utf8') > MAX_PATH_SEGMENT_CHARS) return fail('path_segment_too_long');
    if (segment.includes(':')) return fail('alternate_data_stream_rejected');
    if (segment.endsWith('.') || segment.endsWith(' ')) return fail('trailing_dot_or_space_alias_rejected');
    if (isReservedDeviceSegment(segment)) return fail('reserved_device_name_rejected');
  }

  if (entry.isSymlinkOrReparsePoint) return fail('symlink_or_reparse_point_rejected');
  if (entry.isHardLink) return fail('hard_link_rejected');
  if (entry.isEncrypted) return fail('encrypted_entry_rejected');

  const sizeRejection = declaredSizeRejection(entry);
  if (sizeRejection) return fail(sizeRejection);

  const directoryDepth = segments.length - 1;
  if (directoryDepth > MAX_DIRECTORY_DEPTH) return fail('directory_depth_exceeded');

  const canonicalPath = segments.join('/').normalize('NFC');
  if (Buffer.byteLength(canonicalPath, 'utf8') > MAX_ENTRY_RELATIVE_PATH_CHARS) {
    return fail('path_length_budget_exceeded');
  }

  const caseFoldKey = canonicalPath.toLowerCase();
  if (tracker.canonicalPaths.has(canonicalPath)) return fail('duplicate_canonical_path_rejected');
  if (tracker.caseFoldKeys.has(caseFoldKey)) return fail('case_or_normalization_collision_rejected');

  return { ok: true, canonical_path: canonicalPath, case_fold_key: caseFoldKey, reason: null };
}

module.exports = {
  MAX_PATH_SEGMENT_CHARS,
  MAX_DIRECTORY_DEPTH,
  ASSUMED_PACKAGE_STORE_PREFIX_CHARS,
  MAX_TOTAL_WINDOWS_PATH_CHARS,
  MAX_ENTRY_RELATIVE_PATH_CHARS,
  MAX_ENTRY_UNCOMPRESSED_BYTES,
  MAX_ENTRY_COMPRESSION_RATIO,
  RESERVED_DEVICE_NAMES,
  createArchiveEntryTracker,
  validateArchiveEntry,
};
