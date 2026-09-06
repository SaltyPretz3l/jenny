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

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createStore() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-store-meta-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  return { store: new ElectronSessionStore(storePath), storePath };
}

function appendUserMessage(store, sessionId, content) {
  store.appendMessage(sessionId, {
    id: `msg_${Math.random().toString(16).slice(2, 10)}`,
    role: 'user',
    kind: 'user',
    content,
    timestamp: new Date().toISOString(),
    status: 'complete',
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('sessions default to unpinned/unarchived and surface both fields in summaries', () => {
  const { store } = createStore();
  const created = store.createSession({ title: 'Defaults' });
  assert.equal(created.pinned, false);
  assert.equal(created.archived_at, null);

  const listed = store.listSessions().find((session) => session.id === created.id);
  assert.equal(listed.pinned, false);
  assert.equal(listed.archived_at, null);
});

test('setSessionMeta pins without bumping updated_at so the list order is stable', async () => {
  const { store } = createStore();
  const created = store.createSession({ title: 'Pin me' });
  const updatedAtBefore = created.updated_at;

  await wait(10);
  const pinned = store.setSessionMeta(created.id, { pinned: true });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.updated_at, updatedAtBefore, 'pin must not re-sort the session');

  await wait(10);
  const unpinned = store.setSessionMeta(created.id, { pinned: false });
  assert.equal(unpinned.pinned, false);
  assert.equal(unpinned.updated_at, updatedAtBefore, 'unpin must not re-sort either');
});

test('archive round-trips and survives unrelated mutations', () => {
  const { store } = createStore();
  const created = store.createSession({ title: 'Archive me' });
  const archivedAt = '2026-06-12T10:00:00.000Z';

  const archived = store.setSessionMeta(created.id, { archived_at: archivedAt });
  assert.equal(archived.archived_at, archivedAt);

  // An unrelated rename re-runs normalizeSession; the meta must survive it.
  const renamed = store.renameSession(created.id, 'Archive me (renamed)');
  assert.equal(renamed.archived_at, archivedAt);
  assert.equal(renamed.pinned, false);

  const unarchived = store.setSessionMeta(created.id, { archived_at: null });
  assert.equal(unarchived.archived_at, null);
});

test('pin/archive metadata persists across a store reload', () => {
  const { store, storePath } = createStore();
  const created = store.createSession({ title: 'Persist me' });
  store.setSessionMeta(created.id, { pinned: true, archived_at: '2026-06-12T11:00:00.000Z' });
  store.flush();

  const reloaded = new ElectronSessionStore(storePath);
  const summary = reloaded.listSessions().find((session) => session.id === created.id);
  assert.equal(summary.pinned, true);
  assert.equal(summary.archived_at, '2026-06-12T11:00:00.000Z');

  const fullSession = reloaded.getSession(created.id);
  assert.equal(fullSession.pinned, true);
  assert.equal(fullSession.archived_at, '2026-06-12T11:00:00.000Z');
});

test('setSessionMeta ignores unknown fields, handles empty meta, and misses safely', () => {
  const { store } = createStore();
  const created = store.createSession({ title: 'Edge cases' });

  const unchanged = store.setSessionMeta(created.id, {});
  assert.equal(unchanged.id, created.id);
  assert.equal(unchanged.pinned, false);

  const ignored = store.setSessionMeta(created.id, { preferred_model: 'hijack-model', message_count: 99, pinned: true });
  assert.equal(ignored.pinned, true);
  assert.notEqual(ignored.preferred_model, 'hijack-model', 'meta path must not accept non-meta fields');
  assert.equal(ignored.message_count, 0, 'meta path must not accept non-meta fields');

  assert.equal(store.setSessionMeta('sess_missing', { pinned: true }), null);
});

test('setSessionMeta titles without bumping updated_at (auto-title/backfill path)', async () => {
  const { store } = createStore();
  const created = store.createSession({});
  const updatedAtBefore = created.updated_at;
  assert.equal(created.title, 'New Chat');

  await wait(10);
  const titled = store.setSessionMeta(created.id, { title: 'Fix the sidebar resize bug' });
  assert.equal(titled.title, 'Fix the sidebar resize bug');
  assert.equal(titled.updated_at, updatedAtBefore, 'a backfilled title must not re-sort the session');

  // Empty/whitespace titles are ignored rather than resetting to "New Chat".
  const unchanged = store.setSessionMeta(created.id, { title: '   ' });
  assert.equal(unchanged.title, 'Fix the sidebar resize bug');

  // Long titles ride the same 80-char clip as renameSession.
  const clipped = store.setSessionMeta(created.id, { title: 'x'.repeat(120) });
  assert.equal(clipped.title, `${'x'.repeat(77)}...`);
});

test('sweepEmptySessions targets only empty untitled unpinned non-current sessions', () => {
  const { store } = createStore();
  const emptyUntitled = store.createSession({});
  const emptyPinned = store.createSession({});
  store.setSessionMeta(emptyPinned.id, { pinned: true });
  const emptyTitled = store.createSession({ title: 'Keep: deliberately named' });
  const nonEmpty = store.createSession({});
  appendUserMessage(store, nonEmpty.id, 'hello');
  const current = store.createSession({});

  const dryRun = store.sweepEmptySessions({ dryRun: true, currentSessionId: current.id });
  assert.deepEqual(dryRun.candidateIds, [emptyUntitled.id]);
  assert.equal(dryRun.deleted, 0);
  assert.ok(store.getSession(emptyUntitled.id), 'dry run deletes nothing');

  const swept = store.sweepEmptySessions({ currentSessionId: current.id });
  assert.deepEqual(swept.candidateIds, [emptyUntitled.id]);
  assert.equal(swept.deleted, 1);
  assert.equal(store.getSession(emptyUntitled.id), null);
  assert.ok(store.getSession(emptyPinned.id), 'pinned empties survive');
  assert.ok(store.getSession(emptyTitled.id), 'titled empties survive');
  assert.ok(store.getSession(nonEmpty.id), 'sessions with messages survive');
  assert.ok(store.getSession(current.id), 'the current session survives');
});
