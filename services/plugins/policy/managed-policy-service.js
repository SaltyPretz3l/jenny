'use strict';

const crypto = require('node:crypto');
const { verifyManagedPolicyBundle } = require('./managed-policy-bundle');
const {
  readManagedPolicyState,
  writeManagedPolicyState,
} = require('../store/managed-policy-state-store');

const ZERO_DIGEST = '0'.repeat(64);
const DEFAULT_POLL_MS = 30_000;
const PRIVILEGED_CONTRIBUTION_KINDS = new Set([
  'native_mcp', 'session_provider', 'engine_adapter', 'hook',
]);

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function defaultState(status = 'blocked', reason = 'managed_policy_loading') {
  return Object.freeze({
    managed_policy_state_schema_version: 1,
    effective_revision: 0,
    source_revision_high_water: 0,
    source_policy_digest_high_water: null,
    current_policy_digest: null,
    source_kind: null,
    source_fingerprint: null,
    status,
    reason,
    privileged_execution: status === 'unmanaged' ? 'allow' : 'deny',
    installation: 'allow_inactive',
    update_ring: 'stable',
    allowed_source_kinds: [],
    allowed_publishers: [],
    require_sbom: false,
    require_build_provenance: false,
    managed_source_fingerprints: [],
    audit_max_entries: 1000,
    accepted_at: null,
    observed_at: null,
  });
}

function publicStatus(state) {
  return Object.freeze({
    status: state.status,
    reason: state.reason,
    revision: state.effective_revision,
    source_revision: state.source_revision_high_water,
    policy_digest: state.current_policy_digest,
    source_kind: state.source_kind,
    source_fingerprint: state.source_fingerprint,
    privileged_execution: state.privileged_execution,
    installation: state.installation,
    update_ring: state.update_ring,
    allowed_source_kinds: Object.freeze([...state.allowed_source_kinds]),
    allowed_publishers: Object.freeze([...state.allowed_publishers]),
    require_sbom: state.require_sbom,
    require_build_provenance: state.require_build_provenance,
    managed_source_fingerprints: Object.freeze([...state.managed_source_fingerprints]),
    audit_max_entries: state.audit_max_entries,
    managed: state.status !== 'unmanaged',
  });
}

async function initializeManagedPolicy(managedPolicy, log = () => {}) {
  const ready = await managedPolicy?.initialize?.();
  if (ready?.ok === false) {
    log('WARN', 'plugins.managed_policy.initialization_degraded', {
      reason_code: String(ready.reason || 'managed_policy_unavailable').slice(0, 64),
    });
  }
  return ready;
}

function managedPolicyGrantRef(managedPolicy, base) {
  return managedPolicy?.policyGrantRef?.(base) || base;
}

function createManagedInstallValidator(managedPolicy, sourceKind, token = managedPolicy?.capture?.() || null) {
  return (verdict = {}) => {
    if (token && managedPolicy?.isCurrent?.(token) !== true) {
      return { ok: false, reason: 'managed_policy_authority_stale' };
    }
    const policy = managedPolicy?.status?.();
    if (!policy || policy.status === 'unmanaged') return { ok: true };
    if (policy.status === 'blocked') return { ok: false, reason: policy.reason };
    if (policy.installation === 'deny') {
      return { ok: false, reason: 'managed_policy_installation_denied' };
    }
    if (!policy.allowed_source_kinds.includes(sourceKind)) {
      return { ok: false, reason: 'managed_policy_source_denied' };
    }
    const sourceIdentity = verdict.package_record?.source_identity;
    if (sourceIdentity?.kind !== sourceKind) {
      return { ok: false, reason: 'managed_policy_source_denied' };
    }
    if (policy.allowed_publishers.length
      && !policy.allowed_publishers.includes(verdict.publisher_id)) {
      return { ok: false, reason: 'managed_policy_publisher_denied' };
    }
    if (policy.managed_source_fingerprints.length
      && !policy.managed_source_fingerprints.includes(digest(sourceIdentity))) {
      return { ok: false, reason: 'managed_policy_source_fingerprint_denied' };
    }
    if (policy.require_sbom && verdict.package_metadata?.sbom_present !== true) {
      return { ok: false, reason: 'managed_policy_sbom_required' };
    }
    if (policy.require_build_provenance
      && verdict.package_metadata?.build_provenance_present !== true) {
      return { ok: false, reason: 'managed_policy_build_provenance_required' };
    }
    return { ok: true };
  };
}

function createManagedInstallPolicy(managedPolicy, sourceKind) {
  const token = managedPolicy?.capture?.() || null;
  return Object.freeze({
    validate: createManagedInstallValidator(managedPolicy, sourceKind, token),
    commit: (operation) => managedPolicy?.withCurrentPolicy?.(token, operation) || operation(),
  });
}

function policyGrantRefForMutation(generation, fallback) {
  const current = generation?.policy_grant_ref;
  return current && typeof current === 'object' ? current : fallback;
}

async function managedActivationDenial({ operation, currentEntry, managedPolicy, reverify }) {
  if (operation !== 'enable' || !currentEntry || managedPolicy?.guard?.().ok !== false) return null;
  const checked = await reverify(currentEntry);
  const requestsPrivilege = checked.ok && checked.verdict.manifest.contributions.some(
    (item) => PRIVILEGED_CONTRIBUTION_KINDS.has(item.kind)
  );
  return requestsPrivilege
    ? (managedPolicy.status().reason || 'managed_policy_privileged_denied')
    : null;
}

function createManagedPolicyService({
  facade,
  baseDir = '',
  source,
  now = () => new Date().toISOString(),
  pollIntervalMs = DEFAULT_POLL_MS,
  log = () => {},
} = {}) {
  let state = defaultState();
  let initialized = false;
  let disposed = false;
  let refreshPromise = null;
  let initializationPromise = null;
  let timer = null;
  let policyFence = Promise.resolve();
  const listeners = new Set();

  function exclusive(operation) {
    const next = policyFence.then(operation, operation);
    policyFence = next.catch(() => {});
    return next;
  }

  function emit(previous) {
    if (previous.status === state.status
      && previous.effective_revision === state.effective_revision
      && previous.current_policy_digest === state.current_policy_digest
      && previous.reason === state.reason) return;
    const status = publicStatus(state);
    for (const listener of listeners) {
      try { listener(status); } catch (_error) { /* observer faults are isolated */ }
    }
  }

  async function publish(next, { persist = true } = {}) {
    if (disposed) return { ok: false, reason: 'managed_policy_disposed' };
    if (persist) {
      const written = await writeManagedPolicyState(facade, baseDir, next);
      if (disposed) return { ok: false, reason: 'managed_policy_disposed' };
      if (!written.ok) {
        const previous = state;
        state = Object.freeze(blockedFrom(state, written.reason, now(), next));
        initialized = true;
        emit(previous);
        log('WARN', 'plugins.managed_policy.persistence_failed', {
          reason_code: written.reason,
        });
        return { ok: false, reason: written.reason, status: publicStatus(state) };
      }
      next = written.state;
    }
    const previous = state;
    state = Object.freeze({ ...next });
    initialized = true;
    emit(previous);
    return { ok: true, status: publicStatus(state) };
  }

  function blockedFrom(current, reason, observedAt, sourceRead = {}) {
    const sourceKind = sourceRead.source_kind || current.source_kind;
    const sourceFingerprint = sourceRead.source_fingerprint || current.source_fingerprint;
    const changed = current.status !== 'blocked' || current.reason !== reason
      || current.current_policy_digest !== null
      || current.source_kind !== sourceKind || current.source_fingerprint !== sourceFingerprint;
    return {
      ...current,
      effective_revision: current.effective_revision + (changed ? 1 : 0),
      current_policy_digest: null,
      source_kind: sourceKind,
      source_fingerprint: sourceFingerprint,
      status: 'blocked',
      reason,
      privileged_execution: 'deny',
      observed_at: observedAt,
    };
  }

  async function performRefresh() {
    const observedAt = now();
    const stored = await readManagedPolicyState(facade, baseDir);
    if (disposed) return { ok: false, reason: 'managed_policy_disposed' };
    let current;
    if (stored.ok) current = stored.state;
    else if (stored.reason === 'managed_policy_state_missing') current = defaultState('unmanaged', 'managed_policy_absent');
    else {
      const next = blockedFrom(state, 'managed_policy_state_corrupt', observedAt);
      return publish(next, { persist: false });
    }

    let read;
    try { read = await source?.read?.(); }
    catch (_error) { read = { status: 'invalid', reason: 'managed_policy_source_unavailable' }; }
    if (disposed) return { ok: false, reason: 'managed_policy_disposed' };
    if (!read || read.status === 'invalid') {
      const reason = String(read?.reason || 'managed_policy_source_invalid').slice(0, 64);
      return publish(blockedFrom(current, reason, observedAt, read || {}));
    }
    if (read.status === 'missing') {
      const changed = current.status !== 'unmanaged' || current.current_policy_digest !== null;
      return publish({
        ...current,
        effective_revision: current.effective_revision + (changed ? 1 : 0),
        current_policy_digest: null,
        source_kind: null,
        source_fingerprint: null,
        status: 'unmanaged',
        reason: 'managed_policy_absent',
        privileged_execution: 'allow',
        installation: 'allow_inactive',
        update_ring: 'stable',
        allowed_source_kinds: [],
        allowed_publishers: [],
        require_sbom: false,
        require_build_provenance: false,
        managed_source_fingerprints: [],
        audit_max_entries: 1000,
        accepted_at: changed ? observedAt : current.accepted_at,
        observed_at: observedAt,
      });
    }
    if (read.status !== 'present') {
      return publish(blockedFrom(current, 'managed_policy_source_invalid', observedAt, read));
    }
    const verified = verifyManagedPolicyBundle(read.bytes, { now });
    if (!verified.ok) {
      return publish(blockedFrom(current, verified.reason, observedAt, read));
    }
    const externalRevision = verified.policy.revision;
    if (externalRevision < current.source_revision_high_water) {
      return publish(blockedFrom(current, 'managed_policy_downgrade_blocked', observedAt, read));
    }
    if (externalRevision === current.source_revision_high_water
      && current.source_policy_digest_high_water
      && verified.policy_digest !== current.source_policy_digest_high_water) {
      return publish(blockedFrom(current, 'managed_policy_equivocation_blocked', observedAt, read));
    }
    const unchanged = current.status === 'active'
      && current.current_policy_digest === verified.policy_digest
      && current.source_fingerprint === read.source_fingerprint;
    const next = {
      ...current,
      effective_revision: current.effective_revision + (unchanged ? 0 : 1),
      source_revision_high_water: Math.max(current.source_revision_high_water, externalRevision),
      source_policy_digest_high_water: verified.policy_digest,
      current_policy_digest: verified.policy_digest,
      source_kind: read.source_kind,
      source_fingerprint: read.source_fingerprint,
      status: 'active',
      reason: verified.policy.privileged_execution === 'deny'
        ? 'managed_policy_privileged_denied' : 'managed_policy_active',
      privileged_execution: verified.policy.privileged_execution,
      installation: verified.policy.installation,
      update_ring: verified.policy.update_ring,
      allowed_source_kinds: [...verified.policy.allowed_source_kinds],
      allowed_publishers: [...verified.policy.allowed_publishers],
      require_sbom: verified.policy.procurement.require_sbom,
      require_build_provenance: verified.policy.procurement.require_build_provenance,
      managed_source_fingerprints: [...verified.policy.managed_source_fingerprints],
      audit_max_entries: verified.policy.audit_max_entries,
      accepted_at: unchanged ? current.accepted_at : observedAt,
      observed_at: observedAt,
    };
    const settled = await publish(next);
    if (disposed) return { ok: false, reason: 'managed_policy_disposed' };
    if (settled.ok) log('INFO', 'plugins.managed_policy.accepted', {
      revision: next.effective_revision,
      source_revision: externalRevision,
      privileged_execution: next.privileged_execution,
    });
    return settled;
  }

  function refresh() {
    if (disposed) return Promise.resolve({ ok: false, reason: 'managed_policy_disposed' });
    if (!refreshPromise) {
      refreshPromise = exclusive(performRefresh).finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  function initialize() {
    if (!initializationPromise) {
      initializationPromise = refresh().then((result) => {
        if (!timer && !disposed && pollIntervalMs > 0) {
          timer = setInterval(() => { void refresh(); }, pollIntervalMs);
          timer.unref?.();
        }
        return result;
      });
    }
    return initializationPromise;
  }

  function capture() {
    return Object.freeze({
      revision: state.effective_revision,
      policy_digest: state.current_policy_digest || ZERO_DIGEST,
    });
  }

  function guard(token = null) {
    if (!initialized) return { ok: false, reason: 'managed_policy_loading' };
    if (token && (token.revision !== state.effective_revision
      || token.policy_digest !== (state.current_policy_digest || ZERO_DIGEST))) {
      return { ok: false, reason: 'managed_policy_authority_stale' };
    }
    if (state.status === 'blocked' || state.privileged_execution !== 'allow') {
      return { ok: false, reason: state.reason };
    }
    return { ok: true, token: capture() };
  }

  function isCurrent(token) {
    const current = capture();
    return Boolean(token) && token.revision === current.revision
      && token.policy_digest === current.policy_digest;
  }

  function policyGrantRef(base = {}) {
    const policyDigest = state.current_policy_digest || ZERO_DIGEST;
    const revision = state.effective_revision;
    const reference = {
      ...base,
      policy_snapshot_digest: policyDigest,
      policy_revision: revision,
    };
    if (Object.hasOwn(base, 'privileged_runtime_policy_digest')) {
      reference.privileged_runtime_policy_digest = digest({ policyDigest, revision,
        privileged_execution: state.privileged_execution });
    }
    if (Object.hasOwn(base, 'secret_delivery_policy_digest')) {
      reference.secret_delivery_policy_digest = digest({ policyDigest, revision,
        secret_delivery: state.privileged_execution });
    }
    if (Object.hasOwn(base, 'hook_policy_digest')) {
      reference.hook_policy_digest = digest({ policyDigest, revision,
        hooks: state.privileged_execution });
    }
    return reference;
  }

  return Object.freeze({
    initialize,
    ready: initialize,
    refresh,
    capture,
    guard,
    isCurrent,
    isPrivilegedAllowed: () => guard().ok,
    status: () => publicStatus(state),
    policyGrantRef,
    withCurrentPolicy(token, operation) {
      if (typeof operation !== 'function') {
        return Promise.resolve({ ok: false, reason: 'managed_policy_operation_invalid' });
      }
      return exclusive(() => {
        if (!initialized) return { ok: false, reason: 'managed_policy_loading' };
        if (token && !isCurrent(token)) {
          return { ok: false, reason: 'managed_policy_authority_stale' };
        }
        if (state.status === 'blocked') return { ok: false, reason: state.reason };
        return operation();
      });
    },
    subscribe(listener) {
      if (typeof listener !== 'function' || disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      listeners.clear();
    },
  });
}

module.exports = {
  ZERO_DIGEST,
  defaultState,
  initializeManagedPolicy,
  managedPolicyGrantRef,
  createManagedInstallValidator,
  createManagedInstallPolicy,
  policyGrantRefForMutation,
  managedActivationDenial,
  createManagedPolicyService,
};
