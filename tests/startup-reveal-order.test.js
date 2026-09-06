'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { getBridgeChannel } = require('../services/ipc-contract');
const { createMainWindowStartupLifecycle } = require('../services/main-window-startup-lifecycle');
const lifecycleProgressUtils = require('../renderer/shell/renderer-lifecycle-progress-utils');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

class FakeEmitter {
  constructor() { this.listeners = new Map(); }
  on(name, listener) {
    const entries = this.listeners.get(name) || [];
    entries.push(listener);
    this.listeners.set(name, entries);
    return this;
  }
  once(name, listener) {
    const wrapped = (...args) => { this.removeListener(name, wrapped); listener(...args); };
    return this.on(name, wrapped);
  }
  removeListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry !== listener));
    return this;
  }
  emit(name, ...args) {
    for (const listener of [...(this.listeners.get(name) || [])]) listener(...args);
  }
}

function createPendingBootstrapHarness(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="startupOverlay"></div></body></html>', {
    url: 'https://jenny.test/',
  });
  const previous = {
    window: global.window,
    document: global.document,
    requestAnimationFrame: global.requestAnimationFrame,
    jennyShell: global.jennyShell,
    audit: global.__jennyStartupAudit,
  };
  const never = new Promise(() => {});
  const marks = [];
  const jennyShell = {
    backend: { getStatus: () => never },
    auth: { getState: async () => ({ authenticated: true }) },
    system: { getStats: async () => ({}) },
    diagnostics: { getStartupAuditConfig: () => never },
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = () => 0;
  global.jennyShell = jennyShell;
  global.__jennyStartupAudit = { mark: (name) => marks.push(name) };
  dom.window.jennyShell = jennyShell;

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
      composerSettingsPopover: element(),
      composerSettingsButton: element(),
      composerTerminalShortcut: element(),
    },
    callbacks: {
      getDefaultAppearancePreferences: () => ({}),
      normalizeAppearancePreferences: (value) => value || {},
      applyAppearanceToDocument: () => {},
      saveStoredAppearancePreferences: () => {},
      normalizeReasoningEffort: (value) => value,
      renderPrompts: () => {},
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
    dom.window.close();
  });
  return { controller, dom, marks };
}

test('painted renderer signals ready via its own callback while bootstrap IPC is still pending, after first-render', async (t) => {
  const { controller, dom, marks } = createPendingBootstrapHarness(t);
  let readySignals = 0;

  void controller.bootstrap({ signalRendererReadyOnce: () => { readySignals += 1; } });
  await Promise.resolve();
  await Promise.resolve();

  const curtain = dom.window.document.getElementById('startupOverlay');
  assert.equal(readySignals, 1);
  assert.equal(curtain.isConnected, true);
  // Real order check between the two marks bootstrap() actually emits here:
  // backend.getStatus() never resolves in this harness, so 'renderer-bootstrap-
  // complete' never lands and comparing against it was always vacuously true.
  // The curtain-dismissal claim moved to the "curtain dismissal still requires
  // backend-ready plus boot-view-ready" test below, which uses a real progress
  // controller instead of the bare, unattached div this harness hands bootstrap().
  assert.ok(marks.includes('renderer-bootstrap-started'));
  assert.ok(marks.includes('first-render'));
  assert.ok(marks.indexOf('renderer-bootstrap-started') < marks.indexOf('first-render'));
});

test('window-visible startup mark records whether the reveal used the timeout backstop', () => {
  const readyChannel = getBridgeChannel('lifecycle.signalReady', 'send');
  function runReveal(useBackstop) {
    const marks = [];
    let timeoutCallback = null;
    const ipcMainRef = new FakeEmitter();
    const windowRef = new FakeEmitter();
    windowRef.webContents = new FakeEmitter();
    windowRef.isDestroyed = () => false;
    windowRef.isVisible = () => false;
    windowRef.show = () => {};
    createMainWindowStartupLifecycle({
      windowRef,
      ipcMainRef,
      readyChannel,
      setTimeoutImpl: (callback) => { timeoutCallback = callback; return 1; },
      clearTimeoutImpl: () => {},
      emitStartupAuditMark: (name, details) => marks.push({ name, details }),
    });
    if (useBackstop) {
      timeoutCallback();
    } else {
      windowRef.emit('ready-to-show');
      ipcMainRef.emit(readyChannel, { sender: windowRef.webContents });
    }
    return marks;
  }

  assert.equal(runReveal(false)[0].details.trigger, 'renderer-ready');
  assert.equal(runReveal(true)[0].details.trigger, 'startup-timeout');
});

function createCurtainController(t, maxVisibleMs = 20000) {
  const dom = new JSDOM('<!doctype html><html><body><div id="startupOverlay"><div id="startupOverlaySublabel"></div><div id="startupOverlaySecondary"></div></div></body></html>');
  const previousMaxVisibleMs = global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS;
  const previousAudit = global.__jennyStartupAudit;
  const marks = [];
  global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = maxVisibleMs;
  global.__jennyStartupAudit = { mark: (name) => marks.push(name) };
  const controller = lifecycleProgressUtils.createLifecycleProgressController({
    state: {
      ui: { activeView: 'chat' },
      backend: { phase: 'starting' },
      lifecycleProgress: lifecycleProgressUtils.defaultLifecycleProgress(),
    },
    dom: {
      startupOverlay: dom.window.document.getElementById('startupOverlay'),
      startupOverlaySublabel: dom.window.document.getElementById('startupOverlaySublabel'),
      startupOverlaySecondary: dom.window.document.getElementById('startupOverlaySecondary'),
    },
    callbacks: { setTurnStatusPill() {}, clearTurnStatusPill() {} },
  });
  t.after(() => {
    controller.dispose();
    global.__JENNY_STARTUP_OVERLAY_MAX_VISIBLE_MS = previousMaxVisibleMs;
    global.__jennyStartupAudit = previousAudit;
    dom.window.close();
  });
  return { controller, overlay: dom.window.document.getElementById('startupOverlay'), marks };
}

test('curtain dismissal still requires backend-ready plus boot-view-ready and marks interaction', (t) => {
  const { controller, overlay, marks } = createCurtainController(t);

  controller.notifyBootViewReady();
  assert.equal(overlay.classList.contains('hidden'), false);
  controller.handleBackendStatus({ phase: 'ready' });

  assert.equal(overlay.classList.contains('hidden'), true);
  assert.deepEqual(marks, ['shell-interactive']);
});

test('curtain backstop still dismisses an otherwise-pending shell', async (t) => {
  const { overlay } = createCurtainController(t, 5);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(overlay.classList.contains('hidden'), true);
});

test('post-reveal offline, workspace, feature, and setup calls may remain pending', async (t) => {
  const cases = [
    ['offline', { offline: { getState: null } }],
    ['workspace', { workspace: { getState: null } }],
    ['features', { features: { getState: null } }],
    ['setup', { setup: { getState: null } }],
  ];
  for (const [name, shell] of cases) {
    let started = false;
    shell[name].getState = () => { started = true; return new Promise(() => {}); };
    const app = await loadRendererApp({ shell });
    t.after(() => app.dispose());
    await waitForUi(app.window, 30);
    assert.equal(app.shell.__state.lifecycleReadySignals, 1, `${name} cannot delay renderer-ready`);
    assert.equal(started, true, `${name} pending call was reached`);
  }
});

test('post-binding backend reconcile catches a ready transition missed during bootstrap, and Logs activation still populates history and status', async (t) => {
  let snapshotCalls = 0;
  let statusCalls = 0;
  let backendCalls = 0;
  const app = await loadRendererApp({
    shell: {
      backend: {
        getStatus({ state }) {
          backendCalls += 1;
          // Simulate exactly the race the post-binding reconcile exists to
          // catch: the backend is still transient during bootstrap()'s own
          // fetch (call #1), and only reports 'ready' by the time
          // reconcileBackendStatusAfterBindings re-fetches it (call #2+, via
          // the harness's default 'ready' state.backendStatus).
          return backendCalls === 1 ? { phase: 'starting', detail: '', mode: 'managed-dev' } : state.backendStatus;
        },
      },
      diagnostics: {
        logs: {
          getSnapshot: async () => {
            snapshotCalls += 1;
            return { active_run: { run_id: 'run' }, entries: [{ entry_id: 'first-open' }] };
          },
        },
        getJennyStatus: async () => { statusCalls += 1; return { backend: { phase: 'ready' } }; },
      },
    },
  });
  t.after(() => app.dispose());

  assert.equal(snapshotCalls, 0);
  const statusCallsBeforeLogs = statusCalls;
  assert.deepEqual(Array.from(app.window.__rendererState.diagnosticsSnapshot.entries), []);
  // Assert the invariant, not a call count: a ready transition the reconcile
  // alone observes (missed during bootstrap()'s own earlier, still-transient
  // fetch) must still load sessions once and let the curtain go. A bare
  // backendCalls === 2 would keep passing even if the reconcile's own refetch
  // were deleted, as long as something else happened to call getStatus twice.
  assert.ok(backendCalls >= 2, 'the post-binding reconcile must re-fetch backend status');
  assert.equal(app.window.__rendererState.backendReadyLoadHandled, true);
  assert.equal(app.window.document.getElementById('startupOverlay').classList.contains('hidden'), true);

  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 80);

  assert.equal(snapshotCalls, 1);
  assert.ok(statusCalls > statusCallsBeforeLogs);
  assert.equal(app.window.__rendererState.diagnosticsStatus.backend.phase, 'ready');
  assert.equal(app.window.__rendererState.logs.some((entry) => entry.entry_id === 'first-open'), true);
});

test('boot restored to Logs fetches the diagnostics snapshot once, with no click', async (t) => {
  let snapshotCalls = 0;
  const app = await loadRendererApp({
    persistedActiveView: 'logs',
    shell: {
      diagnostics: {
        logs: {
          getSnapshot: async () => {
            snapshotCalls += 1;
            return { active_run: { run_id: 'run' }, entries: [{ entry_id: 'boot-open' }] };
          },
        },
      },
    },
  });
  t.after(() => app.dispose());
  await waitForUi(app.window, 80);

  assert.equal(app.window.__rendererState.ui.activeView, 'logs');
  assert.equal(snapshotCalls, 1);
  assert.equal(app.window.__rendererState.logs.some((entry) => entry.entry_id === 'boot-open'), true);
});

test('F1 regression: the curtain must not dismiss while post-reveal hydration is still pending', async (t) => {
  let workspaceStarted = false;
  const app = await loadRendererApp({
    shell: {
      // syncWorkspaceFromStore() (part of bootstrapAppShell's own hydration
      // triple) awaits this and never resolves, simulating exactly the
      // reviewer's repro: backend already ready, hydration still in flight.
      workspace: {
        getState: () => { workspaceStarted = true; return new Promise(() => {}); },
      },
    },
  });
  t.after(() => app.dispose());
  await waitForUi(app.window, 80);

  assert.equal(workspaceStarted, true, 'workspace hydration must actually be in flight for this to be a real test');
  assert.equal(app.window.__rendererState.backend.phase, 'ready', 'the regression is specifically about hydration outrunning an already-ready backend');
  const curtain = app.window.document.getElementById('startupOverlay');
  assert.equal(curtain.classList.contains('hidden'), false, 'the curtain must stay up until hydration actually lands, not just first paint');
  // F2: the background must be kept keyboard/AT-inert for as long as the
  // curtain is up (not just visually covered), so a click behind it cannot
  // activate and persist a view the user never saw. #workspace has no
  // data-startup-inert-exempt descendant, so it is marked directly. (jsdom
  // does not enforce inert's own event-blocking, so this checks the state
  // setStartupOverlayBackgroundInert produces, not synthetic-click behavior --
  // that half is a real-browser/GUI-smoke concern per AGENTS.md.)
  assert.equal(app.window.document.getElementById('workspace').inert, true);
});
