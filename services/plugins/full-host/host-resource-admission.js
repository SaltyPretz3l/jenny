'use strict';

const { createHash } = require('node:crypto');
const { capacityResource } = require('../../session-runtime/resource-broker');

const hostHandles = new WeakMap();
const supervisorHandles = new WeakMap();
const MAX_TERMINATED_SUPERVISOR_PROOFS = 256;

function resourceTerminationConfirmed(result) {
  if (result?.resource_cleanup?.required === true) {
    return result.resource_cleanup.cleanup === 'confirmed'
      && result.resource_cleanup.process_tree_terminated === true
      && result.resource_cleanup.output_readers_terminated === true;
  }
  return result?.terminated === true && result?.tree_empty === true;
}

function completeProof(proof) {
  return proof?.terminated === true && proof?.tree_empty === true
    && proof?.output_readers_terminated === true;
}

function cleanupMetadata(proof, cleanup, reason, extra = {}) {
  return Object.freeze({
    required: true,
    cleanup,
    process_tree_terminated: proof?.terminated === true && proof?.tree_empty === true,
    output_readers_terminated: proof?.output_readers_terminated === true,
    reason: String(reason || (cleanup === 'confirmed' ? 'host_cleanup_confirmed'
      : 'host_cleanup_unproven')).slice(0, 120),
    ...extra,
  });
}

function ownerId(sessionId, sessionEpoch, identity = {}) {
  const source = [sessionId, sessionEpoch, identity.publisher_id, identity.plugin_id,
    identity.contribution_id].join('\0');
  return `native-host-${createHash('sha256').update(source).digest('hex')}`;
}

function supervisorOwnerId(sequence) {
  return `native-supervisor-${createHash('sha256').update(String(sequence)).digest('hex')}`;
}

class HostResourceAdmission {
  constructor({ resourceAdmissionProvider } = {}) {
    this._provider = resourceAdmissionProvider;
    this._declared = resourceAdmissionProvider !== undefined
      && resourceAdmissionProvider !== null;
    this._records = new Map();
    this._supervisor = null;
    this._supervisorSequence = 0;
    this._terminatedSupervisors = new Set();
  }

  get required() { return this._declared; }

  _key(sessionId, sessionEpoch) {
    return `${String(sessionId || '')}\0${String(sessionEpoch || '')}`;
  }

  _runtime() {
    if (!this._declared || typeof this._provider !== 'function') return null;
    let runtime;
    try { runtime = this._provider(); } catch (_error) { return null; }
    const broker = runtime?.broker;
    return broker && typeof broker.tryAcquire === 'function'
      && typeof broker.release === 'function'
      && typeof broker.confirmCleanup === 'function' ? { broker } : null;
  }

  effectiveHostLimit(configured) {
    if (!Number.isSafeInteger(configured) || configured < 0) return 0;
    if (!this._declared) return configured;
    const runtime = this._runtime();
    if (!runtime || typeof runtime.broker.snapshot !== 'function') return 0;
    const capacity = runtime.broker.snapshot()?.limits?.native_processes;
    return Number.isSafeInteger(capacity) ? Math.min(configured, Math.max(0, capacity - 1)) : 0;
  }

  tryStart({ sessionId, sessionEpoch, identity = {}, signal = null, validate = null } = {}) {
    if (!this._declared) return Object.freeze({ ok: true, required: false, handle: null });
    const key = this._key(sessionId, sessionEpoch);
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128
      || !Number.isSafeInteger(sessionEpoch) || sessionEpoch < 1
      || this._records.has(key) || (validate !== null && typeof validate !== 'function')) {
      return this._noStart('native_host_resource_identity_invalid');
    }
    const runtime = this._runtime();
    if (!runtime) return this._noStart('native_host_resource_unavailable');
    let admission;
    try {
      admission = runtime.broker.tryAcquire({
        ownerId: ownerId(sessionId, sessionEpoch, identity),
        resources: [capacityResource('native_processes')],
        signal,
        validate,
      });
    } catch (_error) {
      return this._noStart('native_host_resource_unavailable');
    }
    if (admission?.status !== 'granted') {
      const waiting = admission?.status === 'waiting';
      return this._noStart(waiting ? 'native_host_resource_capacity'
        : (admission?.reason || 'native_host_resource_unavailable'), waiting);
    }
    const record = {
      key,
      sessionId,
      sessionEpoch,
      broker: runtime.broker,
      lease: admission.lease,
      attempted: false,
      quarantined: false,
    };
    const handle = Object.freeze({ session_id: sessionId, session_epoch: sessionEpoch });
    hostHandles.set(handle, record);
    this._records.set(key, record);
    return Object.freeze({ ok: true, required: true, handle });
  }

  _noStart(reason, retryable = false) {
    return Object.freeze({
      ok: false,
      reason,
      retryable,
      no_start: true,
      resource_cleanup: cleanupMetadata(null, 'confirmed', reason, { producer_started: false }),
    });
  }

  markAttempted(handle) {
    const record = hostHandles.get(handle);
    if (!record || this._records.get(record.key) !== record || record.attempted) return false;
    record.attempted = true;
    return true;
  }

  settleNoStart(handle, reason = 'native_host_not_started') {
    const record = hostHandles.get(handle);
    if (!record || this._records.get(record.key) !== record || record.attempted) {
      return cleanupMetadata(null, 'uncertain', 'native_host_no_start_unproven');
    }
    const released = record.broker.release(record.lease, { producerSettled: true });
    if (released) this._records.delete(record.key);
    return cleanupMetadata(null, released ? 'confirmed' : 'uncertain',
      released ? reason : 'native_host_resource_release_failed', { producer_started: false });
  }

  quarantine(handle, reason = 'native_host_start_uncertain') {
    const record = hostHandles.get(handle);
    if (record && this._records.get(record.key) === record) {
      record.quarantined = true;
      record.broker.release(record.lease, { producerSettled: false });
    }
    return cleanupMetadata(null, 'uncertain', reason, { producer_started: true });
  }

  settleTermination({ sessionId, sessionEpoch, proof, reason } = {}) {
    if (!this._declared) return null;
    const key = this._key(sessionId, sessionEpoch);
    const record = this._records.get(key);
    const proofComplete = completeProof(proof);
    let released = proofComplete;
    if (record) {
      if (proofComplete) {
        released = record.broker.confirmCleanup(record.lease);
        if (released) this._records.delete(key);
      } else {
        record.quarantined = true;
        record.broker.release(record.lease, { producerSettled: false });
      }
    }
    const confirmed = proofComplete && released;
    if (confirmed) this._terminatedSupervisors.delete(key);
    return cleanupMetadata(proof, confirmed ? 'confirmed' : 'uncertain',
      confirmed ? (reason || 'native_host_cleanup_confirmed')
        : (reason || 'native_host_cleanup_unproven'), { producer_started: true });
  }


  trySupervisorStart({ signal = null, validate = null } = {}) {
    if (!this._declared) return Object.freeze({ ok: true, required: false, handle: null });
    if (this._supervisor || (validate !== null && typeof validate !== 'function')) {
      return this._noStart('native_supervisor_resource_identity_invalid');
    }
    const runtime = this._runtime();
    if (!runtime) return this._noStart('native_supervisor_resource_unavailable');
    let admission;
    try {
      admission = runtime.broker.tryAcquire({
        ownerId: supervisorOwnerId(++this._supervisorSequence),
        resources: [capacityResource('native_processes')], signal, validate,
      });
    } catch (_error) {
      return this._noStart('native_supervisor_resource_unavailable');
    }
    if (admission?.status !== 'granted') {
      return this._noStart(admission?.status === 'waiting'
        ? 'native_supervisor_resource_capacity'
        : (admission?.reason || 'native_supervisor_resource_unavailable'),
      admission?.status === 'waiting');
    }
    const record = { broker: runtime.broker, lease: admission.lease, attempted: false,
      spawned: false, quarantined: false };
    const handle = Object.freeze({ sequence: this._supervisorSequence });
    supervisorHandles.set(handle, record);
    this._supervisor = record;
    return Object.freeze({ ok: true, required: true, handle });
  }

  markSupervisorAttempted(handle) {
    const record = supervisorHandles.get(handle);
    if (!record || this._supervisor !== record || record.attempted) return false;
    record.attempted = true;
    return true;
  }

  markSupervisorSpawned(handle) {
    const record = supervisorHandles.get(handle);
    if (!record || this._supervisor !== record || !record.attempted || record.spawned) return false;
    record.spawned = true;
    return true;
  }

  settleSupervisorNoStart(handle, reason = 'native_supervisor_not_started') {
    const record = supervisorHandles.get(handle);
    if (!record || this._supervisor !== record || record.spawned) {
      return cleanupMetadata(null, 'uncertain', 'native_supervisor_no_start_unproven');
    }
    const released = record.broker.release(record.lease, { producerSettled: true });
    if (released) this._supervisor = null;
    return cleanupMetadata(null, released ? 'confirmed' : 'uncertain', released ? reason
      : 'native_supervisor_resource_release_failed', { producer_started: false });
  }

  quarantineSupervisor(handle, reason = 'native_supervisor_cleanup_unproven') {
    const record = supervisorHandles.get(handle);
    if (record && this._supervisor === record) {
      record.quarantined = true;
      record.broker.release(record.lease, { producerSettled: false });
    }
    return cleanupMetadata(null, 'uncertain', reason, { producer_started: true });
  }

  settleSupervisorClose(handle, { processClosed = false, outputReadersTerminated = false,
    sessions = [], reason = 'native_supervisor_closed' } = {}) {
    const record = supervisorHandles.get(handle);
    const exactSessionKeys = sessions.filter((session) => typeof session?.session_id === 'string'
      && session.session_id && Number.isSafeInteger(session.session_epoch)
      && session.session_epoch > 0).map((session) => this._key(
      session.session_id, session.session_epoch
    ));
    const newProofCount = exactSessionKeys.filter(
      (key) => !this._terminatedSupervisors.has(key)
    ).length;
    const complete = record && this._supervisor === record && record.spawned
      && processClosed === true && outputReadersTerminated === true
      && this._terminatedSupervisors.size + newProofCount
        <= MAX_TERMINATED_SUPERVISOR_PROOFS;
    const released = complete && record.broker.confirmCleanup(record.lease);
    if (released) {
      this._supervisor = null;
      for (const key of exactSessionKeys) this._terminatedSupervisors.add(key);
    }
    return cleanupMetadata({ terminated: processClosed, tree_empty: processClosed,
      output_readers_terminated: outputReadersTerminated }, released ? 'confirmed' : 'uncertain',
    released ? reason : 'native_supervisor_cleanup_unproven', { producer_started: true });
  }

  applyPriorSupervisorProof({ sessionId, sessionEpoch, proof } = {}) {
    const key = this._key(sessionId, sessionEpoch);
    if (!this._terminatedSupervisors.has(key) || proof?.known !== true
      || proof?.reaped !== true || proof?.tree_empty !== true) return proof;
    return Object.freeze({ ...proof, terminated: true, output_readers_terminated: true,
      previous_supervisor_terminated: true });
  }

  acknowledgeTermination({ sessionId, sessionEpoch } = {}) {
    return this._terminatedSupervisors.delete(this._key(sessionId, sessionEpoch));
  }

  snapshot() {
    const records = [...this._records.values()];
    return Object.freeze({
      active: records.filter((record) => !record.quarantined).length,
      quarantined: records.filter((record) => record.quarantined).length,
    });
  }
}

function createHostResourceAdmission(options) {
  return new HostResourceAdmission(options);
}

module.exports = {
  HostResourceAdmission,
  createHostResourceAdmission,
  resourceTerminationConfirmed,
};
