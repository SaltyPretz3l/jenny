'use strict';

// new-test-file: tests/server/team-approvals.test.js is at the 600-line cap; row 175 item 11 and F9 are a new host read.
// Row 175 item 11 (receipts that last) and F9 (waiting counts known at connect), on a team host through the real router
// on the team project fixture. Receipts come from the project audit the decisions already write: the snapshot of a
// project conversation carries them, newest last, ids and host time only, to whoever may read that conversation.
// `sessions.list` rows carry the backend's pending counts per conversation. The single-owner host adds neither key.
// Audit schema 4: a receipt names its approval id and tool call id, an answered question leaves one, and a plan
// decision (D14) reaches the backend for exit_plan_mode only, its feedback kept nowhere.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { command, createFixture, createSession } = require('../helpers/command-router-fixture');
const { BOUNDED, STREAM, assertNoNames, reasonOf, setup } = require('./helpers/team-approvals-fixture');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

async function receiptsOf(s, who, sessionId) {
  const answer = await s.look(who, sessionId);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return answer.snapshot.receipts;
}

// One allowed by Carl, one declined by Alice, both in a turn Alice started.
async function decideTwo(s) {
  const first = s.openApproval(s.sP, { call: 'call_1' });
  await s.look('carl', s.sP);
  assert.equal((await s.resolve('carl', first, true)).ok, true);
  const second = s.openApproval(s.sP, { call: 'call_2', tool: 'edit_file' });
  await s.look('alice', s.sP);
  assert.equal((await s.resolve('alice', second, false)).ok, true);
}

test('receipts come back on reopen: allowed and declined, newest last, ids and host time only', BOUNDED, async (t) => {
  const s = await setup(t);
  const before = Date.now();
  await decideTwo(s);
  const first = await receiptsOf(s, 'rae', s.sP);
  assert.ok(Array.isArray(first), 'a team project snapshot carries receipts');
  assert.deepEqual(first.map(({ decided_at: at, ...rest }) => rest), [
    { seq: 1, session_id: s.sP, outcome: 'allowed', tool_name: 'write_file', approver_member_id: s.member('carl'),
      prompter_member_id: s.member('alice'), approval_id: `approval_${s.sP}_${STREAM}_call_1`, call_id: 'call_1' },
    { seq: 2, session_id: s.sP, outcome: 'declined', tool_name: 'edit_file', approver_member_id: s.member('alice'),
      prompter_member_id: s.member('alice'), approval_id: `approval_${s.sP}_${STREAM}_call_2`, call_id: 'call_2' },
  ]);
  for (const receipt of first) {
    assert.match(receipt.decided_at, ISO);
    assert.ok(Date.parse(receipt.decided_at) >= before - 1000, 'the host clock at the decision');
  }
  // A re-read (a reopen) answers the same receipts with the same times: they are host-saved, not client memory.
  assert.deepEqual(await receiptsOf(s, 'carl', s.sP), first);
  assert.deepEqual(await receiptsOf(s, 'alice', s.sP), first);
  assertNoNames(JSON.stringify(first), 'the receipts');
});

test('an expired approval leaves a receipt with no approver; a decision that did not apply leaves none', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP, { call: 'call_1' });
  s.h.backend.pendingToolApprovals.delete(approval.approvalId);
  s.h.backend.emit('chat-stream', { type: 'tool_use', sessionId: s.sP, streamId: STREAM, approvalId: approval.approvalId,
    status: 'timeout', toolName: 'write_file' });
  const stale = s.openApproval(s.sP, { call: 'call_2' });
  await s.look('carl', s.sP);
  s.h.backend.approveToolCall = () => false; // the resolve does not apply: `approval_not_applied` names the first entry
  assert.equal(reasonOf(await s.resolve('carl', stale, true)), 'decision_stale');
  assert.deepEqual(s.entries(s.P).map((entry) => entry.kind), ['approval_expired', 'approval_decided', 'approval_not_applied']);
  const receipts = await receiptsOf(s, 'alice', s.sP);
  assert.deepEqual(receipts.map(({ decided_at: _at, ...rest }) => rest), [
    { seq: 1, session_id: s.sP, outcome: 'expired', tool_name: 'write_file', approver_member_id: null,
      prompter_member_id: s.member('alice'), approval_id: approval.approvalId, call_id: 'call_1' },
  ]);
});

test('receipts are the conversation\'s own, at most 50, newest last', BOUNDED, async (t) => {
  const s = await setup(t);
  await decideTwo(s);
  assert.deepEqual(await receiptsOf(s, 'alice', s.sP2), [], 'another conversation of the project has none');
  assert.deepEqual(await receiptsOf(s, 'bob', s.sQ), [], 'another project has none');
  for (let i = 0; i < 60; i += 1) {
    assert.equal(s.h.approvals.append({ kind: 'approval_decided', project_id: s.P, session_id: s.sP,
      actor_member_id: s.member('carl'), prompter_member_id: s.member('alice'), tool_name: 'write_file',
      decision: i % 2 ? 'denied' : 'approved' }).ok, true);
  }
  const receipts = await receiptsOf(s, 'rae', s.sP);
  assert.equal(receipts.length, 50);
  assert.deepEqual([receipts[0].seq, receipts.at(-1).seq], [13, 62]);
});

test('a receipt carries its approval id and the tool call id the approval belongs to (schema 4)', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP, { call: 'call_7' });
  await s.look('carl', s.sP);
  assert.equal((await s.resolve('carl', approval, true)).ok, true);
  const [receipt] = await receiptsOf(s, 'rae', s.sP);
  assert.equal(receipt.approval_id, approval.approvalId);
  assert.equal(receipt.call_id, 'call_7');
  const [entry] = s.entries(s.P);
  assert.deepEqual([entry.approval_id, entry.call_id], [approval.approvalId, 'call_7']);
});

test('who reads receipts: owner outside, another project, pending and revoked get nothing; members and readers get them', BOUNDED, async (t) => {
  const s = await setup(t);
  await decideTwo(s);
  for (const who of ['alice', 'carl', 'rae']) assert.equal((await receiptsOf(s, who, s.sP)).length, 2, who);
  for (const [who, expected] of [['owner', 'team_not_found'], ['bob', 'team_not_found'], ['pia', 'member_pending']]) {
    const answer = await s.look(who, s.sP);
    assert.equal(reasonOf(answer), expected, who);
    assert.equal(answer.snapshot, undefined);
  }
  const revoked = await s.h.store.revokeMember({ actorMemberId: s.member('owner'), memberId: s.member('carl') });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  const auth = s.h.clients.register(s.device('carl'));
  const answer = await s.h.core.router.dispatch({ api_version: 1, operation: 'sessions.snapshot', request_id: 'request_revoked',
    client_id: auth.client_id, boot_epoch: s.h.core.bootEpoch, session_id: s.sP, params: {} },
  { deviceId: s.device('carl'), clientToken: auth.client_token, isAuthenticated: () => true,
    actor: { member_id: s.member('carl'), device_id: s.device('carl') } });
  assert.equal(reasonOf(answer), 'member_revoked');
  assert.equal(answer.snapshot, undefined);
});

// ---- Schema 4: answered questions and plan decisions --------------------------------------------------------------

const auditText = (s) => fs.readFileSync(s.h.approvals.audit().filePath, 'utf8');
const resolvePlan = (s, who, approval, approved, plan) => s.send(who, 'approval.resolve', { stream_id: STREAM,
  approval_id: approval.approvalId, decision_revision: approval.revision, approved, ...plan }, { session_id: approval.sessionId });

test('an answered question leaves an answered receipt; no question, option or answer text is in the audit file', BOUNDED, async (t) => {
  const s = await setup(t);
  s.openApproval(s.sP, { call: 'call_1' }); // the turn Alice started
  s.h.backend.pendingUserQuestions.set('question_9', { questionRef: 'question_9', sessionId: s.sP, streamId: STREAM,
    callId: 'call_q9', questions: [{ id: 'q1', prompt: 'Secret question text', options: ['Hidden option'], allow_other: true }] });
  await s.look('carl', s.sP);
  const answered = await s.send('carl', 'questions.answer', { stream_id: STREAM, question_ref: 'question_9',
    answers: [{ question_id: 'q1', answer: '', other: 'Secret answer text' }] }, { session_id: s.sP });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  const ref = s.openQuestions(s.sP, 'question_10');
  assert.equal((await s.declineQ('carl', s.sP, ref)).ok, true);
  const receipts = await receiptsOf(s, 'rae', s.sP);
  assert.deepEqual(receipts.map(({ decided_at: _at, ...rest }) => rest), [{ seq: 1, session_id: s.sP, outcome: 'answered',
    tool_name: null, approver_member_id: s.member('carl'), prompter_member_id: s.member('alice'), call_id: 'call_q9' }]);
  assert.deepEqual(s.entries(s.P).map((entry) => entry.kind), ['question_answered'], 'a declined batch writes nothing');
  const text = auditText(s);
  for (const word of ['Secret question', 'Hidden option', 'Secret answer', 'question_9', 'q1']) {
    assert.equal(text.includes(word), false, word);
  }
});

test('a plan decision reaches approveToolCall for exit_plan_mode; another tool and a deny are refused; no feedback text is kept', BOUNDED, async (t) => {
  const s = await setup(t);
  const calls = [];
  s.h.backend.approveToolCall = (key, options) => {
    calls.push([key, options]);
    return s.h.backend.pendingToolApprovals.delete(key);
  };
  const feedback = 'Secret feedback: split step two';
  const accepted = s.openApproval(s.sP, { call: 'call_p1', tool: 'exit_plan_mode' });
  const rejected = s.openApproval(s.sP, { call: 'call_p2', tool: 'exit_plan_mode' });
  const write = s.openApproval(s.sP, { call: 'call_w', tool: 'write_file' });
  await s.look('carl', s.sP);
  assert.equal((await resolvePlan(s, 'carl', accepted, true, { plan_decision: 'accepted' })).ok, true);
  assert.equal((await resolvePlan(s, 'carl', rejected, true, { plan_decision: 'rejected', feedback })).ok, true);
  assert.deepEqual(calls, [[accepted.approvalId, { decision: 'accepted' }], [rejected.approvalId, { decision: 'rejected', feedback }]]);
  assert.equal(reasonOf(await resolvePlan(s, 'carl', write, true, { plan_decision: 'accepted' })), 'plan_decision_invalid');
  const third = s.openApproval(s.sP, { call: 'call_p3', tool: 'exit_plan_mode' });
  assert.equal(reasonOf(await resolvePlan(s, 'carl', third, false, { plan_decision: 'rejected', feedback })), 'plan_decision_invalid');
  assert.equal(reasonOf(await resolvePlan(s, 'carl', third, true, { feedback })), 'plan_decision_invalid', 'feedback needs a decision');
  assert.equal(calls.length, 2, 'a refused plan decision applies nothing');
  assert.deepEqual(s.entries(s.P).map((entry) => [entry.decision, entry.plan_decision, entry.call_id]),
    [['approved', 'accepted', 'call_p1'], ['approved', 'rejected', 'call_p2']], 'a refusal writes nothing');
  assert.equal(auditText(s).includes('Secret feedback'), false, 'the audit holds no feedback');
  assert.equal(s.h.logText().includes('Secret feedback'), false, 'no log line holds it');
  for (const [who, expected] of [['rae', 'role_forbidden'], ['pia', 'member_pending'], ['bob', 'team_not_found'],
    ['owner', 'team_not_found']]) {
    await s.look(who, s.sP);
    assert.equal(reasonOf(await resolvePlan(s, who, third, true, { plan_decision: 'approved' })), expected, who);
  }
  assert.equal(calls.length, 2);
});

// ---- F9: waiting counts in sessions.list -------------------------------------------------------------------------

test('sessions.list rows carry the pending approvals and questions of each conversation, for every reader', BOUNDED, async (t) => {
  const s = await setup(t);
  s.openApproval(s.sP, { call: 'call_1' });
  s.openApproval(s.sP, { call: 'call_2' });
  s.openQuestions(s.sP);
  for (const who of ['alice', 'carl', 'rae']) {
    const listed = await s.send(who, 'sessions.list', {});
    assert.equal(listed.ok, true);
    const byId = Object.fromEntries(listed.sessions.map((row) => [row.session_id, row.waiting]));
    assert.deepEqual(byId[s.sP], { approvals: 2, questions: 1 }, who);
    assert.deepEqual(byId[s.sP2], { approvals: 0, questions: 0 }, who);
    assert.equal(byId[s.sQ], undefined, `${who} does not see another project's row`);
  }
  const bob = await s.send('bob', 'sessions.list', {});
  assert.deepEqual(bob.sessions.map((row) => [row.session_id, row.waiting]), [[s.sQ, { approvals: 0, questions: 0 }]]);
  assert.equal(reasonOf(await s.send('pia', 'sessions.list', {})), 'member_pending');
});

test('the waiting counts are capped at 64', BOUNDED, async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 70; i += 1) s.openApproval(s.sP, { call: `call_${i}` });
  const listed = await s.send('alice', 'sessions.list', {});
  assert.deepEqual(listed.sessions.find((row) => row.session_id === s.sP).waiting, { approvals: 64, questions: 0 });
});

test('the single-owner host adds no waiting counts and no receipts', BOUNDED, async (t) => {
  const fx = createFixture();
  t.after(() => fx.close());
  const sessionId = await createSession(fx);
  fx.backend.pendingToolApprovals.set('approval_x', { approvalId: 'approval_x', sessionId, streamId: STREAM, callId: 'c' });
  const listed = await fx.router.dispatch(command(fx.a, 'sessions.list', {}), fx.contextA);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.ok(listed.sessions.length >= 1);
  assert.equal(listed.sessions.every((row) => !Object.hasOwn(row, 'waiting')), true);
  const snapshot = await fx.router.dispatch(command(fx.a, 'sessions.snapshot', {}, { session_id: sessionId }), fx.contextA);
  assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
  assert.equal(Object.hasOwn(snapshot.snapshot, 'receipts'), false);
});
