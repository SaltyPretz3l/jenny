'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultRegistry } = require('../services/tools');
const { TOOL_ERROR_CODES } = require('../services/backend/error-codes');

function makeContext(overrides = {}) {
  return {
    callId: 'call_worktree',
    sessionId: 'session_worktree',
    streamId: 'stream_worktree',
    workingDirectory: 'C:/dev/jenny',
    logger() {},
    ...overrides,
  };
}

function createRootCoordinator({
  initialRoot = 'C:/dev/jenny',
  commitResult = null,
} = {}) {
  let rootPath = initialRoot;
  let preparedTarget = initialRoot;
  let transition = 0;
  return {
    captureContext: () => ({ rootPath, rootId: rootPath || null, generation: transition, phase: 'ready' }),
    async prepareTarget(nextRoot) {
      preparedTarget = String(nextRoot || '');
      transition += 1;
      return { prepared: true, transitionId: `transition-${transition}`, changed: true };
    },
    async commit(payload) {
      if (typeof commitResult === 'function') return commitResult(payload, preparedTarget);
      if (commitResult) return commitResult;
      rootPath = preparedTarget;
      return {
        committed: true,
        changed: true,
        context: { rootPath, rootId: rootPath || null, generation: transition, phase: 'ready' },
      };
    },
    cancel: () => ({ canceled: true }),
  };
}

function createTransitionBroker(coordinator, { result = null } = {}) {
  const calls = [];
  return {
    calls,
    async requestPreparedTransition(input) {
      calls.push(input);
      if (typeof result === 'function') return result(input);
      if (result) return result;
      return coordinator.commit({ transitionId: input.prepared.transitionId });
    },
  };
}

describe('worktree tool registry', () => {
  test('worktree tools are default-off and enabled only with toolsWorktreeEnabled', () => {
    const defaultRegistry = createDefaultRegistry();
    assert.equal(defaultRegistry.getTool('worktree_list'), undefined);
    assert.equal(defaultRegistry.getTool('worktree_create'), undefined);

    const enabledRegistry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    assert.equal(enabledRegistry.getTool('worktree_list').readOnly, true);
    assert.equal(enabledRegistry.getTool('worktree_create').readOnly, false);
    assert.equal(enabledRegistry.getTool('worktree_select').readOnly, false);
    assert.equal(enabledRegistry.getTool('worktree_delete').readOnly, false);
  });
});

describe('worktree_list', () => {
  test('lists worktrees through the Electron-owned WorktreeService', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_list');
    let listedInput = null;

    const result = await tool.execute(
      {},
      makeContext({
        worktreeService: {
          async listWorktrees(input) {
            listedInput = input;
            return {
              success: true,
              repository_root: 'C:/dev/jenny',
              worktrees: [
                {
                  path: 'C:/dev/jenny',
                  branch: 'refs/heads/main',
                  status: 'available',
                  source: 'git',
                },
              ],
            };
          },
        },
      })
    );

    assert.deepEqual(listedInput, { workspaceRoot: 'C:/dev/jenny' });
    assert.equal(result.isError, false);
    assert.equal(result.metadata.result_kind, 'worktree_list');
    assert.equal(result.metadata.worktrees.length, 1);
  });

  test('passes an active abort signal through to WorktreeService', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_list');
    const controller = new AbortController();
    let listedInput = null;

    await tool.execute(
      {},
      makeContext({
        abortSignal: controller.signal,
        worktreeService: {
          async listWorktrees(input) {
            listedInput = input;
            return { success: true, repository_root: 'C:/dev/jenny', worktrees: [] };
          },
        },
      })
    );

    assert.equal(listedInput.signal, controller.signal);
  });
});

describe('worktree_create', () => {
  test('creates a worktree through the Electron-owned WorktreeService without selecting it', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_create');
    let createdInput = null;

    const result = await tool.execute(
      {
        name: 'Feature Alpha',
        base_ref: 'HEAD',
        parent_path: 'C:/should/not/be/accepted',
      },
      makeContext({
        worktreeService: {
          async createWorktree(input) {
            createdInput = input;
            return {
              success: true,
              active_root_changed: false,
              worktree: {
                id: 'wt_feature_alpha',
                repository_root: 'C:/dev/jenny',
                worktree_path: 'C:/dev/jenny-worktrees/feature-alpha',
                branch: 'jenny/feature-alpha',
                base_ref: 'HEAD',
                status: 'available',
              },
            };
          },
        },
      })
    );

    assert.deepEqual(createdInput, {
      workspaceRoot: 'C:/dev/jenny',
      name: 'Feature Alpha',
      branch: '',
      baseRef: 'HEAD',
      parentPath: '',
      owner: { session_id: 'session_worktree', task_id: 'call_worktree' },
    });
    assert.equal(result.isError, false);
    assert.equal(result.metadata.result_kind, 'worktree_create');
    assert.equal(result.metadata.active_root_changed, false);
    assert.equal(result.metadata.worktree.branch, 'jenny/feature-alpha');
  });
});

describe('worktree_select', () => {
  test('reports no active-root change when the coordinator returns a no-op', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_select');
    const coordinator = {
      captureContext: () => ({ rootPath: 'C:/Repo' }),
      prepareTarget: async () => ({
        noop: true,
        context: { rootPath: 'C:/Repo' },
      }),
      commit: async () => ({ committed: true, changed: false }),
    };

    const result = await tool.execute(
      { worktree_id: 'wt_equivalent' },
      makeContext({
        workingDirectory: 'C:/Repo',
        workspaceRootCoordinator: coordinator,
        workspaceRootTransitionBroker: {
          requestPreparedTransition: async () => {
            throw new Error('broker must not run for a no-op');
          },
        },
        worktreeService: {
          async resolveSelectableWorktree() {
            return {
              success: true,
              worktree_path: 'c:\\repo',
              worktree: { id: 'wt_equivalent' },
            };
          },
        },
      })
    );

    assert.equal(result.isError, false);
    assert.equal(result.metadata.active_root_changed, false);
  });

  test('reports a coordinator rollback without directly mutating config', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_select');
    let directConfigWrites = 0;
    const coordinator = createRootCoordinator({
      commitResult: {
        committed: false,
        changed: false,
        rolledBack: true,
        code: 'commit_failed',
      },
    });
    const broker = createTransitionBroker(coordinator);

    const result = await tool.execute(
      { worktree_id: 'wt_feature_alpha' },
      makeContext({
        worktreeService: {
          async resolveSelectableWorktree(input) {
            assert.deepEqual(input, {
              workspaceRoot: 'C:/dev/jenny',
              worktreeId: 'wt_feature_alpha',
            });
            return {
              success: true,
              result_kind: 'worktree_select',
              worktree_path: 'C:/dev/jenny-worktrees/feature-alpha',
              worktree: {
                id: 'wt_feature_alpha',
                repository_root: 'C:/dev/jenny',
                worktree_path: 'C:/dev/jenny-worktrees/feature-alpha',
                branch: 'codex/feature-alpha',
                status: 'available',
              },
            };
          },
        },
        configService: {
          getToolsWorkspaceRoot() {
            return 'C:/dev/jenny';
          },
          setToolsWorkspaceRoot() { directConfigWrites += 1; },
        },
        workspaceRootCoordinator: coordinator,
        workspaceRootTransitionBroker: broker,
      })
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.result_kind, 'worktree_select');
    assert.equal(result.metadata.status, 'failed');
    assert.equal(result.metadata.reason, 'commit_failed');
    assert.equal(result.metadata.active_root_unchanged, true);
    assert.equal(directConfigWrites, 0);
    assert.equal(broker.calls.length, 1);
    assert.equal(broker.calls[0].mode, 'worktree_select');
  });

  test('reports when coordinator rollback is incomplete', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_select');
    const coordinator = createRootCoordinator({
      commitResult: {
        committed: false,
        changed: false,
        rolledBack: true,
        rollbackIncomplete: true,
        code: 'commit_failed',
      },
    });

    const result = await tool.execute(
      { worktree_id: 'wt_feature_alpha' },
      makeContext({
        worktreeService: {
          async resolveSelectableWorktree() {
            return {
              success: true,
              result_kind: 'worktree_select',
              worktree_path: 'C:/dev/jenny-worktrees/feature-alpha',
              worktree: {
                id: 'wt_feature_alpha',
                worktree_path: 'C:/dev/jenny-worktrees/feature-alpha',
                branch: 'codex/feature-alpha',
              },
            };
          },
        },
        configService: {
          getToolsWorkspaceRoot() {
            return 'C:/dev/jenny';
          },
        },
        workspaceRootCoordinator: coordinator,
        workspaceRootTransitionBroker: createTransitionBroker(coordinator),
      })
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'commit_failed');
    assert.equal(result.metadata.active_root_unchanged, true);
    assert.equal(result.metadata.active_root_rollback_failed, true);
  });

  test('fails closed when the renderer transition broker is unavailable', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_select');
    let resolved = 0;
    const result = await tool.execute(
      { worktree_id: 'wt_feature_alpha' },
      makeContext({
        workspaceRootCoordinator: createRootCoordinator(),
        worktreeService: {
          async resolveSelectableWorktree() { resolved += 1; return { success: true }; },
        },
      })
    );

    assert.equal(result.isError, true);
    assert.equal(result.errorCode, TOOL_ERROR_CODES.DISABLED);
    assert.equal(result.metadata.reason, 'unavailable');
    assert.equal(resolved, 0, 'worktree resolution does not start without renderer preflight ownership');
  });
});

describe('worktree_delete', () => {
  test('returns dirty-summary metadata when the service refuses deletion', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_delete');
    let deletedInput = null;
    const coordinator = createRootCoordinator();

    const result = await tool.execute(
      { worktree_id: 'wt_dirty' },
      makeContext({
        workspaceRootCoordinator: coordinator,
        workspaceRootTransitionBroker: createTransitionBroker(coordinator),
        worktreeService: {
          async deleteWorktree(input) {
            deletedInput = input;
            return {
              success: false,
              result_kind: 'worktree_delete',
              message: 'Worktree has local changes.',
              error_code: TOOL_ERROR_CODES.DISABLED,
              reason: 'dirty_worktree',
              dirty_summary: {
                modified_count: 1,
                staged_count: 0,
                untracked_count: 2,
              },
            };
          },
        },
      })
    );

    const { beforeRemove, ...serviceInput } = deletedInput;
    assert.deepEqual(serviceInput, {
      workspaceRoot: 'C:/dev/jenny',
      worktreeId: 'wt_dirty',
    });
    assert.equal(typeof beforeRemove, 'function');
    assert.equal(result.isError, true);
    assert.equal(result.metadata.result_kind, 'worktree_delete');
    assert.equal(result.metadata.reason, 'dirty_worktree');
    assert.deepEqual(result.metadata.dirty_summary, {
      modified_count: 1,
      staged_count: 0,
      untracked_count: 2,
    });
  });

  test('a dirty refusal of the active worktree never transitions the root', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_delete');
    const coordinator = createRootCoordinator({
      initialRoot: 'C:/dev/jenny-worktrees/feature-alpha',
    });
    const broker = createTransitionBroker(coordinator);

    const result = await tool.execute(
      { worktree_id: 'wt_selected' },
      makeContext({
        workingDirectory: 'C:/dev/jenny-worktrees/feature-alpha',
        workspaceRootCoordinator: coordinator,
        workspaceRootTransitionBroker: broker,
        worktreeService: {
          async resolveSelectableWorktree() {
            throw new Error('delete must not pre-resolve the worktree');
          },
          // The real service refuses a dirty tree before calling beforeRemove.
          async deleteWorktree() {
            return {
              success: false,
              result_kind: 'worktree_delete',
              message: 'Worktree has local changes; refusing to delete.',
              error_code: TOOL_ERROR_CODES.DISABLED,
              reason: 'dirty_worktree',
            };
          },
        },
      })
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.reason, 'dirty_worktree');
    assert.equal(result.metadata.active_root_unchanged, true);
    assert.deepEqual(broker.calls, [], 'a refusal costs no root transitions');
  });

  test('rejects non-string worktree ids without calling the service', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const coordinator = createRootCoordinator();
    let called = 0;
    const context = makeContext({
      workspaceRootCoordinator: coordinator,
      workspaceRootTransitionBroker: createTransitionBroker(coordinator),
      worktreeService: {
        async deleteWorktree() { called += 1; return { success: true }; },
        async resolveSelectableWorktree() { called += 1; return { success: true }; },
        async createWorktree() { called += 1; return { success: true }; },
      },
    });
    for (const [name, input] of [
      ['worktree_delete', { worktree_id: { id: 'wt' } }],
      ['worktree_select', { worktree_id: ['wt'] }],
      ['worktree_delete', { worktreeId: 'wt_camel' }],
      ['worktree_select', { worktree_id: 'x'.repeat(129) }],
      ['worktree_create', { name: { toString: () => 'object' } }],
      ['worktree_create', { name: 'ok', branch: 7 }],
    ]) {
      const tool = registry.getTool(name);
      const result = await tool.execute(input, context);
      assert.equal(result.isError, true, `${name} ${JSON.stringify(input)}`);
      assert.equal(result.metadata.reason, 'invalid_arguments');
      assert.doesNotMatch(tool.summarize(input), /object Object/);
    }
    assert.equal(called, 0);
  });

  test('a blocked root clear vetoes the delete before any mutation', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_delete');
    const coordinator = createRootCoordinator({ initialRoot: 'C:/dev/jenny-worktrees/feature-alpha' });
    const broker = createTransitionBroker(coordinator, {
      result: { committed: false, changed: false, code: 'turn_active', blockers: ['stream_1'] },
    });
    let gate = null;
    const result = await tool.execute(
      { worktree_id: 'wt_selected' },
      makeContext({
        workspaceRootCoordinator: coordinator,
        workspaceRootTransitionBroker: broker,
        worktreeService: {
          async deleteWorktree({ beforeRemove }) {
            gate = await beforeRemove({ worktree_path: 'C:/dev/jenny-worktrees/feature-alpha' });
            return { success: false, reason: gate.reason, message: gate.message };
          },
        },
      })
    );
    assert.equal(gate.proceed, false);
    assert.equal(result.summary, 'Worktree delete blocked');
    assert.equal(result.metadata.reason, 'turn_active');
    assert.deepEqual(result.metadata.blockers, ['stream_1']);
    assert.equal(result.metadata.active_root_unchanged, true);
    assert.deepEqual(broker.calls.map((call) => call.mode), ['worktree_delete_clear'], 'no restore after a veto');
  });

  test('commits active-root clear before deleting the selected worktree', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_delete');
    const order = [];
    const coordinator = createRootCoordinator({
      initialRoot: 'C:/dev/jenny-worktrees/feature-alpha',
      commitResult: (_payload, target) => {
        order.push(['commit-root', target]);
        return { committed: true, changed: true, context: { rootPath: target } };
      },
    });
    const broker = createTransitionBroker(coordinator);

    const result = await tool.execute(
      { worktree_id: 'wt_selected' },
      makeContext({
        workingDirectory: 'C:/dev/jenny-worktrees/feature-alpha',
        worktreeService: {
          async deleteWorktree(input) {
            order.push('checks');
            const { beforeRemove, ...serviceInput } = input;
            assert.deepEqual(serviceInput, {
              workspaceRoot: 'C:/dev/jenny-worktrees/feature-alpha',
              worktreeId: 'wt_selected',
            });
            const gate = await beforeRemove({
              worktree_path: 'C:/dev/jenny-worktrees/feature-alpha',
            });
            assert.deepEqual(gate, { proceed: true });
            order.push('remove');
            return {
              success: true,
              result_kind: 'worktree_delete',
              status: 'deleted',
              registry_persisted: true,
              worktree: {
                id: 'wt_selected',
                worktree_path: 'C:/dev/jenny-worktrees/feature-alpha',
                branch: 'codex/feature-alpha',
              },
            };
          },
        },
        workspaceRootCoordinator: coordinator,
        workspaceRootTransitionBroker: broker,
      })
    );

    assert.equal(result.isError, false);
    assert.equal(result.metadata.result_kind, 'worktree_delete');
    assert.equal(result.metadata.active_root_cleared, true);
    assert.equal(result.metadata.active_root_clear_failed, undefined);
    assert.deepEqual(order, ['checks', ['commit-root', ''], 'remove']);
    assert.deepEqual(broker.calls.map((call) => call.mode), ['worktree_delete_clear'],
      'no redundant post-delete clear');
  });

  test('failed active-root deletion restores through the broker even after caller cancellation', async () => {
    const registry = createDefaultRegistry({ toolsWorktreeEnabled: true });
    const tool = registry.getTool('worktree_delete');
    const abortController = new AbortController();
    const coordinator = createRootCoordinator({
      initialRoot: 'C:/dev/jenny-worktrees/feature-alpha',
    });
    const broker = createTransitionBroker(coordinator);

    const result = await tool.execute(
      { worktree_id: 'wt_selected' },
      makeContext({
        workingDirectory: 'C:/dev/jenny-worktrees/feature-alpha',
        abortSignal: abortController.signal,
        workspaceRootCoordinator: coordinator,
        workspaceRootTransitionBroker: broker,
        worktreeService: {
          async deleteWorktree({ beforeRemove }) {
            await beforeRemove({ worktree_path: 'C:/dev/jenny-worktrees/feature-alpha' });
            abortController.abort();
            return {
              success: false,
              reason: 'delete_failed',
              message: 'Delete failed.',
            };
          },
        },
      })
    );

    assert.equal(result.isError, true);
    assert.equal(result.metadata.active_root_unchanged, true);
    assert.deepEqual(broker.calls.map((call) => call.mode), [
      'worktree_delete_clear', 'worktree_delete_restore',
    ]);
    assert.equal(broker.calls[0].signal, abortController.signal);
    assert.equal(broker.calls[1].signal, null, 'integrity rollback is not canceled with the original request');
  });
});
