'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ElectronSessionStore, TURN_EVENT_LOG_VERSION } = require('../services/backend/electron-session-store');
const { exportSession, importSession } = require('../services/backend/session-export-import');

const roots = [];

function createStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-session-turn-events-'));
  roots.push(root);
  return new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
}

function createSessionWithTurnEvent(store) {
  const created = store.createSession({ title: 'Turn events' });
  store.appendMessage(created.id, { id: 'user_turn_1', role: 'user', content: 'question' });
  store.appendMessage(created.id, { id: 'assistant_turn_1', role: 'assistant', content: 'answer' });
  store.appendTurnEvents(created.id, [{
    event_id: 'turn_1:user_prompt:0',
    turn_id: 'turn_1',
    kind: 'user_prompt',
    primary_message_id: 'user_turn_1',
    source_message_ids: ['user_turn_1'],
    payload: { content: 'question', attachments: [] },
  }]);
  return created.id;
}

function withTurnEvents(payload, turnEvents) {
  const parsed = JSON.parse(payload);
  parsed.session.turn_events = turnEvents;
  return JSON.stringify(parsed);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('session export turn events', () => {
  it('keeps canonical turn events through an archive-style export and trusted import', () => {
    const source = createStore();
    const sessionId = createSessionWithTurnEvent(source);
    assert.equal(source.getSessionTurnEvents(sessionId).length, 1);

    const payload = exportSession(source, sessionId, null, { includeTurnEvents: true });
    const target = createStore();
    const restoredSessionId = 'sess_restored_turn_events';
    importSession(target, payload, null, { trustedArchive: true, restoredSessionId });

    const events = target.getSessionTurnEvents(restoredSessionId);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'user_prompt');
    assert.equal(events[0].turn_id, 'turn_1');
    const messageIds = target.getSessionMessages(restoredSessionId).map((message) => message.id);
    assert.ok(messageIds.includes(events[0].primary_message_id));
    assert.deepEqual(events[0].source_message_ids.filter((id) => !messageIds.includes(id)), []);
    // The renderer reads the events only when the log version came back with them.
    const sourceVersion = source.getSession(sessionId).turn_event_log_version;
    assert.ok(sourceVersion >= 1);
    assert.equal(target.getSession(restoredSessionId).turn_event_log_version, sourceVersion);
  });

  it('drops a turn event log written by a newer build and keeps the messages', () => {
    const source = createStore();
    const sessionId = createSessionWithTurnEvent(source);
    const parsed = JSON.parse(exportSession(source, sessionId, null, { includeTurnEvents: true }));
    parsed.session.turn_event_log_version = TURN_EVENT_LOG_VERSION + 1;

    const target = createStore();
    const restoredSessionId = 'sess_restored_newer_log';
    importSession(target, JSON.stringify(parsed), null, { trustedArchive: true, restoredSessionId });

    assert.equal(target.getSessionTurnEvents(restoredSessionId).length, 0);
    assert.equal(target.getSession(restoredSessionId).turn_event_log_version, 0);
    assert.equal(target.getSessionMessages(restoredSessionId).length, 2);
  });

  it('leaves turn events out of the portable export', () => {
    const source = createStore();
    const sessionId = createSessionWithTurnEvent(source);
    assert.equal('turn_events' in JSON.parse(exportSession(source, sessionId)).session, false);
  });

  it('ignores turn events in an untrusted import', () => {
    const source = createStore();
    const sessionId = createSessionWithTurnEvent(source);
    const payload = exportSession(source, sessionId, null, { includeTurnEvents: true });
    assert.equal(JSON.parse(payload).session.turn_events.length, 1);

    const target = createStore();
    const summary = importSession(target, payload, null);
    assert.equal(target.getSessionTurnEvents(summary.id).length, 0);
  });

  it('rejects turn events that are not an array of objects', () => {
    const source = createStore();
    const sessionId = createSessionWithTurnEvent(source);
    const payload = exportSession(source, sessionId);
    for (const bad of ['events', ['text'], [null], [[]]]) {
      assert.throws(
        () => importSession(createStore(), withTurnEvents(payload, bad), null, { trustedArchive: true }),
        { name: 'SessionImportError', reason: 'format_mismatch' }
      );
    }
  });
});
