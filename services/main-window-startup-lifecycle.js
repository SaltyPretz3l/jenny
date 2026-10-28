const { getBridgeChannel } = require('./ipc-contract');

const DEFAULT_WINDOW_READY_CHANNEL = getBridgeChannel('lifecycle.signalReady', 'send');
const DEFAULT_REVEAL_TIMEOUT_MS = 5000;

function createMainWindowStartupLifecycle({
  windowRef,
  ipcMainRef,
  readyChannel = DEFAULT_WINDOW_READY_CHANNEL,
  revealTimeoutMs = DEFAULT_REVEAL_TIMEOUT_MS,
  revealInactive = false,
  revealMaximized = false,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  logReady = () => {},
  logLoadFailure = () => {},
  emitStartupAuditMark = () => {},
  onWindowClosed = () => {},
} = {}) {
  if (!windowRef || typeof windowRef.on !== 'function' || typeof windowRef.once !== 'function') {
    throw new TypeError('createMainWindowStartupLifecycle requires a BrowserWindow-like windowRef');
  }
  if (
    !windowRef.webContents
    || typeof windowRef.webContents.on !== 'function'
    || typeof windowRef.webContents.once !== 'function'
  ) {
    throw new TypeError('createMainWindowStartupLifecycle requires a BrowserWindow-like webContents');
  }
  if (
    !ipcMainRef
    || typeof ipcMainRef.on !== 'function'
    || typeof ipcMainRef.removeListener !== 'function'
  ) {
    throw new TypeError('createMainWindowStartupLifecycle requires an ipcMain-like event emitter');
  }

  let revealLogged = false;
  let maximizedOnReveal = false;
  let domReady = false;
  let cleanedUp = false;
  let revealTimeoutHandle = null;
  let rendererReadyListener = null;

  function clearRevealTimeout() {
    if (revealTimeoutHandle == null) {
      return;
    }
    clearTimeoutImpl(revealTimeoutHandle);
    revealTimeoutHandle = null;
  }

  function detachRendererReadyListener() {
    if (typeof rendererReadyListener !== 'function') {
      return;
    }
    ipcMainRef.removeListener(readyChannel, rendererReadyListener);
    rendererReadyListener = null;
  }

  function cleanup() {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    clearRevealTimeout();
    detachRendererReadyListener();
  }

  function revealWindow(source) {
    if (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed()) {
      return;
    }
    const hidden = typeof windowRef.isVisible === 'function' && !windowRef.isVisible();
    if (revealMaximized && !maximizedOnReveal && typeof windowRef.maximize === 'function') {
      // maximize() also shows a hidden window, so a saved maximized state is
      // restored here, at first paint, rather than at creation where it would
      // show the window before the curtain painted. On Windows it shows with
      // activation (SW_SHOWMAXIMIZED) whenever the process still holds its
      // launch foreground right, so an inactive reveal of a maximized state can
      // take focus; there is no non-activating maximize.
      maximizedOnReveal = true;
      windowRef.maximize();
      if (hidden && !revealInactive) windowRef.focus?.();
    } else if (hidden) {
      // revealInactive (GUI-smoke / background launches) shows the window
      // WITHOUT activating it, so it never steals focus from — or alt-tabs out
      // of — a foreground full-screen app. Falls back to show() when the
      // runtime lacks showInactive.
      if (revealInactive && typeof windowRef.showInactive === 'function') {
        windowRef.showInactive();
      } else {
        windowRef.show?.();
      }
    }
    if (revealLogged) {
      return;
    }
    revealLogged = true;
    clearRevealTimeout();
    detachRendererReadyListener();
    logReady(source, windowRef);
    emitStartupAuditMark('window-visible', { source: 'main', trigger: source });
  }

  // The window shows at its first paint: the static startup curtain in
  // index.html is themed before any script runs and covers the shell until it
  // is interactive, so waiting for the renderer's ready signal (every script
  // parsed plus the first full render) only kept the screen empty longer.
  function tryReveal(trigger) {
    if (domReady) {
      revealWindow(trigger);
    }
  }

  rendererReadyListener = (event) => {
    if (event?.sender && event.sender !== windowRef.webContents) {
      return;
    }
    detachRendererReadyListener();
    tryReveal('renderer-ready');
  };

  windowRef.once('ready-to-show', () => {
    domReady = true;
    tryReveal('ready-to-show');
  });
  windowRef.webContents.once('did-finish-load', () => {
    domReady = true;
    tryReveal('did-finish-load');
  });
  windowRef.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
    logLoadFailure({
      code,
      description,
      validatedURL,
      isMainFrame: Boolean(isMainFrame),
      windowRef,
    });
    if (isMainFrame) {
      revealWindow('did-fail-load');
    }
  });
  ipcMainRef.on(readyChannel, rendererReadyListener);
  revealTimeoutHandle = setTimeoutImpl(() => {
    revealTimeoutHandle = null;
    revealWindow('startup-timeout');
  }, revealTimeoutMs);
  windowRef.on('closed', () => {
    cleanup();
    onWindowClosed(windowRef);
  });

  return { cleanup };
}

module.exports = {
  DEFAULT_REVEAL_TIMEOUT_MS,
  DEFAULT_WINDOW_READY_CHANNEL,
  createMainWindowStartupLifecycle,
};
