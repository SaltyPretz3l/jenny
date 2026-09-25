'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { t: jt } = require('../i18n-main');

const { getContent, contentPath, sha256Hex } = require('../plugins/store/content-store');
const { NativeSupervisorClient } = require('../plugins/full-host/native-supervisor-client');
const { FullHostProcessSupervisor } = require('../plugins/full-host/process-supervisor');
const { createHostResourceAdmission } = require('../plugins/full-host/host-resource-admission');
const { HostSessionManager } = require('../plugins/full-host/host-session-manager');
const { SessionProviderManager } = require('../plugins/full-host/session-provider-manager');
const { FullHostDiagnostics } = require('../plugins/full-host/diagnostics');
const { CleanupReconciler } = require('../plugins/full-host/cleanup-reconciler');
const { FullHostCleanupReceiptStore } = require('../plugins/full-host/cleanup-receipt-store');
const { createDurableHostLaunch } = require('../plugins/full-host/durable-host-launch');
const { CrashQuarantineController } = require('../plugins/full-host/crash-quarantine-controller');
const { FullHostCrashQuarantineStore } = require('../plugins/full-host/crash-quarantine-store');
const { SecretDeliveryGrantStore } = require('../plugins/full-host/secret-delivery-grant-store');
const { sourceFingerprint, SecretValueDelivery } = require('../plugins/full-host/secret-value-delivery');
const { NativeMcpRuntimeRegistry } = require('../plugins/native-mcp/runtime-registry');
const { NativeMcpInvocationBroker } = require('../plugins/native-mcp/invocation-broker');
const { EngineAdapterStreamBroker } = require('../plugins/engine-adapter/stream-broker');
const { HookOutboxStore } = require('../plugins/hooks/outbox-store');
const { HookDispatcher } = require('../plugins/hooks/dispatcher');
const { createStage8ControlPlane } = require('../plugins/stage8-control-plane');
const { reconcileStartupCleanup } = require('../plugins/lifecycle/startup-cleanup-reconciler');
const { PluginHighConsequenceConsent } = require('./plugin-high-consequence-consent');
const { PluginConsentWindow } = require('./plugin-consent-window');

const BACKEND_QUIESCE_TIMEOUT_MS = 4_000;

function supervisorPath({ appRoot, resourcesRoot, isPackaged, platform = process.platform }) {
  const name = platform === 'win32' ? 'plugin-full-host-supervisor.exe' : 'plugin-full-host-supervisor';
  return isPackaged
    ? path.join(resourcesRoot, 'native', name)
    : path.join(appRoot, 'native', 'plugin-full-host-supervisor', 'target', 'release', name);
}

function createPluginStage8Registration({ enabled, runtimeCoordinator, backendService, facade,
  baseDir, rootDir, appRoot, resourcesRoot, isPackaged, ipcMain, BrowserWindow, session,
  managedPolicy = null, recoverPersistentState = true, spawnSupervisor = null,
  backendQuiesceTimeoutMs = BACKEND_QUIESCE_TIMEOUT_MS, log = () => {} } = {}) {
  const executionEnabled = enabled === true;
  const backendShutdownTimeout = Number.isSafeInteger(backendQuiesceTimeoutMs)
    && backendQuiesceTimeoutMs > 0 ? Math.min(backendQuiesceTimeoutMs,
      BACKEND_QUIESCE_TIMEOUT_MS) : BACKEND_QUIESCE_TIMEOUT_MS;
  const capturePolicy = () => managedPolicy?.capture?.() || null;
  const guardPolicy = (token = null) => managedPolicy?.guard?.(token) || { ok: true };

  const diagnostics = new FullHostDiagnostics({ log });
  const consentWindow = new PluginConsentWindow({ BrowserWindow, ipcMain, session, baseDir: appRoot, shellConfigService: backendService.configService, log });
  const consent = new PluginHighConsequenceConsent({
    openPrompt: consentWindow.openPrompt.bind(consentWindow),
  });
  const epochs = new Map();
  const cleanupStore = new FullHostCleanupReceiptStore({ facade, baseDir });
  const crashStore = new FullHostCrashQuarantineStore({ facade, baseDir });
  const crashController = new CrashQuarantineController({
    persist: (entries) => crashStore.save(entries),
    authorizeRelease: () => guardPolicy(),
  });
  const crashReady = (recoverPersistentState ? crashStore.load() : Promise.resolve({ ok: false }))
    .then((loaded) => {
      if (loaded.ok) crashController.hydrate(loaded.entries);
      return loaded.ok;
    });
  let sessionManager;
  let backendShutdownRequested = false;
  const hostResources = createHostResourceAdmission({
    resourceAdmissionProvider: () => ({ broker: backendService.sessionRuntime?.resourceBroker }),
  });
  const nativeClient = new NativeSupervisorClient({
    executablePath: supervisorPath({ appRoot, resourcesRoot, isPackaged }), log,
    ...(typeof spawnSupervisor === 'function' ? { spawn: spawnSupervisor } : {}),
    hostResources, validateResourceAuthority: () => guardPolicy().ok,
    onExit: async (event) => {
      const invalidated = sessionManager?.markSupervisorSessionsUnusable(event?.sessions) || [];
      if (event?.cleanup_phase === 'closed') {
        await sessionManager?.handleSupervisorExit(event.sessions, event.reason);
        return;
      }
      await crashReady;
      for (const active of invalidated) {
        await crashController.recordCrash({ ...active,
          executable_digest: active.executable_digest || active.artifact_digest });
      }
    },
    onHostExit: async ({ session_id: sessionId, session_epoch: sessionEpoch, reason }) => {
      sessionManager?.markSupervisorSessionsUnusable([{ session_id: sessionId, session_epoch: sessionEpoch }]);
      await crashReady;
      const settled = await sessionManager?.handleUnexpectedExit?.(
        sessionId,
        reason,
        (active) => crashController.recordCrash({ ...active,
          executable_digest: active.executable_digest || active.artifact_digest }),
        sessionEpoch
      );
      if (!settled?.session) return;
      if (!settled.ok) diagnostics.record('WARN', 'host_crash_cleanup_unproven', {
        active_generation_id: settled.session.authority?.active_generation_id,
        commit_epoch: settled.session.authority?.commit_epoch,
      });
    },
  });
  const supervisor = new FullHostProcessSupervisor({ nativeClient, diagnostics, hostResources });
  const durableHost = createDurableHostLaunch({ cleanupStore, supervisor });

  async function resolveExecutable(descriptor) {
    const digest = String(descriptor?.executable_digest || '');
    const stored = await getContent(facade, baseDir, digest);
    if (!stored.ok || sha256Hex(stored.bytes) !== digest) {
      return { ok: false, reason: 'executable_object_unavailable' };
    }
    const logical = contentPath(baseDir, digest).split('/');
    const candidate = path.join(rootDir, ...logical);
    try {
      const realRoot = await fs.promises.realpath(rootDir);
      const realCandidate = await fs.promises.realpath(candidate);
      const within = realCandidate.startsWith(`${realRoot}${path.sep}`);
      const stat = await fs.promises.lstat(realCandidate);
      if (!within || !stat.isFile() || stat.isSymbolicLink() || stat.size !== stored.bytes.length) {
        return { ok: false, reason: 'executable_object_identity_rejected' };
      }
      return { ok: true, path: realCandidate, digest, size_bytes: stat.size };
    } catch (_error) {
      return { ok: false, reason: 'executable_object_unavailable' };
    }
  }

  sessionManager = new HostSessionManager({
    limits: { global: 2, perPlugin: 1, perContribution: 1,
      idleMs: 300_000, absoluteMs: 3_600_000 },
    getEffectiveGlobalLimit: (configured) => hostResources.effectiveHostLimit(configured),
    onUnprovenTermination: (record) => durableHost.recordUnproven(record),
    isAuthorityCurrent: (_authority, token) => guardPolicy(token).ok,
    startSession: async ({ authority, contributionId, descriptor, signal, policyToken,
      workloadIdentity = null }) => {
      const capturedPolicy = policyToken || capturePolicy();
      const initialPolicy = guardPolicy(capturedPolicy);
      if (!initialPolicy.ok) return initialPolicy;
      if (backendShutdownRequested) return { ok: false, reason: 'stage8_backend_shutdown' };
      if (!await crashReady) {
        log('WARN', 'plugins.stage8.host_launch_rejected', {
          contribution_id: contributionId, reason_code: 'crash_quarantine_unavailable',
        });
        return { ok: false, reason: 'crash_quarantine_unavailable' };
      }
      if (crashController.isQuarantined(descriptor)) {
        log('WARN', 'plugins.stage8.host_launch_rejected', {
          contribution_id: contributionId, reason_code: 'full_host_quarantined',
        });
        return { ok: false, reason: 'full_host_quarantined' };
      }
      const executable = await resolveExecutable(descriptor);
      if (backendShutdownRequested) return { ok: false, reason: 'stage8_backend_shutdown' };
      if (!guardPolicy(capturedPolicy).ok) {
        return { ok: false, reason: 'managed_policy_authority_stale' };
      }
      if (!executable.ok) {
        log('WARN', 'plugins.stage8.host_launch_rejected', {
          contribution_id: contributionId, reason_code: executable.reason,
        });
        return executable;
      }
      const canonical = {
        operation: 'full_host_launch', authority,
        contribution: {
          publisher_id: descriptor.publisher_id, plugin_id: descriptor.plugin_id,
          contribution_id: contributionId, display_name: contributionId,
          containment_label: 'Windows job: kill-on-close; account/network permissions remain',
          limit_label: jt('plugins.fullHost.sessionLimits', 'Session limits: 1 per contribution; {count} total.',
            { count: hostResources.effectiveHostLimit(2) }),
        },
        artifact: { version: 'verified package', executable_digest: executable.digest },
        session: null,
      };
      let approved;
      try {
        approved = await consent.request(canonical);
      } catch (_error) {
        log('WARN', 'plugins.stage8.host_launch_rejected', {
          contribution_id: contributionId, reason_code: 'full_host_consent_unavailable',
        });
        return { ok: false, reason: 'full_host_consent_unavailable' };
      }
      if (backendShutdownRequested) return { ok: false, reason: 'stage8_backend_shutdown' };
      if (!guardPolicy(capturedPolicy).ok) {
        return { ok: false, reason: 'managed_policy_authority_stale' };
      }
      if (!approved.ok || !consent.consume(approved.receipt_id, canonical).ok) {
        return { ok: false, reason: 'full_host_consent_required' };
      }
      const epoch = (epochs.get(contributionId) || 0) + 1;
      epochs.set(contributionId, epoch);
      const sessionId = crypto.randomUUID();
      const identity = {
        publisher_id: descriptor.publisher_id,
        plugin_id: descriptor.plugin_id,
        contribution_id: contributionId,
        artifact_digest: descriptor.artifact_digest,
        publisher_key_id: String(
          workloadIdentity?.publisher_key_id || descriptor.publisher_key_id || ''
        ),
      };
      const launched = await durableHost.start({ authority, executable, identity, sessionId,
        sessionEpoch: epoch, signal, validateResourceAuthority: () => guardPolicy(capturedPolicy).ok },
      { session_id: sessionId, session_epoch: epoch, authority, ...identity });
      if (!launched.ok) return launched;
      if (!guardPolicy(capturedPolicy).ok) {
        const termination = await durableHost.terminate({ session_id: sessionId,
          session_epoch: epoch, reason: 'managed_policy_revoked' });
        return { ok: false, reason: 'managed_policy_authority_stale', session_id: sessionId,
          session_epoch: epoch, termination, resource_cleanup: termination.resource_cleanup,
          cleanup_persistence: termination.cleanup_persistence };
      }
      return { ok: true, session: {
        session_id: sessionId, session_epoch: epoch,
        launch_receipt_id: launched.receipt.receipt_id,
        channel: launched.channel,
        publisher_id: descriptor.publisher_id,
        plugin_id: descriptor.plugin_id,
        artifact_digest: descriptor.artifact_digest,
        executable_digest: executable.digest,
        workload_profile_id: launched.workload_profile.profile_id,
        host_absolute_lease_ms: launched.workload_profile.host_absolute_lease_ms,
        forced_termination_proof_ms: launched.workload_profile.forced_termination_proof_ms,
        exclusive_gpu: launched.workload_profile.exclusive_gpu === true,
        describe: (request) => launched.channel.request('describe', request),
        invoke: (request) => launched.channel.request('invoke', request),
        status: (request) => launched.channel.request('status', request),
        cancel: (request) => launched.channel.request('cancel', request),
      } };
    },
    terminateSession: async (active, reason) => durableHost.terminate({
      session_id: active.session_id, session_epoch: active.session_epoch, reason,
      workload_profile_id: active.workload_profile_id,
      proof_timeout_ms: active.forced_termination_proof_ms,
    }),
  });
  let service = null;
  const currentAuthority = async () => service?.currentAuthority?.() || {};
  const guardRuntimeAuthority = (authority) => {
    const current = service?.currentAuthority?.();
    return current && authority
      && authority.active_generation_id === current.active_generation_id
      && authority.commit_epoch === current.commit_epoch
      && authority.registry_revision === current.registry_revision
      && authority.dependency_graph_hash === current.dependency_graph_hash
      ? { ok: true } : { ok: false, reason: 'privileged_authority_stale' };
  };
  const acquireFor = async (descriptor, authority, signal) => sessionManager.acquire({
    authority, contributionId: descriptor.contribution_id, descriptor, signal,
    policyToken: service?.currentPolicyToken?.() || capturePolicy(),
    workloadIdentity: { publisher_key_id: descriptor.publisher_key_id },
  });
  const nativeMcpRegistry = new NativeMcpRuntimeRegistry({
    currentAuthority,
    acquireSession: acquireFor,
    releaseSession: (descriptor, authority) => sessionManager.terminate({ authority,
      contributionId: descriptor.contribution_id, publisherId: descriptor.publisher_id,
      pluginId: descriptor.plugin_id, reason: 'generation_stale_before_dispatch' }),
    invoke: async ({ descriptor, args, authority, proof, session: active }) => {
      if (!active?.channel || typeof active.channel.request !== 'function') {
        return { ok: false, reason: 'native_mcp_session_unavailable' };
      }
      return active.channel.request('native_mcp_invoke', {
        namespaced_tool_id: descriptor.tool.namespaced_name,
        remote_tool_name: descriptor.tool.remote_name,
        binding_digest: descriptor.binding.binding_digest,
        arguments: args, authority, proof,
      });
    },
  });
  const nativeMcpBroker = new NativeMcpInvocationBroker({ registry: nativeMcpRegistry });
  const boundedNativeMcp = Object.freeze({
    publish: nativeMcpRegistry.publish.bind(nativeMcpRegistry),
    invoke: nativeMcpBroker.invoke.bind(nativeMcpBroker),
    clear: nativeMcpRegistry.clear.bind(nativeMcpRegistry),
  });
  const sessionProviders = new SessionProviderManager({
    isAuthorityCurrent: () => guardPolicy(service?.currentPolicyToken?.()).ok,
  });
  const engineBroker = new EngineAdapterStreamBroker({
    captureAuthority: capturePolicy,
    guardAuthority: guardPolicy,
    guardRuntimeAuthority,
    invokeHost: async (request) => {
      const descriptor = request.descriptor;
      const acquired = await acquireFor(descriptor, request.authority, request.signal);
      if (!acquired.ok) return acquired;
      return acquired.session.channel.request('engine_stream', request);
    },
  });
  const outbox = recoverPersistentState ? new HookOutboxStore({ facade, baseDir }) : null;
  const hookDispatcher = new HookDispatcher({
    descriptors: () => service?.hookDescriptors?.() || [], currentAuthority, outbox,
    captureAuthority: capturePolicy, guardAuthority: guardPolicy,
    invoke: async ({ descriptor, event, purpose, forbidden }) => {
      const authority = await currentAuthority();
      const acquired = await acquireFor(descriptor, authority);
      if (!acquired.ok) return { ...acquired, dispatched: false };
      return acquired.session.channel.request('hook_delivery', { event, purpose, forbidden,
        binding_digest: descriptor.binding_digest, authority });
    },
  });
  const cleanupReconciler = new CleanupReconciler({
    reconcileReceipt: (receipt) => supervisor.terminate({
      session_id: receipt.session_id, session_epoch: receipt.session_epoch,
      reason: 'cleanup_reconciliation',
    }),
    persistReceipt: async (receipt) => {
      const persisted = await cleanupStore.settle(receipt);
      if (!persisted.ok) throw new Error(persisted.reason);
      try { await supervisor.acknowledgeTermination?.(receipt); } catch (_error) { /* Retain bounded native proof. */ }
    }, diagnostics,
    onConfirmed: (receipt) => sessionManager.confirmTermination(receipt),
  });
  const processCleanupReady = recoverPersistentState
    ? cleanupStore.list().then((stored) => (
      stored.ok && stored.receipts.length ? cleanupReconciler.reconcile(stored.receipts) : null
    ))
    : Promise.resolve(null);
  let disposing = false;
  let startupCleanupReady = null;
  let backendShutdownSettlement = null;
  let backendShutdownAttempt = null;
  let backendQuiesced = false;
  function beginBackendShutdown({ reason = 'backend_stop' } = {}) {
    if (disposing) return Promise.resolve({ ok: false, reason: 'stage8_disposed' });
    backendShutdownRequested = true;
    consent.cancel();
    consentWindow.close();
    if (backendShutdownAttempt) return backendShutdownAttempt;
    if (!backendShutdownSettlement) {
      const sessionShutdown = sessionManager.beginQuiesce(reason);
      backendShutdownSettlement = (async () => {
        const sessions = await sessionShutdown;
        if (!sessions.ok) return { ok: false, reason: sessions.reason, sessions };
        const helper = await supervisor.quiesce();
        backendQuiesced = helper?.ok === true;
        return backendQuiesced ? { ok: true, sessions, helper }
          : { ok: false, reason: helper?.reason || 'stage8_cleanup_unconfirmed', sessions, helper };
      })().catch((error) => ({
        ok: false, reason: String(error?.message || 'stage8_cleanup_unconfirmed'),
      }));
      const settlement = backendShutdownSettlement;
      void settlement.then((result) => {
        if (!result.ok && backendShutdownSettlement === settlement) {
          backendShutdownSettlement = null;
        }
      });
    }
    const settlement = backendShutdownSettlement;
    backendShutdownAttempt = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timedOut: true }), backendShutdownTimeout);
      timer.unref?.();
      settlement.then((result) => {
        clearTimeout(timer);
        resolve({ timedOut: false, result });
      });
    }).then((observed) => {
      if (observed.timedOut) return { ok: false, reason: 'stage8_cleanup_timeout' };
      if (!observed.result.ok) backendShutdownSettlement = null;
      return observed.result;
    }).finally(() => { backendShutdownAttempt = null; });
    return backendShutdownAttempt;
  }
  function reopenAfterBackendStart() {
    if (disposing) return { ok: false, reason: 'stage8_disposed' };
    if (!backendShutdownRequested) return { ok: true };
    const helper = supervisor.reopenAfterQuiesce();
    if (!helper?.ok) return helper;
    const sessions = sessionManager.reopenAfterQuiesce();
    if (!sessions?.ok) return sessions;
    backendShutdownSettlement = null;
    backendShutdownAttempt = null;
    backendShutdownRequested = false;
    backendQuiesced = false;
    return { ok: true };
  }
  const runStartupCleanup = () => {
    if (disposing) {
      return Promise.resolve({ ok: false, reason: 'startup_cleanup_cancelled',
        settled: 0, deferred: 0 });
    }
    if (!startupCleanupReady) {
      startupCleanupReady = reconcileStartupCleanup({ facade, baseDir, processCleanupReady,
        listProcessReceipts: () => cleanupStore.list(), log }).catch(() => {
        log('WARN', 'plugins.cleanup.startup_deferred', { reason_code: 'cleanup_internal_error' });
        return { ok: false, reason: 'cleanup_internal_error', settled: 0, deferred: 0 };
      });
    }
    return startupCleanupReady;
  };
  const grantStore = new SecretDeliveryGrantStore({ facade, baseDir });
  const secretDelivery = new SecretValueDelivery({
    secureStore: backendService.secureStore, grantStore,
    captureAuthority: capturePolicy, guardAuthority: guardPolicy,
    deliver: async ({ grant, secret }) => {
      const acquired = sessionManager.resolveSession(grant.session_id);
      if (!acquired.ok) return acquired;
      if (acquired.session.session_epoch !== grant.session_epoch
        || acquired.session.artifact_digest !== grant.destination_digest) {
        return { ok: false, reason: 'secret_destination_mismatch' };
      }
      const result = await nativeClient.deliverSecret({ session_id: grant.session_id,
        session_epoch: grant.session_epoch, grant_id: grant.grant_id, secret });
      return result?.ok ? { ok: true, receipt_id: result.receipt_id } : result;
    },
    terminateSession: (sessionId, reason) => {
      const resolved = sessionManager.resolveSession(sessionId);
      return supervisor.terminate({ session_id: sessionId,
        session_epoch: resolved.ok ? resolved.session.session_epoch : undefined, reason });
    },
  });

  service = createStage8ControlPlane({ enabled: executionEnabled,
    runtimeCoordinator: executionEnabled ? runtimeCoordinator : null, sessionManager,
    sessionProviders, cleanupReconciler, nativeMcpRegistry: boundedNativeMcp,
    hookDispatcher, engineBroker,
    secretDelivery, consent, managedPolicy, log });

  async function runSyntheticSecretDeliveryDrill() {
    if (!executionEnabled) return { ok: false, reason: 'privileged_plugins_disabled' };
    const active = sessionManager.sessions().find((item) => (
      item.publisher_id === 'jenny-official'
        && item.plugin_id === 'stage8-conformance'
        && item.contribution_id === 'conformance_engine_adapter'
    ));
    if (!active) return { ok: false, reason: 'conformance_session_unavailable' };

    const syntheticSecret = 'synthetic-stage8-owner-secret';
    const sourceIdDigest = crypto.createHash('sha256')
      .update('jenny-stage8-owner-drill-source', 'utf8').digest('hex');
    const grantId = crypto.randomUUID().replaceAll('-', '');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 20_000);
    const authority = active.authority;
    const canonical = {
      operation: 'secret_value_delivery', authority: {
        generation_id: authority.active_generation_id,
        commit_epoch: authority.commit_epoch,
      },
      contribution: {
        publisher_id: active.publisher_id,
        plugin_id: active.plugin_id,
        contribution_id: active.contribution_id,
        display_name: active.contribution_id,
        containment_label: 'Windows job: kill-on-close; account/network permissions remain',
        limit_label: 'One synthetic value; disclosure cannot be revoked after delivery',
      },
      artifact: { version: 'verified package', executable_digest: active.executable_digest },
      session: { session_id: active.session_id, session_epoch: active.session_epoch },
    };
    const binding = {
      session_id: active.session_id,
      session_epoch: active.session_epoch,
      active_generation_id: authority.active_generation_id,
      commit_epoch: authority.commit_epoch,
    };
    const grant = {
      grant_schema_version: 6,
      grant_id: grantId,
      approval_id: 'pending-approval',
      publisher_id: active.publisher_id,
      plugin_id: active.plugin_id,
      contribution_id: active.contribution_id,
      active_generation_id: authority.active_generation_id,
      commit_epoch: authority.commit_epoch,
      session_id: active.session_id,
      session_epoch: active.session_epoch,
      purpose: 'secret_value_delivery',
      source_id_digest: sourceIdDigest,
      source_fingerprint: sourceFingerprint(syntheticSecret),
      destination_digest: active.artifact_digest,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      one_shot: true,
      spent: false,
    };

    try {
      await backendService.secureStore.setPluginFullHostSecret(sourceIdDigest, syntheticSecret);
      const prepared = await service.requestSecretDelivery({ canonical, grant });
      if (!prepared?.ok) return prepared;
      const delivered = await service.consumeSecretDelivery({ grantId, binding });
      if (!delivered?.ok) return delivered;
      const replay = await service.consumeSecretDelivery({ grantId, binding });
      return {
        ok: replay?.reason === 'secret_grant_spent_or_missing',
        delivery_receipt_id: delivered.receipt_id,
        replay_reason: replay?.reason || 'unexpected_replay_result',
        source_id_digest: sourceIdDigest,
      };
    } finally {
      await backendService.secureStore.deletePluginFullHostSecret(sourceIdDigest);
    }
  }

  return {
    enabled: executionEnabled, service,
    runtimeCoordinator: executionEnabled ? service.runtimeCoordinator : runtimeCoordinator,
    runStartupCleanup,
    runSyntheticSecretDeliveryDrill,
    beginBackendShutdown,
    reopenAfterBackendStart,
    async dispose() {
      disposing = true;
      consent.cancel();
      consentWindow.close();
      await Promise.allSettled([processCleanupReady, startupCleanupReady].filter(Boolean));
      await service.dispose();
      await supervisor.dispose();
    },
  };
}

module.exports = { createPluginStage8Registration, supervisorPath };
