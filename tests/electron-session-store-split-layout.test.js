const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ElectronSessionStore,
  STORE_SCHEMA_VERSION,
} = require('../services/backend/electron-session-store');
const { FileJsonStore } = require('../services/backend/file-json-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createLogCollector() {
  const entries = [];
  return {
    entries,
    logger(level, event, details = {}) {
      entries.push({ level, event, details });
    },
  };
}

function sessionsDir(userDataPath) {
  return path.join(userDataPath, 'sessions');
}

function indexFilePath(userDataPath) {
  return path.join(sessionsDir(userDataPath), '_index.json');
}

function sessionFilePath(userDataPath, sessionId) {
  return path.join(sessionsDir(userDataPath), `${sessionId}.json`);
}

function readIndexOnDisk(userDataPath) {
  return JSON.parse(fs.readFileSync(indexFilePath(userDataPath), 'utf8'));
}

function readSessionOnDisk(userDataPath, sessionId) {
  return JSON.parse(fs.readFileSync(sessionFilePath(userDataPath, sessionId), 'utf8'));
}

function findMigratedBackup(userDataPath) {
  return fs.readdirSync(userDataPath).find((entry) =>
    entry.startsWith('sessions.json.migrated-')
  );
}
// --- Per-session split behavior (Fix C) -------------------------------------

test('mutating one session does not rewrite other sessions on disk', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-isolation-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  const store = new ElectronSessionStore(storePath);
  const sessionA = store.createSession({ title: 'Session A' });
  const sessionB = store.createSession({ title: 'Session B' });

  // Stale these mtimes so the next write becomes detectable.
  const aPath = sessionFilePath(userDataPath, sessionA.id);
  const bPath = sessionFilePath(userDataPath, sessionB.id);
  const stalePast = new Date('2024-01-01T00:00:00.000Z');
  fs.utimesSync(aPath, stalePast, stalePast);
  fs.utimesSync(bPath, stalePast, stalePast);
  const baselineA = fs.statSync(aPath).mtimeMs;
  const baselineB = fs.statSync(bPath).mtimeMs;

  store.appendMessage(sessionA.id, {
    id: 'user_isolate',
    role: 'user',
    content: 'only for A',
  });

  // A's file is rewritten; B's file is not.
  assert.notEqual(fs.statSync(aPath).mtimeMs, baselineA);
  assert.equal(fs.statSync(bPath).mtimeMs, baselineB);
});

test('sessions lazy-load from disk on first access without eager bulk read', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-lazy-load-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  // Bootstrap two sessions, then close and reopen the store: the second
  // instance must serve list queries from the index without touching any
  // per-session file until the caller asks for one explicitly.
  const seed = new ElectronSessionStore(storePath);
  const sessionA = seed.createSession({ title: 'Session A' });
  const sessionB = seed.createSession({ title: 'Session B' });
  seed.appendMessage(sessionA.id, {
    id: 'user_lazy_a',
    role: 'user',
    content: 'message in A',
  });
  seed.appendMessage(sessionB.id, {
    id: 'user_lazy_b',
    role: 'user',
    content: 'message in B',
  });
  seed.dispose();

  const reopened = new ElectronSessionStore(storePath);
  // Construction must not load any per-session payload; startup latency on
  // long histories was a goal of the split.
  assert.equal(reopened._backend._loadedSessions.has(sessionA.id), false);
  assert.equal(reopened._backend._loadedSessions.has(sessionB.id), false);
  assert.equal(reopened._backend._sessionStores.size, 0);

  // listSessions returns index summaries only, no on-disk reads.
  reopened.listSessions();
  assert.equal(reopened._backend._loadedSessions.has(sessionA.id), false);
  assert.equal(reopened._backend._loadedSessions.has(sessionB.id), false);
  assert.equal(reopened._backend._sessionStores.size, 0);

  // Asking for A's content pulls only A from disk, not B.
  const messagesA = reopened.getSessionMessages(sessionA.id);
  assert.equal(messagesA.length, 1);
  assert.equal(reopened._backend._loadedSessions.has(sessionA.id), true);
  assert.equal(reopened._backend._loadedSessions.has(sessionB.id), false);
  assert.equal(reopened._backend._sessionStores.has(sessionA.id), false);
});

test('monolithic v9 sessions.json migrates atomically and keeps a timestamped backup', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-split-migrate-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const monolithicPayload = {
    schema_version: 9,
    sessions: {
      sess_split_a: {
        id: 'sess_split_a',
        title: 'Split A',
        created_at: '2026-05-10T10:00:00.000Z',
        updated_at: '2026-05-10T10:00:00.000Z',
        messages: [
          { id: 'msg_a', role: 'user', content: 'Hello from A' },
        ],
      },
      sess_split_b: {
        id: 'sess_split_b',
        title: 'Split B',
        created_at: '2026-05-10T11:00:00.000Z',
        updated_at: '2026-05-10T11:00:00.000Z',
        messages: [
          { id: 'msg_b', role: 'user', content: 'Hello from B' },
        ],
      },
    },
  };
  fs.writeFileSync(storePath, JSON.stringify(monolithicPayload, null, 2));

  const logs = createLogCollector();
  const store = new ElectronSessionStore(storePath, { logger: logs.logger });

  // After construction:
  //   - sessions.json has been renamed to sessions.json.migrated-<ts>
  //   - sessions/_index.json carries the current schema_version
  //   - sessions/<id>.json files exist for every migrated session
  //   - the store can read sessions by id from the split layout
  assert.equal(fs.existsSync(storePath), false);
  const backupName = findMigratedBackup(userDataPath);
  assert.ok(backupName);
  assert.match(backupName, /sessions\.json\.migrated-\d+/);

  const indexPayload = readIndexOnDisk(userDataPath);
  assert.equal(indexPayload.schema_version, STORE_SCHEMA_VERSION);
  assert.deepEqual(
    Object.keys(indexPayload.sessions).sort(),
    ['sess_split_a', 'sess_split_b']
  );

  const sessionA = readSessionOnDisk(userDataPath, 'sess_split_a');
  assert.equal(sessionA.schema_version, STORE_SCHEMA_VERSION);
  assert.equal(sessionA.session.title, 'Split A');
  assert.equal(sessionA.session.messages[0].content, 'Hello from A');

  // The store responds to public reads using the split layout, not the backup.
  assert.deepEqual(
    store.listSessions().map((session) => session.id).sort(),
    ['sess_split_a', 'sess_split_b']
  );
  assert.equal(store.getSessionMessages('sess_split_b')[0].content, 'Hello from B');

  // A migration log entry should be emitted so operators can spot when the
  // legacy file was rolled forward.
  const migrationLog = logs.entries.find(
    (entry) => entry.event === 'session_store.split_migration_completed'
  );
  assert.ok(migrationLog);
  assert.equal(migrationLog.level, 'INFO');
  assert.equal(migrationLog.details.sessionCount, 2);
});

test('migrating an existing split layout is a no-op when no monolithic file is present', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-split-idempotent-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  const firstBoot = new ElectronSessionStore(storePath);
  const created = firstBoot.createSession({ title: 'Persistent' });
  firstBoot.appendMessage(created.id, {
    id: 'first_boot_msg',
    role: 'user',
    content: 'persist me',
  });
  firstBoot.dispose();

  const indexMtime = fs.statSync(indexFilePath(userDataPath)).mtimeMs;
  const sessionMtime = fs.statSync(sessionFilePath(userDataPath, created.id)).mtimeMs;

  // Reopening should NOT re-run migration or rewrite any file.
  const logs = createLogCollector();
  const secondBoot = new ElectronSessionStore(storePath, { logger: logs.logger });

  assert.equal(fs.statSync(indexFilePath(userDataPath)).mtimeMs, indexMtime);
  assert.equal(
    fs.statSync(sessionFilePath(userDataPath, created.id)).mtimeMs,
    sessionMtime
  );
  assert.equal(
    logs.entries.some((entry) => entry.event === 'session_store.split_migration_completed'),
    false
  );
  assert.equal(secondBoot.getSession(created.id).title, 'Persistent');
});

test('old split schema migration is queued on construction and completes asynchronously', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-split-schema-async-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const firstBoot = new ElectronSessionStore(storePath);
  const created = firstBoot.createSession({ title: 'Split Schema Async' });
  firstBoot.appendMessage(created.id, {
    id: 'legacy_async_msg',
    role: 'assistant',
    content: 'legacy async marker',
    messageReactions: {
      saved: {
        selected: true,
        updated_at: '2026-05-12T18:00:00.000Z',
      },
    },
  });
  firstBoot.flush();
  firstBoot.dispose();

  const oldIndex = readIndexOnDisk(userDataPath);
  oldIndex.schema_version = 11;
  fs.writeFileSync(indexFilePath(userDataPath), JSON.stringify(oldIndex, null, 2), 'utf8');
  const oldSession = readSessionOnDisk(userDataPath, created.id);
  oldSession.schema_version = 11;
  fs.writeFileSync(sessionFilePath(userDataPath, created.id), JSON.stringify(oldSession, null, 2), 'utf8');

  const logs = createLogCollector();
  const store = new ElectronSessionStore(storePath, { logger: logs.logger });

  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(readIndexOnDisk(userDataPath).schema_version, 11);
  assert.equal(
    logs.entries.some((entry) => entry.event === 'session_store.split_schema_migration_completed'),
    false
  );

  const result = await store.runPendingMigrations({ batchSize: 1 });

  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);
  assert.equal(readIndexOnDisk(userDataPath).schema_version, STORE_SCHEMA_VERSION);
  assert.equal(readSessionOnDisk(userDataPath, created.id).schema_version, STORE_SCHEMA_VERSION);
  assert.equal(store.getSession(created.id).messages[0].message_reactions.saved.selected, true);
  assert.ok(logs.entries.some((entry) => entry.event === 'session_store.split_schema_migration_queued'));
  const completed = logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed');
  assert.ok(completed);
  assert.equal(completed.level, 'INFO');
  assert.equal(completed.details.success, true);
});

test('old split schema migration preserves live writes made while queued', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-split-schema-live-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const firstBoot = new ElectronSessionStore(storePath);
  const created = firstBoot.createSession({ title: 'Queued Existing' });
  firstBoot.appendMessage(created.id, {
    id: 'legacy_live_msg',
    role: 'assistant',
    content: 'legacy live marker',
  });
  firstBoot.flush();
  firstBoot.dispose();

  const oldIndex = readIndexOnDisk(userDataPath);
  oldIndex.schema_version = 11;
  fs.writeFileSync(indexFilePath(userDataPath), JSON.stringify(oldIndex, null, 2), 'utf8');
  const oldSession = readSessionOnDisk(userDataPath, created.id);
  oldSession.schema_version = 11;
  fs.writeFileSync(sessionFilePath(userDataPath, created.id), JSON.stringify(oldSession, null, 2), 'utf8');

  const store = new ElectronSessionStore(storePath);

  assert.equal(store.hasPendingMigrations(), true);
  store.appendMessage(created.id, {
    id: 'live_queued_msg',
    role: 'user',
    content: 'live write while migration queued',
  });
  const newSession = store.createSession({ title: 'Created While Queued' });
  store.appendMessage(newSession.id, {
    id: 'live_new_msg',
    role: 'assistant',
    content: 'new session while migration queued',
  });
  store.flush();

  assert.equal(readIndexOnDisk(userDataPath).schema_version, 11);

  const result = await store.runPendingMigrations({ batchSize: 1 });

  assert.equal(result.success, true);
  assert.equal(store.hasPendingMigrations(), false);
  const migratedIndex = readIndexOnDisk(userDataPath);
  assert.equal(migratedIndex.schema_version, STORE_SCHEMA_VERSION);
  assert.deepEqual(
    Object.keys(migratedIndex.sessions).sort(),
    [created.id, newSession.id].sort()
  );
  assert.deepEqual(
    store.getSessionMessages(created.id).map((message) => message.id),
    ['legacy_live_msg', 'live_queued_msg']
  );
  assert.equal(
    store.getSessionMessages(newSession.id)[0].content,
    'new session while migration queued'
  );
  assert.deepEqual(
    readSessionOnDisk(userDataPath, created.id).session.messages.map((message) => message.id),
    ['legacy_live_msg', 'live_queued_msg']
  );
});

test('failed split schema migration keeps the old index on disk', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-split-schema-fail-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const firstBoot = new ElectronSessionStore(storePath);
  const created = firstBoot.createSession({ title: 'Split Schema Failure' });
  firstBoot.appendMessage(created.id, {
    id: 'legacy_reaction_msg',
    role: 'assistant',
    content: 'legacy marker',
    messageReactions: {
      saved: {
        selected: true,
        updated_at: '2026-05-12T18:00:00.000Z',
      },
    },
  });
  firstBoot.flush();
  firstBoot.dispose();

  const oldIndex = readIndexOnDisk(userDataPath);
  oldIndex.schema_version = 11;
  fs.writeFileSync(indexFilePath(userDataPath), JSON.stringify(oldIndex, null, 2), 'utf8');
  const oldSession = readSessionOnDisk(userDataPath, created.id);
  oldSession.schema_version = 11;
  fs.writeFileSync(sessionFilePath(userDataPath, created.id), JSON.stringify(oldSession, null, 2), 'utf8');

  const logs = createLogCollector();
  // The split migration writes each session through FileJsonStore.writeImmediate,
  // which is synchronous (fs.writeFileSync inside _writeNow) so that no mutation
  // can interleave with it. The failure therefore has to be injected at the sync
  // primitive; patching fs.promises.writeFile here would no longer be reached and
  // the migration would silently succeed, making this test vacuous.
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function patchedWriteFileSync(filePath, value, encoding) {
    if (String(filePath || '').startsWith(`${sessionFilePath(userDataPath, created.id)}.`)) {
      const error = new Error('disk full');
      error.code = 'ENOSPC';
      throw error;
    }
    return originalWriteFileSync.call(this, filePath, value, encoding);
  };

  let store;
  try {
    store = new ElectronSessionStore(storePath, { logger: logs.logger });
    assert.equal(store.hasPendingMigrations(), true);
    assert.equal(store.getSession(created.id).title, 'Split Schema Failure');
    await store.runPendingMigrations({ batchSize: 1 });
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(store.hasPendingMigrations(), true);
  assert.equal(readIndexOnDisk(userDataPath).schema_version, 11);
  assert.equal(readSessionOnDisk(userDataPath, created.id).schema_version, 11);
  assert.ok(logs.entries.some((entry) => entry.event === 'session_store.split_schema_migration_failed'));
  const completed = logs.entries.find((entry) => entry.event === 'session_store.split_schema_migration_completed');
  assert.ok(completed);
  assert.equal(completed.level, 'WARN');
  assert.equal(completed.details.success, false);
});

test('split layout rebuilds a missing index from per-session files', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-index-recover-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const firstBoot = new ElectronSessionStore(storePath);
  const created = firstBoot.createSession({ title: 'Recoverable' });
  firstBoot.appendMessage(created.id, {
    id: 'recover_msg',
    role: 'user',
    content: 'still here',
  });
  firstBoot.flush();
  fs.unlinkSync(indexFilePath(userDataPath));

  const logs = createLogCollector();
  const recovered = new ElectronSessionStore(storePath, { logger: logs.logger });

  assert.equal(recovered.getSession(created.id).title, 'Recoverable');
  assert.equal(recovered.getSessionMessages(created.id)[0].content, 'still here');
  assert.equal(readIndexOnDisk(userDataPath).sessions[created.id].title, 'Recoverable');
  assert.equal(
    logs.entries.some((entry) => entry.event === 'session_store.split_index_recovered'),
    true
  );
});

test('split layout rebuilds an unreadable index from per-session files', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-index-corrupt-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const firstBoot = new ElectronSessionStore(storePath);
  const created = firstBoot.createSession({ title: 'Corrupt Index Recovery' });
  firstBoot.flush();
  fs.writeFileSync(indexFilePath(userDataPath), '{not valid json', 'utf8');

  const recovered = new ElectronSessionStore(storePath);

  assert.equal(recovered.getSession(created.id).title, 'Corrupt Index Recovery');
  assert.equal(readIndexOnDisk(userDataPath).sessions[created.id].title, 'Corrupt Index Recovery');
});

test('failed monolithic migration removes partial split files', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-migrate-cleanup-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 9,
    sessions: {
      sess_partial_a: {
        id: 'sess_partial_a',
        title: 'Partial A',
        messages: [{ id: 'a_msg', role: 'user', content: 'A' }],
      },
      sess_partial_b: {
        id: 'sess_partial_b',
        title: 'Partial B',
        messages: [{ id: 'b_msg', role: 'user', content: 'B' }],
      },
    },
  }, null, 2));
  const logs = createLogCollector();
  const originalWriteImmediate = FileJsonStore.prototype.writeImmediate;
  let sessionWriteCount = 0;
  FileJsonStore.prototype.writeImmediate = function patchedWriteImmediate(value) {
    if (
      String(this.filePath || '').includes(`${path.sep}sessions${path.sep}`)
      && !String(this.filePath || '').endsWith(`${path.sep}_index.json`)
    ) {
      sessionWriteCount += 1;
      if (sessionWriteCount === 2) {
        const error = new Error('disk full');
        error.code = 'ENOSPC';
        throw error;
      }
    }
    return originalWriteImmediate.call(this, value);
  };

  try {
    const store = new ElectronSessionStore(storePath, { logger: logs.logger });
    assert.equal(store.getSession('sess_partial_a').title, 'Partial A');
    assert.equal(store.getSession('sess_partial_b').title, 'Partial B');
  } finally {
    FileJsonStore.prototype.writeImmediate = originalWriteImmediate;
  }

  const remainingSplitFiles = fs.existsSync(sessionsDir(userDataPath))
    ? fs.readdirSync(sessionsDir(userDataPath)).filter((entry) => entry.endsWith('.json'))
    : [];
  assert.deepEqual(remainingSplitFiles, []);
  assert.equal(fs.existsSync(storePath), true);
  assert.equal(
    logs.entries.some((entry) => entry.event === 'session_store.migration_write_failed'),
    true
  );
});

test('flush() drains pending writes across every per-session FileJsonStore plus the index', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-flush-many-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  const store = new ElectronSessionStore(storePath, { writeDebounceMs: 10_000 });
  const sessionA = store.createSession({ title: 'Flush A' });
  const sessionB = store.createSession({ title: 'Flush B' });
  store.appendMessage(sessionA.id, { id: 'a_user', role: 'user', content: 'a' });
  store.appendMessage(sessionB.id, { id: 'b_user', role: 'user', content: 'b' });

  // With the long debounce window every per-session file plus the index has a
  // pending write that has not hit disk yet.
  assert.equal(store._backend._sessionStores.get(sessionA.id).hasPendingWrite(), true);
  assert.equal(store._backend._sessionStores.get(sessionB.id).hasPendingWrite(), true);
  assert.equal(store._backend._indexStore.hasPendingWrite(), true);

  const flushed = store.flush();
  assert.equal(flushed, true);
  assert.equal(store._backend._sessionStores.get(sessionA.id).hasPendingWrite(), false);
  assert.equal(store._backend._sessionStores.get(sessionB.id).hasPendingWrite(), false);
  assert.equal(store._backend._indexStore.hasPendingWrite(), false);

  // After flush the per-session messages are visible on disk.
  assert.equal(readSessionOnDisk(userDataPath, sessionA.id).session.messages[0].content, 'a');
  assert.equal(readSessionOnDisk(userDataPath, sessionB.id).session.messages[0].content, 'b');
});

test('flushAsync() drains pending writes across every per-session FileJsonStore plus the index', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-flush-async-many-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  const store = new ElectronSessionStore(storePath, { writeDebounceMs: 10_000 });
  const sessionA = store.createSession({ title: 'Flush Async A' });
  const sessionB = store.createSession({ title: 'Flush Async B' });
  store.appendMessage(sessionA.id, { id: 'a_user_async', role: 'user', content: 'a async' });
  store.appendMessage(sessionB.id, { id: 'b_user_async', role: 'user', content: 'b async' });

  assert.equal(store._backend._sessionStores.get(sessionA.id).hasPendingWrite(), true);
  assert.equal(store._backend._sessionStores.get(sessionB.id).hasPendingWrite(), true);
  assert.equal(store._backend._indexStore.hasPendingWrite(), true);

  const flushed = await store.flushAsync();
  assert.equal(flushed, true);
  assert.equal(store._backend._sessionStores.get(sessionA.id).hasPendingWrite(), false);
  assert.equal(store._backend._sessionStores.get(sessionB.id).hasPendingWrite(), false);
  assert.equal(store._backend._indexStore.hasPendingWrite(), false);
  assert.equal(readSessionOnDisk(userDataPath, sessionA.id).session.messages[0].content, 'a async');
  assert.equal(readSessionOnDisk(userDataPath, sessionB.id).session.messages[0].content, 'b async');
});

test('deleting a session removes its file and prunes the index without touching others', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-delete-file-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');

  const store = new ElectronSessionStore(storePath);
  const sessionA = store.createSession({ title: 'Keep' });
  const sessionB = store.createSession({ title: 'Delete' });
  const aPath = sessionFilePath(userDataPath, sessionA.id);
  const bPath = sessionFilePath(userDataPath, sessionB.id);
  assert.equal(fs.existsSync(aPath), true);
  assert.equal(fs.existsSync(bPath), true);

  assert.equal(store.deleteSession(sessionB.id), true);

  assert.equal(fs.existsSync(aPath), true);
  assert.equal(fs.existsSync(bPath), false);
  const indexAfterDelete = readIndexOnDisk(userDataPath);
  assert.deepEqual(Object.keys(indexAfterDelete.sessions), [sessionA.id]);
});
