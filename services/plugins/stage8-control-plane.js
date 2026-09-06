'use strict';

const crypto = require('node:crypto');
const { validate } = require('./contracts/generated-plugin-contracts');
const { compileNativeMcpContributions } = require('./native-mcp/contribution-compiler');
const { compileEngineAdapters } = require('./engine-adapter/contribution-compiler');
const { compileHookContributions } = require('./hooks/contribution-compiler');

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function runtimeDescriptor(content, contentDigest, bindingDigest) {
  return {
    publisher_id: content.publisher_id,
    plugin_id: content.plugin_id,
    contribution_id: content.contribution_id,
    kind: content.kind,
    binding_digest: bindingDigest,
    artifact_digest: content.artifact_digest,
    content_digest: contentDigest,
    executable_digest: content.executable_digest,
    containment_profile_digest: content.containment_profile_digest,
  };
}

function descriptorMatchesContent(descriptor, content, authority) {
  return descriptor?.publisher_id === content.publisher_id
    && descriptor?.plugin_id === content.plugin_id
    && descriptor?.contribution_id === content.contribution_id
    && descriptor?.artifact_digest === content.artifact_digest
    && descriptor?.executable_digest === content.executable_digest
    && descriptor?.active_generation_id === authority.active_generation_id
    && descriptor?.commit_epoch === authority.commit_epoch;
}

function boundedRuntimeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded, 'utf8') > 16 * 1024) return null;
    return Object.freeze(JSON.parse(encoded));
  } catch (_error) {
    return null;
  }
}

function sessionProviderStatusKey(authority, identity) {
  return [authority?.active_generation_id, authority?.commit_epoch,
    identity?.publisher_id, identity?.plugin_id, identity?.contribution_id].join('\0');
}

function createStage8ControlPlane({ enabled = false, runtimeCoordinator = null,
  sessionManager = null, sessionProviders = null, cleanupReconciler = null,
  nativeMcpRegistry = null, hookDispatcher = null, engineBroker = null,
  secretDelivery = null, consent = null, managedPolicy = null,
  log = () => {} } = {}) {
  let disposed = false;
  let committedAuthority = null;
  let committedPrivileged = null;
  let hookDescriptors = Object.freeze([]);
  const engineDescriptors = new Map();
  const sessionProviderStatuses = new Map();
  let committedPolicyToken = null;
  const revokedAuthorities = new Set();
  const authorityFingerprint = (authority = {}) => [authority.active_generation_id,
    authority.commit_epoch, authority.registry_revision, authority.dependency_graph_hash].join('\0');
  const rememberRevoked = (authority) => {
    if (!authority) return;
    revokedAuthorities.add(authorityFingerprint(authority));
    while (revokedAuthorities.size > 64) revokedAuthorities.delete(revokedAuthorities.values().next().value);
  };
  const capturePolicy = () => managedPolicy?.capture?.() || null;
  const policyCurrent = (token) => managedPolicy?.isCurrent?.(token) !== false;
  const policyGuard = (token = committedPolicyToken) => (
    managedPolicy?.guard?.(token) || { ok: true }
  );
  const unavailable = () => {
    if (!enabled) return { ok: false, reason: 'privileged_plugins_disabled' };
    const policy = policyGuard();
    return policy.ok ? { ok: false, reason: 'privileged_runtime_unavailable' } : policy;
  };

  function emptyPrivileged(policyToken) {
    return {
      ok: true,
      full_host_descriptors: [], native_mcp_bindings: [], session_providers: [],
      engine_adapters: [], hook_descriptors: [], containment_profiles: [],
      expected_rejections: [], native_descriptors: [], engine_descriptors: [],
      active_hook_descriptors: [], session_provider_descriptors: [],
      session_provider_statuses: [],
      started_contributions: [], policy_token: policyToken,
    };
  }

  function clearPrivilegedPublication() {
    nativeMcpRegistry?.clear?.();
    sessionProviders?.clear?.();
  }

  function publishPrivileged(authority, privileged) {
    const native = nativeMcpRegistry?.publish?.(authority, privileged.native_descriptors || [])
      || { ok: true };
    if (native.ok === false) {
      clearPrivilegedPublication();
      return native;
    }
    const sessions = sessionProviders?.publish?.(
      authority,
      privileged.session_provider_descriptors || [],
    ) || { ok: true };
    if (sessions.ok === false) {
      clearPrivilegedPublication();
      return sessions;
    }
    return { ok: true };
  }

  function retirePriorPublication(registry, priorGenerationId, authority, descriptors) {
    if (!registry) return { ok: true };
    if (typeof registry.revokeGeneration === 'function') {
      registry.revokeGeneration(priorGenerationId);
      return { ok: true };
    }
    if (typeof registry.clear !== 'function' || typeof registry.publish !== 'function') {
      return { ok: true };
    }
    registry.clear();
    return registry.publish(authority, descriptors) || { ok: true };
  }

  function matchesCommittedAuthority(authority, {
    generationField = 'active_generation_id', exact = false,
  } = {}) {
    return Boolean(committedAuthority && authority)
      && authority[generationField] === committedAuthority.active_generation_id
      && authority.commit_epoch === committedAuthority.commit_epoch
      && (!exact || (authority.registry_revision === committedAuthority.registry_revision
        && authority.dependency_graph_hash === committedAuthority.dependency_graph_hash));
  }

  async function compile({ packages = [], authority, phase = null } = {}) {
    if (!enabled || disposed || !sessionManager) return unavailable();
    const policyToken = capturePolicy();
    if (!policyGuard(policyToken).ok) return emptyPrivileged(policyToken);
    if (revokedAuthorities.has(authorityFingerprint(authority))) {
      return emptyPrivileged(policyToken);
    }
    if (phase === 'prior_committed' && committedPrivileged && committedAuthority
      && policyCurrent(committedPolicyToken)
      && committedAuthority.registry_revision === authority?.registry_revision
      && committedAuthority.dependency_graph_hash === authority?.dependency_graph_hash
      && committedAuthority.commit_epoch === authority?.commit_epoch
      && committedAuthority.active_generation_id === authority?.active_generation_id) {
      return { ok: true, ...committedPrivileged, started_contributions: [] };
    }
    log('INFO', 'plugins.stage8.compile_started', {
      package_count: packages.length,
      full_host_content_count: packages.reduce((total, item) => (
        total + (item?.verdict?.full_host_contents?.length || 0)
      ), 0),
    });
    const privileged = {
      full_host_descriptors: [], native_mcp_bindings: [], session_providers: [],
      engine_adapters: [], hook_descriptors: [], containment_profiles: [],
      expected_rejections: [], session_provider_statuses: [],
    };
    const fullNative = [];
    const fullEngines = [];
    const fullHooks = [];
    const fullSessions = [];
    const started = [];
    for (const { entry, verdict } of packages) {
      const contentById = new Map((verdict.full_host_contents || [])
        .map((content) => [content.contribution_id, content]));
      for (const contribution of verdict.manifest.contributions || []) {
        const content = contentById.get(contribution.contribution_id);
        if (!content) {
          privileged.expected_rejections.push({ publisher_id: entry.publisher_id,
            plugin_id: entry.plugin_id, contribution_id: contribution.contribution_id,
            digest: contribution.content_sha256 });
          continue;
        }
        log('INFO', 'plugins.stage8.descriptor_probe_started', {
          contribution_id: content.contribution_id,
        });
        let acquired;
        try {
          acquired = await sessionManager.acquire({ authority,
            contributionId: content.contribution_id, descriptor: content, policyToken,
            workloadIdentity: { publisher_key_id: entry.publisher_key_id } });
        } catch (_error) {
          acquired = { ok: false, reason: 'descriptor_session_exception' };
        }
        log('INFO', 'plugins.stage8.descriptor_session_settled', {
          contribution_id: content.contribution_id,
          status: acquired?.ok === true ? 'ready' : 'rejected',
          reason_code: String(acquired?.reason || 'none').slice(0, 64),
        });
        if (!acquired?.ok || typeof acquired.session?.describe !== 'function') {
          log('WARN', 'plugins.stage8.descriptor_probe_rejected', {
            contribution_id: content.contribution_id,
            reason_code: String(acquired?.reason || 'descriptor_session_unavailable').slice(0, 64),
          });
          privileged.expected_rejections.push({ publisher_id: content.publisher_id,
            plugin_id: content.plugin_id, contribution_id: content.contribution_id,
            digest: contribution.content_sha256 });
          continue;
        }
        if (!policyGuard(policyToken).ok) {
          await sessionManager.terminate({ authority, contributionId: content.contribution_id,
            publisherId: content.publisher_id, pluginId: content.plugin_id,
            reason: 'managed_policy_revoked' });
          return { ok: false, reason: 'managed_policy_authority_stale' };
        }
        let described;
        try {
          described = await acquired.session.describe({ kind: content.kind, authority, identity: {
            publisher_id: content.publisher_id, plugin_id: content.plugin_id,
            contribution_id: content.contribution_id,
           }, containment_profile_digest: content.containment_profile_digest,
            publisher_key_id: entry.publisher_key_id,
            plugin_version: entry.resolved_version,
            artifact_digest: content.artifact_digest,
            executable_digest: content.executable_digest });
        } catch (_error) {
          described = { ok: false };
        }
        if (!policyGuard(policyToken).ok) described = { ok: false,
          reason: 'managed_policy_authority_stale' };
        const descriptor = described?.descriptor;
        const narrowSessionProvider = content.kind !== 'session_provider'
          || descriptor?.descriptor_schema_version == null
          || (validate('PluginSessionProviderDescriptorV1', descriptor).ok
            && descriptor.publisher_key_id === entry.publisher_key_id
            && descriptor.plugin_version === entry.resolved_version);
        const descriptorAccepted = described?.ok && narrowSessionProvider
          && descriptorMatchesContent(descriptor, content, authority);
        const terminated = await sessionManager.terminate({ authority,
          contributionId: content.contribution_id,
          publisherId: content.publisher_id, pluginId: content.plugin_id,
          reason: descriptorAccepted ? 'descriptor_probe_complete' : 'descriptor_rejected' });
        if (terminated?.terminated !== true || terminated?.tree_empty !== true) {
          log('ERROR', 'plugins.stage8.descriptor_probe_cleanup_unproven', {
            contribution_id: content.contribution_id,
          });
          privileged.expected_rejections.push({ publisher_id: content.publisher_id,
            plugin_id: content.plugin_id, contribution_id: content.contribution_id,
            digest: contribution.content_sha256 });
          continue;
        }
        if (!descriptorAccepted) {
          log('WARN', 'plugins.stage8.descriptor_probe_rejected', {
            contribution_id: content.contribution_id,
            reason_code: String(described?.reason || 'descriptor_invalid').slice(0, 64),
          });
          privileged.expected_rejections.push({ publisher_id: content.publisher_id,
            plugin_id: content.plugin_id, contribution_id: content.contribution_id,
            digest: contribution.content_sha256 });
          continue;
        }
        started.push(content.contribution_id);
        const bindingDigest = descriptor.binding_digest || digest(descriptor);
        privileged.full_host_descriptors.push(runtimeDescriptor(
          content, contribution.content_sha256, bindingDigest,
        ));
        privileged.containment_profiles.push({ publisher_id: content.publisher_id,
          plugin_id: content.plugin_id, contribution_id: content.contribution_id,
          digest: content.containment_profile_digest });
        if (content.kind === 'native_mcp') fullNative.push(descriptor);
        else if (content.kind === 'engine_adapter') fullEngines.push(descriptor);
        else if (content.kind === 'hook') fullHooks.push(descriptor);
        else if (content.kind === 'session_provider') {
          fullSessions.push(descriptor);
          privileged.session_provider_statuses.push({
            publisher_id: descriptor.publisher_id,
            plugin_id: descriptor.plugin_id,
            contribution_id: descriptor.contribution_id,
            runtime_status: boundedRuntimeStatus(described.runtime_status),
          });
        }
      }
    }
    const native = compileNativeMcpContributions(fullNative, authority);
    const engines = compileEngineAdapters(fullEngines, authority);
    const hooks = compileHookContributions(fullHooks, authority);
    for (const rejected of [...native.rejected, ...engines.rejected, ...hooks.rejected]) {
      log('WARN', 'plugins.stage8.descriptor_rejected', {
        contribution_id: rejected.contribution_id, reason_code: rejected.reason,
      });
    }
    privileged.native_mcp_bindings = native.accepted;
    privileged.engine_adapters = engines.accepted;
    const genericFor = (item) => privileged.full_host_descriptors.find((candidate) => (
      candidate.publisher_id === item.publisher_id && candidate.plugin_id === item.plugin_id
      && candidate.contribution_id === item.contribution_id
    ));
    privileged.hook_descriptors = hooks.accepted.map(genericFor).filter(Boolean);
    privileged.session_providers = fullSessions.map(genericFor).filter(Boolean);
    privileged.containment_profiles = [...new Map(privileged.containment_profiles
      .map((item) => [item.digest, item])).values()];
    return { ok: true, ...privileged, native_descriptors: native.accepted,
      engine_descriptors: engines.accepted, active_hook_descriptors: hooks.accepted,
      session_provider_descriptors: fullSessions, started_contributions: started,
      policy_token: policyToken };
  }

  async function commitCompiled(compiled) {
    const privileged = compiled?.privileged || {};
    const policyToken = privileged.policy_token || capturePolicy();
    if (!policyCurrent(policyToken)) {
      await sessionManager?.revokeGeneration?.(compiled?.snapshot?.active_generation_id);
      return { ok: false, reason: 'managed_policy_authority_stale' };
    }
    const authority = {
      registry_revision: compiled.snapshot.registry_revision,
      dependency_graph_hash: compiled.snapshot.dependency_graph_hash,
      commit_epoch: compiled.snapshot.commit_epoch,
      active_generation_id: compiled.snapshot.active_generation_id,
    };
    const allowed = policyGuard(policyToken).ok
      && !revokedAuthorities.has(authorityFingerprint(authority));
    if (!allowed) {
      clearPrivilegedPublication();
    }
    const priorAuthority = committedAuthority;
    const generationChanged = priorAuthority?.active_generation_id
      && priorAuthority.active_generation_id !== authority.active_generation_id;
    if (generationChanged) {
      committedAuthority = null;
      const engineCleanup = await engineBroker?.cancelAll?.('generation_changed');
      if (engineCleanup?.ok === false) log('WARN', 'plugins.engine_adapter.revocation_degraded', {
        prior_generation_id: priorAuthority.active_generation_id,
      });
    }
    const publication = allowed ? publishPrivileged(authority, privileged) : { ok: true };
    if (publication.ok === false) {
      await sessionManager?.revokeGeneration?.(authority.active_generation_id);
      return { ok: false, reason: publication.reason || 'privileged_publish_failed' };
    }
    if (allowed && generationChanged) {
      const nativeRetired = retirePriorPublication(
        nativeMcpRegistry,
        priorAuthority.active_generation_id,
        authority,
        privileged.native_descriptors || [],
      );
      const sessionsRetired = retirePriorPublication(
        sessionProviders,
        priorAuthority.active_generation_id,
        authority,
        privileged.session_provider_descriptors || [],
      );
      if (nativeRetired.ok === false || sessionsRetired.ok === false) {
        clearPrivilegedPublication();
        await sessionManager?.revokeGeneration?.(authority.active_generation_id);
        return { ok: false,
          reason: nativeRetired.reason || sessionsRetired.reason || 'privileged_publish_failed' };
      }
    }
    engineDescriptors.clear();
    for (const descriptor of allowed ? (privileged.engine_descriptors || []) : []) {
      engineDescriptors.set(descriptor.adapter_id, Object.freeze(descriptor));
    }
    hookDescriptors = Object.freeze(allowed ? [...(privileged.active_hook_descriptors || [])] : []);
    sessionProviderStatuses.clear();
    if (allowed) {
      for (const item of privileged.session_provider_statuses || []) {
        if (!item.runtime_status) continue;
        sessionProviderStatuses.set(sessionProviderStatusKey(authority, item), item.runtime_status);
      }
    }
    committedPrivileged = privileged;
    committedAuthority = allowed ? Object.freeze(authority) : null;
    committedPolicyToken = policyToken;
    if (generationChanged) {
      await sessionManager?.revokeGeneration?.(priorAuthority.active_generation_id);
    }
    return { ok: true };
  }

  const coordinator = runtimeCoordinator && Object.freeze({
    ...runtimeCoordinator,
    async prepare({ compiled, priorRuntime }) {
      const prepared = await runtimeCoordinator.prepare({ compiled, priorRuntime });
      if (!prepared?.ok) {
        await sessionManager?.revokeGeneration?.(compiled?.snapshot?.active_generation_id);
        return prepared;
      }
      return {
        ...prepared,
        rollback: async (options) => {
          await sessionManager?.revokeGeneration?.(compiled.snapshot.active_generation_id);
          return prepared.rollback?.(options) || { ok: true };
        },
        commit: async () => {
          const settled = await prepared.commit?.() || { ok: true };
          if (!settled.ok) return settled;
          return commitCompiled(compiled);
        },
      };
    },
    async reconcileCompiled(compiled, reason) {
      const settled = typeof runtimeCoordinator.reconcileCompiled === 'function'
        ? await runtimeCoordinator.reconcileCompiled(compiled, reason)
        : await runtimeCoordinator.reconcile({ envelope: { mode: 'plugin_runtime',
          plugin_runtime: { snapshot: compiled.snapshot,
            declarative_content: compiled.declarative_content } }, snapshot: compiled.snapshot }, reason);
      return settled?.ok ? commitCompiled(compiled) : settled;
    },
    getState: () => {
      const sessionSnapshot = sessionManager?.snapshot?.() || {};
      const sessions = { active: sessionSnapshot.active || 0, pending: sessionSnapshot.pending || 0,
        unusable: sessionSnapshot.unusable || 0 };
      const cleanup = cleanupReconciler?.state?.() || { cleanup_status: 'not_required' };
      const cleanupStatus = sessions.unusable > 0 ? 'termination_failed' : cleanup.cleanup_status;
      return { ...runtimeCoordinator.getState?.(), stage8_enabled: enabled,
        privileged_generation_id: committedAuthority?.active_generation_id || null,
        privileged_runtime_status: cleanupStatus === 'termination_failed'
          ? 'termination_failed' : (sessions.pending > 0 ? 'provisioning'
            : (sessions.active > 0 ? 'ready' : 'cold')),
        privileged_cleanup_status: cleanupStatus,
        host_sessions: sessions,
        containment_statement: process.platform === 'win32'
          ? 'Supervised process; not isolated from your Windows account, files, or network.'
          : 'Supervised process; not isolated from your user account, files, or network.',
      };
    },
  });

  return Object.freeze({
    enabled, compile, runtimeCoordinator: coordinator || runtimeCoordinator,
    currentAuthority: () => committedAuthority && policyGuard(committedPolicyToken).ok
      ? { ...committedAuthority } : null,
    currentPolicyToken: () => committedPolicyToken ? { ...committedPolicyToken } : capturePolicy(),
    hookDescriptors: () => hookDescriptors,
    async cleanupOnly(receipts) {
      return cleanupReconciler?.reconcile?.(receipts) || { ok: true, outcomes: [] };
    },
    terminatePluginResources({ publisherId, pluginId } = {}) {
      if (!sessionManager) return Promise.resolve({ ok: true, status: 'complete' });
      return sessionManager.terminatePlugin(publisherId, pluginId, 'plugin_uninstalled');
    },
    acquireHost(request) {
      if (!enabled || disposed || !sessionManager || !policyGuard().ok
        || !matchesCommittedAuthority(request?.authority, { exact: true })) return unavailable();
      return sessionManager.acquire({ ...request, policyToken: committedPolicyToken });
    },
    resolveSessionProvider(authority, identity) {
      if (!enabled || disposed || !sessionProviders || !policyGuard().ok
        || !matchesCommittedAuthority(authority, { exact: true })) return unavailable();
      return sessionProviders.resolve(authority, identity, { requireContractV1: true });
    },
    resolveSessionProviderStatus(authority, identity) {
      const resolved = this.resolveSessionProvider(authority, identity);
      if (!resolved?.ok) return resolved;
      return { ok: true, runtime_status: sessionProviderStatuses.get(
        sessionProviderStatusKey(authority, resolved.descriptor),
      ) || null };
    },
    releaseHost({ authority, descriptor, reason = 'requested' } = {}) {
      if (!sessionManager || !descriptor) return Promise.resolve({
        ok: true, terminated: true, tree_empty: true, already_absent: true,
      });
      return sessionManager.terminate({ authority,
        contributionId: descriptor.contribution_id,
        publisherId: descriptor.publisher_id,
        pluginId: descriptor.plugin_id,
        reason,
      }).then((result) => result?.already_absent === true
        ? { ...result, terminated: true, tree_empty: true }
        : result);
    },
    invokeNativeTool(request) {
      return !enabled || disposed || !nativeMcpRegistry || !policyGuard().ok
        ? unavailable() : nativeMcpRegistry.invoke(request);
    },
    enqueueHook(event) {
      return !enabled || disposed || !hookDispatcher || !policyGuard().ok
        ? unavailable() : hookDispatcher.enqueue(event);
    },
    requestSecretDelivery({ canonical, grant }) {
      if (!enabled || disposed || !secretDelivery || !consent || !policyGuard().ok
        || !matchesCommittedAuthority(canonical?.authority, { generationField: 'generation_id' })) {
        return unavailable();
      }
      const policyToken = committedPolicyToken;
      return consent.request(canonical).then(async (approved) => {
        if (!policyGuard(policyToken).ok) return { ok: false, reason: 'managed_policy_authority_stale' };
        if (!approved?.ok || !consent.consume(approved.receipt_id, canonical).ok) {
          return { ok: false, reason: 'secret_delivery_consent_required' };
        }
        return secretDelivery.prepare({ ...grant, approval_id: approved.receipt_id });
      });
    },
    consumeSecretDelivery(request) {
      return !enabled || disposed || !secretDelivery || !policyGuard().ok
        || !matchesCommittedAuthority(request?.binding) ? unavailable()
        : secretDelivery.consumeAndDeliver(request);
    },
    invokeEngine(request) {
      if (!enabled || disposed || !engineBroker || !policyGuard().ok
        || !matchesCommittedAuthority(request?.authority, { exact: true })) return unavailable();
      const descriptor = engineDescriptors.get(request?.adapterId);
      return descriptor ? engineBroker.start({ ...request, descriptor })
        : { ok: false, reason: 'engine_adapter_not_found' };
    },
    engineStream: Object.freeze({
      start: (request) => {
        if (!enabled || disposed || !engineBroker || !policyGuard().ok
          || !matchesCommittedAuthority(request?.authority, { exact: true })) return unavailable();
        const descriptor = engineDescriptors.get(request?.adapter_id || request?.adapterId
          || request?.binding?.adapter_id);
        return descriptor ? engineBroker.start({ ...request, descriptor })
          : { ok: false, reason: 'engine_adapter_not_found' };
      },
      acknowledge: (request) => (!enabled || disposed || !engineBroker || !policyGuard().ok ? unavailable()
        : engineBroker.acknowledge(request)),
      cancel: (request) => (!enabled || disposed || !engineBroker ? unavailable()
        : engineBroker.cancel(request)),
    }),
    async applyManagedPolicy() {
      const priorAuthority = committedAuthority;
      rememberRevoked(priorAuthority);
      committedAuthority = null;
      committedPrivileged = null;
      committedPolicyToken = capturePolicy();
      hookDescriptors = Object.freeze([]);
      engineDescriptors.clear();
      sessionProviderStatuses.clear();
      nativeMcpRegistry?.clear?.();
      sessionProviders?.clear?.();
      consent?.cancel?.();
      const revocations = [
        ['engine', engineBroker?.cancelAll?.('managed_policy_revoked')],
        ['hook', hookDispatcher?.revokeAll?.('managed_policy_revoked')],
        ['secret', secretDelivery?.revokeAll?.()],
        ['session', sessionManager?.revokeAll?.('managed_policy_revoked')],
      ].filter(([, promise]) => promise);
      const outcomes = await Promise.allSettled(revocations.map(([, promise]) => promise));
      const sessionIndex = revocations.findIndex(([kind]) => kind === 'session');
      const sessionOutcome = sessionIndex >= 0 ? outcomes[sessionIndex] : null;
      const cleanup = sessionOutcome?.status === 'fulfilled' ? sessionOutcome.value : null;
      const ok = outcomes.every((item) => item.status === 'fulfilled' && item.value?.ok !== false);
      const cleanupStatus = cleanup?.status
        || (sessionOutcome?.status === 'rejected' ? 'termination_failed' : (ok ? 'complete' : 'termination_failed'));
      log(ok ? 'INFO' : 'WARN', 'plugins.managed_policy.revocation_settled', {
        prior_generation_id: priorAuthority?.active_generation_id || null,
        cleanup_status: cleanupStatus,
      });
      return { ok, cleanup_status: cleanupStatus };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      sessionProviderStatuses.clear();
      await sessionManager?.dispose?.();
      await hookDispatcher?.dispose?.();
    },
  });
}

module.exports = { createStage8ControlPlane, descriptorMatchesContent, runtimeDescriptor };
