'use strict';

// Focused seam test for the unpackaged-run bundled-ChatGPT fallback in
// services/main/plugins-ipc-registration.js: when the resourcesRoot copy of
// plugins/chatgpt-subscription.jenny-plugin is missing (dev checkouts have no
// build/plugins/), loadBundledPackage retries under <appRoot>/plugins with the
// sha256 pin and signature verification intact, so the startup migration
// installs instead of writing a `failed` receipt every launch.
//
// Lives beside tests/plugins-ipc-registration.test.js, which owns the full
// register() composition harness but sits at the plugin-tree 600-line cap;
// this file reproduces only the slice of that harness the fallback needs.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerPluginsRuntime } = require('../services/main/plugins-ipc-registration');
const {
  REQUIRED_RESOURCE_KINDS,
} = require('../services/plugins/runtime/runtime-apply-coordinator');

const createdRoots = [];

after(() => {
  for (const root of createdRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-plugins-devfb-'));
  createdRoots.push(root);
  return root;
}

function createFakeIpcMain() {
  return { handle() {}, on() {} };
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

test('unpackaged startup retries the bundled ChatGPT package from the app root', async () => {
  const appRoot = makeRoot();
  for (const relativePath of [
    'plugins/chatgpt-subscription.jenny-plugin',
    'config/plugins/trusted-publishers.json',
  ]) {
    const target = path.join(appRoot, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), ...relativePath.split('/')), target);
  }
  const userData = makeRoot();
  const handle = registerPluginsRuntime(createFakeIpcMain(), {
    backendService: {
      featureFlags: { plugins: true },
      sidecarClient: createRuntimeSidecar(),
    },
    app: {
      getPath: () => userData,
      getAppPath: () => appRoot,
      once: () => {},
      isPackaged: false,
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    // resourcesPath deliberately points at the (empty) build/ dir a dev
    // checkout would have, so the primary read misses and the fallback runs.
    processRef: { argv: [], env: {}, resourcesPath: path.join(appRoot, 'build') },
    getMainWindow: () => null,
    sendBridgeEvent: () => {},
    log: () => {},
  });
  const result = await handle.startupReady;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.available, true);
  await handle.dispose();
});
