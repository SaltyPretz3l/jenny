'use strict';

// Client-supplied relative paths for team uploads (slice 3-8a). The Node form
// of the "Segment names" table in the team Windows file access spec,
// applied on every host so a manifest accepted on Linux is also safe to
// install on Windows (TEAM_PROJECTS_SPEC "Upload and download").
//
// Answers are closed reasons and never echo the name. Validation is pure: no
// name reaches a filesystem call here, and the transfer core names its staging
// files by index, so these paths are carried as data for the install step.

const PATH_LIMITS = Object.freeze({
  MAX_SEGMENTS: 16,
  MAX_BYTES: 512,
  // A Linux NAME_MAX counts bytes. UTF-8 bytes are never fewer than UTF-16
  // code units, so this bound also covers the Windows bound of 255 units.
  MAX_SEGMENT_BYTES: 255,
});

const SEGMENT_REASONS = Object.freeze([
  'segment_not_string', 'segment_empty', 'segment_dot', 'segment_separator', 'segment_character',
  'segment_control', 'segment_trailing', 'segment_reserved', 'segment_too_long',
  'path_not_string', 'path_absolute', 'path_drive', 'path_too_deep', 'path_too_long',
]);

const SEPARATORS = /[\\/:]/u;
const WIN32_INVALID = /[<>"|?*]/u;
// Below U+0020 and U+007F. Lone surrogates are checked with isWellFormed.
// eslint-disable-next-line no-control-regex -- the control range is the rule.
const CONTROL = /[\u0000-\u001f\u007f]/u;
const TRAILING = /[. ]$/u;
// CON, PRN, AUX, NUL, CONIN$, CONOUT$, COM0-9 and LPT0-9 (with the
// superscript digits Win32 also maps to devices), case folded, with or
// without an extension, and with spaces before the extension ('con .txt').
// COM0 and LPT0 since slice 3-8b, as the Windows file access spec's table and
// its vectors have them since 2026-11-11.
const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]) *(?:\..*)?$/iu;
const DRIVE = /^[A-Za-z]:/u;

// Two names that one file system could treat as the same file fold alike: NFKC
// normalized, then each code point upper-cased and lower-cased on its own, so
// context rules (final sigma) cannot split a pair NTFS's upper-case table
// joins ('A\u03a3' and 'a\u03c3', '\u0131' and 'I'). Stricter than any one
// file system on purpose ('\u00df' meets 'ss'): a false collision refuses an
// upload, a missed one would merge two files. (transfer-manifest.js re-exports it.)
function foldKey(filePath) {
  return Array.from(filePath.normalize('NFKC'), (char) => char.toUpperCase().toLowerCase()).join('').normalize('NFKC');
}

// E69 (owner, 2026-11-14): the names the approval rules treat as sensitive
// (project-rules-match.js "Hidden folders", TEAM_PROJECTS_SPEC 3-12). The one
// list: a project upload refuses a folder name or path segment on it, the
// host's download listing never offers one and the member's download never
// writes one. Compared folded (foldKey) on every platform, so '.GIT', '.Env'
// and '.g\u0131t' are on it too. Other dot names ('.gitignore') are not.
const SENSITIVE_NAMES = Object.freeze(['.git', '.github', '.vscode', '.env', '.jenny']);
const SENSITIVE_KEYS = new Set(SENSITIVE_NAMES.map(foldKey));
// No listed name is over 7 characters and the fold never shortens a name to a quarter, so a longer segment is
// never folded: an oversized one costs nothing here and is refused by the length rules (review pass).
const SENSITIVE_MAX_CHARS = 32;

function isSensitiveSegment(name) {
  return typeof name === 'string' && name.length <= SENSITIVE_MAX_CHARS && SENSITIVE_KEYS.has(foldKey(name));
}

/** The first segment of a '/'-separated relative path that is on the list, as spelled; null when none is. */
function sensitiveSegment(value) {
  if (typeof value !== 'string') return null;
  return value.split('/').find(isSensitiveSegment) ?? null;
}

function refuse(reason) {
  return { ok: false, reason };
}

function validateSegment(name) {
  if (typeof name !== 'string') return refuse('segment_not_string');
  if (name.length === 0) return refuse('segment_empty');
  if (Buffer.byteLength(name, 'utf8') > PATH_LIMITS.MAX_SEGMENT_BYTES) return refuse('segment_too_long');
  if (name === '.' || name === '..') return refuse('segment_dot');
  if (SEPARATORS.test(name)) return refuse('segment_separator');
  if (CONTROL.test(name) || !name.isWellFormed()) return refuse('segment_control');
  if (WIN32_INVALID.test(name)) return refuse('segment_character');
  if (TRAILING.test(name)) return refuse('segment_trailing');
  if (RESERVED.test(name)) return refuse('segment_reserved');
  return { ok: true };
}

function validateRelativePath(value) {
  if (typeof value !== 'string') return refuse('path_not_string');
  if (Buffer.byteLength(value, 'utf8') > PATH_LIMITS.MAX_BYTES) return refuse('path_too_long');
  if (value.startsWith('/')) return refuse('path_absolute');
  if (DRIVE.test(value)) return refuse('path_drive');
  const segments = value.split('/');
  if (segments.length > PATH_LIMITS.MAX_SEGMENTS) return refuse('path_too_deep');
  for (const segment of segments) {
    const result = validateSegment(segment);
    if (!result.ok) return result;
  }
  return { ok: true };
}

module.exports = {
  PATH_LIMITS, SEGMENT_REASONS, SENSITIVE_NAMES, foldKey, isSensitiveSegment, sensitiveSegment, validateRelativePath,
  validateSegment,
};
