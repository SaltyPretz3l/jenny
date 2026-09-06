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
const { refreshManagedConfig } = require('../../services/backend/managed-sidecar-lifecycle');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar re-initialization does not accumulate process listeners across model loads', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-listeners-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  try {
    await service.start();

    const sidecarProcess = service.sidecarManager.process;
    assert.ok(sidecarProcess);
    assert.ok(sidecarProcess.stdout);
    const baselineStdoutListeners = sidecarProcess.stdout.listenerCount('data');
    const baselineExitListeners = sidecarProcess.listenerCount('exit');
    assert.equal(baselineStdoutListeners, 1);
    // Intentional lower bound: the runtime may attach a variable number of exit
    // listeners; the meaningful invariant (it stays constant across loadModel)
    // is asserted below against this captured baseline.
    assert.ok(baselineExitListeners >= 1, 'expected at least one baseline exit listener');

    await service.loadModel('mock-v2');
    assert.equal(sidecarProcess.stdout.listenerCount('data'), baselineStdoutListeners);
    assert.equal(sidecarProcess.listenerCount('exit'), baselineExitListeners);

    await service.loadModel('mock-v1');
    assert.equal(sidecarProcess.stdout.listenerCount('data'), baselineStdoutListeners);
    assert.equal(sidecarProcess.listenerCount('exit'), baselineExitListeners);
  } finally {
    await service.stop();
  }
});

test('refreshManagedConfig forwards the sign-out reconfiguration bounds into the initialize flight', async () => {
  // The managed initialize path passes timeoutMs:null to sidecarClient.initialize,
  // so the per-method RPC timeout does not apply: without these bounds the
  // awaited sign-out reconfiguration would inherit the 300s/615s flight
  // defaults and hang the Settings button.
  const observed = [];
  const service = {
    sidecarClient: {},
    sidecarManager: { process: {} },
    currentModel: '',
    currentEngineType: 'chatgpt',
    reasoningEffortSupport: '',
    currentStatus: null,
    _lastEngineFallback: null,
    _managedPendingModel: '',
    _modelLifecycle: { state: 'unloaded' },
    _emitServiceLog() {},
    async _initializeManagedSidecar(options) {
      observed.push(options);
      return {};
    },
    async refreshStatusSnapshot() { return null; },
  };

  await refreshManagedConfig(service, 'chatgpt_signed_out', {
    requestedEngineType: 'chatgpt',
    inactivityTimeoutMs: 8000,
    absoluteTimeoutMs: 8000,
  });
  await refreshManagedConfig(service, 'config_updated');

  assert.deepEqual(observed, [
    {
      reason: 'chatgpt_signed_out',
      requestedEngineType: 'chatgpt',
      inactivityTimeoutMs: 8000,
      absoluteTimeoutMs: 8000,
    },
    // Unset bounds are never forwarded, so ordinary refreshes keep the defaults.
    { reason: 'config_updated' },
  ]);
});

test('a lazy managed boot (no startup model) pushes a final ready backend-status', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-lazy-ready-'));
  trackDirectory(userDataPath);

  // preferredEngineType chatgpt resolves an empty startup model (lazy boot):
  // no model lifecycle transition ever follows the init flight, so the settled
  // 'ready' phase must come from the explicit post-start push — without it the
  // renderer's last observed phase stays 'sidecar_spawned' and the composer
  // deadlocks (can't send without a model, can't pick one while "starting").
  const configService = { getState: () => ({ preferredEngineType: 'chatgpt' }) };
  const service = createManagedService(userDataPath, { configService });
  const phases = [];
  service.on('backend-status', (status) => phases.push(String(status?.phase || '')));
  try {
    await service.start();
    assert.ok(phases.length > 0, 'expected backend-status pushes during start');
    assert.equal(phases[phases.length - 1], 'ready');
  } finally {
    await service.stop();
  }
});
