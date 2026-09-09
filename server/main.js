'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDiskAdmission } = require('./resource-limits');
const { loadHostConfig } = require('./config');
const { assertImportComplete } = require('../services/host/maintenance-commands');
const { acquireProfile } = require('../services/host/profile-ownership');
const { createHostedBackend } = require('../services/host/service-composition');
const { FileSecretStore } = require('./file-secret-store');
const { ExecutionBroker } = require('../services/host/execution-broker');
const { AuthService } = require('./auth-service');
const { ClientRegistry } = require('./client-registry');
const { ControlLeases } = require('./control-leases');
const { CommandReceipts } = require('./command-receipts');
const { BackendEvents } = require('./backend-events');
const { createCommandRouter } = require('./command-router');
const { createAssetCommands } = require('../services/host/asset-commands');
const { createArtifactCommands } = require('../services/host/artifact-commands');
const { createAssetRoutes } = require('./asset-routes');
const { createArtifactRoutes } = require('./artifact-routes');
const { createHttpServer } = require('./http-server');

function log(level, event, fields = {}) {
  // This edge records only explicit operational metadata, never exception,
  // request body, cookie, provider, or URL text.
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}

function acquireConfiguredProfile(configPath, { acquireProfileImpl = acquireProfile } = {}) {
  const before = loadHostConfig(configPath);
  const lock = acquireProfileImpl({ userDataPath: before.userDataPath,
    pythonExecutable: before.pythonExecutable || '/opt/jenny-venv/bin/python' });
  try {
    // Setup may have committed while startup was between its first read and
    // profile acquisition. Never combine that old endpoint with a new key.
    const config = loadHostConfig(configPath);
    if (config.userDataPath !== before.userDataPath) throw new Error('host_profile_changed_during_start');
    return { config, lock };
  } catch (error) { lock.release(); throw error; }
}

async function startHostedServer(configPath) {
  const { config, lock } = acquireConfiguredProfile(configPath);
  const pythonExecutable = config.pythonExecutable || '/opt/jenny-venv/bin/python';
  let composition;
  let executionBroker;
  let events;
  let router;
  let transport;
  let stopPromise;
  let ready = false;
  let assets;
  let assetSweep;
  const stop = () => {
    stopPromise ||= (async () => {
      ready = false;
      clearInterval(assetSweep);
      assets?.dispose();
      const failures = [];
      try { await transport?.close(); } catch (error) { failures.push(error); }
      router?.dispose();
      events?.dispose();
      // Keep the exclusive profile lock on an uncertain child exit. The
      // process/container shutdown watchdog is the final teardown boundary.
      const result = await composition?.stop();
      if (composition && result?.exitConfirmed !== true) throw new Error('host_child_exit_unconfirmed');
      await executionBroker?.close();
      try { composition?.dispose(); } finally { lock.release(); }
      if (failures.length) throw new AggregateError(failures, 'host_transport_stop_failed');
    })();
    return stopPromise;
  };
  try {
    assertImportComplete(config.userDataPath);
    const clients = new ClientRegistry();
    const leases = new ControlLeases();
    const auth = new AuthService({ filePath: path.join(config.userDataPath, 'auth.json'), logger: log,
      onInvalidate: (deviceId) => {
        clients.revokeDevice(deviceId);
        leases.revokeDevice(deviceId);
        events?.revokeDevice(deviceId);
      } });
    if (!auth.isConfigured()) throw new Error('owner_initialization_required');
    if (config.execution) {
      executionBroker = new ExecutionBroker({ userDataPath: config.userDataPath, logger: log });
      await executionBroker.prepare();
    }
    composition = createHostedBackend({ ...config, pythonExecutable, executionBroker,
      repoRoot: path.resolve(__dirname, '..'),
      credentialService: new FileSecretStore({ directory: config.secretsDir }) });
    assets = createAssetCommands({ backend: composition.backend, userDataPath: config.userDataPath });
    const sweep = () => { try { assets.pruneExpired(); } catch { log('WARN', 'host.asset_cleanup_failed'); } };
    sweep();
    assetSweep = setInterval(sweep, 3_600_000); assetSweep.unref();
    const canAdmit = createDiskAdmission([config.userDataPath, config.workspaceRoot], { logger: log });
    const assetRoutes = createAssetRoutes({ commands: { ...assets, upload: (params) => canAdmit()
      ? assets.upload(params) : { ok: false, error: { kind: 'unavailable', reason: 'disk_pressure', retryable: true } } } });
    const artifactRoutes = createArtifactRoutes({ commands: createArtifactCommands(composition) });
    const bootEpoch = randomUUID();
    events = new BackendEvents({ backend: composition.backend, bootEpoch });
    router = createCommandRouter({ backend: composition.backend, clients, leases,
      receipts: new CommandReceipts({ filePath: path.join(config.userDataPath, 'command-receipts.json') }),
      bootEpoch, eventStream: events, resolveAttachments: assets.resolveAttachments, canAdmit });
    transport = createHttpServer({ canonicalOrigin: config.canonicalOrigin,
      browserAccessMode: config.browserAccessMode,
      executionStatus: () => executionBroker?.status().available === true,
      staticRoot: path.resolve(__dirname, '..', 'build', 'browser'),
      auth, clients, events, router, bootEpoch, resourceLimits: config.resourceLimits,
      isReady: () => ready && Boolean(composition.backend.sidecarManager.process)
        && composition.backend._hostedPolicyProcess === composition.backend.sidecarManager.process,
      assetRoutes: async (context) => await assetRoutes(context) || await artifactRoutes(context),
      logger: log });
    // History and owner login remain available when an external model is down.
    try { await composition.start(); }
    catch { log('WARN', 'host.model_unavailable'); }
    ready = true;
    await new Promise((resolve, reject) => {
      transport.server.once('error', reject);
      transport.server.listen(config.port, config.listenHost, () => {
        transport.server.off('error', reject); resolve();
      });
    });
    log('INFO', 'host.listening', { boot_epoch: bootEpoch, ready: Boolean(composition.backend.sidecarManager.process)
      && composition.backend._hostedPolicyProcess === composition.backend.sidecarManager.process });
    return { stop };
  } catch (error) {
    try { await stop(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'host_start_cleanup_failed', { cause: cleanupError });
    }
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--config' || !path.isAbsolute(argv[1])) throw new Error('invalid_arguments');
  const host = await startHostedServer(argv[1]);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const watchdog = setTimeout(() => { process.exitCode = 1; process.exit(1); }, 20_000);
    watchdog.unref();
    host.stop().then(() => { clearTimeout(watchdog); log('INFO', 'host.stopped'); })
      .catch(() => { log('ERROR', 'host.stop_failed'); process.exitCode = 1; });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return host;
}

if (require.main === module) {
  main().catch(() => { log('ERROR', 'host.start_failed'); process.exitCode = 1; });
}

module.exports = { startHostedServer, main, acquireConfiguredProfile };
