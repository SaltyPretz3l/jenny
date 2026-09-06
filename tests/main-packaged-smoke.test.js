const fs = require('fs');
const os = require('os');
const path = require('path');
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

function createElectronMock() {
  return {
    app: {
      getPath: () => path.join(process.cwd(), 'tmp'),
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
    ipcMain: { handle() {}, on() {}, removeListener() {} },
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

class FakeIpcMain {
  constructor() {
    this.listeners = new Map();
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) {
      this.listeners.delete(channel);
    }
  }

  emit(channel, event) {
    this.listeners.get(channel)?.(event);
  }
}

test('runtime shell config service receives the structured logger', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'main', 'runtime-service-composition.js'),
    'utf8'
  );
  assert.match(
    source,
    /new ShellConfigService\(\{[\s\S]*?logger:\s*log/,
  );
});

test('packaged smoke requests graceful shutdown after writing success output', () => {
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-packaged-smoke-unit-'));
  const outputPath = path.join(tempDir, 'result.json');
  const ipcMainRef = new FakeIpcMain();
  const sender = {};
  const exitCalls = [];
  const shutdownCalls = [];
  let quitCalls = 0;

  try {
    const controller = mainModule.createPackagedSmokeController({
      outputPath,
      timeoutMs: 60000,
      appRef: {
        exit(code) {
          exitCalls.push(code);
        },
        quit() {
          quitCalls += 1;
        },
      },
      requestShutdown(code) {
        shutdownCalls.push(code);
      },
      ipcMainRef,
      getWindow: () => ({
        isDestroyed: () => false,
        webContents: sender,
      }),
      getBackendStatus: () => ({ phase: 'starting' }),
      readyChannel: 'renderer-ready',
    });

    assert.ok(controller);
    ipcMainRef.emit('renderer-ready', { sender });
    controller.markBackendReady({
      phase: 'ready',
      launchSource: 'packaged-binary',
      packagedLaunchDetail: 'validated',
    });

    const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(payload.ok, true);
    assert.equal(payload.rendererReady, true);
    assert.equal(payload.launchSource, 'packaged-binary');
    assert.deepEqual(shutdownCalls, [0]);
    assert.deepEqual(exitCalls, []);
    assert.equal(quitCalls, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
