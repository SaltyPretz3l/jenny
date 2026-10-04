'use strict';

// plugins.* (default-on with kill switch, Stage 7): the Electron composition + IPC seam for
// the first-party declarative plugin control plane. ONE flag check gates composition AND
// registration together, so flag-off constructs nothing, registers nothing,
// loads no plugin module, and touches no path under `userData/plugins/`.
//
// Composition remains here because routing it through the ratcheted main.js
// entrypoint would add wiring, and this seam jointly owns lifecycle and IPC
// admission.
//
// WHY THE REQUIRES ARE SPELLED WITH THE FULL `services/plugins/` SEGMENT
// ---------------------------------------------------------------------
// scripts/checks/check_plugin_boundary.py's direction guard matches require
// specifiers containing `services/plugins/` and refuses any core file not
// named in JS_CORE_ALLOWLIST. A house-style relative specifier
// (`../plugins/...`) would resolve identically but slip past that regex --
// which would mean this seam existed with NO allowlist entry naming it, and
// the guard would quietly stop guarding. The specifiers below are written so
// the checker sees the seam and the allowlist entry is meaningful.
//
// FLAG-OFF IS THE LOAD-BEARING PROPERTY
// -------------------------------------
// Every `require` of the control plane is INSIDE the flag branch, never at
// module top level. A top-level require would load plugin code on every
// startup and break the unchanged-core proof even though no handler was ever
// invoked; tests/plugins-startup-unchanged.test.js asserts exactly that by
// inspecting require.cache.

const { getBridgeChannel, registerIpcInvokeHandlers } = require('../ipc-contract');
const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');
const { waitForRuntimeSidecar, createStartupSafeRuntimeCoordinator } = require('./plugins-startup-runtime');
const {
  createTrustedSenderAuthorizer,
  unauthorizedIpcResult,
} = require('./ipc-sender-authorization');

// The invoke descriptors this seam owns, mapped to the control-plane
// method each one forwards to. Declared as data so the untrusted-sender test
// can loop the list instead of hand-writing six near-identical cases, and so a
// descriptor added to the contract without a handler here is visible.
const PLUGIN_INVOKE_METHODS = Object.freeze({
  'plugins.getState': 'getState',
  'plugins.getDetails': 'getDetails',
  'plugins.getOperation': 'getOperation',
  'plugins.installLocalPackage': 'installLocalPackage',
  'plugins.enable': 'enable',
  'plugins.disable': 'disable',
  'plugins.setContributionEnabled': 'setContributionEnabled',
  'plugins.updateSettings': 'updateSettings',
  'plugins.uninstall': 'uninstall',
  'plugins.exportAudit': 'exportAudit',
});

const PLUGIN_STAGE5_INVOKE_METHODS = Object.freeze({
  'plugins.getDistributionState': 'getDistributionState',
  'plugins.installLocalPackageFromPath': 'installPackageFromPath',
});

const PLUGIN_STAGE7_INVOKE_METHODS = Object.freeze({
  'plugins.openView': 'openViewContribution',
  'plugins.setViewBounds': 'setBounds',
  'plugins.setViewZoom': 'setZoom',
  'plugins.closeView': 'closeView',
  'plugins.focusView': 'focusView',
});

// The two subscribe descriptors, mapped to the service's subscription
// registrars. `sendBridgeEvent` resolves the wire channel itself.
const PLUGIN_SUBSCRIBE_METHODS = Object.freeze({
  'plugins.onChanged': 'onChanged',
  'plugins.onOperationProgress': 'onOperationProgress',
});

// The packaged first-start ChatGPT migration is itself a graph mutation. A
// renderer mutation admitted concurrently can mint a second epoch-zero
// receipt before either pointer exists, forcing both otherwise-valid commits
// into `recovery_required`. Keep reads available, but serialize every graph
// mutation behind that one startup migration.
const MIGRATION_SERIALIZED_METHODS = new Set([
  'plugins.installLocalPackage',
  'plugins.enable',
  'plugins.disable',
  'plugins.setContributionEnabled',
  'plugins.updateSettings',
  'plugins.uninstall',
  'plugins.installLocalPackageFromPath',
]);
function createStartupSafeRuntimeApply(backendService, { signal = null } = {}) {
  return async function requestRuntimeApply(envelope) {
    // Plugin store recovery is scheduled as soon as IPC registration finishes,
    // before main.js starts the backend. Treat that first backend handshake as
    // an in-flight dependency: returning "unavailable" here makes the adapter
    // restart the sidecar that backendService.start() is still initializing.
    if (backendService?._managedReadyOnce === false && backendService?._stopping !== true) {
      const ready = await waitForRuntimeSidecar(() => (
        backendService?._managedReadyOnce === true ? backendService.sidecarClient : null
      ), { signal });
      if (!ready) {
        const startupStillActive = backendService?._managedReadyOnce === false
          && backendService?._stopping !== true;
        return {
          ok: false,
          reason: startupStillActive
            ? 'runtime_startup_in_progress'
            : 'runtime_sidecar_unavailable',
          ambiguous: false,
        };
      }
    }

    const client = backendService?.sidecarClient;
    if (!client || client.connected !== true || typeof client.initialize !== 'function') {
      return { ok: false, reason: 'runtime_sidecar_unavailable', ambiguous: false };
    }
    try {
      const attestation = await client.initialize(envelope);
      return { ok: true, attestation };
    } catch (error) {
      const semanticCode = String(error?.error_code || error?.rpc?.data?.error_code || '');
      const deterministic = Object.values(PLUGIN_ERROR_CODES).includes(semanticCode);
      return {
        ok: false,
        reason: deterministic
          ? 'runtime_apply_rejected'
          : 'runtime_apply_transport_failed',
        ambiguous: !deterministic,
      };
    }
  };
}

async function runAfterStartupMigration(methodPath, migrationReady, task, isDisposed = () => false) {
  if (isDisposed()) return { ok: false, reason: 'plugin_runtime_disposed', retryable: false };
  if (MIGRATION_SERIALIZED_METHODS.has(methodPath)) await migrationReady;
  if (isDisposed()) return { ok: false, reason: 'plugin_runtime_disposed', retryable: false };
  return task();
}

/**
 * @param {object} ipcMainLike an ipcMain-like object with handle()
 * @param {object} deps
 * @param {object} deps.backendService carries the resolved featureFlags
 * @param {object} deps.app Electron app (for `userData` + the will-quit fallback)
 * @param {object} [deps.processRef] argv/env source for safe-mode resolution
 * @param {function} [deps.getMainWindow] trusted-sender authorization source
 * @param {function} [deps.getMainLifecycle] shutdown-task registrar
 * @param {function} [deps.log] house logger
 * @param {function} [deps.sendBridgeEvent] renderer event pump
 * @param {function} [deps.setChatgptModelsEnabled] Settings > Models switch
 *   owner, given the retired ChatGPT plugin's on/off choice once
 * @returns {{service:object,channels:string[],dispose:function}|null} null when
 *   the flag is off -- and in that case nothing above has been required, built,
 *   registered, or read.
 */
function registerPluginsRuntime(ipcMainLike, {
  backendService,
  app,
  dialog = null,
  processRef = process,
  getMainWindow = () => null,
  getMainLifecycle = () => null,
  log = () => {},
  sendBridgeEvent = () => {},
  setChatgptModelsEnabled = async () => {},
} = {}) {
  if (backendService?.featureFlags?.plugins !== true) {
    return null;
  }

  // Everything below this line runs ONLY with the flag on.
  const {
    createPluginControlPlaneService,
    PLUGIN_STORE_BASE_DIR,
    resolvePluginStoreRoot,
  } = require('../../services/plugins/plugin-control-plane-service');
  const { createNodeFsFacade } = require('../../services/plugins/store/node-fs-facade');
  const { resolvePluginsSafeMode } = require('../../services/plugins/safe-mode');
  const { createPluginLocalPackageSource } = require('./plugin-local-package-source');
  const { createDeveloperProfileSeams } = require('./plugins-developer-profile');
  const { readInstallEnvelope } = require('../../services/plugins/contribution-control-plane');
  const { loadTrustedPublisherRoots } = require('../../services/plugins/package/trusted-publisher-roots');
  const { verifyLocalPackage } = require('../../services/plugins/package/local-package-intake');
  const { DEVELOPER_UNSIGNED_KEY_ID, verifyDistributionPackage } = require('../../services/plugins/package/distribution-package-intake');
  const { createRuntimeApplyCoordinator } = require('../../services/plugins/runtime/runtime-apply-coordinator');
  const { attachManagedPluginRuntime } = require('../backend/managed-plugin-runtime');
  const { DistributionController } = require('../../services/plugins/distribution/distribution-controller');
  const { createProductionDistributionContextFactory,
    digest: digestDistributionValue } = require('../../services/plugins/distribution/production-context');
  const { createStage5ControlPlane,
    operationId } = require('../../services/plugins/stage5-control-plane');
  const { reconcileStartupCleanup } = require('../../services/plugins/lifecycle/startup-cleanup-reconciler');
  const { retirePrivilegedTierState } = require('../../services/plugins/lifecycle/privileged-tier-retirement');
  const { createChatgptRetiredChoiceCarrier } = require('../backend/chatgpt-models-enabled');
  const contractLockV5 = require('../../config/plugins/contract-lock-v5.json');
  const nodeFs = require('node:fs');
  const nodePath = require('node:path');

  // Safe mode is read HERE because main.js may not grow a line: this is the
  // one place `--plugins-safe-mode` and JENNY_PLUGINS_SAFE_MODE enter the
  // process. It is resolved independently of the feature flag, per
  // safe-mode.js -- a user reaching for safe mode cannot be expected to know
  // what the flag says.
  const safeMode = resolvePluginsSafeMode({
    argv: processRef?.argv || [],
    env: processRef?.env || {},
  });
  let disposing = false;
  // The facade is rooted at `<userData>/plugins`, so the real-disk adapter
  // physically cannot reach anything else under userData, and the store's own
  // baseDir is that root. The root segment is spelled once, by the control
  // plane itself (resolvePluginStoreRoot) -- never re-derived here.
  const rootDir = resolvePluginStoreRoot(app.getPath('userData'));
  const facade = createNodeFsFacade({ rootDir, log });
  const pickerDialog = dialog || require('electron').dialog;
  const readPackageBytes = createPluginLocalPackageSource({ dialog: pickerDialog });
  const appRoot = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd();
  const trustRootsPath = nodePath.join(appRoot, 'config', 'plugins', 'trusted-publishers.json');
  let trustRootsPromise = null;
  const trustRootsProvider = async () => {
    if (!trustRootsPromise) trustRootsPromise = loadTrustedPublisherRoots({ filePath: trustRootsPath });
    return trustRootsPromise;
  };
  const developerProfile = createDeveloperProfileSeams({
    enabled: backendService.featureFlags.plugin_developer_profile === true,
    trustRootsProvider, log,
  });
  const verifyPackage = async (args) => {
    const trustRoots = await trustRootsProvider();
    if (!trustRoots.ok) return trustRoots;
    if (args.packageRecord?.package_record_schema_version === 3) {
      const developerRecord = args.packageRecord.signing_key_id === DEVELOPER_UNSIGNED_KEY_ID;
      if (developerRecord && backendService.featureFlags.plugin_developer_profile !== true) return {
        ok: false, code: PLUGIN_ERROR_CODES.FEATURE_DISABLED, reason: 'developer_profile_disabled' };
      return verifyDistributionPackage({
        bytes: args.bytes,
        sourceIdentity: args.sourceIdentity,
        trustRoots,
        verificationCacheKey: args.packageRecord.verification_cache_key,
        now: args.now,
        developerProfile: developerRecord && backendService.featureFlags.plugin_developer_profile === true,
      });
    }
    return verifyLocalPackage({ ...args, trustRoots });
  };
  const startupAbortController = new AbortController();
  const requestRuntimeApply = createStartupSafeRuntimeApply(backendService, {
    signal: startupAbortController.signal,
  });

  const runtimeAdapter = attachManagedPluginRuntime(backendService, {
    requestApply: requestRuntimeApply,
    restartAndApply: async (envelope) => {
      if (typeof backendService?._restartManagedSidecar !== 'function') {
        return { ok: false, reason: 'runtime_restart_unavailable' };
      }
      const restarted = await backendService._restartManagedSidecar('plugin_runtime_reconciliation');
      if (restarted !== true) return { ok: false, reason: 'runtime_restart_failed' };
      return requestRuntimeApply(envelope);
    },
    log: (event, data) => log('INFO', event, data),
  });
  const sidecarRuntimeCoordinator = createStartupSafeRuntimeCoordinator(backendService, createRuntimeApplyCoordinator({
    runtimeAdapter,
    log: (event, data) => log('INFO', event, data),
  }), { signal: startupAbortController.signal });
  const resourcesRoot = app.isPackaged
    ? processRef.resourcesPath : nodePath.join(appRoot, 'build');
  let service = null;

  const { WebContentsView, session: electronSession } = require('electron');
  const { PluginViewController } = require('../../services/main/plugin-view-controller');
  const { createStage7ControlPlane } = require('../../services/plugins/stage7-control-plane');
  const viewHost = typeof WebContentsView === 'function' && electronSession?.fromPartition
    ? new PluginViewController({
      WebContentsView,
      session: electronSession,
      preloadPath: nodePath.join(appRoot, 'plugin-view-preload.bundle.js'),
      getMainWindow,
      log: (event, data) => log('INFO', event, data),
      onQuarantine: (identity) => service?.quarantineRestrictedRuntime?.(identity),
    })
    : {
      active: null,
      commitGeneration: async () => ({ ok: true }),
      destroyAll: async () => ({ ok: true }),
      open: async () => ({ ok: false, reason: 'view_host_unavailable' }),
      setBounds: () => ({ ok: false, reason: 'view_host_unavailable' }),
      setZoom: () => ({ ok: false, reason: 'view_host_unavailable' }),
      focus: () => {},
      setOnViewDestroyed: () => {},
      contextForEvent: () => null,
      sendEvent: () => false,
    };
  const pluginServiceProxy = {
    getState: (payload) => service?.getState(payload) || { ok: false, reason: 'plugin_service_unavailable' },
    updateSettings: (payload) => service?.updateSettings(payload) || { ok: false, reason: 'plugin_service_unavailable' },
  };
  const stage7Service = createStage7ControlPlane({
    runtimeCoordinator: sidecarRuntimeCoordinator,
    viewHost,
    pluginService: pluginServiceProxy,
    log: (event, data) => log('INFO', event, data),
  });
  const runtimeCoordinator = stage7Service.runtimeCoordinator;
  service = createPluginControlPlaneService({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    featureEnabled: true,
    safeMode,
    readPackageBytes,
    verifyPackage,
    runtimeCoordinator,
    log,
  });
  const distributionController = new DistributionController({
    facade, baseDir: PLUGIN_STORE_BASE_DIR,
    mintOperationId: () => operationId('distribution'),
    realpath: nodeFs.promises.realpath,
    onCommitted: () => sendBridgeEvent('plugins.onChanged', {}),
  });
  const createDistributionContextBase = createProductionDistributionContextFactory({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    trustRootsProvider,
    readLocalPackage: readPackageBytes,
    contractLockDigest: digestDistributionValue(contractLockV5),
    verifyPackage,
    developerProfileEnabled: backendService.featureFlags.plugin_developer_profile === true,
  });
  const createDistributionContext = async (request, internal = {}) => {
    // The distribution controller runs detached in production. Complete the
    // one-shot store recovery before it can mint a pending receipt, otherwise
    // a first concurrent state query could reconcile the live operation as a
    // startup orphan. This stays after picker/verification, so cancellation
    // remains a write-free no-op.
    const recovered = await service.getState();
    if (!recovered.ok) return recovered;
    const participant = await service.prepareDistributionParticipant();
    if (!participant.ok) return participant;
    const context = await createDistributionContextBase(request, internal);
    return context.ok
      ? { ok: true, value: { ...context.value, participantPrepare: participant.participantPrepare } }
      : context;
  };
  const stage5Service = createStage5ControlPlane({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    distributionController,
    verifyPackage,
    selectLocalPackage: readPackageBytes,
    readPackageAtPath: developerProfile.readPackageAtPath,
    inspectLocalPackage: developerProfile.inspectLocalPackage,
    createDistributionContext,
    safeMode,
    log,
  });
  const { createBundledInstallWiring } = require('./plugins-bundled-install-wiring');
  const bundledInstall = createBundledInstallWiring({
    inventory: require('../../config/plugins/bundled-plugins.json'),
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    stage5Service,
    enablePlugin: (identity) => service.enable(identity),
    uninstallPlugin: (identity) => service.uninstall(identity),
    // null when the plugin state cannot be read: unknown is not "off".
    readDesiredState: async (identity) => {
      const state = await service.getState();
      if (state?.ok !== true || !Array.isArray(state.plugins)) return null;
      return state.plugins.find((plugin) => plugin?.publisher_id === identity.publisher_id
        && plugin?.plugin_id === identity.plugin_id)?.desired_state || '';
    },
    carryRetiredChoice: createChatgptRetiredChoiceCarrier({
      configService: backendService.configService, setChatgptModelsEnabled,
    }),
    resourcesRoot,
    appRoot,
    isPackaged: app.isPackaged === true,
    readFile: nodeFs.promises.readFile,
    log,
  });
  const startupCleanupReady = Promise.resolve().then(async () => {
    if (startupAbortController.signal.aborted) {
      return { ok: false, reason: 'startup_cleanup_cancelled', settled: 0, deferred: 0 };
    }
    const state = await service.getState();
    if (startupAbortController.signal.aborted) {
      return { ok: false, reason: 'startup_cleanup_cancelled', settled: 0, deferred: 0 };
    }
    if (!state?.ok || state.store_writable !== true) {
      log('WARN', 'plugins.cleanup.startup_deferred', {
        reason_code: state?.reason || 'plugin_store_not_writable',
      });
      return { ok: false, reason: state?.reason || 'plugin_store_not_writable',
        settled: 0, deferred: 0 };
    }
    // The privileged tier is retired: drop its leftover state once, then settle
    // pending per-plugin data cleanup (no native process receipts to wait on).
    await retirePrivilegedTierState({ facade, baseDir: PLUGIN_STORE_BASE_DIR, safeMode, log });
    return reconcileStartupCleanup({ facade, baseDir: PLUGIN_STORE_BASE_DIR, log });
  }).catch(() => {
    log('WARN', 'plugins.cleanup.startup_deferred', { reason_code: 'startup_recovery_failed' });
    return { ok: false, reason: 'startup_recovery_failed', settled: 0, deferred: 0 };
  });
  let startupMigrationReady = startupCleanupReady.then(() => (
    { ok: true, migrated: false, reason: 'startup_cleanup_settled' }
  ));
  const previousStage7Service = backendService._pluginStage7ControlPlane;
  backendService._pluginStage7ControlPlane = stage7Service;

  // Every plugins.* channel sits behind the same trusted-sender authorizer as
  // the rest of the mutating surface: these handlers can request an authority
  // change, so a foreign frame or a navigated renderer must never reach them.
  const authorization = {
    authorize: createTrustedSenderAuthorizer({ getMainWindow, log }),
    unauthorizedResult: unauthorizedIpcResult,
  };

  const handlers = {};
  for (const [methodPath, methodName] of Object.entries(PLUGIN_INVOKE_METHODS)) {
    // `_event` is dropped deliberately: the renderer's identity is settled by
    // the authorizer above, and the service must never see an IPC event object.
    if (methodPath === 'plugins.installLocalPackage') {
      handlers[methodPath] = async (_event, payload = {}) => {
        const envelope = readInstallEnvelope(payload);
        if (!envelope.ok) {
          return {
            ok: false,
            code: PLUGIN_ERROR_CODES.POLICY_BLOCKED,
            reason: envelope.reason,
            retryable: false,
          };
        }
        return runAfterStartupMigration(methodPath, startupMigrationReady, () => (
          stage5Service.startDistributionOperation({
            client_request_id: envelope.clientRequestId || operationId('install'),
          })
        ), () => disposing);
      };
    } else if (methodPath === 'plugins.uninstall') {
      handlers[methodPath] = async (_event, payload) => {
        const result = await runAfterStartupMigration(methodPath, startupMigrationReady, () => (
          service[methodName](payload || {})
        ), () => disposing);
        if (result?.ok) await bundledInstall.markRemoved(payload);
        return result;
      };
    } else {
      handlers[methodPath] = (_event, payload) => runAfterStartupMigration(
        methodPath, startupMigrationReady, () => service[methodName](payload || {}),
        () => disposing
      );
    }
  }
  for (const [methodPath, methodName] of Object.entries(PLUGIN_STAGE5_INVOKE_METHODS)) {
    handlers[methodPath] = (_event, payload = {}) => runAfterStartupMigration(
      methodPath, startupMigrationReady, async () => {
        return stage5Service[methodName](payload || {});
      },
      () => disposing
    );
  }
  for (const [methodPath, methodName] of Object.entries(PLUGIN_STAGE7_INVOKE_METHODS)) {
    handlers[methodPath] = (_event, payload = {}) => {
      if (methodName === 'openViewContribution') {
        return stage7Service.openViewContribution(payload, { bounds: payload.bounds,
          lifecycleEpoch: payload.lifecycle_epoch || 0,
        });
      }
      if (methodName === 'setBounds') return stage7Service.setBounds(payload.bounds || payload);
      if (methodName === 'setZoom') return stage7Service.setZoom(payload.zoom_factor);
      return stage7Service[methodName]();
    };
  }
  const channels = registerIpcInvokeHandlers(ipcMainLike, handlers, authorization);
  const viewBridgeChannel = getBridgeChannel('plugins.viewBridge', 'invoke');
  ipcMainLike.handle(viewBridgeChannel, (event, payload) => stage7Service.bridge(event, payload));
  channels.push(viewBridgeChannel);

  const unsubscribes = Object.entries(PLUGIN_SUBSCRIBE_METHODS).map(
    ([methodPath, registrar]) => service[registrar]((payload) => sendBridgeEvent(methodPath, payload))
  );

  let disposePromise = null;
  const dispose = () => {
    if (disposePromise) return disposePromise;
    disposing = true;
    startupAbortController.abort();
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch (_error) {
        /* teardown never throws */
      }
    }
    ipcMainLike.removeHandler?.(viewBridgeChannel);
    if (backendService._pluginStage7ControlPlane === stage7Service) {
      if (previousStage7Service === undefined) delete backendService._pluginStage7ControlPlane;
      else backendService._pluginStage7ControlPlane = previousStage7Service;
    }
    disposePromise = Promise.resolve(startupMigrationReady).catch(() => null).then(async () => {
      const stage5Dispose = Promise.resolve(stage5Service.dispose());
      const stage7Dispose = Promise.resolve(stage7Service.dispose());
      service.dispose();
      await Promise.all([stage5Dispose, stage7Dispose]);
    });
    return disposePromise;
  };

  // Prefer the awaited shutdown-task list; fall back to will-quit for
  // standalone composition.
  const mainLifecycle = getMainLifecycle?.();
  if (typeof mainLifecycle?.registerShutdownTask === 'function') {
    mainLifecycle.registerShutdownTask(dispose);
  } else if (typeof app?.once === 'function') {
    app.once('will-quit', dispose);
  }

  log('INFO', 'plugins.control_plane_registered', {
    channelCount: channels.length,
    safeModeActive: safeMode.active,
    safeModeSource: safeMode.source,
  });
  if (!safeMode.active) {
    const runtimeReady = startupCleanupReady.then(() => (app?.isPackaged === true
      ? waitForRuntimeSidecar(() => backendService.sidecarClient, {
        signal: startupAbortController.signal,
      })
      : true));
    startupMigrationReady = runtimeReady.then((ready) => (
      ready ? bundledInstall.run() : { ok: false, migrated: false,
        reason: startupAbortController.signal.aborted
          ? 'startup_disposed' : 'runtime_sidecar_unavailable' }
    )).then((result) => {
      log(result.ok ? 'INFO' : 'WARN', 'plugins.startup_migration', {
        status: result.ok ? 'done' : 'failed',
        reason_code: result.reason || 'none',
      });
      return result;
    }).catch(() => {
      log('WARN', 'plugins.startup_migration', {
        status: 'failed', reason_code: 'migration_internal_error',
      });
      return { ok: false, reason: 'migration_internal_error' };
    });
  }

  return { service, stage5Service, stage7Service, channels, facade, safeMode,
    startupReady: startupMigrationReady, dispose };
}

module.exports = {
  PLUGIN_INVOKE_METHODS,
  PLUGIN_STAGE5_INVOKE_METHODS,
  PLUGIN_STAGE7_INVOKE_METHODS,
  PLUGIN_SUBSCRIBE_METHODS,
  registerPluginsRuntime,
  waitForRuntimeSidecar,
  createStartupSafeRuntimeApply,
  runAfterStartupMigration,
};
