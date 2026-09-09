'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../services/remote/remote-policy');
const { createRemoteDecisionAdapter } = require('../services/remote/remote-decision-adapter');
const askUserTool = require('../services/tools/builtin/ask-user-tool');
const exitPlanModeTool = require('../services/tools/builtin/exit-plan-mode-tool');

function approval(overrides = {}) {
  return {
    approvalId: 'approval_1',
    streamId: 'stream_1',
    sessionId: 'session_1',
    requestId: 'stream_1',
    callId: 'call_1',
    toolName: 'read_file',
    toolInput: { path: 'README.md' },
    policyScope: '',
    policyConsequence: '',
    resolve() {},
    ...overrides,
  };
}

function question(overrides = {}) {
  return {
    questionId: 'batch_1',
    questionRef: 'question_1',
    sessionId: 'session_1',
    streamId: 'stream_1',
    callId: 'call_questions',
    questions: askUserTool.normalizeQuestions({ questions: [{
      id: 'color',
      prompt: 'Pick a color',
      options: ['red', 'blue'],
      multi_select: false,
      allow_other: false,
    }] }),
    resolve() {},
    ...overrides,
  };
}

function createBackend() {
  const backend = {
    pendingToolApprovals: new Map(),
    pendingUserQuestions: new Map(),
    sessionStore: {
      getSession: () => ({ id: 'session_1', session_type: 'chat', archived_at: null }),
    },
    approvals: [],
    denials: [],
    answers: [],
    declines: [],
  };
  backend.approveToolCall = (id, options) => {
    if (!backend.pendingToolApprovals.has(id)) return false;
    backend.approvals.push({ id, options });
    backend.pendingToolApprovals.delete(id);
    return true;
  };
  backend.denyToolCall = (id) => {
    if (!backend.pendingToolApprovals.has(id)) return false;
    backend.denials.push(id);
    backend.pendingToolApprovals.delete(id);
    return true;
  };
  backend.answerUserQuestions = (ref, payload) => {
    if (!backend.pendingUserQuestions.has(ref)) return false;
    backend.answers.push({ ref, payload });
    backend.pendingUserQuestions.delete(ref);
    return true;
  };
  backend.declineUserQuestions = (ref) => {
    if (!backend.pendingUserQuestions.has(ref)) return false;
    backend.declines.push(ref);
    backend.pendingUserQuestions.delete(ref);
    return true;
  };
  return backend;
}

function createAdapter(backend) {
  return createRemoteDecisionAdapter({
    backendService: backend,
    featureFlags: () => ({}),
    policy,
    contracts: require('../services/remote/remote-contracts'),
  });
}

function decision(overrides = {}) {
  return {
    sessionId: 'session_1',
    streamId: 'stream_1',
    approvalId: 'approval_1',
    decisionRevision: 1,
    decision: 'approve_once',
    lease: { session_id: 'session_1', device_id: 'device_1' },
    deviceId: 'device_1',
    ...overrides,
  };
}

test('pending approvals are narrowly projected and revisions follow entry identity', () => {
  const backend = createBackend();
  const first = approval();
  backend.pendingToolApprovals.set(first.approvalId, first);
  const adapter = createAdapter(backend);

  const pending = adapter.pendingFor('session_1').tool[0];
  assert.deepEqual(pending, {
    approval_id: 'approval_1',
    stream_id: 'stream_1',
    call_id: 'call_1',
    tool_name: 'read_file',
    decision_revision: 1,
    classification: 'phone_ok',
    facts: {
      tool_name: 'read_file',
      summary: 'Read README.md',
      policy_scope: '',
      policy_consequence: '',
    },
  });
  assert.equal(adapter.pendingFor('session_1').tool[0].decision_revision, 1);
  backend.pendingToolApprovals.set('approval_1', approval({ toolInput: { path: 'NEXT_STEPS.md' } }));
  assert.equal(adapter.pendingFor('session_1').tool[0].decision_revision, 2);
});

test('approval revisions use one adapter-wide monotonic sequence after live-map pruning', () => {
  const backend = createBackend();
  backend.pendingToolApprovals.set('approval_1', approval());
  backend.pendingToolApprovals.set('approval_2', approval({ approvalId: 'approval_2', callId: 'call_2' }));
  const adapter = createAdapter(backend);
  assert.deepEqual(
    adapter.pendingFor('session_1').tool.map((entry) => entry.decision_revision),
    [1, 2]
  );
  backend.pendingToolApprovals.clear();
  assert.deepEqual(adapter.pendingFor('session_1'), { tool: [], questions: [], plan: [] });
  backend.pendingToolApprovals.set('approval_1', approval());
  assert.equal(adapter.pendingFor('session_1').tool[0].decision_revision, 3);
});

test('tool decisions require exact approval id, session, stream, lease, and revision', () => {
  const backend = createBackend();
  backend.pendingToolApprovals.set('approval_1', approval());
  const adapter = createAdapter(backend);
  adapter.pendingFor('session_1');

  assert.equal(adapter.decideTool(decision({ approvalId: 'call_1' })).error, 'stale_approval');
  assert.equal(adapter.decideTool(decision({ sessionId: 'session_2' })).error, 'unauthorized');
  assert.equal(adapter.decideTool(decision({ streamId: 'stream_2' })).error, 'stale_approval');
  assert.equal(adapter.decideTool(decision({ decisionRevision: 2 })).error, 'stale_approval');
  assert.equal(adapter.decideTool(decision({ deviceId: 'device_2' })).error, 'unauthorized');
  assert.equal(backend.pendingToolApprovals.has('approval_1'), true);
});

test('desktop-only classification comes from the tool class, never from consequence copy', () => {
  for (const toolName of ['delete_file', 'move_file', 'run_command', 'run_temp_script', 'python_execute']) {
    const backend = createBackend();
    backend.pendingToolApprovals.set('approval_1', approval({ toolName }));
    const adapter = createAdapter(backend);
    const projected = adapter.pendingFor('session_1').tool[0];
    assert.equal(projected.classification, 'desktop_only', toolName);
    assert.equal(adapter.decideTool(decision()).error, 'desktop_only', toolName);
  }
  // Ordinary approval copy (scope + consequence) does not move authority.
  const backend = createBackend();
  backend.pendingToolApprovals.set('approval_1', approval({
    policyScope: 'workspace', policyConsequence: 'May read data in this scope.', reason: 'file_safety',
  }));
  const adapter = createAdapter(backend);
  const projected = adapter.pendingFor('session_1').tool[0];
  assert.equal(projected.classification, 'phone_ok');
  assert.equal(projected.facts.policy_consequence, 'May read data in this scope.');
  // Missing or non-object tool input keeps the decision on desktop.
  const incomplete = createBackend();
  incomplete.pendingToolApprovals.set('approval_1', approval({ toolInput: null }));
  assert.equal(createAdapter(incomplete).pendingFor('session_1').tool[0].classification, 'desktop_only');
});

test('approval facts use canonical redaction and incomplete sanitized facts stay desktop-only', () => {
  const backend = createBackend();
  backend.pendingToolApprovals.set('approval_1', approval({
    toolInput: { path: 'C:\\Users\\private\\secret.txt', api_key: 'sk-abcdefghijklmnop' },
  }));
  const projected = createAdapter(backend).pendingFor('session_1').tool[0];
  assert.equal(projected.classification, 'desktop_only');
  assert.match(projected.facts.summary, /\[redacted:path\]/);
  assert.doesNotMatch(JSON.stringify(projected), /Users|sk-abcdefghijklmnop/);

  const truncated = createBackend();
  truncated.pendingToolApprovals.set('approval_1', approval({
    toolInput: { command: 'x'.repeat(3000) },
  }));
  assert.equal(createAdapter(truncated).pendingFor('session_1').tool[0].classification, 'desktop_only');
});

test('approve once and deny use only the canonical one-off backend calls', () => {
  const approvedBackend = createBackend();
  approvedBackend.pendingToolApprovals.set('approval_1', approval());
  const approved = createAdapter(approvedBackend);
  approved.pendingFor('session_1');
  assert.equal(approved.decideTool(decision()).ok, true);
  assert.deepEqual(approvedBackend.approvals, [{
    id: 'approval_1', options: { decision: 'approved' },
  }]);

  const deniedBackend = createBackend();
  deniedBackend.pendingToolApprovals.set('approval_1', approval());
  const denied = createAdapter(deniedBackend);
  denied.pendingFor('session_1');
  assert.equal(denied.decideTool(decision({ decision: 'deny' })).ok, true);
  assert.deepEqual(deniedBackend.denials, ['approval_1']);
});

test('plan approve and revise map to exact existing decision payloads', () => {
  const planInput = {
    title: 'Remote slice', summary: 'Use canonical seams.', steps: ['Inspect', 'Implement'],
    notes: 'Keep the lease.', verification: 'Run focused tests.',
  };
  const approveBackend = createBackend();
  approveBackend.pendingToolApprovals.set('approval_1', approval({
    toolName: 'exit_plan_mode', toolInput: planInput,
  }));
  const approve = createAdapter(approveBackend);
  assert.deepEqual(approve.pendingFor('session_1').plan[0].facts.plan, planInput);
  assert.equal(approve.decidePlan(decision({ decision: 'approve' })).ok, true);
  assert.deepEqual(approveBackend.approvals[0].options, { decision: 'approved' });

  const reviseBackend = createBackend();
  reviseBackend.pendingToolApprovals.set('approval_1', approval({
    toolName: 'exit_plan_mode', toolInput: planInput,
  }));
  const revise = createAdapter(reviseBackend);
  revise.pendingFor('session_1');
  assert.equal(revise.decidePlan(decision({
    decision: 'revise', feedback: 'Reuse the actor lease.',
  })).ok, true);
  assert.deepEqual(reviseBackend.approvals[0].options, {
    decision: 'rejected', feedback: 'Reuse the actor lease.',
  });
});

test('plan projection is canonical and any clamped or redacted consequential field is desktop-only', () => {
  const backend = createBackend();
  backend.pendingToolApprovals.set('approval_1', approval({
    toolName: 'exit_plan_mode',
    toolInput: {
      title: 'Plan', summary: 'Summary', steps: ['Inspect'], notes: '', verification: 'Test',
    },
  }));
  const projected = createAdapter(backend).pendingFor('session_1').plan[0];
  assert.deepEqual(projected.facts.plan, exitPlanModeTool.normalizePlan(backend.pendingToolApprovals.get('approval_1').toolInput));
  assert.equal(projected.classification, 'phone_ok');

  const oversized = createBackend();
  oversized.pendingToolApprovals.set('approval_1', approval({
    toolName: 'exit_plan_mode',
    toolInput: { title: 'x'.repeat(exitPlanModeTool.LIMITS.title + 1), steps: ['One'] },
  }));
  assert.equal(createAdapter(oversized).pendingFor('session_1').plan[0].classification, 'desktop_only');

  const redacted = createBackend();
  redacted.pendingToolApprovals.set('approval_1', approval({
    toolName: 'exit_plan_mode',
    toolInput: { title: 'Plan', steps: ['Read C:\\Users\\private\\secret.txt'] },
  }));
  const redactedPlan = createAdapter(redacted).pendingFor('session_1').plan[0];
  assert.equal(redactedPlan.classification, 'desktop_only');
  assert.match(redactedPlan.facts.plan.steps[0], /\[redacted:path\]/);
});

test('question answers are validated against the exact live batch', () => {
  const backend = createBackend();
  backend.pendingUserQuestions.set('question_1', question());
  const adapter = createAdapter(backend);
  assert.deepEqual(adapter.pendingFor('session_1').questions[0], {
    question_ref: 'question_1',
    batch_id: 'batch_1',
    call_id: 'call_questions',
    questions: [{
      id: 'color', prompt: 'Pick a color',
      options: [{ id: 'red', label: 'red' }, { id: 'blue', label: 'blue' }],
      multi_select: false, allow_other: false,
    }],
  });
  const base = {
    sessionId: 'session_1', questionRef: 'question_1', batchId: 'batch_1',
    lease: { session_id: 'session_1', device_id: 'device_1' }, deviceId: 'device_1',
  };
  assert.equal(adapter.answerQuestions({ ...base, answers: [{ id: 'missing', value: 'red' }] }).error, 'invalid_request');
  assert.equal(adapter.answerQuestions({ ...base, answers: [{ id: 'color', value: 'green' }] }).error, 'invalid_request');
  const answers = [{ id: 'color', value: ' blue ' }];
  assert.equal(adapter.answerQuestions({ ...base, answers }).ok, true);
  assert.deepEqual(backend.answers, [{
    ref: 'question_1', payload: { answers: [{ id: 'color', value: 'blue' }] },
  }]);
});

test('question submissions mirror live ask-user normalization and bounds', () => {
  const backend = createBackend();
  const questions = askUserTool.normalizeQuestions({ questions: [
    { id: 'free', prompt: 'Describe it' },
    { id: 'multi', prompt: 'Pick values', options: ['a', 'b'], multi_select: true },
    { id: 'optional', prompt: 'May be omitted', options: ['yes'] },
  ] });
  backend.pendingUserQuestions.set('question_1', question({ questions }));
  const adapter = createAdapter(backend);
  const base = {
    sessionId: 'session_1', questionRef: 'question_1', batchId: 'batch_1',
    lease: { session_id: 'session_1', device_id: 'device_1' }, deviceId: 'device_1',
  };
  assert.equal(adapter.answerQuestions({ ...base, answers: [] }).error, 'invalid_request');
  assert.equal(adapter.answerQuestions({ ...base, answers: [{ id: 'free', value: '   ' }] }).error, 'invalid_request');
  assert.equal(adapter.answerQuestions({
    ...base, answers: [{ id: 'multi', value: ['a', 'b', 'a'] }],
  }).error, 'invalid_request');
  assert.equal(adapter.answerQuestions({
    ...base,
    answers: [{ id: 'free', value: ' details ' }, { id: 'multi', value: ['a', 'b'] }],
  }).ok, true);
  assert.deepEqual(backend.answers[0].payload.answers, [
    { id: 'free', value: 'details' }, { id: 'multi', value: ['a', 'b'] },
  ]);
});

test('question prompts and option labels are redacted from the live backend batch', () => {
  const backend = createBackend();
  backend.pendingUserQuestions.set('question_1', question({
    questions: askUserTool.normalizeQuestions({ questions: [{
      id: 'path', prompt: 'Open C:\\Users\\private\\secret.txt?',
      options: ['Bearer abcdefghijklmnop'],
    }] }),
  }));
  const projected = createAdapter(backend).pendingFor('session_1').questions[0];
  assert.match(projected.questions[0].prompt, /\[redacted:path\]/);
  assert.equal(projected.questions[0].options[0].label, '[redacted]');
  assert.doesNotMatch(JSON.stringify(projected), /Users|abcdefghijklmnop/);
});

test('real scoped approval ids up to 256 characters compare without truncation', () => {
  const backend = createBackend();
  const approvalId = `approval_${'a'.repeat(220)}`;
  const streamId = `stream_${'b'.repeat(180)}`;
  backend.pendingToolApprovals.set(approvalId, approval({ approvalId, streamId }));
  const adapter = createAdapter(backend);
  const pending = adapter.pendingFor('session_1').tool[0];
  assert.equal(pending.approval_id, approvalId);
  assert.equal(pending.stream_id, streamId);
  assert.equal(adapter.decideTool(decision({
    approvalId, streamId, decisionRevision: pending.decision_revision,
  })).ok, true);
});

test('backend decision errors expose a public code and redacted bounded detail', () => {
  const backend = createBackend();
  backend.pendingToolApprovals.set('approval_1', approval());
  backend.approveToolCall = () => {
    throw new Error('failed at C:\\Users\\private\\secret.txt token=sk-abcdefghijklmnop');
  };
  const adapter = createAdapter(backend);
  adapter.pendingFor('session_1');
  const result = adapter.decideTool(decision());
  assert.equal(result.reason, 'not_reachable');
  assert.match(result.detail, /\[redacted:path\]|\[redacted\]/);
  assert.doesNotMatch(result.detail, /Users|sk-abcdefghijklmnop/);
});

test('question decline settles the live ref and historical refs stay inert', () => {
  const backend = createBackend();
  backend.pendingUserQuestions.set('question_1', question());
  const adapter = createAdapter(backend);
  const input = {
    sessionId: 'session_1', questionRef: 'question_1', batchId: 'batch_1',
    lease: { session_id: 'session_1', device_id: 'device_1' }, deviceId: 'device_1',
  };
  assert.equal(adapter.declineQuestions(input).ok, true);
  assert.deepEqual(backend.declines, ['question_1']);
  assert.equal(adapter.declineQuestions(input).error, 'stale_approval');
});

test('already-settled approval ids cannot be replayed', () => {
  const backend = createBackend();
  backend.pendingToolApprovals.set('approval_1', approval());
  const adapter = createAdapter(backend);
  adapter.pendingFor('session_1');
  assert.equal(adapter.decideTool(decision()).ok, true);
  assert.equal(adapter.decideTool(decision()).error, 'stale_approval');
});
