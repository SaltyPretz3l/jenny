'use strict';

const { normalizeString } = require('../renderer/shared/string-utils');
const { hasActiveAutomationRun } = require('./scheduler-automation-runtime');
const { parseIsoMs } = require('./scheduler-tasks-store');

// Pure snapshot derivation for the scheduler:get-state IPC bridge (Home
// dashboard scheduler widget). Kept out of SchedulerService so the run-loop
// file stays under the size ceiling and the derivation is unit-testable
// without a service harness.

// Tasks with sub-minute intervals are continuous runtime machinery, not
// user-meaningful scheduled work; they would render as perpetually "due" noise.
const MIN_UPCOMING_INTERVAL_SECONDS = 60;
const MAX_SNAPSHOT_ITEMS = 8;

function describeTaskLabel(task) {
  const name = normalizeString(task?.task) || normalizeString(task?.id);
  return name.replace(/^builtin:|^automation:/, '').replace(/[_-]+/g, ' ').trim() || 'Scheduled task';
}

function formatEta(dueMs, nowMs) {
  const deltaMs = dueMs - nowMs;
  if (deltaMs <= 0) {
    return 'due';
  }
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) {
    return 'in <1m';
  }
  if (minutes < 60) {
    return `in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  return `in ${Math.round(hours / 24)}d`;
}

function lastRunMs(task) {
  return Math.max(
    parseIsoMs(task?.last_result_at),
    parseIsoMs(task?.last_started_at),
    parseIsoMs(task?.last_completed_at)
  );
}

function isTaskRunning(task) {
  return hasActiveAutomationRun(task);
}

function buildSchedulerSnapshot(tasks, now = new Date()) {
  const nowMs = now.getTime();
  const running = [];
  const upcoming = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || task.enabled === false) {
      continue;
    }
    const id = normalizeString(task.id);
    if (!id) {
      continue;
    }
    if (isTaskRunning(task)) {
      running.push({
        id,
        label: describeTaskLabel(task),
        startedAt: normalizeString(task.last_started_at),
      });
      continue;
    }
    const intervalSeconds = Number(task?.trigger?.interval_seconds || 0);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < MIN_UPCOMING_INTERVAL_SECONDS) {
      continue;
    }
    const previousMs = lastRunMs(task);
    const dueMs = previousMs > 0 ? previousMs + intervalSeconds * 1000 : nowMs;
    upcoming.push({
      id,
      label: describeTaskLabel(task),
      eta: formatEta(dueMs, nowMs),
      intervalSeconds: Math.trunc(intervalSeconds),
      dueMs,
    });
  }
  upcoming.sort((a, b) => a.dueMs - b.dueMs);
  for (const item of upcoming) {
    delete item.dueMs;
  }
  return {
    upcoming: upcoming.slice(0, MAX_SNAPSHOT_ITEMS),
    running: running.slice(0, MAX_SNAPSHOT_ITEMS),
    generatedAt: now.toISOString(),
  };
}

module.exports = {
  MIN_UPCOMING_INTERVAL_SECONDS,
  buildSchedulerSnapshot,
  describeTaskLabel,
  formatEta,
};
