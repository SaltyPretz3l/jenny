'use strict';

/**
 * Deterministic virtual clock for tests.
 *
 * Returns a drop-in seam for the four timer globals plus a `now()` (a
 * `Date.now`/`performance.now` replacement) and a `tick(ms)` pump that advances
 * virtual time and fires every task whose due time is reached, in due-time
 * order, honoring repeating intervals. No wall-clock time passes, so a test that
 * injects these instead of the real globals is fully deterministic — no
 * `setTimeout(..., 5)` races, no `Date.now()`-delta flakes.
 *
 * Production code under test should accept these as optional injected
 * dependencies that default to the real globals, so `git diff` shows only
 * additive optional params and real runtime behavior is unchanged.
 *
 *   const timers = createFakeTimers();
 *   const store = new Thing({ now: timers.now, setTimeout: timers.setTimeout });
 *   store.scheduleSomething();
 *   timers.tick(1000);            // fire everything due within 1000 virtual ms
 *   assert.equal(timers.now(), 1000);
 *
 * Extracted from tests/renderer-thinking-indicator.test.js (its first consumer);
 * the P1-3 flake-elimination conversions share this single implementation.
 */
function createFakeTimers() {
  let currentTime = 0;
  let nextId = 1;
  const tasks = new Map();

  function schedule(callback, delayMs, intervalMs = 0) {
    const id = nextId;
    nextId += 1;
    tasks.set(id, {
      callback,
      dueAt: currentTime + Math.max(Number(delayMs) || 0, 0),
      intervalMs: Math.max(Number(intervalMs) || 0, 0),
    });
    return id;
  }

  function clear(id) {
    tasks.delete(id);
  }

  function tick(ms) {
    const targetTime = currentTime + Math.max(Number(ms) || 0, 0);
    while (true) {
      let nextTaskId = 0;
      let nextTask = null;
      for (const [id, task] of tasks.entries()) {
        if (task.dueAt <= targetTime && (!nextTask || task.dueAt < nextTask.dueAt)) {
          nextTaskId = id;
          nextTask = task;
        }
      }
      if (!nextTask) {
        break;
      }
      currentTime = nextTask.dueAt;
      if (nextTask.intervalMs > 0) {
        nextTask.dueAt += nextTask.intervalMs;
      } else {
        tasks.delete(nextTaskId);
      }
      nextTask.callback();
    }
    currentTime = targetTime;
  }

  return {
    now: () => currentTime,
    setTimeout: (callback, delayMs) => schedule(callback, delayMs),
    clearTimeout: clear,
    setInterval: (callback, delayMs) => schedule(callback, delayMs, delayMs),
    clearInterval: clear,
    tick,
    /** Number of still-pending (unfired, uncleared) tasks. */
    pending: () => tasks.size,
  };
}

module.exports = { createFakeTimers };
