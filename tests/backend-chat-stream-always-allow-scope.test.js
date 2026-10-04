'use strict';

// F15: "Always allow" on a path-bearing call persists a tool + path_prefix
// rule instead of flipping the whole tool. Lives beside, not inside,
// backend-service-lifecycle.test.js, which sits at the file-size cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const { approveToolCall } = require('../services/backend/backend-chat-stream');
test('backend always allow grants the pending tool input and logs path scope', () => {
  const toolInput = { path: 'docs/a.md', content: 'hello' };
  const grants = [];
  const logs = [];
  const service = {
    toolPermissionStore: {
      grantAlwaysAllow(toolName, input) {
        grants.push({ toolName, input });
        return {
          scope: 'path',
          toolName: 'write_file',
          pathPrefix: 'docs/a.md',
          ruleId: 'always-allow:write_file:abc123',
        };
      },
    },
    pendingToolApprovals: new Map([[
      'approval-scoped-write',
      {
        approvalId: 'approval-scoped-write',
        callId: 'call-scoped-write',
        streamId: 'stream-scoped-write',
        toolName: 'Write',
        toolInput,
        resolve() {},
      },
    ]]),
    _emitServiceLog(level, event, fields) {
      logs.push({ level, event, fields });
    },
  };

  assert.equal(approveToolCall(service, 'approval-scoped-write', { alwaysAllow: true }), true);
  assert.deepEqual(grants, [{ toolName: 'Write', input: toolInput }]);
  assert.deepEqual(logs, [{
    level: 'INFO',
    event: 'tool_permission.always_allow_scoped',
    fields: {
      toolName: 'Write',
      pathPrefix: 'docs/a.md',
      ruleId: 'always-allow:write_file:abc123',
    },
  }]);
});

test('backend one-off-only approval ignores a forged always-allow action', () => {
  const grants = [];
  const resolutions = [];
  const service = {
    toolPermissionStore: {
      grantAlwaysAllow(toolName, input) {
        grants.push({ toolName, input });
      },
    },
    pendingToolApprovals: new Map([[
      'approval-streak-cap',
      {
        approvalId: 'approval-streak-cap',
        callId: 'call-streak-cap',
        toolName: 'write_file',
        toolInput: { path: 'notes.md' },
        oneOffOnly: true,
        resolve(...args) { resolutions.push(args); },
      },
    ]]),
  };

  assert.equal(approveToolCall(service, 'approval-streak-cap', { alwaysAllow: true }), true);
  assert.deepEqual(resolutions, [[true, 'approved', '', undefined]]);
  assert.deepEqual(grants, []);
});

// Real-app X1: "Always allow" during a running turn reinitialized the managed
// sidecar mid-turn, so the next approval resume rebuilt a different prompt and
// preempted the turn with approval_plan_drift. The grant persists at once; the
// sidecar refresh waits until the last admitted stream settles.
function createDeferredRun() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}

function createAlwaysAllowTurnService() {
  const grants = [];
  const refreshes = [];
  const logs = [];
  const service = {
    activeStreams: new Map(),
    toolPermissionStore: {
      grantAlwaysAllow(toolName) {
        grants.push(toolName);
        return { scope: 'tool', toolName };
      },
    },
    pendingToolApprovals: new Map(),
    refreshManagedConfig(reason) {
      refreshes.push(reason);
      return Promise.resolve(null);
    },
    _emitServiceLog(level, event, fields) {
      logs.push({ level, event, fields });
    },
  };
  const addApproval = (approvalId, toolName) => {
    service.pendingToolApprovals.set(approvalId, {
      approvalId,
      callId: `call-${approvalId}`,
      streamId: 'stream-turn',
      toolName,
      toolInput: {},
      resolve() {},
    });
  };
  return { service, grants, refreshes, logs, addApproval };
}

async function drainAsyncWork() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('always allow during an active turn persists the grant but defers the sidecar refresh', async () => {
  const { service, grants, refreshes, logs, addApproval } = createAlwaysAllowTurnService();
  const run = createDeferredRun();
  service.activeStreams.set('stream-turn', { _pendingPromise: run.promise });

  addApproval('approval-first', 'python_execute');
  assert.equal(approveToolCall(service, 'approval-first', { alwaysAllow: true }), true);
  addApproval('approval-second', 'run_command');
  assert.equal(approveToolCall(service, 'approval-second', { alwaysAllow: true }), true);
  await drainAsyncWork();

  assert.deepEqual(grants, ['python_execute', 'run_command']);
  assert.deepEqual(refreshes, [], 'no sidecar reinitialize while the turn is admitted');
  assert.equal(
    logs.filter((entry) => entry.event === 'tool_permission.config_refresh_deferred').length,
    2
  );

  // The turn's finally path removes the controller, then its run settles.
  service.activeStreams.delete('stream-turn');
  run.settle();
  await drainAsyncWork();
  assert.deepEqual(refreshes, ['tool_permission_updated'], 'one coalesced flush after the turn');

  // A later idle always-allow refreshes immediately, as before.
  addApproval('approval-idle', 'python_execute');
  assert.equal(approveToolCall(service, 'approval-idle', { alwaysAllow: true }), true);
  await drainAsyncWork();
  assert.deepEqual(refreshes, ['tool_permission_updated', 'tool_permission_updated']);
});

test('deferred permission refresh waits for every concurrently active stream', async () => {
  const { service, refreshes, addApproval } = createAlwaysAllowTurnService();
  const first = createDeferredRun();
  const second = createDeferredRun();
  service.activeStreams.set('stream-a', { _pendingPromise: first.promise });
  service.activeStreams.set('stream-b', { _pendingPromise: second.promise });

  addApproval('approval-concurrent', 'python_execute');
  assert.equal(approveToolCall(service, 'approval-concurrent', { alwaysAllow: true }), true);

  service.activeStreams.delete('stream-a');
  first.settle();
  await drainAsyncWork();
  assert.deepEqual(refreshes, [], 'stream-b is still admitted');

  service.activeStreams.delete('stream-b');
  second.settle();
  await drainAsyncWork();
  assert.deepEqual(refreshes, ['tool_permission_updated']);
});

test('deferred permission refresh polls a stream that exposes no run promise', async () => {
  const { service, refreshes, addApproval } = createAlwaysAllowTurnService();
  service.activeStreams.set('stream-bare', {});

  addApproval('approval-bare', 'python_execute');
  assert.equal(approveToolCall(service, 'approval-bare', { alwaysAllow: true }), true);
  await drainAsyncWork();
  assert.deepEqual(refreshes, []);

  service.activeStreams.delete('stream-bare');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(refreshes, ['tool_permission_updated']);
});

test('a deferred permission refresh is dropped when shutdown drains the turn', async () => {
  const { service, refreshes, addApproval } = createAlwaysAllowTurnService();
  const run = createDeferredRun();
  service.activeStreams.set('stream-turn', { _pendingPromise: run.promise });

  addApproval('approval-shutdown', 'python_execute');
  assert.equal(approveToolCall(service, 'approval-shutdown', { alwaysAllow: true }), true);

  // Quitting: the service is stopping, then the drain settles the turn.
  service._stopping = true;
  service.activeStreams.delete('stream-turn');
  run.settle();
  await drainAsyncWork();
  assert.deepEqual(refreshes, [], 'no sidecar reinitialize races the runtime stop');
});
