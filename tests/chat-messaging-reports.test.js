'use strict';

/* Linked-child terminal reports at the messaging service (row 59 checkpoint 5b-1, slice B2):
 * convertReport, deliverReport, setReporting and the startup repair, over a real session store
 * and the desktop wiring. The turn side lives in session-report-admission.test.js and the
 * end-to-end flow in linked-child-reporting-integration.test.js. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { reportMessageId, reportOperationId } = require('../services/backend/session-report-records');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { buildReportEnvelope } = require('../services/backend/session-message-envelope');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');
const F = require('./helpers/session-mail-fixtures');

const V = { schema_version: 1 };

// A parent and a linked child that owes a report for `turnId` (reporting on, one reservation).
function linked(t, { turnId = 'turn_1', reserve = true, reporting = true } = {}) {
  const f = createFixture(t);
  const parent = f.sessionId('Parent');
  const parentIncarnation = f.store.getSession(parent).session_incarnation;
  const child = f.store.createSessionWithId('sess_child', {
    title: 'Child',
    spawnedFrom: F.makeSpawnedFrom({ parent_session_id: parent, parent_session_incarnation: parentIncarnation }),
  }).id;
  const mail = createSessionMailStore(f.store);
  const set = (patch) => assert.ok(mail.mutate(child, ({ mail: current }) => ({ mail: { ...current, ...patch } })).ok);
  set({
    reporting_enabled: reporting,
    report_reservations: reserve
      ? [F.makeReservation(1, { turn_id: turnId, parent_session_id: parent, parent_session_incarnation: parentIncarnation })] : [],
  });
  const messageId = () => reportMessageId(child, f.store.getSession(child).session_incarnation, turnId);
  const convert = (extra = {}) => f.service.convertReport({
    sessionId: child, turnId, outcome: 'completed', body: 'It is done.', clipped: false, errorCode: null, ...extra,
  });
  return { f, parent, child, mail, set, messageId, convert, parentIncarnation };
}

// ---------- setReporting ----------

test('setReporting flips a linked child and answers {enabled, revision}; the same value is a no-op', async (t) => {
  const { f, child } = linked(t, { reporting: true });
  const before = f.store.getSession(child).coordination_revision;
  f.events.length = 0;
  const off = await f.service.setReporting({ ...V, child_session_id: child, enabled: false });
  assert.equal(off.ok, true);
  assert.equal(off.enabled, false);
  assert.equal(off.revision, before + 1);
  assert.equal(f.mail(child).reporting_enabled, false);
  assert.ok(f.events.some((event) => event.session_id === child), 'a change event is published');
  const again = await f.service.setReporting({ ...V, child_session_id: child, enabled: false });
  assert.equal(again.ok, true);
  assert.equal(again.revision, before + 1, 'a no-op does not bump the revision');
  const on = await f.service.setReporting({ ...V, child_session_id: child, enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(f.mail(child).reporting_enabled, true);
});

test('setReporting never deletes an owed report reservation', async (t) => {
  const { f, child } = linked(t);
  assert.equal((await f.service.setReporting({ ...V, child_session_id: child, enabled: false })).ok, true);
  assert.equal(f.mail(child).report_reservations.length, 1);
});

test('setReporting refuses malformed requests, unknown chats and chats that were not spawned', async (t) => {
  const { f, child } = linked(t);
  const plain = f.sessionId('Plain');
  const bad = await f.service.setReporting({ ...V, child_session_id: child, enabled: 'yes' });
  assert.equal(bad.reason, 'invalid_request');
  assert.equal(bad.error_code, CODES.INVALID_REQUEST);
  assert.equal((await f.service.setReporting({ ...V, child_session_id: child, enabled: true, extra: 1 })).reason, 'invalid_request');
  assert.equal((await f.service.setReporting(null)).reason, 'invalid_request');
  const missing = await f.service.setReporting({ ...V, child_session_id: 'sess_missing', enabled: true });
  assert.equal(missing.reason, 'not_found');
  const notLinked = await f.service.setReporting({ ...V, child_session_id: plain, enabled: true });
  assert.equal(notLinked.reason, 'invalid_request');
  assert.equal(f.mail(plain).reporting_enabled, false, 'an unlinked chat is never written');
});

test('setReporting reports a persistence failure and leaves the flag unchanged', async (t) => {
  const { f, child } = linked(t, { reporting: true });
  f.failFlush(child);
  const result = await f.service.setReporting({ ...V, child_session_id: child, enabled: false });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'persistence_failure');
  assert.equal(f.mail(child).reporting_enabled, true);
});

// ---------- convertReport ----------

test('convertReport turns the reservation into one delivered report with the deterministic ids', async (t) => {
  const { f, parent, child, messageId, convert } = linked(t);
  const result = await convert();
  assert.equal(result.ok, true);
  assert.equal(result.converted, true);
  assert.equal(result.operation_id, reportOperationId(messageId()));
  const mail = f.mail(child);
  assert.equal(mail.report_reservations.length, 0);
  assert.equal(mail.outbox.length, 1);
  const [record] = mail.outbox;
  assert.equal(record.state, 'delivered');
  assert.equal(record.gesture_id, null);
  assert.equal(record.authorization_id, null);
  assert.equal(record.envelope.message_id, messageId());
  assert.equal(record.envelope.destination_session_id, parent);
  assert.equal(record.envelope.source_turn_id, 'turn_1');
  assert.equal(f.mail(parent).inbox.length, 1);
  assert.equal(f.mail(parent).inbox[0].envelope.kind, 'terminal_report');
});

test('convertReport is idempotent: a replay and a concurrent second call write nothing more', async (t) => {
  const { f, parent, child, convert } = linked(t);
  await convert();
  const revision = f.store.getSession(child).coordination_revision;
  const replay = await convert();
  assert.equal(replay.ok, true);
  assert.equal(replay.converted, false);
  assert.equal(f.store.getSession(child).coordination_revision, revision, 'no write on a replay');
  assert.equal(f.mail(child).outbox.length, 1);
  assert.equal(f.mail(parent).inbox.length, 1);
});

test('convertReport with no reservation (and no report) is a no-op success', async (t) => {
  const { f, child, convert } = linked(t, { reserve: false });
  const revision = f.store.getSession(child).coordination_revision;
  const result = await convert();
  assert.equal(result.ok, true);
  assert.equal(result.converted, false);
  assert.equal(f.store.getSession(child).coordination_revision, revision);
  assert.equal(f.mail(child).outbox.length, 0);
});

test('convertReport leaves the reservation when the envelope would be invalid, and refuses malformed requests', async (t) => {
  const { f, child, convert } = linked(t);
  const empty = await convert({ body: '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'invalid_request');
  assert.equal(f.mail(child).report_reservations.length, 1);
  for (const raw of [null, 'x', {}, { sessionId: child }, { sessionId: child, turnId: 'turn_1', outcome: 'nope', body: 'b' },
    { sessionId: child, turnId: 'turn_1', outcome: 'completed', body: 'b', errorCode: 'bad' }]) {
    assert.equal((await f.service.convertReport(raw)).reason, 'invalid_request', JSON.stringify(raw));
  }
  assert.equal(f.mail(child).outbox.length, 0);
});

test('convertReport to an archived parent leaves a failed, retryable report that Retry delivers after restore', async (t) => {
  const { f, parent, child, convert } = linked(t);
  f.archive(parent);
  assert.equal((await convert()).ok, true);
  const [record] = f.mail(child).outbox;
  assert.equal(record.state, 'failed');
  assert.equal(record.last_error.reason, 'recipient_archived');
  assert.equal(f.mail(parent).inbox.length, 0);
  f.store.setSessionMeta(parent, { archived_at: null });
  const retried = await f.service.retry({ ...V, operation_id: record.operation_id });
  assert.equal(f.wakes.length, 0, 'Retry of a failed delivery wakes nothing (row 70 D4)');
  assert.equal(retried.ok, true);
  assert.equal(f.mail(child).outbox[0].state, 'delivered');
  assert.equal(f.mail(parent).inbox.length, 1);
});

test('convertReport to a deleted parent fails recipient_deleted (not retryable)', async (t) => {
  const { f, parent, child, convert } = linked(t);
  f.store.deleteSession(parent);
  assert.equal((await convert()).ok, true);
  const [record] = f.mail(child).outbox;
  assert.equal(record.state, 'failed');
  assert.equal(record.last_error.reason, 'recipient_deleted');
  assert.equal(record.last_error.retryable, false);
});

test('a flush failure keeps the reservation; a later convert succeeds', async (t) => {
  const { f, child, convert } = linked(t);
  f.failFlush(child);
  const failed = await convert();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'persistence_failure');
  assert.equal(f.mail(child).report_reservations.length, 1);
  assert.equal(f.mail(child).outbox.length, 0);
  assert.equal((await convert()).ok, true);
  assert.equal(f.mail(child).outbox.length, 1);
});

test('convertReport on an unknown chat answers not_found', async (t) => {
  const { f, convert } = linked(t);
  assert.equal((await f.service.convertReport({
    sessionId: 'sess_missing', turnId: 'turn_1', outcome: 'completed', body: 'b',
  })).reason, 'not_found');
  assert.equal(typeof convert, 'function');
});

// ---------- deliverReport ----------

test('deliverReport delivers a pending report and tracks it for Retry/Cancel', async (t) => {
  const { f, parent, child, mail, messageId } = linked(t, { reserve: false });
  const operationId = reportOperationId(messageId());
  const ends = (id) => ({
    session_id: id, session_incarnation: f.store.getSession(id).session_incarnation, project_id: f.store.getSession(id).project_id,
  });
  const record = {
    envelope: buildReportEnvelope({
      child: ends(child), parent: ends(parent), turnId: 'turn_1', outcome: 'completed', body: 'Pending body', clipped: false,
      errorCode: null, messageId: messageId(), createdAt: new Date(),
    }),
    operation_id: operationId, gesture_id: null, tool_call_id: null, authorization_id: null, state: 'pending',
    prepared_at: F.iso(), expires_at: null, send_requested_at: F.iso(), delivered_at: null, destination_receipt_id: null,
    last_error: null, restore_requires_confirmation: false,
  };
  assert.ok(mail.mutate(child, ({ mail: current }) => ({ mail: { ...current, outbox: [record] } })).ok);
  const delivered = f.service.deliverReport(child, operationId);
  assert.equal(delivered.ok, true);
  assert.equal(delivered.operation.state, 'delivered');
  assert.equal(f.mail(parent).inbox.length, 1);
  // Row 70 D6: a live report wakes the parent once, with the report anchor.
  assert.equal(f.wakes.length, 1);
  assert.equal(f.wakes[0].request.sessionId, parent);
  assert.match(f.wakes[0].request.visiblePrompt, /^Woken by a report from /);
  const missing = f.service.deliverReport(child, '00000000-0000-4000-8000-00000000dead');
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'stale_operation');
});

// ---------- startup repair (E8) ----------

test('startup repair drops a reservation whose report already exists', async (t) => {
  const { f, child, mail, convert } = linked(t);
  await convert();
  assert.equal(f.wakes.length, 1, 'the live conversion delivered and woke the parent once');
  const [record] = f.mail(child).outbox;
  // Put the reservation back as a crash between "append the report" and "remove the reservation" would leave it.
  assert.ok(mail.mutate(child, ({ mail: current }) => ({
    mail: { ...current, report_reservations: [F.makeReservation(1, { turn_id: 'turn_1', parent_session_id: record.envelope.destination_session_id,
      parent_session_incarnation: record.envelope.destination_session_incarnation })] },
  })).ok);
  f.service.reconcileOnStartup();
  assert.equal(f.mail(child).report_reservations.length, 0);
  assert.equal(f.mail(child).outbox.length, 1, 'no second report');
  assert.equal(f.wakes.length, 1, 'startup repair wakes nothing (row 70 D4)');
});

test('startup repair converts from terminal evidence without a marker, mapping the row to an outcome', async (t) => {
  const { f, child } = linked(t, { turnId: 'stream_9' });
  f.store.appendMessage(child, { id: 'user_stream_9', role: 'user', content: 'Q', turn_id: 'stream_9' });
  f.store.appendMessage(child, {
    id: 'assistant_stream_9', role: 'assistant', content: 'I got halfway.', status: 'runtime_error', terminal_status: 'runtime_error',
    error_code: 'CMP-ENGINE-0001', parent_stream_id: 'stream_9',
  });
  f.service.reconcileOnStartup();
  const [record] = f.mail(child).outbox;
  assert.equal(record.envelope.report.outcome, 'failed');
  assert.equal(record.envelope.body, 'I got halfway.');
  assert.equal(record.envelope.report.error_code, 'CMP-ENGINE-0001');
  assert.equal(record.state, 'delivered');
});

test('startup repair reports a cancelled row as cancelled and an interrupted row with the interrupted line', async (t) => {
  const cancelled = linked(t, { turnId: 'stream_c' });
  cancelled.f.store.appendMessage(cancelled.child, { id: 'user_stream_c', role: 'user', content: 'Q', turn_id: 'stream_c' });
  cancelled.f.store.appendMessage(cancelled.child, {
    id: 'assistant_stream_c', role: 'assistant', content: '', status: 'cancelled', terminal_status: 'cancelled', parent_stream_id: 'stream_c',
  });
  cancelled.f.service.reconcileOnStartup();
  const [one] = cancelled.f.mail(cancelled.child).outbox;
  assert.equal(one.envelope.report.outcome, 'cancelled');
  assert.equal(one.envelope.body, 'The turn was cancelled before it produced an answer.');

  const interrupted = linked(t, { turnId: 'stream_i' });
  interrupted.f.store.appendMessage(interrupted.child, { id: 'user_stream_i', role: 'user', content: 'Q', turn_id: 'stream_i' });
  interrupted.f.store.appendMessage(interrupted.child, {
    id: 'assistant_stream_i', role: 'assistant', content: 'This turn was interrupted before it could finish.', status: 'interrupted',
    terminal_status: 'interrupted', parent_stream_id: 'stream_i',
  });
  interrupted.f.service.reconcileOnStartup();
  const [two] = interrupted.f.mail(interrupted.child).outbox;
  assert.equal(two.envelope.report.outcome, 'failed');
  assert.equal(two.envelope.body, 'The turn was interrupted before it could finish.');
});

test('startup repair reads a lifecycle cancel or a restart row as interrupted, never as a user cancel', async (t) => {
  for (const [turnId, row] of [
    ['stream_s', { status: 'cancelled', terminal_status: 'cancelled', terminal_subcode: 'app_shutdown', content: 'Partial.' }],
    ['stream_r', { status: 'runtime_error', terminal_status: 'runtime_error', terminal_subcode: 'app_restart', content: '' }],
    ['stream_t', { status: 'cancelled', terminal_status: 'cancelled', terminal_subcode: 'timeout', content: '' }],
  ]) {
    const env = linked(t, { turnId });
    env.f.store.appendMessage(env.child, { id: `user_${turnId}`, role: 'user', content: 'Q', turn_id: turnId });
    env.f.store.appendMessage(env.child, { id: `assistant_${turnId}`, role: 'assistant', parent_stream_id: turnId, ...row });
    env.f.service.reconcileOnStartup();
    const [record] = env.f.mail(env.child).outbox;
    assert.equal(record.envelope.report.outcome, 'failed', turnId);
    assert.equal(record.envelope.body, turnId === 'stream_t'
      ? 'The turn failed before it produced an answer.' : 'The turn was interrupted before it could finish.', turnId);
  }
});

test('startup repair reads the outcome an anchor marker carries when no assistant row was written', async (t) => {
  const env = linked(t, { turnId: 'stream_a' });
  const reportId = env.messageId();
  env.f.store.appendMessage(env.child, {
    id: 'user_stream_a', role: 'user', content: 'Q', turn_id: 'stream_a',
    terminal_report_message_id: reportId, terminal_report_outcome: 'completed', terminal_report_error_code: null,
  });
  env.f.service.reconcileOnStartup();
  const [record] = env.f.mail(env.child).outbox;
  assert.equal(record.envelope.report.outcome, 'completed');
  assert.equal(record.envelope.body, 'The turn finished without a visible answer.');
});

test('startup repair never reads a failed earlier attempt as a crashed retry of the same prompt', async (t) => {
  const env = linked(t, { turnId: 'turn_retry' });
  // The retry keeps the first attempt's anchor (user_stream_1) and its failure row, written before this turn reserved.
  env.f.store.appendMessage(env.child, { id: 'user_stream_1', role: 'user', content: 'Q', turn_id: 'turn_retry' });
  env.f.store.appendMessage(env.child, {
    id: 'assistant_stream_1', role: 'assistant', content: 'Old partial.', status: 'runtime_error', terminal_status: 'runtime_error',
    error_code: 'CMP-ENGINE-0001', parent_stream_id: 'stream_1', timestamp: new Date(Date.parse(F.makeReservation().reserved_at) - 60000).toISOString(),
  });
  env.f.service.reconcileOnStartup();
  const [record] = env.f.mail(env.child).outbox;
  assert.equal(record.envelope.report.outcome, 'failed');
  assert.equal(record.envelope.body, 'The turn was interrupted before it could finish.');
  assert.equal(record.envelope.report.error_code, null);
});

test('startup repair uses the proposal title port for an awaiting_proposal row', async (t) => {
  const { f, child } = linked(t, { turnId: 'stream_p' });
  f.store.appendMessage(child, { id: 'user_stream_p', role: 'user', content: 'Q', turn_id: 'stream_p' });
  f.store.appendMessage(child, {
    id: 'assistant_stream_p', role: 'assistant', content: 'Offer.', completion_reason: 'awaiting_proposal',
    completion_proposal_id: `proposal_${'a'.repeat(64)}`, parent_stream_id: 'stream_p',
  });
  const titles = [];
  const service = f.service;
  service._reports = require('../services/chat-messaging-reports').createReportOps({
    mail: createSessionMailStore(f.store),
    getSessionSummary: (id) => f.store.getSessionSummary(id),
    getSessionMessages: (id) => f.store.peekSessionMessages(id) || [],
    getActiveTurn: () => null,
    getProposalTitle: (id, proposalId) => { titles.push([id, proposalId]); return 'Ship the export'; },
    now: () => new Date(f.clock.ms),
    notify: (id) => service.notify(id),
    deliver: (a, b) => service.deliverReport(a, b),
    storeFailure: (result) => service._storeFailure(result),
    log: () => {},
  });
  service.reconcileOnStartup();
  const [record] = f.mail(child).outbox;
  assert.equal(record.envelope.report.outcome, 'awaiting_decision');
  assert.equal(record.envelope.body, 'Waiting for a decision: Ship the export');
  assert.deepEqual(titles, [[child, `proposal_${'a'.repeat(64)}`]]);
});

test('startup repair disables reporting for a child whose parent no longer exists', async (t) => {
  const { f, parent, child } = linked(t, { reserve: false });
  f.store.deleteSession(parent);
  f.service.reconcileOnStartup();
  assert.equal(f.mail(child).reporting_enabled, false);
});

test('startup repair leaves an unlinked or healthy chat byte-for-byte alone', async (t) => {
  const { f, child } = linked(t, { reserve: false });
  const plain = f.sessionId('Plain');
  const before = [JSON.stringify(f.store.getSession(plain).session_mail), JSON.stringify(f.store.getSession(child).session_mail)];
  const revisions = [f.store.getSession(plain).coordination_revision, f.store.getSession(child).coordination_revision];
  f.service.reconcileOnStartup();
  assert.deepEqual([JSON.stringify(f.store.getSession(plain).session_mail), JSON.stringify(f.store.getSession(child).session_mail)], before);
  assert.deepEqual([f.store.getSession(plain).coordination_revision, f.store.getSession(child).coordination_revision], revisions);
});

test('report diagnostics carry ids and reason tokens only, never bodies', async (t) => {
  const { f, parent, convert } = linked(t);
  f.archive(parent);
  await convert({ body: 'A very private report body.' });
  assert.ok(f.logs.length > 0);
  assert.ok(f.logs.every((entry) => !JSON.stringify(entry).includes('private report body')));
});
