const fs = require('fs');
const path = require('path');

const { FileJsonStore } = require('./file-json-store');
const {
  logNewerSchemaDetected,
  logWriteFailed,
} = require('./session-store-logging');
const {
  readJsonFileAsync,
  yieldToEventLoop,
  unlinkIfExists,
  summariesEqual,
  hasOwn,
} = require('./session-storage-fs-utils');
const {
  readsNewerSchema,
  enterNewerSchemaFreeze,
} = require('./session-storage-guards');

const SPLIT_MIGRATION_BATCH_SIZE = 25;

// Migration & recovery engine for SessionStorageBackend. These functions take
// the backend instance (`self`) and operate on its private state exactly as the
// original instance methods did; the backend keeps thin delegators so its
// public/test surface is unchanged. Three init-time paths live here:
//   - monolithic -> split migration (legacy single-file payloads)
//   - deferred split-layout schema migration (older split index, run async)
//   - split-index recovery is kept on the backend (it reuses cache primitives)

function migrateFromMonolithic(self) {
  const monolithicStore = new FileJsonStore(self._legacyMonolithicPath, {
    writeDebounceMs: 0,
    logger: self._logger,
  });
  const raw = monolithicStore.read(null);
  if (!raw) {
    self._initializeEmpty();
    return;
  }
  const observed = Number(raw?.schema_version || 1);

  if (Number.isFinite(observed) && observed > self._legacyMaxSchemaVersion) {
    enterMonolithicReadonlyMode(self, raw, observed);
    return;
  }

  const migrated = self._migratePayload(raw);
  fs.mkdirSync(self._rootDir, { recursive: true });

  const indexSessions = {};
  let writeFailed = false;
  for (const [sessionId, session] of Object.entries(migrated.sessions || {})) {
    const normalized = self._normalizeSession(sessionId, session);
    try {
      const store = self._getOrCreateSessionStore(sessionId);
      store.writeImmediate({
        schema_version: self._schemaVersion,
        session: normalized,
      });
    } catch (error) {
      logWriteFailed(
        self._logger,
        `${self._storeName}.migration_write_failed`,
        self._sessionFilePath(sessionId),
        error
      );
      writeFailed = true;
      break;
    }
    self._loadedSessions.set(sessionId, normalized);
    self._trackActiveTurn(sessionId, normalized);
    self._touchSession(sessionId);
    indexSessions[sessionId] = self._summarizeSession(normalized);
  }

  if (writeFailed) {
    // Abort migration: leave the monolithic file in place so the next
    // startup can try again. Drop any partial split state from memory.
    cleanupAfterFailedMigration(self);
    initializeFromMonolithicReadOnlyCache(self, migrated);
    return;
  }

  const indexPayload = {
    schema_version: self._schemaVersion,
    sessions: indexSessions,
  };
  try {
    const indexStore = new FileJsonStore(self._indexPath, {
      writeDebounceMs: 0,
      logger: self._logger,
    });
    indexStore.writeImmediate(indexPayload);
  } catch (error) {
    logWriteFailed(
      self._logger,
      `${self._storeName}.migration_index_write_failed`,
      self._indexPath,
      error
    );
    cleanupAfterFailedMigration(self);
    initializeFromMonolithicReadOnlyCache(self, migrated);
    return;
  }

  self._indexStore = new FileJsonStore(self._indexPath, {
    writeDebounceMs: self._writeDebounceMs,
    logger: self._logger,
  });
  self._cachedIndex = indexPayload;

  const backupPath = `${self._legacyMonolithicPath}.migrated-${Date.now()}`;
  try {
    fs.renameSync(self._legacyMonolithicPath, backupPath);
  } catch (error) {
    // Backup rename is best-effort: the new layout is already complete and
    // serves all reads. The monolithic file will be ignored on next startup
    // because the index exists.
    if (self._logger) {
      try {
        self._logger('WARN', `${self._storeName}.migration_backup_failed`, {
          monolithicPath: self._legacyMonolithicPath,
          backupPath,
          errorMessage: String(error?.message || error),
        });
      } catch (_logError) {
        void _logError;
      }
    }
  }

  if (self._logger) {
    try {
      self._logger('INFO', `${self._storeName}.split_migration_completed`, {
        rootDir: self._rootDir,
        sessionCount: Object.keys(indexSessions).length,
        backupPath,
      });
    } catch (_logError) {
      void _logError;
    }
  }
}

function enterMonolithicReadonlyMode(self, raw, observedVersion) {
  self._mode = 'monolithic_readonly';
  self._newerSchemaVersion = observedVersion;
  logNewerSchemaDetected(
    self._logger,
    `${self._storeName}.newer_schema_detected`,
    self._legacyMonolithicPath,
    observedVersion,
    self._schemaVersion
  );
  // Normalize the future-schema payload through the standard migration so the
  // in-memory cache uses the current record shape. NOTE: normalizeSession is a
  // strict whitelist, so any future fields the payload carries are NOT preserved
  // — the read-only cache reflects only current-schema fields. The store stays
  // frozen (no writes), so the future file on disk is never downgraded.
  const migrated = self._migratePayload(raw);
  initializeFromMonolithicReadOnlyCache(self, migrated);
}

function initializeFromMonolithicReadOnlyCache(self, migratedPayload) {
  self._mode = 'monolithic_readonly';
  const indexSessions = {};
  for (const [sessionId, session] of Object.entries(migratedPayload.sessions || {})) {
    const normalized = self._normalizeSession(sessionId, session);
    self._loadedSessions.set(sessionId, normalized);
    self._trackActiveTurn(sessionId, normalized);
    self._touchSession(sessionId);
    indexSessions[sessionId] = self._summarizeSession(normalized);
  }
  self._cachedIndex = {
    schema_version: self._schemaVersion,
    sessions: indexSessions,
  };
}

function cleanupAfterFailedMigration(self) {
  for (const [, store] of self._sessionStores) {
    try {
      if (typeof store.dispose === 'function') {
        store.dispose();
      }
    } catch (_error) {
      void _error;
    }
    try {
      unlinkIfExists(store.filePath);
    } catch (error) {
      logWriteFailed(
        self._logger,
        `${self._storeName}.migration_cleanup_failed`,
        store.filePath,
        error
      );
    }
  }
  try {
    unlinkIfExists(self._indexPath);
  } catch (error) {
    logWriteFailed(
      self._logger,
      `${self._storeName}.migration_cleanup_failed`,
      self._indexPath,
      error
    );
  }
  try {
    fs.rmdirSync(self._rootDir);
  } catch (_error) {
    void _error;
  }
  self._sessionStores.clear();
  self._loadedSessions.clear();
  self._scanActiveTurns.clear();
  self._cachedIndex = { schema_version: self._schemaVersion, sessions: {} };
}

function queueSplitLayoutMigration(self, indexRaw, observedVersion) {
  const indexSessions =
    indexRaw && indexRaw.sessions && typeof indexRaw.sessions === 'object' && !Array.isArray(indexRaw.sessions)
      ? { ...indexRaw.sessions }
      : {};
  self._cachedIndex = {
    schema_version: self._schemaVersion,
    sessions: indexSessions,
  };
  self._pendingSplitMigration = {
    indexRaw: {
      schema_version: observedVersion,
      sessions: indexSessions,
    },
    observedVersion,
  };
  if (self._logger) {
    try {
      self._logger('INFO', `${self._storeName}.split_schema_migration_queued`, {
        rootDir: self._rootDir,
        observedVersion,
        expectedVersion: self._schemaVersion,
        indexedSessionCount: Object.keys(indexSessions).length,
      });
    } catch (_logError) {
      void _logError;
    }
  }
}

async function runSplitLayoutMigrationAsync(self, { batchSize = SPLIT_MIGRATION_BATCH_SIZE } = {}) {
  const pending = self._pendingSplitMigration;
  if (!pending) {
    return {
      ran: false,
      success: true,
      storeName: self._storeName,
      reason: 'none',
    };
  }
  const observedVersion = pending.observedVersion;
  const originalIndexSessions =
    pending.indexRaw && pending.indexRaw.sessions && typeof pending.indexRaw.sessions === 'object'
      ? { ...pending.indexRaw.sessions }
      : {};
  const normalizedBatchSize = Math.max(1, Math.floor(Number(batchSize) || SPLIT_MIGRATION_BATCH_SIZE));
  let entries;
  try {
    entries = await fs.promises.readdir(self._rootDir, { withFileTypes: true });
  } catch (error) {
    logWriteFailed(
      self._logger,
      `${self._storeName}.split_schema_migration_failed`,
      self._rootDir,
      error
    );
    self._cachedIndex = {
      schema_version: self._schemaVersion,
      sessions: mergeLiveSplitMigrationIndex(self, originalIndexSessions, {}),
    };
    return completeSplitMigrationLog(self, {
      observedVersion,
      sessionCount: 0,
      success: false,
    });
  }

  const sourceSessions = {};
  let processed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === '_index.json' || !entry.name.endsWith('.json')) {
      continue;
    }
    const filePath = path.join(self._rootDir, entry.name);
    try {
      const raw = await readJsonFileAsync(filePath);
      if (readsNewerSchema(self, raw)) {
        // A future-schema session file during a downgrade migration: a newer app
        // owns this store. Freeze and skip it; the post-loop guard aborts so we
        // never migrate payloads or rebuild a current-schema index over it.
        enterNewerSchemaFreeze(self, raw.schema_version, filePath);
        continue;
      }
      const sessionRecord =
        raw && typeof raw === 'object' && !Array.isArray(raw) && raw.session
          ? raw.session
          : raw;
      if (!sessionRecord || typeof sessionRecord !== 'object' || Array.isArray(sessionRecord)) {
        continue;
      }
      const sessionId = String(
        sessionRecord.id || path.basename(entry.name, '.json') || ''
      ).trim();
      if (sessionId) {
        sourceSessions[sessionId] = sessionRecord;
      }
    } catch (error) {
      logWriteFailed(
        self._logger,
        `${self._storeName}.split_schema_migration_failed`,
        filePath,
        error
      );
    }
    processed += 1;
    if (processed % normalizedBatchSize === 0) {
      await yieldToEventLoop();
    }
  }

  if (self._newerSchemaVersion > 0) {
    // A newer on-disk schema was detected mid-migration: abort. Do not migrate
    // payloads or rebuild a current-schema index over data a newer app owns;
    // leave the store frozen and clear the pending migration so it is not
    // retried.
    self._pendingSplitMigration = null;
    return completeSplitMigrationLog(self, {
      observedVersion,
      sessionCount: 0,
      success: false,
    });
  }

  const migrated = self._migratePayload({
    schema_version: observedVersion,
    sessions: sourceSessions,
  });
  const indexSessions = {};
  let writeFailed = false;
  let written = 0;
  for (const [sessionId, session] of Object.entries(migrated.sessions || {})) {
    const liveIndexSessions =
      self._cachedIndex && self._cachedIndex.sessions && typeof self._cachedIndex.sessions === 'object'
        ? self._cachedIndex.sessions
        : {};
    if (
      hasOwn(originalIndexSessions, sessionId)
      && !hasOwn(liveIndexSessions, sessionId)
    ) {
      continue;
    }
    const loadedSession = self._loadedSessions.get(sessionId);
    const sourceSession =
      loadedSession && typeof loadedSession === 'object' && !Array.isArray(loadedSession)
        ? loadedSession
        : session;
    const normalized = self._normalizeSession(sessionId, sourceSession);
    try {
      self._getOrCreateSessionStore(sessionId).writeImmediate({
        schema_version: self._schemaVersion,
        session: normalized,
      });
    } catch (error) {
      writeFailed = true;
      logWriteFailed(
        self._logger,
        `${self._storeName}.split_schema_migration_failed`,
        self._sessionFilePath(sessionId),
        error
      );
      continue;
    }
    self._loadedSessions.set(sessionId, normalized);
    self._trackActiveTurn(sessionId, normalized);
    self._touchSession(sessionId);
    indexSessions[sessionId] = self._summarizeSession(normalized);
    written += 1;
    if (written % normalizedBatchSize === 0) {
      await yieldToEventLoop();
    }
  }

  if (writeFailed) {
    self._cachedIndex = {
      schema_version: self._schemaVersion,
      sessions: mergeLiveSplitMigrationIndex(self, originalIndexSessions, {}),
    };
    return completeSplitMigrationLog(self, {
      observedVersion,
      sessionCount: Object.keys(indexSessions).length,
      success: false,
    });
  }

  const mergedIndexSessions = mergeLiveSplitMigrationIndex(
    self,
    originalIndexSessions,
    indexSessions
  );
  self._cachedIndex = {
    schema_version: self._schemaVersion,
    sessions: mergedIndexSessions,
  };
  try {
    if (!self._indexStore) {
      // Unreachable today -- _loadFromSplitLayout assigns _indexStore before it
      // can queue a migration. Fail into the catch below rather than clear the
      // dirty flags for an index write that never happened: reporting a
      // migration complete without persisting its index is how a mutation's
      // deferred index write gets silently dropped.
      throw new Error('split migration has no index store to write through');
    }
    self._indexStore.writeImmediate(self._cachedIndex);
    self._indexDirty = false;
    self._pendingSplitMigration = null;
  } catch (error) {
    self._indexDirty = true;
    logWriteFailed(
      self._logger,
      `${self._storeName}.split_schema_migration_failed`,
      self._indexPath,
      error
    );
    return completeSplitMigrationLog(self, {
      observedVersion,
      sessionCount: Object.keys(mergedIndexSessions).length,
      success: false,
    });
  }

  return completeSplitMigrationLog(self, {
    observedVersion,
    sessionCount: Object.keys(mergedIndexSessions).length,
    success: true,
  });
}

function mergeLiveSplitMigrationIndex(self, originalIndexSessions, migratedIndexSessions) {
  const liveIndexSessions =
    self._cachedIndex && self._cachedIndex.sessions && typeof self._cachedIndex.sessions === 'object'
      ? self._cachedIndex.sessions
      : {};
  const merged = { ...(migratedIndexSessions || {}) };

  for (const sessionId of Object.keys(merged)) {
    if (hasOwn(originalIndexSessions, sessionId) && !hasOwn(liveIndexSessions, sessionId)) {
      delete merged[sessionId];
    }
  }

  for (const [sessionId, liveSummary] of Object.entries(liveIndexSessions)) {
    const hadOriginal = hasOwn(originalIndexSessions, sessionId);
    const wasMigrated = hasOwn(merged, sessionId);
    const changedSinceQueued =
      !hadOriginal || !summariesEqual(liveSummary, originalIndexSessions[sessionId]);
    if (changedSinceQueued || !wasMigrated) {
      merged[sessionId] = liveSummary;
    }
  }

  return merged;
}

function completeSplitMigrationLog(self, { observedVersion, sessionCount, success }) {
  const level = success ? 'INFO' : 'WARN';
  if (self._logger) {
    try {
      self._logger(level, `${self._storeName}.split_schema_migration_completed`, {
        rootDir: self._rootDir,
        observedVersion,
        expectedVersion: self._schemaVersion,
        sessionCount,
        success,
      });
    } catch (_logError) {
      void _logError;
    }
  }
  return {
    ran: true,
    success,
    storeName: self._storeName,
    observedVersion,
    expectedVersion: self._schemaVersion,
    sessionCount,
  };
}

module.exports = {
  SPLIT_MIGRATION_BATCH_SIZE,
  migrateFromMonolithic,
  queueSplitLayoutMigration,
  runSplitLayoutMigrationAsync,
};
