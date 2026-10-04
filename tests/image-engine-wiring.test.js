'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackendServiceWithDeps } = require('../services/main/backend-service-wiring');
const { ShellConfigService } = require('../services/shell-config-service');
const { ImageEngineService } = require('../services/image-engine-service');
const { ExclusiveGpuCoordinator } = require('../services/backend/exclusive-gpu-coordinator');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { getImageEnginePidPath, writeRenderRecord, readRenderRecord } = require('../services/image-engine-pidfile');

test.afterEach(cleanupTrackedResources);

function fixture({ coordinator } = {}) {
  const userDataPath = createTrackedTempDir('jenny-image-wiring-');
  const shellConfigService = new ShellConfigService({ userDataPath, env: {} });
  const events = [];
  const manager = {};
  const getLlamaServerManager = () => manager;
  const backendPath = require.resolve('../services/backend/backend-service');
  const wiringPath = require.resolve('../services/main/backend-service-wiring');
  const handoffPath = require.resolve('../services/backend/chat-gpu-handoff');
  const originalBackend = require(backendPath);
  const originalHandoff = require(handoffPath);
  let handoffOptions;
  let created;
  try {
    require.cache[backendPath].exports = { ...originalBackend, BackendService: class extends originalBackend.BackendService {
      constructor(options) {
        super(options);
        if (coordinator) this.exclusiveGpuCoordinator = coordinator;
      }
    } };
    require.cache[handoffPath].exports = { ...originalHandoff, createChatGpuHandoff: (options) => {
      handoffOptions = options;
      return originalHandoff.createChatGpuHandoff(options);
    } };
    delete require.cache[wiringPath];
    created = require(wiringPath).createBackendServiceWithDeps({
      app: { getVersion: () => '0.0.0-test', getPath: () => userDataPath, isReady: () => true, isPackaged: false },
      processRef: { env: {}, argv: [], platform: process.platform, resourcesPath: '', cwd: () => userDataPath },
      safeStorage: createFakeSafeStorage(), dialog: {}, shellConfigService, personalityWorkspace: {},
      worktreeService: { describeStatus: () => ({ ok: true }) },
      skillsService: { getBundledRoot: () => '', on: () => {} },
      getLlamaServerManager, sendBridgeEvent: (name, state) => events.push([name, state]),
    });
  } finally {
    require.cache[backendPath].exports = originalBackend;
    require.cache[handoffPath].exports = originalHandoff;
    delete require.cache[wiringPath];
  }
  return { ...created, userDataPath, events, handoffOptions, getLlamaServerManager };
}

function dispose(f) {
  f.backendService.imageEngine?.dispose();
  f.backendService.dispose();
}

test('wiring starts the image engine, attaches shutdown and handoff, and forwards changed state', (t) => {
  assert.equal(typeof createBackendServiceWithDeps, 'function');
  const start = ImageEngineService.prototype.start;
  let starts = 0;
  t.mock.method(ImageEngineService.prototype, 'start', function () { starts += 1; return start.call(this); });
  const f = fixture();
  try {
    const { backendService: backend } = f;
    assert.ok(backend.imageEngine instanceof ImageEngineService);
    assert.equal(starts, 1);
    assert.equal(backend.imageEngine.userDataPath, f.userDataPath);
    assert.ok(backend.exclusiveGpuCoordinator instanceof ExclusiveGpuCoordinator);
    assert.equal(typeof backend.chatGpuHandoff.reconcile, 'function');
    assert.equal(typeof backend.imageEngineRuntime.killRenderSync, 'function');
    assert.equal(f.handoffOptions.backendService, backend);
    assert.equal(f.handoffOptions.coordinator, backend.exclusiveGpuCoordinator);
    assert.equal(f.handoffOptions.getLlamaServerManager, f.getLlamaServerManager);
    const state = { status: 'installing' };
    backend.imageEngine.emit('changed', state);
    assert.deepEqual(f.events.at(-1), ['imageEngine.onChanged', state]);
    assert.equal(f.events.at(-1)[1], state);
  } finally { dispose(f); }
});

test('wiring reuses an existing coordinator for the handoff', async () => {
  const coordinator = new ExclusiveGpuCoordinator();
  const owner = { kind: 'builtin', tool_name: 'test_tool', call_id: 'test_call', stream_id: 'test_stream' };
  const { leaseId } = await coordinator.acquireExclusiveLease({ owner });
  const f = fixture({ coordinator });
  try {
    assert.equal(f.backendService.exclusiveGpuCoordinator, coordinator);
    assert.equal(f.handoffOptions.coordinator, coordinator);
    assert.equal(f.backendService.chatGpuHandoff.getState().admission, coordinator.getState().state);
  } finally {
    coordinator.releaseLease(leaseId, owner);
    dispose(f);
  }
});

test('wired reconcile and emergency cleanup read the actual profile pidfile', async () => {
  const f = fixture();
  const pidPath = getImageEnginePidPath(f.userDataPath);
  const record = { version: 1, pid: 2147483647, exePath: 'unused', output: 'unused.png', opId: 'test_render', startedAt: 1 };
  try {
    writeRenderRecord(pidPath, record);
    assert.deepEqual(await f.backendService.chatGpuHandoff.reconcile(), { confirmed: true, released: false });
    assert.equal(readRenderRecord(pidPath), null);
    writeRenderRecord(pidPath, record);
    assert.deepEqual(f.backendService.imageEngineRuntime.killRenderSync(), { hadState: true, killed: false });
    assert.equal(readRenderRecord(pidPath), null);
  } finally { dispose(f); }
});
