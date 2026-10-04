'use strict';

// Overlapping feature-settings saves against the real managed refresh and
// initialize-flight join (managed-sidecar-lifecycle.js, local-engine-status.js)
// with a fake sidecar client whose initialize calls the test resolves by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { applyFeatureSettingsPatch } = require('../services/feature-settings-service');
const { refreshManagedConfig } = require('../services/backend/managed-sidecar-lifecycle');
const { initializeManagedSidecarWithTimeout } = require('../services/backend/local-engine-status');
const { createBackendServiceWithDeps } = require('../services/main/backend-service-wiring');
const { shouldRefreshManagedConfigForShellConfigReason } = require('../services/main/main-process-policy');
const { ShellConfigService } = require('../services/shell-config-service');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

// A flight left in the air holds its watchdog timers; settle it so a failing
// test reports instead of hanging the file.
const openFlights = new Set();

test.afterEach(async () => {
  for (const flight of openFlights) {
    flight.reject(new Error('test ended with the flight in the air'));
  }
  openFlights.clear();
  await cleanupTrackedResources();
});

class FakeShellConfig extends EventEmitter {
  constructor() {
    super();
    this.state = {
      tools: { web: false, imageRead: false },
      webSearch: { provider: 'duckduckgo', searxngUrl: '' },
      featureOverrides: {},
      memory: { captureSuggestions: true },
      chatUi: { density: 'cozy' },
    };
  }

  getState() { return structuredClone(this.state); }

  getWorkspaceRootStatus() { return { state: 'missing', message: 'Missing.' }; }

  updateFeatureSettings(patch = {}) {
    const next = { ...this.state };
    for (const key of ['tools', 'webSearch', 'featureOverrides', 'memory']) {
      next[key] = { ...this.state[key], ...(patch[key] || {}) };
    }
    return this._write(next, 'feature_settings_updated');
  }

  updateChatUi(patch) {
    return this._write({ ...this.state, chatUi: { ...this.state.chatUi, ...patch } }, 'chat_ui_settings_updated');
  }

  replaceState(next, reason) { return this._write(structuredClone(next), reason); }

  _write(next, reason) {
    this.state = next;
    this.emit('changed', this.getState(), { reason });
    return this.getState();
  }
}

function createManagedBackend(configService) {
  const flights = [];
  const processGeneration = {};
  const service = Object.assign(new EventEmitter(), {
    configService,
    currentEngineType: 'mock',
    currentModel: '',
    defaultModel: '',
    featureFlags: {},
    options: { userDataPath: process.cwd() },
    activeStreams: new Map(),
    _disposed: false,
    _managedInitializeFlight: null,
    _managedInitializeGeneration: 0,
    _managedPendingModel: '',
    _modelLifecycle: { state: 'unloaded' },
    _emitServiceLog() {},
    sidecarManager: { process: processGeneration, getStatus: () => ({ phase: 'ready' }) },
    sidecarClient: {
      process: processGeneration,
      connected: true,
      attachProcess(next) { this.process = next; },
      initialize(payload) {
        return new Promise((resolve, reject) => {
          const flight = {
            config: payload.config,
            resolve: () => {
              openFlights.delete(flight);
              resolve({ active_engine: 'mock', active_model: service._managedPendingModel });
            },
            reject: (error) => {
              openFlights.delete(flight);
              reject(error);
            },
          };
          openFlights.add(flight);
          flights.push(flight);
        });
      },
    },
    setFeatureFlags() {},
    refreshStatusSnapshot: async () => null,
    _initializeManagedSidecar(options) { return initializeManagedSidecarWithTimeout(service, options); },
    refreshManagedConfig(reason) { return refreshManagedConfig(service, reason); },
  });
  return { service, flights };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function track(promise) {
  const tracked = { settled: false, value: undefined, error: undefined };
  tracked.promise = promise.then(
    (value) => { tracked.settled = true; tracked.value = value; return value; },
    (error) => { tracked.settled = true; tracked.error = error; throw error; }
  );
  tracked.promise.catch(() => {});
  return tracked;
}

function save(shellConfigService, backendService, patch, extra = {}) {
  return applyFeatureSettingsPatch({
    patch, shellConfigService, backendService, env: {}, platform: 'win32', ...extra,
  });
}

test('a save submitted while an earlier save is in flight resolves only after a flight built with its values', async () => {
  const shell = new FakeShellConfig();
  const { service, flights } = createManagedBackend(shell);

  const saveA = track(save(shell, service, { tools: { web: true } }));
  await waitFor(() => flights.length === 1, 'flight A');
  const saveB = track(save(shell, service, { webSearch: { provider: 'searxng' } }));

  flights[0].resolve();
  await saveA.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saveB.settled, false, 'B must not be acknowledged by a flight built before it committed');

  await waitFor(() => flights.length === 2, 'flight B');
  assert.equal(flights[1].config.tools_web_search_provider, 'searxng');
  assert.equal(flights[1].config.tools_web_enabled, true);
  flights[1].resolve();
  const payload = await saveB.promise;
  assert.equal(payload.webSearch.provider, 'searxng');
  assert.equal(flights.length, 2);
});

test('a save that joins an unrelated flight built before its commit drains with another refresh', async () => {
  const shell = new FakeShellConfig();
  const { service, flights } = createManagedBackend(shell);

  const unrelated = service.refreshManagedConfig('time_format_updated');
  await waitFor(() => flights.length === 1, 'unrelated flight');
  assert.equal(flights[0].config.tools_web_enabled, false);
  const saveB = track(save(shell, service, { tools: { web: true } }));
  await waitFor(() => shell.state.tools.web === true, 'B commit');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flights.length, 1, 'B joined the in-air flight');

  flights[0].resolve();
  await unrelated;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saveB.settled, false, 'the joined flight carried the pre-commit config');

  await waitFor(() => flights.length === 2, 'drain flight');
  assert.equal(flights[1].config.tools_web_enabled, true);
  flights[1].resolve();
  await saveB.promise;
});

test('a failed save restores only its own keys and keeps commits that landed after it', async () => {
  const shell = new FakeShellConfig();
  const { service, flights } = createManagedBackend(shell);
  const broadcasts = [];
  const failure = new Error('initialize failed');

  const saveA = track(save(shell, service, { tools: { web: true } }, {
    sendToWindow: (_channel, payload) => broadcasts.push(payload),
  }));
  await waitFor(() => flights.length === 1, 'flight A');
  shell.updateChatUi({ density: 'compact' });
  shell.updateFeatureSettings({ tools: { imageRead: true } });

  flights[0].reject(failure);
  await waitFor(() => flights.length === 2, 'rollback flight');
  assert.equal(flights[1].config.tools_web_enabled, false);
  assert.equal(flights[1].config.tools_image_read_enabled, true);
  flights[1].resolve();
  await assert.rejects(saveA.promise, (error) => error === failure);

  assert.equal(shell.state.tools.web, false, "A's own key is restored");
  assert.equal(shell.state.tools.imageRead, true, 'a later sub-key commit survives');
  assert.equal(shell.state.chatUi.density, 'compact', 'a later commit to another section survives');
  assert.equal(broadcasts.at(-1).tools.web, false);
  assert.equal(broadcasts.at(-1).tools.imageRead, true);
});

test('three rapid saves commit one at a time, resolve in order and publish the last values', async () => {
  const shell = new FakeShellConfig();
  const { service, flights } = createManagedBackend(shell);
  const order = [];
  const saves = [
    ['A', { tools: { web: true } }],
    ['B', { webSearch: { provider: 'searxng' } }],
    ['C', { tools: { imageRead: true } }],
  ].map(([name, patch]) => save(shell, service, patch).then(() => order.push(name)));

  for (let index = 0; index < 3; index += 1) {
    await waitFor(() => flights.length === index + 1, `flight ${index + 1}`);
    flights[index].resolve();
  }
  await Promise.all(saves);

  assert.deepEqual(order, ['A', 'B', 'C']);
  assert.equal(flights.length, 3);
  assert.equal(flights[0].config.tools_web_search_provider, 'duckduckgo', 'B had not committed during A');
  assert.equal(flights[0].config.tools_image_read_enabled, false, 'C had not committed during A');
  const last = flights.at(-1).config;
  assert.equal(last.tools_web_enabled, true);
  assert.equal(last.tools_web_search_provider, 'searxng');
  assert.equal(last.tools_image_read_enabled, true);
});

function createWiredBackend() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-feature-overlap-'));
  trackDirectory(userDataPath);
  const shellConfigService = new ShellConfigService({ userDataPath, env: {} });
  const created = createBackendServiceWithDeps({
    app: { getVersion: () => '0.0.0-test', getPath: () => userDataPath, isReady: () => true, isPackaged: false },
    processRef: { env: {}, platform: process.platform, resourcesPath: userDataPath, cwd: () => userDataPath },
    safeStorage: createFakeSafeStorage(),
    dialog: {},
    shellConfigService,
    personalityWorkspace: {},
    worktreeService: { describeStatus: () => ({ ok: true }) },
    skillsService: { getBundledRoot: () => '', on: () => {} },
    mcpDiscoveryService: { setBackendService: () => {} },
    getMainWindow: () => undefined,
    shouldRefreshManagedConfigForShellConfigReason,
  });
  return { shellConfigService, backendService: created.backendService };
}

for (const [label, buildPatch] of [
  ['tools_worktree_enabled_updated', () => ({ tools: { worktree: true } })],
  ['feature_settings_updated', (state) => ({ tools: { lsp: state.tools.lsp !== true } })],
]) {
  test(`a single save triggers exactly one managed refresh (${label} commit)`, async () => {
    const { shellConfigService, backendService } = createWiredBackend();
    const reasons = [];
    const commitReasons = [];
    backendService.refreshManagedConfig = async (reason) => { reasons.push(reason); return null; };
    shellConfigService.on('changed', (_state, context) => commitReasons.push(context.reason));
    try {
      await save(shellConfigService, backendService, buildPatch(shellConfigService.getState()));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(commitReasons, [label]);
      assert.deepEqual(reasons, ['feature_settings_updated']);
    } finally {
      backendService.dispose?.();
    }
  });
}

test('a refresh that never publishes the saved revision fails the save instead of spinning', async () => {
  const { applyFeatureSettingsPatch } = require('../services/feature-settings-service');
  let state = { tools: { web: false }, webSearch: {}, featureOverrides: {}, memory: {} };
  const shellConfigService = {
    getState: () => JSON.parse(JSON.stringify(state)),
    updateFeatureSettings: (patch) => { state = { ...state, tools: { ...state.tools, ...patch.tools } }; return shellConfigService.getState(); },
    replaceState: (next) => { state = JSON.parse(JSON.stringify(next)); },
  };
  const refreshes = [];
  const backendService = {
    _publishedFeatureSettingsRevision: 0,
    setFeatureFlags() {},
    refreshManagedConfig: async (reason) => { refreshes.push(reason); return {}; },
    _emitServiceLog() {},
  };
  await assert.rejects(
    applyFeatureSettingsPatch({ patch: { tools: { web: true } }, shellConfigService, backendService, env: {} }),
    /did not confirm/
  );
  assert.deepEqual(refreshes, ['feature_settings_updated', 'feature_settings_updated', 'feature_settings_updated', 'feature_settings_rollback']);
  assert.equal(state.tools.web, false, 'the unconfirmed save is rolled back');
});
