'use strict';

/* services/computer-use/turn-overlay.js: the screen frame and the pill while Jenny has the mouse (row 196, C6).
 *
 * Two frameless, transparent, always-on-top windows on the screen of the granted window, from the first
 * `computer` call of a turn until the turn ends: a 3 px frame that takes no clicks, and the pill with what
 * Jenny is doing, Resume (while paused) and Stop. Both are excluded from every capture
 * (setContentProtection, WDA_EXCLUDEFROMCAPTURE on Windows 10 2004+), so they never appear in a step's
 * picture; the helper already refuses input to every Jenny window, so the model cannot press them.
 *
 * Electron comes in as arguments (the composition passes BrowserWindow, screen and ipcMain), so this module
 * loads nothing until a computer turn starts. The pill's calls carry no chat id: the overlay answers for the
 * chat it is showing, and only the pill window's own document may call. */

const PILL_STATE = 'computer-pill:state';
const PILL_RESUME = 'computer-pill:resume';
const PILL_STOP = 'computer-pill:stop';
const PILL_SIZE = 'computer-pill:size';
// The chord the helper registers, as the owner reads it: Ctrl+Alt+Shift+F12.
const STOP_KEY = require('./turn-watch').STOP_CHORD.split('+').map((part) => part[0].toUpperCase() + part.slice(1)).join('+');
const MARGIN = 16;
const PILL_DEFAULT = Object.freeze({ width: 300, height: 40 });
const PILL_LIMITS = Object.freeze({ minWidth: 120, maxWidth: 560, minHeight: 28, maxHeight: 64 });

const VERBS = Object.freeze({
  click: 'clicking', drag: 'clicking', move: 'clicking', scroll: 'clicking',
  type: 'typing', key: 'typing',
  screenshot: 'looking', wait: 'looking', windows: 'looking',
  open: 'opening', focus: 'opening',
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));

/**
 * What the pill shows for a turn state, in the owner's language.
 * @param {{ state: string, action?: string, programName?: string }} turn
 * @param {boolean|null} stopKeyRegistered null before the watch first started (shown as available)
 * @param {(key: string, english: string, params?: object) => string} t
 */
function pillView(turn, stopKeyRegistered, t) {
  const paused = turn.state === 'paused';
  const name = String(turn.programName || '').slice(0, 80);
  let text = t('computerUse.pill.thinking', 'Thinking');
  if (paused) text = t('computerUse.pill.paused', 'Paused: you have control');
  else if (turn.state === 'step' && name && VERBS[turn.action]) {
    const verb = VERBS[turn.action];
    if (verb === 'clicking') text = t('computerUse.pill.clicking', 'Clicking in {name}', { name });
    else if (verb === 'typing') text = t('computerUse.pill.typing', 'Typing in {name}', { name });
    else if (verb === 'looking') text = t('computerUse.pill.looking', 'Looking at {name}', { name });
    else text = t('computerUse.pill.opening', 'Opening {name}', { name });
  }
  return {
    paused,
    dot: paused ? 'warn' : 'active',
    text,
    keyHint: stopKeyRegistered === false ? t('computerUse.pill.noStopKey', 'Stop key not available: use Stop') : STOP_KEY,
    resumeLabel: t('computerUse.pill.resume', 'Resume'),
    stopLabel: t('computerUse.pill.stop', 'Stop'),
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.BrowserWindow Electron's BrowserWindow
 * @param {object} deps.screen Electron's screen
 * @param {object} deps.ipcMain Electron's ipcMain
 * @param {string} deps.pillPage path of renderer/computer-pill/pill.html
 * @param {string} deps.framePage path of renderer/computer-pill/frame.html
 * @param {string} deps.preload path of the pill's preload
 * @param {(event: object, getWindow: () => object|null, page: string) => boolean} deps.authorizeSender
 * @param {(sessionId: string) => unknown} deps.onResume
 * @param {(sessionId: string) => unknown} deps.onStop
 * @param {() => boolean|null} [deps.stopKeyRegistered]
 * @param {{ get: (displayId: string) => ({x: number, y: number}|null), set: (displayId: string, spot: {x: number, y: number}) => void }} [deps.positions]
 * @param {Function} [deps.t]
 * @param {Function} [deps.log]
 */
function createTurnOverlay({
  BrowserWindow, screen, ipcMain, pillPage, framePage, preload, authorizeSender, onResume, onStop,
  stopKeyRegistered = () => null, positions = null, t = (_key, english, params) => english.replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m)), log = () => {},
}) {
  let frame = null;
  let pill = null;
  let shown = null; // { sessionId, displayId, workArea, view }
  let handlersOn = false;
  let placing = false; // our own setBounds, not the owner's drag

  const alive = (win) => Boolean(win) && !win.isDestroyed();
  const warn = (event, error) => { try { log('WARN', event, { message: String(error?.message || error).slice(0, 160) }); } catch (_e) { /* never throws */ } };

  function send(win, view) {
    if (!alive(win)) return;
    try { win.webContents.send(PILL_STATE, view); } catch (error) { warn('computer_use.overlay_send_failed', error); }
  }

  function registerHandlers() {
    if (handlersOn) return;
    handlersOn = true;
    const fromPill = (event) => {
      try { return authorizeSender(event, () => (alive(pill) ? pill : null), pillPage) === true; } catch (_error) { return false; }
    };
    ipcMain.handle(PILL_RESUME, async (event) => {
      if (!fromPill(event) || !shown) return { ok: false };
      return onResume(shown.sessionId);
    });
    ipcMain.handle(PILL_STOP, async (event) => {
      if (!fromPill(event) || !shown) return { ok: false };
      return onStop(shown.sessionId);
    });
    ipcMain.handle(PILL_SIZE, async (event, size) => {
      if (!fromPill(event) || !alive(pill) || !shown) return { ok: false };
      const width = Number(size?.width);
      const height = Number(size?.height);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return { ok: false };
      resizePill(clamp(width, PILL_LIMITS.minWidth, PILL_LIMITS.maxWidth), clamp(height, PILL_LIMITS.minHeight, PILL_LIMITS.maxHeight));
      return { ok: true };
    });
  }

  function unregisterHandlers() {
    if (!handlersOn) return;
    handlersOn = false;
    for (const channel of [PILL_RESUME, PILL_STOP, PILL_SIZE]) {
      try { ipcMain.removeHandler(channel); } catch (_error) { /* already gone */ }
    }
  }

  function displayFor(point) {
    try {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return screen.getPrimaryDisplay();
      // The helper's window bounds are physical pixels; Electron places windows in DIPs (they differ per screen scale).
      const dip = typeof screen.screenToDipPoint === 'function' ? screen.screenToDipPoint(point) : point;
      return screen.getDisplayNearestPoint(dip);
    } catch (_error) {
      return null;
    }
  }

  /** The pill's spot on this display: the owner's saved spot if it still fits, else the top-right corner. */
  function pillSpot(display, width, height) {
    const area = display.workArea || display.bounds;
    const saved = positions?.get?.(String(display.id));
    const fits = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
      && saved.x >= 0 && saved.y >= 0 && saved.x + width <= area.width && saved.y + height <= area.height;
    const x = fits ? saved.x : area.width - width - MARGIN;
    const y = fits ? saved.y : MARGIN;
    return { x: area.x + x, y: area.y + y, width, height };
  }

  function place(win, bounds) {
    placing = true;
    try { win.setBounds(bounds); } finally { placing = false; }
  }

  // Keep the right edge where it was, so a longer text grows to the left and the pill stays in its corner.
  function resizePill(width, height) {
    const now = pill.getBounds();
    if (now.width === width && now.height === height) return;
    const area = shown.workArea;
    const right = now.x + now.width;
    const x = clamp(right - width, area.x, area.x + area.width - width);
    const y = clamp(now.y, area.y, area.y + area.height - height);
    place(pill, { x, y, width, height });
  }

  // Saved against the screen the pill now sits on, which the owner may have dragged it to.
  function saveSpot() {
    if (placing || !alive(pill) || !shown || !positions?.set) return;
    const bounds = pill.getBounds();
    try {
      const display = typeof screen.getDisplayMatching === 'function' ? screen.getDisplayMatching(bounds) : null;
      const id = display ? String(display.id) : shown.displayId;
      const area = display ? (display.workArea || display.bounds) : shown.workArea;
      positions.set(id, { x: bounds.x - area.x, y: bounds.y - area.y });
    } catch (error) { warn('computer_use.pill_spot_failed', error); }
  }

  function overlayWindow(options) {
    const win = new BrowserWindow({
      frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false,
      maximizable: false, fullscreenable: false, hasShadow: false, show: false, focusable: false,
      backgroundColor: '#00000000',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
      ...options,
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(true);
    win.setVisibleOnAllWorkspaces?.(true);
    // A link or a drop never turns an overlay into a browser.
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    win.webContents.on?.('will-navigate', (event) => event.preventDefault());
    return win;
  }

  function create(display) {
    registerHandlers();
    const bounds = display.bounds;
    frame = overlayWindow({ ...bounds, movable: false });
    frame.setIgnoreMouseEvents(true);
    const spot = pillSpot(display, PILL_DEFAULT.width, PILL_DEFAULT.height);
    pill = overlayWindow({ ...spot, movable: true });
    pill.on('moved', saveSpot);
    for (const [win, page] of [[frame, framePage], [pill, pillPage]]) {
      win.webContents.once?.('did-finish-load', () => { send(win, win === frame ? { paused: shown?.view?.paused === true } : shown?.view); if (alive(win)) win.showInactive(); });
      win.loadFile(page).catch((error) => warn('computer_use.overlay_load_failed', error));
    }
  }

  function moveTo(display) {
    place(frame, display.bounds);
    const now = pill.getBounds();
    place(pill, pillSpot(display, now.width, now.height));
  }

  function destroy() {
    for (const win of [frame, pill]) {
      if (alive(win)) { try { win.destroy(); } catch (_error) { /* already closing */ } }
    }
    frame = null;
    pill = null;
    shown = null;
  }

  /** A turn state from the service: { sessionId, state, action, programName, screenPoint }. */
  function update(turn) {
    if (!turn || typeof turn.sessionId !== 'string') return;
    if (turn.state === 'idle') {
      if (shown?.sessionId === turn.sessionId) destroy();
      return;
    }
    if (!['thinking', 'step', 'paused'].includes(turn.state)) return;
    if (shown && shown.sessionId !== turn.sessionId && alive(pill)) return; // one chat drives it until that turn ends
    const display = displayFor(turn.screenPoint);
    if (!display) return;
    const view = pillView(turn, safeRegistered(), t);
    const displayId = String(display.id);
    try {
      if (!alive(frame) || !alive(pill)) {
        destroy();
        shown = { sessionId: turn.sessionId, displayId, workArea: display.workArea || display.bounds, view };
        create(display);
        return;
      }
      if (shown.displayId !== displayId) moveTo(display);
      const pausedChanged = shown.view.paused !== view.paused;
      shown = { sessionId: turn.sessionId, displayId, workArea: display.workArea || display.bounds, view };
      if (pausedChanged) send(frame, { paused: view.paused }); // the frame draws only the colour
      send(pill, view);
    } catch (error) {
      warn('computer_use.overlay_failed', error);
      destroy();
    }
  }

  function safeRegistered() {
    try { return stopKeyRegistered(); } catch (_error) { return null; }
  }

  /** Shutdown: close both windows and take the pill's handlers away. */
  function dispose() {
    destroy();
    unregisterHandlers();
  }

  return { update, dispose, isShown: () => Boolean(shown) };
}

module.exports = { PILL_RESUME, PILL_SIZE, PILL_STATE, PILL_STOP, STOP_KEY, createTurnOverlay, pillView };
