'use strict';

// Helpers the member connection tests share: timers that count what the manager asks for, and the start lines the fake
// bridge children received.

// Timers the manager uses, counted so a test can see what is live and every delay asked for.
function countingTimers() {
  const live = new Set();
  const delays = [];
  return {
    live, delays,
    setTimeout(fn, ms) {
      delays.push(ms);
      const handle = setTimeout(() => { live.delete(handle); fn(); }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout(handle) { live.delete(handle); clearTimeout(handle); },
  };
}

/** The first line each fake bridge child from index `from` received: the `start` line. */
const startLines = (host, from) => host.memberSpawner.children.slice(from).map((child) => child.received[0]);

module.exports = { countingTimers, startLines };
