'use strict';

const fs = require('node:fs');

function sameFileSnapshot(before, after) {
  if (!before || !after || before.size !== after.size
    || before.isFile() !== after.isFile()) return false;
  if (Number.isFinite(before.ino) && Number.isFinite(after.ino)
    && before.ino !== 0 && after.ino !== 0) {
    return before.dev === after.dev && before.ino === after.ino
      && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
  }
  return before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function readBoundedRegularFile({ fsImpl = fs, filePath, maxBytes } = {}) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(String(filePath || ''), 'r');
    const before = fsImpl.fstatSync(descriptor);
    if (!before.isFile()) return { ok: false, reason: 'type' };
    if (!Number.isSafeInteger(before.size) || before.size <= 0 || before.size > maxBytes) {
      return { ok: false, reason: 'size' };
    }
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fsImpl.readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) break;
      offset += count;
    }
    const after = fsImpl.fstatSync(descriptor);
    if (offset !== buffer.length || !sameFileSnapshot(before, after)) {
      return { ok: false, reason: 'raced' };
    }
    return { ok: true, buffer };
  } catch (_error) {
    return { ok: false, reason: 'unavailable' };
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch (_error) { /* best effort */ }
    }
  }
}

module.exports = { readBoundedRegularFile, sameFileSnapshot };
