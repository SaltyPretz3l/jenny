const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { notifyWriteMeasured } = require('./session-write-meter');
const { corruptedReadResult, readFileWithRetry, unreadableReadResult } = require('./file-read-retry');
const MAX_FLUSH_PASSES = 8;

function buildTempPath(filePath) {
  return `${filePath}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

// Stable-storage barrier for a freshly written file. Rename alone protects
// against a process crash; the bytes must also be flushed before the rename
// publishes them, or a power loss can leave a published but empty file.
function syncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function syncFileAsync(filePath) {
  const handle = await fs.promises.open(filePath, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Best-effort flush of the rename itself. Windows cannot open directories, and
// the data file is already flushed, so a failure here never fails the write.
function syncDirectory(dirPath) {
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(dirPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (directoryError) {
    void directoryError;
  }
}

async function syncDirectoryAsync(dirPath) {
  if (process.platform === 'win32') return;
  try {
    const handle = await fs.promises.open(dirPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (directoryError) {
    void directoryError;
  }
}

// Optional logger contract: logger(level, event, data) matches the
// `_emitServiceLog` signature used by services/backend/. `console.error`
// remains a safety net so a missing logger never silences corruption.
//
// Optional `writeDebounceMs` enables trailing-edge write coalescing: bursts of
// `write()` calls collapse into a single async disk write per debounce window.
// The in-memory state is up-to-date immediately; only the disk snapshot is
// delayed. Callers should drain pending async writes via `flushAsync()` /
// `disposeAsync()` before process exit or before reading the file from a
// different instance. `flush()` / `dispose()` remain synchronous crash-safety
// drains for pending or in-flight values. `writeImmediate(value)` bypasses debouncing
// for crash-safety-critical writes; it cancels any pending debounced write so
// the immediate value wins.
class FileJsonStore {
  constructor(filePath, options) {
    this.filePath = filePath;
    const logger = options && typeof options.logger === 'function' ? options.logger : null;
    this._logger = logger;
    // Stores of user-authored text keep the unparsable bytes out of every log line.
    this._redactReadErrors = options?.redactReadErrors === true;
    this._onWriteSettled = typeof options?.onWriteSettled === 'function' ? options.onWriteSettled : null;
    // Observation-only hook: { bytes, ms, serializeMs, sync } after each successful disk write.
    this._onWriteMeasured = typeof options?.onWriteMeasured === 'function' ? options.onWriteMeasured : null;
    // High-churn machine-only stores (sessions, the session index, usage
    // history) skip pretty-printing: every rewrite is 20-30% fewer bytes.
    this._jsonIndent = options?.compact === true ? undefined : 2;
    const rawDebounce = options && options.writeDebounceMs;
    this._writeDebounceMs = Number.isFinite(Number(rawDebounce))
      ? Math.max(0, Math.trunc(Number(rawDebounce)))
      : 0;
    this._pendingWriteValue = undefined;
    this._hasPendingWrite = false;
    this._debounceTimer = null;
    this._asyncWriteChain = Promise.resolve();
    this._asyncWriteCount = 0;
    this._queuedAsyncWrite = null;
    this._drainStep = null;
    this._resolveDrainStep = null;
    this._writeGeneration = 0;
    this._durableGeneration = 0;
    this._failedGeneration = 0;
    this._lastImmediateGeneration = 0;
    this._lastImmediateValue = undefined;
    this._deleteGeneration = 0;
    this._disposed = false;
    // Read-your-writes buffer: the newest value handed to write() that has not
    // yet completed its disk write. While any write is pending or in flight,
    // readWithStatus() serves this instead of the (stale) disk bytes — a read
    // during the debounce window must never observe pre-write state, because an
    // evicted session cache could reload stale disk bytes and revert a committed
    // message.
    this._lastUnflushedValue = undefined;
  }

  read(defaultValue) {
    return this.readWithStatus(defaultValue).value;
  }

  // Like read(), but reports WHY the default was returned so callers can
  // distinguish a missing file, an `unreadable` one (the read itself failed,
  // after a brief retry of transient errors) and a `corrupted` one (the bytes
  // were read and do not parse), e.g. to quarantine only corrupt bytes.
  readWithStatus(defaultValue) {
    if (this.hasPendingWrite() && this._lastUnflushedValue !== undefined) {
      return {
        // Clone so callers cannot mutate the buffer that is about to be
        // serialized to disk (parity with the fresh-parse disk path).
        value: JSON.parse(JSON.stringify(this._lastUnflushedValue)),
        missing: false,
        corrupted: false,
        errorCode: null,
        errorMessage: null,
      };
    }
    let raw;
    try {
      raw = readFileWithRetry(this.filePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          value: defaultValue,
          missing: true,
          corrupted: false,
          errorCode: 'ENOENT',
          errorMessage: error.message || String(error),
        };
      }
      // The file exists but could not be read (locked, access denied): that
      // says nothing about its bytes, so it is `unreadable`, never `corrupted`.
      return unreadableReadResult(this.filePath, error, defaultValue, this._logger);
    }
    try {
      return {
        value: JSON.parse(raw),
        missing: false,
        corrupted: false,
        errorCode: null,
        errorMessage: null,
      };
    } catch (error) {
      // The bytes were read but do not parse; surface for diagnostics.
      return corruptedReadResult(this.filePath, error, defaultValue, this._logger, { redactMessage: this._redactReadErrors });
    }
  }

  write(value) {
    this._assertWritable();
    this._writeGeneration += 1;
    const generation = this._writeGeneration;
    this._deleteGeneration = 0;
    this._clearImmediateCorrection();
    if (this._writeDebounceMs <= 0) {
      try {
        this._writeNow(value);
        this._durableGeneration = generation;
        this._failedGeneration = 0;
      } catch (error) {
        this._failedGeneration = generation;
        throw error;
      }
      this._notifyWriteSettled();
      return { generation, durable: true };
    }
    this._queuedAsyncWrite = null;
    this._pendingWriteValue = value;
    this._lastUnflushedValue = value;
    this._hasPendingWrite = true;
    if (this._debounceTimer == null) {
      this._debounceTimer = setTimeout(
        () => this._handleDebounceTimerFired(),
        this._writeDebounceMs
      );
    }
    return { generation, durable: false };
  }

  writeImmediate(value) {
    this._assertWritable();
    this._cancelDebounce();
    this._writeGeneration += 1;
    this._deleteGeneration = 0;
    if (this._asyncWriteCount > 0) {
      this._lastImmediateGeneration = this._writeGeneration;
      this._lastImmediateValue = value;
      // Older async writes are still draining: keep serving the newest value
      // to readers until the chain settles.
      this._lastUnflushedValue = value;
    } else {
      this._clearImmediateCorrection();
      this._lastUnflushedValue = undefined;
    }
    try {
      this._writeNow(value);
      this._durableGeneration = this._writeGeneration;
      this._failedGeneration = 0;
      if (this._asyncWriteCount > 0) {
        this._lastImmediateGeneration = this._writeGeneration;
        this._lastImmediateValue = value;
        this._lastUnflushedValue = value;
      }
    } catch (error) {
      this._failedGeneration = this._writeGeneration;
      throw error;
    }
    this._notifyWriteSettled();
    return { generation: this._writeGeneration, durable: true };
  }

  flush() {
    if (this._disposed) return false;
    if (this._debounceTimer != null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (!this._hasPendingWrite && (
      this._asyncWriteCount === 0 || this._durableGeneration === this._writeGeneration
    )) {
      return false;
    }
    const value = this._hasPendingWrite ? this._pendingWriteValue : this._lastUnflushedValue;
    this._pendingWriteValue = undefined;
    this._hasPendingWrite = false;
    this._queuedAsyncWrite = null;
    try {
      this._writeNow(value);
      this._durableGeneration = this._writeGeneration;
      this._failedGeneration = 0;
    } catch (error) {
      // Keep failed durability work observable and retryable. Callers such as
      // session deletion can now distinguish "already flushed" from a write
      // that was attempted but did not reach disk.
      this._pendingWriteValue = value;
      this._lastUnflushedValue = value;
      this._hasPendingWrite = true;
      throw error;
    }
    if (this._asyncWriteCount === 0) {
      this._lastUnflushedValue = undefined;
    } else {
      this._lastImmediateGeneration = this._writeGeneration;
      this._lastImmediateValue = value;
    }
    this._notifyWriteSettled();
    return true;
  }

  async flushAsync() {
    if (this._disposed) return false;
    // Writes accepted after this call are a later flush's job; the pass cap
    // stops a writer that supersedes every snapshot from holding the flush.
    const target = this._writeGeneration;
    let wroteAny = false;
    let passes = 0;
    do {
      if (this._debounceTimer != null) {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
      }
      if (this._hasPendingWrite) {
        const value = this._pendingWriteValue;
        const generation = this._writeGeneration;
        this._pendingWriteValue = undefined;
        this._hasPendingWrite = false;
        this._enqueueAsyncWrite(value, generation);
        wroteAny = true;
      }
      if (this._asyncWriteCount > 0) {
        wroteAny = true;
        // One write at a time: the drain may keep consuming later writes, so the
        // flush re-checks its target after each instead of awaiting the drain.
        await this._nextDrainStep();
      }
      passes += 1;
    } while (
      this.hasPendingWrite()
      && this._durableGeneration < target
      && this._failedGeneration < target
      && passes < MAX_FLUSH_PASSES
    );
    return wroteAny;
  }

  hasPendingWrite() {
    return this._hasPendingWrite || this._asyncWriteCount > 0;
  }

  getWriteState() {
    return {
      acceptedGeneration: this._writeGeneration,
      durableGeneration: this._durableGeneration,
      failedGeneration: this._failedGeneration,
      pending: this.hasPendingWrite(),
    };
  }

  replacePendingValue(value) {
    if (!this._hasPendingWrite || this._debounceTimer == null) return false;
    this._pendingWriteValue = value;
    this._lastUnflushedValue = value;
    return true;
  }

  dispose() {
    if (this._disposed) return;
    if (this._debounceTimer != null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._hasPendingWrite || this._asyncWriteCount > 0) {
      const value = this._lastUnflushedValue !== undefined
        ? this._lastUnflushedValue
        : this._pendingWriteValue;
      if (value === undefined) { this._disposed = true; return; }
      this._pendingWriteValue = undefined;
      this._hasPendingWrite = false;
      this._queuedAsyncWrite = null;
      try {
        this._writeNow(value);
        this._durableGeneration = this._writeGeneration;
        this._failedGeneration = 0;
      } catch (error) {
        this._pendingWriteValue = value;
        this._lastUnflushedValue = value;
        this._hasPendingWrite = true;
        throw error;
      }
      if (this._asyncWriteCount > 0) {
        this._lastImmediateGeneration = this._writeGeneration;
        this._lastImmediateValue = value;
      } else {
        this._lastUnflushedValue = undefined;
      }
      this._notifyWriteSettled();
    }
    this._disposed = true;
  }

  async disposeAsync() {
    if (this._disposed) return;
    await this.flushAsync();
    this._disposed = true;
  }

  delete() {
    this._cancelDebounce();
    this._writeGeneration += 1;
    this._deleteGeneration = this._writeGeneration;
    this._clearImmediateCorrection();
    this._lastUnflushedValue = undefined;
    try {
      fs.unlinkSync(this.filePath);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }
    this._durableGeneration = this._writeGeneration;
    this._failedGeneration = 0;
  }

  _handleDebounceTimerFired() {
    this._debounceTimer = null;
    if (!this._hasPendingWrite) {
      return;
    }
    const value = this._pendingWriteValue;
    const generation = this._writeGeneration;
    this._pendingWriteValue = undefined;
    this._hasPendingWrite = false;
    this._enqueueAsyncWrite(value, generation);
  }

  _cancelDebounce() {
    if (this._debounceTimer != null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._pendingWriteValue = undefined;
    this._hasPendingWrite = false;
    this._queuedAsyncWrite = null;
  }

  _clearImmediateCorrection() {
    this._lastImmediateGeneration = 0;
    this._lastImmediateValue = undefined;
  }

  _enqueueAsyncWrite(value, generation) {
    // The drain owns one active snapshot; this slot replaces all older work
    // before it can be serialized or touch storage.
    this._queuedAsyncWrite = { value, generation };
    if (this._asyncWriteCount > 0) return this._asyncWriteChain;
    this._asyncWriteCount = 1;
    this._asyncWriteChain = Promise.resolve()
      .then(() => this._drainAsyncWrites())
      .catch(() => {});
    return this._asyncWriteChain;
  }

  async _drainAsyncWrites() {
    try {
      while (this._queuedAsyncWrite) {
        const { value, generation } = this._queuedAsyncWrite;
        this._queuedAsyncWrite = null;
        try {
          await this._writeNowAsync(value, generation);
        } catch (error) {
          if (generation === this._writeGeneration) {
            this._failedGeneration = generation;
          }
          this._logDebouncedWriteFailure(error);
        }
        this._settleDrainStep();
      }
    } finally {
      this._asyncWriteCount = 0;
      this._clearImmediateCorrection();
      if (!this._hasPendingWrite) this._lastUnflushedValue = undefined;
      this._notifyWriteSettled();
      this._settleDrainStep();
    }
  }

  _nextDrainStep() {
    if (!this._drainStep) this._drainStep = new Promise((resolve) => { this._resolveDrainStep = resolve; });
    return this._drainStep;
  }

  _settleDrainStep() {
    const resolve = this._resolveDrainStep;
    this._drainStep = null;
    this._resolveDrainStep = null;
    resolve?.();
  }

  _notifyWriteSettled() {
    try { this._onWriteSettled?.(); } catch (_error) { /* Observers cannot change durability. */ }
  }

  _assertWritable() {
    if (!this._disposed) return;
    const error = new Error('store_disposed');
    error.code = 'store_disposed';
    throw error;
  }

  _logDebouncedWriteFailure(error) {
    // Surface the failure but do not crash the process: debounced writes are
    // best-effort. Callers needing crash-safety should use writeImmediate() or
    // wrap flush() in a try/catch.
    try {
      console.error(
        `FileJsonStore: debounced write failed for ${this.filePath}: ${error?.message || error}`
      );
    } catch (logError) {
      void logError;
    }
    if (this._logger) {
      try {
        this._logger('ERROR', 'store.debounced_write_failed', {
          filePath: this.filePath,
          errorCode: error?.code || null,
          errorMessage: error?.message || String(error),
        });
      } catch (loggerError) {
        void loggerError;
      }
    }
  }

  _writeNow(value) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const startedAt = performance.now();
    const payload = JSON.stringify(value, null, this._jsonIndent);
    const serializedAt = performance.now();
    const tempPath = buildTempPath(this.filePath);
    try {
      fs.writeFileSync(tempPath, payload, 'utf8');
      syncFile(tempPath);
      fs.renameSync(tempPath, this.filePath);
      syncDirectory(dir);
      notifyWriteMeasured(this._onWriteMeasured, payload, startedAt, serializedAt, true);
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupError) {
        void cleanupError;
      }
      throw error;
    }
  }

  async _writeNowAsync(value, generation) {
    if (generation !== this._writeGeneration || generation <= this._durableGeneration) return false;
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    if (generation !== this._writeGeneration || generation <= this._durableGeneration) return false;
    const startedAt = performance.now();
    const payload = JSON.stringify(value, null, this._jsonIndent);
    const serializedAt = performance.now();
    const tempPath = buildTempPath(this.filePath);
    try {
      await fs.promises.writeFile(tempPath, payload, 'utf8');
      await syncFileAsync(tempPath);
      if (generation !== this._writeGeneration) {
        try {
          await fs.promises.unlink(tempPath);
        } catch (cleanupError) {
          void cleanupError;
        }
        return false;
      }
      await fs.promises.rename(tempPath, this.filePath);
      await syncDirectoryAsync(dir);
      if (generation !== this._writeGeneration) {
        await this._repairStaleAsyncRename(generation);
        return false;
      }
      this._durableGeneration = generation;
      this._failedGeneration = 0;
      notifyWriteMeasured(this._onWriteMeasured, payload, startedAt, serializedAt, false);
      return true;
    } catch (error) {
      if (generation === this._writeGeneration) {
        this._failedGeneration = generation;
      }
      try {
        await fs.promises.unlink(tempPath);
      } catch (cleanupError) {
        void cleanupError;
      }
      throw error;
    }
  }

  async _repairStaleAsyncRename(generation) {
    if (
      this._lastImmediateGeneration > generation
      && this._lastImmediateGeneration === this._writeGeneration
      && this._lastImmediateValue !== undefined
    ) {
      this._writeNow(this._lastImmediateValue);
      return;
    }
    if (
      this._deleteGeneration > generation
      && this._deleteGeneration === this._writeGeneration
    ) {
      try {
        fs.unlinkSync(this.filePath);
      } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== 'ENOENT') {
          throw cleanupError;
        }
      }
    }
  }
}

module.exports = {
  buildTempPath,
  FileJsonStore,
  syncDirectory,
  syncDirectoryAsync,
  syncFileAsync,
};
