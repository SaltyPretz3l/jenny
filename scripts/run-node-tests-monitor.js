'use strict';

const RUN_HEARTBEAT_INTERVAL_MS = 15_000;

function formatInFlightHeartbeat({ inFlightStartedAt, completed = 0, startedAt, now = Date.now() }) {
  const active = [...inFlightStartedAt.entries()]
    .map(([file, fileStartedAt]) => `${file} (${((now - fileStartedAt) / 1000).toFixed(1)}s)`)
    .join(', ');
  return `[run-node-tests-safe] HEARTBEAT elapsed=${((now - startedAt) / 1000).toFixed(1)}s ` +
    `completed=${completed} in-flight=${active || 'none'}`;
}

function createRunMonitor({
  startedAt = Date.now(),
  intervalMs = RUN_HEARTBEAT_INTERVAL_MS,
  enabled = true,
  log = console.log,
} = {}) {
  const inFlightStartedAt = new Map();
  let completed = 0;
  const heartbeat = enabled
    ? setInterval(() => log(formatInFlightHeartbeat({
      inFlightStartedAt,
      completed,
      startedAt,
    })), intervalMs)
    : null;
  heartbeat?.unref?.();

  return {
    fileStarted(file, timeoutMs, fileStartedAt = Date.now()) {
      inFlightStartedAt.set(file, fileStartedAt);
      if (enabled) log(`[run-node-tests-safe] START ${file} (timeout ${timeoutMs}ms)`);
    },
    fileFinished(file) {
      if (inFlightStartedAt.delete(file)) completed += 1;
    },
    dispose() {
      if (heartbeat) clearInterval(heartbeat);
      inFlightStartedAt.clear();
    },
  };
}

module.exports = {
  RUN_HEARTBEAT_INTERVAL_MS,
  createRunMonitor,
  formatInFlightHeartbeat,
};
