const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceSessionCoordinator } = require('../renderer/shell/renderer-workspace-session-utils');
const { createWorkspaceStateController } = require('../renderer/shell/renderer-workspace-state-utils');

// "Show in Chats" on the eviction toast (review C-3): a collapsed chats panel
// shows only the strip, so the evicted row is mounted but cannot take focus
// until the panel opens the way the strip's own expand opens it.

function createRevealRig({ collapsed }) {
  let stored = { activeSessionId: '', openSessionIds: [] };
  const wsc = createWorkspaceStateController({
    jennyShell: { workspace: { getState: async () => stored, updateState: async (next) => { stored = next; return next; } } },
    isSessionBusy: () => false,
  });
  const calls = [];
  const toasts = [];
  const row = {
    dataset: { sessionId: 's1' },
    querySelector: () => ({ focus() { calls.push(['focus', 's1']); }, scrollIntoView() {} }),
  };
  const chatsPanel = {
    prepareForStripExpansion: () => calls.push(['prepareForStripExpansion']),
    setProjectFilter: (id) => calls.push(['setProjectFilter', id]),
    renderNow: () => calls.push(['renderNow']),
  };
  let panelCollapsed = collapsed;
  const state = {
    workspace: { activeSessionId: '', openSessionIds: [] },
    currentSessionId: '',
    sessions: Array.from({ length: 9 }, (_v, index) => ({ id: `s${index + 1}`, title: `Chat ${index + 1}` })),
    pendingToolApprovals: new Map(),
    activeStreamSessionId: '',
    ui: { activeView: 'chat' },
  };
  const coordinator = createWorkspaceSessionCoordinator({
    state,
    constants: { TOAST_SOURCE: {} },
    dom: {
      workspaceRailShell: {
        ownerDocument: { querySelectorAll: (selector) => (selector.includes('#conversationGroups') ? [row] : []) },
      },
    },
    callbacks: {
      openSession: async (sessionId) => { state.currentSessionId = sessionId; },
      renderAll() {},
      showToastMessage: (message, options) => toasts.push({ message, ...options }),
      getOpenSessionsInNewTab: () => true,
      isChatsPanelCollapsed: () => panelCollapsed,
      expandChatsPanel: () => { panelCollapsed = false; calls.push(['expandChatsPanel']); },
    },
    controllers: {
      getMultiStreamController: () => null,
      getWorkspaceStateController: () => wsc,
      getWorkspaceChromeController: () => null,
      getChatsPanelController: () => chatsPanel,
    },
  });
  return { wsc, coordinator, calls, toasts };
}

async function evictFirstTab({ wsc, coordinator }) {
  for (let index = 1; index <= 8; index += 1) await wsc.openSession(`s${index}`);
  coordinator.applyWorkspaceSnapshot(wsc.getState());
  await coordinator.activateWorkspaceSession('s9');
}

test('Show in Chats opens a collapsed chats panel, filters cleared, before focusing the row', async () => {
  const rig = createRevealRig({ collapsed: true });
  await evictFirstTab(rig);
  rig.toasts[0].actions[0].onClick();
  assert.deepEqual(rig.calls, [
    ['prepareForStripExpansion'],
    ['setProjectFilter', ''],
    ['expandChatsPanel'],
    ['renderNow'],
    ['focus', 's1'],
  ]);
});

test('Show in Chats leaves an open chats panel as it is when the row is already mounted', async () => {
  const rig = createRevealRig({ collapsed: false });
  await evictFirstTab(rig);
  rig.toasts[0].actions[0].onClick();
  assert.deepEqual(rig.calls, [['focus', 's1']]);
});
