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

// Row 175 F5: the exact change a team approval card shows.
const exactFields = (text) => ({ schema_version: 1, fields: [{ name: 'file_path', text: 'a.md' }, { name: 'content', text }],
  bytes: 20 + Buffer.byteLength(text), sha256: 'b'.repeat(64) });

function exactBackend(entries) {
  const backend = { pendingToolApprovals: new Map() };
  for (const [id, toolName, exactApproval] of entries) {
    backend.pendingToolApprovals.set(id, { approvalId: id, streamId: 'stream_1', sessionId: 'session_1', callId: `call_${id}`,
      toolName, ...(exactApproval ? { exactApproval } : {}) });
  }
  return createDecisionAdapter({ backend, exactApprovals: true });
}

test('a single-owner host lists no exact presentation (its keys stay as before)', () => {
  const backend = exactBackend([['a1', 'write_file', null]]);
  assert.equal(Object.hasOwn(createDecisionAdapter({ backend: { pendingToolApprovals: new Map([['a1', { approvalId: 'a1', streamId: 'stream_1',
    sessionId: 'session_1', callId: 'call_a1', toolName: 'write_file' }]]) } }).listApprovals('session_1', 'stream_1')[0], 'exact_approval'), false);
  assert.equal(backend.listApprovals('session_1', 'stream_1')[0].exact_approval, null, 'a team host fails closed');
});

test('listApprovals carries the exact presentation for write_file and edit_file only', () => {
  const exact = exactFields('hello');
  const listed = exactBackend([['a1', 'write_file', exact], ['a2', 'edit_file', exact], ['a3', 'run_command', exact],
    ['a4', 'write_file', null]]).listApprovals('session_1', 'stream_1');
  const byId = Object.fromEntries(listed.map((entry) => [entry.approval_id, entry]));
  assert.deepEqual(byId.a1.exact_approval, exact);
  assert.deepEqual(byId.a2.exact_approval, exact);
  assert.equal(Object.hasOwn(byId.a3, 'exact_approval'), false, 'not a tool the team offers');
  assert.equal(byId.a4.exact_approval, null, 'none was built: null, so the card fails closed');
});

test('listApprovals passes the too-large shape and drops a malformed presentation', () => {
  const big = { schema_version: 1, too_large: true, bytes: 40_000, limit_bytes: 32_768, extra: 'x' };
  const listed = exactBackend([['a1', 'write_file', big], ['a2', 'write_file', { ...exactFields('x'), sha256: 'zz' }],
    ['a3', 'write_file', { ...exactFields('x'), schema_version: 2 }], ['a4', 'write_file', { schema_version: 1, fields: [{ name: 'a', text: 5 }], sha256: 'c'.repeat(64) }],
  ]).listApprovals('session_1', 'stream_1');
  assert.deepEqual(listed[0].exact_approval, { schema_version: 1, too_large: true, bytes: 40_000, limit_bytes: 32_768 });
  // Fail closed: a write whose presentation is malformed carries null, so the card offers no Allow.
  for (const entry of listed.slice(1)) assert.equal(entry.exact_approval, null, entry.approval_id);
});

test('one pending list carries at most 256 KiB of presentation; later entries carry the too-large shape', () => {
  const chunk = exactFields('x'.repeat(30_000));
  const entries = Array.from({ length: 12 }, (_, index) => [`a${index}`, 'write_file', chunk]);
  const listed = exactBackend(entries).listApprovals('session_1', 'stream_1');
  const full = listed.filter((entry) => entry.exact_approval.fields);
  const large = listed.filter((entry) => entry.exact_approval.too_large === true);
  assert.equal(full.length + large.length, 12);
  assert.ok(full.length > 0 && large.length > 0);
  assert.ok(full.reduce((total, entry) => total + entry.exact_approval.bytes, 0) <= 256 * 1024);
  for (const entry of large) assert.equal(entry.exact_approval.bytes, chunk.bytes);
  assert.deepEqual(listed.slice(0, full.length), full, 'the first entries fit, the rest are over the budget');
});

// Row 175 (D14): a plan decision reaches approveToolCall for exit_plan_mode only, with approved: true.
test('plan decisions and feedback reach approveToolCall for exit_plan_mode only; anything else applies nothing', () => {
  const setup = (toolName) => {
    const { backend, pending } = approvalBackend();
    const calls = [];
    backend.approveToolCall = (id, options) => { calls.push([id, options]); backend.pendingToolApprovals.delete(id); return true; };
    pending.toolName = toolName;
    const adapter = createDecisionAdapter({ backend });
    const revision = adapter.listApprovals('session_1', 'stream_1')[0].decision_revision;
    const resolve = (extra) => adapter.resolveApproval({ sessionId: 'session_1', streamId: 'stream_1', approvalId: 'approval_1',
      decisionRevision: revision, approved: true, ...extra });
    return { adapter, backend, calls, resolve };
  };
  for (const [extra, options] of [[{ planDecision: 'accepted' }, { decision: 'accepted' }],
    [{ planDecision: 'rejected', feedback: 'Split step two' }, { decision: 'rejected', feedback: 'Split step two' }],
    [{ planDecision: 'approved' }, { decision: 'approved' }], [{}, { decision: 'approved' }]]) {
    const plan = setup('exit_plan_mode');
    assert.equal(plan.resolve(extra).ok, true, JSON.stringify(extra));
    assert.deepEqual(plan.calls, [['approval_1', options]]);
  }
  for (const [tool, extra] of [['write_file', { planDecision: 'accepted' }], ['exit_plan_mode', { planDecision: 'accepted', approved: false }],
    ['exit_plan_mode', { planDecision: 'approved_auto' }], ['exit_plan_mode', { feedback: 'no decision' }],
    ['exit_plan_mode', { planDecision: 'rejected', feedback: 'x'.repeat(801) }]]) {
    const plan = setup(tool);
    assert.deepEqual(plan.resolve(extra), { ok: false, reason: 'plan_decision_invalid' }, `${tool} ${JSON.stringify(extra)}`);
    assert.deepEqual([plan.calls, plan.backend.denied, plan.backend.pendingToolApprovals.size], [[], [], 1], 'nothing applied');
  }
  assert.equal(setup('exit_plan_mode').adapter.planDecisionValid('exit_plan_mode', { approved: true, planDecision: 'rejected',
    feedback: 'keep going' }), true);
  const params = { stream_id: 'stream_1', approval_id: 'approval_1', decision_revision: 'dec_1', approved: true };
  assert.equal(validateCommand({ api_version: 1, operation: 'approval.resolve', request_id: 'r1', client_id: 'c1', boot_epoch: 'b',
    session_id: 'session_1', params: { ...params, plan_decision: 'accepted', feedback: 'ok' } }).ok, true);
  for (const extra of [{ plan_decision: 'approved_auto' }, { feedback: 'x'.repeat(801) }]) {
    assert.equal(validateCommand({ api_version: 1, operation: 'approval.resolve', request_id: 'r1', client_id: 'c1', boot_epoch: 'b',
      session_id: 'session_1', params: { ...params, ...extra } }).ok, false, JSON.stringify(extra));
  }
});

test('peekApproval names the call id and peekQuestions the question batch\'s call id', () => {
  const { backend } = approvalBackend();
  backend.pendingUserQuestions = new Map([['questions_1', { questionRef: 'questions_1', sessionId: 'session_1', streamId: 'stream_1',
    callId: 'call_q', questions: [] }]]);
  const adapter = createDecisionAdapter({ backend });
  const revision = adapter.listApprovals('session_1', 'stream_1')[0].decision_revision;
  assert.deepEqual(adapter.peekApproval({ sessionId: 'session_1', streamId: 'stream_1', approvalId: 'approval_1',
    decisionRevision: revision }), { toolName: 'shell', callId: 'call_1' });
  assert.deepEqual(adapter.peekQuestions({ sessionId: 'session_1', streamId: 'stream_1', questionRef: 'questions_1' }), { callId: 'call_q' });
  assert.equal(adapter.peekQuestions({ sessionId: 'session_1', streamId: 'stream_1', questionRef: 'questions_2' }), null);
});
