'use strict';

// Session review 2026-11-17, owner decision D1: "Always" on a Python card allows Python for the rest of
// that chat (same root), in memory only. The sidecar keeps asking; Electron answers without a card.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { approveToolCall } = require('../services/backend/backend-chat-stream');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const {
  CHAT_PYTHON_SCOPE, createChatPythonGrants, isPythonRequest,
} = require('../services/backend/chat-python-grant-gate');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');

function capture(sessionId = 'session-a', rootId = 'root-1', rootRevision = 1, approvalMode = 'auto_run') {
  const project = { project_id: 'p', root_path: os.tmpdir(), root_id: rootId, root_revision: rootRevision, device_id: 'd', inode: 'i' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: {
      captureSession: () => project,
      requireCurrent: (current) => current,
      _sessionStore: { getSessionSummary: () => ({ id: sessionId, run_mode: 'auto', plan_mode: false }) },
    },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  return { authority, binding: authority.captureSession(sessionId, { requestId: 'req-1', mode: 'assist', approvalMode }) };
}

function harness({ safetyMode = 'normal', hostMode = undefined, authority, permissionStore = null } = {}) {
  const emitted = [];
  const service = {
    sessionStore: { appendMessage() {}, updateMessage() {} },
    emit(_event, payload) { emitted.push(payload); },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    configService: { getChatUiState: () => ({ safetyMode }) },
    chatPythonGrants: createChatPythonGrants(),
    sessionExecutionAuthority: authority,
    ...(hostMode ? { hostMode } : {}),
    ...(permissionStore ? { toolPermissionStore: permissionStore } : {}),
  };
  return { service, emitted };
}

let callSeq = 0;
function ask(service, binding, {
  toolName = 'python_execute', input = { code: 'print(1)' }, sessionId = 'session-a', collector = null, oneOffOnly = false,
} = {}) {
  callSeq += 1;
  return waitForToolApproval(service, 'stream-1', sessionId, 'req-1', {
    tool_name: toolName, tool_call_id: `call-${callSeq}`, tool_input: input, ...(oneOffOnly ? { one_off_only: true } : {}),
  }, new AbortController(), collector, binding);
}

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const cards = (emitted) => emitted.filter((event) => event.type === 'tool_approval_needed');

// A person answers the waiting card; returns the run's result.
async function answer(service, run, { alwaysAllow = false } = {}) {
  await tick();
  const [pending] = [...service.pendingToolApprovals.values()];
  assert.ok(pending, 'a card is waiting');
  assert.equal(approveToolCall(service, pending.approvalId, { decision: 'approved', alwaysAllow }), true);
  return run;
}

async function denyWaiting(service, run) {
  await tick();
  const pending = [...service.pendingToolApprovals.values()];
  assert.equal(pending.length, 1, 'a person is asked');
  pending[0].resolve(false, 'denied');
  await run;
}

test('isPythonRequest mirrors the sidecar: python_execute, or run_temp_script with language "python"', () => {
  assert.equal(isPythonRequest('python_execute', {}), true);
  assert.equal(isPythonRequest('run_temp_script', { language: 'python' }), true);
  assert.equal(isPythonRequest('run_temp_script', { language: 'powershell' }), false);
  assert.equal(isPythonRequest('run_temp_script', {}), false);
  assert.equal(isPythonRequest('run_command', { command: 'python x.py' }), false);
});

test('the Python card offers "Always for this chat", and pressing it answers later Python calls without a card', async () => {
  const { authority, binding } = capture();
  const { service, emitted } = harness({ authority });
  const collector = new CanonicalTurnEventCollector({ turnId: 'stream-1', sessionId: 'session-a' });

  const first = ask(service, binding, { collector });
  await tick();
  assert.deepEqual(cards(emitted)[0].alwaysAllowScope, { kind: 'chat' }, 'the card can label its Always for this chat');
  assert.equal(cards(emitted)[0].oneOffOnly, undefined);
  assert.equal(await answer(service, first, { alwaysAllow: true }), true);

  const cardsBefore = cards(emitted).length;
  assert.equal(await ask(service, binding, { collector }), true, 'the second Python call runs');
  assert.equal(await ask(service, binding, { collector, toolName: 'run_temp_script', input: { language: 'python', code: 'x' } }), true);
  assert.equal(cards(emitted).length, cardsBefore, 'no further card');
  assert.equal(service.pendingToolApprovals.size, 0);

  const resolved = collector.capturedEvents.filter((event) => event.kind === 'approval_resolved');
  const requested = collector.capturedEvents.filter((event) => event.kind === 'approval_requested');
  assert.equal(requested.length, 3, 'every call keeps its own request');
  assert.deepEqual(resolved.map((event) => event.payload.approval_scope), [CHAT_PYTHON_SCOPE, CHAT_PYTHON_SCOPE, CHAT_PYTHON_SCOPE]);
});

test('Python Always is never persisted to the permission store', async () => {
  const grants = [];
  const permissionStore = { grantAlwaysAllow: (...args) => { grants.push(args); return {}; }, setPolicy: (...args) => { grants.push(args); } };
  const { authority, binding } = capture();
  const { service } = harness({ authority, permissionStore });
  assert.equal(await answer(service, ask(service, binding), { alwaysAllow: true }), true);
  assert.deepEqual(grants, []);
});

test('Allow once grants nothing for the chat', async () => {
  const { authority, binding } = capture();
  const { service, emitted } = harness({ authority });
  await answer(service, ask(service, binding), { alwaysAllow: false });
  await denyWaiting(service, ask(service, binding));
  assert.equal(cards(emitted).length, 2);
});

test('the grant does not reach another chat, another root, or a command', async () => {
  const { authority, binding } = capture('session-a', 'root-1');
  const { service } = harness({ authority });
  await answer(service, ask(service, binding), { alwaysAllow: true });

  const otherChat = capture('session-b', 'root-1');
  service.sessionExecutionAuthority = otherChat.authority;
  await denyWaiting(service, ask(service, otherChat.binding, { sessionId: 'session-b' }));

  const otherRoot = capture('session-a', 'root-2');
  await denyWaiting(service, ask(service, otherRoot.binding));

  await denyWaiting(service, ask(service, binding, { toolName: 'run_command', input: { command: 'dir' } }));
});

for (const [name, options] of [
  ['a team or hosted server', { hostMode: 'server' }],
  ['Paranoid safety mode', { safetyMode: 'paranoid' }],
  ['an unknown safety mode', { safetyMode: 'surprise' }],
]) {
  test(`${name}: the Python card offers Allow once only, and Always grants nothing`, async () => {
    const { authority, binding } = capture();
    const { service, emitted } = harness({ authority, ...options });
    const first = ask(service, binding);
    await tick();
    assert.equal(cards(emitted)[0].oneOffOnly, true);
    assert.equal(cards(emitted)[0].alwaysAllowScope, undefined);
    await answer(service, first, { alwaysAllow: true });
    await denyWaiting(service, ask(service, binding));
  });
}

test('a request that must be approved once by a person is never answered by the grant', async () => {
  const { authority, binding } = capture();
  const { service } = harness({ authority });
  await answer(service, ask(service, binding), { alwaysAllow: true });
  await denyWaiting(service, ask(service, binding, { oneOffOnly: true }));
});

test('an idle pause always reaches a person', async () => {
  const { authority, binding } = capture();
  const { service } = harness({ authority });
  await answer(service, ask(service, binding), { alwaysAllow: true });
  const idle = Object.assign(new AbortController(), { unattendedPauseRequested: true });
  callSeq += 1;
  await denyWaiting(service, waitForToolApproval(service, 'stream-1', 'session-a', 'req-1', {
    tool_name: 'python_execute', tool_call_id: `call-${callSeq}`, tool_input: { code: 'x' },
  }, idle, null, binding));
});

test('in the Jenny chat the grant answers only in an Auto turn', async () => {
  const { authority, binding } = capture();
  const { service } = harness({ authority });
  service.sessionStore.getSessionSummary = () => ({ id: 'session-a', session_role: 'primary' });
  await answer(service, ask(service, binding), { alwaysAllow: true });
  assert.equal(await ask(service, binding), true, 'an Auto turn is answered');
  // A scheduled check or digest runs as a prompt-mode turn in the same chat and root.
  const promptTurn = capture('session-a', 'root-1', 1, 'ask');
  service.sessionExecutionAuthority = promptTurn.authority;
  await denyWaiting(service, ask(service, promptTurn.binding));
});

test('clearing the chat ends its grant', async () => {
  const { authority, binding } = capture();
  const { service } = harness({ authority });
  await answer(service, ask(service, binding), { alwaysAllow: true });
  service.chatPythonGrants.clearSession('session-a');
  await denyWaiting(service, ask(service, binding));
});

test('the in-memory grant table is bounded', () => {
  const grants = createChatPythonGrants({ maxSessions: 2 });
  grants.note('s1', 'r:1');
  grants.note('s2', 'r:1');
  grants.note('s3', 'r:1');
  assert.equal(grants.has('s1', 'r:1'), false, 'the oldest chat is dropped');
  assert.equal(grants.has('s3', 'r:1'), true);
  assert.equal(grants.has('s3', ''), false);
});
