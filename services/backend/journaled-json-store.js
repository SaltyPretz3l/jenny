'use strict';

const fs = require('fs');
const path = require('path');
const { FileJsonStore, syncDirectory } = require('./file-json-store');
const {
  EPOCH_KEY,
  closeQuietly,
  deleteJournalFiles,
  envelopeRestJson,
  isPlainObject,
  journalPathOf,
  listJournalEpochs,
  logSafe,
  readBaseEpochPrefix,
  readContext,
  readJournaledFile,
  replayStable,
} = require('./journaled-json-files');
const { createDeltaEncoder, encodeHeader } = require('./session-journal');
const { notifyWriteMeasured } = require('./session-write-meter');

const DEFAULTS = Object.freeze({
  maxJournalBytes: 1024 * 1024,
  maxJournalBaseRatio: 0.5,
  // Maximum age of the oldest un-compacted change before the base is rewritten.
  idleCompactMs: 600000,
});

// setTimeout treats a longer delay as 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;
// Appends to a journal that must already exist: a journal that vanished is
// never re-created without its header.
const APPEND_EXISTING = fs.constants.O_WRONLY | fs.constants.O_APPEND;
// How soon compaction is retried when the age limit passes during a pending write.
const COMPACT_RETRY_MS = 1000;

function numberOption(value, fallback) {
  const number = Number(value);
  return value !== undefined && value !== null && Number.isFinite(number) && number >= 0 ? number : fallback;
}

function fsyncAsync(fd) {
  return new Promise((resolve, reject) => {
    fs.fsync(fd, (error) => (error ? reject(error) : resolve()));
  });
}

// Drop-in FileJsonStore whose writes mostly append a delta record to a sibling
// journal instead of rewriting the base file. See session-journal.js for the
// record format. The base holds the envelope with a leading `journal_epoch`;
// journal files are named per epoch and every base replacement bumps the epoch.
class JournaledJsonStore extends FileJsonStore {
  constructor(filePath, options) {
    super(filePath, options);
    const ctx = readContext(filePath, options);
    this._payloadKey = ctx.payloadKey;
    this._journalId = ctx.journalId;
    this._appendEnabled = options.appendEnabled !== false;
    this._maxJournalBytes = numberOption(options.maxJournalBytes, DEFAULTS.maxJournalBytes);
    this._maxJournalBaseRatio = numberOption(options.maxJournalBaseRatio, DEFAULTS.maxJournalBaseRatio);
    this._idleCompactMs = Math.min(MAX_TIMER_MS, Math.trunc(numberOption(options.idleCompactMs, DEFAULTS.idleCompactMs)));
    // { epoch, bytes, baseBytes, usable, unsynced, continues } after the first
    // base replacement; the encoder and the envelope rest belong to it.
    this._journal = null;
    this._encoder = null;
    this._restJson = null;
    this._idleTimer = null;
    this._compactDue = false;
  }

  static readFile(filePath, options) {
    return readJournaledFile(filePath, options);
  }

  static deleteJournals(filePath) {
    deleteJournalFiles(filePath);
  }

  readWithStatus(defaultValue) {
    if (this.hasPendingWrite() && this._lastUnflushedValue !== undefined) {
      const served = super.readWithStatus(defaultValue);
      if (isPlainObject(served.value)) delete served.value[EPOCH_KEY];
      return served;
    }
    return replayStable(() => super.readWithStatus(defaultValue), {
      filePath: this.filePath,
      payloadKey: this._payloadKey,
      journalId: this._journalId,
      logger: this._logger,
      defaultValue,
    });
  }

  // ---- Write entry points ---------------------------------------------------

  _writeNow(value) {
    const handle = this._applyWrite(value, this._planAppend(value));
    if (handle) this._syncAndClose(handle);
  }

  _syncAndClose(handle) {
    try {
      fs.fsyncSync(handle.fd);
      handle.journal.unsynced = false;
    } catch (error) {
      handle.journal.usable = false;
      throw error;
    } finally {
      closeQuietly(handle.fd);
    }
    this._syncNewJournalDirectory(handle.journal);
    this._reportAppend(handle.plan, true);
  }

  async _writeNowAsync(value, generation) {
    if (generation !== this._writeGeneration || generation <= this._durableGeneration) return false;
    try {
      // Plan, write and commit happen in this tick, which fixes the on-disk
      // order against any later synchronous write. A base replacement is never
      // asynchronous: a late background base write would erase newer appends.
      const handle = this._applyWrite(value, this._planAppend(value));
      if (!handle) {
        this._durableGeneration = generation;
        this._failedGeneration = 0;
        return true;
      }
      try {
        await fsyncAsync(handle.fd);
        handle.journal.unsynced = false;
      } catch (error) {
        handle.journal.usable = false;
        throw error;
      } finally {
        closeQuietly(handle.fd);
      }
      this._syncNewJournalDirectory(handle.journal);
      this._reportAppend(handle.plan, false);
      if (generation !== this._writeGeneration) return false;
      this._durableGeneration = generation;
      this._failedGeneration = 0;
      return true;
    } catch (error) {
      if (generation === this._writeGeneration) this._failedGeneration = generation;
      throw error;
    }
  }

  // Returns the open journal handle of an appended record (the caller fsyncs and
  // closes it), or null when the value is already durable on disk.
  _applyWrite(value, plan) {
    let handle = null;
    if (plan === null) {
      this._replaceBase(value);
    } else if (plan.skip) {
      this._confirmUnchanged(value);
    } else {
      handle = this._writeRecord(plan);
      if (handle === null) this._replaceBase(value, true);
    }
    this._armIdleTimer();
    return handle;
  }

  // The value equals what the journal already holds. It may still be sitting
  // un-fsynced from a background append, so durability is confirmed first.
  _confirmUnchanged(value) {
    try {
      this._syncJournalIfNeeded();
    } catch (error) {
      void error;
      this._replaceBase(value);
    }
  }

  // ---- Appending ------------------------------------------------------------

  // Null means "replace the base"; { skip: true } means nothing changed.
  // The payload when `value` can be expressed as a delta of the last persisted
  // value: usable journal, plain-object payload, unchanged rest of the envelope.
  _appendablePayload(value) {
    const journal = this._journal;
    if (!this._appendEnabled || !journal || !journal.usable || !this._encoder) return null;
    if (!isPlainObject(value) || !isPlainObject(value[this._payloadKey])) return null;
    if (envelopeRestJson(value, this._payloadKey) !== this._restJson) return null;
    // Another writer replaced the base: this journal is no longer read, so an
    // append to it would be acknowledged and then lost. Replace the base instead.
    if (readBaseEpochPrefix(this.filePath) !== journal.epoch) return null;
    return value[this._payloadKey];
  }

  _planAppend(value) {
    const journal = this._journal;
    // The age limit passed while a write was pending: this write is the compaction.
    if (this._compactDue) return null;
    const payload = this._appendablePayload(value);
    if (payload === null) return null;
    const startedAt = performance.now();
    let prepared;
    try {
      prepared = this._encoder.prepare(payload);
    } catch (prepareError) {
      // RangeError: the record would be too large to read back. Any other
      // failure also falls back to the whole-value write, which is always correct.
      void prepareError;
      return null;
    }
    const serializedAt = performance.now();
    if (prepared.record === null) return { skip: true };
    const limit = Math.max(this._maxJournalBytes, journal.baseBytes * this._maxJournalBaseRatio);
    if (journal.bytes + prepared.bytes > limit) return null;
    return { prepared, startedAt, serializedAt, written: null };
  }

  // Open, write and commit one record. The descriptor is returned still open
  // for the caller's fsync and is never kept between writes (an open handle
  // blocks directory moves on Windows). Returns null if the journal file exists
  // although it should not, or is gone although it should exist.
  _writeRecord(plan) {
    const journal = this._journal;
    const needHeader = journal.bytes === 0;
    let fd;
    try {
      fd = fs.openSync(journalPathOf(this.filePath, journal.epoch), needHeader ? 'wx' : APPEND_EXISTING);
    } catch (error) {
      if (error && error.code === (needHeader ? 'EEXIST' : 'ENOENT')) return null;
      journal.usable = false;
      throw error;
    }
    try {
      const header = needHeader
        ? encodeHeader({ sessionId: this._journalId, epoch: journal.epoch, continues: journal.continues })
        : null;
      const chunk = header ? Buffer.concat([header, plan.prepared.record]) : plan.prepared.record;
      const written = fs.writeSync(fd, chunk);
      if (written !== chunk.length) throw new Error('journal short write');
      // Only now does the encoder baseline move: the bytes are in the file.
      plan.prepared.commit();
      journal.bytes += chunk.length;
      journal.unsynced = true;
      if (needHeader) journal.directoryUnsynced = true;
      plan.written = chunk;
      return { fd, journal, plan };
    } catch (error) {
      journal.usable = false;
      closeQuietly(fd);
      throw error;
    }
  }

  _reportAppend(plan, sync) {
    notifyWriteMeasured(this._onWriteMeasured, plan.written, plan.startedAt, plan.serializedAt, sync);
  }

  _syncJournalIfNeeded() {
    const journal = this._journal;
    if (!journal) return;
    if (journal.unsynced) {
      const fd = fs.openSync(journalPathOf(this.filePath, journal.epoch), 'r+');
      try {
        fs.fsyncSync(fd);
        journal.unsynced = false;
      } catch (error) {
        journal.usable = false;
        throw error;
      } finally {
        closeQuietly(fd);
      }
    }
    this._syncNewJournalDirectory(journal);
  }

  // A newly created journal is durable only once its directory entry is. The
  // flag lives on the journal so a barrier that overtakes the background append
  // which created the file does not acknowledge before the entry is synced.
  _syncNewJournalDirectory(journal) {
    if (!journal.directoryUnsynced) return;
    syncDirectory(path.dirname(this.filePath));
    journal.directoryUnsynced = false;
  }

  // ---- Base replacement -----------------------------------------------------

  _discoverNextEpoch() {
    const highestJournal = Math.max(0, ...listJournalEpochs(this.filePath));
    return Math.max(readBaseEpochPrefix(this.filePath), highestJournal) + 1;
  }

  // Decides whether the NEW base will equal the state at the end of the CURRENT
  // journal, so the journal started on top of it may be chained after the
  // current one if the new base is ever lost. When the value still differs, its
  // delta is appended (fsynced) to the current journal first.
  _prepareContinuation(value) {
    const journal = this._journal;
    const payload = this._appendablePayload(value);
    if (payload === null) return false;
    const startedAt = performance.now();
    let prepared;
    try {
      prepared = this._encoder.prepare(payload);
    } catch (prepareError) {
      void prepareError;
      return false;
    }
    if (prepared.record === null) return true;
    // A delta bigger than the base would only grow the journal we replace next.
    if (prepared.bytes > journal.baseBytes) return false;
    try {
      const handle = this._writeRecord({ prepared, startedAt, serializedAt: performance.now(), written: null });
      if (handle === null) return false;
      this._syncAndClose(handle);
      return true;
    } catch (error) {
      void error;
      return false;
    }
  }

  _replaceBase(value, rediscover = false) {
    if (!isPlainObject(value)) throw new TypeError('journaled store values must be plain objects');
    const previous = this._journal;
    let continues = this._prepareContinuation(value);
    // Journal N must be durable before base N+1 exists: it is the fallback
    // (base N + journal N + journal N+1) if the rename of base N+1 is lost.
    try {
      this._syncJournalIfNeeded();
    } catch (syncError) {
      continues = false;
      logSafe(this._logger, 'WARN', 'store.journal_sync_failed', {
        filePath: this.filePath, errorCode: (syncError && syncError.code) || null,
      });
    }
    const first = previous ? previous.epoch + 1 : 1;
    // The next epoch comes from memory only while the base on disk is still the
    // one this instance wrote; a second writer must never be handed the same epoch.
    const ours = previous && !rediscover && readBaseEpochPrefix(this.filePath) === previous.epoch;
    const newEpoch = ours ? first : Math.max(first, this._discoverNextEpoch());
    if (!previous || newEpoch !== first) continues = false;

    const { [EPOCH_KEY]: ignoredEpoch, ...rest } = value;
    void ignoredEpoch;
    super._writeNow({ [EPOCH_KEY]: newEpoch, ...rest });
    let baseBytes = 0;
    try {
      baseBytes = fs.statSync(this.filePath).size;
    } catch (statError) {
      void statError;
    }
    // Journal newEpoch-1 is deliberately kept; anything older is superseded.
    for (const epoch of listJournalEpochs(this.filePath)) {
      if (epoch >= newEpoch - 1) continue;
      try {
        fs.unlinkSync(journalPathOf(this.filePath, epoch));
      } catch (unlinkError) {
        void unlinkError;
      }
    }
    const payload = value[this._payloadKey];
    if (this._encoder) this._encoder.reset(payload);
    else this._encoder = createDeltaEncoder(payload);
    this._restJson = envelopeRestJson(value, this._payloadKey);
    this._journal = {
      epoch: newEpoch, bytes: 0, baseBytes, usable: isPlainObject(payload), unsynced: false, continues,
    };
    this._compactDue = false;
    this._armIdleTimer();
  }

  // ---- Compaction and lifecycle ----------------------------------------------

  // True when the base was replaced. Throws when the base write fails.
  // The new base is rebuilt from what is on disk (base + journal), never from a
  // caller's object: its owner may have changed that in memory without a write,
  // and compaction must not persist state nobody asked to save.
  _compactNow() {
    const journal = this._journal;
    if (!journal || journal.bytes === 0 || !this._encoder) return false;
    // The base belongs to another writer now (a second store on this file):
    // rewriting it from here would orphan that writer's journal.
    if (readBaseEpochPrefix(this.filePath) !== journal.epoch) {
      logSafe(this._logger, 'WARN', 'store.journal_superseded', { filePath: this.filePath, epoch: journal.epoch });
      this._dropJournalState();
      return false;
    }
    const served = readJournaledFile(this.filePath, {
      payloadKey: this._payloadKey, journalId: this._journalId, logger: this._logger,
    });
    if (served.missing || served.corrupted || served.journalStatus !== 'ok') {
      logSafe(this._logger, 'WARN', 'store.journal_compact_skipped', {
        filePath: this.filePath, journalStatus: served.journalStatus,
      });
      return false;
    }
    this._replaceBase(served.value);
    return true;
  }

  _compactQuietly() {
    try {
      this._compactNow();
    } catch (error) {
      logSafe(this._logger, 'WARN', 'store.journal_compact_failed', {
        filePath: this.filePath,
        errorCode: (error && error.code) || null,
        errorMessage: (error && error.message) || String(error),
      });
    }
  }

  compact() {
    if (this._disposed || this.hasPendingWrite()) return false;
    return this._compactNow();
  }

  _armIdleTimer(delayMs = this._idleCompactMs) {
    const journal = this._journal;
    if (this._idleCompactMs <= 0 || this._disposed || !journal || journal.bytes === 0) {
      this._clearIdleTimer();
      return;
    }
    // Not refreshed by later writes: the timer bounds how old the oldest
    // un-compacted change can get, so a chat that is written continuously still
    // gets a complete base (other processes read base files directly).
    if (this._idleTimer) return;
    this._idleTimer = setTimeout(() => this._onIdle(), delayMs);
    this._idleTimer.unref();
  }

  _clearIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  // For an owner that has shut down: no base rewrite may start later on its own.
  cancelScheduledCompaction() {
    this._clearIdleTimer();
    this._compactDue = false;
  }

  _onIdle() {
    this._idleTimer = null;
    if (this._disposed) return;
    // A write is pending or still syncing. The next write replaces the base
    // itself; if none comes, a short retry compacts once the store is quiet.
    if (this.hasPendingWrite()) {
      this._compactDue = true;
      this._armIdleTimer(Math.min(this._idleCompactMs, COMPACT_RETRY_MS));
      return;
    }
    this._compactQuietly();
    // A compaction that was skipped or failed is tried again one period later.
    this._armIdleTimer();
  }

  _dropJournalState() {
    this._clearIdleTimer();
    this._compactDue = false;
    this._journal = null;
    this._encoder = null;
    this._restJson = null;
  }

  _closeJournal() {
    this._compactQuietly();
    this._dropJournalState();
  }

  dispose() {
    if (this._disposed) return;
    super.dispose();
    if (this._disposed) this._closeJournal();
  }

  async disposeAsync() {
    if (this._disposed) return;
    await super.disposeAsync();
    if (this._disposed) this._closeJournal();
  }

  delete() {
    super.delete();
    this._dropJournalState();
    JournaledJsonStore.deleteJournals(this.filePath);
  }
}

module.exports = { JournaledJsonStore };
