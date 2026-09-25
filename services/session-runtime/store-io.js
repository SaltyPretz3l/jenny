'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MAX_INDEX_BYTES } = require('./contracts');

const STALE_TEMP_PATTERN = /^\.runtime-[0-9a-f]{24}\.tmp$/u;

function createRuntimeStoreIO({ fsImpl = fs, pathImpl = path } = {}) {
  function readJson(filePath, { maxBytes = MAX_INDEX_BYTES } = {}) {
    let descriptor;
    try {
      const beforePath = fsImpl.lstatSync(filePath);
      const resolvedPath = fsImpl.realpathSync(filePath);
      if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1) {
        throw new Error('invalid_runtime_document');
      }
      const flags = fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0)
        | (fsImpl.constants.O_NONBLOCK || 0);
      descriptor = fsImpl.openSync(filePath, flags);
      const stat = fsImpl.fstatSync(descriptor);
      const sameIdentity = (left, right) => !left.ino || !right.ino
        ? left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
        : left.dev === right.dev && left.ino === right.ino;
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || !sameIdentity(beforePath, stat)) {
        throw new Error('invalid_runtime_document');
      }
      const buffer = Buffer.allocUnsafe(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = fsImpl.readSync(descriptor, buffer, offset, buffer.length - offset, null);
        if (!count) break;
        offset += count;
      }
      const after = fsImpl.fstatSync(descriptor);
      const afterPath = fsImpl.lstatSync(filePath);
      if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
        || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1 || afterPath.isSymbolicLink()
        || !afterPath.isFile() || afterPath.nlink !== 1 || !sameIdentity(after, afterPath)
        || fsImpl.realpathSync(filePath) !== resolvedPath) {
        throw new Error('runtime_document_changed_during_read');
      }
      return { status: 'ok', value: JSON.parse(buffer.subarray(0, offset).toString('utf8')) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing' };
      return { status: 'corrupt', error };
    } finally {
      if (descriptor !== undefined) fsImpl.closeSync(descriptor);
    }
  }
  function writeJsonAtomic(filePath, value) {
    const directory = pathImpl.dirname(filePath);
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = fsImpl.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('invalid_runtime_store_directory');
    }
    const tempPath = pathImpl.join(directory, `.runtime-${crypto.randomBytes(12).toString('hex')}.tmp`);
    let descriptor;
    try {
      descriptor = fsImpl.openSync(tempPath, 'wx', 0o600);
      fsImpl.writeFileSync(descriptor, JSON.stringify(value), 'utf8');
      fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      fsImpl.renameSync(tempPath, filePath);
      if (process.platform !== 'win32') {
        const directoryDescriptor = fsImpl.openSync(directory, 'r');
        try { fsImpl.fsyncSync(directoryDescriptor); } finally { fsImpl.closeSync(directoryDescriptor); }
      }
    } finally {
      if (descriptor !== undefined) fsImpl.closeSync(descriptor);
      try { fsImpl.unlinkSync(tempPath); } catch (_error) { /* Best-effort cleanup. */ }
    }
  }
  function listJson(directory) {
    try {
      const stat = fsImpl.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_runtime_store_directory');
      return fsImpl.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => pathImpl.join(directory, entry.name));
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
  function sweepStaleTemp(directory) {
    let entries;
    try {
      const stat = fsImpl.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_runtime_store_directory');
      entries = fsImpl.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !STALE_TEMP_PATTERN.test(entry.name)) continue;
      fsImpl.unlinkSync(pathImpl.join(directory, entry.name));
      removed += 1;
    }
    return removed;
  }
  function remove(filePath) {
    try { fsImpl.unlinkSync(filePath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return Object.freeze({ listJson, readJson, remove, sweepStaleTemp, writeJsonAtomic });
}

module.exports = { STALE_TEMP_PATTERN, createRuntimeStoreIO };
