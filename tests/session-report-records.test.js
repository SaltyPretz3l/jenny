'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Rep = require('../services/backend/session-report-records');
const R = require('../services/backend/session-mail-records');
const E = require('../services/backend/session-message-envelope');
const { derivedUuid } = require('../services/backend/chat-proposal-session-records');
const F = require('./helpers/session-mail-fixtures');

const NOW = '2026-10-15T11:00:00.000Z';
const FAIL_LINE = 'The turn failed before it produced an answer.';
const CANCEL_LINE = 'The turn was cancelled before it produced an answer.';
const INTERRUPT_LINE = 'The turn was interrupted before it could finish.';
const bytes = (text) => Buffer.byteLength(text, 'utf8');

function reserveInput(overrides = {}) {
  return {
    spawnedFrom: F.makeSpawnedFrom(), reportingEnabled: true, parentExists: true, turnId: 'turn_1', now: NOW, ...overrides,
  };
}

// ---------- ids and outcomes ----------

test('reportMessageId is the deterministic derived UUID over the child, incarnation and turn', () => {
  const id = Rep.reportMessageId('sess_src', 'inc_src', 'turn_1');
  assert.equal(id, derivedUuid('terminal_report', 'sess_src', 'inc_src', 'turn_1'));
  assert.equal(id, Rep.reportMessageId('sess_src', 'inc_src', 'turn_1'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, Rep.reportMessageId('sess_src', 'inc_src', 'turn_2'));
  assert.notEqual(id, Rep.reportMessageId('sess_src', 'inc_other', 'turn_1'));
  assert.notEqual(id, Rep.reportMessageId('sess_other', 'inc_src', 'turn_1'));
});

test('reportOutcome maps every coordinator kind (E6)', () => {
  assert.equal(Rep.reportOutcome('complete', {}), 'completed');
  assert.equal(Rep.reportOutcome('complete'), 'completed');
  assert.equal(Rep.reportOutcome('complete', { completionReason: 'stop' }), 'completed');
  assert.equal(Rep.reportOutcome('complete', { completionReason: 'awaiting_proposal' }), 'awaiting_decision');
  assert.equal(Rep.reportOutcome('question_batch', {}), 'awaiting_decision');
  for (const kind of ['error', 'timeout', 'denied', 'preempted', 'interrupted']) {
    assert.equal(Rep.reportOutcome(kind, {}), 'failed', kind);
  }
  assert.equal(Rep.reportOutcome('cancelled', {}), 'cancelled');
  assert.equal(Rep.reportOutcome('cancelled', { cancelReason: 'user_stop' }), 'cancelled');
  for (const reason of ['app_shutdown', 'dispose', 'service_stop']) {
    assert.equal(Rep.reportOutcome('cancelled', { cancelReason: reason }), 'defer', reason);
  }
  assert.equal(Rep.reportOutcome('cancelled', { cancelReason: 'session_delete' }), null);
  for (const reason of ['timeout', 'transport_abort']) {
    assert.equal(Rep.reportOutcome('cancelled', { cancelReason: reason }), 'failed', reason);
  }
  assert.equal(Rep.reportOutcome('cancelled', { cancelReason: 'user_cancel' }), 'cancelled');
  assert.equal(Rep.reportOutcome('cancelled', { cancelReason: 'sidecar_cancel' }), 'cancelled');
  assert.equal(Rep.reportOutcome('mystery', {}), null);
  assert.equal(Rep.reportOutcome(undefined, {}), null);
});

// ---------- body (E7) ----------

test('buildReportBody: completed carries the visible answer verbatim', () => {
  assert.deepEqual(Rep.buildReportBody({ outcome: 'completed', visibleText: 'All done.\nSecond line.' }),
    { body: 'All done.\nSecond line.', clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'completed', visibleText: '  padded \t' }),
    { body: 'padded', clipped: false });
});

test('buildReportBody: failed and cancelled use the partial answer, else the fallback line', () => {
  assert.deepEqual(Rep.buildReportBody({ outcome: 'failed', visibleText: 'half an answ' }), { body: 'half an answ', clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'failed', visibleText: '' }), { body: FAIL_LINE, clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'failed' }), { body: FAIL_LINE, clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'failed', visibleText: null, interrupted: true }),
    { body: INTERRUPT_LINE, clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'failed', visibleText: 'partial', interrupted: true }),
    { body: 'partial', clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'cancelled', visibleText: '' }), { body: CANCEL_LINE, clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'cancelled', visibleText: 'so far' }), { body: 'so far', clipped: false });
});

test('buildReportBody: a completed turn with no visible text still has a non-empty body', () => {
  const { body, clipped } = Rep.buildReportBody({ outcome: 'completed', visibleText: ' \n ' });
  assert.ok(body.length > 0);
  assert.equal(clipped, false);
  assert.equal(E.validateBody(body, { maxBytes: 8192 }).ok, true);
});

test('buildReportBody: awaiting_decision names the proposal title, else the plain line', () => {
  assert.deepEqual(Rep.buildReportBody({ outcome: 'awaiting_decision', visibleText: 'ignored', proposalTitle: 'Open a PR' }),
    { body: 'Waiting for a decision: Open a PR', clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'awaiting_decision', proposalTitle: '' }),
    { body: 'Waiting for a decision.', clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'awaiting_decision', proposalTitle: '  \t ' }),
    { body: 'Waiting for a decision.', clipped: false });
  assert.deepEqual(Rep.buildReportBody({ outcome: 'awaiting_decision' }), { body: 'Waiting for a decision.', clipped: false });
  assert.equal(Rep.buildReportBody({ outcome: 'awaiting_decision', proposalTitle: 'a\u0007b' }).body, 'Waiting for a decision: a b');
});

test('buildReportBody sanitizes: CRLF/CR to LF, C0 controls to space, lone surrogates to U+FFFD', () => {
  assert.equal(Rep.buildReportBody({ outcome: 'completed', visibleText: 'a\r\nb\rc\nd' }).body, 'a\nb\nc\nd');
  assert.equal(Rep.buildReportBody({ outcome: 'completed', visibleText: 'a\u0000b\u0007c\u001bd\u007fe\tf' }).body, 'a b c d e\tf');
  assert.equal(Rep.buildReportBody({ outcome: 'completed', visibleText: 'x\ud800y' }).body, 'x�y');
  assert.equal(Rep.buildReportBody({ outcome: 'completed', visibleText: 'x\udc00y' }).body, 'x�y');
  assert.equal(Rep.buildReportBody({ outcome: 'completed', visibleText: 'ok 😀 ok' }).body, 'ok 😀 ok');
  assert.equal(Rep.buildReportBody({ outcome: 'completed', visibleText: 'tail\ud83d' }).body, 'tail�');
  const all = Rep.buildReportBody({ outcome: 'completed', visibleText: 'a\r\n\u0000\ud800z' }).body;
  assert.equal(E.validateBody(all, { maxBytes: 8192 }).ok, true);
});

test('buildReportBody: whitespace-only text takes the synthesized line', () => {
  for (const text of [' ', '\n\t \r\n', '\u0000\u0001', '  ']) {
    assert.equal(Rep.buildReportBody({ outcome: 'failed', visibleText: text }).body, FAIL_LINE, JSON.stringify(text));
    assert.equal(Rep.buildReportBody({ outcome: 'cancelled', visibleText: text }).body, CANCEL_LINE, JSON.stringify(text));
  }
});

test('buildReportBody clips at 8192 UTF-8 bytes on a code point boundary', () => {
  const exact = Rep.buildReportBody({ outcome: 'completed', visibleText: 'a'.repeat(8192) });
  assert.equal(exact.body.length, 8192);
  assert.equal(exact.clipped, false);
  const over = Rep.buildReportBody({ outcome: 'completed', visibleText: 'a'.repeat(8193) });
  assert.equal(bytes(over.body), 8192);
  assert.equal(over.clipped, true);
  // 2-byte characters: 4096 fit exactly, an odd extra byte never splits one.
  const twoByte = Rep.buildReportBody({ outcome: 'completed', visibleText: `a${'é'.repeat(5000)}` });
  assert.equal(twoByte.clipped, true);
  assert.ok(bytes(twoByte.body) <= 8192);
  assert.equal(twoByte.body.isWellFormed(), true);
  assert.equal(bytes(twoByte.body), 8191, 'a + 4095 two-byte characters; the 4096th would cross 8192');
  // 4-byte emoji straddling the cut: 8190 ASCII then an emoji (4 bytes) is dropped whole.
  const emoji = Rep.buildReportBody({ outcome: 'completed', visibleText: `${'a'.repeat(8190)}😀tail` });
  assert.equal(emoji.clipped, true);
  assert.equal(emoji.body, 'a'.repeat(8190));
  assert.equal(emoji.body.isWellFormed(), true);
  // 3-byte characters (CJK): 8190 / 3 = 2730 fit, the next would cross.
  const cjk = Rep.buildReportBody({ outcome: 'completed', visibleText: '中'.repeat(3000) });
  assert.equal(cjk.body, '中'.repeat(2730));
  assert.equal(cjk.clipped, true);
  const huge = Rep.buildReportBody({ outcome: 'completed', visibleText: 'z'.repeat(3 * 1024 * 1024) });
  assert.equal(bytes(huge.body), 8192);
  assert.equal(huge.clipped, true);
});

test('buildReportBody clipped output always passes envelope body validation', () => {
  for (const text of [`${'a'.repeat(8191)}😀`, '中'.repeat(4000), `x${'\r\n'.repeat(6000)}y`, `${'a '.repeat(5000)}`]) {
    const { body } = Rep.buildReportBody({ outcome: 'completed', visibleText: text });
    assert.equal(E.validateBody(body, { maxBytes: 8192 }).ok, true);
    assert.ok(body.length > 0);
  }
});

test('buildReportBody clips a long awaiting_decision title and never exceeds the cap', () => {
  const out = Rep.buildReportBody({ outcome: 'awaiting_decision', proposalTitle: 'T'.repeat(20000) });
  assert.equal(out.clipped, true);
  assert.ok(bytes(out.body) <= 8192);
  assert.ok(out.body.startsWith('Waiting for a decision: TTT'));
});

// ---------- reservations ----------

test('findReservation finds by turn id and tolerates missing lists', () => {
  const mail = F.emptyMail({ report_reservations: [F.makeReservation(1), F.makeReservation(2)] });
  assert.equal(Rep.findReservation(mail, 'turn_2').turn_id, 'turn_2');
  assert.equal(Rep.findReservation(mail, 'turn_9'), null);
  assert.equal(Rep.findReservation({}, 'turn_1'), null);
  assert.equal(Rep.findReservation(null, 'turn_1'), null);
});

test('reserveReport adds one valid reservation and does not mutate its input', () => {
  const mail = F.emptyMail({ reporting_enabled: true });
  const before = structuredClone(mail);
  const result = Rep.reserveReport(mail, reserveInput());
  assert.deepEqual(mail, before);
  assert.deepEqual(result.mail.report_reservations, [{
    turn_id: 'turn_1',
    slot_bytes: 8192,
    reserved_at: NOW,
    parent_session_id: 'sess_dst',
    parent_session_incarnation: 'inc_dst',
    reporting_consent_id: F.makeSpawnedFrom().reporting_consent_id,
  }]);
  assert.deepEqual(R.normalizeReportReservation(result.mail.report_reservations[0]), result.mail.report_reservations[0]);
  assert.equal(result.mail.reporting_enabled, true);
  assert.equal(result.refused, undefined);
  assert.equal(result.disable, undefined);
});

test('reserveReport is idempotent per turn', () => {
  const first = Rep.reserveReport(F.emptyMail(), reserveInput());
  const again = Rep.reserveReport(first.mail, reserveInput({ now: '2026-10-15T12:00:00.000Z' }));
  assert.deepEqual(again.mail, first.mail, 'the original reserved_at stands');
  const second = Rep.reserveReport(first.mail, reserveInput({ turnId: 'turn_2' }));
  assert.deepEqual(second.mail.report_reservations.map((r) => r.turn_id), ['turn_1', 'turn_2']);
});

test('reserveReport leaves mail alone when the session is not eligible', () => {
  const mail = F.emptyMail({ outbox: [F.makeOutbox(1)] });
  for (const input of [
    reserveInput({ spawnedFrom: null }),
    reserveInput({ spawnedFrom: undefined }),
    reserveInput({ spawnedFrom: { schema_version: 2, future: true } }),
    reserveInput({ reportingEnabled: false }),
  ]) {
    const result = Rep.reserveReport(mail, input);
    assert.deepEqual(result.mail, mail);
    assert.equal(result.refused, undefined);
    assert.equal(result.disable, undefined);
  }
  for (const turnId of ['', null, undefined, 7]) {
    assert.deepEqual(Rep.reserveReport(mail, reserveInput({ turnId })).mail, mail, String(turnId));
  }
});

test('reserveReport disables reporting when the parent is gone and reserves nothing', () => {
  const mail = F.emptyMail({ reporting_enabled: true });
  const result = Rep.reserveReport(mail, reserveInput({ parentExists: false }));
  assert.equal(result.disable, true);
  assert.equal(result.mail.reporting_enabled, false);
  assert.deepEqual(result.mail.report_reservations, []);
  assert.equal(mail.reporting_enabled, true, 'input untouched');
  // An existing reservation for the turn wins over a vanished parent (idempotent success).
  const reserved = Rep.reserveReport(mail, reserveInput()).mail;
  const again = Rep.reserveReport(reserved, reserveInput({ parentExists: false }));
  assert.equal(again.disable, undefined);
  assert.equal(again.mail.reporting_enabled, true);
});

test('reserveReport refuses with report_backpressure when the outbox is full', () => {
  const full = Array.from({ length: 128 }, (_, i) => F.makeOutbox(i + 1, { state: 'failed', send_requested_at: F.iso(), last_error: { code: 'CMP-MESSAGE-0006', reason: 'recipient_archived', retryable: true } }));
  const result = Rep.reserveReport(F.emptyMail({ outbox: full }), reserveInput());
  assert.deepEqual(result, { refused: 'report_backpressure' });
  // Reservations themselves fill the outbox: 128 records.
  const reservations = Array.from({ length: 128 }, (_, i) => F.makeReservation(i + 1));
  assert.deepEqual(Rep.reserveReport(F.emptyMail({ report_reservations: reservations }), reserveInput({ turnId: 'turn_new' })),
    { refused: 'report_backpressure' });
  // An already-reserved turn is success even when the outbox is otherwise full.
  const reserved = Rep.reserveReport(F.emptyMail(), reserveInput()).mail;
  const withFull = { ...reserved, outbox: full };
  assert.ok(Rep.reserveReport(withFull, reserveInput()).mail);
  assert.equal(Rep.reserveReport(withFull, reserveInput()).refused, undefined);
});

test('releaseReservation removes only the named reservation', () => {
  const mail = F.emptyMail({ report_reservations: [F.makeReservation(1), F.makeReservation(2)] });
  const before = structuredClone(mail);
  const released = Rep.releaseReservation(mail, 'turn_1');
  assert.deepEqual(released.report_reservations.map((r) => r.turn_id), ['turn_2']);
  assert.deepEqual(mail, before);
  assert.deepEqual(Rep.releaseReservation(mail, 'turn_9'), mail);
  assert.deepEqual(Rep.releaseReservation(F.emptyMail(), 'turn_1'), F.emptyMail());
});

// ---------- conversion ----------

test('convertReservation appends one pending outbox record and drops the reservation', () => {
  const envelope = F.makeReportEnvelope(1, { body: 'Done.' });
  const mail = F.emptyMail({ report_reservations: [F.makeReservation(1), F.makeReservation(2)], outbox: [F.makeOutbox(50)] });
  const before = structuredClone(mail);
  const next = Rep.convertReservation(mail, { turnId: 'turn_1', envelope, now: NOW });
  assert.deepEqual(mail, before);
  assert.deepEqual(next.report_reservations.map((r) => r.turn_id), ['turn_2']);
  assert.equal(next.outbox.length, 2);
  const record = next.outbox[1];
  assert.deepEqual(record, {
    envelope,
    operation_id: derivedUuid('terminal_report_operation', envelope.message_id),
    gesture_id: null,
    tool_call_id: null,
    authorization_id: null,
    state: 'pending',
    prepared_at: NOW,
    expires_at: null,
    send_requested_at: NOW,
    delivered_at: null,
    destination_receipt_id: null,
    last_error: null,
    restore_requires_confirmation: false,
  });
  assert.deepEqual(R.normalizeOutboxRecord(record), record);
  assert.equal(Rep.reportOperationId(envelope.message_id), record.operation_id);
});

test('convertReservation is a no-op when the report already sits in the outbox', () => {
  const envelope = F.makeReportEnvelope(1);
  const mail = F.emptyMail({ report_reservations: [F.makeReservation(1)] });
  const once = Rep.convertReservation(mail, { turnId: 'turn_1', envelope, now: NOW });
  const twice = Rep.convertReservation(once, { turnId: 'turn_1', envelope, now: '2026-10-15T13:00:00.000Z' });
  assert.deepEqual(twice, once);
  assert.equal(twice.outbox.length, 1);
  // Reservation re-added by a repair: the outbox record still wins, no second record.
  const readded = { ...once, report_reservations: [F.makeReservation(1)] };
  assert.equal(Rep.convertReservation(readded, { turnId: 'turn_1', envelope, now: NOW }).outbox.length, 1);
});

test('convertReservation refuses to convert without a matching reservation or a matching envelope', () => {
  const envelope = F.makeReportEnvelope(1);
  const empty = F.emptyMail();
  assert.deepEqual(Rep.convertReservation(empty, { turnId: 'turn_1', envelope, now: NOW }), empty);
  const mail = F.emptyMail({ report_reservations: [F.makeReservation(1)] });
  const wrongTurn = F.makeReportEnvelope(1, { turnId: 'turn_other' });
  assert.deepEqual(Rep.convertReservation(mail, { turnId: 'turn_1', envelope: wrongTurn, now: NOW }), mail);
  const wrongParent = F.makeReservation(1, { parent_session_id: 'sess_elsewhere' });
  assert.deepEqual(Rep.convertReservation(F.emptyMail({ report_reservations: [wrongParent] }), { turnId: 'turn_1', envelope, now: NOW }).outbox, []);
  assert.deepEqual(Rep.convertReservation(mail, { turnId: 'turn_1', envelope: { ...envelope, body: 'tampered' }, now: NOW }), mail);
  assert.deepEqual(Rep.convertReservation(mail, { turnId: 'turn_1', envelope: F.makeEnvelope(1), now: NOW }), mail, 'not a terminal_report');
});

test('a full outbox cannot block a conversion: the slot is already counted', () => {
  const envelope = F.makeReportEnvelope(1, { body: 'x'.repeat(8192) });
  const filler = Array.from({ length: 127 }, (_, i) => F.makeOutbox(i + 10, { state: 'pending', send_requested_at: F.iso() }));
  const mail = F.emptyMail({ report_reservations: [F.makeReservation(1)], outbox: filler });
  assert.equal(R.outboxCapacity(mail).records, 128);
  const next = Rep.convertReservation(mail, { turnId: 'turn_1', envelope, now: NOW });
  assert.equal(next.outbox.length, 128);
  assert.equal(R.outboxCapacity(next).records, 128);
});
