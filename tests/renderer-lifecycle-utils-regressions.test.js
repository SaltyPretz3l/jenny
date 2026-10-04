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
  global.requestAnimationFrame = options.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
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
  const callbacks = { refreshSettingsSection: () => Promise.resolve(null), ...(options.callbacks || {}) };
  const controller = createLifecycleController({
    state,
    constants: { APPEARANCE_STORAGE_KEY: 'appearance', TOAST_SOURCE: {}, INTERACTIVE_SEQUENCE_IDLE: 'idle' },
    dom: {
      chatInput: options.chatInput || element(),
      composerAttachMenu: element(),
      composerAttachShortcut: element(),
      composerTerminalShortcut: element(),
      ...(options.dom || {}),
    },
    callbacks,
    controllers: options.controllers || {},
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
  return { controller, state, dom, callbacks };
}

test('the attach menu opens above the paperclip, left aligned and clamped to the viewport', (t) => {
  const page = new JSDOM('<button id="clip"></button><div class="composer-popover hidden" id="menu"><button role="menuitem">Attach files</button></div>');
  t.after(() => page.window.close());
  const clip = page.window.document.getElementById('clip');
  const menu = page.window.document.getElementById('menu');
  const h = createHarness(t, { dom: { composerAttachShortcut: clip, composerAttachMenu: menu } });
  const { createSettingsOverlayRenderer } = require('../renderer/shell/renderer-settings-overlays');
  const overlay = createSettingsOverlayRenderer({ state: h.state, windowRef: page.window,
    dom: { composerAttachShortcut: clip, composerAttachMenu: menu } });
  h.callbacks.renderComposerPopover = overlay.renderComposerPopover;
  Object.defineProperty(page.window, 'innerWidth', { value: 800 });
  clip.getBoundingClientRect = () => ({ left: 120, right: 148, top: 524 });
  menu.getBoundingClientRect = () => ({ width: 200, height: 120 });
  h.controller.openComposerPopover();
  assert.equal(h.state.ui.composerPopoverOpen, true);
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(clip.getAttribute('aria-expanded'), 'true');
  assert.equal(menu.style.left, '120px');
  assert.equal(menu.style.top, '394px');
  h.controller.closeComposerPopover({ restoreFocus: true });
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(page.window.document.activeElement, clip);
  clip.getBoundingClientRect = () => ({ left: 790, right: 818, top: 20 });
  h.controller.openComposerPopover();
  assert.equal(menu.style.left, '584px');
  assert.equal(menu.style.top, '16px');
});

test('chat activation never borrows sprite opacity or creates a timed duplicate', (t) => {
  const frames = [];
  let positions = 0;
  const h = createHarness(t, {
    requestAnimationFrame: (callback) => frames.push(callback),
    callbacks: { updateAssistantSpritePosition: () => { positions += 1; } },
  });
  h.dom.window.document.body.innerHTML = '<div id="chatAssistantSprite" style="opacity:0.84"></div>';
  h.state.ui.morphStartRect = { top: 10, left: 10, width: 30, height: 30 };
  h.controller.setActiveView('chat');
  while (frames.length) frames.shift()();
  assert.equal(positions, 1);
  assert.equal(h.state.ui.morphStartRect, undefined);
  assert.equal(h.dom.window.document.querySelector('.presence-morph-overlay'), null);
  assert.equal(h.dom.window.document.getElementById('chatAssistantSprite').style.opacity, '0.84');
});

for (const interruption of ['view', 'session', 'dispose']) {
  test(`chat activation ignores a queued frame after ${interruption} interruption`, (t) => {
    const frames = [];
    let positions = 0;
    const h = createHarness(t, {
      requestAnimationFrame: (callback) => frames.push(callback),
      callbacks: { updateAssistantSpritePosition: () => { positions += 1; } },
    });
    h.controller.setActiveView('chat');
    if (interruption === 'view') h.controller.setActiveView('settings');
    if (interruption === 'session') h.state.currentSessionId = 'another-session';
    if (interruption === 'dispose') h.controller.disposeLifecycleController();
    while (frames.length) frames.shift()();
    assert.equal(positions, 0);
  });
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

for (const twoPanes of [true, false]) {
  test(`chat activation with ${twoPanes ? 'two panes focuses the focused pane composer, not pane 0 #chatInput' : 'one pane keeps #chatInput'}`, (t) => {
    const previousComposition = globalThis.rendererAppPaneComposition;
    const frames = [];
    let chatInputFocuses = 0;
    let composerFocuses = 0;
    const chatInput = { focus: () => { chatInputFocuses += 1; } };
    globalThis.rendererAppPaneComposition = {
      getPaneComposition: () => ({ focusComposer: () => { composerFocuses += 1; return twoPanes; } }),
    };
    const h = createHarness(t, { chatInput, requestAnimationFrame: (callback) => frames.push(callback) });
    t.after(() => { globalThis.rendererAppPaneComposition = previousComposition; });
    h.controller.setActiveView('chat');
    while (frames.length) frames.shift()();
    assert.equal(composerFocuses, 1);
    assert.equal(chatInputFocuses, twoPanes ? 0 : 1);
  });
}

for (const [label, panes, expected] of [
  ['one pane', undefined, 1],
  ['two panes, pane 0 focused', { panes: [{ sessionId: 's0' }, { sessionId: 's1' }], focusedPaneId: 0 }, 1],
  ['two panes, pane 1 focused', { panes: [{ sessionId: 's0' }, { sessionId: 's1' }], focusedPaneId: 1 }, 0],
]) {
  test(`creating a chat re-latches pane 0 follow only when the chat lands there (CTR-001): ${label}`, async (t) => {
    const state = {
      ui: { activeView: 'chat', activeSettingsSection: 'models', composerPopoverOpen: false, commandPopoverOpen: false },
      logs: [],
      sessions: [],
      currentSessionId: panes ? panes.panes[panes.focusedPaneId].sessionId : 's0',
      runtimeDraft: { preferredModel: '', reasoningEffort: 'default', runMode: 'ask', planMode: false, contextPreferences: {} },
      features: { featureFlags: {} },
      ...(panes ? { panes } : {}),
    };
    let follows = 0;
    let resumes = 0;
    const { controller } = createHarness(t, {
      state,
      jennyShell: { sessions: { create: async () => ({ data: { id: 'sess_new' } }), list: async () => ({ data: [] }) } },
      controllers: { thinkingController: { resumeAutoScroll: () => { resumes += 1; } } },
      callbacks: {
        normalizeReasoningEffort: (value) => value,
        renderAll: () => {},
        isAnySendBusy: () => false,
        clearComposerStatusNotice: () => {},
        setSessionMessages: () => {},
        setFollowLatest: (value) => { if (value === true) follows += 1; },
      },
    });
    await controller.handleCreateSession().catch(() => {}); // the session list reload has no bridge here; the re-latch precedes it
    assert.equal(state.currentSessionId, 'sess_new');
    assert.deepEqual([follows, resumes], [expected, expected]);
  });
}
