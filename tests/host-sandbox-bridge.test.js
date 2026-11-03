'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  executeElectronToolRequest,
} = require('../services/backend/electron-tool-bridge');
const { drainHostedExecution, settleHostedExecution } = require('../services/backend/hosted-execution-settlement');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-bridge-'));
const WORKSPACE = path.join(SCRATCH, 'workspace');
const STAGING = path.join(SCRATCH, 'staging');
fs.mkdirSync(path.join(WORKSPACE, 'projects', 'alpha'), { recursive: true });
fs.mkdirSync(STAGING, { recursive: true });
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });

// The hosted bridge derives the worker's input root from the request's captured
// project root, so a command needs a real execution binding.
function hostedBinding(rootPath) {
  const authority = Object.freeze({ project_id: 'project_test', root_path: rootPath,
    root_id: 'root_test', root_revision: 1, device_id: null, inode: null });
  const executionAuthority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: { run_command: 'auto' }, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  return executionAuthority.captureSession('session-1', { requestId: 'stream-1' });
}

function hostedService(broker) {
  return {
    hostMode: 'server',
    options: { hostExecutionPolicyVersion: 2, hostExecutionBroker: broker, hostExecutionStagingRoot: STAGING },
    configService: { getToolsWorkspaceRoot: () => WORKSPACE },
    toolExecutor: {
      async executePreApproved() {
        throw new Error('hosted run_command must not use the sidecar tool executor');
      },
    },
  };
}

test('hosted run_command uses the injected worker broker and foreground contract', async () => {
  let observed = null;
  const broker = {
    status: () => ({ available: true }),
    async execute(input, context) {
      observed = { input, context };
      await context.beforeAdmission();
      return {
        status: 'completed',
        exit_code: 0,
        stdout: 'ok',
        stderr: '',
        success: true,
        cleanup_confirmed: true,
        workspace: 'disposable_copy',
      };
    },
  };
  const approvedBinding = hostedBinding(path.join(WORKSPACE, 'projects', 'alpha'));
  require('../services/backend/hosted-command-bridge').noteHostedRunCommandApproval(approvedBinding, {
    tool_name: 'run_command', tool_call_id: 'call-1',
    tool_input: { command: 'printf ok', cwd: 'src', timeout_seconds: 5 },
  });
  const result = await executeElectronToolRequest(hostedService(broker), {
    params: {
      tool_name: 'run_command', tool_call_id: 'call-1', plan_mode: false, read_only: false,
      arguments: { command: 'printf ok', cwd: 'src', timeout_seconds: 5 },
      request_id: 'stream-1',
    },
    sessionId: 'session-1',
    streamId: 'stream-1',
    executionAuthority: approvedBinding,
  });

  assert.equal(result.success, true);
  assert.equal(result.output, 'ok');
  assert.match(observed.input.inputRoot, /^[a-f0-9-]{36}$/u);
  assert.deepEqual(observed.input, {
    command: 'printf ok', cwd: 'src', timeoutSeconds: 5, expectedExitCodes: [0],
    inputRoot: observed.input.inputRoot,
  });
  assert.equal(typeof observed.context.beforeAdmission, 'function');
  assert.deepEqual(observed.context, {
    beforeAdmission: observed.context.beforeAdmission,
    sessionId: 'session-1', streamId: 'stream-1', signal: null,
  });
});

test('hosted run_command rejects background and malformed cwd arguments', async () => {
  const broker = { status: () => ({ available: true }), execute: async () => {
    throw new Error('must not execute malformed arguments');
  } };
  for (const arguments_ of [
    { command: 'sleep 1', run_in_background: true },
    { command: 'pwd', cwd: '../outside' },
  ]) {
    const result = await executeElectronToolRequest(hostedService(broker), {
      params: { tool_name: 'run_command', plan_mode: false, read_only: false, arguments: arguments_, request_id: 'stream-1' },
      sessionId: 'session-1', streamId: 'stream-1',
    });
    assert.equal(result.success, false);
  }
});

test('hosted execution settlement waits for the broker cleanup barrier', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const broker = { drainStream: async () => pending };
  let settled = false;
  const draining = drainHostedExecution({
    hostMode: 'server',
    options: { hostExecutionPolicyVersion: 2, hostExecutionBroker: broker },
  }, 'stream-1').then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await draining;
  assert.equal(settled, true);
});



test('hosted reverse bridge rejects read-only, plan mode and missing mode declarations', async () => {
  const broker = { status: () => ({ available: true }), execute: async () => { throw new Error('must not run'); } };
  for (const flags of [{}, { plan_mode: true, read_only: false }, { plan_mode: false, read_only: true }]) {
    const result = await executeElectronToolRequest(hostedService(broker), {
      params: { tool_name: 'run_command', arguments: { command: 'echo no' }, ...flags },
      sessionId: 's', streamId: 't',
    });
    assert.equal(result.success, false);
    assert.match(result.output, /read-only or plan mode/);
  }
});


test('unconfirmed cleanup prevents success and replaces optimistic cancellation', async () => {
  const service = hostedService({ drainStream: async () => {
    throw Object.assign(new Error('unconfirmed'), { reason: 'sandbox_cleanup_unconfirmed' });
  } });
  await assert.rejects(settleHostedExecution(service, 'stream-1'), (error) => error.execution_uncertain === true);
  const payload = { status: 'cancelled', retryable: true, cancel_reason: 'user' };
  await settleHostedExecution(service, 'stream-1', payload);
  assert.equal(payload.status, 'runtime_error');
  assert.equal(payload.terminal_subcode, 'execution_uncertain');
  assert.equal(payload.retryable, false);
  assert.equal(payload.cancel_reason, '');
});

// Security review item 6: main re-checks the sidecar's one-off approval. Only the
// approval waiter's record of an explicit approval of this exact call lets a hosted
// command reach the worker; a persisted rule, Auto or an auto-run grant never does.
const bridgeModule = require('../services/backend/electron-tool-bridge');
const hostedBridge = require('../services/backend/hosted-command-bridge');
const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');

function autoRunBinding() {
  const authority = Object.freeze({ project_id: 'project_test', root_path: path.join(WORKSPACE, 'projects', 'alpha'),
    root_id: 'root_test', root_revision: 1, device_id: null, inode: null });
  const executionAuthority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: { run_command: 'auto' }, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const binding = executionAuthority.captureSession('session-1', { requestId: 'stream-1', approvalMode: 'auto_run' });
  return { executionAuthority, binding };
}

function countingBroker() {
  const calls = [];
  return { calls, status: () => ({ available: true }), async execute(input, context) {
    calls.push(input); await context.beforeAdmission();
    return { status: 'completed', exit_code: 0, stdout: 'ran', stderr: '', success: true, cleanup_confirmed: true };
  } };
}

// Drives the real approval wiring: the sidecar's tool.request_approval reaches the
// managed request's onApprovalRequest, whose waiter returns the user's decision.
async function decideApproval(service, { executionAuthority, binding }, approval, decision) {
  const options = bridgeModule.buildManagedSidecarChatSendOptions({
    service: { ...service, sessionExecutionAuthority: executionAuthority, _emitServiceLog() {} },
    controller: new AbortController(), streamId: 'stream-1', resolvedSessionId: 'session-1',
    requestId: 'stream-1', requestTraceId: 'trace-1', runtime: { handleNotification() {} },
    toolContext: {}, handleToolNotification() {}, waitForToolApproval: async () => decision,
    turnEventCollector: { turnId: 'stream-1' }, normalizedPreferences: {}, timeoutMs: 1_000,
    executionAuthority: binding,
  });
  return options.onApprovalRequest({ tool_name: 'run_command', ...approval });
}

function runHosted(service, binding, toolCallId, args) {
  return executeElectronToolRequest(service, {
    params: { tool_name: 'run_command', tool_call_id: toolCallId, plan_mode: false, read_only: false,
      arguments: args, request_id: 'stream-1' },
    sessionId: 'session-1', streamId: 'stream-1', executionAuthority: binding,
  });
}

test('hosted run_command runs once after the user approves that exact call', async () => {
  const broker = countingBroker();
  const service = hostedService(broker);
  const scope = autoRunBinding();
  assert.equal(await decideApproval(service, scope,
    { tool_call_id: 'call-ok', tool_input: { command: 'printf ran', purpose: 'check' } }, true), true);
  const result = await runHosted(service, scope.binding, 'call-ok', { command: 'printf ran', purpose: 'check' });
  assert.equal(result.success, true);
  assert.equal(result.output, 'ran');
  assert.equal(broker.calls.length, 1);
  // The approval is spent by the call it approved; a replay of the same call id is refused.
  const replay = await runHosted(service, scope.binding, 'call-ok', { command: 'printf ran', purpose: 'check' });
  assert.equal(replay.success, false);
  assert.equal(replay.error_code, TOOL_ERROR_CODES.APPROVAL_DENIED);
  assert.equal(broker.calls.length, 1);
});

test('hosted run_command is never dispatched without a matching one-off approval', async () => {
  const cases = [
    { name: 'no approval under an auto rule and auto-run', approval: null },
    { name: 'denied', approval: { tool_call_id: 'call-1', tool_input: { command: 'ls' } }, decision: false },
    { name: 'approval for another call id', approval: { tool_call_id: 'call-other', tool_input: { command: 'ls' } }, decision: true },
    { name: 'approval for other arguments', approval: { tool_call_id: 'call-1', tool_input: { command: 'ls -a' } }, decision: true },
    { name: 'approval for another cwd', approval: { tool_call_id: 'call-1', tool_input: { command: 'ls', cwd: 'src' } }, decision: true },
  ];
  for (const scenario of cases) {
    const broker = countingBroker();
    const service = hostedService(broker);
    const scope = autoRunBinding();
    if (scenario.approval) await decideApproval(service, scope, scenario.approval, scenario.decision);
    const result = await runHosted(service, scope.binding, 'call-1', { command: 'ls' });
    assert.equal(result.success, false, scenario.name);
    assert.equal(result.error_code, TOOL_ERROR_CODES.APPROVAL_DENIED, scenario.name);
    assert.equal(broker.calls.length, 0, scenario.name);
  }
});

test('a hosted approval recorded for one request does not authorize another request', async () => {
  const broker = countingBroker();
  const service = hostedService(broker);
  const first = autoRunBinding();
  const second = autoRunBinding();
  await decideApproval(service, first, { tool_call_id: 'call-1', tool_input: { command: 'ls' } }, true);
  const result = await runHosted(service, second.binding, 'call-1', { command: 'ls' });
  assert.equal(result.error_code, TOOL_ERROR_CODES.APPROVAL_DENIED);
  assert.equal(broker.calls.length, 0);
  assert.equal(hostedBridge.noteHostedRunCommandApproval(null,
    { tool_name: 'run_command', tool_call_id: 'call-1', tool_input: { command: 'ls' } }), false);
});
