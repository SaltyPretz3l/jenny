'use strict';

// The path matcher behind a team project's "Always allowed" rules (slice 3-12, TEAM_PROJECTS_SPEC "3-12 as built").
// Pure: no filesystem call. It answers whether a write_file or edit_file call's path lies in a rule's place, and is
// never more permissive than the sidecar's own confinement: anything it cannot compare safely is no target, and a
// call with no target is asked of a person.
//
// How the sidecar takes a hosted path (sidecar/ai/tools/workspace.py `_resolve_path`): it strips surrounding space
// (Python `str.strip()`), expands a leading `~`, may read `/src/a.py` as `src/a.py` when only the second exists (row
// 129), joins a relative path to the root and resolves it, and refuses symlinks and reparse points on a mutation
// path. So this matcher refuses a path with surrounding space, a leading `~`, a NUL, an empty or `..` segment, a
// segment the upload segment rules refuse (a Windows rename such as a trailing dot or a `:` stream, a reserved device
// name, a control character), and an absolute path not spelled under the project root exactly. A `.` segment is
// dropped (a no-op for the sidecar too).
//
// Characters: a path holding a C1 control (U+0080-009F), a line or paragraph separator (U+2028/2029), a bidi control
// (U+202A-202E, U+2066-2069), a zero-width character (U+200B-200D, U+FEFF) or a lone surrogate, anywhere, is no
// target. JS `trim()` and Python `str.strip()` differ only on U+001C-001F and U+0085 (Python strips them) and U+FEFF
// (JS trims it); every one of those is refused here, so no surrounding character is read differently.
//
// Hidden folders (owner, 2026-11-13): a path with any segment that starts with a dot (`.git`, `.github`, `.env`, a
// dot-file at any depth) is no target, whatever the rule; a rule's folder may not name one either.
//
// Comparison is exact, code unit for code unit, on every platform: no case folding and no Unicode normalization.
// On a case-insensitive volume (Windows, macOS) or a normalizing one, a spelling that differs from the rule's folder
// may reach the same folder; it is not matched, so a person is asked. A match therefore never names a place the
// rule did not name. On Windows a backslash is a separator; on Linux it is a file-name character and is refused.

const { validateRelativePath, validateSegment } = require('./path-segments');

// The tools a rule may cover: the one list (api-contract.js, the store, the port and services/backend/team-rule-gate.js).
const RULE_TOOL_NAMES = Object.freeze(['edit_file', 'write_file']);
const isRuleTool = (name) => RULE_TOOL_NAMES.includes(name);
// The fields a ruled tool names its file in (chat-stream-exact-approval.js EXACT_APPROVAL_FIELDS).
const PATH_FIELDS = Object.freeze(['path', 'file_path']);
const FOLDER_LIMITS = Object.freeze({ MAX_SEGMENTS: 8, MAX_CHARS: 255 });
const MAX_PATH_CHARS = 4096;
const WIN_ABSOLUTE = /^[A-Za-z]:\//u;
const WIN_DRIVE = /^[A-Za-z]:/u;
// C1 controls, line/paragraph separators, bidi controls and zero-width characters (lone surrogates: isWellFormed).
const UNSAFE_CHARACTERS = /[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/u;

const folderInvalid = () => ({ ok: false, reason: 'team_rule_folder_invalid' });
const hidden = (segment) => segment.startsWith('.');
const unsafeText = (value) => !value.isWellFormed() || UNSAFE_CHARACTERS.test(value);

// A rule's folder as an admin typed it: null for "anywhere in this project", else a relative path of 1 to 8
// segments and at most 255 characters that passes the upload segment rules, with no hidden segment and none of the
// characters above. Stored exactly as given.
function validateFolder(value) {
  if (value === null) return { ok: true, folder: null };
  if (typeof value !== 'string' || value.length === 0 || value.length > FOLDER_LIMITS.MAX_CHARS) return folderInvalid();
  const segments = value.split('/');
  if (segments.length > FOLDER_LIMITS.MAX_SEGMENTS || !validateRelativePath(value).ok) return folderInvalid();
  if (unsafeText(value) || segments.some(hidden)) return folderInvalid();
  return { ok: true, folder: value };
}

function trimRoot(root, platform) {
  if (typeof root !== 'string' || root.length === 0) return null;
  const forward = platform === 'win32' ? root.replace(/\\/gu, '/') : root;
  const trimmed = forward.replace(/\/+$/u, '');
  const absolute = platform === 'win32' ? WIN_ABSOLUTE.test(`${trimmed}/`) : trimmed.startsWith('/');
  return absolute && trimmed.length > 0 ? trimmed : null;
}

// The project-relative segments of one path value, or null when it cannot be compared safely.
function targetSegments(value, { root = null, platform = process.platform } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_CHARS) return null;
  if (value.trim() !== value || value.includes('\u0000') || value.startsWith('~') || unsafeText(value)) return null;
  const text = platform === 'win32' ? value.replace(/\\/gu, '/') : value;
  let rest = text;
  const absolute = platform === 'win32' ? text.startsWith('/') || WIN_DRIVE.test(text) : text.startsWith('/');
  if (absolute) {
    const base = trimRoot(root, platform);
    if (base === null || !text.startsWith(`${base}/`)) return null;
    rest = text.slice(base.length + 1);
  }
  const segments = rest.split('/').filter((segment) => segment !== '.');
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (!validateSegment(segment).ok || hidden(segment)) return null;
  }
  return segments;
}

// The target of a ruled tool call: the segments of its one path, or null. A call naming both `path` and `file_path`
// is a target only when they are the same text.
function ruleTarget(toolName, input, options = {}) {
  if (!isRuleTool(toolName) || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  const values = PATH_FIELDS.filter((field) => Object.hasOwn(input, field) && input[field] !== undefined)
    .map((field) => input[field]);
  if (values.length === 0 || values.some((value) => value !== values[0])) return null;
  return targetSegments(values[0], options);
}

// True when a rule's folder (null: anywhere) holds the target: every folder segment equals the target's at the same
// place, and the target goes at least one segment deeper.
function folderCovers(folder, segments) {
  if (!Array.isArray(segments) || segments.length === 0) return false;
  if (folder === null) return true;
  const parts = folder.split('/');
  return segments.length > parts.length && parts.every((part, index) => segments[index] === part);
}

module.exports = { RULE_TOOL_NAMES, folderCovers, isRuleTool, ruleTarget, targetSegments, validateFolder };
