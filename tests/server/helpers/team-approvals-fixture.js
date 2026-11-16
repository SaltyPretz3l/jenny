'use strict';

// Slice 3-6b: the approvals setup for tests/server/team-approvals.test.js, kept apart so that file stays
// under the line cap. P: Alice admin, Carl writer, Rae reader. Q: Bob admin.
// The owner has joined neither. A waiting approval runs in a turn Alice started.

const assert = require('node:assert/strict');

const { createTeamProjectFixture } = require('./team-project-fixture');
const { dataFrames } = require('./session-scope-fixture');

const BOUNDED = Object.freeze({ timeout: 30_000 });
const SECRET_PATH = 'C:/secret/plans/launch.txt';
// Display names, project names, the title, the prompt and the tool argument: none may reach an answer
// to a decision, an event, a log line or the audit file.
const NAMES = ['Olive Owner', 'Alice', 'Bob', 'Carl', 'Rae', 'Pia', 'Apollo', 'Zephyr', 'Laptop', 'Secret Title',
  'secret prompt', SECRET_PATH, 'secret content'];
const STREAM = 'stream_turn';

function startTurn(store, sessionId, starter) {
  const now = new Date().toISOString();
  assert.ok(store.appendMessage(sessionId, { id: 'message_turn', role: 'user', content: 'secret prompt',
    ...(starter ? { author: { kind: 'member', member_id: starter } } : {}) }));
  store.setActiveTurn(sessionId, { request_id: STREAM, stream_id: STREAM, user_message_id: 'message_turn',
    started_at: now, last_event_at: now, status: 'awaiting_assistant' });
}

// P: Alice admin, Carl writer, Rae reader. Q: Bob admin. The owner has joined neither.
async function setup(t, options = {}) {
  let viewerClock = 1_000_000;
  const h = await createTeamProjectFixture(t, { viewerNow: () => viewerClock, ...options });
  const P = await h.sharedProject('Apollo');
  const Q = (await h.ok(h.send('bob', 'team.project.create', { name: 'Zephyr' }))).project_id;
  const create = async (who, projectId) => (await h.ok(h.send(who, 'sessions.create',
    { title: 'Secret Title', project_id: projectId }))).session.session_id;
  const decided = [];
  const backend = h.backend;
  const settle = (map, key, value) => {
    if (!backend[map].has(key)) return false;
    backend[map].delete(key);
    decided.push([key, value]);
    return true;
  };
  backend.approveToolCall = (key) => settle('pendingToolApprovals', key, 'approved');
  backend.denyToolCall = (key) => settle('pendingToolApprovals', key, 'denied');
  backend.answerUserQuestions = (key) => settle('pendingUserQuestions', key, 'answered');
  backend.declineUserQuestions = (key) => settle('pendingUserQuestions', key, 'declined');
  const answers = [];
  const record = async (promise) => { const answer = await promise; answers.push(answer); return answer; };
  const send = (who, operation, params, extra) => record(h.send(who, operation, params, extra));
  const member = (who) => h.seats[who].member_id;
  const device = (who) => h.seats[who].device_id;
  // A waiting approval in a running turn; `starter` null is a turn with no member author.
  const openApproval = (sessionId, { call = 'call_1', starter = member('alice'), tool = 'write_file' } = {}) => {
    if (!backend.sessionStore.peekActiveTurn(sessionId)) startTurn(backend.sessionStore, sessionId, starter);
    const approvalId = `approval_${sessionId}_${STREAM}_${call}`;
    backend.pendingToolApprovals.set(approvalId, { approvalId, sessionId, streamId: STREAM, callId: call, toolName: tool,
      toolInput: { path: SECRET_PATH, content: 'secret content' }, messageId: 'message_tool', resolve: () => {} });
    backend.emit('chat-stream', { type: 'tool_approval_needed', sessionId, streamId: STREAM, approvalId, callId: call,
      toolName: tool, summary: `Write ${SECRET_PATH}` });
    return { sessionId, approvalId, revision: h.core.router.snapshot(sessionId).pending_approvals
      .find((entry) => entry.approval_id === approvalId).decision_revision };
  };
  const openQuestions = (sessionId, ref = 'question_1') => {
    if (!backend.sessionStore.peekActiveTurn(sessionId)) startTurn(backend.sessionStore, sessionId, member('alice'));
    backend.pendingUserQuestions.set(ref, { questionRef: ref, sessionId, streamId: STREAM, callId: 'call_q',
      questions: [{ id: 'q1', prompt: 'Pick one', options: ['a', 'b'] }] });
    return ref;
  };
  const resolve = (who, approval, approved = true, extra = {}) => send(who, 'approval.resolve', { stream_id: STREAM,
    approval_id: approval.approvalId, decision_revision: approval.revision, approved },
  { session_id: approval.sessionId, ...extra });
  const answerQ = (who, sessionId, ref) => send(who, 'questions.answer', { stream_id: STREAM, question_ref: ref,
    answers: [{ question_id: 'q1', answer: 'a' }] }, { session_id: sessionId });
  const declineQ = (who, sessionId, ref) => send(who, 'questions.decline', { stream_id: STREAM, question_ref: ref },
    { session_id: sessionId });
  const look = (who, sessionId) => send(who, 'sessions.snapshot', {}, { session_id: sessionId });
  const entries = (projectId) => h.approvals.audit().read({ projectId }).entries;
  return {
    h, P, Q, sP: await create('alice', P), sP2: await create('alice', P), sQ: await create('bob', Q), decided, answers,
    send, member, device, openApproval, openQuestions, resolve, answerQ, declineQ, look, entries,
    viewing: (who, sessionId) => h.approvals.viewers.isViewing(sessionId, device(who)),
    advance: (ms) => { viewerClock += ms; },
  };
}

const reasonOf = (answer) => (answer.ok ? 'ok' : answer.error.reason);
const frames = (response, type) => dataFrames(response.frames).filter((frame) => frame.event_type === type);
function assertNoNames(text, where) {
  const words = text.replace(/[A-Za-z0-9_-]{12,}/g, ' ');
  for (const name of NAMES) assert.equal(words.includes(name), false, `${where} carries ${name}`);
}


module.exports = { BOUNDED, NAMES, SECRET_PATH, STREAM, assertNoNames, frames, reasonOf, setup, startTurn };
