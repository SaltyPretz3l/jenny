'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeSandboxCommand, sandboxReady, ALLOWED: SANDBOX_BRIDGE_TOOLS } = require('../services/execution/command-bridge');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { normalizeSandboxResultMetadata } = require('../services/backend/sandbox-result-metadata');
const { normalizeCommandSandbox } = require('../services/shell-config-command-sandbox');
function fixture(policy = 'ask') {
  const process = {};
  let submitted = 0;
  const authority = Object.freeze({ project_id: 'project_test', root_path: '/workspace', root_id: 'root',
    root_revision: 0, device_id: null, inode: null });
  const service = {
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    sidecarManager: { process }, _desktopPolicyProcess: process,
    activeStreams: new Map([['stream', {}]]),
    configService: { getState: () => ({ commandSandbox: { enabled: true }, safetyMode: 'normal' }) },
    toolPermissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: { run_command: policy }, rules: [] }) },
    commandSandbox: { enabled: true, state: 'ready', execute: async (_args, context, authorize) => {
      const result = await authorize({ command_digest: 'test' }, () => assert.equal(context.isLive(), true));
      if (!result.approved) throw Object.assign(new Error(), { reason: 'sandbox_approval_denied' });
      result.validate();
      submitted += 1;
      return { success: true, status: 'completed', stdout: 'sandboxed', exit_code: 0, cleanup_confirmed: true };
    } },
  };
  const options = { input: { command: 'echo example' }, sessionId: 'session', streamId: 'stream', callId: 'call',
    canonicalReadOnly: false, readOnly: false, planMode: false, authorize: async () => true,
    projectAuthority: authority };
  return { service, options, submitted: () => submitted };
}
test('denial, Plan and missing policy acknowledgement never submit', async () => {
  for (const mode of ['deny', 'plan', 'ack']) {
    const { service, options, submitted } = fixture(mode === 'deny' ? 'deny' : 'ask');
    if (mode === 'plan') options.canonicalReadOnly = true;
    if (mode === 'ack') service._desktopPolicyProcess = null;
    const result = await executeSandboxCommand(service, options);
    assert.equal(result.success, false); assert.equal(submitted(), 0);
  }
});
test('explicit approval and auto policy both pass through Electron authority', async () => {
  for (const policy of ['ask', 'auto']) {
    const setup = fixture(policy);
    let prompts = 0;
    setup.options.authorize = async () => { prompts += 1; return true; };
    const result = await executeSandboxCommand(setup.service, setup.options);
    assert.equal(result.success, true);
    assert.equal(setup.submitted(), 1);
    assert.equal(prompts, policy === 'ask' ? 1 : 0);
    assert.equal(result.metadata.execution.backend, 'docker');
  }
});

test('captured Auto grants cover default sandbox asks, with explicit policy and stale controls', async () => {
  const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
  for (const scenario of ['auto', 'ask', 'paranoid', 'explicit_ask', 'rule_ask', 'deny', 'closed', 'forged']) {
    const setup = fixture();
    setup.service.toolPermissionStore.getSnapshot = () => ({ version: 1,
      rules: scenario === 'rule_ask' ? [{ id: 'ask-command', decision: 'ask', match: { tool_id: 'run_command' } }] : [],
      legacy_policies: scenario === 'explicit_ask' ? { run_command: 'ask' }
        : scenario === 'deny' ? { run_command: 'deny' } : {} });
    setup.service.configService.getState = () => ({ commandSandbox: { enabled: true },
      safetyMode: scenario === 'paranoid' ? 'paranoid' : 'normal' });
    const owner = new SessionExecutionAuthority({
      projectAuthority: setup.service.projectAuthority, permissionStore: setup.service.toolPermissionStore,
      knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
      resolveProjectWorkspaceServices: () => ({}),
    });
    setup.options.executionAuthority = owner.captureSession('session', {
      requestId: 'stream', approvalMode: scenario === 'ask' ? 'prompt' : 'auto_run',
    });
    if (scenario === 'closed') owner.close(setup.options.executionAuthority);
    if (scenario === 'forged') setup.options.executionAuthority = { autoRun: true };
    let prompts = 0;
    setup.options.authorize = async () => { prompts++; return true; };
    const result = await executeSandboxCommand(setup.service, setup.options);
    const refused = ['deny', 'closed', 'forged'].includes(scenario);
    assert.equal(result.success, !refused, scenario);
    assert.equal(setup.submitted(), refused ? 0 : 1, scenario);
    assert.equal(prompts, ['auto', 'deny', 'closed', 'forged'].includes(scenario) ? 0 : 1, scenario);
  }
});
test('deny response and foreground-only schema reject without a host fallback', async () => {
  const setup = fixture();
  setup.options.authorize = async () => false;
  assert.equal((await executeSandboxCommand(setup.service, setup.options)).success, false);
  setup.options.input.run_in_background = true;
  assert.equal((await executeSandboxCommand(setup.service, setup.options)).success, false);
  assert.equal(setup.submitted(), 0);
});
test('Electron indirect executable paths are fenced before plugin and checkpoint invocation', async () => {
  const { service } = fixture();
  service.workspaceGitService = { createCheckpoint: () => { throw new Error('must not invoke'); } };
  for (const tool_name of ['__jenny_git_checkpoint','verify','worktree_create','python_execute','plugin:a:b:c']) {
    const result = await executeElectronToolRequest(service, { params: { tool_name } });
    assert.equal(result.success, false);
  }
});
test('config migration fails closed on malformed present sandbox settings', () => {
  assert.deepEqual(normalizeCommandSandbox(undefined), { enabled: false, mode: 'synced' });
  for (const value of [null, {}, { enabled: 'false' }]) assert.equal(normalizeCommandSandbox(value).enabled, true);
  assert.equal(normalizeCommandSandbox({ enabled: false }).enabled, false);
  // Row 106: an unknown mode never selects synced for a profile that already ran the copy.
  assert.equal(normalizeCommandSandbox({ enabled: true }).mode, 'copy');
  assert.equal(normalizeCommandSandbox({ enabled: true, mode: 'live' }).mode, 'copy');
  assert.equal(normalizeCommandSandbox({ enabled: false, mode: 'copy' }).mode, 'copy');
});
test('persisted sandbox metadata has a bounded allowlist', () => {
  const result = normalizeSandboxResultMetadata({ execution: { backend: 'docker', status: 'completed',
    exit_code: 0, cleanup_confirmed: true, token: 'secret', stdout: 'not metadata' } });
  assert.equal(result.execution.cleanup_confirmed, true);
  assert.equal(result.execution.token, undefined);
  assert.equal(normalizeSandboxResultMetadata({ execution: { backend: 'host', status: 'completed' } }), null);
});
test('an auto decision cannot authorize a later ask policy', async () => {
 const setup = fixture('auto'); let reads = 0;
 setup.service.toolPermissionStore.getSnapshot = () => ({ version: 1, rules: [],
  legacy_policies: { run_command: ++reads >= 3 ? 'ask' : 'auto' } });
 const result = await executeSandboxCommand(setup.service, setup.options);
 assert.equal(result.success, false); assert.equal(setup.submitted(), 0);
});
test('workspace cancellation signal reaches the canonical approval waiter', async () => {
 const setup = fixture(); const controller = new AbortController();
 setup.service.commandSandbox.execute = async (_args, _context, authorize) => {
  const promise = authorize({}, () => {}, controller.signal); controller.abort();
  const authorization = await promise;
  assert.equal(authorization.approved, false);
  throw Object.assign(new Error(), { reason: 'sandbox_approval_denied' });
 };
 setup.options.authorize = (_approval, signal) => new Promise(resolve => {
  signal.addEventListener('abort', () => resolve(false), { once: true });
 });
 assert.equal((await executeSandboxCommand(setup.service, setup.options)).success, false);
});

test('explicit Always allow approval remains valid for the approved command', async () => {
 const setup = fixture('ask'); let policy = 'ask';
 setup.service.toolPermissionStore.getSnapshot = () => ({ version: 1, rules: [], legacy_policies: { run_command: policy } });
 setup.options.authorize = async () => { policy = 'auto'; return true; };
 assert.equal((await executeSandboxCommand(setup.service, setup.options)).success, true);
 assert.equal(setup.submitted(), 1);
});

test('sandbox policy reads remain bound to the captured project', async () => {
 const setup = fixture();
 const seen = [];
 setup.service.toolPermissionStore.getSnapshot = authority => {
  seen.push(authority);
  return { version: 1, rules: [], legacy_policies: { run_command: 'ask' } };
 };
 assert.equal((await executeSandboxCommand(setup.service, setup.options)).success, true);
 assert.ok(seen.length >= 3);
 for (const authority of seen) assert.deepEqual(authority, setup.options.projectAuthority);
});

test('reassigned sessions and unavailable permission storage fail closed', async () => {
 const setup = fixture();
 setup.options.authorize = async () => {
  setup.service.projectAuthority.captureSession = () => ({ ...setup.options.projectAuthority, project_id: 'project_other' });
  return true;
 };
 assert.equal((await executeSandboxCommand(setup.service, setup.options)).success, false);
 assert.equal(setup.submitted(), 0);
 const unavailable = fixture();
 unavailable.service.toolPermissionStore.getSnapshot = () => { throw new Error('unavailable'); };
 assert.equal((await executeSandboxCommand(unavailable.service, unavailable.options)).success, false);
 assert.equal(unavailable.submitted(), 0);
});


test('cancelled bridge result persists before terminal settlement and releases tracking', async () => {
 const { trackSandboxBridgeRequest, settleExecution } = require('../services/execution/execution-settlement');
 const events = []; let complete;
 const service = { commandSandbox: { enabled: true, drainStream: async () => events.push('drained') } };
 const pending = trackSandboxBridgeRequest(service, 'stream', () => new Promise(resolve => { complete = resolve; }),
  result => { assert.equal(result.metadata.execution.status, 'cancelled'); events.push('persisted'); });
 const terminal = settleExecution(service, 'stream').then(() => events.push('terminal'));
 await Promise.resolve();
 assert.deepEqual(events, []);
 complete({ metadata: { execution: { status: 'cancelled', cleanup_confirmed: true } } });
 await Promise.all([pending, terminal]);
 assert.deepEqual(events, ['persisted', 'drained', 'terminal']);
 assert.equal(service._desktopSandboxBridgeRequests.size, 0);
});

test('the sandbox bridge passes every Electron-owned shell-free tool through (seam 17 of a new manifest tool)', () => {
  assert.deepEqual([...SANDBOX_BRIDGE_TOOLS].sort(), ['app_view', 'ask_user', 'away_digest', 'browser', 'chat_configure', 'chat_organize', 'complete_session_handoff', 'conversation_open', 'conversations_recent', 'conversations_search', 'exit_plan_mode', 'home', 'jenny_help', 'project_create', 'project_notes', 'projects_list', 'propose_command', 'propose_session', 'run_command', 'schedule_change', 'schedule_list', 'session_export', 'session_status', 'session_stop', 'session_transcript', 'sessions_list', 'settings_change', 'settings_get', 'suggest_next_step', 'task_board', 'terminal_read']);
});
test('a refusal retrying cannot fix names its limits and is recorded for the card Run', async () => {
  const { service, options } = fixture('auto');
  service.commandSandbox.execute = async () => { throw Object.assign(new Error(), { reason: 'snapshot_limit' }); };
  const result = await executeSandboxCommand(service, options);
  assert.equal(result.success, false);
  assert.equal(result.metadata.execution.reason, 'snapshot_limit');
  assert.match(result.output, /too large to copy into the sandbox \(limits: 64 MiB, 2,048 files and folders, 32 levels deep\)/);
  assert.match(result.output, /turn the command sandbox off in Settings/);
  assert.deepEqual(service.lastSandboxFailure, { streamId: 'stream', reason: 'snapshot_limit' });
  service.commandSandbox.execute = async () => { throw Object.assign(new Error(), { reason: 'sandbox_policy_changed' }); };
  assert.equal((await executeSandboxCommand(service, options)).output, 'Docker sandbox: sandbox policy changed. No host command was run.');
});
test('sandboxReady accepts ready and busy only', () => {
  for (const [state, ready] of [['ready', true], ['busy', true], ['unavailable', false], ['preparing', false],
    ['recovery-required', false], ['disabled', false]]) {
    assert.equal(sandboxReady({ commandSandbox: { state } }), ready, state);
  }
  assert.equal(sandboxReady({}), false);
});

// 2026-11-03 Rust session: `rustc` was missing from the image; behind `| tail` it read as
// success, and a bare exit 127 came back classed as an internal error.
function completedRun(result) {
  const setup = fixture('auto');
  setup.service.commandSandbox.execute = async (_args, _context, authorize) => {
    (await authorize({ command_digest: 'test' }, () => {})).validate();
    return { status: 'completed', cleanup_confirmed: true, ...result };
  };
  return executeSandboxCommand(setup.service, setup.options);
}
test('a completed run reports its exit code and a non-zero exit as the command\'s own result', async () => {
  const failed = await completedRun({ success: false, stdout: 'error[E0599]: no method', exit_code: 1 });
  assert.equal(failed.success, false);
  assert.match(failed.output, /\[exit code 1\]$/u);
  assert.equal(failed.metadata.failure_class, 'precondition_unmet');
  assert.match(failed.metadata.remediation, /exited with code 1\. That is the command's own result/u);
  assert.doesNotMatch(failed.output, /sandbox image has only/u);

  const passed = await completedRun({ success: true, stdout: 'ok', exit_code: 0 });
  assert.equal(passed.output, 'ok\n[exit code 0]');
  assert.equal(passed.metadata.failure_class, undefined);
});
test('a program missing from the sandbox image is named, even when a pipe hides the exit code', async () => {
  const masked = await completedRun({ success: true, stdout: '/bin/sh: 1: rustc: not found', exit_code: 0 });
  assert.match(masked.output, /sandbox image has only Node\.js \(node, npm, npx, yarn\) and Python 3; rustc is not installed there/u);
  assert.match(masked.output, /turn the command sandbox off in Settings/u);

  const bare = await completedRun({ success: false, stderr: '', exit_code: 127 });
  assert.match(bare.output, /sandbox image has only Node\.js .* and Python 3\. Give the user/u);
  assert.equal(bare.metadata.failure_class, 'precondition_unmet');
});
