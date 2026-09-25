const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceStateController } = require('../renderer/shell/renderer-workspace-state-utils');

function harness() {
  let saved = { activeSessionId: '', openSessionIds: [] };
  let fail = false;
  const errors = [];
  const controller = createWorkspaceStateController({
    jennyShell: { workspace: {
      getState: async () => structuredClone(saved),
      updateState: async (next) => { if (fail) throw Error('disk unavailable'); saved = structuredClone(next); },
    } },
    onPersistenceError: (error) => errors.push(error),
    isSessionBusy: () => true,
  });
  return { controller, errors, setFailure(value) { fail = value; } };
}

for (const background of [false, true]) {
  test(`draft B promotes to C without tab loss (${background ? 'background' : 'active'})`, async () => {
    const { controller: c } = harness();
    await c.openSession('A');
    await c.openSession('B');
    if (background) await c.openSession('A');
    await c.rekeySession('B', 'C');
    assert.deepEqual(await c.restore(['A', 'C']), {
      activeSessionId: background ? 'A' : 'C', openSessionIds: ['A', 'C'],
    });
  });
}

test('promotion deduplicates target at source position and migrates cycling state', async () => {
  const { controller: c } = harness();
  for (const id of ['C', 'A', 'B']) await c.openSession(id);
  await c.cycleNext();
  await c.rekeySession('B', 'C');
  const snapshot = c.getRollbackSnapshot();
  assert.deepEqual(snapshot.openSessionIds, ['A', 'C']);
  assert.equal(snapshot.activeSessionId, 'A');
  assert.deepEqual(snapshot.cycleSnapshot, ['C', 'A']);
  assert.equal(snapshot.cycleCursor, 1);
  assert.equal((await c.cycleNext()).activeSessionId, 'C');
});

test('canonical identity survives persistence failure and stale saved IDs', async () => {
  const h = harness(); const c = h.controller;
  await c.openSession('A'); await c.openSession('B');
  h.setFailure(true);
  await c.rekeySession('B', 'C');
  assert.deepEqual(c.getState(), { activeSessionId: 'C', openSessionIds: ['A', 'C'] });
  assert.equal(h.errors.length, 1);
  h.setFailure(false);
  assert.deepEqual(await c.restore(['A', 'C']), { activeSessionId: 'C', openSessionIds: ['A', 'C'] });
});

test('refresh queued behind promotion maps stale valid IDs and retains newer navigation', async () => {
  const { controller: c } = harness();
  await c.openSession('A'); await c.openSession('B');
  const promotion = c.rekeySession('B', 'C');
  const navigation = c.openSession('A');
  const refresh = c.restore(['A', 'B'], { preserveCurrentSession: true });
  await Promise.all([promotion, navigation, refresh]);
  assert.deepEqual(c.getState(), { activeSessionId: 'A', openSessionIds: ['A', 'C'] });
});

test('promoting a session no tab holds publishes nothing, so the renderer keeps its current session', async () => {
  // First send in a new chat: the optimistic shell never became a tab, so its
  // rekey must not republish the workspace's stale active id (it flipped
  // state.currentSessionId to '' mid-handoff and a render in that window
  // painted an empty chat with no Stop button).
  const published = [];
  let writes = 0;
  const c = createWorkspaceStateController({
    jennyShell: { workspace: { getState: async () => ({}), updateState: async (next) => { writes += 1; return next; } } },
    onStateChanged: (snapshot) => published.push(snapshot),
  });
  assert.deepEqual(await c.rekeySession('session_local_1', 'session-real'), { activeSessionId: '', openSessionIds: [] });
  await c.openSession('A');
  const before = { published: published.length, writes };
  assert.deepEqual(await c.rekeySession('session_local_2', 'session-real-2'), { activeSessionId: 'A', openSessionIds: ['A'] });
  assert.deepEqual({ published: published.length, writes }, before);
  assert.deepEqual(published, [{ activeSessionId: 'A', openSessionIds: ['A'] }]);
});