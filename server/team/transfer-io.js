'use strict';

// The checked file IO of the team transfer core (slice 6-1, a pure move out of
// `transfer-core.js`, TEAM_MODEL_SHARING_SPEC MS4). It opens a staging file
// without following a link, checks it with `fstat` before work (a regular
// file, one link, the size the caller expects), writes a part at an offset,
// and hashes a file as a stream in 1 MiB chunks with the same check before and
// after. Phase 6's receiver uses the same pieces.
//
// The part protocol (part sizes, the pending cap, a part only at the file's
// current length) stays in the core: it reads per-upload state. This module
// knows no upload, owner or path rule; the caller has already built and
// checked every path it passes. It logs nothing. `StagingChanged` carries a
// code only; any other error is a raw Node error whose message holds the
// path, so a caller logs its code, never its message.

const crypto = require('node:crypto');
const fs = require('node:fs');

const { openNoFollow } = require('./file-checks');

const HASH_CHUNK_BYTES = 1024 * 1024;
// file-checks.js `openNoFollow` adds O_NOFOLLOW off Windows and its checks before and after on Windows.
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
const APPEND_FLAGS = fs.constants.O_WRONLY;
const READ_FLAGS = fs.constants.O_RDONLY;

class StagingChanged extends Error {
  constructor() {
    super('staging_changed');
    this.code = 'staging_changed';
  }
}

async function checkedStat(handle, size) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size) throw new StagingChanged();
}

/**
 * Create the IO helpers. `onHandle(delta)` is told +1 after each open and -1
 * before each close, so the caller's open-handle count stays exact on every
 * path, throws included.
 */
function createTransferIo({ onHandle = () => {} } = {}) {
  if (typeof onHandle !== 'function') throw new TypeError('onHandle must be a function.');

  async function withHandle(filePath, flags, work) {
    const handle = await openNoFollow(filePath, flags, 0o600);
    onHandle(1);
    try {
      return await work(handle);
    } finally {
      onHandle(-1);
      await handle.close();
    }
  }

  // Offset 0 creates the file exclusively; any other offset appends to a file
  // that must be exactly `offset` bytes long.
  async function writeAt(filePath, offset, bytes) {
    await withHandle(filePath, offset === 0 ? CREATE_FLAGS : APPEND_FLAGS, async (handle) => {
      await checkedStat(handle, offset);
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, offset + written);
        if (bytesWritten <= 0) throw new StagingChanged();
        written += bytesWritten;
      }
    });
  }

  // Size 0 creates the file exclusively and hashes nothing.
  async function hashFile(filePath, size) {
    if (size === 0) {
      await withHandle(filePath, CREATE_FLAGS, (handle) => checkedStat(handle, 0));
      return crypto.createHash('sha256').digest('hex');
    }
    return withHandle(filePath, READ_FLAGS, async (handle) => {
      await checkedStat(handle, size);
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, size));
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > size) throw new StagingChanged();
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (total !== size) throw new StagingChanged();
      await checkedStat(handle, size);
      return hash.digest('hex');
    });
  }

  return Object.freeze({ withHandle, checkedStat, writeAt, hashFile });
}

module.exports = {
  APPEND_FLAGS,
  CREATE_FLAGS,
  HASH_CHUNK_BYTES,
  READ_FLAGS,
  StagingChanged,
  checkedStat,
  createTransferIo,
};
