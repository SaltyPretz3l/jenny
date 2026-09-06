'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WINDOW_STATE_FILENAME,
  WINDOW_STATE_VERSION,
  WindowStateService,
} = require('../services/window-state-service');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

function tempUserData() {
  // Tracked, not a bare mkdtempSync: each of this file's cases makes its own
  // userData root, and the helper's process hooks only fire on signals and
  // uncaught exceptions, never on a clean exit. Untracked, a full run left one
  // jenny-window-state-* directory per case behind in the OS temp dir forever.
  return createTrackedTempDir('jenny-window-state-');
}

function readState(userDataPath) {
  return JSON.parse(fs.readFileSync(path.join(userDataPath, WINDOW_STATE_FILENAME), 'utf8'));
}

function writeState(userDataPath, payload) {
  fs.writeFileSync(path.join(userDataPath, WINDOW_STATE_FILENAME), JSON.stringify(payload, null, 2));
}

function createScreen(displays = null) {
  const screen = new EventEmitter();
  let activeDisplays = displays || [
    {
      id: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    },
  ];
  screen.getAllDisplays = () => activeDisplays;
  screen.getPrimaryDisplay = () => activeDisplays[0];
  screen.setDisplays = (nextDisplays) => {
    activeDisplays = nextDisplays;
  };
  return screen;
}

function createTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    runAll() {
      for (const id of [...timers.keys()]) {
        const timer = timers.get(id);
        timers.delete(id);
        timer.callback();
      }
    },
    count() {
      return timers.size;
    },
  };
}

class FakeWindow extends EventEmitter {
  constructor(bounds = { x: 10, y: 20, width: 1300, height: 800 }) {
    super();
    this._bounds = { ...bounds };
    this._normalBounds = { ...bounds };
    this._maximized = false;
    this._minimized = false;
    this._destroyed = false;
    this.setBoundsCalls = [];
  }

  getBounds() {
    return { ...this._bounds };
  }

  getNormalBounds() {
    return { ...this._normalBounds };
  }

  setBounds(bounds) {
    this.setBoundsCalls.push({ ...bounds });
    this._bounds = { ...this._bounds, ...bounds };
    if (!this._maximized) {
      this._normalBounds = { ...this._bounds };
    }
  }

  isMaximized() {
    return this._maximized;
  }

  isMinimized() {
    return this._minimized;
  }

  isDestroyed() {
    return this._destroyed;
  }

  maximize() {
    this._maximized = true;
    this.emit('maximize');
  }

  unmaximize() {
    this._maximized = false;
    this.emit('unmaximize');
  }

  minimize() {
    this._minimized = true;
  }

  restore() {
    this._minimized = false;
  }

  close() {
    this.emit('close');
    this._destroyed = true;
    this.emit('closed');
  }
}

// UIUX-004: the window floor must fit the audit's constrained targets — a
// 1024x600 remote-desktop work area and a 1920px-display half snap (~960
// device-independent px). The old 1180x720 floor clamped both upward past
// the available work area.
test('a 1024x600 work area holds the window without upward clamping past it', () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: WINDOW_STATE_VERSION,
    normalBounds: { x: 0, y: 0, width: 900, height: 580 },
    isMaximized: false,
    displayId: 7,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const screen = createScreen([
    {
      id: 7,
      bounds: { x: 0, y: 0, width: 1024, height: 620 },
      workArea: { x: 0, y: 0, width: 1024, height: 600 },
    },
  ]);
  const service = new WindowStateService({ userDataPath, screen });

  const options = service.getInitialWindowOptions();
  assert.ok(
    options.width <= 1024,
    `restored width must fit the 1024px work area (got ${options.width})`
  );
  assert.ok(
    options.height <= 600,
    `restored height must fit the 600px work area (got ${options.height})`
  );
});

test('a half-snap-sized window (~960px) is not clamped back up by the floor', () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: WINDOW_STATE_VERSION,
    normalBounds: { x: 0, y: 0, width: 960, height: 1040 },
    isMaximized: false,
    displayId: 1,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const service = new WindowStateService({ userDataPath, screen: createScreen() });

  const options = service.getInitialWindowOptions();
  assert.equal(
    options.width,
    960,
    'a persisted 960px half-snap width must survive restore untouched'
  );
});

test('restores valid normal bounds from persisted state', () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: WINDOW_STATE_VERSION,
    normalBounds: { x: 120, y: 80, width: 1400, height: 860 },
    isMaximized: false,
    displayId: 1,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const service = new WindowStateService({ userDataPath, screen: createScreen() });

  assert.deepEqual(service.getInitialWindowOptions(), {
    x: 120,
    y: 80,
    width: 1400,
    height: 860,
    isMaximized: false,
  });
});

test('restores maximized state while preserving normal bounds for unmaximize', () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: WINDOW_STATE_VERSION,
    normalBounds: { x: 240, y: 90, width: 1500, height: 900 },
    isMaximized: true,
    isMinimized: true,
    displayId: 1,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const service = new WindowStateService({ userDataPath, screen: createScreen() });

  assert.deepEqual(service.getInitialWindowOptions(), {
    x: 240,
    y: 90,
    width: 1500,
    height: 900,
    isMaximized: true,
  });
});

test('repairs off-screen bounds to a centered default on the primary display', () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: WINDOW_STATE_VERSION,
    normalBounds: { x: 9000, y: 7000, width: 1400, height: 900 },
    isMaximized: false,
    displayId: 99,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const service = new WindowStateService({ userDataPath, screen: createScreen() });

  assert.deepEqual(service.getInitialWindowOptions(), {
    x: 160,
    y: 55,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    isMaximized: false,
  });
});

test('clamps malformed, fractional, and undersized bounds without throwing', () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: WINDOW_STATE_VERSION,
    normalBounds: { x: 12.8, y: -20.4, width: 200, height: 'bad' },
    isMaximized: false,
    displayId: 1,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const service = new WindowStateService({ userDataPath, screen: createScreen() });

  assert.deepEqual(service.getInitialWindowOptions(), {
    x: 13,
    y: 0,
    width: MIN_WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT,
    isMaximized: false,
  });
});

test('corrupt state files fall back to defaults and log repair', () => {
  const userDataPath = tempUserData();
  fs.writeFileSync(path.join(userDataPath, WINDOW_STATE_FILENAME), '{bad-json', 'utf8');
  const logs = [];
  const service = new WindowStateService({
    userDataPath,
    screen: createScreen(),
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.equal(service.getInitialWindowOptions().width, DEFAULT_WINDOW_WIDTH);
  assert.equal(service.getInitialWindowOptions().height, DEFAULT_WINDOW_HEIGHT);
  assert.equal(logs.some((entry) => entry.event === 'window.state_repaired'), true);
});

test('unknown state schema versions are repaired instead of restored', () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: 999,
    normalBounds: { x: 120, y: 80, width: 1400, height: 860 },
    isMaximized: true,
    displayId: 1,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const logs = [];
  const service = new WindowStateService({
    userDataPath,
    screen: createScreen(),
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.deepEqual(service.getInitialWindowOptions(), {
    x: 160,
    y: 55,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    isMaximized: false,
  });
  assert.equal(logs.some((entry) => entry.event === 'window.state_repaired'), true);
});

test('state save failures log bounded diagnostics without local paths', () => {
  const userDataPath = tempUserData();
  const occupiedPath = path.join(userDataPath, 'occupied');
  fs.writeFileSync(occupiedPath, 'not a directory', 'utf8');
  const logs = [];
  const service = new WindowStateService({
    userDataPath: occupiedPath,
    screen: createScreen(),
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  const windowRef = new FakeWindow({ x: 44, y: 55, width: 1280, height: 760 });

  assert.equal(service.flush(windowRef), false);
  const saveFailure = logs.find((entry) => entry.event === 'window.state_save_failed');
  assert.ok(saveFailure);
  assert.equal(JSON.stringify(saveFailure.details).includes(occupiedPath), false);
});

test('debounces move and resize saves and flushes on close', () => {
  const userDataPath = tempUserData();
  const timers = createTimers();
  const service = new WindowStateService({
    userDataPath,
    screen: createScreen(),
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });
  const windowRef = new FakeWindow({ x: 44, y: 55, width: 1280, height: 760 });

  service.attach(windowRef);
  windowRef.emit('move');
  windowRef.emit('resize');
  assert.equal(timers.count(), 1);

  windowRef.close();
  assert.equal(timers.count(), 0);
  assert.deepEqual(readState(userDataPath).normalBounds, {
    x: 44,
    y: 55,
    width: 1280,
    height: 760,
  });
});

test('skips persistence while minimized and keeps the prior visible state', () => {
  const userDataPath = tempUserData();
  writeState(userDataPath, {
    version: WINDOW_STATE_VERSION,
    normalBounds: { x: 88, y: 99, width: 1320, height: 780 },
    isMaximized: false,
    displayId: 1,
    updatedAt: '2026-05-23T12:00:00.000Z',
  });
  const service = new WindowStateService({ userDataPath, screen: createScreen() });
  const windowRef = new FakeWindow({ x: 11, y: 22, width: 1180, height: 720 });

  service.attach(windowRef);
  windowRef.minimize();
  windowRef.emit('resize');
  service.flush(windowRef);

  assert.deepEqual(readState(userDataPath).normalBounds, {
    x: 88,
    y: 99,
    width: 1320,
    height: 780,
  });
});

test('reclamps visible windows after display changes', () => {
  const userDataPath = tempUserData();
  const screen = createScreen();
  const logs = [];
  const service = new WindowStateService({
    userDataPath,
    screen,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  const windowRef = new FakeWindow({ x: 5000, y: 100, width: 1300, height: 780 });

  service.attachDisplayListeners(() => windowRef);
  screen.emit('display-removed');

  assert.deepEqual(windowRef.setBoundsCalls[0], {
    x: 310,
    y: 130,
    width: 1300,
    height: 780,
  });
  assert.equal(logs.some((entry) => entry.event === 'window.display_reclamped'), true);
});

test('display changes repair maximized normal bounds without moving the visible window', () => {
  const userDataPath = tempUserData();
  const screen = createScreen();
  const service = new WindowStateService({ userDataPath, screen });
  const windowRef = new FakeWindow({ x: 0, y: 0, width: 1920, height: 1040 });
  windowRef._maximized = true;
  windowRef._normalBounds = { x: 5000, y: 100, width: 1300, height: 780 };

  assert.equal(service.reclampWindow(windowRef), true);

  assert.equal(windowRef.setBoundsCalls.length, 0);
  assert.deepEqual(readState(userDataPath).normalBounds, {
    x: 620,
    y: 100,
    width: 1300,
    height: 780,
  });
  assert.equal(readState(userDataPath).isMaximized, true);
});
