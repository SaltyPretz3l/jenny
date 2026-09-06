function createManualScheduler() {
  let nextId = 1;
  let now = 0;
  const timers = new Map();
  const frames = new Map();

  function nextHandle() {
    const id = nextId;
    nextId += 1;
    return id;
  }

  return {
    now() {
      return now;
    },
    setTimeout(callback, delayMs) {
      const id = nextHandle();
      timers.set(id, { callback, runAt: now + Math.max(0, Number(delayMs) || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestAnimationFrame(callback) {
      const id = nextHandle();
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    advanceBy(ms) {
      now += Math.max(0, Number(ms) || 0);
      const dueTimers = [...timers.entries()]
        .filter(([, entry]) => entry.runAt <= now)
        .sort((a, b) => a[1].runAt - b[1].runAt);
      for (const [id, entry] of dueTimers) {
        timers.delete(id);
        entry.callback();
      }
    },
    frameCount() {
      return frames.size;
    },
    drainFrame() {
      const frameEntries = [...frames.entries()];
      frames.clear();
      frameEntries.forEach(([, callback]) => callback(now));
    },
  };
}

module.exports = {
  createManualScheduler,
};
