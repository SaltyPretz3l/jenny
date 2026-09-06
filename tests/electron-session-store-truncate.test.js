// F2 backend: tests for ElectronSessionStore.truncateAfterMessage,
// SessionShadowStore.truncateAfterMessage, TurnEventJournal.purgeTurnsAfter,
// and backendService.editUserMessageAndTruncate (via direct call against the
// session store, without spinning up the full BackendService).
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
} = require('../services/backend/electron-session-store');
const {
  SessionShadowStore,
} = require('../services/backend/session-shadow-store');
const {
  TurnEventJournal,
} = require('../services/backend/turn-event-journal');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const {
  freshStore,
  seedConversation,
} = require('./helpers/session-truncate-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('truncateAfterMessage returns null when the session does not exist', () => {
  const { store } = freshStore();
  const result = store.truncateAfterMessage('not_a_session', 'msg_user_1', {});
  assert.equal(result, null);
});

test('truncateAfterMessage returns null when the message id is missing or unknown', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  assert.equal(store.truncateAfterMessage(sessionId, '', {}), null);
  assert.equal(store.truncateAfterMessage(sessionId, 'nope_msg_id', {}), null);
});

test('truncateAfterMessage refuses non-user roles (defensive)', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  const result = store.truncateAfterMessage(sessionId, 'msg_ai_1', {});
  assert.equal(result, null);
  // History should be untouched.
  const session = store.getSession(sessionId);
  assert.equal(session.messages.length, 4);
});

test('truncateAfterMessage with no content patch keeps messages up to and including the target', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  const summary = store.truncateAfterMessage(sessionId, 'msg_user_2', {});
  assert.ok(summary);
  const session = store.getSession(sessionId);
  assert.equal(session.messages.length, 3);
  assert.deepEqual(session.messages.map((m) => m.id), ['msg_user_1', 'msg_ai_1', 'msg_user_2']);
  // Content unchanged because no replaceMessageContent provided.
  assert.equal(session.messages[2].content, 'second prompt');
});

test('truncateAfterMessage with replaceMessageContent patches the target in place', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  const summary = store.truncateAfterMessage(sessionId, 'msg_user_2', {
    replaceMessageContent: 'edited prompt',
  });
  assert.ok(summary);
  const session = store.getSession(sessionId);
  assert.equal(session.messages.length, 3);
  assert.equal(session.messages[2].id, 'msg_user_2');
  assert.equal(session.messages[2].content, 'edited prompt');
  assert.equal(session.messages[2].timestamp, '2026-05-11T10:00:02.000Z');
});

// CTL-001 contract: truncation is whole-turn and boundary-explicit. The edited
// target's turn is DISCARDED (its old user payload, assistant text, reasoning,
// tool and approval events are all stale after an edit), every later turn is
// discarded, and turns strictly before the boundary survive in full. The
// edited message itself survives patched in messages[]; the resend turn
// re-anchors it with a fresh user event.
test('truncateAfterMessage drops the edited target turn and keeps prior turns in full', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  store.truncateAfterMessage(sessionId, 'msg_user_2', {
    replaceMessageContent: 'edited',
  });
  const session = store.getSession(sessionId);
  const turnIds = new Set(session.turn_events.map((e) => e.turn_id));
  assert.deepEqual(Array.from(turnIds), ['turn_1'], 'the edited turn_2 must be discarded whole');
  assert.equal(session.turn_events.length, 2, 'turn_1 survives with both of its events');
  const payloadDump = JSON.stringify(session.turn_events.map((e) => e.payload));
  assert.ok(!payloadDump.includes('second prompt'), 'the pre-edit prompt payload must not survive');
  assert.ok(!payloadDump.includes('second reply'), 'the deleted reply payload must not survive');
});

test('truncateAfterMessage on the first prompt discards every turn', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  // The first turn IS the target turn: its events are stale; turn_2 is later.
  store.truncateAfterMessage(sessionId, 'msg_user_1', {
    replaceMessageContent: 'edited first',
  });
  const session = store.getSession(sessionId);
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].content, 'edited first');
  assert.deepEqual(session.turn_events, [], 'no event of the target turn or later turns may survive');
});

test('truncateAfterMessage on the last prompt of a three-turn session keeps both prior turns intact', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  store.appendMessage(sessionId, {
    id: 'msg_user_3', role: 'user', content: 'third prompt', timestamp: '2026-05-11T10:00:04.000Z',
  });
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'turn_3:user_bubble:0', turn_id: 'turn_3', kind: 'user_prompt',
      primary_message_id: 'msg_user_3', source_message_ids: ['msg_user_3'], payload: { content: 'third prompt' },
    },
  ]);
  store.truncateAfterMessage(sessionId, 'msg_user_3', { replaceMessageContent: 'edited third' });
  const session = store.getSession(sessionId);
  const turnIds = [...new Set(session.turn_events.map((e) => e.turn_id))];
  assert.deepEqual(turnIds, ['turn_1', 'turn_2'], 'both prior turns survive in full');
  assert.equal(session.turn_events.length, 4);
});

test('truncateAfterMessage keeps a no-primary marker event of a surviving prior turn', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  store.appendTurnEvents(sessionId, [
    {
      event_id: 'turn_1:marker:0', turn_id: 'turn_1', kind: 'turn_events_compacted',
      primary_message_id: '', source_message_ids: [], payload: { compacted_count: 3 },
    },
  ]);
  store.truncateAfterMessage(sessionId, 'msg_user_2', { replaceMessageContent: 'edited' });
  const session = store.getSession(sessionId);
  assert.ok(
    session.turn_events.some((e) => e.kind === 'turn_events_compacted'),
    'a marker event with no primary id survives with its (prior) turn',
  );
});

test('truncateAfterMessage clears active_turn so any in-flight stream is abandoned', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  store.updateSession(sessionId, {
    active_turn: {
      turn_id: 'turn_3',
      status: 'streaming',
      stream_id: 'stream_active',
    },
  });
  store.truncateAfterMessage(sessionId, 'msg_user_2', { replaceMessageContent: 'edited' });
  const session = store.getSession(sessionId);
  assert.equal(session.active_turn, null);
});

test('truncateAfterMessage preserves message_seq_counter and turn_event_seq_counter (no reset)', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  const before = store.getSession(sessionId);
  const beforeMessageSeq = before.message_seq_counter;
  const beforeTurnEventSeq = before.turn_event_seq_counter;
  assert.ok(beforeMessageSeq > 0);
  assert.ok(beforeTurnEventSeq > 0);
  store.truncateAfterMessage(sessionId, 'msg_user_1', { replaceMessageContent: 'edited' });
  const after = store.getSession(sessionId);
  assert.equal(after.message_seq_counter, beforeMessageSeq, 'message_seq_counter must NOT reset');
  assert.equal(after.turn_event_seq_counter, beforeTurnEventSeq, 'turn_event_seq_counter must NOT reset');
});

test('truncateAfterMessage updates last_message_preview to reflect the new tail', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  store.truncateAfterMessage(sessionId, 'msg_user_2', {
    replaceMessageContent: 'edited prompt body',
  });
  const summary = store.listSessions().find((s) => s.id === sessionId);
  assert.ok(summary);
  assert.match(summary.last_message_preview, /edited prompt body/);
});

test('truncateAfterMessage with empty content patches to empty string but keeps the message slot', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  store.truncateAfterMessage(sessionId, 'msg_user_2', { replaceMessageContent: '' });
  const session = store.getSession(sessionId);
  assert.equal(session.messages.length, 3);
  assert.equal(session.messages[2].id, 'msg_user_2');
  assert.equal(session.messages[2].content, '');
});

test('SessionShadowStore.truncateAfterMessage mirrors the primary contract', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-truncate-shadow-'));
  trackDirectory(userDataPath);
  const shadow = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));
  shadow.upsertSession('sess_shadow', {
    title: 'Shadow',
    messages: [
      { id: 'msg_user_1', role: 'user', content: 'one', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'msg_ai_1', role: 'assistant', content: 'reply one', timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 'msg_user_2', role: 'user', content: 'two', timestamp: '2026-01-01T00:00:02.000Z' },
    ],
    turn_events: [
      {
        event_id: 'e1', turn_id: 'turn_1', kind: 'user_bubble',
        primary_message_id: 'msg_user_1', source_message_ids: ['msg_user_1'], payload: {},
      },
      {
        event_id: 'e2', turn_id: 'turn_1', kind: 'assistant_text_segment',
        primary_message_id: 'msg_ai_1', source_message_ids: ['msg_user_1'], payload: {},
      },
      {
        event_id: 'e3', turn_id: 'turn_2', kind: 'user_bubble',
        primary_message_id: 'msg_user_2', source_message_ids: ['msg_user_2'], payload: {},
      },
    ],
  });
  // Refuses non-user.
  assert.equal(shadow.truncateAfterMessage('sess_shadow', 'msg_ai_1', {}), null);
  // Refuses unknown session/message.
  assert.equal(shadow.truncateAfterMessage('nope', 'msg_user_1', {}), null);
  assert.equal(shadow.truncateAfterMessage('sess_shadow', 'nope', {}), null);
  // Happy path: editing the first prompt makes turn_1 the target turn — its
  // stale events are discarded whole, and later turn_2 goes with it (CTL-001).
  const summary = shadow.truncateAfterMessage('sess_shadow', 'msg_user_1', {
    replaceMessageContent: 'edited one',
  });
  assert.ok(summary);
  const session = shadow.getSession('sess_shadow');
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].content, 'edited one');
  assert.deepEqual(session.turn_events, [], 'target turn and later turns are discarded whole');
});

test('TurnEventJournal.purgeTurnsAfter drops only non-surviving turn ids', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-truncate-journal-'));
  trackDirectory(userDataPath);
  const journal = new TurnEventJournal(path.join(userDataPath, 'journal.json'));
  journal.append('sess_J', 'turn_keep', [{ event_id: 'k1' }]);
  journal.append('sess_J', 'turn_drop', [{ event_id: 'd1' }]);
  journal.append('sess_J', 'turn_also_drop', [{ event_id: 'd2' }]);

  const { purged } = journal.purgeTurnsAfter('sess_J', new Set(['turn_keep']));
  assert.equal(purged, 2);

  assert.equal(journal.list('sess_J', 'turn_keep').length, 1);
  assert.equal(journal.list('sess_J', 'turn_drop').length, 0);
  assert.equal(journal.list('sess_J', 'turn_also_drop').length, 0);
});

test('TurnEventJournal.purgeTurnsAfter is a no-op when no turns drop', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-truncate-journal-noop-'));
  trackDirectory(userDataPath);
  const journal = new TurnEventJournal(path.join(userDataPath, 'journal.json'));
  journal.append('sess_J', 'turn_a', [{ event_id: 'a1' }]);
  journal.append('sess_J', 'turn_b', [{ event_id: 'b1' }]);

  const result = journal.purgeTurnsAfter('sess_J', new Set(['turn_a', 'turn_b']));
  assert.equal(result.purged, 0);
  assert.equal(journal.list('sess_J', 'turn_a').length, 1);
  assert.equal(journal.list('sess_J', 'turn_b').length, 1);
});

test('TurnEventJournal.purgeTurnsAfter accepts an array argument', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-truncate-journal-array-'));
  trackDirectory(userDataPath);
  const journal = new TurnEventJournal(path.join(userDataPath, 'journal.json'));
  journal.append('sess_J', 'turn_x', [{ event_id: 'x1' }]);
  journal.append('sess_J', 'turn_y', [{ event_id: 'y1' }]);
  const { purged } = journal.purgeTurnsAfter('sess_J', ['turn_x']);
  assert.equal(purged, 1);
});

test('editUserMessageAndTruncate via backendService composes store + shadow + journal', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-sessions');
  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Composed' });
  seedConversation(store, sessionId);
  const shadowPath = path.join(userDataPath, 'shadow-sessions.json');
  const shadowStore = new SessionShadowStore(shadowPath);
  // Mirror the seeded session into the shadow store.
  shadowStore.upsertSession(sessionId, {
    title: 'Composed',
    messages: store.getSession(sessionId).messages,
    turn_events: store.getSession(sessionId).turn_events,
  });
  const journal = new TurnEventJournal(path.join(userDataPath, 'journal.json'));
  journal.append(sessionId, 'turn_1', [{ event_id: 'j1' }]);
  journal.append(sessionId, 'turn_2', [{ event_id: 'j2' }]);

  const service = {
    sessionStore: store,
    shadowStore,
    turnEventJournal: journal,
  };

  const summary = await editUserMessageAndTruncate(service, sessionId, 'msg_user_1', {
    content: 'edited first prompt',
  });
  assert.ok(summary);
  const after = store.getSession(sessionId);
  assert.equal(after.messages.length, 1);
  assert.equal(after.messages[0].content, 'edited first prompt');
  // Shadow mirrored.
  const shadowAfter = shadowStore.getSession(sessionId);
  assert.equal(shadowAfter.messages.length, 1);
  assert.equal(shadowAfter.messages[0].content, 'edited first prompt');
  // Editing the first prompt makes turn_1 the target turn, so the journal is
  // purged in lockstep with the store: BOTH turns go (CTL-001).
  assert.equal(journal.list(sessionId, 'turn_1').length, 0);
  assert.equal(journal.list(sessionId, 'turn_2').length, 0);
});

test('editUserMessageAndTruncate durably rolls canonical history back when journal purge fails', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-sessions');
  const { store, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Rollback' });
  seedConversation(store, sessionId);
  const before = store.getSession(sessionId);
  const shadowStore = new SessionShadowStore(path.join(userDataPath, 'shadow-rollback.json'));
  shadowStore.upsertSession(sessionId, before);
  const shadowBefore = shadowStore.getSession(sessionId);
  const logs = [];
  const result = await editUserMessageAndTruncate({
    sessionStore: store,
    shadowStore,
    turnEventJournal: {
      purgeTurnsAfter() {
        return { ok: false, purged: 0, durable: false, reason: 'disk_failed' };
      },
    },
    _emitServiceLog(level, event, data) { logs.push({ level, event, data }); },
  }, sessionId, 'msg_user_1', { content: 'must roll back' });
  assert.equal(result, null);
  assert.deepEqual(store.getSession(sessionId), before);
  assert.deepEqual(shadowStore.getSession(sessionId), shadowBefore);
  assert.equal(logs.some((entry) => entry.event === 'session.truncate_rolled_back' && entry.data.ok), true);
});

test('editUserMessageAndTruncate restores cache and disk when truncate durability fails', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-sessions');
  const { store, userDataPath } = freshStore({ writeDebounceMs: 60_000 });
  const { id: sessionId } = store.createSession({ title: 'Durability rollback' });
  seedConversation(store, sessionId);
  assert.equal(store.flushSession(sessionId), true);
  const before = store.getSession(sessionId);
  const shadowStore = new SessionShadowStore(path.join(userDataPath, 'shadow-durability.json'));
  shadowStore.upsertSession(sessionId, before);
  let journalCalls = 0;
  const logs = [];
  store.flushSession = () => false;

  const result = await editUserMessageAndTruncate({
    sessionStore: store,
    shadowStore,
    turnEventJournal: {
      purgeTurnsAfter() {
        journalCalls += 1;
        return { ok: true, durable: true, purged: 0 };
      },
    },
    _emitServiceLog(level, event, data) { logs.push({ level, event, data }); },
  }, sessionId, 'msg_user_1', { content: 'must not survive' });

  assert.equal(result, null);
  assert.equal(journalCalls, 0, 'journal purge must wait for positive truncate durability proof');
  assert.deepEqual(store.getSession(sessionId), before);
  const reloaded = new ElectronSessionStore(path.join(userDataPath, 'sessions.json'));
  assert.deepEqual(reloaded.getSession(sessionId), before);
  assert.equal(logs.some((entry) => entry.event === 'session.truncate_rolled_back' && entry.data.ok), true);
});

test('editUserMessageAndTruncate returns null when no session or message id is given', async () => {
  const { editUserMessageAndTruncate } = require('../services/backend/backend-sessions');
  const service = { sessionStore: { getSession: () => null } };
  assert.equal(await editUserMessageAndTruncate(service, '', 'm1', { content: '' }), null);
  assert.equal(await editUserMessageAndTruncate(service, 's1', '', { content: '' }), null);
});
