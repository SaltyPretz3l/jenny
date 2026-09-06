const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionStorageBackend } = require('../services/backend/session-storage-backend');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// ---- Shared hand-built injectors (mirror the LRU sibling test) ----------

function normalizeSession(id, record) {
  const source = record && typeof record === 'object' ? record : {};
  return {
    id,
    title: source.title || 'Untitled',
    messages: Array.isArray(source.messages) ? source.messages : [],
  };
}

function summarizeSession(record) {
  return { id: record.id, title: record.title };
}

const migratePayload = (payload) => payload;

function makeTempRoot(label) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-ssb-${label}-`));
  trackDirectory(rootDir);
  return rootDir;
}

// A logger() that records every (level, event, data) triple so oracles can
// assert the exact event names the backend emitted on each dark branch.
function makeRecordingLogger() {
  const events = [];
  const logger = (level, event, data) => {
    events.push({ level, event, data });
  };
  logger.events = events;
  logger.names = () => events.map((entry) => entry.event);
  logger.find = (name) => events.filter((entry) => entry.event === name);
  return logger;
}

function makeBackend(rootDir, overrides = {}) {
  return new SessionStorageBackend(rootDir, {
    schemaVersion: 2,
    normalizeSession,
    summarizeSession,
    migratePayload,
    writeDebounceMs: 0,
    ...overrides,
  });
}

// ---- NEWER SCHEMA: write blocked, detection + block events fired ---------

test('newer on-disk schema flips read-only mode and blocks upsert/delete writes', () => {
  const rootDir = makeTempRoot('newer-schema');
  // Pre-seed an index that claims a schema_version GREATER than configured (2).
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 9,
      sessions: { sess_keep: { id: 'sess_keep', title: 'Persisted' } },
    }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'canonical_store' });

  assert.equal(backend.hasNewerSchema(), true, 'newer schema must be detected');
  assert.deepEqual(
    logger.find('canonical_store.newer_schema_detected').map((e) => e.data.observedVersion),
    [9],
    'a single newer_schema_detected event with observedVersion 9 must fire'
  );

  // Write attempts are blocked and emit newer_schema_write_blocked.
  const upsertResult = backend.upsertSession('sess_new', { title: 'Blocked' });
  assert.equal(upsertResult, false, 'upsert under newer schema must return false');

  const deleteResult = backend.deleteSession('sess_keep');
  assert.equal(deleteResult, false, 'delete under newer schema must return false');

  // The blocked entry stays in the index (delete was refused, not applied).
  assert.equal(
    backend.hasSession('sess_keep'),
    true,
    'a blocked delete must not remove the session from the index'
  );

  const blockedEvents = logger.find('canonical_store.newer_schema_write_blocked');
  assert.equal(
    blockedEvents.length,
    2,
    'both the blocked upsert and blocked delete must emit newer_schema_write_blocked'
  );
  assert.equal(
    blockedEvents[0].data.observedVersion,
    9,
    'the block event must carry the observed newer version'
  );
});

// ---- SPLIT-INDEX RECOVERY: rebuild the index from orphan session files ----

test('missing index is rebuilt from orphan session files with a recovery warning', () => {
  const rootDir = makeTempRoot('split-recover');
  // Two real session files, no _index.json, no monolithic.
  fs.writeFileSync(
    path.join(rootDir, 'alpha.json'),
    JSON.stringify({ schema_version: 2, session: { id: 'alpha', title: 'Alpha' } }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, 'beta.json'),
    JSON.stringify({ schema_version: 2, session: { id: 'beta', title: 'Beta' } }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'shadow_store' });

  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.sessions).sort(),
    ['alpha', 'beta'],
    'recovery must rebuild the index from both orphan session files'
  );
  assert.deepEqual(
    snapshot.sessions.alpha,
    { id: 'alpha', title: 'Alpha' },
    'recovered summary must come from summarizeSession over the file record'
  );

  // The index file now exists on disk.
  assert.equal(
    fs.existsSync(path.join(rootDir, '_index.json')),
    true,
    'recovery must persist a fresh _index.json to disk'
  );
  const onDiskIndex = JSON.parse(fs.readFileSync(path.join(rootDir, '_index.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(onDiskIndex.sessions).sort(),
    ['alpha', 'beta'],
    'the persisted index must contain both recovered ids'
  );

  const recoveredLogs = logger.find('shadow_store.split_index_recovered');
  assert.equal(recoveredLogs.length, 1, 'exactly one split_index_recovered event must fire');
  assert.equal(recoveredLogs[0].level, 'WARN', 'recovery is logged at WARN level');
  assert.equal(
    recoveredLogs[0].data.sessionCount,
    2,
    'the recovery event must report sessionCount 2'
  );
});

// ---- CORRUPT QUARANTINE: move bad bytes aside, re-seed an empty stub ------

test('unreadable session file is quarantined and re-seeded as an empty stub', () => {
  const rootDir = makeTempRoot('corrupt');

  // First pass: a real backend persists one session + index normally.
  const seedLogger = makeRecordingLogger();
  const seedBackend = makeBackend(rootDir, { logger: seedLogger });
  seedBackend.upsertSession('sess_corrupt', { title: 'Original Title' });
  seedBackend.flush();
  seedBackend.dispose();

  const sessionFile = path.join(rootDir, 'sess_corrupt.json');
  assert.equal(fs.existsSync(sessionFile), true, 'precondition: the session file was written');

  // Corrupt the bytes so readWithStatus reports corrupted (existing, unparsable).
  fs.writeFileSync(sessionFile, '{ this is not <<< valid json', 'utf8');

  // Second pass: fresh backend reads index (which still lists sess_corrupt).
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger });
  assert.equal(backend.hasSession('sess_corrupt'), true, 'index still lists the corrupt session');

  const recovered = backend.getSession('sess_corrupt');
  assert.ok(recovered, 'getSession must return a re-seeded stub, not null');
  assert.deepEqual(recovered.messages, [], 'the re-seeded stub must have an empty messages array');
  assert.equal(recovered.id, 'sess_corrupt', 'the stub keeps the session id');
  // The stub is re-seeded from the surviving index summary, so the title that
  // was persisted before corruption (NOT the normalize fallback 'Untitled')
  // must carry through. This pins the summary-merge in
  // _quarantineAndRecoverCorruptSession; dropping the spread would regress to
  // 'Untitled' and silently lose the session's metadata.
  assert.equal(
    recovered.title,
    'Original Title',
    'the re-seeded stub keeps the title from the surviving index summary'
  );

  // The corrupt directory now exists and holds the moved-aside bytes.
  const corruptDir = path.join(rootDir, 'corrupt');
  assert.equal(fs.existsSync(corruptDir), true, 'a corrupt/ quarantine dir must be created');
  const quarantined = fs.readdirSync(corruptDir);
  assert.equal(quarantined.length, 1, 'exactly one file must be moved into corrupt/');
  assert.match(
    quarantined[0],
    /^sess_corrupt\./,
    'the quarantined file keeps the original session basename'
  );

  const quarantineLogs = logger.find('session_store.session_file_quarantined');
  assert.equal(quarantineLogs.length, 1, 'exactly one session_file_quarantined event must fire');
  assert.equal(quarantineLogs[0].level, 'ERROR', 'quarantine is logged at ERROR level');
  assert.equal(
    quarantineLogs[0].data.sessionId,
    'sess_corrupt',
    'the quarantine event must name the affected session'
  );

  // A subsequent read returns the cached stub (no second quarantine).
  const again = backend.getSession('sess_corrupt');
  assert.deepEqual(again.messages, [], 'subsequent read returns the cached empty stub');
  assert.equal(
    logger.find('session_store.session_file_quarantined').length,
    1,
    'a second read must NOT re-quarantine an already-recovered session'
  );
});

// ---- MONOLITHIC MIGRATION: split the legacy single-file payload -----------

test('legacy monolithic payload is migrated to a split layout and renamed aside', () => {
  const rootDir = makeTempRoot('monolithic-root');
  const monolithicDir = makeTempRoot('monolithic-src');
  const monolithicPath = path.join(monolithicDir, 'sessions.json');
  fs.writeFileSync(
    monolithicPath,
    JSON.stringify({
      schema_version: 2,
      sessions: {
        m_one: { id: 'm_one', title: 'Mono One' },
        m_two: { id: 'm_two', title: 'Mono Two' },
      },
    }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, legacyMonolithicPath: monolithicPath });

  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.sessions).sort(),
    ['m_one', 'm_two'],
    'both monolithic sessions must appear in the rebuilt split index'
  );

  // Per-session files were written to the split root.
  assert.equal(
    fs.existsSync(path.join(rootDir, 'm_one.json')),
    true,
    'a per-session file must exist for m_one after migration'
  );
  assert.equal(
    fs.existsSync(path.join(rootDir, 'm_two.json')),
    true,
    'a per-session file must exist for m_two after migration'
  );
  assert.equal(
    fs.existsSync(path.join(rootDir, '_index.json')),
    true,
    'the split index must exist after migration'
  );

  // The original monolithic file was renamed aside (not left in place).
  assert.equal(
    fs.existsSync(monolithicPath),
    false,
    'the monolithic file must be renamed aside after a successful migration'
  );
  const backups = fs
    .readdirSync(monolithicDir)
    .filter((name) => name.startsWith('sessions.json.migrated-'));
  assert.equal(backups.length, 1, 'exactly one migrated-<ts> backup must remain');

  // The migrated session content is readable through the public API.
  const one = backend.getSession('m_one');
  assert.equal(one.title, 'Mono One', 'migrated session content survives the split');
});

// ---- FLUSH: persist:false dirties the cache; flush() lands the file -------

test('persist:false caches without writing index; flush lands the file', () => {
  const rootDir = makeTempRoot('flush');
  const backend = makeBackend(rootDir);

  // Cache-only update: dirties the session, leaves the on-disk index untouched.
  const ok = backend.upsertSession('sess_dirty', { title: 'Pending' }, { persist: false });
  assert.equal(ok, true, 'persist:false upsert returns true');
  assert.equal(
    backend.hasPendingWriteForSession('sess_dirty'),
    true,
    'a cache-only dirty session reports a pending write'
  );

  // The index summary on disk must NOT yet mention the dirty session.
  const indexPath = path.join(rootDir, '_index.json');
  if (fs.existsSync(indexPath)) {
    const before = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.equal(
      Object.prototype.hasOwnProperty.call(before.sessions || {}, 'sess_dirty'),
      false,
      'persist:false must not write the session into the on-disk index'
    );
  }
  // The per-session file does not exist before flush.
  assert.equal(
    fs.existsSync(path.join(rootDir, 'sess_dirty.json')),
    false,
    'persist:false must not write the per-session file before flush'
  );

  // flush() drains the dirty session to disk and reports it wrote.
  const wrote = backend.flush();
  assert.equal(wrote, true, 'flush must report it wrote at least one file');
  assert.equal(backend.hasPendingWriteForSession('sess_dirty'), false, 'flush clears the pending write');
  assert.equal(
    fs.existsSync(path.join(rootDir, 'sess_dirty.json')),
    true,
    'flush writes the per-session file to disk'
  );
  const onDisk = JSON.parse(fs.readFileSync(path.join(rootDir, 'sess_dirty.json'), 'utf8'));
  assert.equal(onDisk.session.title, 'Pending', 'the flushed file carries the cached record');
  const flushedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(flushedIndex.sessions.sess_dirty.title, 'Pending', 'flush also durably indexes the session');

  // A no-op flush (nothing dirty) reports false.
  assert.equal(backend.flush(), false, 'a flush with no dirty state reports false');
});

// ---- flushAsync: async drain of a dirty cache writes the file ------------

test('flushAsync drains a persist:false dirty session to disk', async () => {
  const rootDir = makeTempRoot('flush-async');
  const backend = makeBackend(rootDir);

  backend.upsertSession('sess_async', { title: 'AsyncPending' }, { persist: false });
  assert.equal(backend.hasPendingWriteForSession('sess_async'), true, 'precondition: pending before flushAsync');

  const wrote = await backend.flushAsync();
  assert.equal(wrote, true, 'flushAsync reports it wrote');
  assert.equal(backend.hasPendingWriteForSession('sess_async'), false, 'flushAsync clears the pending write');
  assert.equal(
    fs.existsSync(path.join(rootDir, 'sess_async.json')),
    true,
    'flushAsync writes the per-session file'
  );
  const onDisk = JSON.parse(fs.readFileSync(path.join(rootDir, 'sess_async.json'), 'utf8'));
  assert.equal(onDisk.session.title, 'AsyncPending', 'the async-flushed file carries the record');
});

// ---- runPendingMigrations: no-op when nothing queued ---------------------

test('runPendingMigrations is a no-op when no migration is queued', async () => {
  const rootDir = makeTempRoot('no-migration');
  const backend = makeBackend(rootDir, { storeName: 'idle_store' });

  assert.equal(backend.hasPendingMigrations(), false, 'a fresh backend has no pending migration');
  const result = await backend.runPendingMigrations();
  assert.deepEqual(
    result,
    { ran: false, success: true, storeName: 'idle_store', reason: 'none' },
    'runPendingMigrations returns the canonical no-op result'
  );
});

// ---- CONSTRUCTOR ARG VALIDATION: each required dependency throws ----------

test('constructor throws when rootDir is missing', () => {
  assert.throws(
    () =>
      new SessionStorageBackend(undefined, {
        schemaVersion: 2,
        migratePayload,
        normalizeSession,
        summarizeSession,
      }),
    /SessionStorageBackend requires a rootDir\./,
    'a falsy rootDir must throw the rootDir message'
  );
});

test('constructor throws when migratePayload is not a function', () => {
  const rootDir = makeTempRoot('ctor-migrate');
  assert.throws(
    () =>
      new SessionStorageBackend(rootDir, {
        schemaVersion: 2,
        migratePayload: null,
        normalizeSession,
        summarizeSession,
      }),
    /SessionStorageBackend requires a migratePayload function\./,
    'a non-function migratePayload must throw the migratePayload message'
  );
});

test('constructor throws when normalizeSession is not a function', () => {
  const rootDir = makeTempRoot('ctor-normalize');
  assert.throws(
    () =>
      new SessionStorageBackend(rootDir, {
        schemaVersion: 2,
        migratePayload,
        normalizeSession: 'nope',
        summarizeSession,
      }),
    /SessionStorageBackend requires a normalizeSession function\./,
    'a non-function normalizeSession must throw the normalizeSession message'
  );
});

test('constructor throws when summarizeSession is not a function', () => {
  const rootDir = makeTempRoot('ctor-summarize');
  assert.throws(
    () =>
      new SessionStorageBackend(rootDir, {
        schemaVersion: 2,
        migratePayload,
        normalizeSession,
        summarizeSession: 42,
      }),
    /SessionStorageBackend requires a summarizeSession function\./,
    'a non-function summarizeSession must throw the summarizeSession message'
  );
});

// ---- UNREADABLE / MALFORMED _index.json -> recovery fallback --------------

test('unreadable _index.json (array root) recovers the index from session files', () => {
  const rootDir = makeTempRoot('unreadable-index');
  // An existing _index.json whose root is an ARRAY (not an object) is treated
  // as unreadable -> recovery from orphan session files.
  fs.writeFileSync(path.join(rootDir, '_index.json'), JSON.stringify(['not', 'an', 'object']), 'utf8');
  fs.writeFileSync(
    path.join(rootDir, 'orphan.json'),
    JSON.stringify({ schema_version: 2, session: { id: 'orphan', title: 'Orphan' } }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'unreadable_store' });

  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.sessions),
    ['orphan'],
    'recovery must rebuild the index from the orphan session file'
  );
  const recoveredLogs = logger.find('unreadable_store.split_index_recovered');
  assert.equal(recoveredLogs.length, 1, 'recovery from an unreadable index must log once');
  assert.equal(
    recoveredLogs[0].data.reason,
    'unreadable_index',
    'the recovery reason must be unreadable_index'
  );
  assert.equal(recoveredLogs[0].data.sessionCount, 1, 'recovery must report sessionCount 1');
});

test('unreadable _index.json with NO recoverable files falls back to an empty index', () => {
  const rootDir = makeTempRoot('unreadable-empty');
  // Array root => unreadable; no session files => recovery returns false =>
  // the cached index falls back to a fresh empty index.
  fs.writeFileSync(path.join(rootDir, '_index.json'), JSON.stringify([1, 2, 3]), 'utf8');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'fallback_store' });

  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(snapshot.sessions, {}, 'no sessions can be recovered -> empty index');
  assert.equal(snapshot.schema_version, 2, 'the fallback index carries the configured schema_version');
  assert.equal(
    logger.find('fallback_store.split_index_recovered').length,
    0,
    'with nothing to recover, no split_index_recovered event fires'
  );
});

test('malformed _index.json (object root, non-object sessions) recovers from session files', () => {
  const rootDir = makeTempRoot('malformed-index');
  // Object root with a configured schema_version but a non-object `sessions`
  // (an array) hits the malformed-index recovery branch.
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({ schema_version: 2, sessions: ['bogus'] }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, 'recovered.json'),
    JSON.stringify({ schema_version: 2, session: { id: 'recovered', title: 'Rec' } }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'malformed_store' });

  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.sessions),
    ['recovered'],
    'a malformed sessions map must be rebuilt from the orphan file'
  );
  const recoveredLogs = logger.find('malformed_store.split_index_recovered');
  assert.equal(recoveredLogs.length, 1, 'malformed-index recovery must log once');
  assert.equal(
    recoveredLogs[0].data.reason,
    'malformed_index',
    'the recovery reason must be malformed_index'
  );
});

// ---- SPLIT-SCHEMA MIGRATION ROUND-TRIP (deferred async migration) ---------

test('older split index queues a deferred migration, defers index writes, then completes', async () => {
  const rootDir = makeTempRoot('split-migrate');
  // Pre-seed an _index.json at schema_version 1 (< configured 2) plus two
  // per-session files so runPendingMigrations has real source to walk.
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 1,
      sessions: {
        s_one: { id: 's_one', title: 'One' },
        s_two: { id: 's_two', title: 'Two' },
      },
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, 's_one.json'),
    JSON.stringify({ schema_version: 1, session: { id: 's_one', title: 'One' } }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, 's_two.json'),
    JSON.stringify({ schema_version: 1, session: { id: 's_two', title: 'Two' } }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'mig_store' });

  // On construct, an older split index queues a deferred migration.
  assert.equal(backend.hasPendingMigrations(), true, 'older split index must queue a migration');
  const queued = logger.find('mig_store.split_schema_migration_queued');
  assert.equal(queued.length, 1, 'a single split_schema_migration_queued event must fire');
  assert.equal(queued[0].level, 'INFO', 'queued migration is logged at INFO');
  assert.equal(queued[0].data.observedVersion, 1, 'queued event carries observedVersion 1');
  assert.equal(queued[0].data.expectedVersion, 2, 'queued event carries expectedVersion 2');
  assert.equal(
    queued[0].data.indexedSessionCount,
    2,
    'queued event counts the two indexed sessions'
  );

  // A persisting upsert while a migration is pending DEFERS the index write:
  // the per-session file lands but the on-disk _index.json is NOT rewritten,
  // so it still reports the OLD schema_version 1.
  const upserted = backend.upsertSession('s_three', { title: 'Three' });
  assert.equal(upserted, true, 'upsert during a pending migration still returns true');
  assert.equal(
    fs.existsSync(path.join(rootDir, 's_three.json')),
    true,
    'the per-session file is still written during a pending migration'
  );
  const indexBefore = JSON.parse(fs.readFileSync(path.join(rootDir, '_index.json'), 'utf8'));
  assert.equal(
    indexBefore.schema_version,
    1,
    'the on-disk index write is deferred -> still at the OLD schema_version'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(indexBefore.sessions, 's_three'),
    false,
    'the deferred index write means s_three is not yet on disk'
  );

  // Drain the migration.
  const result = await backend.runPendingMigrations();
  assert.equal(result.ran, true, 'runPendingMigrations reports it ran');
  assert.equal(result.success, true, 'the migration succeeded');
  assert.equal(result.observedVersion, 1, 'the result carries the observed (old) version');
  assert.equal(backend.hasPendingMigrations(), false, 'pending migration is cleared after a run');

  // The on-disk index is now rewritten at the configured schema_version with
  // all three sessions present.
  const indexAfter = JSON.parse(fs.readFileSync(path.join(rootDir, '_index.json'), 'utf8'));
  assert.equal(indexAfter.schema_version, 2, 'the migrated index now carries schema_version 2');
  assert.deepEqual(
    Object.keys(indexAfter.sessions).sort(),
    ['s_one', 's_three', 's_two'],
    'the migrated index lists every session including the one upserted mid-flight'
  );

  const completed = logger.find('mig_store.split_schema_migration_completed');
  assert.equal(completed.length, 1, 'a single split_schema_migration_completed event must fire');
  assert.equal(completed[0].level, 'INFO', 'a successful migration completes at INFO level');
  assert.equal(completed[0].data.success, true, 'the completion event records success:true');
  assert.equal(completed[0].data.sessionCount, 3, 'the completion event counts all three sessions');
});

test('split migration preserves an index mutation that arrives during final index persistence', async () => {
  const rootDir = makeTempRoot('split-index-race');
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 1,
      sessions: { s_one: { id: 's_one', title: 'One' } },
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, 's_one.json'),
    JSON.stringify({ schema_version: 1, session: { id: 's_one', title: 'One' } }),
    'utf8'
  );
  const backend = makeBackend(rootDir, { storeName: 'race_store' });
  assert.equal(backend.hasPendingMigrations(), true, 'precondition: split migration is pending');

  const originalRenameAsync = fs.promises.rename;
  const originalRenameSync = fs.renameSync;
  let resolveMutation;
  const mutationCompleted = new Promise((resolve) => {
    resolveMutation = resolve;
  });
  let mutationScheduled = false;
  let dirtyImmediatelyAfterMutation = null;
  const mutateDuringIndexPersistence = () => {
    if (mutationScheduled) {
      return;
    }
    mutationScheduled = true;
    assert.equal(
      backend.upsertSession('s_live', { title: 'Live' }),
      true,
      'mutation through the public API succeeds'
    );
    dirtyImmediatelyAfterMutation = backend._indexDirty;
    resolveMutation();
  };

  fs.promises.rename = async (fromPath, toPath) => {
    const result = await originalRenameAsync.call(fs.promises, fromPath, toPath);
    if (toPath === backend._indexPath) {
      mutateDuringIndexPersistence();
    }
    return result;
  };
  fs.renameSync = (fromPath, toPath) => {
    const result = originalRenameSync.call(fs, fromPath, toPath);
    if (toPath === backend._indexPath && !mutationScheduled) {
      setImmediate(mutateDuringIndexPersistence);
    }
    return result;
  };

  try {
    const result = await backend.runPendingMigrations();
    await mutationCompleted;

    assert.equal(result.success, true, 'migration succeeds');
    assert.equal(
      backend._indexDirty,
      dirtyImmediatelyAfterMutation,
      'migration does not silently clear a deferred index write'
    );
    const persistedIndex = JSON.parse(fs.readFileSync(backend._indexPath, 'utf8'));
    assert.deepEqual(
      persistedIndex.sessions.s_live,
      { id: 's_live', title: 'Live' },
      'the concurrent mutation summary survives in the persisted index'
    );
  } finally {
    fs.promises.rename = originalRenameAsync;
    fs.renameSync = originalRenameSync;
  }
});

// ---- DELETE: live store path removes the file + reschedules the index -----

test('deleteSession removes a persisted session, its file, and updates the index', () => {
  const rootDir = makeTempRoot('delete-live');
  const backend = makeBackend(rootDir, { storeName: 'del_store' });

  // Persist a session so a live FileJsonStore is created in _sessionStores.
  assert.equal(backend.upsertSession('sess_del', { title: 'ToDelete' }), true, 'seed upsert ok');
  const sessionFile = path.join(rootDir, 'sess_del.json');
  assert.equal(fs.existsSync(sessionFile), true, 'precondition: the session file exists');
  assert.equal(backend.hasSession('sess_del'), true, 'precondition: the index lists the session');

  const deleted = backend.deleteSession('sess_del');
  assert.equal(deleted, true, 'deleteSession of a live session returns true');
  assert.equal(backend.hasSession('sess_del'), false, 'the session is removed from the index');
  assert.equal(fs.existsSync(sessionFile), false, 'the per-session file is unlinked via store.delete()');
  assert.equal(
    backend.hasPendingWriteForSession('sess_del'),
    false,
    'no pending write remains for a deleted session'
  );

  // _scheduleIndexWrite ran synchronously (writeDebounceMs 0): the on-disk
  // index no longer lists the deleted session.
  const onDiskIndex = JSON.parse(fs.readFileSync(path.join(rootDir, '_index.json'), 'utf8'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(onDiskIndex.sessions, 'sess_del'),
    false,
    'the rescheduled index write drops the deleted session from disk'
  );
});

test('deleteSession of an absent session returns false and logs nothing', () => {
  const rootDir = makeTempRoot('delete-absent');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'absent_store' });

  const deleted = backend.deleteSession('never_existed');
  assert.equal(deleted, false, 'deleting an unknown session returns false');
  assert.equal(logger.events.length, 0, 'an absent-session delete emits no log events');
});

// ---- WRITE_FAILED: store.write throws -> write_failed log, returns false ---

test('upsert returns false and logs write_failed when the session file path is a directory', () => {
  const rootDir = makeTempRoot('write-failed');
  // Pre-create a DIRECTORY where the atomic write expects to rename a file.
  // FileJsonStore.write() -> renameSync(temp, <id>.json) fails because the
  // target is a directory, so store.write() throws and upsert reports false.
  fs.mkdirSync(path.join(rootDir, 'sess_blocked.json'));
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'wf_store' });

  const ok = backend.upsertSession('sess_blocked', { title: 'CannotWrite' });
  assert.equal(ok, false, 'a failed store.write makes upsert return false');

  const failures = logger.find('wf_store.write_failed');
  assert.equal(failures.length, 1, 'exactly one write_failed event must fire');
  assert.equal(failures[0].level, 'WARN', 'write_failed is logged at WARN level');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, 'sess_blocked.json'),
    'the write_failed event names the per-session file path'
  );
  assert.ok(
    failures[0].data.errorMessage,
    'the write_failed event carries an error message'
  );
});

// ---- MONOLITHIC_READONLY: future-schema monolithic blocks all writes ------

test('monolithic_readonly blocks writes, flush, and flushAsync but serves cached reads', async () => {
  const rootDir = makeTempRoot('mono-readonly-root');
  const monoDir = makeTempRoot('mono-readonly-src');
  const monolithicPath = path.join(monoDir, 'sessions.json');
  // schema_version 9 > configured 2 => monolithic_readonly mode.
  fs.writeFileSync(
    monolithicPath,
    JSON.stringify({
      schema_version: 9,
      sessions: { cached_sess: { id: 'cached_sess', title: 'Cached' } },
    }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, {
    logger,
    legacyMonolithicPath: monolithicPath,
    storeName: 'mono_store',
  });

  assert.equal(backend.hasNewerSchema(), true, 'a future-schema monolithic flips hasNewerSchema');
  assert.deepEqual(
    logger.find('mono_store.newer_schema_detected').map((entry) => entry.data.observedVersion),
    [9],
    'a newer_schema_detected event surfaces the observed version'
  );

  // Cached read works (the payload was pre-loaded during init).
  const cached = backend.getSession('cached_sess');
  assert.ok(cached, 'a cached session is readable in readonly mode');
  assert.equal(cached.title, 'Cached', 'the cached record carries the migrated title');

  // A miss in readonly mode returns null (the _loadSession monolithic-miss path).
  assert.equal(
    backend.getSession('not_present'),
    null,
    'an unknown session returns null in monolithic_readonly mode'
  );

  // Writes are blocked.
  assert.equal(
    backend.upsertSession('cached_sess', { title: 'Blocked' }),
    false,
    'upsert is blocked in readonly mode'
  );
  const blocked = logger.find('mono_store.newer_schema_write_blocked');
  assert.equal(blocked.length, 1, 'the blocked upsert emits newer_schema_write_blocked');
  assert.equal(blocked[0].data.observedVersion, 9, 'the block event carries the observed version');

  // flush() / flushAsync() short-circuit to false in readonly mode.
  assert.equal(backend.flush(), false, 'flush returns false in monolithic_readonly mode');
  assert.equal(await backend.flushAsync(), false, 'flushAsync returns false in readonly mode');
});

// ---- QUARANTINE RENAME FAILURE: cannot move bad bytes aside -> null --------

test('quarantine failure leaves bytes in place, logs quarantine_failed, returns null', () => {
  const rootDir = makeTempRoot('quarantine-fail');
  // Make the quarantine directory un-creatable by pre-creating a FILE named
  // 'corrupt' at the root, so mkdirSync(rootDir/corrupt) throws (ENOTDIR/EEXIST)
  // and the rename of the corrupt session never happens.
  fs.writeFileSync(path.join(rootDir, 'corrupt'), 'i am a file, not a dir', 'utf8');
  // An index that lists a corrupt session id.
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 2,
      sessions: { bad_sess: { id: 'bad_sess', title: 'Bad' } },
    }),
    'utf8'
  );
  // The corresponding session file exists but is unparsable -> corrupted read.
  fs.writeFileSync(path.join(rootDir, 'bad_sess.json'), '<<< not json >>>', 'utf8');

  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'qf_store' });

  assert.equal(backend.hasSession('bad_sess'), true, 'precondition: the index lists the corrupt session');

  const result = backend.getSession('bad_sess');
  assert.equal(result, null, 'a failed quarantine rename returns null (missing-session behavior)');

  const quarantineFailed = logger.find('qf_store.session_file_quarantine_failed');
  assert.equal(quarantineFailed.length, 1, 'exactly one quarantine_failed event must fire');
  assert.equal(quarantineFailed[0].level, 'WARN', 'quarantine_failed is logged at WARN level');
  assert.equal(
    quarantineFailed[0].data.filePath,
    path.join(rootDir, 'bad_sess.json'),
    'the quarantine_failed event names the unmovable session file'
  );
  // No successful-quarantine event was emitted.
  assert.equal(
    logger.find('qf_store.session_file_quarantined').length,
    0,
    'a failed quarantine must NOT emit the success event'
  );
});
