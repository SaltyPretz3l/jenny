const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 2 * 1_048_576;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_DRAIN_DELAY_MS = 25;
const DEFAULT_MAX_PENDING_ENTRIES = 400;
const DEFAULT_MAX_PENDING_BYTES = 1_048_576;
const DEFAULT_SEVERE_RESERVE = 64;

function isBenignWriteError(error) {
  const code = String(error && error.code || '').trim().toUpperCase();
  const message = String(error && error.message || '').trim().toUpperCase();
  return code === 'EPIPE'
    || code === 'ERR_STREAM_DESTROYED'
    || message.includes('EPIPE')
    || message.includes('BROKEN PIPE');
}

function isMissingFileError(error) {
  return String(error && error.code || '').trim().toUpperCase() === 'ENOENT';
}

function normalizeLevel(entry) {
  const level = String(entry && entry.level || 'INFO').trim().toUpperCase();
  return ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(level) ? level : 'INFO';
}

function isSevereLevel(level) {
  return level === 'WARN' || level === 'ERROR';
}

class ProcessLogWriter {
  constructor({
    stream,
    filePath,
    maxBytes,
    maxFiles,
    fsImpl,
    logger,
    durable = false,
    drainDelayMs,
    maxPendingEntries,
    maxPendingBytes,
    severeReserve,
  } = {}) {
    this.stream = stream === undefined ? process.stdout : stream;
    this.disabled = false;
    this.filePath = filePath || null;
    this.maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_MAX_BYTES;
    this.maxFiles = Number.isFinite(maxFiles) && maxFiles >= 1 ? Math.floor(maxFiles) : DEFAULT_MAX_FILES;
    this.fileDisabled = false;
    this.fileBytes = 0;
    this.fs = fsImpl || fs;
    this.logger = typeof logger === 'function' ? logger : null;
    this.durable = durable === true;
    this.drainDelayMs = Number.isFinite(drainDelayMs) && drainDelayMs >= 0
      ? Math.floor(drainDelayMs)
      : DEFAULT_DRAIN_DELAY_MS;
    this.maxPendingEntries = Number.isFinite(maxPendingEntries) && maxPendingEntries >= 1
      ? Math.floor(maxPendingEntries)
      : DEFAULT_MAX_PENDING_ENTRIES;
    this.maxPendingBytes = Number.isFinite(maxPendingBytes) && maxPendingBytes >= 1
      ? Math.floor(maxPendingBytes)
      : DEFAULT_MAX_PENDING_BYTES;
    this.severeReserve = Number.isFinite(severeReserve) && severeReserve >= 0
      ? Math.min(Math.floor(severeReserve), this.maxPendingEntries)
      : Math.min(DEFAULT_SEVERE_RESERVE, this.maxPendingEntries);
    this.pending = [];
    this.pendingBytes = 0;
    this.drainTimer = null;
    this.writeChain = Promise.resolve();
    this.inFlightCount = 0;
    this.reportingWarning = false;
    this.warnedSinks = new Set();
    this.stats = {
      flushedCount: 0,
      timedOutCount: 0,
      severeFallbackCount: 0,
      droppedByLevel: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 },
    };
    this.pendingDropReport = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };

    if (this.stream && typeof this.stream.on === 'function') {
      this.stream.on('error', (error) => this._disableStream('event', error));
    }
    if (this.filePath) {
      try {
        this.fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        try {
          this.fileBytes = this.fs.statSync(this.filePath).size;
        } catch {
          this.fileBytes = 0;
        }
      } catch (error) {
        this._disableFile('init', error);
      }
    }
  }

  _emitSinkWarning(sink, stage, error) {
    if (!this.logger || this.warnedSinks.has(sink) || this.reportingWarning) return;
    this.warnedSinks.add(sink);
    this.reportingWarning = true;
    try {
      this.logger('WARN', 'logs.process_log_writer_disabled', {
        sink,
        stage,
        code: String(error && error.code || '').trim() || null,
        message: String(error && error.message || error || '').trim().slice(0, 240),
      });
    } catch {
      // Logging degradation must never escape the logging path.
    } finally {
      this.reportingWarning = false;
    }
  }

  _disableStream(stage, error) {
    if (this.disabled) return;
    this.disabled = true;
    this._emitSinkWarning('stream', stage, error);
  }

  _disableFile(stage, error) {
    if (this.fileDisabled) return;
    this.fileDisabled = true;
    this._emitSinkWarning('file', stage, error);
  }

  _fsyncPath(targetPath, stage) {
    if (!this.durable || !targetPath || typeof this.fs.openSync !== 'function') return;
    let fd = null;
    try {
      fd = this.fs.openSync(targetPath, 'r');
      if (typeof this.fs.fsyncSync === 'function') this.fs.fsyncSync(fd);
    } catch (error) {
      this._disableFile(stage, error);
    } finally {
      if (fd != null && typeof this.fs.closeSync === 'function') {
        try { this.fs.closeSync(fd); } catch { /* best effort */ }
      }
    }
  }

  _ignoreMissingFile(operation) {
    try {
      operation();
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  write(entry) {
    return this.writeBatch([entry]);
  }

  writeBatch(entries) {
    const items = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      try {
        const line = `${JSON.stringify(entry)}\n`;
        items.push({ line, bytes: Buffer.byteLength(line, 'utf8'), level: normalizeLevel(entry) });
      } catch {
        this._recordDrop(normalizeLevel(entry));
      }
    }
    if (items.length === 0) return false;

    const streamWrote = this._writeStream(items.map((item) => item.line).join(''));
    let fileAccepted = false;
    if (this.durable) {
      for (const item of items) fileAccepted = this._writeFileSyncItems([item]) || fileAccepted;
    } else {
      for (const item of items) fileAccepted = this._enqueue(item) || fileAccepted;
      if (fileAccepted) this._scheduleDrain();
    }
    return streamWrote || fileAccepted;
  }

  _writeStream(payload) {
    if (this.disabled || !this.stream || typeof this.stream.write !== 'function') return false;
    if (this.stream.destroyed || this.stream.writable === false) {
      this._disableStream('state', new Error('stream unavailable'));
      return false;
    }
    try {
      this.stream.write(payload);
      return true;
    } catch (error) {
      this._disableStream(isBenignWriteError(error) ? 'broken_pipe' : 'write', error);
      return false;
    }
  }

  _recordDrop(level) {
    this.stats.droppedByLevel[level] += 1;
    this.pendingDropReport[level] += 1;
  }

  _evictOldest(level) {
    const index = this.pending.findIndex((item) => item.level === level);
    if (index < 0) return false;
    const [removed] = this.pending.splice(index, 1);
    this.pendingBytes -= removed.bytes;
    this._recordDrop(level);
    return true;
  }

  _fits(item, lowPriority) {
    const entryLimit = lowPriority
      ? Math.max(0, this.maxPendingEntries - this.severeReserve)
      : this.maxPendingEntries;
    return this.pending.length < entryLimit && this.pendingBytes + item.bytes <= this.maxPendingBytes;
  }

  _enqueue(item) {
    if (!this.filePath || this.fileDisabled) return false;
    const severe = isSevereLevel(item.level);
    if (!severe) {
      if (item.level === 'INFO') {
        while (!this._fits(item, true) && this._evictOldest('DEBUG')) { /* prefer INFO */ }
      }
      if (!this._fits(item, true)) {
        this._recordDrop(item.level);
        return false;
      }
    } else {
      while (!this._fits(item, false) && this._evictOldest('DEBUG')) { /* reserve severe */ }
      while (!this._fits(item, false) && this._evictOldest('INFO')) { /* reserve severe */ }
      if (!this._fits(item, false)) {
        const severePending = this.pending.splice(0);
        this.pendingBytes = 0;
        const fallbackItems = [...severePending, item];
        this.stats.severeFallbackCount += fallbackItems.length;
        if (this.inFlightCount > 0) {
          this._queueAsyncItems(fallbackItems);
          return true;
        }
        return this._writeFileSyncItems(fallbackItems);
      }
    }
    this.pending.push(item);
    this.pendingBytes += item.bytes;
    return true;
  }

  _scheduleDrain() {
    if (this.drainTimer || this.pending.length === 0) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this._drainPending();
    }, this.drainDelayMs);
    this.drainTimer.unref?.();
  }

  _emitDropReport() {
    const droppedByLevel = { ...this.pendingDropReport };
    const droppedCount = Object.values(droppedByLevel).reduce((sum, count) => sum + count, 0);
    if (droppedCount === 0 || !this.logger || this.reportingWarning) return;
    this.pendingDropReport = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    this.reportingWarning = true;
    try {
      this.logger('WARN', 'logs.process_log_queue_dropped', {
        droppedCount,
        droppedByLevel,
        capacityEntries: this.maxPendingEntries,
        capacityBytes: this.maxPendingBytes,
      });
    } catch {
      // Drop reporting is best effort and deliberately non-recursive.
    } finally {
      this.reportingWarning = false;
    }
  }

  _drainPending() {
    this._emitDropReport();
    if (this.pending.length === 0 || this.fileDisabled) return this.writeChain;
    const items = this.pending.splice(0);
    this.pendingBytes = 0;
    this._queueAsyncItems(items);
    return this.writeChain;
  }

  _queueAsyncItems(items) {
    this.inFlightCount += items.length;
    this.writeChain = this.writeChain
      .then(() => this._writeFileAsyncItems(items))
      .catch(() => false)
      .finally(() => { this.inFlightCount -= items.length; });
  }

  async _appendAsync(payload) {
    if (this.fs.promises && typeof this.fs.promises.appendFile === 'function') {
      await this.fs.promises.appendFile(this.filePath, payload, 'utf8');
      return;
    }
    if (typeof this.fs.appendFile === 'function') {
      await new Promise((resolve, reject) => {
        this.fs.appendFile(this.filePath, payload, 'utf8', (error) => error ? reject(error) : resolve());
      });
      return;
    }
    await Promise.resolve();
    this.fs.appendFileSync(this.filePath, payload, 'utf8');
  }

  async _writeFileAsyncItems(items) {
    if (!this.filePath || this.fileDisabled || items.length === 0) return false;
    const payload = items.map((item) => item.line).join('');
    const byteLength = items.reduce((sum, item) => sum + item.bytes, 0);
    if (this.fileBytes + byteLength > this.maxBytes && this.fileBytes > 0) this._rotate();
    if (this.fileDisabled) return false;
    try {
      await this._appendAsync(payload);
      this.fileBytes += byteLength;
      this.stats.flushedCount += items.length;
      return true;
    } catch (error) {
      this._disableFile('append', error);
      return false;
    }
  }

  _writeFileSyncItems(items) {
    if (!this.filePath || this.fileDisabled || items.length === 0) return false;
    const payload = items.map((item) => item.line).join('');
    const byteLength = items.reduce((sum, item) => sum + item.bytes, 0);
    if (this.fileBytes + byteLength > this.maxBytes && this.fileBytes > 0) this._rotate();
    if (this.fileDisabled) return false;
    try {
      this.fs.appendFileSync(this.filePath, payload, 'utf8');
      this._fsyncPath(this.filePath, 'append_fsync');
      if (this.fileDisabled) return false;
      this.fileBytes += byteLength;
      this.stats.flushedCount += items.length;
      return true;
    } catch (error) {
      this._disableFile('append', error);
      return false;
    }
  }

  async flush({ timeoutMs = 2000 } = {}) {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this._emitDropReport();
    const drain = this._drainPending();
    const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : 2000;
    let timer = null;
    const timedOut = await Promise.race([
      Promise.resolve(drain).then(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), boundedTimeout);
      }),
    ]);
    if (timer) clearTimeout(timer);
    const timedOutCount = timedOut ? this.pending.length + this.inFlightCount : 0;
    this.stats.timedOutCount += timedOutCount;
    const droppedCount = Object.values(this.stats.droppedByLevel).reduce((sum, count) => sum + count, 0);
    return {
      flushed: !timedOut,
      flushedCount: this.stats.flushedCount,
      timedOutCount: this.stats.timedOutCount,
      droppedCount,
      droppedByLevel: { ...this.stats.droppedByLevel },
      severeFallbackCount: this.stats.severeFallbackCount,
    };
  }

  _rotate() {
    try {
      for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
        this._ignoreMissingFile(() => this.fs.renameSync(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`));
      }
      this._ignoreMissingFile(() => this.fs.renameSync(this.filePath, `${this.filePath}.1`));
      this._ignoreMissingFile(() => this.fs.unlinkSync(`${this.filePath}.${this.maxFiles + 1}`));
      this._fsyncPath(path.dirname(this.filePath), 'rotate_fsync');
      this.fileBytes = 0;
    } catch (error) {
      this._disableFile('rotate', error);
    }
  }
}

module.exports = {
  ProcessLogWriter,
  isBenignWriteError,
};
