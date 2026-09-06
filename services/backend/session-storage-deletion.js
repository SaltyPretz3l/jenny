const fs = require('fs');
const { logWriteFailed } = require('./session-store-logging');

// Deletion mechanics for SessionStorageBackend.deleteSession (CTL-008).
// Extracted to a sibling module to keep session-storage-backend.js under the
// repo's per-file line cap; this is otherwise a behavior-preserving move of
// the pre-existing logic PLUS the fixed failure contract below.
//
// Contract: a delete whose underlying file removal actually fails (a live
// store.delete() throw, or a non-ENOENT fs.unlinkSync throw) must NOT report
// success and must RETAIN the session: the file is still on disk, so
// dropping the cache/index entry would orphan it permanently — it would even
// survive a restart as a file the index no longer knows about. ENOENT (the
// file is already gone) is a completed delete and stays a success so retries
// converge. The pre-existing `<storeName>.delete_failed` WARN diagnostic
// still fires exactly once per failed attempt.
//
// Returns `true` on success, `{ ok: false, reason: 'delete_failed' }` on a
// genuine removal failure. Callers must never treat the failure shape as
// truthy-success (see callers in electron-session-store.js / session-shadow-
// store.js, which check `=== true` rather than bare truthiness).
function deleteSessionFromBackend(backend, sessionId) {
  const store = backend._sessionStores.get(sessionId);
  if (store) {
    try {
      store.delete();
    } catch (error) {
      logWriteFailed(
        backend._logger,
        `${backend._storeName}.delete_failed`,
        backend._sessionFilePath(sessionId),
        error
      );
      return { ok: false, reason: 'delete_failed' };
    }
    backend._sessionStores.delete(sessionId);
  } else {
    const filePath = backend._sessionFilePath(sessionId);
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        logWriteFailed(
          backend._logger,
          `${backend._storeName}.delete_failed`,
          filePath,
          error
        );
        return { ok: false, reason: 'delete_failed' };
      }
    }
  }
  backend._loadedSessions.delete(sessionId);
  backend._dirtySessionIds.delete(sessionId);
  backend._dirtyFlushFailureCounts.delete(sessionId);
  backend._durability?.forget(sessionId);
  backend._sessionLru.delete(sessionId);
  backend._scanActiveTurns.delete(sessionId);
  delete backend._cachedIndex.sessions[sessionId];
  backend._scheduleIndexWrite();
  return true;
}

module.exports = { deleteSessionFromBackend };
