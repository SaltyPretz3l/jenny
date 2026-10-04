'use strict';

/* The workspace coordinator's window-level chords: Ctrl+Shift+R is the guarded
 * reload (exit preflight first, a chord that fires from text fields too, a
 * thrown preflight logged), and Ctrl+Tab cycles chat tabs only when no other
 * handler consumed the chord, only in the chat view, never under a modal. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkspaceSessionCoordinator } = require('../renderer/shell/renderer-workspace-session-utils');
const { createWorkspaceStateController } = require('../renderer/shell/renderer-workspace-state-utils');

function createWorkspaceShell() {
  let stored = { activeSessionId: '', openSessionIds: [] };
  const copy = () => ({ activeSessionId: stored.activeSessionId, openSessionIds: stored.openSessionIds.slice() });
  return {
    workspace: {
      async getState() { return copy(); },
      async updateState(patch) {
        stored = { activeSessionId: patch.activeSessionId, openSessionIds: (patch.openSessionIds || []).slice() };
        return copy();
      },
    },
  };
}

function createHarness({ windowRef = globalThis } = {}) {
  const wsc = createWorkspaceStateController({ jennyShell: createWorkspaceShell() });
  const openSessionCalls = [];
  const noop = () => {};
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
      openSession: async (sessionId) => { openSessionCalls.push(sessionId); state.currentSessionId = sessionId; },
      renderAll: noop,
      renderSessions: noop,
      renderSettings: noop,
      showToastMessage: noop,
      showSessionActionError: noop,
      patchSessionSummary: noop,
    },
    controllers: {
      getMultiStreamController: () => null,
      getWorkspaceStateController: () => wsc,
      getWorkspaceChromeController: () => null,
      getChatsPanelController: () => null,
    },
    windowRef,
  });
  coordinator.applyWorkspaceSnapshot(wsc.getState());
  return { wsc, coordinator, state, openSessionCalls };
}

function ctrlTabDown() {
  return { type: 'keydown', key: 'Tab', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false, target: null, preventDefault() {} };
}

async function seedThreeTabs(wsc, coordinator) {
  await wsc.openSession('s3');
  await wsc.openSession('s2');
  await wsc.openSession('s1');
  coordinator.applyWorkspaceSnapshot(wsc.getState());
}

// Window controls (area 4) step 1: Ctrl+Shift+R is the guarded reload. It runs
// the window-exit preflight first and reloads only when the preflight proceeds.
function ctrlShiftR() {
  let prevented = false;
  return {
    event: { type: 'keydown', key: 'R', ctrlKey: true, altKey: false, metaKey: false, shiftKey: true, target: null, preventDefault() { prevented = true; } },
    wasPrevented: () => prevented,
  };
}

function createReloadWindow(preflightOutcome) {
  const calls = [];
  return {
    calls,
    windowRef: {
      jennyShell: {
        windowControl: async (action) => { calls.push(`control:${action}`); return { ok: true }; },
      },
      jennyWindowExitPreflight: {
        preflightExit: async (action) => { calls.push(`preflight:${action}`); return preflightOutcome; },
      },
    },
  };
}

test('Ctrl+Shift+R runs the exit preflight before reloading', async () => {
  const { calls, windowRef } = createReloadWindow({ proceed: true });
  const { coordinator } = createHarness({ windowRef });
  const key = ctrlShiftR();
  await coordinator.handleWorkspaceShortcut(key.event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(key.wasPrevented(), true);
  assert.deepEqual(calls, ['preflight:reload', 'control:reload']);
});

test('Ctrl+Shift+R does not reload when the preflight cancels', async () => {
  const { calls, windowRef } = createReloadWindow({ proceed: false, reason: 'canceled' });
  const { coordinator } = createHarness({ windowRef });
  await coordinator.handleWorkspaceShortcut(ctrlShiftR().event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['preflight:reload']);
});

test('Ctrl+Shift+R reloads from the composer: a chord, not text input', async () => {
  const { calls, windowRef } = createReloadWindow({ proceed: true });
  const { coordinator } = createHarness({ windowRef });
  const key = ctrlShiftR();
  key.event.target = { closest: (sel) => (sel.includes('textarea') ? {} : null), isContentEditable: false };
  await coordinator.handleWorkspaceShortcut(key.event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(key.wasPrevented(), true);
  assert.deepEqual(calls, ['preflight:reload', 'control:reload']);

  await coordinator.handleWorkspaceShortcut({ ...ctrlShiftR().event, defaultPrevented: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2, 'an editor that bound the chord itself keeps it');
});

test('a throwing reload preflight is logged through the client logger the shell handed the cluster', async (t) => {
  const { JSDOM } = require('jsdom');
  const { bindShellWindowControls } = require('../renderer/chat/renderer-window-controls-utils');
  const dom = new JSDOM('<!doctype html><body></body>');
  t.after(() => dom.window.close());
  const calls = [];
  const logs = [];
  dom.window.jennyShell = { windowControl: async (action) => { calls.push(action); return { ok: true }; } };
  dom.window.jennyWindowExitPreflight = { preflightExit: async () => { throw new Error('dirty-state probe failed'); } };
  bindShellWindowControls({
    documentRef: dom.window.document,
    windowRef: dom.window,
    appendClientLog: (level, event, detail) => logs.push([level, event, detail.message]),
  });
  const { coordinator } = createHarness({ windowRef: dom.window });
  await coordinator.handleWorkspaceShortcut(ctrlShiftR().event);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [], 'a failed preflight never reloads');
  assert.deepEqual(logs, [['WARN', 'window.exit_preflight_failed', 'dirty-state probe failed']]);
});

// Ctrl+Tab cycles chat tabs only when nothing else consumed the chord: the
// command palette (scope cycle) and the IDE (editor MRU) preventDefault first.
test('Ctrl+Tab leaves a chord another handler consumed, other views and modal inputs alone', async () => {
  const { wsc, coordinator, state, openSessionCalls } = createHarness();
  await seedThreeTabs(wsc, coordinator);

  await coordinator.handleWorkspaceShortcut({ ...ctrlTabDown(), defaultPrevented: true });
  assert.deepEqual(openSessionCalls, [], 'the palette or IDE already handled it');

  const modalInput = { closest: (sel) => (sel.includes('aria-modal') ? {} : null), isContentEditable: false };
  await coordinator.handleWorkspaceShortcut({ ...ctrlTabDown(), target: modalInput });
  assert.deepEqual(openSessionCalls, [], 'a modal input keeps its own Tab chord');

  state.ui.activeView = 'ide';
  await coordinator.handleWorkspaceShortcut(ctrlTabDown());
  assert.deepEqual(openSessionCalls, [], 'the tab rail is only in the chat view');
  assert.equal(state.workspace.activeSessionId, 's1');

  state.ui.activeView = 'chat';
  await coordinator.handleWorkspaceShortcut(ctrlTabDown());
  assert.deepEqual(openSessionCalls, ['s2'], 'the chat view still cycles');
});

test('Ctrl+Shift+I toggles devtools only when no other surface claimed the chord', async (t) => {
  const calls = [];
  const previousWindow = globalThis.window;
  globalThis.window = { jennyShell: { windowControl: (action) => { calls.push(action); } } };
  t.after(() => { globalThis.window = previousWindow; });
  const { coordinator } = createHarness();
  const chord = { type: 'keydown', key: 'I', ctrlKey: true, altKey: false, metaKey: false, shiftKey: true, target: null, preventDefault() {} };

  await coordinator.handleWorkspaceShortcut({ ...chord, defaultPrevented: true });
  assert.deepEqual(calls, [], 'a consumed chord does not open devtools');

  await coordinator.handleWorkspaceShortcut(chord);
  assert.deepEqual(calls, ['toggle-devtools']);
});
