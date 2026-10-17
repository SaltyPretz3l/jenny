'use strict';

/* The durable delivery transaction of an addressed session message (row 59
 * checkpoint 4): crash injection before / after each phase, recovery by Retry, by
 * the in-process recovery timer and by startup reconciliation, destination
 * failures that stay failed until the user retries, identity / project changes,
 * receipt-first recovery, expiry and the operation locate fallback. A flush
 * failure is modelled by the fixture's `failFlush` (one session, skip N flushes). */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const E = require('../services/backend/session-message-envelope');
const mailFixtures = require('./helpers/session-mail-fixtures');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');

const V = { schema_version: 1 };

async function setup(t, options) {
  const f = createFixture(t, options);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest');
  const prepared = await f.prepare(src, dst, 'payload');
  const send = () => f.service.send({ ...V, operation_id: prepared.operation_id });
  const retry = () => f.service.retry({ ...V, operation_id: prepared.operation_id });
  const outbox = () => f.mail(src).outbox.find((op) => op.operation_id === prepared.operation_id);
  return { f, src, dst, prepared, send, retry, outbox };
}

test('flush failure at phase 2 leaves the operation pending with nothing in the inbox; Retry delivers once', async (t) => {
  const { f, dst, send, retry, outbox } = await setup(t);
  f.failFlush(dst, 1);
  const failed = await send();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'persistence_failure');
  assert.equal(failed.error_code, CODES.PERSISTENCE_FAILURE);
  assert.equal(failed.retryable, true);
  assert.equal(outbox().state, 'pending');
  assert.equal(f.mail(dst).inbox.length, 0, 'the unflushed destination write is rolled back in memory');
  assert.equal(f.mail(dst).next_receive_sequence, 1);
  const delivered = await retry();
  assert.equal(delivered.ok, true);
  assert.equal(delivered.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(f.mail(dst).inbox[0].receive_sequence, 1);
});

test('the in-process recovery timer retries a pending operation with backoff and gives up after three tries', async (t) => {
  const { f, dst, send, outbox } = await setup(t);
  f.failFlush(dst, 4);
  await send();
  assert.deepEqual(f.timers.map((timer) => timer.ms), [1000]);
  f.timers[0].fn();
  assert.deepEqual(f.timers.map((timer) => timer.ms), [1000, 4000]);
  f.timers[1].fn();
  assert.deepEqual(f.timers.map((timer) => timer.ms), [1000, 4000, 16000]);
  f.timers[2].fn(); // third failure: no fourth timer, the operation waits for Retry or restart
  assert.equal(f.timers.length, 3);
  assert.equal(outbox().state, 'pending');
  f.failFlush(dst, 0);
  const { f: g, dst: dst2, send: send2, outbox: outbox2 } = await setup(t);
  g.failFlush(dst2, 1);
  await send2();
  g.timers[0].fn();
  assert.equal(outbox2().state, 'delivered', 'a timer retry that succeeds finalizes the delivery');
  assert.equal(g.mail(dst2).inbox.length, 1);
});

test('flush failure at phase 3 keeps the destination receipt; Retry finalizes with the same receipt and no duplicate', async (t) => {
  const { f, src, dst, send, retry, outbox } = await setup(t);
  f.failFlush(src, 1, 1); // the send mutate flush passes; the delivered receipt flush fails
  const failed = await send();
  assert.equal(failed.reason, 'persistence_failure');
  assert.equal(outbox().state, 'pending');
  assert.equal(f.mail(dst).inbox.length, 1, 'the destination write is durable');
  const receiptId = f.mail(dst).inbox[0].receipt_id;
  const done = await retry();
  assert.equal(done.operation.state, 'delivered');
  assert.equal(outbox().destination_receipt_id, receiptId);
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(f.mail(dst).next_receive_sequence, 2);
});

test('flush failure at phase 4 still answers delivered; startup reconciliation records the acknowledgment', async (t) => {
  const { f, src, dst, send, outbox } = await setup(t);
  f.failFlush(dst, 1, 1); // phase 2 flush passes; the acknowledgment flush fails
  const sent = await send();
  assert.equal(sent.ok, true);
  assert.equal(sent.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox[0].source_receipt_confirmed_at, null);
  assert.ok(f.logs.some(([, event]) => event === 'chat_messaging.confirm_not_persisted'));
  f.service.reconcileOnStartup();
  assert.notEqual(f.mail(dst).inbox[0].source_receipt_confirmed_at, null);
  assert.equal(outbox().state, 'delivered');
  assert.equal(f.mail(src).outbox.length, 1);
});

test('a source deleted before it acknowledged is marked absent at startup, so the destination record can retire', async (t) => {
  const { f, src, dst, send } = await setup(t);
  f.failFlush(dst, 1, 1); // the acknowledgment never persists
  assert.equal((await send()).ok, true);
  f.store.deleteSession(src);
  f.service.reconcileOnStartup();
  const record = f.mail(dst).inbox[0];
  assert.equal(record.source_absent, true);
  assert.equal(record.source_receipt_confirmed_at, null);
});

test('cancel races delivery: a destination receipt wins and the operation finalizes as delivered', async (t) => {
  const { f, src, dst, send, outbox, prepared } = await setup(t);
  f.failFlush(src, 1, 1);
  await send(); // destination durable, source still pending
  assert.equal(outbox().state, 'pending');
  const cancelled = await f.service.cancel({ ...V, operation_id: prepared.operation_id });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.created, false);
  assert.equal(cancelled.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox.length, 1);
});

test('recovery finds the destination receipt even after the recipient was archived or the chat changed', async (t) => {
  const { f, src, dst, send, retry, outbox } = await setup(t);
  f.failFlush(src, 1, 1);
  await send();
  f.archive(dst);
  f.store._updateSessionRecord(dst, { project_id: 'project_b' }, { bumpUpdatedAt: false });
  const done = await retry();
  assert.equal(done.ok, true);
  assert.equal(done.operation.state, 'delivered', 'a durable receipt proves delivery; later eligibility cannot block it');
  assert.equal(outbox().state, 'delivered');
  assert.equal(f.mail(dst).inbox.length, 1);
});

test('an archived recipient fails the send visibly; restoring it never delivers until the user retries', async (t) => {
  const { f, src, dst, send, retry, outbox } = await setup(t);
  f.archive(dst);
  const sent = await send();
  assert.equal(sent.ok, true);
  assert.equal(sent.operation.state, 'failed');
  assert.equal(sent.operation.last_error.reason, 'recipient_archived');
  assert.equal(sent.operation.last_error.code, CODES.RECIPIENT_ARCHIVED);
  assert.equal(sent.operation.last_error.retryable, true);
  assert.equal(f.mail(dst).inbox.length, 0);
  const counts = (await f.service.list({ ...V, session_id: src, direction: 'outbox' })).counts;
  assert.equal(counts.failed_delivery, 1);
  f.store.setSessionMeta(dst, { archived_at: null });
  f.service.reconcileOnStartup();
  assert.equal(outbox().state, 'failed', 'restore does not deliver automatically');
  const done = await retry();
  assert.equal(done.created, true);
  assert.equal(done.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(outbox().authorization_id !== null, true);
  assert.equal(f.mail(src).authorizations.length, 1, 'Retry reuses the consumed authorization');
});

test('a deleted recipient is a permanent failure; Retry answers recipient_deleted without recreating anything', async (t) => {
  const { f, dst, send, retry, outbox } = await setup(t);
  f.store.deleteSession(dst);
  const sent = await send();
  assert.equal(sent.operation.state, 'failed');
  assert.equal(sent.operation.last_error.reason, 'recipient_deleted');
  assert.equal(sent.operation.last_error.retryable, false);
  assert.equal(sent.operation.destination.available, false);
  const again = await retry();
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'recipient_deleted');
  assert.equal(again.error_code, CODES.RECIPIENT_DELETED);
  assert.equal(outbox().state, 'failed');
  assert.equal(f.store.getSession(dst), null);
});

test('a full destination inbox fails with recipient_backpressure and delivers on Retry once space exists', async (t) => {
  const { f, dst, send, retry, outbox } = await setup(t);
  const inbox = Array.from({ length: 256 }, (_, n) => mailFixtures.makeInbox(n + 1, {}, {
    source: { session_id: 'sess_other', session_incarnation: 'inc_o' }, destination: { session_id: dst },
  }));
  f.store._updateSessionRecord(dst, {
    session_mail: { ...mailFixtures.emptyMail(), inbox, next_receive_sequence: 257 }, coordination_revision: 1,
  }, { bumpUpdatedAt: false });
  const sent = await send();
  assert.equal(sent.operation.state, 'failed');
  assert.equal(sent.operation.last_error.reason, 'recipient_backpressure');
  assert.equal(sent.operation.last_error.code, CODES.RECIPIENT_BACKPRESSURE);
  assert.equal(f.mail(dst).inbox.length, 256, 'nothing is evicted to make room');
  f.store._updateSessionRecord(dst, {
    session_mail: { ...mailFixtures.emptyMail(), next_receive_sequence: 257 }, coordination_revision: 2,
  }, { bumpUpdatedAt: false });
  const done = await retry();
  assert.equal(done.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox[0].receive_sequence, 257, 'the sequence only moves forward');
  assert.equal(outbox().state, 'delivered');
});

test('a destination whose identity or project changed since prepare fails stale_operation and never retries', async (t) => {
  for (const change of [{ session_incarnation: 'inc_replaced' }, { project_id: 'project_b' }]) {
    const { f, dst, send, retry, outbox } = await setup(t);
    f.store._updateSessionRecord(dst, change, { bumpUpdatedAt: false });
    const sent = await send();
    assert.equal(sent.operation.state, 'failed');
    assert.equal(sent.operation.last_error.reason, 'stale_operation');
    assert.equal(sent.operation.last_error.retryable, false);
    assert.equal(f.mail(dst).inbox.length, 0);
    assert.equal((await retry()).reason, 'stale_operation');
    assert.equal(outbox().state, 'failed');
  }
});

test('the same message id with a different envelope is an idempotency conflict and is never merged', async (t) => {
  const { f, dst, send, outbox, prepared } = await setup(t);
  const altered = E.validateEnvelope({ ...prepared.envelope, created_at: '2026-10-15T09:00:00.000Z' });
  assert.ok(altered);
  const mail = { ...mailFixtures.emptyMail(), next_receive_sequence: 2 };
  mail.inbox = [{
    envelope: altered, receipt_id: '11111111-1111-4111-8111-111111111111', receive_sequence: 1,
    delivered_at: '2026-10-15T09:00:00.000Z', read_at: null, source_receipt_confirmed_at: null, source_absent: false,
    context: { state: 'queued' },
  }];
  f.store._updateSessionRecord(dst, { session_mail: mail, coordination_revision: 1 }, { bumpUpdatedAt: false });
  const sent = await send();
  assert.equal(sent.operation.state, 'failed');
  assert.equal(sent.operation.last_error.reason, 'idempotency_conflict');
  assert.equal(sent.operation.last_error.code, CODES.IDEMPOTENCY_CONFLICT);
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(outbox().state, 'failed');
});

test('an identical envelope already in the destination is idempotent success, discard receipts included', async (t) => {
  const { f, dst, send, outbox, prepared } = await setup(t);
  const mail = { ...mailFixtures.emptyMail(), next_receive_sequence: 2 };
  mail.discarded = [{
    schema_version: 1, message_id: prepared.envelope.message_id, envelope_sha256: E.envelopeSha256(prepared.envelope),
    receipt_id: '22222222-2222-4222-8222-222222222222', receive_sequence: 1, discarded_at: '2026-10-15T09:00:00.000Z',
    source_receipt_confirmed_at: null, source_absent: false, canonical_message_id: `ctxr_${prepared.envelope.message_id}`,
  }];
  f.store._updateSessionRecord(dst, { session_mail: mail, coordination_revision: 1 }, { bumpUpdatedAt: false });
  const sent = await send();
  assert.equal(sent.operation.state, 'delivered');
  assert.equal(outbox().destination_receipt_id, '22222222-2222-4222-8222-222222222222');
  assert.equal(f.mail(dst).inbox.length, 0, 'a matching delivery replay finds the receipt, not a new inbox entry');
  assert.notEqual(f.mail(dst).discarded[0].source_receipt_confirmed_at, null);
});

test('startup reconciliation delivers pending sends, expires prepared ones and settles reserved admission snapshots', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const other = f.sessionId('O');
  const stuck = await f.prepare(src, dst, 'stuck');
  f.failFlush(dst, 1);
  await f.service.send({ ...V, operation_id: stuck.operation_id });
  const lapsing = await f.prepare(src, other, 'lapsing');
  const reserved = mailFixtures.makeSnapshot(1, { state: 'reserved' });
  f.store._updateSessionRecord(other, {
    session_mail: { ...mailFixtures.emptyMail(), admission_snapshots: [reserved] }, coordination_revision: 5,
  }, { bumpUpdatedAt: false });
  f.advance(25 * 60 * 60 * 1000);
  f.service.reconcileOnStartup();
  const ops = f.mail(src).outbox;
  assert.equal(ops.find((op) => op.operation_id === stuck.operation_id).state, 'delivered');
  const expired = ops.find((op) => op.operation_id === lapsing.operation_id);
  assert.equal(expired.state, 'cancelled');
  assert.equal(expired.last_error.code, CODES.STALE_OPERATION);
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.deepEqual(f.admission, [other], 'only a chat with a reserved snapshot is handed to admission');
});

test('reconciliation never throws on a broken session and keeps going', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('S');
  const dst = f.sessionId('D');
  const stuck = await f.prepare(src, dst, 'stuck');
  f.failFlush(dst, 1);
  await f.service.send({ ...V, operation_id: stuck.operation_id });
  const original = f.store.peekSession.bind(f.store);
  let calls = 0;
  f.store.peekSession = (id) => { calls += 1; if (calls === 1) throw new Error('boom C:\\secret'); return original(id); };
  assert.doesNotThrow(() => f.service.reconcileOnStartup());
  assert.ok(f.logs.some(([, event]) => event === 'chat_messaging.reconcile_failed'));
  assert.ok(f.logs.every(([, , details]) => !JSON.stringify(details || {}).includes('secret')));
});

test('an operation unknown to the locate cache is found by scanning, so restart needs no index', async (t) => {
  const { f, send, outbox } = await setup(t);
  f.service._operations.clear();
  const sent = await send();
  assert.equal(sent.ok, true);
  assert.equal(outbox().state, 'delivered');
});

test('send to a chat that already holds mail assigns the next receive sequence and keeps both senders ordered', async (t) => {
  const f = createFixture(t);
  const a = f.sessionId('A');
  const b = f.sessionId('B');
  const dst = f.sessionId('D');
  await f.sendNew(a, dst, 'first');
  await f.sendNew(b, dst, 'second');
  await f.sendNew(a, dst, 'third');
  assert.deepEqual(f.mail(dst).inbox.map((record) => [record.receive_sequence, record.envelope.body]), [[1, 'first'], [2, 'second'], [3, 'third']]);
  assert.equal(f.mail(dst).next_receive_sequence, 4);
});
