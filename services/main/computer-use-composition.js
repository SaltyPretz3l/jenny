'use strict';

/**
 * The computer tool's per-profile holder (roadmap row 196). The service, the program finder and their
 * modules load on first use, so none of it costs startup time for an owner who never turns Computer on.
 * The helper host is the Live tab's (services/main/run-view-composition.js): one helper process serves
 * both, and the run-view holder owns its life. services/run-view never requires services/computer-use.
 * The screen frame and pill (services/computer-use/turn-overlay.js) are created on a turn's first computer
 * call; the owner's program list is one store shared by the finder and Settings (computer-use-ipc-registration.js).
 */

const path = require('path');

/** Every process and program file of Jenny itself: the helper refuses input to any of them. */
function readJennyIdentity({ app, processRef = process }) {
  const pids = new Set([processRef.pid]);
  try {
    for (const metric of app.getAppMetrics?.() || []) {
      if (Number.isSafeInteger(metric?.pid) && metric.pid > 0) pids.add(metric.pid);
    }
  } catch (_error) { /* the main process alone is still denied */ }
  return { pids: [...pids], programs: [processRef.execPath] };
}

/** Start a program with no shell and no console; the child is not held by Jenny. */
function spawnDetached(file, args) {
  const { spawn } = require('child_process');
  const child = spawn(file, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

const PILL_DIR = path.join(__dirname, '..', '..', 'renderer', 'computer-pill');
const MAX_PILL_SPOTS = 16;

/** The pill's spot per display, in one small file; a bad read starts from the corners. */
function createPillSpots({ filePath, fs = require('fs'), log }) {
  let spots = null;
  function load() {
    if (spots) return spots;
    spots = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      for (const [id, spot] of Object.entries(data?.spots || {}).slice(0, MAX_PILL_SPOTS)) {
        if (Number.isFinite(spot?.x) && Number.isFinite(spot?.y)) spots.set(id, { x: Math.round(spot.x), y: Math.round(spot.y) });
      }
    } catch (_error) { /* no file yet, or unreadable: the corners */ }
    return spots;
  }
  return {
    get: (displayId) => load().get(displayId) || null,
    set(displayId, spot) {
      const map = load();
      map.delete(displayId);
      map.set(displayId, { x: Math.round(spot.x), y: Math.round(spot.y) });
      while (map.size > MAX_PILL_SPOTS) map.delete(map.keys().next().value);
      const { writeJsonAtomicAsync } = require('../backend/session-storage-fs-utils');
      writeJsonAtomicAsync(filePath, { schema_version: 1, spots: Object.fromEntries(map) })
        .catch(() => { try { log?.('WARN', 'computer_use.pill_spot_write_failed', {}); } catch (_error) { /* never throws */ } });
    },
  };
}

/** The pill's calls come only from the pill window's own top frame showing the pill page; built once. */
function createPillAuthorizer({ log = null } = {}) {
  const byPage = new Map(); // one authorizer per page; the window is looked up on every call
  let windowNow = () => null;
  return (event, getWindow, page) => {
    windowNow = typeof getWindow === 'function' ? getWindow : () => null;
    if (!byPage.has(page)) {
      const { createTrustedSenderAuthorizer } = require('./ipc-sender-authorization');
      byPage.set(page, createTrustedSenderAuthorizer({ getMainWindow: () => windowNow(), expectedDocumentPath: page, log }));
    }
    return byPage.get(page)(event, { methodPath: 'computer-pill' });
  };
}

function createLazyComputerUse({ getRunView, userDataPath, log, electron = null, processRef = process, createOverlay = null }) {
  let service = null;
  let programs = null;
  let overlay = null;
  let disposed = false;
  const turnListeners = new Set();
  const logger = { warn: (message) => { try { log?.('WARN', 'computer_use.warning', { message: String(message).slice(0, 120) }); } catch (_error) { /* logging never breaks a step */ } } };

  /** The owner's program list, one store for the finder and Settings. */
  function ownerPrograms() {
    if (!programs) {
      const { createOwnerPrograms } = require('../computer-use/owner-programs');
      programs = createOwnerPrograms({ filePath: path.join(userDataPath, 'computer-use-programs.json') });
    }
    return programs;
  }

  function overlayFor() {
    if (overlay) return overlay;
    if (createOverlay) { overlay = createOverlay({ service }); return overlay; }
    const { BrowserWindow, screen, ipcMain } = electron || require('electron');
    const { createTurnOverlay } = require('../computer-use/turn-overlay');
    const { t } = require('../i18n-main');
    overlay = createTurnOverlay({
      BrowserWindow, screen, ipcMain, t, log,
      pillPage: path.join(PILL_DIR, 'pill.html'),
      framePage: path.join(PILL_DIR, 'frame.html'),
      preload: path.join(__dirname, 'computer-pill-preload.js'),
      authorizeSender: createPillAuthorizer({ log }),
      onResume: (sessionId) => service.resume(sessionId),
      onStop: (sessionId) => service.stop(sessionId),
      stopKeyRegistered: () => service.stopChordRegistered(),
      positions: createPillSpots({ filePath: path.join(userDataPath, 'computer-use-pill.json'), log }),
    });
    return overlay;
  }

  // The service's turn state goes to the frame and pill, then to the bridge listeners (the chat, Settings).
  function onTurnState(state) {
    try {
      // Not before a program window is in front (no card-only first call opens the frame), nor for an idle turn.
      if (!disposed && (overlay || (state?.state !== 'idle' && state?.screenPoint))) overlayFor().update(state);
    } catch (_error) { logger.warn('overlay failed'); }
    for (const listener of [...turnListeners]) {
      try { listener(state); } catch (_error) { /* one listener never stops the others */ }
    }
  }

  function get() {
    if (service) return service;
    const { app, shell } = electron || require('electron');
    const { createComputerUseService } = require('../computer-use/computer-use-service');
    const { createProgramFinder } = require('../computer-use/program-finder');
    const { createStartApps, defaultRunPowerShell } = require('../computer-use/start-apps');
    const finder = createProgramFinder({
      ownerPrograms: ownerPrograms(),
      startApps: createStartApps({ runPowerShell: defaultRunPowerShell }),
      readShortcutLink: (lnkPath) => shell.readShortcutLink(lnkPath),
      openPath: (programPath) => shell.openPath(programPath),
      spawnDetached,
    });
    service = createComputerUseService({
      getHost: () => getRunView?.()?.helperHost?.() || null,
      finder,
      jennyIdentity: () => readJennyIdentity({ app, processRef }),
      logger,
      onTurnState,
    });
    return service;
  }

  return {
    get,
    // The service if it has started, else null: a turn end or a delete never starts it.
    peek: () => service,
    ownerPrograms,
    /** Turn states { sessionId, state, action, programName, screenPoint }; returns an unsubscribe. */
    subscribeTurnState(listener) {
      if (typeof listener !== 'function') return () => {};
      turnListeners.add(listener);
      return () => turnListeners.delete(listener);
    },
    async onTurnEnd(sessionId) {
      if (service) await service.onTurnEnd(sessionId);
    },
    async forgetChat(sessionId) {
      if (service) await service.forgetChat(sessionId);
    },
    // Before the Live tab's stage stops the shared helper: let go of everything and stop the watch.
    async dispose() {
      disposed = true;
      try { overlay?.dispose(); } catch (_error) { /* shutting down */ }
      overlay = null;
      if (service) await service.shutdown();
    },
  };
}

module.exports = { PILL_DIR, createLazyComputerUse, createPillAuthorizer, createPillSpots, readJennyIdentity };
