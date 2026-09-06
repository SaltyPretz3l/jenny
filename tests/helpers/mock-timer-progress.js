'use strict';

// Drives a test's own `setInterval`-based progress emitter against node's mock
// timers, for suites asserting a RELATIONSHIP between two timers rather than any
// single duration -- e.g. "each progress gap stays under the inactivity watchdog
// while total elapsed time exceeds it".
//
// Under real timers such a test carries only the ratio of the two constants as
// its margin (12ms gaps against a 30ms watchdog is 2.5x), so a single event-loop
// stall longer than the watchdog aborts the flight and the test fails for a
// reason unrelated to the property. Mock timers make the relationship exact
// while leaving the constants that document it untouched: each tick advances the
// fake clock by one interval period, and the production timer under test re-arms
// against that same clock.
//
// Microtasks are flushed on both sides of every tick because progress callbacks
// typically reach production through an awaited promise, so a tick with no
// intervening flush would advance the clock past work that has not run yet.

const MICROTASK_FLUSH_ROUNDS = 20;

async function flushMicrotasks(rounds = MICROTASK_FLUSH_ROUNDS) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Advance `ticks` interval periods, flushing microtasks around each one.
 * `ticks` should comfortably exceed the number of progress callbacks the test
 * needs; extra ticks are harmless once the interval has been cleared.
 */
async function driveProgressTicks(t, intervalMs, ticks = 8) {
  for (let i = 0; i < ticks; i += 1) {
    await flushMicrotasks();
    t.mock.timers.tick(intervalMs);
  }
  await flushMicrotasks();
}

module.exports = { driveProgressTicks, flushMicrotasks };
