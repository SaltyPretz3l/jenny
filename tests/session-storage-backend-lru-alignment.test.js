const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStorageBackend } = require('../services/backend/session-storage-backend');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(() => cleanupTrackedResources());

function createBackend(t, root, writeDebounceMs = 0) {
  const backend = new SessionStorageBackend(root, {
    schemaVersion: 1,
    migratePayload: payload => payload,
    normalizeSession: (id, record) => ({ ...record, id }),
    summarizeSession: record => ({ id: record.id, title: record.title }),
    writeDebounceMs,
  });
  t.after(() => backend.dispose());
  return backend;
}

function createRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-lru-alignment-'));
  trackDirectory(root);
  return root;
}

function assertAligned(backend) {
  const owned = new Set([...backend._loadedSessions.keys(), ...backend._sessionStores.keys()]);
  assert.ok(backend._sessionLru.size <= owned.size, 'LRU must not retain unowned session IDs');
  assert.deepEqual(new Set(backend._sessionLru), owned);
}

test('LRU stays aligned through many writes, evictions and reopened sessions', t => {
  const backend = createBackend(t, createRoot());
  for (let index = 0; index < 120; index += 1) {
    assert.equal(backend.upsertSession(`sess_${index}`, { title: `Session ${index}` }), true);
    assertAligned(backend);
  }
  backend.flush();
  for (let index = 0; index < 120; index += 1) {
    assert.equal(backend.getSession(`sess_${index}`).title, `Session ${index}`);
    assertAligned(backend);
  }
  assert.ok(backend._loadedSessions.size <= 30);
  assert.ok(backend._sessionStores.size <= 30);
});

test('pending writes keep their session, store and LRU entry through a load burst', t => {
  const root = createRoot();
  const seed = createBackend(t, root);
  for (let index = 0; index < 80; index += 1) {
    seed.upsertSession(`sess_${index}`, { title: `Session ${index}` });
  }
  seed.dispose();
  const backend = createBackend(t, root, 60000);
  backend.upsertSession('sess_0', { title: 'Pending change' });
  const pendingStore = backend._sessionStores.get('sess_0');
  for (let index = 1; index < 80; index += 1) backend.getSession(`sess_${index}`);
  assert.equal(backend.hasPendingWriteForSession('sess_0'), true);
  assert.equal(backend._sessionStores.get('sess_0'), pendingStore);
  assert.equal(backend._loadedSessions.get('sess_0').title, 'Pending change');
  assert.equal(backend._sessionLru.has('sess_0'), true);
  assertAligned(backend);
});

test('active turns keep their session and store during cache pressure', t => {
  const backend = createBackend(t, createRoot());
  backend.upsertSession('sess_active', { title: 'Active', active_turn: { id: 'turn_1' } });
  backend.flush();
  const activeStore = backend._sessionStores.get('sess_active');
  for (let index = 0; index < 80; index += 1) {
    backend.upsertSession(`sess_${index}`, { title: `Session ${index}` });
  }
  assert.equal(backend._loadedSessions.has('sess_active'), true);
  assert.equal(backend._sessionStores.get('sess_active'), activeStore, 'active turn store must not be evicted');
  assertAligned(backend);
});
