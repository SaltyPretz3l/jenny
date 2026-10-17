'use strict';

const { normalizeProposalResultMetadata } = require('../../backend/proposal-result-metadata');
const {
  checkLiveCall, producerToolSupported, proposalFailure, resolveSessionProposalDeps, text,
} = require('./propose-tool-support');

const NAME = 'complete_session_handoff';
const PROPOSAL_ID = /^proposal_[0-9a-f]{64}$/;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ADMISSION_STATES = new Set(['queued', 'admitted', 'needs_attention']);
const SUCCESS_CONTENT = 'The new chat is created and its first message is on its way. '
  + 'Stop here; Jenny shows the user what happened.';

// Only the handoff-only preparation turn offers this tool. The task and background text are the
// model's own words for the new chat: they go to the service, never into the result or a log.
function validateArgs(input) {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = new Set(['schema_version', 'proposal_id', 'attempt_id', 'task', 'background']);
  if (Object.keys(args).some((key) => !allowed.has(key))) return 'unknown_field';
  // Optional in the manifest (as for propose_session): an absent version means 1.
  if (args.schema_version !== undefined && args.schema_version !== 1) return 'field_schema_version';
  if (typeof args.proposal_id !== 'string' || !PROPOSAL_ID.test(args.proposal_id)) return 'field_proposal_id';
  if (typeof args.attempt_id !== 'string' || !ATTEMPT_ID.test(args.attempt_id)) return 'field_attempt_id';
  if (typeof args.task !== 'string' || !args.task.trim()) return 'field_task';
  if (args.background !== undefined && typeof args.background !== 'string') return 'field_background';
  return null;
}

function successMetadata(done) {
  const admission = ADMISSION_STATES.has(done.admission_state) ? done.admission_state : null;
  if (!admission) return null;
  return normalizeProposalResultMetadata({
    schema_version: 1,
    result_kind: 'session_handoff',
    proposal_id: done.proposal_id,
    revision: done.revision,
    child_session_id: done.child_session_id,
    first_turn_work_id: done.first_turn_work_id,
    first_turn_turn_id: done.first_turn_turn_id,
    admission_state: admission,
    turn_boundary: 'session_handoff_completed',
  });
}

module.exports = {
  name: NAME,
  description: 'Finish preparing a separate chat by handing over its task and background.',
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  workspaceRequired: false,
  parameters: {},

  // The task and background are deliberately not echoed into the tool row.
  summarize() {
    return 'Hand off to a new chat';
  },

  async execute(input, context = {}) {
    const deps = resolveSessionProposalDeps(context);
    if (!deps) return proposalFailure(NAME, 'unavailable');
    if (!producerToolSupported(deps, context, NAME)) return proposalFailure(NAME, 'unsupported_capability');
    const invalid = validateArgs(input);
    if (invalid) return proposalFailure(NAME, 'invalid_request', { cause: invalid });
    const live = checkLiveCall(context);
    if (!live.ok) return proposalFailure(NAME, 'authority_changed');
    // The capability is request-bound: only the preparation turn of exactly this attempt may finish it.
    const preparation = live.trusted.handoffPreparation;
    if (!preparation || preparation.proposalId !== input.proposal_id || preparation.attemptId !== input.attempt_id) {
      return proposalFailure(NAME, 'authorization_required');
    }
    const handoff = context.backendService?.chatProposals;
    if (!handoff || typeof handoff.completeHandoff !== 'function') return proposalFailure(NAME, 'unavailable');
    let done;
    try {
      done = await handoff.completeHandoff({
        sessionId: live.sessionId,
        sessionIncarnation: live.incarnation,
        turnId: live.turnId,
        toolCallId: text(context.callId),
        proposalId: input.proposal_id,
        attemptId: input.attempt_id,
        task: input.task,
        background: typeof input.background === 'string' ? input.background : '',
      });
    } catch (_error) {
      return proposalFailure(NAME, 'unavailable');
    }
    if (!done || done.ok !== true) return proposalFailure(NAME, done?.reason || 'unavailable', { cause: done?.cause_code });
    const metadata = successMetadata(done);
    if (!metadata) return proposalFailure(NAME, 'unavailable');
    return { content: SUCCESS_CONTENT, summary: 'Handed off to a new chat', isError: false, metadata };
  },
};
