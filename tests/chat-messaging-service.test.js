'use strict';

/* ChatMessagingService bridge behaviour (row 59 checkpoint 4): closed request
 * schemas, prepare / send / retry / cancel, the inbox / outbox lists with cursor and
 * counts, markRead, disposition, discard and the checkpoint-5 methods. Runs against a
 * real ElectronSessionStore through the desktop wiring. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { INCLUDED_ROW_PREFIX, RECEIPT_ROW_PREFIX, validateContextRow } = require('../services/backend/session-message-envelope');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');

const V = { schema_version: 1 };
const UUID = '99999999-9999-4999-8999-999999999999';

test('prepare writes a prepared outbox record, returns the exact preview and sends nothing', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest', { projectId: 'project_a' });
  const prepared = await f.prepare(src, dst, 'Please review the plan.');
  assert.equal(prepared.ok, true);
  assert.equal(prepared.schema_version, 1);
  assert.equal(prepared.envelope.kind, 'user_message');
  assert.equal(prepared.envelope.body, 'Please review the plan.');
  assert.equal(prepared.envelope.destination_project_id, 'project_a');
  assert.equal(prepared.envelope.source_project_id, 'project_general', 'a new chat belongs to the General project');
  assert.equal(prepared.envelope.source_turn_id, null);
  assert.equal(prepared.expires_at, new Date(f.clock.ms + 24 * 60 * 60 * 1000).toISOString());
  const outbox = f.mail(src).outbox;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].state, 'prepared');
  assert.equal(outbox[0].authorization_id, null);
  assert.equal(f.mail(dst).inbox.length, 0, 'prepare delivers nothing');
  assert.equal(f.mail(src).authorizations.length, 0);
});

test('a gesture replay with the same payload returns the same operation and a different payload conflicts', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const other = f.sessionId('O');
  const gesture = f.gesture();
  const first = await f.prepare(src, dst, 'one', gesture);
  const replay = await f.prepare(src, dst, 'one', gesture);
  assert.equal(replay.ok, true);
  assert.equal(replay.operation_id, first.operation_id);
  assert.equal(replay.envelope.message_id, first.envelope.message_id);
  assert.equal(f.mail(src).outbox.length, 1);
  for (const [to, body] of [[dst, 'two'], [other, 'one']]) {
    const conflict = await f.prepare(src, to, body, gesture);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'idempotency_conflict');
    assert.equal(conflict.error_code, CODES.IDEMPOTENCY_CONFLICT);
  }
  assert.equal(f.mail(src).outbox.length, 1);
});

test('prepare rejects malformed requests, self-send and ineligible endpoints with stable reasons', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const archived = f.sessionId('A');
  f.archive(archived);
  const base = { ...V, source_session_id: src, destination_session_id: dst, body: 'hi', gesture_id: f.gesture() };
  const invalid = [
    { ...base, extra: 1 },
    { ...base, schema_version: 2 },
    { ...base, body: '   ' },
    { ...base, body: 'x'.repeat(16385) },
    { ...base, body: 'bell\u0007' },
    { ...base, gesture_id: 'not-a-uuid' },
    { ...base, destination_session_id: '../escape' },
    { source_session_id: src },
    null,
    'text',
  ];
  for (const raw of invalid) {
    const result = await f.service.prepare(raw);
    assert.equal(result.ok, false);
    assert.equal(result.error_code, CODES.INVALID_REQUEST);
  }
  assert.equal((await f.prepare(src, src)).reason, 'self_send');
  assert.equal((await f.prepare(src, 'sess_missing')).reason, 'recipient_deleted');
  assert.equal((await f.prepare('sess_missing', dst)).reason, 'not_found');
  const toArchived = await f.prepare(src, archived);
  assert.equal(toArchived.reason, 'recipient_archived');
  assert.equal(toArchived.error_code, CODES.RECIPIENT_ARCHIVED);
  assert.equal(toArchived.retryable, true);
  assert.equal((await f.prepare(archived, dst)).reason, 'source_ineligible');
  assert.equal(f.mail(src).outbox.length, 0);
});

test('sender capacity: 128 undelivered operations refuse the next prepare without evicting any', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const fixtures = require('./helpers/session-mail-fixtures');
  const outbox = Array.from({ length: 128 }, (_, n) => fixtures.makeOutbox(n + 1, {
    expires_at: new Date(f.clock.ms + 3600000).toISOString(),
  }, { source: { session_id: src, session_incarnation: 'inc_x' }, destination: { session_id: dst } }));
  const mail = { ...fixtures.emptyMail(), outbox };
  f.store._updateSessionRecord(src, { session_mail: mail, coordination_revision: 1 }, { bumpUpdatedAt: false });
  const result = await f.prepare(src, dst);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sender_backpressure');
  assert.equal(result.error_code, CODES.SENDER_BACKPRESSURE);
  assert.equal(f.mail(src).outbox.length, 128);
});

test('send consumes a one-off authorization, delivers to the inbox and acknowledges the receipt', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest');
  const { prepared, sent } = await f.sendNew(src, dst, 'Hello Dest');
  assert.equal(sent.ok, true);
  assert.equal(sent.created, true);
  assert.equal(sent.operation.state, 'delivered');
  assert.equal(sent.operation.message_id, prepared.envelope.message_id);
  assert.equal(sent.operation.destination.title, 'Dest');
  const out = f.mail(src);
  assert.equal(out.outbox[0].state, 'delivered');
  assert.equal(out.outbox[0].delivered_at, new Date(f.clock.ms).toISOString());
  assert.equal(out.authorizations.length, 1);
  assert.equal(out.authorizations[0].kind, 'user_send');
  assert.equal(out.authorizations[0].remaining_sends, 0);
  assert.equal(out.authorizations[0].consent_event_id, `send:${prepared.operation_id}`);
  assert.equal(out.authorizations[0].operation_id, prepared.operation_id);
  const into = f.mail(dst);
  assert.equal(into.inbox.length, 1);
  assert.equal(into.inbox[0].receive_sequence, 1);
  assert.equal(into.next_receive_sequence, 2);
  assert.deepEqual(into.inbox[0].context, { state: 'queued' });
  assert.equal(into.inbox[0].read_at, null);
  assert.equal(into.inbox[0].receipt_id, out.outbox[0].destination_receipt_id);
  assert.equal(into.inbox[0].source_receipt_confirmed_at, new Date(f.clock.ms).toISOString());
  assert.equal(f.store.getSessionSummary(dst).unread_message_count, 1);
  // The invalidation events fire after the durable writes, for both chats.
  const touched = new Set(f.events.map((event) => event.session_id));
  assert.deepEqual([...touched].sort(), [src, dst].sort());
  assert.ok(f.coordination.includes(src) && f.coordination.includes(dst));
  for (const event of f.events) assert.deepEqual(Object.keys(event), ['schema_version', 'session_id', 'revision']);
});

test('a duplicate send is idempotent and never creates a second inbox record', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const { prepared } = await f.sendNew(src, dst, 'once');
  const again = await f.service.send({ ...V, operation_id: prepared.operation_id });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(f.mail(src).authorizations.length, 1);
});

test('send never recreates an unknown, cancelled or expired operation', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const unknown = await f.service.send({ ...V, operation_id: UUID });
  assert.equal(unknown.reason, 'stale_operation');
  assert.equal(unknown.error_code, CODES.STALE_OPERATION);

  const cancelled = await f.prepare(src, dst, 'c');
  assert.equal((await f.service.cancel({ ...V, operation_id: cancelled.operation_id })).operation.state, 'cancelled');
  assert.equal((await f.service.send({ ...V, operation_id: cancelled.operation_id })).reason, 'stale_operation');

  const expiring = await f.prepare(src, dst, 'e');
  f.advance(24 * 60 * 60 * 1000 + 1000);
  const late = await f.service.send({ ...V, operation_id: expiring.operation_id });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'expired');
  assert.equal(late.error_code, CODES.STALE_OPERATION);
  assert.equal(f.mail(dst).inbox.length, 0);
  assert.equal(f.mail(src).authorizations.length, 0);
});

test('send refuses once the source chat identity or project changed after prepare', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const first = await f.prepare(src, dst, 'a');
  f.store._updateSessionRecord(src, { project_id: 'project_b' }, { bumpUpdatedAt: false });
  assert.equal((await f.service.send({ ...V, operation_id: first.operation_id })).reason, 'stale_operation');
  const src2 = f.sessionId('S2');
  const second = await f.prepare(src2, dst, 'b');
  f.store._updateSessionRecord(src2, { session_incarnation: 'inc_replaced' }, { bumpUpdatedAt: false });
  assert.equal((await f.service.send({ ...V, operation_id: second.operation_id })).reason, 'stale_operation');
  assert.equal(f.mail(dst).inbox.length, 0);
});

test('cancel: prepared becomes cancelled, a delivered message cannot be retracted', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const prepared = await f.prepare(src, dst, 'x');
  const cancelled = await f.service.cancel({ ...V, operation_id: prepared.operation_id });
  assert.equal(cancelled.created, true);
  assert.equal(cancelled.operation.state, 'cancelled');
  const replay = await f.service.cancel({ ...V, operation_id: prepared.operation_id });
  assert.equal(replay.created, false);
  const { prepared: delivered } = await f.sendNew(src, dst, 'y');
  const late = await f.service.cancel({ ...V, operation_id: delivered.operation_id });
  assert.equal(late.ok, true);
  assert.equal(late.created, false);
  assert.equal(late.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox.length, 1);
});

test('list outbox: newest first, expired prepared hidden, cursor pages, counts and current titles', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest', { projectId: 'project_a' });
  const ids = [];
  for (let n = 0; n < 3; n += 1) {
    f.advance(1000);
    ids.push((await f.prepare(src, dst, `m${n}`)).operation_id);
  }
  await f.service.send({ ...V, operation_id: ids[0] });
  const page1 = await f.service.list({ ...V, session_id: src, direction: 'outbox', limit: 2 });
  assert.equal(page1.ok, true);
  assert.deepEqual(page1.items.map((item) => item.operation_id), [ids[2], ids[1]]);
  assert.ok(page1.next_cursor);
  assert.equal(page1.items[0].destination.project_name, 'Alpha');
  assert.equal(page1.items[0].destination.available, true);
  assert.equal(page1.counts.pending_delivery, 0);
  const page2 = await f.service.list({ ...V, session_id: src, direction: 'outbox', limit: 2, cursor: page1.next_cursor });
  assert.deepEqual(page2.items.map((item) => item.operation_id), [ids[0]]);
  assert.equal(page2.next_cursor, null);
  // A cursor from an older revision is stale.
  await f.prepare(src, dst, 'later');
  const stale = await f.service.list({ ...V, session_id: src, direction: 'outbox', limit: 2, cursor: page1.next_cursor });
  assert.equal(stale.reason, 'stale_cursor');
  assert.equal(stale.error_code, CODES.STALE_OPERATION);
  assert.equal(stale.retryable, true);
  // Prepared operations past 24 hours leave the list and become cancelled.
  f.advance(25 * 60 * 60 * 1000);
  const expired = await f.service.list({ ...V, session_id: src, direction: 'outbox' });
  assert.deepEqual(expired.items.map((item) => item.operation_id), [ids[0]]);
  assert.equal(f.mail(src).outbox.find((op) => op.operation_id === ids[1]).state, 'cancelled');
});

test('a deleted destination projects as an unavailable chat with no title', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  await f.sendNew(src, dst, 'gone soon');
  f.store.deleteSession(dst);
  const list = await f.service.list({ ...V, session_id: src, direction: 'outbox' });
  assert.deepEqual(list.items[0].destination, {
    session_id: dst, available: false, title: null, project_id: null, project_name: null,
  });
});

test('list inbox: ascending receive sequence with sources, counts and request validation', async (t) => {
  const f = createFixture(t);
  const a = f.sessionId('Alpha chat', { projectId: 'project_a' });
  const b = f.sessionId('Beta chat');
  const dst = f.sessionId('Dest');
  await f.sendNew(a, dst, 'from a');
  await f.sendNew(b, dst, 'from b');
  const list = await f.service.list({ ...V, session_id: dst, direction: 'inbox' });
  assert.equal(list.ok, true);
  assert.deepEqual(list.items.map((item) => item.envelope.body), ['from a', 'from b']);
  assert.deepEqual(list.items.map((item) => item.receive_sequence), [1, 2]);
  assert.equal(list.items[0].source.title, 'Alpha chat');
  assert.equal(list.items[0].source.project_name, 'Alpha');
  assert.equal(list.counts.unread, 2);
  assert.equal(list.counts.queued, 2);
  assert.equal(list.revision, f.store.getSession(dst).coordination_revision);
  for (const bad of [{ ...V, session_id: dst }, { ...V, session_id: dst, direction: 'both' },
    { ...V, session_id: dst, direction: 'inbox', limit: 101 }, { ...V, session_id: dst, direction: 'inbox', limit: 0 },
    { ...V, session_id: dst, direction: 'inbox', cursor: '!!' }]) {
    assert.equal((await f.service.list(bad)).error_code, CODES.INVALID_REQUEST);
  }
  assert.equal((await f.service.list({ ...V, session_id: 'sess_missing', direction: 'inbox' })).reason, 'not_found');
});

test('markRead marks only unread messages of that chat and answers the count and revision', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const first = (await f.sendNew(src, dst, 'one')).prepared.envelope.message_id;
  const second = (await f.sendNew(src, dst, 'two')).prepared.envelope.message_id;
  const read = await f.service.markRead({ ...V, session_id: dst, message_ids: [first] });
  assert.equal(read.ok, true);
  assert.equal(read.updated_count, 1);
  assert.equal(read.revision, f.store.getSession(dst).coordination_revision);
  assert.equal(f.store.getSessionSummary(dst).unread_message_count, 1);
  const repeat = await f.service.markRead({ ...V, session_id: dst, message_ids: [first, second] });
  assert.equal(repeat.updated_count, 1);
  assert.equal(f.store.getSessionSummary(dst).unread_message_count, 0);
  // Ids that do not belong to this destination, duplicates and empty lists are invalid.
  assert.equal((await f.service.markRead({ ...V, session_id: dst, message_ids: [UUID] })).error_code, CODES.INVALID_REQUEST);
  assert.equal((await f.service.markRead({ ...V, session_id: src, message_ids: [first] })).error_code, CODES.INVALID_REQUEST);
  assert.equal((await f.service.markRead({ ...V, session_id: dst, message_ids: [first, first] })).error_code, CODES.INVALID_REQUEST);
  assert.equal((await f.service.markRead({ ...V, session_id: dst, message_ids: [] })).error_code, CODES.INVALID_REQUEST);
  assert.equal((await f.service.markRead({ ...V, session_id: dst, message_ids: Array.from({ length: 101 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`) })).error_code, CODES.INVALID_REQUEST);
});

test('setContextDisposition toggles queued and excluded and refuses reserved or included entries as busy', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const id = (await f.sendNew(src, dst, 'one')).prepared.envelope.message_id;
  const reservedId = (await f.sendNew(src, dst, 'two')).prepared.envelope.message_id;
  const excluded = await f.service.setContextDisposition({ ...V, session_id: dst, message_ids: [id], disposition: 'excluded_by_user' });
  assert.equal(excluded.updated_count, 1);
  assert.equal(f.mail(dst).inbox[0].context.state, 'excluded_by_user');
  assert.equal((await f.service.setContextDisposition({ ...V, session_id: dst, message_ids: [id], disposition: 'excluded_by_user' })).updated_count, 0);
  const counts = (await f.service.list({ ...V, session_id: dst, direction: 'inbox' })).counts;
  assert.equal(counts.excluded_by_user, 1);
  assert.equal(counts.queued, 1);
  assert.equal((await f.service.setContextDisposition({ ...V, session_id: dst, message_ids: [id], disposition: 'queued' })).updated_count, 1);
  // Mark the second entry reserved: the whole request refuses with busy.
  const mail = f.mail(dst);
  mail.inbox[1] = { ...mail.inbox[1], context: { state: 'reserved', turn_id: 'turn_1', snapshot_id: UUID } };
  f.store._updateSessionRecord(dst, { session_mail: mail }, { bumpUpdatedAt: false });
  const busy = await f.service.setContextDisposition({ ...V, session_id: dst, message_ids: [id, reservedId], disposition: 'excluded_by_user' });
  assert.equal(busy.reason, 'busy');
  assert.equal(busy.error_code, CODES.STALE_OPERATION);
  assert.equal(f.mail(dst).inbox[0].context.state, 'queued', 'a refused request changes nothing');
  assert.equal((await f.service.setContextDisposition({ ...V, session_id: dst, message_ids: [id], disposition: 'maybe' })).error_code, CODES.INVALID_REQUEST);
});

test('discard appends the canonical receipt row first, then retires the entry into a compact receipt', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const messageId = (await f.sendNew(src, dst, 'private words')).prepared.envelope.message_id;
  const result = await f.service.discard({ ...V, session_id: dst, message_ids: [messageId] });
  assert.equal(result.ok, true);
  assert.equal(result.updated_count, 1);
  const row = f.store.getSession(dst).messages.find((message) => message.id === `${RECEIPT_ROW_PREFIX}${messageId}`);
  assert.ok(validateContextRow(row), 'a valid canonical receipt row is persisted');
  assert.equal(row.disposition, 'discarded');
  assert.equal(row.content, 'private words');
  assert.equal(f.store.getSessionSummary(dst).last_message_preview, '', 'a context row never becomes the chat preview');
  const mail = f.mail(dst);
  assert.equal(mail.inbox.length, 0);
  assert.equal(mail.discarded.length, 1);
  assert.equal(mail.discarded[0].canonical_message_id, `${RECEIPT_ROW_PREFIX}${messageId}`);
  assert.equal(mail.discarded[0].source_receipt_confirmed_at !== null, true);
  // The list still shows it, as a discarded item with the receipt row's envelope.
  const list = await f.service.list({ ...V, session_id: dst, direction: 'inbox' });
  assert.equal(list.items[0].context.state, 'discarded');
  assert.equal(list.items[0].envelope.body, 'private words');
  assert.equal(list.items[0].source.title, 'S');
  // Replay is idempotent; the source cannot retract it.
  const replay = await f.service.discard({ ...V, session_id: dst, message_ids: [messageId] });
  assert.equal(replay.ok, true);
  assert.equal(replay.updated_count, 0);
  assert.equal(f.store.getSession(dst).messages.filter((message) => message.id.startsWith(RECEIPT_ROW_PREFIX)).length, 1);
  const op = f.mail(src).outbox[0];
  assert.equal((await f.service.cancel({ ...V, operation_id: op.operation_id })).operation.state, 'delivered');
  assert.equal(INCLUDED_ROW_PREFIX, 'ctx_');
});

test('discard refuses while the destination has an active turn, and a reserved or unknown entry', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const messageId = (await f.sendNew(src, dst, 'wait')).prepared.envelope.message_id;
  const startedAt = new Date(f.clock.ms).toISOString();
  f.store.setActiveTurn(dst, {
    request_id: 'req_1', stream_id: 'stream_1', turn_id: 'turn_1', user_message_id: 'msg_1', status: 'streaming',
    started_at: startedAt, last_event_at: startedAt, session_incarnation: f.store.getSession(dst).session_incarnation,
  });
  assert.ok(f.store.getActiveTurn(dst), 'the fixture turn is active');
  const busy = await f.service.discard({ ...V, session_id: dst, message_ids: [messageId] });
  assert.equal(busy.reason, 'busy');
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(f.store.getSession(dst).messages.length, 0, 'no receipt row lands mid-turn');
  f.store.setActiveTurn(dst, null);
  assert.equal((await f.service.discard({ ...V, session_id: dst, message_ids: [UUID] })).error_code, CODES.INVALID_REQUEST);
  const mail = f.mail(dst);
  mail.inbox[0] = { ...mail.inbox[0], context: { state: 'reserved', turn_id: 'turn_1', snapshot_id: UUID } };
  f.store._updateSessionRecord(dst, { session_mail: mail }, { bumpUpdatedAt: false });
  assert.equal((await f.service.discard({ ...V, session_id: dst, message_ids: [messageId] })).reason, 'busy');
  assert.equal(f.store.getSession(dst).messages.length, 0);
});

test('discard replays: an existing receipt row from a crashed earlier attempt is reused, not duplicated', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const messageId = (await f.sendNew(src, dst, 'crash')).prepared.envelope.message_id;
  f.failFlush(dst, 1); // the mail mutate flush fails after the row was appended and flushed once
  const rowsFlushOk = await f.service.discard({ ...V, session_id: dst, message_ids: [messageId] });
  // The first flush (row append) consumed the injected failure: nothing was acknowledged.
  assert.equal(rowsFlushOk.ok, false);
  assert.equal(rowsFlushOk.reason, 'persistence_failure');
  assert.equal(rowsFlushOk.error_code, CODES.PERSISTENCE_FAILURE);
  assert.equal(f.mail(dst).inbox.length, 1, 'the inbox entry stays until the receipt is durable');
  const again = await f.service.discard({ ...V, session_id: dst, message_ids: [messageId] });
  assert.equal(again.ok, true);
  assert.equal(f.store.getSession(dst).messages.filter((message) => message.id === `${RECEIPT_ROW_PREFIX}${messageId}`).length, 1);
  assert.equal(f.mail(dst).discarded.length, 1);
});

test('confirmRestored is a real method with a closed request (setReporting since cp5b-1, createGrant / revokeGrant since cp5b-2)', async (t) => {
  const f = createFixture(t);
  for (const raw of [{ ...V, anything: true }, { anything: true }, null]) {
    const result = await f.service.confirmRestored(raw);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_request');
    assert.equal(result.error_code, CODES.INVALID_REQUEST);
  }
});

test('setReporting is a real method: a malformed request is invalid_request and an unlinked chat is refused (cp5b-1)', async (t) => {
  const f = createFixture(t);
  const plain = f.sessionId('Plain');
  assert.equal((await f.service.setReporting({ anything: true })).error_code, CODES.INVALID_REQUEST);
  assert.equal((await f.service.setReporting(null)).error_code, CODES.INVALID_REQUEST);
  const refused = await f.service.setReporting({ ...V, child_session_id: plain, enabled: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid_request');
  assert.notEqual(refused.reason, 'unsupported');
  assert.equal(f.mail(plain).reporting_enabled, false);
});

test('failure envelopes never carry exception text and notify reaches both sinks', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  f.service.notify(src);
  assert.equal(f.events.at(-1).session_id, src);
  assert.deepEqual(f.coordination.at(-1), src);
  const failure = await f.service.send({ ...V, operation_id: UUID });
  assert.deepEqual(Object.keys(failure).sort(), ['current_revision', 'error_code', 'ok', 'reason', 'retryable', 'schema_version']);
  assert.ok(f.logs.every(([, , details]) => !JSON.stringify(details || {}).includes('hello')));
});

test('agentListInbox lists only this chat inbox, newest first, previews bounded, nothing marked read', async (t) => {
  const f = createFixture(t);
  const a = f.sessionId('Alpha chat', { projectId: 'project_a' });
  const dst = f.sessionId('Dest');
  const other = f.sessionId('Other');
  const inc = (id) => f.store.getSession(id).session_incarnation;
  await f.sendNew(a, dst, 'first message');
  await f.sendNew(a, dst, `second ${'x'.repeat(400)}`);
  const third = (await f.sendNew(a, dst, 'third, to discard')).prepared.envelope.message_id;
  await f.sendNew(a, other, 'not for dest');
  assert.equal((await f.service.discard({ ...V, session_id: dst, message_ids: [third] })).ok, true);
  const listed = await f.service.agentListInbox({ sourceSessionId: dst, sourceIncarnation: inc(dst), limit: 2 });
  assert.equal(listed.ok, true);
  assert.equal(listed.truncated, true);
  assert.deepEqual(listed.messages.map((entry) => [entry.state, entry.read]), [['discarded', true], ['queued', false]]);
  const [discarded, second] = listed.messages;
  assert.equal(discarded.preview, '', 'excluded or discarded text is never previewed');
  assert.deepEqual(Object.keys(second).sort(), ['created_at', 'from', 'kind', 'message_id', 'preview', 'read', 'state']);
  assert.equal(second.kind, 'user_message');
  assert.deepEqual(second.from, { session_id: a, title: 'Alpha chat' });
  assert.equal(second.preview, '', 'queued text waits for its admitted turn');
  assert.equal(listed.counts.unread, 2);
  assert.equal(listed.counts.discarded, 1);
  const all = await f.service.agentListInbox({ sourceSessionId: dst, sourceIncarnation: inc(dst) });
  assert.deepEqual(all.messages.map((entry) => entry.preview), ['', '', ''], 'nothing is included yet, so nothing is previewed');
  assert.equal(all.messages.some((entry) => entry.preview === 'not for dest'), false);
  // Once a message has been included in an admitted turn, its preview is the body's first 280 characters.
  const mail = f.mail(dst);
  mail.inbox[0] = { ...mail.inbox[0], context: { state: 'included', turn_id: 'turn_1', snapshot_id: UUID,
    included_at: new Date().toISOString(), canonical_message_id: `ctx_${mail.inbox[0].envelope.message_id}` } };
  assert.ok(f.store._updateSessionRecord(dst, { session_mail: mail }, { bumpUpdatedAt: false }));
  const after = await f.service.agentListInbox({ sourceSessionId: dst, sourceIncarnation: inc(dst) });
  const included = after.messages.filter((entry) => entry.state === 'included');
  assert.equal(included.length, 1);
  assert.equal(included[0].preview, mail.inbox[0].envelope.body.slice(0, 280));
  assert.ok(included[0].preview.length > 0);
  assert.equal(f.store.getSessionSummary(dst).unread_message_count, 2, 'listing never marks mail read');
  for (const limit of [0, 51, 1.5]) {
    assert.equal((await f.service.agentListInbox({ sourceSessionId: dst, sourceIncarnation: inc(dst), limit })).reason, 'invalid_request');
  }
  assert.equal((await f.service.agentListInbox({ sourceSessionId: dst, sourceIncarnation: inc(a) })).reason, 'stale_operation');
});


test('resumeWake reaches the wake ops: a paused chat queues mail, Resume wakes it once for the oldest (row 76)', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest');
  let paused = true;
  f.backend.primaryChatControls = { isPaused: (id) => paused && id === dst };
  assert.equal((await f.sendNew(src, dst, 'first')).sent.ok, true);
  assert.equal((await f.sendNew(src, dst, 'second')).sent.ok, true);
  assert.equal(f.wakes.length, 0, 'a paused chat is not woken');
  assert.equal(f.mail(dst).inbox.filter((record) => record.context.state === 'queued').length, 2, 'the mail is still queued');
  assert.equal((await f.service.resumeWake(dst)).outcome, 'paused', 'still paused: the gate refuses');
  paused = false;
  assert.equal((await f.service.resumeWake(dst)).outcome, 'submitted');
  assert.equal(f.wakes.length, 1);
  assert.equal(f.wakes[0].request.sessionId, dst);
});
