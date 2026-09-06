const fs = require('fs');
const path = require('path');

const { FileJsonStore } = require('./file-json-store');
const {
  logNewerSchemaDetected,
  logWriteFailed,
  safeEmitLog,
} = require('./session-store-logging');
const {
  sanitizeSessionId,
  deriveSessionsDirectory,
  summariesEqual,
} = require('./session-storage-fs-utils');
const {
  SPLIT_MIGRATION_BATCH_SIZE,
  migrateFromMonolithic,
  queueSplitLayoutMigration,
  runSplitLayoutMigrationAsync,
} = require('./session-storage-migration');
const {
  readsNewerSchema,
  enterNewerSchemaFreeze,
  freezeRecoveredIndex,
} = require('./session-storage-guards');
const { deleteSessionFromBackend } = require('./session-storage-deletion');
const { flushBackend, flushBackendAsync } = require('./session-storage-flush');
const {
  SessionStorageDurability,
  flushSessionDurably,
  reconcileSessionDurability,
  recordAcceptedSessionMutation,
  restoreCachedSessionSnapshot, evictLoadedSession,
} = require('./session-storage-durability');

// Per-session directory backend used by ElectronSessionStore and
// SessionShadowStore. Replaces the single-file monolithic layout that froze
// the UI on long histories (every active-turn touch rewrote 64MB+). With the
// split, per-write cost is O(one session) regardless of total history.
//
// Layout (rooted at `rootDir`):
//   rootDir/_index.json         - summaries used by listSessions / lookups
//   rootDir/<sessionId>.json    - full session record, lazy-loaded on first get
//
// On construct, if a legacy monolithic file is present and no index exists,
// the backend runs the supplied `migratePayload` over the monolithic payload,
// writes per-session files + the index atomically, then renames the monolithic
// file to `<monolithic>.migrated-<timestamp>` so it can be inspected.
//
// Public surface (all instance methods):
//   - getIndexSnapshot()            -> { schema_version, sessions: { id: summary } }
//   - getSession(id)                -> normalized record or null (lazy disk read)
//   - peekSession(id)               -> cache-neutral read for bulk scans (read-only)
//   - getActiveTurnSnapshots()      -> Map(id -> active_turn) without loading bodies
//   - upsertSession(id, record, { persist })
//   - deleteSession(id)             -> true on success; `{ ok: false, reason }`
//     (or false for the newer-schema/unknown-session early returns) when the
//     underlying file removal genuinely failed — the session is RETAINED so
//     the still-on-disk data isn't orphaned (see session-storage-deletion.js)
//   - flush()                       -> boolean (true if any disk write happened)
//   - dispose()                     -> flush + drop file handles
//   - hasNewerSchema()
//   - hasPendingWriteForSession(id), hasPendingWrites()
//
// Modes:
//   - `split` (default): per-session files + index
//   - `monolithic_readonly`: a future-schema monolithic file was found; data
//     stays in memory, no disk writes are scheduled, write attempts log
//     `<store>.newer_schema_write_blocked` and return without touching disk.
class SessionStorageBackend {
  constructor(rootDir, {
    legacyMonolithicPath = null,
    schemaVersion,
    legacyMaxSchemaVersion = schemaVersion,
    migratePayload,
    normalizeSession,
    summarizeSession,
    writeDebounceMs = 0,
    logger = null,
    storeName = 'session_store',
  } = {}) {
    if (!rootDir) {
      throw new Error('SessionStorageBackend requires a rootDir.');
    }
    if (typeof migratePayload !== 'function') {
      throw new Error('SessionStorageBackend requires a migratePayload function.');
    }
    if (typeof normalizeSession !== 'function') {
      throw new Error('SessionStorageBackend requires a normalizeSession function.');
    }
    if (typeof summarizeSession !== 'function') {
      throw new Error('SessionStorageBackend requires a summarizeSession function.');
    }
    this._rootDir = rootDir;
    this._indexPath = path.join(rootDir, '_index.json');
    this._legacyMonolithicPath = legacyMonolithicPath || null;
    this._schemaVersion = schemaVersion;
    this._legacyMaxSchemaVersion = legacyMaxSchemaVersion;
    this._migratePayload = migratePayload;
    this._normalizeSession = normalizeSession;
    this._summarizeSession = summarizeSession;
    this._writeDebounceMs = Math.max(0, Number(writeDebounceMs) || 0);
    this._logger = typeof logger === 'function' ? logger : null;
    this._storeName = String(storeName || 'session_store');

    this._mode = 'split';
    this._newerSchemaVersion = 0;
    this._cachedIndex = { schema_version: this._schemaVersion, sessions: {} };
    this._indexStore = null;
    this._indexDirty = false;
    this._sessionStores = new Map();
    this._loadedSessions = new Map();
    this._dirtySessionIds = new Set();
    this._durability = new SessionStorageDurability();
    this._dirtyFlushFailureCounts = new Map();
    this._sessionLru = new Set();
    // Scan registry: sessionId -> active_turn (or null) for every session the
    // backend has authoritative in-memory knowledge of. Lets bulk callers
    // (listSessionRecords) answer active_turn without loading message bodies.
    // Lazily seeded from disk once per process by getActiveTurnSnapshots(),
    // then maintained on every upsert/load/delete.
    this._scanActiveTurns = new Map();
    this._activeTurnScanSeeded = false;
    this._pendingSplitMigration = null;
    this._pendingMigrationPromise = null;

    this._initialize();
  }

  _initialize() {
    if (fs.existsSync(this._indexPath)) {
      this._loadFromSplitLayout();
      return;
    }
    if (
      !(this._legacyMonolithicPath && fs.existsSync(this._legacyMonolithicPath))
      && this._recoverSplitIndexFromSessionFiles('missing_index')
    ) {
      return;
    }
    if (this._legacyMonolithicPath && fs.existsSync(this._legacyMonolithicPath)) {
      this._migrateFromMonolithic();
      return;
    }
    this._initializeEmpty();
  }

  _initializeEmpty() {
    fs.mkdirSync(this._rootDir, { recursive: true });
    this._indexStore = new FileJsonStore(this._indexPath, {
      writeDebounceMs: this._writeDebounceMs,
      logger: this._logger,
    });
    this._cachedIndex = { schema_version: this._schemaVersion, sessions: {} };
  }

  _loadFromSplitLayout() {
    this._indexStore = new FileJsonStore(this._indexPath, {
      writeDebounceMs: this._writeDebounceMs,
      logger: this._logger,
    });
    const raw = this._indexStore.read(null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      if (this._recoverSplitIndexFromSessionFiles('unreadable_index')) {
        return;
      }
      this._cachedIndex = { schema_version: this._schemaVersion, sessions: {} };
      return;
    }
    const observed = Number(raw?.schema_version || 1);
    if (Number.isFinite(observed) && observed > this._schemaVersion) {
      this._newerSchemaVersion = observed;
      logNewerSchemaDetected(
        this._logger,
        `${this._storeName}.newer_schema_detected`,
        this._indexPath,
        observed,
        this._schemaVersion
      );
    }
    const indexSessions =
      raw && raw.sessions && typeof raw.sessions === 'object' && !Array.isArray(raw.sessions)
        ? raw.sessions
        : {};
    if (
      (!raw.sessions || typeof raw.sessions !== 'object' || Array.isArray(raw.sessions))
      && this._newerSchemaVersion === 0
      && this._recoverSplitIndexFromSessionFiles('malformed_index')
    ) {
      return;
    }
    if (
      this._newerSchemaVersion === 0
      && Number.isFinite(observed)
      && observed < this._schemaVersion
    ) {
      this._queueSplitLayoutMigration(raw, observed);
      return;
    }
    this._cachedIndex = {
      schema_version: this._schemaVersion,
      sessions: { ...indexSessions },
    };
  }

  _queueSplitLayoutMigration(indexRaw, observedVersion) {
    return queueSplitLayoutMigration(this, indexRaw, observedVersion);
  }

  _migrateFromMonolithic() {
    return migrateFromMonolithic(this);
  }

  // Public API

  hasNewerSchema() {
    return this._newerSchemaVersion > 0;
  }

  getIndexSnapshot() {
    return {
      schema_version: this._cachedIndex.schema_version,
      sessions: { ...(this._cachedIndex.sessions || {}) },
    };
  }

  hasSession(sessionId) {
    return Object.prototype.hasOwnProperty.call(
      this._cachedIndex.sessions || {},
      sessionId
    );
  }

  getSessionIds() {
    return Object.keys(this._cachedIndex.sessions || {});
  }

  getSession(sessionId) {
    if (!this.hasSession(sessionId)) {
      return null;
    }
    const session = this._loadSession(sessionId);
    if (session) this._durability.markLoaded(sessionId);
    return session;
  }

  // Cache-neutral read for bulk scans (attachment-asset sweep, active-turn
  // seed). Returns the authoritative cached record when loaded — which covers
  // every session with a pending debounced write, since _pruneCache never
  // evicts those — otherwise reads and normalizes straight from disk WITHOUT
  // inserting into the session LRU. Periodic whole-store walks previously
  // churned the entire 30-slot cache (hot active session included) per pass.
  // Callers must treat the result as read-only.
  peekSession(sessionId) {
    if (!this.hasSession(sessionId)) {
      return null;
    }
    if (this._loadedSessions.has(sessionId)) {
      return this._loadedSessions.get(sessionId);
    }
    if (this._mode === 'monolithic_readonly') {
      // monolithic_readonly pre-populates every session into the loaded cache
      // during init; a miss here means the session truly doesn't exist.
      return null;
    }
    return this._readSessionFromDisk(sessionId);
  }

  // Active-turn view over every indexed session, answered from the scan
  // registry instead of loading session bodies. First call seeds the registry
  // with one cache-neutral disk pass (crash-orphaned turns from a previous run
  // live only on disk); later calls are O(index). Values are the normalized
  // active_turn objects by reference — read-only, like getSession() records.
  getActiveTurnSnapshots() {
    this._seedActiveTurnScan();
    const snapshots = new Map();
    for (const [sessionId, activeTurn] of this._scanActiveTurns) {
      if (activeTurn && this.hasSession(sessionId)) {
        snapshots.set(sessionId, activeTurn);
      }
    }
    return snapshots;
  }

  upsertSession(sessionId, sessionRecord, { persist = true, alreadyNormalized = false } = {}) {
    if (this._newerSchemaVersion > 0) {
      this._logNewerSchemaWriteBlocked();
      return false;
    }
    // The store layer hands us records that are already normalizeSession()
    // output; re-normalizing them here was a redundant full message-array walk
    // on every mutation (findings #3, #4). Callers that pass raw/summary records
    // (mirror _write, index inserts) leave alreadyNormalized=false.
    if (this.hasSession(sessionId)) this._durability.markLoaded(sessionId);
    const normalized = alreadyNormalized ? sessionRecord : this._normalizeSession(sessionId, sessionRecord);

    if (!persist) {
      const summary = this._summarizeSession(normalized);
      const cachedSummary = this._cachedIndex.sessions[sessionId];
      const indexChanged = !cachedSummary || !summariesEqual(cachedSummary, summary);
      if (indexChanged) {
        this._cachedIndex = {
          ...this._cachedIndex,
          sessions: { ...(this._cachedIndex.sessions || {}), [sessionId]: summary },
        };
        this._indexDirty = true;
      }
      recordAcceptedSessionMutation(this, sessionId, { indexChanged });
      this._loadedSessions.set(sessionId, normalized);
      this._trackActiveTurn(sessionId, normalized);
      this._touchSession(sessionId);
      return true;
    }

    const summary = this._summarizeSession(normalized);
    const cachedSummary = this._cachedIndex.sessions[sessionId];
    const summaryChanged = !cachedSummary || !summariesEqual(cachedSummary, summary);
    const nextIndex = summaryChanged
      ? {
          schema_version: this._cachedIndex.schema_version,
          sessions: { ...(this._cachedIndex.sessions || {}), [sessionId]: summary },
        }
      : this._cachedIndex;

    let writeError = null;
    let sessionWrite = null;
    try {
      const store = this._getOrCreateSessionStore(sessionId);
      sessionWrite = store.write({
        schema_version: this._schemaVersion,
        session: normalized,
      });
    } catch (error) {
      writeError = error;
      logWriteFailed(
        this._logger,
        `${this._storeName}.write_failed`,
        this._sessionFilePath(sessionId),
        error
      );
    }
    // Skip the index write when the summary fields are unchanged, e.g.
    // setActiveTurn / clearActiveTurn / appendTurnEvents mutate per-session
    // state but never touch any summary field, so rewriting the index would
    // be a no-op disk hit. Index writes still happen for title/preview/
    // preference changes where the summary genuinely shifts.
    let deferredIndexWrite = false;
    let indexWrite = null;
    if (!writeError && this._indexStore && summaryChanged) {
      if (this._pendingSplitMigration) {
        deferredIndexWrite = true;
      } else {
        try {
          indexWrite = this._indexStore.write(nextIndex);
        } catch (error) {
          writeError = error;
          logWriteFailed(
            this._logger,
            `${this._storeName}.write_failed`,
            this._indexPath,
            error
          );
        }
      }
    }
    if (writeError) {
      return false;
    }
    if (summaryChanged) {
      this._indexDirty = deferredIndexWrite;
      this._cachedIndex = nextIndex;
    }
    this._loadedSessions.set(sessionId, normalized);
    recordAcceptedSessionMutation(this, sessionId, {
      sessionWrite,
      indexWrite,
      indexChanged: summaryChanged,
    });
    this._trackActiveTurn(sessionId, normalized);
    this._touchSession(sessionId);
    return true;
  }

  deleteSession(sessionId) {
    if (this._newerSchemaVersion > 0) {
      this._logNewerSchemaWriteBlocked();
      return false;
    }
    if (!this.hasSession(sessionId)) {
      return false;
    }
    return deleteSessionFromBackend(this, sessionId);
  }

  flush() {
    return flushBackend(this);
  }

  async flushAsync() {
    return flushBackendAsync(this);
  }

  dispose() {
    this.flush();
  }

  async disposeAsync() {
    await this.flushAsync();
  }

  // Force a single session's cached record to disk immediately, bypassing the
  // debounce window, and report whether the bytes actually landed. Callers that
  // must confirm durability before discarding a crash-recovery source (e.g. the
  // turn-event journal) use this: with writeDebounceMs > 0 an upsert only
  // SCHEDULES a best-effort async write, so "accepted into cache" is not "safe
  // on disk". Refuses when the store is frozen (monolithic_readonly or a newer
  // on-disk schema) so a current-schema payload never overwrites future bytes.
  flushSession(sessionId) {
    return flushSessionDurably(this, sessionId);
  }

  getSessionDurability(sessionId) {
    return reconcileSessionDurability(this, sessionId);
  }

  restoreSessionSnapshot(sessionId, snapshot, indexSnapshot) {
    return restoreCachedSessionSnapshot(this, sessionId, snapshot, indexSnapshot);
  }
  hasPendingWriteForSession(sessionId) {
    const durability = reconcileSessionDurability(this, sessionId);
    if (durability && durability.dirtyEpoch > durability.durableEpoch) return true;
    if (this._dirtySessionIds.has(sessionId)) {
      return true;
    }
    const store = this._sessionStores.get(sessionId);
    return Boolean(store && typeof store.hasPendingWrite === 'function' && store.hasPendingWrite());
  }

  hasPendingWrites() {
    if (this._indexDirty || this._dirtySessionIds.size > 0) return true;
    if (this._indexStore?.hasPendingWrite?.()) return true;
    for (const store of this._sessionStores.values()) {
      if (store?.hasPendingWrite?.()) return true;
    }
    return false;
  }

  hasPendingMigrations() {
    return Boolean(this._pendingSplitMigration);
  }

  async runPendingMigrations({ batchSize = SPLIT_MIGRATION_BATCH_SIZE } = {}) {
    if (!this._pendingSplitMigration) {
      return {
        ran: false,
        success: true,
        storeName: this._storeName,
        reason: 'none',
      };
    }
    if (this._pendingMigrationPromise) {
      return this._pendingMigrationPromise;
    }
    this._pendingMigrationPromise = runSplitLayoutMigrationAsync(this, {
      batchSize,
    }).finally(() => {
      this._pendingMigrationPromise = null;
    });
    return this._pendingMigrationPromise;
  }

  _touchSession(sessionId) {
    this._sessionLru.delete(sessionId);
    this._sessionLru.add(sessionId);
    this._pruneCache();
  }

  _pruneCache() {
    const maxCached = 30;
    if (this._loadedSessions.size <= maxCached && this._sessionStores.size <= maxCached) {
      return;
    }
    for (const sessionId of this._sessionLru) {
      if (this._loadedSessions.size > maxCached) {
        // A session whose disk write is still debounced/in-flight must keep
        // its cache entry: evicting it would make the next getSession()
        // re-read STALE disk bytes and silently revert the pending mutation
        // (2026-07-02 lifecycle-triage F4 — a mass session load mid-window
        // dropped a freshly persisted user message this way).
        if (!this.hasPendingWriteForSession(sessionId)) {
          evictLoadedSession(this, sessionId);
        }
      }
      if (this._sessionStores.size > maxCached) {
        const store = this._sessionStores.get(sessionId);
        if (store && !store.hasPendingWrite()) {
          try {
            store.dispose();
          } catch (_e) {
            void _e;
          }
          this._sessionStores.delete(sessionId);
        }
      }
      if (this._loadedSessions.size <= maxCached && this._sessionStores.size <= maxCached) {
        break;
      }
    }
  }

  _loadSession(sessionId) {
    if (this._loadedSessions.has(sessionId)) {
      this._touchSession(sessionId);
      return this._loadedSessions.get(sessionId);
    }
    if (this._mode === 'monolithic_readonly') {
      // monolithic_readonly pre-populates every session into the loaded cache
      // during init; a miss here means the session truly doesn't exist.
      return null;
    }
    const normalized = this._readSessionFromDisk(sessionId);
    if (!normalized) {
      return null;
    }
    this._loadedSessions.set(sessionId, normalized);
    this._trackActiveTurn(sessionId, normalized);
    this._touchSession(sessionId);
    return normalized;
  }

  // Shared parse+normalize for _loadSession (caching) and peekSession
  // (cache-neutral). A missing file is a missing session; an EXISTING file
  // that cannot be read is quarantined and the session re-seeded, so
  // corruption no longer masquerades as absence (which silently dropped every
  // later mutation). The recovery stub is cached by its own upsert.
  _readSessionFromDisk(sessionId) {
    const store = this._sessionStores.get(sessionId) || new FileJsonStore(
      this._sessionFilePath(sessionId),
      {
        writeDebounceMs: this._writeDebounceMs,
        logger: this._logger,
      }
    );
    const readStatus = store.readWithStatus(null);
    if (readStatus.corrupted) {
      return this._quarantineAndRecoverCorruptSession(sessionId, readStatus);
    }
    const raw = readStatus.value;
    if (!raw) {
      return null;
    }
    if (readsNewerSchema(this, raw)) {
      // A newer app wrote this file; freeze and do not load future-schema data.
      enterNewerSchemaFreeze(this, raw.schema_version, this._sessionFilePath(sessionId));
      return null;
    }
    const sessionRecord =
      raw && typeof raw === 'object' && !Array.isArray(raw) && raw.session
        ? raw.session
        : raw;
    return this._normalizeSession(sessionId, sessionRecord);
  }

  _trackActiveTurn(sessionId, session) {
    const activeTurn =
      session && typeof session === 'object' && !Array.isArray(session)
        ? session.active_turn
        : null;
    this._scanActiveTurns.set(
      sessionId,
      activeTurn && typeof activeTurn === 'object' && !Array.isArray(activeTurn)
        ? activeTurn
        : null
    );
  }

  _seedActiveTurnScan() {
    if (this._activeTurnScanSeeded) {
      return;
    }
    this._activeTurnScanSeeded = true;
    for (const sessionId of this.getSessionIds()) {
      if (this._scanActiveTurns.has(sessionId)) {
        // Already tracked from an in-process write/load, which is at least as
        // fresh as disk (pending-write sessions never leave the cache).
        continue;
      }
      this._trackActiveTurn(sessionId, this.peekSession(sessionId));
    }
  }

  _quarantineAndRecoverCorruptSession(sessionId, readStatus) {
    const filePath = this._sessionFilePath(sessionId);
    const quarantineDir = path.join(this._rootDir, 'corrupt');
    const quarantinePath = path.join(
      quarantineDir,
      `${path.basename(filePath, '.json')}.${Date.now()}.json`
    );
    try {
      fs.mkdirSync(quarantineDir, { recursive: true });
      fs.renameSync(filePath, quarantinePath);
    } catch (error) {
      // The unreadable bytes could not be moved aside; leave the file where
      // it is (it may be hand-recoverable) and keep the missing-session
      // behavior for this read rather than risk overwriting evidence.
      logWriteFailed(
        this._logger,
        `${this._storeName}.session_file_quarantine_failed`,
        filePath,
        error
      );
      return null;
    }
    safeEmitLog(this._logger, 'ERROR', `${this._storeName}.session_file_quarantined`, {
      sessionId,
      filePath,
      quarantinePath,
      errorCode: readStatus.errorCode,
      errorMessage: readStatus.errorMessage,
    });
    // Re-seed a fresh, empty session from the index summary: title and
    // metadata survive, the messages are gone with the unreadable file, and
    // the session id stays functional — reads return an honest empty record
    // and later mutations persist again instead of bailing null forever.
    const summary = this._cachedIndex.sessions[sessionId];
    const stub = this._normalizeSession(sessionId, {
      ...(summary && typeof summary === 'object' ? summary : {}),
      id: sessionId,
      messages: [],
      turn_events: [],
      message_count: 0,
      message_seq_counter: 0,
      turn_event_seq_counter: 0,
      last_message_preview: '',
      active_turn: null,
    });
    this.upsertSession(sessionId, stub, { persist: true, alreadyNormalized: true });
    return this._loadedSessions.get(sessionId) || stub;
  }

  _getOrCreateSessionStore(sessionId) {
    let store = this._sessionStores.get(sessionId);
    if (!store) {
      store = new FileJsonStore(this._sessionFilePath(sessionId), {
        writeDebounceMs: this._writeDebounceMs,
        logger: this._logger,
      });
      this._sessionStores.set(sessionId, store);
    }
    return store;
  }

  _sessionFilePath(sessionId) {
    return path.join(this._rootDir, `${sanitizeSessionId(sessionId)}.json`);
  }

  _recoverSplitIndexFromSessionFiles(reason) {
    if (!fs.existsSync(this._rootDir)) {
      return false;
    }
    let entries;
    try {
      entries = fs.readdirSync(this._rootDir, { withFileTypes: true });
    } catch (error) {
      logWriteFailed(
        this._logger,
        `${this._storeName}.split_index_recovery_failed`,
        this._rootDir,
        error
      );
      return false;
    }
    const indexSessions = {};
    let recoveredCount = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === '_index.json' || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(this._rootDir, entry.name);
      const store = new FileJsonStore(filePath, {
        writeDebounceMs: this._writeDebounceMs,
        logger: this._logger,
      });
      const raw = store.read(null);
      if (readsNewerSchema(this, raw)) {
        // Future-schema file: freeze; the post-loop guard aborts the rebuild.
        enterNewerSchemaFreeze(this, raw.schema_version, filePath);
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
      if (!sessionId) {
        continue;
      }
      const normalized = this._normalizeSession(sessionId, sessionRecord);
      this._loadedSessions.set(sessionId, normalized);
      this._trackActiveTurn(sessionId, normalized);
      indexSessions[sessionId] = this._summarizeSession(normalized);
      recoveredCount += 1;
    }
    if (this._newerSchemaVersion > 0) {
      // A future-schema file froze the store; present nothing rather than
      // rebuild a current-schema index over newer data.
      freezeRecoveredIndex(this);
      return true;
    }
    if (!recoveredCount) {
      return false;
    }
    this._indexStore = new FileJsonStore(this._indexPath, {
      writeDebounceMs: this._writeDebounceMs,
      logger: this._logger,
    });
    this._cachedIndex = {
      schema_version: this._schemaVersion,
      sessions: indexSessions,
    };
    try {
      this._indexStore.writeImmediate(this._cachedIndex);
      this._indexDirty = false;
    } catch (error) {
      this._indexDirty = true;
      logWriteFailed(
        this._logger,
        `${this._storeName}.split_index_recovery_write_failed`,
        this._indexPath,
        error
      );
    }
    if (this._logger) {
      try {
        this._logger('WARN', `${this._storeName}.split_index_recovered`, {
          rootDir: this._rootDir,
          reason: String(reason || 'unknown'),
          sessionCount: recoveredCount,
        });
      } catch (_logError) {
        void _logError;
      }
    }
    return true;
  }

  _scheduleIndexWrite() {
    if (this._mode === 'monolithic_readonly' || !this._indexStore) {
      return;
    }
    if (this._pendingSplitMigration) {
      this._indexDirty = true;
      return;
    }
    try {
      this._indexStore.write(this._cachedIndex);
      this._indexDirty = false;
    } catch (error) {
      this._indexDirty = true;
      logWriteFailed(
        this._logger,
        `${this._storeName}.write_failed`,
        this._indexPath,
        error
      );
    }
  }

  _logNewerSchemaWriteBlocked() {
    logNewerSchemaDetected(
      this._logger,
      `${this._storeName}.newer_schema_write_blocked`,
      this._indexStore ? this._indexPath : this._legacyMonolithicPath,
      this._newerSchemaVersion,
      this._schemaVersion
    );
  }
}

module.exports = {
  SessionStorageBackend,
  deriveSessionsDirectory,
  sanitizeSessionId,
};
