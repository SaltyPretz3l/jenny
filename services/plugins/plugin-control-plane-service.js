'use strict';
const crypto = require('node:crypto');
const { PLUGIN_ERROR_CODES } = require('../backend/error-codes');
const { redactText } = require('./lifecycle/operation-result');
const { readCommittedState } = require('./lifecycle/commit-sequence');
const { installPackage } = require('./lifecycle/install-operation');
const { uninstallPlugin } = require('./lifecycle/uninstall-operation');
const {
  recoverStore,
  detectIncompatibleRetainedState,
  READ_ONLY_INCOMPATIBLE,
  PLUGINS_DISABLED_REQUIRED,
} = require('./lifecycle/recovery');
const { createProgressLog } = require('./lifecycle/progress-log');
const { compactReceipts } = require('./store/operation-receipts');
const { sha256Hex } = require('./store/content-store');
const { reverifyInstalledPackage } = require('./runtime/declarative-compiler');
const { CONTROL_PLANE_STAGE } = require('./lifecycle/stage-gate');
const { safeModeRefusal } = require('./safe-mode');
const { initializeManagedPolicy, managedPolicyGrantRef, createManagedInstallPolicy,
  policyGrantRefForMutation, managedActivationDenial } = require('./policy/managed-policy-service');
const { createControlPlaneRuntime, createMutationSerializer } = require('./runtime/control-plane-runtime');
const { createControlPlaneQueries } = require('./control-plane-queries');
const {
  createContributionMutations,
  dependencyMapFor,
  readAuthority,
  readMutationEnvelope,
  readInstallEnvelope,
  readActivationEnvelope,
} = require('./contribution-control-plane');
const {
  PLUGIN_STORE_ROOT_DIRNAME, NEUTRAL_DISPLAY_NAME, LIFECYCLE_TO_CONSENT_OPERATION,
  resolvePluginStoreRoot, defaultNow, defaultNewOperationId, defaultRequireConsent,
  unavailablePackageReader, unavailableVerifier, safeDisplayName,
  buildControlPlanePosture,
} = require('./control-plane-defaults');
const PLUGIN_STORE_BASE_DIR = '';
const MAX_REPORTED_PLUGINS = 64;
const EMPTY_POLICY_GRANT_REF = Object.freeze({
  policy_snapshot_digest: sha256Hex('[]'),
  policy_revision: 0,
  grant_set_digest: sha256Hex('[]'),
});
// Collaborators are injected; authority-bearing seams default fail-closed.
function createPluginControlPlaneService({
  facade,
  baseDir = PLUGIN_STORE_BASE_DIR,
  now = defaultNow,
  featureEnabled = false,
  safeMode = { active: false, source: 'none' },
  verifyPackage = unavailableVerifier,
  requireConsent = defaultRequireConsent,
  readPackageBytes = unavailablePackageReader,
  newOperationId = defaultNewOperationId,
  runtimeCoordinator = null,
  remoteMcpRuntime = null,
  privilegedRuntime = null,
  managedPolicy = null,
  log = () => {},
} = {}) {
  const logEvent = typeof log === 'function' ? log : () => {};
  const clock = typeof now === 'function' ? now : defaultNow;
  const changedListeners = new Set();
  const progressListeners = new Set();
  const runtime = createControlPlaneRuntime({
    facade,
    baseDir,
    verifyPackage,
    runtimeCoordinator,
    remoteMcpRuntime,
    privilegedRuntime,
    now: clock,
  });

  let disposed = false;
  let recoveryPromise = null;
  let recoverySummary = null;
  let incompatibility = null;
  let storeWritable = null;
  let lastOperation = null;
  let receiptEvictionCount = 0;

  const posture = () => buildControlPlanePosture(featureEnabled, safeMode, CONTROL_PLANE_STAGE);

  function refuse(code, reason, extra = {}) {
    return { ok: false, code, reason, ...posture(), ...extra };
  }

  // Pure gate runs before any I/O.
  function gate() {
    if (disposed) {
      return refuse(PLUGIN_ERROR_CODES.FEATURE_DISABLED, 'service_disposed');
    }
    if (featureEnabled !== true) {
      return refuse(PLUGIN_ERROR_CODES.FEATURE_DISABLED, 'plugins_feature_disabled');
    }
    if (safeMode && safeMode.active === true) {
      // Re-spell the shared safe-mode refusal for this facade.
      const refusal = safeModeRefusal(safeMode);
      return refuse(refusal.wireCode, refusal.reason, {
        retryable: refusal.retryable,
        source: refusal.source,
        recovery_guidance: refusal.recoveryGuidance,
      });
    }
    return { ok: true };
  }

  async function compactOperationReceipts(now) {
    try {
      return await compactReceipts(facade, baseDir, {
        now,
        onWarning: (warning) => {
          receiptEvictionCount += warning.evicted_count;
          logEvent('WARN', warning.event, {
            evicted_count: warning.evicted_count,
            max_terminal_receipts: warning.max_terminal_receipts,
            eviction_count: receiptEvictionCount,
          });
        },
      });
    } catch (error) {
      logEvent('WARN', 'plugins.operation_receipts.compaction_failed', {
        code: String(error?.code || 'unknown'),
      });
      return null;
    }
  }

  function ensureRecovered() {
    if (!recoveryPromise) {
      recoveryPromise = (async () => {
        const futureState = await detectIncompatibleRetainedState(facade, baseDir);
        if (!futureState) await initializeManagedPolicy(managedPolicy, logEvent);
        const report = await recoverStore(facade, baseDir, {
          now: clock(), validateCandidate: runtime.validateRecoveryCandidate,
        });
        recoverySummary = {
          classification: report.classification,
          reason: report.reason || null,
          reconciled_count: Array.isArray(report.reconciled) ? report.reconciled.length : 0,
        };
        if (report.classification === READ_ONLY_INCOMPATIBLE) {
          incompatibility = {
            reason: report.reason || 'incompatible_plugin_store',
            ...(Number.isInteger(report.detail?.schemaVersion)
              ? { observed_version: report.detail.schemaVersion }
              : {}),
            ...(Number.isInteger(report.detail?.supportedSchemaVersion)
              ? { supported_version: report.detail.supportedSchemaVersion }
              : {}),
            ...(Array.isArray(report.detail?.states)
              ? { states: report.detail.states.slice(0, 8) }
              : {}),
          };
        }
        const pristineEmptyStore = report.classification === PLUGINS_DISABLED_REQUIRED
          && report.reason === 'no_safe_candidate_generation'
          && report.detail?.pointerStatus === 'missing'
          && Array.isArray(report.detail?.tried)
          && report.detail.tried.length === 0;
        storeWritable = report.classification !== READ_ONLY_INCOMPATIBLE
          && (report.classification !== PLUGINS_DISABLED_REQUIRED || pristineEmptyStore);
        if (storeWritable && report.pointer) {
          const committedState = await readCommittedState(facade, baseDir);
          if (committedState.pointer && committedState.generation) {
            const rehydrated = await runtime.rehydrate({
              generation: committedState.generation,
              pointer: committedState.pointer,
            });
            const runtimeState = runtime.state();
            recoverySummary.runtime_status = rehydrated?.ok === true
              ? runtimeState.runtime_status
              : 'degraded';
            recoverySummary.runtime_reason_code = rehydrated?.ok === true
              ? runtimeState.runtime_reason_code
              : String(rehydrated?.reason || 'runtime_rehydration_failed');
          }
        }
        const compacted = report.classification === READ_ONLY_INCOMPATIBLE
          ? null
          : await compactOperationReceipts(clock());
        if (compacted) {
          recoverySummary.receipts_expired_removed = compacted.expiredRemovedCount;
          recoverySummary.receipts_cap_evicted = compacted.capEvictedCount;
        }
        logEvent('INFO', 'plugins.store_recovered', recoverySummary);
        return recoverySummary;
      })().catch((error) => {
        recoverySummary = { classification: 'recovery_failed', reason: 'internal_error', reconciled_count: 0 };
        storeWritable = false;
        logEvent('WARN', 'plugins.store_recovery_failed', { code: String(error?.code || 'unknown') });
        return recoverySummary;
      });
    }
    return recoveryPromise;
  }

  function internalError(operation, error) {
    const raw = error && error.message ? String(error.message) : String(error);
    const redacted = redactText(raw, { maxBytes: 200 });
    const code = typeof error?.code === 'string' && /^CMP-PLUGIN-\d{4}$/.test(error.code)
      ? error.code
      : PLUGIN_ERROR_CODES.OUTCOME_INDETERMINATE;
    logEvent('WARN', 'plugins.control_plane_internal_error', {
      operation, code,
      detail: redacted.ok ? redacted.text : `redacted:${redacted.reason}`,
    });
    return refuse(code, 'internal_error', {
      operation,
      detail: redacted.ok ? redacted.text : `redacted:${redacted.reason}`,
    });
  }

  async function run(operation, body, { needsStore = true } = {}) {
    const gated = gate();
    if (!gated.ok) return gated;
    try {
      if (needsStore) await ensureRecovered();
      const postAwaitGate = gate();
      if (!postAwaitGate.ok) return postAwaitGate;
      return await body();
    } catch (error) {
      return internalError(operation, error);
    }
  }

  function emit(listeners, payload) {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (_error) {
        /* a listener fault is never allowed to fail an operation */
      }
    }
  }

  function emitChanged(snapshotFields) {
    emit(changedListeners, { ...posture(), ...snapshotFields });
  }

  function createForwardingProgressLog(operationId) {
    const progressLog = createProgressLog(operationId);
    const accept = progressLog.accept.bind(progressLog);
    progressLog.accept = (rawEvent) => {
      const accepted = accept(rawEvent);
      if (accepted.ok) emit(progressListeners, accepted.event);
      return accepted;
    };
    return progressLog;
  }

  const serializeMutation = createMutationSerializer(gate);

  function writableGate() {
    if (incompatibility) {
      return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'plugin_store_read_only', {
        read_only: true,
        store_writable: false,
        incompatibility,
      });
    }
    if (storeWritable !== true) {
      return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'plugin_store_not_writable', {
        read_only: false,
        store_writable: false,
        recovery: recoverySummary,
      });
    }
    return { ok: true };
  }

  function settleMutation(operation, outcome, publish = true) {
    const record = {
      operation_id: outcome.operationId || outcome.result?.operation_id || null,
      operation,
      status: outcome.result?.status || (outcome.ok ? 'committed' : 'failed'),
      settled_at: outcome.result?.settled_at || null,
    };
    if (publish) lastOperation = record;
    if (!outcome.ok) {
      return refuse(outcome.wireCode || PLUGIN_ERROR_CODES.POLICY_BLOCKED, outcome.reason || 'operation_failed', {
        stage_reached: outcome.stage || null,
        operation_id: record.operation_id,
        result: outcome.result || null,
        authority_changed: outcome.committed === true,
      });
    }
    return {
      ok: true,
      ...posture(),
      operation_id: record.operation_id,
      result: outcome.result || null,
      commit_epoch: outcome.commitEpoch ?? null,
      revision: outcome.revision ?? null,
    };
  }

  async function settleAndPublishMutation(operation, outcome, timestamp, subject = null) {
    const publish = !disposed;
    const settled = settleMutation(operation, outcome, publish);
    if (!publish) return settled;
    await compactOperationReceipts(timestamp);
    if (settled.ok || outcome.committed === true) {
      emitChanged({
        commit_epoch: outcome.commitEpoch ?? settled.commit_epoch,
        revision: outcome.revision ?? settled.revision,
      });
      const eventByOperation = {
        install_local_package: 'plugin.updated', enable: 'plugin.enabled', disable: 'plugin.disabled',
        set_contribution: 'plugin.updated', update_settings: 'plugin.updated',
        uninstall: 'plugin.uninstalled',
      };
      const hookEvent = eventByOperation[operation];
      if (hookEvent && subject?.publisher_id && subject?.plugin_id
        && typeof privilegedRuntime?.enqueueHook === 'function') {
        const eventId = crypto.createHash('sha256').update([
          String(outcome.operationId || outcome.result?.operation_id || ''), hookEvent,
          subject.publisher_id, subject.plugin_id,
        ].join('\0'), 'utf8').digest('hex');
        const queued = await privilegedRuntime.enqueueHook({
          event_id: eventId, event: hookEvent, publisher_id: subject.publisher_id,
          plugin_id: subject.plugin_id, causal_depth: 1,
          commit_epoch: outcome.commitEpoch ?? settled.commit_epoch,
        });
        if (!queued?.ok) logEvent('WARN', 'plugins.hook_enqueue_rejected', {
          reason_code: String(queued?.reason || 'hook_enqueue_failed').slice(0, 120),
        });
      }
    }
    return settled;
  }

  const { setContributionEnabled, updateSettings } = createContributionMutations({
    facade,
    baseDir,
    run,
    serializeMutation,
    writableGate,
    refuse,
    verifyPackage,
    clock,
    newOperationId,
    safeMode,
    isDisposed: () => disposed,
    runtime,
    runtimeCoordinator,
    emptyPolicyGrantRef: EMPTY_POLICY_GRANT_REF,
    getPolicyGrantRef: () => managedPolicyGrantRef(managedPolicy, EMPTY_POLICY_GRANT_REF),
    controlPlaneStage: CONTROL_PLANE_STAGE,
    createForwardingProgressLog,
    settleAndPublishMutation,
  });

  async function installLocalPackage(payload = {}) {
    return run('install_local_package', async () => {
      const writable = writableGate();
      if (!writable.ok) return writable;
      const envelope = readInstallEnvelope(payload);
      if (!envelope.ok) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, envelope.reason);
      }
      const source = await readPackageBytes();
      const postPickerGate = gate();
      if (!postPickerGate.ok) return postPickerGate;
      if (source?.ok === true && source.canceled === true) {
        return { ok: true, canceled: true, changed: false, ...posture() };
      }
      if (!source || source.ok !== true) {
        return refuse(source?.code || PLUGIN_ERROR_CODES.INTEGRITY_FAILED, source?.reason || 'package_source_unavailable');
      }
      return serializeMutation(async () => {
        const installPolicy = createManagedInstallPolicy(managedPolicy, 'local_package');
        const operationId = newOperationId();
        const timestamp = clock();
        const outcome = await installPackage(facade, baseDir, {
          packageBytes: source.bytes,
          sourcePathDigest: source.sourcePathDigest,
          verifyPackage,
          requireConsent,
          newOperationId: () => operationId,
          clientRequestId: envelope.clientRequestId,
          safeMode,
          now: timestamp,
          generationId: `gen-${operationId}`,
          policyGrantRef: managedPolicyGrantRef(managedPolicy, EMPTY_POLICY_GRANT_REF),
          dataSchemaRefs: [],
          progressLog: createForwardingProgressLog(operationId),
          isCanceled: () => disposed,
          validateVerifiedPackage: installPolicy.validate,
          commitAuthority: installPolicy.commit,
        });
        return settleAndPublishMutation('install_local_package', outcome, timestamp, {
          publisher_id: outcome?.publisher_id,
          plugin_id: outcome?.plugin_id,
        });
      });
    });
  }

  async function mutateActivation(operation, payload = {}, { system = false } = {}) {
    return run(operation, () => serializeMutation(async () => {
      const writable = writableGate();
      if (!writable.ok) return writable;
      const envelope = readActivationEnvelope(payload);
      if (!envelope.ok) return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, envelope.reason);
      let dependencyMap = new Map();
      const current = await readCommittedState(facade, baseDir);
      const currentEntry = current.generation?.plugins?.find((item) => (
        item.publisher_id === envelope.publisherId && item.plugin_id === envelope.pluginId
      ));
      const managedDenial = await managedActivationDenial({
        operation, currentEntry, managedPolicy,
        reverify: (pluginEntry) => reverifyInstalledPackage({
          facade, baseDir, pluginEntry, verifyPackage, now: clock(),
        }),
      });
      if (managedDenial) return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, managedDenial);
      if (current.generation?.generation_schema_version === 2) {
        const currentEntry = current.generation.plugins.find((item) => (
          item.publisher_id === envelope.publisherId && item.plugin_id === envelope.pluginId
        ));
        if (!currentEntry) return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, 'plugin_not_installed');
        const reverified = await reverifyInstalledPackage({
          facade, baseDir, pluginEntry: currentEntry, verifyPackage, now: clock(),
        });
        if (!reverified.ok) {
          return refuse(PLUGIN_ERROR_CODES.INTEGRITY_FAILED, reverified.reason || 'package_reverification_failed');
        }
        dependencyMap = dependencyMapFor(reverified.verdict.declarative_contents || []);
      }
      const operationId = newOperationId();
      const timestamp = clock();
      const outcome = await runtime.activate({
        operation,
        publisherId: envelope.publisherId,
        pluginId: envelope.pluginId,
        requireConsent: system ? async () => ({ ok: true }) : requireConsent,
        newOperationId: () => operationId,
        clientRequestId: envelope.clientRequestId,
        safeMode,
        now: timestamp,
        generationId: `gen-${operationId}`,
        policyGrantRef: managedPolicyGrantRef(
          managedPolicy, policyGrantRefForMutation(current.generation, EMPTY_POLICY_GRANT_REF)
        ),
        dataSchemaRefs: [],
        progressLog: createForwardingProgressLog(operationId),
        isCanceled: () => disposed,
        dependencyMap,
        stage: CONTROL_PLANE_STAGE,
      });
      return settleAndPublishMutation(operation, outcome, timestamp, {
        publisher_id: envelope.publisherId, plugin_id: envelope.pluginId,
      });
    }));
  }

  const enable = (payload = {}) => mutateActivation('enable', payload);
  const disable = (payload = {}) => mutateActivation('disable', payload);
  const quarantineRestrictedRuntime = (payload = {}) => (
    mutateActivation('quarantine', payload, { system: true })
  );

  async function uninstall(payload = {}) {
    return run('uninstall', () => serializeMutation(async () => {
      const writable = writableGate();
      if (!writable.ok) return writable;
      const envelope = readMutationEnvelope(payload);
      if (!envelope.ok) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, envelope.reason);
      }
      const authority = readAuthority(payload);
      if (!authority.ok) {
        return refuse(PLUGIN_ERROR_CODES.POLICY_BLOCKED, authority.reason);
      }
      const operationId = newOperationId();
      const timestamp = clock();
      const committedState = await readCommittedState(facade, baseDir);
      const entry = committedState.generation?.plugins?.find((item) => (
        item.publisher_id === authority.publisherId && item.plugin_id === authority.pluginId
      ));
      const runtimeWithdrawal = entry?.effective_state === 'active'
        ? await runtime.activeUninstallParticipant({
          generation: committedState.generation,
          pointer: committedState.pointer,
        })
        : null;
      if (runtimeWithdrawal && runtimeWithdrawal.ok !== true) {
        return refuse(
          PLUGIN_ERROR_CODES.POLICY_BLOCKED,
          runtimeWithdrawal.reason || 'runtime_participant_unavailable'
        );
      }
      let outcome;
      try {
        outcome = await uninstallPlugin(facade, baseDir, {
          publisherId: authority.publisherId,
          pluginId: authority.pluginId,
          requireConsent,
          newOperationId: () => operationId,
          clientRequestId: envelope.clientRequestId,
          safeMode,
          now: timestamp,
          generationId: `gen-${operationId}`,
          policyGrantRef: managedPolicyGrantRef(
            managedPolicy,
            policyGrantRefForMutation(committedState.generation, EMPTY_POLICY_GRANT_REF)
          ),
          dataSchemaRefs: [],
          progressLog: createForwardingProgressLog(operationId),
          isCanceled: () => disposed,
          participantPrepare: runtimeWithdrawal?.participantPrepare || null,
          controlPlaneStage: CONTROL_PLANE_STAGE,
          terminateResources: typeof privilegedRuntime?.terminatePluginResources === 'function'
            ? (request) => privilegedRuntime.terminatePluginResources(request)
            : null,
        });
      } finally {
        runtimeWithdrawal?.finish?.(outcome);
      }
      return settleAndPublishMutation('uninstall', outcome, timestamp, {
        publisher_id: authority.publisherId, plugin_id: authority.pluginId,
      });
    }));
  }

  // --- subscriptions + teardown -------------------------------------------
  function subscribe(listeners, listener) {
    if (typeof listener !== 'function' || disposed) return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  const queries = createControlPlaneQueries({
    facade,
    baseDir,
    clock,
    verifyPackage,
    safeMode,
    maxReportedPlugins: MAX_REPORTED_PLUGINS,
    safeDisplayName,
    posture,
    refuse,
    run,
    runtime,
    getIncompatibility: () => incompatibility,
    isStoreWritable: () => storeWritable === true,
    getRecoverySummary: () => recoverySummary,
    getReceiptEvictionCount: () => receiptEvictionCount,
    getLastOperation: () => lastOperation,
    managedPolicy,
  });

  return {
    getState: queries.getState,
    getDetails: queries.getDetails,
    getPolicyStatus: queries.getPolicyStatus,
    getOperation: queries.getOperation,
    installLocalPackage,
    enable,
    disable,
    quarantineRestrictedRuntime,
    setContributionEnabled,
    updateSettings,
    uninstall,
    exportAudit: queries.exportAudit,
    onChanged: (listener) => subscribe(changedListeners, listener),
    onOperationProgress: (listener) => subscribe(progressListeners, listener),
    prepareDistributionParticipant: () => runtime.distributionParticipant(),
    async rehydrateManagedPolicyChange() {
      await ensureRecovered();
      const committed = await readCommittedState(facade, baseDir);
      if (!committed.pointer || !committed.generation) return { ok: true, reason: 'empty_store' };
      return runtime.rehydrate({ generation: committed.generation, pointer: committed.pointer });
    },
    dispose() {
      disposed = true;
      changedListeners.clear();
      progressListeners.clear();
      runtime.dispose();
    },
  };
}

module.exports = {
  PLUGIN_STORE_ROOT_DIRNAME,
  PLUGIN_STORE_BASE_DIR,
  MAX_REPORTED_PLUGINS,
  NEUTRAL_DISPLAY_NAME,
  EMPTY_POLICY_GRANT_REF,
  policyGrantRefForMutation,
  LIFECYCLE_TO_CONSENT_OPERATION,
  resolvePluginStoreRoot,
  defaultRequireConsent,
  createPluginControlPlaneService,
};
