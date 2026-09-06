'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createTimerHarness() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimeoutImpl(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeoutImpl(id) {
      callbacks.delete(id);
    },
    fireAll() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    snapshot() {
      return [...callbacks.values()];
    },
    get size() {
      return callbacks.size;
    },
  };
}

function createHarness({
  initialRootPath = 'G:/workspace/old',
  chooseResult = { canceled: false, path: 'G:/workspace/new' },
  hooks = {},
  transitionTtlMs = 120_000,
  mutationDrainTimeoutMs = 30_000,
  hookTimeoutMs = 30_000,
} = {}) {
  let persistedRoot = initialRootPath;
  let nextTransition = 1;
  let nextOperation = 1;
  const calls = [];
  const timers = createTimerHarness();
  const normalizeRootPath = (value) => String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
  const rootIdFactory = (rootPath) => rootPath
    ? `root:${normalizeRootPath(rootPath).toLowerCase()}`
    : null;

  const coordinator = new WorkspaceRootCoordinator({
    initialRootPath,
    normalizeRootPath,
    rootIdFactory,
    chooseTarget: async () => chooseResult,
    applyRootPath: async (context) => {
      calls.push(['apply', context.rootPath]);
      persistedRoot = context.rootPath;
      if (hooks.applyRootPath) await hooks.applyRootPath(context);
    },
    restoreRootPath: async (context) => {
      calls.push(['restore', context.rootPath]);
      persistedRoot = context.rootPath;
      if (hooks.restoreRootPath) await hooks.restoreRootPath(context);
    },
    refreshManagedRoot: async (context) => {
      calls.push(['refresh', context.reason, context.rootPath]);
      if (hooks.refreshManagedRoot) await hooks.refreshManagedRoot(context);
    },
    stopRootServices: async (context) => {
      calls.push(['stop', context.rootPath]);
      if (hooks.stopRootServices) await hooks.stopRootServices(context);
    },
    startRootServices: async (context) => {
      calls.push(['start', context.reason, context.rootPath]);
      if (hooks.startRootServices) await hooks.startRootServices(context);
    },
    transitionIdFactory: () => `transition-${nextTransition++}`,
    operationIdFactory: () => `operation-${nextOperation++}`,
    transitionTtlMs,
    mutationDrainTimeoutMs,
    hookTimeoutMs,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  return {
    calls,
    coordinator,
    timers,
    getPersistedRoot: () => persistedRoot,
  };
}

test('prepareChoose selects a target before opening a transition and chooser cancel is inert', async () => {
  const canceledHarness = createHarness({ chooseResult: { canceled: true, path: '' } });
  const before = canceledHarness.coordinator.captureContext();
  const canceled = await canceledHarness.coordinator.prepareChoose();

  assert.deepEqual(canceled, {
    prepared: false,
    canceled: true,
    changed: false,
    context: before,
  });
  assert.deepEqual(canceledHarness.coordinator.captureContext(), before);
  assert.equal(canceledHarness.timers.size, 0);

  const harness = createHarness();
  const prepared = await harness.coordinator.prepareChoose();
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.transitionId, 'transition-1');
  assert.equal(prepared.previous.generation, 0);
  assert.equal(prepared.candidate.generation, 1);
  assert.equal(prepared.candidate.phase, 'transitioning');
  assert.equal(harness.getPersistedRoot(), 'G:/workspace/old');
});

test('prepared reservations are single-slot while old-root operations remain valid until commit', async () => {
  const { coordinator } = createHarness();
  const beforeLease = coordinator.acquireOperation({ kind: 'read' });
  assert.equal(beforeLease.acquired, true);
  assert.equal(beforeLease.release(), true);
  assert.equal(beforeLease.release(), false);

  const prepared = await coordinator.prepareClear();
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.candidate.rootPath, '');
  assert.equal(prepared.candidate.rootId, null);

  const second = await coordinator.prepareChoose();
  assert.equal(second.blocked, true);
  assert.equal(second.code, 'transition_in_progress');

  const admitted = coordinator.acquireOperation({ kind: 'mutation' });
  assert.equal(admitted.acquired, true, 'dirty-save preflight may still write the old root');
  admitted.release();

  const canceled = coordinator.cancel({ transitionId: prepared.transitionId });
  assert.equal(canceled.canceled, true);
  assert.deepEqual(coordinator.captureContext(), {
    rootPath: 'G:/workspace/old',
    rootId: 'root:g:/workspace/old',
    generation: 0,
    phase: 'ready',
  });
  assert.equal(coordinator.isCurrent(prepared.previous), true);
});

test('trusted direct targets use the same prepared-transition contract', async () => {
  const { coordinator } = createHarness();
  const prepared = await coordinator.prepareTarget('G:/workspace/worktree');
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.candidate.rootPath, 'G:/workspace/worktree');
  assert.equal(coordinator.captureContext().rootPath, 'G:/workspace/old');
  assert.equal(coordinator.captureContext().phase, 'ready');
});

test('commit begins the transition, aborts cancellable work, and drains mutations', async () => {
  const { coordinator, calls } = createHarness();
  const mutation = coordinator.acquireOperation({ kind: 'mutation', cancellable: true });
  assert.equal(mutation.acquired, true);

  const prepared = await coordinator.prepareClear();
  assert.equal(mutation.signal.aborted, false, 'reservation does not invalidate dirty-save work');
  assert.equal(
    mutation.isCurrent(),
    true,
    'a mutation remains valid while commit drains it against the unchanged old root'
  );

  let settled = false;
  const commitPromise = coordinator.commit({ transitionId: prepared.transitionId })
    .then((result) => {
      settled = true;
      return result;
    });
  assert.equal(mutation.signal.aborted, false, 'participant readiness is checked before invalidation');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mutation.signal.aborted, true);
  assert.equal(settled, false, 'commit must wait for the mutation lease to release');
  assert.deepEqual(calls, []);

  mutation.release();
  const committed = await commitPromise;
  assert.equal(committed.committed, true);
  assert.equal(committed.context.rootPath, '');
  assert.deepEqual(calls.map((entry) => entry[0]), ['stop', 'apply', 'refresh', 'start']);
});

test('canceled transitions preserve old-root mutation lease validity until release', async () => {
  const { coordinator } = createHarness();
  const mutation = coordinator.acquireOperation({ kind: 'mutation', cancellable: false });
  const prepared = await coordinator.prepareChoose();
  assert.equal(mutation.isCurrent(), true);
  coordinator.cancel({ transitionId: prepared.transitionId });
  assert.equal(mutation.isCurrent(), true);
  mutation.release();
  assert.equal(mutation.isCurrent(), false);
});

test('participants block commit until explicit termination and are rechecked afterward', async () => {
  const { coordinator, calls } = createHarness();
  const read = coordinator.acquireOperation({ kind: 'read', cancellable: true });
  let active = true;
  let terminateCalls = 0;
  coordinator.registerParticipant({
    id: 'terminal',
    getBlocker: () => active ? { reason: 'terminal_active' } : null,
    terminate: async () => {
      terminateCalls += 1;
      active = false;
    },
  });

  const prepared = await coordinator.prepareClear();
  const blocked = await coordinator.commit({ transitionId: prepared.transitionId });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.code, 'participants_active');
  assert.deepEqual(blocked.blockers, [{ id: 'terminal', reason: 'terminal_active' }]);
  assert.deepEqual(calls, []);
  assert.equal(coordinator.captureContext().phase, 'ready');
  assert.equal(read.signal.aborted, false, 'a refused switch must not tear down old-root reads');

  const committed = await coordinator.commit({
    transitionId: prepared.transitionId,
    terminateProcesses: true,
  });
  assert.equal(committed.committed, true);
  assert.equal(terminateCalls, 1);
  assert.equal(read.signal.aborted, true);
  read.release();
});

test('participants are rechecked after mutation drain before persistence changes', async () => {
  const { coordinator, calls } = createHarness();
  const firstCheck = deferred();
  let active = false;
  let checks = 0;
  coordinator.registerParticipant({
    id: 'test-runner',
    getBlocker: () => {
      checks += 1;
      if (checks === 1) firstCheck.resolve();
      return active ? { reason: 'test_run_active' } : null;
    },
  });
  const mutation = coordinator.acquireOperation({ kind: 'mutation', cancellable: false });
  const prepared = await coordinator.prepareChoose();
  const commit = coordinator.commit({ transitionId: prepared.transitionId });

  await firstCheck.promise;
  active = true;
  mutation.release();
  const result = await commit;

  assert.equal(result.committed, false);
  assert.equal(result.code, 'participants_active');
  assert.deepEqual(result.blockers, [{ id: 'test-runner', reason: 'test_run_active' }]);
  assert.deepEqual(calls, [], 'late process activity is caught before root persistence');
});

test('persistence failure restores the old root under the incremented generation', async () => {
  const applyError = new Error('disk unavailable');
  applyError.code = 'EIO';
  const { coordinator, calls, getPersistedRoot } = createHarness({
    hooks: {
      applyRootPath: async () => { throw applyError; },
    },
  });
  const prepared = await coordinator.prepareChoose();
  const result = await coordinator.commit({ transitionId: prepared.transitionId });

  assert.equal(result.committed, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.code, 'commit_failed');
  assert.equal(result.stage, 'persistence');
  assert.deepEqual(result.error, { code: 'EIO', message: 'Workspace root persistence failed.' });
  assert.equal(getPersistedRoot(), 'G:/workspace/old');
  assert.deepEqual(coordinator.captureContext(), {
    rootPath: 'G:/workspace/old',
    rootId: 'root:g:/workspace/old',
    generation: 1,
    phase: 'ready',
  });
  assert.deepEqual(
    calls.map((entry) => entry[0]),
    ['stop', 'apply', 'stop', 'restore', 'refresh', 'start']
  );
});

test('managed refresh or new-root service start failure rolls back and restarts old-root services', async () => {
  for (const failureStage of ['refresh', 'start']) {
    const { coordinator, calls } = createHarness({
      hooks: {
        refreshManagedRoot: async ({ reason }) => {
          if (failureStage === 'refresh' && reason === 'commit') throw new Error('refresh failed');
        },
        startRootServices: async ({ reason }) => {
          if (failureStage === 'start' && reason === 'commit') throw new Error('start failed');
        },
      },
    });
    const prepared = await coordinator.prepareChoose();
    const result = await coordinator.commit({ transitionId: prepared.transitionId });

    assert.equal(result.rolledBack, true);
    assert.equal(result.stage, failureStage);
    assert.equal(result.context.rootPath, 'G:/workspace/old');
    assert.equal(calls.some((entry) => entry[0] === 'restore'), true);
    assert.equal(calls.some((entry) => entry[0] === 'start' && entry[1] === 'rollback'), true);
  }
});

test('incomplete rollback remains fail-closed until an explicit recovery transition', async () => {
  const { coordinator } = createHarness({
    hooks: {
      applyRootPath: async () => { throw new Error('apply failed'); },
      restoreRootPath: async () => { throw new Error('restore failed'); },
    },
  });
  const prepared = await coordinator.prepareChoose();
  const result = await coordinator.commit({ transitionId: prepared.transitionId });

  assert.equal(result.rolledBack, true);
  assert.equal(result.rollbackIncomplete, true);
  assert.equal(result.context.phase, 'error');
  const refused = coordinator.acquireOperation({ kind: 'read' });
  assert.equal(refused.acquired, false);
  assert.equal(refused.code, 'root_recovery_required');

  const recovery = await coordinator.prepareTarget('G:/workspace/old');
  assert.equal(recovery.prepared, true, 'same desired root is not a no-op while recovery is required');
  const canceled = coordinator.cancel({ transitionId: recovery.transitionId });
  assert.equal(canceled.context.phase, 'error');
});

test('partial candidate start is stopped before the previous root restarts', async () => {
  const activeRoots = new Set(['G:/workspace/old']);
  const { coordinator } = createHarness({
    hooks: {
      stopRootServices: async ({ rootPath }) => {
        activeRoots.delete(rootPath);
      },
      startRootServices: async ({ rootPath, reason }) => {
        activeRoots.add(rootPath);
        if (reason === 'commit') throw new Error('partial candidate start');
      },
    },
  });
  const prepared = await coordinator.prepareChoose();
  const result = await coordinator.commit({ transitionId: prepared.transitionId });

  assert.equal(result.rolledBack, true);
  assert.equal(result.rollbackIncomplete, undefined);
  assert.deepEqual([...activeRoots], ['G:/workspace/old']);
  assert.equal(result.context.phase, 'ready');
});

test('rollback participant failures are isolated and leave recovery fail-closed', async () => {
  const { coordinator } = createHarness();
  let secondRollbackCalls = 0;
  coordinator.registerParticipant({
    id: 'first',
    onCommitted: async () => { throw new Error('commit participant failed'); },
    onRolledBack: async () => { throw new Error('first rollback failed'); },
  });
  coordinator.registerParticipant({
    id: 'second',
    onRolledBack: async () => { secondRollbackCalls += 1; },
  });
  const prepared = await coordinator.prepareChoose();
  const result = await coordinator.commit({ transitionId: prepared.transitionId });

  assert.equal(result.stage, 'participants');
  assert.equal(result.rollbackIncomplete, true);
  assert.equal(secondRollbackCalls, 1);
  assert.equal(result.context.phase, 'error');
  assert.equal(
    result.rollbackErrors.some((entry) => entry.stage === 'participant:first'),
    true
  );
});

test('hung participant checks settle as bounded blockers and can be canceled', async () => {
  const entered = deferred();
  const never = deferred();
  const { coordinator, timers } = createHarness({ hookTimeoutMs: 10 });
  coordinator.registerParticipant({
    id: 'hung-terminal',
    getBlocker: async () => {
      entered.resolve();
      return never.promise;
    },
  });
  const prepared = await coordinator.prepareChoose();
  const commit = coordinator.commit({ transitionId: prepared.transitionId });
  await entered.promise;
  timers.fireAll();
  const result = await commit;

  assert.equal(result.code, 'participants_active');
  assert.deepEqual(result.blockers, [
    { id: 'hung-terminal', reason: 'participant_check_timeout' },
  ]);
  assert.equal(coordinator.captureContext().phase, 'ready');
  assert.equal(coordinator.cancel({ transitionId: prepared.transitionId }).canceled, true);
  never.resolve(null);
});

test('delayed persistence failure settles before rollback begins', async () => {
  const entered = deferred();
  const release = deferred();
  const { coordinator, calls, timers } = createHarness({
    hookTimeoutMs: 10,
    hooks: {
      applyRootPath: async () => {
        entered.resolve();
        await release.promise;
        const error = new Error('persistence failed');
        error.code = 'EIO';
        throw error;
      },
    },
  });
  const prepared = await coordinator.prepareChoose();
  const commit = coordinator.commit({ transitionId: prepared.transitionId });
  let settled = false;
  void commit.finally(() => { settled = true; });
  await entered.promise;

  // Mutation-kill: a Promise.race timeout would start rollback here while the
  // persistence hook was still live. No compensating stage may overlap it.
  timers.fireAll();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(calls.map((entry) => entry[0]), ['stop', 'apply']);

  release.resolve();
  const result = await commit;

  assert.equal(result.stage, 'persistence');
  assert.equal(result.rolledBack, true);
  assert.equal(result.rollbackIncomplete, undefined);
  assert.equal(result.context.phase, 'ready');
  assert.deepEqual(
    calls.map((entry) => entry[0]),
    ['stop', 'apply', 'stop', 'restore', 'refresh', 'start']
  );
});

test('mutation drain timeout returns bounded blockers and a release-and-retry succeeds', async () => {
  const { coordinator, timers } = createHarness({ mutationDrainTimeoutMs: 10 });
  const mutation = coordinator.acquireOperation({ kind: 'mutation', cancellable: false });
  const prepared = await coordinator.prepareChoose();
  const firstCommit = coordinator.commit({ transitionId: prepared.transitionId });
  for (let turn = 0; turn < 20 && coordinator._mutationWaiters.size < 1; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(coordinator._mutationWaiters.size, 1, 'mutation drain waiter is registered');
  assert.equal(timers.size, 1, 'only the mutation-drain deadline remains armed during commit');
  timers.fireAll();
  const blocked = await firstCommit;

  assert.equal(blocked.code, 'mutations_active');
  assert.deepEqual(blocked.blockers, [
    { id: mutation.operationId, reason: 'mutation_active' },
  ]);
  mutation.release();
  const committed = await coordinator.commit({ transitionId: prepared.transitionId });
  assert.equal(committed.committed, true);
});

test('prepared transition expires without changing the root or reusing its id', async () => {
  const { coordinator, timers } = createHarness({ transitionTtlMs: 10 });
  const prepared = await coordinator.prepareChoose();
  assert.equal(timers.size, 1);
  timers.fireAll();

  assert.deepEqual(coordinator.captureContext(), {
    rootPath: 'G:/workspace/old',
    rootId: 'root:g:/workspace/old',
    generation: 0,
    phase: 'ready',
  });
  const stale = await coordinator.commit({ transitionId: prepared.transitionId });
  assert.equal(stale.committed, false);
  assert.equal(stale.code, 'transition_not_found');

  const next = await coordinator.prepareClear();
  assert.equal(next.transitionId, 'transition-2');
  assert.equal(next.candidate.generation, 1);
});

test('a cleared expiry callback cannot cancel a re-armed prepared transition', async () => {
  const { coordinator, timers } = createHarness({ transitionTtlMs: 10 });
  coordinator.registerParticipant({
    id: 'terminal',
    getBlocker: () => ({ reason: 'terminal_active' }),
  });
  const prepared = await coordinator.prepareChoose();
  const [staleExpiry] = timers.snapshot();

  const blocked = await coordinator.commit({ transitionId: prepared.transitionId });
  assert.equal(blocked.code, 'participants_active');
  staleExpiry();

  assert.equal(coordinator.captureContext().phase, 'ready');
  assert.equal(
    (await coordinator.commit({ transitionId: prepared.transitionId })).code,
    'participants_active'
  );
});

test('same-root target is a no-op and concurrent commit calls apply once', async () => {
  const same = createHarness({ chooseResult: { canceled: false, path: 'G:\\workspace\\old\\' } });
  const noOp = await same.coordinator.prepareChoose();
  assert.equal(noOp.noop, true);
  assert.equal(noOp.changed, false);
  assert.equal(same.coordinator.captureContext().generation, 0);

  const gate = deferred();
  let applyCalls = 0;
  const harness = createHarness({
    hooks: {
      applyRootPath: async () => {
        applyCalls += 1;
        await gate.promise;
      },
    },
  });
  const prepared = await harness.coordinator.prepareChoose();
  const first = harness.coordinator.commit({ transitionId: prepared.transitionId });
  const second = harness.coordinator.commit({ transitionId: prepared.transitionId });
  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.committed, true);
  assert.equal(secondResult.committed, true);
  assert.equal(applyCalls, 1);
});
