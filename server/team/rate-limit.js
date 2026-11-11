'use strict';

// A fixed-window attempt counter for the team host's rate limits (redeem
// attempts per invite key, admin commands per member). Bounded: it holds at
// most `maxKeys` keys, drops expired windows before it refuses a new key, and
// refuses rather than evicts when still full, so a flood of new keys cannot
// reset someone else's count. No timers.

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}

function createRateLimiter({ limit, windowMs, maxKeys, clock = Date.now } = {}) {
  requirePositiveInteger(limit, 'limit');
  requirePositiveInteger(windowMs, 'windowMs');
  requirePositiveInteger(maxKeys, 'maxKeys');
  const windows = new Map();

  function dropExpired(now) {
    for (const [key, entry] of windows) {
      if (now - entry.startedAt >= windowMs) windows.delete(key);
    }
  }

  // True and counted, or false when this key has used its attempts for the
  // current window (or the table is full of live keys).
  function take(key) {
    if (typeof key !== 'string' || key === '') return false;
    const now = clock();
    let entry = windows.get(key);
    if (entry && now - entry.startedAt >= windowMs) {
      windows.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (windows.size >= maxKeys) dropExpired(now);
      if (windows.size >= maxKeys) return false;
      entry = { startedAt: now, count: 0 };
      windows.set(key, entry);
    }
    if (entry.count >= limit) return false;
    entry.count += 1;
    return true;
  }

  return { take, size: () => windows.size };
}

module.exports = { createRateLimiter };
