// Backend-only, per-process diagnostic counter registry. Never a correctness
// gate; callers inject logging. lease_conflict and durability_degrade emit at WARN.

const counters = new Map();

const WARN_COUNTERS = new Set(['lease_conflict', 'durability_degrade']);

function recordLifecycleDiagnostic(emitLog, counterName, payload = {}) {
  const name = String(counterName || '').trim();
  if (!name) {
    return;
  }
  const nextCount = (counters.get(name) || 0) + 1;
  counters.set(name, nextCount);
  if (typeof emitLog !== 'function') {
    return;
  }
  try {
    const level = WARN_COUNTERS.has(name) ? 'WARN' : 'INFO';
    emitLog(level, `lifecycle.${name}`, {
      count: nextCount,
      ...(payload && typeof payload === 'object' ? payload : {}),
    });
  } catch {
    // A logger throwing must never surface as a lifecycle-diagnostics defect.
  }
}

function getLifecycleDiagnosticCounts() {
  return Object.fromEntries(counters.entries());
}

// Test-only reset -- counters are per-process/module-singleton state, so
// suites that assert exact counts must reset between cases.
function resetLifecycleDiagnosticCounts() {
  counters.clear();
}

module.exports = {
  recordLifecycleDiagnostic,
  getLifecycleDiagnosticCounts,
  resetLifecycleDiagnosticCounts,
};
