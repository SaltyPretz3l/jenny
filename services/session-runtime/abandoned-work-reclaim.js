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
      if (!TERMINAL.has(status)) {
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
  if (reclaimed.length) scheduler.notifyLaneAvailability();
  return Object.freeze({ reclaimed: Object.freeze(reclaimed), retained: Object.freeze(retained) });
}

module.exports = { reclaimAbandonedWork };
