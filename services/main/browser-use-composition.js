'use strict';

/**
 * The model-driven browser's per-profile holder (roadmap row 114). The service, Electron's view
 * classes and the reserved-port reader load on first use, so none of it costs startup time or a
 * first paint for a user who never turns the browser on. The app-wide mute lives here because
 * it has to reach the pages and must work before any page has opened.
 */

const { createAppSound } = require('./app-sound-service');

function managerBaseUrl(getManager) {
  try {
    return getManager?.()?.getBaseUrl?.() || '';
  } catch (_error) {
    return '';
  }
}

// Electron presents the first certificate in the OS store unless told otherwise, and a page here holds no identity.
function refuseClientCertificates(service) {
  return (event, contents, _url, _list, callback) => {
    if (!service.ownsContents(contents)) return;
    event.preventDefault();
    callback();
  };
}

// A reloaded app has no panel to show a page in, and the native view would otherwise stay painted over it.
function parkPagesOnAppReload(service) {
  return (details, _url, isInPlace, isMainFrame) => {
    const mainFrame = typeof details?.isMainFrame === 'boolean' ? details.isMainFrame : isMainFrame;
    const sameDocument = typeof details?.isSameDocument === 'boolean' ? details.isSameDocument : isInPlace;
    if (mainFrame && !sameDocument) service.hideAll();
  };
}

function installAppHooks(app, appContents, service) {
  const onCertificate = refuseClientCertificates(service);
  const onNavigation = parkPagesOnAppReload(service);
  app.on('select-client-certificate', onCertificate);
  appContents?.on?.('did-start-navigation', onNavigation);
  return () => {
    app.removeListener('select-client-certificate', onCertificate);
    if (!appContents?.isDestroyed?.()) appContents?.removeListener?.('did-start-navigation', onNavigation);
  };
}

function createLazyBrowserUse({ getMainWindow, sendBridgeEvent, getBackendService, getSafetyMode, logger }) {
  let service = null;
  let releaseAppHooks = () => {};
  let releaseCreatedHook = null;
  const warn = (event) => { try { logger?.('WARN', event, {}); } catch (_error) { /* logging never breaks sound */ } };
  const appSound = createAppSound({
    listContents: () => require('electron').webContents.getAllWebContents(),
    isManagedPage: (contents) => Boolean(service?.ownsContents(contents)),
    sendBridgeEvent,
    onMuteChanged: () => service?.applyAppMute(),
    logger: { warn: () => warn('app_sound.warning') },
  });
  const watchMainWindow = () => appSound.watchMainContents(getMainWindow?.()?.webContents);
  // A window opened while muted has to join the mute. Nothing needs the hook before the first mute.
  function hookNewContents() {
    if (releaseCreatedHook) return;
    const { app } = require('electron');
    const onCreated = (_event, contents) => appSound.applyToContents(contents);
    app.on('web-contents-created', onCreated);
    releaseCreatedHook = () => app.removeListener('web-contents-created', onCreated);
  }
  return {
    isAppMuted: () => appSound.isMuted(),
    soundState() {
      watchMainWindow();
      return appSound.state();
    },
    setAppMuted(muted) {
      watchMainWindow();
      hookNewContents();
      appSound.setMuted(muted);
      return appSound.state();
    },
    get() {
      if (!service) {
        const electron = require('electron');
        const { createBrowserUseService } = require('../browser-use/browser-use-service');
        const { createReservedPortReader } = require('../browser-use/reserved-ports');
        const { createAdBlocker } = require('../browser-use/ad-block');
        const adBlocker = createAdBlocker({ logger: { warn: () => warn('browser_use.ad_filters_unavailable') } });
        service = createBrowserUseService({
          adBlocker,
          isAppMuted: () => appSound.isMuted(),
          onChatSound: (sessionId, sound) => appSound.noteChatSound(sessionId, sound),
          createView: (options) => new electron.WebContentsView(options),
          sessionFromPartition: (partition) => electron.session.fromPartition(partition),
          getMainWindow,
          sendBridgeEvent,
          logger,
          // Runs on page input, so the lookup that loads no transcript.
          canOpenByHand: (sessionId) => {
            const backend = getBackendService?.();
            if (backend?.featureFlags?.tools_browser_use_enabled !== true || getSafetyMode?.() !== 'normal') return false;
            return backend.sessionStore?.peekSession?.(sessionId)?.tool_category_overrides?.browser_use === true;
          },
          showMenu: (template) => electron.Menu.buildFromTemplate(template).popup({ window: getMainWindow?.() }),
          writeClipboard: (text) => electron.clipboard.writeText(String(text)),
          revealFile: (filePath) => electron.shell.showItemInFolder(filePath),
          getRunningTurnId: (sessionId) => getBackendService?.()?.sessionStore?.peekActiveTurn?.(sessionId)?.turn_id || '',
          getReservedPorts: createReservedPortReader({
            getBaseUrls: () => {
              const options = getBackendService?.()?.options;
              return [managerBaseUrl(options?.getLlamaServerManager), managerBaseUrl(options?.getNinferManager)].filter(Boolean);
            },
            getDebugPort: () => electron.app.commandLine.getSwitchValue('remote-debugging-port'),
          }),
        });
        releaseAppHooks = installAppHooks(electron.app, getMainWindow?.()?.webContents, service);
      }
      return service;
    },
    // A deleted chat's page has nobody left to close it. Never starts the service just to find nothing.
    closeSession(sessionId) {
      return service ? service.close(sessionId) : null;
    },
    // Never starts the service: a chat with no page has nothing to close.
    closeFinished(sessionId) {
      try { return service ? service.closeFinished(sessionId) : false; } catch (_error) { return false; }
    },
    waitedOnUser(sessionId, callId) {
      return service ? service.waitedOnUser(sessionId, callId) : false;
    },
    async dispose() {
      releaseAppHooks();
      releaseCreatedHook?.();
      appSound.dispose();
      if (service) await service.dispose();
    },
  };
}

module.exports = { createLazyBrowserUse, installAppHooks };
