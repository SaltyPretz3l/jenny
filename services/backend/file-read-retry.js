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
  unreadableReadResult,
};
