'use strict';

// Split view gate §D: after a relaunch the renderer's model catalog latched
// { available: false, reason: 'Managed sidecar is not ready yet.' } while the
// backend already read 'ready'. The renderer reads the catalog once per ready
// transition, so the main process must never publish an observed 'ready'
// before the sidecar client is attached to AND initialized for the current
// process, and a catalog read made before the client existed must not be
// served back to the first read after it does.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const { createManagedService } = require('../helpers/managed-sidecar-runtime-helpers');
const { SidecarClient } = require('../../services/backend/sidecar-client');

const NOT_READY_REASON = 'Managed sidecar is not ready yet.';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeService(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  return createManagedService(userDataPath);
}

// Records which sidecar processes finished an initialize handshake.
function trackInitializedProcesses(t) {
  const initialized = new WeakSet();
  const original = SidecarClient.prototype.initialize;
  SidecarClient.prototype.initialize = async function trackedInitialize(...args) {
    const processAtSend = this.process;
    const payload = await original.apply(this, args);
    if (processAtSend) initialized.add(processAtSend);
    return payload;
  };
  t.after(() => { SidecarClient.prototype.initialize = original; });
  return initialized;
}

// Mirrors the renderer: every observed 'ready' push triggers one catalog read.
function recordReadyPushes(service, initialized) {
  const pushes = [];
  service.on('backend-status', (status) => {
    if (status?.phase !== 'ready') return;
    const client = service.sidecarClient;
    const current = service.sidecarManager.process;
    pushes.push({
      clientAttached: Boolean(client) && Boolean(current) && client.process === current,
      initializedForCurrentProcess: Boolean(current) && initialized.has(current),
      // Settled so an early read against a detached client cannot surface as
      // an unhandled rejection before the assertions below report it.
      catalog: service.listModels().then(
        (value) => ({ value }),
        (error) => ({ error })
      ),
    });
  });
  return pushes;
}

async function assertReadyPushesSettled(pushes, label) {
  assert.ok(pushes.length > 0, `${label}: expected at least one observed 'ready' push`);
  for (const [index, push] of pushes.entries()) {
    assert.equal(push.clientAttached, true,
      `${label}: ready push #${index} published before the sidecar client was attached to the current process`);
    assert.equal(push.initializedForCurrentProcess, true,
      `${label}: ready push #${index} published before the current sidecar process was initialized`);
  }
  const { value: first, error } = await pushes[0].catalog;
  assert.equal(error, undefined, `${label}: first ready-push catalog read failed: ${error?.message}`);
  assert.notEqual(first.reason, NOT_READY_REASON,
    `${label}: the catalog read on the first ready push came back "${NOT_READY_REASON}"`);
  assert.equal(first.available, true, `${label}: first ready-push catalog must be available`);
  assert.ok(first.data.length > 0, `${label}: first ready-push catalog must list models`);
}

test('retryStart after stop publishes ready only once the new sidecar is attached and initialized', async (t) => {
  const initialized = trackInitializedProcesses(t);
  const service = makeService('jenny-ready-after-attach-retry-');
  await service.start();
  await service.stop();
  assert.equal(service.sidecarClient, null, 'stop disposes the sidecar client');

  const pushes = recordReadyPushes(service, initialized);
  const status = await service.retryStart();
  assert.equal(status.phase, 'ready');
  await assertReadyPushesSettled(pushes, 'retryStart');
  await service.stop();
});

test('restartManagedSidecar publishes ready only once the respawned sidecar is attached and initialized', async (t) => {
  const initialized = trackInitializedProcesses(t);
  const service = makeService('jenny-ready-after-attach-restart-');
  await service.start();

  const pushes = recordReadyPushes(service, initialized);
  const restarted = await service._restartManagedSidecar('unit.ready_after_attach');
  assert.equal(restarted, true);
  await assertReadyPushesSettled(pushes, 'restartManagedSidecar');
  await service.stop();
});

test('a catalog read made before the sidecar client exists is not served to the first read after ready', async () => {
  const service = makeService('jenny-ready-after-attach-cache-');
  const early = await service.listModels();
  assert.equal(early.available, false);
  assert.equal(early.reason, NOT_READY_REASON);

  const status = await service.start();
  assert.equal(status.phase, 'ready');
  // Well inside the 2 s models.list cache window on a fast launch.
  const catalog = await service.listModels();
  assert.notEqual(catalog.reason, NOT_READY_REASON,
    'the pre-attach not-ready catalog was served from the models.list cache after ready');
  assert.equal(catalog.available, true);
  assert.ok(catalog.data.length > 0);
  await service.stop();
});
