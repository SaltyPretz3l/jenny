const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceStateController } = require('../renderer/shell/renderer-workspace-state-utils');

function createWorkspaceShell(initialState = {}) {
  const normalizedActiveSessionId = String(initialState.activeSessionId || '').trim();
  const normalizedOpenSessionIds = Array.isArray(initialState.openSessionIds) ? initialState.openSessionIds.slice() : [];
  let stored = {
    activeSessionId: normalizedActiveSessionId,
    openSessionIds: normalizedOpenSessionIds,
  };
  const updates = [];
  return {
    updates,
    shell: {
      workspace: {
        async getState() {
          return { activeSessionId: stored.activeSessionId, openSessionIds: stored.openSessionIds.slice() };
        },
        async updateState(patch) {
          updates.push({ activeSessionId: patch.activeSessionId, openSessionIds: patch.openSessionIds.slice() });
          stored = {
            ...stored,
            ...patch,
            openSessionIds: Array.isArray(patch.openSessionIds) ? patch.openSessionIds.slice() : stored.openSessionIds.slice(),
          };
          return { activeSessionId: stored.activeSessionId, openSessionIds: stored.openSessionIds.slice() };
        },
      },
    },
  };
}

test('workspace state controller maintains insertion order for tabs and MRU order for cycling', async () => {
  const bridge = createWorkspaceShell();
  const published = [];
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    onStateChanged(snapshot) {
      published.push(snapshot);
    },
  });

  assert.deepEqual(await controller.openSession('session-1'), {
    activeSessionId: 'session-1',
    openSessionIds: ['session-1'],
  });
  assert.deepEqual(await controller.openSession('session-2'), {
    activeSessionId: 'session-2',
    openSessionIds: ['session-1', 'session-2'],
  });
  assert.deepEqual(await controller.openSession('session-1'), {
    activeSessionId: 'session-1',
    openSessionIds: ['session-1', 'session-2'],
  });
  assert.deepEqual(await controller.cycleNext(), {
    activeSessionId: 'session-2',
    openSessionIds: ['session-1', 'session-2'],
  });
  assert.deepEqual(await controller.cyclePrev(), {
    activeSessionId: 'session-1',
    openSessionIds: ['session-1', 'session-2'],
  });
  assert.equal(await controller.closeSession('session-1'), true);
  assert.deepEqual(controller.getState(), {
    activeSessionId: 'session-2',
    openSessionIds: ['session-2'],
  });
  assert.equal(bridge.updates.length, 6);
  assert.deepEqual(published.at(-1), controller.getState());
});

test('workspace state controller restore prunes invalid ids, enforces the rail cap, and falls back to a valid active session', async () => {
  const bridge = createWorkspaceShell({
    activeSessionId: 'missing',
    openSessionIds: ['ghost', 's3', 's3', 's2', 's1', 's10', 's9', 's8', 's7', 's6', 's5'],
  });
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  const restored = await controller.restore(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);

  assert.deepEqual(restored, {
    activeSessionId: 's3',
    openSessionIds: ['s3', 's2', 's1', 's10', 's9', 's8', 's7', 's6'],
  });
  assert.equal(restored.openSessionIds.length, 8);
  assert.deepEqual(bridge.updates.at(-1), restored);
});

test('workspace state controller refuses to close a busy session', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    isSessionBusy(sessionId) {
      return sessionId === 'session-2';
    },
  });

  await controller.openSession('session-1');
  await controller.openSession('session-2');
  const updateCountBeforeClose = bridge.updates.length;

  assert.equal(await controller.closeSession('session-2'), false);
  assert.deepEqual(controller.getState(), {
    activeSessionId: 'session-2',
    openSessionIds: ['session-1', 'session-2'],
  });
  assert.equal(bridge.updates.length, updateCountBeforeClose);
});

test('workspace state controller serializes persistence so slower writes cannot overwrite newer state', async () => {
  let callIndex = 0;
  let stored = { activeSessionId: '', openSessionIds: [] };
  const controller = createWorkspaceStateController({
    jennyShell: {
      workspace: {
        async getState() {
          return { activeSessionId: stored.activeSessionId, openSessionIds: stored.openSessionIds.slice() };
        },
        async updateState(patch) {
          callIndex += 1;
          const currentCall = callIndex;
          await new Promise((resolve) => setTimeout(resolve, currentCall === 1 ? 20 : 0));
          stored = { activeSessionId: patch.activeSessionId, openSessionIds: patch.openSessionIds.slice() };
          return { activeSessionId: stored.activeSessionId, openSessionIds: stored.openSessionIds.slice() };
        },
      },
    },
  });

  const firstOpen = controller.openSession('session-1');
  const secondOpen = controller.openSession('session-2');

  assert.deepEqual(await firstOpen, {
    activeSessionId: 'session-1',
    openSessionIds: ['session-1'],
  });
  assert.deepEqual(await secondOpen, {
    activeSessionId: 'session-2',
    openSessionIds: ['session-1', 'session-2'],
  });
  assert.deepEqual(stored, {
    activeSessionId: 'session-2',
    openSessionIds: ['session-1', 'session-2'],
  });
});

test('closeSession rechecks busy state after entering the serialized mutation', async () => {
  let busy = false;
  let blockNext = false;
  let releaseBlocked;
  let notifyBlocked;
  const blocked = new Promise((resolve) => { releaseBlocked = resolve; });
  const blockerEntered = new Promise((resolve) => { notifyBlocked = resolve; });
  const bridge = createWorkspaceShell();
  const originalUpdate = bridge.shell.workspace.updateState;
  bridge.shell.workspace.updateState = async (patch) => {
    if (blockNext) {
      blockNext = false;
      notifyBlocked();
      await blocked;
    }
    return originalUpdate(patch);
  };
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    isSessionBusy: () => busy,
  });
  await controller.openSession('s1');
  await controller.openSession('s2');
  blockNext = true;
  const blocker = controller.openSession('s1');
  await blockerEntered;
  const close = controller.closeSession('s2');
  busy = true;
  releaseBlocked();

  await blocker;
  assert.equal(await close, false);
  assert.deepEqual(controller.getState(), {
    activeSessionId: 's1',
    openSessionIds: ['s1', 's2'],
  });
});

test('persistence rejection restores and republishes prior state, then a retry succeeds', async () => {
  const bridge = createWorkspaceShell();
  const published = [];
  const failures = [];
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    onStateChanged: (value) => published.push(value),
    onPersistenceError: (value) => failures.push(value),
  });
  await controller.openSession('s1');
  await controller.openSession('s2');
  const originalUpdate = bridge.shell.workspace.updateState;
  let rejectNext = true;
  bridge.shell.workspace.updateState = async (patch) => {
    if (rejectNext) {
      rejectNext = false;
      throw new Error('disk unavailable');
    }
    return originalUpdate(patch);
  };

  await assert.rejects(controller.closeSession('s2'), /disk unavailable/);
  assert.deepEqual(controller.getState(), {
    activeSessionId: 's2',
    openSessionIds: ['s1', 's2'],
  });
  assert.deepEqual(published.at(-1), controller.getState());
  assert.deepEqual(failures, [{ code: 'workspace_state_persist_failed' }]);

  assert.equal(await controller.closeSession('s2'), true);
  assert.deepEqual(controller.getState(), {
    activeSessionId: 's1',
    openSessionIds: ['s1'],
  });
});

test('two concurrent closes serialize without resurrecting a closed session', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });
  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');

  const [closedOne, closedTwo] = await Promise.all([
    controller.closeSession('s2'),
    controller.closeSession('s3'),
  ]);

  assert.deepEqual([closedOne, closedTwo], [true, true]);
  assert.deepEqual(controller.getState(), {
    activeSessionId: 's1',
    openSessionIds: ['s1'],
  });
});

test('cycleNext follows MRU order, not visual tab order', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');
  // Visual order: ['s1', 's2', 's3'], active=s3
  // MRU: ['s3', 's2', 's1']

  await controller.openSession('s1');
  // Visual order: ['s1', 's2', 's3'], active=s1
  // MRU: ['s1', 's3', 's2']

  const afterCycle = await controller.cycleNext();
  // cycleNext: idx=0 in MRU ['s1','s3','s2'] → next=s3
  assert.equal(afterCycle.activeSessionId, 's3');
  assert.deepEqual(afterCycle.openSessionIds, ['s1', 's2', 's3']);
});

test('openSession inserts new tab after active tab', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');
  // s1 active, s2 after s1, s3 after s2 → ['s1', 's2', 's3']
  // Wait — s1 is opened first (active=s1), then s2 inserts after s1 (active=s2), then s3 inserts after s2 (active=s3)
  assert.deepEqual(controller.getState().openSessionIds, ['s1', 's2', 's3']);

  // Activate s1, then open s4 → inserts after s1
  await controller.openSession('s1');
  await controller.openSession('s4');
  assert.deepEqual(controller.getState().openSessionIds, ['s1', 's4', 's2', 's3']);
  assert.equal(controller.getState().activeSessionId, 's4');
});

test('openSession on already-open session does not move it', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');

  await controller.openSession('s1');
  assert.deepEqual(controller.getState().openSessionIds, ['s1', 's2', 's3']);
  assert.equal(controller.getState().activeSessionId, 's1');
});

test('reorderSession moves tab within visual order without affecting MRU', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');
  // MRU: ['s3','s2','s1'], visual: ['s1','s2','s3']

  await controller.reorderSession('s1', 2);
  assert.deepEqual(controller.getState().openSessionIds, ['s2', 's3', 's1']);

  // cycleNext still follows MRU, not visual order
  // active=s3, MRU=['s3','s2','s1']
  const afterCycle = await controller.cycleNext();
  assert.equal(afterCycle.activeSessionId, 's2');
});

test('reorderSession clamps out-of-bounds index', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');

  await controller.reorderSession('s1', 100);
  assert.deepEqual(controller.getState().openSessionIds, ['s2', 's3', 's1']);

  await controller.reorderSession('s1', -5);
  assert.deepEqual(controller.getState().openSessionIds, ['s1', 's2', 's3']);
});

test('reorderSession to same index is a no-op', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  const updatesBefore = bridge.updates.length;

  await controller.reorderSession('s1', 0);
  assert.equal(bridge.updates.length, updatesBefore);
});

test('reorderSession with nonexistent session is a no-op', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  const updatesBefore = bridge.updates.length;

  await controller.reorderSession('nonexistent', 0);
  assert.equal(bridge.updates.length, updatesBefore);
});

test('closeOtherSessions keeps only the specified session and busy sessions', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    isSessionBusy(id) { return id === 's3'; },
  });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');
  await controller.openSession('s4');

  const result = await controller.closeOtherSessions('s1');
  assert.deepEqual(result, { closed: 2, skipped: 1 });
  assert.deepEqual(controller.getState().openSessionIds, ['s1', 's3']);
  assert.equal(controller.getState().activeSessionId, 's1');
});

test('closeSessionsToRight closes sessions after anchor, skips busy', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    isSessionBusy(id) { return id === 's3'; },
  });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');
  await controller.openSession('s4');

  const result = await controller.closeSessionsToRight('s1');
  assert.deepEqual(result, { closed: 2, skipped: 1 });
  assert.deepEqual(controller.getState().openSessionIds, ['s1', 's3']);
});

test('closeSessionsToRight at last position is a no-op', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');

  const result = await controller.closeSessionsToRight('s2');
  assert.deepEqual(result, { closed: 0, skipped: 0 });
  assert.deepEqual(controller.getState().openSessionIds, ['s1', 's2']);
});

test('closeAllSessions closes all non-busy sessions', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    isSessionBusy(id) { return id === 's2'; },
  });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');

  const result = await controller.closeAllSessions();
  assert.deepEqual(result, { closed: 2, skipped: 1 });
  assert.deepEqual(controller.getState().openSessionIds, ['s2']);
  assert.equal(controller.getState().activeSessionId, 's2');
});

test('cap eviction evicts least-recently-used non-busy session', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  // Fill to cap
  for (let i = 1; i <= 8; i++) {
    await controller.openSession(`s${i}`);
  }
  assert.equal(controller.getState().openSessionIds.length, 8);
  // MRU: ['s8','s7','s6','s5','s4','s3','s2','s1']

  // Open s9 — should evict s1 (last in MRU, not active, not busy)
  await controller.openSession('s9');
  const state = controller.getState();
  assert.equal(state.openSessionIds.length, 8);
  assert.equal(state.openSessionIds.includes('s1'), false);
  assert.equal(state.openSessionIds.includes('s9'), true);
});

test('cap eviction refuses open when all non-active sessions are busy', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    isSessionBusy(id) { return id !== 's8'; },
  });

  for (let i = 1; i <= 8; i++) {
    await controller.openSession(`s${i}`);
  }
  // active=s8, all others busy
  const updatesBefore = bridge.updates.length;

  const result = await controller.openSession('s9');
  assert.equal(result.openSessionIds.includes('s9'), false);
  assert.equal(result.openSessionIds.length, 8);
  assert.equal(bridge.updates.length, updatesBefore);
});

test('closing the only open tab clears both arrays', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  assert.equal(await controller.closeSession('s1'), true);
  assert.deepEqual(controller.getState(), {
    activeSessionId: '',
    openSessionIds: [],
  });
});

test('close fallback picks most-recently-used session', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');
  // MRU: ['s3','s2','s1'], active=s3

  await controller.openSession('s1');
  // MRU: ['s1','s3','s2'], active=s1

  await controller.closeSession('s1');
  // Fallback from MRU: s3
  assert.equal(controller.getState().activeSessionId, 's3');
});

test('restore rebuilds mruStack so cycleNext works from cold start', async () => {
  const bridge = createWorkspaceShell({
    activeSessionId: 's2',
    openSessionIds: ['s1', 's2', 's3'],
  });
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.restore(['s1', 's2', 's3']);
  // mruStack rebuilt: ['s2', 's1', 's3'] (active first, then remaining in persisted order)

  const afterCycle = await controller.cycleNext();
  // cycleNext: idx=0 in MRU ['s2','s1','s3'] → next=s1
  assert.equal(afterCycle.activeSessionId, 's1');
  assert.deepEqual(afterCycle.openSessionIds, ['s1', 's2', 's3']);
});

test('cap eviction respects MRU order — evicts LRU, not recently activated', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  for (let i = 1; i <= 8; i++) {
    await controller.openSession(`s${i}`);
  }
  // MRU: ['s8','s7','s6','s5','s4','s3','s2','s1']

  // Activate s1 so it's the most recently used after s8
  await controller.openSession('s1');
  // MRU: ['s1','s8','s7','s6','s5','s4','s3','s2']

  // Open s9 — should evict s2 (LRU tail, not s1 which is now active)
  await controller.openSession('s9');
  const state = controller.getState();
  assert.equal(state.openSessionIds.includes('s1'), true, 's1 should survive (recently activated)');
  assert.equal(state.openSessionIds.includes('s2'), false, 's2 should be evicted (LRU tail)');
  assert.equal(state.openSessionIds.includes('s9'), true, 's9 should be added');
  assert.equal(state.openSessionIds.length, 8);
});

test('closing a non-active session keeps the current active unchanged', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  await controller.openSession('s3');
  // active=s3

  assert.equal(await controller.closeSession('s1'), true);
  assert.equal(controller.getState().activeSessionId, 's3', 'active should remain s3');
  assert.deepEqual(controller.getState().openSessionIds, ['s2', 's3']);
});

test('cycleNext and cyclePrev are no-ops with fewer than 2 sessions', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  // 0 sessions
  assert.deepEqual(await controller.cycleNext(), { activeSessionId: '', openSessionIds: [] });
  assert.deepEqual(await controller.cyclePrev(), { activeSessionId: '', openSessionIds: [] });

  // 1 session
  await controller.openSession('s1');
  const updatesBefore = bridge.updates.length;
  assert.deepEqual(await controller.cycleNext(), { activeSessionId: 's1', openSessionIds: ['s1'] });
  assert.deepEqual(await controller.cyclePrev(), { activeSessionId: 's1', openSessionIds: ['s1'] });
  assert.equal(bridge.updates.length, updatesBefore);
});

test('held Ctrl walks the full MRU snapshot without oscillation, then commits once on release', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  // Open in reverse so the MRU stack ends up [s1, s2, s3] with s1 active.
  await controller.openSession('s3'); // MRU ['s3']
  await controller.openSession('s2'); // MRU ['s2', 's3']
  await controller.openSession('s1'); // MRU ['s1', 's2', 's3'], active s1

  // Three consecutive Ctrl+Tab presses with Ctrl HELD (no commit between them)
  // walk the frozen snapshot s1 → s2 → s3, then wrap to s1 — never oscillating
  // between just the two most-recent tabs.
  assert.equal((await controller.cycleNext()).activeSessionId, 's2');
  assert.equal((await controller.cycleNext()).activeSessionId, 's3');
  assert.equal((await controller.cycleNext()).activeSessionId, 's1');

  // Land on s3, then release Ctrl. commitCycle promotes s3 to the MRU front once.
  await controller.cycleNext(); // → s2
  await controller.cycleNext(); // → s3
  await controller.commitCycle();
  assert.equal(controller.getState().activeSessionId, 's3');

  // A FRESH gesture now snapshots the committed MRU [s3, s1, s2]: next after s3
  // is s1 — proving the promotion landed and the prior snapshot was discarded.
  assert.equal((await controller.cycleNext()).activeSessionId, 's1');
});

test('cycling does not persist the MRU promotion until commitCycle (one extra write, not per press)', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s3');
  await controller.openSession('s2');
  await controller.openSession('s1'); // active s1, MRU ['s1','s2','s3']

  const updatesBeforeCycle = bridge.updates.length;
  await controller.cycleNext(); // → s2 (active/open changed → 1 write)
  await controller.cycleNext(); // → s3 (1 write)
  assert.equal(bridge.updates.length, updatesBeforeCycle + 2);

  // commitCycle only reorders in-memory mruStack; {active, open} is unchanged,
  // so it must NOT emit another persist write.
  await controller.commitCycle();
  assert.equal(bridge.updates.length, updatesBeforeCycle + 2);
});

test('a single Ctrl+Tab then release still toggles between the two most-recent tabs', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1'); // MRU ['s1']
  await controller.openSession('s2'); // MRU ['s2', 's1'], active s2

  // Tap once and release: go to the previous tab and promote it.
  assert.equal((await controller.cycleNext()).activeSessionId, 's1');
  await controller.commitCycle(); // MRU ['s1', 's2']

  // Repeat the gesture: flips back to s2 (the now-previous tab).
  assert.equal((await controller.cycleNext()).activeSessionId, 's2');
  await controller.commitCycle(); // MRU ['s2', 's1']

  // And again: back to s1. The deliberate two-tab toggle survives.
  assert.equal((await controller.cycleNext()).activeSessionId, 's1');
});

test('cyclePrev reverses within the same frozen snapshot while Ctrl is held', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s3');
  await controller.openSession('s2');
  await controller.openSession('s1'); // active s1, MRU ['s1','s2','s3']

  // Forward two steps, then back two steps — all on the same frozen snapshot.
  assert.equal((await controller.cycleNext()).activeSessionId, 's2');
  assert.equal((await controller.cycleNext()).activeSessionId, 's3');
  assert.equal((await controller.cyclePrev()).activeSessionId, 's2');
  assert.equal((await controller.cyclePrev()).activeSessionId, 's1');
});

test('commitCycle with no gesture in flight returns null and writes nothing', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s1');
  await controller.openSession('s2');
  const updatesBefore = bridge.updates.length;

  // No cycleNext/cyclePrev preceded this — there is nothing to commit.
  assert.equal(await controller.commitCycle(), null);
  assert.equal(bridge.updates.length, updatesBefore);

  // A committed gesture, by contrast, resolves to the snapshot (not null).
  await controller.cycleNext();
  const committed = await controller.commitCycle();
  assert.notEqual(committed, null);
  assert.equal(committed.activeSessionId, controller.getState().activeSessionId);
});

test('a real activation mid-gesture abandons the frozen cycle snapshot', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('s3');
  await controller.openSession('s2');
  await controller.openSession('s1'); // active s1, MRU ['s1','s2','s3']

  await controller.cycleNext(); // → s2 (cycle in flight, frozen ['s1','s2','s3'])
  // Clicking a tab is a real promotion: it must reset the cycle AND push MRU.
  await controller.openSession('s3'); // MRU ['s3','s1','s2'] (or similar), cycle reset

  // Next Ctrl+Tab snapshots fresh from the post-activation MRU, not the stale one.
  assert.equal((await controller.cycleNext()).activeSessionId, 's1');
});

test('replaceActiveSession swaps the active tab in place', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('a'); // ['a'] active a
  await controller.openSession('b'); // ['a','b'] active b
  await controller.openSession('c'); // ['a','b','c'] active c
  await controller.openSession('b'); // active b, order unchanged

  const result = await controller.replaceActiveSession('d');
  // b's slot (index 1) is swapped for d; tab count unchanged.
  assert.deepEqual(result.openSessionIds, ['a', 'd', 'c']);
  assert.equal(result.activeSessionId, 'd');
});

test('replaceActiveSession on an already-open session just activates it (no duplicate)', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('a');
  await controller.openSession('b');
  await controller.openSession('c'); // active c

  const result = await controller.replaceActiveSession('a');
  assert.deepEqual(result.openSessionIds, ['a', 'b', 'c']);
  assert.equal(result.activeSessionId, 'a');
});

test('replaceActiveSession falls back to a new tab when the active tab is busy', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({
    jennyShell: bridge.shell,
    isSessionBusy(id) { return id === 'b'; },
  });

  await controller.openSession('a'); // ['a'] active a
  await controller.openSession('b'); // ['a','b'] active b (busy)

  const result = await controller.replaceActiveSession('c');
  // b is busy → must not be discarded; c opens as a new tab after b.
  assert.deepEqual(result.openSessionIds, ['a', 'b', 'c']);
  assert.equal(result.activeSessionId, 'c');
});

test('replaceActiveSession opens the first tab when the rail is empty', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  const result = await controller.replaceActiveSession('a');
  assert.deepEqual(result.openSessionIds, ['a']);
  assert.equal(result.activeSessionId, 'a');
});

test('replaceActiveSession with an empty id is a no-op', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('a');
  const updatesBefore = bridge.updates.length;

  const result = await controller.replaceActiveSession('   ');
  assert.deepEqual(result, { activeSessionId: 'a', openSessionIds: ['a'] });
  assert.equal(bridge.updates.length, updatesBefore);
});

test('restoreSnapshot rolls back and persists a prior tab snapshot', async () => {
  const bridge = createWorkspaceShell();
  const controller = createWorkspaceStateController({ jennyShell: bridge.shell });

  await controller.openSession('a');
  await controller.openSession('b');
  const checkpoint = controller.getState();
  await controller.replaceActiveSession('c');

  assert.deepEqual(await controller.restoreSnapshot(checkpoint), checkpoint);
  assert.deepEqual(controller.getState(), checkpoint);
  assert.deepEqual(bridge.updates.at(-1), checkpoint);
});

test('restoreSnapshot preserves MRU order from a rollback snapshot', async () => {
  const controller = createWorkspaceStateController({ jennyShell: createWorkspaceShell().shell });

  await controller.openSession('a');
  await controller.openSession('b');
  await controller.openSession('c');
  await controller.openSession('b'); // MRU: b, c, a
  const checkpoint = controller.getRollbackSnapshot();
  await controller.replaceActiveSession('d');

  await controller.restoreSnapshot(checkpoint);

  assert.equal((await controller.cycleNext()).activeSessionId, 'c');
});
