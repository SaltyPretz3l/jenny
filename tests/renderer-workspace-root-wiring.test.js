'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeRootService,
} = require('../renderer/shell/renderer-shell-ide-root-service');
const { createDeferred } = require('./helpers/deferred');

const OLD_CONTEXT = Object.freeze({
  rootPath: 'G:/root-a', rootId: 'root-a', generation: 4, phase: 'ready',
});
const NEW_CONTEXT = Object.freeze({
  rootPath: 'G:/root-b', rootId: 'root-b', generation: 5, phase: 'ready',
});

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('expected async transition stage was not reached');
}

test('the shared root service commits, rehydrates IDE state, then refreshes dependents', async () => {
  const backendCommit = createDeferred();
  const refresh = createDeferred();
  const calls = [];
  const legacyCalls = { choose: 0, clear: 0, getState: 0 };
  const bridge = {
    choose: () => { legacyCalls.choose += 1; },
    clear: () => { legacyCalls.clear += 1; },
    getState: async () => {
      legacyCalls.getState += 1;
      return { workspaceRoot: OLD_CONTEXT.rootPath };
    },
    captureContext: async () => OLD_CONTEXT,
    prepareChoose: async () => ({
      prepared: true,
      transitionId: 'transition-1',
      changed: true,
      candidate: { ...NEW_CONTEXT, phase: 'transitioning' },
      previous: OLD_CONTEXT,
    }),
    commit: async () => {
      calls.push('backend-commit');
      return backendCommit.promise;
    },
    cancel: async () => ({ canceled: true, changed: false, context: OLD_CONTEXT }),
  };
  const closeOrchestrator = {
    preflight: async () => ({ ready: true, decision: 'discard', paths: ['old.js'] }),
    commit: () => { calls.push('close-commit'); return { committed: true }; },
    cancel: () => ({ canceled: true }),
  };
  const ideController = {
    getCloseOrchestrator: () => closeOrchestrator,
    handleWorkspaceRootCommitted: () => { calls.push('ide-refresh'); },
  };
  const service = createIdeRootService({
    state: { ui: { ide: { openTabs: [{ path: 'old.js' }] } } },
    windowRef: { jennyShell: { workspaceRoot: bridge } },
    ideControllerUtils: { createIdeController: () => ideController },
    callbacks: {
      refreshWorkspaceRootDependents: async () => {
        calls.push('dependent-refresh');
        return refresh.promise;
      },
    },
  });

  const pending = service.workspaceRootService.choose();
  await waitFor(() => calls.includes('backend-commit'));
  assert.deepEqual(calls, ['backend-commit']);

  backendCommit.resolve({
    committed: true, changed: true, rolledBack: false,
    context: NEW_CONTEXT, previous: OLD_CONTEXT,
  });
  await waitFor(() => calls.includes('dependent-refresh'));
  assert.deepEqual(calls, ['backend-commit', 'close-commit', 'ide-refresh', 'dependent-refresh']);

  refresh.resolve();
  const result = await pending;
  assert.equal(result.committed, true);
  assert.deepEqual(calls, ['backend-commit', 'close-commit', 'ide-refresh', 'dependent-refresh']);
  assert.deepEqual(legacyCalls, { choose: 0, clear: 0, getState: 0 });

  assert.deepEqual(await service.workspaceRootService.getState(), {
    workspaceRoot: OLD_CONTEXT.rootPath,
  });
  assert.equal(legacyCalls.getState, 1, 'read compatibility still delegates to the preload bridge');
});

test('rollback/refusal never refreshes root-scoped UI', async () => {
  const calls = [];
  const bridge = {
    captureContext: async () => OLD_CONTEXT,
    prepareClear: async () => ({
      prepared: true,
      transitionId: 'transition-clear',
      changed: true,
      candidate: { rootPath: '', rootId: null, generation: 5, phase: 'transitioning' },
      previous: OLD_CONTEXT,
    }),
    commit: async () => ({
      committed: false, changed: false, rolledBack: true,
      code: 'commit_failed', stage: 'refresh', context: OLD_CONTEXT,
    }),
    cancel: async () => ({ canceled: true, changed: false, context: OLD_CONTEXT }),
  };
  const service = createIdeRootService({
    state: { ui: { ide: { openTabs: [] } } },
    windowRef: { jennyShell: { workspaceRoot: bridge } },
    ideControllerUtils: {
      createIdeController: () => ({
        getCloseOrchestrator: () => ({
          preflight: async () => ({ ready: true, decision: 'clean', paths: [] }),
          commit: () => { calls.push('close-commit'); return { committed: true }; },
          cancel: () => ({ canceled: true }),
        }),
        handleWorkspaceRootCommitted: () => { calls.push('ide-refresh'); },
      }),
    },
    callbacks: {
      refreshWorkspaceRootDependents: async () => { calls.push('dependent-refresh'); },
    },
  });

  const result = await service.workspaceRootService.clear();

  assert.equal(result.committed, false);
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls, []);
});
