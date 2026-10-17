const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { forkSession } = require('../services/backend/session-branching');
const { exportSession, importSession } = require('../services/backend/session-export-import');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// Memory v2 (row 58 W1 S4): the per-chat "Don't remember this chat" flag is a
// context preference, so it must survive every surface the other context
// preferences survive: the preference write, a reload, a branch and an
// export/import round trip.

function buildStore() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-memory-opt-out-store-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  return { storePath, store: new ElectronSessionStore(storePath, { logger() {} }) };
}

test('memory_opt_out defaults off and survives persist, reload, branch and export-import', () => {
  const { storePath, store } = buildStore();
  const { id } = store.createSession({ title: 'Private chat' });
  assert.equal(store.getSession(id).context_preferences.memory_opt_out, false);

  store.appendMessage(id, { id: 'msg_1', role: 'user', content: 'hello', timestamp: '2026-10-15T00:00:00.000Z' });
  store.appendMessage(id, { id: 'msg_2', role: 'assistant', content: 'hi', timestamp: '2026-10-15T00:00:01.000Z' });
  const updated = store.setSessionPreferences(id, {
    context_preferences: { ...store.getSession(id).context_preferences, memory_opt_out: true },
  });
  assert.equal(updated.context_preferences.memory_opt_out, true, 'the returned summary carries the flag');
  assert.equal(store.listSessions().find((row) => row.id === id).context_preferences.memory_opt_out, true);

  const reloaded = new ElectronSessionStore(storePath, { logger() {} });
  assert.equal(reloaded.getSession(id).context_preferences.memory_opt_out, true, 'survives a reload');

  const branch = forkSession(reloaded, id, 'msg_2');
  assert.ok(branch, 'branch created');
  assert.equal(reloaded.getSession(branch.id).context_preferences.memory_opt_out, true, 'a branch copies it');

  const exported = exportSession(reloaded, id);
  assert.equal(JSON.parse(exported).session.context_preferences.memory_opt_out, true, 'the export carries it');
  const imported = importSession(reloaded, exported);
  assert.equal(reloaded.getSession(imported.id).context_preferences.memory_opt_out, true, 'the import keeps it');
});

test('a create with memory_opt_out keeps it and a malformed value normalizes off', () => {
  const { store } = buildStore();
  const optedOut = store.createSession({ title: 'Off', preferences: { context_preferences: { memory_opt_out: true } } });
  assert.equal(store.getSession(optedOut.id).context_preferences.memory_opt_out, true);
  const malformed = store.createSession({ title: 'Bad', preferences: { context_preferences: { memory_opt_out: 'yes' } } });
  assert.equal(store.getSession(malformed.id).context_preferences.memory_opt_out, false);
});
