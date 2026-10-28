'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../services/backend/session-mail-records');
const { countFailedOutbox, countUnreadInbox } = R;
const { buildSessionSummary } = require('../services/backend/session-summary-projection');
const F = require('./helpers/session-mail-fixtures');

const DAY = 24 * 60 * 60 * 1000;

function normalizedMail(parts = {}) {
  return { ...F.emptyMail(), ...parts };
}

test('every valid fixture normalizes to itself', () => {
  const outbox = F.makeOutbox(1);
  assert.deepEqual(R.normalizeOutboxRecord(outbox), outbox);
  assert.notEqual(R.normalizeOutboxRecord(outbox), outbox, 'returns a clone');
  const inbox = F.makeInbox(1);
  assert.deepEqual(R.normalizeInboxRecord(inbox), inbox);
  assert.deepEqual(R.normalizeDiscardReceipt(F.makeDiscard(1)), F.makeDiscard(1));
  assert.deepEqual(R.normalizeAuthorizationRecord(F.makeAuthorization(1)), F.makeAuthorization(1));
  assert.deepEqual(R.normalizeAdmissionSnapshot(F.makeSnapshot(1)), F.makeSnapshot(1));
  assert.deepEqual(R.normalizeReportReservation(F.makeReservation(1)), F.makeReservation(1));
  assert.notEqual(R.normalizeReportReservation(F.makeReservation(1)), F.makeReservation(1), 'returns a clone');
});

test('outbox: closed keys, enums, identities and state combinations', () => {
  const ok = F.makeOutbox(1);
  const bad = [
    { ...ok, extra: 1 },
    { ...ok, state: 'sent' },
    { ...ok, operation_id: 'nope' },
    { ...ok, gesture_id: 'nope' },
    { ...ok, authorization_id: 'nope' },
    { ...ok, prepared_at: 'now' },
    { ...ok, last_error: { code: 'CMP-MESSAGE-0099', reason: 'x', retryable: true } },
    { ...ok, last_error: { code: 'CMP-MESSAGE-0011', reason: 'io_failed', retryable: 'yes' } },
    { ...ok, restore_requires_confirmation: 'no' },
    { ...ok, envelope: { ...ok.envelope, body: 'tampered' } },
    { ...ok, state: 'delivered' }, // no delivered_at / receipt
    { ...ok, state: 'pending' }, // no send_requested_at
    { ...ok, send_requested_at: F.iso() }, // prepared with a send time
    { ...ok, destination_receipt_id: F.uuid(9) }, // receipt on a non-delivered op
    { ...ok, state: 'failed', send_requested_at: F.iso() }, // failed needs last_error
    null,
    [],
    'x',
  ];
  for (const record of bad) assert.equal(R.normalizeOutboxRecord(record), null, JSON.stringify(record));
  const { envelope: _gone, ...noEnvelope } = ok;
  assert.equal(R.normalizeOutboxRecord(noEnvelope), null);
  const pending = F.makeOutbox(1, { state: 'pending', send_requested_at: F.iso(), authorization_id: F.uuid(5001) });
  assert.ok(R.normalizeOutboxRecord(pending));
  const delivered = { ...pending, state: 'delivered', delivered_at: F.iso(), destination_receipt_id: F.uuid(3001) };
  assert.ok(R.normalizeOutboxRecord(delivered));
  const failed = { ...pending, state: 'failed', last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } };
  assert.ok(R.normalizeOutboxRecord(failed));
  assert.ok(R.normalizeOutboxRecord(F.makeOutbox(1, { state: 'cancelled' })));
  assert.ok(R.normalizeOutboxRecord(F.makeOutbox(1, { tool_call_id: 'call_1' })));
});

test('inbox: every context state, strict keys and the canonical id', () => {
  const states = [
    { state: 'queued' },
    { state: 'reserved', turn_id: 'turn_1', snapshot_id: F.uuid(6001) },
    { state: 'included', turn_id: 'turn_1', snapshot_id: F.uuid(6001), included_at: F.iso(), canonical_message_id: `ctx_${F.uuid(1)}` },
    { state: 'excluded_by_user', changed_at: F.iso() },
  ];
  for (const context of states) assert.ok(R.normalizeInboxRecord(F.makeInbox(1, { context })), context.state);
  const badContexts = [
    { state: 'queued', extra: 1 },
    { state: 'reserved', turn_id: 'turn_1' },
    { state: 'reserved', turn_id: '', snapshot_id: F.uuid(6001) },
    { ...states[2], canonical_message_id: 'ctx_other' },
    { ...states[2], included_at: 'x' },
    { state: 'excluded_by_user' },
    { state: 'gone' },
    null,
  ];
  for (const context of badContexts) assert.equal(R.normalizeInboxRecord(F.makeInbox(1, { context })), null, JSON.stringify(context));
  for (const patch of [{ receive_sequence: 0 }, { receive_sequence: 1.5 }, { receipt_id: 'x' }, { read_at: 'x' }, { source_absent: 0 },
    { delivered_at: null }, { extra: 1 }]) {
    assert.equal(R.normalizeInboxRecord(F.makeInbox(1, patch)), null, JSON.stringify(patch));
  }
});

test('discard receipt, authorization and snapshot reject malformed records', () => {
  const discard = F.makeDiscard(1);
  for (const patch of [{ envelope_sha256: 'short' }, { canonical_message_id: `ctx_${F.uuid(1)}` }, { receive_sequence: 0 },
    { schema_version: 2 }, { source_absent: 'no' }, { extra: 1 }]) {
    assert.equal(R.normalizeDiscardReceipt({ ...discard, ...patch }), null, JSON.stringify(patch));
  }
  const auth = F.makeAuthorization(1);
  for (const patch of [{ kind: 'god_mode' }, { remaining_sends: -1 }, { remaining_sends: 101 }, { operation_id: null },
    { body_sha256: 'x' }, { purpose: 'why' }, { consent_event_id: '' }, { revoked_at: 'x' }, { schema_version: 2 }, { extra: 1 }]) {
    assert.equal(R.normalizeAuthorizationRecord({ ...auth, ...patch }), null, JSON.stringify(patch));
  }
  const directional = F.makeGrant(1);
  assert.ok(R.normalizeAuthorizationRecord(directional));
  assert.equal(R.normalizeAuthorizationRecord({ ...directional, operation_id: F.uuid(1) }), null);
  const snap = F.makeSnapshot(1);
  const dup = { message_id: F.uuid(1), body_sha256: F.makeEnvelope(1).body_sha256 };
  for (const patch of [{ state: 'finalized' }, { deferred_reason: 'because' }, { entries: [dup, dup] }, { entries: [{ ...dup, extra: 1 }] },
    { entries: Array.from({ length: 17 }, (_, i) => ({ message_id: F.uuid(i + 1), body_sha256: dup.body_sha256 })) },
    { cutoff_receive_sequence: 0 }, { deferred_count: -1 }, { estimator_id: '' }, { snapshot_id: 'x' }, { extra: 1 }]) {
    assert.equal(R.normalizeAdmissionSnapshot({ ...snap, ...patch }), null, JSON.stringify(patch));
  }
  assert.ok(R.normalizeAdmissionSnapshot({ ...snap, entries: [], deferred_count: 2, deferred_reason: 'budget_unknown' }));
  assert.ok(R.normalizeAdmissionSnapshot({ ...snap, state: 'reserved', deferred_reason: 'context_budget' }));
});

test('partitionList keeps invalid, future and duplicate entries as opaque raw values', () => {
  const [normalize, identity] = R.NORMALIZERS.inbox;
  const first = F.makeInbox(1);
  const future = { envelope: { ...F.makeEnvelope(2), schema_version: 2 }, whatever: ['kept'] };
  const duplicate = F.makeInbox(1, { receive_sequence: 9 });
  const { records, opaque } = R.partitionList([future, first, duplicate, 'junk'], normalize, identity);
  assert.deepEqual(records, [first]);
  assert.deepEqual(opaque, [future, duplicate, 'junk']);
  assert.deepEqual(R.partitionList(undefined, normalize, identity), { records: [], opaque: [] });
});

test('computeCounts reports unread, per-state, delivery and the deferred reason', () => {
  const included = { state: 'included', turn_id: 't1', snapshot_id: F.uuid(6001), included_at: F.iso(), canonical_message_id: `ctx_${F.uuid(4)}` };
  const mail = normalizedMail({
    inbox: [
      F.makeInbox(1),
      F.makeInbox(2, { read_at: F.iso(), context: { state: 'excluded_by_user', changed_at: F.iso() } }),
      F.makeInbox(3, { context: { state: 'reserved', turn_id: 't', snapshot_id: F.uuid(6002) } }),
      F.makeInbox(4, { read_at: F.iso(), context: included }),
    ],
    outbox: [
      F.makeOutbox(1),
      F.makeOutbox(2, { state: 'pending', send_requested_at: F.iso() }),
      F.makeOutbox(3, { state: 'failed', send_requested_at: F.iso(), last_error: { code: 'CMP-MESSAGE-0009', reason: 'recipient_backpressure', retryable: true } }),
      F.makeOutbox(4, { state: 'cancelled' }),
    ],
    admission_snapshots: [
      F.makeSnapshot(1, { deferred_reason: 'context_budget', created_at: F.iso(1000) }),
      F.makeSnapshot(2, { deferred_reason: null, created_at: F.iso(500) }),
      F.makeSnapshot(3, { deferred_reason: 'budget_unknown', state: 'reserved', created_at: F.iso(9000) }),
    ],
  });
  assert.deepEqual(R.computeCounts(mail, { now: F.NOW }), {
    unread: 2, queued: 1, reserved: 1, excluded_by_user: 1, included: 1,
    pending_delivery: 1, failed_delivery: 1, deferred_reason: 'context_budget',
  });
  assert.deepEqual(R.computeCounts(normalizedMail(), {}), {
    unread: 0, queued: 0, reserved: 0, excluded_by_user: 0, included: 0,
    pending_delivery: 0, failed_delivery: 0, deferred_reason: null,
  });
  const drained = normalizedMail({ inbox: [F.makeInbox(1, { context: included })], admission_snapshots: mail.admission_snapshots });
  assert.equal(R.computeCounts(drained).deferred_reason, null, 'no queued mail, no deferral');
});

test('countUnreadInbox is a cheap structural count over raw entries', () => {
  assert.equal(countUnreadInbox(undefined), 0);
  assert.equal(countUnreadInbox({ inbox: 'x' }), 0);
  assert.equal(countUnreadInbox(normalizedMail({ inbox: [F.makeInbox(1), F.makeInbox(2, { read_at: F.iso() }), null, 'x', { read_at: null }] })), 1);
});

test('failed_delivery_count: only failed outbox records count, and a frozen container reads 0', () => {
  const failedError = { code: 'CMP-MESSAGE-0009', reason: 'recipient_backpressure', retryable: true };
  const outbox = [
    F.makeOutbox(1, { state: 'failed', send_requested_at: F.iso(), last_error: failedError }),
    F.makeOutbox(2, { state: 'pending', send_requested_at: F.iso() }),
    F.makeOutbox(3, { state: 'delivered', send_requested_at: F.iso(), delivered_at: F.iso() }),
    F.makeOutbox(4, { state: 'cancelled' }),
    F.makeOutbox(5), null, 'x',
  ];
  assert.equal(countFailedOutbox(undefined), 0);
  assert.equal(countFailedOutbox({ outbox: 'x' }), 0);
  assert.equal(countFailedOutbox(normalizedMail({ outbox })), 1);
  assert.equal(buildSessionSummary({ session_mail: normalizedMail({ outbox }) }).failed_delivery_count, 1);
  assert.equal(buildSessionSummary({ session_mail: normalizedMail({ outbox: outbox.slice(1) }) }).failed_delivery_count, 0);
  assert.equal(buildSessionSummary({}).failed_delivery_count, 0, 'no mail reads 0');
  const frozen = { ...normalizedMail({ outbox }), schema_version: 2 };
  assert.equal(buildSessionSummary({ session_mail: frozen }).failed_delivery_count, 0, 'a frozen container reads 0');
});

test('inbox capacity: 256 records or 2 MiB of body bytes', () => {
  const empty = R.inboxCapacity(normalizedMail());
  assert.deepEqual(empty, { records: 0, body_bytes: 0, full: false });
  const records = Array.from({ length: 255 }, (_, i) => F.makeInbox(i + 1));
  const almost = R.inboxCapacity(normalizedMail({ inbox: records }));
  assert.equal(almost.records, 255);
  assert.equal(almost.full, false);
  assert.equal(R.inboxCapacity(normalizedMail({ inbox: [...records, F.makeInbox(256)] })).full, true);
  const big = 'x'.repeat(16384);
  const heavy = Array.from({ length: 127 }, (_, i) => F.makeInbox(i + 1, {}, { body: big }));
  const state = normalizedMail({ inbox: heavy });
  assert.equal(R.inboxCapacity(state, big).body_bytes, 127 * 16384);
  assert.equal(R.inboxCapacity(state, big).full, false);
  const nearly = normalizedMail({ inbox: [...heavy, F.makeInbox(200, {}, { body: big })] });
  assert.equal(R.inboxCapacity(nearly, big).full, true, '128 x 16 KiB = 2 MiB leaves no room');
  assert.equal(R.inboxCapacity(nearly, { body: big }).full, true);
  assert.equal(R.inboxCapacity(nearly, { envelope: F.makeEnvelope(1, { body: big }) }).full, true);
  assert.equal(R.inboxCapacity(nearly, 1).full, true);
});

test('outbox capacity counts only undelivered operations: 128 records or 2 MiB', () => {
  const finalized = [F.makeOutbox(300, { state: 'cancelled' }), F.makeOutbox(301, { state: 'delivered', send_requested_at: F.iso(), delivered_at: F.iso(), destination_receipt_id: F.uuid(3301) })];
  const undelivered = Array.from({ length: 127 }, (_, i) => F.makeOutbox(i + 1));
  const state = normalizedMail({ outbox: [...finalized, ...undelivered] });
  const expectedBytes = undelivered.reduce((sum, r) => sum + Buffer.byteLength(r.envelope.body, 'utf8'), 0);
  assert.deepEqual(R.outboxCapacity(state), { records: 127, body_bytes: expectedBytes, full: false });
  assert.equal(R.outboxCapacity(normalizedMail({ outbox: [...undelivered, F.makeOutbox(128)] })).full, true);
  const big = 'x'.repeat(16384);
  const heavy = Array.from({ length: 128 }, (_, i) => F.makeOutbox(i + 1, { state: 'pending', send_requested_at: F.iso() }, { body: big }));
  assert.equal(R.outboxCapacity(normalizedMail({ outbox: heavy })).full, true);
});

test('pruneMail expires prepared operations past 24 h as cancelled(stale_operation)', () => {
  const old = F.makeOutbox(1, { expires_at: F.iso(-1) });
  const live = F.makeOutbox(2, { expires_at: F.iso(DAY) });
  const pending = F.makeOutbox(3, { state: 'pending', send_requested_at: F.iso(-5 * DAY), expires_at: F.iso(-4 * DAY) });
  const pruned = R.pruneMail(normalizedMail({ outbox: [old, live, pending] }), { now: F.NOW });
  assert.equal(pruned.outbox[0].state, 'cancelled');
  assert.deepEqual(pruned.outbox[0].last_error, { code: 'CMP-MESSAGE-0012', reason: 'stale_operation', retryable: false });
  assert.ok(R.normalizeOutboxRecord(pruned.outbox[0]), 'the expired op is still a valid record');
  assert.equal(pruned.outbox[1].state, 'prepared');
  assert.equal(pruned.outbox[2].state, 'pending', 'only prepared operations expire');
});

test('pruneMail retires read, included and acknowledged inbox records only', () => {
  const included = (n, extra) => F.makeInbox(n, {
    context: { state: 'included', turn_id: 't', snapshot_id: F.uuid(6001), included_at: F.iso(), canonical_message_id: `ctx_${F.uuid(n)}` },
    ...extra,
  });
  const keepers = [
    included(1, { read_at: F.iso() }), // not acknowledged
    included(2, { source_receipt_confirmed_at: F.iso() }), // unread
    F.makeInbox(3, { read_at: F.iso(), source_receipt_confirmed_at: F.iso() }), // not included
  ];
  const retired = [included(4, { read_at: F.iso(), source_receipt_confirmed_at: F.iso() }), included(5, { read_at: F.iso(), source_absent: true })];
  const pruned = R.pruneMail(normalizedMail({ inbox: [...retired, ...keepers] }), { now: F.NOW });
  assert.deepEqual(pruned.inbox.map((r) => r.envelope.message_id), keepers.map((r) => r.envelope.message_id));
});

test('pruneMail caps finalized outbox at 1,024 / 30 days and never touches undelivered', () => {
  const delivered = (n, at) => F.makeOutbox(n, { state: 'delivered', send_requested_at: at, delivered_at: at, destination_receipt_id: F.uuid(3000 + n), prepared_at: at });
  const many = Array.from({ length: 1030 }, (_, i) => delivered(i + 1, F.iso(i * 1000)));
  const tooOld = delivered(2000, F.iso(-31 * DAY));
  const failedOld = F.makeOutbox(2001, { state: 'failed', send_requested_at: F.iso(-90 * DAY), prepared_at: F.iso(-90 * DAY), last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } });
  const pendingOld = F.makeOutbox(2002, { state: 'pending', send_requested_at: F.iso(-90 * DAY), prepared_at: F.iso(-90 * DAY) });
  const pruned = R.pruneMail(normalizedMail({ outbox: [...many, tooOld, failedOld, pendingOld] }), { now: F.NOW });
  const ids = new Set(pruned.outbox.map((r) => r.envelope.message_id));
  assert.equal(pruned.outbox.filter((r) => r.state === 'delivered').length, 1024);
  assert.equal(ids.has(F.uuid(1)), false, 'oldest dropped');
  assert.equal(ids.has(F.uuid(1030)), true, 'newest kept');
  assert.equal(ids.has(F.uuid(2000)), false, 'older than 30 days dropped');
  assert.equal(ids.has(F.uuid(2001)) && ids.has(F.uuid(2002)), true, 'undelivered is protected');
});

test('pruneMail keeps discard receipts that are the only dedup proof', () => {
  const acked = (n, at) => F.makeDiscard(n, { discarded_at: at, source_receipt_confirmed_at: at });
  const unacked = F.makeDiscard(1, { discarded_at: F.iso(-90 * DAY) });
  const absent = F.makeDiscard(2, { discarded_at: F.iso(-90 * DAY), source_absent: true });
  const old = acked(3, F.iso(-31 * DAY));
  const fresh = acked(4, F.iso(-1000));
  const pruned = R.pruneMail(normalizedMail({ discarded: [unacked, absent, old, fresh] }), { now: F.NOW });
  assert.deepEqual(pruned.discarded.map((r) => r.message_id), [F.uuid(1), F.uuid(4)]);
  const many = Array.from({ length: 1026 }, (_, i) => acked(i + 10, F.iso(-i * 1000)));
  assert.equal(R.pruneMail(normalizedMail({ discarded: many }), { now: F.NOW }).discarded.length, 1024);
});

test('pruneMail drops orphaned authorizations and keeps the latest 64 published snapshots', () => {
  const op = F.makeOutbox(1);
  const live = F.makeAuthorization(1);
  const orphan = F.makeAuthorization(2);
  const snapshots = Array.from({ length: 70 }, (_, i) => F.makeSnapshot(i + 1, { state: 'published' }));
  const reserved = F.makeSnapshot(100, { state: 'reserved', created_at: F.iso(-DAY) });
  const pruned = R.pruneMail(normalizedMail({ outbox: [op], authorizations: [live, orphan], admission_snapshots: [reserved, ...snapshots] }), { now: F.NOW });
  assert.deepEqual(pruned.authorizations.map((a) => a.authorization_id), [live.authorization_id]);
  assert.equal(pruned.admission_snapshots.filter((s) => s.state === 'published').length, 64);
  assert.equal(pruned.admission_snapshots.some((s) => s.snapshot_id === snapshots[0].snapshot_id), false);
  assert.equal(pruned.admission_snapshots.some((s) => s.snapshot_id === snapshots[69].snapshot_id), true);
  assert.equal(pruned.admission_snapshots.some((s) => s.state === 'reserved'), true, 'reserved is never pruned');
});

test('pruneMail does not mutate its input and is stable on a second pass', () => {
  const mail = normalizedMail({ outbox: [F.makeOutbox(1, { expires_at: F.iso(-1) })], inbox: [F.makeInbox(1)] });
  const before = structuredClone(mail);
  const once = R.pruneMail(mail, { now: F.NOW });
  assert.deepEqual(mail, before);
  assert.deepEqual(R.pruneMail(once, { now: F.NOW }), once);
  assert.throws(() => R.pruneMail(mail, { now: 'not a date' }));
});

test('report reservation: closed keys, ids, the fixed 8192 slot, timestamp and consent UUID', () => {
  const ok = F.makeReservation(1);
  const bad = [
    { ...ok, extra: 1 },
    { ...ok, slot_bytes: 8191 },
    { ...ok, slot_bytes: 16384 },
    { ...ok, slot_bytes: '8192' },
    { ...ok, turn_id: '' },
    { ...ok, turn_id: 7 },
    { ...ok, turn_id: 'x'.repeat(513) },
    { ...ok, parent_session_id: '' },
    { ...ok, parent_session_incarnation: null },
    { ...ok, reserved_at: 'now' },
    { ...ok, reserved_at: '2026-10-15T10:00:00Z' },
    { ...ok, reporting_consent_id: 'nope' },
    { ...ok, reporting_consent_id: 'ABCDEF01-0000-4000-8000-000000000001' },
    { ...ok, reporting_consent_id: null },
    (({ turn_id: _drop, ...rest }) => rest)(ok),
    { ...ok, schema_version: 1 },
    [],
    null,
    'text',
  ];
  for (const value of bad) assert.equal(R.normalizeReportReservation(value), null, JSON.stringify(value));
});

test('report_reservations is a normalizer list keyed by turn_id, so malformed entries stay opaque', () => {
  const [normalize, identity] = R.NORMALIZERS.report_reservations;
  assert.equal(normalize, R.normalizeReportReservation);
  assert.equal(identity(F.makeReservation(3)), 'turn_3');
  const parts = R.partitionList(
    [F.makeReservation(1), { turn_id: 'turn_2', slot_bytes: 8192 }, F.makeReservation(1, { reserved_at: F.iso(5) }), 'junk'],
    normalize,
    identity,
  );
  assert.deepEqual(parts.records, [F.makeReservation(1)]);
  assert.equal(parts.opaque.length, 3);
});

test('outbox capacity counts each report reservation as one record plus 8192 bytes', () => {
  const undelivered = Array.from({ length: 10 }, (_, i) => F.makeOutbox(i + 1));
  const without = R.outboxCapacity(normalizedMail({ outbox: undelivered }));
  const reservations = [F.makeReservation(1), F.makeReservation(2), F.makeReservation(3)];
  const withSlots = R.outboxCapacity(normalizedMail({ outbox: undelivered, report_reservations: reservations }));
  assert.deepEqual(withSlots, { records: 13, body_bytes: without.body_bytes + 3 * 8192, full: false });
  assert.deepEqual(R.outboxCapacity({ outbox: undelivered }), without, 'a mail without the list is unchanged');
  assert.deepEqual(R.outboxCapacity(normalizedMail({ outbox: undelivered, report_reservations: [] })), without);
  const nearly = Array.from({ length: 125 }, (_, i) => F.makeOutbox(i + 1));
  assert.equal(R.outboxCapacity(normalizedMail({ outbox: nearly, report_reservations: [F.makeReservation(1)] })).full, false);
  assert.equal(R.outboxCapacity(normalizedMail({ outbox: nearly, report_reservations: reservations })).full, true, '125 + 3 = 128');
  const lone = normalizedMail({ report_reservations: [F.makeReservation(1)] });
  assert.equal(R.outboxCapacity(lone).full, false);
  assert.equal(R.outboxCapacity(lone, 2 * 1024 * 1024 - 8191).full, true);
  assert.equal(R.outboxCapacity(lone, 2 * 1024 * 1024 - 8192).full, false);
});

test('computeCounts and pruneMail leave report reservations alone', () => {
  const reservations = [F.makeReservation(1), F.makeReservation(2)];
  const mail = normalizedMail({ report_reservations: reservations, outbox: [F.makeOutbox(1, { state: 'pending', send_requested_at: F.iso() })] });
  assert.equal(R.computeCounts(mail).pending_delivery, 1);
  assert.deepEqual(R.computeCounts(normalizedMail({ report_reservations: reservations })), R.computeCounts(normalizedMail()));
  const old = F.makeReservation(3, { reserved_at: F.iso(-400 * DAY) });
  const pruned = R.pruneMail(normalizedMail({ report_reservations: [...reservations, old] }), { now: F.NOW });
  assert.deepEqual(pruned.report_reservations, [...reservations, old]);
});

// ---------- cp5b-2: directional grants, agent sends, authorization checks ----------

test('directional grant: purpose is required and 1-512 UTF-8 bytes; expiry is exactly created + 7 days', () => {
  const grant = F.makeGrant(1);
  assert.deepEqual(R.normalizeAuthorizationRecord(grant), grant);
  for (const purpose of [null, '', 'x'.repeat(513), 'é'.repeat(257), '\ud800', 5]) {
    assert.equal(R.normalizeAuthorizationRecord({ ...grant, purpose }), null, JSON.stringify(purpose));
  }
  assert.ok(R.normalizeAuthorizationRecord({ ...grant, purpose: 'x'.repeat(512) }));
  assert.ok(R.normalizeAuthorizationRecord({ ...grant, purpose: 'é'.repeat(256) }), '256 two-byte characters are 512 bytes');
  for (const expires of [null, F.iso(F.WEEK_MS - 1), F.iso(F.WEEK_MS + 1), F.iso(DAY), F.iso(-1)]) {
    assert.equal(R.normalizeAuthorizationRecord({ ...grant, expires_at: expires }), null, String(expires));
  }
  assert.equal(R.validPurpose('ok'), true);
  assert.equal(R.validPurpose(''), false);
});

test('per-operation authorizations keep their own rules: agent_once binds an operation and may carry no purpose', () => {
  const once = F.makeAuthorization(1, { kind: 'agent_once', consent_event_id: 'approval_1' });
  assert.ok(R.normalizeAuthorizationRecord(once));
  assert.equal(R.normalizeAuthorizationRecord({ ...once, operation_id: null }), null);
  assert.equal(R.normalizeAuthorizationRecord({ ...once, purpose: 'x'.repeat(513) }), null);
  assert.equal(R.normalizeAuthorizationRecord(F.makeAuthorization(1, { purpose: 'not for a user send' })), null);
});

test('findAgentOperation and countAgentSendsForTurn key on the incarnation, turn and tool call', () => {
  const one = F.makeAgentOutbox(1);
  const two = F.makeAgentOutbox(2, {}, { turnId: 'turn_2' });
  const user = F.makeOutbox(3);
  const mail = normalizedMail({ outbox: [one, two, user] });
  const identity = { incarnation: 'inc_src', turnId: 'turn_1', toolCallId: 'call_1' };
  assert.equal(R.findAgentOperation(mail, identity).operation_id, one.operation_id);
  assert.equal(R.findAgentOperation(mail, { ...identity, toolCallId: 'call_2' }), null, 'another turn owns call_2');
  assert.equal(R.findAgentOperation(mail, { ...identity, incarnation: 'inc_other' }), null);
  assert.equal(R.countAgentSendsForTurn(mail, identity), 1);
  assert.equal(R.countAgentSendsForTurn(mail, { incarnation: 'inc_src', turnId: 'turn_2' }), 1);
  assert.equal(R.countAgentSendsForTurn(mail, { incarnation: 'inc_other', turnId: 'turn_1' }), 0);
  assert.equal(R.countAgentSendsForTurn(null, identity), 0);
});

test('isLiveGrant and liveGrantCount: revoked, expired and exhausted grants are not live', () => {
  const live = F.makeGrant(1);
  assert.equal(R.isLiveGrant(live, F.NOW), true);
  assert.equal(R.isLiveGrant({ ...live, revoked_at: F.iso() }, F.NOW), false);
  assert.equal(R.isLiveGrant({ ...live, remaining_sends: 0 }, F.NOW), false);
  assert.equal(R.isLiveGrant(live, new Date(F.NOW.getTime() + F.WEEK_MS)), false, 'expired exactly at expires_at');
  assert.equal(R.isLiveGrant(F.makeAuthorization(1), F.NOW), false, 'a user send is never a grant');
  const mail = normalizedMail({ authorizations: [live, F.makeGrant(2, { revoked_at: F.iso() }), F.makeAuthorization(3)] });
  assert.equal(R.liveGrantCount(mail, F.NOW), 1);
});

test('authorizationBlocked: revoked, expired and any identity or project change on either end', () => {
  const grant = F.makeGrant(1);
  const envelope = F.makeAgentEnvelope(1);
  const same = {
    source: { session_incarnation: 'inc_src', project_id: null }, destination: { session_incarnation: 'inc_dst', project_id: 'proj_1' },
  };
  const blocked = (auth, current, at = F.NOW) => R.authorizationBlocked(auth, envelope, current, at);
  assert.equal(blocked(grant, same), false);
  assert.equal(blocked({ ...grant, revoked_at: F.iso() }, same), true);
  assert.equal(blocked(grant, same, new Date(F.NOW.getTime() + F.WEEK_MS)), true);
  assert.equal(blocked(grant, { ...same, source: { session_incarnation: 'inc_new', project_id: null } }), true);
  assert.equal(blocked(grant, { ...same, source: { session_incarnation: 'inc_src', project_id: 'proj_2' } }), true);
  assert.equal(blocked(grant, { ...same, destination: { session_incarnation: 'inc_dst', project_id: 'proj_2' } }), true);
  assert.equal(blocked(grant, { ...same, destination: { session_incarnation: 'inc_new', project_id: 'proj_1' } }), true);
  assert.equal(blocked(grant, { ...same, destination: null }), false, 'a gone recipient is for delivery to report');
  assert.equal(blocked({ ...grant, destination_session_id: 'sess_other' }, same), true);
  const once = F.makeAuthorization(1, { kind: 'agent_once', consent_event_id: 'approval_1', body_sha256: envelope.body_sha256 });
  assert.equal(blocked(once, same), false);
  assert.equal(blocked({ ...once, body_sha256: 'f'.repeat(64) }, same), true, 'a one-off binds the exact body');
});

test('pruneMail retires directional grants 30 days after they expired, were revoked or were spent, unless an unsettled op rides them', () => {
  const day = (days) => F.iso(days * DAY);
  const aged = (n, extra) => F.makeGrant(n, { authorization_id: F.uuid(8200 + n), ...extra });
  const expiredOld = aged(1, { created_at: day(-40), expires_at: F.iso(-40 * DAY + F.WEEK_MS) }); // expired 33 days ago
  const expiredRecent = aged(2, { created_at: day(-36), expires_at: F.iso(-36 * DAY + F.WEEK_MS) }); // expired 29 days ago
  const revokedOld = aged(3, { revoked_at: day(-31) });
  const revokedRecent = aged(4, { revoked_at: day(-29) });
  const spentOld = aged(5, { created_at: day(-40), expires_at: F.iso(-40 * DAY + F.WEEK_MS), remaining_sends: 0 });
  const liveGrant = aged(6);
  const riding = aged(7, { created_at: day(-40), expires_at: F.iso(-40 * DAY + F.WEEK_MS) });
  const ride = F.makeAgentOutbox(7, {
    state: 'failed', authorization_id: riding.authorization_id, send_requested_at: day(-39), prepared_at: day(-39),
    last_error: { code: 'CMP-MESSAGE-0004', reason: 'authorization_revoked', retryable: false },
  });
  const user = F.makeAuthorization(1);
  const pruned = R.pruneMail(normalizedMail({
    outbox: [F.makeOutbox(1), ride],
    authorizations: [expiredOld, expiredRecent, revokedOld, revokedRecent, spentOld, liveGrant, riding, user],
  }), { now: F.NOW });
  const kept = pruned.authorizations.map((auth) => auth.authorization_id).sort();
  assert.deepEqual(kept, [expiredRecent, revokedRecent, liveGrant, riding, user].map((auth) => auth.authorization_id).sort());
});

test('an exhausted grant retires 30 days after its last send, not after its creation', () => {
  const grant = F.makeGrant(1, { remaining_sends: 0 });
  const recentSend = F.makeAgentOutbox(1, {
    state: 'delivered', authorization_id: grant.authorization_id, send_requested_at: F.iso(-DAY), delivered_at: F.iso(-DAY),
    destination_receipt_id: F.uuid(9001),
  });
  const mail = normalizedMail({ outbox: [recentSend], authorizations: [grant] });
  const inside = R.pruneMail(mail, { now: new Date(F.NOW.getTime() + 20 * DAY) });
  assert.equal(inside.authorizations.length, 1, 'ended = min(expiry, last send): still inside the 30 day window');
  const later = R.pruneMail(mail, { now: new Date(F.NOW.getTime() + 40 * DAY) });
  assert.equal(later.authorizations.length, 0);
});
