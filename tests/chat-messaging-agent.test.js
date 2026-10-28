'use strict';

/* Agent-authored addressed messaging (row 59 checkpoint 5b-2, slice M1): listAgentTargets,
 * agentPrepare, agentSend, agentCancel and agentRead on a real ElectronSessionStore through the
 * desktop wiring, plus the delivery-time authorization check. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGE_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { envelopeSha256 } = require('../services/backend/session-message-envelope');
const { createAgentOps } = require('../services/chat-messaging-agent');
const { makeSpawnedFrom } = require('./helpers/session-mail-fixtures');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');

const V = { schema_version: 1 };
const DAY = 24 * 60 * 60 * 1000;
const UUID = '99999999-9999-4999-8999-999999999999';
const ONCE = { kind: 'once', consent_event_id: 'approval_1' };

function setup(t, options) {
  const f = createFixture(t, options);
  const src = f.sessionId('Source');
  const dst = f.sessionId('Dest', { projectId: 'project_a' });
  const inc = (id) => f.store.getSession(id).session_incarnation;
  let call = 0;
  const base = { sourceSessionId: src, sourceIncarnation: inc(src), turnId: 'turn_1', destinationSessionId: dst, body: 'Please review the plan.' };
  const prepare = (extra = {}) => f.service.agentPrepare({ ...base, toolCallId: `call_${call += 1}`, ...extra });
  const grant = async (source = src, destination = dst, purpose = 'Share review notes') => (await f.service.createGrant({
    ...V, source_session_id: source, destination_session_id: destination, purpose, gesture_id: f.gesture(),
  })).grant;
  const targets = async () => (await f.service.listAgentTargets({ sourceSessionId: src, sourceIncarnation: inc(src) })).targets;
  const sendOnce = (operationId, extra = {}) => f.service.agentSend({ sourceSessionId: src, operationId, authorization: ONCE, ...extra });
  return { f, src, dst, inc, base, prepare, grant, targets, sendOnce };
}

test('the agent module exports its factory', () => {
  assert.equal(typeof createAgentOps, 'function');
});

// ---------- prepare ----------

test('agentPrepare writes a prepared agent_message bound to its turn and tool call and sends nothing', async (t) => {
  const { f, src, dst, base, prepare } = setup(t);
  const prepared = await prepare({ toolCallId: 'call_a' });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.created, true);
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.grant, null);
  assert.deepEqual(prepared.destination, { session_id: dst, title: 'Dest', project_label: 'Alpha' });
  const [op] = f.mail(src).outbox;
  assert.equal(prepared.operation_id, op.operation_id);
  assert.equal(prepared.envelope_sha256, envelopeSha256(op.envelope));
  assert.equal(op.envelope.kind, 'agent_message');
  assert.equal(op.envelope.source_turn_id, 'turn_1');
  assert.equal(op.envelope.body, base.body);
  assert.equal(op.envelope.source_session_incarnation, base.sourceIncarnation);
  assert.equal(op.envelope.report, null);
  assert.equal(op.tool_call_id, 'call_a');
  assert.equal(op.gesture_id, null);
  assert.equal(op.authorization_id, null);
  assert.equal(op.state, 'prepared');
  assert.equal(Date.parse(op.expires_at), Date.parse(op.prepared_at) + DAY);
  assert.equal(f.mail(dst).inbox.length, 0, 'prepare delivers nothing');
  assert.equal(f.mail(src).authorizations.length, 0);
  assert.ok(f.coordination.includes(src));
});

test('agentPrepare is idempotent by (incarnation, turn, tool call): same body replays, a different one conflicts', async (t) => {
  const { f, src, dst, prepare } = setup(t);
  const other = f.sessionId('Other');
  const first = await prepare({ toolCallId: 'call_a' });
  const revision = f.store.getSession(src).coordination_revision;
  const replay = await prepare({ toolCallId: 'call_a' });
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.operation_id, first.operation_id);
  assert.equal(replay.envelope_sha256, first.envelope_sha256);
  assert.equal(f.mail(src).outbox.length, 1);
  assert.equal(f.store.getSession(src).coordination_revision, revision, 'a replay writes nothing');
  for (const patch of [{ body: 'A different body' }, { destinationSessionId: other }]) {
    const conflict = await prepare({ toolCallId: 'call_a', ...patch });
    assert.equal(conflict.ok, false, JSON.stringify(patch));
    assert.equal(conflict.reason, 'idempotency_conflict');
    assert.equal(conflict.error_code, CODES.IDEMPOTENCY_CONFLICT);
  }
  const otherTurn = await prepare({ toolCallId: 'call_a', turnId: 'turn_2' });
  assert.equal(otherTurn.created, true, 'the identity includes the turn');
  assert.notEqual(otherTurn.operation_id, first.operation_id);
  assert.equal(f.mail(src).outbox.length, 2);
  assert.equal(f.mail(dst).outbox.length, 0);
});

test('a replay still answers after the call was sent, cancelled or the recipient was archived', async (t) => {
  const { f, src, dst, prepare, sendOnce } = setup(t);
  const sent = await prepare({ toolCallId: 'call_sent' });
  assert.equal((await sendOnce(sent.operation_id)).ok, true);
  const cancelled = await prepare({ toolCallId: 'call_cancelled' });
  await f.service.agentCancel({ sourceSessionId: src, operationId: cancelled.operation_id });
  f.archive(dst);
  const again = await prepare({ toolCallId: 'call_sent' });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.state, 'delivered');
  assert.equal((await prepare({ toolCallId: 'call_cancelled' })).state, 'cancelled');
});

test('at most eight new agent sends per source turn; a retry never counts twice and each turn has its own eight', async (t) => {
  const { f, src, prepare } = setup(t);
  const ops = [];
  for (let i = 0; i < 8; i += 1) {
    const prepared = await prepare({ toolCallId: `call_${i}` });
    assert.equal(prepared.ok, true, `send ${i}`);
    ops.push(prepared);
  }
  const ninth = await prepare({ toolCallId: 'call_9' });
  assert.equal(ninth.ok, false);
  assert.equal(ninth.reason, 'turn_send_limit');
  assert.equal(ninth.error_code, CODES.SENDER_BACKPRESSURE);
  assert.equal(ninth.retryable, false);
  const retry = await prepare({ toolCallId: 'call_3' });
  assert.equal(retry.ok, true, 'a retry of an existing call is not a new send');
  assert.equal(retry.created, false);
  assert.equal(retry.operation_id, ops[3].operation_id);
  assert.equal(f.mail(src).outbox.length, 8);
  assert.equal((await prepare({ toolCallId: 'call_9', turnId: 'turn_2' })).ok, true);
  await f.service.agentCancel({ sourceSessionId: src, operationId: ops[0].operation_id });
  assert.equal((await prepare({ toolCallId: 'call_10' })).reason, 'turn_send_limit', 'a cancelled draft still counts for the turn');
});

test('agentPrepare enforces the body rule: 1-16,384 UTF-8 bytes, no blank or control text', async (t) => {
  const { prepare } = setup(t);
  assert.equal((await prepare({ body: 'x'.repeat(16384) })).ok, true);
  for (const body of ['x'.repeat(16385), '漢'.repeat(5462), '', '   ', 'bell\u0007', 5, null, '\ud800']) {
    const result = await prepare({ body });
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.reason, 'invalid_request');
  }
  for (const patch of [{ toolCallId: '' }, { turnId: '' }, { destinationSessionId: '../x' }, { sourceSessionId: 'bad id' }]) {
    assert.equal((await prepare(patch)).reason, 'invalid_request', JSON.stringify(patch));
  }
  assert.equal((await prepare({ toolCallId: undefined })).reason, 'invalid_request');
});

test('agentPrepare reports unreachable endpoints and a stale source with stable reasons', async (t) => {
  const { f, src, dst, prepare } = setup(t);
  assert.equal((await prepare({ destinationSessionId: src })).reason, 'self_send');
  assert.equal((await prepare({ destinationSessionId: 'sess_missing' })).reason, 'recipient_deleted');
  assert.equal((await prepare({ sourceSessionId: 'sess_missing' })).reason, 'not_found');
  assert.equal((await prepare({ sourceIncarnation: 'inc_other' })).reason, 'stale_operation');
  assert.equal((await prepare({ sourceIncarnation: '' })).reason, 'invalid_request');
  f.archive(dst);
  const archived = await prepare();
  assert.equal(archived.reason, 'recipient_archived');
  assert.equal(archived.error_code, CODES.RECIPIENT_ARCHIVED);
  f.store.setSessionMeta(dst, { archived_at: null });
  f.archive(src);
  assert.equal((await prepare()).reason, 'source_ineligible');
  assert.equal(f.mail(src).outbox.length, 0);
});

test('a full undelivered outbox refuses a new agent draft with sender_backpressure', async (t) => {
  const { f, src, prepare } = setup(t);
  for (let turn = 0; turn < 16; turn += 1) {
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await prepare({ turnId: `turn_${turn}`, toolCallId: `call_${turn}_${i}` })).ok, true);
    }
  }
  assert.equal(f.mail(src).outbox.length, 128);
  const full = await prepare({ turnId: 'turn_99', toolCallId: 'call_99' });
  assert.equal(full.ok, false);
  assert.equal(full.reason, 'sender_backpressure');
});

test('agentPrepare returns the live grant covering the direction, without the purpose', async (t) => {
  const { prepare, grant } = setup(t);
  const created = await grant();
  const prepared = await prepare();
  assert.deepEqual(prepared.grant, { grant_id: created.authorization_id, expires_at: created.expires_at, remaining_sends: 100 });
});

// ---------- send ----------

test('agentSend with a one-off approval consumes it with the pending transition, delivers and writes a receipt', async (t) => {
  const { f, src, dst, prepare, sendOnce } = setup(t);
  const prepared = await prepare();
  const sent = await sendOnce(prepared.operation_id);
  assert.equal(sent.ok, true);
  assert.equal(sent.created, true);
  assert.equal(sent.operation.state, 'delivered');
  assert.equal(sent.operation.envelope.kind, 'agent_message');
  const [op] = f.mail(src).outbox;
  assert.equal(op.state, 'delivered');
  assert.notEqual(op.authorization_id, null);
  assert.notEqual(op.send_requested_at, null);
  const [auth] = f.mail(src).authorizations;
  assert.equal(auth.kind, 'agent_once');
  assert.equal(auth.authorization_id, op.authorization_id);
  assert.equal(auth.operation_id, op.operation_id);
  assert.equal(auth.body_sha256, op.envelope.body_sha256);
  assert.equal(auth.consent_event_id, 'approval_1');
  assert.equal(auth.remaining_sends, 0);
  assert.equal(auth.expires_at, null);
  assert.equal(auth.destination_session_id, dst);
  const inbox = f.mail(dst).inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].envelope.message_id, op.envelope.message_id);
  assert.equal(inbox[0].envelope.kind, 'agent_message');
  assert.equal(inbox[0].context.state, 'queued', 'delivery queues the mail; the wake turn admits it');
  // Row 70: a live delivery wakes the idle destination exactly once, under its own authority.
  assert.equal(f.wakes.length, 1, 'one wake turn for the destination');
  assert.equal(f.wakes[0].request.sessionId, dst);
  assert.match(f.wakes[0].request.visiblePrompt, /^Woken by a message from /);
  assert.equal(f.wakes[0].request.approvalMode, 'prompt');
  assert.match(f.wakes[0].options.idempotencyKey, /^wake_[0-9a-f]{32}$/);
  const receipt = f.store.getSession(src).coordination_receipts.at(-1);
  assert.equal(receipt.method, 'session_message.send');
  assert.equal(receipt.resource_kind, 'outbox_operation');
  assert.equal(receipt.resource_id, op.operation_id);
  assert.notEqual(receipt.accepted_revision, null);
});

test('a replayed agentSend is created:false and never delivers twice', async (t) => {
  const { f, dst, prepare, sendOnce } = setup(t);
  const prepared = await prepare();
  await sendOnce(prepared.operation_id);
  const replay = await sendOnce(prepared.operation_id, { authorization: { kind: 'once', consent_event_id: 'approval_other' } });
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.operation.state, 'delivered');
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(f.mail(f.service._locate(prepared.operation_id)).authorizations.length, 1, 'no second approval is recorded');
});

test('agentSend under a directional grant spends one send and rides the grant\'s authorization id', async (t) => {
  const { f, src, prepare, grant } = setup(t);
  const created = await grant();
  const prepared = await prepare();
  const sent = await f.service.agentSend({
    sourceSessionId: src, operationId: prepared.operation_id, authorization: { kind: 'grant', grant_id: created.authorization_id },
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.operation.state, 'delivered');
  const [op] = f.mail(src).outbox;
  assert.equal(op.authorization_id, created.authorization_id);
  const [stored] = f.mail(src).authorizations;
  assert.equal(stored.remaining_sends, 99);
  assert.equal(f.mail(src).authorizations.length, 1, 'no one-off record is created');
  const second = await prepare({ toolCallId: 'call_second' });
  await f.service.agentSend({
    sourceSessionId: src, operationId: second.operation_id, authorization: { kind: 'grant', grant_id: created.authorization_id },
  });
  assert.equal(f.mail(src).authorizations[0].remaining_sends, 98);
});

test('agentSend refuses a grant that is missing, spent, revoked, expired or for another direction', async (t) => {
  const { f, src, dst, prepare, grant } = setup(t);
  const other = f.sessionId('Other');
  const live = await grant();
  const elsewhere = await grant(src, other, 'Other direction');
  const send = async (grantId) => {
    const prepared = await prepare({ toolCallId: `call_${Math.random()}` });
    return f.service.agentSend({ sourceSessionId: src, operationId: prepared.operation_id, authorization: { kind: 'grant', grant_id: grantId } });
  };
  const missing = await send(UUID);
  assert.equal(missing.reason, 'authorization_required');
  assert.equal(missing.error_code, CODES.AUTHORIZATION_REQUIRED);
  assert.equal((await send(elsewhere.authorization_id)).reason, 'authorization_required', 'another destination');
  f.store._updateSessionRecord(src, {
    session_mail: { ...f.mail(src), authorizations: f.mail(src).authorizations.map((auth) => (auth.authorization_id === live.authorization_id ? { ...auth, remaining_sends: 0 } : auth)) },
  }, { bumpUpdatedAt: false });
  assert.equal((await send(live.authorization_id)).reason, 'authorization_required', 'spent');
  await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: live.authorization_id });
  const revoked = await send(live.authorization_id);
  assert.equal(revoked.reason, 'authorization_revoked');
  assert.equal(revoked.error_code, CODES.AUTHORIZATION_REVOKED);
  const fresh = await grant();
  f.advance(7 * DAY + 1000);
  assert.equal((await send(fresh.authorization_id)).reason, 'authorization_revoked', 'expired');
  assert.equal(f.mail(dst).inbox.length, 0);
  const ops = f.mail(src).outbox;
  assert.ok(ops.every((op) => ['prepared', 'cancelled'].includes(op.state) && op.authorization_id === null),
    'a refused send never pends a draft (stale ones expire to cancelled)');
});

test('a project reassignment of the destination blocks a grant send until it is granted again', async (t) => {
  const { f, src, dst, prepare, grant } = setup(t);
  const created = await grant();
  f.store._updateSessionRecord(dst, { project_id: 'project_b' }, { bumpUpdatedAt: false });
  const prepared = await prepare();
  const sent = await f.service.agentSend({
    sourceSessionId: src, operationId: prepared.operation_id, authorization: { kind: 'grant', grant_id: created.authorization_id },
  });
  assert.equal(sent.ok, false);
  assert.equal(sent.reason, 'authorization_required');
  assert.equal(f.mail(src).authorizations[0].remaining_sends, 100);
});

test('agentSend validates its arguments and the operation it names', async (t) => {
  const { f, src, dst, prepare } = setup(t);
  const prepared = await prepare();
  const bad = [
    { authorization: { kind: 'grant' } }, { authorization: { kind: 'grant', grant_id: 'nope' } }, { authorization: { kind: 'once' } },
    { authorization: { kind: 'once', consent_event_id: '' } }, { authorization: { kind: 'once', consent_event_id: 'x', extra: 1 } },
    { authorization: { kind: 'forever', grant_id: UUID } }, { authorization: null }, { operationId: 'nope' }, { sourceSessionId: '../x' },
  ];
  for (const patch of bad) {
    const result = await f.service.agentSend({ sourceSessionId: src, operationId: prepared.operation_id, authorization: ONCE, ...patch });
    assert.equal(result.reason, 'invalid_request', JSON.stringify(patch));
  }
  assert.equal((await f.service.agentSend({ sourceSessionId: src, operationId: UUID, authorization: ONCE })).reason, 'stale_operation');
  assert.equal(f.mail(src).outbox[0].state, 'prepared');
  const userOp = await f.prepare(src, dst, 'a user draft');
  assert.equal((await f.service.agentSend({ sourceSessionId: src, operationId: userOp.operation_id, authorization: ONCE })).reason, 'stale_operation',
    'an agent approval never sends a user draft');
  const agentOp = await f.service.send({ ...V, operation_id: prepared.operation_id });
  assert.equal(agentOp.reason, 'stale_operation', 'the user Send path never authorizes an agent draft');
  assert.equal(f.mail(src).outbox.find((op) => op.operation_id === prepared.operation_id).state, 'prepared');
  assert.equal(f.mail(dst).inbox.length, 0);
});

test('agentSend re-reads the source and the draft expiry inside its mutation', async (t) => {
  const { f, src, prepare, sendOnce } = setup(t);
  const stale = await prepare({ toolCallId: 'call_stale' });
  f.advance(DAY + 1000);
  const expired = await sendOnce(stale.operation_id);
  assert.equal(expired.reason, 'expired');
  assert.equal(expired.error_code, CODES.STALE_OPERATION);
  const fresh = await prepare({ toolCallId: 'call_fresh' });
  f.archive(src);
  const archived = await sendOnce(fresh.operation_id);
  assert.equal(archived.reason, 'source_ineligible');
  f.store.setSessionMeta(src, { archived_at: null });
  const afterProject = await prepare({ toolCallId: 'call_project' });
  f.store._updateSessionRecord(src, { project_id: 'project_b' }, { bumpUpdatedAt: false });
  assert.equal((await sendOnce(afterProject.operation_id)).reason, 'stale_operation', 'a reassigned source needs a fresh draft');
  assert.equal(f.mail(src).authorizations.length, 0);
});

// ---------- delivery-time revocation ----------

test('a pending grant send whose grant is revoked before delivery fails authorization_revoked and cannot be retried', async (t) => {
  const { f, src, dst, prepare, grant } = setup(t);
  const created = await grant();
  const prepared = await prepare();
  f.failFlush(dst, 1);
  const sent = await f.service.agentSend({
    sourceSessionId: src, operationId: prepared.operation_id, authorization: { kind: 'grant', grant_id: created.authorization_id },
  });
  assert.equal(sent.reason, 'persistence_failure', 'the destination write failed transiently');
  assert.equal(f.mail(src).outbox[0].state, 'pending');
  assert.equal(f.mail(dst).inbox.length, 0);
  const revoked = await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: created.authorization_id });
  assert.equal(revoked.ok, true);
  const [op] = f.mail(src).outbox;
  assert.equal(op.state, 'failed');
  assert.deepEqual(op.last_error, { code: CODES.AUTHORIZATION_REVOKED, reason: 'authorization_revoked', retryable: false });
  assert.equal(f.mail(dst).inbox.length, 0, 'nothing was delivered');
  const retry = await f.service.retry({ ...V, operation_id: prepared.operation_id });
  assert.equal(retry.ok, false, 'Retry cannot acquire new permission');
  assert.equal(f.mail(dst).inbox.length, 0);
});

test('a fresh approval of the same failed operation re-pends the same message and delivers it', async (t) => {
  const { f, src, dst, prepare, grant, sendOnce } = setup(t);
  const created = await grant();
  const prepared = await prepare();
  f.failFlush(dst, 1);
  await f.service.agentSend({
    sourceSessionId: src, operationId: prepared.operation_id, authorization: { kind: 'grant', grant_id: created.authorization_id },
  });
  await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: created.authorization_id });
  const messageId = f.mail(src).outbox[0].envelope.message_id;
  const reapproved = await sendOnce(prepared.operation_id, { authorization: { kind: 'once', consent_event_id: 'approval_again' } });
  assert.equal(reapproved.ok, true);
  assert.equal(reapproved.created, true);
  assert.equal(reapproved.operation.state, 'delivered');
  assert.equal(reapproved.operation.operation_id, prepared.operation_id, 'the same operation identity');
  assert.equal(f.mail(src).outbox.length, 1);
  assert.equal(f.mail(dst).inbox.length, 1);
  assert.equal(f.mail(dst).inbox[0].envelope.message_id, messageId, 'the same message, never a replacement');
  const kinds = f.mail(src).authorizations.map((auth) => auth.kind).sort();
  assert.deepEqual(kinds, ['agent_directional', 'agent_once']);
});

test('a destination receipt wins over a revocation: the delivery finalizes without any authorization check', async (t) => {
  const { f, src, dst, prepare, grant } = setup(t);
  const created = await grant();
  const prepared = await prepare();
  f.failFlush(src, 1, 1); // accept flush ok, destination write ok, the source's delivered flush fails
  const sent = await f.service.agentSend({
    sourceSessionId: src, operationId: prepared.operation_id, authorization: { kind: 'grant', grant_id: created.authorization_id },
  });
  assert.equal(sent.ok, false);
  assert.equal(f.mail(dst).inbox.length, 1, 'the destination already holds the message');
  assert.equal(f.mail(src).outbox[0].state, 'pending');
  const revoked = await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: created.authorization_id });
  assert.equal(revoked.ok, true);
  const [op] = f.mail(src).outbox;
  assert.equal(op.state, 'delivered', 'delivered text is never retracted by a revocation');
  assert.equal(f.mail(dst).inbox.length, 1);
});

test('a destination whose project changed while pending fails the delivery without delivering', async (t) => {
  const { f, src, dst, prepare, sendOnce } = setup(t);
  const prepared = await prepare();
  f.failFlush(dst, 1);
  await sendOnce(prepared.operation_id);
  f.store._updateSessionRecord(dst, { project_id: 'project_b' }, { bumpUpdatedAt: false });
  const retried = await f.service.retry({ ...V, operation_id: prepared.operation_id });
  assert.equal(retried.ok, true);
  assert.equal(f.mail(src).outbox[0].state, 'failed');
  assert.equal(f.mail(dst).inbox.length, 0);
});

test('restart reconciliation re-checks a pending agent send and fails it when the grant was revoked meanwhile', async (t) => {
  const { f, src, dst, prepare, grant } = setup(t);
  const created = await grant();
  const prepared = await prepare();
  f.failFlush(dst, 1);
  await f.service.agentSend({
    sourceSessionId: src, operationId: prepared.operation_id, authorization: { kind: 'grant', grant_id: created.authorization_id },
  });
  // The revocation lands without the settle step (as if the process died right after it).
  f.store._updateSessionRecord(src, {
    session_mail: { ...f.mail(src), authorizations: f.mail(src).authorizations.map((auth) => ({ ...auth, revoked_at: new Date(f.clock.ms).toISOString() })) },
  }, { bumpUpdatedAt: false });
  f.service.reconcileOnStartup();
  assert.equal(f.mail(src).outbox[0].state, 'failed');
  assert.equal(f.mail(src).outbox[0].last_error.reason, 'authorization_revoked');
  assert.equal(f.mail(dst).inbox.length, 0);
});

// ---------- cancel ----------

test('agentCancel cancels a prepared draft once, and never a draft that was approved or is not an agent draft', async (t) => {
  const { f, src, dst, prepare, sendOnce } = setup(t);
  const draft = await prepare({ toolCallId: 'call_draft' });
  const cancelled = await f.service.agentCancel({ sourceSessionId: src, operationId: draft.operation_id });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.created, true);
  assert.equal(cancelled.operation.state, 'cancelled');
  assert.equal(f.mail(src).outbox[0].state, 'cancelled');
  const again = await f.service.agentCancel({ sourceSessionId: src, operationId: draft.operation_id });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal((await sendOnce(draft.operation_id)).reason, 'stale_operation', 'a cancelled draft cannot be sent');
  const sent = await prepare({ toolCallId: 'call_sent' });
  await sendOnce(sent.operation_id);
  assert.equal((await f.service.agentCancel({ sourceSessionId: src, operationId: sent.operation_id })).reason, 'stale_operation');
  const userOp = await f.prepare(src, dst, 'a user draft');
  assert.equal((await f.service.agentCancel({ sourceSessionId: src, operationId: userOp.operation_id })).reason, 'stale_operation');
  assert.equal((await f.service.agentCancel({ sourceSessionId: src, operationId: UUID })).reason, 'stale_operation');
  assert.equal((await f.service.agentCancel({ sourceSessionId: src, operationId: 'nope' })).reason, 'invalid_request');
  assert.equal(f.mail(dst).inbox.length, 1, 'only the approved message was delivered');
});

// ---------- list_targets ----------

test('listAgentTargets lists only granted destinations, with the model-visible grant fields', async (t) => {
  const { f, dst, targets, grant } = setup(t);
  f.sessionId('Not granted');
  assert.deepEqual(await targets(), []);
  const created = await grant();
  const list = await targets();
  assert.deepEqual(list, [{
    session_id: dst, title: 'Dest', project_label: 'Alpha', free_form_allowed: true,
    grant: { grant_id: created.authorization_id, expires_at: created.expires_at, remaining_sends: 100 },
  }]);
  assert.equal(JSON.stringify(list).includes('Share review notes'), false, 'the purpose is not shown to the model');
  assert.equal(JSON.stringify(list).includes('consent'), false);
});

test('listAgentTargets drops a destination when its grant ended or the chat changed', async (t) => {
  const { f, src, dst, targets, grant } = setup(t);
  const created = await grant();
  assert.equal((await targets()).length, 1);
  f.store._updateSessionRecord(dst, { project_id: 'project_b' }, { bumpUpdatedAt: false });
  assert.equal((await targets()).length, 0, 'a project reassignment ends the grant');
  f.store._updateSessionRecord(dst, { project_id: 'project_a' }, { bumpUpdatedAt: false });
  assert.equal((await targets()).length, 1);
  f.archive(dst);
  assert.equal((await targets()).length, 0, 'an archived recipient is not a target');
  f.store.setSessionMeta(dst, { archived_at: null });
  await f.service.revokeGrant({ ...V, source_session_id: src, grant_id: created.authorization_id });
  assert.equal((await targets()).length, 0);
  await grant();
  f.advance(7 * DAY + 1000);
  assert.equal((await targets()).length, 0, 'an expired grant is not a target');
});

test('listAgentTargets bounds titles to 512 UTF-8 bytes and reports a stale or missing source', async (t) => {
  const { f, src, dst, targets, grant } = setup(t);
  await grant();
  f.store.setSessionMeta(dst, { title: '漢'.repeat(300) });
  const [target] = await targets();
  assert.ok(Buffer.byteLength(target.title, 'utf8') <= 512);
  assert.equal((await f.service.listAgentTargets({ sourceSessionId: src, sourceIncarnation: 'inc_other' })).reason, 'stale_operation');
  assert.equal((await f.service.listAgentTargets({ sourceSessionId: 'sess_missing', sourceIncarnation: 'inc_x' })).reason, 'not_found');
  assert.equal((await f.service.listAgentTargets({})).reason, 'invalid_request');
});

test('a linked child lists its immediate parent as a reporting-only target while reporting is on', async (t) => {
  const f = createFixture(t);
  const parent = f.sessionId('Parent chat');
  const parentInc = f.store.getSession(parent).session_incarnation;
  const child = f.store.createSessionWithId('sess_child', {
    title: 'Child chat', spawnedFrom: makeSpawnedFrom({ parent_session_id: parent, parent_session_incarnation: parentInc }),
  }).id;
  const childInc = f.store.getSession(child).session_incarnation;
  const mailStore = createSessionMailStore(f.store);
  const list = async () => (await f.service.listAgentTargets({ sourceSessionId: child, sourceIncarnation: childInc })).targets;
  mailStore.mutate(child, ({ mail }) => ({ mail: { ...mail, reporting_enabled: false } }));
  assert.deepEqual(await list(), [], 'reporting is off: no relation is listed');
  mailStore.mutate(child, ({ mail }) => ({ mail: { ...mail, reporting_enabled: true } }));
  assert.deepEqual(await list(), [{ session_id: parent, title: 'Parent chat', project_label: null, free_form_allowed: false, grant: null }]);
  mailStore.mutate(child, ({ mail }) => ({ mail: { ...mail, reporting_enabled: false } }));
  assert.deepEqual(await list(), [], 'turning reporting off removes the relation');
});

test('a grant that also covers the parent makes it free-form; archiving the parent removes it', async (t) => {
  const f = createFixture(t);
  const parent = f.sessionId('Parent chat');
  const parentInc = f.store.getSession(parent).session_incarnation;
  const child = f.store.createSessionWithId('sess_child', {
    title: 'Child chat', spawnedFrom: makeSpawnedFrom({ parent_session_id: parent, parent_session_incarnation: parentInc }),
  }).id;
  const childInc = f.store.getSession(child).session_incarnation;
  createSessionMailStore(f.store).mutate(child, ({ mail }) => ({ mail: { ...mail, reporting_enabled: true } }));
  const created = (await f.service.createGrant({
    ...V, source_session_id: child, destination_session_id: parent, purpose: 'Ask questions', gesture_id: f.gesture(),
  })).grant;
  const list = async () => (await f.service.listAgentTargets({ sourceSessionId: child, sourceIncarnation: childInc })).targets;
  const [target] = await list();
  assert.equal(target.session_id, parent);
  assert.equal(target.free_form_allowed, true);
  assert.equal(target.grant.grant_id, created.authorization_id);
  assert.equal((await list()).length, 1, 'the parent is listed once');
  f.archive(parent);
  assert.deepEqual(await list(), []);
});

// ---------- read ----------

test('agentRead returns only an included inbox message of this chat', async (t) => {
  const { f, src, dst, inc, prepare, sendOnce } = setup(t);
  const prepared = await prepare();
  await sendOnce(prepared.operation_id);
  const [record] = f.mail(dst).inbox;
  const messageId = record.envelope.message_id;
  const read = (sessionId, id = messageId) => f.service.agentRead({ sourceSessionId: sessionId, sourceIncarnation: inc(sessionId), messageId: id });
  assert.equal((await read(dst)).reason, 'not_found', 'queued mail is not readable');
  const mailStore = createSessionMailStore(f.store);
  const setContext = (context) => mailStore.mutate(dst, ({ mail }) => ({
    mail: { ...mail, inbox: mail.inbox.map((entry) => ({ ...entry, context })) },
  }));
  setContext({ state: 'reserved', turn_id: 'turn_9', snapshot_id: UUID });
  assert.equal((await read(dst)).reason, 'not_found', 'reserved mail is not readable');
  setContext({ state: 'excluded_by_user', changed_at: new Date(f.clock.ms).toISOString() });
  assert.equal((await read(dst)).reason, 'not_found', 'excluded mail is not readable');
  setContext({
    state: 'included', turn_id: 'turn_9', snapshot_id: UUID, included_at: new Date(f.clock.ms).toISOString(), canonical_message_id: `ctx_${messageId}`,
  });
  const included = await read(dst);
  assert.equal(included.ok, true);
  assert.equal(included.envelope.body, record.envelope.body);
  assert.equal((await read(src)).reason, 'not_found', 'another chat\'s inbox');
  assert.equal((await read(dst, UUID)).reason, 'not_found');
  assert.equal((await read(dst, 'nope')).reason, 'invalid_request');
  assert.equal((await f.service.agentRead({ sourceSessionId: dst, sourceIncarnation: 'inc_other', messageId })).reason, 'stale_operation');
});
