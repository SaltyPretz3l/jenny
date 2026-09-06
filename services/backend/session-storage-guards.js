const {
  logNewerSchemaDetected,
  safeEmitLog,
} = require('./session-store-logging');

// Durability / schema guards for SessionStorageBackend. Like
// session-storage-migration.js, these helpers take the backend instance
// (`self`) and operate on its private state so the backend file stays legible.

// True when a per-session-file envelope declares a schema_version NEWER than the
// store understands. Such a file was written by a newer app; loading or
// migrating it into the current-schema world would strip its unknown fields
// (normalizeSession is a strict whitelist) and silently downgrade it on the next
// rewrite. A bare (unwrapped) session record has no numeric schema_version and
// is not treated as newer.
function readsNewerSchema(self, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const observed = Number(raw.schema_version);
  return Number.isFinite(observed) && observed > self._schemaVersion;
}

// Freeze the whole store read-only on a newer on-disk schema — consistent with
// the index-level guard in _loadFromSplitLayout. Records the highest observed
// version (so upsert/delete refuse writes) and emits a per-file diagnostic that
// mirrors the index-level newer_schema_detected log shape.
function enterNewerSchemaFreeze(self, observedVersion, filePath) {
  const observed = Number(observedVersion);
  if (Number.isFinite(observed) && observed > self._newerSchemaVersion) {
    self._newerSchemaVersion = observed;
  }
  logNewerSchemaDetected(
    self._logger,
    `${self._storeName}.newer_schema_detected`,
    filePath,
    observed,
    self._schemaVersion
  );
}

// Consecutive failed-flush attempts before the retained-dirty diagnostic is
// emitted. Accepted but undurable state is never discarded merely because the
// disk remains unavailable.
const DIRTY_FLUSH_FAILURE_CAP = 3;

// Reconcile the dirty-session set after a flush pass:
//   - flushedSessionIds: written to disk (or unwritable/empty) -> cleared from
//     the dirty set and their failure counter reset.
//   - failedSessionIds:  the write threw -> RETAINED as dirty so the unsaved
//     state survives to the next flush AND stays protected from cache eviction
//     (hasPendingWriteForSession returns true for a dirty id). After
//     DIRTY_FLUSH_FAILURE_CAP consecutive failures the id is dropped with one
//     ERROR once; the dirty id remains eviction-protected and retryable.
// The previous unconditional `_dirtySessionIds.clear()` dropped the dirty mark
// even on a throw, so a transient disk error lost the session's unsaved
// active-turn touch (and let _pruneCache evict it from memory too).
function reconcileDirtyAfterFlush(self, flushedSessionIds, failedSessionIds) {
  for (const sessionId of flushedSessionIds) {
    const durability = self._durability?.reconcile(
      sessionId,
      self._sessionStores.get(sessionId) || null,
      self._indexStore
    );
    if (!durability || durability.durableEpoch >= durability.dirtyEpoch) {
      self._dirtySessionIds.delete(sessionId);
      self._dirtyFlushFailureCounts.delete(sessionId);
    } else {
      self._dirtySessionIds.add(sessionId);
    }
  }
  for (const sessionId of failedSessionIds) {
    const attempts = (self._dirtyFlushFailureCounts.get(sessionId) || 0) + 1;
    self._dirtySessionIds.add(sessionId);
    self._dirtyFlushFailureCounts.set(sessionId, Math.min(attempts, DIRTY_FLUSH_FAILURE_CAP));
    if (attempts === DIRTY_FLUSH_FAILURE_CAP) {
      safeEmitLog(self._logger, 'ERROR', `${self._storeName}.flush_dirty_retained_after_retries`, {
        sessionId,
        attempts,
      });
    }
  }
}

// After a split-index recovery pass froze the store on a future-schema file,
// drop the partially recovered state and present an empty index rather than
// rebuild a current-schema index over data a newer app owns. Writes are already
// blocked by _newerSchemaVersion, so the store fails closed.
function freezeRecoveredIndex(self) {
  self._loadedSessions.clear();
  self._scanActiveTurns.clear();
  self._cachedIndex = { schema_version: self._schemaVersion, sessions: {} };
}

module.exports = {
  DIRTY_FLUSH_FAILURE_CAP,
  reconcileDirtyAfterFlush,
  readsNewerSchema,
  enterNewerSchemaFreeze,
  freezeRecoveredIndex,
};
