const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ElectronSessionStore,
  STORE_SCHEMA_VERSION,
  normalizeSession,
} = require('../services/backend/electron-session-store');
const {
  migrateStorePayload,
} = require('../services/backend/session-store-migrations');
test('electron session store persists frontier diagnostic session metadata', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-frontier-session-'));
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));

  try {
    store.createSessionWithId('frontier_session_1', {
      title: 'Frontier diagnostics',
      preferences: {
        diagnostic_mode: 'frontier',
        diagnostic_run_id: 'frontier_run_1',
        diagnostic_provider: 'codex-cli',
        diagnostic_model: 'gpt-5',
      },
    });
    const session = store.getSession('frontier_session_1');
    const summary = store.listSessions().find((entry) => entry.id === 'frontier_session_1');

    assert.equal(session.diagnostic_mode, 'frontier');
    assert.equal(session.diagnostic_run_id, 'frontier_run_1');
    assert.equal(session.diagnostic_provider, 'codex-cli');
    assert.equal(session.diagnostic_model, 'gpt-5');
    assert.equal(summary.diagnostic_mode, 'frontier');
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('electron session migration adds empty diagnostic metadata to normal chats', () => {
  const migrated = migrateStorePayload({
    schema_version: STORE_SCHEMA_VERSION - 1,
    sessions: {
      chat_1: {
        id: 'chat_1',
        title: 'Normal chat',
        messages: [],
      },
    },
  });
  const session = normalizeSession('chat_1', migrated.sessions.chat_1);

  assert.equal(migrated.schema_version, STORE_SCHEMA_VERSION);
  assert.equal(session.diagnostic_mode, '');
  assert.equal(session.diagnostic_run_id, '');
  assert.equal(session.diagnostic_provider, '');
  assert.equal(session.diagnostic_model, '');
});
