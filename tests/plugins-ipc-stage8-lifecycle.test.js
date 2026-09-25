'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerPluginsRuntime } = require('../services/main/plugins-ipc-registration');
const { createPluginStage8Registration } = require('../services/main/plugin-stage8-registration');
const { putContent } = require('../services/plugins/store/content-store');
const { createNodeFsFacade } = require('../services/plugins/store/node-fs-facade');
const { ResourceBroker } = require('../services/session-runtime/resource-broker');

function fakeIpcMain() {
  return { handle() {}, on() {}, removeHandler() {} };
}

class FakeWebContents extends EventEmitter {
  constructor() { super(); this.mainFrame = this; }
  setWindowOpenHandler() {}
}

class PendingConsentWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    PendingConsentWindow.created = this;
  }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  show() {}
  loadFile() { return Promise.resolve(); }
}

test('plugin composition installs a reusable Stage 8 lifecycle port and restores its owner', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-lifecycle-'));
  const prior = { beginBackendShutdown() {}, reopenAfterBackendStart() {} };
  const backendService = { featureFlags: { plugins: true }, _pluginStage8Lifecycle: prior };
  const handle = registerPluginsRuntime(fakeIpcMain(), {
    backendService,
    app: { getPath: () => userData, getAppPath: () => process.cwd(), once() {}, isPackaged: false },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    processRef: { argv: [], env: {}, resourcesPath: path.join(process.cwd(), 'build') },
    getMainWindow: () => null,
    sendBridgeEvent() {},
    log() {},
  });
  t.after(async () => {
    await handle.dispose();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  const lifecycle = backendService._pluginStage8Lifecycle;
  assert.notEqual(lifecycle, prior);
  assert.deepEqual(await lifecycle.beginBackendShutdown(),
    { ok: true, sessions: { ok: true, terminated_count: 0, unproven_count: 0 },
      helper: { ok: true, already_absent: true } });
  assert.deepEqual(lifecycle.reopenAfterBackendStart(), { ok: true });
  await handle.dispose();
  assert.equal(backendService._pluginStage8Lifecycle, prior);
});

test('backend shutdown closes pending production consent before any native spawn', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-stage8-consent-stop-'));
  const facade = createNodeFsFacade({ rootDir });
  const executable = Buffer.from('stage8 pending consent fixture');
  const stored = await putContent(facade, '', executable);
  const broker = new ResourceBroker({ limits: { native_processes: 2 } });
  let spawns = 0;
  let releaseStorageCleanup;
  PendingConsentWindow.created = null;
  const ipcMain = fakeIpcMain();
  const isolatedSession = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    on() {}, clearStorageData: () => new Promise((resolve) => { releaseStorageCleanup = resolve; }) };
  const authority = { active_generation_id: 'generation-consent', commit_epoch: 1,
    registry_revision: 1, dependency_graph_hash: 'a'.repeat(64) };
  const runtimeCoordinator = { getState: () => ({}),
    prepare: async () => ({ ok: true, commit: async () => ({ ok: true }) }) };
  const registration = createPluginStage8Registration({ enabled: true, runtimeCoordinator,
    backendService: { configService: null, secureStore: {}, sessionRuntime: { resourceBroker: broker } },
    facade, baseDir: '', rootDir, appRoot: process.cwd(), resourcesRoot: rootDir,
    isPackaged: false, ipcMain, BrowserWindow: PendingConsentWindow,
    session: { fromPartition: () => isolatedSession },
    spawnSupervisor: () => { spawns += 1; throw new Error('unexpected spawn'); },
    backendQuiesceTimeoutMs: 10, log() {} });
  t.after(async () => { await registration.dispose(); fs.rmSync(rootDir, { recursive: true, force: true }); });
  const prepared = await registration.service.runtimeCoordinator.prepare({ compiled: {
    snapshot: authority, privileged: {},
  } });
  assert.equal((await prepared.commit()).ok, true);
  const descriptor = { publisher_id: 'publisher', plugin_id: 'plugin', contribution_id: 'host',
    artifact_digest: crypto.createHash('sha256').update('artifact').digest('hex'),
    executable_digest: stored.digest };
  const pending = registration.service.acquireHost({ authority, contributionId: 'host', descriptor });
  await Promise.race([
    (async () => {
      while (!PendingConsentWindow.created) await new Promise((resolve) => setImmediate(resolve));
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('consent prompt did not open')), 1_000)),
  ]);

  const shutdown = await registration.beginBackendShutdown();
  assert.deepEqual(shutdown, { ok: false, reason: 'stage8_cleanup_timeout' });
  assert.equal(spawns, 0);
  releaseStorageCleanup();
  assert.equal((await pending).reason, 'stage8_backend_shutdown');
  assert.equal((await registration.beginBackendShutdown()).ok, true);
  assert.equal(PendingConsentWindow.created.destroyed, true);
  assert.equal(broker.snapshot().lease_count, 0);
});
