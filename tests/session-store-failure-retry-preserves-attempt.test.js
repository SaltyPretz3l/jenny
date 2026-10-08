'use strict';

// Owner report, 2026-08-26: "ended with a retry-able error, so I did and lost
// all the history of the first try".
//
// Retry is routed through edit-and-regenerate (renderer-shell-runtime-utils.js
// hands a retry action to handleRegenerateMessage, which sends editedMessageId),
// so it lands on truncateAfterMessage and takes the CTL-001 edit boundary with
// it: the failed attempt's assistant text, reasoning, tool calls, results and
// approvals are all discarded. That is CORRECT for an edited prompt -- stale
// pre-edit history must never rehydrate under a new prompt -- and wrong for an
// unchanged retry, where the user wants the work back.
//
// Owner decision, 2026-08-26: the failed attempt stays, AND the retry builds on
// it, so a turn that died after ~50 tool calls does not redo them.
//
// So truncateAfterMessage grows a second mode rather than losing its first one.
// Both stores implement it through the same shared helper, because their own
// comments say the boundary rule must not drift between the primary store and
// its recovery mirror.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');
const { freshStore, seedConversation } = require('./helpers/session-truncate-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('a failure retry keeps the failed attempt in messages and turn events', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);

  // msg_user_2 is the prompt whose turn failed; msg_ai_2 / turn_2 are the
  // attempt the owner lost. The prompt is UNCHANGED -- a retry, not an edit.
  const summary = store.truncateAfterMessage(sessionId, 'msg_user_2', {
    replaceMessageContent: 'second prompt',
    preserveActiveTurn: true,
    preserveSupersededTurn: true,
  });
  assert.ok(summary, 'the re-anchor must still report a persisted user summary');

  const session = store.getSession(sessionId);
  assert.deepEqual(
    session.messages.map((message) => message.id),
    ['msg_user_1', 'msg_ai_1', 'msg_user_2', 'msg_ai_2'],
    'the failed attempt must survive the retry'
  );
  assert.deepEqual(
    Array.from(new Set(session.turn_events.map((event) => event.turn_id))),
    ['turn_1', 'turn_2'],
    'the failed turn keeps its events so the transcript can still render it'
  );
  assert.equal(session.turn_events.length, 4, 'no event of the failed turn may be dropped');
  assert.ok(
    JSON.stringify(session.turn_events).includes('second reply'),
    'the failed attempt payload is what the owner wanted back'
  );
});

test('a failure retry leaves the CTL-001 edit boundary untouched for real edits', () => {
  // The A/B that proves the flag is what changes behaviour: same store, same
  // fixture, same target -- only the flag differs.
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);

  store.truncateAfterMessage(sessionId, 'msg_user_2', {
    replaceMessageContent: 'edited prompt',
  });

  const session = store.getSession(sessionId);
  assert.deepEqual(
    session.messages.map((message) => message.id),
    ['msg_user_1', 'msg_ai_1', 'msg_user_2'],
    'an edit still drops everything after the edited prompt'
  );
  assert.deepEqual(
    Array.from(new Set(session.turn_events.map((event) => event.turn_id))),
    ['turn_1'],
    'an edit still discards the boundary turn whole'
  );
});

test('the shadow store mirrors the failure-retry mode', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-retry-shadow-'));
  trackDirectory(userDataPath);
  const shadow = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));
  shadow.upsertSession('sess_shadow', {
    messages: [
      { id: 'msg_user_1', role: 'user', content: 'prompt', timestamp: '2026-05-11T10:00:00.000Z' },
      { id: 'msg_ai_1', role: 'assistant', content: 'failed attempt', timestamp: '2026-05-11T10:00:01.000Z' },
    ],
    message_count: 2,
    turn_events: [
      {
        event_id: 'turn_1:user_bubble:0',
        turn_id: 'turn_1',
        kind: 'user_bubble',
        primary_message_id: 'msg_user_1',
        source_message_ids: ['msg_user_1'],
        payload: { text: 'prompt' },
      },
      {
        event_id: 'turn_1:assistant_text_segment:0',
        turn_id: 'turn_1',
        kind: 'assistant_text_segment',
        primary_message_id: 'msg_ai_1',
        source_message_ids: ['msg_user_1'],
        payload: { text: 'failed attempt' },
      },
    ],
  });

  const summary = shadow.truncateAfterMessage('sess_shadow', 'msg_user_1', {
    replaceMessageContent: 'prompt',
    preserveActiveTurn: true,
    preserveSupersededTurn: true,
  });
  assert.ok(summary, 'the shadow re-anchor must still return a summary');

  const session = shadow.getSession('sess_shadow');
  assert.deepEqual(
    session.messages.map((message) => message.id),
    ['msg_user_1', 'msg_ai_1'],
    'the shadow must not drop the failed attempt while the primary keeps it'
  );
  assert.equal(session.turn_events.length, 2, 'the shadow keeps the failed turn events too');
  assert.deepEqual(
    summary.survivingTurnIds,
    ['turn_1'],
    'the surviving-turn report must include the preserved turn'
  );
});

// JCA-003. Moving the snapshot decision into the shared helper turned out to be
// moving UNTESTED code: perturbing the edit-mode branch to keep the snapshot
// left every suite green. These two give it an oracle, because the branch is
// the difference between a summarized prefix that still describes the history
// and one that describes a message whose text was rewritten underneath it.
function seedBoundarySnapshot(store, sessionId) {
  store.setCompactionSnapshot(sessionId, {
    version: 2,
    origin: 'manual',
    created_at: '2026-05-11T09:00:00.000Z',
    strategy: 'full',
    tokens_before: 4000,
    tokens_after: 900,
    // The snapshot's prefix ends ON the message the retry/edit re-anchors.
    boundary_message_id: 'msg_user_2',
    boundary_message_count: 3,
    messages: [{ role: 'system', content: 'summary of the first exchange' }],
  });
}

test('an edit that rewrites the boundary message drops the compaction snapshot', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  seedBoundarySnapshot(store, sessionId);

  store.truncateAfterMessage(sessionId, 'msg_user_2', { replaceMessageContent: 'edited prompt' });

  assert.equal(
    store.getSession(sessionId).compaction_snapshot,
    null,
    'the summarized prefix ends on a message whose content just changed, so it is stale'
  );
});

test('a failure retry keeps the compaction snapshot it did not invalidate', () => {
  const { store } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'T' });
  seedConversation(store, sessionId);
  seedBoundarySnapshot(store, sessionId);

  store.truncateAfterMessage(sessionId, 'msg_user_2', {
    replaceMessageContent: 'second prompt',
    preserveActiveTurn: true,
    preserveSupersededTurn: true,
  });

  const snapshot = store.getSession(sessionId).compaction_snapshot;
  assert.ok(snapshot, 'a retry rewrote nothing, so throwing the snapshot away would cost tokens');
  assert.equal(snapshot.boundary_message_id, 'msg_user_2');
});
