'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

// Host metadata only. Canonical conversations keep their existing store owner.
function readJson(filePath, { maxBytes = 8 * 1024 * 1024 } = {}) {
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
    const value = JSON.parse(buffer.subarray(0, offset).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_metadata_root');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeContents(filePath, content) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('invalid_metadata_directory');
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
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

function writeJson(filePath, value) { writeContents(filePath, JSON.stringify(value)); }
function writeText(filePath, value) {
  if (typeof value !== 'string') throw new TypeError('text_required');
  writeContents(filePath, value);
}

module.exports = { readJson, writeJson, writeText };
