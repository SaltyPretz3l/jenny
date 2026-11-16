'use strict';

const fs = require('fs');

// Read errors another process (antivirus, backup software, a second reader) or
// a momentary handle shortage can cause. The bytes may be perfectly healthy,
// so such a read is retried briefly before it is given up.
const TRANSIENT_READ_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN']);
// Synchronous backoff between attempts: 80 ms worst case per read.
const READ_RETRY_DELAYS_MS = Object.freeze([20, 60]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientReadError(error) {
  return TRANSIENT_READ_ERROR_CODES.has(error?.code);
}

// Reads `filePath` as UTF-8 (`encoding: null` for a Buffer). A transient error
// is retried after each delay in `delaysMs`; any other error (including ENOENT)
// throws at once, and the last transient error throws once the delays run out.
function readFileWithRetry(filePath, { delaysMs = READ_RETRY_DELAYS_MS, sleep = sleepSync, encoding = 'utf8' } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fs.readFileSync(filePath, encoding);
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransientReadError(error)) throw error;
      sleep(delaysMs[attempt]);
    }
  }
}

// The write-side twin, used by FileJsonStore's synchronous writes (flush at
// exit, no debounce). On Windows a rename onto a file that antivirus, the
// indexer or another reader holds open fails for a moment, so it is retried
// briefly (230 ms worst case) instead of losing the write (LFM3 image chat
// findings F5: shell-config.json EBUSY at exit, 2026-11-13). The same codes as
// a read count as transient; any other error throws at once. A target whose
// retries ran out gets single tries for a while, so a lasting lock does not
// stall the main thread 230 ms on every write; a success clears that.
const RENAME_RETRY_DELAYS_MS = Object.freeze([20, 60, 150]);
const RENAME_RETRY_COOLDOWN_MS = 5_000;
const renameRetryExhaustedAt = new Map(); // target path -> ms; only paths still locked, a success deletes

function renameWithRetrySync(from, to, { delaysMs = RENAME_RETRY_DELAYS_MS, sleep = sleepSync, now = Date.now } = {}) {
  const coolingDown = now() - (renameRetryExhaustedAt.get(to) ?? -Infinity) < RENAME_RETRY_COOLDOWN_MS;
  const delays = coolingDown ? [] : delaysMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      renameRetryExhaustedAt.delete(to);
      return;
    } catch (error) {
      if (!isTransientReadError(error)) throw error;
      if (attempt >= delays.length) {
        if (delays.length) renameRetryExhaustedAt.set(to, now());
        throw error;
      }
      sleep(delays[attempt]);
    }
  }
}

// FileJsonStore.readWithStatus result for a file that exists but could not be
// read. Nothing is known about its bytes, so it is never reported as corrupted:
// callers must not move, replace or overwrite it, and a later read tries again.
function unreadableReadResult(filePath, error, defaultValue, logger) {
  const errorCode = (error && error.code) || null;
  const errorMessage = (error && error.message) || String(error);
  try {
    console.error(`FileJsonStore: could not read ${filePath}: ${errorMessage}`);
  } catch (logError) {
    void logError;
  }
  if (logger) {
    try {
      logger('WARN', 'store.unreadable', { filePath, errorCode, errorMessage });
    } catch (loggerError) {
      void loggerError;
    }
  }
  return {
    value: defaultValue,
    missing: false,
    corrupted: false,
    unreadable: true,
    errorCode,
    errorMessage,
  };
}

// FileJsonStore.readWithStatus result for bytes that were read but do not parse.
// `options.redactMessage`: V8's JSON.parse message quotes the offending bytes,
// so a store holding user text (project notes) logs a fixed line instead.
function corruptedReadResult(filePath, error, defaultValue, logger, options) {
  const errorCode = (error && error.code) || null;
  const errorMessage = options?.redactMessage === true
    ? `[redacted: ${(error && error.name) || 'SyntaxError'}]`
    : (error && error.message) || String(error);
  try {
    console.error(`FileJsonStore: failed to read ${filePath}: ${errorMessage}`);
  } catch (logError) {
    void logError;
  }
  if (logger) {
    try {
      logger('WARN', 'store.corrupted', { filePath, errorCode, errorMessage });
    } catch (loggerError) {
      void loggerError;
    }
  }
  return { value: defaultValue, missing: false, corrupted: true, errorCode, errorMessage };
}

module.exports = {
  READ_RETRY_DELAYS_MS,
  TRANSIENT_READ_ERROR_CODES,
  corruptedReadResult,
  isTransientReadError,
  readFileWithRetry,
  renameWithRetrySync,
  unreadableReadResult,
};
