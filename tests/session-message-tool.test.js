'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tool = require('../services/tools/builtin/session-message-tool');
const os = require('node:os');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const protocol = require('../services/session-runtime/inference-protocol');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { buildManagedSidecarChatSendOptions, executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { waitForApproval } = require('../services/backend/chat-stream-tool-approval');
const { normalizePersistedToolResultMetadata } = require('../services/backend/tool-result-diff-metadata');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');

const DESTINATION = { session_id: 'dest', title: 'Recipient', project_label: 'Project' };
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const HASH = 'a'.repeat(64);

function harness({ grant = null, supported = true, authorize = null, replay = null } = {}) {
  const project = { project_id: 'project', root_path: os.tmpdir(), root_id: 'root', root_revision: 1,
    device_id: 'device', inode: 'inode' };
  const summary = { id: 'source', run_mode: 'auto', plan_mode: false };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: captured => captured,
      _sessionStore: { getSessionSummary: () => summary } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('source', { requestId: 'stream', mode: 'assist', approvalMode: 'auto' });
  const client = { process: {} };
  protocol.completeRuntimeInferenceInitialization(client, protocol.beginRuntimeInferenceInitialization(client), {
    runtime_inference_admission_version: 1, chat_workspace_version: 1,
    chat_workspace_capabilities: { schema_version: 1, producer_tools: [], context_kinds: ['session_message'], session_messages: supported },
  });
  const calls = { prepare: [], send: [], cancel: [], read: [], targets: [] };
  const prepared = { ok: true, operation_id: OPERATION_ID, envelope_sha256: HASH, state: 'prepared', grant, destination: DESTINATION,
    ...(replay ? { created: false, state: replay } : {}) };
  const service = {
    sidecarClient: client, sessionExecutionAuthority: authority,
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) },
    chatMessages: {
      async agentPrepare(args) { calls.prepare.push(args); return prepared; },
      async agentSend(args) { calls.send.push(args); return { ok: true, operation: { state: 'delivered', envelope: { private: true } } }; },
      async agentCancel(args) { calls.cancel.push(args); return { ok: true }; },
      async agentRead(args) { calls.read.push(args); return { ok: true, envelope: { body: 'included' } }; },
      async listAgentTargets(args) { calls.targets.push(args); return { ok: true, targets: [{ ...DESTINATION,
        free_form_allowed: true, purpose: 'private purpose', grant: { grant_id: 'grant', purpose: 'private purpose',
          consent_event_id: 'private consent', expires_at: '2026-10-22T00:00:00.000Z', remaining_sends: 3 } }] }; },
    },
  };
  service.toolExecutor = new ToolExecutor({ registry: createDefaultRegistry(),
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) }, pathPolicy: {}, logger: () => {} });
  const context = { sessionId: 'source', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call', backendService: service, executionAuthority, authorize, mode: 'auto',
    abortSignal: new AbortController().signal };
  return { service, context, calls, prepared };
}

const sendInput = body => ({ action: 'send', destination_session_id: 'dest', body });
const output = result => JSON.parse(result.content);

test('session_message rejects unknown actions and extra keys before service work', async () => {
  for (const input of [{ action: 'unknown' }, { action: 'list_targets', body: 'extra' },
    { action: 'send', destination_session_id: 'dest', body: 'hello', grant_id: 'forged' },
    { action: 'send', destination_session_id: 'dest' }, { action: 'read' },
    { action: 'read', message_id: 'message', extra: true }, sendInput('é'.repeat(8193)), sendInput('bad\u0000body')]) {
    const result = await tool.execute(input, {});
    assert.deepEqual(JSON.parse(result.content), { ok: false, reason: 'invalid_request' });
    assert.equal(result.isError, false);
  }
});

test('list_targets hides purpose, grant identity and consent while retaining bounds', async () => {
  const { context, calls } = harness();
  const result = output(await tool.execute({ action: 'list_targets' }, context));
  assert.deepEqual(result, { ok: true, targets: [{ ...DESTINATION, free_form_allowed: true,
    grant: { expires_at: '2026-10-22T00:00:00.000Z', remaining_sends: 3 } }] });
  assert.deepEqual(calls.targets, [{ sourceSessionId: 'source', sourceIncarnation: 'incarnation' }]);
});

test('read delegates to the included-inbox reader and preserves its refusal', async () => {
  const { service, context, calls } = harness();
  assert.deepEqual(output(await tool.execute({ action: 'read', message_id: 'included' }, context)),
    { ok: true, envelope: { body: 'included' } });
  assert.deepEqual(calls.read, [{ sourceSessionId: 'source', sourceIncarnation: 'incarnation', messageId: 'included' }]);
  service.chatMessages.agentRead = async () => ({ ok: false, reason: 'not_found' });
  assert.equal(output(await tool.execute({ action: 'read', message_id: 'queued' }, context)).reason, 'not_found');
});

test('a prepared live grant sends once without authorization', async () => {
  const { context, calls } = harness({ grant: { grant_id: 'grant' }, authorize: () => assert.fail('must not ask') });
  assert.deepEqual(output(await tool.execute(sendInput('hello'), context)),
    { ok: true, operation_id: OPERATION_ID, state: 'delivered', destination: DESTINATION });
  assert.deepEqual(calls.prepare, [{ sourceSessionId: 'source', sourceIncarnation: 'incarnation', turnId: 'turn',
    toolCallId: 'call', destinationSessionId: 'dest', body: 'hello' }]);
  assert.deepEqual(calls.send, [{ sourceSessionId: 'source', operationId: OPERATION_ID,
    authorization: { kind: 'grant', grant_id: 'grant' } }]);
});

test('Auto still authorizes exact content once, and sends with the approval decision id', async () => {
  const body = 'full body\n'.repeat(1000);
  const approvals = [];
  const { context, calls } = harness({ authorize: async (payload, signal) => {
    approvals.push(payload);
    assert.equal(signal, context.abortSignal);
    return { approved: true, consent_event_id: 'decision' };
  } });
  await tool.execute(sendInput(body), context);
  assert.deepEqual(approvals, [{ tool_name: 'session_message', tool_call_id: 'call', tool_input: sendInput(body), one_off_only: true,
    messageFields: { session_message_approval: { schema_version: 1, operation_id: OPERATION_ID, destination: DESTINATION,
      body, envelope_sha256: HASH, one_off_only: true } } }]);
  assert.deepEqual(calls.send, [{ sourceSessionId: 'source', operationId: OPERATION_ID,
    authorization: { kind: 'once', consent_event_id: 'decision' } }]);
});

for (const [label, authorize] of [['deny', async () => ({ approved: false })],
  ['timeout', async () => { throw new Error('private timeout details'); }],
  ['missing consent id', async () => ({ approved: true })], ['no callback', null]]) {
  test(`${label} cancels the prepared send and returns authorization_required normally`, async () => {
    const { context, calls } = harness({ authorize });
    const result = await tool.execute(sendInput('hello'), context);
    assert.deepEqual(output(result), { ok: false, reason: 'authorization_required' });
    assert.equal(result.isError, false);
    assert.deepEqual(calls.cancel, [{ sourceSessionId: 'source', operationId: OPERATION_ID }]);
    assert.equal(calls.send.length, 0);
  });
}

test('service reason tokens pass through while internal exceptions are hidden', async () => {
  const { context, service, calls } = harness();
  for (const reason of ['turn_send_limit', 'capacity', 'recipient_archived']) {
    service.chatMessages.agentPrepare = async () => ({ ok: false, reason });
    assert.deepEqual(output(await tool.execute(sendInput('hello'), context)), { ok: false, reason });
  }
  service.chatMessages.agentPrepare = async () => { throw new Error('private storage failure'); };
  assert.deepEqual(output(await tool.execute(sendInput('hello'), context)), { ok: false, reason: 'unavailable' });
  assert.equal(calls.send.length, 0);
});

test('unnegotiated and unbound calls do no service work', async () => {
  for (const bound of [false, true]) {
    const { context, calls } = harness({ supported: !bound });
    if (!bound) context.sessionId = '';
    assert.equal(output(await tool.execute({ action: 'list_targets' }, context)).ok, false);
    assert.equal(calls.targets.length, 0);
  }
});

test('Plan/read-only preflight allows list_targets and read, blocks send and undeclared actions', () => {
  const { context, service } = harness();
  for (const action of ['list_targets', 'read', 'send', 'unknown']) {
    const verdict = service.toolExecutor._preflightTool({ toolName: 'session_message', callId: 'call', input: { action } },
      { ...context, readOnly: true, planMode: true }, { preApproved: true });
    assert.equal(Boolean(verdict.tool), ['list_targets', 'read'].includes(action));
  }
});

test('real bridge and executor thread authorization and suspend idle and transport only while waiting', async () => {
  const { service, context, calls } = harness();
  const controller = new AbortController();
  const clocks = { idle: 0, transport: 0 };
  let decide;
  let approvalCount = 0;
  service.sidecarClient.suspendRequestTimeout = () => { clocks.transport++; return () => { clocks.transport--; }; };
  const options = buildManagedSidecarChatSendOptions({ service, controller, streamId: 'stream', resolvedSessionId: 'source',
    requestId: 'request', runtime: {}, executionAuthority: context.executionAuthority,
    turnIdentity: { turnId: 'turn', sessionIncarnation: 'incarnation' },
    pauseStreamIdleTimer: () => { clocks.idle++; return () => { clocks.idle--; }; },
    waitForToolApproval: async (_service, _stream, _session, _request, params) => {
      approvalCount++;
      assert.equal(params.messageFields.session_message_approval.body, 'exact body');
      assert.deepEqual(clocks, { idle: 1, transport: 1 });
      return new Promise(resolve => { decide = resolve; });
    },
  });
  const pending = options.onElectronToolRequest({ tool_name: 'session_message', tool_call_id: 'call',
    arguments: sendInput('exact body'), plan_mode: false, read_only: false });
  for (let attempt = 0; !decide && attempt < 50; attempt++) await new Promise(resolve => setImmediate(resolve));
  if (!decide) assert.fail(`Approval never reached: ${JSON.stringify(await pending)}`);
  assert.deepEqual(clocks, { idle: 1, transport: 1 });
  decide({ approved: true, decision: 'approved', consent_event_id: 'decision' });
  const result = await pending;
  assert.equal(result.success, true, result.output);
  assert.equal(calls.send.length, 1);
  assert.equal(approvalCount, 1);
  assert.deepEqual(clocks, { idle: 0, transport: 0 });
});

test('approval presentation and canonical receipt preserve full body and return the resolved event id', async () => {
  const body = 'untruncated content\n'.repeat(700);
  const events = [];
  const notices = [];
  const service = { currentModel: 'model', pendingToolApprovals: new Map(),
    sessionStore: { appendMessage() {}, updateMessage() {} }, emit: (_channel, payload) => notices.push(payload) };
  const pending = waitForApproval(service, 'stream', 'source', 'request', {
    tool_name: 'session_message', tool_call_id: 'call', tool_input: sendInput(body), one_off_only: true,
    messageFields: { session_message_approval: { schema_version: 1, operation_id: OPERATION_ID,
      destination: DESTINATION, body, envelope_sha256: HASH, one_off_only: true } },
  }, new AbortController(), { turnId: 'turn', noteEvent: event => events.push(event) }, null,
  () => assert.fail('session_message denial returns its own normal result'));
  const card = notices.find(event => event.type === 'tool_approval_needed');
  assert.equal(card.session_message_approval.body, body);
  assert.ok(JSON.stringify(card.input).length < body.length);
  assert.ok(events.some(event => event.payload?.session_message_approval?.body === body));
  [...service.pendingToolApprovals.values()][0].resolve(true, 'approved');
  const decision = await pending;
  assert.equal(decision.approved, true);
  assert.equal(events.find(event => event.type === 'tool_approval_resolved')?.event_id, decision.consent_event_id);
});

test('hosted and Docker sandbox bridges refuse session_message', async () => {
  for (const service of [{ hostMode: 'server' }, { commandSandbox: { enabled: true } }]) {
    const result = await executeElectronToolRequest(service, { params: { tool_name: 'session_message' } });
    assert.equal(result.success, false);
    assert.match(result.output, /hosted|Docker sandbox/);
  }
});

test('persisted receipt metadata is closed and bounded, and only for the marked tool', () => {
  assert.deepEqual(normalizePersistedToolResultMetadata({ result_kind: 'session_message', action: 'send', ok: true, operation_id: OPERATION_ID,
    destination: { ...DESTINATION, incarnation: 'private' }, state: 'delivered', body: 'private', grant_id: 'private' }),
  { result_kind: 'session_message', action: 'send', ok: true, operation_id: OPERATION_ID,
    destination: { session_id: 'dest', title: 'Recipient' }, state: 'delivered' });
  // Another tool whose raw metadata happens to look alike is not rewritten.
  assert.equal(normalizePersistedToolResultMetadata({ action: 'send', ok: true, state: 'delivered' })?.state, undefined);
});

test('the real approval timeout cancels preparation and returns a normal authorization_required result', async t => {
  let fireTimeout;
  const modulePath = require.resolve('../services/backend/chat-stream-tool-approval');
  const saved = require.cache[modulePath];
  t.after(() => { require.cache[modulePath] = saved; });
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 600000);
    fireTimeout = callback;
    return { unref() {} };
  });
  t.mock.method(global, 'clearTimeout', () => {});
  delete require.cache[modulePath];
  const timed = require(modulePath).waitForApproval;
  const { service, context, calls } = harness();
  Object.assign(service, { pendingToolApprovals: new Map(), emit() {} });
  Object.assign(service.sessionStore, { appendMessage() {}, updateMessage() {} });
  context.authorize = params => timed(service, 'stream', 'source', 'request', params,
    new AbortController(), null, null, () => assert.fail('normal tool result owns denial'));
  const pending = tool.execute(sendInput('exact body'), context);
  for (let attempt = 0; !fireTimeout && attempt < 50; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof fireTimeout, 'function');
  fireTimeout();
  assert.deepEqual(output(await pending), { ok: false, reason: 'authorization_required' });
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.send.length, 0);
  assert.equal(service.pendingToolApprovals.size, 0);
});

test('a maximum-size JSON-escaped body survives the actual approval journal unchanged', async () => {
  const body = '"\\\n\t'.repeat(4096);
  assert.equal(Buffer.byteLength(body), 16384);
  const journaled = [];
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn', sessionId: 'source',
    journal: { append: (_session, _turn, events) => journaled.push(...events) } });
  const service = { pendingToolApprovals: new Map(), emit() {}, sessionStore: { appendMessage() {}, updateMessage() {} } };
  const pending = waitForApproval(service, 'stream', 'source', 'request', {
    tool_name: 'session_message', tool_call_id: 'call', tool_input: sendInput(body), one_off_only: true,
    messageFields: { session_message_approval: { schema_version: 1, operation_id: OPERATION_ID,
      destination: DESTINATION, body, envelope_sha256: HASH, one_off_only: true } },
  }, new AbortController(), collector, null, () => {});
  const captured = journaled.find(event => event.kind === 'tool_use' && event.status === 'pending_approval');
  const canonical = journaled.find(event => event.kind === 'approval_requested');
  [...service.pendingToolApprovals.values()][0].resolve(false, 'denied');
  await pending;
  assert.equal(captured?.payload?.session_message_approval?.body, body);
  // The canonical request stays sequenced (continuation proofs) and carries identity, never the body.
  assert.ok(Number.isSafeInteger(canonical?.payload?.canonical_seq) && canonical.payload.canonical_seq > 0);
  assert.equal(canonical.payload.session_message_approval.envelope_sha256, HASH);
  assert.equal(Object.hasOwn(canonical.payload.session_message_approval, 'body'), false);
});

test('only an explicit approved decision is consent for a message send', async () => {
  for (const decision of ['rejected', 'accepted', 'approved_auto']) {
    const service = { currentModel: 'model', pendingToolApprovals: new Map(), emit() {},
      sessionStore: { appendMessage() {}, updateMessage() {} } };
    const pending = waitForApproval(service, 'stream', 'source', 'request', {
      tool_name: 'session_message', tool_call_id: 'call', tool_input: sendInput('hi'), one_off_only: true,
      messageFields: { session_message_approval: { schema_version: 1, operation_id: OPERATION_ID,
        destination: DESTINATION, body: 'hi', envelope_sha256: HASH, one_off_only: true } },
    }, new AbortController(), { turnId: 'turn', noteEvent() {} }, null, () => {});
    [...service.pendingToolApprovals.values()][0].resolve(true, decision);
    assert.equal((await pending).approved, false, decision);
  }
});

test('an approval bookkeeping failure never authorizes a send without a durable decision', async () => {
  const { service, context, calls } = harness();
  Object.assign(service, { pendingToolApprovals: new Map(), emit() {} });
  Object.assign(service.sessionStore, { appendMessage() {}, updateMessage() { throw new Error('private write failure'); } });
  context.authorize = params => waitForApproval(service, 'stream', 'source', 'request', params,
    new AbortController(), null, null, () => {});
  const pending = tool.execute(sendInput('exact body'), context);
  for (let attempt = 0; !service.pendingToolApprovals.size && attempt < 50; attempt++) await new Promise(resolve => setImmediate(resolve));
  [...service.pendingToolApprovals.values()][0].resolve(true, 'approved');
  assert.deepEqual(output(await pending), { ok: false, reason: 'authorization_required' });
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.send.length, 0);
});

test('a replayed call never asks again: a sent operation reports its state, a refused one stays refused', async () => {
  for (const [state, expected] of [['pending', { ok: true, operation_id: OPERATION_ID, state: 'pending', destination: DESTINATION }],
    ['delivered', { ok: true, operation_id: OPERATION_ID, state: 'delivered', destination: DESTINATION }],
    ['cancelled', { ok: false, reason: 'authorization_required' }], ['failed', { ok: false, reason: 'stale_operation' }]]) {
    const { context, calls } = harness({ replay: state, authorize: () => assert.fail('a replay must not ask') });
    assert.deepEqual(output(await tool.execute(sendInput('hello'), context)), expected, state);
    assert.equal(calls.send.length, 0, state);
  }
});

test('a session_message approval request without a valid exact presentation is refused before any prompt', async () => {
  for (const messageFields of [undefined, {}, { session_message_approval: { schema_version: 1, operation_id: OPERATION_ID,
    destination: DESTINATION, body: 'hi', envelope_sha256: 'not-a-hash', one_off_only: true } }]) {
    const notices = [];
    const service = { currentModel: 'model', pendingToolApprovals: new Map(), emit: (_channel, payload) => notices.push(payload),
      sessionStore: { appendMessage() {}, updateMessage() {} } };
    const decision = await waitForApproval(service, 'stream', 'source', 'request', {
      tool_name: 'session_message', tool_call_id: 'call', tool_input: sendInput('hi'), one_off_only: true, messageFields,
    }, new AbortController(), { turnId: 'turn', noteEvent() {} }, null, () => {});
    assert.equal(decision, false);
    assert.equal(service.pendingToolApprovals.size, 0);
    assert.equal(notices.some((event) => event.type === 'tool_approval_needed'), false);
  }
});
