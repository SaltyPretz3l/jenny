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

test('SessionStorageBackend limits in-memory loaded sessions and stores using LRU strategy', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-lru-test-'));
  trackDirectory(rootDir);

  const normalizeSession = (id, record) => {
    return { id, title: record.title || 'Untitled', messages: record.messages || [] };
  };
  const summarizeSession = (record) => {
    return { id: record.id, title: record.title };
  };
  const migratePayload = (payload) => payload;

  const backend = new SessionStorageBackend(rootDir, {
    schemaVersion: 1,
    normalizeSession,
    summarizeSession,
    migratePayload,
    writeDebounceMs: 0,
  });

  // 1. Write 35 sessions (5 more than the limit of 30)
  const sessionIds = [];
  for (let i = 1; i <= 35; i++) {
    const sessionId = `sess_${i}`;
    sessionIds.push(sessionId);
    backend.upsertSession(sessionId, { title: `Session ${i}` });
  }

  // Flush to ensure all writes land on disk and are clean
  backend.flush();

  // 2. Assert that caches are capped at 30
  assert.ok(backend._loadedSessions.size <= 30, `Loaded sessions size is ${backend._loadedSessions.size}, expected <= 30`);
  assert.ok(backend._sessionStores.size <= 30, `Session stores size is ${backend._sessionStores.size}, expected <= 30`);

  // 3. Assert that the earliest sessions (sess_1 to sess_5) were evicted
  for (let i = 1; i <= 5; i++) {
    const sessionId = `sess_${i}`;
    assert.equal(backend._loadedSessions.has(sessionId), false, `${sessionId} should be evicted from loaded sessions`);
    assert.equal(backend._sessionStores.has(sessionId), false, `${sessionId} should be evicted from session stores`);
  }

  // 4. Assert that the latest sessions (sess_6 to sess_35) are still in memory
  for (let i = 6; i <= 35; i++) {
    const sessionId = `sess_${i}`;
    assert.equal(backend._loadedSessions.has(sessionId), true, `${sessionId} should still be cached`);
    assert.equal(backend._sessionStores.has(sessionId), true, `${sessionId} should still be cached`);
  }

  // 5. Access an evicted session (sess_1). It should be loaded back.
  const session1 = backend.getSession('sess_1');
  assert.ok(session1);
  assert.equal(session1.title, 'Session 1');
  assert.equal(backend._loadedSessions.has('sess_1'), true, 'sess_1 should be loaded back into cache');

  // Since sess_1 was accessed, it became the most recently used.
  // Writing another session should now evict sess_6 (the new oldest) instead of sess_1.
  backend.upsertSession('sess_36', { title: 'Session 36' });
  backend.flush();

  assert.equal(backend._loadedSessions.has('sess_6'), false, 'sess_6 should have been evicted as the oldest');
  assert.equal(backend._loadedSessions.has('sess_1'), true, 'sess_1 should still be in cache because it was recently accessed');

  // 6. Delete a session. It should be removed from LRU.
  backend.deleteSession('sess_1');
  assert.equal(backend._sessionLru.has('sess_1'), false, 'sess_1 should be removed from LRU set on deletion');
});
