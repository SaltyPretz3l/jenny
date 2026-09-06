'use strict';

// Integration tests for the dirty-id retention durability fix in
// SessionStorageBackend.flush(): a session whose write throws is RETAINED as
// dirty (and eviction-protected) and re-attempted on the next flush, up to a
// small failure cap after which it is dropped with one ERROR. The pure
// reconcile helper is unit-tested in session-storage-guards.test.js.
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-ssb-retain-${label}-`));
  trackDirectory(rootDir);
  return rootDir;
}

function makeRecordingLogger() {
  const events = [];
  const logger = (level, event, data) => {
    events.push({ level, event, data });
  };
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

// A FileJsonStore stand-in whose writeImmediate optionally throws.
function makeFakeStore(filePath, behavior = {}) {
  const calls = [];
  return {
    filePath,
    calls,
    write(value) { calls.push({ method: 'write', value }); },
    writeImmediate(value) {
      calls.push({ method: 'writeImmediate', value });
      if (behavior.writeImmediateThrows) {
        throw behavior.writeImmediateThrows;
      }
    },
    flush() { calls.push({ method: 'flush' }); return false; },
    hasPendingWrite() { return false; },
    dispose() { calls.push({ method: 'dispose' }); },
    delete() { calls.push({ method: 'delete' }); },
  };
}

// A session retained after a failed flush is re-attempted and cleared once its
// write finally succeeds.
test('a dirty session retained after a failed flush is persisted and cleared by a later successful flush', () => {
  const rootDir = makeTempRoot('retry-success');
  const backend = makeBackend(rootDir, { storeName: 'retry_store' });

  backend._loadedSessions.set('sess_retry', normalizeSession('sess_retry', { title: 'Retry' }));
  backend._dirtySessionIds.add('sess_retry');
  backend._sessionStores.set('sess_retry', makeFakeStore(path.join(rootDir, 'sess_retry.json'), {
    writeImmediateThrows: new Error('first write fails'),
  }));

  assert.equal(backend.flush(), false, 'the first flush fails to write');
  assert.equal(backend._dirtySessionIds.has('sess_retry'), true, 'the id is retained after the failure');
  assert.equal(backend._dirtyFlushFailureCounts.get('sess_retry'), 1, 'one failure recorded');

  // Swap in a store whose writeImmediate succeeds and flush again.
  const succeeding = makeFakeStore(path.join(rootDir, 'sess_retry.json'), {});
  backend._sessionStores.set('sess_retry', succeeding);
  assert.equal(backend.flush(), true, 'the retry flush writes successfully');
  assert.equal(
    succeeding.calls.filter((c) => c.method === 'writeImmediate').length,
    1,
    'the retained session was re-attempted on the next flush'
  );
  assert.equal(backend._dirtySessionIds.has('sess_retry'), false, 'a successful flush clears the retained id');
  assert.equal(backend._dirtyFlushFailureCounts.has('sess_retry'), false, 'the failure counter is reset');
});

// A permanently unwritable session remains dirty after the retry cap; the cap
// bounds the dedicated retention diagnostic, not accepted durability state.
test('a dirty session that keeps failing remains retained after the retry cap', () => {
  const rootDir = makeTempRoot('cap-drop');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'cap_store' });

  backend._loadedSessions.set('sess_dead', normalizeSession('sess_dead', { title: 'Dead' }));
  backend._dirtySessionIds.add('sess_dead');
  backend._sessionStores.set('sess_dead', makeFakeStore(path.join(rootDir, 'sess_dead.json'), {
    writeImmediateThrows: new Error('disk is dead'),
  }));

  backend.flush();
  assert.equal(backend._dirtyFlushFailureCounts.get('sess_dead'), 1, 'attempt 1 recorded');
  assert.equal(backend._dirtySessionIds.has('sess_dead'), true, 'retained after attempt 1');
  backend.flush();
  assert.equal(backend._dirtyFlushFailureCounts.get('sess_dead'), 2, 'attempt 2 recorded');
  assert.equal(backend._dirtySessionIds.has('sess_dead'), true, 'retained after attempt 2');
  backend.flush();
  assert.equal(backend._dirtySessionIds.has('sess_dead'), true, 'retained after the third failure');
  assert.equal(backend._dirtyFlushFailureCounts.get('sess_dead'), 3, 'the counter remains capped');

  const retained = logger.find('cap_store.flush_dirty_retained_after_retries');
  assert.equal(retained.length, 1, 'exactly one retention ERROR is emitted at the cap');
  assert.equal(retained[0].level, 'ERROR');
  assert.equal(retained[0].data.sessionId, 'sess_dead');
  assert.equal(retained[0].data.attempts, 3);
  assert.equal(logger.find('cap_store.flush_failed').length, 3, 'each failed attempt still logs flush_failed');
});

// The retained dirty marker also re-protects the session from cache eviction so
// a transient disk error does not compound into full in-memory loss.
test('a dirty session retained after a failed flush is protected from _pruneCache eviction', () => {
  const rootDir = makeTempRoot('retain-no-evict');
  const backend = makeBackend(rootDir, { storeName: 'evict_store' });

  backend._loadedSessions.set('sess_hot', normalizeSession('sess_hot', { title: 'Hot' }));
  backend._dirtySessionIds.add('sess_hot');
  backend._sessionStores.set('sess_hot', makeFakeStore(path.join(rootDir, 'sess_hot.json'), {
    writeImmediateThrows: new Error('write failed'),
  }));
  backend.flush();
  assert.equal(backend._dirtySessionIds.has('sess_hot'), true, 'retained dirty after the failed flush');

  // Put it at the front of the LRU, then overflow the cache with clean sessions
  // and prune: the retained-dirty session must survive.
  backend._sessionLru.add('sess_hot');
  for (let i = 0; i < 40; i += 1) {
    const id = `clean_${i}`;
    backend._loadedSessions.set(id, normalizeSession(id, { title: id }));
    backend._sessionLru.add(id);
  }
  backend._pruneCache();

  assert.equal(
    backend._loadedSessions.has('sess_hot'),
    true,
    'the retained-dirty session is protected from eviction (hasPendingWriteForSession is true)'
  );
  assert.equal(backend.hasPendingWriteForSession('sess_hot'), true, 'the retained dirty id reports a pending write');
  assert.ok(backend._loadedSessions.size <= 30, 'the clean overflow was pruned down to the cap');
});

// The ASYNC flush path must attribute a real disk failure the same way the sync
// path does. Under production debouncing (writeDebounceMs > 0) the previous
// flushAsync() staged each dirty session with store.write(), which only BUFFERS
// and cannot throw for a genuine disk failure, so every dirty session was
// classified "flushed" before the disk I/O ran -- an ENOSPC during an
// active-turn touch silently cleared the dirty marker with zero retries. The
// async path now forces each dirty session to disk (writeImmediate), so a
// throwing write is RETAINED, eviction-protected, and retried, exactly like
// the synchronous flush().
test('flushAsync retains a dirty session whose durable write fails under debouncing', async () => {
  const rootDir = makeTempRoot('flushasync-retain');
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, {
    logger,
    storeName: 'fa_retain_store',
    // Production-like: a debounced store.write() would only buffer, never throw.
    writeDebounceMs: 500,
  });

  backend._loadedSessions.set('sess_async', normalizeSession('sess_async', { title: 'AsyncHot' }));
  backend._dirtySessionIds.add('sess_async');
  const failing = makeFakeStore(path.join(rootDir, 'sess_async.json'), {
    writeImmediateThrows: new Error('disk full during async flush'),
  });
  backend._sessionStores.set('sess_async', failing);

  const wrote = await backend.flushAsync();

  assert.equal(wrote, false, 'flushAsync reports nothing landed when the only durable write fails');
  assert.equal(
    failing.calls.filter((c) => c.method === 'writeImmediate').length,
    1,
    'flushAsync forces the dirty session to disk via writeImmediate (not a debounced buffer)'
  );
  assert.equal(
    failing.calls.filter((c) => c.method === 'write').length,
    0,
    'flushAsync no longer stages the dirty session with the non-throwing debounced write()'
  );
  assert.equal(backend.hasPendingWriteForSession('sess_async'), true, 'the pending write is RETAINED after the failed async flush');
  assert.equal(backend._dirtyFlushFailureCounts.get('sess_async'), 1, 'one async failure recorded for retry bookkeeping');
  assert.equal(logger.find('fa_retain_store.flush_failed').length, 1, 'the failed async flush logs flush_failed');

  // Drop the injected fakes so no debounce timer or dirty state outlives the test.
  backend._dirtySessionIds.clear();
  backend._sessionStores.clear();
});
