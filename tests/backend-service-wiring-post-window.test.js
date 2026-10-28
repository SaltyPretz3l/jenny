'use strict';

// Row 62 Wave B: service starts first paint does not need leave backend
// construction. startPostWindowServices() (main.js, right after the IPC
// handlers register) starts the add-on, image engine and command sandbox and
// wires the semantic catalog; the sidecar-gated Row 58 workers start with the
// deferred refreshes once the backend is up.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBackendServiceWithDeps } = require('../services/main/backend-service-wiring');
const { ShellConfigService } = require('../services/shell-config-service');
const { ImageEngineService } = require('../services/image-engine-service');
const { PdfAddonService } = require('../services/pdf-addon-service');
const { DesktopSandboxService } = require('../services/execution/desktop-sandbox-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function countStarts(t) {
  const counts = { pdfAddon: 0, imageEngine: 0, commandSandbox: 0 };
  t.mock.method(PdfAddonService.prototype, 'start', async function () { counts.pdfAddon += 1; return {}; });
  t.mock.method(ImageEngineService.prototype, 'start', function () { counts.imageEngine += 1; return {}; });
  t.mock.method(DesktopSandboxService.prototype, 'start', async function () { counts.commandSandbox += 1; return {}; });
  return counts;
}

function createWiring() {
  const userDataPath = createTrackedTempDir('jenny-post-window-wiring-');
  return createBackendServiceWithDeps({
    app: { getVersion: () => '0.0.0-test', getPath: () => userDataPath, isReady: () => true, isPackaged: false },
    processRef: { env: {}, argv: [], platform: process.platform, resourcesPath: '', cwd: () => userDataPath },
    safeStorage: createFakeSafeStorage(),
    dialog: {},
    shellConfigService: new ShellConfigService({ userDataPath, env: {} }),
    personalityWorkspace: {},
    worktreeService: { describeStatus: () => ({ ok: true }) },
    skillsService: { getBundledRoot: () => '', on: () => {} },
  });
}

function disposeWiring(created) {
  const service = created.backendService;
  service.memoryReflectionScheduler?.dispose?.();
  service.conversationIndexPump?.dispose?.();
  service.memoryPurgeReconcile?.dispose?.();
  service.semanticCatalogService?.dispose?.();
  service.imageEngine?.dispose?.();
  created.linkStatusService.stop();
  created.calendarService.stop();
  service.dispose?.();
}

test('construction starts no post-window service; startPostWindowServices starts each once', (t) => {
  const counts = countStarts(t);
  const created = createWiring();
  try {
    assert.deepEqual(counts, { pdfAddon: 0, imageEngine: 0, commandSandbox: 0 });
    assert.equal(created.backendService.semanticCatalogService, undefined);
    // The objects the IPC handlers and the sidecar env read already exist.
    assert.ok(created.backendService.pdfAddon instanceof PdfAddonService);
    assert.ok(created.backendService.imageEngine instanceof ImageEngineService);
    assert.ok(created.backendService.commandSandbox instanceof DesktopSandboxService);

    created.startPostWindowServices();
    created.startPostWindowServices();
    assert.deepEqual(counts, { pdfAddon: 1, imageEngine: 1, commandSandbox: 1 });
    assert.equal(typeof created.backendService.semanticCatalogService?.getSidecarConfig, 'function');
  } finally {
    disposeWiring(created);
  }
});

test('the sidecar-gated memory workers start with the deferred refreshes, once', (t) => {
  countStarts(t);
  const created = createWiring();
  created.modelCatalogService.refresh = () => {};
  created.linkStatusService.refresh = () => {};
  created.calendarService.refreshFeeds = () => {};
  try {
    const service = created.backendService;
    assert.equal(service.memoryReflectionScheduler, undefined);
    assert.equal(service.conversationIndexPump, undefined);
    assert.equal(service.memoryPurgeReconcile, undefined);

    created.startDeferredBackgroundRefreshes();
    const first = [service.memoryReflectionScheduler, service.conversationIndexPump, service.memoryPurgeReconcile];
    assert.ok(first.every((worker) => worker && typeof worker.dispose === 'function'));
    created.startDeferredBackgroundRefreshes();
    assert.deepEqual(
      [service.memoryReflectionScheduler, service.conversationIndexPump, service.memoryPurgeReconcile],
      first,
    );
  } finally {
    disposeWiring(created);
  }
});
