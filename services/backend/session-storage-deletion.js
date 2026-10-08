const fs = require('fs');
const { logWriteFailed, safeEmitLog } = require('./session-store-logging');
const { purgeSessionRecoveryCopies } = require('./session-recovery-copies');
const { deleteSessionJournals } = require('./session-journal-wiring');
const { skipsReadonlyModeWrite } = require('./session-storage-guards');

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
// A journaled chat also has journal files. The base file is the record of
// existence: once it is gone the chat is deleted, and a journal that could not
// be removed only logs `<storeName>.journal_delete_failed` (the legacy prune
// removes a leftover journal without a base).
//
// Returns `true` on success, `{ ok: false, reason: 'delete_failed' }` on a
// genuine removal failure. Callers must never treat the failure shape as
// truthy-success (see callers in electron-session-store.js / session-shadow-
// store.js, which check `=== true` rather than bare truthiness).
function deleteSessionFromBackend(backend, sessionId) {
  // A failed split migration only drops the in-memory copy (see the guard).
  const readonly = skipsReadonlyModeWrite(backend, 'deleteSession');
  const store = backend._sessionStores.get(sessionId);
  if (readonly) {
    // The legacy file still holds the chat; nothing on disk is touched.
  } else if (store) {
    try {
      store.delete();
    } catch (error) {
      const filePath = backend._sessionFilePath(sessionId);
      if (!backend._journal || fs.existsSync(filePath)) {
        logWriteFailed(backend._logger, `${backend._storeName}.delete_failed`, filePath, error);
        return { ok: false, reason: 'delete_failed' };
      }
      logWriteFailed(backend._logger, `${backend._storeName}.journal_delete_failed`, filePath, error);
    }
    backend._sessionStores.delete(sessionId);
    // A plain store (kill switch) leaves the journals of an earlier journaling run.
    deleteSessionJournals(backend, sessionId, backend._sessionFilePath(sessionId));
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
    deleteSessionJournals(backend, sessionId, filePath);
  }
  backend._loadedSessions.delete(sessionId);
  backend._dirtySessionIds.delete(sessionId);
  backend._dirtyFlushFailureCounts.delete(sessionId);
  backend._durability?.forget(sessionId);
  backend._sessionLru.delete(sessionId);
  backend._scanActiveTurns.delete(sessionId);
  delete backend._cachedIndex.sessions[sessionId];
  backend._scheduleIndexWrite();
  if (readonly) return true;
  // Best effort: the delete itself already succeeded.
  const purged = purgeSessionRecoveryCopies(backend, sessionId);
  if (purged.failed > 0) {
    safeEmitLog(backend._logger, 'WARN', `${backend._storeName}.recovery_copy_delete_failed`, {
      sessionId,
      failed: purged.failed,
    });
  }
  return true;
}

module.exports = { deleteSessionFromBackend };
