// Shared fixtures for the truncate suites: a throwaway ElectronSessionStore and
// the four-message / two-turn conversation both the store-contract tests and the
// attachment-lifecycle tests truncate against.
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ElectronSessionStore,
} = require('../../services/backend/electron-session-store');
const {
  trackDirectory,
} = require('./resource-cleanup');

function freshStore(options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-truncate-'));
  trackDirectory(userDataPath);
  const store = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'), options);
  return { store, userDataPath };
}

function seedConversation(store, sessionId) {
  store.appendMessage(sessionId, {
    id: 'msg_user_1',
    role: 'user',
    content: 'first prompt',
    timestamp: '2026-05-11T10:00:00.000Z',
  });
  store.appendMessage(sessionId, {
    id: 'msg_ai_1',
    role: 'assistant',
    content: 'first reply',
    timestamp: '2026-05-11T10:00:01.000Z',
  });
  store.appendMessage(sessionId, {
    id: 'msg_user_2',
    role: 'user',
    content: 'second prompt',
    timestamp: '2026-05-11T10:00:02.000Z',
  });
  store.appendMessage(sessionId, {
    id: 'msg_ai_2',
    role: 'assistant',
    content: 'second reply',
    timestamp: '2026-05-11T10:00:03.000Z',
  });
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'turn_1:user_bubble:0',
      turn_id: 'turn_1',
      kind: 'user_bubble',
      primary_message_id: 'msg_user_1',
      source_message_ids: ['msg_user_1'],
      payload: { text: 'first prompt' },
    },
    {
      event_id: 'turn_1:assistant_text_segment:0',
      turn_id: 'turn_1',
      kind: 'assistant_text_segment',
      primary_message_id: 'msg_ai_1',
      source_message_ids: ['msg_user_1'],
      payload: { text: 'first reply' },
    },
    {
      event_id: 'turn_2:user_bubble:0',
      turn_id: 'turn_2',
      kind: 'user_bubble',
      primary_message_id: 'msg_user_2',
      source_message_ids: ['msg_user_2'],
      payload: { text: 'second prompt' },
    },
    {
      event_id: 'turn_2:assistant_text_segment:0',
      turn_id: 'turn_2',
      kind: 'assistant_text_segment',
      primary_message_id: 'msg_ai_2',
      source_message_ids: ['msg_user_2'],
      payload: { text: 'second reply' },
    },
  ]);
}

module.exports = { freshStore, seedConversation };
