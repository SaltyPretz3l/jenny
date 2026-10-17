'use strict';

/* Launch grants (row 59 checkpoint 5a-1, D7): authorizeLaunch idempotency, conflict, capacity and
 * its refusals, and the atomic consumption of one grant by a live propose_session(user_asked)
 * call of the same turn. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { createSessionFixture } = require('./helpers/chat-proposal-session-fixture');

const HOUR = 60 * 60 * 1000;

function withMessage(fx, messageId = 'msg_1', turnId = 'turn_1') {
  fx.ctl.userTurns.set(messageId, turnId);
}

test('authorizeLaunch grants one hour, bound to the message\'s resolved turn, and is idempotent by (message, action)', async (t) => {
  const fx = createSessionFixture(t);
  withMessage(fx);
  const first = await fx.authorize('msg_1');
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.match(first.authorization_ref, /^[0-9a-f-]{36}$/u);
  assert.equal(first.remaining, 1);
  assert.equal(Date.parse(first.expires_at) - fx.clock.ms, HOUR);
  const [grant] = fx.grants();
  assert.deepEqual(
    [grant.source_session_incarnation, grant.source_user_message_id, grant.source_turn_id, grant.destination_project_ids, grant.max_children, grant.revoked_at],
    [fx.sessionIncarnation, 'msg_1', 'turn_1', ['proj_1'], 1, null],
  );
  assert.deepEqual(grant.restrictions, { read_only: false, plan_mode: false, lockdown: false });
  assert.equal(fx.rail.length, 1);

  const again = await fx.authorize('msg_1');
  assert.deepEqual(again, first, 'the same pair replays the same grant');
  assert.equal(fx.grants().length, 1);
  assert.equal(fx.rail.length, 1, 'a replay is not a mutation');
  const conflict = await fx.authorize('msg_1', { max_children: 2 });
  assert.deepEqual([conflict.ok, conflict.reason, conflict.error_code], [false, 'idempotency_conflict', CODES.IDEMPOTENCY_CONFLICT]);
  const otherDestinations = await fx.authorize('msg_1', { destination_project_ids: ['proj_2'] });
  assert.equal(otherDestinations.reason, 'idempotency_conflict');
  const otherAction = await fx.authorize('msg_1', { action_id: randomUUID() });
  assert.equal(otherAction.ok, true, 'a different action id is a different grant');
  assert.equal(fx.grants().length, 2);
});

test('authorizeLaunch refuses a wrong incarnation, an unresolvable message and a malformed request without writing', async (t) => {
  const fx = createSessionFixture(t);
  withMessage(fx);
  const wrong = await fx.authorize('msg_1', { expected_session_incarnation: 'inc_other' });
  assert.deepEqual([wrong.ok, wrong.reason, wrong.error_code], [false, 'authority_changed', CODES.AUTHORITY_CHANGED]);
  const missing = await fx.authorize('msg_unknown');
  assert.deepEqual([missing.ok, missing.reason, missing.retryable], [false, 'not_found', true]);
  for (const bad of [
    { max_children: 0 }, { max_children: 11 }, { max_children: 1.5 }, { destination_project_ids: [] }, { destination_project_ids: ['a', 'a'] },
    { destination_project_ids: Array.from({ length: 9 }, (_, n) => `p${n}`) }, { destination_project_ids: [3] }, { action_id: 'nope' },
    { source_user_message_id: '' }, { source_user_message_id: 'bad id' }, { extra: true },
  ]) {
    assert.equal((await fx.authorize('msg_1', bad)).reason, 'invalid_request', JSON.stringify(bad));
  }
  assert.equal((await fx.service.authorizeLaunch({ schema_version: 1, session_id: 'sess_nope', source_user_message_id: 'msg_1', expected_session_incarnation: 'x', max_children: 1, destination_project_ids: [null], action_id: randomUUID() })).reason, 'not_found');
  assert.equal(fx.grants().length, 0);
});

test('at most twenty live grants per session; spent and expired grants do not count', async (t) => {
  const fx = createSessionFixture(t);
  for (let n = 1; n <= 20; n += 1) {
    withMessage(fx, `msg_${n}`, `turn_${n}`);
    assert.equal((await fx.authorize(`msg_${n}`)).ok, true, `grant ${n}`);
  }
  withMessage(fx, 'msg_21', 'turn_21');
  const over = await fx.authorize('msg_21');
  assert.deepEqual([over.ok, over.reason, over.error_code], [false, 'capacity', CODES.CAPACITY]);
  fx.clock.ms += HOUR + 1000;
  assert.equal((await fx.authorize('msg_21')).ok, true, 'expired grants free their slots');
  assert.equal(fx.grants().filter((grant) => grant.remaining > 0).length, 21, 'expired entries are kept until the 30-day prune');
});

test('a live user_asked call of the granted turn consumes the grant atomically into an accepted New session record', async (t) => {
  const fx = createSessionFixture(t);
  withMessage(fx);
  const { authorization_ref: ref } = await fx.authorize('msg_1');
  const done = await fx.publishSession(1, { initiation: 'user_asked' });
  assert.equal(done.ok, true, JSON.stringify(done));
  const { proposal } = done;
  assert.deepEqual([proposal.decision_state, proposal.action_state, proposal.decision.choice], ['accepted', 'queued', 'new_session']);
  assert.deepEqual(proposal.display, { title: 'Fix the build', description: null, initiation: 'user_asked', authorization_required: false });
  const record = fx.record(proposal.proposal_id);
  assert.equal(record.binding.session.launch_grant_ref, ref);
  assert.equal(record.decision.decision_id.length, 36);
  assert.deepEqual(record.decision.options, record.options);
  assert.equal(record.dispatch_key, `proposal:${record.proposal_id}:${record.decision.decision_id}:prepare:1`);
  assert.equal(fx.grants()[0].remaining, 0, 'consumed in the same mutation');
  assert.equal(fx.runtime.submits.length, 0, 'the dispatch runs after the tool call returns');
  await fx.service.idle();
  assert.equal(fx.runtime.submits.length, 1);
  assert.deepEqual(fx.runtime.submits[0].request.sessionHandoffPreparation, { proposal_id: record.proposal_id, attempt_id: record.attempt_id });
  assert.equal(fx.record(proposal.proposal_id).preparation_work_id, 'work_1');

  const replay = await fx.publishSession(1, { initiation: 'user_asked' });
  assert.equal(replay.created, false);
  assert.equal(fx.grants()[0].remaining, 0);
  const second = await fx.publishSession(2, { initiation: 'user_asked', turn: 'turn_1' });
  assert.equal(second.proposal.display.authorization_required, true, 'an exhausted grant becomes an offer');
});

test('a given authorization_ref must name the calling turn\'s own live grant', async (t) => {
  const fx = createSessionFixture(t);
  withMessage(fx, 'msg_1', 'turn_1');
  withMessage(fx, 'msg_2', 'turn_2');
  const first = await fx.authorize('msg_1');
  const second = await fx.authorize('msg_2', { action_id: randomUUID() });
  const wrongTurn = await fx.publishSession(1, { initiation: 'user_asked', authorization_ref: second.authorization_ref, turn: 'turn_1' });
  assert.equal(wrongTurn.proposal.display.authorization_required, true, 'another turn\'s grant is not spendable here');
  assert.equal(fx.grants().every((grant) => grant.remaining === 1), true);
  const named = await fx.publishSession(2, { initiation: 'user_asked', authorization_ref: first.authorization_ref, turn: 'turn_1' });
  assert.equal(named.proposal.decision_state, 'accepted');
  assert.equal(named.proposal.display.initiation, 'user_asked');
  assert.equal(fx.grants().find((grant) => grant.authorization_ref === first.authorization_ref).remaining, 0);
  assert.equal(fx.grants().find((grant) => grant.authorization_ref === second.authorization_ref).remaining, 1);
});

test('absent, expired, other-turn, other-incarnation and wrong-destination grants all become offers', async (t) => {
  const fx = createSessionFixture(t);
  withMessage(fx, 'msg_1', 'turn_1');
  await fx.authorize('msg_1');
  const otherTurn = await fx.publishSession(1, { initiation: 'user_asked', turn: 'turn_other' });
  assert.equal(otherTurn.proposal.display.authorization_required, true);
  const input = { initiation: 'user_asked', title: 'T' };
  const otherIncarnation = await fx.service.publish({
    kind: 'session', sessionId: fx.sessionId, sessionIncarnation: 'inc_not_this_one', turnId: 'turn_1', toolCallId: 'call_x',
    input: require('../services/backend/chat-proposal-session-records').normalizeSessionProposalInput(input).value,
    binding: require('./helpers/chat-proposal-session-fixture').sessionBinding(),
  });
  assert.equal(otherIncarnation.proposal.display.authorization_required, true);
  const elsewhere = await fx.publishSession(3, { initiation: 'user_asked', turn: 'turn_1', binding: { source_project_id: 'proj_2' } });
  assert.equal(elsewhere.proposal.display.authorization_required, true, 'the default destination is not in the grant');
  assert.equal(fx.grants()[0].remaining, 1, 'none of them spent it');
  fx.clock.ms += HOUR + 1;
  const expired = await fx.publishSession(4, { initiation: 'user_asked', turn: 'turn_1' });
  assert.equal(expired.proposal.display.authorization_required, true);
  assert.equal(fx.grants()[0].remaining, 1);
});

test('a grant is not spent while the handoff path is not negotiated: the request stays an offer', async (t) => {
  const fx = createSessionFixture(t);
  withMessage(fx, 'msg_1', 'turn_1');
  await fx.authorize('msg_1');
  fx.ctl.handoffSupported = false;
  const published = await fx.publishSession(1, { initiation: 'user_asked', turn: 'turn_1' });
  assert.equal(published.proposal.display.authorization_required, true);
  assert.equal(published.proposal.decision_state, 'pending');
  assert.equal(fx.grants()[0].remaining, 1);
  assert.equal(fx.runtime.submits.length, 0, 'no doomed preparation turn');
});

test('a revoked grant and a weaker source than the grant\'s restrictions are not spendable', async (t) => {
  const fx = createSessionFixture(t);
  fx.store.setSessionPreferences(fx.sessionId, { run_mode: 'plan' });
  withMessage(fx, 'msg_1', 'turn_1');
  await fx.authorize('msg_1');
  assert.deepEqual(fx.grants()[0].restrictions, { read_only: true, plan_mode: true, lockdown: false });
  const weaker = await fx.publishSession(1, { initiation: 'user_asked', turn: 'turn_1' });
  assert.equal(weaker.proposal.display.authorization_required, true, 'the source left Plan after the grant');
  const stillPlan = await fx.publishSession(2, {
    initiation: 'user_asked', turn: 'turn_1', binding: { run_mode: 'plan', restrictions: { read_only: true, plan_mode: true } },
  });
  assert.equal(stillPlan.proposal.decision_state, 'accepted');
  assert.equal(stillPlan.proposal.options.run_mode, 'plan', 'the child inherits Plan');

  const fresh = createSessionFixture(t);
  withMessage(fresh, 'msg_9', 'turn_9');
  await fresh.authorize('msg_9');
  fresh.store._updateSessionRecord(fresh.sessionId, {
    chat_proposals: { schema_version: 1, records: [], launch_grants: fresh.grants().map((grant) => ({ ...grant, revoked_at: '2026-10-15T10:00:01.000Z' })) },
  }, { bumpUpdatedAt: false });
  const revoked = await fresh.publishSession(1, { initiation: 'user_asked', turn: 'turn_9' });
  assert.equal(revoked.proposal.display.authorization_required, true);
});

test('consumption is all-or-nothing with the record: a failed flush leaves the grant and the proposals untouched', async (t) => {
  const fx = createSessionFixture(t);
  withMessage(fx);
  await fx.authorize('msg_1');
  const flush = fx.store.flushSession;
  fx.store.flushSession = () => false;
  const failed = await fx.publishSession(1, { initiation: 'user_asked' });
  fx.store.flushSession = flush;
  assert.deepEqual([failed.ok, failed.reason], [false, 'io_failed']);
  assert.equal(fx.grants()[0].remaining, 1);
  assert.equal(fx.proposalStore.read(fx.sessionId).records.length, 0);
  const retried = await fx.publishSession(1, { initiation: 'user_asked' });
  assert.equal(retried.proposal.decision_state, 'accepted');
  assert.equal(fx.grants()[0].remaining, 0);
});

test('authorization_ref is only valid with user_asked', async (t) => {
  const fx = createSessionFixture(t);
  for (const initiation of ['offer', 'own_initiative']) {
    const result = await fx.publishSession(1, { initiation, authorization_ref: randomUUID() });
    assert.equal(result.ok, false, initiation);
    assert.equal(result.input.cause_code, 'field_authorization_ref');
  }
});

test('a grant expired more than thirty days ago is pruned on the next authorize', async (t) => {
  const fx = createSessionFixture(t);
  withMessage(fx, 'msg_1', 'turn_1');
  await fx.authorize('msg_1');
  fx.clock.ms += 31 * 24 * HOUR;
  withMessage(fx, 'msg_2', 'turn_2');
  await fx.authorize('msg_2');
  assert.deepEqual(fx.grants().map((grant) => grant.source_user_message_id), ['msg_2']);
});
