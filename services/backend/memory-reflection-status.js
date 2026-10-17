'use strict';

// The `memory_reflection` Diagnostics facet (agentic memory v2, row 58 W2):
// scheduler state and per-process counters. Every field is a whitelisted
// scalar or reason token, so no memory text can reach Diagnostics.

const STATES = new Set(['idle', 'waiting_idle', 'running', 'backing_off']);
const OUTCOME = /^(?:applied|preempted|failed|skipped|refused:[a-z_]{1,64})$/u;
const REASON = /^[a-z_]{1,64}$/u;
const COUNTERS = ['runs', 'preempted', 'saved', 'queued', 'skipped', 'failed', 'backoffs'];

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function emptyFacet(available) {
  return { available, enabled: false, state: 'idle', last_run_at: null, last_outcome: null,
    ...Object.fromEntries(COUNTERS.map(key => [key, 0])), refused: {} };
}

function buildMemoryReflectionFacet(service) {
  const scheduler = service?.memoryReflectionScheduler;
  if (typeof scheduler?.snapshot !== 'function') return emptyFacet(false);
  try {
    const snapshot = scheduler.snapshot() || {};
    const facet = emptyFacet(true);
    facet.enabled = snapshot.enabled === true;
    if (STATES.has(snapshot.state)) facet.state = snapshot.state;
    if (typeof snapshot.last_run_at === 'string' && !Number.isNaN(Date.parse(snapshot.last_run_at))) {
      facet.last_run_at = new Date(snapshot.last_run_at).toISOString();
    }
    if (typeof snapshot.last_outcome === 'string' && OUTCOME.test(snapshot.last_outcome)) {
      facet.last_outcome = snapshot.last_outcome;
    }
    for (const key of COUNTERS) facet[key] = count(snapshot[key]);
    for (const [reason, value] of Object.entries(snapshot.refused || {})) {
      if (REASON.test(reason) && count(value)) facet.refused[reason] = count(value);
    }
    return facet;
  } catch (_error) {
    return emptyFacet(false);
  }
}

module.exports = { buildMemoryReflectionFacet };
