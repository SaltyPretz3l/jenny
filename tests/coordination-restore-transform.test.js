'use strict';

// Pure restore transform for archived session coordination (row 59 cp5b-3, slice H1).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const R = require('../services/backend/chat-proposal-records');
const S = require('../services/backend/chat-proposal-session-records');
const M = require('../services/backend/session-mail-records');
const { normalizeCoordinationFields, normalizeLaunchGrant } = require('../services/backend/session-coordination-records');
const { transformRestoredCoordination } = require('../services/data-lifecycle/coordination-restore-transform');
const P = require('./helpers/chat-proposal-records-fixture');
const F = require('./helpers/session-mail-fixtures');
const {
  acceptedCommand, acceptedGit, launchGrant, pendingOp, sessionProposal,
} = require('./helpers/coordination-archive-fixtures');

const RESTORE_NOW = new Date('2026-10-16T09:30:00.000Z');
const RESTORE_ISO = RESTORE_NOW.toISOString();
const MESSAGE_RESTORE_ERROR = { code: 'CMP-MESSAGE-0003', reason: 'restored_confirmation_required', retryable: false };
const PROPOSAL_RESTORE_REASON = 'restored_confirmation_required';

function mail(overrides = {}) {
  return { ...normalizeCoordinationFields({}).session_mail, ...overrides };
}

function archived(overrides = {}) {
  return { session_incarnation: 'inc_dst', ...normalizeCoordinationFields({}), ...overrides };
}

const run = (record, options = {}) => transformRestoredCoordination(record, { restoredSessionIds: ['sess_src', 'sess_dst'], now: RESTORE_NOW, ...options });

const withProposals = (records, launchGrants = []) => archived({
  chat_proposals: { schema_version: 1, records, launch_grants: launchGrants },
});

test('outbox: a pending send fails closed behind a confirmation; a never-sent prepared op stays prepared', () => {
  const prepared = F.makeOutbox(1);
  const pending = pendingOp(2);
  const result = run(archived({ session_mail: mail({ outbox: [prepared, pending] }) }));
  assert.equal(result.quarantined, false);
  const [first, second] = result.record.session_mail.outbox;
  assert.deepEqual(first, prepared, 'no consent was ever given for a prepared op, so nothing is fabricated for it');
  for (const [out, source] of [[second, pending]]) {
    assert.equal(out.state, 'failed');
    assert.equal(out.restore_requires_confirmation, true);
    assert.deepEqual(out.last_error, MESSAGE_RESTORE_ERROR);
    assert.equal(out.operation_id, source.operation_id);
    assert.deepEqual(out.envelope, source.envelope);
    assert.equal(out.authorization_id, source.authorization_id, 'the identity and receipts of the op are preserved');
    assert.notEqual(M.normalizeOutboxRecord(out), null, 'a restored op is a valid stored outbox record');
  }
  assert.equal(second.send_requested_at, pending.send_requested_at);
});

test('outbox: delivered, failed and cancelled sends are unchanged', () => {
  const delivered = F.makeOutbox(3, {
    state: 'delivered', send_requested_at: F.iso(1000), delivered_at: F.iso(2000), destination_receipt_id: F.uuid(3003),
  });
  const failed = F.makeOutbox(4, {
    state: 'failed', send_requested_at: F.iso(1000),
    last_error: { code: 'CMP-MESSAGE-0002', reason: 'unavailable', retryable: true },
  });
  const cancelled = F.makeOutbox(5, { state: 'cancelled' });
  const record = archived({ session_mail: mail({ outbox: [delivered, failed, cancelled] }) });
  const result = run(record);
  assert.deepEqual(result.record.session_mail.outbox, [delivered, failed, cancelled]);
  assert.equal(result.record.coordination_revision, record.coordination_revision, 'nothing changed, so the revision is kept');
});

test('mail: inbox, discard receipts and inclusion state are preserved; reporting is switched off', () => {
  const included = F.makeInbox(6, {
    read_at: F.iso(500), context: { state: 'included', turn_id: 'turn_1', snapshot_id: F.uuid(6001), included_at: F.iso(400), canonical_message_id: `ctx_${F.uuid(6)}` },
  });
  const excluded = F.makeInbox(7, { context: { state: 'excluded_by_user', changed_at: F.iso(300) } });
  const queued = F.makeInbox(8);
  const discard = F.makeDiscard(9);
  const result = run(archived({
    session_mail: mail({ inbox: [included, excluded, queued], discarded: [discard], reporting_enabled: true, next_receive_sequence: 12 }),
  }));
  assert.deepEqual(result.record.session_mail.inbox, [included, excluded, queued]);
  assert.deepEqual(result.record.session_mail.discarded, [discard]);
  assert.equal(result.record.session_mail.next_receive_sequence, 12);
  assert.equal(result.record.session_mail.reporting_enabled, false);
});

test('mail: report reservations are dropped and reserved admission snapshots are released', () => {
  const reserved = F.makeSnapshot(1, { state: 'reserved' });
  const published = F.makeSnapshot(2, { state: 'published' });
  const reservedRow = F.makeInbox(10, { context: { state: 'reserved', turn_id: 'turn_1', snapshot_id: reserved.snapshot_id } });
  const result = run(archived({
    session_mail: mail({
      report_reservations: [F.makeReservation(1)],
      admission_snapshots: [reserved, published],
      inbox: [reservedRow],
    }),
  }));
  assert.deepEqual(result.record.session_mail.report_reservations, []);
  assert.deepEqual(result.record.session_mail.admission_snapshots, [published]);
  assert.deepEqual(result.record.session_mail.inbox[0].context, { state: 'queued' }, 'a reserved row goes back to the queue, never to included');
  assert.notEqual(M.normalizeInboxRecord(result.record.session_mail.inbox[0]), null);
});

test('authorizations: directional grants and launch grants are never live; per-operation ones are untouched', () => {
  const directional = F.makeAuthorization(1, {
    kind: 'agent_directional', operation_id: null, body_sha256: null, purpose: 'keep in sync',
    expires_at: F.iso(7 * 24 * 60 * 60 * 1000), remaining_sends: 40,
  });
  const once = F.makeAuthorization(2, { kind: 'agent_once' });
  const userSend = F.makeAuthorization(3);
  const grant = launchGrant(1);
  const revokedGrant = launchGrant(2, { revoked_at: F.iso(10), remaining: 0 });
  const result = run({
    ...withProposals([], [grant, revokedGrant]),
    session_mail: mail({ authorizations: [directional, once, userSend] }),
  });
  const [outDirectional, outOnce, outUser] = result.record.session_mail.authorizations;
  assert.equal(outDirectional.revoked_at, RESTORE_ISO);
  assert.equal(outDirectional.remaining_sends, 0);
  assert.equal(outDirectional.authorization_id, directional.authorization_id, 'kept as a record');
  assert.notEqual(M.normalizeAuthorizationRecord(outDirectional), null);
  assert.deepEqual(outOnce, once);
  assert.deepEqual(outUser, userSend);
  const [outGrant, outRevoked] = result.record.chat_proposals.launch_grants;
  assert.equal(outGrant.revoked_at, RESTORE_ISO);
  assert.equal(outGrant.remaining, 0);
  assert.equal(outGrant.authorization_ref, grant.authorization_ref);
  assert.notEqual(normalizeLaunchGrant(outGrant), null);
  assert.deepEqual(outRevoked, revokedGrant, 'an already revoked grant keeps its original revocation time');
});

test('proposals: accepted non-terminal actions need attention and every command is inert', () => {
  const sessionPending = sessionProposal(1);
  const gitPending = P.makeGit(2);
  const commandPending = P.makeCommand(3);
  const gitQueued = acceptedGit(4, 'queued');
  const gitAdmitted = acceptedGit(5, 'admitted');
  const commandQueued = acceptedCommand(6, 'queued');
  const sessionAccepted = S.acceptSessionDecision(sessionProposal(7), { decisionId: P.DECISION, choice: 'do_it_here', now: P.NOW, attemptId: P.ATTEMPT });
  const records = [sessionPending, gitPending, commandPending, gitQueued, gitAdmitted, commandQueued, sessionAccepted];
  const result = run(withProposals(records));
  const out = result.record.chat_proposals.records;
  assert.equal(out.length, records.length);
  for (const [index, record] of out.entries()) {
    const source = records[index];
    assert.equal(record.proposal_id, source.proposal_id);
    assert.equal(record.restore_requires_confirmation, true, `${source.kind}/${source.action_state} carries the flag`);
    assert.deepEqual(R.normalizeProposalRecord(record), record, 'a restored proposal is a valid stored record');
  }
  // Pending non-command and pending command offers stay pending (read-only until confirmed).
  for (const index of [0, 1, 2]) {
    assert.equal(out[index].decision_state, 'pending');
    assert.equal(out[index].action_state, 'none');
    assert.equal(out[index].last_error, null);
  }
  // Accepted work whose outcome is unknown is never reset to pending or replayed.
  for (const index of [3, 4, 5, 6]) {
    assert.equal(out[index].decision_state, 'accepted');
    assert.equal(out[index].action_state, 'needs_attention');
    assert.equal(out[index].last_error.reason, PROPOSAL_RESTORE_REASON);
    assert.equal(out[index].last_error.code, R.PROPOSAL_ERROR_CODES.authorization_required);
    assert.equal(out[index].last_error.retryable, false);
    assert.equal(out[index].revision, records[index].revision + 1);
    assert.equal(out[index].dispatch_key, records[index].dispatch_key, 'the same dispatch identity is kept');
    assert.equal(out[index].attempt_id, records[index].attempt_id);
  }
  assert.equal(out[2].revision, commandPending.revision + 1);
});

test('proposals: terminal records are unchanged', () => {
  const dismissed = R.dismissProposal(P.makeGit(1), { decisionId: P.DECISION, now: P.NOW });
  const expired = R.expireIfDue(P.makeGit(2), new Date(P.NOW.getTime() + 8 * P.DAY));
  const stale = R.markStale(P.makeGit(3));
  const succeeded = acceptedGit(4, 'succeeded');
  const failed = acceptedGit(5, 'failed');
  const cancelled = acceptedGit(6, 'cancelled');
  const commandDone = acceptedCommand(7, 'succeeded');
  const records = [dismissed, expired, stale, succeeded, failed, cancelled, commandDone];
  const result = run(withProposals(records));
  assert.deepEqual(result.record.chat_proposals.records, records);
});

test('proposals: an accepted needs_attention record is re-marked once and the transform is idempotent', () => {
  const unknown = { ...acceptedGit(1, 'queued'), action_state: 'needs_attention' };
  unknown.last_error = { code: R.PROPOSAL_ERROR_CODES.outcome_unknown, reason: 'outcome_unknown', retryable: false, cause_code: 'restart' };
  assert.deepEqual(R.normalizeProposalRecord(unknown), unknown);
  const first = run(withProposals([unknown, P.makeCommand(2)], [launchGrant(1)]));
  const [restored] = first.record.chat_proposals.records;
  assert.equal(restored.last_error.reason, PROPOSAL_RESTORE_REASON);
  assert.equal(restored.last_error.cause_code, 'outcome_unknown', 'the prior reason is kept as the cause');
  const second = run(first.record);
  assert.deepEqual(second.record, first.record, 'a second pass changes nothing, not even revisions');
});

test('revision: the coordination revision moves once when anything changed', () => {
  const record = archived({ coordination_revision: 4, session_mail: mail({ outbox: [pendingOp(1)] }) });
  assert.equal(run(record).record.coordination_revision, 5);
  assert.equal(run(archived({ coordination_revision: 4 })).record.coordination_revision, 4);
});

test('opaque entries and future containers are carried verbatim, never normalized away', () => {
  const futureOutbox = { future: true, schema_version: 9, state: 'pending' };
  const opaqueProposal = { schema_version: 2, proposal_id: 'future' };
  const result = run(archived({
    chat_proposals: { schema_version: 1, records: [opaqueProposal], launch_grants: [{ schema_version: 2, authorization_ref: 'x' }] },
    session_mail: mail({ outbox: [futureOutbox, pendingOp(1)] }),
  }));
  assert.deepEqual(result.record.session_mail.outbox[0], futureOutbox);
  assert.equal(result.record.session_mail.outbox[1].state, 'failed');
  assert.deepEqual(result.record.chat_proposals.records, [opaqueProposal]);
  assert.deepEqual(result.record.chat_proposals.launch_grants, [{ schema_version: 2, authorization_ref: 'x' }]);

  const frozenMail = { schema_version: 2, whatever: [pendingOp(2)] };
  const frozenProposals = { schema_version: 3, records: [P.makeCommand(1)] };
  const frozen = run(archived({ session_mail: frozenMail, chat_proposals: frozenProposals }));
  assert.equal(frozen.quarantined, false);
  assert.deepEqual(frozen.record.session_mail, frozenMail);
  assert.deepEqual(frozen.record.chat_proposals, frozenProposals);
});

test('quarantine: a malformed record falls back to default coordination and says why', () => {
  const defaults = normalizeCoordinationFields({});
  const bad = [
    ['session_mail_invalid', { session_mail: 'oops' }],
    ['session_mail_invalid', { session_mail: mail({ outbox: 'x' }) }],
    ['session_mail_invalid', { session_mail: mail({ next_receive_sequence: 'one' }) }],
    ['chat_proposals_invalid', { chat_proposals: { schema_version: 1, records: {}, launch_grants: [] } }],
    ['chat_proposals_invalid', { chat_proposals: [] }],
    ['spawned_from_invalid', { spawned_from: { schema_version: 1, parent_session_id: 'p' } }],
    ['coordination_receipts_invalid', { coordination_receipts: 'x' }],
  ];
  for (const [reason, patch] of bad) {
    const result = run(archived({ coordination_revision: 3, ...patch }));
    assert.equal(result.quarantined, true, reason);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.record, { session_incarnation: 'inc_dst', ...defaults });
  }
  for (const record of [null, 'x', [], undefined]) {
    const result = run(record);
    assert.equal(result.quarantined, true);
    assert.equal(result.reason, 'record_invalid');
    assert.deepEqual(result.record, { session_incarnation: '', ...defaults });
  }
  const badIncarnation = run(archived({ session_incarnation: 42 }));
  assert.equal(badIncarnation.quarantined, true);
  assert.equal(badIncarnation.reason, 'incarnation_invalid');
});

test('session proposals in every accepted state lift to valid needs-attention records', () => {
  const states = [];
  const take = (record) => { assert.deepEqual(R.normalizeProposalRecord(record), record); states.push(record); return record; };
  const args = { decisionId: P.DECISION, now: P.NOW, attemptId: P.ATTEMPT };
  take(S.acceptSessionDecision(sessionProposal(1), { ...args, choice: 'do_it_here' }));
  take(S.acceptSessionDecision(sessionProposal(2), { ...args, choice: 'new_session', waitForSource: true }));
  take(S.acceptSessionDecision(sessionProposal(3), { ...args, choice: 'new_session' }));
  const preparing = (n) => S.markPreparing(S.markPrepAcknowledged(
    S.acceptSessionDecision(sessionProposal(n), { ...args, choice: 'new_session' }), { workId: 'work_p', turnId: 'turn_p' },
  ));
  take(preparing(4));
  take(S.recordHandoff(preparing(5), { task: 'Do it', background: 'Ctx', childSessionId: 'sess_child', childIncarnation: 'inc_child' }));
  const result = run(withProposals(states));
  assert.equal(result.quarantined, false, result.reason);
  for (const [index, restored] of result.record.chat_proposals.records.entries()) {
    assert.equal(restored.action_state, 'needs_attention', `state ${states[index].action_state}`);
    assert.equal(restored.restore_requires_confirmation, true);
    assert.equal(restored.child_session_id, states[index].child_session_id, 'child links and proof are untouched');
    assert.equal(restored.dispatch_key, states[index].dispatch_key);
  }
  assert.deepEqual(result.unavailable_session_ids, ['sess_child'], 'a child that was not restored is an unavailable link');
});

test('unavailable counterparts are reported, never fabricated', () => {
  const orphan = F.makeOutbox(1, { state: 'pending', send_requested_at: F.iso(1) }, { destination: { session_id: 'sess_gone' } });
  const record = archived({
    spawned_from: F.makeSpawnedFrom({ parent_session_id: 'sess_parent_gone' }),
    session_mail: mail({ outbox: [orphan], inbox: [F.makeInbox(2, {}, { source: { session_id: 'sess_src' } })] }),
  });
  const result = run(record, { restoredSessionIds: new Set(['sess_src', 'sess_dst']) });
  assert.deepEqual(result.unavailable_session_ids, ['sess_gone', 'sess_parent_gone']);
  assert.equal(result.record.session_mail.outbox[0].envelope.destination_session_id, 'sess_gone', 'the link stays as it was recorded');
  assert.equal(result.record.spawned_from.parent_session_id, 'sess_parent_gone');
});

test('the transform is pure: its input is never mutated', () => {
  const record = archived({
    session_mail: mail({ outbox: [pendingOp(1)], report_reservations: [F.makeReservation(1)], reporting_enabled: true }),
    chat_proposals: { schema_version: 1, records: [acceptedGit(2, 'queued'), P.makeCommand(3)], launch_grants: [launchGrant(1)] },
  });
  const before = JSON.stringify(record);
  run(record);
  assert.equal(JSON.stringify(record), before);
});

test('the timestamp comes from the injected clock', () => {
  const directional = F.makeAuthorization(1, {
    kind: 'agent_directional', operation_id: null, body_sha256: null, purpose: 'p', expires_at: F.iso(7 * 24 * 60 * 60 * 1000), remaining_sends: 2,
  });
  const result = transformRestoredCoordination(archived({ session_mail: mail({ authorizations: [directional] }) }), {
    restoredSessionIds: [], now: '2027-01-02T03:04:05.678Z',
  });
  assert.equal(result.record.session_mail.authorizations[0].revoked_at, '2027-01-02T03:04:05.678Z');
});
