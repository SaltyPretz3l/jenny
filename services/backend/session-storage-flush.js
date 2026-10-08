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

// A cleanly closed or asynchronously flushed store (shutdown, backup, uninstall)
// leaves complete base files, which scripts and other processes read directly.
// The synchronous flush is a durability barrier on hot paths (it runs on every
// chat delete) and does not compact. The index compacts after the chat stores.
function compactSessionStores(backend) {
    const stores = [...backend._sessionStores.values()];
    if (backend._indexStore) stores.push(backend._indexStore);
    for (const store of stores) {
      try {
        store.compact?.();
      } catch (error) {
        logWriteFailed(
          backend._logger,
          `${backend._storeName}.flush_failed`,
          store.filePath,
          error
        );
      }
      // A compaction that could not run must not run later from a timer, after
      // the owner has shut down and the files may belong to someone else.
      if (backend._disposed) store.cancelScheduledCompaction?.();
    }
}

function flushBackend(backend, { compact = false } = {}) {
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
    if (compact) compactSessionStores(backend);
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
    compactSessionStores(backend);
    return wroteAny;
}

module.exports = { flushBackend, flushBackendAsync };
