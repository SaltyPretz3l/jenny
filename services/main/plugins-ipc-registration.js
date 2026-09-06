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
  'plugins.getPolicyStatus': 'getPolicyStatus',
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
  'plugins.getCatalogState': 'getCatalogState',
  'plugins.refreshCatalogs': 'refreshCatalogs',
  'plugins.installFromCatalog': 'installFromCatalog',
  'plugins.updateFromCatalog': 'updateFromCatalog',
  'plugins.listRollbackCandidates': 'listRollbackCandidates',
  'plugins.rollback': 'rollback',
  'plugins.retryRecovery': 'retryRecovery',
  'plugins.getDistributionState': 'getDistributionState',
  'plugins.selectOfflineMirror': 'selectOfflineMirror',
  'plugins.startDistributionOperation': 'startDistributionOperation',
  'plugins.installLocalPackageFromPath': 'installPackageFromPath',
  'plugins.cancelOperation': 'cancelOperation',
  'plugins.setNetworkConsent': 'setNetworkConsent',
  'plugins.beginRemoteMcpAuthorization': 'beginRemoteMcpAuthorization',
  'plugins.revokeRemoteMcpAuthorization': 'revokeRemoteMcpAuthorization',
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
  'plugins.startDistributionOperation',
  'plugins.installLocalPackageFromPath',
  'plugins.installFromCatalog',
  'plugins.updateFromCatalog',
  'plugins.rollback',
  'plugins.retryRecovery',
]);
const STARTUP_RUNTIME_WAIT_MS = 30_000;

function waitForDelay(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    timer.unref?.();
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

async function waitForRuntimeSidecar(getClient, {
  timeoutMs = STARTUP_RUNTIME_WAIT_MS,
  pollMs = 50,
  now = Date.now,
  signal = null,
  wait = waitForDelay,
} = {}) {
  const deadline = now() + Math.max(1, Number(timeoutMs) || 1);
  do {
    if (signal?.aborted) return false;
    const client = getClient?.();
    if (client?.connected === true && typeof client.initialize === 'function') return true;
    await wait(
      Math.min(Math.max(1, Number(pollMs) || 1), Math.max(1, deadline - now())),
      signal
    );
  } while (now() < deadline);
  if (signal?.aborted) return false;
  const client = getClient?.();
  return client?.connected === true && typeof client.initialize === 'function';
}

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

function refreshManagedConfigAfterProviderChange(
  backendService,
  buildOptions = () => ({}),
  change = {}
) {
  return backendService?.refreshManagedConfig?.(
    change.reason || 'plugin_provider_changed',
    buildOptions()
  );
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
 * @returns {{service:object,channels:string[],dispose:function}|null} null when
 *   the flag is off -- and in that case nothing above has been required, built,
 *   registered, or read.
 */
function registerPluginsRuntime(ipcMainLike, {
  backendService,
  app,
  dialog = null,
  shell = null,
  processRef = process,
  getMainWindow = () => null,
  getMainLifecycle = () => null,
  log = () => {},
  sendBridgeEvent = () => {},
  showItemInFolderImpl = null,
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
  const { createPluginManagedPolicySource } = require('./plugin-managed-policy-source');
  const { createManagedPolicyService } = require('../../services/plugins/policy/managed-policy-service');
  const managedPolicyDefaults = require('../../config/plugins/managed-policy-defaults.json');
  const { resolvePluginsSafeMode } = require('../../services/plugins/safe-mode');
  const { createPluginLocalPackageSource } = require('./plugin-local-package-source');
  const { createDeveloperProfileSeams } = require('./plugins-developer-profile');
  const { readInstallEnvelope } = require('../../services/plugins/contribution-control-plane');
  const { loadTrustedPublisherRoots } = require('../../services/plugins/package/trusted-publisher-roots');
  const { verifyLocalPackage } = require('../../services/plugins/package/local-package-intake');
  const { DEVELOPER_UNSIGNED_KEY_ID, verifyDistributionPackage } = require('../../services/plugins/package/distribution-package-intake');
  const { createRuntimeApplyCoordinator } = require('../../services/plugins/runtime/runtime-apply-coordinator');
  const { createStage6ControlPlane } = require('../../services/plugins/stage6-control-plane');
  const { resolveRestrictedHostRuntime } = require('../../services/plugins/restricted-host/runtime-resolver');
  const {
    RESTRICTED_ABI_DIGEST,
    RESTRICTED_PROTOCOL_DIGEST,
  } = require('../../services/plugins/runtime/declarative-compiler');
  const { attachManagedPluginRuntime } = require('../backend/managed-plugin-runtime');
  const { createNetworkBroker } = require('../../services/plugins/network/network-broker');
  const { CredentialBroker } = require('../../services/plugins/auth/credential-broker');
  const { OAuthFlowService } = require('../../services/plugins/auth/oauth-flow-service');
  const { createLoopbackAuthorization } = require('../../services/plugins/auth/loopback-authorization');
  const { RemoteMcpService } = require('../../services/plugins/remote-mcp/remote-mcp-service');
  const { RemoteMcpRuntimeAuthority } = require('../../services/plugins/remote-mcp/runtime-authority');
  const { DistributionController } = require('../../services/plugins/distribution/distribution-controller');
  const { PluginCatalogService } = require('../../services/plugins/catalog/plugin-catalog-service');
  const { activateChatgptProvider, providerReconfigureOptions } = require('../../services/plugins/provider/provider-activation-service');
  const { createProductionDistributionContextFactory,
    digest: digestDistributionValue } = require('../../services/plugins/distribution/production-context');
  const { createStage5ControlPlane,
    operationId } = require('../../services/plugins/stage5-control-plane');
  const { AttachmentTicketBroker } = require('../../services/plugins/view/attachment-ticket-broker');
  const { SessionProviderInvocationBroker } = require('../../services/plugins/session-provider/invocation-broker');
  const {
    drainActiveChatStreams,
    verifyGpuEvictedForEngine,
  } = require('../../services/backend/exclusive-gpu-preflight');
  const {
    createChatGptAuthServiceDefault,
    ensureChatgptAuthService,
  } = require('../provider-auth-runtime');
  const contractLockV5 = require('../../config/plugins/contract-lock-v5.json');
  const trustedCatalogs = require('../../config/plugins/trusted-catalogs.json');
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
  let providerApplySettled = false;
  const rearmDefaultModelLoad = () => {
    // One-shot: onProviderChanged is also wired as onAuthChanged, and a later
    // sign-in/out must not re-run the default-model load or resurface the
    // launch WARN on a user gesture.
    if (providerApplySettled) return;
    providerApplySettled = true;
    if (disposing) return;
    try { backendService._autoLoadDefaultModel?.(); } catch (_error) { /* fail open */ }
  };
  const providerRuntimeApplyPending = (engineType) => (
    !providerApplySettled && engineType === 'chatgpt');
  if (!safeMode.active) {
    backendService._providerRuntimeApplyPending = providerRuntimeApplyPending;
  }
  // Plugin IPC is composed before the general auxiliary handlers. Stage 7
  // therefore owns creation of its auth dependency here instead of capturing
  // a null backend field and hoping a later registrar repairs the reference.
  // The auxiliary composition calls the same idempotent helper afterwards.
  const chatgptAuthService = ensureChatgptAuthService({
    backendService,
    log,
    createAuthService: createChatGptAuthServiceDefault,
    env: processRef?.env || process.env,
  });

  // The facade is rooted at `<userData>/plugins`, so the real-disk adapter
  // physically cannot reach anything else under userData, and the store's own
  // baseDir is that root. The root segment is spelled once, by the control
  // plane itself (resolvePluginStoreRoot) -- never re-derived here.
  const rootDir = resolvePluginStoreRoot(app.getPath('userData'));
  const facade = createNodeFsFacade({ rootDir, log });
  const managedPolicy = createManagedPolicyService({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    source: createPluginManagedPolicySource({
      platform: processRef?.platform || process.platform,
      windowsKey: managedPolicyDefaults.windows.registry_key,
      windowsValue: managedPolicyDefaults.windows.value_name,
      macosDomain: managedPolicyDefaults.macos.managed_preferences_domain,
      macosKey: managedPolicyDefaults.macos.key,
      linuxFile: managedPolicyDefaults.linux.policy_file,
    }),
    pollIntervalMs: managedPolicyDefaults.poll_interval_ms,
    log: (level, event, data) => log(level, event, data),
  });
  let managedPolicyInitialized = false;
  const managedPolicyReady = safeMode.active
    ? Promise.resolve({ ok: false, reason: 'plugins_safe_mode_active' })
    : managedPolicy.initialize().finally(() => {
      managedPolicyInitialized = true;
    });
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
  const sidecarRuntimeCoordinator = createRuntimeApplyCoordinator({
    runtimeAdapter,
    log: (event, data) => log('INFO', event, data),
  });
  const resourcesRoot = app.isPackaged
    ? processRef.resourcesPath : nodePath.join(appRoot, 'build');
  const restrictedHostRoot = nodePath.join(resourcesRoot, 'restricted-host');
  const sidecarManifestPath = nodePath.join(resourcesRoot, 'sidecar', 'manifest.json');
  const resolveRuntime = async () => {
    let sidecarManifest;
    try { sidecarManifest = JSON.parse(await nodeFs.promises.readFile(sidecarManifestPath, 'utf8')); }
    catch (_error) { return { ok: false, reason: 'restricted_host_build_identity_unavailable' }; }
    const expectedCommit = String(sidecarManifest?.git_commit || '');
    if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
      return { ok: false, reason: 'restricted_host_build_identity_invalid' };
    }
    return resolveRestrictedHostRuntime({
      fs: nodeFs.promises,
      rootDir: restrictedHostRoot,
      expectedCommit,
      expectedAbiDigest: RESTRICTED_ABI_DIGEST,
      expectedProtocolDigest: RESTRICTED_PROTOCOL_DIGEST,
    });
  };
  const networkBroker = createNetworkBroker({
    isSessionLockedDown: (sessionId) => {
      if (backendService.featureFlags?.session_offline_lockdown !== true) return false;
      const session = backendService.sessionStore?.getSession?.(sessionId);
      return !session || session.lockdown === true;
    },
  });
  let service = null;
  const stage6Service = createStage6ControlPlane({
    runtimeCoordinator: sidecarRuntimeCoordinator,
    resolveRuntime,
    log,
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    networkBroker,
    onQuarantine: (identity) => service?.quarantineRestrictedRuntime?.({
      publisher_id: identity.publisher_id,
      plugin_id: identity.plugin_id,
    }),
  });
  let runtimeCoordinator = stage6Service.runtimeCoordinator;

  const credentialBroker = new CredentialBroker({
    secureStore: backendService.secureStore,
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
  });
  const remoteMcpService = new RemoteMcpService({
    networkBroker,
    credentialBroker,
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
  });
  const remoteMcpRuntime = new RemoteMcpRuntimeAuthority({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    remoteMcpService,
    credentialBroker,
    verifyPackage,
    log,
  });
  const { BrowserWindow, WebContentsView, session: electronSession } = require('electron');
  const { PluginViewController } = require('../../services/main/plugin-view-controller');
  const { createStage7ControlPlane } = require('../../services/plugins/stage7-control-plane');
  let sessionProviderBroker = null;
  const attachmentTicketBroker = backendService.sessionStore && backendService.attachmentAssetStore
    ? new AttachmentTicketBroker({
      sessionStore: backendService.sessionStore,
      attachmentAssetStore: backendService.attachmentAssetStore,
      revealPath: showItemInFolderImpl || shell?.showItemInFolder?.bind(shell) || (async () => false),
      log: (event, data) => log('WARN', event, data),
    })
    : null;
  const viewHost = typeof WebContentsView === 'function' && electronSession?.fromPartition
    ? new PluginViewController({
      WebContentsView,
      session: electronSession,
      preloadPath: nodePath.join(appRoot, 'plugin-view-preload.bundle.js'),
      getMainWindow,
      log: (event, data) => log('INFO', event, data),
      onQuarantine: (identity) => service?.quarantineRestrictedRuntime?.(identity),
      resolveAttachmentTicket: attachmentTicketBroker
        ? (request) => attachmentTicketBroker.resolve(request) : null,
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
    runtimeCoordinator,
    viewHost,
    pluginService: pluginServiceProxy,
    chatgptAuthService,
    onProviderChanged: async (change = {}) => {
      // finally: a rejected refresh must still settle the predicate, or the
      // launch fallback stays 'deferred' (INFO) for the process lifetime and
      // the honest WARN never fires.
      try {
        await refreshManagedConfigAfterProviderChange(
          backendService, providerReconfigureOptions, change);
      } finally {
        rearmDefaultModelLoad();
      }
    },
    activateProvider: (providerId) => activateChatgptProvider(backendService, providerId),
    sessionProviderCall: (call, context) => sessionProviderBroker
      ? sessionProviderBroker.handleViewCall(call, context)
      : { ok: false, reason: 'session_provider_unavailable' },
    authorizeSessionView: (sessionId, descriptor) => sessionProviderBroker
      ? sessionProviderBroker.authorizeViewOpen(sessionId, descriptor)
      : { ok: false, reason: 'session_provider_unavailable' },
    onSessionViewDestroyed: async (context, reason) => {
      attachmentTicketBroker?.revokeView?.(context.viewInstanceId);
      if (context.sessionId && reason !== 'view_crash_restart') {
        return sessionProviderBroker
          ? sessionProviderBroker.cancelSessionAndWait(context.sessionId, reason)
          : { ok: false, reason: 'session_provider_unavailable' };
      }
      return { ok: true };
    },
    log: (event, data) => log('INFO', event, data),
    providerAuthLog: (event, data) => log('WARN', event, data),
  });
  runtimeCoordinator = stage7Service.runtimeCoordinator;
  const privilegedEnabled = backendService?.featureFlags?.privileged_plugins === true
    && safeMode.active !== true;
  const stage8Registration = require('./plugin-stage8-registration').createPluginStage8Registration({
      enabled: privilegedEnabled,
      runtimeCoordinator,
      backendService,
      facade,
      baseDir: PLUGIN_STORE_BASE_DIR,
      rootDir,
      appRoot,
      resourcesRoot,
      isPackaged: app.isPackaged === true,
      ipcMain: ipcMainLike,
      BrowserWindow,
      session: electronSession,
      managedPolicy,
      recoverPersistentState: !safeMode.active,
      log: (level, event, data) => log(level, event, data),
    });
  runtimeCoordinator = stage8Registration.runtimeCoordinator;
  if (attachmentTicketBroker && backendService.exclusiveGpuCoordinator) {
    const privilegedRuntime = stage8Registration.service;
    sessionProviderBroker = new SessionProviderInvocationBroker({
      sessionStore: backendService.sessionStore,
      runtime: {
        currentAuthority: () => privilegedRuntime.currentAuthority(),
        resolveProvider: (authority, identity) => (
          privilegedRuntime.resolveSessionProvider(authority, identity)
        ),
        providerStatus: (authority, identity) => (
          privilegedRuntime.resolveSessionProviderStatus(authority, identity)
        ),
        acquireHost: (request) => privilegedRuntime.acquireHost(request),
        terminateHost: (request) => privilegedRuntime.releaseHost(request),
      },
      ticketBroker: attachmentTicketBroker,
      attachmentAssetStore: backendService.attachmentAssetStore,
      exclusiveGpuCoordinator: backendService.exclusiveGpuCoordinator,
      scratchRoot: nodePath.join(app.getPath('userData'), 'plugins', 'session-provider-staging'),
      getChatEngineType: () => backendService.currentEngineType
        || backendService.configService?.getState?.()?.preferredEngineType || '',
      drainChat: () => drainActiveChatStreams({ activeStreams: backendService.activeStreams,
        cancelStream: (streamId) => backendService.cancelChatStream?.(streamId),
        // Resolved per drain, NOT captured at registration: the actor registry is
        // built in initializeConversationStorage during backend construction, but
        // binding it once here would silently degrade to the activeStreams-only
        // drain -- the exact double-admission hole this barrier source closes --
        // if that ordering ever changed.
        getPendingLeaseSettlementBarriers: () => {
          const registry = backendService.sessionTurnActorRegistry
            || backendService.sessionTurnActors;
          // No registry at all means no chat turn can be in flight, so an empty
          // barrier set is the truth. A registry that EXISTS but has lost the
          // method is a wiring defect rather than an empty set: return null so
          // the drain fails closed on chat_drain_unverified instead of letting a
          // privileged workload load the GPU on an unverified claim.
          if (!registry) {
            return [];
          }
          if (typeof registry.pendingUnattachedLeaseSettlementBarriers !== 'function') {
            return null;
          }
          return registry.pendingUnattachedLeaseSettlementBarriers();
        } }),
      unloadChatModel: () => backendService.unloadModel?.(),
      verifyGpuFree: ({ engineType }) => verifyGpuEvictedForEngine({ engineType }),
      log: (event, data) => log('WARN', event, data),
    });
    sessionProviderBroker.reconcileInterruptedOperations();
  }
  service = createPluginControlPlaneService({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    featureEnabled: true,
    safeMode,
    readPackageBytes,
    verifyPackage,
    runtimeCoordinator,
    remoteMcpRuntime,
    privilegedRuntime: stage8Registration.service,
    managedPolicy,
    log,
  });
  const distributionController = new DistributionController({
    facade, baseDir: PLUGIN_STORE_BASE_DIR,
    networkBroker,
    mintOperationId: () => operationId('distribution'),
    realpath: nodeFs.promises.realpath,
    onCommitted: () => sendBridgeEvent('plugins.onChanged', {}),
  });
  const selectOfflineRoot = async () => {
    let selection;
    try {
      selection = await pickerDialog.showOpenDialog({
        title: 'Select an offline Jenny plugin mirror',
        properties: ['openDirectory', 'dontAddToRecent'],
      });
    } catch (_error) {
      return { ok: false, reason: 'offline_mirror_picker_failed' };
    }
    if (!selection || selection.canceled === true || selection.filePaths?.length === 0) {
      return { ok: true, canceled: true };
    }
    if (!Array.isArray(selection.filePaths) || selection.filePaths.length !== 1) {
      return { ok: false, reason: 'offline_mirror_selection_invalid' };
    }
    return { ok: true, canceled: false, rootPath: selection.filePaths[0] };
  };
  const createDistributionContextBase = createProductionDistributionContextFactory({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    trustRootsProvider,
    readLocalPackage: readPackageBytes,
    contractLockDigest: digestDistributionValue(contractLockV5),
    verifyPackage,
    managedPolicy,
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
  const oauthFlowService = new OAuthFlowService({ networkBroker, credentialBroker });
  const loopbackAuthorization = createLoopbackAuthorization({
    oauthFlowService,
    openExternal: (url) => (shell || require('electron').shell).openExternal(url),
  });
  const stage5Service = createStage5ControlPlane({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    distributionController,
    remoteMcpRuntime,
    oauthFlowService,
    credentialBroker,
    loopbackAuthorization,
    verifyPackage,
    selectLocalPackage: readPackageBytes,
    readPackageAtPath: developerProfile.readPackageAtPath,
    inspectLocalPackage: developerProfile.inspectLocalPackage,
    selectOfflineRoot,
    createDistributionContext,
    safeMode,
    log,
  });
  const catalogService = new PluginCatalogService({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    cacheRoot: nodePath.join(rootDir, 'catalog-cache'),
    distributionController,
    createDistributionContext,
    networkBroker,
    configuredSources: Array.isArray(trustedCatalogs.catalogs) ? trustedCatalogs.catalogs : [],
    realpath: nodeFs.promises.realpath,
    confirmOfflineTrust: async (identity) => {
      const result = await pickerDialog.showMessageBox(getMainWindow?.() || undefined, {
        type: 'warning',
        buttons: ['Trust mirror', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Trust offline plugin mirror?',
        message: `Trust “${identity.display_name}” as a plugin catalog?`,
        detail: `Pinned root fingerprint:\n${identity.root_fingerprint}\n\nOnly signed targets accepted by this root can be installed.`,
      });
      return result?.response === 0;
    },
    log,
  });
  const { createChatGptPluginMigration, PACKAGE_IDENTITY } = require('../../services/plugins/provider/chatgpt-migration');
  const { resolveBundledPluginRecord } = require('../../services/plugins/provider/bundled-plugin-inventory');
  const bundledPlugins = require('../../config/plugins/bundled-plugins.json');
  const chatgptBundle = resolveBundledPluginRecord(bundledPlugins, PACKAGE_IDENTITY);
  const chatgptMigration = createChatGptPluginMigration({
    facade,
    baseDir: PLUGIN_STORE_BASE_DIR,
    stage5Service,
    chatgptAuthService,
    preferredEngineType: () => backendService.configService?.getState?.()?.preferredEngineType || '',
    enablePlugin: (identity) => service.enable(identity),
    loadBundledPackage: async () => {
      if (!chatgptBundle.ok) return chatgptBundle;
      const packagePath = nodePath.join(resourcesRoot, ...chatgptBundle.record.package_resource.split('/'));
      try {
        return { ok: true, bytes: await nodeFs.promises.readFile(packagePath),
          expectedSha256: chatgptBundle.record.package_sha256 };
      } catch (_error) {
        if (app.isPackaged !== true) {
          try {
            const devPackagePath = nodePath.join(appRoot, ...chatgptBundle.record.package_resource.split('/'));
            return { ok: true, bytes: await nodeFs.promises.readFile(devPackagePath),
              expectedSha256: chatgptBundle.record.package_sha256 };
          } catch (_devError) { /* fall through to the unavailable result */ }
        }
        // A packaged build missing its bundled plugin is a packaging defect,
        // not the benign dev-checkout miss: give it a distinct reason so the
        // migration's quiet-skip branch does not swallow it (it falls through
        // to the failed-receipt + WARN path instead).
        return {
          ok: false,
          reason: app.isPackaged === true
            ? 'bundled_package_missing_from_build' : 'bundled_package_unavailable',
        };
      }
    },
    log: (event, data, level = 'WARN') => log(level, event, data),
  });
  const unsubscribeManagedPolicy = managedPolicy.subscribe((status) => {
    if (!managedPolicyInitialized) return;
    sendBridgeEvent('plugins.onChanged', {
      reason: 'managed_policy_changed',
      policy_revision: status.revision,
      policy_status: status.status,
    });
    void stage8Registration.service?.applyManagedPolicy?.().then(async (revoked) => {
      if (managedPolicyInitialized && revoked?.ok !== false && !disposing) {
        await service.rehydrateManagedPolicyChange();
      }
    }).catch(() => {
      log('WARN', 'plugins.managed_policy.revocation_failed', {
        reason_code: 'managed_policy_revocation_exception',
      });
    });
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
    return stage8Registration.runStartupCleanup();
  }).catch(() => {
    log('WARN', 'plugins.cleanup.startup_deferred', { reason_code: 'startup_recovery_failed' });
    return { ok: false, reason: 'startup_recovery_failed', settled: 0, deferred: 0 };
  });
  let chatgptMigrationReady = startupCleanupReady.then(() => (
    { ok: true, migrated: false, reason: 'startup_cleanup_settled' }
  ));
  const previousStage5Service = backendService._pluginStage5ControlPlane;
  const previousStage6Service = backendService._pluginStage6ControlPlane;
  const previousStage7Service = backendService._pluginStage7ControlPlane;
  const previousStage8Service = backendService._pluginStage8ControlPlane;
  const agentMode = /^(1|true|yes|on)$/i.test(String(process.env.JENNY_AGENT_DEV || '').trim());
  const previousStage8OwnerDrill = globalThis.__jennyStage8OwnerDrill;
  backendService._pluginStage5ControlPlane = stage5Service;
  backendService._pluginStage6ControlPlane = stage6Service;
  backendService._pluginStage7ControlPlane = stage7Service;
  if (stage8Registration.service) backendService._pluginStage8ControlPlane = stage8Registration.service;
  if (sessionProviderBroker) backendService._pluginSessionProviderBroker = sessionProviderBroker;
  if (agentMode) {
    globalThis.__jennyStage8OwnerDrill = Object.freeze({
      runSyntheticSecretDelivery: stage8Registration.runSyntheticSecretDeliveryDrill,
    });
  }

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
        return runAfterStartupMigration(methodPath, chatgptMigrationReady, () => (
          stage5Service.startDistributionOperation({
            client_request_id: envelope.clientRequestId || operationId('install'),
          })
        ), () => disposing);
      };
    } else if (methodPath === 'plugins.uninstall') {
      handlers[methodPath] = async (_event, payload) => {
        const result = await runAfterStartupMigration(methodPath, chatgptMigrationReady, () => (
          service[methodName](payload || {})
        ), () => disposing);
        if (result?.ok && payload?.publisher_id === PACKAGE_IDENTITY.publisher_id
          && payload?.plugin_id === PACKAGE_IDENTITY.plugin_id) await chatgptMigration.markRemoved();
        return result;
      };
    } else {
      handlers[methodPath] = (_event, payload) => runAfterStartupMigration(
        methodPath, chatgptMigrationReady, () => service[methodName](payload || {}),
        () => disposing
      );
    }
  }
  for (const [methodPath, methodName] of Object.entries(PLUGIN_STAGE5_INVOKE_METHODS)) {
    handlers[methodPath] = (_event, payload = {}) => runAfterStartupMigration(
      methodPath, chatgptMigrationReady, async () => {
        if (methodPath === 'plugins.selectOfflineMirror') {
          const selected = await selectOfflineRoot();
          if (!selected?.ok || selected.canceled === true) return selected;
          return catalogService.trustOfflineMirror({
            source_id: payload.source_id,
            display_name: payload.display_name,
            root_path: selected.rootPath,
          });
        }
        if (typeof catalogService[methodName] === 'function') {
          return catalogService[methodName](payload || {});
        }
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
          sessionId: String(payload.sessionId || '').trim(),
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
    if (backendService._providerRuntimeApplyPending === providerRuntimeApplyPending) backendService._providerRuntimeApplyPending = null;
    unsubscribeManagedPolicy();
    startupAbortController.abort();
    for (const unsubscribe of unsubscribes) {
      try {
        unsubscribe();
      } catch (_error) {
        /* teardown never throws */
      }
    }
    ipcMainLike.removeHandler?.(viewBridgeChannel);
    if (backendService._pluginStage5ControlPlane === stage5Service) {
      if (previousStage5Service === undefined) delete backendService._pluginStage5ControlPlane;
      else backendService._pluginStage5ControlPlane = previousStage5Service;
    }
    if (backendService._pluginStage6ControlPlane === stage6Service) {
      if (previousStage6Service === undefined) delete backendService._pluginStage6ControlPlane;
      else backendService._pluginStage6ControlPlane = previousStage6Service;
    }
    if (backendService._pluginStage7ControlPlane === stage7Service) {
      if (previousStage7Service === undefined) delete backendService._pluginStage7ControlPlane;
      else backendService._pluginStage7ControlPlane = previousStage7Service;
    }
    if (backendService._pluginStage8ControlPlane === stage8Registration.service) {
      if (previousStage8Service === undefined) delete backendService._pluginStage8ControlPlane;
      else backendService._pluginStage8ControlPlane = previousStage8Service;
    }
    if (backendService._pluginSessionProviderBroker === sessionProviderBroker) {
      delete backendService._pluginSessionProviderBroker;
    }
    if (agentMode && globalThis.__jennyStage8OwnerDrill?.runSyntheticSecretDelivery
      === stage8Registration.runSyntheticSecretDeliveryDrill) {
      if (previousStage8OwnerDrill === undefined) delete globalThis.__jennyStage8OwnerDrill;
      else globalThis.__jennyStage8OwnerDrill = previousStage8OwnerDrill;
    }
    disposePromise = Promise.resolve(chatgptMigrationReady).catch(() => null).then(async () => {
      await managedPolicyReady.catch(() => null);
      const stage5Dispose = Promise.resolve(stage5Service.dispose());
      const stage6Dispose = Promise.resolve(stage6Service.dispose());
      const stage7Dispose = Promise.resolve(stage7Service.dispose());
      const stage8Dispose = Promise.resolve(stage8Registration.dispose());
      const sessionProviderDispose = Promise.resolve(sessionProviderBroker?.dispose?.());
      remoteMcpService.dispose();
      service.dispose();
      managedPolicy.dispose();
      await Promise.all([stage5Dispose, stage6Dispose, stage7Dispose, stage8Dispose,
        sessionProviderDispose]);
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
    chatgptMigrationReady = runtimeReady.then((ready) => (
      ready ? chatgptMigration.run() : { ok: false, migrated: false,
        reason: startupAbortController.signal.aborted
          ? 'startup_disposed' : 'runtime_sidecar_unavailable' }
    )).then((result) => {
      log(result.ok ? 'INFO' : 'WARN', 'plugins.chatgpt_migration', {
        status: result.ok ? (result.migrated ? 'migrated' : 'skipped') : 'failed',
        reason_code: result.reason || 'none',
      });
      return result;
    }).catch(() => {
      log('WARN', 'plugins.chatgpt_migration', {
        status: 'failed', reason_code: 'migration_internal_error',
      });
      return { ok: false, reason: 'migration_internal_error' };
    }).then((result) => {
      if (result.ok !== true || result.available !== true) rearmDefaultModelLoad();
      return result;
    });
  }

  return { service, catalogService, stage5Service, stage6Service, stage7Service,
    stage8Service: stage8Registration.service, sessionProviderBroker, channels, facade, safeMode,
    startupReady: chatgptMigrationReady, dispose };
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
  refreshManagedConfigAfterProviderChange,
};
