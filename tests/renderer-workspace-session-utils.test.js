const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceSessionCoordinator } = require('../renderer/shell/renderer-workspace-session-utils');
const { createWorkspaceStateController } = require('../renderer/shell/renderer-workspace-state-utils');

// Minimal in-memory workspace bridge so the real state controller drives the
// MRU/cycle logic end-to-end through the keyboard coordinator.
function createWorkspaceShell() {
  let stored = { activeSessionId: '', openSessionIds: [] };
  return {
    workspace: {
      async getState() {
        return { activeSessionId: stored.activeSessionId, openSessionIds: stored.openSessionIds.slice() };
      },
      async updateState(patch) {
        stored = {
          activeSessionId: patch.activeSessionId,
          openSessionIds: Array.isArray(patch.openSessionIds) ? patch.openSessionIds.slice() : [],
        };
        return { activeSessionId: stored.activeSessionId, openSessionIds: stored.openSessionIds.slice() };
      },
    },
  };
}

// Build a coordinator wired to a real workspace state controller. Returns the
// coordinator, the controller, and recorders for the renderer callbacks the
// Ctrl+Tab handler drives (openSession / renderAll).
function createHarness({ getOpenSessionsInNewTab, openSession: openSessionImpl } = {}) {
  const wsc = createWorkspaceStateController({ jennyShell: createWorkspaceShell() });
  const openSessionCalls = [];
  const openSessionOptions = [];
  let renderAllCount = 0;
  const state = {
    workspace: { activeSessionId: '', openSessionIds: [] },
    currentSessionId: '',
    sessions: [],
    pendingToolApprovals: new Map(),
    activeStreamSessionId: '',
    ui: { activeView: 'chat' },
  };
  const coordinator = createWorkspaceSessionCoordinator({
    state,
    constants: { TOAST_SOURCE: {} },
    dom: { workspaceRailShell: null },
    callbacks: {
      openSession: async (sessionId, options) => {
        openSessionCalls.push(sessionId);
        openSessionOptions.push(options || {});
        if (openSessionImpl) return openSessionImpl(sessionId, options || {}, state);
        state.currentSessionId = sessionId;
        return undefined;
      },
      renderAll: () => { renderAllCount += 1; },
      renderSessions: () => {},
      renderSettings: () => {},
      showToastMessage: () => {},
      showSessionActionError: () => {},
      patchSessionSummary: () => {},
      ...(getOpenSessionsInNewTab ? { getOpenSessionsInNewTab } : {}),
    },
    controllers: {
      getMultiStreamController: () => null,
      getWorkspaceStateController: () => wsc,
      getWorkspaceChromeController: () => null,
    },
    windowRef: globalThis,
  });
  // Mirror the controller's current snapshot into state.workspace, the way the
  // app does on init, so the handler has a correct previous-active to diff.
  coordinator.applyWorkspaceSnapshot(wsc.getState());
  return {
    wsc,
    coordinator,
    state,
    openSessionCalls,
    openSessionOptions,
    getRenderAllCount: () => renderAllCount,
  };
}

function ctrlTabDown({ shift = false } = {}) {
  return { type: 'keydown', key: 'Tab', ctrlKey: true, altKey: false, metaKey: false, shiftKey: shift, target: null, preventDefault() {} };
}
function ctrlUp() {
  return { type: 'keyup', key: 'Control', ctrlKey: false, target: null };
}

async function seedThreeTabs(wsc, coordinator, state) {
  // Open in reverse so MRU ends up [s1, s2, s3] with s1 active.
  await wsc.openSession('s3');
  await wsc.openSession('s2');
  await wsc.openSession('s1');
  coordinator.applyWorkspaceSnapshot(wsc.getState());
  assert.equal(state.workspace.activeSessionId, 's1');
}

test('Ctrl+Tab held: consecutive presses walk the full MRU stack (no oscillation)', async () => {
  const { wsc, coordinator, state, openSessionCalls } = createHarness();
  await seedThreeTabs(wsc, coordinator, state);

  // Three taps with Ctrl held — no keyup between them.
  await coordinator.handleWorkspaceShortcut(ctrlTabDown());
  await coordinator.handleWorkspaceShortcut(ctrlTabDown());
  await coordinator.handleWorkspaceShortcut(ctrlTabDown());

  // Walked s1 → s2 → s3 → (wrap) s1, NOT the old s2 ↔ s1 oscillation.
  assert.deepEqual(openSessionCalls, ['s2', 's3', 's1']);
});

test('releasing Ctrl commits the landed tab to the MRU front exactly once', async () => {
  const { wsc, coordinator, state, openSessionCalls } = createHarness();
  await seedThreeTabs(wsc, coordinator, state);

  // Walk to s3 with Ctrl held, then release.
  await coordinator.handleWorkspaceShortcut(ctrlTabDown()); // → s2
  await coordinator.handleWorkspaceShortcut(ctrlTabDown()); // → s3
  assert.deepEqual(openSessionCalls, ['s2', 's3']);
  await coordinator.handleWorkspaceShortcut(ctrlUp());      // commit s3
  assert.equal(state.workspace.activeSessionId, 's3');

  // A FRESH gesture snapshots the committed MRU [s3, s1, s2]: next is s1.
  await coordinator.handleWorkspaceShortcut(ctrlTabDown());
  assert.equal(state.workspace.activeSessionId, 's1');
  assert.deepEqual(openSessionCalls, ['s2', 's3', 's1']);
});

test('keyup for a non-Control key does not commit an in-flight cycle', async () => {
  const { wsc, coordinator, state } = createHarness();
  await seedThreeTabs(wsc, coordinator, state);

  await coordinator.handleWorkspaceShortcut(ctrlTabDown()); // → s2 (cycle in flight)
  // Releasing Tab (Ctrl still held) must NOT commit — the cycle keeps walking.
  await coordinator.handleWorkspaceShortcut({ type: 'keyup', key: 'Tab', ctrlKey: true, target: null });
  await coordinator.handleWorkspaceShortcut(ctrlTabDown()); // continues frozen snapshot → s3
  assert.equal(state.workspace.activeSessionId, 's3');
});

test('Ctrl+Shift+Tab walks backward through the frozen snapshot', async () => {
  const { wsc, coordinator, state, openSessionCalls } = createHarness();
  await seedThreeTabs(wsc, coordinator, state); // MRU ['s1','s2','s3'], active s1

  // Backward from s1: wrap to s3, then s2.
  await coordinator.handleWorkspaceShortcut(ctrlTabDown({ shift: true }));
  await coordinator.handleWorkspaceShortcut(ctrlTabDown({ shift: true }));
  assert.deepEqual(openSessionCalls, ['s3', 's2']);
});

test('shortcut handler ignores Ctrl+Tab while focused in a text input', async () => {
  const { wsc, coordinator, state, openSessionCalls } = createHarness();
  await seedThreeTabs(wsc, coordinator, state);

  const target = { closest: (sel) => (sel.includes('textarea') ? {} : null), isContentEditable: false };
  await coordinator.handleWorkspaceShortcut({ type: 'keydown', key: 'Tab', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, target, preventDefault() {} });

  assert.deepEqual(openSessionCalls, []);
  assert.equal(state.workspace.activeSessionId, 's1');
});

test('committing with no cycle in flight is a harmless no-op', async () => {
  const { wsc, coordinator, state } = createHarness();
  await seedThreeTabs(wsc, coordinator, state);

  // Release Ctrl without ever tapping Tab.
  await coordinator.handleWorkspaceShortcut(ctrlUp());
  assert.equal(state.workspace.activeSessionId, 's1');
});

async function seedTwoTabs(wsc, coordinator) {
  await wsc.openSession('a');
  await wsc.openSession('b'); // ['a','b'] active b
  coordinator.applyWorkspaceSnapshot(wsc.getState());
}

test('activateWorkspaceSession replaces the active tab by default (pref off)', async () => {
  const { wsc, coordinator, state, openSessionOptions } = createHarness({ getOpenSessionsInNewTab: () => false });
  await seedTwoTabs(wsc, coordinator);

  await coordinator.activateWorkspaceSession('c');
  assert.deepEqual(state.workspace.openSessionIds, ['a', 'c']);
  assert.equal(state.workspace.activeSessionId, 'c');
  assert.equal(openSessionOptions.at(-1).outgoingSessionId, 'b');
});

test('activateWorkspaceSession restores the prior workspace and session when hydration fails', async () => {
  const fixture = createHarness({
    getOpenSessionsInNewTab: () => false,
    openSession: async (sessionId, _options, state) => {
      state.currentSessionId = sessionId;
      if (sessionId === 'c') throw new Error('hydrate failed');
    },
  });
  await seedTwoTabs(fixture.wsc, fixture.coordinator);
  const previousWorkspace = fixture.wsc.getState();

  await assert.rejects(
    fixture.coordinator.activateWorkspaceSession('c'),
    /hydrate failed/
  );

  assert.deepEqual(fixture.wsc.getState(), previousWorkspace);
  assert.deepEqual(fixture.state.workspace, previousWorkspace);
  assert.equal(fixture.state.currentSessionId, 'b');
  assert.deepEqual(fixture.openSessionCalls, ['c', 'b']);
  assert.equal(fixture.openSessionOptions[0].outgoingSessionId, 'b');
  assert.equal(fixture.openSessionOptions[1].outgoingSessionId, 'c');
  assert.equal(fixture.getRenderAllCount(), 1);
});

test('failed workspace activation preserves the prior Ctrl+Tab MRU order', async () => {
  const fixture = createHarness({
    getOpenSessionsInNewTab: () => false,
    openSession: async (sessionId, _options, state) => {
      state.currentSessionId = sessionId;
      if (sessionId === 'd') throw new Error('hydrate failed');
    },
  });
  await fixture.wsc.openSession('a');
  await fixture.wsc.openSession('b');
  await fixture.wsc.openSession('c');
  await fixture.wsc.openSession('b'); // MRU: b, c, a
  fixture.coordinator.applyWorkspaceSnapshot(fixture.wsc.getState());

  await assert.rejects(fixture.coordinator.activateWorkspaceSession('d'), /hydrate failed/);

  assert.equal((await fixture.wsc.cycleNext()).activeSessionId, 'c');
});

test('activateWorkspaceSession restores the prior workspace when hydration is canceled', async () => {
  const fixture = createHarness({
    getOpenSessionsInNewTab: () => false,
    openSession: async (sessionId, _options, state) => {
      if (sessionId === 'c') return false;
      state.currentSessionId = sessionId;
      return true;
    },
  });
  await seedTwoTabs(fixture.wsc, fixture.coordinator);
  const previousWorkspace = fixture.wsc.getState();

  const result = await fixture.coordinator.activateWorkspaceSession('c');

  assert.deepEqual(result, previousWorkspace);
  assert.deepEqual(fixture.wsc.getState(), previousWorkspace);
  assert.deepEqual(fixture.state.workspace, previousWorkspace);
  assert.equal(fixture.state.currentSessionId, 'b');
  assert.deepEqual(fixture.openSessionCalls, ['c']);
  assert.equal(fixture.getRenderAllCount(), 1);
});

test('activateWorkspaceSession opens a new tab when the pref is on', async () => {
  const { wsc, coordinator, state } = createHarness({ getOpenSessionsInNewTab: () => true });
  await seedTwoTabs(wsc, coordinator);

  await coordinator.activateWorkspaceSession('c');
  assert.deepEqual(state.workspace.openSessionIds, ['a', 'b', 'c']);
  assert.equal(state.workspace.activeSessionId, 'c');
});

test('activateWorkspaceSession honors an explicit new-tab mode even when the pref is off', async () => {
  const { wsc, coordinator, state } = createHarness({ getOpenSessionsInNewTab: () => false });
  await seedTwoTabs(wsc, coordinator);

  await coordinator.activateWorkspaceSession('c', { mode: 'new-tab' });
  assert.deepEqual(state.workspace.openSessionIds, ['a', 'b', 'c']);
  assert.equal(state.workspace.activeSessionId, 'c');
});

test('activateWorkspaceSession defaults to replace when no pref accessor is wired', async () => {
  const { wsc, coordinator, state } = createHarness();
  await seedTwoTabs(wsc, coordinator);

  await coordinator.activateWorkspaceSession('c');
  assert.deepEqual(state.workspace.openSessionIds, ['a', 'c']);
  assert.equal(state.workspace.activeSessionId, 'c');
});

test('activateWorkspaceSession drops a stale background navigation before applying its snapshot', async () => {
  let resolveOpen;
  const state = {
    workspace: { activeSessionId: 'parent', openSessionIds: ['parent'] },
    currentSessionId: 'parent',
    sessions: [], pendingToolApprovals: new Map(), activeStreamSessionId: '',
  };
  const openSessionCalls = [];
  const navigationGuard = { current: true, isCurrent() { return this.current; } };
  const coordinator = createWorkspaceSessionCoordinator({
    state,
    constants: { TOAST_SOURCE: {} },
    dom: { workspaceRailShell: null },
    callbacks: {
      openSession: async (sessionId) => { openSessionCalls.push(sessionId); },
      renderAll() {}, renderSessions() {}, renderSettings() {}, showToastMessage() {},
      showSessionActionError() {}, patchSessionSummary() {},
    },
    controllers: {
      getMultiStreamController: () => null,
      getWorkspaceStateController: () => ({
        replaceActiveSession: () => new Promise((resolve) => { resolveOpen = resolve; }),
      }),
      getWorkspaceChromeController: () => null,
    },
    windowRef: globalThis,
  });

  const activation = coordinator.activateWorkspaceSession('branch', {
    silent: true,
    navigationGuard,
  });
  navigationGuard.current = false;
  state.currentSessionId = 'newer-user-choice';
  resolveOpen({ activeSessionId: 'branch', openSessionIds: ['branch'] });
  await activation;

  assert.equal(state.currentSessionId, 'newer-user-choice');
  assert.deepEqual(state.workspace, { activeSessionId: 'parent', openSessionIds: ['parent'] });
  assert.deepEqual(openSessionCalls, []);
});
