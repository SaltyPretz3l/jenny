'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDecisionAdapter } = require('../../server/decision-adapter');

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
