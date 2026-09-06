// CTL-008 acceptance contract: session deletion must report TRUTHFULLY and
// never orphan user data. Today SessionStorageBackend.deleteSession swallows
// store.delete()/unlinkSync failures, drops the cache + index entry anyway,
// and returns true — so the session file stays on disk while every caller
// (IPC deleted:true, attachment/artifact cleanup, cost reset, sweeps) behaves
// as if the data is gone.
//
// Contract pinned here:
// - A FAILED primary delete (the session file provably still exists) must not
//   report success — backend result must satisfy
//   `result === true || result?.ok === true` === false — and the session must
//   be RETAINED (index + hasSession) so the on-disk data is still reachable
//   and a retry can converge. The existing delete_failed diagnostic stays.
// - ENOENT (file already gone) stays a SUCCESS so retries converge.
// - ElectronSessionStore.deleteSession keeps its boolean surface: exactly
//   `false` when the backend delete fails (IPC reports deleted:false, cleanup
//   must not run), exactly `true` on success.
// - sweepEmptySessions must not count a failed delete as deleted (an
//   object-shaped backend result must not slip through boolean call sites).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionStorageBackend } = require('../services/backend/session-storage-backend');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeTempRoot(label) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-del-durability-${label}-`));
  trackDirectory(rootDir);
  return rootDir;
}

function isSuccess(result) {
  return result === true || result?.ok === true;
}

function normalizeSession(id, record) {
  const source = record && typeof record === 'object' ? record : {};
  return {
    id,
    title: source.title || 'Untitled',
    messages: Array.isArray(source.messages) ? source.messages : [],
  };
}

function makeBackend(rootDir, overrides = {}) {
  return new SessionStorageBackend(rootDir, {
    schemaVersion: 2,
    normalizeSession,
    summarizeSession: (record) => ({ id: record.id, title: record.title }),
    migratePayload: (payload) => payload,
    writeDebounceMs: 0,
    ...overrides,
  });
}

function makeThrowingStore(filePath, error) {
  return {
    filePath,
    write() {},
    writeImmediate() {},
    flush() { return false; },
    hasPendingWrite() { return false; },
    dispose() {},
    delete() { throw error; },
  };
}

// ---------------------------------------------------------------------------
// SessionStorageBackend: failed primary delete
// ---------------------------------------------------------------------------

test('a live store.delete() failure must not report success and must retain the session', () => {
  const rootDir = makeTempRoot('live-throw');
  const backend = makeBackend(rootDir);
  assert.equal(isSuccess(backend.upsertSession('sess_locked', { title: 'Locked' })), true);
  backend.flush();
  const filePath = path.join(rootDir, 'sess_locked.json');
  assert.equal(fs.existsSync(filePath), true, 'precondition: the session file is on disk');
  const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  backend._sessionStores.set('sess_locked', makeThrowingStore(filePath, eperm));

  const result = backend.deleteSession('sess_locked');

  assert.equal(
    isSuccess(result),
    false,
    'a delete whose file removal failed must not read as success under any result shape'
  );
  assert.equal(
    backend.hasSession('sess_locked'),
    true,
    'the session must be RETAINED: its data is still on disk, so dropping the index would orphan it'
  );
  assert.equal(fs.existsSync(filePath), true, 'the file is still there — the index must still know it');
});

test('an unlinkSync non-ENOENT failure (no live store) must not report success and must retain the session', () => {
  const rootDir = makeTempRoot('unlink-throw');
  // Index lists a session whose "file" is a directory: unlink throws
  // EPERM/EISDIR, the platform-independent stand-in for a locked file.
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 2,
      sessions: { sess_dir: { id: 'sess_dir', title: 'DirSession' } },
    }),
    'utf8'
  );
  fs.mkdirSync(path.join(rootDir, 'sess_dir.json'));
  const backend = makeBackend(rootDir);
  assert.equal(backend._sessionStores.has('sess_dir'), false, 'precondition: no live store');

  const result = backend.deleteSession('sess_dir');

  assert.equal(isSuccess(result), false, 'the failed unlink must not read as success');
  assert.equal(backend.hasSession('sess_dir'), true, 'the undeletable session stays listed');
});

test('a failed delete survives a restart: a fresh backend over the same root still lists the session', () => {
  const rootDir = makeTempRoot('restart');
  const backend = makeBackend(rootDir);
  backend.upsertSession('sess_survivor', { title: 'Survivor' });
  backend.flush();
  const filePath = path.join(rootDir, 'sess_survivor.json');
  const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  backend._sessionStores.set('sess_survivor', makeThrowingStore(filePath, eperm));

  assert.equal(isSuccess(backend.deleteSession('sess_survivor')), false);
  backend.flush();
  backend.dispose?.();

  const reloaded = makeBackend(rootDir);
  assert.equal(
    reloaded.hasSession('sess_survivor'),
    true,
    'after restart the still-on-disk session must be reachable (not an orphaned file the index forgot)'
  );
  const record = reloaded.getSession('sess_survivor');
  assert.equal(record?.title, 'Survivor', 'the retained session record loads intact');
});

// Green pin: ENOENT means the file is already gone — that IS a completed
// delete, and it must keep reporting success so retries converge.
test('deleting a session whose file is already gone stays a success', () => {
  const rootDir = makeTempRoot('enoent');
  fs.writeFileSync(
    path.join(rootDir, '_index.json'),
    JSON.stringify({
      schema_version: 2,
      sessions: { sess_gone: { id: 'sess_gone', title: 'Ghost' } },
    }),
    'utf8'
  );
  const backend = makeBackend(rootDir);

  const result = backend.deleteSession('sess_gone');

  assert.equal(isSuccess(result), true, 'ENOENT converges to deleted');
  assert.equal(backend.hasSession('sess_gone'), false);
});

// Green pin: the sunny-day delete still works end to end.
test('a successful delete removes the file and the index entry and reports success', () => {
  const rootDir = makeTempRoot('sunny');
  const backend = makeBackend(rootDir);
  backend.upsertSession('sess_ok', { title: 'Removable' });
  backend.flush();
  const filePath = path.join(rootDir, 'sess_ok.json');
  assert.equal(fs.existsSync(filePath), true);

  const result = backend.deleteSession('sess_ok');

  assert.equal(isSuccess(result), true);
  assert.equal(fs.existsSync(filePath), false, 'the session file is gone');
  assert.equal(backend.hasSession('sess_ok'), false);
});

// ---------------------------------------------------------------------------
// ElectronSessionStore: boolean surface + call-site truthfulness
// ---------------------------------------------------------------------------

function makeElectronStore(label) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-del-electron-${label}-`));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), {
    writeDebounceMs: 0,
  });
  return { store, userDataPath };
}

test('ElectronSessionStore.deleteSession returns exactly false when the backend delete fails', () => {
  const { store } = makeElectronStore('passthrough');
  const created = store.createSession({ title: 'Locked Session' });
  store.flushSession?.(created.id);
  const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  const filePath = store._backend._sessionFilePath(created.id);
  store._backend._sessionStores.set(created.id, makeThrowingStore(filePath, eperm));

  const deleted = store.deleteSession(created.id);

  assert.equal(
    deleted,
    false,
    'the IPC-facing surface must report deleted:false when the file removal failed'
  );
  assert.equal(
    store.getSession(created.id) !== null && store.getSession(created.id) !== undefined,
    true,
    'the session is still reachable through the store after the failed delete'
  );
});

test('ElectronSessionStore.deleteSession still returns exactly true on a successful delete', () => {
  const { store } = makeElectronStore('sunny');
  const created = store.createSession({ title: 'Removable' });

  const deleted = store.deleteSession(created.id);

  assert.equal(deleted, true);
  assert.ok(!store.getSession(created.id), 'the deleted session is gone from the store');
});

test('sweepEmptySessions does not count a failed delete as deleted and retains the session', () => {
  const { store } = makeElectronStore('sweep');
  // Two sweep candidates: both empty, untitled. One of them cannot be
  // deleted (locked file).
  const locked = store.createSession({ title: 'New Chat' });
  const removable = store.createSession({ title: 'New Chat' });
  store.flushSession?.(locked.id);
  const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  const lockedPath = store._backend._sessionFilePath(locked.id);
  store._backend._sessionStores.set(locked.id, makeThrowingStore(lockedPath, eperm));

  const result = store.sweepEmptySessions();

  assert.equal(result.candidateIds.length, 2, 'precondition: both sessions are sweep candidates');
  assert.equal(
    result.deleted,
    1,
    'only the genuinely removed session may be counted (a truthy non-success result must not inflate the count)'
  );
  assert.ok(store.getSession(locked.id), 'the undeletable session survives the sweep');
  assert.ok(!store.getSession(removable.id), 'the removable session is actually gone');
});
