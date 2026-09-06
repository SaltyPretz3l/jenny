const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadWithElectronMock(modulePath, electronMock) {
  const resolvedPath = require.resolve(modulePath);
  const originalLoad = Module._load;
  delete require.cache[resolvedPath];
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return electronMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(resolvedPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolvedPath];
  }
}

class FakeEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(eventName, listener) {
    if (!this._listeners.has(eventName)) {
      this._listeners.set(eventName, []);
    }
    this._listeners.get(eventName).push(listener);
    return this;
  }

  once(eventName, listener) {
    const wrapped = (...args) => {
      this.removeListener(eventName, wrapped);
      listener(...args);
    };
    return this.on(eventName, wrapped);
  }

  removeListener(eventName, listener) {
    const listeners = this._listeners.get(eventName) || [];
    const filtered = listeners.filter((entry) => entry !== listener);
    if (filtered.length) {
      this._listeners.set(eventName, filtered);
    } else {
      this._listeners.delete(eventName);
    }
    return this;
  }

  emit(eventName, ...args) {
    const listeners = [...(this._listeners.get(eventName) || [])];
    for (const listener of listeners) {
      listener(...args);
    }
  }

  listenerCount(eventName) {
    return (this._listeners.get(eventName) || []).length;
  }
}

class FakeOverlayWindow extends FakeEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.hideCalls = 0;
    this.showCalls = 0;
    this.positionCalls = [];
    this.mouseEvents = [];
    this.contentProtectionCalls = [];
    this.loadedFiles = [];
    this.sentMessages = [];
    this.showInactiveCalls = 0;
    this.webContents = {
      send: (channel, payload) => {
        this.sentMessages.push({ channel, payload });
      },
    };
  }

  setIgnoreMouseEvents(enabled, config) {
    this.mouseEvents.push({ enabled, config });
  }

  loadFile(filePath) {
    this.loadedFiles.push(filePath);
  }

  setContentProtection(enabled) {
    this.contentProtectionCalls.push(enabled);
  }

  isDestroyed() {
    return this.destroyed;
  }

  setPosition(x, y) {
    this.positionCalls.push({ x, y });
  }

  hide() {
    this.hideCalls += 1;
  }

  show() {
    this.showCalls += 1;
  }

  showInactive() {
    this.showInactiveCalls += 1;
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.emit('closed');
  }
}

class FakeMainWindow extends FakeEmitter {
  constructor({ focused = true } = {}) {
    super();
    this.bounds = { x: 20, y: 40, width: 800, height: 600 };
    this.focused = focused;
  }

  getBounds() {
    return { ...this.bounds };
  }

  isFocused() {
    return this.focused;
  }
}

test('createCometOverlay disposes on owner-window close and cleans up exactly once', () => {
  const createdOverlays = [];
  const electronMock = {
    BrowserWindow: function BrowserWindow(options) {
      const overlay = new FakeOverlayWindow(options);
      createdOverlays.push(overlay);
      return overlay;
    },
  };
  const { createCometOverlay } = loadWithElectronMock('../overlay-window.js', electronMock);
  const mainWindow = new FakeMainWindow();
  let disposeCount = 0;

  const overlayRef = createCometOverlay(mainWindow, {
    onDispose: () => {
      disposeCount += 1;
    },
  });

  const overlay = createdOverlays[0];
  assert.ok(overlay, 'expected overlay window to be created');
  assert.equal(mainWindow.listenerCount('move'), 1);
  assert.equal(mainWindow.listenerCount('resize'), 1);
  assert.equal(mainWindow.listenerCount('focus'), 1);
  assert.equal(mainWindow.listenerCount('blur'), 1);
  assert.equal(mainWindow.listenerCount('closed'), 1);
  assert.deepEqual(overlay.positionCalls, [{ x: 680, y: 500 }]);

  mainWindow.emit('closed');

  assert.equal(overlay.isDestroyed(), true);
  assert.equal(disposeCount, 1);
  assert.equal(mainWindow.listenerCount('move'), 0);
  assert.equal(mainWindow.listenerCount('resize'), 0);
  assert.equal(mainWindow.listenerCount('focus'), 0);
  assert.equal(mainWindow.listenerCount('blur'), 0);
  assert.equal(mainWindow.listenerCount('closed'), 0);

  overlayRef.dispose();
  overlayRef.dispose();

  assert.equal(disposeCount, 1);
  assert.equal(mainWindow.listenerCount('closed'), 0);
});

test('createCometOverlay re-shows after owner blur without activating the app', () => {
  const createdOverlays = [];
  const electronMock = {
    BrowserWindow: function BrowserWindow(options) {
      const overlay = new FakeOverlayWindow(options);
      createdOverlays.push(overlay);
      return overlay;
    },
  };
  const { createCometOverlay } = loadWithElectronMock('../overlay-window.js', electronMock);
  const mainWindow = new FakeMainWindow();

  const overlayRef = createCometOverlay(mainWindow);
  const overlay = createdOverlays[0];

  assert.equal(overlay.options.show, false);
  assert.equal(overlay.showInactiveCalls, 0);
  mainWindow.emit('blur');

  assert.equal(overlay.showInactiveCalls, 1);
  assert.equal(overlay.showCalls, 0, 'owner blur must not activate Jenny');

  mainWindow.emit('focus');
  assert.equal(overlay.hideCalls, 1, 'owner focus must hide the overlay again');

  overlayRef.dispose();
});

test('createCometOverlay shows inactive immediately when the owner starts unfocused', () => {
  const createdOverlays = [];
  const electronMock = {
    BrowserWindow: function BrowserWindow(options) {
      const overlay = new FakeOverlayWindow(options);
      createdOverlays.push(overlay);
      return overlay;
    },
  };
  const { createCometOverlay } = loadWithElectronMock('../overlay-window.js', electronMock);
  const mainWindow = new FakeMainWindow({ focused: false });

  const overlayRef = createCometOverlay(mainWindow);
  const overlay = createdOverlays[0];

  assert.equal(overlay.options.show, false);
  assert.equal(overlay.showInactiveCalls, 1);
  assert.equal(overlay.showCalls, 0, 'initial visibility must not activate Jenny');

  overlayRef.dispose();
});

test('createCometOverlay still destroys the overlay when onDispose throws', () => {
  const createdOverlays = [];
  const electronMock = {
    BrowserWindow: function BrowserWindow(options) {
      const overlay = new FakeOverlayWindow(options);
      createdOverlays.push(overlay);
      return overlay;
    },
  };
  const { createCometOverlay } = loadWithElectronMock('../overlay-window.js', electronMock);
  const mainWindow = new FakeMainWindow();
  const overlayRef = createCometOverlay(mainWindow, {
    onDispose: () => {
      throw new Error('dispose callback failed');
    },
  });
  const overlay = createdOverlays[0];

  assert.throws(
    () => overlayRef.dispose(),
    /dispose callback failed/
  );
  assert.equal(overlay.isDestroyed(), true);
  assert.equal(mainWindow.listenerCount('move'), 0);
  assert.equal(mainWindow.listenerCount('resize'), 0);
  assert.equal(mainWindow.listenerCount('focus'), 0);
  assert.equal(mainWindow.listenerCount('blur'), 0);
  assert.equal(mainWindow.listenerCount('closed'), 0);
});
