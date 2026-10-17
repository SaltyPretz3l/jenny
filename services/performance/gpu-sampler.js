'use strict';

function createGpuSampler({ collector, tracker, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let demand = {}; let cadence = null; let timer; let flight = null; let disposed = false; let epoch = 0;
  const samples = []; let refreshedAt = null; let stale = false;
  let current = { schema_version: 1, sequence: 0, sampled_at: null, cadence_ms: null, state: 'unavailable',
    reason: 'not_sampled', adapter: null, managed_process: null, external_processes: [], other_process_count: 0, truncated: false };
  const identityKey = identity => JSON.stringify([identity?.pid ?? null, identity?.createdAt ?? null]);
  function warning(sample) { tracker.accept(sample, { runtimeIdentity: demand.identity, active: demand.active === true }); }
  function schedule(delay = cadence) {
    clearTimer(timer); timer = null;
    if (!disposed && cadence !== null) {
      timer = setTimer(() => { timer = null; refresh(); }, delay); timer?.unref?.();
    }
  }
  async function refresh() {
    if (disposed || cadence === null || flight) return;
    const version = epoch; const identity = demand.identity; const startedAt = now();
    flight = Promise.resolve().then(() => collector.sample(identity));
    try {
      let sample;
      try { sample = await flight; } catch (_error) { sample = { state: 'unavailable', reason: 'collection_unavailable' }; }
      if (disposed || version !== epoch) return;
      if (sample && ['fresh', 'partial'].includes(sample.state)) {
        refreshedAt = now(); stale = false; current = { ...sample, cadence_ms: cadence };
      } else {
        stale = true; current = { ...current, state: 'stale', reason: sample?.reason || 'collection_unavailable' };
      }
      samples.push(structuredClone(current));
      if (samples.length > 60) samples.shift();
      warning(current);
    } finally {
      flight = null;
      // Demand that ended mid-sample could not release the busy helper; release it now.
      if (cadence === null) collector.release?.();
      schedule(version === epoch ? Math.max(0, cadence - (now() - startedAt)) : 0);
    }
  }
  function setDemand(next = {}) {
    if (disposed) return;
    const identityChanged = identityKey(next.identity) !== identityKey(demand.identity);
    const previous = cadence;
    demand = { ...next, identity: next.identity ? { ...next.identity } : null };
    const enabled = next.counter === true || next.warnings === true || Number(next.subscribers) > 0;
    // Without a managed runtime identity there is nothing to attribute, so nothing is sampled.
    cadence = enabled && next.identity ? (next.active === true ? 2000 : 15000) : null;
    if (identityChanged) {
      epoch++; samples.length = 0; refreshedAt = null; stale = true;
      current = { ...current, state: 'stale', reason: 'runtime_changed', adapter: null, managed_process: null, external_processes: [] };
      warning(current);
    }
    if (cadence === null) { clearTimer(timer); timer = null; collector.release?.(); }
    else if (!flight && (previous === null || identityChanged)) { clearTimer(timer); timer = null; refresh(); }
    else if (previous !== cadence) schedule();
  }
  function latest() {
    if (!stale && refreshedAt !== null && now() - refreshedAt >= Math.max(3 * (cadence || current.cadence_ms || 15000), 6000)) {
      stale = true; current = { ...current, state: 'stale', reason: 'sample_expired' }; warning(current);
    }
    return structuredClone({ ...current, cadence_ms: cadence, warning: tracker.snapshot() });
  }
  function dispose() {
    if (disposed) return;
    disposed = true; epoch++; clearTimer(timer); samples.length = 0; collector.dispose();
  }
  return { setDemand, latest, dispose };
}
module.exports = { createGpuSampler };
