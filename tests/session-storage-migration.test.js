'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SPLIT_MIGRATION_BATCH_SIZE,
  migrateFromMonolithic,
  queueSplitLayoutMigration,
  runSplitLayoutMigrationAsync,
} = require('../services/backend/session-storage-migration');
const {
  trackDirectory,
  cleanupTrackedResources,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// Build a hand-rolled `self` (the SessionStorageBackend instance shape) plus a
// log recorder. `_getOrCreateSessionStore` returns recording fake stores by
// default; individual tests override pieces as needed.
function makeMigrationSelf(rootDir, overrides = {}) {
  const logs = [];
  const touched = [];
  const sessionStores = new Map();
  const loadedSessions = new Map();
  const self = {
    _schemaVersion: 14,
    _legacyMaxSchemaVersion: 14,
    _storeName: 'store',
    _rootDir: path.join(rootDir, 'sessions'),
    _indexPath: path.join(rootDir, 'sessions', '_index.json'),
    _legacyMonolithicPath: path.join(rootDir, 'sessions.json'),
    _writeDebounceMs: 0,
    _mode: 'split',
    _sessionStores: sessionStores,
    _loadedSessions: loadedSessions,
    _scanActiveTurns: new Map(),
    _trackActiveTurn: (id, session) => {
      self._scanActiveTurns.set(id, session?.active_turn || null);
    },
    _logger: (lvl, ev, data) => logs.push([lvl, ev, data]),
    _initializeEmpty: () => {
      self._cachedIndex = { schema_version: self._schemaVersion, sessions: {} };
      self._initializeEmptyCalled = (self._initializeEmptyCalled || 0) + 1;
    },
    _migratePayload: (p) => p,
    _normalizeSession: (_id, s) => s,
    _summarizeSession: (s) => ({ id: s.id, title: s.title || null }),
    _touchSession: (id) => touched.push(id),
    _sessionFilePath: (id) => path.join(self._rootDir, `${id}.json`),
    _indexStore: {
      writeImmediate(value) {
        fs.mkdirSync(path.dirname(self._indexPath), { recursive: true });
        fs.writeFileSync(self._indexPath, JSON.stringify(value), 'utf8');
      },
    },
    _getOrCreateSessionStore: (id) => {
      if (sessionStores.has(id)) {
        return sessionStores.get(id);
      }
      const filePath = self._sessionFilePath(id);
      const store = {
        filePath,
        writeImmediateCalls: [],
        writeImmediate(value) {
          this.writeImmediateCalls.push(value);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
        },
        disposeCalls: 0,
        dispose() {
          this.disposeCalls += 1;
        },
      };
      sessionStores.set(id, store);
      return store;
    },
    ...overrides,
  };
  return { self, logs, touched, sessionStores, loadedSessions };
}

function findLog(logs, suffix) {
  return logs.find(([, ev]) => ev.endsWith(suffix));
}

// --- SPLIT_MIGRATION_BATCH_SIZE constant ---

test('SPLIT_MIGRATION_BATCH_SIZE equals 25', () => {
  assert.equal(SPLIT_MIGRATION_BATCH_SIZE, 25);
});

// --- queueSplitLayoutMigration ---

test('queueSplitLayoutMigration sets _cachedIndex and _pendingSplitMigration and logs', () => {
  const logs = [];
  const self = {
    _schemaVersion: 14,
    _storeName: 'store',
    _rootDir: '/r',
    _logger: (lvl, ev, data) => logs.push([lvl, ev, data]),
  };

  const indexRaw = { sessions: { a: { title: 'A' } } };
  queueSplitLayoutMigration(self, indexRaw, 9);

  // _cachedIndex uses current schema version and spreads the sessions
  assert.deepEqual(self._cachedIndex, {
    schema_version: 14,
    sessions: { a: { title: 'A' } },
  });

  // _pendingSplitMigration records what was observed
  assert.deepEqual(self._pendingSplitMigration, {
    indexRaw: { schema_version: 9, sessions: { a: { title: 'A' } } },
    observedVersion: 9,
  });

  // A log entry must have been emitted with the right event and data
  const entry = logs.find(([, ev]) => ev.endsWith('.split_schema_migration_queued'));
  assert.ok(entry, 'expected a split_schema_migration_queued log entry');
  const [, , data] = entry;
  assert.equal(data.observedVersion, 9);
  assert.equal(data.expectedVersion, 14);
  assert.equal(data.indexedSessionCount, 1);
});

test('queueSplitLayoutMigration: non-object sessions field produces empty sessions', () => {
  const logs = [];
  const self = {
    _schemaVersion: 14,
    _storeName: 'store',
    _rootDir: '/r',
    _logger: (lvl, ev, data) => logs.push([lvl, ev, data]),
  };

  // Pass an array as sessions — should be rejected and normalised to {}
  const indexRaw = { sessions: ['not', 'an', 'object'] };
  queueSplitLayoutMigration(self, indexRaw, 5);

  assert.deepEqual(self._cachedIndex.sessions, {});
  assert.deepEqual(self._pendingSplitMigration.indexRaw.sessions, {});

  // Log is still emitted, count should be 0
  const entry = logs.find(([, ev]) => ev.endsWith('.split_schema_migration_queued'));
  assert.ok(entry, 'expected log entry even with invalid sessions');
  assert.equal(entry[2].indexedSessionCount, 0);
});

test('queueSplitLayoutMigration: null indexRaw produces empty sessions', () => {
  const logs = [];
  const self = {
    _schemaVersion: 14,
    _storeName: 'store',
    _rootDir: '/r',
    _logger: (lvl, ev, data) => logs.push([lvl, ev, data]),
  };
  queueSplitLayoutMigration(self, null, 3);

  // _cachedIndex and _pendingSplitMigration must both be fully populated even
  // for a null indexRaw — not just _cachedIndex.sessions.
  assert.deepEqual(self._cachedIndex, { schema_version: 14, sessions: {} });
  assert.deepEqual(self._pendingSplitMigration, {
    indexRaw: { schema_version: 3, sessions: {} },
    observedVersion: 3,
  });

  // The queued log still fires, recording the observed version and a 0 count.
  const entry = logs.find(([, ev]) => ev.endsWith('.split_schema_migration_queued'));
  assert.ok(entry, 'expected a split_schema_migration_queued log entry for null indexRaw');
  assert.equal(entry[0], 'INFO');
  assert.equal(entry[2].observedVersion, 3);
  assert.equal(entry[2].expectedVersion, 14);
  assert.equal(entry[2].indexedSessionCount, 0);
});

// --- runSplitLayoutMigrationAsync: no-op when no pending migration ---

test('runSplitLayoutMigrationAsync resolves {ran:false,success:true,reason:"none"} when _pendingSplitMigration is null', async () => {
  const self = {
    _storeName: 'mystore',
    _pendingSplitMigration: null,
  };
  const result = await runSplitLayoutMigrationAsync(self);
  assert.equal(result.ran, false);
  assert.equal(result.success, true);
  assert.equal(result.storeName, 'mystore');
  assert.equal(result.reason, 'none');
});

test('runSplitLayoutMigrationAsync resolves {ran:false,success:true,reason:"none"} when _pendingSplitMigration is undefined', async () => {
  const self = {
    _storeName: 'anotherstore',
    // _pendingSplitMigration deliberately absent (undefined)
  };
  const result = await runSplitLayoutMigrationAsync(self);
  assert.equal(result.ran, false);
  assert.equal(result.success, true);
  assert.equal(result.storeName, 'anotherstore');
  assert.equal(result.reason, 'none');
});

// --- runSplitLayoutMigrationAsync: happy path with a real tmp directory ---

test('runSplitLayoutMigrationAsync happy path: migrates one session file and writes index', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-split-mig-test-'));
  try {
    const sessionId = 's1';
    const sessionFilePath = path.join(tmp, `${sessionId}.json`);
    const indexFilePath = path.join(tmp, '_index.json');

    // Write a pre-migration session file
    fs.writeFileSync(
      sessionFilePath,
      JSON.stringify({ schema_version: 9, session: { id: sessionId, title: 'Test session' } }),
      'utf8'
    );

    const touchedSessions = [];
    const loadedSessions = new Map();
    const logEntries = [];

    const self = {
      _schemaVersion: 14,
      _storeName: 'store',
      _rootDir: tmp,
      _indexPath: indexFilePath,
      _loadedSessions: loadedSessions,
      _scanActiveTurns: new Map(),
      _trackActiveTurn: (id, session) => {
        self._scanActiveTurns.set(id, session?.active_turn || null);
      },
      _touchSession: (id) => touchedSessions.push(id),
      _migratePayload: (p) => p,
      _normalizeSession: (_id, s) => s,
      _summarizeSession: (s) => ({ id: s.id }),
      _sessionFilePath: (id) => path.join(tmp, `${id}.json`),
      _indexStore: {
        writeImmediate(value) {
          fs.writeFileSync(indexFilePath, JSON.stringify(value), 'utf8');
        },
      },
      _getOrCreateSessionStore: () => ({
        writeImmediate(value) {
          fs.writeFileSync(sessionFilePath, JSON.stringify(value), 'utf8');
        },
      }),
      _cachedIndex: { schema_version: 14, sessions: { [sessionId]: { id: sessionId } } },
      _logger: (lvl, ev, data) => logEntries.push([lvl, ev, data]),
      _pendingSplitMigration: {
        indexRaw: {
          schema_version: 9,
          sessions: { [sessionId]: { id: sessionId } },
        },
        observedVersion: 9,
      },
    };

    const result = await runSplitLayoutMigrationAsync(self);

    // Should have run and succeeded
    assert.equal(result.ran, true);
    assert.equal(result.success, true);
    assert.equal(result.sessionCount, 1);

    // Pending migration should be cleared
    assert.equal(self._pendingSplitMigration, null);

    // _index.json must now exist on disk
    assert.ok(fs.existsSync(indexFilePath), '_index.json should be written to disk');

    // _touchSession must have been called for the migrated session
    assert.ok(touchedSessions.includes(sessionId), '_touchSession should have been called');

    // A completion log entry should have been emitted
    const completionEntry = logEntries.find(([, ev]) => ev.endsWith('.split_schema_migration_completed'));
    assert.ok(completionEntry, 'expected split_schema_migration_completed log entry');
    assert.equal(completionEntry[2].success, true);
    assert.equal(completionEntry[2].sessionCount, 1);
  } finally {
    // Clean up tmp directory
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_e) {
      void _e;
    }
  }
});

// --- migrateFromMonolithic: empty/missing monolithic file ---

test('migrateFromMonolithic: missing monolithic file calls _initializeEmpty and does not migrate', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mono-mig-'));
  trackDirectory(tmp);
  const { self, logs } = makeMigrationSelf(tmp);
  // No monolithic file on disk -> read returns null -> _initializeEmpty path.

  migrateFromMonolithic(self);

  assert.equal(self._initializeEmptyCalled, 1, '_initializeEmpty must be called exactly once');
  assert.deepEqual(self._cachedIndex, { schema_version: 14, sessions: {} });
  // No migration / completion logs should have fired.
  assert.equal(findLog(logs, '.split_migration_completed'), undefined);
  assert.equal(self._mode, 'split');
});

// --- migrateFromMonolithic: happy path migrates sessions + writes index + renames backup ---

test('migrateFromMonolithic happy path: writes per-session store, index, renames backup, logs completion', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mono-mig-'));
  trackDirectory(tmp);
  const { self, logs, touched, sessionStores } = makeMigrationSelf(tmp);

  fs.writeFileSync(
    self._legacyMonolithicPath,
    JSON.stringify({
      schema_version: 14,
      sessions: { s1: { id: 's1', title: 'One' }, s2: { id: 's2', title: 'Two' } },
    }),
    'utf8'
  );

  migrateFromMonolithic(self);

  // Per-session stores were created and written with the schema-versioned envelope.
  assert.equal(sessionStores.get('s1').writeImmediateCalls.length, 1);
  assert.deepEqual(sessionStores.get('s1').writeImmediateCalls[0], {
    schema_version: 14,
    session: { id: 's1', title: 'One' },
  });
  assert.equal(sessionStores.get('s2').writeImmediateCalls.length, 1);

  // Both sessions touched + loaded.
  assert.deepEqual(touched.sort(), ['s1', 's2']);
  assert.deepEqual(self._loadedSessions.get('s1'), { id: 's1', title: 'One' });

  // Index written to disk + cached.
  assert.ok(fs.existsSync(self._indexPath), '_index.json should exist on disk');
  assert.deepEqual(self._cachedIndex, {
    schema_version: 14,
    sessions: { s1: { id: 's1', title: 'One' }, s2: { id: 's2', title: 'Two' } },
  });
  const onDisk = JSON.parse(fs.readFileSync(self._indexPath, 'utf8'));
  assert.equal(onDisk.schema_version, 14);
  assert.equal(Object.keys(onDisk.sessions).length, 2);

  // Monolithic file renamed to a .migrated-* backup (original removed).
  assert.equal(fs.existsSync(self._legacyMonolithicPath), false);
  const backups = fs.readdirSync(tmp).filter((n) => n.startsWith('sessions.json.migrated-'));
  assert.equal(backups.length, 1, 'exactly one migrated backup should exist');

  // Completion log fired with the right session count + backup path.
  const completion = findLog(logs, '.split_migration_completed');
  assert.ok(completion, 'expected split_migration_completed log');
  assert.equal(completion[0], 'INFO');
  assert.equal(completion[2].sessionCount, 2);
  assert.equal(completion[2].rootDir, self._rootDir);
  assert.match(completion[2].backupPath, /sessions\.json\.migrated-\d+$/);
});

// --- migrateFromMonolithic: per-session writeImmediate throws -> abort + readonly cache (lines 58-79) ---

test('migrateFromMonolithic: per-session writeImmediate throws -> migration_write_failed, abort, readonly cache', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mono-mig-'));
  trackDirectory(tmp);
  const { self, logs, sessionStores } = makeMigrationSelf(tmp);

  // Override the store factory so the FIRST session's writeImmediate throws.
  // Capture the created store in a closure: cleanupAfterFailedMigration clears
  // self._sessionStores, so reading it back from the map afterward would be
  // undefined; we keep our own handle to assert dispose() ran.
  const thrown = new Error('disk full');
  thrown.code = 'ENOSPC';
  const createdStores = new Map();
  self._getOrCreateSessionStore = (id) => {
    if (sessionStores.has(id)) {
      return sessionStores.get(id);
    }
    const store = {
      filePath: self._sessionFilePath(id),
      writeImmediateCalls: [],
      writeImmediate(value) {
        this.writeImmediateCalls.push(value);
        throw thrown;
      },
      disposeCalls: 0,
      dispose() {
        this.disposeCalls += 1;
      },
    };
    sessionStores.set(id, store);
    createdStores.set(id, store);
    return store;
  };

  fs.writeFileSync(
    self._legacyMonolithicPath,
    JSON.stringify({ schema_version: 14, sessions: { s1: { id: 's1', title: 'One' } } }),
    'utf8'
  );

  migrateFromMonolithic(self);

  // writeImmediate was actually attempted for the failing session.
  assert.equal(createdStores.get('s1').writeImmediateCalls.length, 1);

  // The per-session write_failed event fired with the failing session path + error.
  const failed = findLog(logs, '.migration_write_failed');
  assert.ok(failed, 'expected migration_write_failed log');
  assert.equal(failed[0], 'WARN');
  assert.equal(failed[2].filePath, self._sessionFilePath('s1'));
  assert.equal(failed[2].errorCode, 'ENOSPC');
  assert.equal(failed[2].errorMessage, 'disk full');

  // Migration aborted: NO index written, monolithic file left in place for retry.
  assert.equal(fs.existsSync(self._indexPath), false, 'index must NOT be written on abort');
  assert.equal(fs.existsSync(self._legacyMonolithicPath), true, 'monolithic file kept for retry');
  assert.equal(findLog(logs, '.split_migration_completed'), undefined);

  // Fell back to read-only cache: monolithic_readonly mode + cache populated.
  assert.equal(self._mode, 'monolithic_readonly');
  assert.equal(self._loadedSessions.get('s1').id, 's1');
  assert.deepEqual(self._cachedIndex.sessions.s1, { id: 's1', title: 'One' });

  // Cleanup disposed the partially-created store and cleared the store map.
  assert.equal(createdStores.get('s1').disposeCalls, 1);
  assert.equal(sessionStores.size, 0, 'cleanup clears _sessionStores');
});

// --- migrateFromMonolithic: index writeImmediate throws -> cleanup + readonly (lines 92-101) ---

test('migrateFromMonolithic: index write throws -> migration_index_write_failed, cleanup, readonly cache', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mono-mig-'));
  trackDirectory(tmp);
  const { self, logs, sessionStores } = makeMigrationSelf(tmp);

  // Wrap the default factory so we keep a handle to the created store after
  // cleanupAfterFailedMigration clears self._sessionStores.
  const createdStores = new Map();
  const baseFactory = self._getOrCreateSessionStore;
  self._getOrCreateSessionStore = (id) => {
    const store = baseFactory(id);
    createdStores.set(id, store);
    return store;
  };

  // Make the index path unwritable by placing a regular FILE where its parent
  // directory needs to be: rootDir/_index.json -> point _indexPath one level
  // deeper through a file so FileJsonStore._writeNow's mkdirSync throws.
  const blockerFile = path.join(self._rootDir, 'blocker');
  self._indexPath = path.join(blockerFile, '_index.json');

  fs.writeFileSync(
    self._legacyMonolithicPath,
    JSON.stringify({ schema_version: 14, sessions: { s1: { id: 's1', title: 'One' } } }),
    'utf8'
  );

  // Pre-create the session dir + the blocker FILE so the per-session write
  // succeeds but the index dir creation fails (parent path is a file).
  fs.mkdirSync(self._rootDir, { recursive: true });
  fs.writeFileSync(blockerFile, 'i am a file, not a dir', 'utf8');

  migrateFromMonolithic(self);

  // Per-session write happened first and succeeded.
  assert.equal(createdStores.get('s1').writeImmediateCalls.length, 1);

  // Index write failure logged with the index path.
  const failed = findLog(logs, '.migration_index_write_failed');
  assert.ok(failed, 'expected migration_index_write_failed log');
  assert.equal(failed[0], 'WARN');
  assert.equal(failed[2].filePath, self._indexPath);

  // Cleanup ran: session store disposed + its file unlinked; mode is readonly.
  assert.equal(createdStores.get('s1').disposeCalls, 1);
  assert.equal(sessionStores.size, 0, 'cleanup clears _sessionStores');
  assert.equal(fs.existsSync(self._sessionFilePath('s1')), false, 'partial session file removed');
  assert.equal(self._mode, 'monolithic_readonly');
  assert.deepEqual(self._cachedIndex.sessions.s1, { id: 's1', title: 'One' });
  assert.equal(self._loadedSessions.get('s1').id, 's1');

  // Monolithic file left in place; no completion log.
  assert.equal(fs.existsSync(self._legacyMonolithicPath), true);
  assert.equal(findLog(logs, '.split_migration_completed'), undefined);
});

// --- migrateFromMonolithic: backup rename fails -> WARN but still completes (lines 113-138) ---

test('migrateFromMonolithic: backup rename failure logs migration_backup_failed but migration still completes', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mono-mig-'));
  trackDirectory(tmp);
  const { self, logs } = makeMigrationSelf(tmp);

  // Point the legacy monolithic path at a DIRECTORY for the read+rename, but we
  // need read(null) to return a payload first. Instead: stub _migratePayload to
  // succeed, keep a real monolithic file, then sabotage fs.renameSync by making
  // the target collide. Simplest deterministic approach: monkeypatch the source
  // monolithic file to be deleted just before rename via a getter is hard, so
  // instead make the rename fail by pointing _legacyMonolithicPath at a path
  // that exists for read but whose rename will hit EPERM: use a directory.
  //
  // Cleanest portable trick: write the monolithic file, then replace it with a
  // *directory* of the same name is impossible while it has content. Instead we
  // wrap renameSync. We monkeypatch fs.renameSync for the duration of this test.
  fs.writeFileSync(
    self._legacyMonolithicPath,
    JSON.stringify({ schema_version: 14, sessions: { s1: { id: 's1', title: 'One' } } }),
    'utf8'
  );

  const realRename = fs.renameSync;
  const renameCalls = [];
  fs.renameSync = (from, to) => {
    // Only sabotage the monolithic backup rename; let atomic temp renames pass.
    if (from === self._legacyMonolithicPath) {
      renameCalls.push([from, to]);
      const err = new Error('rename blocked');
      err.code = 'EPERM';
      throw err;
    }
    return realRename(from, to);
  };

  try {
    migrateFromMonolithic(self);
  } finally {
    fs.renameSync = realRename;
  }

  // The backup rename was attempted against the monolithic path.
  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0][0], self._legacyMonolithicPath);
  assert.match(renameCalls[0][1], /sessions\.json\.migrated-\d+$/);

  // Best-effort backup failure logged at WARN with both paths.
  const backupFailed = findLog(logs, '.migration_backup_failed');
  assert.ok(backupFailed, 'expected migration_backup_failed log');
  assert.equal(backupFailed[0], 'WARN');
  assert.equal(backupFailed[2].monolithicPath, self._legacyMonolithicPath);
  assert.match(backupFailed[2].backupPath, /sessions\.json\.migrated-\d+$/);
  assert.equal(backupFailed[2].errorMessage, 'rename blocked');

  // Migration still completes: index on disk + completion log fired.
  assert.ok(fs.existsSync(self._indexPath), 'index written despite backup failure');
  const completion = findLog(logs, '.split_migration_completed');
  assert.ok(completion, 'expected split_migration_completed log despite backup failure');
  assert.equal(completion[0], 'INFO');
  assert.equal(completion[2].sessionCount, 1);
});

// --- migrateFromMonolithic: newer-than-legacyMax schema -> enterMonolithicReadonlyMode (lines 183-194/199-210 caller) ---

test('migrateFromMonolithic: observed schema newer than legacyMax enters monolithic_readonly mode and logs newer_schema_detected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mono-mig-'));
  trackDirectory(tmp);
  const { self, logs, touched, sessionStores } = makeMigrationSelf(tmp);
  self._legacyMaxSchemaVersion = 14;

  fs.writeFileSync(
    self._legacyMonolithicPath,
    JSON.stringify({
      schema_version: 99, // newer than legacyMax 14
      sessions: { s1: { id: 's1', title: 'Future' } },
    }),
    'utf8'
  );

  migrateFromMonolithic(self);

  // Entered read-only mode, recorded the newer version.
  assert.equal(self._mode, 'monolithic_readonly');
  assert.equal(self._newerSchemaVersion, 99);

  // newer_schema_detected warning fired with observed/expected versions.
  const newer = findLog(logs, '.newer_schema_detected');
  assert.ok(newer, 'expected newer_schema_detected log');
  assert.equal(newer[0], 'WARN');
  assert.equal(newer[2].observedVersion, 99);
  assert.equal(newer[2].expectedVersion, 14);
  assert.equal(newer[2].filePath, self._legacyMonolithicPath);

  // Read-only cache populated WITHOUT writing per-session stores or an index.
  assert.equal(sessionStores.size, 0, 'no per-session stores created in readonly mode');
  assert.equal(fs.existsSync(self._indexPath), false, 'no index written in readonly mode');
  assert.equal(fs.existsSync(self._legacyMonolithicPath), true, 'monolithic file kept');
  assert.deepEqual(self._cachedIndex.sessions.s1, { id: 's1', title: 'Future' });
  assert.deepEqual(touched, ['s1']);
});

// --- runSplitLayoutMigrationAsync: readdir rejects -> split_schema_migration_failed, success:false (lines 266-281) ---

test('runSplitLayoutMigrationAsync: readdir failure logs split_schema_migration_failed and returns success:false', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-split-mig-'));
  trackDirectory(tmp);
  const { self, logs } = makeMigrationSelf(tmp);
  // Point _rootDir at a path that does NOT exist so readdir rejects ENOENT.
  self._rootDir = path.join(tmp, 'does-not-exist');
  self._indexPath = path.join(self._rootDir, '_index.json');
  self._cachedIndex = { schema_version: 14, sessions: { s1: { id: 's1' } } };
  self._pendingSplitMigration = {
    indexRaw: { schema_version: 9, sessions: { s1: { id: 's1' } } },
    observedVersion: 9,
  };

  const result = await runSplitLayoutMigrationAsync(self);

  assert.deepEqual(result, {
    ran: true,
    success: false,
    storeName: 'store',
    observedVersion: 9,
    expectedVersion: 14,
    sessionCount: 0,
  });

  // The readdir failure logged with the root dir as the failing path.
  const failed = findLog(logs, '.split_schema_migration_failed');
  assert.ok(failed, 'expected split_schema_migration_failed log');
  assert.equal(failed[0], 'WARN');
  assert.equal(failed[2].filePath, self._rootDir);

  // Completion log fired at WARN with success:false.
  const completion = findLog(logs, '.split_schema_migration_completed');
  assert.ok(completion, 'expected completion log');
  assert.equal(completion[0], 'WARN');
  assert.equal(completion[2].success, false);
  assert.equal(completion[2].sessionCount, 0);

  // Pending migration NOT cleared on failure.
  assert.deepEqual(self._pendingSplitMigration.observedVersion, 9);
});

// --- runSplitLayoutMigrationAsync: per-file read throws -> logged + skipped (lines 297-312) ---

test('runSplitLayoutMigrationAsync: unreadable/corrupt session file is logged and skipped, others migrate', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-split-mig-'));
  trackDirectory(tmp);
  const { self, logs, touched } = makeMigrationSelf(tmp);
  self._rootDir = tmp;
  self._indexPath = path.join(tmp, '_index.json');

  // One valid file, one corrupt (invalid JSON -> readJsonFileAsync throws).
  fs.writeFileSync(
    path.join(tmp, 'good.json'),
    JSON.stringify({ schema_version: 9, session: { id: 'good', title: 'Good' } }),
    'utf8'
  );
  fs.writeFileSync(path.join(tmp, 'bad.json'), '{ this is not valid json', 'utf8');

  self._cachedIndex = {
    schema_version: 14,
    sessions: { good: { id: 'good', title: 'Good' }, bad: { id: 'bad', title: 'Bad' } },
  };
  self._pendingSplitMigration = {
    indexRaw: {
      schema_version: 9,
      sessions: { good: { id: 'good', title: 'Good' }, bad: { id: 'bad', title: 'Bad' } },
    },
    observedVersion: 9,
  };

  const result = await runSplitLayoutMigrationAsync(self);

  // Migration succeeds. The corrupt 'bad' file is skipped from the read loop,
  // so it is NEVER re-migrated (not loaded, not touched, no fresh file write);
  // only its pre-existing live-index summary survives the merge.
  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  assert.deepEqual(touched, ['good'], 'only the readable session is migrated/touched');
  assert.equal(self._loadedSessions.get('good').id, 'good');
  assert.equal(self._loadedSessions.has('bad'), false, 'corrupt session not loaded');

  // The corrupt file read failure was logged against bad.json.
  const failed = logs.find(
    ([, ev, data]) => ev.endsWith('.split_schema_migration_failed')
      && data.filePath === path.join(tmp, 'bad.json')
  );
  assert.ok(failed, 'expected a read-failure log for bad.json');
  assert.equal(failed[0], 'WARN');
  // The read-failure log must carry the actual JSON parse error string, not just
  // any truthy value: corrupt JSON yields a deterministic "...JSON..." message.
  assert.equal(typeof failed[2].errorMessage, 'string');
  assert.match(failed[2].errorMessage, /JSON/);

  // The good session got a freshly-written per-session file in current schema.
  const goodOnDisk = JSON.parse(fs.readFileSync(self._sessionFilePath('good'), 'utf8'));
  assert.equal(goodOnDisk.schema_version, 14);
  assert.deepEqual(goodOnDisk.session, { id: 'good', title: 'Good' });

  // bad.json is left untouched as the original corrupt bytes (never rewritten).
  assert.equal(fs.readFileSync(path.join(tmp, 'bad.json'), 'utf8'), '{ this is not valid json');

  // Merged index keeps both summaries: good (migrated) + bad (live-index only).
  const onDisk = JSON.parse(fs.readFileSync(self._indexPath, 'utf8'));
  assert.deepEqual(onDisk.sessions.good, { id: 'good', title: 'Good' });
  assert.deepEqual(onDisk.sessions.bad, { id: 'bad', title: 'Bad' });
  assert.equal(result.sessionCount, 2);
});

// --- runSplitLayoutMigrationAsync: session removed from live index since queued -> skipped (lines 335-336) ---

test('runSplitLayoutMigrationAsync: session deleted from live index after queue is skipped (not re-migrated)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-split-mig-'));
  trackDirectory(tmp);
  const { self, touched } = makeMigrationSelf(tmp);
  self._rootDir = tmp;
  self._indexPath = path.join(tmp, '_index.json');

  fs.writeFileSync(
    path.join(tmp, 'keep.json'),
    JSON.stringify({ schema_version: 9, session: { id: 'keep', title: 'Keep' } }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmp, 'gone.json'),
    JSON.stringify({ schema_version: 9, session: { id: 'gone', title: 'Gone' } }),
    'utf8'
  );

  // Queue saw BOTH sessions...
  self._pendingSplitMigration = {
    indexRaw: {
      schema_version: 9,
      sessions: { keep: { id: 'keep', title: 'Keep' }, gone: { id: 'gone', title: 'Gone' } },
    },
    observedVersion: 9,
  };
  // ...but 'gone' was deleted from the live index before the async run.
  self._cachedIndex = {
    schema_version: 14,
    sessions: { keep: { id: 'keep', title: 'Keep' } },
  };

  const result = await runSplitLayoutMigrationAsync(self);

  assert.equal(result.ran, true);
  assert.equal(result.success, true);
  // Only 'keep' migrated; 'gone' skipped (line 335-336 continue).
  assert.equal(result.sessionCount, 1);
  assert.deepEqual(touched, ['keep']);
  assert.equal(self._loadedSessions.has('gone'), false);

  const onDisk = JSON.parse(fs.readFileSync(self._indexPath, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.sessions), ['keep']);

  // 'keep' was rewritten in the current schema by the migration...
  const keepOnDisk = JSON.parse(fs.readFileSync(self._sessionFilePath('keep'), 'utf8'));
  assert.equal(keepOnDisk.schema_version, 14);
  assert.deepEqual(keepOnDisk.session, { id: 'keep', title: 'Keep' });
  // ...but the deleted 'gone' file was left as its ORIGINAL v9 bytes (the
  // migration's continue at lines 335-336 means it never re-wrote that file).
  const goneOnDisk = JSON.parse(fs.readFileSync(self._sessionFilePath('gone'), 'utf8'));
  assert.equal(goneOnDisk.schema_version, 9, 'gone.json not rewritten by migration');
  assert.deepEqual(goneOnDisk.session, { id: 'gone', title: 'Gone' });
});

// --- runSplitLayoutMigrationAsync: final index write throws -> indexDirty + success:false (lines 393-405) ---

test('runSplitLayoutMigrationAsync: final index write failure sets _indexDirty and returns success:false', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-split-mig-'));
  trackDirectory(tmp);
  const { self, logs, touched } = makeMigrationSelf(tmp);
  self._rootDir = tmp;
  // Make the FINAL index write fail: place a FILE where _indexPath's parent dir
  // must be created. writeJsonAtomicAsync mkdir(dirname) will reject.
  const blockerFile = path.join(tmp, 'idxblock');
  fs.writeFileSync(blockerFile, 'not a dir', 'utf8');
  self._indexPath = path.join(blockerFile, '_index.json');

  fs.writeFileSync(
    path.join(tmp, 's1.json'),
    JSON.stringify({ schema_version: 9, session: { id: 's1', title: 'One' } }),
    'utf8'
  );

  self._cachedIndex = { schema_version: 14, sessions: { s1: { id: 's1', title: 'One' } } };
  self._pendingSplitMigration = {
    indexRaw: { schema_version: 9, sessions: { s1: { id: 's1', title: 'One' } } },
    observedVersion: 9,
  };

  const result = await runSplitLayoutMigrationAsync(self);

  // Per-session write succeeded (1 session), but the index write blew up.
  assert.equal(result.ran, true);
  assert.equal(result.success, false);
  assert.equal(result.sessionCount, 1);
  assert.deepEqual(touched, ['s1']);

  // _indexDirty flag set; pending migration NOT cleared.
  assert.equal(self._indexDirty, true);
  assert.notEqual(self._pendingSplitMigration, null);

  // The index-write failure logged against the index path.
  const failed = logs.find(
    ([, ev, data]) => ev.endsWith('.split_schema_migration_failed')
      && data.filePath === self._indexPath
  );
  assert.ok(failed, 'expected split_schema_migration_failed log for index path');
  assert.equal(failed[0], 'WARN');

  // Completion log at WARN, success false.
  const completion = findLog(logs, '.split_schema_migration_completed');
  assert.ok(completion);
  assert.equal(completion[0], 'WARN');
  assert.equal(completion[2].success, false);
});

// --- mergeLiveSplitMigrationIndex via runSplitLayoutMigrationAsync: live-changed-since-queued WARN completion (lines 423-453) ---

test('runSplitLayoutMigrationAsync: session changed in live index since queue is overwritten with live summary on success', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-split-mig-'));
  trackDirectory(tmp);
  const { self, logs } = makeMigrationSelf(tmp);
  self._rootDir = tmp;
  self._indexPath = path.join(tmp, '_index.json');

  fs.writeFileSync(
    path.join(tmp, 's1.json'),
    JSON.stringify({ schema_version: 9, session: { id: 's1', title: 'OldTitle' } }),
    'utf8'
  );

  // Queue captured the original summary...
  self._pendingSplitMigration = {
    indexRaw: { schema_version: 9, sessions: { s1: { id: 's1', title: 'OldTitle' } } },
    observedVersion: 9,
  };
  // ...but a live edit changed s1's summary AND added a brand-new s2 that was
  // never on disk (exercises both branches of mergeLiveSplitMigrationIndex).
  self._cachedIndex = {
    schema_version: 14,
    sessions: {
      s1: { id: 's1', title: 'LiveEditedTitle' },
      s2: { id: 's2', title: 'LiveOnly' },
    },
  };

  const result = await runSplitLayoutMigrationAsync(self);

  assert.equal(result.ran, true);
  assert.equal(result.success, true);

  // Merged index keeps the LIVE summary for the changed s1 (not the migrated
  // OldTitle) and includes the live-only s2.
  const merged = self._cachedIndex.sessions;
  assert.deepEqual(merged.s1, { id: 's1', title: 'LiveEditedTitle' });
  assert.deepEqual(merged.s2, { id: 's2', title: 'LiveOnly' });

  // On-disk index reflects the merged result.
  const onDisk = JSON.parse(fs.readFileSync(self._indexPath, 'utf8'));
  assert.deepEqual(onDisk.sessions.s1, { id: 's1', title: 'LiveEditedTitle' });
  assert.deepEqual(onDisk.sessions.s2, { id: 's2', title: 'LiveOnly' });
  assert.equal(result.sessionCount, 2);

  // Successful completion log.
  const completion = findLog(logs, '.split_schema_migration_completed');
  assert.ok(completion);
  assert.equal(completion[0], 'INFO');
  assert.equal(completion[2].success, true);
  assert.equal(completion[2].sessionCount, 2);

  // Pending migration cleared on success.
  assert.equal(self._pendingSplitMigration, null);
  assert.equal(self._indexDirty, false);
});
