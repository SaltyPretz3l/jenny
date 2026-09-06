'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function createHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previous = {
    window: global.window,
    document: global.document,
    requestAnimationFrame: global.requestAnimationFrame,
    jennyShell: global.jennyShell,
    rendererPluginSessions: global.rendererPluginSessions,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.jennyShell = options.jennyShell;
  dom.window.jennyShell = options.jennyShell;
  global.rendererPluginSessions = options.rendererPluginSessions;

  const modulePath = require.resolve('../renderer/shell/renderer-lifecycle-utils');
  delete require.cache[modulePath];
  const { createLifecycleController } = require('../renderer/shell/renderer-lifecycle-utils');
  const element = () => dom.window.document.createElement('div');
  const state = options.state || {
    ui: { activeView: 'chat', activeSettingsSection: 'models', composerPopoverOpen: false, commandPopoverOpen: false },
    logs: [],
    sessions: [],
    runtimeDraft: {},
    features: { featureFlags: {} },
  };
  const controller = createLifecycleController({
    state,
    constants: { APPEARANCE_STORAGE_KEY: 'appearance', TOAST_SOURCE: {}, INTERACTIVE_SEQUENCE_IDLE: 'idle' },
    dom: {
      chatInput: element(),
      composerSettingsPopover: element(),
      composerSettingsButton: element(),
      composerTerminalShortcut: element(),
    },
    callbacks: { refreshSettingsSection: () => Promise.resolve(null), ...(options.callbacks || {}) },
    controllers: {},
  });
  t.after(() => {
    controller.disposeLifecycleController();
    global.window = previous.window;
    global.document = previous.document;
    global.requestAnimationFrame = previous.requestAnimationFrame;
    global.jennyShell = previous.jennyShell;
    global.rendererPluginSessions = previous.rendererPluginSessions;
    dom.window.close();
  });
  return { controller, state };
}

test('runtime preferences expose the session pre-plan run mode for the plan toggle', (t) => {
  // The store owns pre_plan_run_mode (captured on plan entry); the renderer's
  // Alt+P toggle must read it from the session summary, not a module-local
  // shadow — otherwise a reload or session switch restores the wrong mode.
  const state = {
    ui: { activeView: 'chat', activeSettingsSection: 'models', composerPopoverOpen: false, commandPopoverOpen: false },
    logs: [],
    sessions: [{ id: 's1', run_mode: 'plan', plan_mode: true, pre_plan_run_mode: 'auto' }],
    currentSessionId: 's1',
    runtimeDraft: {},
    features: { featureFlags: {} },
  };
  const { controller } = createHarness(t, {
    state,
    callbacks: { normalizeReasoningEffort: (value) => value },
  });
  const prefs = controller.getCurrentRuntimePreferences();
  assert.equal(prefs.runMode, 'plan');
  assert.equal(prefs.prePlanRunMode, 'auto', 'session summaries surface pre_plan_run_mode to the composer');
});

test('creating a local draft session carries the draft run mode through the rebuild', async (t) => {
  // Three draft-rebuild literals dropped runMode when it was added; a user who
  // selects Auto with no session open must not have it silently reset to Ask
  // by opening a new chat.
  const state = {
    ui: { activeView: 'chat', activeSettingsSection: 'models', composerPopoverOpen: false, commandPopoverOpen: false },
    logs: [],
    sessions: [],
    currentSessionId: '',
    runtimeDraft: { preferredModel: '', reasoningEffort: 'default', runMode: 'auto', planMode: false, contextPreferences: {} },
    features: { featureFlags: {} },
  };
  const upserts = [];
  const { controller } = createHarness(t, {
    state,
    callbacks: {
      normalizeReasoningEffort: (value) => value,
      renderAll: () => {},
      isAnySendBusy: () => true,
      clearComposerStatusNotice: () => {},
      upsertSessionSummary: (summary) => { upserts.push(summary); },
      setSessionMessages: () => {},
    },
  });
  const sessionId = await controller.handleCreateSession();
  assert.ok(sessionId, 'local draft created');
  assert.equal(state.runtimeDraft.runMode, 'auto', 'draft rebuild preserves the selected run mode');
  assert.equal(upserts[0]?.run_mode, 'auto', 'the optimistic draft summary records the mode too');
});

test('renderer log forwarding invokes only the canonical bridge when it exists', (t) => {
  let canonicalCalls = 0;
  let legacyCalls = 0;
  const { controller } = createHarness(t, {
    jennyShell: {
      diagnostics: { logs: { appendRendererBatch: () => { canonicalCalls += 1; } } },
      logs: { clientAppend: () => { legacyCalls += 1; } },
    },
  });

  controller.appendClientLog('INFO', 'regression.single_channel', {});
  controller.disposeLifecycleController();

  assert.equal(canonicalCalls, 1);
  assert.equal(legacyCalls, 0, 'a fire-and-forget undefined return must not trigger the legacy bridge');
});

test('deferred plugin-view leave cannot activate a view after lifecycle disposal', async (t) => {
  const leaveRequest = deferred();
  let renderLayoutCalls = 0;
  const state = {
    ui: { activeView: 'plugin', activeSettingsSection: 'models', composerPopoverOpen: false, commandPopoverOpen: false },
    logs: [],
    sessions: [],
    runtimeDraft: {},
    features: { featureFlags: {} },
  };
  const { controller } = createHarness(t, {
    state,
    rendererPluginSessions: {
      instance: {
        getActiveSessionId: () => 'plugin-session',
        guardLeaveSession: () => leaveRequest.promise,
      },
    },
    callbacks: { renderLayout: () => { renderLayoutCalls += 1; } },
  });

  controller.setActiveView('chat');
  controller.disposeLifecycleController();
  leaveRequest.resolve(true);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(state.ui.activeView, 'plugin');
  assert.equal(renderLayoutCalls, 0, 'the stale leave continuation must not repaint after disposal');
});
