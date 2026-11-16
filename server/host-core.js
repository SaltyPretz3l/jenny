'use strict';

// The composition shared by the single-owner host (server/main.js) and the team
// host (server/team/team-main.js): the hosted backend, the asset commands and
// their hourly sweep, the disk admissions, the asset and artifact routes, the
// backend event stream, the command receipts and the command router. The two
// hosts differ only in what they hand in (`authorize`, `guardRequired`,
// `maxEventClients`, `teamCommands`, `sessionScope`) and in what they put in front (an HTTP
// server with owner login, or the team listener).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { HOST_ERROR_CODES } = require('../services/backend/error-codes');
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
  // request body, cookie, provider, or URL text. The line's own keys win over a field of the same name.
  process.stdout.write(`${JSON.stringify({ ...fields, timestamp: new Date().toISOString(), level, event })}\n`);
}

// A profile is single-owner or team for life (TEAM_MEMBERSHIP_SPEC M1): each mode
// refuses a profile that holds the other mode's credential file, with the reason the
// profile owner already uses for a profile of another host.
const OTHER_MODE_FILE = Object.freeze({ team: 'auth.json', single: 'team-members.json' });
function assertProfileMode(config) {
  if (fs.existsSync(path.join(config.userDataPath, OTHER_MODE_FILE[config.team ? 'team' : 'single']))) {
    throw Object.assign(new Error('invalid_host_profile'),
      { code: HOST_ERROR_CODES.CONFLICT, reason: 'invalid_host_profile' });
  }
}

// Asynchronous because the Windows profile lock is a named pipe; an injected
// implementation may return the lock or a promise of it. `onLost` fires when
// the lock is lost after it was held. Under the lock a team config refuses a
// single-owner profile before any store is opened (the team start, `team-init` and
// `team-recover` all come through here); the single-owner start makes the opposite
// check itself, so a config that stopped being a team config keeps its own refusal.
async function acquireConfiguredProfile(configPath, { acquireProfileImpl = acquireProfileAsync, onLost } = {}) {
  const before = loadHostConfig(configPath);
  const lock = await acquireProfileImpl({ userDataPath: before.userDataPath,
    pythonExecutable: before.pythonExecutable || DEFAULT_PYTHON, onLost });
  try {
    // Setup may have committed while startup was between its first read and
    // profile acquisition. Never combine that old endpoint with a new key.
    const config = loadHostConfig(configPath);
    if (config.userDataPath !== before.userDataPath) throw new Error('host_profile_changed_during_start');
    if (config.team) assertProfileMode(config);
    return { config, lock };
  } catch (error) { lock.release(); throw error; }
}

// Slice 3-11: a headless (secret_file) team host's projects root must exist before anything is built.
// The config loader accepts an absent one and the project canonicalizer would throw a raw ENOENT; this
// names it instead. A desktop (parent_channel) host is unchanged.
function assertTeamProjectsRoot(config) {
  const root = config.team?.keySource === 'secret_file' ? config.team.projectsRoot ?? null : null;
  if (root === null) return;
  let stat;
  try { stat = fs.lstatSync(root); } catch { stat = null; }
  if (stat?.isDirectory() !== true) {
    throw Object.assign(new Error('team_projects_root_missing'), { reason: 'team_projects_root_missing' });
  }
}

// The volumes the disk admissions watch: the profile, the workspace, and a team host's projects root.
const diskRootsFor = (config) => [config.userDataPath, config.workspaceRoot,
  ...(config.team?.projectsRoot ? [config.team.projectsRoot] : [])];

// The hosted credential port: the mounted secret files on a single-owner host. A team host
// holds no API key (AGENTS.md "Approved team hosting boundary"): its port answers nothing for
// every name, except that a given model credential function (the team pool's per-boot key,
// slice 4a-4) answers the model key.
function hostCredentialService(config, modelCredential) {
  const store = new FileSecretStore({ directory: config.secretsDir });
  if (!config.team && typeof modelCredential !== 'function') return store;
  const model = typeof modelCredential === 'function' ? modelCredential : () => null;
  return Object.freeze({
    get: (key) => (key === 'openai_compatible_api_key' ? model() : (config.team ? null : store.get(key))),
    getStatus: () => store.getStatus(),
  });
}

// Builds the shared objects in the single-owner host's order. A failure part
// way through leaves what was built reachable as `error.hostCore` (a
// non-enumerable `{ dispose, canReleaseLock }`), so the caller's cleanup stops
// exactly that.
function createHostCore({
  config, launch = sidecarLaunchOptions({ config }), pythonExecutable = launch.pythonExecutable, clients, leases,
  executionBroker = null, authorize, guardRequired = false, maxEventClients, sessionScope = null,
  logger = log, createBackend = createHostedBackend, teamCommands, turnRoute = null, modelCredential = null,
  teamApprovals = null, makeDiskAdmission = createDiskAdmission,
}) {
  // Only an omitted `authorize` is the single-owner host (the router refuses any other non-function too).
  if ((guardRequired || authorize !== undefined) && typeof authorize !== 'function') {
    throw new TypeError('A host core with a route guard or an authorize needs an authorize function.');
  }
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
      projectsRoot: config.team?.projectsRoot ?? null, memberTurns: Boolean(config.team),
      executionStagingRoot: config.execution?.stagingRoot || null,
      repoRoot: launch.repoRoot,
      ...(launch.resolvePackagedLaunch ? { resolvePackagedLaunch: launch.resolvePackagedLaunch,
        pythonRuntimeBundleRoot: launch.pythonRuntimeBundleRoot } : {}),
      ...(turnRoute ? { turnRoute } : {}),
      credentialService: hostCredentialService(config, modelCredential) });
    assets = createAssetCommands({ backend: composition.backend, userDataPath: config.userDataPath });
    const sweep = () => { try { assets.pruneExpired(); } catch { logger('WARN', 'host.asset_cleanup_failed'); } };
    sweep();
    assetSweep = setInterval(sweep, 3_600_000); assetSweep.unref();
    const diskRoots = diskRootsFor(config);
    const canAdmit = makeDiskAdmission(diskRoots, { logger });
    const receiptsPath = path.join(config.userDataPath, 'command-receipts.json');
    const canAdmitDeletion = makeDiskAdmission(diskRoots, {
      logger, reserveBytes: DELETE_RESERVE_BYTES, extraBytes: () => rewriteHeadroom(receiptsPath),
    });
    const guard = guardRequired ? { guardRequired: true } : {};
    const assetRoutes = createAssetRoutes({ commands: { ...assets, upload: (params) => canAdmit()
      ? assets.upload(params) : { ok: false, error: { kind: 'unavailable', reason: 'disk_pressure', retryable: true } } },
    ...guard });
    const artifactRoutes = createArtifactRoutes({ commands: createArtifactCommands(composition), ...guard });
    const bootEpoch = randomUUID();
    // Slice 3-6b: a team host's approvals (server/team/team-approvals.js) go to the router; its
    // withdrawal events name the prompter.
    events = new BackendEvents({ backend: composition.backend, bootEpoch,
      ...(maxEventClients === undefined ? {} : { maxClients: maxEventClients }), sessionScope, logger,
      ...(teamApprovals ? { prompterOf: teamApprovals.prompterOf } : {}) });
    router = createCommandRouter({ backend: composition.backend, clients, leases,
      receipts: new CommandReceipts({ filePath: receiptsPath, logger }),
      bootEpoch, eventStream: events, resolveAttachments: assets.resolveAttachments, canAdmit, canAdmitDeletion,
      ...(authorize === undefined ? {} : { authorize }), ...(teamCommands ? { teamCommands } : {}),
      ...(teamApprovals ? { approvals: teamApprovals } : {}) });
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

module.exports = { log, acquireConfiguredProfile, assertProfileMode, assertTeamProjectsRoot, createHostCore, diskRootsFor,
  sidecarLaunchOptions };
