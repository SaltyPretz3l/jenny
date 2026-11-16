'use strict';

// Reading and saving one file outside the Workspace (row 137).
//
// Reads reuse the versioned service's byte primitives: a bounded read on one
// handle, a stable-snapshot check, and the same opaque content-hash version
// token Workspace files use for conflict detection.
//
// Saves write IN PLACE on the existing file (open 'r+', write, truncate,
// fsync) instead of the Workspace's temp-file-and-rename. Replacing the file
// would drop its Zone.Identifier stream (Mark of the Web), attributes, ACLs
// and hard links, and a standard user cannot create a temp file in C:\ even
// where they may edit an existing one. Nothing is ever created next to the
// user's file. The trade-off, the same as VS Code's default: a power loss
// mid-write can truncate the file while the editor still holds the content.

const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { WORKSPACE_FS_ERROR_CODES } = require('../../backend/error-codes');
const { workspaceFsError } = require('../../workspace-ide-errors');
const {
  StableFileReadError,
  createFileVersion,
  readStableFileBytes,
  sameReadSnapshot,
} = require('../../versioned-workspace-file-bytes');
const { decodeOutsideText, encodeOutsideText } = require('./outside-file-encoding');

const DEFAULT_MAX_OUTSIDE_BYTES = 5 * 1024 * 1024;
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

function pathHint(realPath) {
  return {
    file_name: nodePath.basename(String(realPath || '')).slice(0, 256),
    path_hash: crypto.createHash('sha256').update(String(realPath || '')).digest('hex').slice(0, 12),
  };
}

function samePath(left, right, platform) {
  const a = String(left || '');
  const b = String(right || '');
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function osError(error, details) {
  const code = String(error?.code || '');
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return workspaceFsError(WORKSPACE_FS_ERROR_CODES.NOT_FOUND, 'The file is no longer there.', details);
  }
  if (code === 'EISDIR') {
    return workspaceFsError(WORKSPACE_FS_ERROR_CODES.NOT_A_FILE, 'That is a folder, not a file.', details);
  }
  if (PERMISSION_CODES.has(code)) {
    return workspaceFsError(WORKSPACE_FS_ERROR_CODES.IO_FAILED, 'Jenny is not allowed to open or change this file.', {
      ...details, reason: 'permission', os_code: code,
    });
  }
  if (error?.error_code) return error;
  return workspaceFsError(WORKSPACE_FS_ERROR_CODES.IO_FAILED, 'The file operation failed.', { ...details, os_code: code || 'unknown' });
}

function stableReadError(error, details, maxBytes) {
  if (error.reason === 'too_large') {
    return workspaceFsError(WORKSPACE_FS_ERROR_CODES.TOO_LARGE, 'The file is too large to open.', {
      ...details, size: Number(error.details?.size) || undefined, max_bytes: maxBytes,
    });
  }
  if (error.reason === 'not_regular_file') {
    return workspaceFsError(WORKSPACE_FS_ERROR_CODES.NOT_A_FILE, 'That is not a regular file.', details);
  }
  return workspaceFsError(WORKSPACE_FS_ERROR_CODES.IO_FAILED, 'The file changed while Jenny read it.', {
    ...details, reason: 'changed_during_read',
  });
}

// One stable snapshot of the file: bytes, stats, decoded text and version.
async function readOutsideSnapshot(realPath, {
  fs = fsPromises,
  maxBytes = DEFAULT_MAX_OUTSIDE_BYTES,
  platform = process.platform,
} = {}) {
  const details = pathHint(realPath);
  let currentReal;
  try {
    currentReal = await fs.realpath(realPath);
  } catch (error) {
    throw osError(error, details);
  }
  // The granted path was a real path; if it now resolves elsewhere (replaced
  // by a link or a junction), the grant no longer names the same file.
  if (!samePath(currentReal, realPath, platform)) {
    throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.NOT_FOUND, 'The file was moved or replaced.', { ...details, reason: 'path_redirected' });
  }
  let handle;
  try {
    handle = await fs.open(realPath, 'r');
  } catch (error) {
    throw osError(error, details);
  }
  try {
    const initialStats = await handle.stat();
    const { bytes, stats } = await readStableFileBytes({
      initialStats,
      maxBytes,
      readAt: (buffer, position) => handle.read(buffer, 0, buffer.length, position),
      statAfter: () => handle.stat(),
    });
    const decoded = decodeOutsideText(bytes, details);
    return { bytes, stats, decoded, fileVersion: createFileVersion(stats, bytes) };
  } catch (error) {
    if (error instanceof StableFileReadError) throw stableReadError(error, details, maxBytes);
    throw osError(error, details);
  } finally {
    await handle.close().catch(() => {});
  }
}

function snapshotMetadata(snapshot, { includeContent }) {
  const result = {
    size: Number(snapshot.stats.size),
    mtimeMs: Number(snapshot.stats.mtimeMs),
    fileVersion: snapshot.fileVersion,
    encoding: snapshot.decoded.encoding,
    eol: snapshot.decoded.eol,
    editable: snapshot.decoded.editable,
    truncated: false,
  };
  if (includeContent) result.content = snapshot.decoded.content;
  return result;
}

// Best effort after a failed in-place write (disk full, a dropped share): the original bytes go back so the
// file is not left half-written and the editor's version still matches it.
async function restoreOriginal(handle, original) {
  try {
    let offset = 0;
    while (offset < original.length) {
      const { bytesWritten } = await handle.write(original, offset, original.length - offset, offset);
      if (!(bytesWritten > 0)) return;
      offset += bytesWritten;
    }
    await handle.truncate(original.length);
    await handle.sync();
  } catch (_error) { /* the original error is reported; the editor still holds the content */ }
}

async function writeOutsideFileInPlace(realPath, {
  content,
  expectedFileVersion,
  fs = fsPromises,
  maxBytes = DEFAULT_MAX_OUTSIDE_BYTES,
  platform = process.platform,
} = {}) {
  const details = pathHint(realPath);
  if (typeof content !== 'string') {
    throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.UNSUPPORTED_ENCODING, 'Content must be text.', details);
  }
  const snapshot = await readOutsideSnapshot(realPath, { fs, maxBytes, platform });
  if (snapshot.fileVersion !== String(expectedFileVersion || '')) {
    throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT, 'File changed on disk since it was loaded.', {
      ...details, current_file_version: snapshot.fileVersion,
    });
  }
  const bytes = encodeOutsideText(content, snapshot.decoded.encoding, details);
  if (bytes.length > maxBytes) {
    throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.TOO_LARGE, 'The content is too large to save.', {
      ...details, size: bytes.length, max_bytes: maxBytes,
    });
  }
  if (bytes.equals(snapshot.bytes)) return { ...snapshotMetadata(snapshot, { includeContent: false }), stats: snapshot.stats };

  let handle;
  let after;
  let started = false;
  try {
    handle = await fs.open(realPath, 'r+');
  } catch (error) {
    throw osError(error, details);
  }
  try {
    // Same file, unchanged since the conflict check: a swap or an edit in the
    // gap is a conflict, never an overwrite.
    if (!sameReadSnapshot(snapshot.stats, await handle.stat())) {
      throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT, 'File changed on disk since it was loaded.', details);
    }
    let offset = 0;
    started = true;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
        throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.IO_FAILED, 'The file could not be written.', { ...details, reason: 'short_write' });
      }
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
    await handle.sync();
    after = await handle.stat();
  } catch (error) {
    if (started) await restoreOriginal(handle, snapshot.bytes);
    throw osError(error, details);
  } finally {
    await handle.close().catch(() => {});
  }
  // The new version comes from the bytes just written and the handle's final stats: no second read and hash.
  const saved = { bytes, stats: after, decoded: decodeOutsideText(bytes, details), fileVersion: createFileVersion(after, bytes) };
  return { ...snapshotMetadata(saved, { includeContent: false }), stats: after };
}

module.exports = {
  DEFAULT_MAX_OUTSIDE_BYTES,
  pathHint,
  readOutsideSnapshot,
  samePath,
  snapshotMetadata,
  writeOutsideFileInPlace,
};
