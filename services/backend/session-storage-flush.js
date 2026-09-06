const { logWriteFailed } = require('./session-store-logging');
const { reconcileDirtyAfterFlush } = require('./session-storage-guards');

// Flush mechanics for SessionStorageBackend.flush / flushAsync.
// Extracted to a sibling module to keep session-storage-backend.js under the
// repo's per-file line cap; this is otherwise a behavior-preserving move.
function indexRequiresWrite(backend) {
    const state = backend._indexStore?.getWriteState?.();
    return backend._indexDirty || Boolean(state && (
      state.acceptedGeneration > state.durableGeneration
      || (state.failedGeneration > 0 && state.failedGeneration === state.acceptedGeneration)
    ));
}

function flushBackend(backend) {
    if (backend._mode === 'monolithic_readonly' || backend._newerSchemaVersion > 0) {
      return false;
    }
    let wroteAny = false;
    const flushedSessionIds = [];
    const failedSessionIds = [];
    for (const sessionId of backend._dirtySessionIds) {
      const session = backend._loadedSessions.get(sessionId);
      if (!session) {
        // No loaded record to persist: an unloaded dirty id can never be written
        // and must not be retried forever, so drop it.
        flushedSessionIds.push(sessionId);
        continue;
      }
      try {
        const store = backend._getOrCreateSessionStore(sessionId);
        const write = store.writeImmediate({
          schema_version: backend._schemaVersion,
          session,
        });
        backend._durability.markSessionDurable(sessionId, write?.generation);
        wroteAny = true;
        flushedSessionIds.push(sessionId);
      } catch (error) {
        failedSessionIds.push(sessionId);
        logWriteFailed(
          backend._logger,
          `${backend._storeName}.flush_failed`,
          backend._sessionFilePath(sessionId),
          error
        );
      }
    }
    for (const [, store] of backend._sessionStores) {
      try {
        if (typeof store.flush === 'function' && store.flush()) {
          wroteAny = true;
        }
      } catch (error) {
        logWriteFailed(
          backend._logger,
          `${backend._storeName}.flush_failed`,
          store.filePath,
          error
        );
      }
    }

    if (backend._indexStore) {
      if (indexRequiresWrite(backend) && !backend._pendingSplitMigration) {
        try {
          backend._indexStore.writeImmediate(backend._cachedIndex);
          backend._indexDirty = false;
          wroteAny = true;
        } catch (error) {
          logWriteFailed(
            backend._logger,
            `${backend._storeName}.flush_failed`,
            backend._indexPath,
            error
          );
        }
      }
      try {
        if (typeof backend._indexStore.flush === 'function' && backend._indexStore.flush()) {
          wroteAny = true;
        }
      } catch (error) {
        logWriteFailed(
          backend._logger,
          `${backend._storeName}.flush_failed`,
          backend._indexPath,
          error
        );
      }
    }
    const indexState = backend._indexStore?.getWriteState?.();
    if (
      !backend._pendingSplitMigration
      && indexState
      && indexState.durableGeneration >= indexState.acceptedGeneration
    ) {
      for (const sessionId of flushedSessionIds) {
        backend._durability.markIndexDurable(sessionId, indexState.durableGeneration);
      }
    }
    reconcileDirtyAfterFlush(backend, flushedSessionIds, failedSessionIds);
    return wroteAny;
}

async function flushBackendAsync(backend) {
    if (backend._mode === 'monolithic_readonly' || backend._newerSchemaVersion > 0) {
      return false;
    }
    let wroteAny = false;
    const flushedSessionIds = [];
    const failedSessionIds = [];
    for (const sessionId of backend._dirtySessionIds) {
      const session = backend._loadedSessions.get(sessionId);
      if (!session) {
        // No loaded record to persist: drop the unwritable dirty id.
        flushedSessionIds.push(sessionId);
        continue;
      }
      try {
        const store = backend._getOrCreateSessionStore(sessionId);
        // writeImmediate (not debounced write()) so a disk failure THROWS -> retained/retried, not silently cleared.
        const write = store.writeImmediate({
          schema_version: backend._schemaVersion,
          session,
        });
        backend._durability.markSessionDurable(sessionId, write?.generation);
        wroteAny = true;
        flushedSessionIds.push(sessionId);
      } catch (error) {
        failedSessionIds.push(sessionId);
        logWriteFailed(
          backend._logger,
          `${backend._storeName}.flush_failed`,
          backend._sessionFilePath(sessionId),
          error
        );
      }
    }
    const pendingStoreFlushes = [];
    for (const [, store] of backend._sessionStores) {
      if (typeof store.flushAsync === 'function') {
        pendingStoreFlushes.push(
          store.flushAsync()
            .then((didWrite) => {
              if (didWrite) {
                wroteAny = true;
              }
            })
            .catch((error) => {
              logWriteFailed(
                backend._logger,
                `${backend._storeName}.flush_failed`,
                store.filePath,
                error
              );
            })
        );
      } else {
        try {
          if (typeof store.flush === 'function' && store.flush()) {
            wroteAny = true;
          }
        } catch (error) {
          logWriteFailed(
            backend._logger,
            `${backend._storeName}.flush_failed`,
            store.filePath,
            error
          );
        }
      }
    }

    if (backend._indexStore) {
      if (indexRequiresWrite(backend) && !backend._pendingSplitMigration) {
        try {
          backend._indexStore.write(backend._cachedIndex);
          backend._indexDirty = false;
          wroteAny = true;
        } catch (error) {
          logWriteFailed(
            backend._logger,
            `${backend._storeName}.flush_failed`,
            backend._indexPath,
            error
          );
        }
      }
      if (typeof backend._indexStore.flushAsync === 'function') {
        pendingStoreFlushes.push(
          backend._indexStore.flushAsync()
            .then((didWrite) => {
              if (didWrite) {
                wroteAny = true;
              }
            })
            .catch((error) => {
              logWriteFailed(
                backend._logger,
                `${backend._storeName}.flush_failed`,
                backend._indexPath,
                error
              );
            })
        );
      } else {
        try {
          if (typeof backend._indexStore.flush === 'function' && backend._indexStore.flush()) {
            wroteAny = true;
          }
        } catch (error) {
          logWriteFailed(
            backend._logger,
            `${backend._storeName}.flush_failed`,
            backend._indexPath,
            error
          );
        }
      }
    }

    if (pendingStoreFlushes.length) {
      await Promise.all(pendingStoreFlushes);
    }
    const indexState = backend._indexStore?.getWriteState?.();
    if (
      !backend._pendingSplitMigration
      && indexState
      && indexState.durableGeneration >= indexState.acceptedGeneration
    ) {
      for (const sessionId of flushedSessionIds) {
        backend._durability.markIndexDurable(sessionId, indexState.durableGeneration);
      }
    }
    reconcileDirtyAfterFlush(backend, flushedSessionIds, failedSessionIds);
    return wroteAny;
}

module.exports = { flushBackend, flushBackendAsync };
