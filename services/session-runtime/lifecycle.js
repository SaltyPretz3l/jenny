'use strict';

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
const MAX_DRAIN_TIMEOUT_MS = 120_000;

function normalizeReason(value, fallback = 'user') {
  if (value === undefined || value === null) return fallback;
  const reason = typeof value === 'string' ? value.trim() : '';
  if (!reason || value.length > 256) throw new TypeError('session_runtime_reason_invalid');
  return reason;
}

function normalizeTimeout(value, fallback = DEFAULT_DRAIN_TIMEOUT_MS) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DRAIN_TIMEOUT_MS) {
    throw new TypeError('session_runtime_drain_timeout_invalid');
  }
  return value;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForCleanup(check, { timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  waiters = () => [] } = {}) {
  const timeout = normalizeTimeout(timeoutMs);
  const deadline = Date.now() + timeout;
  // Waiters observed settled (resolved or rejected) never race again: an already
  // settled promise would win every race and starve the timers that drive cleanup.
  const settled = new WeakSet();
  while (true) {
    if (check() === true) return Object.freeze({ ok: true });
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Object.freeze({ ok: false, reason: 'runtime_cleanup_timeout', timedOut: true });
    }
    const pending = waiters().filter(value => value && typeof value.then === 'function'
      && !settled.has(value));
    // A rejecting waiter only ends this wait; the loop re-checks and keeps draining.
    // Each waiter is boxed so the race resolves to its identity instead of adopting its rejection.
    const winner = await Promise.race([delay(Math.min(remaining, 25)).then(() => null),
      ...pending.map(promise => Promise.resolve(promise).then(() => [promise], () => [promise]))]);
    if (winner) {
      settled.add(winner[0]);
      await delay(0); // Yield a macrotask so timers and I/O can advance cleanup.
    }
  }
}

module.exports = {
  DEFAULT_DRAIN_TIMEOUT_MS,
  normalizeReason,
  normalizeTimeout,
  waitForCleanup,
};
