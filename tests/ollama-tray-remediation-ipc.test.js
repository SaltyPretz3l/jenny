'use strict';
// SPEC: ollamaTray.* IPC namespace — owner-triggered remediation for the
// Ollama tray-app conflict. Gated by the ollama_tray_remediation feature
// flag on backendService; disabled/missing backendService registers nothing.
// Handlers never throw across the IPC boundary and emit the frozen
// ollama.tray_remediation_* structured log events.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JENNY_SHELL_BRIDGE_DESCRIPTORS,
  getBridgeChannel,
} = require('../services/ipc-contract');
const {
  registerOllamaTrayRemediationIpcHandlers,
} = require('../services/main/ipc-handler-registration');

function fakeIpcMain() {
  const handlers = {};
  return {
    handle(channel, fn) { handlers[channel] = fn; },
    invoke(channel, payload) { return handlers[channel](null, payload); },
    registered: () => Object.keys(handlers),
  };
}

function makeLogSpy() {
  const calls = [];
  const log = (level, event, details) => { calls.push({ level, event, details }); };
  log.calls = calls;
  return log;
}

test('descriptors: ollamaTray.* map to kebab channels', () => {
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['ollamaTray.status'].channel, 'ollama-tray:status');
  assert.equal(JENNY_SHELL_BRIDGE_DESCRIPTORS['ollamaTray.quitTrayApp'].channel, 'ollama-tray:quit');
  assert.equal(
    JENNY_SHELL_BRIDGE_DESCRIPTORS['ollamaTray.disableStartupShortcut'].channel,
    'ollama-tray:disable-startup'
  );
  assert.equal(
    JENNY_SHELL_BRIDGE_DESCRIPTORS['ollamaTray.restartEngine'].channel,
    'ollama-tray:restart-engine'
  );
  assert.equal(getBridgeChannel('ollamaTray.status', 'invoke'), 'ollama-tray:status');
});

test('registers nothing when enabled is false', () => {
  const ipcMain = fakeIpcMain();
  const backendService = {
    ollamaManager: { stop: async () => {}, start: async () => ({ started: true }) },
    featureFlags: { ollama_tray_remediation: true },
  };
  const registered = registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log: makeLogSpy(),
    enabled: false,
  });
  assert.deepEqual(registered, []);
  assert.deepEqual(ipcMain.registered(), []);
});

test('registers nothing when backendService is missing', () => {
  const ipcMain = fakeIpcMain();
  const registered = registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService: null,
    log: makeLogSpy(),
    enabled: true,
  });
  assert.deepEqual(registered, []);
  assert.deepEqual(ipcMain.registered(), []);
});

test('when enabled, all 4 channels register', () => {
  const ipcMain = fakeIpcMain();
  const backendService = {
    ollamaManager: {
      stop: async () => {},
      start: async () => ({ started: true }),
      _isRunning: async () => true,
    },
    featureFlags: { ollama_tray_remediation: true },
  };
  const registered = registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log: makeLogSpy(),
    enabled: true,
  });
  assert.deepEqual(registered.sort(), [
    'ollama-tray:disable-startup',
    'ollama-tray:quit',
    'ollama-tray:restart-engine',
    'ollama-tray:status',
  ].sort());
  assert.deepEqual(ipcMain.registered().sort(), registered.sort());
});

test('ollamaTray.status returns the contract shape via the injected detectImpl', async () => {
  const ipcMain = fakeIpcMain();
  const backendService = {
    ollamaManager: { stop: async () => {}, start: async () => ({ started: true }) },
    featureFlags: { ollama_tray_remediation: true },
  };
  const detectImpl = () => ({
    detected: true,
    trayProcesses: [{ pid: 111, name: 'ollama app.exe' }],
    startupShortcuts: ['Ollama.lnk'],
  });
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log: makeLogSpy(),
    enabled: true,
    detectImpl,
  });

  const result = await ipcMain.invoke('ollama-tray:status');
  assert.equal(result.ok, true);
  assert.equal(result.detected, true);
  assert.deepEqual(result.trayProcesses, [{ pid: 111, name: 'ollama app.exe' }]);
  assert.deepEqual(result.startupShortcuts, ['Ollama.lnk']);
  assert.equal(typeof result.platform, 'string');
  assert.equal(typeof result.supported, 'boolean');
});

test('ollamaTray.quitTrayApp invokes the injected quitImpl and logs INFO on success', async () => {
  const ipcMain = fakeIpcMain();
  const log = makeLogSpy();
  const backendService = {
    ollamaManager: { stop: async () => {}, start: async () => ({ started: true }) },
    featureFlags: { ollama_tray_remediation: true },
  };
  const quitImpl = () => ({ ok: true, killedPids: [111, 222] });
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    enabled: true,
    quitImpl,
  });

  const result = await ipcMain.invoke('ollama-tray:quit');
  assert.deepEqual(result, { ok: true, killedPids: [111, 222] });
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0].level, 'INFO');
  assert.equal(log.calls[0].event, 'ollama.tray_remediation_quit');
  assert.deepEqual(log.calls[0].details.killedPids, [111, 222]);
});

test('ollamaTray.quitTrayApp logs WARN when the result is not ok', async () => {
  const ipcMain = fakeIpcMain();
  const log = makeLogSpy();
  const backendService = {
    ollamaManager: { stop: async () => {}, start: async () => ({ started: true }) },
    featureFlags: { ollama_tray_remediation: true },
  };
  const quitImpl = () => ({ ok: false, killedPids: [], reason: 'kill_failed' });
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    enabled: true,
    quitImpl,
  });

  const result = await ipcMain.invoke('ollama-tray:quit');
  assert.equal(result.ok, false);
  assert.equal(log.calls[0].level, 'WARN');
  assert.equal(log.calls[0].event, 'ollama.tray_remediation_quit');
});

test('ollamaTray.quitTrayApp never throws across the IPC boundary', async () => {
  const ipcMain = fakeIpcMain();
  const log = makeLogSpy();
  const backendService = {
    ollamaManager: { stop: async () => {}, start: async () => ({ started: true }) },
    featureFlags: { ollama_tray_remediation: true },
  };
  const quitImpl = () => { throw new Error('boom'); };
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    enabled: true,
    quitImpl,
  });

  const result = await ipcMain.invoke('ollama-tray:quit');
  assert.equal(result.ok, false);
  assert.equal(log.calls[0].level, 'WARN');
});

test('ollamaTray.disableStartupShortcut invokes the injected disableImpl and logs the event', async () => {
  const ipcMain = fakeIpcMain();
  const log = makeLogSpy();
  const backendService = {
    ollamaManager: { stop: async () => {}, start: async () => ({ started: true }) },
    featureFlags: { ollama_tray_remediation: true },
  };
  const disableImpl = () => ({ ok: true, disabled: ['Ollama.lnk'], skipped: [] });
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    enabled: true,
    disableImpl,
  });

  const result = await ipcMain.invoke('ollama-tray:disable-startup');
  assert.deepEqual(result, { ok: true, disabled: ['Ollama.lnk'], skipped: [] });
  assert.equal(log.calls[0].level, 'INFO');
  assert.equal(log.calls[0].event, 'ollama.tray_remediation_disable_startup');
  assert.deepEqual(log.calls[0].details.disabled, ['Ollama.lnk']);
});

test('ollamaTray.restartEngine stops then starts the engine and reports running:true', async () => {
  const ipcMain = fakeIpcMain();
  const log = makeLogSpy();
  const calls = [];
  const backendService = {
    ollamaManager: {
      stop: async () => { calls.push('stop'); },
      start: async () => { calls.push('start'); return { started: true }; },
      _isRunning: async () => true,
    },
    featureFlags: { ollama_tray_remediation: true },
  };
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    enabled: true,
  });

  const result = await ipcMain.invoke('ollama-tray:restart-engine');
  assert.deepEqual(calls, ['stop', 'start']);
  assert.equal(result.ok, true);
  assert.equal(result.running, true);
  assert.equal(log.calls[0].level, 'INFO');
  assert.equal(log.calls[0].event, 'ollama.tray_remediation_restart');
});

test('ollamaTray.restartEngine reports running:false and WARN when the engine fails to start', async () => {
  const ipcMain = fakeIpcMain();
  const log = makeLogSpy();
  const backendService = {
    ollamaManager: {
      stop: async () => {},
      start: async () => ({ started: false, failure: { remediation: 'not found' } }),
      _isRunning: async () => false,
    },
    featureFlags: { ollama_tray_remediation: true },
  };
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    enabled: true,
  });

  const result = await ipcMain.invoke('ollama-tray:restart-engine');
  assert.equal(result.ok, false);
  assert.equal(result.running, false);
  assert.equal(log.calls[0].level, 'WARN');
  assert.equal(log.calls[0].event, 'ollama.tray_remediation_restart');
});

test('ollamaTray.restartEngine never throws across the IPC boundary', async () => {
  const ipcMain = fakeIpcMain();
  const log = makeLogSpy();
  const backendService = {
    ollamaManager: {
      stop: async () => { throw new Error('stop boom'); },
      start: async () => ({ started: true }),
    },
    featureFlags: { ollama_tray_remediation: true },
  };
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    enabled: true,
  });

  const result = await ipcMain.invoke('ollama-tray:restart-engine');
  assert.equal(result.ok, false);
  assert.equal(result.running, false);
  assert.equal(log.calls[0].level, 'WARN');
});
