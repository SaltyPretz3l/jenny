const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceSessionCoordinator } = require('../renderer/shell/renderer-workspace-session-utils');
const { createWorkspaceStateController } = require('../renderer/shell/renderer-workspace-state-utils');

// "Show in Chats" on the eviction toast (review C-3): the evicted row takes focus, and the
// panel is asked to reveal it when it is not mounted.

function createRevealRig({ mountedAtStart = true, revealMounts = true }) {
  let mounted = mountedAtStart;
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
    revealSession: (sessionId) => { calls.push(['revealSession', sessionId]); mounted = revealMounts; return revealMounts; },
  };
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
        ownerDocument: {
          querySelectorAll: (selector) => (selector.includes('#conversationGroups') && mounted ? [row] : []),
        },
      },
    },
    callbacks: {
      openSession: async (sessionId) => { state.currentSessionId = sessionId; },
      renderAll() {},
      showToastMessage: (message, options) => toasts.push({ message, ...options }),
      getOpenSessionsInNewTab: () => true,
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

test('Show in Chats leaves the chats panel as it is when the row is already mounted', async () => {
  const rig = createRevealRig({});
  await evictFirstTab(rig);
  rig.toasts[0].actions[0].onClick();
  assert.deepEqual(rig.calls, [['focus', 's1']]);
});

// Project grouping (the default) ignores the flat page limit, so a chat in a
// collapsed project or past its project's first rows never mounts by paging:
// the panel's own revealSession widens exactly what hides it.
test('Show in Chats asks the panel to reveal an unmounted row', async () => {
  const rig = createRevealRig({ mountedAtStart: false });
  await evictFirstTab(rig);
  rig.toasts[0].actions[0].onClick();
  assert.deepEqual(rig.calls, [['revealSession', 's1'], ['focus', 's1']]);
});

test('Show in Chats focuses nothing when the panel cannot reveal the session', async () => {
  const rig = createRevealRig({ mountedAtStart: false, revealMounts: false });
  await evictFirstTab(rig);
  assert.doesNotThrow(() => rig.toasts[0].actions[0].onClick());
  assert.deepEqual(rig.calls, [['revealSession', 's1']]);
});
