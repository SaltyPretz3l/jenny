'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JENNY_SHELL_BRIDGE_DESCRIPTORS,
  createJennyShellBridge,
  getBridgeChannel,
  listBridgeMethodPaths,
  registerIpcInvokeHandlers,
} = require('../services/ipc-contract');

test('ipc contract descriptors use unique invoke/send/subscribe channels', () => {
  const channels = new Map();

  for (const [methodPath, descriptor] of Object.entries(JENNY_SHELL_BRIDGE_DESCRIPTORS)) {
    assert.match(methodPath, /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/);
    assert.ok(['invoke', 'send', 'subscribe', 'local'].includes(descriptor.kind));
    if (descriptor.kind === 'local') {
      // Local methods run inside the preload context and have no IPC channel;
      // they name the preload implementation they bind to instead.
      assert.match(descriptor.impl, /^[a-z][A-Za-z0-9]*$/);
      assert.equal(descriptor.channel, undefined);
      continue;
    }
    assert.match(descriptor.channel, /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/);
    assert.equal(channels.has(descriptor.channel), false, `duplicate ${descriptor.channel}`);
    channels.set(descriptor.channel, methodPath);
  }
});

test('workspaceRecovery invoke descriptors use the five canonical unique channels', () => {
  const expected = {
    'workspaceRecovery.listChangeSets': 'workspace-recovery:list-change-sets',
    'workspaceRecovery.preflightUndo': 'workspace-recovery:preflight-undo',
    'workspaceRecovery.undoChangeSet': 'workspace-recovery:undo-change-set',
    'workspaceRecovery.restoreTrashEntry': 'workspace-recovery:restore-trash-entry',
    'workspaceRecovery.abandonRestore': 'workspace-recovery:abandon-restore',
  };
  const channels = Object.entries(expected).map(([methodPath, channel]) => {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath], { kind: 'invoke', channel });
    return channel;
  });
  assert.equal(new Set(channels).size, channels.length);
});

test('the preload bridge materializes all five workspaceRecovery methods', async () => {
  const calls = [];
  const bridge = createJennyShellBridge({
    ipcRenderer: {
      invoke(channel, ...args) {
        calls.push({ channel, args });
        return Promise.resolve({ ok: true });
      },
      send() {},
    },
  });

  await bridge.workspaceRecovery.listChangeSets({});
  await bridge.workspaceRecovery.preflightUndo({ changeSetId: 'set' });
  await bridge.workspaceRecovery.undoChangeSet({ changeSetId: 'set', decisions: {} });
  await bridge.workspaceRecovery.restoreTrashEntry({ name: 'trash' });
  await bridge.workspaceRecovery.abandonRestore({ workspaceId: 'root', changeSetId: 'set' });

  assert.deepEqual(calls, [
    { channel: 'workspace-recovery:list-change-sets', args: [{}] },
    { channel: 'workspace-recovery:preflight-undo', args: [{ changeSetId: 'set' }] },
    { channel: 'workspace-recovery:undo-change-set', args: [{ changeSetId: 'set', decisions: {} }] },
    { channel: 'workspace-recovery:restore-trash-entry', args: [{ name: 'trash' }] },
    { channel: 'workspace-recovery:abandon-restore', args: [{ workspaceId: 'root', changeSetId: 'set' }] },
  ]);
});

test('llamaServer invoke descriptors use the seven canonical unique channels', () => {
  const expected = {
    'llamaServer.getStatus': 'llama-server:status',
    'llamaServer.start': 'llama-server:start',
    'llamaServer.stop': 'llama-server:stop',
    'llamaServer.restart': 'llama-server:restart',
    'llamaServer.listLocalGgufs': 'llama-server:list-local-ggufs',
    'llamaServer.chooseGguf': 'llama-server:choose-gguf',
    'llamaServer.chooseLibraryFolder': 'llama-server:choose-library-folder',
  };
  const channels = Object.entries(expected).map(([methodPath, channel]) => {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[methodPath], { kind: 'invoke', channel });
    return channel;
  });
  assert.equal(new Set(channels).size, channels.length);
});

test('registerIpcInvokeHandlers registers only descriptor-backed invoke channels', () => {
  const registrations = [];
  const ipcMainLike = {
    handle(channel, handler) {
      registrations.push({ channel, handler });
    },
  };
  const handlers = {
    'workspace.getState': () => ({ ok: true }),
    'chat.startStream': () => ({ ok: true }),
    'chat.editAndRegenerate': () => ({ ok: true }),
    'chat.retryUnsavedReply': () => ({ ok: true }),
    'chat.discardUnsavedReply': () => ({ ok: true }),
  };

  const channels = registerIpcInvokeHandlers(ipcMainLike, handlers);

  assert.deepEqual(channels, [
    getBridgeChannel('workspace.getState', 'invoke'),
    getBridgeChannel('chat.startStream', 'invoke'),
    getBridgeChannel('chat.editAndRegenerate', 'invoke'),
    getBridgeChannel('chat.retryUnsavedReply', 'invoke'),
    getBridgeChannel('chat.discardUnsavedReply', 'invoke'),
  ]);
  assert.deepEqual(
    registrations.map((entry) => entry.channel),
    channels
  );
});

test('registerIpcInvokeHandlers denies unauthorized callers before privileged handlers run', async () => {
  const registered = new Map();
  let handlerCalls = 0;
  registerIpcInvokeHandlers({
    handle(channel, handler) { registered.set(channel, handler); },
  }, {
    'workspaceFs.delete': () => { handlerCalls += 1; return { deleted: true }; },
  }, {
    authorize: (event, metadata) => (
      event?.trusted === true && metadata.methodPath === 'workspaceFs.delete'
    ),
  });

  const handler = registered.get(getBridgeChannel('workspaceFs.delete', 'invoke'));
  assert.deepEqual(await handler({ trusted: false }), {
    ok: false,
    authorized: false,
    code: 'ipc_sender_unauthorized',
  });
  assert.equal(handlerCalls, 0);
  assert.deepEqual(await handler({ trusted: true }), { deleted: true });
  assert.equal(handlerCalls, 1);
});

test('ipc contract rejects missing and wrong-kind registrations', () => {
  assert.throws(
    () => registerIpcInvokeHandlers({ handle() {} }, { 'chat.onStream': () => null }),
    /must be "invoke"/
  );
  assert.throws(
    () => registerIpcInvokeHandlers({ handle() {} }, { 'missing.path': () => null }),
    /Unknown Jenny IPC bridge path/
  );
  assert.throws(
    () => registerIpcInvokeHandlers({ handle() {} }, { 'chat.send': null }),
    /must be a function/
  );
});

test('ipc contract exposes a stable sorted method inventory', () => {
  const invokePaths = listBridgeMethodPaths({ kind: 'invoke' });
  const allPaths = listBridgeMethodPaths();

  assert.ok(invokePaths.includes('chat.startStream'));
  assert.ok(invokePaths.includes('chat.editAndRegenerate'));
  assert.ok(invokePaths.includes('chat.retryUnsavedReply'));
  assert.ok(invokePaths.includes('chat.discardUnsavedReply'));
  assert.ok(invokePaths.includes('updates.getState'));
  assert.ok(invokePaths.includes('updates.check'));
  assert.ok(invokePaths.includes('updates.download'));
  assert.ok(invokePaths.includes('updates.install'));
  assert.ok(invokePaths.includes('updates.skip'));
  assert.ok(invokePaths.includes('diagnostics.getJennyStatus'));
  assert.ok(invokePaths.includes('memory.status'));
  assert.ok(invokePaths.includes('usage.clearHistory'));
  assert.ok(invokePaths.includes('usage.getSnapshot'));
  assert.ok(invokePaths.includes('system.refreshStats'));
  for (const methodPath of [
    'llamaServer.chooseGguf',
    'llamaServer.chooseLibraryFolder',
    'llamaServer.getStatus',
    'llamaServer.listLocalGgufs',
    'llamaServer.restart',
    'llamaServer.start',
    'llamaServer.stop',
  ]) {
    assert.ok(invokePaths.includes(methodPath));
  }
  assert.equal(invokePaths.includes('auth.login'), false);
  assert.equal(invokePaths.includes('auth.register'), false);
  assert.equal(invokePaths.includes('auth.logout'), false);
  assert.ok(invokePaths.includes('auth.updateLocalProfile'));
  assert.equal(invokePaths.includes('cost.getSession'), false);
  assert.equal(invokePaths.includes('cost.getCumulative'), false);
  assert.ok(invokePaths.includes('diagnostics.reportStartupMarksBatch'));
  assert.ok(invokePaths.includes('modelTuning.getState'));
  assert.ok(invokePaths.includes('modelTuning.update'));
  assert.equal(invokePaths.includes('diagnostics.createReviewPrompt'), false);
  assert.equal(invokePaths.some((path) => path.startsWith('diagnostics.dev.')), false);
  assert.ok(invokePaths.includes('codexCli.getState'));
  assert.ok(invokePaths.includes('codexCli.openLoginTerminal'));
  assert.ok(invokePaths.includes('codexCli.refresh'));
  assert.equal(invokePaths.includes('diagnostics.frontier.getState'), false);
  assert.ok(invokePaths.includes('window.getState'));
  assert.ok(invokePaths.includes('setup.getState'));
  assert.ok(invokePaths.includes('setup.validateEndpoint'));
  assert.ok(invokePaths.includes('setup.startOllamaPull'));
  assert.ok(invokePaths.includes('setup.cancelOllamaPull'));
  assert.ok(invokePaths.includes('setup.factoryReset'));
  assert.ok(invokePaths.includes('mcpDiscovery.getState'));
  assert.ok(invokePaths.includes('mcpDiscovery.refresh'));
  assert.equal(invokePaths.includes('mcpDiscovery.openConfig'), false);
  assert.ok(invokePaths.includes('mcpDiscovery.createServer'));
  assert.ok(invokePaths.includes('mcpDiscovery.updateServer'));
  assert.ok(invokePaths.includes('mcpDiscovery.removeServer'));
  assert.ok(invokePaths.includes('mcpDiscovery.testServer'));
  assert.ok(invokePaths.includes('mcpDiscovery.approveServer'));
  assert.ok(invokePaths.includes('mcpDiscovery.setServerEnabled'));
  assert.ok(invokePaths.includes('mcpAuth.getStatus'));
  assert.ok(invokePaths.includes('mcpAuth.set'));
  assert.ok(invokePaths.includes('mcpAuth.delete'));
  assert.equal(getBridgeChannel('mcpAuth.getStatus', 'invoke'), 'mcp-auth:get-status');
  assert.equal(getBridgeChannel('mcpAuth.set', 'invoke'), 'mcp-auth:set');
  assert.equal(getBridgeChannel('mcpAuth.delete', 'invoke'), 'mcp-auth:delete');
  assert.ok(invokePaths.includes('workspace.getState'));
  assert.ok(invokePaths.includes('workspaceFs.readText'));
  assert.ok(invokePaths.includes('workspaceFs.writeText'));
  assert.ok(invokePaths.includes('workspaceRecovery.listChangeSets'));
  assert.ok(invokePaths.includes('workspaceRecovery.preflightUndo'));
  assert.ok(invokePaths.includes('workspaceRecovery.undoChangeSet'));
  assert.ok(invokePaths.includes('workspaceRecovery.restoreTrashEntry'));
  assert.ok(invokePaths.includes('workspaceRecovery.abandonRestore'));
  assert.ok(invokePaths.includes('models.delete'));
  assert.ok(invokePaths.includes('sessions.setMeta'));
  assert.ok(invokePaths.includes('sessions.sweepEmpty'));
  assert.ok(invokePaths.includes('workspaceGit.getStatus'));
  assert.ok(invokePaths.includes('workspaceGit.getDiff'));
  assert.ok(invokePaths.includes('workspaceGit.getCommitDiff'));
  assert.ok(invokePaths.includes('workspaceGit.blameRange'));
  assert.ok(invokePaths.includes('workspaceGit.commit'));
  assert.ok(invokePaths.includes('workspaceGit.undoLastCommit'));
  assert.ok(invokePaths.includes('workspaceFileMap.getGraph'));
  assert.ok(invokePaths.includes('workspaceFileMap.refresh'));
  assert.deepEqual([...invokePaths].sort(), invokePaths);
  assert.equal(getBridgeChannel('models.delete', 'invoke'), 'models:delete');
  assert.equal(getBridgeChannel('sessions.setMeta', 'invoke'), 'sessions:set-meta');
  assert.equal(getBridgeChannel('sessions.sweepEmpty', 'invoke'), 'sessions:sweep-empty');
  assert.equal(getBridgeChannel('workspaceGit.getStatus', 'invoke'), 'workspace-git:get-status');
  assert.equal(getBridgeChannel('workspaceFs.readText', 'invoke'), 'workspace-fs:read-text');
  assert.equal(getBridgeChannel('workspaceFs.writeText', 'invoke'), 'workspace-fs:write-text');
  assert.equal(getBridgeChannel('workspaceGit.getCommitDiff', 'invoke'), 'workspace-git:get-commit-diff');
  assert.equal(getBridgeChannel('workspaceGit.getFileAtHead', 'invoke'), 'workspace-git:get-file-at-head');
  assert.equal(getBridgeChannel('workspaceGit.discardFile', 'invoke'), 'workspace-git:discard-file');
  assert.equal(getBridgeChannel('workspaceGit.undoLastCommit', 'invoke'), 'workspace-git:undo-last-commit');
  assert.equal(getBridgeChannel('workspaceFileMap.getGraph', 'invoke'), 'workspace-file-map:get-graph');
  assert.equal(getBridgeChannel('workspaceFileMap.refresh', 'invoke'), 'workspace-file-map:refresh');
  assert.equal(getBridgeChannel('diagnostics.getJennyStatus', 'invoke'), 'diagnostics:jenny-status');
  assert.equal(getBridgeChannel('usage.clearHistory', 'invoke'), 'usage:clear-history');
  assert.equal(getBridgeChannel('usage.getSnapshot', 'invoke'), 'usage:get-snapshot');
  assert.equal(
    getBridgeChannel('diagnostics.reportStartupMarksBatch', 'invoke'),
    'diagnostics:startup-marks-batch'
  );
  assert.equal(getBridgeChannel('modelTuning.getState', 'invoke'), 'model-tuning:get-state');
  assert.equal(getBridgeChannel('modelTuning.update', 'invoke'), 'model-tuning:update');
  assert.equal(getBridgeChannel('codexCli.getState', 'invoke'), 'codex-cli:get-state');
  assert.equal(getBridgeChannel('codexCli.openLoginTerminal', 'invoke'), 'codex-cli:open-login-terminal');
  assert.equal(getBridgeChannel('codexCli.refresh', 'invoke'), 'codex-cli:refresh');
  assert.equal(getBridgeChannel('window.getState', 'invoke'), 'window:get-state');
  assert.equal(getBridgeChannel('window.onStateChanged', 'subscribe'), 'window:state-changed');
  assert.equal(getBridgeChannel('setup.getState', 'invoke'), 'setup:get-state');
  assert.equal(getBridgeChannel('setup.factoryReset', 'invoke'), 'setup:factory-reset');
  assert.equal(getBridgeChannel('mcpDiscovery.refresh', 'invoke'), 'mcp-discovery:refresh');
  assert.equal(getBridgeChannel('mcpDiscovery.testServer', 'invoke'), 'mcp-discovery:test-server');
  assert.equal(getBridgeChannel('setup.onModelPullProgress', 'subscribe'), 'setup:model-pull-progress');
  assert.equal(getBridgeChannel('chat.onStreamEnvelope', 'subscribe'), 'chat:stream-envelope');
  assert.equal(
    getBridgeChannel('chat.onStreamRecoveryRequired', 'subscribe'),
    'chat:stream-recovery-required'
  );
  assert.equal(getBridgeChannel('updates.onChanged', 'subscribe'), 'updates:changed');
  assert.ok(listBridgeMethodPaths({ kind: 'subscribe' }).includes('chat.onStreamEnvelope'));
  assert.ok(listBridgeMethodPaths({ kind: 'subscribe' }).includes('chat.onStreamRecoveryRequired'));
  assert.ok(listBridgeMethodPaths({ kind: 'subscribe' }).includes('window.onStateChanged'));
  assert.ok(allPaths.length > invokePaths.length);
});
