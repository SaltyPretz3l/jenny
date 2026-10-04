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
  return { ipcMain, handle, backendService, userData };
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
    assert.equal(expected.length, 18);
    assert.deepEqual([...ipcMain.invoke.keys()].sort(), [...expected].sort());
    assert.deepEqual([...handle.channels].sort(), [...expected].sort());
  });

  test('the retired catalog, offline mirror and rollback surface is neither composed nor exposed', () => {
    const { handle } = register();
    assert.equal(Object.hasOwn(handle, 'catalogService'), false);
    for (const retired of ['getCatalogState', 'refreshCatalogs', 'installFromCatalog', 'updateFromCatalog',
      'listRollbackCandidates', 'rollback', 'selectOfflineMirror']) {
      assert.equal(Object.hasOwn(PLUGIN_STAGE5_INVOKE_METHODS, `plugins.${retired}`), false, retired);
      assert.equal(typeof handle.stage5Service[retired], 'undefined', retired);
    }
    assert.equal(Object.hasOwn(PLUGIN_STAGE5_INVOKE_METHODS, 'plugins.getDistributionState'), true);
    assert.equal(Object.hasOwn(PLUGIN_STAGE5_INVOKE_METHODS, 'plugins.installLocalPackageFromPath'), true);
    const loaded = Object.keys(require.cache).map((key) => key.split(path.sep).join('/'))
      .filter((key) => /\/services\/plugins\/(catalog|network)\//.test(key));
    assert.deepEqual(loaded, [], 'no catalog or network-broker module may load');
    handle.dispose();
  });

  test('every handled method path is a real invoke descriptor and maps to a service method', () => {
    const { handle } = register();
    for (const [methodPath, methodName] of Object.entries(PLUGIN_INVOKE_METHODS)) {
      assert.equal(typeof getBridgeChannel(methodPath, 'invoke'), 'string');
      assert.equal(typeof handle.service[methodName], 'function', `${methodPath} -> ${methodName}`);
    }
    for (const [methodPath, methodName] of Object.entries(PLUGIN_STAGE5_INVOKE_METHODS)) {
      assert.equal(typeof getBridgeChannel(methodPath, 'invoke'), 'string');
      assert.equal(typeof handle.stage5Service[methodName], 'function', `${methodPath} -> ${methodName}`);
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

  test('the retired privileged tier is not composed even with the old flag and a session store', () => {
    const { handle, backendService } = register({ backendServiceOverrides: {
      featureFlags: { plugins: true, privileged_plugins: true },
      sessionStore: { listSessions: () => [], getSession: () => null },
      attachmentAssetStore: {},
      exclusiveGpuCoordinator: {},
    } });
    const loaded = Object.keys(require.cache).map((key) => key.split(path.sep).join('/'))
      .filter((key) => /\/services\/plugins\/(full-host|session-provider|artifacts)\/|\/services\/plugins\/stage8-control-plane|plugin-stage8-registration|plugin-consent-window|attachment-ticket-broker/.test(key));
    assert.deepEqual(loaded, [], 'no privileged-tier module may load');
    assert.equal(Object.hasOwn(handle, 'stage8Service'), false);
    assert.equal(Object.hasOwn(handle, 'sessionProviderBroker'), false);
    for (const key of ['_pluginStage8ControlPlane', '_pluginStage8Lifecycle', '_pluginSessionProviderBroker']) {
      assert.equal(backendService[key], undefined, key);
    }
    assert.equal(globalThis.__jennyStage8OwnerDrill, undefined);
    handle.dispose();
  });

  test('startup drops leftover privileged-tier state once and still settles per-plugin cleanup', async () => {
    const seed = (userData) => {
      const pluginsDir = path.join(userData, 'plugins');
      fs.mkdirSync(path.join(pluginsDir, 'runtime'), { recursive: true });
      fs.mkdirSync(path.join(pluginsDir, 'session-provider-staging', 'op-1'), { recursive: true });
      fs.writeFileSync(path.join(pluginsDir, 'runtime', 'hook-outbox-v6.json'), '{}');
      fs.writeFileSync(path.join(pluginsDir, 'runtime', 'full-host-cleanup-v6.json'), '{}');
      fs.writeFileSync(path.join(pluginsDir, 'runtime', 'keep-me.json'), '{}');
      fs.writeFileSync(path.join(pluginsDir, 'session-provider-staging', 'op-1', 'x.png'), 'x');
      return pluginsDir;
    };
    const logs = [];
    const ipcMain = createFakeIpcMain();
    const userData = makeUserData();
    const pluginsDir = seed(userData);
    const handle = registerPluginsRuntime(ipcMain, {
      backendService: { featureFlags: { plugins: true } },
      app: { getPath: () => userData, getAppPath: () => process.cwd(), once: () => {}, isPackaged: false },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      processRef: { argv: [], env: {}, resourcesPath: '' },
      getMainWindow: () => null,
      log: (level, event, data) => logs.push({ level, event, data }),
    });
    await handle.startupReady;
    assert.equal(fs.existsSync(path.join(pluginsDir, 'runtime', 'hook-outbox-v6.json')), false);
    assert.equal(fs.existsSync(path.join(pluginsDir, 'runtime', 'full-host-cleanup-v6.json')), false);
    assert.equal(fs.existsSync(path.join(pluginsDir, 'session-provider-staging')), false);
    assert.equal(fs.existsSync(path.join(pluginsDir, 'runtime', 'keep-me.json')), true);
    const swept = logs.find((entry) => entry.event === 'plugins.privileged_tier_retired');
    assert.deepEqual(swept.data, { removed_count: 3, failed_count: 0 });
    assert.ok(!JSON.stringify(logs).includes(userData), 'no user data path is logged');
    await handle.dispose();
  });

  test('plugins safe mode leaves the leftover privileged-tier state untouched', async () => {
    const ipcMain = createFakeIpcMain();
    const userData = makeUserData();
    const staging = path.join(userData, 'plugins', 'session-provider-staging');
    fs.mkdirSync(staging, { recursive: true });
    const handle = registerPluginsRuntime(ipcMain, {
      backendService: { featureFlags: { plugins: true } },
      app: { getPath: () => userData, getAppPath: () => process.cwd(), once: () => {}, isPackaged: false },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      processRef: { argv: ['--plugins-safe-mode'], env: {}, resourcesPath: '' },
      getMainWindow: () => null,
      log: () => {},
    });
    await handle.startupReady;
    assert.equal(fs.existsSync(staging), true);
    await handle.dispose();
  });

  test('plugin IPC no longer owns the ChatGPT auth service (core registrars create it)', () => {
    const { backendService } = register({
      env: { JENNY_AGENT_DEV: '1', JENNY_STAGE7_SYNTHETIC_OAUTH: '1' },
    });
    assert.equal(backendService.chatgptAuthService, undefined);
  });

  test('the retired restricted (Wasm) tier is not composed or attached', () => {
    const { backendService, handle } = register();
    assert.equal(backendService._pluginStage6ControlPlane, undefined);
    assert.equal(Object.hasOwn(handle, 'stage6Service'), false);
    handle.dispose();
  });

  test('the retired managed (enterprise) policy is not composed, polled or exposed', () => {
    const { handle } = register();
    const loaded = Object.keys(require.cache).map((key) => key.split(path.sep).join('/'))
      .filter((key) => /\/services\/plugins\/policy\/|plugin-managed-policy-source|managed-policy-state-store/.test(key));
    assert.deepEqual(loaded, [], 'no managed-policy module may load (it polled reg.exe every 30s)');
    assert.equal(Object.hasOwn(PLUGIN_INVOKE_METHODS, 'plugins.getPolicyStatus'), false);
    assert.equal(typeof handle.service.getPolicyStatus, 'undefined');
    handle.dispose();
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
    assert.equal(state.restricted_host_scope, 'unavailable');
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
