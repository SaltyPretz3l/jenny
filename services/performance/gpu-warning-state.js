'use strict';
const { randomUUID } = require('node:crypto');
const GiB = 1024 ** 3;
const known = value => Number.isSafeInteger(value) && value >= 0;
// A dismissal covers its condition and every weaker one in the same identity, so one noisy sample that
// downgrades a dismissed spill does not re-alert; only a worsening may resurface (once).
const RANK = Object.freeze({ low_headroom: 0, possible_contention: 1, possible_spill: 2 });

// `since` and `dismissed_until` are published to the renderer, so the default clock is wall time.
function createGpuWarningTracker({ now = Date.now, uuid = randomUUID } = {}) {
  let identityKey; let runtimeKey; let baseline = null; let healthySamples = [];
  let low = 0; let healthy = 0; let spill = 0; let contenders = new Map();
  let episode = null; let confirmed = null; let state = 'unknown'; let evidence = [];
  const dismissals = new Map();
  function resetCounters() { low = 0; healthy = 0; spill = 0; contenders.clear(); }
  function resetIdentity() { baseline = null; healthySamples = []; episode = null; confirmed = null; resetCounters(); }
  function unknown(reset = true) { if (reset) resetCounters(); state = 'unknown'; evidence = []; return snapshot(); }
  function dismissalKey(condition) { return JSON.stringify([identityKey, condition]); }
  function dismissedUntil(condition) {
    let until = null;
    if (!(condition in RANK)) return until;
    for (const [name, rank] of Object.entries(RANK)) {
      const dismissal = rank >= RANK[condition] ? dismissals.get(dismissalKey(name)) : null;
      if (dismissal?.until > now() && (until === null || dismissal.until > until)) until = dismissal.until;
    }
    return until;
  }
  function snapshot() {
    const until = dismissedUntil(confirmed);
    return { warning_id: episode?.id ?? null, state, since: episode?.since ?? null,
      evidence_codes: [...evidence], dismissed_until: episode && until !== null ? until : null,
      last_confirmed_state: confirmed };
  }
  function accept(sample, { runtimeIdentity, active = false } = {}) {
    const nextRuntime = JSON.stringify([runtimeIdentity?.pid ?? null, runtimeIdentity?.createdAt ?? null]);
    if (nextRuntime !== runtimeKey) { runtimeKey = nextRuntime; identityKey = null; resetIdentity(); }
    // Failed refreshes of the same launch cannot erase its episode.
    if (!sample || !['fresh', 'partial'].includes(sample.state)) return unknown();
    const luid = sample.adapter?.luid;
    if (!runtimeIdentity || runtimeIdentity.createdAt == null || !luid) return unknown();
    const nextKey = JSON.stringify([runtimeIdentity.pid, runtimeIdentity.createdAt, luid, sample.adapter.physical_index ?? null]);
    if (nextKey !== identityKey) {
      identityKey = nextKey; resetIdentity();
    }
    for (const [key, dismissal] of dismissals) if (dismissal.until <= now()) dismissals.delete(key);
    const free = sample.adapter.dedicated_free_bytes;
    if (!known(free)) return unknown();
    const shared = sample.managed_process?.shared_bytes;
    if (!sample.managed_process || !Array.isArray(sample.external_processes)) return unknown();
    const healthyEvidence = known(shared);
    if (free >= 1.5 * GiB && !healthyEvidence) return unknown();
    if (sample.state === 'fresh' && free >= 1.5 * GiB && known(shared) && baseline === null) {
      healthySamples.push(shared);
      if (healthySamples.length === 5) baseline = [...healthySamples].sort((a, b) => a - b)[2];
    }
    // Headroom is the adapter's free memory; partial process coverage only limits asserting absence.
    healthy = free >= 1.5 * GiB && healthyEvidence ? healthy + 1 : 0;
    if (healthy >= 5) {
      episode = null; confirmed = 'clear'; state = 'clear'; evidence = []; resetCounters(); return snapshot();
    }
    const isLow = active === true && free < GiB;
    low = isLow ? low + 1 : 0;
    // Inside a latched episode the stronger classifications keep counting between the thresholds.
    const pressured = isLow || episode !== null;
    spill = pressured && baseline !== null && known(shared) && shared >= baseline + .5 * GiB ? spill + 1 : 0;
    const nextContenders = new Map();
    if (pressured) for (const row of sample.external_processes || []) {
      if (!known(row.dedicated_bytes) || row.dedicated_bytes < .25 * GiB || row.created_at == null) continue;
      const key = JSON.stringify([row.pid, row.created_at]);
      // The collector scopes rows to this adapter; an explicit mismatched LUID is refused.
      if (row.luid != null && row.luid !== luid) continue;
      nextContenders.set(key, (contenders.get(key) || 0) + 1);
    }
    contenders = nextContenders;
    if (!episode && low >= 3) episode = { id: uuid(), since: now() };
    if (!episode) { state = 'clear'; confirmed = 'clear'; evidence = []; return snapshot(); }
    if ((baseline !== null && !known(shared)) || !Array.isArray(sample.external_processes)) return unknown();
    state = spill >= 3 ? 'possible_spill' : [...contenders.values()].some(n => n >= 3) ? 'possible_contention' : 'low_headroom';
    if (state === 'possible_spill' && confirmed !== state) {
      const lower = ['low_headroom', 'possible_contention'].map(condition => dismissals.get(dismissalKey(condition)))
        .filter(dismissal => dismissal?.until > now());
      if (lower.some(dismissal => dismissal.spillResurfaced) && !dismissals.has(dismissalKey(state))) {
        dismissals.set(dismissalKey(state), { until: Math.max(...lower.map(dismissal => dismissal.until)), spillResurfaced: true });
      }
      for (const dismissal of lower) dismissal.spillResurfaced = true;
    }
    confirmed = state;
    evidence = ['low_headroom_latched'];
    if (state === 'possible_spill') evidence.push('managed_shared_above_baseline');
    if (state === 'possible_contention') evidence.push('external_dedicated_allocation');
    return snapshot();
  }
  function dismiss(warningId) {
    if (!episode || warningId !== episode.id) return { ok: false, reason: 'stale_warning' };
    dismissals.set(dismissalKey(confirmed), { until: now() + 600000, spillResurfaced: false });
    // Bound process-local retention even with rapid identity changes.
    if (dismissals.size > 256) dismissals.delete(dismissals.keys().next().value);
    return { ok: true };
  }
  return { accept, snapshot, dismiss };
}
module.exports = { createGpuWarningTracker };
