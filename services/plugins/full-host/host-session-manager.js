'use strict';

const { resourceTerminationConfirmed } = require('./host-resource-admission');

const DEFAULT_LIMITS = Object.freeze({
  global: 2, perPlugin: 1, perContribution: 1,
  idleMs: 300_000, absoluteMs: 3_600_000,
});

function sessionKey(authority, identity = {}) {
  return `${authority?.active_generation_id || ''}\0${authority?.commit_epoch || ''}\0${authority?.registry_revision || ''}\0${authority?.dependency_graph_hash || ''}\0${identity.publisher_id || ''}\0${identity.plugin_id || ''}\0${identity.contribution_id || ''}`;
}

class HostSessionManager {
  constructor({ startSession, terminateSession, limits = DEFAULT_LIMITS,
    onUnprovenTermination = async () => {}, isAuthorityCurrent = () => true,
    getEffectiveGlobalLimit = null,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
    this._start = startSession;
    this._terminate = terminateSession;
    this._limits = { ...DEFAULT_LIMITS, ...limits };
    this._onUnproven = onUnprovenTermination;
    this._isCurrent = isAuthorityCurrent;
    this._getEffectiveGlobalLimit = typeof getEffectiveGlobalLimit === 'function'
      ? getEffectiveGlobalLimit : () => this._limits.global;
    this._setTimeout = setTimeoutFn;
    this._clearTimeout = clearTimeoutFn;
    this._sessions = new Map();
    this._pending = new Map();
    this._pendingIdentity = new Map();
    this._terminations = new Map();
    this._revokingGenerations = new Set();
    this._unusable = new Set();
    this._timers = new Map();
    this._disposed = false;
    this._quiescing = false;
    this._quiesceConfirmed = false;
    this._quiescePromise = null;
  }

  _identity(contributionId, descriptor = {}) {
    return { publisher_id: descriptor.publisher_id || '', plugin_id: descriptor.plugin_id || '',
      contribution_id: contributionId || descriptor.contribution_id || '' };
  }

  _pluginCount(identity) {
    const matches = (value) => value.publisher_id === identity.publisher_id
      && value.plugin_id === identity.plugin_id;
    return [...this._sessions.values()].filter(matches).length
      + [...this._pendingIdentity.values()].filter(matches).length;
  }

  _contributionCount(identity) {
    const matches = (value) => value.publisher_id === identity.publisher_id
      && value.plugin_id === identity.plugin_id
      && value.contribution_id === identity.contribution_id;
    return [...this._sessions.values()].filter(matches).length
      + [...this._pendingIdentity.values()].filter(matches).length;
  }

  _clearTimers(key) {
    const timers = this._timers.get(key);
    if (timers) {
      this._clearTimeout(timers.idle);
      this._clearTimeout(timers.absolute);
    }
    this._timers.delete(key);
  }

  _schedule(key, session) {
    const existing = this._timers.get(key);
    if (existing) this._clearTimeout(existing.idle);
    const idle = this._setTimeout(() => { void this._terminateKey(key, 'idle_eviction'); },
      this._limits.idleMs);
    idle.unref?.();
    const absoluteMs = Number.isSafeInteger(session?.host_absolute_lease_ms)
      && session.host_absolute_lease_ms > 0
      ? session.host_absolute_lease_ms : this._limits.absoluteMs;
    const absolute = existing?.absolute || this._setTimeout(
      () => { void this._terminateKey(key, 'absolute_lease_expired'); }, absoluteMs
    );
    absolute.unref?.();
    this._timers.set(key, { idle, absolute, session });
  }

  _touch(key, session) {
    if (this._disposed || this._unusable.has(key) || this._sessions.get(key) !== session) {
      return false;
    }
    this._schedule(key, session);
    return true;
  }

  _withActivityTracking(key, source, authority, identity) {
    const session = { ...source, authority: { ...authority }, ...identity };
    for (const operation of ['describe', 'invoke', 'status', 'cancel']) {
      const handler = source?.[operation];
      if (typeof handler !== 'function') continue;
      session[operation] = (...args) => {
        this._touch(key, session);
        return handler.apply(source, args);
      };
    }
    return Object.freeze(session);
  }

  _effectiveGlobalLimit() {
    try {
      const value = this._getEffectiveGlobalLimit(this._limits.global);
      return Number.isSafeInteger(value) && value >= 0
        ? Math.min(value, this._limits.global) : 0;
    } catch (_error) { return 0; }
  }

  async _recordUnproven(record) {
    try {
      const result = await this._onUnproven(record);
      return result !== false && result?.ok !== false;
    } catch (_error) { return false; }
  }

  async acquire({ authority, contributionId, descriptor = {}, ...request }) {
    if (this._disposed) return { ok: false, reason: 'session_manager_disposed' };
    if (this._quiescing) return { ok: false, reason: 'session_manager_quiescing' };
    if (this._revokingGenerations.has(authority?.active_generation_id)) {
      return { ok: false, reason: 'generation_revoked' };
    }
    if (!this._isCurrent(authority, request.policyToken)) {
      return { ok: false, reason: 'managed_policy_authority_stale' };
    }
    const identity = this._identity(contributionId, descriptor);
    const key = sessionKey(authority, identity);
    if (this._unusable.has(key)) {
      return { ok: false, reason: 'host_session_cleanup_pending' };
    }
    if (this._sessions.has(key)) {
      const active = this._sessions.get(key);
      this._schedule(key, active);
      return { ok: true, session: active, reused: true };
    }
    if (this._pending.has(key)) return this._pending.get(key);
    if (this._sessions.size + this._pending.size >= this._effectiveGlobalLimit()) {
      return { ok: false, reason: 'host_session_global_limit' };
    }
    if (this._pluginCount(identity) >= this._limits.perPlugin) {
      return { ok: false, reason: 'host_session_plugin_limit' };
    }
    if (this._contributionCount(identity) >= this._limits.perContribution) {
      return { ok: false, reason: 'host_session_contribution_limit' };
    }
    const promise = Promise.resolve(this._start({ authority, contributionId, descriptor, ...request }))
      .then(async (result) => {
        if (!result?.ok) return result;
        const session = this._withActivityTracking(
          key, result.session, authority, identity
        );
        const generationRevoked = this._revokingGenerations.has(authority?.active_generation_id);
        if (this._disposed || this._quiescing || generationRevoked
          || !this._isCurrent(authority, request.policyToken)) {
          const reason = this._disposed ? 'session_manager_disposed'
            : (this._quiescing ? 'session_manager_quiescing'
              : (generationRevoked ? 'generation_revoked' : 'managed_policy_revoked'));
          // Publish the exact native identity before any await. Cleanup
          // reconciliation must be able to find a launch that policy prevented
          // from becoming reusable.
          this._sessions.set(key, session);
          this._unusable.add(key);
          const termination = await this._terminateKey(key, reason);
          return { ok: false, reason, termination,
            ...(termination?.cleanup_persisted === false
              ? { cleanup_persistence_failed: true } : {}) };
        }
        this._sessions.set(key, session);
        this._schedule(key, session);
        return { ok: true, session, reused: false };
      }).finally(() => { this._pending.delete(key); this._pendingIdentity.delete(key); });
    this._pending.set(key, promise);
    this._pendingIdentity.set(key, { ...identity,
      active_generation_id: authority?.active_generation_id || null });
    return promise;
  }

  _terminateKey(key, reason) {
    if (this._terminations.has(key)) return this._terminations.get(key);
    const operation = (async () => {
      const session = this._sessions.get(key);
      if (!session) return { ok: true, already_absent: true };
      this._unusable.add(key);
      const result = await this._terminate(session, reason);
      if (resourceTerminationConfirmed(result)) {
        this._sessions.delete(key);
        this._unusable.delete(key);
        this._clearTimers(key);
      } else {
        const persisted = await this._recordUnproven({ session, result, reason });
        if (!persisted) return { ...(result || {}), ok: false,
          reason: 'cleanup_persistence_failed', cleanup_persisted: false,
          termination_reason: result?.reason || reason };
      }
      return result;
    })();
    const termination = operation.finally(() => { this._terminations.delete(key); });
    this._terminations.set(key, termination);
    return termination;
  }

  async terminate({ authority, contributionId, publisherId = '', pluginId = '',
    reason = 'requested' }) {
    const wanted = sessionKey(authority, { publisher_id: publisherId, plugin_id: pluginId,
      contribution_id: contributionId });
    const key = this._sessions.has(wanted) ? wanted : [...this._sessions.entries()]
      .find(([, value]) => value.authority.active_generation_id === authority?.active_generation_id
        && value.contribution_id === contributionId)?.[0];
    return key ? this._terminateKey(key, reason) : { ok: true, already_absent: true };
  }

  async revokeGeneration(generationId) {
    this._revokingGenerations.add(generationId);
    try {
      const pending = [...this._pending.entries()].filter(([key]) => (
        this._pendingIdentity.get(key)?.active_generation_id === generationId
      )).map(([, promise]) => promise);
      await Promise.allSettled(pending);
      const targets = [...this._sessions.entries()].filter(([, value]) => (
        value.authority.active_generation_id === generationId
      ));
      return Promise.all(targets.map(([key]) => this._terminateKey(key, 'generation_revoked')));
    } finally {
      this._revokingGenerations.delete(generationId);
    }
  }

  async revokeAll(reason = 'managed_policy_revoked') {
    for (const key of this._sessions.keys()) this._unusable.add(key);
    await Promise.allSettled([...this._pending.values()]);
    const results = await Promise.all([...this._sessions.keys()].map((key) => (
      this._terminateKey(key, reason)
    )));
    const unproven = results.filter((result) => (
      !resourceTerminationConfirmed(result)
    ));
    return {
      ok: unproven.length === 0,
      status: unproven.length ? 'termination_failed' : 'complete',
      terminated_count: results.length - unproven.length,
      unproven_count: unproven.length,
    };
  }

  async terminatePlugin(publisherId, pluginId, reason = 'plugin_uninstalled') {
    const matches = (identity) => identity.publisher_id === publisherId
      && identity.plugin_id === pluginId;
    const pending = [...this._pending.entries()].filter(([key]) => (
      matches(this._pendingIdentity.get(key) || {})
    )).map(([, promise]) => promise);
    await Promise.allSettled(pending);
    const targets = [...this._sessions.entries()].filter(([, value]) => matches(value));
    const results = await Promise.all(targets.map(([key]) => this._terminateKey(key, reason)));
    const unproven = results.find((result) => (
      !resourceTerminationConfirmed(result)
    ));
    return unproven ? { ok: false, status: 'pending_restart',
      reason: unproven.reason || 'termination_unproven' } : { ok: true, status: 'complete' };
  }

  snapshot() {
    return { active: this._sessions.size, pending: this._pending.size,
      unusable: this._unusable.size };
  }
  sessions() { return [...this._sessions.values()]; }
  resolveSession(sessionId) {
    const match = [...this._sessions.entries()].find(([key, value]) => (
      value.session_id === sessionId && !this._unusable.has(key)
    ));
    return match ? { ok: true, session: match[1] }
      : { ok: false, reason: 'host_session_not_found' };
  }
  confirmTermination({ session_id: sessionId, session_epoch: sessionEpoch } = {}) {
    const sameId = [...this._sessions.entries()].filter(([, value]) => (
      value.session_id === sessionId
    ));
    const match = sameId.find(([, value]) => value.session_epoch === sessionEpoch);
    if (!match) return sameId.length
      ? { ok: false, reason: 'host_session_cleanup_identity_mismatch' }
      : { ok: true, already_absent: true };
    const [key] = match;
    if (!this._unusable.has(key)) {
      return { ok: false, reason: 'host_session_cleanup_not_pending' };
    }
    this._sessions.delete(key);
    this._unusable.delete(key);
    this._clearTimers(key);
    return { ok: true, confirmed: true };
  }
  markSupervisorSessionsUnusable(sessions = []) {
    const wanted = new Set((Array.isArray(sessions) ? sessions : []).map((session) => (
      `${String(session?.session_id || '')}\0${String(session?.session_epoch || '')}`
    )));
    const matched = [];
    for (const [key, session] of this._sessions) {
      if (!wanted.has(`${String(session.session_id || '')}\0${String(session.session_epoch || '')}`)) {
        continue;
      }
      this._unusable.add(key);
      matched.push(session);
    }
    return matched;
  }
  async handleSupervisorExit(sessions, reason = 'native_supervisor_exited',
    onInvalidated = async () => {}) {
    const matched = this.markSupervisorSessionsUnusable(sessions);
    const results = await Promise.all(matched.map(async (session) => {
      let invalidationRecorded = true;
      try { await onInvalidated(session); } catch (_error) { invalidationRecorded = false; }
      const key = [...this._sessions.entries()].find(([, current]) => current === session)?.[0];
      const termination = key ? await this._terminateKey(key, reason)
        : { ok: true, already_absent: true };
      return { session, termination, invalidation_recorded: invalidationRecorded };
    }));
    return { ok: results.every((result) => result.invalidation_recorded
        && resourceTerminationConfirmed(result.termination)), results };
  }
  async handleUnexpectedExit(sessionId, reason = 'host_process_exited',
    onInvalidated = async () => {}, sessionEpoch = null) {
    const match = [...this._sessions.entries()].find(([, value]) => (
      value.session_id === sessionId
      && (sessionEpoch === null || value.session_epoch === sessionEpoch)
    ));
    if (!match) return { ok: false, reason: 'host_session_not_found' };
    const [key, session] = match;
    // Mark the session unusable before the first await. The process may already
    // be dead, and an unproven cleanup must retain accounting without allowing
    // the dead channel to be handed out again.
    this._unusable.add(key);
    let invalidationRecorded = true;
    try { await onInvalidated(session); } catch (_error) { invalidationRecorded = false; }
    const termination = await this._terminateKey(key, reason);
    if (!invalidationRecorded) this._unusable.add(key);
    return { ok: invalidationRecorded
        && resourceTerminationConfirmed(termination),
      session, termination };
  }
  beginQuiesce(reason = 'backend_stop') {
    if (this._disposed) {
      return Promise.resolve({ ok: false, reason: 'session_manager_disposed' });
    }
    if (this._quiescePromise) return this._quiescePromise;
    this._quiescing = true;
    this._quiesceConfirmed = false;
    const operation = (async () => {
      await Promise.allSettled([...this._pending.values()]);
      const results = await Promise.all([...this._sessions.keys()].map((key) => (
        this._terminateKey(key, reason)
      )));
      const snapshot = this.snapshot();
      const ok = snapshot.active === 0 && snapshot.pending === 0 && snapshot.unusable === 0
        && results.every(resourceTerminationConfirmed);
      this._quiesceConfirmed = ok;
      if (!ok) this._quiescePromise = null;
      return { ok, ...(ok ? {} : { reason: 'host_session_cleanup_unconfirmed' }),
        terminated_count: results.filter(resourceTerminationConfirmed).length,
        unproven_count: results.filter((result) => !resourceTerminationConfirmed(result)).length };
    })();
    this._quiescePromise = operation;
    return operation;
  }
  reopenAfterQuiesce() {
    if (this._disposed) return { ok: false, reason: 'session_manager_disposed' };
    if (!this._quiescing) return { ok: true };
    if (!this._quiesceConfirmed) {
      return { ok: false, reason: 'host_session_cleanup_unconfirmed' };
    }
    this._quiescing = false;
    this._quiesceConfirmed = false;
    this._quiescePromise = null;
    return { ok: true };
  }
  async dispose() {
    this._disposed = true;
    this._quiescing = true;
    const keys = [...this._sessions.keys()];
    await Promise.allSettled(keys.map((key) => this._terminateKey(key, 'shutdown')));
    await Promise.allSettled([...this._pending.values()]);
    for (const key of this._timers.keys()) this._clearTimers(key);
    for (const key of this._unusable) {
      if (!this._sessions.has(key)) this._unusable.delete(key);
    }
    return this.snapshot();
  }
}

module.exports = { DEFAULT_LIMITS, sessionKey, HostSessionManager };
