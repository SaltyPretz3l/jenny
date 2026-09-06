'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry } = require('../services/tools/tool-registry');
const { createDefaultRegistry } = require('../services/tools');
const { ToolExecutor } = require('../services/tools/tool-executor');
const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');

function noop() {}

function makeMockTool(overrides = {}) {
  return {
    name: 'MockTool',
    description: 'A mock tool',
    category: 'builtin',
    readOnly: false,
    sideEffecting: false,
    parameters: { type: 'object', properties: {} },
    summarize: () => 'MockTool',
    execute: async () => ({ content: 'done', summary: 'done', isError: false }),
    ...overrides,
  };
}

function makeRegistry(tools = []) {
  const registry = new ToolRegistry();
  for (const t of tools) {
    registry.registerTool(t);
  }
  return registry;
}

function makePermissionStore(policies = {}, snapshotOverrides = {}) {
  const defaults = { Read: 'auto', Glob: 'auto', Grep: 'auto', Write: 'ask', Edit: 'ask', Bash: 'ask' };
  return {
    getAllPolicies() { return { ...defaults, ...policies }; },
    getSnapshot() {
      return {
        version: Object.hasOwn(snapshotOverrides, 'version') ? snapshotOverrides.version : 1,
        legacy_policies: Object.hasOwn(snapshotOverrides, 'legacy_policies')
          ? snapshotOverrides.legacy_policies
          : this.getAllPolicies(),
        rules: Array.isArray(snapshotOverrides.rules) ? snapshotOverrides.rules : [],
      };
    },
    setPolicy(name, policy) { policies[name] = policy; },
  };
}

function makeShellRunner() {
  return { killProcess: async () => {} };
}

function makeContext(overrides = {}) {
  return {
    planMode: false,
    sessionId: 'sess_1',
    streamId: 'stream_1',
    workingDirectory: '/tmp/test',
    abortSignal: undefined,
    ...overrides,
  };
}

function makeJennyStatusExecutor() {
  return new ToolExecutor({
    registry: createDefaultRegistry(),
    permissionStore: makePermissionStore({ jenny_status: 'auto' }),
    pathPolicy: {},
    shellRunner: makeShellRunner(),
    logger: noop,
  });
}

function executeJennyStatusTool({ backendService, callId = 'call_status', input = {} } = {}) {
  const executor = makeJennyStatusExecutor();
  return executor.execute(
    { callId, toolName: 'jenny_status', input },
    makeContext({ workingDirectory: '', backendService })
  );
}

describe('ToolExecutor', () => {
  test('auto-approved tool executes immediately', async () => {
    const tool = makeMockTool({
      name: 'Read',
      readOnly: true,
      execute: async () => ({ content: 'file contents', summary: 'Read test.js', isError: false }),
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Read: 'auto' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_1', toolName: 'Read', input: { file_path: 'test.js' } },
      makeContext()
    );

    assert.equal(result.callId, 'call_1');
    assert.equal(result.content, 'file contents');
    assert.equal(result.isError, false);
    assert.equal(result.approvalState, 'auto');
    assert.equal(result.errorCode, '');
    assert.equal(result.metadata.policy_decision.decision, 'auto');
    assert.equal(result.metadata.policy_decision.tool_name, 'Read');
  });

  test('pre-approved execution bypasses local approval wait for bridged tools', async () => {
    let executed = false;
    const tool = makeMockTool({
      name: 'worktree_create',
      readOnly: false,
      execute: async () => {
        executed = true;
        return { content: 'opened', summary: 'browser opened', isError: false };
      },
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ worktree_create: 'ask' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.executePreApproved(
      { callId: 'call_worktree', toolName: 'worktree_create', input: { name: 'feature' } },
      makeContext()
    );

    assert.equal(executed, true);
    assert.equal(result.isError, false);
    assert.equal(result.approvalState, 'auto');
    assert.deepEqual(executor.getPendingApprovals(), []);
  });

  test('pre-approved execution still honors current deny policy', async () => {
    let executed = false;
    const tool = makeMockTool({
      name: 'worktree_create',
      readOnly: false,
      execute: async () => {
        executed = true;
        return { content: 'opened', summary: 'browser opened', isError: false };
      },
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ worktree_create: 'deny' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.executePreApproved(
      { callId: 'call_worktree', toolName: 'worktree_create', input: { name: 'feature' } },
      makeContext()
    );

    assert.equal(executed, false);
    assert.equal(result.isError, true);
    assert.equal(result.approvalState, 'denied');
    assert.equal(result.errorCode, TOOL_ERROR_CODES.POLICY_DENIED);
    assert.equal(result.metadata.policy_decision.decision, 'deny');
  });

  test('unknown tool returns error result', async () => {
    const executor = new ToolExecutor({
      registry: makeRegistry([]),
      permissionStore: makePermissionStore(),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_1', toolName: 'Unknown', input: {} },
      makeContext()
    );

    assert.equal(result.isError, true);
    assert.match(result.content, /Unknown tool/);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.UNKNOWN);
  });

  test('missing working directory returns disabled error code', async () => {
    const tool = makeMockTool({ name: 'Read', readOnly: true });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Read: 'auto' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_no_root', toolName: 'Read', input: {} },
      makeContext({ workingDirectory: '' })
    );

    assert.equal(result.isError, true);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.DISABLED);
  });

  test('jenny_status executes without a tools workspace root and returns JSON status', async () => {
    let capturedOptions = null;
    const backendService = {
      async getJennyStatus(options) {
        capturedOptions = options;
        return {
          facade: 'jenny_status',
          schema_version: 1,
          generated_at: '2026-05-07T12:00:00.000Z',
          backend: { available: true, phase: 'ready' },
          runtime: { available: true, model: 'qwen3:8b' },
        };
      },
    };

    const result = await executeJennyStatusTool({
      backendService,
      input: {
        session_id: 'session-a',
        include_harness: false,
        recent_log_limit: 3,
      },
    });

    assert.equal(result.isError, false);
    assert.equal(result.approvalState, 'auto');
    assert.deepEqual(capturedOptions, {
      session_id: 'session-a',
      include_harness: false,
      recent_log_limit: 3,
    });
    const payload = JSON.parse(result.content);
    assert.equal(payload.facade, 'jenny_status');
    assert.equal(result.metadata.result_kind, 'jenny_status');
    assert.equal(result.metadata.schema_version, 1);
    assert.equal(result.metadata.generated_at, '2026-05-07T12:00:00.000Z');
  });

  test('jenny_status fails closed when backend service is unavailable', async () => {
    const result = await executeJennyStatusTool({
      callId: 'call_status_missing_service',
    });

    assert.equal(result.isError, true);
    assert.equal(result.approvalState, 'auto');
    assert.equal(result.errorCode, TOOL_ERROR_CODES.EXECUTION_FAILED);
    assert.match(result.content, /backend service is not attached/);
    assert.equal(result.metadata.result_kind, 'jenny_status');
    assert.equal(result.metadata.unavailable, true);
  });

  test('jenny_status hides raw status-composition errors from tool output', async () => {
    const backendService = {
      async getJennyStatus() {
      throw new Error('C:\\Users\\example\\AppData\\Roaming\\jenny bearer secret-token');
      },
    };

    const result = await executeJennyStatusTool({
      backendService,
      callId: 'call_status_throw',
    });

    assert.equal(result.isError, true);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.EXECUTION_FAILED);
    assert.match(result.content, /status composition failed/);
  assert.doesNotMatch(result.content, /Users\\example/i);
    assert.doesNotMatch(result.content, /secret-token/i);
    assert.equal(result.metadata.result_kind, 'jenny_status');
    assert.equal(result.metadata.unavailable, true);
  });

  test('plan mode rejects non-readOnly tools', async () => {
    const tool = makeMockTool({ name: 'Write', readOnly: false });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Write: 'auto' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_1', toolName: 'Write', input: {} },
      makeContext({ planMode: true, readOnly: true })
    );

    assert.equal(result.isError, true);
    assert.match(result.content, /request is read-only/);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.DISABLED);
  });

  test('ask-policy tool waits for approval then executes', async () => {
    const tool = makeMockTool({
      name: 'Write',
      readOnly: false,
      execute: async () => ({ content: 'written', summary: 'Write done', isError: false }),
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Write: 'ask' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const resultPromise = executor.execute(
      { callId: 'call_1', toolName: 'Write', input: {} },
      makeContext()
    );

    // Approval should be pending
    const pending = executor.getPendingApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].callId, 'call_1');

    executor.approve('call_1');

    const result = await resultPromise;
    assert.equal(result.content, 'written');
    assert.equal(result.approvalState, 'approved');
    assert.equal(result.errorCode, '');
    assert.equal(result.metadata.policy_decision.decision, 'ask');
  });

  test('deny resolves with denied result', async () => {
    const tool = makeMockTool({ name: 'Write', readOnly: false });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Write: 'ask' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const resultPromise = executor.execute(
      { callId: 'call_1', toolName: 'Write', input: {} },
      makeContext()
    );

    executor.deny('call_1');

    const result = await resultPromise;
    assert.equal(result.isError, true);
    assert.equal(result.approvalState, 'denied');
    assert.equal(result.errorCode, TOOL_ERROR_CODES.APPROVAL_DENIED);
    assert.equal(result.metadata.policy_decision.decision, 'ask');
  });

  test('cancelPendingForStream cancels all pending for that stream', async () => {
    const tool = makeMockTool({ name: 'Edit', readOnly: false });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Edit: 'ask' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const resultPromise = executor.execute(
      { callId: 'call_1', toolName: 'Edit', input: {} },
      makeContext({ streamId: 'stream_A' })
    );

    executor.cancelPendingForStream('stream_A');

    const result = await resultPromise;
    assert.equal(result.approvalState, 'cancelled');
    assert.equal(result.isError, true);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.APPROVAL_DENIED);
    assert.equal(result.metadata.policy_decision.decision, 'ask');
  });

  test('approval expiry resolves with approval-denied error code', async () => {
    const tool = makeMockTool({ name: 'Write', readOnly: false });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Write: 'ask' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
      approvalExpiryMs: 5,
    });

    const result = await executor.execute(
      { callId: 'call_expire', toolName: 'Write', input: {} },
      makeContext()
    );

    assert.equal(result.isError, true);
    assert.equal(result.approvalState, 'expired');
    assert.equal(result.errorCode, TOOL_ERROR_CODES.APPROVAL_DENIED);
    assert.equal(result.metadata.policy_decision.decision, 'ask');
  });

  test('approve with alwaysAllow updates permission store', async () => {
    const policies = { Write: 'ask' };
    const tool = makeMockTool({
      name: 'Write',
      readOnly: false,
      execute: async () => ({ content: 'ok', summary: 'ok', isError: false }),
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore(policies),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const resultPromise = executor.execute(
      { callId: 'call_1', toolName: 'Write', input: {} },
      makeContext()
    );

    executor.approve('call_1', { alwaysAllow: true });

    await resultPromise;
    assert.equal(policies.Write, 'auto');
  });

  test('alwaysAllow persistence failure does not prevent approval settlement', async () => {
    const logs = [];
    const tool = makeMockTool({
      name: 'Write',
      readOnly: false,
      execute: async () => ({ content: 'ok', summary: 'ok', isError: false }),
    });
    const permissionStore = makePermissionStore({ Write: 'ask' });
    permissionStore.setPolicy = () => { throw new Error('disk full'); };
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore,
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: (level, event, details) => logs.push({ level, event, details }),
    });

    const resultPromise = executor.execute(
      { callId: 'call_persist_failure', toolName: 'Write', input: {} },
      makeContext()
    );

    assert.equal(executor.approve('call_persist_failure', { alwaysAllow: true }), true);
    const result = await resultPromise;
    assert.equal(result.isError, false);
    assert.deepEqual(executor.getPendingApprovals(), []);
    assert.ok(logs.some(({ level, event }) => (
      level === 'WARN' && event === 'tool.always_allow_persist_failed'
    )));
  });

  test('exit_plan_mode never creates a persistent always-allow policy', async () => {
    const policies = {};
    const tool = makeMockTool({
      name: 'exit_plan_mode',
      readOnly: true,
      planModeOnly: true,
      execute: async () => ({ content: 'approved', summary: 'approved', isError: false }),
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore(policies),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const resultPromise = executor.execute(
      { callId: 'call_plan', toolName: 'exit_plan_mode', input: {} },
      makeContext({ planMode: true, readOnly: true })
    );
    executor.approve('call_plan', { decision: 'approved_auto', alwaysAllow: true });
    await resultPromise;
    assert.equal(policies.exit_plan_mode, undefined);
  });

  test('deny-policy tool is rejected without execution', async () => {
    let executed = false;
    const tool = makeMockTool({
      name: 'Bash',
      readOnly: false,
      execute: async () => { executed = true; return { content: 'ok', summary: 'ok', isError: false }; },
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Bash: 'deny' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_1', toolName: 'Bash', input: {} },
      makeContext()
    );

    assert.equal(result.isError, true);
    assert.equal(result.approvalState, 'denied');
    assert.equal(executed, false);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.POLICY_DENIED);
    assert.equal(result.metadata.policy_decision.decision, 'deny');
  });

  test('rule-list policy deny is enforced before approval and records metadata', async () => {
    let executed = false;
    const tool = makeMockTool({
      name: 'write_file',
      readOnly: false,
      sideEffecting: true,
      toolFamily: 'filesystem',
      sourceKind: 'builtin',
      execute: async () => {
        executed = true;
        return { content: 'written', summary: 'written', isError: false };
      },
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({}, {
        legacy_policies: { write_file: 'auto' },
        rules: [
          {
            id: 'deny-prod-writes',
            decision: 'deny',
            reason: 'production writes require a separate review',
            match: { tool_id: 'write_file', path_prefix: 'prod/' },
          },
        ],
      }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_policy_rule', toolName: 'write_file', input: { path: 'prod/config.json' } },
      makeContext()
    );

    assert.equal(executed, false);
    assert.equal(result.isError, true);
    assert.equal(result.approvalState, 'denied');
    assert.equal(result.errorCode, TOOL_ERROR_CODES.POLICY_DENIED);
    assert.equal(result.metadata.policy_decision.decision, 'deny');
    assert.equal(result.metadata.policy_decision.matched_rule_id, 'deny-prod-writes');
    assert.equal(result.metadata.policy_decision.tool_family, 'filesystem');
    assert.deepEqual(executor.getPendingApprovals(), []);
  });

  test('rule-list auto policy promotes side-effecting direct tools', async () => {
    let approvalRequested = false;
    const tool = makeMockTool({
      name: 'write_file',
      readOnly: false,
      sideEffecting: true,
      toolFamily: 'filesystem',
      sourceKind: 'builtin',
      execute: async () => ({ content: 'written', summary: 'written', isError: false }),
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({}, {
        legacy_policies: {},
        rules: [
          {
            id: 'auto-test-fs',
            decision: 'auto',
            reason: 'test workspace allows filesystem writes',
            match: { tool_family: 'filesystem' },
          },
        ],
      }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger(level, event) {
        if (event === 'tool.approval_requested') {
          approvalRequested = true;
        }
      },
    });

    const result = await executor.execute(
      { callId: 'call_policy_auto', toolName: 'write_file', input: { path: 'scratch.txt' } },
      makeContext()
    );

    assert.equal(result.isError, false);
    assert.equal(result.approvalState, 'auto');
    assert.equal(result.metadata.policy_decision.decision, 'auto');
    assert.equal(result.metadata.policy_decision.matched_rule_id, 'auto-test-fs');
    assert.equal(approvalRequested, false);
  });

  test('getToolPolicy previews rule-list decisions with tool input and context', () => {
    const tool = makeMockTool({
      name: 'write_file',
      readOnly: false,
      sideEffecting: true,
      toolFamily: 'filesystem',
      sourceKind: 'builtin',
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({}, {
        legacy_policies: {},
        rules: [
          {
            id: 'auto-safe-workspace',
            decision: 'auto',
            reason: 'safe workspace writes allowed',
            match: {
              tool_family: 'filesystem',
              mode: ['assist'],
              path_prefix: 'safe/',
            },
          },
        ],
      }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const autoPolicy = executor.getToolPolicy(
      'write_file',
      { file_path: 'safe/output.txt' },
      makeContext({ mode: 'assist' })
    );
    assert.equal(autoPolicy, 'auto');

    const defaultPolicy = executor.getToolPolicy(
      'write_file',
      { file_path: 'other/output.txt' },
      makeContext({ mode: 'assist' })
    );
    assert.equal(defaultPolicy, 'ask');
  });

  test('canonical policy is honored when the tool is invoked through a legacy alias', async () => {
    let executed = false;
    const tool = makeMockTool({
      name: 'run_command',
      aliases: ['Bash'],
      readOnly: false,
      execute: async () => {
        executed = true;
        return { content: 'ok', summary: 'ok', isError: false };
      },
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ run_command: 'deny' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_alias', toolName: 'Bash', input: {} },
      makeContext()
    );

    assert.equal(result.isError, true);
    assert.equal(result.approvalState, 'denied');
    assert.equal(executed, false);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.POLICY_DENIED);
  });

  test('tool execution error is caught and returned', async () => {
    const tool = makeMockTool({
      name: 'Read',
      readOnly: true,
      execute: async () => { throw new Error('file not found'); },
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Read: 'auto' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_1', toolName: 'Read', input: {} },
      makeContext()
    );

    assert.equal(result.isError, true);
    assert.match(result.content, /file not found/);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.EXECUTION_FAILED);
  });

  test('tool result error codes are emitted only for errors and normalized', async () => {
    const invalidErrorTool = makeMockTool({
      name: 'Read',
      readOnly: true,
      execute: async () => ({
        content: 'invalid code',
        summary: 'invalid code',
        isError: true,
        errorCode: 'NOT_A_CANONICAL_CODE',
      }),
    });
    const successWithCodeTool = makeMockTool({
      name: 'Glob',
      readOnly: true,
      execute: async () => ({
        content: 'ok',
        summary: 'ok',
        isError: false,
        errorCode: TOOL_ERROR_CODES.DISABLED,
      }),
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([invalidErrorTool, successWithCodeTool]),
      permissionStore: makePermissionStore({ Read: 'auto', Glob: 'auto' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const invalidErrorResult = await executor.execute(
      { callId: 'call_invalid_error', toolName: 'Read', input: {} },
      makeContext()
    );
    const successResult = await executor.execute(
      { callId: 'call_success_code', toolName: 'Glob', input: {} },
      makeContext()
    );

    assert.equal(invalidErrorResult.isError, true);
    assert.equal(invalidErrorResult.errorCode, TOOL_ERROR_CODES.EXECUTION_FAILED);
    assert.equal(successResult.isError, false);
    assert.equal(successResult.errorCode, '');
  });

  test('tool execution catches non-Error thrown values with useful content', async () => {
    const tool = makeMockTool({
      name: 'Read',
      readOnly: true,
      execute: async () => { throw 'string failure'; },
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Read: 'auto' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_string_throw', toolName: 'Read', input: {} },
      makeContext()
    );

    assert.equal(result.isError, true);
    assert.match(result.content, /string failure/);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.EXECUTION_FAILED);
  });

  test('tool execution error preserves canonical CMP error code from thrown error', async () => {
    const tool = makeMockTool({
      name: 'Read',
      readOnly: true,
      execute: async () => {
        const error = new Error('blocked by tool policy');
        error.code = TOOL_ERROR_CODES.DISABLED;
        throw error;
      },
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore: makePermissionStore({ Read: 'auto' }),
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });

    const result = await executor.execute(
      { callId: 'call_policy', toolName: 'Read', input: {} },
      makeContext()
    );

    assert.equal(result.isError, true);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.DISABLED);
  });
});

describe('ToolExecutor scoped always-allow grants', () => {
  test('approve forwards the approved call input to grantAlwaysAllow', async () => {
    const grants = [];
    const permissionStore = makePermissionStore({ Write: 'ask' });
    permissionStore.grantAlwaysAllow = (toolName, input) => {
      grants.push({ toolName, input });
    };
    const tool = makeMockTool({
      name: 'Write',
      readOnly: false,
      execute: async () => ({ content: 'ok', summary: 'ok', isError: false }),
    });
    const executor = new ToolExecutor({
      registry: makeRegistry([tool]),
      permissionStore,
      pathPolicy: {},
      shellRunner: makeShellRunner(),
      logger: noop,
    });
    const toolInput = { path: 'docs/a.md', content: 'hello' };

    const resultPromise = executor.execute(
      { callId: 'call_scoped', toolName: 'Write', input: toolInput },
      makeContext()
    );

    assert.equal(executor.approve('call_scoped', { alwaysAllow: true }), true);
    await resultPromise;
    assert.deepEqual(grants, [{ toolName: 'Write', input: toolInput }]);
  });
});
