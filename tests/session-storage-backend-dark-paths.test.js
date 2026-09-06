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

// ---- Shared hand-built injectors ----------------------------------------
// Mirrors the behavior/lru siblings. This file targets the deep flush /
// flushAsync / _pruneCache / _recoverSplitIndexFromSessionFiles /
// _scheduleIndexWrite error branches the behavior test does not reach, by
// INJECTING FileJsonStore-shaped recorders that throw on demand, then asserting
// concrete return values AND that the injected collaborators + logger were
// invoked with the right args.

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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-ssb-dark-${label}-`));
  trackDirectory(rootDir);
  return rootDir;
}

// A logger() recording every (level, event, data) triple for the oracles.
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

// A hand-built FileJsonStore stand-in. Every call is recorded; behaviour is
// configurable per-method so a single shape can drive both the throwing and
// the success branches of flush()/flushAsync().
function makeFakeStore(filePath, behavior = {}) {
  const calls = [];
  const store = {
    filePath,
    calls,
    write(value) {
      calls.push({ method: 'write', value });
      if (behavior.writeThrows) {
        throw behavior.writeThrows;
      }
    },
    writeImmediate(value) {
      calls.push({ method: 'writeImmediate', value });
      if (behavior.writeImmediateThrows) {
        throw behavior.writeImmediateThrows;
      }
    },
    flush() {
      calls.push({ method: 'flush' });
      if (behavior.flushThrows) {
        throw behavior.flushThrows;
      }
      return Boolean(behavior.flushReturns);
    },
    hasPendingWrite() {
      calls.push({ method: 'hasPendingWrite' });
      return Boolean(behavior.hasPendingWrite);
    },
    dispose() {
      calls.push({ method: 'dispose' });
      if (behavior.disposeThrows) {
        throw behavior.disposeThrows;
      }
    },
    delete() {
      calls.push({ method: 'delete' });
      if (behavior.deleteThrows) {
        throw behavior.deleteThrows;
      }
    },
  };
  if (behavior.withFlushAsync) {
    store.flushAsync = async () => {
      calls.push({ method: 'flushAsync' });
      if (behavior.flushAsyncRejects) {
        throw behavior.flushAsyncRejects;
      }
      return Boolean(behavior.flushAsyncReturns);
    };
  }
  return store;
}

// =========================================================================
// deleteSession dark branches
// =========================================================================

// Region 321-327 — REWRITTEN for CTL-008 (was a defect-asserting pin): a live
// store.delete() throw means the session file is still on disk, so the delete
// must NOT report success and the session must be RETAINED (dropping the
// index entry would orphan the file). The delete_failed diagnostic stays.
// Full durability contract: tests/session-deletion-durability.test.js.
test('deleteSession reports non-success and retains the session when a live store.delete() throws', () => {
  const rootDir = makeTempRoot('del-live-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'del_store' });

  // Seed a real session so the index lists it, then swap in a throwing store.
  assert.equal(backend.upsertSession('sess_boom', { title: 'Boom' }), true, 'seed upsert ok');
  const boom = new Error('disk gone');
  const fake = makeFakeStore(path.join(rootDir, 'sess_boom.json'), { deleteThrows: boom });
  backend._sessionStores.set('sess_boom', fake);

  const deleted = backend.deleteSession('sess_boom');
  assert.equal(
    deleted === true || deleted?.ok === true,
    false,
    'a delete whose store.delete() throws must not read as success under any result shape'
  );
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ['delete'],
    'the live store.delete() must have been invoked exactly once'
  );
  assert.equal(
    backend.hasSession('sess_boom'),
    true,
    'the session stays in the index: its file is still on disk and must remain reachable'
  );

  const failures = logger.find('del_store.delete_failed');
  assert.equal(failures.length, 1, 'exactly one delete_failed event must fire');
  assert.equal(failures[0].level, 'WARN', 'delete_failed is logged at WARN');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, 'sess_boom.json'),
    'the delete_failed event names the per-session file path'
  );
  assert.equal(
    failures[0].data.errorMessage,
    'disk gone',
    'the delete_failed event carries the thrown error message'
  );
});

// Region 334-342 — REWRITTEN for CTL-008 (was a defect-asserting pin): no live
// store; fs.unlinkSync throws a NON-ENOENT error (unlinkSync of a directory
// throws EPERM/EISDIR). The failed unlink must not read as success and the
// session must be retained; the delete_failed diagnostic stays.
// Full durability contract: tests/session-deletion-durability.test.js.
test('deleteSession reports non-success and retains the session when unlinkSync throws a non-ENOENT error', () => {
  const rootDir = makeTempRoot('del-unlink-throw');
  const logger = makeRecordingLogger();
  // Pre-seed an index that lists a session whose "file" is actually a directory.
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 2,
      sessions: { sess_dir: { id: 'sess_dir', title: 'DirSession' } },
    }),
    'utf8'
  );
  fs.mkdirSync(path.join(rootDir, 'sess_dir.json'));
  const backend = makeBackend(rootDir, { logger, storeName: 'unlink_store' });

  // No live store exists for sess_dir, so deleteSession takes the unlinkSync
  // branch; unlinking a directory throws (EPERM on Windows, EISDIR on POSIX).
  assert.equal(backend._sessionStores.has('sess_dir'), false, 'precondition: no live store');
  const deleted = backend.deleteSession('sess_dir');
  assert.equal(
    deleted === true || deleted?.ok === true,
    false,
    'a delete whose unlink failed must not read as success under any result shape'
  );
  assert.equal(backend.hasSession('sess_dir'), true, 'the undeletable session stays in the index');

  const failures = logger.find('unlink_store.delete_failed');
  assert.equal(failures.length, 1, 'a non-ENOENT unlink error must emit one delete_failed event');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, 'sess_dir.json'),
    'the delete_failed event names the unlinkable path'
  );
  assert.notEqual(
    failures[0].data.errorCode,
    'ENOENT',
    'the surfaced error must NOT be the swallowed ENOENT (a real failure was logged)'
  );
});

// =========================================================================
// flush() dark branches
// =========================================================================

// Region 360-361 + 370-376: skip a dirty-but-unloaded session (continue) AND a
// present dirty session whose store.writeImmediate throws -> flush_failed.
test('flush skips a dirty session with no loaded record and logs flush_failed when writeImmediate throws', () => {
  const rootDir = makeTempRoot('flush-immediate-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'fl_store' });

  // sess_ghost is dirty but has NO loaded record -> the `if (!session) continue`.
  backend._dirtySessionIds.add('sess_ghost');

  // sess_real is dirty AND loaded; its store.writeImmediate throws.
  const boom = new Error('immediate write blew up');
  backend._loadedSessions.set('sess_real', normalizeSession('sess_real', { title: 'Real' }));
  backend._dirtySessionIds.add('sess_real');
  const fake = makeFakeStore(path.join(rootDir, 'sess_real.json'), { writeImmediateThrows: boom });
  backend._sessionStores.set('sess_real', fake);

  const wrote = backend.flush();

  // sess_real's writeImmediate threw and there was no index dirty/no real
  // session store wrote, so flush reports nothing landed.
  assert.equal(wrote, false, 'flush reports false when the only write attempt throws');
  assert.deepEqual(
    fake.calls.filter((c) => c.method === 'writeImmediate').length,
    1,
    'flush invoked the injected store.writeImmediate exactly once for the loaded dirty session'
  );
  // A throwing write RETAINS the dirty marker (durability fix); a ghost is dropped.
  assert.equal(
    backend._dirtySessionIds.has('sess_real'),
    true,
    'flush must RETAIN the dirty marker after a write failure'
  );
  assert.equal(
    backend._dirtySessionIds.has('sess_ghost'),
    false,
    'the skipped ghost session (no loaded record) is dropped from the dirty set'
  );
  // DIRECT proof the `if (!session) continue` guard held: a skipped ghost must
  // never reach _getOrCreateSessionStore, so no real FileJsonStore is created
  // for it and no ghost file is written to disk. (If the guard is removed,
  // flush would create a real store for sess_ghost and writeImmediate a
  // {session: undefined} record — both observable here.)
  assert.equal(
    backend._sessionStores.has('sess_ghost'),
    false,
    'the skipped ghost session never had a session store created (the continue guard held)'
  );
  assert.equal(
    fs.existsSync(path.join(rootDir, 'sess_ghost.json')),
    false,
    'no per-session file was written for the skipped ghost session'
  );

  const failures = logger.find('fl_store.flush_failed');
  assert.equal(failures.length, 1, 'only the loaded-but-throwing session emits flush_failed');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, 'sess_real.json'),
    'the flush_failed event names the throwing session file (not the skipped ghost)'
  );
  assert.equal(failures[0].data.errorMessage, 'immediate write blew up', 'carries the thrown message');
});

// Region 386-392: a per-session store.flush() throws during the live-store
// flush loop -> flush_failed keyed by store.filePath.
test('flush logs flush_failed when a live session store.flush() throws', () => {
  const rootDir = makeTempRoot('flush-store-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'sf_store' });

  const boom = new Error('store flush exploded');
  const fake = makeFakeStore(path.join(rootDir, 'sess_x.json'), { flushThrows: boom });
  backend._sessionStores.set('sess_x', fake);

  const wrote = backend.flush();
  assert.equal(wrote, false, 'a throwing store.flush() with nothing else dirty reports false');
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ['flush'],
    'the injected store.flush() must have been invoked'
  );
  const failures = logger.find('sf_store.flush_failed');
  assert.equal(failures.length, 1, 'a throwing store.flush() emits one flush_failed event');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, 'sess_x.json'),
    'the flush_failed event is keyed by the store filePath'
  );
  assert.equal(failures[0].data.errorMessage, 'store flush exploded', 'carries the store error message');
});

// Region 397-409: the _indexDirty index writeImmediate success arm.
test('flush writes a dirty index via writeImmediate and clears the index dirty flag', () => {
  const rootDir = makeTempRoot('flush-index-immediate');
  const backend = makeBackend(rootDir, { storeName: 'idx_store' });

  // Mark the cached index dirty and inject a recording index store.
  backend._indexDirty = true;
  backend._cachedIndex = {
    schema_version: 2,
    sessions: { only: { id: 'only', title: 'Only' } },
  };
  const fakeIndex = makeFakeStore(backend._indexPath, { flushReturns: false });
  backend._indexStore = fakeIndex;

  const wrote = backend.flush();
  assert.equal(wrote, true, 'a dirty index makes flush report it wrote');
  assert.equal(backend._indexDirty, false, 'flush clears the index dirty flag after writeImmediate');
  const immediateCalls = fakeIndex.calls.filter((c) => c.method === 'writeImmediate');
  assert.equal(immediateCalls.length, 1, 'the index store.writeImmediate must be invoked exactly once');
  assert.deepEqual(
    immediateCalls[0].value,
    backend._cachedIndex,
    'writeImmediate receives the cached index payload'
  );
});

// Region 401-409: writeImmediate of a dirty index THROWS -> flush_failed keyed
// by the index path; the dirty flag is NOT cleared.
test('flush logs flush_failed when the dirty index writeImmediate throws', () => {
  const rootDir = makeTempRoot('flush-index-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'ifail_store' });

  backend._indexDirty = true;
  const boom = new Error('index immediate blew up');
  const fakeIndex = makeFakeStore(backend._indexPath, {
    writeImmediateThrows: boom,
    flushReturns: false,
  });
  backend._indexStore = fakeIndex;

  const wrote = backend.flush();
  assert.equal(wrote, false, 'a throwing index writeImmediate with nothing else reports false');
  assert.equal(backend._indexDirty, true, 'the index dirty flag stays set after a failed writeImmediate');

  const failures = logger.find('ifail_store.flush_failed');
  assert.equal(failures.length, 1, 'a throwing index writeImmediate emits one flush_failed');
  assert.equal(
    failures[0].data.filePath,
    backend._indexPath,
    'the index flush_failed is keyed by the index path'
  );
  assert.equal(failures[0].data.errorMessage, 'index immediate blew up', 'carries the index error');
});

// Region 415-421: the trailing indexStore.flush() throws -> flush_failed.
test('flush logs flush_failed when the trailing indexStore.flush() throws', () => {
  const rootDir = makeTempRoot('flush-index-flush-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'itrail_store' });

  // Index is NOT dirty (skip the writeImmediate arm) but its flush() throws.
  backend._indexDirty = false;
  const boom = new Error('index flush exploded');
  const fakeIndex = makeFakeStore(backend._indexPath, { flushThrows: boom });
  backend._indexStore = fakeIndex;

  const wrote = backend.flush();
  assert.equal(wrote, false, 'a throwing trailing index flush() reports false');
  assert.deepEqual(
    fakeIndex.calls.map((c) => c.method),
    ['flush'],
    'the trailing indexStore.flush() must have been invoked'
  );
  const failures = logger.find('itrail_store.flush_failed');
  assert.equal(failures.length, 1, 'a throwing trailing index flush() emits one flush_failed');
  assert.equal(failures[0].data.filePath, backend._indexPath, 'keyed by the index path');
  assert.equal(failures[0].data.errorMessage, 'index flush exploded', 'carries the index flush error');
});

// =========================================================================
// flushAsync() dark branches — moved to
// tests/session-storage-backend-dark-paths-flush-async.test.js (file-size split)
// =========================================================================

// =========================================================================
// runPendingMigrations: in-flight promise short-circuit (577-578)
// =========================================================================

test('runPendingMigrations short-circuits a concurrent call to the single in-flight run', async () => {
  const rootDir = makeTempRoot('migration-inflight');
  // Seed an older split index so a migration is queued on construct.
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 1,
      sessions: { s_a: { id: 's_a', title: 'A' } },
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, 's_a.json'),
    JSON.stringify({ schema_version: 1, session: { id: 's_a', title: 'A' } }),
    'utf8'
  );
  // A migratePayload spy that counts how many times the migration engine ran:
  // the in-flight short-circuit (line 577-578) means a concurrent second call
  // must NOT drive a second migration, so this counter stays at 1.
  let migrateCount = 0;
  const countingMigrate = (payload) => {
    migrateCount += 1;
    return payload;
  };
  const backend = makeBackend(rootDir, {
    storeName: 'inflight_store',
    migratePayload: countingMigrate,
  });
  assert.equal(backend.hasPendingMigrations(), true, 'precondition: a migration is queued');

  // Fire two runs without awaiting the first. Both resolve to the SAME result
  // object identity because the second call returns the same in-flight promise
  // (which the async wrapper resolves to that one underlying result).
  const first = backend.runPendingMigrations();
  const second = backend.runPendingMigrations();
  const [resultA, resultB] = await Promise.all([first, second]);

  assert.strictEqual(
    resultA,
    resultB,
    'a concurrent runPendingMigrations resolves to the very same in-flight result object'
  );
  assert.equal(resultA.ran, true, 'the single in-flight migration actually ran');
  assert.equal(resultA.success, true, 'the migration succeeded');
  assert.equal(
    migrateCount,
    1,
    'the migration engine ran exactly once despite two concurrent runPendingMigrations calls'
  );
  assert.equal(backend.hasPendingMigrations(), false, 'the migration is cleared after the run');
});

// =========================================================================
// _pruneCache: store.dispose() throws is swallowed (612-613)
// =========================================================================

test('_pruneCache swallows a throwing store.dispose() while still evicting clean stores', () => {
  const rootDir = makeTempRoot('prune-dispose-throw');
  const backend = makeBackend(rootDir, { storeName: 'prune_store' });

  // Fill _sessionStores past the cap (30) with throwing-dispose fakes that
  // report no pending write (so they are eligible for eviction). The LRU set
  // drives the eviction order, so populate it in the same order.
  const boom = new Error('dispose blew up');
  for (let i = 0; i < 40; i += 1) {
    const id = `prune_${i}`;
    const fake = makeFakeStore(path.join(rootDir, `${id}.json`), {
      hasPendingWrite: false,
      disposeThrows: boom,
    });
    backend._sessionStores.set(id, fake);
    backend._sessionLru.add(id);
  }
  const before = backend._sessionStores.size;
  assert.ok(before > 30, 'precondition: the store map is over the cap');

  // _pruneCache is invoked on any _touchSession; trigger it directly. It must
  // not throw despite store.dispose() throwing on every eviction.
  assert.doesNotThrow(() => backend._pruneCache(), '_pruneCache swallows dispose() errors');
  assert.ok(
    backend._sessionStores.size <= 30,
    `_pruneCache evicted down to the cap despite dispose() throwing (size=${backend._sessionStores.size})`
  );
  // The evicted stores' dispose() was actually attempted (the throw was caught,
  // not avoided): pick the oldest evicted id and confirm it left the map.
  assert.equal(
    backend._sessionStores.has('prune_0'),
    false,
    'the oldest store was evicted even though its dispose() threw'
  );
});

// =========================================================================
// _loadSession dark branches
// =========================================================================

// Region 629-632: in monolithic_readonly mode, a session NOT in the loaded
// cache returns null (the readonly-miss path).
test('_loadSession returns null for an unknown session in monolithic_readonly mode', () => {
  const rootDir = makeTempRoot('mono-miss-root');
  const monoDir = makeTempRoot('mono-miss-src');
  const monolithicPath = path.join(monoDir, 'sessions.json');
  fs.writeFileSync(
    monolithicPath,
    JSON.stringify({
      schema_version: 9, // > configured 2 -> monolithic_readonly
      sessions: { cached_one: { id: 'cached_one', title: 'Cached One' } },
    }),
    'utf8'
  );
  const backend = makeBackend(rootDir, {
    legacyMonolithicPath: monolithicPath,
    storeName: 'mono_miss_store',
  });
  assert.equal(backend._mode, 'monolithic_readonly', 'precondition: readonly mode active');

  // Force hasSession true for a session that is NOT pre-loaded so _loadSession
  // is reached and takes the readonly-miss return-null branch.
  backend._cachedIndex.sessions.missing_one = { id: 'missing_one', title: 'Missing' };
  assert.equal(backend._loadedSessions.has('missing_one'), false, 'precondition: not pre-loaded');

  const result = backend.getSession('missing_one');
  assert.equal(
    result,
    null,
    'a readonly-mode session absent from the loaded cache returns null'
  );
  // A genuinely pre-loaded session still reads back.
  assert.equal(backend.getSession('cached_one').title, 'Cached One', 'pre-loaded readonly read works');
});

// Region 649-650: split-mode _loadSession of a session whose file is MISSING
// (not corrupt) returns null. We force the index to list a session with no file.
test('_loadSession returns null for a split-mode session whose file is missing', () => {
  const rootDir = makeTempRoot('load-missing-file');
  const backend = makeBackend(rootDir, { storeName: 'miss_store' });

  // Index lists a session id but no per-session file was ever written and no
  // live store exists, so readWithStatus reports missing (ENOENT) -> raw null.
  backend._cachedIndex.sessions.ghost_file = { id: 'ghost_file', title: 'Ghost' };
  assert.equal(backend.hasSession('ghost_file'), true, 'precondition: index lists the session');
  assert.equal(
    fs.existsSync(path.join(rootDir, 'ghost_file.json')),
    false,
    'precondition: no per-session file on disk'
  );

  const result = backend.getSession('ghost_file');
  assert.equal(result, null, 'a missing (not corrupt) session file reads back as null');
});

// =========================================================================
// _recoverSplitIndexFromSessionFiles dark branches
// =========================================================================

// Region 759-760 + 765-766: recovery skips a file whose record is a non-object
// (array root) and a file whose derived session id is empty. The remaining good
// file is recovered, proving the skip branches were taken (count == 1, not 3).
test('split-index recovery skips non-object and id-less session files', () => {
  const rootDir = makeTempRoot('recover-skip');
  // No _index.json so init runs recovery from session files.
  // 1) array-root file -> sessionRecord is an array -> skipped (759-760).
  fs.writeFileSync(path.join(rootDir, 'arr.json'), JSON.stringify([1, 2, 3]), 'utf8');
  // 2) a JSON `null` file -> sessionRecord null -> skipped (759-760).
  fs.writeFileSync(path.join(rootDir, 'nul.json'), JSON.stringify(null), 'utf8');
  // 3) a genuine recoverable session.
  fs.writeFileSync(
    path.join(rootDir, 'good.json'),
    JSON.stringify({ schema_version: 2, session: { id: 'good', title: 'Good' } }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'skip_store' });

  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.sessions),
    ['good'],
    'only the well-formed session file is recovered; the array/null files are skipped'
  );
  const recovered = logger.find('skip_store.split_index_recovered');
  assert.equal(recovered.length, 1, 'recovery logged once');
  assert.equal(
    recovered[0].data.sessionCount,
    1,
    'exactly one session recovered -> the two malformed files were skipped'
  );
});

// Region 765-766: recovery skips a file whose derived id is empty. Achieve an
// empty id by writing a session record with id '' to a file named '.json'
// (basename of '.json' is '' so both id sources are blank).
test('split-index recovery skips a session file that yields an empty id', () => {
  const rootDir = makeTempRoot('recover-emptyid');
  // A file named '.json': path.basename('.json', '.json') === '' and the record
  // carries an empty id, so the derived sessionId trims to '' -> skipped.
  fs.writeFileSync(
    path.join(rootDir, '.json'),
    JSON.stringify({ schema_version: 2, session: { id: '   ', title: 'Blank' } }),
    'utf8'
  );
  // Plus one good file so recovery has something to return.
  fs.writeFileSync(
    path.join(rootDir, 'keep.json'),
    JSON.stringify({ schema_version: 2, session: { id: 'keep', title: 'Keep' } }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'emptyid_store' });

  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.sessions),
    ['keep'],
    'the empty-id file is skipped; only the well-formed file is recovered'
  );
  assert.equal(
    logger.find('emptyid_store.split_index_recovered')[0].data.sessionCount,
    1,
    'exactly one session recovered (the blank-id file was skipped)'
  );
});

// Region 787-794: recovery's index writeImmediate THROWS (the index path is a
// directory so the atomic rename fails) -> _indexDirty=true + recovery_write_failed.
test('split-index recovery logs recovery_write_failed and marks index dirty when the index write throws', () => {
  const rootDir = makeTempRoot('recover-write-fail');
  // Pre-create _index.json as a DIRECTORY so FileJsonStore.writeImmediate's
  // rename(temp, _index.json) fails -> the recovery write throws.
  fs.mkdirSync(path.join(rootDir, '_index.json'));
  // A recoverable session file so recovery proceeds to the index write.
  fs.writeFileSync(
    path.join(rootDir, 'rec.json'),
    JSON.stringify({ schema_version: 2, session: { id: 'rec', title: 'Rec' } }),
    'utf8'
  );
  const logger = makeRecordingLogger();
  // Construction must not throw even though the recovery write fails.
  const backend = makeBackend(rootDir, { logger, storeName: 'rwf_store' });

  // The in-memory index still holds the recovered session.
  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.sessions),
    ['rec'],
    'recovery still rebuilds the in-memory index despite the failed disk write'
  );
  assert.equal(backend._indexDirty, true, 'a failed recovery write marks the index dirty for a later flush');

  const failures = logger.find('rwf_store.split_index_recovery_write_failed');
  assert.equal(failures.length, 1, 'a failed recovery write emits one recovery_write_failed event');
  assert.equal(failures[0].level, 'WARN', 'recovery_write_failed is logged at WARN');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, '_index.json'),
    'the recovery_write_failed event names the index path'
  );
});

// Region 803-804: recovery's success-log logger() THROWS and is swallowed
// (void _logError); recovery still completes and the in-memory index is rebuilt.
test('split-index recovery swallows a throwing success logger and still rebuilds the index', () => {
  const rootDir = makeTempRoot('recover-log-throw');
  fs.writeFileSync(
    path.join(rootDir, 'lg.json'),
    JSON.stringify({ schema_version: 2, session: { id: 'lg', title: 'Lg' } }),
    'utf8'
  );

  // A logger that throws ONLY on the recovered success event (so the
  // writeImmediate path runs cleanly first, then the success-log throw is hit).
  const calls = [];
  const throwingLogger = (level, event, data) => {
    calls.push({ level, event, data });
    if (event === 'logthrow_store.split_index_recovered') {
      throw new Error('logger blew up on success event');
    }
  };

  let backend;
  assert.doesNotThrow(() => {
    backend = makeBackend(rootDir, { logger: throwingLogger, storeName: 'logthrow_store' });
  }, 'a throwing success logger must not break construction/recovery');

  const snapshot = backend.getIndexSnapshot();
  assert.deepEqual(
    Object.keys(snapshot.sessions),
    ['lg'],
    'recovery completed and rebuilt the index despite the success logger throwing'
  );
  // The success event WAS attempted (the throw proves the line ran).
  assert.equal(
    calls.filter((c) => c.event === 'logthrow_store.split_index_recovered').length,
    1,
    'the success log line was reached exactly once (its throw was swallowed)'
  );
});

// =========================================================================
// _scheduleIndexWrite dark branches (via deleteSession, which calls it)
// =========================================================================

// Region 811-812: _scheduleIndexWrite early-returns on the `!this._indexStore`
// arm: a backend whose index store was dropped still lets deleteSession proceed
// without throwing and without any index-write log.
test('_scheduleIndexWrite is a no-op when there is no index store', () => {
  const rootDir = makeTempRoot('schedule-noindex');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'noidx_store' });

  // Seed a session, then drop the index store to hit the `!this._indexStore` arm.
  backend.upsertSession('sess_ni', { title: 'NI' });
  backend.flush();
  backend._indexStore = null;
  const logsBefore = logger.events.length;

  // deleteSession calls _scheduleIndexWrite; with no index store it must be a
  // silent no-op (no throw, no write_failed) while still updating the cache.
  const deleted = backend.deleteSession('sess_ni');
  assert.equal(deleted, true, 'deleteSession still returns true with no index store');
  assert.equal(backend.hasSession('sess_ni'), false, 'the session is dropped from the cached index');
  assert.equal(
    logger.find('noidx_store.write_failed').length,
    0,
    'a no-index _scheduleIndexWrite emits no write_failed event'
  );
  assert.equal(
    logger.events.length,
    logsBefore,
    'the no-index schedule path logs nothing at all'
  );
});

// Region 813-816: _scheduleIndexWrite with a PENDING migration just sets
// _indexDirty=true (deferring the write) and returns.
test('_scheduleIndexWrite defers (marks dirty) when a split migration is pending', () => {
  const rootDir = makeTempRoot('schedule-pending');
  // Older split index -> a migration is queued on construct.
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 1,
      sessions: {
        keepme: { id: 'keepme', title: 'Keep' },
        dropme: { id: 'dropme', title: 'Drop' },
      },
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(rootDir, 'dropme.json'),
    JSON.stringify({ schema_version: 1, session: { id: 'dropme', title: 'Drop' } }),
    'utf8'
  );
  const backend = makeBackend(rootDir, { storeName: 'pending_store' });
  assert.equal(backend.hasPendingMigrations(), true, 'precondition: a migration is queued');
  assert.equal(backend._indexDirty, false, 'precondition: index not yet marked dirty');

  // Capture the on-disk index before the delete to prove the write was deferred.
  const indexBefore = JSON.parse(fs.readFileSync(path.join(rootDir, '_index.json'), 'utf8'));
  assert.ok(
    Object.prototype.hasOwnProperty.call(indexBefore.sessions, 'dropme'),
    'precondition: dropme is in the on-disk index'
  );

  const deleted = backend.deleteSession('dropme');
  assert.equal(deleted, true, 'delete during a pending migration returns true');
  assert.equal(backend.hasSession('dropme'), false, 'the session leaves the in-memory index');
  assert.equal(
    backend._indexDirty,
    true,
    '_scheduleIndexWrite deferred the write by marking the index dirty (pending migration)'
  );

  // The on-disk index was NOT rewritten (the write was deferred), so dropme is
  // still present on disk until the migration drains.
  const indexAfter = JSON.parse(fs.readFileSync(path.join(rootDir, '_index.json'), 'utf8'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(indexAfter.sessions, 'dropme'),
    true,
    'the deferred schedule did NOT rewrite the on-disk index yet'
  );
});

// Region 821-827: _scheduleIndexWrite's index.write() THROWS -> write_failed log
// keyed by the index path. Inject a throwing index store, then delete a session.
test('_scheduleIndexWrite logs write_failed when the index store.write() throws', () => {
  const rootDir = makeTempRoot('schedule-write-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'swt_store' });

  // Seed a session so the index lists it, then swap in a throwing index store.
  backend.upsertSession('sess_sw', { title: 'SW' });
  backend.flush();
  const boom = new Error('schedule index write blew up');
  const fakeIndex = makeFakeStore(backend._indexPath, { writeThrows: boom });
  backend._indexStore = fakeIndex;

  const deleted = backend.deleteSession('sess_sw');
  assert.equal(deleted, true, 'deleteSession still returns true after a failed index write');
  assert.equal(backend.hasSession('sess_sw'), false, 'the session is dropped from the cached index');
  assert.equal(
    fakeIndex.calls.filter((c) => c.method === 'write').length,
    1,
    'the injected index store.write was invoked exactly once during _scheduleIndexWrite'
  );

  const failures = logger.find('swt_store.write_failed');
  assert.equal(failures.length, 1, 'a throwing schedule index write emits one write_failed');
  assert.equal(failures[0].data.filePath, backend._indexPath, 'keyed by the index path');
  assert.equal(failures[0].data.errorMessage, 'schedule index write blew up', 'carries the write error');
});
