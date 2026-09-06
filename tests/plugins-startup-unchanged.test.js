'use strict';

// THE STAGE-3 EXIT-GATE PROOF.
//
// The rule that outranks everything else in the W9-3B-SURFACE packet: with the
// default-off `plugins` feature flag OFF, startup behaviour is unchanged.
// Everyone who never installs a plugin must be unable to tell this packet
// landed. Concretely, flag-off must mean:
//
//   1. no module under `services/plugins/` is ever require()d -- not even
//      transitively, not even at module-load time;
//   2. no `plugins.*` IPC handler is registered, so the channels exist in the
//      contract but resolve as unknown-channel;
//   3. nothing reads, creates, or stats any path under `userData/plugins/`.
//
// Plus the flag-ON-but-safe-mode posture: the surface EXISTS (so a renderer can
// discover why it is refused) while every mutation refuses and the store is
// never written.
//
// These are asserted, not promised. A top-level `require` of the control plane
// in services/main/plugins-ipc-registration.js fails the first test below --
// which is the single strongest line in the exit pack.

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');

const REPO_ROOT = path.resolve(__dirname, '..');
const PLUGIN_TREE_MARKER = `${path.sep}services${path.sep}plugins${path.sep}`;
const NODE_MODULES_MARKER = `${path.sep}node_modules${path.sep}`;

const createdRoots = [];

after(() => {
  for (const root of createdRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeUserData() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-plugins-startup-'));
  createdRoots.push(root);
  return root;
}

// Drops every repo-owned module from the CommonJS cache so a load can be
// observed from a known-clean state. node:test runs each test FILE in its own
// child process, so this cannot disturb another suite.
function purgeRepoModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(REPO_ROOT) && !key.includes(NODE_MODULES_MARKER)) {
      delete require.cache[key];
    }
  }
}

function loadedPluginModules() {
  return Object.keys(require.cache)
    .filter((key) => key.includes(PLUGIN_TREE_MARKER))
    .map((key) => path.relative(REPO_ROOT, key).split(path.sep).join('/'))
    .sort();
}

function expectedPluginInvokeChannels(registration) {
  return [
    ...Object.keys(registration.PLUGIN_INVOKE_METHODS),
    ...Object.keys(registration.PLUGIN_STAGE5_INVOKE_METHODS),
    ...Object.keys(registration.PLUGIN_STAGE7_INVOKE_METHODS),
    'plugins.viewBridge',
  ].map((methodPath) => getBridgeChannel(methodPath, 'invoke'));
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

// A recording double for the guidance services, used only to give the control
// and packet runs a non-empty, identical baseline channel set to compare.
function guidanceDouble() {
  return {
    getState: () => ({}),
    updateSettings: () => ({}),
    openScopeFolder: () => ({}),
  };
}

function flagOffDeps({ app, processRef } = {}) {
  return {
    backendService: { featureFlags: { plugins: false } },
    app: app || { getPath: () => makeUserData(), once: () => {} },
    processRef: processRef || { argv: [], env: {} },
    getMainWindow: () => null,
    sendBridgeEvent: () => {},
    log: () => {},
  };
}

describe('flag-off loads no plugin module', () => {
  test('requiring the main IPC registry pulls in nothing under services/plugins', () => {
    purgeRepoModules();
    // The whole registration surface, loaded exactly as startup loads it.
    require('../services/main/ipc-handler-registration');
    assert.deepEqual(
      loadedPluginModules(),
      [],
      'a top-level require of the control plane would appear here'
    );
  });

  test('calling registerPluginsRuntime with the flag off loads nothing either', () => {
    purgeRepoModules();
    const { registerPluginsRuntime } = require('../services/main/plugins-ipc-registration');
    assert.deepEqual(loadedPluginModules(), [], 'the seam module itself must load no plugin code');

    const handle = registerPluginsRuntime(createFakeIpcMain(), flagOffDeps());
    assert.equal(handle, null, 'the flag-off call returns null without composing anything');
    assert.equal(registerPluginsRuntime(createFakeIpcMain(), {
      ...flagOffDeps(), backendService: { featureFlags: {
        plugins: false, plugin_developer_profile: true,
      } },
    }), null, 'the developer flag cannot bypass the platform kill switch');
    assert.deepEqual(loadedPluginModules(), []);
  });

  test('an absent backendService or featureFlags object is treated as flag-off', () => {
    purgeRepoModules();
    const { registerPluginsRuntime } = require('../services/main/plugins-ipc-registration');
    assert.equal(registerPluginsRuntime(createFakeIpcMain(), {}), null);
    assert.equal(registerPluginsRuntime(createFakeIpcMain(), { backendService: {} }), null);
    assert.equal(
      registerPluginsRuntime(createFakeIpcMain(), { backendService: { featureFlags: { plugins: 'true' } } }),
      null,
      'only the boolean true opens the seam'
    );
    assert.deepEqual(loadedPluginModules(), []);
  });
});

describe('flag-off registers no IPC channel', () => {
  test('the registered channel set is byte-identical to a control run', () => {
    const { registerGuidanceIpcHandlers } = require('../services/main/ipc-handler-registration');
    const { registerPluginsRuntime } = require('../services/main/plugins-ipc-registration');

    // Both fakes get the same pre-packet registration; only the packet run also
    // calls registerPluginsRuntime. Computing both sets from the same fake is
    // what keeps this honest -- a hand-maintained literal list would rot.
    const controlIpc = createFakeIpcMain();
    const packetIpc = createFakeIpcMain();
    registerGuidanceIpcHandlers(controlIpc, guidanceDouble(), guidanceDouble());
    registerGuidanceIpcHandlers(packetIpc, guidanceDouble(), guidanceDouble());

    assert.equal(registerPluginsRuntime(packetIpc, flagOffDeps()), null);

    const controlChannels = [...controlIpc.invoke.keys()];
    assert.ok(controlChannels.length > 0, 'the baseline must be non-empty to be meaningful');
    assert.deepEqual([...packetIpc.invoke.keys()], controlChannels);
    assert.deepEqual([...packetIpc.send.keys()], [...controlIpc.send.keys()]);
  });

  test('zero handle() calls are made for any plugins: channel', () => {
    const registration = require('../services/main/plugins-ipc-registration');
    const { registerPluginsRuntime } = registration;
    const ipcMain = createFakeIpcMain();
    assert.equal(registerPluginsRuntime(ipcMain, flagOffDeps()), null);

    const registered = [...ipcMain.invoke.keys(), ...ipcMain.send.keys()];
    assert.deepEqual(registered.filter((channel) => channel.startsWith('plugins:')), []);
    // Resolved from the contract, so a channel rename cannot leave this stale.
    for (const channel of expectedPluginInvokeChannels(registration)) {
      assert.equal(ipcMain.invoke.has(channel), false, `${channel} must stay unhandled`);
    }
  });
});

describe('flag-off touches no path under userData/plugins', () => {
  test('userData is never even resolved, and no plugins directory appears', () => {
    const { registerPluginsRuntime } = require('../services/main/plugins-ipc-registration');
    const userData = makeUserData();
    const getPathCalls = [];
    const app = {
      getPath: (name) => {
        getPathCalls.push(name);
        return userData;
      },
      once: () => {
        throw new Error('flag-off must not register a will-quit teardown');
      },
    };
    const argv = ['--plugins-safe-mode'];
    const env = { JENNY_PLUGINS_SAFE_MODE: '1' };

    const handle = registerPluginsRuntime(createFakeIpcMain(), flagOffDeps({
      app,
      processRef: { argv, env },
    }));

    assert.equal(handle, null);
    assert.deepEqual(getPathCalls, [], 'app.getPath must never be called with the flag off');
    assert.equal(fs.existsSync(path.join(userData, 'plugins')), false);
    assert.deepEqual(fs.readdirSync(userData), [], 'nothing at all is created under userData');
  });
});

describe('flag-on with safe mode: the surface exists but refuses', () => {
  test('all six channels register while every mutation refuses SAFE_MODE_ACTIVE', async () => {
    const registration = require('../services/main/plugins-ipc-registration');
    const { registerPluginsRuntime } = registration;
    const { PLUGIN_ERROR_CODES } = require('../services/backend/error-codes');

    const ipcMain = createFakeIpcMain();
    const userData = makeUserData();
    const handle = registerPluginsRuntime(ipcMain, {
      backendService: { featureFlags: { plugins: true } },
      app: { getPath: () => userData, getAppPath: () => process.cwd(), once: () => {} },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      processRef: { argv: ['--plugins-safe-mode'], env: {} },
      getMainWindow: () => null,
      sendBridgeEvent: () => {},
      log: () => {},
    });

    assert.notEqual(handle, null);
    assert.equal(handle.safeMode.active, true);
    assert.equal(handle.safeMode.source, 'argv');
    // The surface EXISTS: a renderer can reach it and be told why it refused.
    assert.deepEqual(
      [...ipcMain.invoke.keys()].sort(),
      [...expectedPluginInvokeChannels(registration)].sort()
    );

    for (const method of ['installLocalPackage', 'uninstall']) {
      const payload = method === 'installLocalPackage' ? {} : { publisher_id: 'acme', plugin_id: 'alpha' };
      const result = await handle.service[method](payload);
      assert.equal(result.ok, false, method);
      assert.equal(result.code, PLUGIN_ERROR_CODES.SAFE_MODE_ACTIVE, method);
      assert.equal(result.safe_mode_active, true, method);
    }

    const counts = handle.facade.callCounts;
    const writes = counts.writeFile + counts.renameFile + counts.mkdir + counts.remove + counts.fsyncFile;
    assert.equal(writes, 0, 'safe mode must never write to the store');
    assert.equal(
      Object.values(counts).reduce((sum, count) => sum + count, 0),
      0,
      'safe mode must not touch the store at all'
    );
    assert.equal(fs.existsSync(path.join(userData, 'plugins')), false);
  });
});
