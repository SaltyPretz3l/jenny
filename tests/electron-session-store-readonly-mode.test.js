const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { FileJsonStore } = require('../services/backend/file-json-store');
const { createRegistry, reserve } = require('./helpers/session-turn-actor-harness');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

// A failed monolithic -> split migration leaves the store in monolithic_readonly:
// sessions.json stays the source of truth and the next start retries the
// migration from it. Nothing under sessions/ may be written meanwhile, or the
// profile collects stale and orphaned per-session files beside the legacy file.

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function snapshotTree(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        files[`${rel}/`] = 'dir';
        walk(full);
      } else {
        files[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(root);
  return files;
}

function legacySession(id, title) {
  return {
    id,
    title,
    created_at: '2026-03-19T10:00:00.000Z',
    updated_at: '2026-03-19T10:00:00.000Z',
    messages: [{ id: `${id}_m1`, role: 'user', content: `hello from ${title}` }],
  };
}

// Every immediate write fails while the store is constructed, so the migration
// aborts after its first session file and falls back to the read-only cache.
function openStoreAfterFailedMigration(userDataPath, logs) {
  const original = FileJsonStore.prototype.writeImmediate;
  FileJsonStore.prototype.writeImmediate = function failingWriteImmediate() {
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  };
  try {
    return new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), {
      logger: (level, event, details) => logs.push({ level, event, details }),
    });
  } finally {
    FileJsonStore.prototype.writeImmediate = original;
  }
}

function makeLegacyProfile() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-readonly-mode-'));
  trackDirectory(userDataPath);
  fs.writeFileSync(path.join(userDataPath, 'sessions.json'), JSON.stringify({
    schema_version: 2,
    sessions: {
      sess_a: legacySession('sess_a', 'Alpha'),
      sess_b: legacySession('sess_b', 'Bravo'),
      sess_c: legacySession('sess_c', 'Charlie'),
    },
  }));
  return userDataPath;
}

function readonlyWarnings(logs) {
  return logs.filter((entry) => entry.event === 'session_store.readonly_mode_write_skipped');
}

test('failed migration: mutations stay in memory and nothing reaches disk', () => {
  const userDataPath = makeLegacyProfile();
  const logs = [];
  const store = openStoreAfterFailedMigration(userDataPath, logs);
  assert.equal(store._backend._mode, 'monolithic_readonly');
  assert.equal(store.hasNewerSchema(), false);
  assert.ok(logs.some((entry) => entry.event === 'session_store.migration_write_failed'));
  const before = snapshotTree(userDataPath);
  assert.deepEqual(Object.keys(before), ['sessions.json'], 'failed migration cleaned up after itself');

  assert.ok(store.appendMessage('sess_a', { id: 'm_new', role: 'user', content: 'new' }));
  assert.equal(store.flushSession('sess_a'), false, 'no durability is claimed');
  assert.ok(store.renameSession('sess_b', 'Bravo renamed'));
  const created = store.createSession({ title: 'Fresh' });
  assert.ok(created?.id);
  assert.equal(store.deleteSession('sess_c'), true);
  assert.deepEqual(store.purgeSessionRecoveryCopies('sess_c'), { removed: 0, failed: 0 });
  const commit = store.conversationStore.appendMessage('sess_a',
    { id: 'm_durable', role: 'user', content: 'durable?' }, { durable: true });
  assert.equal(commit.ok, false);
  assert.equal(commit.applied, true);
  assert.equal(commit.durable, false);
  assert.equal(commit.reason, 'durability_failed');
  assert.throws(
    () => reserve(createRegistry(), store, 'sess_b'),
    (error) => error.code === 'active_turn_recovery_failed'
      && error.reason === 'active_turn_claim_flush_refused'
  );
  assert.equal(store.flush(), false);

  // The session keeps working in memory, truthfully undurable.
  assert.deepEqual(store.listSessions().map((s) => s.title).sort(), ['Alpha', 'Bravo renamed', 'Fresh']);
  assert.deepEqual(store.getSessionMessages('sess_a').map((m) => m.id), ['sess_a_m1', 'm_new', 'm_durable']);
  const durability = store._backend.getSessionDurability('sess_a');
  assert.ok(durability.dirtyEpoch > durability.durableEpoch);
  assert.equal(store.hasPendingWrites(), true);
  store.dispose();

  assert.deepEqual(snapshotTree(userDataPath), before, 'no file created, modified or removed');
  const warnings = readonlyWarnings(logs);
  assert.equal(warnings.length, 1, 'one WARN per process, not per mutation');
  assert.equal(warnings[0].level, 'WARN');
  assert.deepEqual(warnings[0].details, { method: 'upsertSession', changesSaved: false });

  // A second read-only store in the same process does not warn again.
  const laterLogs = [];
  const later = openStoreAfterFailedMigration(makeLegacyProfile(), laterLogs);
  assert.ok(later.renameSession('sess_a', 'again'));
  later.dispose();
  assert.equal(readonlyWarnings(laterLogs).length, 0);
});

test('next start retries the migration from the untouched legacy file', () => {
  const userDataPath = makeLegacyProfile();
  const store = openStoreAfterFailedMigration(userDataPath, []);
  store.appendMessage('sess_a', { id: 'm_new', role: 'user', content: 'new' });
  store.createSession({ title: 'Fresh' });
  store.deleteSession('sess_c');
  store.dispose();

  const reopened = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  try {
    assert.equal(reopened._backend._mode, 'split');
    assert.deepEqual(reopened.listSessions().map((s) => s.title).sort(), ['Alpha', 'Bravo', 'Charlie']);
    const sessionFiles = fs.readdirSync(path.join(userDataPath, 'sessions')).sort();
    assert.deepEqual(sessionFiles, ['_index.json', 'sess_a.json', 'sess_b.json', 'sess_c.json'],
      'no orphaned per-session file from the read-only run');
    assert.equal(fs.existsSync(path.join(userDataPath, 'sessions.json')), false);
  } finally {
    reopened.dispose();
  }
});
