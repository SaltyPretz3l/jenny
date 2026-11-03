'use strict';

// Row 86 D1: is the person at the desk? Electron main has no "last seen by the
// user" fact (the Home widget's cursors are renderer-local), so this tracker
// keeps one: "present" means the main window is focused and visible AND the
// system has been idle for less than the threshold. Pure over injected ports:
// no Electron import, no timers of its own (the caller ticks it on the
// unattended guard's cadence and forwards focus/blur and powerMonitor events).
//
// Writes are edge-only: `lastPresentAt` is persisted on the present -> away
// edge (stamped with the last instant the person was SEEN present, not the
// instant the absence was detected) and at quit while present, never per tick.
// The away -> present edge (including the first present tick after startup,
// measured against the persisted value) calls `onReturn` once when the absence
// lasted at least `awayThresholdMs`. Every port is wrapped: a throwing read
// counts as "not present", a throwing write or callback is logged, and nothing
// throws out of the tracker.

const DEFAULT_IDLE_THRESHOLD_SECONDS = 300;
const DEFAULT_AWAY_THRESHOLD_MS = 4 * 60 * 60 * 1000;

function toMillis(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

function createPresenceTracker({
  isWindowPresent,
  getSystemIdleSeconds,
  readLastPresentAt,
  writeLastPresentAt,
  onReturn,
  now = Date.now,
  idleThresholdSeconds = DEFAULT_IDLE_THRESHOLD_SECONDS,
  awayThresholdMs = DEFAULT_AWAY_THRESHOLD_MS,
  log = () => {},
} = {}) {
  let present = null; // null until the first observation (startup)
  let lastPresentAtMs = null; // the persisted value as this process knows it
  let lastSeenPresentAtMs = null;
  const logged = new Set();

  function logOnce(port, error) {
    if (logged.has(port)) return;
    logged.add(port);
    try {
      log(`[presence] ${port} failed: ${error && error.message ? error.message : String(error)}`);
    } catch {
      // A broken logger must not break presence.
    }
  }

  function call(port, fn, fallback, ...args) {
    if (typeof fn !== 'function') return fallback;
    try {
      return fn(...args);
    } catch (error) {
      logOnce(port, error);
      return fallback;
    }
  }

  function clock() {
    return toMillis(call('now', now, null));
  }

  function observePresent() {
    if (call('isWindowPresent', isWindowPresent, false) !== true) return false;
    const idle = Number(call('getSystemIdleSeconds', getSystemIdleSeconds, Number.NaN));
    return Number.isFinite(idle) && idle >= 0 && idle < idleThresholdSeconds;
  }

  function persist(ms) {
    lastPresentAtMs = ms;
    call('writeLastPresentAt', writeLastPresentAt, undefined, iso(ms));
  }

  function becomePresent(nowMs) {
    const sinceMs = lastPresentAtMs !== null
      ? lastPresentAtMs
      : toMillis(call('readLastPresentAt', readLastPresentAt, null));
    present = true;
    lastSeenPresentAtMs = nowMs;
    // A missing or invalid persisted value, or a clock that went backwards, is
    // not a return: just present.
    if (sinceMs === null || nowMs < sinceMs) return;
    const awayMs = nowMs - sinceMs;
    if (awayMs < awayThresholdMs) return;
    call('onReturn', onReturn, undefined, { since: iso(sinceMs), returnedAt: iso(nowMs), awayMs });
  }

  function becomeAway() {
    // The first observation finding the person away writes nothing.
    if (present === true && lastSeenPresentAtMs !== null) persist(lastSeenPresentAtMs);
    present = false;
  }

  function observe(forcedAway) {
    const nowMs = clock();
    if (nowMs === null) return state();
    const isPresent = !forcedAway && observePresent();
    if (isPresent && present !== true) becomePresent(nowMs);
    else if (isPresent) lastSeenPresentAtMs = nowMs;
    else if (present !== false) becomeAway();
    return state();
  }

  function state() {
    return { present: present === true, lastPresentAt: iso(lastPresentAtMs), lastSeenPresentAt: iso(lastSeenPresentAtMs) };
  }

  return {
    tick: () => observe(false),
    noteFocus: () => observe(false),
    noteBlur: () => observe(true),
    noteResume: () => observe(false),
    noteSuspend: () => observe(true),
    // Quitting while present: the person was here until now.
    noteQuit() {
      if (present === true) {
        const nowMs = clock();
        persist(nowMs === null ? lastSeenPresentAtMs : nowMs);
      }
      present = false;
      return state();
    },
    state,
  };
}

module.exports = {
  DEFAULT_AWAY_THRESHOLD_MS,
  DEFAULT_IDLE_THRESHOLD_SECONDS,
  createPresenceTracker,
};
