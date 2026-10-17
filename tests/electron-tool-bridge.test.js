'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ELECTRON_BRIDGE_TOOL_NAMES,
  executeElectronToolRequest,
  sanitizeBridgeMetadata,
} = require('../services/backend/electron-tool-bridge');

function makeThrowingToolExecutor() {
  return {
    async executePreApproved() {
      throw new Error('toolExecutor.executePreApproved must not be called for __jenny_git_checkpoint');
    },
  };
}

// The __jenny_git_checkpoint branch returns before resolveConfiguredWorkspaceRoot,
// so the bridge only reads service.workspaceGitService (and service.toolExecutor
// for the negative assertion below) — no configService needed. Every test varies
// only the git-service stub, so route through one helper.
function runCheckpoint(workspaceGitService, { toolExecutor = makeThrowingToolExecutor() } = {}) {
  return executeElectronToolRequest(
    { toolExecutor, workspaceGitService },
    { params: { tool_name: '__jenny_git_checkpoint' }, sessionId: 'sess_x' }
  );
}

test('bridge metadata rejects prototype-mutating keys at every object depth', () => {
  const nested = { safe_nested: true };
  const metadata = { safe: 'value', nested };
  for (const target of [metadata, nested]) {
    Object.defineProperty(target, '__proto__', {
      value: { inherited_marker: true },
      enumerable: true,
    });
    Object.defineProperty(target, 'prototype', { value: 'blocked', enumerable: true });
    Object.defineProperty(target, 'constructor', { value: 'blocked', enumerable: true });
  }

  const sanitized = sanitizeBridgeMetadata(metadata);

  assert.equal(Object.getPrototypeOf(sanitized), Object.prototype);
  assert.equal(Object.getPrototypeOf(sanitized.nested), Object.prototype);
  for (const target of [sanitized, sanitized.nested]) {
    assert.equal(Object.hasOwn(target, '__proto__'), false);
    assert.equal(Object.hasOwn(target, 'prototype'), false);
    assert.equal(Object.hasOwn(target, 'constructor'), false);
    assert.equal(target.inherited_marker, undefined);
  }
  assert.equal(sanitized.safe, 'value');
  assert.equal(sanitized.nested.safe_nested, true);
});

test('Electron tool bridge routes the canonical Jenny status facade', async () => {
  assert.equal(ELECTRON_BRIDGE_TOOL_NAMES.has('jenny_status'), true);
  let observed = null;
  const result = await executeElectronToolRequest({
    toolExecutor: {
      async executePreApproved(call, context) {
        observed = { call, backendService: context.backendService };
        return {
          content: '{"facade":"jenny_status"}',
          isError: false,
          metadata: { result_kind: 'jenny_status' },
        };
      },
    },
  }, {
    params: {
      tool_name: 'jenny_status',
      arguments: { recent_log_limit: 5 },
    },
    sessionId: 'session-status',
  });

  assert.equal(observed.call.toolName, 'jenny_status');
  assert.equal(observed.backendService.toolExecutor != null, true);
  assert.equal(result.success, true);
  assert.equal(result.metadata.result_kind, 'jenny_status');
});

test('Electron tool bridge treats an absent per-call plan_mode as plan-safe', async () => {
  let observedContext = null;
  await executeElectronToolRequest({
    toolExecutor: {
      async executePreApproved(_call, context) {
        observedContext = context;
        return { content: 'ok', isError: false, metadata: {} };
      },
    },
  }, {
    planMode: false,
    params: {
      tool_name: 'jenny_status',
      read_only: false,
    },
  });

  assert.equal(observedContext.planMode, true);
  assert.equal(observedContext.readOnly, false);
});

test('Electron tool bridge treats an absent per-call read_only as read-only', async () => {
  let observedContext = null;
  await executeElectronToolRequest({
    toolExecutor: {
      async executePreApproved(_call, context) {
        observedContext = context;
        return { content: 'ok', isError: false, metadata: {} };
      },
    },
  }, {
    planMode: false,
    params: {
      tool_name: 'jenny_status',
      plan_mode: false,
    },
  });

  assert.equal(observedContext.planMode, false);
  assert.equal(observedContext.readOnly, true);
});

test('Electron tool bridge maps edited_plan into the pre-approved tool context', async () => {
  let observedContext = null;
  const editedPlan = { title: 'Edited', steps: ['Build'] };
  await executeElectronToolRequest({
    toolExecutor: {
      async executePreApproved(_call, context) {
        observedContext = context;
        return { content: 'ok', isError: false, metadata: {} };
      },
    },
  }, {
    params: { tool_name: 'exit_plan_mode', edited_plan: editedPlan },
  });

  assert.deepEqual(observedContext.planEditedPlan, editedPlan);
});

describe('Electron tool bridge: __jenny_git_checkpoint (internal, sidecar-originated)', () => {
  test('routes to WorkspaceGitService.createCheckpoint and returns success metadata', async () => {
    let calledWith = null;
    let allowCleanSeen = null;
    const result = await runCheckpoint({
      async createCheckpoint({ session, allowClean }) {
        calledWith = session;
        allowCleanSeen = allowClean;
        return {
          ok: true,
          available: true,
          isRepo: true,
          op: 'createCheckpoint',
          created: true,
          ref: `refs/jenny/checkpoints/${session}/1`,
          sha: 'deadbeef',
          sequence: 1,
        };
      },
    });

    assert.equal(calledWith, 'sess_x');
    assert.equal(allowCleanSeen, true, 'a clean tree still gets the run a restore point');
    assert.equal(result.success, true);
    assert.equal(result.metadata.result_kind, 'auto_checkpoint');
    assert.equal(result.metadata.created, true);
    assert.equal(result.metadata.ref, 'refs/jenny/checkpoints/sess_x/1');
    assert.equal(result.metadata.sequence, 1);
    assert.equal(result.output, 'checkpoint refs/jenny/checkpoints/sess_x/1');
  });

  test('returns a bridgeFailure object (not a throw) when workspaceGitService is missing', async () => {
    const result = await runCheckpoint(undefined);

    assert.equal(result.success, false);
    assert.equal(result.content_type, 'text');
    assert.deepEqual(result.generated_artifacts, []);
    assert.equal(result.metadata.result_kind, 'electron_tool_bridge');
    assert.match(result.output, /unavailable/i);
  });

  test('returns a bridgeFailure object (not a throw) when createCheckpoint rejects', async () => {
    const result = await runCheckpoint({
      async createCheckpoint() {
        throw new Error('git ref write failed');
      },
    });

    assert.equal(result.success, false);
    assert.match(result.output, /Auto-checkpoint failed: git ref write failed/);
  });

  test('reports created:false with a reason when the service declines to checkpoint', async () => {
    const result = await runCheckpoint({
      async createCheckpoint() {
        return {
          ok: true,
          available: true,
          isRepo: false,
          op: 'createCheckpoint',
          created: false,
          reason: 'not_a_repo',
        };
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.metadata.created, false);
    assert.equal(result.metadata.reason, 'not_a_repo');
    assert.equal(result.output, 'no checkpoint (not_a_repo)');
  });

  test('never reaches toolExecutor.executePreApproved for the internal checkpoint op', async () => {
    let executePreApprovedCalled = false;
    await runCheckpoint(
      {
        async createCheckpoint({ session }) {
          return {
            ok: true,
            created: true,
            ref: `refs/jenny/checkpoints/${session}/1`,
            sequence: 1,
          };
        },
      },
      {
        toolExecutor: {
          async executePreApproved() {
            executePreApprovedCalled = true;
            throw new Error('should not be called');
          },
        },
      }
    );

    assert.equal(executePreApprovedCalled, false);
  });
});

describe('Electron tool bridge: retired plugin remote MCP tools', () => {
  test('keeps unknown dynamic names fail-closed even if a Stage 5 service offers remote execution', async () => {
    let remoteCalls = 0;
    for (const service of [{}, { _pluginStage5ControlPlane: {
      executeRemoteTool: async () => { remoteCalls += 1; return { ok: true, result: {} }; },
    } }]) {
      for (const tool_name of ['acme-labs.remote-tools.remote-main:lookup',
        'plugin:remote:server:tool:search:abc']) {
        const result = await executeElectronToolRequest(service, {
          params: { tool_name, arguments: {} },
        });
        assert.equal(result.success, false);
        assert.match(result.output, /unsupported tool/i);
      }
    }
    assert.equal(remoteCalls, 0);
  });
});

describe('Electron tool bridge: retired restricted plugin tools', () => {
  test('refuses a reserved plugin namespace name even if a restricted authority is attached', async () => {
    let calls = 0;
    const result = await executeElectronToolRequest({
      _pluginStage6ControlPlane: {
        executeRestrictedTool: async () => { calls += 1; return { ok: true, value: {} }; },
      },
    }, {
      params: { tool_name: 'plugin:acme-labs:widgets:compute', arguments: {} },
    });
    assert.equal(result.success, false);
    assert.match(result.output, /unsupported tool/i);
    assert.equal(calls, 0);
  });
});

describe('Electron tool bridge: proposal producer tools and turn identity (row 59 cp3)', () => {
  test('allowlists both proposal tools and forwards logicalTurnId and sessionIncarnation', async () => {
    assert.equal(ELECTRON_BRIDGE_TOOL_NAMES.has('propose_git_action'), true);
    assert.equal(ELECTRON_BRIDGE_TOOL_NAMES.has('propose_command'), true);
    let observed = null;
    const result = await executeElectronToolRequest({
      toolExecutor: {
        async executePreApproved(call, context) {
          observed = { call, context };
          return { content: 'ok', isError: false, metadata: {} };
        },
      },
    }, {
      params: { tool_name: 'propose_git_action', tool_call_id: 'call_1', arguments: { summary: 's' } },
      sessionId: 'sess_1',
      streamId: 'stream_1',
      logicalTurnId: 'turn_1',
      sessionIncarnation: 'inc_1',
    });
    assert.equal(result.success, true);
    assert.equal(observed.call.toolName, 'propose_git_action');
    assert.equal(observed.context.logicalTurnId, 'turn_1');
    assert.equal(observed.context.sessionIncarnation, 'inc_1');
  });

  test('the generic managed-chat Electron path threads the lease identity into the executor', async () => {
    const { buildManagedSidecarChatSendOptions } = require('../services/backend/electron-tool-bridge');
    let observed = null;
    const service = {
      toolExecutor: {
        async executePreApproved(_call, context) {
          observed = context;
          return { content: 'ok', isError: false, metadata: {} };
        },
      },
    };
    const options = buildManagedSidecarChatSendOptions({
      service,
      controller: new AbortController(),
      streamId: 'stream_1',
      resolvedSessionId: 'sess_1',
      requestId: 'stream_1',
      requestTraceId: 'trace_1',
      runtime: { handleNotification() {} },
      toolContext: {},
      handleToolNotification() {},
      waitForToolApproval() {},
      turnEventCollector: { turnId: 'collector_turn' },
      normalizedPreferences: {},
      timeoutMs: 1_000,
      turnIdentity: { turnId: 'turn_lease', sessionIncarnation: 'inc_lease' },
    });
    await options.onElectronToolRequest({ tool_name: 'propose_command', tool_call_id: 'c1', arguments: {} });
    assert.equal(observed.logicalTurnId, 'turn_lease');
    assert.equal(observed.sessionIncarnation, 'inc_lease');
    await options.onElectronToolRequest({ tool_name: 'jenny_status', tool_call_id: 'c2', arguments: {} });
    assert.equal(observed.logicalTurnId, 'turn_lease');
  });
});

describe('Electron tool bridge: session producer tools and the handoff preparation gate (row 59 cp5a)', () => {
  const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');

  // The bridge destructures the trusted-binding reader at load, so a fresh copy is loaded while the
  // reader is stubbed. The stub stands in for a binding that carries (or lacks) the preparation capability.
  function loadBridgeWithTrusted(trusted) {
    const authorityModule = require('../services/backend/session-execution-authority');
    const bridgePath = require.resolve('../services/backend/electron-tool-bridge');
    const real = authorityModule.getTrustedExecutionBinding;
    const saved = require.cache[bridgePath];
    authorityModule.getTrustedExecutionBinding = () => trusted;
    delete require.cache[bridgePath];
    try {
      return require(bridgePath);
    } finally {
      authorityModule.getTrustedExecutionBinding = real;
      if (saved) require.cache[bridgePath] = saved; else delete require.cache[bridgePath];
    }
  }

  function trustedBinding(handoffPreparation) {
    return {
      sessionId: 'sess_1', requestId: 'stream_1', mode: 'assist', readOnly: false,
      authority: { root_path: null }, services: {}, handoffPreparation, assertCurrent() {},
    };
  }

  async function run(bridge, toolName) {
    const calls = [];
    const result = await bridge.executeElectronToolRequest({
      toolExecutor: {
        async executePreApproved(call) {
          calls.push(call.toolName);
          return { content: 'ok', isError: false, metadata: {} };
        },
      },
    }, {
      params: { tool_name: toolName, tool_call_id: 'call_1', arguments: {} },
      sessionId: 'sess_1', streamId: 'stream_1', executionAuthority: {},
    });
    return { result, calls };
  }

  test('allowlists both session producer tools', () => {
    assert.equal(ELECTRON_BRIDGE_TOOL_NAMES.has('propose_session'), true);
    assert.equal(ELECTRON_BRIDGE_TOOL_NAMES.has('complete_session_handoff'), true);
  });

  test('an ordinary turn runs propose_session and refuses complete_session_handoff', async () => {
    const bridge = loadBridgeWithTrusted(trustedBinding(null));
    const offered = await run(bridge, 'propose_session');
    assert.equal(offered.result.success, true);
    assert.deepEqual(offered.calls, ['propose_session']);
    const refused = await run(bridge, 'complete_session_handoff');
    assert.equal(refused.result.success, false);
    assert.equal(refused.result.error_code, TOOL_ERROR_CODES.DISABLED);
    assert.deepEqual(refused.calls, []);
  });

  test('a preparation turn passes only complete_session_handoff', async () => {
    const preparation = { proposalId: `proposal_${'a'.repeat(64)}`, attemptId: '11111111-1111-4111-8111-111111111111' };
    const bridge = loadBridgeWithTrusted(trustedBinding(preparation));
    const allowed = await run(bridge, 'complete_session_handoff');
    assert.equal(allowed.result.success, true);
    assert.deepEqual(allowed.calls, ['complete_session_handoff']);
    for (const other of ['propose_session', 'propose_command', 'ask_user', 'task_board', 'session_spawn']) {
      const refused = await run(bridge, other);
      assert.equal(refused.result.success, false, other);
      assert.equal(refused.result.error_code, TOOL_ERROR_CODES.DISABLED, other);
      assert.deepEqual(refused.calls, [], other);
    }
  });

  test('without an execution binding complete_session_handoff is refused', async () => {
    const result = await executeElectronToolRequest({
      toolExecutor: { async executePreApproved() { throw new Error('must not run'); } },
    }, { params: { tool_name: 'complete_session_handoff', tool_call_id: 'c', arguments: {} }, sessionId: 's', streamId: 't' });
    assert.equal(result.success, false);
    assert.equal(result.error_code, TOOL_ERROR_CODES.DISABLED);
  });
});
