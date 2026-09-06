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

function captureJennyShellPreload() {
  const captured = { api: null, invokeCalls: [], subscriptions: [] };
  loadWithElectronMock('../preload.js', {
    contextBridge: {
      exposeInMainWorld(name, api) {
        captured.api = { name, api };
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        captured.invokeCalls.push({ channel, args });
        return Promise.resolve({ ok: true });
      },
      on(channel, listener) {
        captured.subscriptions.push({ channel, listener });
      },
      removeListener(channel, listener) {
        captured.subscriptions.push({ channel, listener, removed: true });
      },
      send() {},
    },
  });
  return captured;
}

function captureOverlayPreload() {
  const captured = { apis: [], invokeCalls: [], subscriptions: [] };
  loadWithElectronMock('../preload-overlay.js', {
    contextBridge: {
      exposeInMainWorld(name, api) {
        captured.apis.push({ name, api });
      },
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        captured.invokeCalls.push({ channel, args });
        return Promise.resolve({ ok: true });
      },
      on(channel, listener) {
        captured.subscriptions.push({ channel, listener });
      },
      removeListener(channel, listener) {
        captured.subscriptions.push({ channel, listener, removed: true });
      },
    },
  });
  return captured;
}

test('preload forwards plugin session view authority without restoring image IPC', async () => {
  const captured = captureJennyShellPreload();
  assert.equal(captured.api.api.imageGen, undefined);
  await captured.api.api.plugins.openView({
    publisher_id: 'jenny-official', plugin_id: 'local-image-generation',
    contribution_id: 'image_workspace', generation_id: 'generation-1',
    sessionId: 'plugin-session',
  });
  assert.deepEqual(captured.invokeCalls, [{
    channel: 'plugins:open-view',
    args: [{ publisher_id: 'jenny-official', plugin_id: 'local-image-generation',
      contribution_id: 'image_workspace', generation_id: 'generation-1',
      sessionId: 'plugin-session' }],
  }]);
});

test('preload exposes the bounded data lifecycle bridge and disposable progress subscription', async () => {
  const captured = captureJennyShellPreload();
  const lifecycle = captured.api.api.dataLifecycle;
  assert.deepEqual(Object.keys(lifecycle).sort(), [
    'chooseArchiveDestination',
    'createArchive',
    'findRestoreCandidates',
    'getOverview',
    'launchUninstallAssistant',
    'onProgress',
    'previewWorkspaceArchive',
    'previewWorkspaceRestore',
    'restoreWorkspace',
    'stageRestore',
    'syncPortablePreferences',
  ]);
  await lifecycle.createArchive({ encrypted: false });
  assert.equal(captured.invokeCalls.at(-1).channel, 'data-lifecycle:create-archive');
  await lifecycle.previewWorkspaceArchive();
  assert.equal(captured.invokeCalls.at(-1).channel, 'data-lifecycle:preview-workspace-archive');
  await lifecycle.previewWorkspaceRestore({ archivePath: 'C:\\archive' });
  assert.equal(captured.invokeCalls.at(-1).channel, 'data-lifecycle:preview-workspace-restore');
  await lifecycle.restoreWorkspace({ archivePath: 'C:\\archive', reviewId: 'review' });
  assert.equal(captured.invokeCalls.at(-1).channel, 'data-lifecycle:restore-workspace');
  const dispose = lifecycle.onProgress(() => {});
  assert.equal(captured.subscriptions.at(-1).channel, 'data-lifecycle:progress');
  dispose();
  assert.equal(captured.subscriptions.at(-1).removed, true);
});

test('preload exposes unsaved reply durability actions on jennyShell.chat', async () => {
  const captured = captureJennyShellPreload();
  const payload = {
    sessionId: 'session-a',
    messageId: 'assistant-a',
    artifactId: 'repair-a',
  };

  assert.equal(typeof captured.api.api.chat.retryUnsavedReply, 'function');
  assert.equal(typeof captured.api.api.chat.discardUnsavedReply, 'function');

  await captured.api.api.chat.retryUnsavedReply(payload);
  await captured.api.api.chat.discardUnsavedReply(payload);

  assert.deepEqual(captured.invokeCalls, [
    { channel: 'chat:retry-unsaved-reply', args: [payload] },
    { channel: 'chat:discard-unsaved-reply', args: [payload] },
  ]);
});

test('preload exposes harness.inspect on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(captured.api.name, 'jennyShell');
  assert.equal(typeof captured.api.api.harness.inspect, 'function');

  await captured.api.api.harness.inspect({ sections: ['tools'] });
  assert.deepEqual(captured.invokeCalls[0], {
    channel: 'harness:inspect',
    args: [{ sections: ['tools'] }],
  });
});

test('preload exposes memory.status on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(typeof captured.api.api.memory.status, 'function');
  await captured.api.api.memory.status();
  assert.deepEqual(captured.invokeCalls.at(-1), { channel: 'memory:status', args: [] });
});

test('preload exposes diagnostics phase percentile bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(captured.api.name, 'jennyShell');
  assert.equal(typeof captured.api.api.diagnostics.phasePercentiles.get, 'function');
  assert.equal(typeof captured.api.api.diagnostics.phasePercentiles.reset, 'function');

  await captured.api.api.diagnostics.phasePercentiles.get();
  await captured.api.api.diagnostics.phasePercentiles.reset();
  assert.deepEqual(captured.invokeCalls, [
    {
      channel: 'diagnostics:phase-percentiles:get',
      args: [],
    },
    {
      channel: 'diagnostics:phase-percentiles:reset',
      args: [],
    },
  ]);
});

test('preload exposes Jenny status diagnostics bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(captured.api.name, 'jennyShell');
  assert.equal(typeof captured.api.api.diagnostics.getJennyStatus, 'function');

  await captured.api.api.diagnostics.getJennyStatus({ sessionId: 'session-a' });
  assert.deepEqual(captured.invokeCalls, [
    {
      channel: 'diagnostics:jenny-status',
      args: [{ sessionId: 'session-a' }],
    },
  ]);
});

test('preload exposes startup audit batch bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(captured.api.name, 'jennyShell');
  assert.equal(typeof captured.api.api.diagnostics.reportStartupMarksBatch, 'function');

  await captured.api.api.diagnostics.reportStartupMarksBatch({
    marks: [{ mark: 'renderer-bootstrap-started' }],
  });
  assert.deepEqual(captured.invokeCalls, [
    {
      channel: 'diagnostics:startup-marks-batch',
      args: [{ marks: [{ mark: 'renderer-bootstrap-started' }] }],
    },
  ]);
});

test('preload exposes model tuning and omits deprecated diagnostic review bridges', async () => {
  const captured = captureJennyShellPreload();
  assert.equal(typeof captured.api.api.modelTuning.getState, 'function');
  assert.equal(typeof captured.api.api.modelTuning.update, 'function');
  assert.equal(captured.api.api.diagnostics.createReviewPrompt, undefined);
  assert.equal(captured.api.api.diagnostics.dev, undefined);
  await captured.api.api.modelTuning.getState();
  await captured.api.api.modelTuning.update({ modelId: 'gemma3:latest', streamInactivitySeconds: 180 });
  assert.deepEqual(captured.invokeCalls, [
    { channel: 'model-tuning:get-state', args: [] },
    { channel: 'model-tuning:update', args: [{ modelId: 'gemma3:latest', streamInactivitySeconds: 180 }] },
  ]);
});

test('preload exposes Codex CLI engine bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(captured.api.name, 'jennyShell');
  assert.equal(typeof captured.api.api.codexCli.getState, 'function');
  assert.equal(typeof captured.api.api.codexCli.openLoginTerminal, 'function');
  assert.equal(typeof captured.api.api.codexCli.refresh, 'function');
  assert.equal(captured.api.api.diagnostics.frontier, undefined);

  await captured.api.api.codexCli.getState();
  await captured.api.api.codexCli.openLoginTerminal();
  await captured.api.api.codexCli.refresh();

  assert.deepEqual(captured.invokeCalls, [
    { channel: 'codex-cli:get-state', args: [] },
    { channel: 'codex-cli:open-login-terminal', args: [] },
    { channel: 'codex-cli:refresh', args: [] },
  ]);
});

test('preload exposes updater bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(captured.api.name, 'jennyShell');
  assert.equal(typeof captured.api.api.updates.getState, 'function');
  assert.equal(typeof captured.api.api.updates.check, 'function');
  assert.equal(typeof captured.api.api.updates.download, 'function');
  assert.equal(typeof captured.api.api.updates.install, 'function');
  assert.equal(typeof captured.api.api.updates.skip, 'function');
  assert.equal(typeof captured.api.api.updates.onChanged, 'function');

  await captured.api.api.updates.getState();
  await captured.api.api.updates.skip('0.2.0');
  assert.deepEqual(captured.invokeCalls, [
    { channel: 'updates:get-state', args: [] },
    { channel: 'updates:skip', args: ['0.2.0'] },
  ]);
});

test('preload exposes setup contract bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(captured.api.name, 'jennyShell');
  assert.equal(typeof captured.api.api.setup.getState, 'function');
  assert.equal(typeof captured.api.api.setup.updateState, 'function');
  assert.equal(typeof captured.api.api.setup.complete, 'function');
  assert.equal(typeof captured.api.api.setup.reset, 'function');
  assert.equal(typeof captured.api.api.setup.factoryReset, 'function');
  assert.equal(typeof captured.api.api.setup.validateEndpoint, 'function');
  assert.equal(typeof captured.api.api.setup.startOllamaPull, 'function');
  assert.equal(typeof captured.api.api.setup.cancelOllamaPull, 'function');
  assert.equal(typeof captured.api.api.setup.onModelPullProgress, 'function');

  await captured.api.api.setup.getState();
  await captured.api.api.setup.startOllamaPull({ model: 'llama3.2:latest' });
  assert.deepEqual(captured.invokeCalls, [
    { channel: 'setup:get-state', args: [] },
    { channel: 'setup:start-ollama-pull', args: [{ model: 'llama3.2:latest' }] },
  ]);
});

test('preload exposes MCP discovery bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();

  assert.equal(captured.api.name, 'jennyShell');
  assert.equal(typeof captured.api.api.mcpDiscovery.getState, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.refresh, 'function');
  assert.equal(captured.api.api.mcpDiscovery.openConfig, undefined);
  assert.equal(typeof captured.api.api.mcpDiscovery.createServer, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.updateServer, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.removeServer, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.testServer, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.approveServer, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.setServerEnabled, 'function');

  await captured.api.api.mcpDiscovery.refresh();
  await captured.api.api.mcpDiscovery.testServer({ name: 'local' });
  assert.deepEqual(captured.invokeCalls, [
    { channel: 'mcp-discovery:refresh', args: [] },
    { channel: 'mcp-discovery:test-server', args: [{ name: 'local' }] },
  ]);
});
