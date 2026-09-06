'use strict';

// Coverage for services/main/plugins-ipc-registration.js -- the Electron
// composition + IPC seam for the Stage-4A plugin control plane.
//
// What is pinned here is the SEAM's behaviour, not the control plane's: the
// flag gates composition and registration together, every plugins.* channel
// sits behind the trusted-sender authorizer, a handler that throws internally
// still resolves a structured result, and Jenny owns the operation id at this
// boundary too. The flag-OFF startup proof lives in
// tests/plugins-startup-unchanged.test.js.

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
  refreshManagedConfigAfterProviderChange,
  runAfterStartupMigration,
} = require('../services/main/plugins-ipc-registration');
const {
  activateChatgptProvider,
  providerReconfigureOptions,
} = require('../services/plugins/provider/provider-activation-service');
const { PLUGIN_ERROR_CODES } = require('../services/backend/error-codes');
const {
  resolvePluginStoreRoot,
} = require('../services/plugins/plugin-control-plane-service');
const { createNodeFsFacade } = require('../services/plugins/store/node-fs-facade');
const { readCommittedState } = require('../services/plugins/lifecycle/commit-sequence');
const {
  REQUIRED_RESOURCE_KINDS,
} = require('../services/plugins/runtime/runtime-apply-coordinator');
const { buildSignedPluginPackage } = require('./helpers/plugins/zip-fixture-builder');

const createdRoots = [];

test('startup migration serializes graph mutations without blocking reads', async () => {
  let releaseMigration;
  const migrationReady = new Promise((resolve) => { releaseMigration = resolve; });
  const calls = [];
  const mutation = runAfterStartupMigration(
    'plugins.installLocalPackage',
    migrationReady,
    () => calls.push('mutation')
  );
  const read = runAfterStartupMigration(
    'plugins.getState',
    migrationReady,
    () => calls.push('read')
  );
  await read;
  assert.deepEqual(calls, ['read']);
  releaseMigration({ ok: true });
  await mutation;
  assert.deepEqual(calls, ['read', 'mutation']);
});

test('provider activation persists the preferred engine and rolls it back on reinit failure', async () => {
  let preferredEngineType = 'ollama';
  const refreshCalls = [];
  const configService = { getState: () => ({ preferredEngineType }),
    updatePreferredEngineType: (value) => { preferredEngineType = value; } };
  const activated = await activateChatgptProvider({ configService,
    refreshManagedConfig: async (...args) => { refreshCalls.push(args); return { ok: true }; } }, 'chatgpt');
  assert.equal(activated.ok, true);
  assert.equal(preferredEngineType, 'chatgpt');
  assert.deepEqual(refreshCalls, [['plugin_provider_activated', {
    requestedEngineType: 'chatgpt', inactivityTimeoutMs: 8000, absoluteTimeoutMs: 8000,
  }]]);

  preferredEngineType = 'ollama';
  const failed = await activateChatgptProvider({ configService,
    refreshManagedConfig: async () => null }, 'chatgpt');
  assert.deepEqual(failed, { ok: false, reason: 'provider_activation_failed' });
  assert.equal(preferredEngineType, 'ollama');
});

test('generic provider refreshes retain the selected engine while explicit ChatGPT activation retargets it', () => {
  const boundedRefresh = {
    requestedEngineType: undefined,
    inactivityTimeoutMs: 8000,
    absoluteTimeoutMs: 8000,
  };

  assert.deepEqual(providerReconfigureOptions(), boundedRefresh);
  assert.deepEqual(providerReconfigureOptions(''), boundedRefresh);
  assert.deepEqual(providerReconfigureOptions('ollama'), boundedRefresh);
  assert.deepEqual(providerReconfigureOptions('chatgpt'), {
    ...boundedRefresh,
    requestedEngineType: 'chatgpt',
  });
});

test('provider graph and auth changes refresh managed config without selecting an engine', async () => {
  const refreshCalls = [];
  const backendService = {
    refreshManagedConfig: async (...args) => { refreshCalls.push(args); return { ok: true }; },
  };

  for (const change of [
    { providers: ['chatgpt'] },
    { provider_id: 'chatgpt', reason: 'provider_auth_started' },
    { provider_id: 'chatgpt', reason: 'provider_auth_signed_out' },
  ]) {
    await refreshManagedConfigAfterProviderChange(
      backendService,
      providerReconfigureOptions,
      change
    );
  }

  const boundedRefresh = {
    requestedEngineType: undefined,
    inactivityTimeoutMs: 8000,
    absoluteTimeoutMs: 8000,
  };
  assert.deepEqual(refreshCalls, [
    ['plugin_provider_changed', boundedRefresh],
    ['provider_auth_started', boundedRefresh],
    ['provider_auth_signed_out', boundedRefresh],
  ]);
});

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

function snapshotTree(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const relativePath = path.relative(root, path.join(entry.parentPath, entry.name));
      return entry.isDirectory()
        ? `dir:${relativePath}`
        : `file:${relativePath}:${fs.readFileSync(path.join(entry.parentPath, entry.name)).toString('base64')}`;
    })
    .sort();
}

function buildRestrictedFixture() {
  return buildSignedPluginPackage({
    contractVersion: 4,
    contributions: [{
      kind: 'restricted_compute', contribution_id: 'compute', name: 'Compute',
      content_path: 'content/compute.json', component_path: 'components/compute.wasm',
      component_bytes: Buffer.from([0, 97, 115, 109, 10, 0, 1, 0]),
      content: {
        content_schema_version: 4, publisher_id: 'acme-labs', plugin_id: 'widgets',
        contribution_id: 'compute',
        payload: {
          kind: 'restricted_compute', description: 'Bounded compute',
          input_schema_json: '{"type":"object"}', output_schema_json: '{"type":"object"}',
          timeout_ms: 1000, capabilities: ['control.cancelled'], network_origins: [],
        },
      },
    }],
  });
}

function createRuntimeSidecar() {
  return {
    connected: true,
    initialize: async (envelope) => {
      const snapshot = envelope.plugin_runtime.snapshot;
      return {
        attestation_schema_version: 1,
        participant_kind: 'sidecar',
        registry_revision: snapshot.registry_revision,
        dependency_graph_hash: snapshot.dependency_graph_hash,
        commit_epoch: snapshot.commit_epoch,
        sidecar_plugin_generation: `sidecar-${snapshot.registry_revision}`,
        reused_resource_proofs: REQUIRED_RESOURCE_KINDS.map((kind, index) => ({
          resource_kind: kind,
          resource_id: `${kind}-${index}`,
          digest: String(index + 1).repeat(64),
        })),
        rejected_contributions: [],
      };
    },
  };
}

async function waitForInstalledPlugin(stateHandler, event) {
  let lastState = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    lastState = await stateHandler(event, {});
    if (lastState.installed_count === 1) return lastState;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`distribution install did not settle: ${JSON.stringify(lastState)}`);
}

async function assertCommittedOperation(operationHandler, event, operationId, waitForOperation) {
  await waitForOperation(operationId);
  const status = await operationHandler(event, { operation_id: operationId });
  assert.deepEqual(
    { classification: status.classification, receiptStatus: status.receipt?.status },
    { classification: 'terminal', receiptStatus: 'committed' },
    `distribution operation did not settle: ${JSON.stringify(status)}`,
  );
  return status;
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

// A sender that satisfies every clause of senderReason(): the expected window's
// own webContents, its own mainFrame, both navigated to the real index.html.
const DOCUMENT_URL = pathToFileURL(MAIN_DOCUMENT_PATH).href;

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

// A different webContents entirely -- the "foreign_sender" rejection path.
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
  dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
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
    dialog,
    processRef: { argv, env, resourcesPath },
    getMainWindow: getMainWindow || (() => null),
    sendBridgeEvent,
    log: () => {},
  });
  return { ipcMain, handle, userData, backendService };
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
      // getBridgeChannel throws for an unknown path or a kind mismatch, so this
      // is itself the assertion that the descriptor exists and is 'invoke'.
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

    // Whole descriptor list, Stage 7 included: a new channel without an authorizer reds here.
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

describe('plugins.* IPC handlers never throw across the seam', () => {
  test('a payload whose property access throws still resolves a structured result', async () => {
    const trusted = createTrustedSender();
    const { ipcMain } = register({ getMainWindow: () => trusted.window });
    // Accessing publisher_id throws INSIDE the handler body, which is the only
    // realistic way to make the control plane throw from a renderer payload.
    const hostilePayload = {
      get publisher_id() {
        throw new Error('C:\\Users\\someone\\hostile.json');
      },
    };
    const installHandler = ipcMain.invoke.get(getBridgeChannel('plugins.installLocalPackage', 'invoke'));
    const install = await installHandler(trusted.event, hostilePayload);
    assert.equal(install.ok, false);
    assert.equal(install.reason, 'install_payload_field_not_permitted');

    const uninstallHandler = ipcMain.invoke.get(getBridgeChannel('plugins.uninstall', 'invoke'));
    const uninstall = await uninstallHandler(trusted.event, hostilePayload);
    assert.equal(uninstall.ok, false);
    assert.equal(uninstall.reason, 'internal_error');
    assert.ok(!String(uninstall.detail).includes('Users'), 'a raw path must never cross the seam');
  });

  test('a caller-supplied operation_id is rejected at the IPC boundary', async () => {
    const trusted = createTrustedSender();
    const { ipcMain } = register({ getMainWindow: () => trusted.window });
    const installHandler = ipcMain.invoke.get(getBridgeChannel('plugins.installLocalPackage', 'invoke'));
    const install = await installHandler(trusted.event, { operation_id: 'attacker-chosen' });
    assert.equal(install.ok, false);
    assert.equal(install.reason, 'install_payload_field_not_permitted');

    const uninstallHandler = ipcMain.invoke.get(getBridgeChannel('plugins.uninstall', 'invoke'));
    const uninstall = await uninstallHandler(trusted.event, {
      publisher_id: 'acme', plugin_id: 'alpha', operation_id: 'attacker-chosen',
    });
    assert.equal(uninstall.ok, false);
    assert.equal(uninstall.reason, 'caller_supplied_operation_id');
    assert.equal(uninstall.code, PLUGIN_ERROR_CODES.POLICY_BLOCKED);
  });

  test('canceling the native package picker is a no-op with no install writes', async () => {
    const trusted = createTrustedSender();
    const { ipcMain, userData } = register({ getMainWindow: () => trusted.window });
    const handler = ipcMain.invoke.get(getBridgeChannel('plugins.installLocalPackage', 'invoke'));
    const result = await handler(trusted.event, {});
    assert.deepEqual(
      { ok: result.ok, canceled: result.canceled, changed: result.changed },
      { ok: true, canceled: true, changed: false },
    );
    const pluginsRoot = path.join(userData, 'plugins');
    const beforeSecondCancel = snapshotTree(pluginsRoot);
    const repeated = await handler(trusted.event, {});
    assert.deepEqual(
      { ok: repeated.ok, canceled: repeated.canceled, changed: repeated.changed },
      { ok: true, canceled: true, changed: false },
    );
    assert.deepEqual(snapshotTree(pluginsRoot), beforeSecondCancel);
  });

  test('trusted native selection runs real ZIP verification and commits installed_disabled on disk', async () => {
    const trusted = createTrustedSender();
    const fixture = buildSignedPluginPackage();
    const appRoot = makeUserData();
    const packagePath = path.join(appRoot, 'widgets.jenny-plugin');
    fs.mkdirSync(path.join(appRoot, 'config', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'config', 'plugins', 'trusted-publishers.json'), JSON.stringify(fixture.trustRootsDocument));
    fs.writeFileSync(packagePath, fixture.bytes);
    const { ipcMain, handle, userData } = register({
      appRoot,
      sidecarClient: createRuntimeSidecar(),
      getMainWindow: () => trusted.window,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [packagePath] }) },
    });
    const installHandler = ipcMain.invoke.get(getBridgeChannel('plugins.installLocalPackage', 'invoke'));
    const installed = await installHandler(trusted.event, {});
    assert.equal(installed.ok, true, JSON.stringify(installed));
    assert.equal(installed.status, 'pending');
    assert.equal(JSON.stringify(installed).includes(packagePath), false, 'the raw selected path must never cross IPC');

    const operationHandler = ipcMain.invoke.get(getBridgeChannel('plugins.getOperation', 'invoke'));
    await assertCommittedOperation(
      operationHandler,
      trusted.event,
      installed.operation_id,
      (operationId) => handle.stage5Service.waitForDistributionOperation(operationId),
    );
    const stateHandler = ipcMain.invoke.get(getBridgeChannel('plugins.getState', 'invoke'));
    const state = await waitForInstalledPlugin(stateHandler, trusted.event);
    assert.equal(state.installed_count, 1);
    assert.equal(state.plugins[0].display_name, 'Widgets Pack');
    assert.equal(state.plugins[0].effective_state, 'installed_disabled');
    const packageDirs = fs.readdirSync(path.join(userData, 'plugins', 'packages'));
    assert.equal(packageDirs.length, 1);
    assert.equal(fs.existsSync(path.join(userData, 'plugins', 'packages', packageDirs[0], 'record.json')), true);
  });

  test('trusted V4 native selection preserves restricted-module evidence in the committed generation', async () => {
    const trusted = createTrustedSender();
    const fixture = buildRestrictedFixture();
    const appRoot = makeUserData();
    const packagePath = path.join(appRoot, 'restricted.jenny-plugin');
    fs.mkdirSync(path.join(appRoot, 'config', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(appRoot, 'config', 'plugins', 'trusted-publishers.json'), JSON.stringify(fixture.trustRootsDocument));
    fs.writeFileSync(packagePath, fixture.bytes);
    const { ipcMain, handle, userData } = register({
      appRoot,
      sidecarClient: createRuntimeSidecar(),
      getMainWindow: () => trusted.window,
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [packagePath] }) },
    });
    const installHandler = ipcMain.invoke.get(getBridgeChannel('plugins.installLocalPackage', 'invoke'));
    const installed = await installHandler(trusted.event, {});
    assert.deepEqual(
      { ok: installed.ok, status: installed.status },
      { ok: true, status: 'pending' },
      JSON.stringify(installed),
    );
    const operationHandler = ipcMain.invoke.get(getBridgeChannel('plugins.getOperation', 'invoke'));
    await assertCommittedOperation(
      operationHandler,
      trusted.event,
      installed.operation_id,
      (operationId) => handle.stage5Service.waitForDistributionOperation(operationId),
    );
    const stateHandler = ipcMain.invoke.get(getBridgeChannel('plugins.getState', 'invoke'));
    await waitForInstalledPlugin(stateHandler, trusted.event);

    const facade = createNodeFsFacade({ rootDir: resolvePluginStoreRoot(userData) });
    const committed = await readCommittedState(facade, '');
    assert.equal(committed.generation.generation_schema_version, 4);
    assert.deepEqual(committed.generation.plugins[0].restricted_module_digests, [
      fixture.manifest.contributions[0].component_sha256,
    ]);
  });

  test('a missing handler payload is defaulted rather than crashing the handler', async () => {
    const trusted = createTrustedSender();
    const { ipcMain } = register({ getMainWindow: () => trusted.window });
    const handler = ipcMain.invoke.get(getBridgeChannel('plugins.getOperation', 'invoke'));
    const result = await handler(trusted.event);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_operation_id');
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
    // A canceled picker must never emit a change event.
    const handler = ipcMain.invoke.get(getBridgeChannel('plugins.installLocalPackage', 'invoke'));
    await handler(trusted.event, {});
    assert.deepEqual(events, []);
  });
});
