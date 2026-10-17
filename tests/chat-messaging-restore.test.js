'use strict';

/* chatMessages.confirmRestored (row 59 checkpoint 5b-3, slice H2a): the user's explicit confirmation of a
 * send that a trusted archive restore parked as a failed operation. Every case starts from a record that
 * went through the real restore transform and was installed with the trusted store method, then runs
 * the real service against a real ElectronSessionStore. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { envelopeSha256 } = require('../services/backend/session-message-envelope');
const { normalizeCoordinationFields } = require('../services/backend/session-coordination-records');
const { transformRestoredCoordination } = require('../services/data-lifecycle/coordination-restore-transform');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');
const F = require('./helpers/session-mail-fixtures');

const V = { schema_version: 1 };
const HASH_OTHER = 'f'.repeat(64);

function endOf(f, sessionId) {
  const session = f.store.getSession(sessionId);
  return { session_id: sessionId, session_incarnation: session.session_incarnation, project_id: session.project_id || null };
}

// Two chats and one in-flight send between them, restored through the real transform.
function restoredPair(t, { outbox = (ends) => [F.makeOutbox(1, {
  state: 'pending', send_requested_at: F.iso(1000), authorization_id: F.uuid(5001),
}, ends)], authorizations = () => [] } = {}) {
  const f = createFixture(t);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest', { projectId: 'project_a' });
  const ends = { source: endOf(f, src), destination: endOf(f, dst) };
  const base = normalizeCoordinationFields({});
  const captured = {
    session_incarnation: ends.source.session_incarnation,
    ...base,
    session_mail: { ...base.session_mail, outbox: outbox(ends), authorizations: authorizations(ends, f) },
  };
  const restored = transformRestoredCoordination(captured, { restoredSessionIds: [src, dst], now: new Date(f.clock.ms) });
  assert.equal(restored.quarantined, false);
  assert.equal(f.store.restoreSessionCoordination(src, restored.record), true);
  const op = f.mail(src).outbox[0];
  return { f, src, dst, op };
}

const confirm = (f, op, extra = {}) => f.service.confirmRestored({
  ...V, operation_id: op.operation_id, expected_envelope_sha256: envelopeSha256(op.envelope), gesture_id: f.gesture(), ...extra,
});

test('the restore transform parks a pending send; the outbox projection shows its hash and the flag', async (t) => {
  const { f, src, op } = restoredPair(t);
  assert.deepEqual([op.state, op.restore_requires_confirmation], ['failed', true]);
  const listed = await f.service.list({ ...V, session_id: src, direction: 'outbox' });
  assert.equal(listed.ok, true);
  const [item] = listed.items;
  assert.equal(item.envelope_sha256, envelopeSha256(op.envelope));
  assert.equal(item.restore_requires_confirmation, true);
  assert.equal(item.state, 'failed');
  assert.equal(item.last_error.reason, 'restored_confirmation_required');
  assert.equal(item.last_error.code, CODES.AUTHORIZATION_REQUIRED);
});

test('confirming a restored send records a fresh user_send authorization, clears the flag and delivers once', async (t) => {
  const { f, src, dst, op } = restoredPair(t);
  const gesture = f.gesture();
  const done = await confirm(f, op, { gesture_id: gesture });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.created, true);
  assert.equal(done.operation.state, 'delivered');
  assert.equal(done.operation.restore_requires_confirmation, false);
  assert.equal(done.operation.operation_id, op.operation_id);
  assert.equal(done.operation.last_error, null);
  assert.equal(done.operation.envelope_sha256, envelopeSha256(op.envelope));

  const after = f.mail(src).outbox[0];
  assert.equal(after.state, 'delivered');
  assert.equal(after.restore_requires_confirmation, false);
  assert.deepEqual(after.envelope, op.envelope, 'the exact restored message moved, nothing re-composed');
  const fresh = f.mail(src).authorizations.filter((auth) => auth.operation_id === op.operation_id);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].kind, 'user_send');
  assert.equal(fresh[0].authorization_id, after.authorization_id);
  assert.equal(fresh[0].consent_event_id, `restore:${gesture}`);
  assert.equal(fresh[0].body_sha256, op.envelope.body_sha256);
  assert.equal(fresh[0].remaining_sends, 0);

  const inbox = f.mail(dst).inbox;
  assert.equal(inbox.length, 1);
  assert.deepEqual(inbox[0].envelope, op.envelope);
  assert.deepEqual(inbox[0].context, { state: 'queued' }, 'delivery wakes nothing and queues the message');
  assert.notEqual(inbox[0].source_receipt_confirmed_at, null);
  assert.equal(f.store.getSession(src).coordination_receipts.filter((receipt) => receipt.method === 'chatMessages.confirmRestored').length, 1);
  assert.ok(f.coordination.includes(src));
});

test('a repeated gesture replays the first result without a second send; a changed payload conflicts', async (t) => {
  const { f, src, dst, op } = restoredPair(t);
  const gesture = f.gesture();
  const first = await confirm(f, op, { gesture_id: gesture });
  assert.equal(first.created, true);
  const replay = await confirm(f, op, { gesture_id: gesture });
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(f.mail(src).authorizations.filter((auth) => auth.operation_id === op.operation_id).length, 1);
  const conflict = await confirm(f, op, { gesture_id: gesture, expected_envelope_sha256: HASH_OTHER });
  assert.deepEqual([conflict.ok, conflict.reason, conflict.error_code], [false, 'idempotency_conflict', CODES.IDEMPOTENCY_CONFLICT]);
  // A second gesture on the settled operation is stale: the flag is gone.
  const stale = await confirm(f, op);
  assert.deepEqual([stale.ok, stale.reason, stale.error_code], [false, 'stale_operation', CODES.STALE_OPERATION]);
  assert.equal(f.mail(dst).inbox.length, 1);
});

test('an existing destination receipt finalizes delivery and clears the flag without new content or authorization', async (t) => {
  const { f, src, dst, op } = restoredPair(t);
  const receiptId = F.uuid(3777);
  const inbound = F.makeInbox(1, { receipt_id: receiptId, receive_sequence: 1 }, { source: endOf(f, src), destination: endOf(f, dst) });
  assert.deepEqual(inbound.envelope, op.envelope);
  f.store._updateSessionRecord(dst, { session_mail: { ...f.mail(dst), inbox: [inbound], next_receive_sequence: 2 } }, { bumpUpdatedAt: false });
  const done = await confirm(f, op);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.operation.state, 'delivered');
  assert.equal(done.operation.destination_receipt_id, receiptId);
  assert.equal(done.operation.restore_requires_confirmation, false);
  assert.equal(f.mail(dst).inbox.length, 1, 'nothing is delivered a second time');
  assert.equal(f.mail(src).authorizations.filter((auth) => auth.operation_id === op.operation_id).length, 0, 'no consent is recorded for a send that already happened');
  assert.notEqual(f.mail(dst).inbox[0].source_receipt_confirmed_at, null);
});

test('a changed envelope hash fails and changes nothing', async (t) => {
  const { f, src, dst, op } = restoredPair(t);
  const result = await confirm(f, op, { expected_envelope_sha256: HASH_OTHER });
  assert.deepEqual([result.ok, result.reason, result.error_code], [false, 'idempotency_conflict', CODES.IDEMPOTENCY_CONFLICT]);
  assert.deepEqual(f.mail(src).outbox[0], op);
  assert.equal(f.mail(src).authorizations.length, 0);
  assert.equal(f.mail(dst).inbox.length, 0);
  assert.deepEqual(f.store.getSession(src).coordination_receipts, []);
});

test('only a flagged restored operation confirms; unknown, prepared and delivered operations are stale', async (t) => {
  const { f, src, op } = restoredPair(t, {
    outbox: (ends) => [
      F.makeOutbox(1, { state: 'pending', send_requested_at: F.iso(1000), authorization_id: F.uuid(5001) }, ends),
      F.makeOutbox(2, {}, ends),
    ],
  });
  const prepared = f.mail(src).outbox.find((entry) => entry.state === 'prepared');
  assert.equal(prepared.restore_requires_confirmation, false);
  const stale = await confirm(f, prepared);
  assert.deepEqual([stale.ok, stale.reason], [false, 'stale_operation']);
  const unknown = await f.service.confirmRestored({
    ...V, operation_id: F.uuid(9999), expected_envelope_sha256: envelopeSha256(op.envelope), gesture_id: f.gesture(),
  });
  assert.deepEqual([unknown.ok, unknown.reason], [false, 'stale_operation']);
  assert.equal(f.mail(src).outbox.find((entry) => entry.operation_id === prepared.operation_id).state, 'prepared');
  assert.equal((await confirm(f, op)).ok, true);
  assert.equal((await confirm(f, op)).reason, 'stale_operation');
});

test('the endpoints are revalidated: archived, deleted and changed chats fail with the existing reasons and nothing is recorded', async (t) => {
  const cases = [
    ['recipient_archived', ({ f, dst }) => f.archive(dst)],
    ['recipient_deleted', ({ f, dst }) => f.store.deleteSession(dst)],
    ['stale_operation', ({ f, dst }) => f.store._updateSessionRecord(dst, { session_incarnation: 'inc_reborn' }, { bumpUpdatedAt: false })],
    ['stale_operation', ({ f, src }) => f.store._updateSessionRecord(src, { session_incarnation: 'inc_reborn' }, { bumpUpdatedAt: false })],
    ['source_ineligible', ({ f, src }) => f.archive(src)],
  ];
  for (const [reason, mutate] of cases) {
    const ctx = restoredPair(t);
    mutate(ctx);
    const before = structuredClone(ctx.f.mail(ctx.src));
    const result = await confirm(ctx.f, ctx.op);
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason);
    assert.deepEqual(ctx.f.mail(ctx.src), before, `${reason}: the parked operation is untouched`);
    assert.deepEqual(ctx.f.store.getSession(ctx.src).coordination_receipts, [], `${reason}: no receipt for a refused gesture`);
  }
});

test('a durable write failure leaves the operation parked and recoverable', async (t) => {
  const { f, src, dst, op } = restoredPair(t);
  f.failFlush(src, 1);
  const failed = await confirm(f, op);
  assert.deepEqual([failed.ok, failed.reason, failed.error_code], [false, 'persistence_failure', CODES.PERSISTENCE_FAILURE]);
  assert.deepEqual(f.mail(src).outbox[0], op);
  assert.equal(f.mail(dst).inbox.length, 0);
  const again = await confirm(f, op);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.operation.state, 'delivered');
});

test('an agent-composed send is delivered only on the user gesture and starts no turn', async (t) => {
  const { f, src, dst, op } = restoredPair(t, {
    outbox: (ends) => [F.makeAgentOutbox(1, { state: 'pending', send_requested_at: F.iso(1000), authorization_id: F.uuid(5001) }, ends)],
  });
  assert.equal(op.envelope.kind, 'agent_message');
  assert.equal(op.state, 'failed');
  const done = await confirm(f, op);
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(done.operation.state, 'delivered');
  assert.equal(f.mail(src).authorizations.find((auth) => auth.operation_id === op.operation_id).kind, 'user_send');
  assert.equal(f.admission.length, 0, 'no admission or wake ran');
  assert.equal(f.mail(dst).inbox[0].context.state, 'queued');
});

test('a directional grant stays revoked after the owner confirms a restored send', async (t) => {
  const DAY = 24 * 60 * 60 * 1000;
  const { f, src } = restoredPair(t, {
    authorizations: (ends, fixture) => [F.makeGrant(1, {
      source_session_id: ends.source.session_id,
      source_session_incarnation: ends.source.session_incarnation,
      source_project_id: ends.source.project_id,
      destination_session_id: ends.destination.session_id,
      destination_session_incarnation: ends.destination.session_incarnation,
      destination_project_id: ends.destination.project_id,
      created_at: new Date(fixture.clock.ms).toISOString(),
      expires_at: new Date(fixture.clock.ms + 7 * DAY).toISOString(),
    })],
  });
  const [lifted] = f.mail(src).authorizations;
  assert.equal(lifted.kind, 'agent_directional');
  assert.notEqual(lifted.revoked_at, null, 'the transform expired the grant at restore time');
  assert.equal(lifted.remaining_sends, 0);
  const op = f.mail(src).outbox[0];
  const done = await confirm(f, op);
  assert.equal(done.ok, true, JSON.stringify(done));
  const grants = f.mail(src).authorizations.filter((auth) => auth.kind === 'agent_directional');
  assert.equal(grants.length, 1);
  assert.notEqual(grants[0].revoked_at, null);
  assert.equal(grants[0].remaining_sends, 0);
});
