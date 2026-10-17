'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ElectronSessionStore, normalizeMessage } = require('../services/backend/electron-session-store');
const { normalizeMessageFields, normalizeMessageRole } = require('../services/backend/message-normalization');
const E = require('../services/backend/session-message-envelope');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const F = require('./helpers/session-mail-fixtures');

function openStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-insert-before-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { store, root };
}

const ctxRow = (n, extra = {}) => E.buildIncludedRow(F.makeEnvelope(n, { body: `from chat ${n}` }), { turn_id: 'turn_1', timestamp: F.iso(n), ...extra });

// A session ending in the turn's user anchor.
function seed(t) {
  const { store, root } = openStore(t);
  const session = store.createSession({ title: 'Dest' });
  store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: 'earlier answer', turn_id: 'turn_0' });
  store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'the prompt', turn_id: 'turn_1' });
  return { store, root, id: session.id };
}

const ids = (store, id) => store.getSession(id).messages.map((m) => m.id);
const seqs = (store, id) => store.getSession(id).messages.map((m) => m.event_seq);

test('rows land before the anchor with event_seq from the anchor old seq; the anchor is re-stamped after them', (t) => {
  const { store, id } = seed(t);
  const before = store.getSession(id);
  assert.deepEqual(seqs(store, id), [0, 1]);
  const summary = store.insertMessagesBefore(id, 'u1', [ctxRow(1), ctxRow(2)]);
  assert.ok(summary);
  assert.equal(summary.id, id);
  assert.deepEqual(ids(store, id), ['a1', `ctx_${F.uuid(1)}`, `ctx_${F.uuid(2)}`, 'u1']);
  assert.deepEqual(seqs(store, id), [0, 1, 2, 3]);
  const after = store.getSession(id);
  assert.equal(after.message_count, 4);
  assert.equal(after.message_seq_counter, 4);
  assert.ok(after.message_seq_counter > before.message_seq_counter);
  assert.equal(after.messages[3].content, 'the prompt');
  assert.equal(after.last_message_preview, 'the prompt', 'context rows never become the preview');
  assert.equal(after.messages[1].role, 'context');
  assert.equal(after.messages[1].turn_id, 'turn_1');
  assert.equal(after.messages[1].session_message.message_id, F.uuid(1));
});

test('insertMessagesBefore is idempotent by row id (timestamp may differ)', (t) => {
  const { store, id } = seed(t);
  store.insertMessagesBefore(id, 'u1', [ctxRow(1)]);
  const first = store.getSession(id);
  const again = store.insertMessagesBefore(id, 'u1', [ctxRow(1, { timestamp: F.iso(99999) })]);
  assert.ok(again, 'replay is a success');
  assert.deepEqual(store.getSession(id).messages, first.messages, 'nothing changed');
  assert.equal(store.getSession(id).updated_at, first.updated_at, 'no write');
  const mixed = store.insertMessagesBefore(id, 'u1', [ctxRow(1), ctxRow(2)]);
  assert.ok(mixed);
  assert.deepEqual(ids(store, id), ['a1', `ctx_${F.uuid(1)}`, `ctx_${F.uuid(2)}`, 'u1']);
  assert.deepEqual(seqs(store, id), [0, 1, 2, 3]);
  assert.equal(new Set(seqs(store, id)).size, 4, 'event_seq values stay unique');
});

test('a different row under an existing id returns null and changes nothing', (t) => {
  const { store, id } = seed(t);
  store.insertMessagesBefore(id, 'u1', [ctxRow(1)]);
  const snapshot = JSON.stringify(store.getSession(id).messages);
  const changedBody = E.buildIncludedRow(F.makeEnvelope(1, { body: 'rewritten' }), { turn_id: 'turn_1' });
  assert.equal(store.insertMessagesBefore(id, 'u1', [{ ...changedBody, id: `ctx_${F.uuid(1)}` }]), null);
  assert.equal(store.insertMessagesBefore(id, 'u1', [ctxRow(1, { turn_id: 'turn_other' })]), null);
  assert.equal(store.insertMessagesBefore(id, 'u1', [ctxRow(3), { ...changedBody, id: `ctx_${F.uuid(1)}` }]), null, 'all or nothing');
  assert.equal(JSON.stringify(store.getSession(id).messages), snapshot);
});

test('the anchor must be the LAST message and a user row', (t) => {
  const { store, id } = seed(t);
  assert.equal(store.insertMessagesBefore(id, 'a1', [ctxRow(1)]), null, 'not last');
  assert.equal(store.insertMessagesBefore(id, 'missing', [ctxRow(1)]), null);
  assert.equal(store.insertMessagesBefore(id, '', [ctxRow(1)]), null);
  assert.equal(store.insertMessagesBefore('sess_missing', 'u1', [ctxRow(1)]), null);
  store.appendMessage(id, { id: 'a2', role: 'assistant', content: 'reply', turn_id: 'turn_1' });
  assert.equal(store.insertMessagesBefore(id, 'u1', [ctxRow(1)]), null, 'a message follows the anchor');
  assert.equal(store.insertMessagesBefore(id, 'a2', [ctxRow(1)]), null, 'last but not a user row');
  assert.deepEqual(ids(store, id), ['a1', 'u1', 'a2']);
});

test('only valid context rows are accepted; empty input is a no-op success', (t) => {
  const { store, id } = seed(t);
  const bad = [
    [{ id: 'x', role: 'assistant', content: 'plain' }],
    [{ ...ctxRow(1), content: 'mismatch' }],
    [{ ...ctxRow(1), session_message: null }],
    [ctxRow(1), ctxRow(1)],
    'rows',
    undefined,
  ];
  for (const rows of bad) assert.equal(store.insertMessagesBefore(id, 'u1', rows), null, JSON.stringify(rows));
  assert.deepEqual(ids(store, id), ['a1', 'u1']);
  assert.ok(store.insertMessagesBefore(id, 'u1', []), 'nothing to insert is fine');
});

test('a discard-receipt row can be inserted too and stays out of the preview', (t) => {
  const { store, id } = seed(t);
  const receipt = E.buildDiscardReceiptRow(F.makeEnvelope(5), { timestamp: F.iso() });
  assert.ok(store.insertMessagesBefore(id, 'u1', [receipt]));
  const row = store.getSession(id).messages[1];
  assert.equal(row.kind, 'session_message_receipt');
  assert.equal(row.disposition, 'discarded');
  assert.equal(store.getSession(id).last_message_preview, 'the prompt');
});

test('legacy anchors without an event_seq still sort the inserted rows between history and the anchor', (t) => {
  const { store, id } = seed(t);
  const session = store.getSession(id);
  const legacy = session.messages.map((m) => {
    const { event_seq: _ignored, ...rest } = m;
    return rest;
  });
  store._updateSessionRecord(id, { messages: legacy, message_seq_counter: 0 });
  assert.deepEqual(seqs(store, id), [null, null]);
  assert.ok(store.insertMessagesBefore(id, 'u1', [ctxRow(1)]));
  assert.deepEqual(seqs(store, id), [null, 1, 2], 'rows take seq from the anchor position upward');
  assert.equal(store.getSession(id).message_seq_counter, 3);
});

test('context rows never update last_message_preview through appendMessage, replace or truncate', (t) => {
  const { store, id } = seed(t);
  store.appendMessage(id, ctxRow(1));
  assert.equal(store.getSession(id).last_message_preview, 'the prompt');
  const rows = store.getSession(id).messages;
  assert.equal(rows[rows.length - 1].role, 'context');
  store.replaceMessages(id, [rows[0], rows[1], rows[2]]);
  assert.equal(store.getSession(id).last_message_preview, 'the prompt', 'preview skips the trailing context row');
});

test('inserted rows persist across a reopen and mail state is untouched', (t) => {
  const { store, root, id } = seed(t);
  const mail = createSessionMailStore(store);
  mail.mutate(id, ({ mail: draft }) => ({ mail: { ...draft, inbox: [F.makeInbox(1)], next_receive_sequence: 2 } }));
  const revision = store.getSession(id).coordination_revision;
  store.insertMessagesBefore(id, 'u1', [ctxRow(1)]);
  store.flushSession(id);
  assert.equal(store.getSession(id).coordination_revision, revision, 'no coordination write');
  assert.equal(store.getSession(id).session_mail.inbox.length, 1);
  const reopened = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  t.after(() => reopened.dispose());
  assert.deepEqual(reopened.getSession(id).messages.map((m) => m.id), ['a1', `ctx_${F.uuid(1)}`, 'u1']);
  assert.deepEqual(reopened.getSession(id).messages[1].session_message, F.makeEnvelope(1, { body: 'from chat 1' }));
});

test('normalizeMessage keeps a valid context row whole and DROPS a malformed one (never an assistant row)', () => {
  const good = ctxRow(1);
  const normalized = normalizeMessage(good, 'model');
  assert.equal(normalized.role, 'context');
  assert.equal(normalized.kind, 'session_message');
  assert.equal(normalized.content, 'from chat 1');
  assert.equal(normalized.turn_id, 'turn_1');
  assert.deepEqual(normalized.session_message, good.session_message);
  assert.equal(E.validateContextRow(normalized) !== null, true, 'normalization is stable under re-validation');
  assert.deepEqual(normalizeMessage(normalized, 'model').session_message, good.session_message);
  const receipt = normalizeMessage(E.buildDiscardReceiptRow(F.makeEnvelope(2)), 'model');
  assert.equal(receipt.disposition, 'discarded');
  const malformed = [
    { ...good, content: 'forged body' },
    { ...good, session_message: { ...good.session_message, body: 'forged' } },
    { ...good, session_message: undefined },
    { ...good, id: 'ctx_other' },
    { ...good, kind: 'something_else' },
    { ...good, kind: '' },
    { id: 'c1', role: 'context', content: 'plain text pretending' },
    { ...good, turn_id: '' },
  ];
  for (const row of malformed) assert.equal(normalizeMessage(row, 'model'), null, JSON.stringify(row));
  assert.equal(normalizeMessageFields({ ...good, content: 'x' }), null);
});

test('context rows carry only contract fields; stray metadata is not kept', () => {
  const dirty = { ...ctxRow(1), tool_call: { tool_name: 'bash' }, attachments: [{ id: 'a' }], interactive_batch: { x: 1 }, model_used: 'm' };
  const normalized = normalizeMessageFields(dirty, 'fallback');
  assert.equal(normalized.tool_call, null);
  assert.deepEqual(normalized.attachments, []);
  assert.equal(normalized.interactive_batch, null);
  assert.equal(normalized.model_used, '');
});

test('role normalization knows context but still coerces other unknown roles as before', () => {
  assert.equal(normalizeMessageRole('context'), 'context');
  assert.equal(normalizeMessageRole(' Context '), 'context');
  assert.equal(normalizeMessageRole('narrator'), 'assistant');
  assert.equal(normalizeMessageRole(''), 'assistant');
});

test('malformed context rows in a persisted session are dropped on load, counted by message_count', (t) => {
  const { store, root, id } = seed(t);
  store.insertMessagesBefore(id, 'u1', [ctxRow(1)]);
  store.flushSession(id);
  const target = fs.readdirSync(root, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
  assert.ok(target.length >= 1);
  const raw = store.getSession(id);
  const forged = raw.messages.map((m) => (m.role === 'context' ? { ...m, content: 'forged' } : m));
  store._updateSessionRecord(id, { messages: forged });
  assert.deepEqual(ids(store, id), ['a1', 'u1'], 'the forged row is dropped, not coerced to assistant');
  assert.equal(store.getSession(id).messages.some((m) => m.role === 'assistant' && m.content === 'forged'), false);
});
