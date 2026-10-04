'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const {
  settleInterruptedPluginOperation,
  settleInterruptedPluginOperationOnRead,
} = require('../services/backend/plugin-session-settlement');
const { createOfficialImagePluginSession } = require('../services/backend/session-type');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

const INTERRUPTED_TEXT = 'The plugin operation was interrupted before it finished.';

function activeOperation(overrides = {}) {
  return {
    operation_id: 'op_settle_1',
    attempt: 2,
    action_id: 'generate',
    status: 'running',
    started_at: '2026-10-01T10:00:00.000Z',
    frame_sequence: 3,
    assistant_message_id: 'assistant_working',
    ...overrides,
  };
}

function pluginSession({ operation = activeOperation(), messages } = {}) {
  const base = createOfficialImagePluginSession({
    model_id: 'HiDream-ai/HiDream-O1-Image', resolution: '2048x2048', steps: 50,
  });
  return {
    id: 'plugin_sess',
    session_type: 'plugin',
    plugin_session: { ...base, active_operation: operation },
    messages: messages || [
      { id: 'user_1', role: 'user', content: 'Draw a fox', status: 'complete' },
      { id: 'assistant_working', role: 'assistant', content: 'Working...', status: 'streaming' },
    ],
  };
}

test('settle rewrites the matching streaming message and clears the active operation', () => {
  const input = pluginSession();
  const { changed, session } = settleInterruptedPluginOperation(input);
  assert.equal(changed, true);
  assert.equal(session.plugin_session.active_operation, null);
  const [user, assistant] = session.messages;
  assert.deepEqual(user, input.messages[0]);
  assert.equal(assistant.content, INTERRUPTED_TEXT);
  assert.equal(assistant.status, 'runtime_error');
  assert.deepEqual(assistant.plugin_operation, {
    operation_id: 'op_settle_1',
    attempt: 2,
    action_id: 'generate',
    status: 'interrupted',
    reason_code: 'app_restarted',
  });
  // Pure: the input is not mutated.
  assert.equal(input.plugin_session.active_operation.status, 'running');
  assert.equal(input.messages[1].status, 'streaming');
});

test('settle also handles accepted, cancelling and cleanup_pending operations', () => {
  for (const status of ['accepted', 'running', 'cancelling', 'cleanup_pending']) {
    const { changed, session } = settleInterruptedPluginOperation(
      pluginSession({ operation: activeOperation({ status }) })
    );
    assert.equal(changed, true, status);
    assert.equal(session.plugin_session.active_operation, null, status);
    assert.equal(session.messages[1].status, 'runtime_error', status);
    assert.equal(session.messages[1].plugin_operation.status, 'interrupted', status);
  }
});

test('settle without an assistant message id only clears the field', () => {
  const operation = activeOperation();
  delete operation.assistant_message_id;
  const input = pluginSession({ operation });
  const { changed, session } = settleInterruptedPluginOperation(input);
  assert.equal(changed, true);
  assert.equal(session.plugin_session.active_operation, null);
  assert.deepEqual(session.messages, input.messages);
});

test('settle with no matching message only clears the field', () => {
  const input = pluginSession({ operation: activeOperation({ assistant_message_id: 'gone' }) });
  const { changed, session } = settleInterruptedPluginOperation(input);
  assert.equal(changed, true);
  assert.equal(session.plugin_session.active_operation, null);
  assert.deepEqual(session.messages, input.messages);
});

test('settle leaves chat sessions and idle plugin sessions untouched', () => {
  const chat = { id: 'chat_1', session_type: 'chat', plugin_session: null, messages: [] };
  assert.deepEqual(settleInterruptedPluginOperation(chat), { changed: false, session: chat });
  const idle = pluginSession({ operation: null });
  assert.deepEqual(settleInterruptedPluginOperation(idle), { changed: false, session: idle });
  assert.deepEqual(settleInterruptedPluginOperation(null), { changed: false, session: null });
});

test('settling twice is a no-op the second time', () => {
  const first = settleInterruptedPluginOperation(pluginSession());
  const second = settleInterruptedPluginOperation(first.session);
  assert.equal(second.changed, false);
  assert.deepEqual(second.session, first.session);
});

test('on-read settlement audits each session once per backend and logs failures', () => {
  const upserts = [];
  const logs = [];
  const backend = {
    hasNewerSchema: () => false,
    upsertSession: (id, value, options) => { upserts.push({ id, value, options }); return true; },
  };
  const normalizeSession = (id, value) => ({ ...value, normalized_for: id });
  const input = pluginSession();
  const settled = settleInterruptedPluginOperationOnRead({
    backend, logger: (...args) => logs.push(args), sessionId: 'plugin_sess', session: input, normalizeSession,
  });
  assert.equal(settled.plugin_session.active_operation, null);
  assert.equal(settled.normalized_for, 'plugin_sess');
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].options, { persist: true, alreadyNormalized: true });
  // Second read of the same session on the same backend is not re-audited.
  const again = settleInterruptedPluginOperationOnRead({
    backend, sessionId: 'plugin_sess', session: input, normalizeSession,
  });
  assert.equal(again, input);
  assert.equal(upserts.length, 1);

  const throwing = { hasNewerSchema: () => false, upsertSession: () => { throw new Error('disk full'); } };
  const unsettled = settleInterruptedPluginOperationOnRead({
    backend: throwing, logger: (...args) => logs.push(args), sessionId: 'plugin_sess', session: input, normalizeSession,
  });
  assert.equal(unsettled, input);
  assert.equal(logs[0][0], 'WARN');
  assert.equal(logs[0][1], 'session_store.plugin_operation_settlement_failed');
});

function makeStorePath(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  return path.join(userDataPath, 'sessions.json');
}

function readSessionFile(storePath, sessionId) {
  return JSON.parse(fs.readFileSync(
    path.join(path.dirname(storePath), 'sessions', `${sessionId}.json`), 'utf8'
  )).session;
}

test('store getSession settles an interrupted plugin operation once and rewrites the record', () => {
  const storePath = makeStorePath('jenny-plugin-settle-');
  const store = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const created = store.createSession({
    title: 'Image', sessionType: 'plugin', pluginSession: pluginSession().plugin_session,
  });
  const sessionId = created.id;
  store.appendMessage(sessionId, { id: 'user_1', role: 'user', content: 'Draw a fox', status: 'complete' });
  store.appendMessage(sessionId, {
    id: 'assistant_working', role: 'assistant', content: 'Working...', status: 'streaming',
  });
  store.updateSession(sessionId, {
    plugin_session: { ...pluginSession().plugin_session, active_operation: activeOperation() },
  });
  store.flush();
  store.dispose();
  const before = readSessionFile(storePath, sessionId);
  assert.equal(before.plugin_session.active_operation.status, 'running');

  const reopened = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const settled = reopened.getSession(sessionId);
  assert.equal(settled.plugin_session.active_operation, null);
  const assistant = settled.messages.find((message) => message.id === 'assistant_working');
  assert.equal(assistant.content, INTERRUPTED_TEXT);
  assert.equal(assistant.status, 'runtime_error');
  assert.equal(assistant.plugin_operation.reason_code, 'app_restarted');
  reopened.flush();
  reopened.dispose();

  const after = readSessionFile(storePath, sessionId);
  assert.equal(after.plugin_session.active_operation, null);
  assert.equal(after.messages.find((message) => message.id === 'assistant_working').status, 'runtime_error');
});

test('store getSession does not rewrite a newer-schema store', () => {
  const storePath = makeStorePath('jenny-plugin-settle-newer-');
  const sessionsDir = path.join(path.dirname(storePath), 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const record = {
    ...pluginSession(),
    title: 'Future',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    message_count: 2,
  };
  const indexPath = path.join(sessionsDir, '_index.json');
  const sessionPath = path.join(sessionsDir, 'plugin_sess.json');
  fs.writeFileSync(indexPath, JSON.stringify({
    schema_version: 99,
    sessions: { plugin_sess: { id: 'plugin_sess', title: 'Future', message_count: 2 } },
  }, null, 2));
  fs.writeFileSync(sessionPath, JSON.stringify({ schema_version: 22, session: record }, null, 2));
  const indexBefore = fs.readFileSync(indexPath, 'utf8');
  const sessionBefore = fs.readFileSync(sessionPath, 'utf8');

  const store = new ElectronSessionStore(storePath, { logger() {} });
  assert.equal(store.hasNewerSchema(), true);
  const session = store.getSession('plugin_sess');
  assert.ok(session);
  assert.equal(session.plugin_session.active_operation?.status, 'running');
  assert.equal(session.messages.find((message) => message.id === 'assistant_working').status, 'streaming');
  store.flush();
  store.dispose();
  assert.equal(fs.readFileSync(indexPath, 'utf8'), indexBefore);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), sessionBefore);
});
