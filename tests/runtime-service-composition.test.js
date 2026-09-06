'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createRuntimeServicesWithDeps,
} = require('../services/main/runtime-service-composition');

// Build a self-contained dependency bundle for the composition root. Every
// callback records its invocations so the test can assert on real delegation
// (not just "it didn't throw"). The caller is responsible for cleaning up the
// temp userData dir and stopping any timers via the returned `cleanup`.
function buildDeps({ systemArch = '', platform = process.platform } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-rsc-test-'));
  const calls = {
    coreLoggingReady: [],
    gpuMemoryReset: [],
    bridgeEvents: [],
    gpuMemorySamples: [],
  };
  const screen = {
    on() {},
    removeListener() {},
    getAllDisplays: () => [],
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1600, height: 900 },
      bounds: { x: 0, y: 0, width: 1600, height: 900 },
    }),
  };
  const deps = {
    app: { getPath: () => tmpDir },
    BrowserWindow: class {
      constructor() {}
    },
    nativeImage: {},
    powerMonitor: { on() {}, removeListener() {} },
    screen,
    shell: { openPath: async () => {}, showItemInFolder: () => {} },
    processRef: { ...process, env: { ...process.env }, platform, resourcesPath: '' },
    rootDir: process.cwd(),
    systemArch,
    onCoreLoggingReady: (arg) => {
      calls.coreLoggingReady.push(arg);
    },
    onGpuMemoryReset: (sample) => {
      calls.gpuMemoryReset.push(sample);
    },
    sendBridgeEvent: (event, payload) => {
      calls.bridgeEvents.push([event, payload]);
    },
    log: () => {},
    getCurrentSystemStatsPayload: () => ({ cpu: 0 }),
    refreshGpuMemorySample: async () => null,
    createUnavailableGpuMemorySample: (opts) => {
      const sample = { src: opts };
      calls.gpuMemorySamples.push(sample);
      return sample;
    },
  };
  return { deps, calls, tmpDir };
}

function makeContext(t, options) {
  const { deps, calls, tmpDir } = buildDeps(options);
  const services = createRuntimeServicesWithDeps(deps);
  t.after(() => {
    try {
      if (services.systemStats && typeof services.systemStats.stop === 'function') {
        services.systemStats.stop();
      }
    } catch {
      // best-effort timer shutdown
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  });
  return { services, calls };
}

test('onGpuMemoryReset is invoked exactly once during composition', (t) => {
  const { calls } = makeContext(t);
  assert.equal(calls.gpuMemoryReset.length, 1);
});

test('non-arm path resets gpu memory with the unavailable sample (no source tag)', (t) => {
  const { calls } = makeContext(t);
  // GPU telemetry is supported, so createUnavailableGpuMemorySample() is called
  // with NO argument -> { src: undefined }. The reset receives that
  // exact object.
  assert.equal(calls.gpuMemorySamples.length, 1);
  assert.deepEqual(calls.gpuMemoryReset[0], { src: undefined });
  assert.equal(calls.gpuMemoryReset[0], calls.gpuMemorySamples[0]);
});

test('darwin arm64 initial sample does not use arm_fallback', (t) => {
  const { calls } = makeContext(t, { systemArch: 'arm64', platform: 'darwin' });
  assert.deepEqual(calls.gpuMemoryReset[0], { src: undefined });
});

test('win32 arm64 initial sample uses arm_fallback', (t) => {
  const { calls } = makeContext(t, { systemArch: 'arm64', platform: 'win32' });
  assert.deepEqual(calls.gpuMemoryReset[0], { src: { source: 'arm_fallback' } });
});

test('onCoreLoggingReady is invoked exactly once with logStore + processLogWriter', (t) => {
  const { calls } = makeContext(t);
  assert.equal(calls.coreLoggingReady.length, 1);
  const published = calls.coreLoggingReady[0];
  assert.ok(published && typeof published === 'object');
  assert.ok(published.logStore, 'logStore must be published to the caller');
  assert.ok(published.processLogWriter, 'processLogWriter must be published');
});

test('published core logging objects are the same instances returned in the bundle', (t) => {
  const { services, calls } = makeContext(t);
  const published = calls.coreLoggingReady[0];
  // The factory must hand the caller the SAME logStore/processLogWriter it
  // exposes in the returned bundle -- not fresh copies.
  assert.equal(published.logStore, services.logStore);
  assert.equal(published.processLogWriter, services.processLogWriter);
});

test('returned bundle exposes the documented service keys with object values', (t) => {
  const { services } = makeContext(t);
  const representative = [
    'toolExecutor',
    'shellConfigService',
    'updateService',
    'setupService',
    'skillsService',
    'systemStats',
    'worktreeService',
    'windowStateService',
    'workspaceIdeSnapshotStore',
  ];
  for (const key of representative) {
    assert.equal(
      typeof services[key],
      'object',
      `expected services.${key} to be an object`
    );
    assert.ok(services[key], `expected services.${key} to be non-null`);
  }
  // usageHistory is documented as object-or-null; construction succeeds here
  // so it must be a real object, never undefined.
  assert.notEqual(typeof services.usageHistory, 'undefined');
  assert.ok(services.usageHistory);
  // Function members of the public surface must be wired too.
  assert.equal(typeof services.buildEffectiveFeatureFlags, 'function');
  assert.equal(typeof services.refreshElectronToolRegistry, 'function');
});

test('updateService "changed" event delegates to sendBridgeEvent("updates.onChanged")', (t) => {
  const { services, calls } = makeContext(t);
  const before = calls.bridgeEvents.length;
  services.updateService.emit('changed', { v: 1 });
  const emitted = calls.bridgeEvents.slice(before);
  assert.deepEqual(emitted, [['updates.onChanged', { v: 1 }]]);
});

test('setupService "model-pull-progress" delegates to sendBridgeEvent("setup.onModelPullProgress")', (t) => {
  const { services, calls } = makeContext(t);
  const before = calls.bridgeEvents.length;
  services.setupService.emit('model-pull-progress', { p: 2 });
  const emitted = calls.bridgeEvents.slice(before);
  assert.deepEqual(emitted, [['setup.onModelPullProgress', { p: 2 }]]);
});

test('ollamaInstallService "install-progress" delegates to sendBridgeEvent("setup.onOllamaInstallProgress")', (t) => {
  const { services, calls } = makeContext(t);
  const before = calls.bridgeEvents.length;
  services.ollamaInstallService.emit('install-progress', { pct: 42 });
  const emitted = calls.bridgeEvents.slice(before);
  assert.deepEqual(emitted, [['setup.onOllamaInstallProgress', { pct: 42 }]]);
});

// W7a-S5: a persisted *_inspect deny pruned by ToolPermissionStore at
// construction must flow into shell config as tools.richFiles=false (the
// per-type denial is inexpressible after the read_file fold; disabling the
// folded capability is the honest non-widening fallback).
test('a pruned *_inspect deny turns the rich-files toggle off in shell config', (t) => {
  const { deps, tmpDir } = buildDeps();
  fs.writeFileSync(
    path.join(tmpDir, 'tool-permissions.json'),
    JSON.stringify({
      version: 1,
      legacy_policies: { image_inspect: 'deny' },
      rules: [],
    }),
    'utf8'
  );
  const services = createRuntimeServicesWithDeps(deps);
  t.after(() => {
    try { services.systemStats?.stop?.(); } catch { /* best-effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  assert.equal(services.shellConfigService.getState().tools.richFiles, false);
});

test('without an *_inspect deny the rich-files toggle keeps its default', (t) => {
  const { deps, tmpDir } = buildDeps();
  fs.writeFileSync(
    path.join(tmpDir, 'tool-permissions.json'),
    JSON.stringify({
      version: 1,
      legacy_policies: { browser_eval: 'deny', read_file: 'auto' },
      rules: [],
    }),
    'utf8'
  );
  const services = createRuntimeServicesWithDeps(deps);
  t.after(() => {
    try { services.systemStats?.stop?.(); } catch { /* best-effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  assert.equal(services.shellConfigService.getState().tools.richFiles, true);
});
