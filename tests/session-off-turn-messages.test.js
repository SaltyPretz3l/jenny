'use strict';

// Off-turn transcript append (agentic memory v2, row 58 W2): background
// receipts land in the canonical store without moving the chat in the list,
// clearing the composer draft, or interleaving with a live turn.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { appendOffTurnMessages } = require('../services/backend/session-off-turn-messages');

function storeWithChat(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-off-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  const id = store.createSession({ title: 'Chat' }).id;
  store.appendMessage(id, { id: 'u1', role: 'user', content: 'Hello.' });
  store.updateSession(id, { composer_draft: 'draft in progress' });
  return { store, id };
}

const note = id => ({ id, role: 'tool', kind: 'tool_result', content: 'memory remember saved',
  tool_result: { call_id: id, tool_name: 'memory', output_text: '', summary: 'memory remember saved', is_error: false,
    metadata: { result_kind: 'memory', action: 'remember', status: 'saved', origin: 'reflection' } } });

test('appends in order with monotonic event_seq, keeping recency and the draft', t => {
  const { store, id } = storeWithChat(t);
  const before = store.getSession(id);
  const result = appendOffTurnMessages(store, id, [note('n1'), note('n2')]);
  assert.deepEqual(result, { ok: true, appended: 2 });
  const after = store.getSession(id);
  assert.deepEqual(after.messages.map(message => message.id), ['u1', 'n1', 'n2']);
  assert.ok(after.messages[1].event_seq > after.messages[0].event_seq);
  assert.ok(after.messages[2].event_seq > after.messages[1].event_seq);
  assert.equal(after.message_count, 3);
  assert.equal(after.updated_at, before.updated_at);
  assert.equal(after.composer_draft, 'draft in progress');
  assert.equal(after.last_message_preview, before.last_message_preview);
  assert.equal(after.messages[1].tool_result.metadata.origin, 'reflection');
});

test('an existing id is not appended twice; a missing chat or a live turn refuses', t => {
  const { store, id } = storeWithChat(t);
  appendOffTurnMessages(store, id, [note('n1')]);
  assert.deepEqual(appendOffTurnMessages(store, id, [note('n1')]), { ok: true, appended: 0 });
  assert.deepEqual(appendOffTurnMessages(store, 'missing', [note('n2')]), { ok: false, reason: 'session_missing', appended: 0 });
  const at = new Date().toISOString();
  store.setActiveTurn(id, { stream_id: 'stream-1', request_id: 'req-1', user_message_id: 'u1', started_at: at,
    last_event_at: at, status: 'streaming' });
  assert.ok(store.getSession(id).active_turn);
  assert.deepEqual(appendOffTurnMessages(store, id, [note('n3')]), { ok: false, reason: 'turn_active', appended: 0 });
  assert.equal(store.getSession(id).messages.length, 2);
});
