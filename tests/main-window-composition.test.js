const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMainWindowWithDeps,
  createMainWindowStartupLifecycle,
} = require('../services/main/main-window-composition');

// A BrowserWindow-like fake that records every interaction the composition
// function (and its electron-free transitive deps: main-window-startup-lifecycle,
// main-window-navigation-guard, main-lifecycle) performs. No Electron, no jsdom.
function createFakeWebContents() {
  const onHandlers = [];
  const onceHandlers = [];
  let windowOpenHandler = null;
  return {
    onHandlers,
    onceHandlers,
    on(event, fn) {
      onHandlers.push([event, fn]);
    },
    once(event, fn) {
      onceHandlers.push([event, fn]);
    },
    getURL() {
      return 'file:///app/index.html';
    },
    setWindowOpenHandler(fn) {
      windowOpenHandler = fn;
    },
    getWindowOpenHandler() {
      return windowOpenHandler;
    },
    session: { webRequest: { onHeadersReceived() {} } },
  };
}

function makeFakeBrowserWindowClass() {
  const created = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.onHandlers = [];
      this.onceHandlers = [];
      this.onEvents = new Set();
      this.onceEvents = new Set();
      this.maximized = false;
      this.menuBarVisible = undefined;
      this.loadedFile = undefined;
      this.webContents = createFakeWebContents();
      created.push(this);
    }

    on(event, fn) {
      this.onHandlers.push([event, fn]);
      this.onEvents.add(event);
      return this;
    }

    once(event, fn) {
      this.onceHandlers.push([event, fn]);
      this.onceEvents.add(event);
      return this;
    }

    getBounds() {
      return { width: 1600, height: 930 };
    }

    setMenuBarVisibility(value) {
      this.menuBarVisible = value;
    }

    maximize() {
      this.maximized = true;
    }

    loadFile(file) {
      this.loadedFile = file;
    }
  }
  FakeBrowserWindow.created = created;
  return FakeBrowserWindow;
}

// Builds a deps object with recording spies. Caller may override windowState.
function makeDeps(overrides = {}) {
  const FakeBrowserWindow = makeFakeBrowserWindowClass();
  const calls = {
    setMainWindow: [],
    emitStartupAuditMark: [],
    log: [],
    attach: [],
    getStartupElapsedMs: 0,
  };
  let currentWindow = null;

  const deps = {
    BrowserWindow: FakeBrowserWindow,
    rootDir: process.cwd(),
    ipcMainRef: { on() {}, removeListener() {}, handle() {} },
    shell: { openExternal: async () => {}, openPath: async () => {} },
    windowStateService: {
      getInitialWindowOptions: () => ({ width: 1600, height: 930, isMaximized: false }),
      attach(w) {
        calls.attach.push(w);
      },
    },
    isPackagedSmokeEnabled: () => false,
    getStartupElapsedMs: () => 4242,
    emitStartupAuditMark: (mark, payload) => {
      calls.emitStartupAuditMark.push([mark, payload]);
    },
    log: (...args) => {
      calls.log.push(args);
    },
    emitMainWindowStateChanged: () => {},
    getMainWindow: () => currentWindow,
    setMainWindow: (w) => {
      currentWindow = w;
      calls.setMainWindow.push(w);
    },
    ...overrides,
  };
  return { deps, calls, FakeBrowserWindow };
}

test('re-exports createMainWindowStartupLifecycle from the startup-lifecycle module', () => {
  assert.equal(
    createMainWindowStartupLifecycle,
    require('../services/main-window-startup-lifecycle').createMainWindowStartupLifecycle,
  );
});

test('constructs exactly one BrowserWindow with the hardened option shape', () => {
  const { deps, FakeBrowserWindow } = makeDeps();
  createMainWindowWithDeps(deps);

  assert.equal(FakeBrowserWindow.created.length, 1, 'BrowserWindow constructed exactly once');
  const opts = FakeBrowserWindow.created[0].options;
  assert.equal(opts.frame, false);
  assert.equal(opts.show, false);
  assert.equal(opts.width, 1600);
  assert.equal(opts.height, 930);
  // UIUX-004: the supported minimum viewport. Must stay below the CSS
  // narrow-layout ladder (Chat 700 / Logs 760-980 / Quick Settings 560) and
  // fit a 1920px half snap (~960) and a 1024x600 remote-desktop work area.
  // Keep in sync with MIN_WINDOW_WIDTH/HEIGHT in services/window-state-service.js.
  assert.equal(opts.minWidth, 640);
  assert.equal(opts.minHeight, 560);
  assert.equal(opts.icon, undefined, 'window icon remains optional for packaged/default composition');
  // The main window loads the esbuild-bundled, self-contained preload — NOT
  // preload.js source. Under sandbox:true only a bundled single-file preload
  // loads; preload.js source would throw "module not found: ./services/ipc-contract".
  assert.equal(opts.webPreferences.preload, path.join(process.cwd(), 'preload.bundle.js'));
  assert.equal(opts.webPreferences.contextIsolation, true);
  assert.equal(opts.webPreferences.nodeIntegration, false);
  // Renderer runs in the Chromium OS process sandbox (it paints untrusted model
  // output). Safe only because `preload` points at preload.bundle.js above. A
  // real sandboxed-preload gate lives in tests/electron-shell-smoke.test.js.
  assert.equal(opts.webPreferences.sandbox, true);
});

test('forwards an explicit development icon to BrowserWindow', () => {
  const windowIconPath = path.join(process.cwd(), 'build', 'icon.ico');
  const { deps, FakeBrowserWindow } = makeDeps({ windowIconPath });

  createMainWindowWithDeps(deps);

  assert.equal(FakeBrowserWindow.created[0].options.icon, windowIconPath);
});

test('revealWindowInactive disables backgroundThrottling; default leaves it unset', () => {
  const { deps: defaultDeps, FakeBrowserWindow: defaultBW } = makeDeps();
  createMainWindowWithDeps(defaultDeps);
  assert.equal(
    defaultBW.created[0].options.webPreferences.backgroundThrottling,
    undefined,
    'default launch leaves backgroundThrottling at the Electron default (unset)',
  );

  const { deps: inactiveDeps, FakeBrowserWindow: inactiveBW } = makeDeps({ revealWindowInactive: true });
  createMainWindowWithDeps(inactiveDeps);
  assert.equal(
    inactiveBW.created[0].options.webPreferences.backgroundThrottling,
    false,
    'inactive reveal disables backgroundThrottling so an occluded window keeps running',
  );
});

test('registers the window via setMainWindow with the created instance and returns it', () => {
  const { deps, calls } = makeDeps();
  const returned = createMainWindowWithDeps(deps);

  assert.equal(calls.setMainWindow.length, 1, 'setMainWindow called exactly once');
  assert.equal(calls.setMainWindow[0], returned, 'setMainWindow received the created window');
  assert.equal(returned, deps.BrowserWindow.created[0], 'returns the created window instance');
});

test('loads index.html, hides the menu bar, and attaches windowStateService', () => {
  const { deps, calls } = makeDeps();
  const win = createMainWindowWithDeps(deps);

  assert.equal(win.loadedFile, path.join(process.cwd(), 'index.html'));
  assert.equal(win.menuBarVisible, false);
  assert.equal(calls.attach.length, 1, 'windowStateService.attach called once');
  assert.equal(calls.attach[0], win, 'attached with the created window');
});

test('emits the window-created startup audit mark and registers a dom-ready audit hook', () => {
  const { deps, calls } = makeDeps();
  const win = createMainWindowWithDeps(deps);

  const marks = calls.emitStartupAuditMark.map((c) => c[0]);
  assert.deepEqual(marks, ['window-created'], 'only window-created emitted synchronously');

  // dom-ready is registered as a once-handler on webContents and emits its mark
  // only when fired.
  const domReadyEntry = win.webContents.onceHandlers.find((h) => h[0] === 'dom-ready');
  assert.ok(domReadyEntry, 'a dom-ready once-handler is registered on webContents');
  domReadyEntry[1]();
  assert.deepEqual(
    calls.emitStartupAuditMark.find((c) => c[0] === 'dom-ready'),
    ['dom-ready', { source: 'main' }],
    'firing dom-ready emits the dom-ready audit mark with source main',
  );
});

test('logs window.created with the startup elapsed milliseconds', () => {
  const { deps, calls } = makeDeps();
  createMainWindowWithDeps(deps);

  const createdLog = calls.log.find((args) => args[0] === 'INFO' && args[1] === 'window.created');
  assert.ok(createdLog, 'an INFO window.created log entry exists');
  assert.deepEqual(createdLog[2], { startupMs: 4242 }, 'window.created carries startupMs from getStartupElapsedMs');
});

test('maximizes the window only when initial state reports isMaximized', () => {
  const notMax = makeDeps();
  const winA = createMainWindowWithDeps(notMax.deps);
  assert.equal(winA.maximized, false, 'window not maximized when isMaximized:false');

  const max = makeDeps({
    windowStateService: {
      getInitialWindowOptions: () => ({ width: 1600, height: 930, isMaximized: true }),
      attach() {},
    },
  });
  const winB = createMainWindowWithDeps(max.deps);
  assert.equal(winB.maximized, true, 'window maximized when isMaximized:true');
});

test('smoke vs non-smoke branch register observably different handler sets', () => {
  // Non-smoke: the composition delegates to createMainWindowStartupLifecycle, which
  // registers a 'ready-to-show' once-handler on the window and 'did-finish-load' /
  // 'did-fail-load' handlers on webContents. It also owns the 'closed' handler.
  const nonSmoke = makeDeps({ isPackagedSmokeEnabled: () => false });
  const winNon = createMainWindowWithDeps(nonSmoke.deps);

  // Smoke: the lifecycle is NOT invoked; the composition body registers its own
  // 'closed' handler directly and none of the lifecycle's ready/fail hooks exist.
  const smoke = makeDeps({ isPackagedSmokeEnabled: () => true });
  const winSmoke = createMainWindowWithDeps(smoke.deps);

  // Both branches register exactly one 'closed' handler on the window, but via
  // different code paths, so closed-count alone does not distinguish them.
  assert.equal(winNon.onEvents.has('closed'), true, 'non-smoke window has a closed handler');
  assert.equal(winSmoke.onEvents.has('closed'), true, 'smoke window has a closed handler');

  // The lifecycle-only 'ready-to-show' once-handler is the genuine discriminator:
  // present only when the lifecycle runs (non-smoke), absent in the smoke branch.
  assert.equal(
    winNon.onceEvents.has('ready-to-show'),
    true,
    'non-smoke branch registers the lifecycle ready-to-show once-handler',
  );
  assert.equal(
    winSmoke.onceEvents.has('ready-to-show'),
    false,
    'smoke branch does NOT register the lifecycle ready-to-show handler',
  );

  // Likewise the lifecycle's webContents fail-load hook exists only in non-smoke.
  const nonFail = winNon.webContents.onHandlers.some((h) => h[0] === 'did-fail-load');
  const smokeFail = winSmoke.webContents.onHandlers.some((h) => h[0] === 'did-fail-load');
  assert.equal(nonFail, true, 'non-smoke wires did-fail-load via the lifecycle');
  assert.equal(smokeFail, false, 'smoke branch does not wire did-fail-load');
});

test('non-smoke branch wires the startup lifecycle ready/fail-load hooks on webContents', () => {
  const { deps } = makeDeps({ isPackagedSmokeEnabled: () => false });
  const win = createMainWindowWithDeps(deps);

  // The startup lifecycle (only invoked in the non-smoke branch) registers a
  // did-finish-load once-handler and a did-fail-load on-handler on webContents.
  const onceEvents = win.webContents.onceHandlers.map((h) => h[0]);
  const onEvents = win.webContents.onHandlers.map((h) => h[0]);
  assert.ok(onceEvents.includes('did-finish-load'), 'lifecycle registers did-finish-load once-handler');
  assert.ok(onEvents.includes('did-fail-load'), 'lifecycle registers did-fail-load on-handler');
  // ready-to-show once-handler is on the window itself.
  assert.ok(win.onceEvents.has('ready-to-show'), 'lifecycle registers ready-to-show on the window');
});

test('navigation guard hands http(s) targets to shell.openExternal and denies window.open', () => {
  const openExternalCalls = [];
  const { deps } = makeDeps({
    shell: {
      openExternal: async (url) => {
        openExternalCalls.push(url);
      },
      openPath: async () => {},
    },
  });
  const win = createMainWindowWithDeps(deps);

  // will-navigate handler is registered on webContents by the nav guard.
  const willNav = win.webContents.onHandlers.find((h) => h[0] === 'will-navigate');
  assert.ok(willNav, 'will-navigate handler registered');
  const prevented = { count: 0 };
  willNav[1]({ preventDefault() { prevented.count += 1; } }, 'https://evil.example.com/page');
  assert.equal(prevented.count, 1, 'external navigation was prevented');
  assert.deepEqual(openExternalCalls, ['https://evil.example.com/page'], 'external url handed to shell.openExternal');

  // window.open handler denies and routes external urls to openExternal too.
  const handler = win.webContents.getWindowOpenHandler();
  assert.equal(typeof handler, 'function', 'a window-open handler was installed');
  const result = handler({ url: 'https://other.example.com/' });
  assert.deepEqual(result, { action: 'deny' }, 'window.open is denied');
  assert.deepEqual(
    openExternalCalls,
    ['https://evil.example.com/page', 'https://other.example.com/'],
    'window.open external url also handed to shell.openExternal',
  );
});
