'use strict';

// Shared by the team chat and presence tests (row 123 slice 2a-3b): one fake
// timer facility (no wall time) and one event-loop turn.

const turn = () => new Promise((resolve) => { setImmediate(resolve); });

// Timeouts and intervals that run only when a test says so. Each handle keeps
// its delay (`ms`), its due time on the fake clock (`at`) and whether it was
// unref'd. An interval is recorded like a timeout and runs once per fire.
function fakeTimers() {
  let now = 0;
  let next = 0;
  const pending = new Map();
  const timers = {
    pending,
    now: () => now,
    setTimeout(fn, ms) {
      next += 1;
      const handle = { id: next, at: now + ms, ms, fn, unrefed: false, unref() { this.unrefed = true; } };
      pending.set(handle.id, handle);
      return handle;
    },
    clearTimeout(handle) { if (handle) pending.delete(handle.id); },
    setInterval(fn, ms) { return timers.setTimeout(fn, ms); },
    clearInterval(handle) { timers.clearTimeout(handle); },
    // Moves the fake clock and runs every timeout now due, earliest first.
    advance(ms) {
      now += ms;
      for (const handle of [...pending.values()].sort((a, b) => a.at - b.at)) {
        if (handle.at > now) continue;
        pending.delete(handle.id);
        handle.fn();
      }
    },
    // Runs the oldest pending timeout, lets its async work finish, and answers its delay.
    async fire() {
      const [first] = pending.values();
      pending.delete(first.id);
      first.fn();
      for (let i = 0; i < 5; i += 1) await turn();
      return first.ms;
    },
  };
  return timers;
}

module.exports = { fakeTimers, turn };
