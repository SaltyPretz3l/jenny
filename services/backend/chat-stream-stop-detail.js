'use strict';

const RESUMABLE_STOPS = new Set([
  'tool_cap',
  'max_iterations',
  'diminishing_returns',
  'context_budget',
]);

function normalizeResumableStop(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return RESUMABLE_STOPS.has(normalized) ? normalized : null;
}

module.exports = {
  normalizeResumableStop,
};
