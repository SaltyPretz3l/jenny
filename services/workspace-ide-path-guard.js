'use strict';

const crypto = require('crypto');

const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');

// Whitespace in a name is identity, not padding: ` target.txt` and `target.txt`
// are different entries, so the path is never trimmed. Typed-input callers trim
// BEFORE calling. Win32 silently strips a trailing space/period (aliasing a
// different entry), so those names are rejected there rather than converted.
function normalizeWorkspaceRelPath(
  value,
  { strictName = false, relocationFrom = null, platform = process.platform } = {}
) {
  const input = String(value || '').replace(/\\/g, '/');
  const lead = input.trimStart();
  if (!lead || input.includes('\0') || lead.startsWith('/') || /^[A-Za-z]:/.test(lead)) {
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
      'Path must be a workspace-relative path.'
    );
  }
  const segments = input.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) {
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
      'Path must stay inside the workspace (no ".." segments).'
    );
  }
  if (platform === 'win32' && segments.some((segment) => /[. ]$/.test(segment))) {
    throw workspaceFsError(
      WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
      'A name can\'t end with a space or a period on Windows.'
    );
  }
  const normalized = segments.join('/');
  const inputLeaf = segments[segments.length - 1];
  // Relocation semantics: moving/copying an entry WITHOUT renaming it is not a
  // naming act — a POSIX-legal legacy leaf (e.g. `what?.txt`) must stay movable
  // and duplicable. When the destination leaf exactly equals the source leaf,
  // strict validation is skipped; only newly typed names are strict.
  const relocationLeaf = relocationFrom == null
    ? null
    : String(relocationFrom).replace(/\\/g, '/').split('/').filter(Boolean).pop() || null;
  const strict = strictName && (relocationLeaf == null || relocationLeaf !== inputLeaf);
  if (strict) {
    const leaf = segments[segments.length - 1];
    const hasControlChar = Array.prototype.some.call(inputLeaf, (ch) => ch.charCodeAt(0) < 0x20);
    if (hasControlChar || /[\\/:*?"<>|]/.test(inputLeaf)) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        'A name can\'t contain any of: \\ / : * ? " < > |'
      );
    }
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(leaf)) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        `"${leaf}" is a reserved name in Windows.`
      );
    }
    if (/[. ]$/.test(inputLeaf)) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        'A name can\'t end with a space or a period.'
      );
    }
    if (leaf.length > 255) {
      throw workspaceFsError(
        WORKSPACE_FS_ERROR_CODES.PATH_INVALID,
        'That name is too long (255 characters max).'
      );
    }
  }
  return normalized;
}

function buildPathLogHint(relPath) {
  const normalized = String(relPath || '');
  return {
    file_name: normalized.split('/').pop() || '',
    path_hash: crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12),
  };
}

function existsError(relPath) {
  return workspaceFsError(
    WORKSPACE_FS_ERROR_CODES.EXISTS,
    'A file or folder with that name already exists.',
    buildPathLogHint(relPath)
  );
}

module.exports = {
  normalizeWorkspaceRelPath,
  buildPathLogHint,
  existsError,
};
