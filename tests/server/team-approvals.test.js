'use strict';

// Slice 3-6b: approvals on a team host, through the real router on the team project fixture. Any writer
// of the project who is viewing the conversation answers (no lease); one answer wins; the prompter is
// named on the snapshot and on decision_changed; every approval decision is audited before it applies.
// The single-owner host keeps its lease rule, adds no key and writes no audit file. The review round's
// rules follow: an entry only for an answer that can still apply, the check inside the queue, each branch
// of the audited resolve, the drops take nothing beyond what they name, the shared limit.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { BackendEvents } = require('../../server/backend-events');
const { createDecisionHandlers } = require('../../server/command-router-decisions');
const { ProjectAudit, PROJECT_AUDIT_FILE } = require('../../server/team/project-audit');
const { VIEW_LIMIT } = require('../../server/team/team-approvals');
const { createFixture, command, createSession } = require('../helpers/command-router-fixture');
const { dataFrames } = require('./helpers/session-scope-fixture');
const {
  BOUNDED, STREAM, assertNoNames, frames, reasonOf, setup,
} = require('./helpers/team-approvals-fixture');

// ---- Who decides ----------------------------------------------------------------

test('a viewing writer answers without a lease; the lease holder who is not viewing and a viewing reader are refused', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP);
  const ref = s.openQuestions(s.sP);
  await s.h.ok(s.send('alice', 'control.acquire', {}, { session_id: s.sP }), 'alice takes the lease');
  assert.equal(reasonOf(await s.resolve('alice', approval)), 'approval_not_viewing', 'the holder is not viewing');
  assert.equal(reasonOf(await s.answerQ('alice', s.sP, ref)), 'approval_not_viewing', 'nor for a question');
  assert.equal(reasonOf(await s.declineQ('alice', s.sP, ref)), 'approval_not_viewing');
  await s.look('rae', s.sP);
  assert.equal(reasonOf(await s.resolve('rae', approval)), 'role_forbidden', 'a reader is refused as before');
  await s.look('carl', s.sP);
  const answered = await s.resolve('carl', approval, true, { control_generation: 999, expected_revision: 'stale' });
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.deepEqual(s.decided, [[approval.approvalId, 'approved']]);
  const [entry] = s.entries(s.P);
  assert.deepEqual({ ...entry, at: 0 }, { seq: 1, at: 0, kind: 'approval_decided', project_id: s.P, session_id: s.sP, board_id: null,
    actor_member_id: s.member('carl'), prompter_member_id: s.member('alice'), tool_name: 'write_file',
    decision: 'approved', detail: null });
});

test('pending, removed, other-project and actor-less callers get the identity answers, for questions too', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP);
  const ref = s.openQuestions(s.sP);
  await s.look('carl', s.sP);
  await s.h.ok(s.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('carl') }));
  const auth = s.h.clients.register(s.device('alice'));
  let n = 0;
  const noActor = (operation, params) => s.h.core.router.dispatch({ api_version: 1, operation, request_id: `request_none${n += 1}`,
    client_id: auth.client_id, boot_epoch: s.h.core.bootEpoch, session_id: s.sP, params },
  { deviceId: s.device('alice'), clientToken: auth.client_token, isAuthenticated: () => true });
  for (const [who, expected] of [['pia', 'member_pending'], ['carl', 'team_not_found'], ['bob', 'team_not_found'],
    ['owner', 'team_not_found']]) {
    assert.equal(reasonOf(await s.resolve(who, approval)), expected, `${who} approval`);
    assert.equal(reasonOf(await s.answerQ(who, s.sP, ref)), expected, `${who} answer`);
    assert.equal(reasonOf(await s.declineQ(who, s.sP, ref)), expected, `${who} decline`);
  }
  await s.look('alice', s.sP);
  assert.equal(reasonOf(await noActor('approval.resolve', { stream_id: STREAM, approval_id: approval.approvalId,
    decision_revision: approval.revision, approved: true })), 'role_forbidden');
  assert.equal(reasonOf(await noActor('questions.answer', { stream_id: STREAM, question_ref: ref,
    answers: [{ question_id: 'q1', answer: 'a' }] })), 'role_forbidden');
  assert.equal(reasonOf(await noActor('questions.decline', { stream_id: STREAM, question_ref: ref })), 'role_forbidden');
  assert.deepEqual(s.decided, []);
  assert.deepEqual(s.entries(s.P), []);
});

test('questions follow the rule: not viewing is refused, a viewing writer answers and nothing is audited', BOUNDED, async (t) => {
  const s = await setup(t);
  const ref = s.openQuestions(s.sP);
  assert.equal(reasonOf(await s.answerQ('carl', s.sP, ref)), 'approval_not_viewing');
  assert.equal(reasonOf(await s.declineQ('carl', s.sP, ref)), 'approval_not_viewing');
  await s.look('rae', s.sP);
  assert.equal(reasonOf(await s.answerQ('rae', s.sP, ref)), 'role_forbidden');
  await s.look('carl', s.sP);
  const events = s.h.attach('rae');
  assert.equal((await s.answerQ('carl', s.sP, ref)).ok, true);
  assert.equal(reasonOf(await s.declineQ('carl', s.sP, ref)), 'question_batch_stale');
  assert.deepEqual(s.decided, [[ref, 'answered']]);
  assert.deepEqual(frames(events, 'decision_changed').map((f) => f.prompter_member_id), [s.member('alice')]);
  assert.deepEqual(s.entries(s.P), []);
});

// ---- One answer wins, audit first ----------------------------------------------------

test('two writers answer at once: one is applied, the other is stale, and only the applied one is audited', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP);
  await s.look('alice', s.sP);
  await s.look('carl', s.sP);
  const [first, second] = await Promise.all([s.resolve('carl', approval, true), s.resolve('alice', approval, false)]);
  assert.equal(first.ok, true);
  assert.equal(reasonOf(second), 'decision_stale');
  assert.deepEqual(s.decided, [[approval.approvalId, 'approved']]);
  // The loser's answer could no longer apply, so it writes nothing (fix round: the loser's entry was withdrawn).
  const log = s.entries(s.P).map(({ seq, kind, actor_member_id: actor, decision, detail }) => ({ seq, kind, actor, decision, detail }));
  assert.deepEqual(log, [{ seq: 1, kind: 'approval_decided', actor: s.member('carl'), decision: 'approved', detail: null }]);
});

test('audit first: a failing append refuses, the approval stays pending and is answered once the log works', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP);
  await s.look('carl', s.sP);
  const audit = s.h.approvals.audit();
  audit.append = () => ({ ok: false, error: { reason: 'team_audit_unavailable' } });
  const refused = await s.resolve('carl', approval);
  assert.equal(refused.error.reason, 'team_audit_unavailable');
  assert.equal(refused.error.code, 'CMP-HOST-0005');
  assert.equal(s.h.backend.pendingToolApprovals.has(approval.approvalId), true);
  delete audit.append;
  assert.equal((await s.resolve('carl', approval)).ok, true);
  assert.deepEqual(s.entries(s.P).map((entry) => entry.kind), ['approval_decided']);
});

test('a log that cannot be opened: the host serves, every approval and the audit read answer unavailable', BOUNDED, async (t) => {
  const s = await setup(t, { createAudit: (options) => {
    fs.writeFileSync(options.filePath, JSON.stringify({ schema_version: 99, floor_seq: 0, next_seq: 1, entries: [] }));
    return new ProjectAudit(options);
  } });
  assert.equal(s.h.fx.logs.filter((line) => line.event === 'team_project_audit.unavailable').length, 1);
  const approval = s.openApproval(s.sP);
  await s.look('carl', s.sP);
  assert.equal(reasonOf(await s.resolve('carl', approval)), 'team_audit_unavailable');
  assert.equal(reasonOf(await s.send('alice', 'team.project.audit.read', { project_id: s.P })), 'team_audit_unavailable');
});

test('after a crash between the audit and the resolve the entry stays as written and nothing is invented', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP);
  await s.look('carl', s.sP);
  const livePath = s.h.approvals.audit().filePath;
  let atCrash = null;
  // The host dies inside the resolve: what is on disk at that moment is all a restart finds.
  s.h.backend.approveToolCall = () => { atCrash = fs.readFileSync(livePath); return true; };
  assert.equal((await s.resolve('carl', approval)).ok, true);
  const restartPath = path.join(path.dirname(livePath), 'restart-project-audit.json');
  fs.writeFileSync(restartPath, atCrash);
  const reopened = new ProjectAudit({ filePath: restartPath });
  assert.deepEqual(reopened.openAtStart(), { setAside: false, keptName: null });
  assert.deepEqual(reopened.read({ projectId: s.P }).entries.map((entry) => [entry.kind, entry.decision]),
    [['approval_decided', 'approved']], 'the entry stays as written; no follow-up is invented');
  assert.equal(reopened.floorSeq(), 1);
  // A restart holds no waiter (a failed turn is never replayed): the same answer again applies nothing.
  s.h.backend.pendingToolApprovals.clear();
  assert.equal(reasonOf(await s.resolve('carl', approval)), 'decision_stale');
  assert.equal(s.entries(s.P).length, 1, 'nothing applied late, nothing written');
});

// ---- Forged ids ---------------------------------------------------------------------

test('a forged approval id and a conversation of another project change nothing and make no viewer record', BOUNDED, async (t) => {
  const s = await setup(t);
  const theirs = s.openApproval(s.sQ, { starter: s.member('bob') });
  for (const viewingOwn of [false, true]) {
    if (viewingOwn) await s.look('carl', s.sP);
    assert.equal(s.viewing('carl', s.sP), viewingOwn);
    // Their approval id in Carl's own conversation, and their conversation id.
    const forged = await s.resolve('carl', { ...theirs, sessionId: s.sP });
    assert.equal(reasonOf(forged), viewingOwn ? 'decision_stale' : 'approval_not_viewing');
    assert.equal(reasonOf(await s.look('carl', s.sQ)), 'team_not_found');
    assert.equal(reasonOf(await s.resolve('carl', theirs)), 'team_not_found');
    assert.equal(reasonOf(await s.send('carl', 'session.view', {}, { session_id: s.sQ })), 'team_not_found');
  }
  assert.equal(s.viewing('carl', s.sQ), false);
  assert.equal(s.h.backend.pendingToolApprovals.has(theirs.approvalId), true);
  assert.deepEqual(s.entries(s.Q), []);
  assert.deepEqual(s.entries(s.P), []);
});

// ---- Viewing ------------------------------------------------------------------------

test('viewing: the snapshot sets it, session.view keeps it, without the heartbeat it lapses', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP);
  await s.look('carl', s.sP);
  s.advance(30_000);
  assert.deepEqual(await s.send('carl', 'session.view', {}, { session_id: s.sP }),
    { ok: true, viewing: true, viewers: [s.member('carl')] });
  s.advance(30_000);
  assert.equal(s.viewing('carl', s.sP), true, 'kept past 45 s by the heartbeat');
  s.advance(46_000);
  assert.equal(reasonOf(await s.resolve('carl', approval)), 'approval_not_viewing', 'lapsed without it');
  assert.equal(reasonOf(await s.send('rae', 'session.view', {}, { session_id: 'sess_1_missingmissing' })), 'team_not_found');
});

test('removal during an awaited approval: the removed member is refused, another viewing writer answers', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP);
  await s.look('carl', s.sP);
  await s.look('alice', s.sP);
  await s.h.ok(s.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('carl') }));
  assert.equal(reasonOf(await s.resolve('carl', approval)), 'team_not_found');
  assert.equal((await s.resolve('alice', approval, false)).ok, true);
  assert.deepEqual(s.decided, [[approval.approvalId, 'denied']]);
});

// ---- Prompter, expiry, unattended ------------------------------------------------------

test('the prompter is on the snapshot and on decision_changed, live and replayed, to the project only', BOUNDED, async (t) => {
  const s = await setup(t);
  const cursor = s.h.core.events.cursor;
  const rae = s.h.attach('rae');
  const bob = s.h.attach('bob');
  const approval = s.openApproval(s.sP);
  s.openQuestions(s.sP);
  const snap = await s.look('carl', s.sP);
  assert.equal(snap.snapshot.pending_approvals[0].prompter_member_id, s.member('alice'));
  assert.equal(snap.snapshot.pending_questions[0].prompter_member_id, s.member('alice'));
  await s.resolve('carl', approval);
  const second = s.openApproval(s.sP, { call: 'call_2' });
  s.h.backend.emit('chat-stream', { type: 'tool_approval_withdrawn', sessionId: s.sP, streamId: STREAM, approvalId: second.approvalId });
  const live = frames(rae, 'decision_changed').map((f) => [f.approval_id, f.prompter_member_id]);
  assert.deepEqual(live, [[approval.approvalId, s.member('alice')], [second.approvalId, s.member('alice')]]);
  const replay = frames(s.h.attach('rae', { cursor }), 'decision_changed').map((f) => f.prompter_member_id);
  assert.deepEqual(replay, [s.member('alice'), s.member('alice')]);
  assert.deepEqual(frames(bob, 'decision_changed'), []);
  assert.deepEqual(frames(s.h.attach('bob', { cursor }), 'decision_changed'), []);
});

test('a turn with no member author: the snapshot shows null, the answer is refused and nothing is written', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP, { starter: null });
  const snap = await s.look('carl', s.sP);
  assert.equal(snap.snapshot.pending_approvals[0].prompter_member_id, null);
  const refused = await s.resolve('carl', approval);
  assert.deepEqual([refused.error.code, refused.error.reason], ['CMP-HOST-0004', 'approval_prompter_unknown']);
  s.h.backend.emit('chat-stream', { type: 'tool_use', sessionId: s.sP, streamId: STREAM, approvalId: approval.approvalId,
    toolName: 'write_file', status: 'timeout' });
  assert.deepEqual(s.decided, []);
  assert.deepEqual(s.entries(s.P), []);
  assert.equal(s.h.fx.logs.filter((line) => line.event === 'team_approval.expired_unrecorded').length, 1);
});

test('a timeout writes approval_expired with the prompter and no approver', BOUNDED, async (t) => {
  let now = 1_700_000_000_000;
  const s = await setup(t, { clock: () => now });
  const approval = s.openApproval(s.sP);
  now += 600_000;
  s.h.backend.pendingToolApprovals.delete(approval.approvalId);
  s.h.backend.emit('chat-stream', { type: 'tool_use', sessionId: s.sP, streamId: STREAM, approvalId: approval.approvalId,
    toolName: 'write_file', status: 'timeout' });
  assert.deepEqual(s.entries(s.P), [{ seq: 1, at: now, kind: 'approval_expired', project_id: s.P, session_id: s.sP, board_id: null,
    actor_member_id: null, prompter_member_id: s.member('alice'), tool_name: 'write_file', decision: null, detail: null }]);
});

test('an approval with no writer viewing publishes one approval_unattended; with a writer viewing, none', BOUNDED, async (t) => {
  const s = await setup(t);
  const rae = s.h.attach('rae');
  const bob = s.h.attach('bob');
  await s.look('rae', s.sP); // a reader viewing does not count
  const first = s.openApproval(s.sP);
  s.h.backend.emit('chat-stream', { type: 'tool_approval_needed', sessionId: s.sP, streamId: STREAM,
    approvalId: first.approvalId, callId: 'call_1', toolName: 'write_file' }); // the same approval again: nothing
  const second = s.openApproval(s.sP, { call: 'call_2' });
  await s.look('carl', s.sP);
  s.openApproval(s.sP, { call: 'call_3' });
  const sent = frames(rae, 'approval_unattended');
  assert.deepEqual(sent.map((f) => [f.approval_id, f.prompter_member_id]),
    [[first.approvalId, s.member('alice')], [second.approvalId, s.member('alice')]]);
  // The payload is exactly its four ids; the rest is the frame's own envelope.
  assert.deepEqual(Object.keys(sent[0]).sort(), ['api_version', 'approval_id', 'boot_epoch', 'cursor', 'event_type',
    'prompter_member_id', 'session_id', 'stream_id']);
  assert.deepEqual([sent[0].session_id, sent[0].stream_id], [s.sP, STREAM]);
  assert.deepEqual(frames(bob, 'approval_unattended'), []);
});

// ---- The audit read ---------------------------------------------------------------------

test('team.project.audit.read: a project admin reads that project only; everyone else is refused', BOUNDED, async (t) => {
  const s = await setup(t, { createAudit: (options) => new ProjectAudit({ ...options, maxEntries: 3 }) });
  for (const [sessionId, call, who] of [[s.sP, 'c1', 'carl'], [s.sQ, 'c2', 'bob'], [s.sP, 'c3', 'carl'], [s.sP, 'c4', 'carl']]) {
    const approval = s.openApproval(sessionId, { call, starter: s.member(sessionId === s.sQ ? 'bob' : 'alice') });
    await s.look(who, sessionId);
    assert.equal((await s.resolve(who, approval)).ok, true);
  }
  const page = await s.send('alice', 'team.project.audit.read', { project_id: s.P });
  // The bound (3 entries) dropped seq 1: floor_seq is the lowest seq still held.
  assert.deepEqual([page.floor_seq, page.entries.map((entry) => entry.seq), page.next_cursor], [2, [3, 4], null]);
  const after = await s.send('alice', 'team.project.audit.read', { project_id: s.P, after_seq: 3, limit: 1 });
  assert.deepEqual(after.entries.map((entry) => entry.seq), [4]);
  const limited = await s.send('alice', 'team.project.audit.read', { project_id: s.P, limit: 1 });
  assert.deepEqual([limited.entries.map((entry) => entry.seq), limited.next_cursor], [[3], 3]);
  assert.deepEqual((await s.send('bob', 'team.project.audit.read', { project_id: s.Q })).entries.map((e) => e.project_id), [s.Q]);
  for (const [who, expected] of [['carl', 'role_forbidden'], ['rae', 'role_forbidden'], ['owner', 'team_not_found'],
    ['bob', 'team_not_found']]) {
    assert.equal(reasonOf(await s.send(who, 'team.project.audit.read', { project_id: s.P })), expected, who);
  }
});

// ---- Redaction --------------------------------------------------------------------------

test('answers, events, log lines and the audit file carry no prompt, argument, path, title or name', BOUNDED, async (t) => {
  const s = await setup(t);
  const events = s.h.attach('alice');
  const approval = s.openApproval(s.sP);
  await s.look('carl', s.sP);
  s.answers.length = 0; // snapshots carry the title by design; the decision paths below must not
  await s.resolve('carl', approval);
  await s.resolve('alice', approval);
  const ref = s.openQuestions(s.sP);
  await s.answerQ('carl', s.sP, ref);
  const expiring = s.openApproval(s.sP, { call: 'call_x' });
  s.h.backend.emit('chat-stream', { type: 'tool_use', sessionId: s.sP, streamId: STREAM, approvalId: expiring.approvalId,
    toolName: 'write_file', status: 'timeout' });
  await s.send('alice', 'team.project.audit.read', { project_id: s.P });
  await s.send('carl', 'session.view', {}, { session_id: s.sP });
  assertNoNames(JSON.stringify(s.answers), 'answers');
  assertNoNames(JSON.stringify(dataFrames(events.frames).filter((f) => f.event_type !== 'team_project_changed')), 'events');
  assertNoNames(s.h.logText(), 'logs');
  assertNoNames(fs.readFileSync(s.h.approvals.audit().filePath, 'utf8'), 'audit file');
});

// ---- Single-owner parity ------------------------------------------------------------------

test('single-owner host: the lease rule answers as before, no new key, no viewing, no audit file', BOUNDED, async (t) => {
  const f = createFixture(); t.after(() => f.close());
  const sessionId = await createSession(f);
  const approvalId = 'approval_single';
  f.backend.pendingToolApprovals.set(approvalId, { approvalId, sessionId, streamId: STREAM, callId: 'call', toolName: 'write_file' });
  f.backend.approveToolCall = (key) => f.backend.pendingToolApprovals.delete(key);
  const snap = f.router.snapshot(sessionId);
  assert.deepEqual(Object.keys(snap.pending_approvals[0]).sort(), ['approval_id', 'call_id', 'decision_revision', 'stream_id',
    'summary', 'tool_name']);
  const params = { stream_id: STREAM, approval_id: approvalId, decision_revision: snap.pending_approvals[0].decision_revision,
    approved: true };
  const noLease = await f.router.dispatch(command(f.a, 'approval.resolve', params, { session_id: sessionId }), f.contextA);
  assert.deepEqual(noLease.error, { code: 'CMP-HOST-0003', reason: 'control_generation_required', retryable: false,
    request_id: noLease.error.request_id });
  const lease = (await f.router.dispatch(command(f.a, 'control.acquire', {}, { session_id: sessionId }), f.contextA)).lease;
  const done = await f.router.dispatch(command(f.a, 'approval.resolve', params, { session_id: sessionId,
    control_generation: lease.generation, expected_revision: snap.session.revision }), f.contextA);
  assert.deepEqual(Object.keys(done).sort(), ['approval_id', 'approved', 'ok', 'revision']);
  assert.deepEqual(f.eventStream.events.find(({ type }) => type === 'decision_changed').payload,
    { session_id: sessionId, stream_id: STREAM, approval_id: approvalId });
  f.backend.pendingUserQuestions.set('question_single', { questionRef: 'question_single', sessionId, streamId: STREAM,
    callId: 'call_q', questions: [{ id: 'q1', prompt: 'Pick', options: ['a'] }] });
  f.backend.answerUserQuestions = (key) => f.backend.pendingUserQuestions.delete(key);
  const qParams = { stream_id: STREAM, question_ref: 'question_single' };
  for (const [operation, params] of [['questions.answer', { ...qParams, answers: [{ question_id: 'q1', answer: 'a' }] }],
    ['questions.decline', qParams]]) {
    const bare = await f.router.dispatch(command(f.a, operation, params, { session_id: sessionId }), f.contextA);
    assert.deepEqual(bare.error, { code: 'CMP-HOST-0003', reason: 'control_generation_required', retryable: false,
      request_id: bare.error.request_id }, operation);
  }
  const answered = await f.router.dispatch(command(f.a, 'questions.answer', { ...qParams,
    answers: [{ question_id: 'q1', answer: 'a' }] }, { session_id: sessionId, control_generation: lease.generation,
    expected_revision: f.router.snapshot(sessionId).session.revision }), f.contextA);
  assert.deepEqual(Object.keys(answered).sort(), ['answered', 'ok', 'question_ref', 'revision']);
  assert.deepEqual(f.eventStream.events.filter(({ type }) => type === 'decision_changed').map(({ payload }) => payload),
    [{ session_id: sessionId, stream_id: STREAM, approval_id: approvalId },
      { session_id: sessionId, stream_id: STREAM, question_ref: 'question_single' }]);
  // BackendEvents' withdrawal on the single-owner host gains no key.
  const backendEvents = new BackendEvents({ backend: f.backend, bootEpoch: 'boot_single' });
  const withdrawals = [];
  backendEvents.events.publish = (type, payload) => withdrawals.push([type, payload]);
  f.backend.emit('chat-stream', { type: 'tool_approval_withdrawn', sessionId, streamId: STREAM, approvalId });
  backendEvents.dispose();
  assert.deepEqual(withdrawals, [['decision_changed', { session_id: sessionId, stream_id: STREAM, approval_id: approvalId }]]);
  const view = await f.router.dispatch(command(f.a, 'session.view', {}, { session_id: sessionId }), f.contextA);
  assert.equal(view.error.reason, 'unsupported_operation');
  assert.equal(fs.existsSync(path.join(f.root, PROJECT_AUDIT_FILE)), false);
});

// ---- Only an answer that can still apply is written ----------------------------------------

test('an ended approval and a live one with a wrong revision write nothing however often they are sent', BOUNDED, async (t) => {
  const s = await setup(t);
  const ended = s.openApproval(s.sP);
  const live = s.openApproval(s.sP, { call: 'call_2' });
  await s.look('carl', s.sP);
  assert.equal((await s.resolve('carl', ended)).ok, true);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(reasonOf(await s.resolve('carl', ended, false)), 'decision_stale');
    assert.equal(reasonOf(await s.resolve('carl', { ...live, revision: 'dec_wrong' })), 'decision_stale');
  }
  assert.equal(s.entries(s.P).length, 1, 'only the applied answer');
  assert.equal(s.h.backend.pendingToolApprovals.has(live.approvalId), true);
});

test('an apply that answers not ok or throws after the append leaves the pair; a failed second append still answers stale', BOUNDED, async (t) => {
  const s = await setup(t);
  await s.look('carl', s.sP);
  const notOk = s.openApproval(s.sP, { call: 'call_a' });
  s.h.backend.approveToolCall = () => false;
  assert.equal(reasonOf(await s.resolve('carl', notOk)), 'decision_stale');
  const throws = s.openApproval(s.sP, { call: 'call_b' });
  s.h.backend.approveToolCall = () => { throw new Error('backend fault'); };
  assert.equal((await s.resolve('carl', throws)).ok, false);
  const pairs = s.entries(s.P).map(({ seq, kind, detail }) => [seq, kind, detail?.ref_seq ?? null]);
  assert.deepEqual(pairs, [[1, 'approval_decided', null], [2, 'approval_not_applied', 1],
    [3, 'approval_decided', null], [4, 'approval_not_applied', 3]]);
  const lost = s.openApproval(s.sP, { call: 'call_c' });
  s.h.backend.approveToolCall = () => false;
  const audit = s.h.approvals.audit();
  const realAppend = audit.append.bind(audit);
  let calls = 0;
  audit.append = (entry) => { calls += 1; return calls === 1 ? realAppend(entry) : { ok: false }; };
  assert.equal(reasonOf(await s.resolve('carl', lost)), 'decision_stale');
  assert.equal(s.h.fx.logs.filter((line) => line.event === 'team_approval.not_applied_unrecorded').length, 1);
});

// ---- The check inside the queue ---------------------------------------------------------------

test('a member removed or re-roled while the answer waits in the queue is refused there', BOUNDED, async (t) => {
  for (const change of ['remove', 'reader']) {
    const s = await setup(t);
    const approval = s.openApproval(s.sP);
    await s.look('carl', s.sP);
    const lease = (await s.h.ok(s.send('alice', 'control.acquire', {}, { session_id: s.sP }))).lease;
    let release;
    let entered;
    const inside = new Promise((resolve) => { entered = resolve; });
    s.h.backend.renameGate = new Promise((resolve) => { release = resolve; });
    s.h.backend.renameEntered = entered;
    const revision = s.h.core.router.snapshot(s.sP).session.revision;
    const rename = s.send('alice', 'sessions.rename', { title: 'Held' },
      { session_id: s.sP, control_generation: lease.generation, expected_revision: revision });
    await inside; // the rename holds the conversation's queue
    const answer = s.resolve('carl', approval);
    await new Promise((resolve) => setImmediate(resolve)); // past the early gate, waiting in the queue
    if (change === 'remove') {
      await s.h.ok(s.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('carl') }));
    } else {
      await s.h.ok(s.send('alice', 'team.project.members.setRole', { project_id: s.P, member_id: s.member('carl'),
        role: 'reader' }));
    }
    release();
    await rename;
    assert.equal(reasonOf(await answer), change === 'remove' ? 'team_not_found' : 'team_project_read_only', change);
    assert.deepEqual(s.decided, [], change);
    assert.deepEqual(s.entries(s.P), [], change);
  }
});

// ---- The prompter is the host's ---------------------------------------------------------------

test('a prompter sent by the client is refused by the contract, in params and in the envelope', BOUNDED, async (t) => {
  const s = await setup(t);
  const approval = s.openApproval(s.sP);
  await s.look('carl', s.sP);
  const params = { stream_id: STREAM, approval_id: approval.approvalId, decision_revision: approval.revision, approved: true };
  assert.equal(reasonOf(await s.send('carl', 'approval.resolve', { ...params, prompter_member_id: s.member('carl') },
    { session_id: s.sP })), 'invalid_command_parameters');
  assert.equal(reasonOf(await s.send('carl', 'approval.resolve', params,
    { session_id: s.sP, prompter_member_id: s.member('carl') })), 'invalid_command_envelope');
  const events = s.h.attach('rae');
  assert.equal((await s.resolve('carl', approval)).ok, true);
  assert.equal(s.entries(s.P)[0].prompter_member_id, s.member('alice'));
  assert.deepEqual(frames(events, 'decision_changed').map((frame) => frame.prompter_member_id), [s.member('alice')]);
});

// ---- Branches of the audited resolve ------------------------------------------------------------

test('a conversation in no project applies with no entry; a tool name the log refuses answers unavailable', BOUNDED, async (t) => {
  const s = await setup(t);
  // Seeded in the store: on a team host sessions.create makes no General conversation (E70).
  const general = s.h.backend.sessionStore.createSession({ title: 'Secret Title' }).id;
  const approval = s.openApproval(general, { starter: s.member('owner') });
  await s.look('owner', general);
  const applied = await s.resolve('owner', approval);
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const file = s.h.approvals.audit().filePath;
  assert.equal(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).entries.length : 0, 0);
  const odd = s.openApproval(s.sP, { tool: 'mcp:server/Write' });
  await s.look('carl', s.sP);
  assert.equal(reasonOf(await s.resolve('carl', odd)), 'team_audit_unavailable');
  assert.equal(s.h.backend.pendingToolApprovals.has(odd.approvalId), true);
});

test('a project lookup that throws refuses the audited resolve and applies nothing', async () => {
  const applied = [];
  const handlers = createDecisionHandlers({
    teamHost: true,
    identity: () => null,
    sessionExists: () => true,
    decisionAdapter: {
      peekApproval: () => ({ toolName: 'write_file' }),
      resolveApproval: () => { applied.push('resolve'); return { ok: true }; },
    },
    approvals: { viewers: { isViewing: () => true }, take: () => true, prompterFor: () => 'member_alice', projectOf: () => undefined,
      append: () => { applied.push('append'); return { ok: true, seq: 1 }; }, log: () => {} },
    trustedAuthor: () => ({ member_id: 'member_carl' }),
    runReceipt: (_command, _context, execute) => execute(),
    bumpRevision: () => 'boot:1', publish: () => {},
  });
  const answer = await handlers.decision({ operation: 'approval.resolve', session_id: 'sess_1_aaaaaaaaaaaa', request_id: 'r1',
    params: { stream_id: STREAM, approval_id: 'approval_x', decision_revision: 'dec_x', approved: true } },
  { deviceId: 'device_a' });
  assert.equal(answer.error.reason, 'team_audit_unavailable');
  assert.deepEqual(applied, []);
});

test('the owner reads a project audit only with an admin row in it', BOUNDED, async (t) => {
  const s = await setup(t);
  assert.equal(reasonOf(await s.send('owner', 'team.project.audit.read', { project_id: s.P })), 'team_not_found');
  await s.h.ok(s.send('owner', 'team.project.join', { project_id: s.P, role: 'reader' }));
  assert.equal(reasonOf(await s.send('owner', 'team.project.audit.read', { project_id: s.P })), 'role_forbidden');
  await s.h.ok(s.send('alice', 'team.project.members.setRole', { project_id: s.P, member_id: s.member('owner'), role: 'admin' }));
  const page = await s.h.ok(s.send('owner', 'team.project.audit.read', { project_id: s.P }));
  assert.deepEqual(Object.keys(page).sort(), ['entries', 'floor_seq', 'next_cursor', 'ok']);
});

// ---- Viewing records ---------------------------------------------------------------------------

test('session.view refused at the store\'s capacity answers viewing: false', BOUNDED, async (t) => {
  const s = await setup(t);
  const { viewers } = s.h.approvals;
  for (let device = 0; viewers.size() < viewers.capacity; device += 1) {
    for (let i = 0; i < 32 && viewers.size() < viewers.capacity; i += 1) {
      assert.equal(viewers.touch(`sess_1_${String(i).padStart(12, '0')}`, `device_filler${device}`), true);
    }
  }
  assert.deepEqual(await s.send('carl', 'session.view', {}, { session_id: s.sP }), { ok: true, viewing: false, viewers: [] });
});

test('the drops take what they name and nothing more', BOUNDED, async (t) => {
  const s = await setup(t);
  await s.h.ok(s.send('bob', 'team.project.members.add', { project_id: s.Q, member_id: s.member('carl'), role: 'writer' }));
  const approval = s.openApproval(s.sP);
  const lookAll = async () => {
    for (const [who, sessionId] of [['carl', s.sP], ['alice', s.sP], ['carl', s.sQ], ['rae', s.sP], ['bob', s.sQ]]) {
      await s.look(who, sessionId);
    }
  };
  const still = (pairs) => { for (const [who, sessionId] of pairs) assert.equal(s.viewing(who, sessionId), true, `${who} kept`); };
  await lookAll();
  await s.h.ok(s.send('alice', 'team.project.members.setRole', { project_id: s.P, member_id: s.member('carl'), role: 'admin' }));
  assert.equal(s.viewing('carl', s.sP), false, 'a project re-role drops');
  still([['alice', s.sP], ['carl', s.sQ], ['rae', s.sP]]);
  // A re-roled writer passes again once looking: the role is checked at decision time.
  assert.equal(reasonOf(await s.resolve('carl', approval)), 'approval_not_viewing');
  await s.look('carl', s.sP);
  assert.equal((await s.resolve('carl', approval)).ok, true);
  await s.h.ok(s.send('alice', 'team.project.members.remove', { project_id: s.P, member_id: s.member('rae') }));
  assert.equal(s.viewing('rae', s.sP), false, 'removal drops');
  still([['alice', s.sP], ['carl', s.sP], ['carl', s.sQ]]);
  s.h.approvals.onMemberStream(s.member('carl'), s.device('carl'), 'open');
  s.h.approvals.onMemberStream(s.member('carl'), s.device('carl'), 'open');
  s.h.approvals.onMemberStream(s.member('carl'), s.device('carl'), 'close');
  still([['carl', s.sP]]);
  s.h.approvals.onMemberStream(s.member('carl'), s.device('carl'), 'close');
  assert.equal(s.viewing('carl', s.sP) || s.viewing('carl', s.sQ), false, 'the last close drops the device');
  still([['alice', s.sP], ['bob', s.sQ]]);
  await lookAll();
  assert.equal((await s.h.store.setRole({ actorMemberId: s.member('owner'), memberId: s.member('rae'), role: 'member' })).ok, true);
  assert.equal(s.viewing('rae', s.sP), false, 'a team role change drops');
  still([['alice', s.sP], ['carl', s.sP], ['bob', s.sQ]]);
  assert.equal((await s.h.store.revokeDevice({ actorMemberId: s.member('bob'), deviceId: s.device('bob') })).ok, true);
  assert.equal(s.viewing('bob', s.sQ), false, 'device revocation drops');
  still([['carl', s.sQ], ['alice', s.sP]]);
  s.h.backend.sessionStore.clearActiveTurn(s.sP, { stream_id: STREAM, request_id: STREAM });
  await s.h.ok(s.send('alice', 'team.project.delete', { project_id: s.P }), 'delete');
  assert.equal(s.viewing('alice', s.sP) || s.viewing('carl', s.sP), false, 'a project delete drops');
  still([['carl', s.sQ]]);
});

test('session.view has its own limit; the decisions keep theirs, and a refused decision applies nothing', BOUNDED,
  async (t) => {
  const s = await setup(t);
  for (let i = 0; i < VIEW_LIMIT.limit; i += 1) {
    assert.deepEqual(await s.send('carl', 'session.view', {}, { session_id: s.sP }),
      { ok: true, viewing: true, viewers: [s.member('carl')] });
  }
  const over = await s.send('carl', 'session.view', {}, { session_id: s.sP });
  assert.deepEqual([over.error.code, over.error.reason], ['CMP-HOST-0007', 'team_view_rate_limit'], 'not team_rate_limit');
  const kept = s.openApproval(s.sP);
  assert.equal((await s.resolve('carl', kept, true)).ok, true, 'views spend no decision token');
  // The rest of the minute's decision tokens, each a stale answer to the settled approval.
  for (let i = 1; i < 60; i += 1) assert.equal(reasonOf(await s.resolve('carl', kept, true)), 'decision_stale');
  const approval = s.openApproval(s.sP, { call: 'call_2' });
  const refused = await s.resolve('carl', approval);
  assert.deepEqual([refused.error.code, refused.error.reason], ['CMP-HOST-0007', 'team_rate_limit']);
  assert.equal(s.h.backend.pendingToolApprovals.has(approval.approvalId), true);
  assert.deepEqual(await s.send('alice', 'session.view', {}, { session_id: s.sP }),
    { ok: true, viewing: true, viewers: [s.member('carl'), s.member('alice')] }, 'another member is unaffected');
});
