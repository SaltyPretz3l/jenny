'use strict';

// The listSummaries order (newest updated_at first, then work_id), memoized per
// index summaries array. Index documents freeze their summaries and every index
// change installs a new array (_commit, _load, commit-failure reconciliation),
// so the array identity is the cache key; an unfrozen array is never cached.
// work_id is unique, so the order is total and sorting before or after a scope
// filter yields the same sequence.
const sortedBySummaries = new WeakMap();

function compareRecency(left, right) {
  return right.updated_at.localeCompare(left.updated_at) || left.work_id.localeCompare(right.work_id);
}

function summariesByRecency(summaries) {
  const cached = sortedBySummaries.get(summaries);
  if (cached) return cached;
  const sorted = Object.freeze([...summaries].sort(compareRecency));
  if (Object.isFrozen(summaries)) sortedBySummaries.set(summaries, sorted);
  return sorted;
}

module.exports = { summariesByRecency };
