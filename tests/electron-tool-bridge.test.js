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
    const result = await runCheckpoint({
      async createCheckpoint({ session }) {
        calledWith = session;
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

describe('Electron tool bridge: Stage 5 remote plugin tools', () => {
  test('routes a dynamic namespaced descriptor through the plugin authority', async () => {
    let observed = null;
    const result = await executeElectronToolRequest({
      _pluginStage5ControlPlane: {
        async executeRemoteTool(name, args) {
          observed = { name, args };
          return {
            ok: true,
            result: { content: [{ type: 'text', text: 'remote ok' }] },
            provenance: {
              publisher_id: 'acme-labs', plugin_id: 'remote-tools',
              contribution_id: 'remote-main', descriptor_digest: 'a'.repeat(64),
            },
          };
        },
      },
    }, {
      params: {
        tool_name: 'acme-labs.remote-tools.remote-main:lookup',
        arguments: { query: 'Jenny' },
      },
    });
    assert.deepEqual(observed, {
      name: 'acme-labs.remote-tools.remote-main:lookup',
      args: { query: 'Jenny' },
    });
    assert.equal(result.success, true);
    assert.equal(result.metadata.result_kind, 'plugin_remote_mcp');
    assert.equal(result.metadata.plugin_provenance.publisher_id, 'acme-labs');
    assert.match(result.output, /remote ok/);
  });

  test('keeps unknown dynamic names fail-closed without the Stage 5 service', async () => {
    const result = await executeElectronToolRequest({}, {
      params: { tool_name: 'acme-labs.remote-tools.remote-main:lookup', arguments: {} },
    });
    assert.equal(result.success, false);
    assert.match(result.output, /unsupported tool/i);
  });
});

describe('Electron tool bridge: Stage 6 restricted plugin tools', () => {
  test('preserves Stage 5 remote MCP routing when both plugin runtimes are present', async () => {
    let restrictedCalls = 0;
    let remoteCalls = 0;
    const result = await executeElectronToolRequest({
      _pluginStage6ControlPlane: {
        executeRestrictedTool: async () => { restrictedCalls += 1; return { ok: false }; },
      },
      _pluginStage5ControlPlane: {
        executeRemoteTool: async () => {
          remoteCalls += 1;
          return { ok: true, result: { source: 'remote' }, provenance: {} };
        },
      },
    }, {
      params: {
        tool_name: 'plugin:remote:server:tool:search:abc',
        arguments: { query: 'Jenny' },
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.metadata.result_kind, 'plugin_remote_mcp');
    assert.equal(restrictedCalls, 0);
    assert.equal(remoteCalls, 1);
  });

  test('routes only the reserved plugin namespace through the restricted authority', async () => {
    let observed = null;
    const abort = new AbortController();
    const result = await executeElectronToolRequest({
      _pluginStage6ControlPlane: {
        async executeRestrictedTool(name, args, context) {
          observed = { name, args, hasSignal: Boolean(context.signal) };
          return { ok: true, value: { answer: 42 }, invocation_id: 'inv_1' };
        },
      },
    }, {
      params: {
        tool_name: 'plugin:acme-labs:widgets:compute',
        arguments: { value: 21 },
      },
      abortSignal: abort.signal,
    });
    assert.deepEqual(observed, {
      name: 'plugin:acme-labs:widgets:compute', args: { value: 21 }, hasSignal: true,
    });
    assert.equal(result.success, true);
    assert.equal(result.output, '{"answer":42}');
    assert.equal(result.metadata.result_kind, 'plugin_restricted_host');
    assert.equal(result.metadata.invocation_id, 'inv_1');
  });

  test('fails closed when the Stage 6 authority is absent or rejects the call', async () => {
    const absent = await executeElectronToolRequest({}, {
      params: { tool_name: 'plugin:acme-labs:widgets:compute', arguments: {} },
    });
    assert.equal(absent.success, false);
    assert.match(absent.output, /runtime is unavailable/i);

    const rejected = await executeElectronToolRequest({
      _pluginStage6ControlPlane: {
        executeRestrictedTool: async () => ({ ok: false, reason: 'commit_epoch_stale' }),
      },
    }, {
      params: { tool_name: 'plugin:acme-labs:widgets:compute', arguments: {} },
    });
    assert.equal(rejected.success, false);
    assert.match(rejected.output, /commit_epoch_stale/);
  });
});
