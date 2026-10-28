'use strict';

// Startup Wave A (row 62): chat history hydrates from the main-process store
// at boot without waiting for the engine, and opens the stored active chat.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');

function createBootstrapHarness(t, { backendPhase, storedActiveSessionId = '', workspaceGetState }) {
  const dom = new JSDOM('<!doctype html><html><body><div id="startupOverlay"></div></body></html>', {
    url: 'https://jenny.test/',
  });
  const previous = {
    window: global.window,
    document: global.document,
    requestAnimationFrame: global.requestAnimationFrame,
    jennyShell: global.jennyShell,
    audit: global.__jennyStartupAudit,
    sessionLifecycle: global.rendererSessionLifecycleUtils,
    snapshotRefresh: global.rendererSnapshotRefresh,
  };
  const calls = { loadSessions: [], refreshSnapshots: 0 };
  const jennyShell = {
    backend: { getStatus: async () => ({ phase: backendPhase }) },
    auth: { getState: async () => ({ authenticated: true }) },
    system: { getStats: async () => ({}) },
    workspace: { getState: workspaceGetState || (async () => ({ activeSessionId: storedActiveSessionId })) },
    diagnostics: { getStartupAuditConfig: () => new Promise(() => {}) },
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = () => 0;
  global.jennyShell = jennyShell;
  global.__jennyStartupAudit = { mark: () => {} };
  dom.window.jennyShell = jennyShell;
  global.rendererSessionLifecycleUtils = {
    createSessionLifecycleController: () => ({
      reconcileSessionCaches: async () => {},
      refreshSessionSummaries: async () => ({ currentSessionId: '', validSessionIds: new Set() }),
      loadSessions: async (...args) => { calls.loadSessions.push(args); },
      openSession: async () => {},
    }),
  };
  global.rendererSnapshotRefresh = {
    createSnapshotRefresh: () => ({ refreshSnapshots: async () => { calls.refreshSnapshots += 1; } }),
  };

  const modulePath = require.resolve('../renderer/shell/renderer-lifecycle-utils');
  delete require.cache[modulePath];
  const { createLifecycleController } = require('../renderer/shell/renderer-lifecycle-utils');
  const state = {
    ui: { activeView: 'chat', appearance: {}, chatZoomPercent: 100 },
    backend: { phase: 'starting' },
    auth: { authenticated: false },
    logs: [],
    sessions: [],
    runtimeDraft: {},
    features: { featureFlags: {} },
  };
  const element = () => dom.window.document.createElement('div');
  const controller = createLifecycleController({
    state,
    constants: { APPEARANCE_STORAGE_KEY: 'appearance', TOAST_SOURCE: {}, INTERACTIVE_SEQUENCE_IDLE: 'idle' },
    dom: {
      chatInput: element(),
      composerAttachMenu: element(),
      composerAttachShortcut: element(),
    },
    callbacks: {
      getDefaultAppearancePreferences: () => ({}),
      normalizeAppearancePreferences: (value) => value || {},
      applyAppearanceToDocument: () => {},
      saveStoredAppearancePreferences: () => {},
      normalizeReasoningEffort: (value) => value,
      renderAll: () => {},
    },
    controllers: {},
  });
  t.after(() => {
    controller.disposeLifecycleController();
    delete require.cache[modulePath];
    global.window = previous.window;
    global.document = previous.document;
    global.requestAnimationFrame = previous.requestAnimationFrame;
    global.jennyShell = previous.jennyShell;
    global.__jennyStartupAudit = previous.audit;
    global.rendererSessionLifecycleUtils = previous.sessionLifecycle;
    global.rendererSnapshotRefresh = previous.snapshotRefresh;
    dom.window.close();
  });
  return { controller, calls, state };
}

test('boot hydrates chat history while the engine is still loading, and leaves engine snapshots for the ready transition', async (t) => {
  const { controller, calls } = createBootstrapHarness(t, { backendPhase: 'model_loading', storedActiveSessionId: 'sess-left-open' });
  await controller.bootstrap({ signalRendererReadyOnce: () => {} });
  // Red before row 62: a starting backend skipped loadSessions entirely.
  assert.deepEqual(calls.loadSessions, [['sess-left-open']], 'history loads, preferring the stored active chat');
  assert.equal(calls.refreshSnapshots, 0, 'engine snapshots wait for a usable backend');
});

test('boot with a ready backend loads history and snapshots together', async (t) => {
  const { controller, calls } = createBootstrapHarness(t, { backendPhase: 'ready', storedActiveSessionId: 'sess-a' });
  await controller.bootstrap({ signalRendererReadyOnce: () => {} });
  assert.deepEqual(calls.loadSessions, [['sess-a']]);
  assert.equal(calls.refreshSnapshots, 1);
});

test('an unreadable workspace store falls back to the default chat choice', async (t) => {
  const { controller, calls } = createBootstrapHarness(t, {
    backendPhase: 'sidecar_spawned',
    workspaceGetState: async () => { throw new Error('store unavailable'); },
  });
  await controller.bootstrap({ signalRendererReadyOnce: () => {} });
  assert.deepEqual(calls.loadSessions, [['']]);
});

test('loadSessions paints the chat list before the conversation loads, and opens the preferred chat (row 62)', async () => {
  const order = [];
  const state = {
    auth: { authenticated: true },
    sessions: [],
    currentSessionId: '',
    messagesBySession: new Map(),
    turnEventsBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(),
    ui: {},
  };
  const controller = createSessionLifecycleController({
    state,
    sessionCacheController: { async clearSessionStreamState() {}, async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: {
        list: async () => ({ data: [{ id: 'chat-newest' }, { id: 'chat-left-open' }] }),
        getMessages: async (id) => { order.push(`messages:${id}`); return { data: [], turn_events: [] }; },
      },
      chat: { async getActiveTurnState() { return null; } },
    },
    callbacks: {
      removeSessionState() {}, pruneSessionArtifacts() {},
      evictPretextArticlePredictions() {}, syncRuntimeDraftFromActiveSession() {},
      setSessionMessages: (id, messages) => state.messagesBySession.set(id, messages),
      renderSessions: () => order.push('render-sessions'),
      renderAll: () => order.push('render-all'),
    },
  });

  await controller.loadSessions('chat-left-open');

  assert.equal(state.currentSessionId, 'chat-left-open');
  assert.deepEqual(order.filter((step) => step.startsWith('messages:')), ['messages:chat-left-open'],
    'only the preferred chat loads; the newest one is never fetched');
  assert.ok(order.indexOf('render-sessions') !== -1, 'the list is painted');
  assert.ok(order.indexOf('render-sessions') < order.indexOf('messages:chat-left-open'),
    'the list paints before the conversation load');
});
