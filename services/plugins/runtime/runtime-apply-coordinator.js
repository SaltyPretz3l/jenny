'use strict';

const { validate } = require('../contracts/generated-plugin-contracts');

const DEFAULT_APPLY_TIMEOUT_MS = 15000;
const REQUIRED_RESOURCE_KINDS = Object.freeze(['engine', 'model', 'memory', 'mcp', 'monitor', 'tool']);

function boundedReason(value, fallback) {
  const reason = typeof value === 'string' ? value : fallback;
  return /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : fallback;
}

function runWithTimeout(task, timeoutMs) {
  let timer = null;
  return Promise.race([
    Promise.resolve().then(task).then(
      (value) => ({ status: 'settled', value }),
      () => ({ status: 'threw' })
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function validateAttestation(rawAttestation, snapshot) {
  const isV6 = snapshot?.runtime_schema_version === 6;
  const validated = validate(isV6 ? 'PluginRuntimeAttestationV6' : 'PluginRuntimeAttestationV1', rawAttestation);
  if (!validated.ok) return { ok: false, reason: 'runtime_attestation_invalid' };
  const attestation = validated.value;
  if (isV6) {
    if (attestation.registry_revision !== snapshot.registry_revision
      || attestation.dependency_graph_hash !== snapshot.dependency_graph_hash
      || attestation.commit_epoch !== snapshot.commit_epoch
      || attestation.active_generation_id !== snapshot.active_generation_id) {
      return { ok: false, reason: 'runtime_attestation_authority_mismatch' };
    }
    return { ok: true, attestation };
  }
  if (
    attestation.participant_kind !== 'sidecar'
    || attestation.registry_revision !== snapshot.registry_revision
    || attestation.dependency_graph_hash !== snapshot.dependency_graph_hash
    || attestation.commit_epoch !== snapshot.commit_epoch
  ) return { ok: false, reason: 'runtime_attestation_authority_mismatch' };
  if (attestation.rejected_contributions.length > 0) {
    return { ok: false, reason: 'runtime_contribution_rejected' };
  }
  const provedKinds = new Set(attestation.reused_resource_proofs.map((proof) => proof.resource_kind));
  if (
    attestation.reused_resource_proofs.length !== REQUIRED_RESOURCE_KINDS.length
    || provedKinds.size !== REQUIRED_RESOURCE_KINDS.length
    || REQUIRED_RESOURCE_KINDS.some((kind) => !provedKinds.has(kind))
  ) {
    return { ok: false, reason: 'runtime_resource_proof_incomplete' };
  }
  return { ok: true, attestation };
}

function extractAttestation(response) {
  if (!response || typeof response !== 'object') return null;
  if (response.attestation && typeof response.attestation === 'object') return response.attestation;
  if (response.result && typeof response.result === 'object') return response.result;
  if (response.attestation_schema_version === 1 || response.attestation_schema_version === 6) return response;
  return null;
}

function createRuntimeApplyCoordinator({ runtimeAdapter, timeoutMs = DEFAULT_APPLY_TIMEOUT_MS, log = null }) {
  if (!runtimeAdapter || typeof runtimeAdapter.apply !== 'function' || typeof runtimeAdapter.reconcile !== 'function') {
    throw new TypeError('runtime apply coordinator requires an injected runtime adapter');
  }
  const effectiveTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 60000)
    : DEFAULT_APPLY_TIMEOUT_MS;
  const emit = (event, data) => {
    if (typeof log === 'function') log(event, data);
  };

  async function reconcileRuntime(runtime, reason) {
    if (!runtime?.envelope || !runtime?.snapshot) {
      return { ok: false, reason: 'runtime_reconciliation_target_missing' };
    }
    const startedAt = Date.now();
    const outcome = await runWithTimeout(
      () => runtimeAdapter.reconcile(runtime.envelope),
      effectiveTimeout
    );
    const result = outcome.status === 'settled' ? outcome.value : null;
    const attestation = result?.ok === true
      ? validateAttestation(extractAttestation(result), runtime.snapshot)
      : { ok: false, reason: boundedReason(result?.reason, `runtime_reconciliation_${outcome.status}`) };
    const ok = attestation.ok === true;
    emit('plugin.runtime.reconciliation', {
      status: ok ? 'ok' : 'degraded',
      reason_code: ok ? reason : attestation.reason,
      latency_ms: Math.max(0, Date.now() - startedAt),
    });
    return ok
      ? { ok: true, attestation: attestation.attestation }
      : { ok: false, reason: attestation.reason };
  }

  async function prepare({ compiled, priorRuntime }) {
    if (!compiled?.snapshot || !Array.isArray(compiled.declarative_content)) {
      return { ok: false, reason: 'runtime_compile_result_invalid', ambiguous: false };
    }
    const envelope = {
      mode: 'plugin_runtime',
      plugin_runtime: {
        snapshot: compiled.snapshot,
        declarative_content: compiled.declarative_content,
      },
    };
    const preparedRuntime = { envelope, snapshot: compiled.snapshot };
    const startedAt = Date.now();
    const isV6 = compiled.snapshot.runtime_schema_version === 6;
    const applyMethod = isV6 ? runtimeAdapter.prepare : runtimeAdapter.apply;
    if (typeof applyMethod !== 'function') {
      return { ok: false, reason: 'runtime_prepare_unavailable', ambiguous: false };
    }
    const outcome = await runWithTimeout(() => applyMethod.call(runtimeAdapter, envelope), effectiveTimeout);
    const response = outcome.status === 'settled' ? outcome.value : null;
    if (outcome.status !== 'settled' || !response || response.ok !== true) {
      const reason = boundedReason(response?.reason, `runtime_apply_${outcome.status}`);
      const ambiguous = outcome.status !== 'settled' || response?.ambiguous === true;
      emit('plugin.runtime.apply', {
        status: ambiguous ? 'ambiguous' : 'rejected',
        reason_code: reason,
        latency_ms: Math.max(0, Date.now() - startedAt),
      });
      return {
        ok: false,
        reason,
        ambiguous,
        reconcile: async () => reconcileRuntime(priorRuntime, 'prepare_failed'),
      };
    }
    const attestation = validateAttestation(extractAttestation(response), compiled.snapshot);
    if (!attestation.ok) {
      emit('plugin.runtime.apply', {
        status: 'rejected',
        reason_code: attestation.reason,
        latency_ms: Math.max(0, Date.now() - startedAt),
      });
      return {
        ok: false,
        reason: attestation.reason,
        // A malformed/rejected response does not prove whether publication
        // happened before response construction was lost or corrupted.
        ambiguous: true,
        reconcile: async () => reconcileRuntime(priorRuntime, 'attestation_rejected'),
      };
    }
    emit('plugin.runtime.apply', {
      status: 'ok',
      reason_code: 'applied',
      latency_ms: Math.max(0, Date.now() - startedAt),
    });
    return {
      ok: true,
      attestation: attestation.attestation,
      preparedRuntime,
      rollback: async ({ reason }) => {
        if (isV6 && typeof runtimeAdapter.abort === 'function') {
          const aborted = await runWithTimeout(
            () => runtimeAdapter.abort(preparedRuntime), effectiveTimeout
          );
          if (aborted.status === 'settled' && aborted.value?.ok === true) return { ok: true };
        }
        return reconcileRuntime(priorRuntime, boundedReason(reason, 'rollback'));
      },
      reconcile: async () => reconcileRuntime(priorRuntime, 'ambiguous_repair'),
      commit: async () => {
        if (typeof runtimeAdapter.commit !== 'function') return { ok: true };
        try {
          const result = await runtimeAdapter.commit(preparedRuntime);
          if (result?.ok === true && isV6) {
            const committedAttestation = validateAttestation(extractAttestation(result), compiled.snapshot);
            return committedAttestation.ok && committedAttestation.attestation.applied === true
              ? { ok: true, attestation: committedAttestation.attestation }
              : { ok: false, reason: committedAttestation.reason || 'runtime_commit_settlement_failed' };
          }
          return result?.ok === true
            ? { ok: true }
            : { ok: false, reason: boundedReason(result?.reason, 'runtime_commit_settlement_failed') };
        } catch (_error) {
          return { ok: false, reason: 'runtime_commit_settlement_failed' };
        }
      },
    };
  }

  return Object.freeze({
    fence: (reason) => runtimeAdapter.fence?.(boundedReason(reason, 'mutation')),
    unfence: () => runtimeAdapter.unfence?.(),
    degrade: (reason) => runtimeAdapter.degrade?.(boundedReason(reason, 'runtime_degraded')),
    getState: () => runtimeAdapter.getState?.() || {
      runtime_status: 'inactive',
      runtime_reason_code: 'runtime_adapter_unavailable',
    },
    detach: () => runtimeAdapter.detach?.(),
    prepare,
    reconcile: reconcileRuntime,
  });
}

module.exports = {
  DEFAULT_APPLY_TIMEOUT_MS,
  REQUIRED_RESOURCE_KINDS,
  boundedReason,
  runWithTimeout,
  validateAttestation,
  createRuntimeApplyCoordinator,
};
