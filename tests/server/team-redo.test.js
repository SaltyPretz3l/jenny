'use strict';

// new-test-file: row 175 item 6 (D7), F13 (D8) and F18 are new team host operations (server/command-router-redo.js):
// regenerate and edit-and-resend the latest turn, branch, ask a teammate and hand the driver seat. Through the real
// router on the team project fixture: P has Alice admin, Carl writer, Rae reader; Q has Bob admin; the owner joined
// neither; Pia is pending.

const assert = require('node:assert/strict');
const test = require('node:test');

const { command, createFixture, createSession } = require('../helpers/command-router-fixture');
const { BOUNDED, assertNoNames, reasonOf, setup } = require('./helpers/team-approvals-fixture');

const OPS = ['team.project.regenerate', 'team.project.edit_resend', 'team.project.branch', 'team.project.ask',
  'team.project.hand_driver'];

// A finished turn in `sessionId`: a prompt by `author` and its answer, nothing running.
function seedTurn(s, sessionId, author, id = 'message_q') {
  const store = s.h.backend.sessionStore;
  assert.ok(store.appendMessage(sessionId, { id, role: 'user', content: 'secret prompt',
    author: { kind: 'member', member_id: s.member(author) } }));
  assert.ok(store.appendMessage(sessionId, { id: `${id}_answer`, role: 'assistant', content: 'secret content' }));
}

// The backend's regenerate, recorded: it starts a turn on the anchor as the real one does.
function stubRegenerate(s) {
  const calls = [];
  s.h.backend.editAndRegenerate = async (payload) => {
    calls.push(payload);
    const streamId = `stream_redo_${calls.length}`;
    const now = new Date().toISOString();
    s.h.backend.sessionStore.setActiveTurn(payload.sessionId, { request_id: streamId, stream_id: streamId,
      user_message_id: payload.editedMessageId, started_at: now, last_event_at: now, status: 'awaiting_assistant' });
    return { sessionId: payload.sessionId, streamId };
  };
  return calls;
}

function spyEvents(s) {
  const events = [];
  const real = s.h.core.events.publish.bind(s.h.core.events);
  s.h.core.events.publish = (type, payload, options) => { events.push({ type, payload, options }); return real(type, payload, options); };
  return events;
}

const endTurn = (s, sessionId) => assert.ok(s.h.backend.sessionStore.clearActiveTurn(sessionId, {
  stream_id: s.h.backend.sessionStore.peekActiveTurn(sessionId)?.stream_id }));
const regen = (s, who, extra = {}) => s.send(who, 'team.project.regenerate',
  { project_id: s.P, session_id: s.sP, message_id: 'message_q', ...extra });

test('prompter regenerates the latest turn: a new turn on the same prompt as the caller, who becomes the driver', BOUNDED, async (t) => {
  const s = await setup(t);
  seedTurn(s, s.sP, 'carl');
  const calls = stubRegenerate(s);
  const events = spyEvents(s);
  const answer = await regen(s, 'carl');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.session_id, s.sP);
  assert.equal(answer.stream_id, 'stream_redo_1');
  assert.equal(typeof answer.revision, 'string');
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].sessionId, calls[0].editedMessageId, calls[0].prompt, calls[0].approvalMode],
    [s.sP, 'message_q', 'secret prompt', 'prompt']);
  assert.equal(s.h.leases.get(s.sP).member_id, s.member('carl'));
  assert.ok(events.some((e) => e.type === 'control_changed' && e.payload.member_id === s.member('carl')));
  assert.ok(events.some((e) => e.type === 'session_changed' && e.payload.reason === 'chat_saved'));
  assertNoNames(JSON.stringify(answer), 'the answer');
  // A turn runs now: a second regenerate waits for it.
  assert.equal(reasonOf(await regen(s, 'carl')), 'session_active');
});

test('D7: a writer who did not ask the latest turn is refused; a project admin may redo anyone\'s', BOUNDED, async (t) => {
  const s = await setup(t);
  seedTurn(s, s.sP, 'alice');
  const calls = stubRegenerate(s);
  assert.equal(reasonOf(await regen(s, 'carl')), 'team_redo_forbidden');
  assert.equal(reasonOf(await s.send('carl', 'team.project.edit_resend', { project_id: s.P, session_id: s.sP,
    message_id: 'message_q', prompt: 'other words' })), 'team_redo_forbidden');
  assert.equal(calls.length, 0);
  seedTurn(s, s.sP2, 'carl');
  const admin = await s.send('alice', 'team.project.regenerate', { project_id: s.P, session_id: s.sP2, message_id: 'message_q' });
  assert.equal(admin.ok, true, JSON.stringify(admin));
  assert.equal(calls.length, 1);
  // An edit stays with its author: the admin's words would sit under Carl's name.
  seedTurn(s, s.sP2, 'carl', 'message_q2');
  assert.equal(reasonOf(await s.send('alice', 'team.project.edit_resend', { project_id: s.P, session_id: s.sP2,
    message_id: 'message_q2', prompt: 'admin words' })), 'team_redo_forbidden');
  assert.equal(calls.length, 1);
});

test('a prompt with attachments is not redone (the restart would drop them)', BOUNDED, async (t) => {
  const s = await setup(t);
  const store = s.h.backend.sessionStore;
  assert.ok(store.appendMessage(s.sP, { id: 'message_q', role: 'user', content: 'see the file',
    attachments: [{ id: 'att_1', name: 'a.png', mime: 'image/png' }], author: { kind: 'member', member_id: s.member('carl') } }));
  const calls = stubRegenerate(s);
  assert.ok(store.getSession(s.sP).messages.at(-1).attachments?.length, 'the store keeps the attachment');
  assert.equal(reasonOf(await regen(s, 'carl')), 'team_redo_attachments');
  assert.equal(calls.length, 0);
});

test('edit and resend replaces the latest prompt; an older message, a running turn or another driver refuses', BOUNDED, async (t) => {
  const s = await setup(t);
  seedTurn(s, s.sP, 'carl', 'message_old');
  seedTurn(s, s.sP, 'carl');
  const calls = stubRegenerate(s);
  const edit = (who, messageId, prompt = 'new secret prompt') => s.send(who, 'team.project.edit_resend',
    { project_id: s.P, session_id: s.sP, message_id: messageId, prompt });
  assert.equal(reasonOf(await edit('carl', 'message_old')), 'team_turn_not_latest');
  assert.equal(reasonOf(await regen(s, 'carl', { message_id: 'message_missing' })), 'team_turn_not_latest');
  // Another member holds the conversation: the caller does not take it over.
  const taken = await s.send('alice', 'control.acquire', {}, { session_id: s.sP });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.equal(reasonOf(await edit('carl', 'message_q')), 'control_lease_unavailable');
  assert.equal((await s.send('alice', 'control.release', {}, { session_id: s.sP,
    control_generation: taken.lease.generation })).ok, true);
  // A waiting approval or question is a turn that waits, and so is a running one.
  s.h.backend.pendingToolApprovals.set('approval_x', { approvalId: 'approval_x', sessionId: s.sP, streamId: 'stream_x' });
  assert.equal(reasonOf(await edit('carl', 'message_q')), 'session_active');
  s.h.backend.pendingToolApprovals.clear();
  s.h.backend.pendingUserQuestions.set('question_x', { questionRef: 'question_x', sessionId: s.sP, streamId: 'stream_x' });
  assert.equal(reasonOf(await edit('carl', 'message_q')), 'session_active');
  s.h.backend.pendingUserQuestions.clear();
  const now = new Date().toISOString();
  s.h.backend.sessionStore.setActiveTurn(s.sP, { request_id: 'stream_x', stream_id: 'stream_x', user_message_id: 'message_q',
    started_at: now, last_event_at: now, status: 'awaiting_assistant' });
  assert.equal(reasonOf(await edit('carl', 'message_q')), 'session_active');
  endTurn(s, s.sP);
  assert.equal(calls.length, 0);
  const answer = await edit('carl', 'message_q');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual([calls[0].editedMessageId, calls[0].prompt, calls[0].visiblePrompt],
    ['message_q', 'new secret prompt', 'new secret prompt']);
});

test('branch copies the conversation up to a message into a new conversation of the same project', BOUNDED, async (t) => {
  const s = await setup(t);
  seedTurn(s, s.sP, 'alice', 'message_first');
  seedTurn(s, s.sP, 'alice');
  // The source's limits go with the branch: write switched off and Plan mode on.
  // (updateSession refuses the team fields: only their own seam writes them.)
  s.h.backend.sessionStore._updateSessionRecord(s.sP, { team_tool_switches: { read: true, write: false }, plan_mode: true });
  const answer = await s.send('carl', 'team.project.branch', { project_id: s.P, session_id: s.sP, message_id: 'message_first_answer' });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const kept = s.h.backend.sessionStore.getSession(answer.session_id);
  assert.deepEqual([kept.team_tool_switches, kept.plan_mode], [{ read: true, write: false }, true], 'the branch keeps its limits');
  assert.deepEqual(Object.keys(answer).sort(), ['ok', 'revision', 'session_id']);
  const branch = s.h.backend.sessionStore.getSession(answer.session_id);
  assert.equal(branch.project_id, s.P);
  assert.equal(branch.title, 'Branch of Secret Title');
  assert.deepEqual(branch.messages.map((m) => m.client_message_id), ['message_first', 'message_first_answer']);
  for (const who of ['alice', 'rae']) {
    const listed = await s.send(who, 'sessions.list', {});
    assert.ok(listed.sessions.some((row) => row.session_id === answer.session_id), `${who} sees the branch`);
  }
  assert.equal(reasonOf(await s.send('bob', 'sessions.snapshot', {}, { session_id: answer.session_id })), 'team_not_found');
  assert.equal(reasonOf(await s.send('carl', 'team.project.branch', { project_id: s.P, session_id: s.sP,
    message_id: 'message_missing' })), 'team_branch_refused');
});

test('ask a teammate: one event to the asked member only, a project member, at most 6 a minute per asker', BOUNDED, async (t) => {
  const s = await setup(t);
  const events = spyEvents(s);
  const ask = (who, memberId, extra = {}) => s.send(who, 'team.project.ask',
    { project_id: s.P, session_id: s.sP, member_id: memberId, ...extra });
  const answer = await ask('carl', s.member('rae'));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const asked = events.filter((e) => e.type === 'teammate_asked');
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].payload, { session_id: s.sP, project_id: s.P, asker_member_id: s.member('carl'),
    asked_member_id: s.member('rae') });
  assert.deepEqual([...asked[0].options.audience], [s.member('rae')]);
  assert.equal(asked[0].options.bucket, `project:${s.P}`);
  assert.equal(reasonOf(await ask('carl', s.member('bob'))), 'team_member_unavailable');
  assert.equal(reasonOf(await ask('carl', s.member('pia'))), 'team_member_unavailable');
  assert.equal(reasonOf(await ask('carl', s.member('carl'))), 'team_member_unavailable');
  assert.equal(reasonOf(await ask('carl', s.member('alice'), { approval_id: 'approval_missing' })), 'decision_stale');
  const approval = s.openApproval(s.sP);
  const withApproval = await ask('alice', s.member('carl'), { approval_id: approval.approvalId });
  assert.equal(withApproval.ok, true, JSON.stringify(withApproval));
  assert.equal(events.filter((e) => e.type === 'teammate_asked').at(-1).payload.approval_id, approval.approvalId);
  // Carl has used 5 tokens (refusals included); one more passes, the next is refused.
  assert.equal((await ask('carl', s.member('alice'))).ok, true);
  assert.equal(reasonOf(await ask('carl', s.member('alice'))), 'team_rate_limit');
  assertNoNames(JSON.stringify(events.filter((e) => e.type === 'teammate_asked').map((e) => e.payload)), 'the event');
});

test('hand the driver seat: to a writer viewing it, who holds the lease on their device; refused otherwise', BOUNDED, async (t) => {
  const s = await setup(t);
  const events = spyEvents(s);
  const hand = (who, target, extra = {}) => s.send(who, 'team.project.hand_driver',
    { project_id: s.P, session_id: s.sP, member_id: s.member(target) }, extra);
  const taken = await s.send('alice', 'control.acquire', {}, { session_id: s.sP });
  assert.equal(taken.ok, true);
  assert.equal(reasonOf(await hand('carl', 'alice')), 'control_lease_required');
  assert.equal(reasonOf(await hand('alice', 'carl')), 'team_hand_refused', 'Carl is not viewing it');
  assert.equal((await s.send('carl', 'session.view', {}, { session_id: s.sP })).ok, true);
  assert.equal((await s.send('rae', 'session.view', {}, { session_id: s.sP })).ok, true);
  assert.equal(reasonOf(await hand('alice', 'rae')), 'team_hand_refused', 'a reader cannot drive');
  const snapshot = await s.look('alice', s.sP);
  assert.deepEqual(new Set(snapshot.snapshot.viewers), new Set([s.member('alice'), s.member('carl'), s.member('rae')]));
  assert.equal(snapshot.snapshot.control.member_id, s.member('alice'));
  const answer = await hand('alice', 'carl');
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.member_id, s.member('carl'));
  const lease = s.h.leases.get(s.sP);
  assert.deepEqual([lease.member_id, lease.device_id], [s.member('carl'), s.device('carl')]);
  assert.ok(events.some((e) => e.type === 'control_changed' && e.payload.member_id === s.member('carl')
    && e.payload.generation === lease.generation));
  // Carl's client takes it up: an acquire on the handed lease is a heartbeat of the same generation.
  const adopted = await s.send('carl', 'control.acquire', {}, { session_id: s.sP });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  assert.equal(adopted.lease.generation, lease.generation);
  assert.equal(reasonOf(await s.send('alice', 'control.heartbeat', {}, { session_id: s.sP,
    control_generation: taken.lease.generation })), 'control_lease_required');
});

test('who may: owner outside, reader, pending, another project and a conversation of another project are refused', BOUNDED, async (t) => {
  const s = await setup(t);
  seedTurn(s, s.sP, 'carl');
  stubRegenerate(s);
  const R = (await s.h.ok(s.send('alice', 'team.project.create', { name: 'Third' }))).project_id;
  const sR = (await s.h.ok(s.send('alice', 'sessions.create', { title: 'Secret Title', project_id: R }))).session.session_id;
  const paramsOf = (operation, sessionId = s.sP, projectId = s.P) => ({ project_id: projectId, session_id: sessionId,
    ...(operation === 'team.project.ask' || operation === 'team.project.hand_driver' ? { member_id: s.member('carl') }
      : { message_id: 'message_q' }), ...(operation === 'team.project.edit_resend' ? { prompt: 'x' } : {}) });
  for (const operation of OPS) {
    for (const [who, expected] of [['owner', 'team_not_found'], ['rae', 'role_forbidden'], ['pia', 'member_pending'],
      ['bob', 'team_not_found']]) {
      assert.equal(reasonOf(await s.send(who, operation, paramsOf(operation))), expected, `${operation} ${who}`);
    }
    // Alice writes both projects: a conversation of R named under P reads as not existing.
    assert.equal(reasonOf(await s.send('alice', operation, paramsOf(operation, sR))), 'team_not_found', operation);
  }
  assert.equal(s.h.backend.sessionStore.getSession(sR).project_id, R);
  const revoked = await s.h.store.revokeMember({ actorMemberId: s.member('owner'), memberId: s.member('carl') });
  assert.equal(revoked.ok, true);
  const auth = s.h.clients.register(s.device('carl'));
  for (const operation of OPS) {
    const answer = await s.h.core.router.dispatch({ api_version: 1, operation, request_id: `request_revoked_${operation.length}`,
      client_id: auth.client_id, boot_epoch: s.h.core.bootEpoch, params: paramsOf(operation) },
    { deviceId: s.device('carl'), clientToken: auth.client_token, isAuthenticated: () => true,
      actor: { member_id: s.member('carl'), device_id: s.device('carl') } });
    assert.equal(reasonOf(answer), 'member_revoked', operation);
  }
});

test('the single-owner host has none of the five operations', BOUNDED, async (t) => {
  const fx = createFixture();
  t.after(() => fx.close());
  const sessionId = await createSession(fx);
  for (const operation of OPS) {
    const params = { project_id: 'project_alpha', session_id: sessionId,
      ...(operation === 'team.project.ask' || operation === 'team.project.hand_driver' ? { member_id: 'member_x' }
        : { message_id: 'message_1' }), ...(operation === 'team.project.edit_resend' ? { prompt: 'x' } : {}) };
    const answer = await fx.router.dispatch(command(fx.a, operation, params), fx.contextA);
    assert.equal(reasonOf(answer), 'team_not_found', operation);
  }
  const snapshot = await fx.router.dispatch(command(fx.a, 'sessions.snapshot', {}, { session_id: sessionId }), fx.contextA);
  assert.equal(Object.hasOwn(snapshot.snapshot, 'viewers'), false);
});
