'use strict';

const { stableJson, validId } = require('./contracts');
const ELIGIBILITY_ADMISSIONS = new WeakMap();

// Live resource waits inherit the original Send authorization. This registry is
// intentionally empty after restart and never discovers paused work on disk.
class RuntimeEligibilityCoordinator {
  constructor({ broker, incarnation, getWork, resume, enabled = true, canDispatch = () => true, onAttention = null,
    maxWaits = 256, dependencyReady = null } = {}) {
    if (typeof broker?.canAcquire !== 'function'
      || typeof broker?.onAvailabilityChange !== 'function'
      || typeof incarnation !== 'string' || !incarnation
      || [getWork, resume, canDispatch].some(port => typeof port !== 'function')
      || typeof enabled !== 'boolean'
      || !Number.isSafeInteger(maxWaits) || maxWaits < 1 || maxWaits > 256) {
      throw new TypeError('runtime_eligibility_dependencies_invalid');
    }
    Object.assign(this, { broker, incarnation, getWork, resume, enabled, canDispatch, maxWaits });
    this.dependencyReady = dependencyReady;
    this.onAttention = typeof onAttention === 'function' ? onAttention : null;
    this.waits = new Map();
    this.admissions = new Map();
    this.admissionCount = 0;
    this.scheduled = false;
    this.disposed = false;
    this.unsubscribe = broker.onAvailabilityChange(() => this.wake());
  }

  captureAdmission(sessionId) {
    const id = String(sessionId || '').trim();
    const token = Object.freeze({});
    const captured = { owner: this, sessionId: id, valid: !this.disposed };
    ELIGIBILITY_ADMISSIONS.set(token, captured);
    if (captured.valid && this.admissionCount < this.maxWaits) {
      const tokens = this.admissions.get(id) || new Set();
      tokens.add(token);
      this.admissions.set(id, tokens);
      this.admissionCount += 1;
    } else {
      captured.valid = false;
    }
    return token;
  }

  releaseAdmission(token) {
    const captured = ELIGIBILITY_ADMISSIONS.get(token);
    if (captured?.owner !== this || !captured.valid) return false;
    captured.valid = false;
    const tokens = this.admissions.get(captured.sessionId);
    if (!tokens?.delete(token)) return false;
    this.admissionCount -= 1;
    if (!tokens.size) this.admissions.delete(captured.sessionId);
    return true;
  }

  track(workId, resources, { admission = null } = {}) {
    if (this.disposed || !this._isEnabled()) return this._rejected('runtime_eligibility_disabled');
    const work = this.getWork(workId);
    if (admission && !this._admissionCurrent(work, admission)) {
      return this._rejected('runtime_wait_controlled');
    }
    if (!this._eligible(work)) return this._rejected('runtime_wait_not_live');
    const existing = this.waits.get(workId);
    if (existing) return this._rejected('runtime_wait_already_tracked');
    if (this.waits.size >= this.maxWaits) return this._rejected('runtime_wait_capacity');
    // The broker validates descriptors; this probe never reserves a physical
    // resource. Descriptors originate at the application-owned wait operation.
    const dependency = resources?.length === 1 && resources[0]?.type === 'dependency' ? resources[0] : null;
    if (dependency) {
      if (Object.keys(dependency).sort().join(',') !== 'type,work_id' || !validId(dependency.work_id)
        || dependency.work_id === workId || typeof this.dependencyReady !== 'function') {
        return this._rejected('runtime_dependency_wait_invalid');
      }
    } else this.broker.canAcquire(resources);
    // Keep branded immutable physical identities. Serialization/cloning would
    // erase their provenance; retain only the broker's supported descriptor fields.
    const captured = Object.freeze(resources.map(resource => Object.freeze(
      resource.type === 'dependency' ? { type: 'dependency', work_id: resource.work_id }
        : resource.type === 'capacity'
        ? { type: 'capacity', key: resource.key, units: resource.units ?? 1 }
        : { type: 'filesystem', identity: resource.identity }
    )));
    this.waits.set(workId, { revision: work.revision,
      checkpoint: stableJson(work.checkpoint_ref), resources: captured, dependencyId: dependency?.work_id || null,
      sequence: work.submission_sequence, sessionId: work.session_id,
      streamId: work.attempt.stream_id });
    this.wake();
    return Object.freeze({ status: 'tracked' });
  }

  forget(workId) { return this.waits.delete(workId); }

  forgetStream(streamId) {
    const id = String(streamId || '').trim();
    let cleared = 0;
    for (const [workId, wait] of this.waits) {
      if (wait.streamId === id) { this.waits.delete(workId); cleared += 1; }
    }
    return cleared;
  }

  clearSession(sessionId) {
    const id = String(sessionId || '').trim();
    this._invalidateAdmissions(id);
    let cleared = 0;
    for (const [workId, wait] of this.waits) {
      if (wait.sessionId === id) { this.waits.delete(workId); cleared += 1; }
    }
    return cleared;
  }

  setEnabled(enabled) {
    this.enabled = enabled === true;
    // OFF is an event, not a sampled predicate: a later ON must not resurrect
    // idle waits even if no resource changed while the runtime was disabled.
    if (!this.enabled) this.clear();
  }

  clear() {
    const cleared = this.waits.size;
    this._invalidateAdmissions();
    this.waits.clear();
    return cleared;
  }

  dispose() {
    this.disposed = true;
    this.clear();
    this.unsubscribe();
  }

  snapshot() {
    return Object.freeze({ wait_count: this.waits.size,
      admission_count: this.admissionCount, disposed: this.disposed });
  }

  wake() {
    if (this.disposed || this.scheduled || !this.waits.size) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.disposed) return;
      try { this._pump(); } catch (error) { this.clear(); this._attention(null, error); }
    });
  }

  _pump() {
    if (!this._isEnabled()) { this.clear(); return; }
    const ordered = [...this.waits].sort((left, right) => left[1].sequence - right[1].sequence);
    for (const [workId, wait] of ordered) {
      if (this.disposed || !this._isEnabled()) { this.clear(); return; }
      if (this.waits.get(workId) !== wait) continue;
      try {
        const work = this.getWork(workId);
        if (!this._eligible(work) || work.revision !== wait.revision
          || stableJson(work.checkpoint_ref) !== wait.checkpoint) {
          this.waits.delete(workId);
          continue;
        }
        if (wait.dependencyId ? this.dependencyReady(work, wait.dependencyId) !== true
          : !this.broker.canAcquire(wait.resources)) continue;
        // Remove before calling the existing admission owner: it may complete or
        // checkpoint synchronously through a test/embedded provider.
        this.waits.delete(workId);
        const result = this.resume(workId, work.revision);
        if (result?.status !== 'accepted') {
          this._attention(workId, new Error(result?.reason || 'runtime_wait_resume_refused'));
        }
      } catch (error) {
        // A transient provider gate may become eligible on a later explicit wake.
        // Nothing polls or creates a worker while that gate remains closed.
        if (error?.retryable === true && this._isEnabled() && !this.disposed) {
          if (!this.waits.has(workId) && this.waits.size < this.maxWaits) this.waits.set(workId, wait);
          else if (!this.waits.has(workId)) this._attention(workId, new Error('runtime_wait_capacity'));
        } else {
          this.waits.delete(workId);
          this._attention(workId, error);
        }
      }
    }
  }

  _eligible(work) {
    return Boolean(work?.status === 'paused' && work.control_request == null
      && work.transition?.reason === 'checkpoint_suspended'
      && work.attempt?.incarnation === this.incarnation && work.checkpoint_ref
      && stableJson(work.checkpoint_ref.source_attempt) === stableJson(work.attempt));
  }

  _admissionCurrent(work, token) {
    const captured = ELIGIBILITY_ADMISSIONS.get(token);
    return Boolean(captured?.owner === this && captured.sessionId === work?.session_id
      && captured.valid && this.admissions.get(captured.sessionId)?.has(token));
  }

  _invalidateAdmissions(sessionId = null) {
    const groups = sessionId === null ? [...this.admissions] : [[sessionId, this.admissions.get(sessionId)]];
    for (const [id, tokens] of groups) {
      if (!tokens) continue;
      for (const token of tokens) {
        const captured = ELIGIBILITY_ADMISSIONS.get(token);
        if (captured?.owner === this) captured.valid = false;
        this.admissionCount -= 1;
      }
      this.admissions.delete(id);
    }
  }

  _isEnabled() { return this.enabled && this.canDispatch() === true; }

  _attention(workId, error) {
    try { this.onAttention?.({ work_id: workId, reason: String(error?.code || error?.message || 'runtime_wait_failed') }); }
    catch (_error) { /* Diagnostics cannot authorize or restart work. */ }
  }

  _rejected(reason) { return Object.freeze({ status: 'rejected', reason }); }
}

module.exports = { RuntimeEligibilityCoordinator };
