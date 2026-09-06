// Tests for services/main/packaged-smoke.js — plain require, no Electron mock needed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS,
  parsePackagedSmokeCliArgs,
  resolvePackagedSmokeConfig,
  shouldBypassSingleInstanceForPackagedSmoke,
  shouldUsePackagedSidecarRuntime,
  createPackagedSmokeController,
} = require('../services/main/packaged-smoke');

// ---------------------------------------------------------------------------
// FakeIpcMain — mirrors tests/main-packaged-smoke.test.js lines 53-71.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS is a concrete numeric constant.
// ---------------------------------------------------------------------------
test('DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS is 45000', () => {
  assert.equal(DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS, 45_000);
});

test('packaged smoke bypasses the singleton only for a consumed request file', () => {
  assert.equal(shouldBypassSingleInstanceForPackagedSmoke({
    outputPath: 'C:/tmp/result.json',
    requestPath: 'C:/app/packaged-smoke-request.json',
  }), true);
  assert.equal(shouldBypassSingleInstanceForPackagedSmoke({
    outputPath: 'C:/tmp/result.json',
    requestPath: '',
  }), false);
  assert.equal(shouldBypassSingleInstanceForPackagedSmoke({
    outputPath: '',
    requestPath: 'C:/app/packaged-smoke-request.json',
  }), false);
});

// ---------------------------------------------------------------------------
// parsePackagedSmokeCliArgs
// ---------------------------------------------------------------------------
test('parsePackagedSmokeCliArgs parses output and timeout flags', () => {
  const result = parsePackagedSmokeCliArgs([
    '--packaged-smoke-output=C:/tmp/r.json',
    '--packaged-smoke-timeout-ms=5000',
  ]);
  assert.deepEqual(result, { outputPath: 'C:/tmp/r.json', timeoutMs: '5000' });
});

test('parsePackagedSmokeCliArgs ignores unknown args and leaves fields empty', () => {
  const result = parsePackagedSmokeCliArgs(['--unrelated-flag=value', '--also-junk']);
  assert.deepEqual(result, { outputPath: '', timeoutMs: '' });
});

test('parsePackagedSmokeCliArgs handles empty array', () => {
  const result = parsePackagedSmokeCliArgs([]);
  assert.deepEqual(result, { outputPath: '', timeoutMs: '' });
});

// ---------------------------------------------------------------------------
// resolvePackagedSmokeConfig — env vars win over argv.
// ---------------------------------------------------------------------------
test('resolvePackagedSmokeConfig: env vars win over argv', () => {
  const result = resolvePackagedSmokeConfig({
    argv: ['--packaged-smoke-output=C:/argv/out.json', '--packaged-smoke-timeout-ms=3000'],
    env: {
      JENNY_PACKAGED_SMOKE_OUTPUT: '/o',
      JENNY_PACKAGED_SMOKE_TIMEOUT_MS: '9',
    },
    execPath: '',
  });
  assert.equal(result.outputPath, '/o');
  assert.equal(result.timeoutMs, '9');
});

test('resolvePackagedSmokeConfig: argv values win when env is empty', () => {
  const result = resolvePackagedSmokeConfig({
    argv: ['--packaged-smoke-output=C:/argv/out2.json', '--packaged-smoke-timeout-ms=7777'],
    env: {},
    execPath: '',
  });
  assert.equal(result.outputPath, 'C:/argv/out2.json');
  assert.equal(result.timeoutMs, '7777');
});

// ---------------------------------------------------------------------------
// shouldUsePackagedSidecarRuntime
// ---------------------------------------------------------------------------
test('shouldUsePackagedSidecarRuntime: true when app.isPackaged === true', () => {
  const result = shouldUsePackagedSidecarRuntime({ appRef: { isPackaged: true } });
  assert.equal(result, true);
});

test('shouldUsePackagedSidecarRuntime: false when not packaged and sidecar manifest missing', () => {
  const result = shouldUsePackagedSidecarRuntime({
    appRef: { isPackaged: false },
    resourcesPath: 'C:/definitely/not/here',
  });
  assert.equal(result, false);
});

// ---------------------------------------------------------------------------
// createPackagedSmokeController — null when outputPath is empty.
// ---------------------------------------------------------------------------
test('createPackagedSmokeController returns null for empty outputPath', () => {
  const controller = createPackagedSmokeController({ outputPath: '' });
  assert.equal(controller, null);
});

test('createPackagedSmokeController returns null for whitespace-only outputPath', () => {
  const controller = createPackagedSmokeController({ outputPath: '   ' });
  assert.equal(controller, null);
});

// ---------------------------------------------------------------------------
// createPackagedSmokeController — success path.
// ---------------------------------------------------------------------------
test('packaged smoke controller writes success JSON and requests graceful shutdown', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-packaged-smoke-unit-'));
  const savedExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = savedExitCode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const outputPath = path.join(tempDir, 'result.json');
  const ipcMainRef = new FakeIpcMain();
  const sender = {};
  const exitCalls = [];
  const shutdownCalls = [];
  let quitCalls = 0;

  const controller = createPackagedSmokeController({
    outputPath,
    timeoutMs: 60_000,
    appRef: {
      exit(code) { exitCalls.push(code); },
      quit() { quitCalls += 1; },
    },
    requestShutdown(code) { shutdownCalls.push(code); },
    ipcMainRef,
    getWindow: () => ({ isDestroyed: () => false, webContents: sender }),
    getBackendStatus: () => ({ phase: 'starting' }),
    readyChannel: 'renderer-ready',
  });

  // controller must not be null — output path is set
  assert.notEqual(controller, null);

  // emit renderer-ready first, then mark backend ready
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

  // listener must be cleaned up after completion
  assert.equal(ipcMainRef.listeners.has('renderer-ready'), false);
});

// ---------------------------------------------------------------------------
// createPackagedSmokeController — failure path.
// ---------------------------------------------------------------------------
test('packaged smoke controller writes failure JSON and requests graceful shutdown', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-packaged-smoke-fail-'));
  const savedExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = savedExitCode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const outputPath = path.join(tempDir, 'fail.json');
  const ipcMainRef = new FakeIpcMain();
  const exitCalls = [];
  const shutdownCalls = [];
  let quitCalls = 0;

  const controller = createPackagedSmokeController({
    outputPath,
    timeoutMs: 60_000,
    appRef: {
      exit(code) { exitCalls.push(code); },
      quit() { quitCalls += 1; },
    },
    requestShutdown(code) { shutdownCalls.push(code); },
    ipcMainRef,
    getWindow: () => null,
    getBackendStatus: () => ({}),
    readyChannel: 'renderer-ready',
  });

  assert.notEqual(controller, null);

  controller.markBackendFailed({ phase: 'error' }, 'boom');

  const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(payload.ok, false);
  assert.ok(
    payload.error.includes('boom'),
    `expected error to contain "boom", got: ${payload.error}`,
  );
  assert.deepEqual(shutdownCalls, [1]);
  assert.deepEqual(exitCalls, []);
  assert.equal(quitCalls, 0);
});

// ---------------------------------------------------------------------------
// createPackagedSmokeController — dispose clears the timeout listener.
// ---------------------------------------------------------------------------
test('controller.dispose() removes the ipc listener', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-packaged-smoke-disp-'));
  const savedExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = savedExitCode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const outputPath = path.join(tempDir, 'disp.json');
  const ipcMainRef = new FakeIpcMain();

  const controller = createPackagedSmokeController({
    outputPath,
    timeoutMs: 60_000,
    appRef: { exit() {}, quit() {} },
    ipcMainRef,
    getWindow: () => null,
    getBackendStatus: () => ({}),
    readyChannel: 'renderer-ready',
  });

  assert.equal(ipcMainRef.listeners.has('renderer-ready'), true);
  controller.dispose();
  assert.equal(ipcMainRef.listeners.has('renderer-ready'), false);
});
