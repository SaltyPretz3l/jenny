'use strict';

const {
  checkLiveCall, proposalFailure, publishProposal, resolveProposalDeps,
} = require('./propose-tool-support');

const NAME = 'propose_git_action';
const RESULT = Object.freeze({
  kind: 'git',
  resultKind: 'git_proposal',
  summary: 'Offered Commit and Test first',
  content: 'The user now sees Commit, Test first and Dismiss choices under your answer. '
    + 'Do not commit or run tests yourself unless the user chooses one. Continue your answer.',
});

// Records a Git decision for the user; it never stages, commits or runs anything.
module.exports = {
  name: NAME,
  description: 'Offer the user a Commit or Test first choice for the changes you just finished.',
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  workspaceRequired: true,
  parameters: {},

  summarize(input) {
    const count = Array.isArray(input?.paths) ? input.paths.length : 0;
    return count ? `Offer to commit ${count} changed ${count === 1 ? 'file' : 'files'}` : 'Offer to commit changes';
  },

  async execute(input, context = {}) {
    const deps = resolveProposalDeps(context);
    if (!deps) return proposalFailure(NAME, 'unavailable');
    const validated = deps.records.normalizeGitProposalInput(input);
    if (!validated?.ok) return proposalFailure(NAME, 'invalid_request', { cause: validated?.cause_code });
    const live = checkLiveCall(context);
    if (!live.ok) return proposalFailure(NAME, 'authority_changed');
    let captured;
    try {
      captured = await deps.binding.captureGitProposalBinding({
        backendService: context.backendService,
        sessionId: live.sessionId,
        trusted: live.trusted,
        paths: validated.value.paths,
        signal: context.abortSignal || null,
      });
    } catch (_error) {
      return proposalFailure(NAME, 'unavailable');
    }
    if (!captured?.ok) return proposalFailure(NAME, captured?.reason, { cause: captured?.cause_code });
    // Capture awaits Git; the call must still be the live one when it publishes.
    if (!checkLiveCall(context).ok) return proposalFailure(NAME, 'authority_changed');
    return publishProposal(NAME, RESULT, validated.value, captured.binding, live, context);
  },
};
