'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { fullAutoApproves } = require('../services/backend/full-auto-gate');
const { SessionExecutionAuthority, getTrustedExecutionBinding } = require('../services/backend/session-execution-authority');

function harness({ armed = true, safetyMode = 'normal', config = undefined, ...extra } = {}) {
  const emitted = [];
  const updates = [];
  const service = {
    sessionStore: {
      appendMessage() {},
      updateMessage(_sessionId, _messageId, patch) { updates.push(patch); },
    },
    emit(_event, payload) { emitted.push(payload); },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    primaryFullAuto: { isArmed: (sessionId) => armed && sessionId === 'session-jenny' },
    configService: config === undefined ? { getChatUiState: () => ({ safetyMode }) } : config,
    ...extra,
  };
  return { service, emitted, updates };
}

// The real authority: the binding a turn carries is opaque, and only the trusted context answers.
function capture(approvalMode, summary = { id: 'session-jenny', run_mode: 'auto', plan_mode: false }) {
  const project = { project_id: 'p', root_path: os.tmpdir(), root_id: 'r', root_revision: 1, device_id: 'd', inode: 'i' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (current) => current, _sessionStore: { getSessionSummary: () => summary } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  return { authority, binding: authority.captureSession('session-jenny', { requestId: 'req-1', mode: 'assist', approvalMode }) };
}

const AUTO_TURN = capture('auto_run').binding;
const PROMPT_TURN = capture('prompt').binding;

function ask(service, { toolName = 'python_execute', input = { code: 'print(1)' }, authority = AUTO_TURN, sessionId = 'session-jenny', collector = null } = {}) {
  return waitForToolApproval(service, 'stream-1', sessionId, 'req-1',
    { tool_name: toolName, tool_call_id: 'call-1', tool_input: input }, new AbortController(), collector, authority);
}

const cardShown = (emitted) => emitted.some((event) => event.type === 'tool_approval_needed');

// A card must be waiting and answerable; settling it keeps the test from leaking a timer.
async function assertAsksAPerson(run, service, emitted) {
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(cardShown(emitted), true, 'the card is shown');
  const pending = [...service.pendingToolApprovals.values()];
  assert.equal(pending.length, 1, 'a person is being waited for');
  pending[0].resolve(false, 'denied');
  await run;
}

test('an armed Jenny chat in an Auto turn runs the call with no card and no waiter left', async () => {
  const { service, emitted, updates } = harness();
  const result = await ask(service);
  assert.equal(result, true);
  assert.equal(cardShown(emitted), false);
  assert.equal(emitted.some((event) => event.status === 'pending_approval'), false, 'no pending flash in the live row');
  assert.equal(service.pendingToolApprovals.size, 0);
  assert.equal(updates.at(-1).tool_call.approval_state, 'approved');
  const settled = emitted.find((event) => event.type === 'tool_use' && event.status === 'approved');
  assert.equal(settled.approvalScope, 'full_auto', 'the live row can name Full auto');
});

test('the audit record keeps one request and names Full auto on the resolution', async () => {
  const { service } = harness();
  const collector = new CanonicalTurnEventCollector({ turnId: 'stream-1', sessionId: 'session-jenny' });
  await ask(service, { collector });
  const requested = collector.capturedEvents.filter((event) => event.kind === 'approval_requested');
  const resolved = collector.capturedEvents.filter((event) => event.kind === 'approval_resolved');
  assert.equal(requested.length, 1, 'continuation proofs need exactly one request per call');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].payload.approval_state, 'approved');
  assert.equal(resolved[0].payload.approval_scope, 'full_auto');
});

for (const [name, options, askOptions] of [
  ['a prompt-mode turn in the armed chat, as a scheduled check or digest runs', {}, { authority: PROMPT_TURN }],
  ['a turn with no execution authority', {}, { authority: null }],
  ['an object that only claims to be an Auto turn', {}, { authority: { autoRun: true, capturedAutoRun: true } }],
  ['a chat that is not armed', { armed: false }, {}],
  ['another chat while Jenny is armed', {}, { sessionId: 'session-other' }],
  ['Paranoid safety mode', { safetyMode: 'paranoid' }, {}],
  ['an unknown safety mode', { safetyMode: 'surprise' }, {}],
  ['a missing config service', { config: null }, {}],
]) {
  test(`${name} still asks a person`, async () => {
    const { service, emitted } = harness(options);
    await assertAsksAPerson(ask(service, askOptions), service, emitted);
  });
}

test('a prompt turn that follows an Ask to Auto flip keeps asking', () => {
  const { service } = harness();
  const summary = { id: 'session-jenny', run_mode: 'ask', plan_mode: false };
  const { authority, binding } = capture('prompt', summary);
  summary.run_mode = 'auto';
  authority.requireCurrent(binding);
  assert.equal(getTrustedExecutionBinding(binding).autoRun, true, 'the flip took effect for plain Auto');
  assert.equal(fullAutoApproves(service, { toolName: 'python_execute', sessionId: 'session-jenny', executionAuthority: binding }), false);
});

test('a plan is never self-approved', () => {
  const { service } = harness();
  const call = { sessionId: 'session-jenny', executionAuthority: AUTO_TURN };
  assert.equal(fullAutoApproves(service, { ...call, toolName: 'python_execute' }), true);
  assert.equal(fullAutoApproves(service, { ...call, toolName: 'exit_plan_mode' }), false);
});

test('a throwing armed-state read asks a person', async () => {
  const { service, emitted } = harness({ primaryFullAuto: { isArmed() { throw new Error('boom'); } } });
  await assertAsksAPerson(ask(service), service, emitted);
});

test('a deny rule refuses before Full auto is considered', async () => {
  const { service, emitted } = harness({ primaryActionRules: { denial: () => ({ effect: 'deny', rule_id: 'r1' }) } });
  const result = await ask(service, { toolName: 'settings_change', input: { changes: [] } });
  assert.equal(result.approved, false);
  assert.equal(result.decision, 'app_refused');
  assert.equal(cardShown(emitted), false);
});

test('a card-only tool still prepares its card before it is approved', async () => {
  const prepared = [];
  const { service, emitted } = harness({
    primarySettings: { prepareCard: async (request) => { prepared.push(request); return { ok: true, rows: [] }; } },
  });
  const result = await ask(service, { toolName: 'settings_change', input: { changes: [{ key: 'a', value: 1 }] } });
  assert.equal(prepared.length, 1, 'the port remembers this call, or it would refuse at execute');
  assert.equal(prepared[0].tool_call_id, 'call-1');
  assert.equal(result, true);
  assert.equal(cardShown(emitted), false);
});

test('an aborted turn does not run the call', async () => {
  const { service } = harness();
  const controller = new AbortController();
  controller.abort();
  const result = await waitForToolApproval(service, 'stream-1', 'session-jenny', 'req-1',
    { tool_name: 'python_execute', tool_call_id: 'call-1', tool_input: {} }, controller, null, AUTO_TURN);
  assert.equal(result, false);
});
