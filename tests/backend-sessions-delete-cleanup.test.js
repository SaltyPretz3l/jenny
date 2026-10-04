'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AttachmentAssetStore } = require('../services/attachment-asset-store');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { deleteSession } = require('../services/backend/backend-sessions');

// Deleting a chat reports what it could not remove. Real stores in temp
// directories drive the production deleteSession; only the injected failure
// differs between cases.

const TODO_VECTOR_SESSION_ID = 'sess_todo_vector_1';
const TODO_VECTOR_FILE = 'ceadff8805ae294664945583b1e02698.json';

function createFixture(t) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-delete-cleanup-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const sessionStore = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), {
    logger() {},
  });
  t.after(() => sessionStore.dispose());
  const attachmentAssetStore = new AttachmentAssetStore({
    rootDir: path.join(userDataPath, 'attachments'),
  });
  const service = {
    options: { userDataPath },
    sessionStore,
    attachmentAssetStore,
    _emitServiceLog() {},
  };
  return { service, sessionStore, attachmentAssetStore, userDataPath };
}

function seedImageChat(fixture, sessionId) {
  const imageDir = fixture.attachmentAssetStore.ensureKindDir('image');
  const assetPath = path.join(imageDir, `${sessionId}.png`);
  fs.writeFileSync(assetPath, 'synthetic image bytes');
  assert.ok(fixture.sessionStore.createSessionWithId(sessionId, { title: 'Image chat' }));
  fixture.sessionStore.appendMessage(sessionId, {
    id: `msg_${sessionId}`,
    role: 'user',
    content: 'look at this',
    timestamp: '2026-10-01T10:00:00.000Z',
    attachments: [{
      id: `image_${sessionId}`,
      kind: 'image',
      displayName: 'Synthetic.png',
      mimeType: 'image/png',
      assetPath,
      sourceKind: 'file',
    }],
  });
  return assetPath;
}

function denyUnlink(t, deniedPath) {
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(deniedPath)) {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    }
    return realUnlink.call(fs, target, ...rest);
  };
  t.after(() => { fs.unlinkSync = realUnlink; });
}

function expectedTodoFile(userDataPath, sessionId) {
  const digest = crypto.createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32);
  return path.join(userDataPath, 'todo-lists', `${digest}.json`);
}

test('chat delete is degraded when a managed image cannot be removed', async (t) => {
  const fixture = createFixture(t);
  const assetPath = seedImageChat(fixture, 'sess_image_denied');
  denyUnlink(t, assetPath);

  const result = await deleteSession(fixture.service, 'sess_image_denied');

  assert.equal(result.deleted, true);
  assert.equal(result.cleanup_status, 'degraded');
  assert.deepEqual(result.cleanup_errors, [{ step: 'attachment_assets', code: 'cleanup_failed' }]);
  assert.equal(fs.existsSync(assetPath), true);
});

test('chat delete is complete and removes the managed image when nothing fails', async (t) => {
  const fixture = createFixture(t);
  const assetPath = seedImageChat(fixture, 'sess_image_ok');

  const result = await deleteSession(fixture.service, 'sess_image_ok');

  assert.equal(result.deleted, true);
  assert.equal(result.cleanup_status, 'complete');
  assert.deepEqual(result.cleanup_errors, []);
  assert.equal(fs.existsSync(assetPath), false);
});

test('chat delete removes that chat\'s todo list and keeps other chats\' lists', async (t) => {
  const fixture = createFixture(t);
  const todoDir = path.join(fixture.userDataPath, 'todo-lists');
  fs.mkdirSync(todoDir, { recursive: true });
  assert.ok(fixture.sessionStore.createSessionWithId(TODO_VECTOR_SESSION_ID, { title: 'Todo chat' }));
  assert.ok(fixture.sessionStore.createSessionWithId('sess_todo_other', { title: 'Other chat' }));
  const deletedFile = path.join(todoDir, TODO_VECTOR_FILE);
  const otherFile = expectedTodoFile(fixture.userDataPath, 'sess_todo_other');
  assert.equal(expectedTodoFile(fixture.userDataPath, TODO_VECTOR_SESSION_ID), deletedFile);
  fs.writeFileSync(deletedFile, '{"items":[]}');
  fs.writeFileSync(otherFile, '{"items":[]}');

  const result = await deleteSession(fixture.service, TODO_VECTOR_SESSION_ID);

  assert.equal(result.cleanup_status, 'complete');
  assert.equal(fs.existsSync(deletedFile), false);
  assert.equal(fs.existsSync(otherFile), true);
});

test('chat delete without a todo list or todo directory stays complete', async (t) => {
  const fixture = createFixture(t);
  assert.ok(fixture.sessionStore.createSessionWithId('sess_no_todo', { title: 'No todo' }));

  const result = await deleteSession(fixture.service, 'sess_no_todo');

  assert.equal(result.cleanup_status, 'complete');
  assert.deepEqual(result.cleanup_errors, []);
});

test('chat delete is degraded when the todo list cannot be removed', async (t) => {
  const fixture = createFixture(t);
  const todoDir = path.join(fixture.userDataPath, 'todo-lists');
  fs.mkdirSync(todoDir, { recursive: true });
  assert.ok(fixture.sessionStore.createSessionWithId('sess_todo_denied', { title: 'Denied' }));
  const todoFile = expectedTodoFile(fixture.userDataPath, 'sess_todo_denied');
  fs.writeFileSync(todoFile, '{"items":[]}');
  denyUnlink(t, todoFile);

  const result = await deleteSession(fixture.service, 'sess_todo_denied');

  assert.equal(result.cleanup_status, 'degraded');
  assert.deepEqual(result.cleanup_errors, [{ step: 'todo_list', code: 'cleanup_failed' }]);
  assert.equal(fs.existsSync(todoFile), true);
});

test('chat delete reports recovery copies it could not purge', async (t) => {
  const fixture = createFixture(t);
  const calls = [];
  fixture.sessionStore.purgeSessionRecoveryCopies = (sessionId) => {
    calls.push(sessionId);
    return { removed: 0, failed: 1 };
  };
  assert.ok(fixture.sessionStore.createSessionWithId('sess_recovery_failed', { title: 'Recovery' }));

  const result = await deleteSession(fixture.service, 'sess_recovery_failed');

  assert.deepEqual(calls, ['sess_recovery_failed']);
  assert.equal(result.cleanup_status, 'degraded');
  assert.deepEqual(result.cleanup_errors, [{ step: 'recovery_copies', code: 'cleanup_failed' }]);
});

test('chat delete stays complete when every recovery copy was purged', async (t) => {
  const fixture = createFixture(t);
  fixture.sessionStore.purgeSessionRecoveryCopies = () => ({ removed: 2, failed: 0 });
  assert.ok(fixture.sessionStore.createSessionWithId('sess_recovery_ok', { title: 'Recovery' }));

  const result = await deleteSession(fixture.service, 'sess_recovery_ok');

  assert.equal(result.cleanup_status, 'complete');
  assert.deepEqual(result.cleanup_errors, []);
});
