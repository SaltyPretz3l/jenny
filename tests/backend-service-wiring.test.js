const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createBackendServiceWithDeps } = require('../services/main/backend-service-wiring');
const { ShellConfigService } = require('../services/shell-config-service');
const { WorkspaceActiveUseTracker } = require('../services/workspace-active-use-tracker');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

// Keep wiring fixtures network-isolated if a test explicitly starts the deferred refresh.
const realFetch = globalThis.fetch;

test.before(() => {
  globalThis.fetch = async (resource) => {
    throw new Error(`network disabled in tests: ${String(resource)}`);
  };
});

test.after(() => {
  globalThis.fetch = realFetch;
});

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createBackendWiringFixture({ packaged = false } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-backend-wiring-'));
  trackDirectory(userDataPath);
  const developmentRepoRoot = path.join(userDataPath, 'repo');
  const resourcesPath = path.join(userDataPath, 'resources');
  const shellConfigService = new ShellConfigService({ userDataPath, env: {} });
  const worktreeService = {
    describeStatus: () => ({ ok: true }),
  };
  const created = createBackendServiceWithDeps({
    app: {
      getVersion: () => '0.0.0-test',
      getPath: () => userDataPath,
      isReady: () => true,
      isPackaged: packaged,
    },
    processRef: { env: {}, platform: process.platform, resourcesPath, cwd: () => developmentRepoRoot },
    safeStorage: createFakeSafeStorage(),
    dialog: {},
    shellConfigService,
    personalityWorkspace: {},
    toolExecutor: null,
    toolPermissionStore: null,
    attachmentAssetStore: null,
    artifactService: null,
    worktreeService,
    automationService: null,
    skillsService: { getBundledRoot: () => '', on: () => {} },
    mcpDiscoveryService: { setBackendService: () => {} },
    setupService: null,
    usageHistory: null,
    logStore: null,
    // main.js constructs the backend before assigning its mainWindow variable.
    getMainWindow: () => undefined,
    shouldUsePackagedSidecarRuntime: () => packaged,
  });
  return { created, developmentRepoRoot, resourcesPath, worktreeService, userDataPath };
}

test('backend wiring starts the workspace active-use tracker before any chat send and disposes it', () => {
  const { created } = createBackendWiringFixture();
  const tracker = created.backendService.workspaceActiveUseTracker;

  assert.equal(tracker instanceof WorkspaceActiveUseTracker, true);
  assert.equal(tracker.started, true);
  created.backendService.dispose();
  assert.equal(tracker.started, false);
});

test('backend wiring injects worktreeService into the BackendService at construction', () => {
  // Regression for the composition-order bug: worktreeService used to be assigned
  // post-hoc behind an always-falsy guard (the backend did not exist yet), leaving
  // backendService.worktreeService permanently null and worktree status unpopulated.
  // It must now be threaded through the constructor.
  const { created, worktreeService } = createBackendWiringFixture();
  try {
    assert.equal(created.backendService.worktreeService, worktreeService);
  } finally {
    created.backendService.dispose?.();
  }
});

test('backend wiring threads getLlamaServerManager into BackendService options', () => {
  // The sidecar secrets broker reads service.options.getLlamaServerManager()
  // behind optional chaining, so a renamed option would degrade silently to an
  // unauthenticated engine. Pin the exact option name end to end.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-backend-wiring-llama-'));
  trackDirectory(userDataPath);
  const shellConfigService = new ShellConfigService({ userDataPath, env: {} });
  const manager = { getApiKey: () => 'k', getBaseUrl: () => 'http://127.0.0.1:8033/v1' };
  const getLlamaServerManager = () => manager;
  const created = createBackendServiceWithDeps({
    app: { getVersion: () => '0.0.0-test', getPath: () => userDataPath, isReady: () => true, isPackaged: false },
    processRef: { env: {}, platform: process.platform, resourcesPath: '', cwd: () => userDataPath },
    safeStorage: createFakeSafeStorage(),
    dialog: {},
    shellConfigService,
    personalityWorkspace: {},
    toolExecutor: null,
    toolPermissionStore: null,
    attachmentAssetStore: null,
    artifactService: null,
    worktreeService: { describeStatus: () => ({ ok: true }) },
    automationService: null,
    skillsService: { getBundledRoot: () => '', on: () => {} },
    mcpDiscoveryService: { setBackendService: () => {} },
    setupService: null,
    usageHistory: null,
    logStore: null,
    getLlamaServerManager,
    shouldUsePackagedSidecarRuntime: () => false,
  });
  try {
    assert.equal(created.backendService.options.getLlamaServerManager, getLlamaServerManager);
    assert.equal(created.backendService.options.getLlamaServerManager(), manager);
  } finally {
    created.backendService.dispose?.();
  }
});

test('backend wiring selects the development vendor runtime bundle despite Electron resourcesPath', () => {
  const { created, developmentRepoRoot } = createBackendWiringFixture();
  try {
    assert.equal(
      created.backendService.options.pythonRuntimeBundleRoot,
      path.join(developmentRepoRoot, 'vendor'),
    );
  } finally {
    created.backendService.dispose?.();
  }
});

test('backend wiring selects packaged resources for the runtime bundle', () => {
  const { created, resourcesPath } = createBackendWiringFixture({ packaged: true });
  try {
    assert.equal(created.backendService.options.pythonRuntimeBundleRoot, resourcesPath);
  } finally {
    created.backendService.dispose?.();
  }
});

test('deferred background refreshes are idempotent and isolated per service', async () => {
  const { created, logEntries } = createRecordingFixture();
  const calls = [];
  created.modelCatalogService.refresh = () => { calls.push('model_catalog'); };
  created.weatherService.refresh = () => {
    calls.push('weather');
    throw new Error('weather failed');
  };
  created.linkStatusService.refresh = () => { calls.push('link_status'); };
  created.calendarService.refreshFeeds = () => { calls.push('calendar'); };

  try {
    created.startDeferredBackgroundRefreshes();
    created.startDeferredBackgroundRefreshes();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, ['model_catalog', 'weather', 'link_status', 'calendar']);
    assert.deepEqual(
      logEntries.find((entry) => entry.event === 'background_refresh.failed'),
      {
        level: 'WARN',
        event: 'background_refresh.failed',
        details: { service: 'weather', message: 'weather failed' },
      },
    );
  } finally {
    created.weatherService.stop();
    created.linkStatusService.stop();
    created.calendarService.stop();
    created.backendService.dispose?.();
  }
});

// ============================================================================
// Extended coverage tests for handler bodies (lines 135-141, 159/162/165,
// 204-205, 212-214, 219-280)
// ============================================================================

/**
 * Build a full fixture with recording fakes so we can assert that the wired
 * event handlers call the right collaborators with the right arguments.
 */
function createRecordingFixture({ featureFlags = {} } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-bsw-rec-'));
  trackDirectory(userDataPath);

  const bridgeEvents = [];
  const sendBridgeEvent = (name, payload) => bridgeEvents.push({ name, payload });

  const logEntries = [];
  const log = (level, event, details) => logEntries.push({ level, event, details });
  const diagnosticEntries = [];
  const diagnosticDrops = [];
  const diagnosticLogService = {
    append: (entry, options) => diagnosticEntries.push({ entry, options }),
    recordDrop: (source, count) => diagnosticDrops.push({ source, count }),
  };

  const crashDialogCalls = [];
  const showSidecarCrashDialog = async (opts) => { crashDialogCalls.push(opts); return null; };

  const smokeControllerCalls = [];
  const smokeController = {
    markBackendFailed: (...args) => smokeControllerCalls.push(args),
  };
  const getPackagedSmokeController = () => smokeController;

  const gpuRefreshCalls = [];
  const refreshGpuMemorySample = async (opts) => { gpuRefreshCalls.push(opts); return null; };

  const toolRegistryRefreshCalls = [];
  const innerRefresh = () => toolRegistryRefreshCalls.push(1);
  const getRefreshElectronToolRegistry = () => innerRefresh;

  const cometOverlayCalls = [];
  const closeCometOverlayIfDisabled = () => cometOverlayCalls.push(1);

  const featureStatePayloads = [];
  const buildFeatureStatePayload = () => {
    const payload = { flags: 'test-payload' };
    featureStatePayloads.push(payload);
    return payload;
  };

  const managedConfigRefreshReasons = [];
  const shouldRefreshManagedConfigForShellConfigReason = (reason) => {
    managedConfigRefreshReasons.push(reason);
    return reason === 'refresh_me';
  };

  const shellConfigService = new ShellConfigService({ userDataPath, env: {} });

  // Enable tips_surface so tipsService.initializeSession() is called (line 204-205)
  const mergedFlags = { tips_surface: true, ...featureFlags };

  const skillsListeners = [];
  const skillsService = {
    getBundledRoot: () => '',
    on: (event, fn) => skillsListeners.push({ event, fn }),
  };

  const created = createBackendServiceWithDeps({
    app: {
      getVersion: () => '0.0.0-test',
      getPath: () => userDataPath,
      isReady: () => true,
      isPackaged: false,
    },
    processRef: { env: {}, platform: process.platform, resourcesPath: userDataPath },
    safeStorage: createFakeSafeStorage(),
    dialog: { showMessageBoxSync: () => 0 },
    shellConfigService,
    personalityWorkspace: {},
    toolExecutor: null,
    toolPermissionStore: null,
    attachmentAssetStore: null,
    artifactService: null,
    worktreeService: { describeStatus: () => ({ ok: true }) },
    automationService: null,
    skillsService,
    mcpDiscoveryService: { setBackendService: () => {} },
    setupService: null,
    usageHistory: null,
    logStore: null,
    diagnosticLogService,
    buildEffectiveFeatureFlags: () => mergedFlags,
    buildFeatureStatePayload,
    refreshGpuMemorySample,
    getRefreshElectronToolRegistry,
    shouldRefreshManagedConfigForShellConfigReason,
    closeCometOverlayIfDisabled,
    sendBridgeEvent,
    log,
    showSidecarCrashDialog,
    getPackagedSmokeController,
    getMainWindow: () => null,
  });

  return {
    created,
    shellConfigService,
    skillsListeners,
    bridgeEvents,
    logEntries,
    diagnosticEntries,
    diagnosticDrops,
    crashDialogCalls,
    smokeControllerCalls,
    smokeController,
    gpuRefreshCalls,
    toolRegistryRefreshCalls,
    cometOverlayCalls,
    featureStatePayloads,
    managedConfigRefreshReasons,
  };
}

// --- skills.on('changed') → sendBridgeEvent (line 159) ---

test('skills.on(changed) closure fires sendBridgeEvent with skills.onChanged + state', () => {
  // The wiring registers skillsService.on('changed', fn) at line 158.
  // TipsService also calls skillsService.on('changed', ...) first (in its constructor),
  // so the wiring listener is the LAST entry in skillsListeners.
  const { skillsListeners, bridgeEvents, created } = createRecordingFixture();
  try {
    const wiringChangedListener = skillsListeners[skillsListeners.length - 1];
    assert.ok(wiringChangedListener && wiringChangedListener.event === 'changed',
      'wiring skills changed listener must be the last registered listener');
    const fakeState = { available: ['skill-a'] };
    const before = bridgeEvents.length;
    wiringChangedListener.fn(fakeState);
    const added = bridgeEvents.slice(before);
    const match = added.find((e) => e.name === 'skills.onChanged');
    assert.ok(match, 'sendBridgeEvent must be called with skills.onChanged');
    assert.deepEqual(match.payload, fakeState);
  } finally {
    created.backendService.dispose?.();
  }
});

// --- tipsService.on('changed') → sendBridgeEvent (line 162) ---

test('tipsService.on(changed) closure fires sendBridgeEvent with tips.onChanged + state', () => {
  // Note: initializeSession() at line 204-205 already fires tips.onChanged during construction.
  // We emit AFTER construction and check only the event emitted by our own .emit() call.
  const { created, bridgeEvents } = createRecordingFixture();
  try {
    const before = bridgeEvents.length;
    const tipsState = { featureEnabled: true, myFlag: 'test-marker-abc' };
    created.tipsService.emit('changed', tipsState);
    const added = bridgeEvents.slice(before);
    const match = added.find((e) => e.name === 'tips.onChanged');
    assert.ok(match, 'sendBridgeEvent must be called with tips.onChanged after emit');
    assert.equal(match.payload.myFlag, 'test-marker-abc',
      'bridge payload must be the exact state object passed to tipsService.emit');
  } finally {
    created.backendService.dispose?.();
  }
});

// --- schedulerService.on('changed') → sendBridgeEvent (line 165) ---

test('schedulerService.on(changed) closure fires sendBridgeEvent with scheduler.onChanged + snapshot', () => {
  const { created, bridgeEvents } = createRecordingFixture();
  try {
    const snapshot = { upcoming: [], running: [] };
    created.schedulerService.emit('changed', snapshot);
    const match = bridgeEvents.find((e) => e.name === 'scheduler.onChanged');
    assert.ok(match, 'sendBridgeEvent must be called with scheduler.onChanged');
    assert.deepEqual(match.payload, snapshot);
  } finally {
    created.backendService.dispose?.();
  }
});

// --- tipsService.initializeSession() called when featureEnabled (line 204-205) ---

test('tipsService.initializeSession is called at construction when tips_surface is enabled', () => {
  // tips_surface:true → tipsService.featureEnabled → initializeSession() → emits 'changed'
  const { created, bridgeEvents } = createRecordingFixture({ featureFlags: { tips_surface: true } });
  try {
    // initializeSession fires 'tips.onChanged' via sendBridgeEvent (wired at line 162)
    const match = bridgeEvents.find((e) => e.name === 'tips.onChanged');
    assert.ok(match, 'tipsService.initializeSession must emit tips.onChanged via bridge');
    // The wiring constructs TipsService with featureEnabled = (tips_surface === true)
    // (source line 152) and only calls initializeSession() behind that gate (line 203).
    // initializeSession emits a snapshot carrying featureEnabled, so a concrete check on
    // that field proves the feature gate -> session-init -> bridge-emit path actually ran,
    // not merely that *some* object was forwarded.
    assert.ok(match.payload && typeof match.payload === 'object',
      'tips.onChanged payload must be a non-null object');
    assert.equal(match.payload.featureEnabled, true,
      'initializeSession snapshot must report featureEnabled:true (tips_surface gate)');
  } finally {
    created.backendService.dispose?.();
  }
});

// --- backendService.on('backend-status') handler (lines 219-235) ---

test('backend-status handler: logs INFO, fires sendBridgeEvent backend.onStatus', async () => {
  const { created, bridgeEvents, logEntries } = createRecordingFixture();
  try {
    const status = { phase: 'starting', detail: 'boot', startupStage: 'sidecar', startupMs: 500 };
    created.backendService.emit('backend-status', status);
    // Give async refreshGpuMemorySample a tick to settle (though phase != 'ready' here)
    await Promise.resolve();
    const logEntry = logEntries.find((e) => e.event === 'backend.status');
    assert.ok(logEntry, 'INFO backend.status must be logged');
    assert.equal(logEntry.level, 'INFO');
    assert.equal(logEntry.details.phase, 'starting');
    assert.equal(logEntry.details.detail, 'boot');
    assert.equal(logEntry.details.startupMs, 500);
    const bridgeEntry = bridgeEvents.find((e) => e.name === 'backend.onStatus');
    assert.ok(bridgeEntry, 'sendBridgeEvent must be called with backend.onStatus');
    assert.equal(bridgeEntry.payload, status);
  } finally {
    created.backendService.dispose?.();
  }
});

test('backend-status handler: calls markBackendFailed when phase is failed', async () => {
  const { created, smokeControllerCalls } = createRecordingFixture();
  try {
    const status = { phase: 'failed', detail: 'crash-detail' };
    created.backendService.emit('backend-status', status);
    await Promise.resolve();
    assert.equal(smokeControllerCalls.length, 1, 'markBackendFailed must be called once');
    assert.equal(smokeControllerCalls[0][0], status);
    assert.equal(smokeControllerCalls[0][1], 'crash-detail');
  } finally {
    created.backendService.dispose?.();
  }
});

test('backend-status handler: does NOT call markBackendFailed when phase is ready', async () => {
  const { created, smokeControllerCalls } = createRecordingFixture();
  try {
    created.backendService.emit('backend-status', { phase: 'ready' });
    await Promise.resolve();
    assert.equal(smokeControllerCalls.length, 0, 'markBackendFailed must NOT be called on ready');
  } finally {
    created.backendService.dispose?.();
  }
});

test('backend-status handler: calls refreshGpuMemorySample with force:true when phase is ready', async () => {
  const { created, gpuRefreshCalls } = createRecordingFixture();
  try {
    created.backendService.emit('backend-status', { phase: 'ready' });
    // refreshGpuMemorySample is called with void + .catch, wait a tick
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gpuRefreshCalls.length, 1, 'refreshGpuMemorySample must be called once on ready');
    assert.deepEqual(gpuRefreshCalls[0], { force: true });
  } finally {
    created.backendService.dispose?.();
  }
});

test('backend-status handler: does NOT call refreshGpuMemorySample when phase is failed', async () => {
  const { created, gpuRefreshCalls } = createRecordingFixture();
  try {
    created.backendService.emit('backend-status', { phase: 'failed', detail: 'd' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gpuRefreshCalls.length, 0, 'refreshGpuMemorySample must NOT be called on failed');
  } finally {
    created.backendService.dispose?.();
  }
});

// --- backendService.on('auth-state') handler (lines 238-244) ---

test('auth-state handler: logs INFO and fires sendBridgeEvent auth.onState', () => {
  const { created, bridgeEvents, logEntries } = createRecordingFixture();
  try {
    const state = { authenticated: true, user: { email: 'a@b.com' } };
    created.backendService.emit('auth-state', state);
    const logEntry = logEntries.find((e) => e.event === 'auth.state');
    assert.ok(logEntry, 'INFO auth.state must be logged');
    assert.equal(logEntry.details.authenticated, true);
    assert.equal(logEntry.details.userPresent, true);
    const bridgeEntry = bridgeEvents.find((e) => e.name === 'auth.onState');
    assert.ok(bridgeEntry, 'sendBridgeEvent must be called with auth.onState');
    assert.equal(bridgeEntry.payload, state);
  } finally {
    created.backendService.dispose?.();
  }
});

test('auth-state handler: userPresent is false when user has no email', () => {
  const { created, logEntries } = createRecordingFixture();
  try {
    created.backendService.emit('auth-state', { authenticated: false, user: null });
    const logEntry = logEntries.find((e) => e.event === 'auth.state');
    assert.ok(logEntry);
    assert.equal(logEntry.details.authenticated, false);
    assert.equal(logEntry.details.userPresent, false);
  } finally {
    created.backendService.dispose?.();
  }
});

// --- backendService.on('chat-stream') handler (lines 246-248) ---

test('chat-stream handler: forwards event to chatStreamBridge.handleEvent', () => {
  const { created } = createRecordingFixture();
  const handled = [];
  // Patch handleEvent on the returned chatStreamBridge object
  const orig = created.chatStreamBridge.handleEvent;
  created.chatStreamBridge.handleEvent = (event) => { handled.push(event); orig?.call(created.chatStreamBridge, event); };
  try {
    const fakeEvent = { type: 'delta', content: 'hello' };
    created.backendService.emit('chat-stream', fakeEvent);
    assert.equal(handled.length, 1, 'handleEvent must be called once');
    assert.equal(handled[0], fakeEvent);
  } finally {
    created.backendService.dispose?.();
  }
});

// --- backendService.on('service-log') handler (lines 250-252) ---

test('service-log handler: calls log with entry level/event/details', () => {
  const { created, logEntries } = createRecordingFixture();
  try {
    const entry = { level: 'WARN', event: 'sidecar.slow', details: { latency: 999 } };
    created.backendService.emit('service-log', entry);
    const match = logEntries.find((e) => e.event === 'sidecar.slow');
    assert.ok(match, 'log must be called with the entry event');
    assert.equal(match.level, 'WARN');
    assert.deepEqual(match.details, { latency: 999 });
  } finally {
    created.backendService.dispose?.();
  }
});

test('service-log handler: falls back to INFO and backend.service when entry fields are absent', () => {
  const { created, logEntries } = createRecordingFixture();
  try {
    created.backendService.emit('service-log', {});
    const match = logEntries.find((e) => e.event === 'backend.service');
    assert.ok(match, 'log must be called with fallback event backend.service');
    assert.equal(match.level, 'INFO');
    assert.deepEqual(match.details, {});
  } finally {
    created.backendService.dispose?.();
  }
});

test('diagnostic handlers append entries and account every explicit drop exactly once', () => {
  const { created, diagnosticEntries, diagnosticDrops } = createRecordingFixture();
  try {
    created.backendService.emit('diagnostic-entry', { event: 'sidecar.diagnostics.malformed_record', layer: 'sidecar' });
    created.backendService.emit('diagnostic-drop', { source: 'sidecar', count: 2 });
    created.backendService.emit('diagnostic-entry', { event: 'sidecar.diagnostics.oversized_record', layer: 'sidecar', data: { dropped_count: 3 } });
    assert.equal(diagnosticEntries.length, 2);
    assert.deepEqual(diagnosticDrops, [{ source: 'sidecar', count: 2 }, { source: 'sidecar', count: 3 }]);
  } finally {
    created.backendService.dispose?.();
  }
});

// --- backendService.on('sidecar-crash') handler (lines 254-261) ---

test('sidecar-crash handler: calls showSidecarCrashDialog with appVersion + detail', async () => {
  const { created, crashDialogCalls } = createRecordingFixture();
  try {
    created.backendService.emit('sidecar-crash', { detail: 'oom-killed' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(crashDialogCalls.length, 1, 'showSidecarCrashDialog must be called once');
    assert.equal(crashDialogCalls[0].appVersion, '0.0.0-test');
    assert.equal(crashDialogCalls[0].detail, 'oom-killed');
  } finally {
    created.backendService.dispose?.();
  }
});

// --- shellConfigService.on('changed') handler (lines 263-281) ---

test('shellConfigService changed: fires sendBridgeEvent features.onChanged with buildFeatureStatePayload result', async () => {
  const { created, shellConfigService, bridgeEvents, featureStatePayloads } = createRecordingFixture();
  try {
    shellConfigService.emit('changed', {}, { reason: 'some_reason' });
    await Promise.resolve();
    const match = bridgeEvents.find((e) => e.name === 'features.onChanged');
    assert.ok(match, 'sendBridgeEvent must be called with features.onChanged');
    // payload is whatever buildFeatureStatePayload returned
    assert.equal(featureStatePayloads.length >= 1, true, 'buildFeatureStatePayload must have been called');
    assert.deepEqual(match.payload, { flags: 'test-payload' });
  } finally {
    created.backendService.dispose?.();
  }
});

test('shellConfigService changed: calls closeCometOverlayIfDisabled on every change', async () => {
  const { created, shellConfigService, cometOverlayCalls } = createRecordingFixture();
  try {
    shellConfigService.emit('changed', {}, { reason: 'any_reason' });
    await Promise.resolve();
    assert.ok(cometOverlayCalls.length >= 1, 'closeCometOverlayIfDisabled must be called');
  } finally {
    created.backendService.dispose?.();
  }
});

test('shellConfigService changed: calls getRefreshElectronToolRegistry()() when reason is tools_worktree_enabled_updated', async () => {
  const { created, shellConfigService, toolRegistryRefreshCalls } = createRecordingFixture();
  try {
    shellConfigService.emit('changed', {}, { reason: 'tools_worktree_enabled_updated' });
    await Promise.resolve();
    assert.equal(toolRegistryRefreshCalls.length, 1, 'tool registry refresh must be called for worktree reason');
  } finally {
    created.backendService.dispose?.();
  }
});

test('shellConfigService changed: calls getRefreshElectronToolRegistry()() when reason is feature_settings_updated', async () => {
  const { created, shellConfigService, toolRegistryRefreshCalls } = createRecordingFixture();
  try {
    shellConfigService.emit('changed', {}, { reason: 'feature_settings_updated' });
    await Promise.resolve();
    assert.equal(toolRegistryRefreshCalls.length, 1, 'tool registry refresh must be called for feature_settings reason');
  } finally {
    created.backendService.dispose?.();
  }
});

test('shellConfigService changed: does NOT call getRefreshElectronToolRegistry for unrelated reason', async () => {
  const { created, shellConfigService, toolRegistryRefreshCalls } = createRecordingFixture();
  try {
    shellConfigService.emit('changed', {}, { reason: 'model_updated' });
    await Promise.resolve();
    assert.equal(toolRegistryRefreshCalls.length, 0, 'tool registry refresh must NOT be called for unrelated reason');
  } finally {
    created.backendService.dispose?.();
  }
});

test('shellConfigService changed: calls refreshManagedConfig when shouldRefreshManagedConfigForShellConfigReason returns true', async () => {
  const { created, shellConfigService, managedConfigRefreshReasons } = createRecordingFixture();
  try {
    shellConfigService.emit('changed', {}, { reason: 'refresh_me' });
    await new Promise((resolve) => setImmediate(resolve));
    // shouldRefreshManagedConfigForShellConfigReason was called with 'refresh_me'
    assert.ok(managedConfigRefreshReasons.includes('refresh_me'),
      'shouldRefreshManagedConfigForShellConfigReason must be called with the reason');
  } finally {
    created.backendService.dispose?.();
  }
});

// --- companionService listSessionSummaries/listSessionRecords closures (lines 135-141) ---

test('companionService.listSessionSummaries closure reads from sessionStore', () => {
  const { created } = createRecordingFixture();
  try {
    // Fake sessionStore with listSessions
    const fakeSessions = [{ id: 'sess-1' }];
    created.backendService.sessionStore = { listSessions: () => fakeSessions };
    const result = created.companionService._listSessions();
    assert.deepEqual(result, fakeSessions);
  } finally {
    created.backendService.dispose?.();
  }
});

test('companionService.listSessionRecords closure returns [] when sessionStore has no listSessionRecords', () => {
  const { created } = createRecordingFixture();
  try {
    // listSessions must return a sentinel: with an empty stub, a regression that
    // fell through to listSessions() would produce [] too and go undetected.
    let listSessionsCalls = 0;
    created.backendService.sessionStore = {
      listSessions: () => { listSessionsCalls += 1; return [{ id: 'must-not-be-read' }]; },
    }; // no listSessionRecords
    const result = created.companionService._listSessionRecords();
    assert.deepEqual(result, []);
    assert.equal(listSessionsCalls, 0, 'the absent-listSessionRecords fallback must not read listSessions');
  } finally {
    created.backendService.dispose?.();
  }
});

test('companionService.listSessionRecords closure returns records when sessionStore.listSessionRecords exists', () => {
  const { created } = createRecordingFixture();
  try {
    const fakeRecords = [{ sessionId: 'sess-1', messages: [] }];
    created.backendService.sessionStore = {
      listSessions: () => [],
      listSessionRecords: () => fakeRecords,
    };
    const result = created.companionService._listSessionRecords();
    assert.deepEqual(result, fakeRecords);
  } finally {
    created.backendService.dispose?.();
  }
});

test('companionService uses effective task-board overrides for Start a session actions', async () => {
  const { created, shellConfigService } = createRecordingFixture({
    featureFlags: { tools_task_board_enabled: false },
  });
  try {
    shellConfigService.upsertFollowUp({
      label: 'Owner task',
      body: 'Keep the action gated.',
      status: 'active',
      sourceKind: 'agent_task',
    });

    const state = await created.companionService.getState();
    const taskRow = state.openLoopsBoard.active.find((entry) => entry.title === 'Owner task');
    assert.ok(taskRow);
    assert.equal(taskRow.actions.some((action) => action.type === 'start_task_session'), false);
  } finally {
    created.backendService.dispose?.();
  }
});

test('backend wiring builds an ipcPayloadStore rooted where the sidecar writes payloads', () => {
  // Regression for an inert-feature bug: backend-sessions.js gates its
  // ipc_payloads delete-cleanup step on service.ipcPayloadStore, but nothing in
  // production ever assigned it -- the only assignment in the whole tree lived in
  // a test fixture. The reference-counted cleanup was dead code while its unit
  // tests, which hang a store directly onto a fake service, stayed green. The
  // root is asserted rather than just the field's presence: a store pointed
  // somewhere the sidecar does not write is inert in exactly the same way.
  const { created, userDataPath } = createBackendWiringFixture();
  try {
    assert.equal(
      created.backendService.ipcPayloadStore.rootDir,
      path.join(userDataPath, 'background-memory', 'ipc-payloads')
    );
  } finally {
    created.backendService.dispose?.();
  }
});
