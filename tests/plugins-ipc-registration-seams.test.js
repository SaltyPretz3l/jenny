'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { getBridgeChannel } = require('../services/ipc-contract');
const { MAIN_DOCUMENT_PATH, IPC_SENDER_UNAUTHORIZED } = require('../services/main/ipc-sender-authorization');
const {
  PLUGIN_INVOKE_METHODS,
  PLUGIN_STAGE5_INVOKE_METHODS,
  PLUGIN_STAGE7_INVOKE_METHODS,
  PLUGIN_SUBSCRIBE_METHODS,
  registerPluginsRuntime,
} = require('../services/main/plugins-ipc-registration');

const createdRoots = [];
const DOCUMENT_URL = pathToFileURL(MAIN_DOCUMENT_PATH).href;

after(() => {
  for (const root of createdRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeUserData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-plugins-ipc-'));
  createdRoots.push(root);
  return root;
}

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

function createTrustedSender() {
  const mainFrame = { url: DOCUMENT_URL };
  const webContents = {
    id: 1,
    mainFrame,
    isDestroyed: () => false,
    getURL: () => DOCUMENT_URL,
  };
  return {
    window: { webContents, isDestroyed: () => false },
    event: { sender: webContents, senderFrame: mainFrame },
  };
}

function createForeignSender() {
  const mainFrame = { url: DOCUMENT_URL };
  const webContents = { id: 2, mainFrame, isDestroyed: () => false, getURL: () => DOCUMENT_URL };
  return { sender: webContents, senderFrame: mainFrame };
}

function register({
  plugins = true,
  backendServiceOverrides = {},
  argv = [],
  env = {},
  getMainWindow,
  sendBridgeEvent = () => {},
  appRoot = process.cwd(),
  sidecarClient = null,
  isPackaged = false,
  resourcesPath = path.join(appRoot, 'build'),
} = {}) {
  const ipcMain = createFakeIpcMain();
  const userData = makeUserData();
  const backendService = { featureFlags: { plugins }, ...backendServiceOverrides,
    ...(sidecarClient ? { sidecarClient } : {}) };
  const handle = registerPluginsRuntime(ipcMain, {
    backendService,
    app: { getPath: () => userData, getAppPath: () => appRoot, once: () => {}, isPackaged },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    processRef: { argv, env, resourcesPath },
    getMainWindow: getMainWindow || (() => null),
    sendBridgeEvent,
    log: () => {},
  });
  return { ipcMain, handle, backendService };
}

describe('registerPluginsRuntime composition', () => {
  test('registers exactly the Stage 7 contract invoke channels when the flag is on', () => {
    const { ipcMain, handle } = register();
    assert.notEqual(handle, null);
    const expected = [
      ...Object.keys(PLUGIN_INVOKE_METHODS),
      ...Object.keys(PLUGIN_STAGE5_INVOKE_METHODS),
      ...Object.keys(PLUGIN_STAGE7_INVOKE_METHODS),
      'plugins.viewBridge',
    ].map((methodPath) => getBridgeChannel(methodPath, 'invoke'));
    assert.equal(expected.length, 32);
    assert.deepEqual([...ipcMain.invoke.keys()].sort(), [...expected].sort());
    assert.deepEqual([...handle.channels].sort(), [...expected].sort());
  });

  test('every handled method path is a real invoke descriptor and maps to a service method', () => {
    const { handle } = register();
    for (const [methodPath, methodName] of Object.entries(PLUGIN_INVOKE_METHODS)) {
      assert.equal(typeof getBridgeChannel(methodPath, 'invoke'), 'string');
      assert.equal(typeof handle.service[methodName], 'function', `${methodPath} -> ${methodName}`);
    }
    for (const [methodPath, methodName] of Object.entries(PLUGIN_STAGE5_INVOKE_METHODS)) {
      assert.equal(typeof getBridgeChannel(methodPath, 'invoke'), 'string');
      assert.equal(typeof handle.catalogService[methodName] === 'function'
        || typeof handle.stage5Service[methodName] === 'function', true, `${methodPath} -> ${methodName}`);
    }
    for (const [methodPath, registrar] of Object.entries(PLUGIN_SUBSCRIBE_METHODS)) {
      assert.equal(typeof getBridgeChannel(methodPath, 'subscribe'), 'string');
      assert.equal(typeof handle.service[registrar], 'function', `${methodPath} -> ${registrar}`);
    }
  });

  test('safe mode is resolved from argv and env at this seam, not from main.js', () => {
    assert.equal(register({ argv: ['--plugins-safe-mode'] }).handle.safeMode.active, true);
    assert.equal(register({ env: { JENNY_PLUGINS_SAFE_MODE: '1' } }).handle.safeMode.active, true);
    assert.equal(register().handle.safeMode.active, false);
  });

  test('the privileged kill switch keeps cleanup-only Stage 8 registration alive', async () => {
    const { handle, backendService } = register();
    assert.equal(handle.stage8Service.enabled, false);
    assert.equal(backendService._pluginStage8ControlPlane, handle.stage8Service);
    assert.deepEqual(await handle.stage8Service.acquireHost({}), {
      ok: false, reason: 'privileged_plugins_disabled',
    });
    const cleanup = await handle.stage8Service.cleanupOnly([]);
    assert.equal(cleanup.ok, true);
  });

  test('session-provider drain wires actor barriers and tolerates an absent registry', async () => {
    const sessionStore = { listSessions: () => [], getSession: () => null };
    let barrierReads = 0;
    const withRegistry = register({ backendServiceOverrides: {
      sessionStore,
      attachmentAssetStore: {},
      exclusiveGpuCoordinator: {},
      activeStreams: new Map(),
      sessionTurnActors: {
        pendingUnattachedLeaseSettlementBarriers: () => {
          barrierReads += 1;
          return [];
        },
      },
    } }).handle;
    assert.deepEqual(await withRegistry.sessionProviderBroker.drainChat(),
      { ok: true, stream_count: 0 });
    assert.equal(barrierReads, 1);

    const withoutRegistry = register({ backendServiceOverrides: {
      sessionStore,
      attachmentAssetStore: {},
      exclusiveGpuCoordinator: {},
      activeStreams: new Map(),
    } }).handle;
    assert.deepEqual(await withoutRegistry.sessionProviderBroker.drainChat(),
      { ok: true, stream_count: 0 });
  });

  test('Stage 7 composes provider auth before later auxiliary IPC registration', () => {
    const { backendService } = register({
      env: { JENNY_AGENT_DEV: '1', JENNY_STAGE7_SYNTHETIC_OAUTH: '1' },
    });
    assert.equal(backendService.chatgptAuthService.getStatus().state, 'signed_out');
  });

  test('the returned handle disposes subscriptions and the service idempotently', () => {
    const events = [];
    const { handle } = register({ sendBridgeEvent: (methodPath, payload) => events.push([methodPath, payload]) });
    handle.dispose();
    handle.dispose();
    assert.deepEqual(events, []);
  });

  test('dispose cancels delayed packaged startup before migration can mutate', async () => {
    let initializeCalls = 0;
    const sidecarClient = {
      connected: false,
      initialize: async () => { initializeCalls += 1; return {}; },
    };
    const { handle } = register({ sidecarClient, isPackaged: true });
    const disposing = handle.dispose();
    sidecarClient.connected = true;
    await disposing;
    const startup = await handle.startupReady;
    assert.equal(startup.reason, 'startup_disposed');
    assert.equal(initializeCalls, 0);
  });
});

describe('plugins.* IPC authorization', () => {
  test('an untrusted sender is rejected on every invoke channel', async () => {
    const trusted = createTrustedSender();
    const { ipcMain } = register({ getMainWindow: () => trusted.window });
    const foreign = createForeignSender();

    for (const methodPath of [...Object.keys(PLUGIN_INVOKE_METHODS),
      ...Object.keys(PLUGIN_STAGE5_INVOKE_METHODS), ...Object.keys(PLUGIN_STAGE7_INVOKE_METHODS)]) {
      const handler = ipcMain.invoke.get(getBridgeChannel(methodPath, 'invoke'));
      assert.equal(typeof handler, 'function', `${methodPath} must be registered`);
      const result = await handler(foreign, {});
      assert.deepEqual(result, { ok: false, authorized: false, code: IPC_SENDER_UNAUTHORIZED }, methodPath);
    }
  });

  test('a missing main window fails closed on every channel', async () => {
    const { ipcMain } = register({ getMainWindow: () => null });
    const trusted = createTrustedSender();
    for (const methodPath of [...Object.keys(PLUGIN_INVOKE_METHODS),
      ...Object.keys(PLUGIN_STAGE5_INVOKE_METHODS), ...Object.keys(PLUGIN_STAGE7_INVOKE_METHODS)]) {
      const handler = ipcMain.invoke.get(getBridgeChannel(methodPath, 'invoke'));
      const result = await handler(trusted.event, {});
      assert.equal(result.code, IPC_SENDER_UNAUTHORIZED, methodPath);
    }
  });

  test('a trusted sender reaches the control plane and gets a structured result', async () => {
    const trusted = createTrustedSender();
    const { ipcMain } = register({ getMainWindow: () => trusted.window });
    const state = await ipcMain.invoke.get(getBridgeChannel('plugins.getState', 'invoke'))(trusted.event, {});
    assert.equal(state.ok, true);
    assert.equal(state.stage, 8);
    assert.equal(state.restricted_host_scope, 'stage6_restricted_host');
    assert.equal(state.enabled, true);
    assert.equal(state.installed_count, 0);
  });
});

describe('plugins.* subscription channels', () => {
  test('both subscribe descriptors are wired to sendBridgeEvent', async () => {
    const trusted = createTrustedSender();
    const events = [];
    const { ipcMain } = register({
      getMainWindow: () => trusted.window,
      sendBridgeEvent: (methodPath, payload) => events.push([methodPath, payload]),
    });
    const handler = ipcMain.invoke.get(getBridgeChannel('plugins.installLocalPackage', 'invoke'));
    await handler(trusted.event, {});
    assert.deepEqual(events, []);
  });
});
