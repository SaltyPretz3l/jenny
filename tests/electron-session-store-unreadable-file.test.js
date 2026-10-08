const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

// A chat file that is briefly locked (antivirus, backup, a second reader) may
// be perfectly healthy. Only bytes that were read and do not parse are moved to
// sessions/corrupt/ and replaced with an empty stub.

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

function sessionFilePath(userDataPath, sessionId) {
  return path.join(sessionsDir(userDataPath), `${sessionId}.json`);
}

function quarantined(userDataPath) {
  const dir = path.join(sessionsDir(userDataPath), 'corrupt');
  // A quarantined chat's journals move with it; these tests pin the chat file itself.
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : [];
}

function seedChats(titles) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-unreadable-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const seed = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const ids = titles.map((title) => {
    const { id } = seed.createSession({ title });
    seed.appendMessage(id, { id: `${id}_m1`, role: 'user', content: `${title} first` });
    seed.appendMessage(id, { id: `${id}_m2`, role: 'assistant', content: `${title} second` });
    return id;
  });
  seed.flush();
  seed.dispose();
  return { userDataPath, storePath, ids };
}

function lockFile(t, filePath) {
  const realRead = fs.readFileSync;
  const mocked = t.mock.method(fs, 'readFileSync', (target, ...rest) => {
    if (String(target) === filePath) {
      throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
    }
    return realRead(target, ...rest);
  });
  return () => mocked.mock.restore();
}

test('a persistently locked chat file is left untouched and loads once the lock clears', (t) => {
  const { userDataPath, storePath, ids: [sessionId] } = seedChats(['Locked chat']);
  const filePath = sessionFilePath(userDataPath, sessionId);
  const before = fs.readFileSync(filePath);
  const logs = createLogCollector();
  const store = new ElectronSessionStore(storePath, { logger: logs.logger, writeDebounceMs: 0 });
  t.after(() => store.dispose());
  const unlock = lockFile(t, filePath);

  assert.equal(store.getSession(sessionId), null);
  assert.equal(store.getSession(sessionId), null, 'each read tries the disk again');
  unlock();

  assert.deepEqual(fs.readFileSync(filePath), before, 'the chat file is byte-identical');
  assert.deepEqual(quarantined(userDataPath), []);
  assert.equal(logs.entries.some((entry) => entry.event === 'session_store.session_file_quarantined'), false);
  const warnings = logs.entries.filter((entry) => entry.event === 'session_store.session_file_unreadable');
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].level, 'WARN');
  assert.deepEqual(warnings[0].details, { sessionId, filePath, errorCode: 'EBUSY' });
  assert.equal(store.listSessions().find((entry) => entry.id === sessionId)?.title, 'Locked chat');

  const loaded = store.getSession(sessionId);
  assert.equal(loaded.title, 'Locked chat');
  assert.deepEqual(loaded.messages.map((message) => message.content), ['Locked chat first', 'Locked chat second']);
});

test('a chat file whose bytes do not parse is still quarantined and re-seeded', () => {
  const { userDataPath, storePath, ids: [sessionId] } = seedChats(['Garbage chat']);
  fs.writeFileSync(sessionFilePath(userDataPath, sessionId), '{definitely not json', 'utf8');
  const logs = createLogCollector();
  const store = new ElectronSessionStore(storePath, { logger: logs.logger, writeDebounceMs: 0 });

  const recovered = store.getSession(sessionId);
  store.dispose();
  assert.equal(recovered.title, 'Garbage chat');
  assert.deepEqual(recovered.messages, []);
  const moved = quarantined(userDataPath);
  assert.equal(moved.length, 1);
  assert.equal(
    fs.readFileSync(path.join(sessionsDir(userDataPath), 'corrupt', moved[0]), 'utf8'),
    '{definitely not json'
  );
  assert.equal(logs.entries.some((entry) => entry.event === 'session_store.session_file_quarantined'), true);
  assert.equal(logs.entries.some((entry) => entry.event === 'session_store.session_file_unreadable'), false);
});

test('index recovery keeps a locked chat listed and leaves its file untouched', (t) => {
  const { userDataPath, storePath, ids: [healthyId, lockedId] } = seedChats(['Healthy chat', 'Locked chat']);
  fs.unlinkSync(path.join(sessionsDir(userDataPath), '_index.json'));
  const lockedPath = sessionFilePath(userDataPath, lockedId);
  const before = fs.readFileSync(lockedPath);
  const unlock = lockFile(t, lockedPath);
  const logs = createLogCollector();

  const store = new ElectronSessionStore(storePath, { logger: logs.logger, writeDebounceMs: 0 });
  t.after(() => store.dispose());
  assert.deepEqual(store.getSessionIds().sort(), [healthyId, lockedId].sort());
  assert.equal(store.getSession(healthyId).title, 'Healthy chat');
  assert.equal(store.getSession(lockedId), null);
  unlock();

  assert.deepEqual(fs.readFileSync(lockedPath), before);
  assert.deepEqual(quarantined(userDataPath), []);
  assert.equal(logs.entries.some((entry) => entry.event === 'session_store.split_index_recovered'), true);
  assert.deepEqual(
    store.getSessionMessages(lockedId).map((message) => message.content),
    ['Locked chat first', 'Locked chat second']
  );
});
