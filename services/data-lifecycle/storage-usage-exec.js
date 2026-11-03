'use strict';

// Runs a previewed unit list for one category (row 95). Sequential, and every
// failure is recorded as a bounded reason code (never a path) so one locked
// file leaves the rest of the clear intact.

const { boundedReason, removeContained, truncateContained } = require('../fs-contained');
const { yieldToEventLoop } = require('../time-sliced-steps');
const { groupLabel, validateUnit } = require('./storage-usage-plans');
const { browserCacheRoots } = require('./storage-usage-registry');
const { createBudget, measureRoots } = require('./storage-usage-walk');

const YIELD_EVERY_UNITS = 20;

function createOutcome() {
  return { freedBytes: 0, freedFiles: 0, failures: new Map(), cleared: 0 };
}

function recordFailure(outcome, group, reason) {
  const key = `${group}|${reason}`;
  const entry = outcome.failures.get(key) || { group, reason, count: 0 };
  entry.count += 1;
  outcome.failures.set(key, entry);
}

// [{ label, reason, count }]: bounded and path-free.
function failureList(outcome) {
  return [...outcome.failures.values()].map((entry) => ({
    label: groupLabel(entry.group, entry.count),
    reason: entry.reason,
    count: entry.count,
  }));
}

async function measureBrowserCaches(userDataPath, budgetOptions) {
  return measureRoots(browserCacheRoots(userDataPath), { budget: createBudget(budgetOptions) });
}

async function runUnit(unit, deps, outcome) {
  if (unit.op === 'browser') {
    const before = await measureBrowserCaches(deps.userDataPath, deps.walkOptions);
    await deps.clearBrowserCaches();
    const after = await measureBrowserCaches(deps.userDataPath, deps.walkOptions);
    outcome.freedBytes += Math.max(0, before.bytes - after.bytes);
    outcome.freedFiles += Math.max(0, before.files - after.files);
    return;
  }
  if (!validateUnit(unit)) throw Object.assign(new Error('unsafe_target'), { reason: 'unsafe_target' });
  if (unit.op === 'truncate') {
    const result = await truncateContained(unit.base, unit.segments);
    if (result.removed) outcome.freedBytes += unit.bytes;
    return;
  }
  const result = await removeContained(unit.base, unit.segments);
  if (result.removed) {
    outcome.freedBytes += unit.bytes;
    outcome.freedFiles += unit.files;
  }
}

async function runFileUnits(units, deps) {
  const outcome = createOutcome();
  let sinceYield = 0;
  for (const unit of units) {
    try {
      await runUnit(unit, deps, outcome);
      outcome.cleared += 1;
    } catch (error) {
      recordFailure(outcome, unit.group, boundedReason(error, 'remove_failed'));
    }
    sinceYield += 1;
    if (sinceYield >= YIELD_EVERY_UNITS) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  return outcome;
}

// Deletes chats one at a time through the backend's own delete (the entry the
// sessions.delete IPC uses), bounded by count and wall time. The primary chat is
// skipped by the backend; a refusal for any other reason is a failure.
async function runChatUnits(units, deps) {
  const outcome = createOutcome();
  const started = deps.now();
  for (const [index, unit] of units.entries()) {
    if (index >= deps.maxChats) {
      recordFailure(outcome, 'chats', 'limit_reached');
      continue;
    }
    if (deps.now() - started > deps.maxMs) {
      recordFailure(outcome, 'chats', 'time_limit');
      continue;
    }
    try {
      const result = await deps.deleteChat(unit.segments[0]);
      if (result?.deleted === true) {
        outcome.cleared += 1;
        outcome.freedBytes += Number(result.freed?.bytes) || 0;
        outcome.freedFiles += Number(result.freed?.files) || 0;
        if (result.cleanup_status === 'degraded') recordFailure(outcome, 'chats', 'cleanup_degraded');
      } else if (result?.reason !== 'primary_protected') {
        recordFailure(outcome, 'chats', 'delete_refused');
      }
    } catch (error) {
      recordFailure(outcome, 'chats', boundedReason(error, 'delete_failed'));
    }
  }
  return outcome;
}

module.exports = { failureList, runChatUnits, runFileUnits };
