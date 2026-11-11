const {
  applyWebSearchSecret,
  buildWebSearchSecretStatus,
  registerFeatureIpcHandlers: registerFeatureIpcHandlersWithDeps,
} = require('../../feature-settings-service');
const { registerClientLogIpcHandler } = require('../client-log-forwarding');
const { createSpellcheckSessionController } = require('../spellcheck-session-controller');
const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { getWindowStateSnapshot } = require('../../window-state-service');
const { APP_ZOOM_DEFAULT } = require('../../shell-config-zoom-state');

// App-shell domain IPC: feature settings, the session spellcheck controller,
// renderer log forwarding, the chat/window UI settings, and the window controls
// (state, native-close preflight, appearance relay reply, clipboard).

function registerFeatureIpcHandlers(
  ipcMainLike,
  {
    getState = () => ({}),
    updateSettings = () => ({}),
    getWebSearchSecretStatus = null,
    setWebSearchSecret = null,
    authorization = {},
  } = {}
) {
  registerFeatureIpcHandlersWithDeps({
    ipcMainLike,
    getState,
    updateSettings,
    getWebSearchSecretStatus,
    setWebSearchSecret,
    authorization,
  });
}

function registerAppShellIpcHandlers(ipcMain, {
  app,
  backendService,
  shellConfigService,
  buildFeatureStatePayload,
  applyFeatureSettingsPatch,
  spellcheckSessionRef,
  getDiagnosticLogService,
  getLogRedactionPrefixes,
  processRef,
  log,
  getMainLifecycle,
  workspaceAuthorization,
}) {
  registerFeatureIpcHandlers(ipcMain, {
    getState: () => buildFeatureStatePayload(),
    updateSettings: (patch) => applyFeatureSettingsPatch(patch),
    getWebSearchSecretStatus: () => buildWebSearchSecretStatus({ backendService }),
    setWebSearchSecret: (payload) => applyWebSearchSecret({ backendService, payload }),
    authorization: workspaceAuthorization,
  });
  try {
    let sessionRef = spellcheckSessionRef;
    try {
      sessionRef ||= require('electron')?.session?.defaultSession || null;
    } catch (_error) {
      /* no electron runtime (tests): the controller degrades to one WARN */
    }
    const controller = createSpellcheckSessionController({
      sessionRef, getShellConfigService: () => shellConfigService, env: processRef?.env || process.env, log,
    });
    controller.apply();
    const spellcheckLifecycle = getMainLifecycle?.();
    if (typeof spellcheckLifecycle?.registerShutdownTask === 'function') {
      spellcheckLifecycle.registerShutdownTask(controller.dispose);
    } else if (typeof app?.once === 'function') {
      app.once('will-quit', controller.dispose);
    }
  } catch (error) {
    try {
      log('WARN', 'spellcheck.session_controller_failed', {
        message: String(error?.message || error).slice(0, 200),
      });
    } catch (_logError) {
      /* best-effort */
    }
  }
  registerClientLogIpcHandler(ipcMain, {
    authorize: workspaceAuthorization.authorize,
    getDiagnosticLogService,
    getRedactionPrefixes: getLogRedactionPrefixes,
    env: processRef?.env || process.env,
    log,
  });
}

function registerUiSettingsIpcHandlers(ipcMainLike, { shellConfigService, ipcAuthorization }) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'chatUi.getState': () => shellConfigService.getChatUiState(),
    'chatUi.updateSettings': (_, patch) => {
      shellConfigService.updateChatUiSettings(patch);
      return shellConfigService.getChatUiState();
    },
    'windowUi.getState': () => shellConfigService.getWindowUiState(),
    'windowUi.updateSettings': (event, patch) => {
      const nextWindowUi = shellConfigService.updateWindowUiSettings(patch);
      // Apply the overall app zoom live to the requesting renderer's frame.
      // Startup application is handled at window creation via webPreferences.
      try {
        const factor = (Number(nextWindowUi?.appZoomPercent) || APP_ZOOM_DEFAULT) / 100;
        const sender = event && event.sender;
        if (sender && typeof sender.setZoomFactor === 'function') {
          sender.setZoomFactor(factor);
        }
      } catch (_error) {
        // setZoomFactor throws if the frame is gone; the persisted value still
        // applies on next launch, so ignore.
      }
      return shellConfigService.getWindowUiState();
    },
  }, ipcAuthorization);
}

function registerWindowIpcHandlers(ipcMainLike, {
  clipboard,
  getMainWindow,
  getWindowState,
  getMainLifecycle,
  windowExitGuard,
  appearanceRelay,
  log,
  ipcAuthorization,
}) {
  const getWindowStatePayload = () => {
    if (typeof getWindowState === 'function') {
      return getWindowState();
    }
    return getWindowStateSnapshot(typeof getMainWindow === 'function' ? getMainWindow() : null);
  };
  registerIpcInvokeHandlers(ipcMainLike, {
    'clipboard.writeText': async (_, text) => {
      await clipboard.writeText(String(text || ''));
      return { ok: true };
    },
    'window.getState': () => getWindowStatePayload(),
    // Renderer→main reply to a native-close dirty preflight. Resolves
    // the exit guard's pending entry (proceed:true closes; proceed:false keeps
    // the window). Fail-soft when no guard is wired.
    // Row 88 D8: the renderer's reply to an appearance relay request (sender re-checked inside).
    'appearance.respondRelay': (event, payload) => (appearanceRelay ? appearanceRelay.handleResponse(event, payload) : { ok: false }),
    'window.respondExitPreflight': (_, payload) => {
      if (windowExitGuard && typeof windowExitGuard.resolvePreflight === 'function') {
        return windowExitGuard.resolvePreflight(payload);
      }
      return { ok: false, code: 'guard_unavailable' };
    },
    windowControl: (_, action) => {
      log('DEBUG', 'window.control', { action });
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { ok: false, maximized: false, minimized: false };
      }
      if (action === 'minimize') {
        mainWindow.minimize();
      }
      if (action === 'maximize') {
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
        } else {
          mainWindow.maximize();
        }
      }
      if (action === 'close' && !mainWindow.isDestroyed()) {
        // The renderer already ran the dirty preflight before invoking, so tell
        // the native-close guard to bypass its interceptor (else it would
        // re-prompt). authorizeNextClose() MUST run before close() fires the
        // 'close' event — and only when close() will actually fire one: a
        // destroyed window would leave the one-shot bypass latched, silently
        // authorizing the NEXT genuine native close to skip the dirty prompt.
        if (windowExitGuard && typeof windowExitGuard.authorizeNextClose === 'function') {
          windowExitGuard.authorizeNextClose();
        }
        mainWindow.close();
      }
      if (action === 'reload') {
        const mainLifecycle = getMainLifecycle();
        if (mainLifecycle && mainLifecycle.isAppQuitting()) {
          return { ok: false, maximized: false, minimized: false };
        }
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.reloadIgnoringCache();
        }
      }
      if (action === 'toggle-devtools' && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools();
      }
      return getWindowStatePayload();
    },
  }, ipcAuthorization);
}

module.exports = {
  registerAppShellIpcHandlers,
  registerFeatureIpcHandlers,
  registerUiSettingsIpcHandlers,
  registerWindowIpcHandlers,
};
