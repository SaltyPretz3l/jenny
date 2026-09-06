const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// Lines 59-60: createLocalMessage returns null when normalizeMessageFields returns null
// appendLocalMessage skips messages that produce null from createLocalMessage
test('session shadow store appendLocalMessage skips messages that fail normalization (null content, no role)', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-null-msg-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  // Provide a message with no content and no valid field that createLocalMessage/normalizeMessageFields can use.
  // normalizeMessageFields returns null when every field normalizes to empty/null (no content, no turn data).
  const before = store.upsertSession('sess_null_msg', { title: 'Null Msg' });
  // appendLocalMessage calls createLocalMessage; if hasMeaningfulMessageContent returns false it bails.
  // To test the null-message path, provide null content and no structured fields.
  const after = store.appendLocalMessage('sess_null_msg', { role: 'assistant', content: '' });

  // Session is returned unchanged because message had no meaningful content
  assert.equal(after.title, 'Null Msg');
  assert.equal(after.messages.length, 0);
  assert.equal(before.message_count, after.message_count);
});

test('session shadow store late appends do not resurrect a missing session', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-no-resurrect-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  const result = store.appendLocalMessage('sess_deleted', {
    role: 'assistant',
    content: 'Late completion',
  });

  assert.equal(result, null);
  assert.equal(store.getSession('sess_deleted'), null);
});

// Lines 133-134: stream_error makes hasMeaningfulMessageContent return true
test('session shadow store appendLocalMessage includes messages with stream_error and no content', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-stream-err-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));
  store.upsertSession('sess_stream_err', {});

  const result = store.appendLocalMessage('sess_stream_err', {
    role: 'assistant',
    content: '',
    stream_error: 'Connection lost',
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].stream_error, 'Connection lost');
  assert.equal(result.message_count, 1);
});

// Lines 140-141: isPlainUserAssistantMessage returns false for non-object input
// prunePersistedPlainMessages relies on isPlainUserAssistantMessage; non-object messages are retained
test('session shadow store prunePersistedPlainMessages returns session unchanged when ids set is empty', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-prune-empty-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_prune_empty', {
    messages: [
      { id: 'msg_a', role: 'user', content: 'Hello' },
    ],
    message_count: 1,
  });

  // Empty clientMessageIds set means nothing to prune: returns session as-is
  const result = store.prunePersistedPlainMessages('sess_prune_empty', []);
  assert.ok(result);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, 'msg_a');
});

// Lines 290-314: _write - deleteSession path when a session is removed from incoming
test('session shadow store _write deletes sessions not present in incoming payload', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-write-del-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_keep', { title: 'Keep' });
  store.upsertSession('sess_delete', { title: 'Delete' });

  assert.ok(store.getSession('sess_keep'));
  assert.ok(store.getSession('sess_delete'));

  // _write with only sess_keep should delete sess_delete
  const keepSnapshot = store.getSession('sess_keep');
  store._write({
    sessions: {
      sess_keep: keepSnapshot,
    },
  });

  assert.ok(store.getSession('sess_keep'));
  assert.equal(store.getSession('sess_delete'), null);
});

// Lines 290-314: _write with invalid payload shape uses empty sessions
test('session shadow store _write with non-object sessions treats as empty and deletes existing', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-write-invalid-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_to_clear', { title: 'Clear Me' });
  assert.ok(store.getSession('sess_to_clear'));

  // Passing null/invalid payload: incoming resolves to {} so all sessions are deleted
  store._write({ sessions: null });

  assert.equal(store.getSession('sess_to_clear'), null);
});

// Lines 321-336: _withSessionMutation returns null when mutator returns non-object
test('session shadow store _withSessionMutation returns null for array mutator result', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-mutate-bad-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  // Directly call _withSessionMutation with a function mutator that returns an array (invalid patch)
  const result = store._withSessionMutation('sess_bad_mutate', () => ['not', 'an', 'object']);
  assert.equal(result, null);
  // Session should not exist since mutator returned bad value
  assert.equal(store.getSession('sess_bad_mutate'), null);
});

// Lines 321-336: _withSessionMutation returns null when mutator returns null
test('session shadow store _withSessionMutation returns null for null mutator result', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-mutate-null-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  const result = store._withSessionMutation('sess_null_mutate', () => null);
  assert.equal(result, null);
  assert.equal(store.getSession('sess_null_mutate'), null);
});

test('session shadow store normalizes malformed durable turn generations', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-turn-generation-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));
  store.upsertSession('sess_generation', { turn_generation: 'not-a-number' });
  assert.equal(store.getSession('sess_generation').turn_generation, 0);
  store.setTurnIdentity('sess_generation', {
    session_incarnation: 'inc_test', turn_generation: -4,
  });
  assert.equal(store.getSession('sess_generation').turn_generation, 0);
});

// Lines 453-454: appendLocalMessage returns early if normalized message has no meaningful content
test('session shadow store appendLocalMessage returns unchanged session for empty-content assistant message', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-append-empty-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_append_empty', {
    title: 'Empty Test',
    messages: [{ id: 'msg_existing', role: 'user', content: 'Prior message' }],
    message_count: 1,
    last_message_preview: 'Prior message',
  });

  const result = store.appendLocalMessage('sess_append_empty', {
    role: 'assistant',
    content: '',
  });

  // Returns session unchanged — no new messages added
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, 'msg_existing');
  assert.equal(result.message_count, 1);
  assert.equal(result.last_message_preview, 'Prior message');
});

// Lines 484-485: appendTurnEvents skips events where normalizeTurnEvent returns null
test('session shadow store appendTurnEvents skips events that fail normalization', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-turn-skip-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_turn_skip', { title: 'Turn Skip' });

  // Pass an invalid event (null) alongside a valid one
  const validEvent = {
    event_id: 'turn_skip:user_prompt:0',
    turn_id: 'turn_skip',
    kind: 'user_prompt',
    primary_message_id: 'user_skip',
    source_message_ids: ['user_skip'],
    payload: { content: 'hi', attachments: [] },
  };

  store.appendTurnEvents('sess_turn_skip', [null, validEvent, null]);

  const session = store.getSession('sess_turn_skip');
  // Only the valid event should be appended; nulls are skipped
  assert.equal(session.turn_events.length, 1);
  assert.equal(session.turn_events[0].event_id, 'turn_skip:user_prompt:0');
  assert.equal(session.turn_event_seq_counter, 1);
});

// Lines 522-528: updateMessage returns null when session doesn't exist
test('session shadow store updateMessage returns null when session does not exist', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-update-no-sess-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  const result = store.updateMessage('sess_nonexistent', 'msg_123', { content: 'new' });
  assert.equal(result, null);
});

// Lines 522-528: updateMessage returns null when messageId is empty
test('session shadow store updateMessage returns null when messageId is empty string', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-update-empty-id-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_update_empty', {
    messages: [{ id: 'msg_a', role: 'user', content: 'Hello' }],
    message_count: 1,
  });

  const result = store.updateMessage('sess_update_empty', '', { content: 'changed' });
  assert.equal(result, null);
});

// Lines 549-550: updateMessage returns null when the target message is not found
test('session shadow store updateMessage returns null when message id not found in session', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-update-notfound-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_update_notfound', {
    messages: [{ id: 'msg_a', role: 'user', content: 'Hello' }],
    message_count: 1,
  });

  const result = store.updateMessage('sess_update_notfound', 'msg_does_not_exist', { content: 'x' });
  assert.equal(result, null);
});

// Lines 569-570: truncateAfterMessage returns null when session doesn't exist
test('session shadow store truncateAfterMessage returns null for missing session', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-trunc-nosess-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  const result = store.truncateAfterMessage('sess_nonexistent', 'msg_any');
  assert.equal(result, null);
});

// Lines 569-570: truncateAfterMessage returns null when messageId is empty
test('session shadow store truncateAfterMessage returns null for empty messageId', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-trunc-empty-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_trunc_empty', {
    messages: [{ id: 'msg_a', role: 'user', content: 'Hello' }],
    message_count: 1,
  });

  const result = store.truncateAfterMessage('sess_trunc_empty', '');
  assert.equal(result, null);
});

// truncateAfterMessage returns null when target message id is not found
test('session shadow store truncateAfterMessage returns null when message not found', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-trunc-notfound-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_trunc_notfound', {
    messages: [{ id: 'msg_a', role: 'user', content: 'Hello' }],
    message_count: 1,
  });

  const result = store.truncateAfterMessage('sess_trunc_notfound', 'msg_missing');
  assert.equal(result, null);
});

// Lines 595-596: truncateAfterMessage returns null when target message is not role:user
test('session shadow store truncateAfterMessage returns null when target message is not user role', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-trunc-notrole-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_trunc_role', {
    messages: [
      { id: 'user_1', role: 'user', content: 'Ask' },
      { id: 'asst_1', role: 'assistant', content: 'Answer' },
    ],
    message_count: 2,
  });

  // Try to truncate at an assistant message — should return null
  const result = store.truncateAfterMessage('sess_trunc_role', 'asst_1');
  assert.equal(result, null);
});

// truncateAfterMessage with replaceMessageContent and replaceMessageAttachments options
test('session shadow store truncateAfterMessage applies content and attachment replacements', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-trunc-replace-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_trunc_replace', {
    messages: [
      { id: 'user_1', role: 'user', content: 'Original question' },
      { id: 'asst_1', role: 'assistant', content: 'Original answer' },
    ],
    message_count: 2,
  });

  const result = store.truncateAfterMessage('sess_trunc_replace', 'user_1', {
    replaceMessageContent: 'Edited question',
    replaceMessageAttachments: [{ type: 'file', name: 'test.txt' }],
  });

  assert.ok(result);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, 'user_1');
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].content, 'Edited question');
  // The replaceMessageAttachments path injected exactly one attachment, which
  // createLocalMessage normalized into a structured attachment record (the raw
  // {type,name} is replaced by normalized fields, so assert on those concretely).
  assert.equal(result.messages[0].attachments.length, 1);
  const attachment = result.messages[0].attachments[0];
  assert.equal(attachment.kind, 'text');
  assert.equal(typeof attachment.id, 'string');
  assert.ok(attachment.id.startsWith('attachment_'));
  assert.equal(result.last_message_preview, 'Edited question');
});

// Lines 635-657: prunePersistedPlainMessages returns null when session doesn't exist
test('session shadow store prunePersistedPlainMessages returns null for missing session', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-prune-nosess-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  const result = store.prunePersistedPlainMessages('sess_nonexistent', ['msg_a']);
  assert.equal(result, null);
});

// Lines 635-657: prunePersistedPlainMessages prunes matching plain user/assistant messages
test('session shadow store prunePersistedPlainMessages removes matching plain messages', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-prune-match-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_prune_match', {
    messages: [
      { id: 'msg_a', role: 'user', content: 'First' },
      { id: 'msg_b', role: 'assistant', content: 'Second' },
      { id: 'msg_c', role: 'user', content: 'Third' },
    ],
    message_count: 3,
  });

  // Prune msg_a and msg_b (plain user/assistant messages)
  const result = store.prunePersistedPlainMessages('sess_prune_match', ['msg_a', 'msg_b']);

  assert.ok(result);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, 'msg_c');
  assert.equal(result.message_count, 1);
});

// Lines 655-656: prunePersistedPlainMessages returns session unchanged when nothing to prune
test('session shadow store prunePersistedPlainMessages returns unchanged session when no ids match', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-prune-nomatch-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_prune_nomatch', {
    messages: [
      { id: 'msg_z', role: 'user', content: 'Keep' },
    ],
    message_count: 1,
  });

  const before = store.getSession('sess_prune_nomatch');
  const result = store.prunePersistedPlainMessages('sess_prune_nomatch', ['msg_x', 'msg_y']);

  // No ids matched, so the early-return path returns the session as-is without
  // an upsert: content is unchanged AND updated_at is NOT bumped (an upsert with
  // default bumpUpdatedAt:true would rewrite updated_at via nowIso()).
  assert.ok(result);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].id, 'msg_z');
  assert.equal(result.messages[0].content, 'Keep');
  assert.equal(result.message_count, before.message_count);
  assert.equal(result.updated_at, before.updated_at);
});

// Lines 667-668: setSessionPreferences with non-object preferences
test('session shadow store setSessionPreferences with null preferences upserts with empty patch', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-prefs-null-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_prefs_null', { title: 'Prefs Null', preferred_model: 'model-a' });

  // null preferences triggers the early return path (line 667-668)
  const result = store.setSessionPreferences('sess_prefs_null', null);
  assert.ok(result);
  assert.equal(result.title, 'Prefs Null');
  // Existing preferred_model should still be present (empty patch applied)
  assert.equal(result.preferred_model, 'model-a');
});

// Lines 667-668: setSessionPreferences with non-object (string) triggers early return
test('session shadow store setSessionPreferences with string preferences upserts with empty patch', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-prefs-str-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_prefs_str', { title: 'Str Prefs' });
  const result = store.setSessionPreferences('sess_prefs_str', 'bad-prefs');
  assert.ok(result);
  assert.equal(result.title, 'Str Prefs');
});

// Lines 711-720: touchActiveTurn returns null when no active turn exists
test('session shadow store touchActiveTurn returns null when session has no active turn', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-touch-noactive-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_touch_no_turn', { title: 'No Turn' });

  const result = store.touchActiveTurn('sess_touch_no_turn', {}, {});
  assert.equal(result, null);
});

// Lines 711-720: touchActiveTurn returns null when request_id does not match
test('session shadow store touchActiveTurn returns null when request_id does not match', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-touch-reqmismatch-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  // normalizeActiveTurn requires request_id, stream_id, user_message_id, started_at, last_event_at, status
  store.upsertSession('sess_touch_req', {
    title: 'Req Mismatch',
    active_turn: {
      request_id: 'req_actual',
      stream_id: 'stream_actual',
      user_message_id: 'user_1',
      started_at: '2026-01-01T00:00:00.000Z',
      last_event_at: '2026-01-01T00:00:01.000Z',
      status: 'streaming',
    },
  });

  // match.request_id differs from the active turn's request_id
  const result = store.touchActiveTurn('sess_touch_req', { request_id: 'req_wrong' }, {});
  assert.equal(result, null);

  // Active turn is unchanged
  const session = store.getSession('sess_touch_req');
  assert.equal(session.active_turn.request_id, 'req_actual');
});

// Lines 711-720: touchActiveTurn returns null when stream_id does not match
test('session shadow store touchActiveTurn returns null when stream_id does not match', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-touch-streammismatch-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_touch_stream', {
    title: 'Stream Mismatch',
    active_turn: {
      request_id: 'req_ok',
      stream_id: 'stream_actual',
      user_message_id: 'user_1',
      started_at: '2026-01-01T00:00:00.000Z',
      last_event_at: '2026-01-01T00:00:01.000Z',
      status: 'streaming',
    },
  });

  const result = store.touchActiveTurn('sess_touch_stream', { stream_id: 'stream_wrong' }, {});
  assert.equal(result, null);

  // Active turn is still set
  const session = store.getSession('sess_touch_stream');
  assert.equal(session.active_turn.request_id, 'req_ok');
});

// touchActiveTurn succeeds when request_id and stream_id both match
test('session shadow store touchActiveTurn updates status when ids match', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-touch-ok-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_touch_ok', {
    title: 'Touch OK',
    active_turn: {
      request_id: 'req_match',
      stream_id: 'stream_match',
      user_message_id: 'user_1',
      started_at: '2026-01-01T00:00:00.000Z',
      last_event_at: '2026-01-01T00:00:01.000Z',
      status: 'streaming',
    },
  });

  const result = store.touchActiveTurn(
    'sess_touch_ok',
    { request_id: 'req_match', stream_id: 'stream_match' },
    { status: 'awaiting_assistant' }
  );
  assert.ok(result);
  // The matched turn is updated in place: identity fields preserved...
  assert.equal(result.active_turn.request_id, 'req_match');
  assert.equal(result.active_turn.stream_id, 'stream_match');
  assert.equal(result.active_turn.user_message_id, 'user_1');
  assert.equal(result.active_turn.started_at, '2026-01-01T00:00:00.000Z');
  // ...the status patch is normalized and actually applied (streaming -> awaiting_assistant)...
  assert.equal(result.active_turn.status, 'awaiting_assistant');
  // ...and last_event_at advances to a fresh timestamp strictly later than the seeded one.
  assert.notEqual(result.active_turn.last_event_at, '2026-01-01T00:00:01.000Z');
  assert.ok(
    new Date(result.active_turn.last_event_at).getTime()
      > new Date('2026-01-01T00:00:01.000Z').getTime()
  );

  // An invalid status token (not awaiting_assistant/streaming) is rejected by
  // normalizeActiveTurnStatus and falls back to the current status rather than
  // being written through verbatim.
  const rejected = store.touchActiveTurn(
    'sess_touch_ok',
    { request_id: 'req_match', stream_id: 'stream_match' },
    { status: 'complete' }
  );
  assert.ok(rejected);
  assert.equal(rejected.active_turn.status, 'awaiting_assistant');
});

// Lines 746-778: clearActiveTurn returns null when no active turn exists
test('session shadow store clearActiveTurn returns null when session has no active turn', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-clear-noactive-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_clear_no_turn', { title: 'No Turn' });
  const result = store.clearActiveTurn('sess_clear_no_turn', {});
  assert.equal(result, null);
});

// F-06 containment (parity with ElectronSessionStore): a bare empty match is
// refused outright — it must never wildcard-clear whichever turn is current.
test('session shadow store clearActiveTurn refuses a bare empty match instead of wildcard-clearing', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-clear-emptymatch-'));
  trackDirectory(userDataPath);
  const logs = [];
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'), {
    logger: (level, event, payload) => logs.push({ level, event, payload }),
  });

  store.upsertSession('sess_clear_empty', {
    active_turn: {
      request_id: 'req_owner',
      stream_id: 'stream_owner',
      user_message_id: 'user_1',
      started_at: '2026-01-01T00:00:00.000Z',
      last_event_at: '2026-01-01T00:00:01.000Z',
      status: 'streaming',
    },
  });

  const result = store.clearActiveTurn('sess_clear_empty', {});
  assert.equal(result, null);

  const session = store.getSession('sess_clear_empty');
  assert.ok(session.active_turn, 'the owning turn survives an identity-less clear attempt');
  assert.equal(session.active_turn.request_id, 'req_owner');
  assert.ok(
    logs.some((entry) => entry.event === 'shadow_store.clear_active_turn_refused_empty_match'),
    'the refusal is logged as a structured WARN'
  );

  // A properly identified clear still works.
  const cleared = store.clearActiveTurn('sess_clear_empty', {
    request_id: 'req_owner',
    stream_id: 'stream_owner',
  });
  assert.ok(cleared);
  assert.equal(store.getSession('sess_clear_empty').active_turn, null);
});

// Lines 746-778: clearActiveTurn returns null when request_id does not match
test('session shadow store clearActiveTurn returns null when request_id does not match', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-clear-reqmismatch-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_clear_req', {
    active_turn: {
      request_id: 'req_actual',
      stream_id: 'stream_actual',
      user_message_id: 'user_1',
      started_at: '2026-01-01T00:00:00.000Z',
      last_event_at: '2026-01-01T00:00:01.000Z',
      status: 'streaming',
    },
  });

  const result = store.clearActiveTurn('sess_clear_req', { request_id: 'req_wrong' });
  assert.equal(result, null);

  // active_turn still present and unchanged
  const session = store.getSession('sess_clear_req');
  assert.ok(session.active_turn);
  assert.equal(session.active_turn.request_id, 'req_actual');
});

// Lines 746-778: clearActiveTurn returns null when stream_id does not match
test('session shadow store clearActiveTurn returns null when stream_id does not match', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-clear-streammismatch-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_clear_stream', {
    active_turn: {
      request_id: 'req_ok',
      stream_id: 'stream_actual',
      user_message_id: 'user_1',
      started_at: '2026-01-01T00:00:00.000Z',
      last_event_at: '2026-01-01T00:00:01.000Z',
      status: 'streaming',
    },
  });

  const result = store.clearActiveTurn('sess_clear_stream', { stream_id: 'stream_wrong' });
  assert.equal(result, null);

  const session = store.getSession('sess_clear_stream');
  assert.ok(session.active_turn);
  assert.equal(session.active_turn.request_id, 'req_ok');
});

// clearActiveTurn clears when match conditions are met
test('session shadow store clearActiveTurn clears active turn when ids match', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-clear-ok-'));
  trackDirectory(userDataPath);
  const store = new SessionShadowStore(path.join(userDataPath, 'shadow-sessions.json'));

  store.upsertSession('sess_clear_ok', {
    active_turn: {
      request_id: 'req_match',
      stream_id: 'stream_match',
      user_message_id: 'user_1',
      started_at: '2026-01-01T00:00:00.000Z',
      last_event_at: '2026-01-01T00:00:01.000Z',
      status: 'streaming',
    },
  });

  const result = store.clearActiveTurn('sess_clear_ok', {
    request_id: 'req_match',
    stream_id: 'stream_match',
  });
  assert.ok(result);
  assert.equal(result.active_turn, null);
});
