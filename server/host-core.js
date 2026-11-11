'use strict';

// The composition shared by the single-owner host (server/main.js) and the team
// host (server/team/team-main.js): the hosted backend, the asset commands and
// their hourly sweep, the disk admissions, the asset and artifact routes, the
// backend event stream, the command receipts and the command router. The two
// hosts differ only in what they hand in (`authorize`, `guardRequired`,
// `maxEventClients`, `teamCommands`) and in what they put in front (an HTTP
// server with owner login, or the team listener).

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDiskAdmission, rewriteHeadroom, DELETE_RESERVE_BYTES } = require('./resource-limits');
const { loadHostConfig } = require('./config');
const { acquireProfileAsync } = require('../services/host/profile-ownership');
const { createHostedBackend } = require('../services/host/service-composition');
const { FileSecretStore } = require('./file-secret-store');
const { CommandReceipts } = require('./command-receipts');
const { BackendEvents } = require('./backend-events');
const { createCommandRouter } = require('./command-router');
const { createAssetCommands } = require('../services/host/asset-commands');
const { createArtifactCommands } = require('../services/host/artifact-commands');
const { createAssetRoutes } = require('./asset-routes');
const { createArtifactRoutes } = require('./artifact-routes');

const DEFAULT_PYTHON = '/opt/jenny-venv/bin/python';
const APP_ROOT = path.resolve(__dirname, '..');
const PACKAGED_ROOT_NAME = 'app.asar';

// How the hosted backend starts its sidecar. Inside the packaged desktop app
// (this file under resources/app.asar) the packaged one-file sidecar runs from
// the real resources directory, as the CLI host does; no interpreter is
// guessed. Anywhere else (a source checkout, the Docker image) the sidecar is
// `python -m sidecar` in the repository with the configured interpreter, or
// the image's /opt venv: exactly as before slice 1f-2.
function sidecarLaunchOptions({ config, appRoot = APP_ROOT, platform = process.platform } = {}) {
  if (path.basename(appRoot) === PACKAGED_ROOT_NAME) {
    // Required lazily so the source and Docker routes never load the CLI layout.
    const { hostLaunchOptions, resolveCliRuntime } = require('../services/cli-host/runtime-layout');
    const runtime = resolveCliRuntime({ root: appRoot, env: {}, platform });
    const { repoRoot, resolvePackagedLaunch, pythonRuntimeBundleRoot } = hostLaunchOptions(runtime);
    return { repoRoot, resolvePackagedLaunch, pythonRuntimeBundleRoot };
  }
  return { repoRoot: appRoot, pythonExecutable: config?.pythonExecutable || DEFAULT_PYTHON };
}

function log(level, event, fields = {}) {
  // This edge records only explicit operational metadata, never exception,
  // request body, cookie, provider, or URL text.
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}

// Asynchronous because the Windows profile lock is a named pipe; an injected
// implementation may return the lock or a promise of it. `onLost` fires when
// the lock is lost after it was held.
async function acquireConfiguredProfile(configPath, { acquireProfileImpl = acquireProfileAsync, onLost } = {}) {
  const before = loadHostConfig(configPath);
  const lock = await acquireProfileImpl({ userDataPath: before.userDataPath,
    pythonExecutable: before.pythonExecutable || DEFAULT_PYTHON, onLost });
  try {
    // Setup may have committed while startup was between its first read and
    // profile acquisition. Never combine that old endpoint with a new key.
    const config = loadHostConfig(configPath);
    if (config.userDataPath !== before.userDataPath) throw new Error('host_profile_changed_during_start');
    return { config, lock };
  } catch (error) { lock.release(); throw error; }
}

// Builds the shared objects in the single-owner host's order. A failure part
// way through leaves what was built reachable as `error.hostCore` (a
// non-enumerable `{ dispose, canReleaseLock }`), so the caller's cleanup stops
// exactly that.
function createHostCore({
  config, launch = sidecarLaunchOptions({ config }), pythonExecutable = launch.pythonExecutable, clients, leases,
  executionBroker = null, authorize, guardRequired = false, maxEventClients,
  logger = log, createBackend = createHostedBackend, teamCommands,
}) {
  let composition;
  let events;
  let router;
  let assets;
  let assetSweep;
  let disposePromise;
  let lockReleasable = false;
  // Keep the exclusive profile lock on an uncertain child exit: the caller
  // releases it only after this resolves. The process/container shutdown
  // watchdog is the final teardown boundary.
  const dispose = () => {
    disposePromise ||= (async () => {
      clearInterval(assetSweep);
      assets?.dispose();
      router?.dispose();
      events?.dispose();
      const result = await composition?.stop();
      if (composition && result?.exitConfirmed !== true) throw new Error('host_child_exit_unconfirmed');
      await executionBroker?.close();
      lockReleasable = true;
      await composition?.dispose();
    })();
    return disposePromise;
  };
  // False after an uncertain child exit (or a failed earlier step): the caller
  // keeps the profile lock then. A started dispose that fails in the very last
  // step still lets the lock go, as the single-owner host always did.
  const canReleaseLock = () => lockReleasable;
  try {
    // E19: only a team config may carry no model endpoint, and only it opts in.
    composition = createBackend({ ...config, pythonExecutable, executionBroker, modelOptional: Boolean(config.team),
      executionStagingRoot: config.execution?.stagingRoot || null,
      repoRoot: launch.repoRoot,
      ...(launch.resolvePackagedLaunch ? { resolvePackagedLaunch: launch.resolvePackagedLaunch,
        pythonRuntimeBundleRoot: launch.pythonRuntimeBundleRoot } : {}),
      credentialService: new FileSecretStore({ directory: config.secretsDir }) });
    assets = createAssetCommands({ backend: composition.backend, userDataPath: config.userDataPath });
    const sweep = () => { try { assets.pruneExpired(); } catch { logger('WARN', 'host.asset_cleanup_failed'); } };
    sweep();
    assetSweep = setInterval(sweep, 3_600_000); assetSweep.unref();
    const diskRoots = [config.userDataPath, config.workspaceRoot];
    const canAdmit = createDiskAdmission(diskRoots, { logger });
    const receiptsPath = path.join(config.userDataPath, 'command-receipts.json');
    const canAdmitDeletion = createDiskAdmission(diskRoots, {
      logger, reserveBytes: DELETE_RESERVE_BYTES, extraBytes: () => rewriteHeadroom(receiptsPath),
    });
    const guard = guardRequired ? { guardRequired: true } : {};
    const assetRoutes = createAssetRoutes({ commands: { ...assets, upload: (params) => canAdmit()
      ? assets.upload(params) : { ok: false, error: { kind: 'unavailable', reason: 'disk_pressure', retryable: true } } },
    ...guard });
    const artifactRoutes = createArtifactRoutes({ commands: createArtifactCommands(composition), ...guard });
    const bootEpoch = randomUUID();
    events = new BackendEvents({ backend: composition.backend, bootEpoch,
      ...(maxEventClients === undefined ? {} : { maxClients: maxEventClients }) });
    router = createCommandRouter({ backend: composition.backend, clients, leases,
      receipts: new CommandReceipts({ filePath: receiptsPath }),
      bootEpoch, eventStream: events, resolveAttachments: assets.resolveAttachments, canAdmit, canAdmitDeletion,
      ...(authorize === undefined ? {} : { authorize }), ...(teamCommands ? { teamCommands } : {}) });
    return {
      composition, bootEpoch, events, router, assets,
      assetRoutes: async (context) => await assetRoutes(context) || await artifactRoutes(context),
      // History and owner login remain available when an external model is down.
      async startBackend() {
        // E19: a team host has no model until Phase 4, so nothing is started (no sidecar).
        if (config.modelEndpoint === null) { logger('INFO', 'team.host.model_none'); return; }
        try { await composition.start(); }
        catch { logger('WARN', 'host.model_unavailable'); }
      },
      isBackendReady: () => Boolean(composition.backend.sidecarManager.process)
        && composition.backend._hostedPolicyProcess === composition.backend.sidecarManager.process,
      dispose, canReleaseLock,
    };
  } catch (error) {
    try { Object.defineProperty(error, 'hostCore', { value: { dispose, canReleaseLock }, configurable: true }); }
    catch { /* a frozen error cannot carry the handle */ }
    throw error;
  }
}

module.exports = { log, acquireConfiguredProfile, createHostCore, sidecarLaunchOptions };
