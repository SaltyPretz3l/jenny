const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadWithElectronMock(modulePath, electronMock) {
  const resolvedPath = require.resolve(modulePath);
  const originalLoad = Module._load;
  delete require.cache[resolvedPath];
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return electronMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(resolvedPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolvedPath];
  }
}

function createElectronMock() {
  return {
    app: {
      getPath: () => path.join(process.cwd(), 'tmp'),
      // Real Electron has setPath, and main.js calls it when JENNY_USER_DATA_DIR
      // is set -- which dev:agent, smoke:gui and capture-ui all export. getPath
      // stays fixed on purpose: nothing here tests profile overriding.
      setPath() {},
      whenReady: () => ({ then() {} }),
      on() {},
      quit() {},
      exit() {},
      setAppUserModelId() {},
    },
    BrowserWindow: {
      getAllWindows: () => [],
    },
    clipboard: { writeText() {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    globalShortcut: { register() { return false; }, unregister() {} },
    ipcMain: { handle() {} },
    nativeImage: {},
    powerMonitor: { on() {}, removeListener() {} },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value) => Buffer.from(String(value || ''), 'utf8'),
      decryptString: (buffer) => Buffer.from(buffer).toString('utf8'),
    },
    shell: { openPath() {}, showItemInFolder() {} },
  };
}

test('workspace IPC handlers delegate round-trip state through shell config service', async () => {
  const handlers = new Map();
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());
  const shellConfigService = {
    getWorkspaceState() {
      return { activeSessionId: 'sess_1', openSessionIds: ['sess_1'] };
    },
    updateWorkspaceState(patch) {
      return {
        activeSessionId: Object.prototype.hasOwnProperty.call(patch, 'activeSessionId')
          ? patch.activeSessionId
          : 'sess_1',
        openSessionIds: Object.prototype.hasOwnProperty.call(patch, 'openSessionIds')
          ? patch.openSessionIds
          : ['sess_1'],
      };
    },
  };

  mainModule.registerWorkspaceIpcHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, shellConfigService);

  assert.deepEqual(await handlers.get('workspace:get-state')(), {
    activeSessionId: 'sess_1',
    openSessionIds: ['sess_1'],
  });
  assert.deepEqual(await handlers.get('workspace:update-state')(null, {
    activeSessionId: null,
    openSessionIds: ['sess_2', 'sess_3'],
  }), {
    activeSessionId: null,
    openSessionIds: ['sess_2', 'sess_3'],
  });
});

test('workspace-root IPC exposes two-phase transitions and legacy aliases stay prepare-only', async () => {
  const handlers = new Map();
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());
  const calls = [];
  const context = { rootPath: 'G:/workspace/project', rootId: 'root-1', generation: 4, phase: 'ready' };

  mainModule.registerWorkspaceRootIpcHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, {
    getState() {
      return {
        workspaceRoot: 'G:/workspace/project',
        workspaceRootStatus: {
          state: 'ready',
          message: 'Workspace root is configured.',
        },
      };
    },
    captureContext() {
      calls.push('capture');
      return context;
    },
    prepareChoose() {
      calls.push('prepareChoose');
      return { prepared: true, transitionId: 'transition-1' };
    },
    prepareClear() {
      calls.push('prepareClear');
      return { prepared: true, transitionId: 'transition-2' };
    },
    commit(payload) {
      calls.push(['commit', payload]);
      return { committed: true, context };
    },
    cancel(payload) {
      calls.push(['cancel', payload]);
      return { canceled: true, context };
    },
  });

  assert.deepEqual(await handlers.get('workspace-root:get-state')(), {
    workspaceRoot: 'G:/workspace/project',
    workspaceRootStatus: {
      state: 'ready',
      message: 'Workspace root is configured.',
    },
  });
  assert.deepEqual(await handlers.get('workspace-root:capture-context')(), context);
  assert.deepEqual(await handlers.get('workspace-root:prepare-choose')(), {
    prepared: true,
    transitionId: 'transition-1',
  });
  assert.deepEqual(await handlers.get('workspace-root:prepare-clear')(), {
    prepared: true,
    transitionId: 'transition-2',
  });
  assert.deepEqual(await handlers.get('workspace-root:commit')(null, {
    transitionId: 'transition-1',
    terminateProcesses: true,
  }), { committed: true, context });
  assert.deepEqual(await handlers.get('workspace-root:cancel')(null, {
    transitionId: 'transition-2',
  }), { canceled: true, context });
  assert.deepEqual(calls, [
    'capture',
    'prepareChoose',
    'prepareClear',
    ['commit', { transitionId: 'transition-1', terminateProcesses: true }],
    ['cancel', { transitionId: 'transition-2' }],
  ]);
});

test('workspace IDE debounced updates require the exact ready root context', async () => {
  const handlers = new Map();
  const { registerWorkspaceIpcHandlers } = require('../services/main/ipc-handler-registration');
  let context = { rootPath: 'G:/one', rootId: 'root_111111111111111111111111', generation: 3, phase: 'ready' };
  const writes = [];
  let touches = 0;
  const state = {
    openTabs: [{ path: 'one.txt' }],
    activeTabPath: 'one.txt',
    expandedDirs: [],
    activeStageSurface: 'editor',
    previewPath: '',
    fontSize: 13,
  };
  const configService = {
    getWorkspaceState: () => ({}),
    updateWorkspaceState: () => ({}),
    touchWorkspaceIdeRoot: () => {
      touches += 1;
      return { ...state };
    },
    getWorkspaceIdeState: () => ({ ...state }),
    getWorkspaceIdeStore: () => ({ preferences: { fontSize: state.fontSize } }),
    updateWorkspaceIdePreferences: (patch) => ({ ...state, ...patch }),
    updateWorkspaceIdeState: (rootId, patch) => {
      writes.push([rootId, patch]);
      Object.assign(state, patch);
      return { ...state };
    },
  };
  registerWorkspaceIpcHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  }, configService, { getRootContext: () => context });

  const update = handlers.get('workspace-ide:update-state');
  const preferenceUpdate = await handlers.get('workspace-ide:update-settings')(null, { fontSize: 18 });
  assert.equal(preferenceUpdate.updated, true);
  assert.equal(preferenceUpdate.fontSize, 18);
  const stale = await update(null, {
    expectedRootId: context.rootId,
    expectedGeneration: 2,
    rootState: { openTabs: [{ path: 'stale.txt' }] },
  });
  assert.equal(stale.updated, false);
  assert.equal(stale.code, 'stale_root_context');
  assert.deepEqual(writes, []);

  const accepted = await update(null, {
    expectedRootId: context.rootId,
    expectedGeneration: 3,
    preferences: { fontSize: 16, openTabs: [{ path: 'wrong-bucket.txt' }] },
    rootState: {
      openTabs: [{ path: 'fresh.txt' }],
      activeTabPath: 'fresh.txt',
      fontSize: 40,
    },
  });
  assert.equal(accepted.updated, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], context.rootId);
  assert.equal(writes[0][1].fontSize, 16);
  assert.deepEqual(writes[0][1].openTabs, [{ path: 'fresh.txt' }]);

  const malformedPayloads = [
    null,
    [],
    { expectedGeneration: 3 },
    { expectedRootId: context.rootId, expectedGeneration: '3' },
    { expectedRootId: context.rootId, expectedGeneration: 3.5 },
    { expectedRootId: context.rootId, expectedGeneration: -1 },
    { expectedRootId: context.rootId, expectedGeneration: 3, preferences: [] },
    { expectedRootId: context.rootId, expectedGeneration: 3, rootState: [] },
  ];
  for (const payload of malformedPayloads) {
    const invalid = await update(null, payload);
    assert.equal(invalid.updated, false);
    assert.equal(invalid.code, 'invalid_payload');
  }
  assert.equal(writes.length, 1);

  context = { ...context, generation: 4, phase: 'transitioning' };
  const transitioning = await update(null, {
    expectedRootId: context.rootId,
    expectedGeneration: 4,
    rootState: { openTabs: [] },
  });
  assert.equal(transitioning.updated, false);
  assert.equal(transitioning.code, 'root_transitioning');
  assert.equal(writes.length, 1);

  const duringTransition = await handlers.get('workspace-ide:get-state')();
  assert.equal(duringTransition.ok, false);
  assert.equal(duringTransition.code, 'root_transitioning');
  assert.equal(touches, 0);

  context = { ...context, phase: 'error' };
  const duringRecovery = await handlers.get('workspace-ide:get-state')();
  assert.equal(duringRecovery.ok, false);
  assert.equal(duringRecovery.code, 'root_recovery_required');
  assert.equal(touches, 0);
});

test('workspace IDE IPC reports a future-schema write refusal and preserves bytes', async () => {
  const handlers = new Map();
  const { registerWorkspaceIpcHandlers } = require('../services/main/ipc-handler-registration');
  const { CONFIG_VERSION, ShellConfigService } = require('../services/shell-config-service');
  const { workspaceRootId } = require('../services/workspace-root-identity');
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-workspace-ipc-future-'));
  const workspaceRoot = 'G:/future-workspace';
  const rootId = workspaceRootId(workspaceRoot);
  const configPath = path.join(userDataPath, 'shell-config.json');
  const rawText = JSON.stringify({
    version: CONFIG_VERSION + 1,
    toolsWorkspaceRoot: workspaceRoot,
    workspaceIde: {
      preferences: { fontSize: 13 },
      rootLru: [rootId],
      roots: { [rootId]: { openTabs: ['before.txt'] } },
    },
  }, null, 2);
  fs.writeFileSync(configPath, rawText);
  try {
    const configService = new ShellConfigService({ userDataPath, env: {} });
    const context = {
      rootPath: workspaceRoot,
      rootId,
      generation: 8,
      phase: 'ready',
    };
    registerWorkspaceIpcHandlers({
      handle(channel, handler) { handlers.set(channel, handler); },
    }, configService, { getRootContext: () => context });

    const result = await handlers.get('workspace-ide:update-state')(null, {
      expectedRootId: rootId,
      expectedGeneration: 8,
      preferences: { fontSize: 20 },
      rootState: { openTabs: [{ path: 'after.txt' }] },
    });

    assert.equal(result.updated, false);
    assert.equal(result.code, 'config_write_blocked');
    assert.equal(configService.getWorkspaceIdeStore().preferences.fontSize, 13);
    assert.equal(fs.readFileSync(configPath, 'utf8'), rawText);
    const preferenceResult = await handlers.get('workspace-ide:update-settings')(null, { fontSize: 20 });
    assert.equal(preferenceResult.updated, false);
    assert.equal(preferenceResult.code, 'config_write_blocked');
  } finally {
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('auxiliary IPC handlers delegate chat UI zoom state through shell config service', async () => {
  const handlers = new Map();
  const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
  const chatUiState = { zoomPercent: 110 };
  const shellConfigService = {
    getChatUiState() {
      return { ...chatUiState };
    },
    updateChatUiSettings(patch) {
      chatUiState.zoomPercent = Number(patch?.zoomPercent || 100);
      return { ...chatUiState };
    },
  };

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload() { return {}; },
    shellConfigService,
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions() { return {}; },
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch() { return {}; },
    dialog: {},
    getMainWindow() { return null; },
    chooseWorkspaceRoot() { return {}; },
    clearWorkspaceRoot() { return {}; },
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
    speechService: {},
  });

  assert.deepEqual(await handlers.get('chat-ui:get-state')(), {
    zoomPercent: 110,
  });
  assert.deepEqual(await handlers.get('chat-ui:update-settings')(null, { zoomPercent: 125 }), {
    zoomPercent: 125,
  });
});

test('auxiliary IPC handlers persist app zoom and apply it live to the requesting frame', async () => {
  const handlers = new Map();
  const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
  const windowUiState = { appZoomPercent: 100 };
  const shellConfigService = {
    getWindowUiState() {
      return { ...windowUiState };
    },
    updateWindowUiSettings(patch) {
      // Mimic the real clamp/step (80–150, step 5) just enough for the assert.
      const raw = Number(patch?.appZoomPercent || 100);
      windowUiState.appZoomPercent = Math.min(150, Math.max(80, raw));
      return { ...windowUiState };
    },
  };

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload() { return {}; },
    shellConfigService,
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions() { return {}; },
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch() { return {}; },
    dialog: {},
    getMainWindow() { return null; },
    chooseWorkspaceRoot() { return {}; },
    clearWorkspaceRoot() { return {}; },
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
    speechService: {},
  });

  assert.deepEqual(await handlers.get('window-ui:get-state')(), { appZoomPercent: 100 });

  const zoomCalls = [];
  const event = { sender: { setZoomFactor(factor) { zoomCalls.push(factor); } } };
  const result = await handlers.get('window-ui:update-settings')(event, { appZoomPercent: 125 });
  assert.deepEqual(result, { appZoomPercent: 125 });
  assert.deepEqual(zoomCalls, [1.25]);
});

test('auxiliary artifact IPC handlers preserve structured artifact error codes', async () => {
  const handlers = new Map();
  const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
  const { ArtifactWorkspaceError, ARTIFACT_ERROR_CODES } = require('../services/artifact-workspace-errors');

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {
      async readArtifact() {
        throw new ArtifactWorkspaceError(
          ARTIFACT_ERROR_CODES.NOT_FOUND,
          'Artifact not found.'
        );
      },
    },
    backendService: {},
    getProactiveStatePayload() { return {}; },
    shellConfigService: {},
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions() { return {}; },
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch() { return {}; },
    dialog: {},
    getMainWindow() { return null; },
    chooseWorkspaceRoot() { return {}; },
    clearWorkspaceRoot() { return {}; },
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
    speechService: {},
  });

  await assert.rejects(
    () => handlers.get('artifacts:read')(null, 'session-1', 'missing-artifact'),
    (error) => error.code === ARTIFACT_ERROR_CODES.NOT_FOUND
  );
});

test('auxiliary proactive reminder IPC rejects over-limit reminder payloads with CMP code', async () => {
  const handlers = new Map();
  const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
  const { PROACTIVE_ERROR_CODES } = require('../services/backend/error-codes');

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload() { return {}; },
    shellConfigService: {
      getState() {
        return {
          proactive: {
            reminders: [],
          },
        };
      },
      upsertReminder() {
        throw new Error('service should not receive invalid reminder');
      },
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions() { return {}; },
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch() { return {}; },
    dialog: {},
    getMainWindow() { return null; },
    chooseWorkspaceRoot() { return {}; },
    clearWorkspaceRoot() { return {}; },
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
    speechService: {},
  });

  assert.throws(
    () => handlers.get('proactive:upsert-reminder')(null, {
      label: 'L'.repeat(201),
      prompt: 'Prompt',
      scheduleType: 'daily_at',
      dailyAt: '09:00',
    }),
    (error) => error.code === PROACTIVE_ERROR_CODES.REMINDER_INVALID
  );
});

test('auxiliary attachment prepare only forwards workspace-root files', async () => {
  const handlers = new Map();
  const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
  const { isChildPath } = require('../services/backend/path-utils');
  const workspaceRoot = path.resolve('G:/workspace/project');
  const homeFile = path.resolve(process.env.USERPROFILE || process.cwd(), '.ssh', 'id_rsa');
  const workspaceFile = path.join(workspaceRoot, 'notes.txt');
  let preparedPaths = [];

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload() { return {}; },
    shellConfigService: {
      getState() {
        return { toolsWorkspaceRoot: workspaceRoot };
      },
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions() { return {}; },
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch() { return {}; },
    dialog: {},
    getMainWindow() { return null; },
    chooseWorkspaceRoot() { return {}; },
    clearWorkspaceRoot() { return {}; },
    prepareAttachmentEntries(filePaths) {
      preparedPaths = filePaths;
      return { accepted: filePaths, rejected: [] };
    },
    attachmentAssetStore: {},
    processRef: process,
    os: require('os'),
    isChildPath,
    clipboard: {},
    log() {},
    getMainLifecycle() { return null; },
    toolExecutor: {},
    toolPermissionStore: {},
    usageHistory: {},
    speechService: {},
  });

  const result = await handlers.get('attachments:prepare')(null, [homeFile, workspaceFile]);

  assert.deepEqual(preparedPaths, [workspaceFile]);
  assert.deepEqual(result.accepted, [workspaceFile]);
});

function registerToolsListHandler({ backendService, registryTools = [] }) {
  const handlers = new Map();
  const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');

  registerAuxiliaryIpcHandlers({
    ipcMainLike: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    personalityWorkspace: {},
    artifactService: {},
    backendService,
    getProactiveStatePayload() { return {}; },
    shellConfigService: {
      getState() { return {}; },
    },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions() { return {}; },
    offlineIntelligenceService: {},
    applyFeatureSettingsPatch() { return {}; },
    dialog: {},
    getMainWindow() { return null; },
    chooseWorkspaceRoot() { return {}; },
    clearWorkspaceRoot() { return {}; },
    prepareAttachmentEntries() { return {}; },
    attachmentAssetStore: {},
    processRef: process,
    os: require('os'),
    isChildPath() { return false; },
    clipboard: {},
    log() {},
    getMainLifecycle() { return null; },
    toolExecutor: {
      registry: {
        getAllTools() {
          return registryTools;
        },
      },
    },
    toolPermissionStore: {},
    usageHistory: {},
    speechService: {},
  });

  return handlers.get('tools:list');
}

test('tools list includes managed sidecar-only availability statuses', async () => {
  const listTools = registerToolsListHandler({
    backendService: {
      currentStatus: {
        tools_status: {
          read_file: {
            available: false,
            reason: 'workspace requirement missing',
            tool_family: 'filesystem',
          },
          web_search: {
            available: true,
            reason: '',
            tool_family: 'web',
          },
          list_dir: {
            available: true,
            reason: '',
            tool_family: 'filesystem',
          },
        },
      },
    },
    registryTools: [{
      name: 'read_file',
      description: 'Read file',
      readOnly: true,
      category: 'builtin',
    }],
  });

  const tools = await listTools();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get('read_file').available, false);
  assert.equal(byName.get('read_file').reason, 'workspace requirement missing');
  assert.equal(byName.get('web_search').available, true);
  assert.equal(byName.get('web_search').category, 'web');
  assert.equal(byName.get('list_dir').available, true);
  assert.equal(byName.get('list_dir').category, 'filesystem');
});

test('tools list fails closed when managed tool status has not been reported', async () => {
  const listTools = registerToolsListHandler({
    backendService: {
      currentStatus: null,
      getBackendStatus() {
        return { phase: 'ready' };
      },
    },
    registryTools: [{
      name: 'read_file',
      description: 'Read file',
      readOnly: true,
      category: 'builtin',
    }],
  });

  const tools = await listTools();

  assert.deepEqual(tools, [
    {
      name: 'read_file',
      description: 'Read file',
      readOnly: true,
      category: 'builtin',
      available: false,
      reason: 'Tool availability has not been reported yet.',
    },
  ]);
});

test('tools list fails closed while managed backend phase is not ready', async () => {
  const listTools = registerToolsListHandler({
    backendService: {
      currentStatus: {
        tools_status: {
          web_search: {
            available: true,
            reason: '',
            tool_family: 'web',
          },
        },
      },
      getBackendStatus() {
        return { phase: 'failed' };
      },
    },
  });

  const tools = await listTools();

  assert.deepEqual(tools, [
    {
      name: 'web_search',
      description: '',
      readOnly: false,
      category: 'web',
      available: false,
      reason: 'Managed sidecar is not ready yet.',
    },
  ]);
});

test('main process auto-start detection enables Electron runtime and respects skip override', () => {
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());

  assert.equal(mainModule.shouldAutoStartMainProcess({
    hasElectronRuntime: false,
    isMainModule: false,
    env: {},
  }), false);

  assert.equal(mainModule.shouldAutoStartMainProcess({
    hasElectronRuntime: true,
    isMainModule: false,
    env: {},
  }), true);

  assert.equal(mainModule.shouldAutoStartMainProcess({
    hasElectronRuntime: true,
    isMainModule: true,
    env: { JENNY_SKIP_MAIN_AUTOSTART: '1' },
  }), false);
});

test('main shell config refresh reasons exclude model-tuning transactions with their own acknowledgement', () => {
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());

  assert.equal(mainModule.shouldRefreshManagedConfigForShellConfigReason('feature_settings_updated'), true);
  assert.equal(mainModule.shouldRefreshManagedConfigForShellConfigReason('workspace_root_updated'), true);
  assert.equal(mainModule.shouldRefreshManagedConfigForShellConfigReason('model_tuning_updated'), false);
  assert.equal(mainModule.shouldRefreshManagedConfigForShellConfigReason('model_tuning_legacy_claimed'), false);
  assert.equal(mainModule.shouldRefreshManagedConfigForShellConfigReason('chunk_inactivity_seconds_updated'), false);
  assert.equal(mainModule.shouldRefreshManagedConfigForShellConfigReason('context_length_tuning_updated'), false);
  assert.equal(mainModule.shouldRefreshManagedConfigForShellConfigReason('compaction_tuning_updated'), false);
  assert.equal(mainModule.shouldRefreshManagedConfigForShellConfigReason('unrelated_change'), false);
});

test('comet overlay enablement reads the current feature flag state instead of a stale startup snapshot', () => {
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());

  assert.equal(mainModule.isCometOverlayEnabled({
    configService: {
      getState() {
        return {
          featureOverrides: {
            comet_overlay: true,
          },
        };
      },
    },
    env: {},
  }), true);

  assert.equal(mainModule.isCometOverlayEnabled({
    configService: {
      getState() {
        return {
          featureOverrides: {
            comet_overlay: false,
          },
        };
      },
    },
    env: {},
  }), false);
});

test('comet overlay payload normalization clamps unexpected values at the main-process bridge', () => {
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());

  assert.deepEqual(
    mainModule.normalizeCometOverlayPresencePayload({
      state: 'ALERT',
      phaseKind: 'approval_wait',
      terminalStatus: 'TIMEOUT',
      terminalSubcode: 'provider',
      ignored: 'value',
    }),
    {
      state: 'alert',
      phaseKind: 'approval_wait',
      terminalStatus: 'timeout',
      terminalSubcode: 'provider',
    }
  );

  assert.deepEqual(
    mainModule.normalizeCometOverlayPresencePayload({
      state: 'wild-state',
      phaseKind: 'tool<script>',
      terminalStatus: 'mystery',
      terminalSubcode: 'x'.repeat(200),
    }),
    {
      state: 'idle',
      phaseKind: '',
      terminalStatus: '',
      terminalSubcode: 'x'.repeat(64),
    }
  );
});

test('comet overlay toggle disposes an existing overlay even after the feature flag is disabled', () => {
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());
  let disposed = 0;
  const overlayRef = {
    window: {
      isDestroyed: () => false,
    },
    dispose() {
      disposed += 1;
    },
  };

  const nextOverlayRef = mainModule.handleCometOverlayToggle({
    data: { enabled: false },
    mainWindowRef: { isDestroyed: () => false },
    currentOverlayRef: overlayRef,
    isOverlayEnabled: () => false,
    createOverlay() {
      throw new Error('overlay should not be created while disabling');
    },
  });

  assert.equal(disposed, 1);
  assert.equal(nextOverlayRef, null);
});

test('comet overlay toggle creates an overlay only when requested and enabled', () => {
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());
  const created = [];

  const nextOverlayRef = mainModule.handleCometOverlayToggle({
    data: { enabled: true },
    mainWindowRef: { isDestroyed: () => false },
    currentOverlayRef: null,
    isOverlayEnabled: () => true,
    createOverlay(ownerWindow, options) {
      const overlayRef = {
        ownerWindow,
        options,
        window: { isDestroyed: () => false },
        dispose() {},
      };
      created.push(overlayRef);
      return overlayRef;
    },
  });

  assert.equal(created.length, 1);
  assert.equal(nextOverlayRef, created[0]);
});
