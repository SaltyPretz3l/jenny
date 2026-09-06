const path = require('path');

const { registerMainWindowSessionEndHandlers } = require('../main-lifecycle');
const { attachMainWindowNavigationGuards } = require('../main-window-navigation-guard');
const { createMainWindowStartupLifecycle } = require('../main-window-startup-lifecycle');
const { attachSpellcheckMenuBridge } = require('./spellcheck-menu-bridge');

function createMainWindowWithDeps({
  BrowserWindow,
  rootDir,
  windowIconPath = null,
  ipcMainRef,
  shell,
  windowStateService = null,
  mainErrorHardening = null,
  mainLifecycle = null,
  isPackagedSmokeEnabled = () => false,
  getStartupElapsedMs = () => 0,
  emitStartupAuditMark = () => {},
  log = () => {},
  emitMainWindowStateChanged = () => {},
  getMainWindow = () => null,
  setMainWindow = () => {},
  getInitialAppZoomFactor = () => 1,
  getPortableAppearance = () => null,
  revealWindowInactive = false,
  getWindowExitGuard = () => null,
} = {}) {
  const initialWindowState = windowStateService
    ? windowStateService.getInitialWindowOptions()
    : { width: 1600, height: 930, isMaximized: false };
  // Resolve the persisted overall app zoom and apply it at window-creation time
  // so the frame opens pre-zoomed (no flash from a 100%-then-jump repaint).
  let initialAppZoomFactor = 1;
  try {
    const resolved = Number(getInitialAppZoomFactor());
    if (Number.isFinite(resolved) && resolved > 0) {
      initialAppZoomFactor = resolved;
    }
  } catch (_error) {
    initialAppZoomFactor = 1;
  }
  const browserWindowOptions = {
    width: initialWindowState.width || 1600,
    height: initialWindowState.height || 930,
    // Supported minimum viewport (UIUX-004) — keep in sync with
    // MIN_WINDOW_WIDTH/HEIGHT in services/window-state-service.js and the
    // narrow-layout CSS ladder (Chat collapses at 700, Logs at 980/760).
    minWidth: 640,
    minHeight: 560,
    frame: false,
    backgroundColor: '#0b0d14',
    show: false,
    ...(windowIconPath ? { icon: windowIconPath } : {}),
    webPreferences: {
      // preload.bundle.js is the esbuild-bundled, self-contained preload (built
      // by scripts/build/build-preload.js on every dev launch and before
      // packaging). It MUST be the bundle, not preload.js source: under
      // sandbox:true Electron's sandboxed-preload loader cannot resolve on-disk
      // local requires like `require('./services/ipc-contract')` — only the
      // electron/node builtin allowlist and a single bundled file. Pointing at
      // preload.js source here would throw "module not found: ./services/ipc-contract",
      // leave jennyShell undefined, and boot a dead shell. See
      // project_main_window_sandbox_hardening for the RCA.
      preload: path.join(rootDir, 'preload.bundle.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer paints untrusted model output (markdown, HTML artifacts,
      // mermaid), so it runs in the Chromium OS process sandbox. Safe only
      // because the preload above is bundled — never point `preload` back at
      // preload.js source while this stays true.
      sandbox: true,
      zoomFactor: initialAppZoomFactor,
      // An inactive (background) reveal can leave the window fully occluded by a
      // foreground full-screen app; keep timers/rAF un-throttled so the renderer
      // still drives streaming + polling at full speed while it sits hidden.
      ...(revealWindowInactive ? { backgroundThrottling: false } : {}),
    },
  };
  if (Number.isFinite(initialWindowState.x) && Number.isFinite(initialWindowState.y)) {
    browserWindowOptions.x = initialWindowState.x;
    browserWindowOptions.y = initialWindowState.y;
  }
  const windowRef = new BrowserWindow(browserWindowOptions);
  setMainWindow(windowRef);

  // UIUX-003: intercept native OS close so unsaved IDE buffers get a prompt.
  // Attach as early as possible (before renderer load) so an immediate close
  // is still guarded. Best-effort: a missing guard never blocks window creation.
  try {
    const windowExitGuard = getWindowExitGuard();
    if (windowExitGuard && typeof windowExitGuard.attach === 'function') {
      windowExitGuard.attach(windowRef);
    }
  } catch (_error) {
    /* guard attach is best-effort */
  }

  if (!isPackagedSmokeEnabled()) {
    createMainWindowStartupLifecycle({
      windowRef,
      ipcMainRef,
      revealInactive: revealWindowInactive,
      emitStartupAuditMark,
      logReady: (source, activeWindow) => {
        log('INFO', 'window.ready', {
          source,
          width: activeWindow.getBounds().width,
          height: activeWindow.getBounds().height,
          startupMs: getStartupElapsedMs(),
        });
      },
      logLoadFailure: ({ code, description, validatedURL, isMainFrame }) => {
        log('ERROR', 'window.did_fail_load', {
          code,
          description,
          validatedURL,
          isMainFrame,
        });
      },
      onWindowClosed: (closedWindow) => {
        if (getMainWindow() === closedWindow) {
          setMainWindow(null);
        }
      },
    });
  } else {
    windowRef.on('closed', () => {
      if (getMainWindow() === windowRef) {
        setMainWindow(null);
      }
    });
  }
  if (mainErrorHardening) {
    mainErrorHardening.attachWindowCrashGuards(windowRef);
  }

  attachMainWindowNavigationGuards({
    windowRef,
    shell,
    log,
  });

  // Composer spellcheck: forward the main-process context-menu event's
  // misspelled word + suggestions to the renderer (the custom composer menu
  // suppresses Chromium's native one) and register the two native correction
  // channels. Best-effort — a failure here leaves today's clipboard-only menu.
  attachSpellcheckMenuBridge({
    windowRef,
    ipcMainRef,
    getMainWindow,
    log,
  });

  windowRef.on('maximize', () => {
    log('DEBUG', 'window.maximized');
    emitMainWindowStateChanged();
  });
  windowRef.on('unmaximize', () => {
    log('DEBUG', 'window.restored');
    emitMainWindowStateChanged();
  });
  windowRef.on('restore', emitMainWindowStateChanged);
  windowRef.on('minimize', emitMainWindowStateChanged);
  if (mainLifecycle) {
    registerMainWindowSessionEndHandlers(windowRef, mainLifecycle);
  }

  windowRef.setMenuBarVisibility(false);
  if (initialWindowState.isMaximized === true) {
    windowRef.maximize();
  }
  if (windowStateService) {
    windowStateService.attach(windowRef);
  }
  windowRef.webContents.once('dom-ready', () => {
    emitStartupAuditMark('dom-ready', { source: 'main' });
  });
  let portableAppearance = null;
  try {
    portableAppearance = getPortableAppearance();
  } catch (_error) {
    // Appearance projection is optional; the renderer falls back to storage.
  }
  windowRef.loadFile(path.join(rootDir, 'index.html'), portableAppearance
    ? { query: { jennyAppearance: JSON.stringify(portableAppearance) } }
    : undefined);
  log('INFO', 'window.created', {
    startupMs: getStartupElapsedMs(),
  });
  emitStartupAuditMark('window-created', { source: 'main' });
  return windowRef;
}

module.exports = {
  createMainWindowStartupLifecycle,
  createMainWindowWithDeps,
};
