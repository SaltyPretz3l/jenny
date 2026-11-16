'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

// The one form an fs error takes in a log line (review sweeps, second run, X1-F02): its code when that is a short
// upper-case word (ENOENT, EPERM), else a fixed word; never the Error, its message, its syscall or its path. A thrown
// error keeps its Error `cause` (the cleanup failure below); a caller that logs one logs `errorCode(cause)`.
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/u;
function errorCode(error) {
  const code = typeof error === 'string' ? error : error?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : 'error_uncoded';
}

// The bytes of a regular single-name file of at most `maxBytes`, opened without following a link and unchanged while
// it was read; null when there is no file.
function readBytes(filePath, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('invalid_metadata_file');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (offset !== stat.size || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs
      || after.mtimeMs !== stat.mtimeMs || after.nlink !== 1) throw new Error('metadata_changed_during_read');
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Host metadata only. Canonical conversations keep their existing store owner.
function readJson(filePath, options) {
  const bytes = readBytes(filePath, options);
  if (bytes === null) return null;
  const value = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_metadata_root');
  return value;
}

// `makeDirectory: false` writes only into a folder that already exists (the caller made and checked it).
function writeContents(filePath, content, { makeDirectory = true } = {}) {
  const directory = path.dirname(filePath);
  if (makeDirectory) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('invalid_metadata_directory');
  if (makeDirectory && process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  const temp = path.join(directory, `.host-${randomBytes(16).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, filePath);
    // Directory fsync is required for Linux container crash durability. Windows
    // is a development host and cannot open directories through this Node API.
    if (process.platform !== 'win32') {
      const directoryFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } catch (error) {
    if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
    try { fs.unlinkSync(temp); } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'metadata_write_failed', { cause: cleanupError });
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Renames a file to a new name in the same directory and syncs the directory
// where the platform allows. Refuses a target that already exists.
function renameDurable(fromPath, toPath) {
  const directory = path.dirname(fromPath);
  if (path.dirname(toPath) !== directory) throw new Error('rename_cross_directory');
  try {
    fs.lstatSync(toPath);
    throw Object.assign(new Error('rename_target_exists'), { code: 'EEXIST' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.renameSync(fromPath, toPath);
  if (process.platform !== 'win32') {
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
}

function writeJson(filePath, value) { writeContents(filePath, JSON.stringify(value)); }
function writeText(filePath, value) {
  if (typeof value !== 'string') throw new TypeError('text_required');
  writeContents(filePath, value);
}
// Bytes into a folder that already exists: never makes a folder.
function writeBytes(filePath, bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes_required');
  writeContents(filePath, bytes, { makeDirectory: false });
}

// A log field for a failure's cause or code: null, a fixed lower-case token, or an fs code word.
const logCode = (value) => (value === undefined || value === null ? null
  : typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value) ? value : errorCode(value));

module.exports = { errorCode, logCode, readBytes, readJson, writeBytes, writeJson, writeText, renameDurable };
