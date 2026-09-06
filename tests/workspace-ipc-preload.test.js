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

test('preload exposes workspace IPC helpers on window.jennyShell', async () => {
  const invokes = [];
  let exposedApi = null;
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) {
        exposedApi = value;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      on() {},
      removeListener() {},
    },
  });

  const stateResult = await exposedApi.workspace.getState();
  const updateResult = await exposedApi.workspace.updateState({ activeSessionId: 'sess_9' });
  const clearUsageResult = await exposedApi.usage.clearHistory();

  assert.deepEqual(invokes, [
    { channel: 'workspace:get-state', args: [] },
    { channel: 'workspace:update-state', args: [{ activeSessionId: 'sess_9' }] },
    { channel: 'usage:clear-history', args: [] },
  ]);
  assert.deepEqual(stateResult, { channel: 'workspace:get-state', args: [] });
  assert.deepEqual(updateResult, {
    channel: 'workspace:update-state',
    args: [{ activeSessionId: 'sess_9' }],
  });
  assert.deepEqual(clearUsageResult, { channel: 'usage:clear-history', args: [] });
  assert.equal(exposedApi.cost, undefined);
});

test('preload personality bridge exposes the v3 surface and omits every retired method', () => {
  let exposedApi = null;
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) { exposedApi = value; },
    },
    ipcRenderer: {
      invoke() { return Promise.resolve(null); },
      on() {},
      removeListener() {},
    },
  });

  assert.equal(typeof exposedApi.personality.getState, 'function');
  assert.equal(typeof exposedApi.personality.save, 'function');
  assert.equal(typeof exposedApi.personality.clear, 'function');
  assert.equal(typeof exposedApi.personality.openWorkspaceFolder, 'function');
  assert.equal(typeof exposedApi.memory.contextFiles.getState, 'function');
  assert.equal(typeof exposedApi.memory.contextFiles.writeFile, 'function');
  assert.equal(typeof exposedApi.memory.contextFiles.resetFile, 'function');
  // Retired by personality v3 (per-file reads/writes and the split preview),
  // plus the older preset/bootstrap surface.
  for (const retired of ['getWorkspaceState', 'listFiles', 'readFile', 'writeFile', 'resetFile',
    'getCompiledContext', 'completeBootstrap', 'listPresets', 'applyPreset']) {
    assert.equal(exposedApi.personality[retired], undefined, `personality.${retired} must be gone`);
  }
  assert.equal(exposedApi.memory.contextFiles.readFile, undefined);
});

test('preload exposes workspace-root IPC helpers on window.jennyShell', async () => {
  const invokes = [];
  let exposedApi = null;
  const listeners = new Map();
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) {
        exposedApi = value;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      on(channel, listener) { listeners.set(channel, listener); },
      removeListener(channel, listener) {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    },
  });

  const stateResult = await exposedApi.workspaceRoot.getState();
  const chooseResult = await exposedApi.workspaceRoot.prepareChoose();
  const clearResult = await exposedApi.workspaceRoot.prepareClear();
  const responseResult = await exposedApi.workspaceRoot.respondExternalTransition({
    request_id: 'external-1', transition_id: 'transition-1', outcome: { committed: true },
  });
  const seen = [];
  const unsubscribe = exposedApi.workspaceRoot.onExternalTransitionRequested((payload) => seen.push(payload));
  listeners.get('workspace-root:external-transition-requested')(null, { request_id: 'external-1' });
  unsubscribe();

  assert.deepEqual(invokes, [
    { channel: 'workspace-root:get-state', args: [] },
    { channel: 'workspace-root:prepare-choose', args: [] },
    { channel: 'workspace-root:prepare-clear', args: [] },
    {
      channel: 'workspace-root:respond-external-transition',
      args: [{ request_id: 'external-1', transition_id: 'transition-1', outcome: { committed: true } }],
    },
  ]);
  assert.deepEqual(stateResult, { channel: 'workspace-root:get-state', args: [] });
  assert.deepEqual(chooseResult, { channel: 'workspace-root:prepare-choose', args: [] });
  assert.deepEqual(clearResult, { channel: 'workspace-root:prepare-clear', args: [] });
  assert.deepEqual(responseResult, {
    channel: 'workspace-root:respond-external-transition',
    args: [{ request_id: 'external-1', transition_id: 'transition-1', outcome: { committed: true } }],
  });
  assert.deepEqual(seen, [{ request_id: 'external-1' }]);
  assert.equal(listeners.has('workspace-root:external-transition-requested'), false);
});

test('preload exposes the generation-pinned workspace image reader', async () => {
  const invokes = [];
  let exposedApi = null;
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) { exposedApi = value; },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      on() {},
      removeListener() {},
    },
  });

  const result = await exposedApi.workspaceFs.readImage({ path: 'assets/logo.png' });
  const copyResult = await exposedApi.workspaceFs.copyEntry({
    from: 'notes.txt',
    to: 'notes.txt',
    onCollision: 'auto-rename',
  });
  assert.deepEqual(result, {
    channel: 'workspace-fs:read-image',
    args: [{ path: 'assets/logo.png' }],
  });
  assert.deepEqual(copyResult, {
    channel: 'workspace-fs:copy-entry',
    args: [{ from: 'notes.txt', to: 'notes.txt', onCollision: 'auto-rename' }],
  });
  assert.deepEqual(invokes, [
    {
      channel: 'workspace-fs:read-image',
      args: [{ path: 'assets/logo.png' }],
    },
    {
      channel: 'workspace-fs:copy-entry',
      args: [{ from: 'notes.txt', to: 'notes.txt', onCollision: 'auto-rename' }],
    },
  ]);
});

test('preload exposes external import invokes and progress subscription', async () => {
  const invokes = [];
  const listeners = new Map();
  let exposedApi = null;
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) { exposedApi = value; },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      on(channel, listener) { listeners.set(channel, listener); },
      removeListener(channel, listener) {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      },
    },
  });

  const preview = { sources: ['C:/drop/report.xlsx'] };
  const start = { importId: 'import-1', sources: preview.sources, destination: '' };
  await exposedApi.workspaceFs.previewImport(preview);
  await exposedApi.workspaceFs.importExternal(start);
  await exposedApi.workspaceFs.cancelImport({ importId: 'import-1' });
  const seen = [];
  const unsubscribe = exposedApi.workspaceFs.onImportProgress((payload) => seen.push(payload));
  listeners.get('workspace-fs:import-progress')(null, { import_id: 'import-1' });
  unsubscribe();

  assert.deepEqual(invokes, [
    { channel: 'workspace-fs:preview-import', args: [preview] },
    { channel: 'workspace-fs:import-external', args: [start] },
    { channel: 'workspace-fs:cancel-import', args: [{ importId: 'import-1' }] },
  ]);
  assert.deepEqual(seen, [{ import_id: 'import-1' }]);
  assert.equal(listeners.has('workspace-fs:import-progress'), false);
});

test('preload exposes chat UI IPC helpers on window.jennyShell', async () => {
  const invokes = [];
  let exposedApi = null;
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) {
        exposedApi = value;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      on() {},
      removeListener() {},
    },
  });

  const stateResult = await exposedApi.chatUi.getState();
  const updateResult = await exposedApi.chatUi.updateSettings({ zoomPercent: 120 });

  assert.deepEqual(invokes, [
    { channel: 'chat-ui:get-state', args: [] },
    { channel: 'chat-ui:update-settings', args: [{ zoomPercent: 120 }] },
  ]);
  assert.deepEqual(stateResult, { channel: 'chat-ui:get-state', args: [] });
  assert.deepEqual(updateResult, {
    channel: 'chat-ui:update-settings',
    args: [{ zoomPercent: 120 }],
  });
});

test('preload exposes the audio attachment IPC helper on window.jennyShell', async () => {
  const invokes = [];
  let exposedApi = null;
  const listeners = new Map();
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) {
        exposedApi = value;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel) {
        listeners.delete(channel);
      },
    },
  });

  const audioAsset = await exposedApi.attachments.saveAudioAsset({ bytes: new Uint8Array([1, 2, 3]) });

  assert.deepEqual(audioAsset, {
    channel: 'attachments:save-audio-asset',
    args: [{ bytes: new Uint8Array([1, 2, 3]) }],
  });
});

test('guidance IPC handlers and preload helpers expose skills and tips plumbing', async () => {
  const handlers = new Map();
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());
  const skillService = {
    getState() {
      return { featureEnabled: true, settings: { bundledEnabled: true } };
    },
    updateSettings(patch) {
      return { featureEnabled: true, settings: patch };
    },
    openScopeFolder(scope) {
      return Promise.resolve({ opened: scope });
    },
  };
  const tipsService = {
    getState() {
      return { featureEnabled: true, settings: { enabled: true } };
    },
    updateSettings(patch) {
      return { featureEnabled: true, settings: patch };
    },
  };

  mainModule.registerGuidanceIpcHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, skillService, tipsService);

  assert.deepEqual(await handlers.get('skills:get-state')(), {
    featureEnabled: true,
    settings: { bundledEnabled: true },
  });
  assert.deepEqual(await handlers.get('skills:update-settings')(null, { userEnabled: false }), {
    featureEnabled: true,
    settings: { userEnabled: false },
  });
  assert.deepEqual(await handlers.get('skills:open-scope-folder')(null, 'user'), {
    opened: 'user',
  });
  assert.deepEqual(await handlers.get('tips:get-state')(), {
    featureEnabled: true,
    settings: { enabled: true },
  });
  assert.deepEqual(await handlers.get('tips:update-settings')(null, { enabled: false }), {
    featureEnabled: true,
    settings: { enabled: false },
  });

  const invokes = [];
  let exposedApi = null;
  const listeners = new Map();
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) {
        exposedApi = value;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel) {
        listeners.delete(channel);
      },
    },
  });

  const skillState = await exposedApi.skills.getState();
  const skillsUpdate = await exposedApi.skills.updateSettings({ projectEnabled: false });
  const tipsState = await exposedApi.tips.getState();
  const tipsUpdate = await exposedApi.tips.updateSettings({ enabled: false });
  const unsubscribeSkills = exposedApi.skills.onChanged(() => {});
  const unsubscribe = exposedApi.tips.onChanged(() => {});

  assert.deepEqual(skillState, { channel: 'skills:get-state', args: [] });
  assert.deepEqual(skillsUpdate, {
    channel: 'skills:update-settings',
    args: [{ projectEnabled: false }],
  });
  assert.deepEqual(tipsState, { channel: 'tips:get-state', args: [] });
  assert.deepEqual(tipsUpdate, {
    channel: 'tips:update-settings',
    args: [{ enabled: false }],
  });
  assert.equal(typeof unsubscribeSkills, 'function');
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(listeners.has('skills:changed'), true);
  assert.equal(listeners.has('tips:changed'), true);
});

test('feature IPC handlers and preload helpers expose the consolidated feature settings bridge', async () => {
  const handlers = new Map();
  const mainModule = loadWithElectronMock('../main.js', createElectronMock());
  const payload = {
    tools: {
      web: true,
      mermaid: false,
      imageRead: false,
      pythonRuntime: true,
      todo: false,
    },
    featureFlags: {
      tips_surface: true,
    },
    featureOverrides: {
      tips_surface: true,
    },
    availability: {
      runtime: {
        managedSidecarActive: true,
        windowsOnly: true,
        workspaceRootStatus: {
          state: 'ready',
          message: 'Workspace root is configured.',
        },
      },
      tools: {},
      featureFlags: {},
    },
  };

  mainModule.registerFeatureIpcHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, {
    getState() {
      return payload;
    },
    updateSettings(patch) {
      return {
        ...payload,
        tools: {
          ...payload.tools,
          ...(patch.tools || {}),
        },
        featureOverrides: {
          ...payload.featureOverrides,
          ...(patch.featureOverrides || {}),
        },
      };
    },
  });

  assert.deepEqual(await handlers.get('features:get-state')(), payload);
  assert.deepEqual(
    await handlers.get('features:update-settings')(null, {
      tools: { todo: true },
      featureOverrides: { tips_surface: false },
    }),
    {
      ...payload,
      tools: {
        ...payload.tools,
        todo: true,
      },
      featureOverrides: {
        ...payload.featureOverrides,
        tips_surface: false,
      },
    }
  );

  const invokes = [];
  let exposedApi = null;
  const listeners = new Map();
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) {
        exposedApi = value;
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel) {
        listeners.delete(channel);
      },
    },
  });

  const featureState = await exposedApi.features.getState();
  const featureUpdate = await exposedApi.features.updateSettings({
    tools: { web: false },
    featureOverrides: { tips_surface: false },
  });
  const unsubscribe = exposedApi.features.onChanged(() => {});

  assert.deepEqual(featureState, { channel: 'features:get-state', args: [] });
  assert.deepEqual(featureUpdate, {
    channel: 'features:update-settings',
    args: [{
      tools: { web: false },
      featureOverrides: { tips_surface: false },
    }],
  });
  assert.equal(typeof unsubscribe, 'function');
  assert.equal(listeners.has('features:changed'), true);
});

test('ipc contract helpers build invoke, send, and subscribe bridge methods from one descriptor map', async () => {
  const { createJennyShellBridge } = require('../services/ipc-contract');
  const invokes = [];
  const sends = [];
  const listeners = new Map();
  const bridge = createJennyShellBridge({
    ipcRenderer: {
      invoke(channel, ...args) {
        invokes.push({ channel, args });
        return Promise.resolve({ channel, args });
      },
      send(channel, ...args) {
        sends.push({ channel, args });
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel, listener) {
        if (listeners.get(channel) === listener) {
          listeners.delete(channel);
        }
      },
    },
  });
  const seenPayloads = [];

  const workspaceState = await bridge.workspace.getState();
  bridge.lifecycle.signalReady();
  const unsubscribe = bridge.backend.onStatus((payload) => seenPayloads.push(payload));
  listeners.get('backend:status')(null, { phase: 'ready' });
  unsubscribe();

  assert.deepEqual(workspaceState, {
    channel: 'workspace:get-state',
    args: [],
  });
  assert.deepEqual(invokes, [
    { channel: 'workspace:get-state', args: [] },
  ]);
  assert.deepEqual(sends, [
    { channel: 'renderer:ready', args: [] },
  ]);
  assert.deepEqual(seenPayloads, [
    { phase: 'ready' },
  ]);
  assert.equal(listeners.has('backend:status'), false);
});

test('ipc contract invoke registration validates bridge paths and registers canonical channels', async () => {
  const { registerIpcInvokeHandlers } = require('../services/ipc-contract');
  const handlers = new Map();

  registerIpcInvokeHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  }, {
    'workspace.getState': () => ({ ok: true }),
    'workspace.updateState': (_, patch) => patch,
  });

  assert.deepEqual(await handlers.get('workspace:get-state')(), { ok: true });
  assert.deepEqual(await handlers.get('workspace:update-state')(null, { activeSessionId: 'sess_10' }), {
    activeSessionId: 'sess_10',
  });
  assert.throws(
    () => registerIpcInvokeHandlers(null, { 'workspace.getState': () => null }),
    /ipcmain-like object with handle/i
  );
  assert.throws(
    () => registerIpcInvokeHandlers({ handle() {} }, { 'backend.onStatus': () => null }),
    /must be "invoke"/i
  );
});

test('ipc contract subscribe helpers reject non-function listeners early', () => {
  const { createJennyShellBridge } = require('../services/ipc-contract');
  const bridge = createJennyShellBridge({
    ipcRenderer: {
      invoke() {
        return Promise.resolve(null);
      },
      send() {},
      on() {},
      removeListener() {},
    },
  });

  assert.throws(
    () => bridge.backend.onStatus('not-a-function'),
    /listener .* must be a function/i
  );
});

test('preload exposes webUtils.getPathForFile as a local bridge method for drag-drop', () => {
  let exposedApi = null;
  const resolvedPaths = new Map();
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(_key, value) {
        exposedApi = value;
      },
    },
    ipcRenderer: {
      invoke: () => Promise.resolve(null),
      send() {},
      on() {},
      removeListener() {},
    },
    webUtils: {
      getPathForFile(file) {
        return resolvedPaths.get(file) || '';
      },
    },
  });

  const droppedFile = { name: 'dropped.txt' };
  resolvedPaths.set(droppedFile, 'C:/workspace/dropped.txt');

  assert.equal(typeof exposedApi.attachments.getPathForFile, 'function');
  assert.equal(
    exposedApi.attachments.getPathForFile(droppedFile),
    'C:/workspace/dropped.txt'
  );
  assert.equal(exposedApi.attachments.getPathForFile({ name: 'unknown.bin' }), '');
});
