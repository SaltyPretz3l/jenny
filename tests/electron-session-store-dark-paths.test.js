'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ElectronSessionStore,
  getLocalISODate,
} = require('../services/backend/electron-session-store');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeStore(prefix = 'jenny-dark-paths-') {
  const userDataPath = createTrackedTempDir(prefix);
  const storePath = path.join(userDataPath, 'sessions.json');
  const store = new ElectronSessionStore(storePath);
  return { store, userDataPath, storePath };
}

// ---------------------------------------------------------------------------
// Lines 63-64: getLocalISODate with an invalid date input returns ''
// ---------------------------------------------------------------------------
test('getLocalISODate returns empty string for invalid date input', () => {
  const result = getLocalISODate(new Date('not-a-date'));
  assert.equal(result, '', 'must return empty string for NaN date, not throw or return garbage');
});

test('getLocalISODate returns empty string when string cannot be parsed as a date', () => {
  const result = getLocalISODate('totally-invalid-string');
  assert.equal(result, '', 'must return empty string for unparseable date string');
});

// ---------------------------------------------------------------------------
// Lines 262-263: _read() returns the index snapshot
// ---------------------------------------------------------------------------
test('_read() returns a sessions map that reflects current store state', () => {
  const { store } = makeStore('jenny-dark-read-');
  const created = store.createSession({ title: 'Read Shim' });

  const snapshot = store._read();
  // Must be an object with a sessions map
  assert.ok(snapshot && typeof snapshot === 'object', '_read must return an object');
  assert.ok(snapshot.sessions && typeof snapshot.sessions === 'object', '_read must have a sessions field');
  // The created session must appear in the snapshot
  assert.ok(
    Object.prototype.hasOwnProperty.call(snapshot.sessions, created.id),
    `_read must include the created session id ${created.id}`
  );
  // The title must be correct — not a tautology: we can change the title and verify
  assert.equal(snapshot.sessions[created.id].title, 'Read Shim');
});

// ---------------------------------------------------------------------------
// Lines 271-291: _write() diff-based update shim
// ---------------------------------------------------------------------------
test('_write() with null-like payload treats incoming sessions as empty and deletes all existing', () => {
  const { store } = makeStore('jenny-dark-write-delete-');
  const created = store.createSession({ title: 'To Delete' });

  // _write with an empty payload should remove the existing session
  store._write({});

  const snapshot = store._read();
  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot.sessions || {}, created.id),
    false,
    '_write with empty sessions must delete existing sessions from the index'
  );
  assert.equal(store.getSession(created.id), null);
});

test('_write() upserts new entries not present in cached index', () => {
  const { store } = makeStore('jenny-dark-write-upsert-');
  const created = store.createSession({ title: 'Base' });

  // Add a synthetic new entry via _write
  const snapshot = store._read();
  const newEntry = {
    id: 'sess_synthetic_write',
    title: 'Synthetic',
    session_type: 'chat',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    message_count: 0,
    last_message_preview: '',
    last_model_used: '',
    session_start_date: '',
    preferred_model: '',
    reasoning_effort: 'default',
    conversation_mode: 'chat',
    pending_question_batch: null,
    pending_plan_proposal: null,
    interactive_sequence_state: 'idle',
    interactive_round_count: 0,
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: {},
    linked_session_ids: [],
    branch_origin: null,
  };
  snapshot.sessions['sess_synthetic_write'] = newEntry;
  store._write(snapshot);

  const afterWrite = store._read();
  assert.ok(
    Object.prototype.hasOwnProperty.call(afterWrite.sessions || {}, 'sess_synthetic_write'),
    '_write must upsert new session entries that were not in the cached index'
  );
  // Original entry must still be present (same reference → skipped, not deleted)
  assert.ok(
    Object.prototype.hasOwnProperty.call(afterWrite.sessions || {}, created.id),
    '_write must preserve unchanged sessions by reference equality'
  );
});

test('_write() skips upsert when incoming value is the same reference as cached value', () => {
  const { store } = makeStore('jenny-dark-write-skip-');
  const created = store.createSession({ title: 'Skip Me' });

  let upsertCallCount = 0;
  const originalUpsert = store._backend.upsertSession.bind(store._backend);
  store._backend.upsertSession = (...args) => {
    upsertCallCount += 1;
    return originalUpsert(...args);
  };

  // Pass back exactly the same snapshot — all references are identical
  const snapshot = store._read();
  store._write(snapshot);

  // upsertSession must NOT be called for unchanged sessions (same ref)
  assert.equal(
    upsertCallCount,
    0,
    '_write must skip upsert when incoming value is the same object reference as cached value'
  );
  // Session must still exist after the no-op write
  assert.equal(store.getSession(created.id).title, 'Skip Me');
});

// ---------------------------------------------------------------------------
// Lines 304-305: _withSessionMutation - bad patch (null/array) returns null
// ---------------------------------------------------------------------------
test('_withSessionMutation with null patch returns null without mutating store', () => {
  const { store } = makeStore('jenny-dark-mut-null-');
  const created = store.createSession({ title: 'Stable' });

  // updateSession routes through _withSessionMutation; pass a function mutator
  // that returns null (covers line 304 — patch is null)
  const result = store._updateSessionRecord(created.id, null);
  assert.equal(result, null, 'null patch must return null from _withSessionMutation');
  // Session must remain unchanged
  assert.equal(store.getSession(created.id).title, 'Stable');
});

test('_withSessionMutation with array patch returns null', () => {
  const { store } = makeStore('jenny-dark-mut-arr-');
  const created = store.createSession({ title: 'Array Patch' });

  // Pass an array as patch — the guard rejects it
  const result = store._updateSessionRecord(created.id, ['unexpected']);
  assert.equal(result, null, 'array patch must return null from _withSessionMutation');
  assert.equal(store.getSession(created.id).title, 'Array Patch');
});

// ---------------------------------------------------------------------------
// Lines 317-318: _withSessionMutation - upsertSession returns !ok → null
// ---------------------------------------------------------------------------
test('_withSessionMutation returns null when backend upsertSession rejects the write', () => {
  const { store } = makeStore('jenny-dark-mut-reject-');
  const created = store.createSession({ title: 'Will Fail' });

  // Stub upsertSession to return false (simulating schema-rejected write)
  const originalUpsert = store._backend.upsertSession.bind(store._backend);
  let callCount = 0;
  store._backend.upsertSession = (id, session, opts) => {
    callCount += 1;
    // First call (createSession above already happened) — reject mutation writes
    return false;
  };

  const result = store.updateSession(created.id, { title: 'New Title' });
  assert.equal(result, null, 'must return null when upsertSession returns false');
  assert.ok(callCount >= 1, 'upsertSession stub must have been invoked');
});

// ---------------------------------------------------------------------------
// listSessionRecords dark path: an indexed session whose per-session file is
// missing still yields a summary-shaped record (with a null active_turn), and
// the bulk surface never routes through getSession (that per-id walk churned
// the backend session LRU on every companion/reconciliation pass).
// ---------------------------------------------------------------------------
test('listSessionRecords serves summary records without loading session bodies', () => {
  const { store } = makeStore('jenny-dark-records-fallback-');
  const created = store.createSession({ title: 'Phantom' });

  // Simulate a missing per-session file: drop the in-memory caches and the
  // disk file; only the index summary survives.
  store.flush();
  store._backend._loadedSessions.clear();
  store._backend._scanActiveTurns.clear();
  fs.unlinkSync(store._backend._sessionFilePath(created.id));
  store._backend.getSession = () => {
    throw new Error('listSessionRecords must not load session bodies');
  };

  const records = store.listSessionRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, created.id);
  assert.equal(records[0].title, 'Phantom');
  assert.equal(records[0].active_turn, null);
  // Records must NOT include messages/turn_events (summary never had them)
  assert.equal(Object.prototype.hasOwnProperty.call(records[0], 'messages'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(records[0], 'turn_events'), false);
});

// ---------------------------------------------------------------------------
// Lines 385-386: createSessionWithId with empty/blank id returns null
// ---------------------------------------------------------------------------
test('createSessionWithId returns null for empty string id', () => {
  const { store } = makeStore('jenny-dark-create-empty-id-');
  const result = store.createSessionWithId('', { title: 'Should Fail' });
  assert.equal(result, null, 'empty session id must return null');
  assert.equal(store.listSessions().length, 0, 'no session must be created');
});

test('createSessionWithId returns null for whitespace-only id', () => {
  const { store } = makeStore('jenny-dark-create-blank-id-');
  const result = store.createSessionWithId('   ', { title: 'Should Fail' });
  assert.equal(result, null, 'whitespace-only session id must return null');
  assert.equal(store.listSessions().length, 0);
});

// ---------------------------------------------------------------------------
// Lines 438-439: deleteSession returns false when session does not exist
// ---------------------------------------------------------------------------
test('deleteSession returns false when the session does not exist', () => {
  const { store } = makeStore('jenny-dark-delete-missing-');
  const result = store.deleteSession('sess_nonexistent_example');
  assert.equal(result, false, 'deleteSession must return false for unknown session id');
});

// ---------------------------------------------------------------------------
// Lines 456-457: deleteSession - linked referencing session's getSession returns null → continue
// ---------------------------------------------------------------------------
test('deleteSession continues when a linking session cannot be loaded from the backend', () => {
  const { store } = makeStore('jenny-dark-delete-link-missing-');

  // Create two sessions
  store.createSessionWithId('sess_linker', { title: 'Linker' });
  store.createSessionWithId('sess_target', { title: 'Target' });

  // Set linker to reference target
  store.setSessionPreferences('sess_linker', {
    linked_session_ids: ['sess_target'],
  });

  // Stub getSession to return null for the linker when iterated during delete
  const originalGetSession = store._backend.getSession.bind(store._backend);
  let nulledCount = 0;
  store._backend.getSession = (id) => {
    if (id === 'sess_linker') {
      nulledCount += 1;
      return null;
    }
    return originalGetSession(id);
  };

  // Should not throw; should skip the linker and still delete target
  const result = store.deleteSession('sess_target');
  assert.equal(result, true, 'deleteSession must succeed even if a linker session cannot be loaded');
  assert.ok(nulledCount >= 1, 'getSession must have been called for the linker session');
  assert.equal(store.getSession('sess_target'), null, 'target session must be removed');
});

// ---------------------------------------------------------------------------
// Lines 471-472: deleteSession returns false when backend.deleteSession returns false
// ---------------------------------------------------------------------------
test('deleteSession returns false when backend.deleteSession itself returns false', () => {
  const { store } = makeStore('jenny-dark-delete-backend-false-');
  const created = store.createSession({ title: 'Stubbed Delete' });

  // Stub backend deleteSession to return false after hasSession returns true
  let deleteCalls = 0;
  store._backend.deleteSession = (id) => {
    deleteCalls += 1;
    return false; // simulate backend refusing the delete
  };

  const result = store.deleteSession(created.id);
  assert.equal(result, false, 'deleteSession must return false when backend.deleteSession returns false');
  assert.ok(deleteCalls >= 1, 'backend.deleteSession must have been called');
});

// ---------------------------------------------------------------------------
// Lines 506-507: touchActiveTurn - no active turn → null
// ---------------------------------------------------------------------------
test('touchActiveTurn returns null when session has no active turn', () => {
  const { store } = makeStore('jenny-dark-touch-no-turn-');
  const created = store.createSession({ title: 'No Active Turn' });

  const result = store.touchActiveTurn(created.id, {}, { status: 'streaming' });
  assert.equal(result, null, 'touchActiveTurn must return null when there is no active_turn');
});

test('touchActiveTurn returns null when session does not exist', () => {
  const { store } = makeStore('jenny-dark-touch-missing-session-');

  const result = store.touchActiveTurn('sess_nonexistent_example', {}, { status: 'streaming' });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Lines 511-512: touchActiveTurn - request_id mismatch → null
// ---------------------------------------------------------------------------
test('touchActiveTurn returns null when request_id does not match', () => {
  const { store } = makeStore('jenny-dark-touch-reqid-mismatch-');
  const created = store.createSession({ title: 'Touch Req Mismatch' });

  store.setActiveTurn(created.id, {
    request_id: 'req_correct',
    stream_id: 'stream_1',
    trace_id: 'trace_1',
    user_message_id: 'user_1',
    started_at: '2026-01-01T00:00:00.000Z',
    last_event_at: '2026-01-01T00:00:00.000Z',
    status: 'awaiting_assistant',
  });

  const result = store.touchActiveTurn(
    created.id,
    { request_id: 'req_wrong_example' },
    { status: 'streaming' }
  );
  assert.equal(result, null, 'request_id mismatch must return null from touchActiveTurn');

  // Confirm the active turn is unchanged
  const activeTurn = store.getActiveTurn(created.id);
  assert.equal(activeTurn.status, 'awaiting_assistant');
});

// ---------------------------------------------------------------------------
// Lines 514-515: touchActiveTurn - stream_id mismatch → null
// ---------------------------------------------------------------------------
test('touchActiveTurn returns null when stream_id does not match', () => {
  const { store } = makeStore('jenny-dark-touch-streamid-mismatch-');
  const created = store.createSession({ title: 'Touch Stream Mismatch' });

  store.setActiveTurn(created.id, {
    request_id: 'req_1',
    stream_id: 'stream_correct',
    trace_id: 'trace_1',
    user_message_id: 'user_1',
    started_at: '2026-01-01T00:00:00.000Z',
    last_event_at: '2026-01-01T00:00:00.000Z',
    status: 'awaiting_assistant',
  });

  const result = store.touchActiveTurn(
    created.id,
    { stream_id: 'stream_wrong_example' },
    { status: 'streaming' }
  );
  assert.equal(result, null, 'stream_id mismatch must return null from touchActiveTurn');

  const activeTurn = store.getActiveTurn(created.id);
  assert.equal(activeTurn.status, 'awaiting_assistant');
});

// ---------------------------------------------------------------------------
// Lines 548-549: touchActiveTurn - upsertSession returns !ok → null
// ---------------------------------------------------------------------------
test('touchActiveTurn returns null when backend upsertSession rejects the cache-only write', () => {
  const { store } = makeStore('jenny-dark-touch-upsert-fail-');
  const created = store.createSession({ title: 'Touch Upsert Fail' });

  store.setActiveTurn(created.id, {
    request_id: 'req_tu',
    stream_id: 'stream_tu',
    trace_id: 'trace_tu',
    user_message_id: 'user_tu',
    started_at: '2026-01-01T00:00:00.000Z',
    last_event_at: '2026-01-01T00:00:00.000Z',
    status: 'awaiting_assistant',
  });

  // Stub upsertSession to return false only for cache-only calls (persist=false)
  const originalUpsert = store._backend.upsertSession.bind(store._backend);
  const upsertCalls = [];
  store._backend.upsertSession = (id, session, opts) => {
    upsertCalls.push({ id, persist: opts && opts.persist });
    if (opts && opts.persist === false) {
      return false;
    }
    return originalUpsert(id, session, opts);
  };

  const result = store.touchActiveTurn(
    created.id,
    { request_id: 'req_tu', stream_id: 'stream_tu' },
    { status: 'streaming' }
  );
  assert.equal(result, null, 'touchActiveTurn must return null when upsertSession rejects');
  const cacheOnlyCalls = upsertCalls.filter((c) => c.persist === false);
  assert.ok(cacheOnlyCalls.length >= 1, 'upsertSession must have been called with persist:false');
});

// ---------------------------------------------------------------------------
// Lines 562-563: clearActiveTurn - no active_turn → null
// ---------------------------------------------------------------------------
test('clearActiveTurn returns null when session has no active turn', () => {
  const { store } = makeStore('jenny-dark-clear-no-turn-');
  const created = store.createSession({ title: 'Clear No Turn' });

  const result = store.clearActiveTurn(created.id, {});
  assert.equal(result, null, 'clearActiveTurn must return null when there is no active_turn');
});

test('clearActiveTurn returns null when session does not exist', () => {
  const { store } = makeStore('jenny-dark-clear-missing-session-');
  const result = store.clearActiveTurn('sess_nonexistent_example', {});
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Lines 565-566: clearActiveTurn - request_id mismatch → null
// ---------------------------------------------------------------------------
test('clearActiveTurn returns null when request_id does not match', () => {
  const { store } = makeStore('jenny-dark-clear-reqid-mismatch-');
  const created = store.createSession({ title: 'Clear Req Mismatch' });

  store.setActiveTurn(created.id, {
    request_id: 'req_clear_correct',
    stream_id: 'stream_c1',
    trace_id: 'trace_c1',
    user_message_id: 'user_c1',
    started_at: '2026-01-01T00:00:00.000Z',
    last_event_at: '2026-01-01T00:00:00.000Z',
    status: 'streaming',
  });

  const result = store.clearActiveTurn(created.id, { request_id: 'req_wrong_example' });
  assert.equal(result, null, 'request_id mismatch must return null from clearActiveTurn');

  // Active turn still present and unchanged
  const activeTurn = store.getActiveTurn(created.id);
  assert.ok(activeTurn !== null, 'active turn must remain after failed clearActiveTurn');
  assert.equal(activeTurn.request_id, 'req_clear_correct');
});

// ---------------------------------------------------------------------------
// Lines 577-578: clearActiveTurn - stream_id mismatch → null
// ---------------------------------------------------------------------------
test('clearActiveTurn returns null when stream_id does not match', () => {
  const { store } = makeStore('jenny-dark-clear-streamid-mismatch-');
  const created = store.createSession({ title: 'Clear Stream Mismatch' });

  store.setActiveTurn(created.id, {
    request_id: 'req_cs',
    stream_id: 'stream_clear_correct',
    trace_id: 'trace_cs',
    user_message_id: 'user_cs',
    started_at: '2026-01-01T00:00:00.000Z',
    last_event_at: '2026-01-01T00:00:00.000Z',
    status: 'streaming',
  });

  const result = store.clearActiveTurn(created.id, { stream_id: 'stream_wrong_example' });
  assert.equal(result, null, 'stream_id mismatch must return null from clearActiveTurn');

  const activeTurn = store.getActiveTurn(created.id);
  assert.ok(activeTurn !== null, 'active turn must remain after failed clearActiveTurn');
  assert.equal(activeTurn.stream_id, 'stream_clear_correct');
});

// ---------------------------------------------------------------------------
// F-06 containment: clearActiveTurn refuses a bare empty match instead of
// unconditionally clearing whoever's active_turn happens to be current. Every
// production caller supplies turn identity (see chat-stream-session-lifecycle.js
// clearActiveTurn / settleQuestionBatch / settleAssistantCompletion / etc. and
// the startup reconcilers), so an empty match is always a bug, never a
// legitimate wildcard clear.
// ---------------------------------------------------------------------------
test('clearActiveTurn refuses a bare empty match and leaves the active turn intact', () => {
  const logs = [];
  const userDataPath = createTrackedTempDir('jenny-dark-clear-empty-match-');
  const storePath = path.join(userDataPath, 'sessions.json');
  const store = new ElectronSessionStore(storePath, {
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  const created = store.createSession({ title: 'Clear Empty Match' });

  store.setActiveTurn(created.id, {
    request_id: 'req_owner',
    stream_id: 'stream_owner',
    trace_id: 'trace_owner',
    user_message_id: 'user_owner',
    started_at: '2026-01-01T00:00:00.000Z',
    last_event_at: '2026-01-01T00:00:00.000Z',
    status: 'streaming',
  });

  const result = store.clearActiveTurn(created.id, { request_id: '', stream_id: '' });
  assert.equal(result, null, 'a bare empty match must be refused, not treated as a wildcard clear');

  const activeTurn = store.getActiveTurn(created.id);
  assert.ok(activeTurn !== null, 'active turn must remain after a refused empty-match clear');
  assert.equal(activeTurn.request_id, 'req_owner');
  assert.equal(activeTurn.stream_id, 'stream_owner');

  assert.ok(
    logs.some((entry) => entry.level === 'WARN' && entry.event === 'session_store.clear_active_turn_refused_empty_match'),
    'a refused empty-match clear must emit a structured WARN log'
  );
});

// ---------------------------------------------------------------------------
// Lines 593-594: appendMessage - message normalizes to null → null
// ---------------------------------------------------------------------------
test('appendMessage coerces an unrecognized (null) role to assistant and appends the message', () => {
  const { store } = makeStore('jenny-dark-append-null-msg-');
  const created = store.createSession({ title: 'Null Message' });

  // normalizeMessageRole maps any role not in {user,assistant,system,tool} —
  // including null — to 'assistant'. normalizeMessage therefore returns a real
  // record (never null) for an object message, so appendMessage MUST persist it.
  // (The line 592-594 null-normalize guard is unreachable from appendMessage:
  // the `{ ...message, event_seq }` spread always yields an object and
  // normalizeMessage of an object never returns null — see equivalentMutantsNoted.)
  const result = store.appendMessage(created.id, { role: null, content: 'hello' });
  assert.ok(result !== null, 'appendMessage must return a summary for an object message');
  assert.equal(result.message_count, 1, 'message_count must advance to exactly 1');

  const messages = store.getSessionMessages(created.id);
  assert.equal(messages.length, 1, 'exactly one message must be appended');
  assert.equal(messages[0].role, 'assistant', 'null role must be coerced to assistant');
  assert.equal(messages[0].content, 'hello', 'content must be carried through normalization');
});

test('appendMessage returns null for session that does not exist', () => {
  const { store } = makeStore('jenny-dark-append-no-session-');
  const result = store.appendMessage('sess_nonexistent_example', { role: 'user', content: 'hi' });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Lines 616-617: updateMessage - no session → null
// ---------------------------------------------------------------------------
test('updateMessage returns null when session does not exist', () => {
  const { store } = makeStore('jenny-dark-updatemsg-no-session-');
  const result = store.updateMessage('sess_nonexistent_example', 'msg_1', { content: 'updated' });
  assert.equal(result, null, 'updateMessage must return null for a non-existent session');
});

// ---------------------------------------------------------------------------
// Lines 620-621: updateMessage - empty messageId → null
// ---------------------------------------------------------------------------
test('updateMessage returns null when messageId is empty string', () => {
  const { store } = makeStore('jenny-dark-updatemsg-empty-id-');
  const created = store.createSession({ title: 'Update Empty Id' });
  store.appendMessage(created.id, { id: 'msg_1', role: 'user', content: 'hello' });

  const result = store.updateMessage(created.id, '', { content: 'updated' });
  assert.equal(result, null, 'empty messageId must return null from updateMessage');
  // Message must be unchanged
  const messages = store.getSessionMessages(created.id);
  assert.equal(messages[0].content, 'hello');
});

test('updateMessage returns null when messageId is whitespace only', () => {
  const { store } = makeStore('jenny-dark-updatemsg-blank-id-');
  const created = store.createSession({ title: 'Update Blank Id' });
  store.appendMessage(created.id, { id: 'msg_1', role: 'user', content: 'hello' });

  const result = store.updateMessage(created.id, '   ', { content: 'updated' });
  assert.equal(result, null, 'whitespace messageId must return null from updateMessage');
});

// ---------------------------------------------------------------------------
// Lines 639-640: updateMessage - message not found (no match) → null
// ---------------------------------------------------------------------------
test('updateMessage returns null when messageId does not match any message', () => {
  const { store } = makeStore('jenny-dark-updatemsg-not-found-');
  const created = store.createSession({ title: 'Update Not Found' });
  store.appendMessage(created.id, { id: 'msg_real', role: 'user', content: 'hello' });

  const result = store.updateMessage(created.id, 'msg_nonexistent_example', { content: 'updated' });
  assert.equal(result, null, 'updateMessage must return null when messageId matches no message');
  // Existing message must be untouched
  assert.equal(store.getSessionMessages(created.id)[0].content, 'hello');
});

// ---------------------------------------------------------------------------
// Lines 649-663: replaceMessages - session not found → null
// ---------------------------------------------------------------------------
test('replaceMessages returns null when session does not exist', () => {
  const { store } = makeStore('jenny-dark-replacemsg-no-session-');
  const result = store.replaceMessages('sess_nonexistent_example', [
    { id: 'msg_1', role: 'user', content: 'hello' },
  ]);
  assert.equal(result, null, 'replaceMessages must return null for a non-existent session');
});

test('replaceMessages with non-array messages normalizes to empty array', () => {
  const { store } = makeStore('jenny-dark-replacemsg-non-array-');
  const created = store.createSession({ title: 'Replace Non-Array' });

  // Seed with a message first
  store.appendMessage(created.id, { id: 'msg_a', role: 'user', content: 'original' });
  assert.equal(store.getSessionMessages(created.id).length, 1);

  // Pass null as messages → normalizes to empty array
  const result = store.replaceMessages(created.id, null);
  assert.ok(result !== null, 'replaceMessages with null messages must not return null when session exists');
  assert.equal(result.message_count, 0, 'message_count must be 0 after replacing with null');
  assert.deepEqual(store.getSessionMessages(created.id), []);
});

test('replaceMessages correctly replaces messages and updates last_message_preview', () => {
  const { store } = makeStore('jenny-dark-replacemsg-happy-');
  const created = store.createSession({ title: 'Replace Happy' });

  store.appendMessage(created.id, { id: 'msg_old', role: 'user', content: 'old content' });

  const result = store.replaceMessages(created.id, [
    { id: 'msg_new_1', role: 'user', content: 'new content here' },
    { id: 'msg_new_2', role: 'assistant', content: 'new reply here' },
  ]);
  assert.ok(result !== null);
  assert.equal(result.message_count, 2);
  const messages = store.getSessionMessages(created.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].id, 'msg_new_1');
  assert.equal(messages[1].id, 'msg_new_2');
  // last_message_preview must reflect the last message
  assert.ok(result.last_message_preview.length > 0, 'last_message_preview must be updated');
});

// ---------------------------------------------------------------------------
// Lines 704-705: truncateAfterMessage with replaceAttachments array path
// ---------------------------------------------------------------------------
test('truncateAfterMessage with replaceMessageAttachments patches the target attachments', () => {
  const { store } = makeStore('jenny-dark-truncate-attachments-');
  const created = store.createSession({ title: 'Attachments Patch' });

  store.appendMessage(created.id, {
    id: 'msg_user_1',
    role: 'user',
    content: 'first message',
    timestamp: '2026-01-01T00:00:00.000Z',
  });
  store.appendMessage(created.id, {
    id: 'msg_assistant_1',
    role: 'assistant',
    content: 'first reply',
    timestamp: '2026-01-01T00:00:01.000Z',
  });
  store.appendMessage(created.id, {
    id: 'msg_user_2',
    role: 'user',
    content: 'second message',
    timestamp: '2026-01-01T00:00:02.000Z',
    attachments: [{ name: 'old.txt', size: 100 }],
  });

  // Attachments use the normalized shape produced by normalizeAttachmentMetadataList
  const newAttachments = [{ kind: 'text', displayName: 'Readme', sizeBytes: 512 }];
  const result = store.truncateAfterMessage(created.id, 'msg_user_2', {
    replaceMessageAttachments: newAttachments,
  });

  assert.ok(result !== null, 'truncateAfterMessage with replaceAttachments must succeed');
  const session = store.getSession(created.id);
  assert.equal(session.messages.length, 3, 'all three messages kept up to and including target');
  // attachments must be replaced on the target message
  const targetMsg = session.messages.find((m) => m.id === 'msg_user_2');
  assert.ok(targetMsg, 'target message must still exist');
  assert.ok(Array.isArray(targetMsg.attachments), 'attachments must be an array');
  // The normalized attachment list must differ from the original (one item provided → one item kept)
  assert.equal(targetMsg.attachments.length, 1, 'exactly one attachment must survive after replace');
  assert.equal(targetMsg.attachments[0].kind, 'text', 'attachment kind must be text');
  assert.equal(targetMsg.attachments[0].sizeBytes, 512, 'sizeBytes must be carried through normalization');
  // content must be unchanged (no replaceMessageContent given)
  assert.equal(targetMsg.content, 'second message');
});

// ---------------------------------------------------------------------------
// appendTurnEvents - session not found → structured { ok:false, unknown_session }
// ---------------------------------------------------------------------------
test('appendTurnEvents reports ok:false / unknown_session when the session does not exist', () => {
  const { store } = makeStore('jenny-dark-append-events-no-session-');
  const result = store.appendTurnEvents('sess_nonexistent_example', [
    {
      event_id: 'turn_x:user_prompt:0',
      turn_id: 'turn_x',
      kind: 'user_prompt',
      primary_message_id: 'msg_1',
      source_message_ids: ['msg_1'],
      payload: { content: 'hello' },
    },
  ]);
  assert.equal(result.ok, false, 'a missing session must report ok:false');
  assert.equal(result.reason, 'unknown_session', 'reason must be unknown_session');
  assert.equal(result.value.appended, 0, 'nothing may be appended for a missing session');
});

// ---------------------------------------------------------------------------
// Lines 786-787: appendTurnEvents - empty events array → returns summary early
// ---------------------------------------------------------------------------
test('appendTurnEvents with empty events array returns current session summary without mutation', () => {
  const { store } = makeStore('jenny-dark-append-events-empty-');
  const created = store.createSession({ title: 'Empty Events' });

  // Append a real event first to set turn_event_seq_counter
  store.appendTurnEvents(created.id, [{
    event_id: 'turn_e:user_prompt:0',
    turn_id: 'turn_e',
    kind: 'user_prompt',
    primary_message_id: 'user_e',
    source_message_ids: ['user_e'],
    payload: { content: 'hello' },
  }]);

  const beforeSeq = store.getSession(created.id).turn_event_seq_counter;

  // Now call with empty array
  const result = store.appendTurnEvents(created.id, []);
  assert.equal(result.ok, true, 'an empty append is ok:true (nothing to persist, journal-safe)');
  assert.equal(result.reason, 'no_events', 'reason must be no_events');
  assert.equal(result.value.appended, 0, 'nothing may be appended for an empty batch');

  // turn_event_seq_counter must not have changed
  const afterSeq = store.getSession(created.id).turn_event_seq_counter;
  assert.equal(afterSeq, beforeSeq, 'turn_event_seq_counter must not change on empty append');
});

// ---------------------------------------------------------------------------
// Lines 801-802: appendTurnEvents - normalizeTurnEvent returns null → skip
// ---------------------------------------------------------------------------
test('appendTurnEvents skips events that fail normalization and still appends valid ones', () => {
  const { store } = makeStore('jenny-dark-append-events-skip-null-');
  const created = store.createSession({ title: 'Skip Null Events' });

  // null entries are passed to normalizeTurnEvent which returns null → skipped
  const result = store.appendTurnEvents(created.id, [
    null,
    undefined,
    {
      event_id: 'turn_sn:user_prompt:0',
      turn_id: 'turn_sn',
      kind: 'user_prompt',
      primary_message_id: 'user_sn',
      source_message_ids: ['user_sn'],
      payload: { content: 'valid event' },
    },
    null,
  ]);

  // The valid event must be appended; nulls must be silently skipped
  assert.equal(result.ok, true, 'a batch with skippable nulls still persists the valid event (ok:true)');
  assert.equal(result.value.appended, 1, 'exactly one valid event must be reported appended');
  const session = store.getSession(created.id);
  assert.equal(session.turn_events.length, 1, 'exactly one valid event must be appended');
  assert.equal(session.turn_events[0].event_id, 'turn_sn:user_prompt:0');
  assert.equal(
    session.turn_event_seq_counter,
    1,
    'turn_event_seq_counter must only count successfully appended events'
  );
});

// ---------------------------------------------------------------------------
// Bonus: appendTurnEvents with bumpUpdatedAt=false (non-default path)
// ---------------------------------------------------------------------------
test('appendTurnEvents with bumpUpdatedAt=true moves updated_at forward; default leaves it untouched', () => {
  const { store } = makeStore('jenny-dark-append-events-bump-');

  // Seed an explicitly stale updated_at so any real "now" bump is strictly
  // greater than the seed. A `>=` against the current value would be clamp-blind
  // (same-ms equality always passes even if the bump is removed); pinning a far
  // past seed makes the bump observable and the mutation (drop the bump) detectable.
  const STALE = '2000-01-01T00:00:00.000Z';

  // --- Case A: bumpUpdatedAt:true MUST advance updated_at past the stale seed.
  const bumped = store.createSession({ title: 'Bump True' });
  const bumpedRec = store._backend.getSession(bumped.id);
  bumpedRec.updated_at = STALE;
  store._backend.upsertSession(bumped.id, bumpedRec, { persist: false, alreadyNormalized: true });
  assert.equal(store.getSession(bumped.id).updated_at, STALE, 'seed must take effect');

  const bumpResult = store.appendTurnEvents(bumped.id, [{
    event_id: 'turn_bump:user_prompt:0',
    turn_id: 'turn_bump',
    kind: 'user_prompt',
    primary_message_id: 'user_bump',
    source_message_ids: ['user_bump'],
    payload: { content: 'bump' },
  }], { bumpUpdatedAt: true });
  assert.equal(bumpResult.ok, true, 'a successful append reports ok:true');
  const afterBump = store.getSession(bumped.id).updated_at;
  assert.ok(
    afterBump > STALE,
    `bumpUpdatedAt=true must advance updated_at past the stale seed (got ${afterBump})`
  );

  // --- Case B: the default (bumpUpdatedAt omitted → false) MUST NOT touch updated_at.
  // This is the contrast that makes the bump genuinely load-bearing: if the bump
  // flag were ignored, Case A would equal STALE and fail.
  const kept = store.createSession({ title: 'Bump Default' });
  const keptRec = store._backend.getSession(kept.id);
  keptRec.updated_at = STALE;
  store._backend.upsertSession(kept.id, keptRec, { persist: false, alreadyNormalized: true });

  store.appendTurnEvents(kept.id, [{
    event_id: 'turn_keep:user_prompt:0',
    turn_id: 'turn_keep',
    kind: 'user_prompt',
    primary_message_id: 'user_keep',
    source_message_ids: ['user_keep'],
    payload: { content: 'keep' },
  }]);
  assert.equal(
    store.getSession(kept.id).updated_at,
    STALE,
    'default appendTurnEvents (bumpUpdatedAt=false) must leave updated_at untouched'
  );
});

// ---------------------------------------------------------------------------
// appendTurnEvents({ durable: true }): the append lands in cache but the forced
// immediate flush fails → ok:false / write_failed so the caller retains its
// crash-recovery journal (the turn-event durability fix).
// ---------------------------------------------------------------------------
test('appendTurnEvents durable:true reports ok:false / write_failed when the immediate flush throws', () => {
  const { store } = makeStore('jenny-dark-append-durable-fail-');
  const created = store.createSession({ title: 'Durable Fail' });

  // Inject a FileJsonStore-shaped double whose write() (the cache-scheduled path)
  // succeeds but whose writeImmediate() (the durable flush) throws.
  const boom = new Error('immediate flush blew up');
  store._backend._sessionStores.set(created.id, {
    filePath: 'durable-fail.json',
    write() {},
    writeImmediate() { throw boom; },
    hasPendingWrite() { return false; },
    flush() { return false; },
    dispose() {},
    delete() {},
  });

  const result = store.appendTurnEvents(created.id, [{
    event_id: 'turn_d:user_prompt:0',
    turn_id: 'turn_d',
    kind: 'user_prompt',
    primary_message_id: 'user_d',
    source_message_ids: ['user_d'],
    payload: { content: 'durable' },
  }], { durable: true });

  assert.equal(result.ok, false, 'a failed durable flush must report ok:false');
  assert.equal(result.reason, 'durability_failed', 'the reason must describe failed durability proof');
  assert.equal(result.value.appended, 1, 'the append still lands in cache (only the disk flush failed)');
  assert.equal(
    store.getSession(created.id).turn_events.length,
    1,
    'the event is present in the in-memory record even though the durable flush failed'
  );
});
