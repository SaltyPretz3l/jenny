'use strict';

// Named hostile-archive scenarios built on the raw ZIP primitives in
// ./hostile-archive-builder.js. Split into its own file (per the lane
// contract's 600-raw-line ceiling) so the low-level byte assembly stays
// separate from the higher-level "here is what an attack looks like" catalog.
//
// Each scenario function returns `{ bytes, entries, localHeaderOffsets }`:
//   - `bytes`: the complete in-memory ZIP buffer (never written to disk).
//   - `entries`: the logical entry specs used to build it, so a test can feed
//     `{ rawPath: entries[i].name, ... }`-shaped metadata straight into
//     services/plugins/package/archive-entry-validator.js without writing a
//     second, redundant ZIP reader.
//   - `localHeaderOffsets`: byte offsets for structural read-back assertions
//     (CRC/size/header-disagreement scenarios that archive-entry-validator.js
//     does not itself check, since path-shape and structural zip-consistency
//     are different concerns; see PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md's
//     "Distribution and supply-chain security" rejection list).
//
// Unicode NFC/NFD text below is written with explicit codepoint escapes
// rather than literal composed/decomposed characters, so the scenario intent
// survives any editor/tool that silently re-normalizes source file bytes.

const { assembleZip } = require('./hostile-archive-builder.js');

const NFC_E_ACUTE = '\u00e9'; // U+00E9 LATIN SMALL LETTER E WITH ACUTE (composed)
const NFD_E_ACUTE = 'e\u0301'; // 'e' + U+0301 COMBINING ACUTE ACCENT (decomposed)

/**
 * Reserved Unix symlink mode (S_IFLNK) shifted into the upper 16 bits of
 * external attributes. Uses multiplication rather than `<<`, since `<<`
 * operates on signed 32-bit integers in JS and 0xa1ff << 16 overflows into a
 * negative number instead of the intended unsigned value.
 */
const UNIX_SYMLINK_EXTERNAL_ATTRIBUTES = 0xa1ff * 0x10000;

function buildPathTraversalArchive() {
  const entries = [{ name: '../../evil.txt', data: Buffer.from('traversal', 'utf8') }];
  return { entries, ...assembleZip(entries) };
}

function buildAbsolutePathArchive() {
  const entries = [{ name: '/etc/passwd', data: Buffer.from('absolute', 'utf8') }];
  return { entries, ...assembleZip(entries) };
}

function buildDriveLetterPathArchive() {
  const entries = [{ name: 'C:/evil.txt', data: Buffer.from('drive', 'utf8') }];
  return { entries, ...assembleZip(entries) };
}

function buildUncPathArchive() {
  const entries = [{ name: '//server/share/evil.txt', data: Buffer.from('unc', 'utf8') }];
  return { entries, ...assembleZip(entries) };
}

function buildDeviceNameEntryArchive() {
  const entries = [{ name: 'nested/COM1.dll', data: Buffer.from('device', 'utf8') }];
  return { entries, ...assembleZip(entries) };
}

function buildTrailingDotAliasArchive() {
  const entries = [{ name: 'evil.txt.', data: Buffer.from('trailingdot', 'utf8') }];
  return { entries, ...assembleZip(entries) };
}

function buildDuplicateCanonicalPathArchive() {
  const entries = [
    { name: 'dup.txt', data: Buffer.from('first', 'utf8') },
    { name: 'dup.txt', data: Buffer.from('second', 'utf8') },
  ];
  return { entries, ...assembleZip(entries) };
}

function buildCaseCollisionArchive() {
  const entries = [
    { name: 'File.txt', data: Buffer.from('upper', 'utf8') },
    { name: 'file.txt', data: Buffer.from('lower', 'utf8') },
  ];
  return { entries, ...assembleZip(entries) };
}

function buildNfcNfdCollisionArchive() {
  // These are the only non-ASCII names in the corpus, so they are the only entries
  // that need ZIP general-purpose bit 11 (0x0800) to declare the name is UTF-8.
  // Without it the bytes claim a code-page name while carrying UTF-8 -- fine for the
  // corpus test, which validates the entry objects rather than the bytes, but the
  // fixtures in this file are meant to be honest end-to-end (see the symlink and
  // encrypted raw-signal checks in hostile-archive-corpus.test.js).
  const entries = [
    {
      name: `caf${NFC_E_ACUTE}.txt`,
      data: Buffer.from('composed', 'utf8'),
      generalPurposeBitFlag: 0x0800,
    },
    {
      name: `caf${NFD_E_ACUTE}.txt`,
      data: Buffer.from('decomposed', 'utf8'),
      generalPurposeBitFlag: 0x0800,
    },
  ];
  return { entries, ...assembleZip(entries) };
}

/** Local header says "safe.txt"; the central directory copy says "evil.txt". */
function buildCentralLocalDisagreementArchive() {
  const entries = [
    {
      name: 'safe.txt',
      data: Buffer.from('payload', 'utf8'),
      centralOverrides: { name: 'evil.txt' },
    },
  ];
  return { entries, ...assembleZip(entries) };
}

/** Declared CRC in both headers does not match the real CRC of the data bytes. */
function buildCrcMismatchArchive() {
  const entries = [
    {
      name: 'crc-mismatch.txt',
      data: Buffer.from('real content', 'utf8'),
      crc32Override: 0x00000000,
    },
  ];
  return { entries, ...assembleZip(entries) };
}

/** Declared uncompressed/compressed size is far larger than the real trailing bytes. */
function buildDeclaredSizeMismatchArchive() {
  const entries = [
    {
      name: 'size-mismatch.txt',
      data: Buffer.from('tiny', 'utf8'),
      compressedSizeOverride: 999999,
      uncompressedSizeOverride: 999999,
    },
  ];
  return { entries, ...assembleZip(entries) };
}

/** A clearly-labeled fake marker appended after the end-of-central-directory record. */
function buildTrailingPolyglotArchive() {
  const entries = [{ name: 'innocuous.txt', data: Buffer.from('nothing to see here', 'utf8') }];
  const trailingBytes = Buffer.from('FAKE_POLYGLOT_TEST_MARKER_NOT_EXECUTABLE', 'utf8');
  return { entries, ...assembleZip(entries, { trailingBytes }) };
}

/** General-purpose bit 0 set: the entry claims to be encrypted (ZipCrypto). */
function buildEncryptedEntryArchive() {
  const entries = [
    { name: 'secret.bin', data: Buffer.from('ciphertext-shaped bytes', 'utf8'), generalPurposeBitFlag: 0x1 },
  ];
  return { entries, ...assembleZip(entries) };
}

/** Unix symlink mode bits set in the external attributes field. */
function buildSymlinkEntryArchive() {
  const entries = [
    {
      name: 'link-to-somewhere',
      data: Buffer.from('/etc/passwd', 'utf8'),
      externalAttributes: UNIX_SYMLINK_EXTERNAL_ATTRIBUTES,
    },
  ];
  return { entries, ...assembleZip(entries) };
}

/** A well-formed archive with no defects at all, as a negative control. */
function buildBenignControlArchive() {
  const entries = [
    { name: 'plugin.json', data: Buffer.from('{"plugin_id":"widgets"}', 'utf8') },
    { name: 'skills/render.js', data: Buffer.from('module.exports = {};', 'utf8') },
  ];
  return { entries, ...assembleZip(entries) };
}

module.exports = {
  UNIX_SYMLINK_EXTERNAL_ATTRIBUTES,
  buildPathTraversalArchive,
  buildAbsolutePathArchive,
  buildDriveLetterPathArchive,
  buildUncPathArchive,
  buildDeviceNameEntryArchive,
  buildTrailingDotAliasArchive,
  buildDuplicateCanonicalPathArchive,
  buildCaseCollisionArchive,
  buildNfcNfdCollisionArchive,
  buildCentralLocalDisagreementArchive,
  buildCrcMismatchArchive,
  buildDeclaredSizeMismatchArchive,
  buildTrailingPolyglotArchive,
  buildEncryptedEntryArchive,
  buildSymlinkEntryArchive,
  buildBenignControlArchive,
};
