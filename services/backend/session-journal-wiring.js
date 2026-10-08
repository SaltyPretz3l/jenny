'use strict';

const fs = require('fs');
const path = require('path');

const { FileJsonStore } = require('./file-json-store');
const { JournaledJsonStore } = require('./journaled-json-store');
const { EPOCH_KEY, isPlainObject, journalPathOf, listJournalEpochs } = require('./journaled-json-files');
const { safeEmitLog } = require('./session-store-logging');
const { buildFeatureFlagDefaults } = require('../feature-flags');

// How SessionStorageBackend owns chat files when its `journal` option is set:
// which store class holds a chat file, how a chat file without a cached store is
// read, and what happens to a chat's journals when a direct file operation
// (quarantine, damage report, migration, delete) touches the chat file.
// Journals are named <stem>.<epoch>.journal beside the chat file; a quarantined
// copy is corrupt/<stem>.<ms>.<epoch>.journal, next to corrupt/<stem>.<ms>.json.

const PAYLOAD_KEY = 'session';
const INDEX_PAYLOAD_KEY = 'sessions';
const THRESHOLD_KEYS = ['maxJournalBytes', 'maxJournalBaseRatio', 'idleCompactMs'];
// Per backend: the damage / torn-tail reports already made by this process.
const reportedStatuses = new WeakMap();

// null keeps plain FileJsonStore chat files (the shadow store). Anything else
// makes reads journal-aware. `append: false` is the kill switch: chat files are
// written by a plain FileJsonStore exactly as before the journal existed (a
// base without an epoch, which no journal is ever replayed over), while a chat
// still stored as base + journal is read completely. An unset `append` follows the
// session_journal flag default, so JENNY_ENABLE_SESSION_JOURNAL=0 reaches every
// store a tool or script constructs, not only the app's.
function normalizeJournalOption(journal) {
  if (!journal || typeof journal !== 'object') return null;
  const normalized = { append: (journal.append ?? buildFeatureFlagDefaults().session_journal) !== false };
  for (const key of THRESHOLD_KEYS) {
    if (journal[key] !== undefined) normalized[key] = journal[key];
  }
  return normalized;
}

function createSessionFileStore(backend, sessionId) {
  const filePath = backend._sessionFilePath(sessionId);
  const options = {
    writeDebounceMs: backend._writeDebounceMs,
    compact: true,
    onWriteSettled: () => backend._notifyCacheAvailability(),
    onWriteMeasured: backend._measuredWrites('session', sessionId),
    logger: backend._logger,
  };
  const journal = backend._journal;
  if (!journal || !journal.append) return new FileJsonStore(filePath, options);
  return new JournaledJsonStore(filePath, { ...options, ...journal, payloadKey: PAYLOAD_KEY });
}

// The session index (<sessions>/_index.json = { schema_version, sessions: { id: summary } })
// follows the same rules with `sessions` as the journal payload: a chat's changed
// summary is a top-level `set`, a deleted chat an `unset`. Every construction goes
// through createIndexStore, and exactly one index store is live per backend.
function createIndexStore(backend, extraOptions = {}) {
  const options = {
    writeDebounceMs: backend._writeDebounceMs,
    compact: true,
    onWriteSettled: () => backend._notifyCacheAvailability?.(),
    onWriteMeasured: backend._measuredWrites?.('index'),
    logger: backend._logger,
    ...extraOptions,
  };
  const journal = backend._journal;
  if (!journal) return new FileJsonStore(backend._indexPath, options);
  if (!journal.append) {
    return new FileJsonStore(backend._indexPath, {
      ...options, onWriteMeasured: dropIndexJournalsAfterFirstWrite(backend, options.onWriteMeasured),
    });
  }
  return new JournaledJsonStore(backend._indexPath, { ...options, ...journal, payloadKey: INDEX_PAYLOAD_KEY });
}

// A kill-switch index write leaves a base without an epoch, so any index journal
// of an earlier journaling run can no longer be reached. They are removed after
// the first successful write of the process; a failure only logs (the prune
// removes them after a day).
function dropIndexJournalsAfterFirstWrite(backend, measured) {
  let dropped = false;
  return (write) => {
    if (!dropped) {
      dropped = true;
      try {
        JournaledJsonStore.deleteJournals(backend._indexPath);
      } catch (error) {
        safeEmitLog(backend._logger, 'WARN', `${backend._storeName}.index_journal_delete_failed`, {
          filePath: backend._indexPath,
          errorCode: (error && error.code) || null,
          errorMessage: (error && error.message) || String(error),
        });
      }
    }
    if (typeof measured === 'function') measured(write);
  };
}

// Replaces backend._indexStore with a new store, disposing a different previous
// one first so two stores never own the index file.
function installIndexStore(backend) {
  const previous = backend._indexStore;
  if (previous && typeof previous.dispose === 'function') {
    try {
      previous.dispose();
    } catch (error) {
      void error;
    }
  }
  backend._indexStore = createIndexStore(backend);
  return backend._indexStore;
}

// The index as it is on disk, journals replayed, in the shape of readWithStatus
// (value null when missing or unreadable). Journal-aware whenever the backend has
// a journal option, including under the kill switch, whose plain store cannot
// replay a journal left by a journaling run unless it holds a pending write.
function readIndexStatus(backend) {
  return readThroughStore(backend, backend._indexStore, backend._indexPath, INDEX_PAYLOAD_KEY);
}

// `store` (may be null) is used when it can see the whole file; otherwise the
// file is read without creating a store instance, since a throwaway journaled
// store would own an idle timer.
function readThroughStore(backend, store, filePath, payloadKey) {
  if (store && (!backend._journal || store instanceof JournaledJsonStore || store.hasPendingWrite())) {
    return store.readWithStatus(null);
  }
  if (!backend._journal) return new FileJsonStore(filePath, { logger: backend._logger }).readWithStatus(null);
  return JournaledJsonStore.readFile(filePath, { payloadKey, logger: backend._logger, defaultValue: null });
}

// Reads one chat from disk through its cached store when that store can see the
// whole chat. Under the kill switch the cached store is a plain FileJsonStore,
// which cannot replay a journal left by a journaling run: unless it holds a
// pending write (served from memory), the journal-aware file read is used.
function readSessionStatus(backend, sessionId) {
  const store = backend._sessionStores.get(sessionId) || null;
  return readThroughStore(backend, store, backend._sessionFilePath(sessionId), PAYLOAD_KEY);
}

// A readWithStatus-shaped result for a chat file that has no cached store.
function readSessionFileStatus(backend, filePath) {
  return readThroughStore(backend, null, filePath, PAYLOAD_KEY);
}

// The value a split-layout migration should use for a chat file it read raw:
// a journaled chat is re-read with its journals replayed, and no value keeps the
// journal's epoch key. Throws like the raw read does when the file is unreadable.
function resolveMigrationValue(backend, filePath, raw) {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, EPOCH_KEY)) return raw;
  let value = raw;
  if (backend._journal && Number.isInteger(raw[EPOCH_KEY]) && raw[EPOCH_KEY] >= 1) {
    const status = readSessionFileStatus(backend, filePath);
    if (status.corrupted || status.missing || status.unreadable) {
      throw Object.assign(new Error(status.errorMessage || 'chat file unreadable'), { code: status.errorCode });
    }
    value = status.value;
  }
  if (!isPlainObject(value)) return value;
  const { [EPOCH_KEY]: ignoredEpoch, ...rest } = value;
  void ignoredEpoch;
  return rest;
}

// Moves (or copies) every journal of one chat into corrupt/. Best effort: one
// WARN with the failure count, never an exception.
function stashJournals(backend, sessionId, stamp, move, filePath = backend._sessionFilePath(sessionId)) {
  const stem = path.basename(filePath, '.json');
  const quarantineDir = path.join(backend._rootDir, 'corrupt');
  let failed = 0;
  let lastError = null;
  for (const epoch of listJournalEpochs(filePath)) {
    const source = journalPathOf(filePath, epoch);
    const target = path.join(quarantineDir, `${stem}.${stamp}.${epoch}.journal`);
    try {
      fs.mkdirSync(quarantineDir, { recursive: true });
      if (move) fs.renameSync(source, target);
      else fs.copyFileSync(source, target);
    } catch (error) {
      failed += 1;
      lastError = error;
    }
  }
  if (failed > 0) {
    safeEmitLog(backend._logger, 'WARN', `${backend._storeName}.session_journal_quarantine_failed`, {
      sessionId,
      failed,
      move,
      errorCode: (lastError && lastError.code) || null,
    });
  }
}

// A cached journaled store keeps in-memory journal state (open epoch, byte
// count). Once a direct operation changed the files under it, its next write
// must start from a fresh instance, whose first write always replaces the base.
function retireCachedStore(backend, sessionId) {
  const store = backend._sessionStores.get(sessionId);
  if (!store) return;
  try {
    store.dispose();
  } catch (error) {
    void error;
  }
  backend._sessionStores.delete(sessionId);
}

// The chat file was moved to corrupt/<stem>.<stamp>.json: its journals follow it.
function quarantineSessionJournals(backend, sessionId, stamp) {
  if (!backend._journal) return;
  retireCachedStore(backend, sessionId);
  stashJournals(backend, sessionId, stamp, true);
}

// A chat was loaded from disk: report what the journal replay found. A torn tail
// is the normal result of a crash. A damaged journal keeps the readable prefix;
// its files are copied for diagnosis once per chat per process.
function noteJournalStatus(backend, sessionId, readStatus) {
  const status = readStatus && readStatus.journalStatus;
  if (status !== 'corrupt' && status !== 'torn_tail') return;
  let reported = reportedStatuses.get(backend);
  if (!reported) {
    reported = new Set();
    reportedStatuses.set(backend, reported);
  }
  const key = `${status}:${sessionId}`;
  if (reported.has(key)) return;
  reported.add(key);
  if (status === 'torn_tail') {
    safeEmitLog(backend._logger, 'INFO', `${backend._storeName}.session_journal_tail_dropped`, { sessionId });
    return;
  }
  safeEmitLog(backend._logger, 'ERROR', `${backend._storeName}.session_journal_damaged`, { sessionId });
  retireCachedStore(backend, sessionId);
  stashJournals(backend, sessionId, Date.now(), false);
}

// The index journal is damaged and the index is about to be rebuilt from the
// chat files: keep a copy of the journals for diagnosis first.
function preserveDamagedIndexJournals(backend) {
  safeEmitLog(backend._logger, 'ERROR', `${backend._storeName}.index_journal_damaged`, {});
  stashJournals(backend, '_index', Date.now(), false, backend._indexPath);
}

// Chat files that could not be read while the index was rebuilt have a blank
// entry in it, or none (a hashed file name does not give the chat's id). They
// are read again after each delay and their real summary takes the entry.
const INDEX_REPAIR_DELAYS_MS = [2000, 15000, 60000];

function repairIndexEntry(backend, filePath) {
  const readStatus = readSessionFileStatus(backend, filePath);
  if (readStatus.unreadable) return false;
  const record = readStatus.value && readStatus.value.session;
  if (readStatus.missing || readStatus.corrupted || !isPlainObject(record)) return true;
  if (Number(readStatus.value.schema_version) > backend._schemaVersion) return true;
  const sessionId = String(record.id || path.basename(filePath, '.json')).trim();
  if (!sessionId) return true;
  const session = backend._loadedSessions.get(sessionId) || backend._normalizeSession(sessionId, record);
  backend._cachedIndex.sessions[sessionId] = backend._summarizeSession(session);
  backend._scheduleIndexWrite();
  safeEmitLog(backend._logger, 'INFO', `${backend._storeName}.index_entry_repaired`, { sessionId });
  return true;
}

function scheduleIndexRepair(backend, filePaths, attempt = 0) {
  if (filePaths.length === 0 || attempt >= INDEX_REPAIR_DELAYS_MS.length) return;
  setTimeout(() => {
    if (backend._disposed || backend._mode !== 'split' || backend._newerSchemaVersion > 0) return;
    const remaining = filePaths.filter((filePath) => {
      try {
        return !repairIndexEntry(backend, filePath);
      } catch (error) {
        void error;
        return false;
      }
    });
    scheduleIndexRepair(backend, remaining, attempt + 1);
  }, INDEX_REPAIR_DELAYS_MS[attempt]).unref();
}

// Deletes a chat's journals after its base file is gone. A failure never undoes
// the delete (the base is the record of existence; the legacy prune removes a
// leftover journal later).
function deleteSessionJournals(backend, sessionId, filePath) {
  if (!backend._journal) return;
  try {
    JournaledJsonStore.deleteJournals(filePath);
  } catch (error) {
    safeEmitLog(backend._logger, 'WARN', `${backend._storeName}.journal_delete_failed`, {
      sessionId,
      filePath,
      errorCode: (error && error.code) || null,
      errorMessage: (error && error.message) || String(error),
    });
  }
}

module.exports = {
  createIndexStore,
  createSessionFileStore,
  deleteSessionJournals,
  installIndexStore,
  noteJournalStatus,
  normalizeJournalOption,
  preserveDamagedIndexJournals,
  quarantineSessionJournals,
  readIndexStatus,
  readSessionFileStatus,
  readSessionStatus,
  resolveMigrationValue,
  scheduleIndexRepair,
};
