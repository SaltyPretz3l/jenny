'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  importSession,
  SESSION_IMPORT_ERROR_CODES,
} = require('../services/backend/session-export-import');

function createStore(sessions = {}) {
  const store = {
    sessions: { ...sessions },
    getSession(sessionId) { return store.sessions[sessionId] || null; },
    _read() { return { schema_version: 3, sessions: { ...store.sessions } }; },
    _write(payload) { store.sessions = { ...(payload.sessions || {}) }; },
    _toSummary(session) { return { id: session.id, title: session.title }; },
  };
  return store;
}

function sessionPayload() {
  return JSON.stringify({
    format: 'jenny-session-export',
    format_version: 1,
    session: {
      title: 'Original Chat',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      messages: [{ id: 'msg_1', role: 'user', content: 'Hello' }],
    },
  });
}

test('trusted archive restore preserves session identity without widening ordinary imports', () => {
  const restored = importSession(createStore(), sessionPayload(), null, {
    trustedArchive: true,
    restoredSessionId: 'sess_preserved_1',
  });
  assert.equal(restored.id, 'sess_preserved_1');
  assert.equal(restored.title, 'Original Chat');

  const imported = importSession(createStore(), sessionPayload(), null, {
    restoredSessionId: 'sess_untrusted',
  });
  assert.notEqual(imported.id, 'sess_untrusted');
  assert.match(imported.title, /\(imported\)$/);
});

test('trusted archive restore rejects conflicting and malformed session identities', () => {
  const existing = createStore({
    sess_existing: { id: 'sess_existing', title: 'Existing', messages: [] },
  });
  for (const [store, restoredSessionId] of [
    [existing, 'sess_existing'],
    [createStore(), '../bad'],
  ]) {
    assert.throws(() => importSession(store, sessionPayload(), null, {
      trustedArchive: true,
      restoredSessionId,
    }), (error) => error.name === 'SessionImportError'
      && error.code === SESSION_IMPORT_ERROR_CODES.FORMAT_MISMATCH
      && error.reason === 'format_mismatch');
  }
});
