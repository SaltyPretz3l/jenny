'use strict';

const { normalizeReason } = require('./lifecycle');
const { TERMINAL } = require('./terminal-retention-contract');

const ATTEMPT_KEYS = ['attempt_id', 'stream_id', 'incarnation', 'authority_revision'];

function sameAttempt(left, right) {
  return Boolean(left && right && ATTEMPT_KEYS.every(key => left[key] === right[key]));
}

// Backend-restart proof (B3D-1): the sidecar process tree that ran these
// producers is gone, so an entry whose producer already returned an unproven
// outcome can never confirm late. Retire it and release its quarantined lane;
// a producer that has not returned yet is left alone and reported as retained.
// Work parked in needs_attention with a pause or cancel intent keeps that
// status, as a new process keeps it (store _pauseUnfinishedAfterRestart): the
// checkpoint it may have published is recovered by the caller, so only its lane
// and entry are released here and it is reported with status needs_attention.
// Quarantined lane leases that no remaining active entry owns are confirmed too.
function reclaimAbandonedWork(scheduler, { reason = 'backend_restart' } = {}) {
  const normalizedReason = normalizeReason(reason, 'backend_restart');
  const reclaimed = [];
  const retained = [];
  for (const entry of [...scheduler.active.values()]) {
    const id = entry.work.work_id;
    if (entry.initialSettlementDone !== true) {
      retained.push(Object.freeze({ work_id: id, reason: 'runtime_producer_pending' }));
      continue;
    }
    try {
      const current = scheduler.store.get(id);
      if (!current || !sameAttempt(current.attempt, entry.attempt)) {
        throw new Error('runtime_attempt_stale');
      }
      let status = current.status;
      const awaitsRecovery = status === 'needs_attention'
        && ['pause', 'cancel'].includes(current.control_request?.kind);
      if (!TERMINAL.has(status) && !awaitsRecovery) {
        status = current.control_request?.kind === 'cancel' ? 'cancelled' : 'failed';
        scheduler.store.transition(id, { expectedRevision: current.revision,
          expectedAttempt: entry.attempt, to: status, reason: normalizedReason });
      }
      scheduler._mutateLanes(() => scheduler.lanes.confirmCleanup(entry.lease));
      scheduler._completeEntry(entry, status);
      scheduler.releaseEligibility(entry.eligibilityAdmission);
      reclaimed.push(Object.freeze({ work_id: id, session_id: entry.work.session_id, status }));
    } catch (error) {
      scheduler._attention(id, error);
      retained.push(Object.freeze({ work_id: id,
        reason: String(error?.message || 'runtime_reclaim_failed') }));
    }
  }
  // A lease can also be quarantined with no active entry: a turn lease after an
  // uncertain canonical claim or an unconfirmed auxiliary (compaction) cleanup,
  // an inference lease of a retired attempt or an auxiliary request. The old
  // process's settlement handlers are gone, so nothing could ever confirm it,
  // and the local lane's single slot blocked every later send. A retained
  // entry keeps its turn lease and the inference leases it owns (the initial
  // reservation under its work id, gateway operations under its stream id).
  const retainedEntries = [...scheduler.active.values()];
  const held = { heldLeases: new Set(retainedEntries.map(entry => entry.lease)),
    heldOwners: new Set(retainedEntries.flatMap(entry => [entry.work.work_id, entry.attempt.stream_id])) };
  const leasesConfirmed = scheduler._mutateLanes(() => scheduler.lanes.confirmOrphaned(held));
  if (reclaimed.length || leasesConfirmed) scheduler.notifyLaneAvailability();
  return Object.freeze({ reclaimed: Object.freeze(reclaimed), retained: Object.freeze(retained),
    leases_confirmed: leasesConfirmed });
}

module.exports = { reclaimAbandonedWork, sameAttempt };
