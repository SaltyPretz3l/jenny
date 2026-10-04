const path = require('path');
const { APP_ZOOM_DEFAULT } = require('../shell-config-zoom-state');

const { registerMainWindowSessionEndHandlers } = require('../main-lifecycle');
const { attachMainWindowNavigationGuards } = require('../main-window-navigation-guard');
const { createMainWindowStartupLifecycle } = require('../main-window-startup-lifecycle');
const { attachSpellcheckMenuBridge } = require('./spellcheck-menu-bridge');
const { installApplicationMenu } = require('./app-menu');
const { buildFeatureFlags } = require('../feature-flags');

function resolveWindowIconPath({ isPackaged, platform, rootDir, resourcesPath }) {
  // Windows/mac executables carry their icon; the Linux ELF does not, so
  // packaging copies build/icon.png into resources.
  if (!isPackaged) return path.join(rootDir, 'build', platform === 'win32' ? 'icon.ico' : 'icon.png');
  if (platform === 'linux' && resourcesPath) return path.join(resourcesPath, 'icon.png');
  return null;
}

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
  getInitialAppZoomFactor = () => APP_ZOOM_DEFAULT / 100,
  getPortableAppearance = () => null,
  getUiLanguage = () => 'en',
  revealWindowInactive = false,
  getWindowExitGuard = () => null,
  onWindowVisibilityChange = () => {},
  Menu = null,
  isPackaged = true,
  platform = process.platform,
  env = process.env,
} = {}) {
  // Replace Electron's default menu before the first window exists: its View >
  // Reload / Force Reload accelerators fire in the main process and would skip
  // the renderer's guarded reload (dirty-buffer preflight). See app-menu.js.
  installApplicationMenu({ Menu, platform, isPackaged, log });
  const initialWindowState = windowStateService
    ? windowStateService.getInitialWindowOptions()
    : { width: 1600, height: 930, isMaximized: false };
  // Resolve the persisted overall app zoom and apply it at window-creation time
  // so the frame opens pre-zoomed (no flash from a 100%-then-jump repaint).
  let initialAppZoomFactor = APP_ZOOM_DEFAULT / 100;
  try {
    const resolved = Number(getInitialAppZoomFactor());
    if (Number.isFinite(resolved) && resolved > 0) {
      initialAppZoomFactor = resolved;
    }
  } catch (_error) {
    initialAppZoomFactor = APP_ZOOM_DEFAULT / 100;
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
  // Safety net (real-app B4b): the renderer's exit preflight owns unsaved-work
  // prompts, so a beforeunload that cancels the unload is a stray handler. Left
  // alone it silently swallows close/reload and trips the unresponsive
  // shutdown. In Electron, preventDefault() here means "ignore the
  // beforeunload and unload anyway".
  windowRef.webContents.on('will-prevent-unload', (event) => {
    log('WARN', 'window.unload_prevented', {});
    event.preventDefault();
  });

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
  // On screen or not, for the stats monitor pause (runtime-service-composition).
  const reportVisibility = () => {
    try {
      onWindowVisibilityChange(windowRef.isVisible() && !windowRef.isMinimized());
    } catch (_error) {
      // Visibility reporting is an optimization; the monitor keeps running.
    }
  };
  ['hide', 'minimize', 'show', 'restore'].forEach((event) => windowRef.on(event, reportVisibility));
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
  const query = portableAppearance
    ? { jennyAppearance: JSON.stringify(portableAppearance) }
    : {};
  try {
    const uiLanguage = getUiLanguage();
    if (typeof uiLanguage === 'string' && uiLanguage.length > 0) {
      query.jennyUiLanguage = uiLanguage;
    }
  } catch (_error) {
    // Language projection is optional; the renderer falls back to storage.
  }
  // The env-only startup_animation kill switch must be on the page before its
  // first paint: the boot curtain mounts its sky at construction, long before
  // the renderer fetches feature flags. theme-bootstrap.js stamps it.
  if (buildFeatureFlags(env).startup_animation === false) {
    query.jennyStartupAnimation = 'off';
  }
  const loadOptions = Object.keys(query).length ? { query } : undefined;
  windowRef.loadFile(path.join(rootDir, 'index.html'), loadOptions);
  log('INFO', 'window.created', {
    startupMs: getStartupElapsedMs(),
  });
  emitStartupAuditMark('window-created', { source: 'main' });
  return windowRef;
}

module.exports = {
  createMainWindowStartupLifecycle,
  createMainWindowWithDeps,
  resolveWindowIconPath,
};
