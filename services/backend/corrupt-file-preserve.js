'use strict';

const fs = require('fs');
const path = require('path');

const MAX_PRESERVED_COPIES = 3;
const PRESERVED_CORRUPT_SUFFIX = /\.corrupt-(\d{10,16})$/;

// `<name>.corrupt-<Date.now()>`: the damaged original of a store file, moved
// aside so a later write cannot replace the only copy of recoverable bytes.
function parsePreservedCorruptName(name) {
  const match = PRESERVED_CORRUPT_SUFFIX.exec(String(name || ''));
  if (!match) return null;
  return { baseName: String(name).slice(0, match.index), stampMs: Number(match[1]) };
}

function emit(logger, level, event, data) {
  if (typeof logger !== 'function') return;
  try { logger(level, event, data); } catch (_error) { /* diagnostics never change the outcome */ }
}

function prunePreservedCopies(filePath, maxCopies) {
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const copies = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && parsePreservedCorruptName(entry.name)?.baseName === baseName)
    .map((entry) => ({ name: entry.name, stampMs: parsePreservedCorruptName(entry.name).stampMs }))
    .sort((left, right) => right.stampMs - left.stampMs);
  for (const stale of copies.slice(maxCopies)) {
    fs.unlinkSync(path.join(dir, stale.name));
  }
}

// Moves a store file that exists but cannot be read or parsed to a sibling
// `<name>.corrupt-<ms>` and keeps the newest `maxCopies` of them. The rename
// stays inside the file's own directory. A caller that gets
// `{ preserved: false }` still has the damaged bytes at `filePath` and must not
// write over them. `{ preserved: false, reason: 'missing' }` means there was
// nothing to preserve.
function preserveCorruptFile(filePath, {
  now = Date.now,
  logger = null,
  maxCopies = MAX_PRESERVED_COPIES,
} = {}) {
  const target = path.resolve(String(filePath || ''));
  if (!String(filePath || '').trim()) return { preserved: false, reason: 'invalid_path' };
  let stampMs = Math.trunc(Number(now()));
  if (!Number.isFinite(stampMs) || stampMs <= 0) stampMs = Date.now();
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) return { preserved: false, reason: 'not_a_file' };
    let preservedPath = `${target}.corrupt-${stampMs}`;
    for (let attempt = 0; attempt < 8 && fs.existsSync(preservedPath); attempt += 1) {
      stampMs += 1;
      preservedPath = `${target}.corrupt-${stampMs}`;
    }
    fs.renameSync(target, preservedPath);
    emit(logger, 'ERROR', 'store.corrupt_file_preserved', {
      fileName: path.basename(target),
      preservedName: path.basename(preservedPath),
      bytes: stat.size,
    });
    try {
      prunePreservedCopies(target, Math.max(1, Math.trunc(Number(maxCopies)) || MAX_PRESERVED_COPIES));
    } catch (error) {
      emit(logger, 'WARN', 'store.corrupt_file_prune_failed', {
        fileName: path.basename(target),
        errorCode: String(error?.code || '').slice(0, 64),
      });
    }
    return { preserved: true, preservedPath };
  } catch (error) {
    if (error?.code === 'ENOENT') return { preserved: false, reason: 'missing' };
    emit(logger, 'ERROR', 'store.corrupt_file_preserve_failed', {
      fileName: path.basename(target),
      errorCode: String(error?.code || '').slice(0, 64),
    });
    return { preserved: false, reason: String(error?.code || 'preserve_failed').slice(0, 64) };
  }
}

const READ_RETRY_ATTEMPTS = 3;
const READ_RETRY_DELAY_MS = 100;

// A read error (file busy, access denied) says nothing about the bytes, so an
// `unreadable` read (already retried briefly inside readWithStatus) is tried
// again over a longer window before it is reported. A parse failure
// (`corrupted`) is final and is not retried. `store` is a FileJsonStore.
function readWithRetry(store, defaultValue, {
  attempts = READ_RETRY_ATTEMPTS,
  delayMs = READ_RETRY_DELAY_MS,
} = {}) {
  let result = store.readWithStatus(defaultValue);
  for (let attempt = 1; attempt < attempts && result.unreadable; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    result = store.readWithStatus(defaultValue);
  }
  return result;
}

module.exports = {
  MAX_PRESERVED_COPIES,
  parsePreservedCorruptName,
  preserveCorruptFile,
  readWithRetry,
};
