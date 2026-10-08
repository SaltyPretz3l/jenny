'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDecisionAdapter } = require('../../server/decision-adapter');
const { validateCommand } = require('../../server/api-contract');

function approvalBackend() {
  const backend = {
    pendingToolApprovals: new Map(),
    approved: [],
    denied: [],
    approveToolCall(id) {
      this.approved.push(id);
      this.pendingToolApprovals.delete(id);
      return true;
    },
    denyToolCall(id) {
      this.denied.push(id);
      this.pendingToolApprovals.delete(id);
      return true;
    },
  };
  const pending = {
    approvalId: 'approval_1', streamId: 'stream_1', sessionId: 'session_1',
    callId: 'call_1', toolName: 'shell', policyScope: 'workspace',
  };
  backend.pendingToolApprovals.set('approval_1', pending);
  return { backend, pending };
}

test('approval decisions require the exact live map key and per-object revision', () => {
  const { backend, pending } = approvalBackend();
  const adapter = createDecisionAdapter({ backend });
  const listed = adapter.listApprovals('session_1', 'stream_1');
  assert.equal(listed.length, 1);
  assert.match(listed[0].decision_revision, /^dec_[A-Za-z0-9_-]+$/);
  assert.equal(adapter.resolveApproval({
    sessionId: 'session_1', streamId: 'stream_1', approvalId: 'call_1',
    decisionRevision: listed[0].decision_revision, approved: true,
  }).reason, 'decision_stale');
  assert.equal(backend.pendingToolApprovals.has('approval_1'), true);
  assert.equal(adapter.resolveApproval({
    sessionId: 'session_1', streamId: 'stream_1', approvalId: 'approval_1',
    decisionRevision: 'dec_wrong', approved: true,
  }).reason, 'decision_stale');
  const resolved = adapter.resolveApproval({
    sessionId: 'session_1', streamId: 'stream_1', approvalId: 'approval_1',
    decisionRevision: listed[0].decision_revision, approved: true,
  });
  assert.deepEqual(resolved, { ok: true, approval_id: 'approval_1', approved: true });
  assert.deepEqual(backend.approved, ['approval_1']);
  assert.equal(backend.pendingToolApprovals.has('approval_1'), false);
  assert.equal(pending.approvalId, 'approval_1');
});

test('question answers validate the exact live batch and convert to backend ids', () => {
  const calls = [];
  const backend = {
    pendingUserQuestions: new Map([['questions_1', {
      questionRef: 'questions_1', streamId: 'stream_1', sessionId: 'session_1', callId: 'call_2',
      questions: [
        { id: 'language', prompt: 'Language?', options: ['JavaScript', 'Python'] },
        { id: 'tests', prompt: 'Run tests?', options: ['yes', 'no'] },
      ],
    }]]),
    answerUserQuestions(ref, payload) { calls.push({ ref, payload }); return true; },
    declineUserQuestions() { return true; },
  };
  const adapter = createDecisionAdapter({ backend });
  const listed = adapter.listQuestions('session_1', 'stream_1');
  assert.deepEqual(listed[0].questions[0].options[0], { id: 'JavaScript', label: 'JavaScript' });
  const invalid = adapter.answerQuestions({
    sessionId: 'session_1', streamId: 'stream_1', questionRef: 'questions_1',
    answers: [{ question_id: 'language', answer: 'JavaScript' }, { question_id: 'unknown', answer: 'x' }],
  });
  assert.deepEqual(invalid, { ok: false, reason: 'question_batch_stale' });
  assert.equal(calls.length, 0);
  const answered = adapter.answerQuestions({
    sessionId: 'session_1', streamId: 'stream_1', questionRef: 'questions_1',
    answers: [{ question_id: 'tests', answer: 'yes' }, { question_id: 'language', answer: 'Python' }],
  });
  assert.deepEqual(answered, { ok: true, question_ref: 'questions_1', answered: true });
  assert.deepEqual(calls, [{
    ref: 'questions_1', payload: { answers: [{ id: 'tests', value: 'yes' }, { id: 'language', value: 'Python' }] },
  }]);
});

test('question ids with punctuation and Unicode round-trip through the API and live batch', () => {
  const calls = [];
  const questions = ['build.target', '目標'].map(id => ({ id, prompt: 'Target?', options: ['yes', 'no'] }));
  const backend = {
    pendingUserQuestions: new Map([['questions_1', {
      questionRef: 'questions_1', streamId: 'stream_1', sessionId: 'session_1', callId: 'call_1', questions,
    }]]),
    answerUserQuestions(ref, payload) { calls.push({ ref, payload }); return true; },
  };
  const adapter = createDecisionAdapter({ backend });
  const listed = adapter.listQuestions('session_1', 'stream_1')[0];
  assert.deepEqual(listed.questions.map(question => question.id), questions.map(question => question.id));
  const answers = listed.questions.map(question => ({ question_id: question.id, answer: 'yes' }));
  const command = { api_version: 1, operation: 'questions.answer', request_id: 'answer_1',
    client_id: 'client_1', boot_epoch: 'boot_1', session_id: 'session_1',
    params: { stream_id: listed.stream_id, question_ref: listed.question_ref, answers } };
  assert.equal(validateCommand(command).ok, true);
  assert.equal(validateCommand({ ...command, params: { ...command.params,
    answers: [{ question_id: 'x'.repeat(513), answer: 'yes' }] } }).ok, false);
  assert.deepEqual(adapter.answerQuestions({ sessionId: command.session_id,
    streamId: command.params.stream_id, questionRef: command.params.question_ref, answers }),
  { ok: true, question_ref: 'questions_1', answered: true });
  assert.deepEqual(calls, [{ ref: 'questions_1', payload: {
    answers: questions.map(question => ({ id: question.id, value: 'yes' })),
  } }]);
});
