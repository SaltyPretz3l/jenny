'use strict';

/* Launch grants (row 59 checkpoint 5a-1, D7): authorizeLaunch idempotency, conflict, capacity and
 * its refusals, and the atomic consumption of one grant by a live propose_session(user_asked)
 * call of the same turn. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const { PROPOSAL_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { normalizeLaunchGrant } = require('../services/backend/session-coordination-records');
const { isLiveGrant } = require('../services/chat-proposal-launch-grants');
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

// ---------- standing launch permission (row 76, S4) ----------

const PERMISSION_ID = `lp_${'a'.repeat(32)}`;

function permissionFixture(t, { cap = 1, permission = true, serviceOptions = {} } = {}) {
  const calls = [];
  const fx = createSessionFixture(t, {
    serviceOptions: {
      matchLaunchPermission: (args) => {
        calls.push(args);
        return permission ? { permission_id: PERMISSION_ID, max_children_per_turn: cap } : null;
      },
      ...serviceOptions,
    },
  });
  fx.matchCalls = calls;
  return fx;
}

test('a standing permission mints a valid spent v1 grant and accepts the record in the same mutation', async (t) => {
  const fx = permissionFixture(t);
  const done = await fx.publishSession(1, { initiation: 'user_asked' });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.deepEqual([done.proposal.decision_state, done.proposal.action_state, done.proposal.decision.choice], ['accepted', 'queued', 'new_session']);
  assert.deepEqual(done.proposal.display, { title: 'Fix the build', description: null, initiation: 'user_asked', authorization_required: false });
  const [grant] = fx.grants();
  assert.notEqual(normalizeLaunchGrant(grant), null, 'the stored entry is a valid v1 grant');
  assert.deepEqual(
    [grant.remaining, grant.max_children, grant.source_user_message_id, grant.source_turn_id, grant.destination_project_ids, grant.revoked_at, grant.source_session_incarnation],
    [0, 1, `standing.${PERMISSION_ID}`, 'turn_1', ['proj_1'], null, fx.sessionIncarnation],
  );
  assert.equal(Date.parse(grant.expires_at) - Date.parse(grant.created_at), HOUR);
  assert.equal(isLiveGrant(grant, new Date(fx.clock.ms)), false, 'a minted grant is spent: never live');
  assert.equal(fx.record(done.proposal.proposal_id).binding.session.launch_grant_ref, grant.authorization_ref);
  assert.deepEqual(fx.matchCalls, [{ sessionId: fx.sessionId, destinationProjectId: 'proj_1', runMode: 'ask' }]);
  assert.equal(fx.runtime.submits.length, 0, 'the dispatch runs after the call returns');
  await fx.service.idle();
  assert.equal(fx.runtime.submits.length, 1);
});

test('a wake turn never mints: a message from another chat grants no launch, and a throwing port fails closed', async (t) => {
  const fx = permissionFixture(t, { serviceOptions: { isWakeTurn: (_sessionId, turnId) => turnId === 'turn_1' } });
  const woken = await fx.publishSession(1, { initiation: 'user_asked', turn: 'turn_1' });
  assert.deepEqual([woken.proposal.decision_state, woken.proposal.display.authorization_required], ['pending', true]);
  assert.equal(fx.grants().length, 0);
  assert.deepEqual(fx.matchCalls, [], 'the permission is not consulted in a wake turn');
  assert.equal((await fx.publishSession(2, { initiation: 'user_asked', turn: 'turn_2' })).proposal.decision_state, 'accepted');
  const throwing = permissionFixture(t, { serviceOptions: { isWakeTurn: () => { throw new Error('boom'); } } });
  assert.equal((await throwing.publishSession(1, { initiation: 'user_asked' })).proposal.decision_state, 'pending');
  assert.deepEqual(throwing.matchCalls, []);
});

test('minted audit rows are capped at 32: the oldest standing rows drop first, newest kept', async (t) => {
  const fx = permissionFixture(t, { cap: 1 });
  assert.equal((await fx.publishSession(1, { initiation: 'user_asked', turn: 'turn_1' })).proposal.decision_state, 'accepted');
  const [first] = fx.grants();
  // 31 older audit rows of earlier turns (the unresolved-proposal cap of 20 keeps a live loop from minting that many).
  const older = Array.from({ length: 31 }, (_, index) => {
    const created = new Date(Date.parse(first.created_at) - (32 - index) * 60_000).toISOString();
    return {
      ...first, authorization_ref: randomUUID(), action_id: randomUUID(), source_turn_id: `turn_old_${index + 1}`,
      created_at: created, expires_at: new Date(Date.parse(created) + HOUR).toISOString(),
    };
  });
  assert.equal(fx.proposalStore.mutate(fx.sessionId, ({ records }) => ({ records, launch_grants: [...older, first] })).ok, true);
  assert.equal(fx.grants().length, 32);
  assert.equal((await fx.publishSession(2, { initiation: 'user_asked', turn: 'turn_2' })).proposal.decision_state, 'accepted');
  const turns = fx.grants().map((grant) => grant.source_turn_id);
  assert.equal(turns.length, 32);
  assert.deepEqual([turns[0], turns.at(-2), turns.at(-1)], ['turn_old_2', 'turn_1', 'turn_2'], 'the oldest standing row dropped');
});

test('a standing permission is capped per turn; the next turn mints again', async (t) => {
  const fx = permissionFixture(t, { cap: 1 });
  assert.equal((await fx.publishSession(1, { initiation: 'user_asked', turn: 'turn_1' })).proposal.decision_state, 'accepted');
  const over = await fx.publishSession(2, { initiation: 'user_asked', turn: 'turn_1' });
  assert.deepEqual([over.proposal.decision_state, over.proposal.display.authorization_required], ['pending', true]);
  assert.equal(fx.grants().length, 1);
  const next = await fx.publishSession(3, { initiation: 'user_asked', turn: 'turn_2' });
  assert.equal(next.proposal.decision_state, 'accepted');
  assert.deepEqual(fx.grants().map((grant) => grant.source_turn_id), ['turn_1', 'turn_2']);
  const capThree = permissionFixture(t, { cap: 3 });
  for (let n = 1; n <= 3; n += 1) {
    assert.equal((await capThree.publishSession(n, { initiation: 'user_asked', turn: 'turn_1' })).proposal.decision_state, 'accepted', `child ${n}`);
  }
  assert.equal((await capThree.publishSession(4, { initiation: 'user_asked', turn: 'turn_1' })).proposal.decision_state, 'pending');
  assert.equal(capThree.grants().length, 3);
});

test('a turn grant is preferred over a standing permission; nothing is minted', async (t) => {
  const fx = permissionFixture(t);
  withMessage(fx);
  const { authorization_ref: ref } = await fx.authorize('msg_1');
  const done = await fx.publishSession(1, { initiation: 'user_asked' });
  assert.equal(done.proposal.decision_state, 'accepted');
  assert.equal(fx.grants().length, 1);
  assert.equal(fx.grants()[0].remaining, 0);
  assert.equal(fx.record(done.proposal.proposal_id).binding.session.launch_grant_ref, ref);
  assert.equal(fx.matchCalls.length, 0, 'the permission is not consulted when a turn grant matched');
});

test('without a permission a user_asked request stays an offer that needs authorization', async (t) => {
  const fx = permissionFixture(t, { permission: false });
  const done = await fx.publishSession(1, { initiation: 'user_asked' });
  assert.deepEqual([done.proposal.decision_state, done.proposal.display.authorization_required], ['pending', true]);
  assert.equal(fx.grants().length, 0);
  const plain = createSessionFixture(t);
  assert.equal((await plain.publishSession(1, { initiation: 'user_asked' })).proposal.display.authorization_required, true);
});

test('a permission is never consulted for offers, suggestions, an unnegotiated handoff or an explicit authorization_ref', async (t) => {
  const fx = permissionFixture(t);
  assert.equal((await fx.publishSession(1, { initiation: 'offer' })).proposal.decision_state, 'pending');
  assert.equal((await fx.publishSession(2, { initiation: 'own_initiative' })).proposal.decision_state, 'pending');
  assert.equal(fx.matchCalls.length, 0);
  const named = await fx.publishSession(3, { initiation: 'user_asked', authorization_ref: randomUUID() });
  assert.equal(named.proposal.display.authorization_required, true, 'a ref names a turn grant only');
  fx.ctl.handoffSupported = false;
  assert.equal((await fx.publishSession(4, { initiation: 'user_asked', turn: 'turn_9' })).proposal.display.authorization_required, true);
  assert.equal(fx.matchCalls.length, 0);
  assert.equal(fx.grants().length, 0);
});

test('project_id is honored only when the port allows a project choice and the project exists', async (t) => {
  const honored = permissionFixture(t, { serviceOptions: { allowsProjectChoice: () => true, projectExists: (id) => id === 'proj_2' } });
  const offer = await honored.publishSession(1, { initiation: 'offer', project_id: 'proj_2' });
  assert.equal(offer.proposal.options.destination_project_id, 'proj_2');
  const asked = await honored.publishSession(2, { initiation: 'user_asked', project_id: 'proj_2' });
  assert.equal(asked.proposal.options.destination_project_id, 'proj_2');
  assert.deepEqual(honored.matchCalls[0], { sessionId: honored.sessionId, destinationProjectId: 'proj_2', runMode: 'ask' });
  assert.deepEqual(honored.grants()[0].destination_project_ids, ['proj_2']);
  const unknown = await honored.publishSession(3, { initiation: 'offer', project_id: 'proj_3' });
  assert.equal(unknown.proposal.options.destination_project_id, 'proj_1', 'an unknown project falls back to the source project');

  const refused = permissionFixture(t, { serviceOptions: { allowsProjectChoice: () => false, projectExists: () => true } });
  const ignored = await refused.publishSession(1, { initiation: 'offer', project_id: 'proj_2' });
  assert.equal(ignored.proposal.options.destination_project_id, 'proj_1');
  const askedIgnored = await refused.publishSession(2, { initiation: 'user_asked', project_id: 'proj_2' });
  assert.deepEqual(refused.matchCalls[0], { sessionId: refused.sessionId, destinationProjectId: 'proj_1', runMode: 'ask' });
  assert.equal(askedIgnored.proposal.options.destination_project_id, 'proj_1');
});
