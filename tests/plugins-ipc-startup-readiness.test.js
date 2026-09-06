'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createStartupSafeRuntimeApply,
  registerPluginsRuntime,
  waitForRuntimeSidecar,
} = require('../services/main/plugins-ipc-registration');
const { attachManagedPluginRuntime } = require('../services/backend/managed-plugin-runtime');
const {
  REQUIRED_RESOURCE_KINDS,
} = require('../services/plugins/runtime/runtime-apply-coordinator');

const createdRoots = [];

after(() => {
  for (const root of createdRoots) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-plugins-ready-'));
  createdRoots.push(root);
  return root;
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

function registerStartupRuntime(backendService, appRoot = process.cwd()) {
  const service = { featureFlags: { plugins: true }, sidecarClient: createRuntimeSidecar(),
    ...backendService };
  const userData = makeRoot();
  const handle = registerPluginsRuntime({ handle() {}, on() {}, removeHandler() {} }, {
    backendService: service,
    app: { getPath: () => userData, getAppPath: () => appRoot, once() {}, isPackaged: false },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    processRef: { argv: [], env: {}, resourcesPath: path.join(appRoot, 'build') },
    getMainWindow: () => null,
  });
  return { handle, backendService: service };
}

test('startup migration waits boundedly for the packaged sidecar connection', async () => {
  let current = 0;
  let polls = 0;
  const client = { connected: false, initialize: async () => ({}) };
  const ready = await waitForRuntimeSidecar(() => client, {
    timeoutMs: 100,
    pollMs: 10,
    now: () => current,
    wait: async (delayMs) => {
      current += delayMs;
      polls += 1;
      if (polls === 2) client.connected = true;
    },
  });
  assert.equal(ready, true);
  assert.equal(polls, 2);

  current = 0;
  client.connected = false;
  const timedOut = await waitForRuntimeSidecar(() => client, {
    timeoutMs: 25,
    pollMs: 10,
    now: () => current,
    wait: async (delayMs) => { current += delayMs; },
  });
  assert.equal(timedOut, false);
  assert.equal(current, 25);
});

test('plugin recovery waits for the initial backend handshake instead of restarting it', async () => {
  let initializeCalls = 0;
  let restartCalls = 0;
  const backendService = {
    _managedReadyOnce: false,
    _stopping: false,
    sidecarClient: {
      connected: false,
      initialize: async () => {
        initializeCalls += 1;
        return {};
      },
    },
  };
  const adapter = attachManagedPluginRuntime(backendService, {
    requestApply: createStartupSafeRuntimeApply(backendService),
    restartAndApply: async () => {
      restartCalls += 1;
      return { ok: true };
    },
  });

  const recovery = adapter.reconcile({ mode: 'plugin_runtime' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(initializeCalls, 0);
  assert.equal(restartCalls, 0);

  backendService.sidecarClient.connected = true;
  backendService._managedReadyOnce = true;
  assert.equal((await recovery).ok, true);
  assert.equal(initializeCalls, 1);
  assert.equal(restartCalls, 0);
});

test('provider apply settlement re-arms default-model loading after config refresh', async () => {
  let releaseRefresh;
  let resolveRefreshStarted;
  let resolveAutoLoad;
  let refreshCalls = 0;
  let autoLoadCalls = 0;
  const refreshStarted = new Promise((resolve) => { resolveRefreshStarted = resolve; });
  const autoLoaded = new Promise((resolve) => { resolveAutoLoad = resolve; });
  const { handle, backendService } = registerStartupRuntime({
    configService: { getState: () => ({ preferredEngineType: 'ollama' }) },
    refreshManagedConfig: () => {
      refreshCalls += 1;
      if (refreshCalls > 1) return undefined;
      resolveRefreshStarted();
      return new Promise((resolve) => { releaseRefresh = resolve; });
    },
    _autoLoadDefaultModel() {
      autoLoadCalls += 1;
      if (autoLoadCalls === 1) resolveAutoLoad();
    },
  });

  assert.equal(backendService._providerRuntimeApplyPending('chatgpt'), true);
  await refreshStarted;
  assert.equal(autoLoadCalls, 0);
  releaseRefresh();
  await autoLoaded;
  assert.equal(backendService._providerRuntimeApplyPending('chatgpt'), false);
  assert.equal(autoLoadCalls, 1);
  await handle.startupReady;
  assert.equal(autoLoadCalls, 1);
  await handle.dispose();
  assert.equal(backendService._providerRuntimeApplyPending, null);
});

test('a rejected post-apply refresh still settles the apply predicate', async () => {
  let refreshCalls = 0;
  let autoLoadCalls = 0;
  let resolveAutoLoad;
  const autoLoaded = new Promise((resolve) => { resolveAutoLoad = resolve; });
  const { handle, backendService } = registerStartupRuntime({
    configService: { getState: () => ({ preferredEngineType: 'chatgpt' }) },
    refreshManagedConfig: async () => {
      refreshCalls += 1;
      throw new Error('sidecar reconfigure failed');
    },
    _autoLoadDefaultModel() {
      autoLoadCalls += 1;
      resolveAutoLoad();
    },
  });

  assert.equal(backendService._providerRuntimeApplyPending('chatgpt'), true);
  await autoLoaded;
  // Without the finally around refreshManagedConfigAfterProviderChange the
  // predicate would stay pending forever and the honest WARN could never fire.
  assert.equal(backendService._providerRuntimeApplyPending('chatgpt'), false);
  assert.equal(refreshCalls, 1);
  assert.equal(autoLoadCalls, 1);
  await handle.startupReady;
  assert.equal(autoLoadCalls, 1);
  await handle.dispose();
});

test('migration without an available provider settles and re-arms default-model loading', async () => {
  let autoLoadCalls = 0;
  const { handle, backendService } = registerStartupRuntime({
    configService: { getState: () => ({ preferredEngineType: 'chatgpt' }) },
    _autoLoadDefaultModel() { autoLoadCalls += 1; },
  }, makeRoot());

  assert.equal(backendService._providerRuntimeApplyPending('chatgpt'), true);
  const result = await handle.startupReady;
  assert.notEqual(result.available, true);
  assert.equal(backendService._providerRuntimeApplyPending('chatgpt'), false);
  assert.equal(autoLoadCalls, 1);
  await handle.dispose();
});
