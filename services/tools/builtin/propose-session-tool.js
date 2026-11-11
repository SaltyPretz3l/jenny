'use strict';

const { normalizeProposalResultMetadata } = require('../../backend/proposal-result-metadata');
const { isPrimarySession } = require('../../backend/primary-session');
const {
  checkLiveCall, producerToolSupported, proposalFailure, publishProposal, resolveSessionProposalDeps,
} = require('./propose-tool-support');
const { manifestSchema } = require('./tool-result');
const { inDirectoryScope } = require('./session-directory-tool-support');

// Loaded only for a fork: it pulls in the branching module.
const forkSource = () => require('../../backend/session-fork-source');

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
  project_not_allowed: 'Only the Jenny chat can choose a project; omit project_id.',
  unknown_project: 'No project with that id. Use a project.id from sessions_list, or omit project_id.',
  fork_not_allowed: 'Only the Jenny chat can fork a chat; omit fork_of_session_id.',
  fork_with_project: 'A fork stays in the project of the chat it copies; omit project_id when you set fork_of_session_id.',
  fork_disabled: 'Forking a chat is turned off; omit fork_of_session_id.',
  unknown_fork: 'No chat with that id that you can fork. Use a session_id from sessions_list, or omit fork_of_session_id.',
  fork_primary: 'The Jenny chat cannot be forked. Use another chat\'s session_id, or omit fork_of_session_id.',
  fork_empty: 'That chat has no messages to fork yet. Omit fork_of_session_id to start an empty chat.',
});

// A refusal for the primary's project_id (row 76) or fork_of_session_id (row 94 P2): the shared
// invalid_request result shape, with the reason's own sentence. Never echoes the id the model sent.
function placementRefusal(reason) {
  const failure = proposalFailure(NAME, 'invalid_request');
  return { ...failure, content: `${NAME} did not record a proposal. ${CONTENT[reason]}` };
}

// Row 129 C11: the reason a chat other than the Jenny chat is refused when its raw input carries a
// primary-only argument, whatever the argument's value (a malformed one must not read as "fix project_id").
// Null when the input carries none.
function primaryOnlyReason(input) {
  if (!input || typeof input !== 'object') return null;
  const sent = (key) => input[key] !== undefined && input[key] !== null;
  if (sent('fork_of_session_id')) return 'fork_not_allowed';
  return sent('project_id') ? 'project_not_allowed' : null;
}

// The refusal reason for the primary's fork_of_session_id (the caller is already known to be the
// primary), or null when the chat can be forked.
async function forkRefusalReason(value, context, live) {
  if (!forkSource().forkingEnabled(context.backendService?.featureFlags)) return 'fork_disabled';
  if (typeof value.project_id === 'string') return 'fork_with_project';
  const forkId = value.fork_of_session_id;
  if (forkId === live.sessionId) return 'fork_primary';
  if (!(await inDirectoryScope(context, forkId))) return 'unknown_fork';
  const source = forkSource().readForkSource(context.backendService?.sessionStore, forkId);
  return source.ok ? null : source.reason;
}

const MAX_LISTED_MODELS = 10;

// The short name people use for an installed tag (`ornith15:9b` for `ornith15:9b-q6-256k`): the one
// installed id that extends it. Two candidates resolve to nothing, so the model has to pick.
function uniqueInstalledExtension(model, ids) {
  const prefix = model.includes(':') ? `${model}-` : `${model}:`;
  const matches = ids.filter((id) => id.startsWith(prefix));
  return matches.length === 1 ? matches[0] : '';
}

// The preferred_model pre-fill must be an installed id: the card's picker only offers those, but a
// launch grant starts the chat without anyone seeing the card (2026-10-27: the alias `ornith15:9b`
// reached a child and its first turn failed). A short name with exactly one installed extension
// resolves to it (the owner's next run showed the refusal as a failed tool row before the model
// retried with the same id); anything else is refused with installed ids listed, closest first.
// The model is accepted unchanged when the catalog cannot be read.
async function resolveInstalledModel(model, context) {
  if (typeof model !== 'string') return { model };
  let listing;
  try { listing = await context.backendService?.listModels?.(); } catch { return { model }; }
  const ids = (Array.isArray(listing?.data) ? listing.data : [])
    .filter((entry) => entry && typeof entry.id === 'string' && entry.available !== false).map((entry) => entry.id);
  if (!ids.length || ids.includes(model)) return { model };
  const extension = uniqueInstalledExtension(model, ids);
  if (extension) return { model: extension, resolved: true };
  const closest = [...ids].sort((a, b) => Number(b.startsWith(model)) - Number(a.startsWith(model)));
  const failure = proposalFailure(NAME, 'invalid_request');
  return {
    refusal: {
      ...failure,
      content: `${NAME} did not record a proposal. preferred_model is not an installed model. `
        + `Installed: ${closest.slice(0, MAX_LISTED_MODELS).join(', ')}. Use one of these ids exactly, or omit preferred_model.`,
    },
  };
}

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
    content = !pendingOffer ? CONTENT.settled : authorizationRequired ? CONTENT.unauthorized : content;
  }
  return { content, metadata };
}

const PUBLISH = Object.freeze({ kind: 'session', summary: 'Offered a separate chat', project: resultFor });

// Records an offer or suggestion for the user; it never creates, opens or runs a chat itself.
module.exports = {
  name: NAME,
  ...manifestSchema(NAME),
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  workspaceRequired: false,

  // The title and description are deliberately not echoed into the tool row.
  summarize(input) {
    return input?.initiation === 'own_initiative' ? 'Suggest a separate chat' : 'Offer a separate chat';
  },

  async execute(input, context = {}) {
    const deps = resolveSessionProposalDeps(context);
    if (!deps?.records || !deps.binding) return proposalFailure(NAME, 'unavailable');
    if (!producerToolSupported(deps, context, NAME)) return proposalFailure(NAME, 'unsupported_capability');
    const primaryOnly = primaryOnlyReason(input);
    if (primaryOnly && !isPrimarySession(context.backendService?.sessionStore, context.sessionId)) return placementRefusal(primaryOnly);
    const validated = deps.records.normalizeSessionProposalInput(input);
    if (!validated?.ok) return proposalFailure(NAME, 'invalid_request', { cause: validated?.cause_code });
    const live = checkLiveCall(context);
    if (!live.ok) return proposalFailure(NAME, 'authority_changed');
    const installed = await resolveInstalledModel(validated.value.preferred_model, context);
    if (installed.refusal) return installed.refusal;
    const value = installed.resolved ? { ...validated.value, preferred_model: installed.model } : validated.value;
    const projectId = value.project_id;
    const forking = typeof value.fork_of_session_id === 'string';
    if (typeof projectId === 'string' || forking) {
      if (!isPrimarySession(context.backendService?.sessionStore, live.sessionId)) {
        return placementRefusal(forking ? 'fork_not_allowed' : 'project_not_allowed');
      }
      const forkReason = forking ? await forkRefusalReason(value, context, live) : null;
      if (forkReason) return placementRefusal(forkReason);
      if (!forking && !context.backendService?.projectService?.get?.(projectId)) return placementRefusal('unknown_project');
    }
    let captured;
    try {
      captured = await deps.binding.captureSessionBinding(context, live);
    } catch (_error) {
      return proposalFailure(NAME, 'unavailable');
    }
    if (!captured?.ok) return proposalFailure(NAME, captured?.reason, { cause: captured?.cause_code });
    if (!checkLiveCall(context).ok) return proposalFailure(NAME, 'authority_changed');
    const result = await publishProposal(NAME, PUBLISH, value, captured.binding, live, context);
    // Say which model the new chat will use, so the reply names the installed id.
    return installed.resolved && !result.isError
      ? { ...result, content: `${result.content} preferred_model is set to the installed ${installed.model}.` }
      : result;
  },
};
