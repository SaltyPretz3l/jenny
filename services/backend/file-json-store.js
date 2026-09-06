const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function buildTempPath(filePath) {
  return `${filePath}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
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
// drains for pending timer values. `writeImmediate(value)` bypasses debouncing
// for crash-safety-critical writes; it cancels any pending debounced write so
// the immediate value wins.
class FileJsonStore {
  constructor(filePath, options) {
    this.filePath = filePath;
    const logger = options && typeof options.logger === 'function' ? options.logger : null;
    this._logger = logger;
    const rawDebounce = options && options.writeDebounceMs;
    this._writeDebounceMs = Number.isFinite(Number(rawDebounce))
      ? Math.max(0, Math.trunc(Number(rawDebounce)))
      : 0;
    this._pendingWriteValue = undefined;
    this._hasPendingWrite = false;
    this._debounceTimer = null;
    this._asyncWriteChain = Promise.resolve();
    this._asyncWriteCount = 0;
    this._writeGeneration = 0;
    this._durableGeneration = 0;
    this._failedGeneration = 0;
    this._lastImmediateGeneration = 0;
    this._lastImmediateValue = undefined;
    this._deleteGeneration = 0;
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
  // distinguish a genuinely missing file from a corrupt/unreadable one
  // (e.g. to quarantine the bytes instead of treating them as absent).
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
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return {
        value: JSON.parse(raw),
        missing: false,
        corrupted: false,
        errorCode: null,
        errorMessage: null,
      };
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
      // File exists but is corrupted or unreadable; surface for diagnostics.
      try {
        console.error(`FileJsonStore: failed to read ${this.filePath}: ${error.message}`);
      } catch (logError) {
        void logError;
      }
      if (this._logger) {
        try {
          this._logger('WARN', 'store.corrupted', {
            filePath: this.filePath,
            errorCode: error.code || null,
            errorMessage: error.message || String(error),
          });
        } catch (loggerError) {
          void loggerError;
        }
      }
      return {
        value: defaultValue,
        missing: false,
        corrupted: true,
        errorCode: (error && error.code) || null,
        errorMessage: (error && error.message) || String(error),
      };
    }
  }

  write(value) {
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
      return { generation, durable: true };
    }
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
    return { generation: this._writeGeneration, durable: true };
  }

  flush() {
    if (this._debounceTimer != null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (!this._hasPendingWrite) {
      return false;
    }
    const value = this._pendingWriteValue;
    this._pendingWriteValue = undefined;
    this._hasPendingWrite = false;
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
    }
    return true;
  }

  async flushAsync() {
    let wroteAny = false;
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
      await this._asyncWriteChain;
    }
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
    this.flush();
  }

  async disposeAsync() {
    await this.flushAsync();
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
  }

  _clearImmediateCorrection() {
    this._lastImmediateGeneration = 0;
    this._lastImmediateValue = undefined;
  }

  _enqueueAsyncWrite(value, generation) {
    this._asyncWriteCount += 1;
    const operation = this._asyncWriteChain
      .then(() => this._writeNowAsync(value, generation))
      .catch((error) => {
        if (generation === this._writeGeneration) {
          this._failedGeneration = generation;
        }
        this._logDebouncedWriteFailure(error);
      })
      .finally(() => {
        this._asyncWriteCount = Math.max(0, this._asyncWriteCount - 1);
        if (this._asyncWriteCount === 0) {
          this._clearImmediateCorrection();
          if (!this._hasPendingWrite) {
            this._lastUnflushedValue = undefined;
          }
        }
      });
    this._asyncWriteChain = operation.catch(() => {});
    return operation;
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
    const payload = JSON.stringify(value, null, 2);
    const tempPath = buildTempPath(this.filePath);
    try {
      fs.writeFileSync(tempPath, payload, 'utf8');
      fs.renameSync(tempPath, this.filePath);
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
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });
    const payload = JSON.stringify(value, null, 2);
    const tempPath = buildTempPath(this.filePath);
    try {
      await fs.promises.writeFile(tempPath, payload, 'utf8');
      if (generation !== this._writeGeneration) {
        try {
          await fs.promises.unlink(tempPath);
        } catch (cleanupError) {
          void cleanupError;
        }
        return false;
      }
      await fs.promises.rename(tempPath, this.filePath);
      if (generation !== this._writeGeneration) {
        await this._repairStaleAsyncRename(generation);
        return false;
      }
      this._durableGeneration = generation;
      this._failedGeneration = 0;
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
};
