'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createSession } = require('../services/backend/backend-sessions');

function fixture(t) {
  const scratch = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'sessions-handoff-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {}, writeDebounceMs: 60000 });
  t.after(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const service = { sessionStore: store, projectAuthority: { captureProject: (id) => ({ project_id: id }) } };
  return { store, service };
}

test('handoff create links both chats and records branch_origin without copying messages', async (t) => {
  const { store, service } = fixture(t);
  const source = (await createSession(service, { title: 'Parser rewrite', projectId: 'project_general' })).data;
  store.appendMessage(source.id, { role: 'user', content: 'Plan the parser rewrite.' });
  store.appendMessage(source.id, { role: 'assistant', content: 'Start with the tokenizer.' });
  const sourceMessages = store.getSessionMessages(source.id);
  assert.equal(sourceMessages.length, 2);
  const lastId = sourceMessages[1].id;
  assert.ok(lastId);

  const before = Date.now();
  const result = await createSession(service, {
    title: 'New Chat', projectId: 'project_general', handoffFromSessionId: source.id,
  });
  const child = result.data;
  assert.notEqual(child.id, source.id);
  assert.equal(child.branch_origin.source_session_id, source.id);
  assert.equal(child.branch_origin.source_message_id, lastId);
  assert.equal(child.branch_origin.source_title, 'Parser rewrite');
  assert.ok(Date.parse(child.branch_origin.created_at) >= before - 1000);
  assert.deepEqual(child.linked_session_ids, [source.id]);

  const childRecord = store.getSession(child.id);
  assert.deepEqual(childRecord.branch_origin, child.branch_origin);
  assert.deepEqual(childRecord.linked_session_ids, [source.id]);
  assert.equal(store.getSessionMessages(child.id).length, 0);
  assert.deepEqual(store.getSession(source.id).linked_session_ids, [child.id]);
  assert.equal(store.getSessionMessages(source.id).length, 2);
});

test('a source with no messages points at session_start', async (t) => {
  const { store, service } = fixture(t);
  const source = (await createSession(service, { title: 'Empty', projectId: 'project_general' })).data;
  const child = (await createSession(service, { projectId: 'project_general', handoffFromSessionId: source.id })).data;
  assert.equal(child.branch_origin.source_message_id, 'session_start');
  assert.deepEqual(store.getSession(source.id).linked_session_ids, [child.id]);
});

test('an unknown, blank or non-string source id is ignored', async (t) => {
  const { store, service } = fixture(t);
  for (const handoffFromSessionId of ['sess_missing', '   ', 42, null, undefined]) {
    const child = (await createSession(service, { projectId: 'project_general', handoffFromSessionId })).data;
    assert.equal(child.branch_origin, null);
    assert.deepEqual(store.getSession(child.id).linked_session_ids || [], []);
  }
});

test('row 69: a handoff from the primary Jenny chat is refused (its note would span every project)', async (t) => {
  const { store, service } = fixture(t);
  const primary = (await createSession(service, { title: 'Jenny', projectId: 'project_general', sessionRole: 'primary' })).data;
  assert.equal(store.getSessionSummary(primary.id).session_role, 'primary');
  await assert.rejects(
    createSession(service, { title: 'New Chat', projectId: 'project_general', handoffFromSessionId: primary.id }),
    (error) => error.code === 'primary_protected'
  );
  assert.equal(store.listSessions().length, 1, 'nothing was created');
  const plain = (await createSession(service, { title: 'Plan', projectId: 'project_general' })).data;
  const child = (await createSession(service, { title: 'New Chat', projectId: 'project_general', handoffFromSessionId: plain.id })).data;
  assert.deepEqual(child.linked_session_ids, [plain.id], 'ordinary handoffs still link');
});
