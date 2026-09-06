import fs from 'node:fs';
import { Buffer } from 'node:buffer';

function sameFile(left, right) {
  if (!left || !right || left.size !== right.size) return false;
  if (Number.isFinite(left.ino) && Number.isFinite(right.ino)
    && left.ino !== 0 && right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function readStableBoundedFile(filePath, maxBytes, { fsImpl = fs } = {}) {
  let before;
  try { before = fsImpl.lstatSync(filePath); } catch (_error) {
    return { ok: false, reason: 'unavailable' };
  }
  if (!before.isFile() || before.isSymbolicLink()) return { ok: false, reason: 'type' };
  if (!Number.isSafeInteger(before.size) || before.size <= 0 || before.size > maxBytes) {
    return { ok: false, reason: 'size' };
  }
  let descriptor;
  try {
    descriptor = fsImpl.openSync(filePath, 'r');
    const opened = fsImpl.fstatSync(descriptor);
    if (!opened.isFile() || !sameFile(before, opened)) return { ok: false, reason: 'changed' };
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fsImpl.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(count) || count <= 0) break;
      offset += count;
    }
    const after = fsImpl.fstatSync(descriptor);
    if (offset !== bytes.length || !sameFile(opened, after)) {
      return { ok: false, reason: 'changed' };
    }
    return { ok: true, bytes };
  } catch (_error) {
    return { ok: false, reason: 'unavailable' };
  } finally {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch (_error) { /* best effort */ }
    }
  }
}
