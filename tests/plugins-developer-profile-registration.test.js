'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { getBridgeChannel } = require('../services/ipc-contract');
const { buildFeatureFlags } = require('../services/feature-flags');
const { MAIN_DOCUMENT_PATH } = require('../services/main/ipc-sender-authorization');
const { PLUGIN_ERROR_CODES } = require('../services/backend/error-codes');
const { registerPluginsRuntime, PLUGIN_STAGE5_INVOKE_METHODS,
  runAfterStartupMigration } = require('../services/main/plugins-ipc-registration');
const { createDeveloperProfileSeams } = require('../services/main/plugins-developer-profile');
const { DEVELOPER_UNSIGNED_KEY_ID,
  verifyDistributionPackage } = require('../services/plugins/package/distribution-package-intake');
const { createProductionDistributionContextFactory,
  digest } = require('../services/plugins/distribution/production-context');
const { REQUIRED_RESOURCE_KINDS } = require('../services/plugins/runtime/runtime-apply-coordinator');
const { buildSignedPluginPackage } = require('./helpers/plugins/zip-fixture-builder');

const NOW = '2026-09-01T00:00:00Z';
const EMPTY_ROOTS_DOCUMENT = Object.freeze({
  trust_roots_schema_version: 1, updated_at: NOW, publishers: [],
});

function fakeIpcMain() {
  const invoke = new Map();
  return { invoke, send: new Map(), handle(channel, handler) { invoke.set(channel, handler); },
    on(channel, handler) { this.send.set(channel, handler); } };
}

function trustedSender() {
  const mainFrame = { url: pathToFileURL(MAIN_DOCUMENT_PATH).href };
  const webContents = { id: 1, mainFrame, isDestroyed: () => false,
    getURL: () => mainFrame.url };
  return { window: { webContents, isDestroyed: () => false },
    event: { sender: webContents, senderFrame: mainFrame } };
}

function runtimeSidecar() {
  return { connected: true, initialize: async (envelope) => {
    const snapshot = envelope.plugin_runtime.snapshot;
    return { attestation_schema_version: 1, participant_kind: 'sidecar',
      registry_revision: snapshot.registry_revision,
      dependency_graph_hash: snapshot.dependency_graph_hash,
      commit_epoch: snapshot.commit_epoch,
      sidecar_plugin_generation: `sidecar-${snapshot.registry_revision}`,
      reused_resource_proofs: REQUIRED_RESOURCE_KINDS.map((kind, index) => ({
        resource_kind: kind, resource_id: `${kind}-${index}`,
        digest: String(index + 1).repeat(64),
      })), rejected_contributions: [] };
  } };
}

function register(t, { developerEnabled, packagePath, logs = [],
  trustRootsDocument = EMPTY_ROOTS_DOCUMENT }) {
  const ipcMain = fakeIpcMain();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-developer-profile-'));
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-developer-app-'));
  t.after(() => {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(appRoot, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(appRoot, 'config', 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'config', 'plugins', 'trusted-publishers.json'),
    JSON.stringify(trustRootsDocument));
  const sender = trustedSender();
  const backendService = { featureFlags: { plugins: true,
    plugin_developer_profile: developerEnabled, privileged_plugins: false },
    sidecarClient: runtimeSidecar() };
  const handle = registerPluginsRuntime(ipcMain, { backendService,
    app: { getPath: () => userData, getAppPath: () => appRoot, once: () => {},
      isPackaged: false },
    processRef: { argv: [], env: {}, resourcesPath: path.join(appRoot, 'build') },
    getMainWindow: () => sender.window, sendBridgeEvent: () => {},
    log: (...entry) => logs.push(entry) });
  return { ipcMain, handle, sender, userData, backendService };
}

async function waitForOperation(handle, operationId) {
  const terminal = await handle.stage5Service.waitForDistributionOperation(operationId);
  const state = await handle.service.getOperation({ operation_id: operationId });
  return { receipt: state.receipt, terminal };
}

test('developer flag defaults on, has a kill switch, and registers the path method', async () => {
  assert.equal(buildFeatureFlags({}).plugin_developer_profile, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_PLUGIN_DEVELOPER_PROFILE: '0' })
    .plugin_developer_profile, false);
  assert.equal(PLUGIN_STAGE5_INVOKE_METHODS['plugins.installLocalPackageFromPath'],
    'installPackageFromPath');
  let release;
  const migration = new Promise((resolve) => { release = resolve; });
  let ran = false;
  const pending = runAfterStartupMigration('plugins.installLocalPackageFromPath', migration,
    () => { ran = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ran, false);
  release();
  await pending;
  assert.equal(ran, true);
});

test('developer seam is signed-first, managed-policy bounded, and observable', async () => {
  const fixture = buildSignedPluginPackage({ contractVersion: 3 });
  const selected = { bytes: fixture.bytes, sourcePathDigest: fixture.sourcePathDigest };
  const logs = [];
  const enabled = createDeveloperProfileSeams({ enabled: true,
    trustRootsProvider: async () => ({ ok: true, value: EMPTY_ROOTS_DOCUMENT,
      publishers: new Map() }),
    log: (...entry) => logs.push(entry) });
  const accepted = await enabled.inspectLocalPackage(selected);
  assert.equal(accepted.ok, true, accepted.reason);
  assert.deepEqual(accepted.package_record.source_identity, {
    kind: 'local_package', package_path_digest: fixture.sourcePathDigest,
  });
  assert.equal(accepted.package_record.signing_key_id, DEVELOPER_UNSIGNED_KEY_ID);
  assert.deepEqual(logs[0], ['INFO', 'plugins.developer_profile.accepted', {
    publisher_id: 'acme-labs', plugin_id: 'widgets',
    link_digest: accepted.archive_digest,
  }]);

  const disabled = createDeveloperProfileSeams({ enabled: false,
    trustRootsProvider: enabledTrustRoots, managedPolicy: null });
  const refused = await disabled.inspectLocalPackage(selected);
  assert.deepEqual({ code: refused.code, reason: refused.reason }, {
    code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED, reason: 'publisher_not_pretrusted',
  });
  async function enabledTrustRoots() {
    return { ok: true, value: EMPTY_ROOTS_DOCUMENT, publishers: new Map() };
  }
});

test('install-from-path commits developer source kind and catalog update is refused', async (t) => {
  const fixture = buildSignedPluginPackage({ contractVersion: 3 });
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-developer-package-'));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  const packagePath = path.join(packageRoot, 'widgets.jenny-plugin');
  fs.writeFileSync(packagePath, fixture.bytes);
  const logs = [];
  const { ipcMain, handle, sender } = register(t, {
    developerEnabled: true, packagePath, logs,
  });
  const handler = ipcMain.invoke.get(getBridgeChannel(
    'plugins.installLocalPackageFromPath', 'invoke'
  ));
  const started = await handler(sender.event, {
    client_request_id: 'developer_path', path: packagePath,
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const settled = await waitForOperation(handle, started.operation_id);
  assert.equal(settled.receipt.status, 'committed', JSON.stringify(settled));
  const state = await handle.service.getState();
  assert.equal(state.plugins[0].source_kind, 'developer_link');
  assert.equal(logs.some((entry) => entry[1] === 'plugins.developer_profile.accepted'), true);

  const trustRoots = { ok: true, value: EMPTY_ROOTS_DOCUMENT, publishers: new Map() };
  const verifyPackage = (args) => verifyDistributionPackage({ bytes: args.bytes,
    sourceIdentity: args.sourceIdentity, trustRoots,
    verificationCacheKey: args.packageRecord.verification_cache_key,
    now: args.now,
    developerProfile: args.packageRecord.signing_key_id === DEVELOPER_UNSIGNED_KEY_ID });
  const createContext = createProductionDistributionContextFactory({
    facade: handle.facade, baseDir: '', trustRootsProvider: async () => trustRoots,
    readLocalPackage: async () => ({ ok: false }), contractLockDigest: digest({ lock: 1 }),
    verifyPackage, developerProfileEnabled: true,
  });
  const update = await createContext({ operation: { kind: 'update',
    source_kind: 'signed_catalog', target: { publisher_id: 'acme-labs', plugin_id: 'widgets' } } });
  assert.deepEqual({ ok: update.ok, code: update.code, reason: update.reason }, {
    ok: false, code: PLUGIN_ERROR_CODES.POLICY_BLOCKED,
    reason: 'developer_install_not_updatable',
  });
});

test('flag-off developer records are ineligible and do not block a signed local install', async (t) => {
  const developerFixture = buildSignedPluginPackage({ contractVersion: 3,
    publisherId: 'dev-labs', pluginId: 'dev-widget', name: 'Developer Widget' });
  const signedFixture = buildSignedPluginPackage({ contractVersion: 3,
    publisherId: 'signed-labs', pluginId: 'signed-widget', name: 'Signed Widget' });
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-developer-exclusion-'));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  const developerPath = path.join(packageRoot, 'developer.jenny-plugin');
  const signedPath = path.join(packageRoot, 'signed.jenny-plugin');
  fs.writeFileSync(developerPath, developerFixture.bytes);
  fs.writeFileSync(signedPath, signedFixture.bytes);
  const { ipcMain, handle, sender, backendService } = register(t, {
    developerEnabled: true, trustRootsDocument: signedFixture.trustRootsDocument,
  });
  const install = ipcMain.invoke.get(getBridgeChannel(
    'plugins.installLocalPackageFromPath', 'invoke'
  ));
  const developerStarted = await install(sender.event, {
    client_request_id: 'developer_before_kill_switch', path: developerPath,
  });
  assert.equal(developerStarted.ok, true, JSON.stringify(developerStarted));
  assert.equal((await waitForOperation(handle, developerStarted.operation_id)).receipt.status,
    'committed');

  backendService.featureFlags.plugin_developer_profile = false;
  const disabledState = await handle.service.getState();
  assert.equal(disabledState.plugins[0].source_kind, 'developer_link');
  assert.equal(disabledState.plugins[0].activation_eligible, false);
  assert.notEqual(disabledState.plugins[0].effective_state, 'active');

  const signedStarted = await install(sender.event, {
    client_request_id: 'signed_after_kill_switch', path: signedPath,
  });
  assert.equal(signedStarted.ok, true, JSON.stringify(signedStarted));
  assert.equal((await waitForOperation(handle, signedStarted.operation_id)).receipt.status,
    'committed');
  const signedState = await handle.service.getState();
  assert.deepEqual(signedState.plugins.map((plugin) => plugin.plugin_id), ['signed-widget']);
});

test('flag-off install-from-path keeps unsigned publishers untrusted', async (t) => {
  const fixture = buildSignedPluginPackage({ contractVersion: 3 });
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-developer-disabled-'));
  t.after(() => fs.rmSync(packageRoot, { recursive: true, force: true }));
  const packagePath = path.join(packageRoot, 'widgets.jenny-plugin');
  fs.writeFileSync(packagePath, fixture.bytes);
  const { ipcMain, sender } = register(t, { developerEnabled: false, packagePath });
  const result = await ipcMain.invoke.get(getBridgeChannel(
    'plugins.installLocalPackageFromPath', 'invoke'
  ))(sender.event, { client_request_id: 'developer_disabled', path: packagePath });
  assert.deepEqual({ code: result.code, reason: result.reason }, {
    code: PLUGIN_ERROR_CODES.PUBLISHER_UNTRUSTED, reason: 'publisher_not_pretrusted',
  });
});
