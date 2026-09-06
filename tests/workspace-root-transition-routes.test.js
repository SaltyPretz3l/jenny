'use strict';

// Route-level coverage for the coordinator-owned workspace-root transaction:
// canonical and proactive/compat entry points may prepare a target, while only
// explicit commit can mutate the root and participant blockers remain typed.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerMainIpcHandlers } = require('../services/main/ipc-handler-registration');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const {
  createWorkspaceRootStub,
  initializeWorkspaceRootHarnessState,
} = require('./helpers/renderer-shell-harness-workspace-root');

const invokeChannel = (methodPath) => getBridgeChannel(methodPath, 'invoke');

// ---------------------------------------------------------------------------
// Canonical route: workspaceRoot.prepareChoose / workspaceRoot.prepareClear
// (services/main/ipc-handler-registration.js registerMainIpcHandlers)
// ---------------------------------------------------------------------------

function createFakeIpcMain() {
  const invoke = new Map();
  const send = new Map();
  return {
    handle(channel, handler) {
      invoke.set(channel, handler);
    },
    on(channel, handler) {
      send.set(channel, handler);
    },
    invoke,
    send,
  };
}

function createFakeShellConfigService(overrides = {}) {
  let workspaceRoot = '';
  const store = {
    getWorkspaceState: () => ({}),
    updateWorkspaceState: () => ({}),
    getWorkspaceIdeState: () => ({}),
    updateWorkspaceIdeState: () => ({}),
    getToolsWorkspaceRoot: () => workspaceRoot,
    getState: () => ({ toolsWorkspaceRoot: workspaceRoot }),
    getWorkspaceRootStatus: () => (workspaceRoot
      ? { state: 'ready', message: 'Workspace root is configured.' }
      : { state: 'missing', message: 'No workspace root is configured yet.' }),
    setToolsWorkspaceRoot: (next) => {
      workspaceRoot = String(next || '');
    },
    clearToolsWorkspaceRoot: () => {
      workspaceRoot = '';
    },
    ...overrides,
  };
  return store;
}

test('renderer workspace-root harness preserves proactive prepare abort flags', async () => {
  const options = {
    proactive: {
      state: {
        toolsWorkspaceRoot: 'G:/current',
        workspaceRootStatus: { state: 'ready' },
      },
      chooseWorkspaceRoot: async () => ({
        canceled: true,
        changed: false,
        toolsWorkspaceRoot: 'G:/next',
      }),
      clearWorkspaceRoot: async () => ({
        canceled: false,
        changed: false,
        toolsWorkspaceRoot: 'G:/next',
      }),
    },
  };
  const state = { companionState: {}, featuresState: {} };
  initializeWorkspaceRootHarnessState(options, state);
  const workspaceRoot = createWorkspaceRootStub(options, state);

  assert.deepEqual(
    await workspaceRoot.prepareChoose(),
    { prepared: false, canceled: true, changed: false },
    'proactive choose cancellation must abort workspace-root preparation'
  );
  assert.deepEqual(
    await workspaceRoot.prepareClear(),
    { prepared: false, canceled: false, changed: false, noop: true },
    'proactive clear changed=false must abort workspace-root preparation'
  );
});

// Minimal full deps object for registerMainIpcHandlers, mirroring
// tests/ipc-handler-registration-dark-paths.test.js's buildDeps helper (kept
// local/inline per that file's own note: it is not exported, and this test
// file must not append to it - see the P0 packet plan's file-touch fence).
function buildMainIpcDeps(overrides = {}) {
  const ipcMain = createFakeIpcMain();
  const shellConfigService = overrides.shellConfigService || createFakeShellConfigService();
  const backendService = new Proxy(
    { sessionStore: {}, attachmentAssetStore: null, shadowStore: {} },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => ({ __method: prop });
      },
    }
  );

  const deps = {
    app: { getPath: () => 'C:/tmp/userData' },
    ipcMain,
    backendService,
    logStore: { list: () => [] },
    updateService: {
      getState: () => ({}), check: () => ({}), download: () => ({}), install: () => ({}), skip: () => ({}),
    },
    personalityWorkspace: {
      getWorkspaceState: () => ({}),
      listFiles: () => [],
      readFile: () => ({}),
      writeFile: () => ({}),
      resetFile: () => ({}),
      openWorkspaceFolder: () => ({}),
    },
    artifactService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService,
    companionService: {},
    skillsService: { getState: () => ({}), updateSettings: () => ({}), openScopeFolder: () => ({}) },
    tipsService: { getState: () => ({}), updateSettings: () => ({}) },
    suggestionCache: {},
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch: () => ({}),
    dialog: {
      showSaveDialog: async () => ({ canceled: true }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    getMainWindow: () => null,
    processRef: process,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    getWindowState: () => null,
    startDeferredServices: () => {},
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    setupService: {},
    ollamaInstallService: {},
    mcpDiscoveryService: {},
    schedulerService: {},
    weatherService: {},
    linkStatusService: {},
    calendarService: {},
    chatStreamBridge: {},
    getStartupAuditConfig: () => ({ enabled: false }),
    createStartupAuditMarkHandler: () => () => ({}),
    createStartupAuditMarksBatchHandler: () => () => ({}),
    refreshGpuMemorySample: async () => null,
    getCurrentSystemStatsPayload: () => ({}),
    buildFeatureStatePayload: () => ({}),
    sendBridgeEvent: () => {},
    workspaceSnapshotStore: null,
    authorizeWorkspaceSender: () => true,
    ...overrides,
  };
  delete deps.shellConfigServiceOverride;
  return { deps, ipcMain, shellConfigService };
}

describe('canonical route: workspaceRoot prepare/commit process recheck', () => {
  test('idle system: choose selects a target without mutating config until commit', async () => {
    const showOpenCalls = [];
    const shellConfigService = createFakeShellConfigService();
    const { deps, ipcMain } = buildMainIpcDeps({
      shellConfigService,
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async (...args) => {
          showOpenCalls.push(args);
          return { canceled: false, filePaths: ['G:/workspace/selected'] };
        },
      },
    });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('workspaceRoot.prepareChoose'));
    const prepared = await handler({});
    assert.equal(showOpenCalls.length, 1, 'idle system must reach the real dialog');
    assert.equal(prepared.prepared, true);
    assert.equal(shellConfigService.getState().toolsWorkspaceRoot, '');
    const commit = ipcMain.invoke.get(invokeChannel('workspaceRoot.commit'));
    const result = await commit({}, { transitionId: prepared.transitionId });
    assert.equal(result.committed, true);
    assert.match(shellConfigService.getState().toolsWorkspaceRoot, /workspace[\\/]selected$/);
  });

  test('active terminal: target selection succeeds but commit is blocked and config stays unchanged', async () => {
    const showOpenCalls = [];
    const shellConfigService = createFakeShellConfigService();
    const { deps, ipcMain } = buildMainIpcDeps({
      shellConfigService,
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async (...args) => {
          showOpenCalls.push(args);
          return { canceled: false, filePaths: ['G:/workspace/selected'] };
        },
      },
    });
    const result0 = registerMainIpcHandlers(deps);
    // White-box: stub the participant signal on the real service instance
    // registerMainIpcHandlers constructed internally; the coordinator reads
    // the live service at commit time.
    result0.workspaceTerminalService.hasSession = () => true;
    const handler = ipcMain.invoke.get(invokeChannel('workspaceRoot.prepareChoose'));
    const prepared = await handler({});
    assert.equal(showOpenCalls.length, 1, 'target selection precedes process recheck');
    const commit = ipcMain.invoke.get(invokeChannel('workspaceRoot.commit'));
    const result = await commit({}, { transitionId: prepared.transitionId });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockers, [{ id: 'workspace_terminal', reason: 'terminal_active' }]);
    assert.equal(result.changed, false);
    assert.equal(shellConfigService.getState().toolsWorkspaceRoot, '', 'root must be unchanged');
  });

  test('active pty session: commit is blocked with pty_active', async () => {
    const shellConfigService = createFakeShellConfigService();
    const { deps, ipcMain } = buildMainIpcDeps({ shellConfigService });
    const result0 = registerMainIpcHandlers(deps);
    result0.workspacePtyService.isRunning = () => true;
    const handler = ipcMain.invoke.get(invokeChannel('workspaceRoot.prepareChoose'));
    deps.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['G:/new'] });
    const prepared = await handler({});
    const commit = ipcMain.invoke.get(invokeChannel('workspaceRoot.commit'));
    const result = await commit({}, { transitionId: prepared.transitionId });
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockers, [{ id: 'workspace_pty', reason: 'pty_active' }]);
  });

  test('active test run: clear prepares but commit is blocked and the config helper never runs', async () => {
    const clearCalls = [];
    const shellConfigService = createFakeShellConfigService({
      clearToolsWorkspaceRoot: () => { clearCalls.push(true); },
    });
    shellConfigService.setToolsWorkspaceRoot('G:/old');
    const { deps, ipcMain } = buildMainIpcDeps({ shellConfigService });
    const result0 = registerMainIpcHandlers(deps);
    result0.workspaceTestRunnerService.getState = () => ({ activeRun: 'run-1' });
    const handler = ipcMain.invoke.get(invokeChannel('workspaceRoot.prepareClear'));
    const prepared = await handler({});
    const commit = ipcMain.invoke.get(invokeChannel('workspaceRoot.commit'));
    const result = await commit({}, { transitionId: prepared.transitionId });
    assert.equal(clearCalls.length, 0, 'blocked clear must never call clearToolsWorkspaceRoot');
    assert.equal(result.blocked, true);
    assert.deepEqual(result.blockers, [
      { id: 'workspace_test_runner', reason: 'test_run_active' },
    ]);
    assert.equal(result.changed, false);
  });

  test('idle system: clear remains non-mutating until explicit commit', async () => {
    const shellConfigService = createFakeShellConfigService();
    shellConfigService.setToolsWorkspaceRoot('G:/old');
    const { deps, ipcMain } = buildMainIpcDeps({ shellConfigService });
    registerMainIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('workspaceRoot.prepareClear'));
    const prepared = await handler({});
    assert.equal(shellConfigService.getState().toolsWorkspaceRoot, 'G:/old');
    const commit = ipcMain.invoke.get(invokeChannel('workspaceRoot.commit'));
    const result = await commit({}, { transitionId: prepared.transitionId });
    assert.equal(result.committed, true);
    assert.equal(shellConfigService.getState().toolsWorkspaceRoot, '');
  });

  test('external broker resolves only after coordinator commit and trusted renderer settlement', async () => {
    const shellConfigService = createFakeShellConfigService();
    const sent = [];
    const { deps, ipcMain } = buildMainIpcDeps({
      shellConfigService,
      getMainWindow: () => ({ isDestroyed: () => false }),
      sendBridgeEvent: (methodPath, payload) => sent.push({ methodPath, payload }),
    });
    const registered = registerMainIpcHandlers(deps);
    const prepared = await registered.workspaceRootCoordinator.prepareTarget('G:/workspace/external');
    const pending = registered.workspaceRootExternalTransitionBroker.requestPreparedTransition({
      prepared,
      mode: 'worktree_select',
    });
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();

    assert.equal(settled, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].methodPath, 'workspaceRoot.onExternalTransitionRequested');
    assert.equal(sent[0].payload.transition_id, prepared.transitionId);

    const commit = ipcMain.invoke.get(invokeChannel('workspaceRoot.commit'));
    const committed = await commit({}, { transitionId: prepared.transitionId });
    assert.equal(committed.committed, true);
    assert.equal(settled, false, 'backend commit alone cannot report tool success');

    const respond = ipcMain.invoke.get(invokeChannel('workspaceRoot.respondExternalTransition'));
    const response = await respond({}, {
      request_id: sent[0].payload.request_id,
      transition_id: prepared.transitionId,
      outcome: {
        committed: true,
        changed: true,
        degraded: false,
        context: {
          root_path: committed.context.rootPath,
          root_id: committed.context.rootId,
          generation: committed.context.generation,
          phase: committed.context.phase,
        },
      },
    });
    assert.deepEqual(response, { accepted: true });
    assert.equal((await pending).committed, true);
    assert.match(shellConfigService.getState().toolsWorkspaceRoot, /workspace[\\/]external$/);
  });
});

// ---------------------------------------------------------------------------
// Proactive/compat route: proactive.chooseWorkspaceRoot / proactive.clearWorkspaceRoot
// (services/auxiliary-ipc-handlers.js registerAuxiliaryIpcHandlers)
// ---------------------------------------------------------------------------

function buildAuxiliaryIpcDeps(overrides = {}) {
  const ipcMain = createFakeIpcMain();
  const deps = {
    ipcMainLike: ipcMain,
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({ toolsWorkspaceRoot: '', workspaceRootStatus: { state: 'missing' } }),
    shellConfigService: {},
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions() { return {}; },
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch() { return {}; },
    dialog: {},
    getMainWindow() { return null; },
    workspaceRootCoordinator: {
      prepareChoose: async () => ({ prepared: true, transitionId: 'proactive-choose' }),
      prepareClear: async () => ({ prepared: true, transitionId: 'proactive-clear' }),
    },
    prepareAttachmentEntries() { return {}; },
    attachmentAssetStore: {},
    processRef: process,
    os: require('os'),
    isChildPath() { return false; },
    clipboard: {},
    log() {},
    getMainLifecycle() { return null; },
    toolExecutor: {},
    toolPermissionStore: {},
    usageHistory: {},
    ...overrides,
  };
  return { deps, ipcMain };
}

describe('proactive route: compatibility methods are prepare-only coordinator aliases', () => {
  test('choose delegates to coordinator prepare without committing', async () => {
    const chooseCalls = [];
    const { deps, ipcMain } = buildAuxiliaryIpcDeps({
      workspaceRootCoordinator: {
        prepareChoose: async () => {
          chooseCalls.push(true);
          return { prepared: true, transitionId: 'choose-1' };
        },
      },
    });
    registerAuxiliaryIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('proactive.chooseWorkspaceRoot'));
    const result = await handler({});
    assert.equal(chooseCalls.length, 1);
    assert.equal(result.prepared, true);
    assert.equal(result.transitionId, 'choose-1');
  });

  test('choose propagates coordinator refusal without invoking any legacy helper', async () => {
    const { deps, ipcMain } = buildAuxiliaryIpcDeps({
      workspaceRootCoordinator: {
        prepareChoose: async () => ({
          prepared: false,
          blocked: true,
          changed: false,
          canceled: false,
          code: 'transition_in_progress',
        }),
      },
    });
    registerAuxiliaryIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('proactive.chooseWorkspaceRoot'));
    const result = await handler({});
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'transition_in_progress');
    assert.equal(result.changed, false);
    assert.equal(result.canceled, false);
  });

  test('missing coordinator fails closed', async () => {
    const { deps, ipcMain } = buildAuxiliaryIpcDeps({
      workspaceRootCoordinator: null,
    });
    registerAuxiliaryIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('proactive.clearWorkspaceRoot'));
    const result = await handler({});
    assert.equal(result.blocked, true);
    assert.equal(result.code, 'workspace_root_coordinator_unavailable');
  });

  test('clear delegates to prepareClear and remains non-mutating', async () => {
    const clearCalls = [];
    const { deps, ipcMain } = buildAuxiliaryIpcDeps({
      workspaceRootCoordinator: {
        prepareClear: async () => {
          clearCalls.push(true);
          return { prepared: true, transitionId: 'clear-1' };
        },
      },
    });
    registerAuxiliaryIpcHandlers(deps);
    const handler = ipcMain.invoke.get(invokeChannel('proactive.clearWorkspaceRoot'));
    const result = await handler({});
    assert.equal(clearCalls.length, 1);
    assert.equal(result.prepared, true);
    assert.equal(result.transitionId, 'clear-1');
  });
});
