const { logWriteFailed } = require('./session-store-logging');

const MAX_EVICTED_DURABILITY_PROOFS = 30;

function normalizeEpoch(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeGeneration(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function writeState(store) {
  if (!store || typeof store.getWriteState !== 'function') {
    return { durableGeneration: 0 };
  }
  const state = store.getWriteState();
  return {
    durableGeneration: normalizeGeneration(state?.durableGeneration),
  };
}

class SessionStorageDurability {
  constructor() {
    this._records = new Map();
    this._evictedProofs = new Map();
  }

  markLoaded(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    this._evictedProofs.delete(id);
    if (!this._records.has(id)) {
      this._records.set(id, {
        dirtyEpoch: 1,
        durableEpoch: 1,
        sessionGeneration: 0,
        sessionCoverageEpoch: 1,
        indexGeneration: 0,
        indexCoverageEpoch: 1,
      });
    }
    return this._records.get(id);
  }

  markAccepted(sessionId, {
    sessionGeneration = null,
    indexGeneration = null,
    indexChanged = false,
  } = {}) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    this._evictedProofs.delete(id);
    const record = this._records.get(id) || {
      dirtyEpoch: 0,
      durableEpoch: 0,
      sessionGeneration: 0,
      sessionCoverageEpoch: 0,
      indexGeneration: 0,
      indexCoverageEpoch: 0,
    };
    record.dirtyEpoch += 1;
    if (sessionGeneration != null) {
      record.sessionGeneration = normalizeGeneration(sessionGeneration);
      record.sessionCoverageEpoch = record.dirtyEpoch;
    }
    if (indexChanged) {
      if (indexGeneration != null) {
        record.indexGeneration = normalizeGeneration(indexGeneration);
        record.indexCoverageEpoch = record.dirtyEpoch;
      }
    } else {
      // A summary-neutral mutation does not stale the current index.
      record.indexCoverageEpoch = record.dirtyEpoch;
    }
    this._records.set(id, record);
    return record;
  }

  markSessionDurable(sessionId, generation) {
    const record = this._records.get(String(sessionId || '').trim());
    if (!record) return null;
    record.sessionGeneration = normalizeGeneration(generation);
    record.sessionCoverageEpoch = record.dirtyEpoch;
    return record;
  }

  markIndexDurable(sessionId, generation) {
    const record = this._records.get(String(sessionId || '').trim());
    if (!record) return null;
    record.indexGeneration = normalizeGeneration(generation);
    record.indexCoverageEpoch = record.dirtyEpoch;
    return record;
  }

  reconcile(sessionId, sessionStore, indexStore) {
    const id = String(sessionId || '').trim();
    const record = this._records.get(id);
    if (!record) return this.snapshot(id);
    const sessionDurableGeneration = writeState(sessionStore).durableGeneration;
    const indexDurableGeneration = writeState(indexStore).durableGeneration;
    const sessionCovered = record.sessionCoverageEpoch >= record.dirtyEpoch
      && sessionDurableGeneration >= record.sessionGeneration;
    const indexCovered = record.indexCoverageEpoch >= record.dirtyEpoch
      && indexDurableGeneration >= record.indexGeneration;
    if (record.dirtyEpoch > 0 && sessionCovered && indexCovered) {
      record.durableEpoch = Math.max(record.durableEpoch, record.dirtyEpoch);
    }
    return this.snapshot(id);
  }

  needsIndexFlush(sessionId, indexStore) {
    const record = this._records.get(String(sessionId || '').trim());
    if (!record) return false;
    const durableGeneration = writeState(indexStore).durableGeneration;
    return record.indexCoverageEpoch < record.dirtyEpoch
      || durableGeneration < record.indexGeneration;
  }

  snapshot(sessionId) {
    const id = String(sessionId || '').trim();
    const record = this._records.get(id) || this._evictedProofs.get(id);
    if (!record) return null;
    return {
      dirtyEpoch: normalizeEpoch(record.dirtyEpoch),
      durableEpoch: normalizeEpoch(record.durableEpoch),
    };
  }

  forget(sessionId) {
    const id = String(sessionId || '').trim();
    this._records.delete(id);
    this._evictedProofs.delete(id);
  }

  evict(sessionId) {
    const id = String(sessionId || '').trim();
    const record = this._records.get(id);
    if (record && record.dirtyEpoch > 0 && record.durableEpoch >= record.dirtyEpoch) {
      this._evictedProofs.delete(id);
      this._evictedProofs.set(id, {
        dirtyEpoch: record.dirtyEpoch,
        durableEpoch: record.durableEpoch,
      });
      while (this._evictedProofs.size > MAX_EVICTED_DURABILITY_PROOFS) {
        this._evictedProofs.delete(this._evictedProofs.keys().next().value);
      }
    }
    this._records.delete(id);
  }
}

// _pruneCache's loadedSessions branch only reaches here once
// hasPendingWriteForSession(sessionId) is false, i.e. dirtyEpoch <=
// durableEpoch, no _dirtySessionIds entry, and no in-flight store write. Keep
// only a bounded clean epoch proof so finalizeCommit can observe durability
// after a newly written oversized record self-evicts. A later load or accepted
// mutation replaces that proof with a fresh active record; hard deletion
// removes both forms.
function evictLoadedSession(self, sessionId) {
  self._loadedSessions.delete(sessionId);
  self._durability.evict(sessionId);
}

function reconcileSessionDurability(self, sessionId) {
  const store = self._sessionStores.get(sessionId) || null;
  const state = self._durability.reconcile(sessionId, store, self._indexStore);
  if (state && state.dirtyEpoch === state.durableEpoch) {
    self._dirtySessionIds.delete(sessionId);
    self._dirtyFlushFailureCounts.delete(sessionId);
  } else if (state && state.dirtyEpoch > state.durableEpoch) {
    self._dirtySessionIds.add(sessionId);
  }
  return state;
}

function recordAcceptedSessionMutation(self, sessionId, {
  sessionWrite = null,
  indexWrite = null,
  indexChanged = false,
} = {}) {
  const state = self._durability.markAccepted(sessionId, {
    sessionGeneration: sessionWrite?.generation,
    indexGeneration: indexWrite?.generation,
    indexChanged,
  });
  self._dirtySessionIds.add(sessionId);
  return reconcileSessionDurability(self, sessionId) || state;
}

function flushSessionDurably(self, sessionId) {
  if (self._mode === 'monolithic_readonly' || self._newerSchemaVersion > 0) {
    return false;
  }
  const session = self._loadedSessions.get(sessionId);
  if (!session) return false;
  self._durability.markLoaded(sessionId);
  try {
    const store = self._getOrCreateSessionStore(sessionId);
    const sessionWrite = store.writeImmediate({
      schema_version: self._schemaVersion,
      session,
    });
    self._durability.markSessionDurable(sessionId, sessionWrite?.generation);
    if (self._durability.needsIndexFlush(sessionId, self._indexStore)) {
      const indexWrite = self._indexStore.writeImmediate(self._cachedIndex);
      self._indexDirty = false;
      self._durability.markIndexDurable(sessionId, indexWrite?.generation);
    }
    const state = reconcileSessionDurability(self, sessionId);
    return Boolean(
      state
      && state.dirtyEpoch > 0
      && state.durableEpoch >= state.dirtyEpoch
    );
  } catch (error) {
    logWriteFailed(
      self._logger,
      `${self._storeName}.flush_session_failed`,
      self._sessionFilePath(sessionId),
      error
    );
    return false;
  }
}

function restoreCachedSessionSnapshot(self, sessionId, snapshot, indexSnapshot = null) {
  if (self._mode === 'monolithic_readonly' || self._newerSchemaVersion > 0) return false;
  const normalized = self._normalizeSession(sessionId, snapshot);
  const nextIndex = indexSnapshot || {
    ...self._cachedIndex,
    sessions: { ...(self._cachedIndex.sessions || {}), [sessionId]: self._summarizeSession(normalized) },
  };
  self._cachedIndex = nextIndex;
  self._loadedSessions.set(sessionId, normalized);
  self._transcriptCache?.invalidate(sessionId, normalized);
  self._durability.markAccepted(sessionId, { indexChanged: true });
  self._dirtySessionIds.add(sessionId);
  self._trackActiveTurn(sessionId, normalized);
  self._touchSession(sessionId);
  const store = self._getOrCreateSessionStore(sessionId);
  let sessionWrite = null;
  let indexWrite = null;
  try {
    sessionWrite = store.writeImmediate({ schema_version: self._schemaVersion, session: normalized });
    self._durability.markSessionDurable(sessionId, sessionWrite?.generation);
  } catch (error) {
    logWriteFailed(self._logger, `${self._storeName}.restore_snapshot_failed`, store.filePath, error);
  }
  try {
    indexWrite = self._indexStore.writeImmediate(nextIndex);
    self._indexDirty = false;
    self._durability.markIndexDurable(sessionId, indexWrite?.generation);
  } catch (error) {
    self._indexDirty = true;
    logWriteFailed(self._logger, `${self._storeName}.restore_index_failed`, self._indexPath, error);
  }
  const sessionState = store.getWriteState();
  const indexState = self._indexStore.getWriteState();
  const state = reconcileSessionDurability(self, sessionId);
  return Boolean(
    sessionWrite && indexWrite
    && sessionState.durableGeneration >= sessionWrite.generation
    && indexState.durableGeneration >= indexWrite.generation
    && state?.durableEpoch >= state?.dirtyEpoch
  );
}

module.exports = {
  SessionStorageDurability,
  flushSessionDurably,
  reconcileSessionDurability,
  recordAcceptedSessionMutation,
  restoreCachedSessionSnapshot,
  evictLoadedSession,
};
