'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { executeSandboxCommand } = require('../services/execution/command-bridge');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { normalizeSandboxResultMetadata } = require('../services/backend/sandbox-result-metadata');
const { normalizeCommandSandbox } = require('../services/shell-config-command-sandbox');
function fixture(policy = 'ask') {
  const process = {};
  let submitted = 0;
  const service = {
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
    canonicalReadOnly: false, readOnly: false, planMode: false, authorize: async () => true };
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
  service._pluginStage8ControlPlane = { invokeNativeTool: () => { throw new Error('must not invoke'); } };
  for (const tool_name of ['__jenny_git_checkpoint','verify','worktree_create','python_execute','plugin:a:b:c']) {
    const result = await executeElectronToolRequest(service, { params: { tool_name }, pluginRuntimeAuthority: { mode: 'plugin' } });
    assert.equal(result.success, false);
  }
});
test('config migration fails closed on malformed present sandbox settings', () => {
  assert.deepEqual(normalizeCommandSandbox(undefined), { enabled: false });
  for (const value of [null, {}, { enabled: 'false' }]) assert.equal(normalizeCommandSandbox(value).enabled, true);
  assert.equal(normalizeCommandSandbox({ enabled: false }).enabled, false);
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
