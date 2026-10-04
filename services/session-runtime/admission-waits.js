'use strict';

const { validId } = require('./contracts');

// Lanes accept wider tokens than projections; an id the projection would
// refuse is dropped here so one odd lease can never blank a whole snapshot.
const projectable = id => (validId(id) ? id : null);

class AdmissionWaits {
  constructor({ now = Date.now, max = 1000 } = {}) {
    if (!Number.isSafeInteger(max) || max < 0) throw new TypeError('runtime_admission_wait_bound_invalid');
    this.now = now;
    this.max = max;
    this.entries = new Map();
  }

  note(workId, result) {
    if (result?.status !== 'waiting'
      || !['session_busy', 'downstream_capacity', 'lane_capacity', 'runtime_model_switch_busy'].includes(result.reason)) {
      this.clear(workId);
      return;
    }
    const blockers = Array.isArray(result?.blockers) ? result.blockers : [];
    const quarantined = blockers.length > 0
      && blockers.every(blocker => Number.isFinite(blocker?.quarantined_at));
    const reason = quarantined ? 'cleanup_unconfirmed'
      : result.reason === 'session_busy' ? 'session_busy' : 'model_busy';
    const previous = this.entries.get(workId);
    const live = blockers.find(blocker => blocker?.quarantined_at === null);
    const entry = Object.freeze({
      reason,
      since: quarantined ? Math.min(...blockers.map(blocker => blocker.quarantined_at))
        : previous?.reason === reason ? previous.since : this.now(),
      blocking_session_id: projectable(quarantined ? blockers[0].session_id : live?.session_id),
    });
    this.entries.set(workId, entry);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
  }

  clear(workId) { this.entries.delete(workId); }

  get(workId) { return this.entries.get(workId) || null; }
}

module.exports = { AdmissionWaits };
