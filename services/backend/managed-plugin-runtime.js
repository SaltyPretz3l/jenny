'use strict';

// Backend-neutral participant adapter. Nothing in services/backend imports
// services/plugins; the sole composition seam injects request/restart calls.

const { PLUGIN_ERROR_CODES } = require('./error-codes');

const ADAPTER_STATE = new WeakMap();
const RESTART_SUPPRESSED_REASONS = new Set(['runtime_startup_in_progress']);

function boundedReason(value, fallback = 'runtime_unavailable') {
  const normalized = typeof value === 'string' ? value : fallback;
  return /^[a-z][a-z0-9_]{0,63}$/.test(normalized) ? normalized : fallback;
}

function emit(state, event, data) {
  if (typeof state.log === 'function') state.log(event, data);
}

function publicState(state) {
  return {
    runtime_status: state.status,
    runtime_reason_code: state.reason,
  };
}

function authorityFromEnvelope(envelope) {
  const snapshot = envelope?.plugin_runtime?.snapshot;
  if (!snapshot || typeof snapshot !== 'object') return null;
  const declarative = snapshot.declarative_content;
  const hasContributions = Boolean(
    (Array.isArray(declarative) && declarative.length)
    || (declarative && !Array.isArray(declarative)
      && ['skill_scopes', 'prompts', 'themes', 'settings_schemas', 'commands', 'workflows']
        .some((key) => Array.isArray(declarative[key]) && declarative[key].length))
    || (Array.isArray(snapshot.remote_mcp_bindings) && snapshot.remote_mcp_bindings.length)
    || (Array.isArray(snapshot.restricted_contributions) && snapshot.restricted_contributions.length)
    || (Array.isArray(snapshot.full_host_descriptors) && snapshot.full_host_descriptors.length)
    || (Array.isArray(snapshot.native_mcp_bindings) && snapshot.native_mcp_bindings.length)
    || (Array.isArray(snapshot.session_providers) && snapshot.session_providers.length)
    || (Array.isArray(snapshot.engine_adapters) && snapshot.engine_adapters.length)
    || (Array.isArray(snapshot.hook_descriptors) && snapshot.hook_descriptors.length)
  );
  return {
    mode: 'plugin',
    registry_revision: snapshot.registry_revision,
    dependency_graph_hash: snapshot.dependency_graph_hash,
    commit_epoch: snapshot.commit_epoch,
    active_generation_id: snapshot.active_generation_id,
    hasContributions,
  };
}

function isV6Envelope(envelope) {
  return envelope?.plugin_runtime?.snapshot?.runtime_schema_version === 6;
}

function withV6Operation(envelope, operation) {
  if (!isV6Envelope(envelope)) return envelope;
  return {
    ...envelope,
    plugin_runtime: { ...envelope.plugin_runtime, operation },
  };
}

function setCommittedEnvelope(state, envelope) {
  const authority = authorityFromEnvelope(envelope);
  state.committedEnvelope = envelope || null;
  state.authority = authority;
  setStableState(
    state,
    authority?.hasContributions ? 'ready' : 'inactive',
    authority?.hasContributions ? 'ready' : 'no_active_plugins'
  );
}

function setStableState(state, status, reason) {
  if (state.detached) return;
  state.stableStatus = status;
  state.stableReason = reason;
  if (state.fenceDepth === 0) {
    state.status = status;
    state.reason = reason;
  }
}

function attachManagedPluginRuntime(owner, {
  requestApply,
  restartAndApply = null,
  log = null,
} = {}) {
  if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) {
    throw new TypeError('managed plugin runtime owner must be an object');
  }
  if (typeof requestApply !== 'function') {
    throw new TypeError('managed plugin runtime requires requestApply');
  }
  const existing = ADAPTER_STATE.get(owner);
  if (existing && !existing.detached) return existing.adapter;

  const state = {
    owner,
    requestApply,
    restartAndApply,
    log,
    status: 'inactive',
    reason: 'not_initialized',
    stableStatus: 'inactive',
    stableReason: 'not_initialized',
    detached: false,
    reconcileFlight: null,
    activeApply: null,
    committedEnvelope: null,
    authority: null,
    requestSequence: 0,
    fenceDepth: 0,
  };

  function ensureAttached() {
    if (state.detached) return { ok: false, reason: 'runtime_adapter_detached' };
    return null;
  }

  async function apply(envelope) {
    const detached = ensureAttached();
    if (detached) return detached;
    if (state.reconcileFlight) {
      return { ok: false, reason: 'runtime_reconciliation_in_progress', ambiguous: false };
    }
    if (state.activeApply) {
      return { ok: false, reason: 'runtime_apply_in_flight', ambiguous: true };
    }
    const requestToken = ++state.requestSequence;
    const startedAt = Date.now();
    const flight = (async () => {
      let result;
      try {
        result = await state.requestApply(envelope);
      } catch (_error) {
        result = { ok: false, reason: 'runtime_apply_transport_failed', ambiguous: true };
      }
      if (state.detached) return { ok: false, reason: 'runtime_adapter_detached' };
      if (requestToken !== state.requestSequence) {
        return { ok: false, reason: 'runtime_apply_superseded', ambiguous: false };
      }
      const normalized = result?.ok === true
        ? result
        : {
          ok: false,
          reason: boundedReason(result?.reason, 'runtime_apply_rejected'),
          ambiguous: result?.ambiguous === true,
        };
      if (state.fenceDepth === 0) {
        setStableState(
          state,
          normalized.ok ? 'ready' : 'degraded',
          normalized.ok ? 'ready' : normalized.reason
        );
      }
      emit(state, 'plugin.runtime.adapter_apply', {
        status: normalized.ok ? 'ok' : 'degraded',
        reason_code: normalized.ok ? 'applied' : normalized.reason,
        latency_ms: Math.max(0, Date.now() - startedAt),
      });
      return normalized;
    })();
    state.activeApply = { requestToken, flight };
    try {
      return await flight;
    } finally {
      if (!state.detached && state.activeApply?.requestToken === requestToken) {
        state.activeApply = null;
      }
    }
  }

  async function restartReconciliation(envelope, priorReason) {
    state.requestSequence += 1;
    state.activeApply = null;
    if (typeof state.restartAndApply !== 'function') {
      setStableState(state, 'degraded', boundedReason(priorReason, 'runtime_reconciliation_failed'));
      return { ok: false, reason: state.stableReason, ambiguous: true };
    }
    const restartToken = state.requestSequence;
    emit(state, 'plugin.runtime.adapter_restart', {
      status: 'start',
      reason_code: boundedReason(priorReason, 'runtime_reconciliation_failed'),
    });
    let result;
    try {
      result = await state.restartAndApply(envelope);
    } catch (_error) {
      result = { ok: false, reason: 'runtime_restart_failed', ambiguous: false };
    }
    if (state.detached) return { ok: false, reason: 'runtime_adapter_detached' };
    if (restartToken !== state.requestSequence) {
      return { ok: false, reason: 'runtime_apply_superseded', ambiguous: false };
    }
    if (result?.ok === true) {
      setCommittedEnvelope(state, envelope);
      return result;
    }
    const reason = boundedReason(result?.reason, 'runtime_reconciliation_failed');
    setStableState(state, 'degraded', reason);
    return { ok: false, reason, ambiguous: result?.ambiguous === true };
  }

  async function runReconciliation(envelope) {
    if (isV6Envelope(envelope)) {
      const result = await apply(withV6Operation(envelope, 'reconcile'));
      if (result.ok) setCommittedEnvelope(state, envelope);
      return result;
    }
    if (state.activeApply) {
      return restartReconciliation(envelope, 'runtime_apply_in_flight');
    }
    const result = await apply(envelope);
    if (state.detached) return { ok: false, reason: 'runtime_adapter_detached' };
    if (result.ok) {
      setCommittedEnvelope(state, envelope);
      return result;
    }
    if (RESTART_SUPPRESSED_REASONS.has(result.reason)) {
      const publicReason = 'runtime_sidecar_unavailable';
      setStableState(state, 'degraded', publicReason);
      return { ...result, reason: publicReason };
    }
    return restartReconciliation(envelope, result.reason);
  }

  function reconcile(envelope) {
    const detached = ensureAttached();
    if (detached) return Promise.resolve(detached);
    if (state.reconcileFlight) return state.reconcileFlight;
    state.reconcileFlight = runReconciliation(envelope).finally(() => {
      if (!state.detached) state.reconcileFlight = null;
    });
    return state.reconcileFlight;
  }

  const adapter = Object.freeze({
    apply,
    prepare(envelope) {
      return apply(withV6Operation(envelope, 'prepare'));
    },
    reconcile,
    commit(preparedRuntime = null) {
      const detached = ensureAttached();
      if (detached) return detached;
      const envelope = preparedRuntime?.envelope || null;
      if (!isV6Envelope(envelope)) {
        setCommittedEnvelope(state, envelope);
        return { ok: true };
      }
      return apply(withV6Operation(envelope, 'commit')).then((result) => {
        if (result.ok) setCommittedEnvelope(state, envelope);
        return result;
      });
    },
    abort(preparedRuntime = null) {
      const detached = ensureAttached();
      if (detached) return detached;
      const envelope = preparedRuntime?.envelope || null;
      if (!isV6Envelope(envelope)) return { ok: true };
      return apply(withV6Operation(envelope, 'abort'));
    },
    fence(reason = 'mutation') {
      if (state.detached) return;
      state.fenceDepth += 1;
      state.status = 'fenced';
      state.reason = boundedReason(reason, 'mutation');
      emit(state, 'plugin.runtime.adapter_fence', {
        status: 'fenced', reason_code: state.reason, fence_depth: state.fenceDepth,
      });
    },
    unfence() {
      if (state.detached) return;
      if (state.fenceDepth > 0) state.fenceDepth -= 1;
      if (state.fenceDepth > 0) return;
      state.status = state.stableStatus;
      state.reason = state.stableReason;
      emit(state, 'plugin.runtime.adapter_fence', {
        status: state.status, reason_code: state.reason, fence_depth: 0,
      });
    },
    degrade(reason = 'runtime_degraded') {
      if (state.detached) return;
      setStableState(state, 'degraded', boundedReason(reason, 'runtime_degraded'));
    },
    getState: () => publicState(state),
    getChatAuthority() {
      if (state.detached || state.status !== 'ready' || !state.authority?.hasContributions) {
        return { mode: 'core_only' };
      }
      const {
        registry_revision,
        dependency_graph_hash,
        commit_epoch,
        active_generation_id,
      } = state.authority;
      return {
        mode: 'plugin',
        registry_revision,
        dependency_graph_hash,
        commit_epoch,
        active_generation_id,
      };
    },
    reconcileCurrent() {
      if (!state.committedEnvelope) {
        return Promise.resolve({ ok: false, reason: 'runtime_reconciliation_target_missing' });
      }
      return reconcile(state.committedEnvelope);
    },
    detach() {
      if (state.detached) return;
      state.detached = true;
      state.requestSequence += 1;
      state.activeApply = null;
      state.reconcileFlight = null;
      state.fenceDepth = 0;
      state.status = 'inactive';
      state.reason = 'runtime_adapter_detached';
      state.committedEnvelope = null;
      state.authority = null;
      ADAPTER_STATE.delete(owner);
    },
  });
  state.adapter = adapter;
  ADAPTER_STATE.set(owner, state);
  return adapter;
}

function getManagedPluginRuntime(owner) {
  const state = ADAPTER_STATE.get(owner);
  return state && !state.detached ? state.adapter : null;
}

function isPluginAuthorityConflict(error) {
  const code = String(
    error?.error_code
    || error?.rpc?.data?.error_code
    || error?.rpc?.data?.code
    || ''
  ).trim();
  return code === PLUGIN_ERROR_CODES.EXPECTED_GENERATION_CONFLICT;
}

async function sendWithPluginRuntimeReconciliation(owner, send, { log = null } = {}) {
  const adapter = getManagedPluginRuntime(owner);
  const firstAuthority = adapter?.getChatAuthority?.() || { mode: 'core_only' };
  try {
    return await send(firstAuthority);
  } catch (error) {
    if (!adapter || !isPluginAuthorityConflict(error)) throw error;
    emit({ log }, 'plugin.runtime.chat_reconciliation', {
      status: 'start',
      reason_code: 'authority_conflict',
    });
    let reconciled;
    try {
      reconciled = await adapter.reconcileCurrent();
    } catch (_error) {
      reconciled = { ok: false, reason: 'runtime_reconciliation_failed' };
    }
    const authority = reconciled?.ok === true
      ? adapter.getChatAuthority()
      : { mode: 'core_only' };
    emit({ log }, 'plugin.runtime.chat_reconciliation', {
      status: reconciled?.ok === true ? 'ok' : 'fallback',
      reason_code: reconciled?.ok === true
        ? 'reconciled'
        : boundedReason(reconciled?.reason, 'core_only_fallback'),
    });
    return send(authority);
  }
}

module.exports = {
  boundedReason,
  authorityFromEnvelope,
  attachManagedPluginRuntime,
  getManagedPluginRuntime,
  isPluginAuthorityConflict,
  sendWithPluginRuntimeReconciliation,
};
