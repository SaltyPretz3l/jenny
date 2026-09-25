'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DesktopSandboxService } = require('../services/execution/desktop-sandbox-service');
const { ExecutionReceipts } = require('../services/execution/execution-receipts');
const { sandboxError } = require('../services/execution/sandbox-errors');
const { ResourceBroker, capacityResource } = require('../services/session-runtime/resource-broker');
const { fixture, fakeLauncher } = require('./helpers/desktop-sandbox-lifecycle-fixture');

function disabledService(setup, launcher) {
  return new DesktopSandboxService({
    userDataPath: setup.base,
    sourceRoot: setup.base,
    configService: setup.config,
    launcherFactory: () => launcher,
  });
}

test('a disabled sandbox with only a leftover image context never touches Docker on start or close', async (t) => {
  const setup = await fixture(t, { enabled: false });
  await fs.mkdir(path.join(setup.base, 'command-sandbox', 'image-context-x'), { recursive: true });
  await fs.mkdir(path.join(setup.base, 'command-sandbox', 'snapshots'), { recursive: true });
  const launcher = fakeLauncher({ detectError: sandboxError('docker_operation_failed') });
  const service = disabledService(setup, launcher);
  const state = await service.start();
  assert.equal(state.state, 'disabled');
  await service.close();
  assert.deepEqual(launcher.calls, []);
});

test('a disabled sandbox still reconciles staged snapshots left by a crash', async (t) => {
  const setup = await fixture(t, { enabled: false });
  await fs.mkdir(path.join(setup.base, 'command-sandbox', 'snapshots', 'stage-1'), { recursive: true });
  const launcher = fakeLauncher();
  const service = disabledService(setup, launcher);
  t.after(() => service.close().catch(() => {}));
  await service.start();
  assert.deepEqual(launcher.calls[0], ['detect']);
});

test('a disabled sandbox still reconciles a pending execution receipt', async (t) => {
  const setup = await fixture(t, { enabled: false });
  const receipts = new ExecutionReceipts(path.join(setup.base, 'command-sandbox'));
  receipts.append('admitted', { request_id: 'request-1' });
  const launcher = fakeLauncher();
  const service = disabledService(setup, launcher);
  t.after(() => service.close().catch(() => {}));
  await service.start();
  assert.deepEqual(launcher.calls[0], ['detect']);
});

test('a maintenance lease reclaimed by a backend restart is re-acquired, not reused', async (t) => {
  const setup = await fixture(t, { enabled: false });
  const broker = new ResourceBroker();
  const service = new DesktopSandboxService({
    userDataPath: setup.base,
    sourceRoot: setup.base,
    configService: setup.config,
    getBackend: () => ({ sessionRuntime: { resourceBroker: broker } }),
    launcherFactory: () => fakeLauncher(),
  });
  const stale = broker.tryAcquire({ ownerId: 'desktop-sandbox-maintenance', resources: [capacityResource('native_processes')] });
  broker.confirmCleanup(stale.lease);
  service.maintenanceResources = { broker, lease: stale.lease };
  service._claimMaintenanceResources();
  assert.notEqual(service.maintenanceResources.lease, stale.lease);
  assert.equal(broker.isHeld(service.maintenanceResources.lease), true);
});
