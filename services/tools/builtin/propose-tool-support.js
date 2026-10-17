'use strict';

const { PROPOSAL_ERROR_CODES: SHARED_PROPOSAL_ERROR_CODES } = require('../../backend/error-codes');

// Shared plumbing for the two proposal producer tools (`propose_git_action`,
// `propose_command`; row 59 checkpoint 3). They only write the app's own
// proposal record: validation, binding capture and persistence live in the
// proposal modules, this file owns the live-call check (contract C6), the
// error mapping and the metadata-only result. Nothing here ever echoes the
// command text, the summary or the paths back to the model or into a log.
const { getTrustedExecutionBinding } = require('../../backend/session-execution-authority');
const { normalizeProposalResultMetadata } = require('../../backend/proposal-result-metadata');

const PROPOSAL_ERROR_CODES = Object.freeze(Object.fromEntries(
  Object.entries(SHARED_PROPOSAL_ERROR_CODES).map(([key, code]) => [key.toLowerCase(), code]),
));
const CAUSE_PATTERN = /^[a-z0-9_]{1,64}$/;

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function proposalFailure(toolName, reason, { cause = null } = {}) {
  const known = Object.hasOwn(PROPOSAL_ERROR_CODES, reason) ? reason : 'unavailable';
  const safeCause = typeof cause === 'string' && CAUSE_PATTERN.test(cause) ? cause : null;
  const detail = {
    invalid_request: `The arguments were invalid${safeCause ? ` (${safeCause})` : ''}. Correct them and call ${toolName} again.`,
    capacity: 'Too many proposals are already waiting for the user. Continue your answer without proposing again.',
    authority_changed: 'The session or workspace changed while the call was running. Continue your answer without a proposal.',
    idempotency_conflict: 'A different proposal was already recorded for this call.',
    unsupported_capability: 'This proposal is not supported here. Continue your answer without one.',
    authorization_required: 'The user has not authorized this. Continue your answer without it.',
    preparation_failed: 'The handoff could not be completed. Stop here; the user sees what happened.',
  }[known] || `Proposal cards are unavailable right now${safeCause ? ` (${safeCause})` : ''}. Continue your answer without one.`;
  return {
    content: `${toolName} did not record a proposal. ${detail}`,
    summary: `${toolName} not recorded`,
    isError: true,
    errorCode: PROPOSAL_ERROR_CODES[known],
    metadata: {},
  };
}

// The producer may only publish for the call that is live right now: the
// execution binding is current, it names this session/stream, and the session's
// active turn claim is exactly this stream, logical turn and incarnation.
function checkLiveCall(context) {
  const sessionId = text(context.sessionId);
  const streamId = text(context.streamId);
  const turnId = text(context.logicalTurnId);
  const incarnation = text(context.sessionIncarnation);
  if (!sessionId || !streamId || !turnId || !incarnation) return { ok: false };
  const trusted = getTrustedExecutionBinding(context.executionAuthority);
  if (!trusted) return { ok: false };
  try {
    trusted.assertCurrent();
  } catch (_error) {
    return { ok: false };
  }
  if (text(trusted.sessionId) !== sessionId || text(trusted.requestId) !== streamId) return { ok: false };
  let active;
  try {
    active = context.backendService?.sessionStore?.getActiveTurn?.(sessionId) || null;
  } catch (_error) {
    return { ok: false };
  }
  if (!active || text(active.stream_id) !== streamId || text(active.turn_id) !== turnId
    || text(active.session_incarnation) !== incarnation) return { ok: false };
  return { ok: true, trusted, sessionId, streamId, turnId, incarnation };
}

// Tests inject `context.proposalDeps`; production resolves the real modules
// lazily so a missing optional owner degrades to an unavailable result.
function resolveProposalDeps(context) {
  const injected = context.proposalDeps;
  if (injected && typeof injected === 'object') return injected;
  try {
    return {
      records: require('../../backend/chat-proposal-records'),
      binding: require('../../chat-proposal-binding'),
    };
  } catch (_error) {
    return null;
  }
}

// Session producers (`propose_session`, `complete_session_handoff`; row 59 checkpoint 5a). Tests
// inject `context.proposalDeps` with `records.normalizeSessionProposalInput`,
// `binding.captureSessionBinding` and `supportsProducerTool(name)`; production resolves the real
// modules lazily. A producer the sidecar did not negotiate is unsupported (fail closed).
function resolveSessionProposalDeps(context) {
  const injected = context.proposalDeps;
  if (injected && typeof injected === 'object') return injected;
  try {
    return {
      records: require('../../backend/chat-proposal-session-records'),
      binding: require('../../chat-proposal-session-binding'),
    };
  } catch (_error) {
    return null;
  }
}

function producerToolSupported(deps, context, toolName) {
  try {
    if (typeof deps?.supportsProducerTool === 'function') return deps.supportsProducerTool(toolName) === true;
    const { supportsProducerTool } = require('../../session-runtime/inference-protocol');
    return typeof supportsProducerTool === 'function'
      && supportsProducerTool(context.backendService?.sidecarClient, toolName) === true;
  } catch (_error) {
    return false;
  }
}

async function publishProposal(toolName, { kind, resultKind, content, summary }, input, binding, live, context) {
  const publisher = context.backendService?.chatProposals;
  if (!publisher || typeof publisher.publish !== 'function') return proposalFailure(toolName, 'unavailable');
  let published;
  try {
    published = await publisher.publish({
      kind,
      sessionId: live.sessionId,
      sessionIncarnation: live.incarnation,
      turnId: live.turnId,
      toolCallId: text(context.callId),
      input,
      binding,
    });
  } catch (_error) {
    return proposalFailure(toolName, 'unavailable');
  }
  if (!published || published.ok !== true) {
    return proposalFailure(toolName, published?.reason || 'unavailable');
  }
  const proposal = published.proposal || {};
  const metadata = normalizeProposalResultMetadata({
    schema_version: 1,
    result_kind: resultKind,
    proposal_id: proposal.proposal_id,
    revision: proposal.revision,
    decision_state: proposal.decision_state,
    action_state: proposal.action_state,
  });
  if (!metadata) return proposalFailure(toolName, 'unavailable');
  return { content, summary, isError: false, metadata };
}

module.exports = {
  PROPOSAL_ERROR_CODES,
  checkLiveCall,
  proposalFailure,
  publishProposal,
  producerToolSupported,
  resolveProposalDeps,
  resolveSessionProposalDeps,
  text,
};
