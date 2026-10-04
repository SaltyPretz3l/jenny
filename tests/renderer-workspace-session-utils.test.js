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
function createHarness({
  getOpenSessionsInNewTab, openSession: openSessionImpl, isSessionBusy, chrome = null,
  workspaceRailShell = null, windowRef = globalThis, sessions = [], chatsPanel = null, paneModel,
} = {}) {
  const wsc = createWorkspaceStateController({ jennyShell: createWorkspaceShell(), isSessionBusy, paneModel });
  const toasts = [];
  const errors = [];
  const patches = [];
  const chromeRenders = [];
  const openSessionCalls = [];
  const openSessionOptions = [];
  let renderAllCount = 0;
  const state = {
    workspace: { activeSessionId: '', openSessionIds: [] },
    currentSessionId: '',
    sessions,
    pendingToolApprovals: new Map(),
    activeStreamSessionId: '',
    ui: { activeView: 'chat' },
  };
  const coordinator = createWorkspaceSessionCoordinator({
    state,
    constants: { TOAST_SOURCE: {} },
    dom: { workspaceRailShell },
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
      renderWorkspaceChrome: (options) => { chromeRenders.push(options || {}); },
      showToastMessage: (message, options) => { toasts.push({ message, ...options }); },
      showSessionActionError: (error, title) => { errors.push({ error, title }); },
      patchSessionSummary: (sessionId, patch) => {
        patches.push([sessionId, patch]);
        const summary = state.sessions.find((entry) => entry.id === sessionId);
        if (summary) Object.assign(summary, patch);
      },
      ...(getOpenSessionsInNewTab ? { getOpenSessionsInNewTab } : {}),
    },
    controllers: {
      // The app hands the state controller the coordinator's own busy
      // predicate; mirror that so both sides agree on which tabs are busy.
      getMultiStreamController: () => (isSessionBusy ? {
        getStreamingSessionIds: () => wsc.getState().openSessionIds.filter((id) => isSessionBusy(id)),
        getApprovalPendingSessionIds: () => [],
      } : null),
      getWorkspaceStateController: () => wsc,
      getWorkspaceChromeController: () => chrome,
      getChatsPanelController: () => chatsPanel,
    },
    windowRef,
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
    toasts,
    errors,
    patches,
    chromeRenders,
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

test('Ctrl+Tab cycles while focus is in a text input; Ctrl+W stays suppressed there', async () => {
  const { wsc, coordinator, state, openSessionCalls } = createHarness();
  await seedThreeTabs(wsc, coordinator, state);

  // Focus usually lives in the composer: tab switching must work from there.
  const target = { closest: (sel) => (sel.includes('textarea') ? {} : null), isContentEditable: false };
  await coordinator.handleWorkspaceShortcut({ type: 'keydown', key: 'Tab', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, target, preventDefault() {} });
  assert.deepEqual(openSessionCalls, ['s2']);
  assert.equal(state.workspace.activeSessionId, 's2');

  await coordinator.handleWorkspaceShortcut({ type: 'keydown', key: 'Tab', ctrlKey: true, altKey: false, metaKey: false, shiftKey: true, target, preventDefault() {} });
  assert.equal(state.workspace.activeSessionId, 's1', 'Ctrl+Shift+Tab also works from a text input');

  let prevented = false;
  await coordinator.handleWorkspaceShortcut({ type: 'keydown', key: 'w', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, target, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'Ctrl+W is left to the text input');
  assert.deepEqual(state.workspace.openSessionIds.slice().sort(), ['s1', 's2', 's3']);
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

test('a restore before sign-in is deferred: the stored tabs survive and the signed-in load restores them from storage', async () => {
  let stored = { activeSessionId: 's2', openSessionIds: ['s1', 's2'] };
  const writes = [];
  const wsc = createWorkspaceStateController({ jennyShell: { workspace: {
    async getState() { return { ...stored, openSessionIds: stored.openSessionIds.slice() }; },
    async updateState(patch) { writes.push(patch); stored = { ...stored, ...patch }; return stored; },
  } } });
  let restoredHooks = 0;
  const state = {
    auth: { authenticated: false }, workspace: { activeSessionId: '', openSessionIds: [] },
    currentSessionId: '', sessions: [], pendingToolApprovals: new Map(), activeStreamSessionId: '',
    ui: { activeView: 'chat' }, messagesBySession: new Map(),
  };
  const coordinator = createWorkspaceSessionCoordinator({
    state, constants: { TOAST_SOURCE: {} }, dom: { workspaceRailShell: null },
    callbacks: {
      openSession: async (id) => { state.currentSessionId = id; state.messagesBySession.set(id, []); },
      renderAll() {}, renderSessions() {}, renderSettings() {}, showToastMessage() {},
      showSessionActionError() {}, patchSessionSummary() {},
      onWorkspaceRestored: () => { restoredHooks += 1; },
    },
    controllers: { getMultiStreamController: () => null, getWorkspaceStateController: () => wsc,
      getWorkspaceChromeController: () => null },
    windowRef: globalThis,
  });

  // Cold boot: the backend has not signed in, so the session list is empty.
  await coordinator.syncWorkspaceFromStore();
  assert.equal(state.workspaceRestoreDeferred, true);
  assert.deepEqual(writes, [], 'no empty rail is persisted over the stored tabs');
  assert.equal(restoredHooks, 0, 'the stored second pane is not hydrated from an empty restore');

  // Signed in before the list arrives (agent mode's boot order): still deferred.
  state.auth = { authenticated: true };
  await coordinator.syncWorkspaceFromStore();
  assert.equal(state.workspaceRestoreDeferred, true);
  assert.deepEqual(writes, [], 'a signed-in boot with no session list yet persists nothing');

  // The list lands and the first currentSessionId is sessions[0];
  // even a preserve-current refresh must read storage, not the empty rail.
  state.sessionListLoaded = true;
  state.sessions = [{ id: 's3' }, { id: 's1' }, { id: 's2' }];
  state.currentSessionId = 's3';
  const restored = await coordinator.syncWorkspaceFromStore({ preserveCurrentSession: true });
  assert.deepEqual(restored.openSessionIds, ['s1', 's2']);
  assert.equal(restored.activeSessionId, 's2');
  assert.equal(state.currentSessionId, 's2');
  assert.equal(state.workspaceRestoreDeferred, false);
  assert.equal(restoredHooks, 1);
  assert.deepEqual(stored.openSessionIds, ['s1', 's2']);
});

// ---- Chat tab rail program (shell-chrome area 2) ----

async function fillRail(wsc, coordinator, count = 8) {
  for (let index = 1; index <= count; index += 1) await wsc.openSession(`s${index}`);
  coordinator.applyWorkspaceSnapshot(wsc.getState());
}

test('opening a ninth tab says which idle tab closed and offers to show it in Chats', async () => {
  const focused = [];
  const row = {
    dataset: { sessionId: 's1' },
    querySelector: () => ({ focus() { focused.push('s1'); }, scrollIntoView() {} }),
  };
  const workspaceRailShell = {
    ownerDocument: { querySelectorAll: (selector) => (selector.includes('#conversationGroups') ? [row] : []) },
    classList: { toggle() {} },
    hidden: false,
  };
  const sessions = Array.from({ length: 9 }, (_v, index) => ({ id: `s${index + 1}`, title: index === 0 ? 'Quick harness check' : `Chat ${index + 1}` }));
  const { wsc, coordinator, state, toasts } = createHarness({ getOpenSessionsInNewTab: () => true, workspaceRailShell, sessions });
  await fillRail(wsc, coordinator);

  await coordinator.activateWorkspaceSession('s9');
  assert.equal(state.workspace.openSessionIds.includes('s1'), false);
  assert.equal(toasts.length, 1);
  const [toast] = toasts;
  assert.equal(toast.title, 'Tab closed to make room');
  assert.equal(toast.message, '\u201cQuick harness check\u201d is still in Chats.');
  assert.equal(toast.tone, 'info');
  assert.equal(toast.durationMs, 6000);
  assert.notEqual(toast.sticky, true);
  assert.equal(toast.actions.length, 1);
  assert.equal(toast.actions[0].label, 'Show in Chats');
  toast.actions[0].onClick();
  assert.deepEqual(focused, ['s1'], 'the action focuses the evicted chat in the sidebar');
});

test('Show in Chats widens a filtered or paged sidebar until the evicted row is mounted', async () => {
  const focused = [];
  const calls = [];
  const row = {
    dataset: { sessionId: 's1' },
    querySelector: () => ({ focus() { focused.push('s1'); }, scrollIntoView() {} }),
  };
  // The row is filtered out (a search, a project, the archived scope) and sits
  // one page down: it mounts only after the filters clear and a page loads.
  let mounted = false;
  let pages = 0;
  const search = { value: 'harness' };
  const chatsPanel = {
    getScope: () => 'archived',
    setScope: (scope) => calls.push(['setScope', scope]),
    getProjectFilter: () => 'proj-1',
    setProjectFilter: (id) => calls.push(['setProjectFilter', id]),
    resetQuery: () => calls.push(['resetQuery']),
    renderNow: () => { calls.push(['renderNow']); mounted = pages >= 1; },
    loadMore: () => { pages += 1; calls.push(['loadMore']); },
  };
  const workspaceRailShell = {
    ownerDocument: {
      querySelectorAll: (selector) => (mounted && selector.includes('#conversationGroups') ? [row] : []),
      getElementById: (id) => (id === 'conversationSearch' ? search : null),
    },
    classList: { toggle() {} },
    hidden: false,
  };
  const sessions = Array.from({ length: 9 }, (_v, index) => ({ id: `s${index + 1}`, title: `Chat ${index + 1}` }));
  const { wsc, coordinator, toasts } = createHarness({ getOpenSessionsInNewTab: () => true, workspaceRailShell, sessions, chatsPanel });
  await fillRail(wsc, coordinator);
  await coordinator.activateWorkspaceSession('s9');
  toasts[0].actions[0].onClick();

  assert.equal(search.value, '', 'the search box is cleared');
  assert.deepEqual(calls.slice(0, 4), [['setScope', 'recent'], ['setProjectFilter', ''], ['resetQuery'], ['renderNow']]);
  assert.equal(pages, 1, 'one more page was enough');
  assert.deepEqual(focused, ['s1']);
});

test('Show in Chats gives up after a bounded number of pages when the session is gone', async () => {
  let pages = 0;
  const chatsPanel = { renderNow() {}, loadMore: () => { pages += 1; } };
  const workspaceRailShell = {
    ownerDocument: { querySelectorAll: () => [], getElementById: () => null },
    classList: { toggle() {} },
    hidden: false,
  };
  const sessions = Array.from({ length: 9 }, (_v, index) => ({ id: `s${index + 1}`, title: `Chat ${index + 1}` }));
  const { wsc, coordinator, toasts } = createHarness({ getOpenSessionsInNewTab: () => true, workspaceRailShell, sessions, chatsPanel });
  await fillRail(wsc, coordinator);
  await coordinator.activateWorkspaceSession('s9');
  assert.doesNotThrow(() => toasts[0].actions[0].onClick());
  assert.equal(pages, 20);
});

test('a full rail of busy tabs names the cap in sentence case', async () => {
  const { wsc, coordinator, toasts } = createHarness({ getOpenSessionsInNewTab: () => true, isSessionBusy: () => true });
  await fillRail(wsc, coordinator);
  await coordinator.activateWorkspaceSession('s9');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, 'All 8 tabs are busy');
  assert.equal(toasts[0].message, 'Close or finish a busy session before opening another tab.');
});

test('a full rail whose only idle tab is shown in the other pane says so instead of "all busy"', async () => {
  const paneModel = require('../renderer/shell/renderer-pane-model');
  const { wsc, coordinator, toasts } = createHarness({
    getOpenSessionsInNewTab: () => true, paneModel, isSessionBusy: (id) => id !== 's8' && id !== 's3',
  });
  await fillRail(wsc, coordinator);
  coordinator.applyWorkspaceSnapshot(wsc.getState());
  wsc.persistPaneLayout({ panes: ['s8', 's3'], focusedPaneId: 0 });
  await coordinator.activateWorkspaceSession('s9');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, '6 of 8 tabs are busy');
  assert.equal(toasts[0].message, 'A tab shown in a pane stays open. Close a tab before opening another.');
});

test('a full rail where only the current tab is idle counts the busy tabs', async () => {
  const { wsc, coordinator, toasts } = createHarness({ getOpenSessionsInNewTab: () => true, isSessionBusy: (id) => id !== 's8' });
  await fillRail(wsc, coordinator);
  await coordinator.activateWorkspaceSession('s9');
  assert.equal(toasts[0].title, '7 of 8 tabs are busy');
  assert.equal(toasts[0].message, 'Close or finish a busy session before opening another tab.');
});

test('a sessions render retitles the rail tabs', async () => {
  const calls = [];
  const chrome = {
    syncTabTitles() { calls.push('syncTabTitles'); },
    renderSidebarBadges() { calls.push('renderSidebarBadges'); },
  };
  const { coordinator } = createHarness({ chrome });
  coordinator.renderWorkspaceSidebarBadges([], []);
  assert.deepEqual(calls, ['renderSidebarBadges', 'syncTabTitles']);
});

test('a chrome pass outside the chat view keeps a row-anchored link popover open', async () => {
  const hides = [];
  const chrome = { renderSidebarBadges() {}, hideLinkedSessionPopover: (options) => hides.push(options) };
  const workspaceRailShell = { ownerDocument: { querySelectorAll: () => [] }, classList: { toggle() {} }, hidden: false };
  const { coordinator, state } = createHarness({ chrome, workspaceRailShell });
  state.ui.activeView = 'plugin';
  coordinator.renderWorkspaceChrome();
  assert.deepEqual(hides, [{ keepRowAnchored: true }]);
});
