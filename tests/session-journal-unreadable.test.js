'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { JournaledJsonStore } = require('../services/backend/journaled-json-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackCloseable,
} = require('./helpers/resource-cleanup');

const TIMESTAMP = '2026-07-14T10:00:00.000Z';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeProfile() {
  const dir = createTrackedTempDir('jenny-session-journal-unreadable-');
  return { dir, storePath: path.join(dir, 'sessions.json'), sessionsDir: path.join(dir, 'sessions') };
}

function open(profile) {
  const logs = [];
  const store = trackCloseable(new ElectronSessionStore(profile.storePath, {
    writeDebounceMs: 60_000,
    sessionJournal: true,
    logger: (level, event, details) => logs.push({ level, event, details }),
  }));
  store.logs = logs;
  return store;
}

function seedChat(store, id, { title = id, count = 1 } = {}) {
  assert.ok(store.createSessionWithId(id, { title }));
  for (let index = 0; index < count; index += 1) {
    assert.ok(store.appendMessage(id, {
      id: `${id}_m${index}`, role: 'user', content: `message ${index}`, timestamp: TIMESTAMP,
    }));
  }
  assert.equal(store.flushSession(id), true);
  return id;
}

function listedIds(store) {
  return store.listSessions().map((summary) => summary.id).sort();
}

function snapshot(dir) {
  const files = {};
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) files[name] = fs.readFileSync(file).toString('base64');
  }
  return files;
}

// Makes every read of a file whose name matches `pattern` fail as if another
// process held it without read sharing.
function lockFiles(t, pattern) {
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (typeof file === 'string' && pattern.test(path.basename(file))) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: 'EBUSY' });
    }
    return realRead(file, ...rest);
  });
}

test('a journal that cannot be read makes the read unreadable, not a base-only value', (t) => {
  const dir = createTrackedTempDir('jenny-jjs-unreadable-');
  const filePath = path.join(dir, 's1.json');
  const options = { payloadKey: 'session', compact: true, idleCompactMs: 0 };
  const writer = new JournaledJsonStore(filePath, options);
  writer.writeImmediate({ schema_version: 1, session: { id: 's1', messages: [{ id: 'a' }] } });
  writer.writeImmediate({ schema_version: 1, session: { id: 's1', messages: [{ id: 'a' }, { id: 'b' }] } });

  lockFiles(t, /\.journal$/);
  const locked = new JournaledJsonStore(filePath, options).readWithStatus('fallback');
  assert.equal(locked.unreadable, true);
  assert.equal(locked.corrupted, false);
  assert.equal(locked.journalStatus, 'unreadable');
  assert.equal(locked.value, 'fallback');
  assert.equal(locked.errorCode, 'EBUSY');
  // Compaction from disk must not turn the base alone into the new truth either.
  assert.equal(writer.compact(), false);
  t.mock.restoreAll();

  const read = new JournaledJsonStore(filePath, options).readWithStatus(null);
  assert.equal(read.journalStatus, 'ok');
  assert.equal(read.value.session.messages.length, 2);
  writer.dispose();
});

test('a chat whose journal is locked is not loaded, replaced or quarantined, and loads later', (t) => {
  const profile = makeProfile();
  const first = open(profile);
  const id = seedChat(first, 'chat_locked', { title: 'Locked', count: 3 });
  // The first save of a chat replaces its base; the next one is journaled.
  assert.ok(first.appendMessage(id, { id: 'journaled', role: 'user', content: 'journaled', timestamp: TIMESTAMP }));
  assert.equal(first.flushSession(id), true);
  const before = snapshot(profile.sessionsDir);
  assert.ok(Object.keys(before).some((name) => /^chat_locked\.\d+\.journal$/.test(name)), 'the chat has a journal');

  const second = open(profile);
  lockFiles(t, /^chat_locked\.\d+\.journal$/);
  assert.equal(second.getSession(id), null);
  assert.ok(second.logs.some((entry) => entry.event === 'session_store.session_file_unreadable'));
  t.mock.restoreAll();
  assert.deepEqual(snapshot(profile.sessionsDir), before, 'no file was written, moved or replaced');
  assert.equal(fs.existsSync(path.join(profile.sessionsDir, 'corrupt')), false);

  assert.equal(second.getSession(id).messages.length, 4, 'the next read retries the disk');
  assert.ok(second.appendMessage(id, { id: 'after', role: 'user', content: 'after', timestamp: TIMESTAMP }));
  assert.equal(second.flushSession(id), true);
  assert.equal(open(profile).getSession(id).messages.length, 5);
});

test('an index journal that is locked at startup hides no chat, then or later', (t) => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_a', { title: 'Alpha' });
  first.flush();
  seedChat(first, 'chat_b', { title: 'Bravo', count: 2 });

  lockFiles(t, /^_index\.\d+\.journal$/);
  const second = open(profile);
  assert.deepEqual(listedIds(second), ['chat_a', 'chat_b']);
  assert.equal(second.getSessionSummary('chat_b').title, 'Bravo');
  seedChat(second, 'chat_c', { title: 'Charlie' });
  second.dispose();
  t.mock.restoreAll();

  const third = open(profile);
  assert.deepEqual(listedIds(third), ['chat_a', 'chat_b', 'chat_c']);
  assert.equal(third.getSession('chat_b').messages.length, 2);
});

test('rebuilding a damaged index keeps the known summary of a chat whose file does not read', () => {
  const profile = makeProfile();
  const first = open(profile);
  seedChat(first, 'chat_old', { title: 'Old', count: 3 });
  first.dispose();

  const second = open(profile);
  for (let index = 0; index < 8; index += 1) seedChat(second, `chat_late_${index}`, { title: `Late ${index}` });
  const journal = fs.readdirSync(profile.sessionsDir).filter((name) => /^_index\.\d+\.journal$/.test(name)).sort().pop();
  const journalPath = path.join(profile.sessionsDir, journal);
  const bytes = fs.readFileSync(journalPath);
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  fs.writeFileSync(journalPath, bytes);
  fs.writeFileSync(path.join(profile.sessionsDir, 'chat_old.json'), '{ not json');

  const third = open(profile);
  assert.equal(listedIds(third).length, 9);
  const summary = third.getSessionSummary('chat_old');
  assert.equal(summary.title, 'Old');
  assert.equal(summary.message_count, 3, 'the count the attachment sweep relies on is not reset to 0');
});
