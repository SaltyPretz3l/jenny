'use strict';

// The team host's background sweeps on one timer: deleted project folders (slice 3-4b) and deleted boards (row 151
// T1). Each task runs once at the start and then on every tick, and is never awaited by the caller. A task that is
// still running is not started again; one that hangs or fails does not hold the others. The caller clears the
// returned timer at stop; a sweep already running then ends on its own (its removals are bounded).

/**
 * tasks: [[failedEvent, run]]: `run()` may be async; a throw or a rejection is reported as `warn(failedEvent)`.
 * intervalMs: the tick. warn(event): must not throw.
 */
function startSweeps({ tasks, intervalMs, warn }) {
  const running = new Set();
  const tick = () => {
    for (const task of tasks) {
      if (running.has(task)) continue;
      running.add(task);
      Promise.resolve().then(task[1]).catch(() => warn(task[0])).finally(() => running.delete(task));
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { startSweeps };
