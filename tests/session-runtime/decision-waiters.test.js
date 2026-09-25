'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeDecisionControl, projectDecisionPause } = require('../../services/backend/runtime-decision-control');
const { waitForToolApproval } = require('../../services/backend/chat-stream-tool-handling');
const { approveToolCall, denyToolCall } = require('../../services/backend/backend-chat-stream');

function fixture() {
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1', authority_revision: 'authority_1' };
  const context = { schema_version: 1, work_id: 'work_1', turn_id: 'turn_1', source_attempt: attempt,
    authority: { project_id: 'project_1', root_id: null, root_revision: 0, sha256: 'a'.repeat(64) },
    route: { route_id: 'route_1', route_revision: 'config:1', sha256: 'b'.repeat(64) } };
  const work = { status: 'running', work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', attempt };
  const controller = new AbortController();
  const calls = { messages: [], updates: [], policies: [], events: [] };
  const service = { sessionStore: {
    appendMessage(_session, message) { calls.messages.push(message); },
    updateMessage(_session, _id, patch) { calls.updates.push(patch); },
  }, pendingToolApprovals: new Map(), currentModel: 'fixture',
  emit(channel, payload) { calls.events.push([channel, payload]); },
  toolPermissionStore: { setPolicy(...args) { calls.policies.push(args); } } };
  const control = createRuntimeDecisionControl({ context, sessionId: 'session_1', signal: controller.signal,
    getCurrentWork: () => work, assertCurrent: () => true });
  controller._runtimeDecisionControl = control;
  const decision = { kind: 'approval', decision_id: 'decision_1', call_id: 'call_1', execution_started: false };
  const start = () => waitForToolApproval(service, 'stream_1', 'session_1', 'stream_1', {
    tool_name: 'read_file', tool_call_id: 'call_1', tool_input: { path: 'file.txt' }, runtime_decision: decision,
  }, controller);
  const withdrawn = () => calls.events.filter(([, payload]) => payload?.type === 'tool_approval_withdrawn');
  return { work, controller, calls, service, control, decision, start, withdrawn };
}

test('pause removes the exact approval without a denial result or always-allow mutation', async () => {
  const f = fixture();
  const waiting = f.start();
  const [oldRef] = f.service.pendingToolApprovals.keys();
  assert.equal(f.control.requestPause(), false, 'pause must be durable first');
  assert.equal(approveToolCall(f.service, 'call_1', { alwaysAllow: true }), false, 'runtime decisions require exact references');
  f.work.control_request = { kind: 'pause' };
  assert.equal(f.control.requestPause(), true);
  const paused = await waiting;
  assert.deepEqual(projectDecisionPause(paused), { schema_version: 1, request_id: 'stream_1', decision: f.decision });
  assert.equal(f.control.validate(f.decision), true);
  assert.equal(f.control.validate({ ...f.decision, decision_id: 'other' }), false);
  assert.equal(f.service.pendingToolApprovals.size, 0);
  assert.equal(approveToolCall(f.service, oldRef, { alwaysAllow: true }), false);
  assert.equal(denyToolCall(f.service, oldRef), false);
  assert.equal(f.calls.policies.length, 0);
  assert.equal(f.calls.updates.length, 0);
  assert.equal(f.calls.messages.filter(row => row.kind === 'tool_result').length, 0);
  assert.deepEqual(f.withdrawn(), [['chat-stream', { type: 'tool_approval_withdrawn', streamId: 'stream_1',
    turnId: 'stream_1', sessionId: 'session_1', callId: 'call_1', approvalId: oldRef, toolName: 'read_file',
    reason: 'runtime_pause' }]], 'the renderer is told the approval can no longer be answered');
  assert.equal(f.control.requestPause(), false);
});

test('an already-persisted pause suspends a newly installed approval waiter', async () => {
  const f = fixture();
  f.work.control_request = { kind: 'pause' };
  const result = await f.start();
  assert.ok(projectDecisionPause(result));
  assert.equal(f.service.pendingToolApprovals.size, 0);
  const types = f.calls.events.map(([, payload]) => payload?.type);
  assert.ok(types.indexOf('tool_approval_withdrawn') > types.indexOf('tool_approval_needed'),
    'the withdrawal follows the offer it withdraws');
});

test('cancellation wins and makes a suspended proof unusable', async () => {
  const f = fixture();
  const waiting = f.start();
  f.work.control_request = { kind: 'pause' };
  f.controller.abort();
  assert.equal(f.control.requestPause(), false);
  assert.equal(await waiting, false);
  assert.equal(f.control.validate(f.decision), false);
  assert.equal(f.service.pendingToolApprovals.size, 0);
  assert.deepEqual(f.withdrawn(), [], 'a cancelled approval settles through its own tool result');
  const other = fixture();
  const second = other.start();
  other.work.control_request = { kind: 'pause' };
  assert.equal(other.control.requestPause(), true);
  await second;
  other.work.control_request = { kind: 'cancel' };
  assert.equal(other.control.validate(other.decision), false);
});

test('normal exact approval still settles and detaches from decision pause', async () => {
  const f = fixture();
  const waiting = f.start();
  const [ref] = f.service.pendingToolApprovals.keys();
  assert.equal(approveToolCall(f.service, ref), true);
  assert.equal(await waiting, true);
  f.work.control_request = { kind: 'pause' };
  assert.equal(f.control.requestPause(), false);
  assert.deepEqual(f.withdrawn(), []);
});

test('a copied or tool-authored pause object cannot cross the typed control boundary', async () => {
  const f = fixture();
  f.work.control_request = { kind: 'pause' };
  const result = await f.start();
  assert.equal(projectDecisionPause(structuredClone(result)), null);
  assert.equal(projectDecisionPause({ payload: { schema_version: 1, decision: f.decision } }), null);
  assert.equal(projectDecisionPause(null), null);
});


test('the approval transport emits the branded pause separately from a consent response', async () => {
  const { SidecarClient } = require('../../services/backend/sidecar-client');
  const f = fixture();
  const client = new SidecarClient();
  const frames = [];
  client._writeFrame = frame => frames.push(frame);
  client.approvalHandlers.set('stream_1', () => f.start());
  const pending = client._handleApprovalRequest({ id: 100001, params: {
    request_id: 'stream_1', tool_call_id: 'call_1', tool_name: 'read_file',
  } });
  f.work.control_request = { kind: 'pause' };
  assert.equal(f.control.requestPause(), true);
  await pending;
  assert.deepEqual(frames[0].result, { runtime_decision_pause: {
    schema_version: 1, request_id: 'stream_1', decision: f.decision,
  } });
  assert.equal(Object.hasOwn(frames[0].result, 'approved'), false);
  client.approvalHandlers.set('stream_1', () => ({ runtime_decision_pause: frames[0].result.runtime_decision_pause }));
  await client._handleApprovalRequest({ id: 100002, params: { request_id: 'stream_1' } });
  assert.deepEqual(frames[1].result, { approved: false });
});


function questionFixture() {
  const f = fixture();
  f.service.pendingUserQuestions = new Map();
  let resumed = 0;
  f.service.sidecarClient = { suspendRequestTimeout: () => () => { resumed += 1; } };
  f.decision = { ...f.decision, kind: 'user_questions', execution_started: true };
  const tool = require('../../services/tools/builtin/ask-user-tool');
  f.startQuestion = () => tool.execute({ questions: [{ id: 'choice', prompt: 'Continue?' }] }, {
    backendService: f.service, sessionId: 'session_1', streamId: 'stream_1', callId: 'call_1',
    abortSignal: f.controller.signal, runtimeDecision: f.decision, runtimeDecisionControl: f.control,
  });
  f.resumed = () => resumed;
  return f;
}

test('question suspension invalidates the exact waiter without an answer or decline result', async () => {
  const { answerUserQuestions, declineUserQuestions } = require('../../services/backend/backend-chat-stream');
  const f = questionFixture();
  const waiting = f.startQuestion();
  const [reference] = f.service.pendingUserQuestions.keys();
  assert.equal(answerUserQuestions(f.service, 'call_1', { answers: [] }), false);
  assert.equal(declineUserQuestions(f.service, 'call_1'), false);
  assert.equal(f.control.requestPause(), false);
  f.work.control_request = { kind: 'pause' };
  assert.equal(f.control.requestPause(), true);
  await assert.rejects(waiting, value => {
    assert.deepEqual(projectDecisionPause(value)?.decision, f.decision);
    return true;
  });
  assert.equal(f.service.pendingUserQuestions.size, 0);
  assert.equal(answerUserQuestions(f.service, reference, { answers: [] }), false);
  assert.equal(declineUserQuestions(f.service, reference), false);
  assert.equal(f.resumed(), 1);
  assert.equal(f.control.validate(f.decision), true);
});

test('normal answer and cancellation detach the question pause offer', async () => {
  const { answerUserQuestions } = require('../../services/backend/backend-chat-stream');
  for (const cancel of [false, true]) {
    const f = questionFixture();
    const waiting = f.startQuestion();
    const [reference] = f.service.pendingUserQuestions.keys();
    if (cancel) f.controller.abort();
    else assert.equal(answerUserQuestions(f.service, reference,
      { answers: [{ id: 'choice', value: 'Continue' }] }), true);
    const result = await waiting;
    assert.equal(result.metadata.result_kind, cancel ? 'user_questions_declined' : 'user_questions_answered');
    f.work.control_request = { kind: 'pause' };
    assert.equal(f.control.requestPause(), false);
    assert.equal(f.resumed(), 1);
  }
});

test('question reverse RPC projects only a branded pause to its original producer', async () => {
  const { handleElectronToolRequest } = require('../../services/backend/sidecar-client-request-rpc');
  for (const replaceProducer of [false, true]) {
    const f = questionFixture();
    const frames = [];
    const client = { process: {}, electronToolHandlers: new Map([['stream_1', f.startQuestion]]),
      _batch4TransportEnabled: () => false, _writeFrame: frame => frames.push(frame) };
    const waiting = handleElectronToolRequest(client, { id: 42,
      params: { request_id: 'stream_1', tool_name: 'ask_user' } });
    const reference = [...f.service.pendingUserQuestions.keys()][0];
    assert.ok(reference);
    f.work.control_request = { kind: 'pause' };
    assert.equal(f.control.requestPause(), true);
    if (replaceProducer) client.process = {};
    await waiting;
    assert.equal(frames.length, replaceProducer ? 0 : 1);
    if (!replaceProducer) assert.deepEqual(frames[0], { jsonrpc: '2.0', id: 42,
      result: { runtime_decision_pause: { schema_version: 1, request_id: 'stream_1', decision: f.decision } } });
  }
});
