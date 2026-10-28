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

test('preload exposes neither the retired plugin bridge nor image IPC', () => {
  const captured = captureJennyShellPreload();
  assert.equal(captured.api.api.imageGen, undefined);
  assert.equal(captured.api.api.plugins, undefined);
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
  assert.equal(captured.api.api.codexCli.openLoginTerminal, undefined);
  assert.equal(typeof captured.api.api.codexCli.refresh, 'function');
  assert.equal(captured.api.api.diagnostics.frontier, undefined);

  await captured.api.api.codexCli.getState();
  await captured.api.api.codexCli.refresh();

  assert.deepEqual(captured.invokeCalls, [
    { channel: 'codex-cli:get-state', args: [] },
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

test('preload exposes the command-line tool PATH bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();
  const cliPath = captured.api.api.cli.path;
  assert.equal(typeof cliPath.getState, 'function');
  assert.equal(typeof cliPath.install, 'function');
  assert.equal(typeof cliPath.remove, 'function');

  await cliPath.getState();
  await cliPath.install();
  await cliPath.remove();
  assert.deepEqual(captured.invokeCalls, [
    { channel: 'cli:path:get-state', args: [] },
    { channel: 'cli:path:install', args: [] },
    { channel: 'cli:path:remove', args: [] },
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
  assert.equal(typeof captured.api.api.mcpDiscovery.checkReadiness, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.getPrompt, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.getReaInstallPlan, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.installRea, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.uninstallRea, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.onReaInstallProgress, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.approveServer, 'function');
  assert.equal(typeof captured.api.api.mcpDiscovery.setServerEnabled, 'function');

  await captured.api.api.mcpDiscovery.refresh();
  await captured.api.api.mcpDiscovery.testServer({ name: 'local' });
  await captured.api.api.mcpDiscovery.checkReadiness({ name: 'rea' });
  await captured.api.api.mcpDiscovery.getPrompt({ name: 'docs', prompt: 'review', arguments: { target: 'x' } });
  await captured.api.api.mcpDiscovery.getReaInstallPlan();
  await captured.api.api.mcpDiscovery.installRea({ confirmed: true });
  await captured.api.api.mcpDiscovery.uninstallRea({ confirmed: true });
  assert.deepEqual(captured.invokeCalls, [
    { channel: 'mcp-discovery:refresh', args: [] },
    { channel: 'mcp-discovery:test-server', args: [{ name: 'local' }] },
    { channel: 'mcp-discovery:check-readiness', args: [{ name: 'rea' }] },
    { channel: 'mcp-discovery:get-prompt', args: [{ name: 'docs', prompt: 'review', arguments: { target: 'x' } }] },
    { channel: 'mcp-discovery:rea-install-plan', args: [] },
    { channel: 'mcp-discovery:install-rea', args: [{ confirmed: true }] },
    { channel: 'mcp-discovery:uninstall-rea', args: [{ confirmed: true }] },
  ]);
  const unsubscribe = captured.api.api.mcpDiscovery.onReaInstallProgress(() => {});
  assert.equal(captured.subscriptions.at(-1).channel, 'mcp-discovery:rea-install-progress');
  unsubscribe();
  assert.equal(captured.subscriptions.at(-1).removed, true);
});

test('preload sends only webUtils-resolved drop paths on the preload-internal channel', async () => {
  const captured = { api: null, invokeCalls: [] };
  const granted = { name: 'granted.txt' };
  const pageBuilt = { name: 'forged.txt' };
  loadWithElectronMock('../preload.js', {
    contextBridge: { exposeInMainWorld(name, api) { captured.api = api; } },
    ipcRenderer: {
      invoke(channel, ...args) { captured.invokeCalls.push({ channel, args }); return Promise.resolve({ accepted: [], rejected: [] }); },
      on() {}, removeListener() {}, send() {},
    },
    webUtils: { getPathForFile: (file) => (file === granted ? 'D:\\outside\\granted.txt' : '') },
  });
  const attachments = captured.api.attachments;
  // The internal channel is never a page method; only the File-taking one is.
  assert.equal(attachments.prepareDroppedPaths, undefined);
  await attachments.prepareDroppedFiles([granted, pageBuilt, 'C:\\secret.txt'], { session_id: 's1' });
  assert.deepEqual(captured.invokeCalls, [{
    channel: 'attachments:prepare-dropped-paths',
    args: [['D:\\outside\\granted.txt'], { session_id: 's1' }],
  }]);
});

test('preload exposes the chat workspace bridge with only its closed methods and a disposable subscription', async () => {
  const captured = captureJennyShellPreload();
  const chatWorkspace = captured.api.api.chatWorkspace;
  assert.deepEqual(Object.keys(chatWorkspace).sort(), [
    'getChangeDiff',
    'getSummary',
    'listChanges',
    'onChanged',
    'setView',
  ]);
  await chatWorkspace.getSummary({ schema_version: 1, session_id: 'sess_a' });
  await chatWorkspace.setView({ schema_version: 1, session_id: 'sess_a', expected_revision: 0, patch: { rail_visible: true } });
  await chatWorkspace.listChanges({ schema_version: 1, session_id: 'sess_a' });
  await chatWorkspace.getChangeDiff({ schema_version: 1, session_id: 'sess_a', path: 'a.txt' });
  assert.deepEqual(captured.invokeCalls.map((call) => call.channel), [
    'chat-workspace:get-summary',
    'chat-workspace:set-view',
    'chat-workspace:list-changes',
    'chat-workspace:get-change-diff',
  ]);
  const unsubscribe = chatWorkspace.onChanged(() => {});
  assert.equal(captured.subscriptions.at(-1).channel, 'chat-workspace:changed');
  unsubscribe();
  assert.equal(captured.subscriptions.at(-1).removed, true);
});

test('preload exposes the performance bridge with only its closed methods and a disposable subscription', async () => {
  const captured = captureJennyShellPreload();
  const performance = captured.api.api.performance;
  assert.deepEqual(Object.keys(performance).sort(), ['dismissWarning', 'getSnapshot', 'onChanged', 'updateSettings']);
  await performance.getSnapshot({ schema_version: 1, session_id: 'sess_a' });
  await performance.updateSettings({ schema_version: 1, gpu_warnings_enabled: false });
  await performance.dismissWarning({ schema_version: 1, session_id: 'sess_a', warning_id: '123e4567-e89b-42d3-a456-426614174000' });
  assert.deepEqual(captured.invokeCalls.map((call) => call.channel), [
    'performance:get-snapshot',
    'performance:update-settings',
    'performance:dismiss-warning',
  ]);
  const unsubscribe = performance.onChanged(() => {});
  assert.equal(captured.subscriptions.at(-1).channel, 'performance:changed');
  unsubscribe();
  assert.equal(captured.subscriptions.at(-1).removed, true);
});

test('preload exposes the chat messages bridge with only its closed methods and a disposable subscription', async () => {
  const captured = captureJennyShellPreload();
  const chatMessages = captured.api.api.chatMessages;
  assert.deepEqual(Object.keys(chatMessages).sort(), [
    'cancel',
    'confirmRestored',
    'createGrant',
    'discard',
    'list',
    'listRecipients',
    'markRead',
    'onChanged',
    'prepare',
    'retry',
    'revokeGrant',
    'send',
    'setContextDisposition',
    'setReporting',
  ]);
  const request = { schema_version: 1, session_id: 'sess_a' };
  await chatMessages.listRecipients({ ...request, source_session_id: 'sess_a' });
  await chatMessages.list({ ...request, direction: 'inbox' });
  await chatMessages.send({ schema_version: 1, operation_id: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(captured.invokeCalls.map((call) => call.channel), [
    'chat-messages:list-recipients',
    'chat-messages:list',
    'chat-messages:send',
  ]);
  const unsubscribe = chatMessages.onChanged(() => {});
  assert.equal(captured.subscriptions.at(-1).channel, 'chat-messages:changed');
  unsubscribe();
  assert.equal(captured.subscriptions.at(-1).removed, true);
});

test('preload exposes the session proposals bridge with only its closed methods and a disposable subscription', async () => {
  const captured = captureJennyShellPreload();
  const sessionProposals = captured.api.api.sessionProposals;
  assert.deepEqual(Object.keys(sessionProposals).sort(), [
    'authorizeLaunch',
    'cancel',
    'confirmRestored',
    'decide',
    'get',
    'getCapabilities',
    'list',
    'onChanged',
    'retry',
    'setOptions',
    'startAll',
  ]);
  const request = { schema_version: 1, session_id: 'sess_a' };
  await sessionProposals.get({ ...request, proposal_id: `proposal_${'a'.repeat(64)}` });
  await sessionProposals.list(request);
  await sessionProposals.retry({ ...request, proposal_id: `proposal_${'a'.repeat(64)}`, expected_revision: 1, decision_id: '11111111-1111-4111-8111-111111111111' });
  assert.deepEqual(captured.invokeCalls.map((call) => call.channel), [
    'session-proposals:get',
    'session-proposals:list',
    'session-proposals:retry',
  ]);
  const unsubscribe = sessionProposals.onChanged(() => {});
  assert.equal(captured.subscriptions.at(-1).channel, 'session-proposals:changed');
  unsubscribe();
  assert.equal(captured.subscriptions.at(-1).removed, true);
});

test('preload exposes the Settings memory page bridge on jennyShell', async () => {
  const captured = captureJennyShellPreload();
  await captured.api.api.memory.restore({ projectId: 'project_general', memoryId: 3 });
  assert.deepEqual(captured.invokeCalls.at(-1), { channel: 'memory:restore', args: [{ projectId: 'project_general', memoryId: 3 }] });
  await captured.api.api.memory.acceptPending('session-1', 'sha256:abc', 'project_garden');
  assert.deepEqual(captured.invokeCalls.at(-1), { channel: 'memory:accept-pending', args: ['session-1', 'sha256:abc', 'project_garden'] });
  for (const name of ['listArchived', 'erase', 'clearForgotten', 'listOperations', 'setAlwaysOn', 'exportMarkdown', 'openContextFile']) {
    assert.equal(typeof captured.api.api.memory[name], 'function', name);
  }
});

test('preload exposes the primary chat bridge with only its closed methods and a disposable subscription', async () => {
  const captured = captureJennyShellPreload();
  const primaryChat = captured.api.api.primaryChat;
  assert.deepEqual(Object.keys(primaryChat).sort(), [
    'activity',
    'forgetPreview',
    'getState',
    'grantLaunch',
    'onChanged',
    'pause',
    'permissions',
    'reset',
    'resume',
    'revokeLaunch',
  ]);
  await primaryChat.getState({ schema_version: 1 });
  await primaryChat.activity({ schema_version: 1, limit: 10 });
  await primaryChat.reset({ schema_version: 1, forget: true });
  assert.deepEqual(captured.invokeCalls.map((call) => call.channel), [
    'primary-chat:get-state',
    'primary-chat:activity',
    'primary-chat:reset',
  ]);
  const unsubscribe = primaryChat.onChanged(() => {});
  assert.equal(captured.subscriptions.at(-1).channel, 'primary-chat:changed');
  unsubscribe();
  assert.equal(captured.subscriptions.at(-1).removed, true);
});
