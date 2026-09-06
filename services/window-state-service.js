'use strict';

const fs = require('fs');
const path = require('path');

const WINDOW_STATE_VERSION = 1;
const WINDOW_STATE_FILENAME = 'window-state.json';
const DEFAULT_WINDOW_WIDTH = 1600;
const DEFAULT_WINDOW_HEIGHT = 930;
// Supported minimum desktop viewport (UIUX-004). Keep in sync with the
// BrowserWindow floor in services/main/main-window-composition.js and the
// narrow-layout CSS ladder (Chat collapses at 700, Logs at 980/760, Quick
// Settings at 560): the floor must sit below those breakpoints or they are
// unreachable, and it must fit a 1920px half snap (~960) and a 1024x600
// remote-desktop work area.
const MIN_WINDOW_WIDTH = 640;
const MIN_WINDOW_HEIGHT = 560;
const SAVE_DEBOUNCE_MS = 500;
const MIN_VISIBLE_AREA_RATIO = 0.2;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundInt(value, fallback = 0) {
  const number = finiteNumber(value);
  return number == null ? fallback : Math.round(number);
}

function positiveInt(value, fallback) {
  const number = finiteNumber(value);
  if (number == null || number <= 0) {
    return fallback;
  }
  return Math.round(number);
}

function normalizeRect(value, defaults = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaultX = roundInt(defaults.x, 0);
  const defaultY = roundInt(defaults.y, 0);
  const widthFallback = Object.prototype.hasOwnProperty.call(source, 'width')
    ? MIN_WINDOW_WIDTH
    : defaults.width || DEFAULT_WINDOW_WIDTH;
  const heightFallback = Object.prototype.hasOwnProperty.call(source, 'height')
    ? MIN_WINDOW_HEIGHT
    : defaults.height || DEFAULT_WINDOW_HEIGHT;
  const width = Math.max(positiveInt(source.width, widthFallback), MIN_WINDOW_WIDTH);
  const height = Math.max(positiveInt(source.height, heightFallback), MIN_WINDOW_HEIGHT);
  return {
    x: roundInt(source.x, defaultX),
    y: roundInt(source.y, defaultY),
    width,
    height,
  };
}

function rectArea(rect) {
  return Math.max(roundInt(rect?.width, 0), 0) * Math.max(roundInt(rect?.height, 0), 0);
}

function intersectionArea(left, right) {
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  return Math.max(x2 - x1, 0) * Math.max(y2 - y1, 0);
}

function displayWorkArea(display) {
  return normalizeRect(display?.workArea || display?.bounds, {
    x: 0,
    y: 0,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
  });
}

function displayId(display) {
  return Number.isFinite(Number(display?.id)) ? Math.trunc(Number(display.id)) : null;
}

function errorDetails(error) {
  return {
    name: String(error?.name || 'Error'),
    code: String(error?.code || 'unknown'),
  };
}

function getWindowStateSnapshot(windowRef) {
  if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) {
    return { ok: false, maximized: false, minimized: false };
  }
  return {
    ok: true,
    maximized: typeof windowRef.isMaximized === 'function' ? windowRef.isMaximized() === true : false,
    minimized: typeof windowRef.isMinimized === 'function' ? windowRef.isMinimized() === true : false,
  };
}

function fitSizeToWorkArea(bounds, workArea) {
  return {
    width: Math.min(Math.max(bounds.width, MIN_WINDOW_WIDTH), Math.max(workArea.width, MIN_WINDOW_WIDTH)),
    height: Math.min(Math.max(bounds.height, MIN_WINDOW_HEIGHT), Math.max(workArea.height, MIN_WINDOW_HEIGHT)),
  };
}

function centerInWorkArea(bounds, workArea) {
  const { width, height } = fitSizeToWorkArea(bounds, workArea);
  return {
    x: workArea.x + Math.max(Math.round((workArea.width - width) / 2), 0),
    y: workArea.y + Math.max(Math.round((workArea.height - height) / 2), 0),
    width,
    height,
  };
}

function clampToWorkArea(bounds, workArea) {
  const { width, height } = fitSizeToWorkArea(bounds, workArea);
  const maxX = workArea.x + Math.max(workArea.width - width, 0);
  const maxY = workArea.y + Math.max(workArea.height - height, 0);
  return {
    x: Math.min(Math.max(roundInt(bounds.x, workArea.x), workArea.x), maxX),
    y: Math.min(Math.max(roundInt(bounds.y, workArea.y), workArea.y), maxY),
    width,
    height,
  };
}

function findBestDisplay(bounds, displays, preferredDisplayId = null) {
  const displayList = Array.isArray(displays) ? displays : [];
  if (!displayList.length) {
    return null;
  }
  const preferred = preferredDisplayId != null
    ? displayList.find((display) => displayId(display) === preferredDisplayId)
    : null;
  if (preferred) {
    return preferred;
  }
  let best = displayList[0];
  let bestArea = -1;
  for (const display of displayList) {
    const area = intersectionArea(bounds, displayWorkArea(display));
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

function isUsableOnDisplays(bounds, displays) {
  const area = rectArea(bounds);
  if (area <= 0) {
    return false;
  }
  return (Array.isArray(displays) ? displays : []).some((display) => {
    const visible = intersectionArea(bounds, displayWorkArea(display));
    return visible / area >= MIN_VISIBLE_AREA_RATIO;
  });
}

function safeDisplays(screenRef) {
  try {
    const displays = screenRef && typeof screenRef.getAllDisplays === 'function'
      ? screenRef.getAllDisplays()
      : [];
    return Array.isArray(displays) && displays.length ? displays : [];
  } catch (_error) {
    return [];
  }
}

function safePrimaryDisplay(screenRef, displays) {
  try {
    if (screenRef && typeof screenRef.getPrimaryDisplay === 'function') {
      return screenRef.getPrimaryDisplay();
    }
  } catch (_error) {
    // Fall back to the first display below.
  }
  return Array.isArray(displays) && displays.length ? displays[0] : null;
}

class WindowStateService {
  constructor({
    userDataPath,
    screen,
    logger = null,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    nowProvider = () => new Date(),
    saveDebounceMs = SAVE_DEBOUNCE_MS,
  } = {}) {
    if (!userDataPath) {
      throw new Error('WindowStateService requires userDataPath.');
    }
    this.userDataPath = String(userDataPath);
    this.filePath = path.join(this.userDataPath, WINDOW_STATE_FILENAME);
    this.screen = screen || null;
    this.logger = typeof logger === 'function' ? logger : null;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    const debounceMs = Number(saveDebounceMs);
    this.saveDebounceMs = Number.isFinite(debounceMs) && debounceMs >= 0
      ? debounceMs
      : SAVE_DEBOUNCE_MS;
    this.saveTimer = null;
    this.lastState = this._readState();
    this.lastRestore = null;
    this._displayListenersAttached = false;
    this._suppressScheduledSave = false;
  }

  _log(level, event, details = {}) {
    if (!this.logger) {
      return;
    }
    this.logger(level, event, details);
  }

  _readState() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return null;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      this._log('WARN', 'window.state_repaired', {
        reason: 'read_failed',
        ...errorDetails(error),
      });
      return null;
    }
  }

  _writeState(state) {
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(this.userDataPath, { recursive: true });
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
      this.lastState = state;
      this._log('DEBUG', 'window.state_saved', {
        isMaximized: state.isMaximized === true,
        displayId: state.displayId,
      });
      return true;
    } catch (error) {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_cleanupError) {
        // The next successful write will replace the canonical state file.
      }
      this._log('WARN', 'window.state_save_failed', {
        ...errorDetails(error),
      });
      return false;
    }
  }

  _defaultBounds() {
    const displays = safeDisplays(this.screen);
    const primary = safePrimaryDisplay(this.screen, displays);
    const workArea = displayWorkArea(primary);
    return centerInWorkArea(
      { x: workArea.x, y: workArea.y, width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT },
      workArea
    );
  }

  _sanitizeSavedState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return null;
    }
    if (Number(state.version) !== WINDOW_STATE_VERSION) {
      return null;
    }
    const defaults = this._defaultBounds();
    const normalBounds = normalizeRect(state.normalBounds, defaults);
    return {
      version: WINDOW_STATE_VERSION,
      normalBounds,
      isMaximized: state.isMaximized === true,
      displayId: displayId({ id: state.displayId }),
      updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    };
  }

  getInitialWindowOptions() {
    const displays = safeDisplays(this.screen);
    const sanitized = this._sanitizeSavedState(this.lastState);
    let repaired = false;
    let bounds = sanitized?.normalBounds || this._defaultBounds();
    let isMaximized = sanitized?.isMaximized === true;
    if (!sanitized || !isUsableOnDisplays(bounds, displays)) {
      repaired = Boolean(this.lastState);
      bounds = this._defaultBounds();
      isMaximized = false;
    } else {
      const best = findBestDisplay(bounds, displays, sanitized.displayId);
      bounds = best ? clampToWorkArea(bounds, displayWorkArea(best)) : bounds;
    }
    if (repaired) {
      this._log('WARN', 'window.state_repaired', { reason: 'invalid_or_offscreen' });
    }
    this.lastRestore = { ...bounds, isMaximized };
    this._log('INFO', 'window.state_restored', {
      repaired,
      isMaximized,
      width: bounds.width,
      height: bounds.height,
    });
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized,
    };
  }

  getWindowState(windowRef) {
    return getWindowStateSnapshot(windowRef);
  }

  _stateFromBounds(normalBounds, isMaximized) {
    const bounds = normalizeRect(normalBounds, this.lastRestore || this._defaultBounds());
    const displays = safeDisplays(this.screen);
    const best = findBestDisplay(bounds, displays);
    const display = best || safePrimaryDisplay(this.screen, displays);
    const clampedBounds = best ? clampToWorkArea(bounds, displayWorkArea(best)) : bounds;
    return {
      version: WINDOW_STATE_VERSION,
      normalBounds: clampedBounds,
      isMaximized: isMaximized === true,
      displayId: displayId(display),
      updatedAt: this.nowProvider().toISOString(),
    };
  }

  _captureWindow(windowRef) {
    if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) {
      return null;
    }
    if (typeof windowRef.isMinimized === 'function' && windowRef.isMinimized()) {
      return null;
    }
    const isMaximized = typeof windowRef.isMaximized === 'function' && windowRef.isMaximized();
    const normalBounds =
      isMaximized && typeof windowRef.getNormalBounds === 'function'
        ? windowRef.getNormalBounds()
        : windowRef.getBounds();
    return this._stateFromBounds(normalBounds, isMaximized);
  }

  _captureRepairState(windowRef) {
    if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) {
      return null;
    }
    const isMaximized = typeof windowRef.isMaximized === 'function' && windowRef.isMaximized();
    const normalBounds = typeof windowRef.getNormalBounds === 'function'
      ? windowRef.getNormalBounds()
      : windowRef.getBounds();
    return this._stateFromBounds(normalBounds, isMaximized);
  }

  _clearSaveTimer() {
    if (this.saveTimer == null) {
      return;
    }
    this.clearTimeoutImpl(this.saveTimer);
    this.saveTimer = null;
  }

  scheduleSave(windowRef) {
    if (this._suppressScheduledSave) {
      return;
    }
    if (windowRef && typeof windowRef.isMinimized === 'function' && windowRef.isMinimized()) {
      return;
    }
    this._clearSaveTimer();
    this.saveTimer = this.setTimeoutImpl(() => {
      this.saveTimer = null;
      this.flush(windowRef);
    }, this.saveDebounceMs);
    if (typeof this.saveTimer?.unref === 'function') {
      this.saveTimer.unref();
    }
  }

  flush(windowRef) {
    this._clearSaveTimer();
    const state = this._captureWindow(windowRef);
    if (!state) {
      return false;
    }
    return this._writeState(state);
  }

  attach(windowRef) {
    if (!windowRef || typeof windowRef.on !== 'function') {
      throw new TypeError('WindowStateService.attach requires a BrowserWindow-like object.');
    }
    const schedule = () => this.scheduleSave(windowRef);
    const flush = () => this.flush(windowRef);
    windowRef.on('move', schedule);
    windowRef.on('resize', schedule);
    windowRef.on('maximize', flush);
    windowRef.on('unmaximize', flush);
    windowRef.on('close', flush);
    return () => {
      this._clearSaveTimer();
      if (typeof windowRef.removeListener === 'function') {
        windowRef.removeListener('move', schedule);
        windowRef.removeListener('resize', schedule);
        windowRef.removeListener('maximize', flush);
        windowRef.removeListener('unmaximize', flush);
        windowRef.removeListener('close', flush);
      }
    };
  }

  reclampWindow(windowRef) {
    if (!windowRef || (typeof windowRef.isDestroyed === 'function' && windowRef.isDestroyed())) {
      return false;
    }
    const isMinimized = typeof windowRef.isMinimized === 'function' && windowRef.isMinimized();
    const isMaximized = typeof windowRef.isMaximized === 'function' && windowRef.isMaximized();
    if (isMinimized || isMaximized) {
      const normalBounds = typeof windowRef.getNormalBounds === 'function'
        ? windowRef.getNormalBounds()
        : windowRef.getBounds();
      const normalizedBounds = normalizeRect(normalBounds, this.lastRestore || this._defaultBounds());
      if (isUsableOnDisplays(normalizedBounds, safeDisplays(this.screen))) {
        return false;
      }
      const repairState = this._captureRepairState(windowRef);
      if (!repairState) {
        return false;
      }
      const saved = this._writeState(repairState);
      if (saved) {
        this._log('WARN', 'window.display_reclamped', {
          width: repairState.normalBounds.width,
          height: repairState.normalBounds.height,
        });
      }
      return saved;
    }
    const bounds = normalizeRect(windowRef.getBounds(), this._defaultBounds());
    const displays = safeDisplays(this.screen);
    if (isUsableOnDisplays(bounds, displays)) {
      return false;
    }
    const targetDisplay = safePrimaryDisplay(this.screen, displays);
    const nextBounds = centerInWorkArea(bounds, displayWorkArea(targetDisplay));
    if (typeof windowRef.setBounds === 'function') {
      this._suppressScheduledSave = true;
      try {
        windowRef.setBounds(nextBounds);
      } finally {
        this._suppressScheduledSave = false;
      }
      const saved = this.flush(windowRef);
      if (saved) {
        this._log('WARN', 'window.display_reclamped', {
          width: nextBounds.width,
          height: nextBounds.height,
        });
      }
      return true;
    }
    return false;
  }

  attachDisplayListeners(getWindowRef) {
    if (this._displayListenersAttached || !this.screen || typeof this.screen.on !== 'function') {
      return () => {};
    }
    this._displayListenersAttached = true;
    const handleDisplayChange = () => {
      const windowRef = typeof getWindowRef === 'function' ? getWindowRef() : null;
      this.reclampWindow(windowRef);
    };
    this.screen.on('display-added', handleDisplayChange);
    this.screen.on('display-removed', handleDisplayChange);
    this.screen.on('display-metrics-changed', handleDisplayChange);
    return () => {
      if (typeof this.screen.removeListener === 'function') {
        this.screen.removeListener('display-added', handleDisplayChange);
        this.screen.removeListener('display-removed', handleDisplayChange);
        this.screen.removeListener('display-metrics-changed', handleDisplayChange);
      }
      this._displayListenersAttached = false;
    };
  }
}

module.exports = {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  getWindowStateSnapshot,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WINDOW_STATE_FILENAME,
  WINDOW_STATE_VERSION,
  WindowStateService,
};
