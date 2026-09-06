'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createIdeCloseOrchestrator,
} = require('../renderer/features/renderer-ide-close-orchestrator');
const {
  createWorkspaceRootTransitionController,
} = require('../renderer/shell/renderer-workspace-root-transition');
const { createDeferred } = require('./helpers/deferred');

const OLD_CONTEXT = Object.freeze({
  rootPath: 'G:/root-a',
  rootId: 'root-a',
  generation: 7,
  phase: 'ready',
});
const CANDIDATE_CONTEXT = Object.freeze({
  rootPath: 'G:/root-b',
  rootId: 'root-b',
  generation: 8,
  phase: 'transitioning',
});
const NEW_CONTEXT = Object.freeze({
  ...CANDIDATE_CONTEXT,
  phase: 'ready',
});

function preparedChoose() {
  return {
    prepared: true,
    transitionId: 'transition-1',
    canceled: false,
    changed: true,
    candidate: CANDIDATE_CONTEXT,
    previous: OLD_CONTEXT,
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('persistence flush precedes target preparation and settle always receives authoritative context', async () => {
  const events = [];
  const settledContext = { ...OLD_CONTEXT, generation: 8 };
  let captureCalls = 0;
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => {
        captureCalls += 1;
        events.push(`capture-${captureCalls}`);
        return captureCalls === 1 ? OLD_CONTEXT : settledContext;
      },
      prepareChoose: async () => {
        events.push('prepare');
        return { prepared: false, canceled: true, changed: false, context: OLD_CONTEXT };
      },
    },
    beforePrepare: async ({ context }) => {
      events.push('flush');
      assert.deepEqual(context, OLD_CONTEXT);
    },
    onSettled: async ({ context, committed }) => {
      events.push('settled');
      assert.deepEqual(context, settledContext);
      assert.equal(committed, false);
    },
  });

  const result = await controller.choose();

  assert.equal(result.canceled, true);
  assert.deepEqual(events, ['capture-1', 'flush', 'prepare', 'capture-2', 'settled']);
});

test('persistence preflight refusal prevents target selection and still resumes through settle', async () => {
  const events = [];
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => { events.push('prepare'); },
    },
    beforePrepare: async () => {
      events.push('flush');
      const error = new Error('disk refused');
      error.code = 'config_write_blocked';
      throw error;
    },
    onSettled: async () => { events.push('settled'); },
  });

  const result = await controller.choose();

  assert.equal(result.committed, false);
  assert.equal(result.code, 'persistence_preflight_failed');
  assert.equal(result.stage, 'persistence');
  assert.deepEqual(events, ['flush', 'settled']);
});

test('root transition selects the target before preflight and preserves old UI until explicit backend commit', async () => {
  const backendCommit = createDeferred();
  const events = [];
  let visibleContext = OLD_CONTEXT;
  const plan = { ready: true, decision: 'discard', paths: ['old.js'] };
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => { events.push('capture'); return OLD_CONTEXT; },
      prepareChoose: async () => { events.push('prepareChoose'); return preparedChoose(); },
      prepareClear: async () => { throw new Error('unexpected clear'); },
      commit: async (payload) => {
        events.push(['backendCommit', payload]);
        return backendCommit.promise;
      },
      cancel: async () => { throw new Error('unexpected cancel'); },
    },
    closeOrchestrator: {
      preflight: async (paths) => { events.push(['preflight', paths]); return plan; },
      commit: (value) => { events.push(['closeCommit', value]); return { committed: true, closedPaths: value.paths }; },
      cancel: () => { events.push('closeCancel'); },
    },
    getOpenPaths: () => ['old.js'],
    onCommitted: async ({ context }) => {
      events.push('uiCommit');
      visibleContext = context;
    },
  });

  const pending = controller.choose();
  await nextTurn();

  assert.deepEqual(events.slice(0, 3), [
    'capture',
    'prepareChoose',
    ['preflight', ['old.js']],
  ]);
  assert.deepEqual(events[3], [
    'backendCommit',
    { transitionId: 'transition-1', terminateProcesses: false },
  ]);
  assert.equal(visibleContext, OLD_CONTEXT, 'renderer keeps old-root UI while commit is pending');
  assert.equal(events.some((entry) => Array.isArray(entry) && entry[0] === 'closeCommit'), false);

  backendCommit.resolve({
    committed: true,
    changed: true,
    rolledBack: false,
    context: NEW_CONTEXT,
    previous: OLD_CONTEXT,
  });
  const result = await pending;

  assert.equal(result.committed, true);
  assert.deepEqual(visibleContext, NEW_CONTEXT);
  assert.deepEqual(events.slice(-3).map((entry) => Array.isArray(entry) ? entry[0] : entry), [
    'closeCommit',
    'uiCommit',
    'capture',
  ]);
});

test('chooser cancel occurs before dirty preflight and never discards', async () => {
  let preflightCalls = 0;
  let commitCalls = 0;
  let cancelCalls = 0;
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => ({
        prepared: false,
        canceled: true,
        changed: false,
        context: OLD_CONTEXT,
      }),
      commit: async () => { commitCalls += 1; },
      cancel: async () => { cancelCalls += 1; },
    },
    closeOrchestrator: {
      preflight: async () => { preflightCalls += 1; },
      commit: () => { throw new Error('discard must not run'); },
    },
  });

  const result = await controller.choose();

  assert.equal(result.canceled, true);
  assert.equal(result.committed, false);
  assert.equal(preflightCalls, 0);
  assert.equal(commitCalls, 0);
  assert.equal(cancelCalls, 0, 'no transition was prepared, so no cancel RPC is needed');
});

test('a tab opened during deferred Save cancels the prepared root mutation', async () => {
  const save = createDeferred();
  const openPaths = ['old.js'];
  const closed = [];
  const bridgeCalls = { commit: [], cancel: [] };
  const closeOrchestrator = createIdeCloseOrchestrator({
    getIde: () => ({ openTabs: openPaths.map((path) => ({ path })) }),
    isDirty: (path) => path === 'old.js',
    saveFile: () => save.promise,
    confirmClose: () => Promise.resolve('save'),
    forceClose: (path) => closed.push(path),
  });
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => preparedChoose(),
      commit: async (payload) => { bridgeCalls.commit.push(payload); return { committed: true, context: NEW_CONTEXT }; },
      cancel: async (payload) => {
        bridgeCalls.cancel.push(payload);
        return { canceled: true, changed: false, context: OLD_CONTEXT };
      },
    },
    closeOrchestrator,
    getOpenPaths: () => [...openPaths],
  });

  const pending = controller.choose();
  await nextTurn();
  assert.equal(bridgeCalls.commit.length, 0, 'backend commit waits for Save');

  openPaths.push('opened-during-save.js');
  save.resolve(true);
  const result = await pending;

  assert.equal(result.committed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'renderer_context_changed');
  assert.equal(bridgeCalls.commit.length, 0);
  assert.deepEqual(bridgeCalls.cancel, [{ transitionId: 'transition-1' }]);
  assert.deepEqual(closed, [], 'neither saved nor newly opened tabs are discarded');
});

test('commit recheck refusal from an active watch mutation cancels without changing UI', async () => {
  const commit = createDeferred();
  const cancelCalls = [];
  const closeCalls = [];
  let visibleContext = OLD_CONTEXT;
  const plan = { ready: true, decision: 'clean', paths: ['old.js'] };
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareClear: async () => ({
        ...preparedChoose(),
        candidate: { rootPath: '', rootId: '', generation: 8, phase: 'transitioning' },
      }),
      commit: async () => commit.promise,
      cancel: async (payload) => {
        cancelCalls.push(payload);
        return { canceled: true, changed: false, context: OLD_CONTEXT };
      },
    },
    closeOrchestrator: {
      preflight: async () => plan,
      commit: (value) => { closeCalls.push(['commit', value]); return { committed: true }; },
      cancel: (value) => { closeCalls.push(['cancel', value]); return { canceled: true }; },
    },
    getOpenPaths: () => ['old.js'],
    onCommitted: async ({ context }) => { visibleContext = context; },
  });

  const pending = controller.clear({ terminateProcesses: true });
  await nextTurn();
  assert.equal(visibleContext, OLD_CONTEXT);

  commit.resolve({
    committed: false,
    changed: false,
    blocked: true,
    code: 'mutations_active',
    blockers: [{ id: 'workspace_watch', reason: 'draining' }],
    context: OLD_CONTEXT,
  });
  const result = await pending;

  assert.equal(result.committed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'mutations_active');
  assert.deepEqual(result.blockers, [{ id: 'workspace_watch', reason: 'draining' }]);
  assert.deepEqual(cancelCalls, [{ transitionId: 'transition-1' }]);
  assert.equal(closeCalls.some(([action]) => action === 'commit'), false);
  assert.equal(closeCalls.some(([action]) => action === 'cancel'), true);
  assert.equal(visibleContext, OLD_CONTEXT);
});

test('structured backend rollback keeps old-root UI and does not enact discard', async () => {
  const cancelCalls = [];
  let closeCommits = 0;
  let uiCommits = 0;
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => preparedChoose(),
      commit: async () => ({
        committed: false,
        changed: false,
        rolledBack: true,
        code: 'commit_failed',
        stage: 'sync_root',
        error: { code: 'CMP-WORKSPACEFS-0007', message: 'Root unavailable.' },
        context: OLD_CONTEXT,
      }),
      cancel: async (payload) => { cancelCalls.push(payload); },
    },
    closeOrchestrator: {
      preflight: async () => ({ ready: true, decision: 'discard', paths: ['old.js'] }),
      commit: () => { closeCommits += 1; },
      cancel: () => ({ canceled: true }),
    },
    getOpenPaths: () => ['old.js'],
    onCommitted: async () => { uiCommits += 1; },
  });

  const result = await controller.choose();

  assert.equal(result.committed, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.code, 'commit_failed');
  assert.equal(result.stage, 'sync_root');
  assert.deepEqual(result.error, { code: 'CMP-WORKSPACEFS-0007', message: 'Root unavailable.' });
  assert.equal(closeCommits, 0);
  assert.equal(uiCommits, 0);
  assert.deepEqual(cancelCalls, [], 'backend already completed rollback');
  assert.deepEqual(result.context, OLD_CONTEXT);
});

test('missing explicit backend commit success fails closed', async () => {
  const cancelCalls = [];
  let closeCommits = 0;
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => preparedChoose(),
      commit: async () => ({ changed: true, context: NEW_CONTEXT }),
      cancel: async (payload) => {
        cancelCalls.push(payload);
        return { canceled: true, changed: false, context: OLD_CONTEXT };
      },
    },
    closeOrchestrator: {
      preflight: async () => ({ ready: true, decision: 'clean', paths: [] }),
      commit: () => { closeCommits += 1; },
      cancel: () => ({ canceled: true }),
    },
  });

  const result = await controller.choose();

  assert.equal(result.committed, false);
  assert.equal(result.code, 'invalid_commit_response');
  assert.deepEqual(cancelCalls, [{ transitionId: 'transition-1' }]);
  assert.equal(closeCommits, 0);
});

test('a second root transition is refused while target selection is in flight', async () => {
  const target = createDeferred();
  let prepareClearCalls = 0;
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => target.promise,
      prepareClear: async () => { prepareClearCalls += 1; },
      commit: async () => { throw new Error('unexpected commit'); },
      cancel: async () => { throw new Error('unexpected cancel'); },
    },
    closeOrchestrator: {
      preflight: async () => { throw new Error('unexpected preflight'); },
      commit: () => { throw new Error('unexpected close commit'); },
    },
  });

  const first = controller.choose();
  await nextTurn();
  const second = await controller.clear();

  assert.equal(second.committed, false);
  assert.equal(second.blocked, true);
  assert.equal(second.code, 'transition_in_progress');
  assert.equal(prepareClearCalls, 0);

  target.resolve({ prepared: false, canceled: true, changed: false, context: OLD_CONTEXT });
  assert.equal((await first).canceled, true);
});

test('an externally prepared transition reuses dirty preflight and waits for renderer rehydration', async () => {
  const events = [];
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => { throw new Error('externally prepared flow must not open a chooser'); },
      commit: async (payload) => {
        events.push(['backend-commit', payload]);
        return { committed: true, changed: true, context: NEW_CONTEXT, previous: OLD_CONTEXT };
      },
      cancel: async () => { throw new Error('unexpected cancel'); },
    },
    closeOrchestrator: {
      preflight: async (paths) => {
        events.push(['preflight', paths]);
        return { ready: true, decision: 'save', paths };
      },
      commit: (plan) => {
        events.push(['close-commit', plan.paths]);
        return { committed: true };
      },
      cancel: () => ({ canceled: true }),
    },
    getOpenPaths: () => ['dirty.js'],
    beforePrepare: async () => { events.push('persistence'); },
    onCommitted: async () => { events.push('rehydrated'); },
    now: () => 100,
  });

  const result = await controller.external({
    request_id: 'external-1',
    transition_id: 'transition-1',
    deadline_ms: 1_000,
    terminate_processes: false,
    previous: { root_path: OLD_CONTEXT.rootPath, root_id: OLD_CONTEXT.rootId, generation: 7, phase: 'ready' },
    candidate: { root_path: NEW_CONTEXT.rootPath, root_id: NEW_CONTEXT.rootId, generation: 8, phase: 'transitioning' },
  });

  assert.equal(result.committed, true);
  assert.equal(result.degraded, false);
  assert.deepEqual(events, [
    'persistence',
    ['preflight', ['dirty.js']],
    ['backend-commit', { transitionId: 'transition-1', terminateProcesses: false }],
    ['close-commit', ['dirty.js']],
    'rehydrated',
  ]);
});

test('active workspace processes require explicit consent before the same transition retries', async () => {
  const calls = [];
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => preparedChoose(),
      commit: async (payload) => {
        calls.push(['commit', payload]);
        return payload.terminateProcesses
          ? { committed: true, changed: true, context: NEW_CONTEXT, previous: OLD_CONTEXT }
          : {
            committed: false,
            changed: false,
            blocked: true,
            code: 'participants_active',
            blockers: [{ id: 'workspace_terminal', reason: 'terminal_active' }],
            context: OLD_CONTEXT,
          };
      },
      cancel: async () => { throw new Error('approved retry must not cancel'); },
    },
    closeOrchestrator: {
      preflight: async () => ({ ready: true, decision: 'clean', paths: ['old.js'] }),
      commit: (plan) => { calls.push(['close', plan.paths]); return { committed: true }; },
      cancel: () => { calls.push('close-cancel'); return { canceled: true }; },
    },
    getOpenPaths: () => ['old.js'],
    confirmProcessTermination: async (payload) => { calls.push(['confirm', payload]); return true; },
    onCommitted: async () => { calls.push('ui-commit'); },
  });

  const result = await controller.choose({ terminateProcesses: true });

  assert.equal(result.committed, true);
  assert.deepEqual(calls, [
    ['commit', { transitionId: 'transition-1', terminateProcesses: false }],
    ['confirm', {
      mode: 'choose',
      transitionId: 'transition-1',
      blockers: [{ id: 'workspace_terminal', reason: 'terminal_active' }],
    }],
    ['commit', { transitionId: 'transition-1', terminateProcesses: true }],
    ['close', ['old.js']],
    'ui-commit',
  ]);
});

test('declining process termination cancels the prepared transition without closing old-root state', async () => {
  const calls = [];
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareClear: async () => preparedChoose(),
      commit: async (payload) => {
        calls.push(['commit', payload]);
        return { committed: false, changed: false, blocked: true, code: 'participants_active' };
      },
      cancel: async (payload) => { calls.push(['cancel', payload]); return { canceled: true, changed: false }; },
    },
    closeOrchestrator: {
      preflight: async () => ({ ready: true, decision: 'discard', paths: ['dirty.js'] }),
      commit: () => { throw new Error('declined process stop must not close buffers'); },
      cancel: (plan) => { calls.push(['close-cancel', plan.paths]); return { canceled: true }; },
    },
    getOpenPaths: () => ['dirty.js'],
    confirmProcessTermination: async () => { calls.push('confirm'); return false; },
  });

  const result = await controller.clear();

  assert.equal(result.committed, false);
  assert.equal(result.canceled, true);
  assert.equal(result.code, 'process_termination_canceled');
  assert.deepEqual(calls, [
    ['commit', { transitionId: 'transition-1', terminateProcesses: false }],
    'confirm',
    ['close-cancel', ['dirty.js']],
    ['cancel', { transitionId: 'transition-1' }],
  ]);
});

test('non-process commit blockers never request process termination consent', async () => {
  let confirmCalls = 0;
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => preparedChoose(),
      commit: async () => ({ committed: false, changed: false, blocked: true, code: 'mutations_active' }),
      cancel: async () => ({ canceled: true, changed: false }),
    },
    closeOrchestrator: {
      preflight: async () => ({ ready: true, decision: 'clean', paths: [] }),
      commit: () => ({ committed: true }),
      cancel: () => ({ canceled: true }),
    },
    confirmProcessTermination: async () => { confirmCalls += 1; return true; },
  });

  const result = await controller.choose();

  assert.equal(result.code, 'mutations_active');
  assert.equal(confirmCalls, 0);
});

test('tabs opened while process consent is pending invalidate the prepared close plan', async () => {
  const openPaths = ['old.js'];
  const calls = [];
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      prepareChoose: async () => preparedChoose(),
      commit: async (payload) => {
        calls.push(['commit', payload]);
        return { committed: false, changed: false, blocked: true, code: 'participants_active' };
      },
      cancel: async (payload) => { calls.push(['cancel', payload]); return { canceled: true, changed: false }; },
    },
    closeOrchestrator: {
      preflight: async () => ({ ready: true, decision: 'clean', paths: ['old.js'] }),
      commit: () => { throw new Error('stale plan must not close'); },
      cancel: () => ({ canceled: true }),
    },
    getOpenPaths: () => [...openPaths],
    confirmProcessTermination: async () => { openPaths.push('late.js'); return true; },
  });

  const result = await controller.choose();

  assert.equal(result.code, 'renderer_context_changed');
  assert.deepEqual(calls, [
    ['commit', { transitionId: 'transition-1', terminateProcesses: false }],
    ['cancel', { transitionId: 'transition-1' }],
  ]);
});

test('external process consent cannot retry after the broker deadline', async () => {
  let currentTime = 100;
  const commits = [];
  const cancels = [];
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      commit: async (payload) => {
        commits.push(payload);
        return { committed: false, changed: false, blocked: true, code: 'participants_active' };
      },
      cancel: async (payload) => { cancels.push(payload); return { canceled: true, changed: false }; },
    },
    closeOrchestrator: {
      preflight: async () => ({ ready: true, decision: 'clean', paths: [] }),
      commit: () => { throw new Error('expired consent must not close'); },
      cancel: () => ({ canceled: true }),
    },
    confirmProcessTermination: async () => { currentTime = 1_001; return true; },
    now: () => currentTime,
  });

  const result = await controller.external({
    request_id: 'external-process',
    transition_id: 'transition-1',
    deadline_ms: 1_000,
    previous: { root_path: OLD_CONTEXT.rootPath, root_id: OLD_CONTEXT.rootId, generation: 7, phase: 'ready' },
    candidate: { root_path: NEW_CONTEXT.rootPath, root_id: NEW_CONTEXT.rootId, generation: 8, phase: 'transitioning' },
  });

  assert.equal(result.code, 'external_transition_expired');
  assert.deepEqual(commits, [{ transitionId: 'transition-1', terminateProcesses: false }]);
  assert.deepEqual(cancels, [{ transitionId: 'transition-1' }]);
});

test('an expired externally prepared request cancels before backend commit', async () => {
  const calls = { commit: 0, cancel: [] };
  const controller = createWorkspaceRootTransitionController({
    bridge: {
      captureContext: async () => OLD_CONTEXT,
      commit: async () => { calls.commit += 1; },
      cancel: async (payload) => {
        calls.cancel.push(payload);
        return { canceled: true, changed: false, context: OLD_CONTEXT };
      },
    },
    closeOrchestrator: {
      preflight: async () => ({ ready: true, decision: 'clean', paths: [] }),
      commit: () => { throw new Error('expired request must not close renderer state'); },
      cancel: () => ({ canceled: true }),
    },
    now: () => 2_000,
  });

  const result = await controller.external({
    request_id: 'external-expired',
    transition_id: 'transition-1',
    deadline_ms: 1_000,
    previous: { root_path: OLD_CONTEXT.rootPath, root_id: OLD_CONTEXT.rootId, generation: 7, phase: 'ready' },
    candidate: { root_path: NEW_CONTEXT.rootPath, root_id: NEW_CONTEXT.rootId, generation: 8, phase: 'transitioning' },
  });

  assert.equal(result.committed, false);
  assert.equal(result.blocked, true);
  assert.equal(result.code, 'external_transition_expired');
  assert.equal(calls.commit, 0);
  assert.deepEqual(calls.cancel, [{ transitionId: 'transition-1' }]);
});
