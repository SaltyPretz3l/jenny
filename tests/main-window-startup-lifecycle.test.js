const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getBridgeChannel } = require('../services/ipc-contract');

// main.js claims the desktop profile under userData at load: keep that marker out of the repo.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-startup-lifecycle-userdata-'));
test.after(() => fs.rmSync(USER_DATA, { recursive: true, force: true }));

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

function createElectronMock() {
  return {
    app: {
      getPath: () => USER_DATA,
      // Real Electron has setPath, and main.js calls it when JENNY_USER_DATA_DIR
      // is set -- which dev:agent, smoke:gui and capture-ui all export. getPath
      // stays fixed on purpose: nothing here tests profile overriding.
      setPath() {},
      whenReady: () => ({ then() {} }),
      on() {},
      quit() {},
      exit() {},
      setAppUserModelId() {},
    },
    BrowserWindow: {
      getAllWindows: () => [],
    },
    clipboard: { writeText() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: {
      handle() {},
      on() {},
      removeListener() {},
    },
    nativeImage: {},
    powerMonitor: { on() {}, removeListener() {} },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(String(value || ''), 'utf8'),
      decryptString: (buffer) => Buffer.from(buffer).toString('utf8'),
    },
    shell: { openPath() {}, showItemInFolder() {} },
  };
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
    wrapped._original = listener;
    return this.on(eventName, wrapped);
  }

  removeListener(eventName, listener) {
    const listeners = this._listeners.get(eventName) || [];
    const filtered = listeners.filter((entry) => entry !== listener && entry._original !== listener);
    if (filtered.length) {
      this._listeners.set(eventName, filtered);
    } else {
      this._listeners.delete(eventName);
    }
    return this;
  }

  emit(eventName, ...args) {
    const listeners = [...(this._listeners.get(eventName) || [])];
    listeners.forEach((listener) => listener(...args));
  }

  listenerCount(eventName) {
    return (this._listeners.get(eventName) || []).length;
  }
}

function createFakeTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimeout(callback, ms) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
    run(id) {
      const timer = scheduled.get(id);
      if (!timer) {
        return false;
      }
      scheduled.delete(id);
      timer.callback();
      return true;
    },
    runAll() {
      for (const id of [...scheduled.keys()]) {
        this.run(id);
      }
    },
    count() {
      return scheduled.size;
    },
  };
}

function createFakeWindow(id) {
  const windowRef = new FakeEmitter();
  let visible = false;
  let destroyed = false;
  windowRef.id = id;
  windowRef.showCalls = 0;
  windowRef.showInactiveCalls = 0;
  windowRef.webContents = new FakeEmitter();
  windowRef.isDestroyed = () => destroyed;
  windowRef.isVisible = () => visible;
  windowRef.show = () => {
    visible = true;
    windowRef.showCalls += 1;
  };
  windowRef.showInactive = () => {
    visible = true;
    windowRef.showInactiveCalls += 1;
  };
  windowRef.getBounds = () => ({ width: 1600, height: 930 });
  windowRef.close = () => {
    destroyed = true;
    windowRef.emit('closed');
  };
  return windowRef;
}

test('startup lifecycle clears the reveal timeout and renderer-ready listener when the window closes', () => {
  const { createMainWindowStartupLifecycle } = loadWithElectronMock('../main.js', createElectronMock());
  const readyChannel = getBridgeChannel('lifecycle.signalReady', 'send');
  const timers = createFakeTimers();
  const ipcMain = new FakeEmitter();
  const windowRef = createFakeWindow('window-1');
  const readyEvents = [];
  let closedWindow = null;

  createMainWindowStartupLifecycle({
    windowRef,
    ipcMainRef: ipcMain,
    readyChannel,
    setTimeoutImpl: timers.setTimeout.bind(timers),
    clearTimeoutImpl: timers.clearTimeout.bind(timers),
    logReady: (source, activeWindow) => readyEvents.push({ source, id: activeWindow.id }),
    logLoadFailure() {},
    onWindowClosed: (activeWindow) => {
      closedWindow = activeWindow;
    },
  });

  assert.equal(timers.count(), 1);
  assert.equal(ipcMain.listenerCount(readyChannel), 1);

  windowRef.close();

  assert.equal(closedWindow, windowRef);
  assert.equal(timers.count(), 0);
  assert.equal(ipcMain.listenerCount(readyChannel), 0);

  timers.runAll();
  assert.deepEqual(readyEvents, []);
});

test('revealInactive shows the window without activating it (no focus steal)', () => {
  const { createMainWindowStartupLifecycle } = loadWithElectronMock('../main.js', createElectronMock());
  const readyChannel = getBridgeChannel('lifecycle.signalReady', 'send');
  const timers = createFakeTimers();
  const ipcMain = new FakeEmitter();
  const windowRef = createFakeWindow('window-inactive');

  createMainWindowStartupLifecycle({
    windowRef,
    ipcMainRef: ipcMain,
    readyChannel,
    revealInactive: true,
    setTimeoutImpl: timers.setTimeout.bind(timers),
    clearTimeoutImpl: timers.clearTimeout.bind(timers),
    logReady() {},
    logLoadFailure() {},
    onWindowClosed() {},
  });

  windowRef.emit('ready-to-show');
  ipcMain.emit(readyChannel, { sender: windowRef.webContents });

  assert.equal(windowRef.showInactiveCalls, 1, 'revealed via showInactive');
  assert.equal(windowRef.showCalls, 0, 'never called the focus-stealing show()');
});

test('default (revealInactive false) reveals via show(), not showInactive', () => {
  const { createMainWindowStartupLifecycle } = loadWithElectronMock('../main.js', createElectronMock());
  const readyChannel = getBridgeChannel('lifecycle.signalReady', 'send');
  const timers = createFakeTimers();
  const ipcMain = new FakeEmitter();
  const windowRef = createFakeWindow('window-active');

  createMainWindowStartupLifecycle({
    windowRef,
    ipcMainRef: ipcMain,
    readyChannel,
    setTimeoutImpl: timers.setTimeout.bind(timers),
    clearTimeoutImpl: timers.clearTimeout.bind(timers),
    logReady() {},
    logLoadFailure() {},
    onWindowClosed() {},
  });

  windowRef.emit('ready-to-show');
  ipcMain.emit(readyChannel, { sender: windowRef.webContents });

  assert.equal(windowRef.showCalls, 1, 'revealed via show() by default');
  assert.equal(windowRef.showInactiveCalls, 0, 'showInactive not used by default');
});

test('stale startup callbacks do not reveal or log against a replacement window', () => {
  const { createMainWindowStartupLifecycle } = loadWithElectronMock('../main.js', createElectronMock());
  const readyChannel = getBridgeChannel('lifecycle.signalReady', 'send');
  const timers = createFakeTimers();
  const ipcMain = new FakeEmitter();
  const readyEvents = [];
  const oldWindow = createFakeWindow('window-old');
  const newWindow = createFakeWindow('window-new');

  createMainWindowStartupLifecycle({
    windowRef: oldWindow,
    ipcMainRef: ipcMain,
    readyChannel,
    setTimeoutImpl: timers.setTimeout.bind(timers),
    clearTimeoutImpl: timers.clearTimeout.bind(timers),
    logReady: (source, activeWindow) => readyEvents.push({ source, id: activeWindow.id }),
    logLoadFailure() {},
    onWindowClosed() {},
  });

  oldWindow.close();
  assert.equal(timers.count(), 0);
  assert.equal(ipcMain.listenerCount(readyChannel), 0);

  createMainWindowStartupLifecycle({
    windowRef: newWindow,
    ipcMainRef: ipcMain,
    readyChannel,
    setTimeoutImpl: timers.setTimeout.bind(timers),
    clearTimeoutImpl: timers.clearTimeout.bind(timers),
    logReady: (source, activeWindow) => readyEvents.push({ source, id: activeWindow.id }),
    logLoadFailure() {},
    onWindowClosed() {},
  });

  assert.equal(timers.count(), 1);
  assert.equal(ipcMain.listenerCount(readyChannel), 1);

  ipcMain.emit(readyChannel, { sender: oldWindow.webContents });
  assert.deepEqual(readyEvents, []);

  newWindow.emit('ready-to-show');
  ipcMain.emit(readyChannel, { sender: newWindow.webContents });

  assert.deepEqual(readyEvents, [{
    source: 'ready-to-show',
    id: 'window-new',
  }]);
  assert.equal(newWindow.showCalls, 1);
  assert.equal(oldWindow.showCalls, 0);
  assert.equal(timers.count(), 0);
  assert.equal(ipcMain.listenerCount(readyChannel), 0);
});

test('the window reveals at its first paint without waiting for the renderer ready signal', () => {
  const { createMainWindowStartupLifecycle } = loadWithElectronMock('../main.js', createElectronMock());
  const readyChannel = getBridgeChannel('lifecycle.signalReady', 'send');
  const timers = createFakeTimers();
  const ipcMain = new FakeEmitter();
  const windowRef = createFakeWindow('window-first-paint');
  const readyEvents = [];

  createMainWindowStartupLifecycle({
    windowRef,
    ipcMainRef: ipcMain,
    readyChannel,
    setTimeoutImpl: timers.setTimeout.bind(timers),
    clearTimeoutImpl: timers.clearTimeout.bind(timers),
    logReady: (source, activeWindow) => readyEvents.push({ source, id: activeWindow.id }),
    logLoadFailure() {},
    onWindowClosed() {},
  });

  // Red before 2026-10-19: ready-to-show alone left the window hidden until
  // the renderer's ready signal (every script plus the first full render).
  windowRef.emit('ready-to-show');
  assert.equal(windowRef.showCalls, 1, 'shown at first paint');
  assert.deepEqual(readyEvents, [{ source: 'ready-to-show', id: 'window-first-paint' }]);
  assert.equal(timers.count(), 0, 'the reveal backstop is cleared');
  assert.equal(ipcMain.listenerCount(readyChannel), 0, 'the ready listener is detached');

  ipcMain.emit(readyChannel, { sender: windowRef.webContents });
  windowRef.webContents.emit('did-finish-load');
  assert.equal(windowRef.showCalls, 1, 'later load signals never reveal twice');
  assert.equal(readyEvents.length, 1);
});

test('a renderer ready signal before any paint does not reveal an unpainted window', () => {
  const { createMainWindowStartupLifecycle } = loadWithElectronMock('../main.js', createElectronMock());
  const readyChannel = getBridgeChannel('lifecycle.signalReady', 'send');
  const timers = createFakeTimers();
  const ipcMain = new FakeEmitter();
  const windowRef = createFakeWindow('window-unpainted');

  createMainWindowStartupLifecycle({
    windowRef,
    ipcMainRef: ipcMain,
    readyChannel,
    setTimeoutImpl: timers.setTimeout.bind(timers),
    clearTimeoutImpl: timers.clearTimeout.bind(timers),
    logReady() {},
    logLoadFailure() {},
    onWindowClosed() {},
  });

  ipcMain.emit(readyChannel, { sender: windowRef.webContents });
  assert.equal(windowRef.showCalls, 0);
  windowRef.webContents.emit('did-finish-load');
  assert.equal(windowRef.showCalls, 1, 'the load completing reveals it');
});

test('a saved maximized state is restored at reveal, never before first paint', () => {
  const { createMainWindowStartupLifecycle } = loadWithElectronMock('../main.js', createElectronMock());
  const readyChannel = getBridgeChannel('lifecycle.signalReady', 'send');
  const timers = createFakeTimers();
  const ipcMain = new FakeEmitter();
  const windowRef = createFakeWindow('window-maximized');
  let maximizeCalls = 0;
  let focusCalls = 0;
  windowRef.maximize = () => { maximizeCalls += 1; windowRef.showInactive(); windowRef.showInactiveCalls -= 1; };
  windowRef.focus = () => { focusCalls += 1; };

  createMainWindowStartupLifecycle({
    windowRef,
    ipcMainRef: ipcMain,
    readyChannel,
    revealMaximized: true,
    setTimeoutImpl: timers.setTimeout.bind(timers),
    clearTimeoutImpl: timers.clearTimeout.bind(timers),
    logReady() {},
    logLoadFailure() {},
    onWindowClosed() {},
  });
  assert.equal(maximizeCalls, 0, 'maximize() shows a hidden window, so it waits for the first paint');

  windowRef.emit('ready-to-show');
  windowRef.webContents.emit('did-finish-load');

  assert.equal(maximizeCalls, 1, 'maximized once, at reveal');
  assert.equal(focusCalls, 1, 'an active reveal focuses the window maximize() showed');
  assert.equal(windowRef.showCalls, 0, 'maximize() replaces show()');
});
