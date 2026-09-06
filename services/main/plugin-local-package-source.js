'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const nodePath = require('node:path');

const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

function fail(reason, code = PLUGIN_ERROR_CODES.INTEGRITY_FAILED) {
  return { ok: false, code, reason };
}

function normalizedPathDigest(filePath, pathImpl = nodePath) {
  let normalized = pathImpl.normalize(pathImpl.resolve(filePath)).normalize('NFC');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function sameSnapshot(before, after) {
  const identityComparable = Number.isSafeInteger(before.ino) && before.ino !== 0
    && Number.isSafeInteger(after.ino) && after.ino !== 0;
  return before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && (!identityComparable || (before.dev === after.dev && before.ino === after.ino));
}

async function readOpenedFile(handle, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (!read || read.bytesRead < 1) return fail('package_read_truncated');
    offset += read.bytesRead;
  }
  return { ok: true, bytes };
}

function createPluginLocalPackageSource({
  dialog,
  openFile = fs.promises.open,
  pathImpl = nodePath,
} = {}) {
  return async function selectLocalPackage() {
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      return fail('package_picker_unavailable');
    }
    let selection;
    try {
      selection = await dialog.showOpenDialog({
        title: 'Install Jenny plugin',
        filters: [{ name: 'Jenny plugin package', extensions: ['jenny-plugin'] }],
        properties: ['openFile', 'dontAddToRecent'],
      });
    } catch (_error) {
      return fail('package_picker_failed');
    }
    if (!selection || selection.canceled === true || !Array.isArray(selection.filePaths) || selection.filePaths.length === 0) {
      return { ok: true, canceled: true, changed: false };
    }
    if (selection.filePaths.length !== 1) return fail('package_picker_selection_invalid');
    return readPackageAtPath(pathImpl.resolve(selection.filePaths[0]), { openFile, pathImpl });
  };
}

async function readPackageAtPath(selectedPath, {
  openFile = fs.promises.open,
  pathImpl = nodePath,
} = {}) {
  if (typeof selectedPath !== 'string' || pathImpl.extname(selectedPath).toLowerCase() !== '.jenny-plugin') {
    return fail('package_extension_invalid', PLUGIN_ERROR_CODES.ARCHIVE_REJECTED);
  }
  if (!pathImpl.isAbsolute(selectedPath)) {
    return fail('package_path_not_absolute', PLUGIN_ERROR_CODES.ARCHIVE_REJECTED);
  }
  let handle;
  try {
    handle = await openFile(selectedPath, 'r');
    const before = await handle.stat();
    if (!before.isFile()) return fail('package_source_not_regular_file');
    if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > MAX_ARCHIVE_BYTES) {
      return fail('package_source_size_invalid', PLUGIN_ERROR_CODES.ARCHIVE_REJECTED);
    }
    const read = await readOpenedFile(handle, before.size);
    if (!read.ok) return read;
    const after = await handle.stat();
    if (!sameSnapshot(before, after)) return fail('package_source_changed_during_read');
    return { ok: true, canceled: false, changed: false, bytes: read.bytes,
      sourcePathDigest: normalizedPathDigest(selectedPath, pathImpl) };
  } catch (_error) {
    return fail('package_source_read_failed');
  } finally {
    if (handle) {
      try { await handle.close(); } catch (_error) { /* best effort */ }
    }
  }
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  normalizedPathDigest,
  sameSnapshot,
  readPackageAtPath,
  createPluginLocalPackageSource,
};
