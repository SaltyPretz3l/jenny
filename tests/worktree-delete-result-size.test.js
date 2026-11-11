'use strict';

// Row 129, C10: deleting the worktree a chat works in tells the model, in the result, that its tools
// now have no folder (and what to do next). Companion to tests/worktree-tools.test.js (the 600-line cap).
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createDefaultRegistry } = require('../services/tools');

const ACTIVE = 'C:/dev/jenny-worktrees/feature-alpha';

function rootCoordinator(initialRoot, { commitFails = false } = {}) {
  let rootPath = initialRoot;
  let target = initialRoot;
  return {
    captureContext: () => ({ rootPath, rootId: rootPath || null, generation: 1, phase: 'ready' }),
    async prepareTarget(next) { target = String(next || ''); return { prepared: true, transitionId: 't1', changed: true }; },
    async commit() {
      if (commitFails) return { committed: false, changed: false, code: 'commit_failed' };
      rootPath = target;
      return { committed: true, changed: true, context: { rootPath } };
    },
    cancel: () => ({ canceled: true }),
  };
}

const broker = (coordinator) => ({ requestPreparedTransition: (input) => coordinator.commit({ transitionId: input.prepared.transitionId }) });

function run({ worktreePath, callBeforeRemove = true, commitFails = false, status = 'deleted' }) {
  const tool = createDefaultRegistry({ toolsWorktreeEnabled: true }).getTool('worktree_delete');
  const coordinator = rootCoordinator(ACTIVE, { commitFails });
  return tool.execute({ worktree_id: 'wt_selected' }, {
    callId: 'call', sessionId: 'session', streamId: 'stream', workingDirectory: ACTIVE, logger() {},
    workspaceRootCoordinator: coordinator, workspaceRootTransitionBroker: broker(coordinator),
    worktreeService: {
      async deleteWorktree({ beforeRemove }) {
        if (callBeforeRemove) {
          const gate = await beforeRemove({ worktree_path: worktreePath });
          if (gate.proceed === false) return { success: false, reason: gate.reason, message: gate.message };
        }
        return { success: true, status, registry_persisted: true,
          worktree: { id: 'wt_selected', worktree_path: worktreePath, branch: 'codex/feature-alpha' } };
      },
    },
  });
}

describe('worktree_delete result names the effect on the chat', () => {
  test('deleting the worktree the chat works in says its tools now have no folder and what to do', async () => {
    const result = await run({ worktreePath: ACTIVE });
    assert.equal(result.isError, false);
    assert.equal(result.metadata.active_root_cleared, true);
    assert.match(result.content, /^Deleted worktree "codex\/feature-alpha"\./u);
    assert.match(result.content, /This chat's tools were working in that worktree, so they now have no folder/u);
    assert.match(result.content, /worktree_select/u);
    assert.ok(!result.content.includes('Active workspace root was cleared'));
  });

  test('a registry entry already missing on disk gets the same sentence', async () => {
    const result = await run({ worktreePath: ACTIVE, callBeforeRemove: false, status: 'pruned_missing' });
    assert.match(result.content, /^Pruned missing worktree registry entry/u);
    assert.match(result.content, /now have no folder/u);
  });

  test('deleting some other worktree says nothing about the chat\'s folder', async () => {
    const result = await run({ worktreePath: 'C:/dev/jenny-worktrees/other' });
    assert.equal(result.content, 'Deleted worktree "codex/feature-alpha".');
    assert.equal(result.metadata.active_root_cleared, false);
  });

  test('a root that could not be cleared says the tools still point at the deleted folder', async () => {
    const result = await run({ worktreePath: ACTIVE, callBeforeRemove: false, commitFails: true });
    assert.equal(result.metadata.active_root_clear_failed, true);
    assert.match(result.content, /still point at the deleted folder/u);
    assert.match(result.content, /worktree_select/u);
  });
});
