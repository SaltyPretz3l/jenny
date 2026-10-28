'use strict';

// Shared fixtures for the window-state service and writer tests.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { WINDOW_STATE_FILENAME } = require('../../services/window-state-service');
const { createTrackedTempDir } = require('./resource-cleanup');

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

module.exports = {
  FakeWindow,
  createScreen,
  createTimers,
  readState,
  tempUserData,
  writeState,
};
