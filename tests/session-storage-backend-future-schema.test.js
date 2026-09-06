'use strict';

// Per-session-file future-schema guard (Fix 3): a session file whose envelope
// declares a schema_version NEWER than the store understands must never be
// loaded, recovered, or migrated into the current-schema world (normalizeSession
// is a strict whitelist, so doing so would strip its unknown fields and
// downgrade it on the next rewrite). All three read sites freeze the store.
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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-ssb-future-${label}-`));
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

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

// --- Read path: current index, but a per-session file from a newer app. -----
test('a future-schema session file freezes the store and is not loaded (read path)', () => {
  const rootDir = makeTempRoot('read');
  writeJson(path.join(rootDir, '_index.json'), {
    schema_version: 2,
    sessions: { sess_future: { id: 'sess_future', title: 'Future' } },
  });
  writeJson(path.join(rootDir, 'sess_future.json'), {
    schema_version: 9,
    session: { id: 'sess_future', title: 'Future', messages: [{ role: 'user', content: 'newer' }] },
  });
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'fs_store' });

  // The index is current-schema, so construction does not freeze the store.
  assert.equal(backend.hasNewerSchema(), false, 'a current index does not freeze on its own');

  // Reading the session detects the future per-file schema: freeze + return null.
  assert.equal(backend.getSession('sess_future'), null, 'a future-schema session file must not be loaded');
  assert.equal(backend.hasNewerSchema(), true, 'the future session file freezes the store');

  // Writes are blocked after the freeze.
  assert.equal(backend.upsertSession('sess_new', { title: 'Blocked' }), false, 'writes are blocked after the freeze');

  const detected = logger.find('fs_store.newer_schema_detected');
  assert.equal(detected.length, 1, 'one newer_schema_detected diagnostic for the future file');
  assert.equal(detected[0].data.observedVersion, 9);
  assert.equal(detected[0].data.filePath, path.join(rootDir, 'sess_future.json'), 'keyed by the session file path');

  // The future file on disk is never rewritten/downgraded.
  const onDisk = JSON.parse(fs.readFileSync(path.join(rootDir, 'sess_future.json'), 'utf8'));
  assert.equal(onDisk.schema_version, 9, 'the future file is not rewritten');
});

// --- Recovery path: no index, a future-schema file present. -----------------
test('a future-schema session file with no index freezes recovery and rebuilds no index', () => {
  const rootDir = makeTempRoot('recover');
  writeJson(path.join(rootDir, 'sess_future.json'), {
    schema_version: 9,
    session: { id: 'sess_future', title: 'Future', messages: [] },
  });
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'rec_store' });

  assert.equal(backend.hasNewerSchema(), true, 'recovery over a future-schema file freezes the store');
  assert.deepEqual(backend.getSessionIds(), [], 'no current-schema index is rebuilt over newer data');
  assert.equal(backend.upsertSession('x', { title: 'Blocked' }), false, 'writes are blocked');
  assert.deepEqual(
    logger.find('rec_store.newer_schema_detected').map((entry) => entry.data.observedVersion),
    [9],
    'the per-file diagnostic surfaces the observed version'
  );
  assert.equal(
    fs.existsSync(path.join(rootDir, '_index.json')),
    false,
    'recovery must not write a current-schema index over newer data'
  );
});

// --- Migration path: older index queues a downgrade migration, but a per-file
//     schema is newer than the store. -----------------------------------------
test('a future-schema session file aborts a downgrade migration instead of migrating it', async () => {
  const rootDir = makeTempRoot('migrate');
  // An OLDER index (schema_version 1 < 2) queues a split-layout migration...
  writeJson(path.join(rootDir, '_index.json'), {
    schema_version: 1,
    sessions: { sess_future: { id: 'sess_future', title: 'Future' } },
  });
  // ...but the per-session file is NEWER (schema_version 9).
  writeJson(path.join(rootDir, 'sess_future.json'), {
    schema_version: 9,
    session: { id: 'sess_future', title: 'Future', messages: [] },
  });
  const logger = makeRecordingLogger();
  const backend = makeBackend(rootDir, { logger, storeName: 'mig_store' });

  assert.equal(backend.hasPendingMigrations(), true, 'an older index queues a migration');
  const result = await backend.runPendingMigrations();
  assert.equal(result.success, false, 'the migration aborts when a future-schema file is present');
  assert.equal(backend.hasNewerSchema(), true, 'the store is frozen after the abort');
  assert.equal(backend.hasPendingMigrations(), false, 'the aborted migration is cleared, not retried');
  assert.ok(logger.find('mig_store.newer_schema_detected').length >= 1, 'the per-file diagnostic is emitted');

  const onDisk = JSON.parse(fs.readFileSync(path.join(rootDir, 'sess_future.json'), 'utf8'));
  assert.equal(onDisk.schema_version, 9, 'the future file is not migrated/downgraded');
});

// --- Flush after a freeze: a session dirtied BEFORE the freeze must not be
//     written (nor the index) into a directory a newer app owns. The freeze is
//     consistent -- flush()/flushAsync() short-circuit like upsert/flushSession,
//     not just monolithic_readonly. -------------------------------------------
test('flush and flushAsync write nothing once a per-session future-schema read freezes the store', async () => {
  const rootDir = makeTempRoot('flush-after-freeze');
  writeJson(path.join(rootDir, '_index.json'), {
    schema_version: 2,
    sessions: { sess_future: { id: 'sess_future', title: 'Future' } },
  });
  writeJson(path.join(rootDir, 'sess_future.json'), {
    schema_version: 9,
    session: { id: 'sess_future', title: 'Future', messages: [] },
  });
  const backend = makeBackend(rootDir, { storeName: 'freeze_flush_store' });

  // Dirty a current-schema session BEFORE the freeze (a normal cache-only touch).
  backend.upsertSession('sess_dirty', { title: 'Dirty' }, { persist: false });
  assert.equal(backend.hasPendingWriteForSession('sess_dirty'), true, 'precondition: the write is pending');

  // Reading the future-schema file freezes the store.
  assert.equal(backend.getSession('sess_future'), null, 'the future file is not loaded');
  assert.equal(backend.hasNewerSchema(), true, 'the read froze the store');

  // Neither flush variant may touch disk while frozen.
  assert.equal(backend.flush(), false, 'flush() short-circuits on the freeze');
  assert.equal(await backend.flushAsync(), false, 'flushAsync() short-circuits on the freeze');
  assert.equal(
    fs.existsSync(path.join(rootDir, 'sess_dirty.json')),
    false,
    'the pre-freeze dirty session is never written into a newer app\'s store'
  );
  const idxOnDisk = JSON.parse(fs.readFileSync(path.join(rootDir, '_index.json'), 'utf8'));
  assert.equal(idxOnDisk.schema_version, 2, 'the on-disk index is left untouched (no current-schema rewrite)');
  assert.equal('sess_dirty' in (idxOnDisk.sessions || {}), false, 'the frozen index is not rewritten with the new session');
});
