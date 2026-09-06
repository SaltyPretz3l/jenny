const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { buildSessionSummary } = require('../services/backend/session-summary-projection');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createStore(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  return { storePath, store: new ElectronSessionStore(storePath, { writeDebounceMs: 0 }) };
}

function withoutVolatileSessionFields(session) {
  const {
    id, created_at: createdAt, updated_at: updatedAt,
    session_incarnation: sessionIncarnation, ...stable
  } = session;
  return stable;
}

test('linked task id persists with a composer draft and appears in session summaries', () => {
  const { storePath, store } = createStore('jenny-linked-task-');
  const created = store.createSession({
    title: 'Task session',
    composerDraft: 'Complete the linked task.',
    linkedTaskId: ' task:WO-10c ',
  });
  const session = store.getSession(created.id);

  assert.equal(session.linked_task_id, 'task:WO-10c');
  assert.equal(session.composer_draft, 'Complete the linked task.');
  assert.equal(buildSessionSummary(session).linked_task_id, 'task:WO-10c');

  store.flush();
  store.dispose();
  const reloaded = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  assert.equal(reloaded.getSession(created.id).linked_task_id, 'task:WO-10c');
  assert.equal(reloaded.getSession(created.id).composer_draft, 'Complete the linked task.');
  reloaded.dispose();
});

test('linked task id normalization rejects malformed values and defaults omissions to empty', () => {
  const { store } = createStore('jenny-linked-task-invalid-');

  for (const linkedTaskId of [{}, 123, 'x'.repeat(500), 'fu_ id']) {
    const created = store.createSession({ title: 'Rejected task link', linkedTaskId });
    assert.equal(store.getSession(created.id).linked_task_id, '');
  }

  const omitted = store.createSession({ title: 'Baseline' });
  const explicitEmpty = store.createSession({ title: 'Baseline', linkedTaskId: '' });
  const omittedRecord = store.getSession(omitted.id);
  const explicitEmptyRecord = store.getSession(explicitEmpty.id);
  assert.equal(omittedRecord.linked_task_id, '');
  assert.deepEqual(
    withoutVolatileSessionFields(explicitEmptyRecord),
    withoutVolatileSessionFields(omittedRecord)
  );
  store.dispose();
});

test('cached index summaries re-normalize linked task ids on list', () => {
  const { store } = createStore('jenny-linked-task-index-');
  const created = store.createSession({ title: 'Indexed', linkedTaskId: 'task-ok' });
  const untouched = store.createSession({ title: 'Plain' });
  // `_read()` hands back the cached summary objects by reference: a tampered
  // or pre-normalizer index entry must not reach `sessions.list` unnormalized.
  store._read().sessions[created.id].linked_task_id = 'bad\nid';
  delete store._read().sessions[untouched.id].linked_task_id;

  const listed = new Map(store.listSessions().map((summary) => [summary.id, summary]));
  assert.equal(listed.get(created.id).linked_task_id, '');
  assert.equal(listed.get(untouched.id).linked_task_id, '');
  store.dispose();
});
