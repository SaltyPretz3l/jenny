'use strict';

const { normalizeProposalResultMetadata } = require('../../backend/proposal-result-metadata');
const {
  checkLiveCall, producerToolSupported, proposalFailure, resolveSessionProposalDeps, text,
} = require('./propose-tool-support');

const NAME = 'propose_session';
const INITIATIONS = new Set(['offer', 'own_initiative', 'user_asked']);

// Model-facing results (English, never an echo of the title or description).
const CONTENT = Object.freeze({
  offer: 'The user now sees your offer to continue here or start a new chat. '
    + 'Stop here and wait for their choice.',
  own_initiative: 'The suggestion is shown to the user. It starts nothing by itself. Continue your answer.',
  user_asked: 'The user\'s request for a separate chat is recorded. Jenny prepares it after this turn. '
    + 'Do not do that task here; tell the user briefly.',
  unauthorized: 'No launch authorization was found, so the user sees an offer instead. '
    + 'Stop here and wait for their choice.',
  settled: 'The user already responded to this offer. Continue your answer.',
});

function resultFor(proposal) {
  const display = proposal?.display || {};
  const initiation = display.initiation;
  if (!INITIATIONS.has(initiation)) return null;
  const authorizationRequired = display.authorization_required === true;
  const pendingOffer = initiation === 'offer' && proposal.decision_state === 'pending';
  const metadata = normalizeProposalResultMetadata({
    schema_version: 1,
    result_kind: 'session_proposal',
    proposal_id: proposal.proposal_id,
    revision: proposal.revision,
    decision_state: proposal.decision_state,
    action_state: proposal.action_state,
    effective_initiation: initiation,
    authorization_required: authorizationRequired,
    group_id: typeof proposal.group_id === 'string' ? proposal.group_id : null,
    ...(pendingOffer ? { turn_boundary: 'awaiting_proposal' } : {}),
  });
  if (!metadata) return null;
  let content = CONTENT[initiation];
  if (initiation === 'offer') {
    if (!pendingOffer) content = CONTENT.settled;
    else if (authorizationRequired) content = CONTENT.unauthorized;
  }
  return { content, metadata };
}

// Records an offer or suggestion for the user; it never creates, opens or runs a chat itself.
module.exports = {
  name: NAME,
  description: 'Offer or suggest that the user continue in a separate linked chat.',
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  workspaceRequired: false,
  parameters: {},

  // The title and description are deliberately not echoed into the tool row.
  summarize(input) {
    return input?.initiation === 'own_initiative' ? 'Suggest a separate chat' : 'Offer a separate chat';
  },

  async execute(input, context = {}) {
    const deps = resolveSessionProposalDeps(context);
    if (!deps?.records || !deps.binding) return proposalFailure(NAME, 'unavailable');
    if (!producerToolSupported(deps, context, NAME)) return proposalFailure(NAME, 'unsupported_capability');
    if (typeof deps.records.normalizeSessionProposalInput !== 'function'
      || typeof deps.binding.captureSessionBinding !== 'function') return proposalFailure(NAME, 'unavailable');
    const validated = deps.records.normalizeSessionProposalInput(input);
    if (!validated?.ok) return proposalFailure(NAME, 'invalid_request', { cause: validated?.cause_code });
    const live = checkLiveCall(context);
    if (!live.ok) return proposalFailure(NAME, 'authority_changed');
    let captured;
    try {
      captured = await deps.binding.captureSessionBinding(context, live);
    } catch (_error) {
      return proposalFailure(NAME, 'unavailable');
    }
    if (!captured?.ok) return proposalFailure(NAME, captured?.reason, { cause: captured?.cause_code });
    if (!checkLiveCall(context).ok) return proposalFailure(NAME, 'authority_changed');
    const publisher = context.backendService?.chatProposals;
    if (!publisher || typeof publisher.publish !== 'function') return proposalFailure(NAME, 'unavailable');
    let published;
    try {
      published = await publisher.publish({
        kind: 'session',
        sessionId: live.sessionId,
        sessionIncarnation: live.incarnation,
        turnId: live.turnId,
        toolCallId: text(context.callId),
        input: validated.value,
        binding: captured.binding,
      });
    } catch (_error) {
      return proposalFailure(NAME, 'unavailable');
    }
    if (!published || published.ok !== true) return proposalFailure(NAME, published?.reason || 'unavailable');
    const result = resultFor(published.proposal);
    if (!result) return proposalFailure(NAME, 'unavailable');
    return { content: result.content, summary: 'Offered a separate chat', isError: false, metadata: result.metadata };
  },
};
