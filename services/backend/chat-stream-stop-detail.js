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

// Turn-boundary completion (cp5a): a turn that ends because the model offered a linked chat
// (awaiting_proposal) or finished a handoff (session_handoff_completed). Both fields or neither.
// An array, not a Set: the cross-layer parity test reads the resumable-stop Set above by constructor.
const COMPLETION_REASONS = Object.freeze(['awaiting_proposal', 'session_handoff_completed']);
const PROPOSAL_ID_PATTERN = /^proposal_[0-9a-f]{64}$/;

function normalizeCompletion(params) {
  const reason = typeof params?.completion_reason === 'string' ? params.completion_reason.trim() : '';
  const proposalId = typeof params?.proposal_id === 'string' ? params.proposal_id.trim() : '';
  return COMPLETION_REASONS.includes(reason) && PROPOSAL_ID_PATTERN.test(proposalId) ? { reason, proposalId } : null;
}

module.exports = {
  COMPLETION_REASONS,
  normalizeCompletion,
  normalizeResumableStop,
};
