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
// Split from session-storage-backend-dark-paths.test.js for file-size relief.
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
// flushAsync() dark branches
// =========================================================================

// Region 434-435 + 444-450: flushAsync skips a dirty-but-unloaded session and
// logs flush_failed when a loaded session's writeImmediate (durable write) throws.
test('flushAsync skips an unloaded dirty session and logs flush_failed when writeImmediate throws', async () => {
  const rootDir = makeTempRoot('flushasync-write-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'fa_store' });

  backend._dirtySessionIds.add('ghost_async'); // unloaded -> continue

  const boom = new Error('async write blew up');
  backend._loadedSessions.set('real_async', normalizeSession('real_async', { title: 'R' }));
  backend._dirtySessionIds.add('real_async');
  const fake = makeFakeStore(path.join(rootDir, 'real_async.json'), { writeImmediateThrows: boom });
  backend._sessionStores.set('real_async', fake);

  const wrote = await backend.flushAsync();
  assert.equal(wrote, false, 'flushAsync reports false when the only durable write throws');
  assert.equal(
    fake.calls.filter((c) => c.method === 'writeImmediate').length,
    1,
    'flushAsync invoked the injected store.writeImmediate once for the loaded dirty session'
  );
  assert.equal(backend._dirtySessionIds.has('real_async'), true, 'flushAsync RETAINS the dirty marker after a write throw');

  const failures = logger.find('fa_store.flush_failed');
  assert.equal(failures.length, 1, 'only the loaded-but-throwing session emits flush_failed');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, 'real_async.json'),
    'flush_failed names the throwing async session file'
  );
  assert.equal(failures[0].data.errorMessage, 'async write blew up', 'carries the async write error');
});

// Region 465-470: a store WITH flushAsync whose flushAsync rejects -> .catch logs.
test('flushAsync logs flush_failed when a session store.flushAsync rejects', async () => {
  const rootDir = makeTempRoot('flushasync-reject');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'far_store' });

  const boom = new Error('async store flush rejected');
  const fake = makeFakeStore(path.join(rootDir, 'sess_reject.json'), {
    withFlushAsync: true,
    flushAsyncRejects: boom,
  });
  backend._sessionStores.set('sess_reject', fake);

  const wrote = await backend.flushAsync();
  assert.equal(wrote, false, 'a rejecting store.flushAsync with nothing else reports false');
  assert.equal(
    fake.calls.filter((c) => c.method === 'flushAsync').length,
    1,
    'the injected store.flushAsync was invoked'
  );
  const failures = logger.find('far_store.flush_failed');
  assert.equal(failures.length, 1, 'a rejecting store.flushAsync emits one flush_failed');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, 'sess_reject.json'),
    'the flush_failed event is keyed by the store filePath'
  );
  assert.equal(failures[0].data.errorMessage, 'async store flush rejected', 'carries the reject reason');
});

// Region 474-486: a store WITHOUT flushAsync falls back to sync store.flush();
// success arm sets wroteAny, throw arm logs.
test('flushAsync falls back to sync store.flush() for a store lacking flushAsync (success arm)', async () => {
  const rootDir = makeTempRoot('flushasync-sync-ok');
  const backend = makeBackend(rootDir, { storeName: 'fas_store' });

  // No withFlushAsync -> the store has no flushAsync method; flush() returns true.
  const fake = makeFakeStore(path.join(rootDir, 'sess_sync.json'), { flushReturns: true });
  backend._sessionStores.set('sess_sync', fake);

  const wrote = await backend.flushAsync();
  assert.equal(wrote, true, 'a sync store.flush() that returns true makes flushAsync report wrote');
  assert.deepEqual(
    fake.calls.map((c) => c.method),
    ['flush'],
    'flushAsync used the sync flush() fallback (no flushAsync was called)'
  );
});

test('flushAsync logs flush_failed when the sync store.flush() fallback throws', async () => {
  const rootDir = makeTempRoot('flushasync-sync-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'fast_store' });

  const boom = new Error('sync fallback flush threw');
  const fake = makeFakeStore(path.join(rootDir, 'sess_syncthrow.json'), { flushThrows: boom });
  backend._sessionStores.set('sess_syncthrow', fake);

  const wrote = await backend.flushAsync();
  assert.equal(wrote, false, 'a throwing sync fallback flush reports false');
  const failures = logger.find('fast_store.flush_failed');
  assert.equal(failures.length, 1, 'the throwing sync fallback emits one flush_failed');
  assert.equal(
    failures[0].data.filePath,
    path.join(rootDir, 'sess_syncthrow.json'),
    'flush_failed is keyed by the store filePath'
  );
  assert.equal(failures[0].data.errorMessage, 'sync fallback flush threw', 'carries the fallback error');
});

// Region 491-503: flushAsync's dirty-index write() success arm: write() lands,
// _indexDirty clears, wroteAny=true.
test('flushAsync writes a dirty index via write() and clears the dirty flag', async () => {
  const rootDir = makeTempRoot('flushasync-index-write');
  const backend = makeBackend(rootDir, { storeName: 'faidx_store' });

  backend._indexDirty = true;
  backend._cachedIndex = { schema_version: 2, sessions: { z: { id: 'z', title: 'Z' } } };
  // No withFlushAsync on the index store -> the trailing sync flush() arm runs too.
  const fakeIndex = makeFakeStore(backend._indexPath, { flushReturns: false });
  backend._indexStore = fakeIndex;

  const wrote = await backend.flushAsync();
  assert.equal(wrote, true, 'a dirty index makes flushAsync report it wrote');
  assert.equal(backend._indexDirty, false, 'flushAsync clears the index dirty flag after write()');
  const writeCalls = fakeIndex.calls.filter((c) => c.method === 'write');
  assert.equal(writeCalls.length, 1, 'the index store.write must be invoked exactly once');
  assert.deepEqual(writeCalls[0].value, backend._cachedIndex, 'write() receives the cached index payload');
});

// Region 495-503: flushAsync's dirty-index write() THROWS -> flush_failed, dirty
// flag stays set.
test('flushAsync logs flush_failed when the dirty index write() throws', async () => {
  const rootDir = makeTempRoot('flushasync-index-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'faie_store' });

  backend._indexDirty = true;
  const boom = new Error('async index write blew up');
  const fakeIndex = makeFakeStore(backend._indexPath, { writeThrows: boom, flushReturns: false });
  backend._indexStore = fakeIndex;

  const wrote = await backend.flushAsync();
  assert.equal(wrote, false, 'a throwing index write() with nothing else reports false');
  assert.equal(backend._indexDirty, true, 'the index dirty flag stays set after a failed write()');
  const failures = logger.find('faie_store.flush_failed');
  assert.equal(failures.length, 1, 'a throwing index write() emits one flush_failed');
  assert.equal(failures[0].data.filePath, backend._indexPath, 'keyed by the index path');
  assert.equal(failures[0].data.errorMessage, 'async index write blew up', 'carries the index error');
});

test('flushAsync retries a cached index after its current async generation fails', async () => {
  const rootDir = makeTempRoot('flushasync-index-generation-retry');
  const backend = makeBackend(rootDir, { writeDebounceMs: 60_000 });
  const indexStore = backend._indexStore;
  const writeNowAsync = indexStore._writeNowAsync.bind(indexStore);
  let failNextWrite = true;
  indexStore._logDebouncedWriteFailure = () => {};
  indexStore._writeNowAsync = async (...args) => {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('injected async index failure');
    }
    return writeNowAsync(...args);
  };
  backend._cachedIndex = { schema_version: 2, sessions: { retry: { id: 'retry', title: 'Retry' } } };
  indexStore.write(backend._cachedIndex);
  backend._indexDirty = false;

  await backend.flushAsync();
  assert.equal(indexStore.getWriteState().failedGeneration, indexStore.getWriteState().acceptedGeneration);
  assert.equal(await backend.flushAsync(), true);
  const state = indexStore.getWriteState();
  assert.equal(state.durableGeneration, state.acceptedGeneration);
  assert.deepEqual(JSON.parse(fs.readFileSync(backend._indexPath, 'utf8')), backend._cachedIndex);
});

// Region 513-518: the index store HAS flushAsync and it rejects -> the .catch
// arm logs flush_failed keyed by the index path.
test('flushAsync logs flush_failed when the index store.flushAsync rejects', async () => {
  const rootDir = makeTempRoot('flushasync-index-reject');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'fair_store' });

  backend._indexDirty = false;
  const boom = new Error('index async flush rejected');
  const fakeIndex = makeFakeStore(backend._indexPath, {
    withFlushAsync: true,
    flushAsyncRejects: boom,
  });
  backend._indexStore = fakeIndex;

  const wrote = await backend.flushAsync();
  assert.equal(wrote, false, 'a rejecting index flushAsync with nothing else reports false');
  assert.equal(
    fakeIndex.calls.filter((c) => c.method === 'flushAsync').length,
    1,
    'the index store.flushAsync was invoked'
  );
  const failures = logger.find('fair_store.flush_failed');
  assert.equal(failures.length, 1, 'a rejecting index flushAsync emits one flush_failed');
  assert.equal(failures[0].data.filePath, backend._indexPath, 'keyed by the index path');
  assert.equal(failures[0].data.errorMessage, 'index async flush rejected', 'carries the reject reason');
});

// Region 522-534: index store LACKS flushAsync -> sync flush() fallback success arm.
test('flushAsync uses the sync index flush() fallback when the index store lacks flushAsync', async () => {
  const rootDir = makeTempRoot('flushasync-index-sync-ok');
  const backend = makeBackend(rootDir, { storeName: 'faisync_store' });

  backend._indexDirty = false;
  const fakeIndex = makeFakeStore(backend._indexPath, { flushReturns: true });
  backend._indexStore = fakeIndex;

  const wrote = await backend.flushAsync();
  assert.equal(wrote, true, 'a sync index flush() returning true makes flushAsync report wrote');
  assert.deepEqual(
    fakeIndex.calls.map((c) => c.method),
    ['flush'],
    'flushAsync used the sync index flush() fallback (no flushAsync was called)'
  );
});

// Region 526-534: the sync index flush() fallback THROWS -> flush_failed.
test('flushAsync logs flush_failed when the sync index flush() fallback throws', async () => {
  const rootDir = makeTempRoot('flushasync-index-sync-throw');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'faist_store' });

  backend._indexDirty = false;
  const boom = new Error('sync index fallback threw');
  const fakeIndex = makeFakeStore(backend._indexPath, { flushThrows: boom });
  backend._indexStore = fakeIndex;

  const wrote = await backend.flushAsync();
  assert.equal(wrote, false, 'a throwing sync index fallback reports false');
  const failures = logger.find('faist_store.flush_failed');
  assert.equal(failures.length, 1, 'the throwing sync index fallback emits one flush_failed');
  assert.equal(failures[0].data.filePath, backend._indexPath, 'keyed by the index path');
  assert.equal(failures[0].data.errorMessage, 'sync index fallback threw', 'carries the fallback error');
});
