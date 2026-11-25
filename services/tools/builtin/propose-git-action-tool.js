'use strict';

const {
  checkLiveCall, proposalFailure, publishProposal, resolveProposalDeps,
} = require('./propose-tool-support');
const { manifestSchema } = require('./tool-result');

const NAME = 'propose_git_action';
const RESULT = Object.freeze({
  kind: 'git',
  resultKind: 'git_proposal',
  summary: 'Offered Commit and Test first',
  content: 'The user now sees Commit, Test first and Dismiss choices under your answer. '
    + 'Do not commit or run tests yourself unless the user chooses one. Continue your answer.',
});

const APPROVED_PLAN_STATES = new Set(['approved', 'approved_auto', 'accepted']);
const VERIFICATION_CHARS = 400;

// What the plan approved in this turn said to check, or '' (no plan, not approved, nothing to
// check, or the lookup failed: a lookup never fails the tool).
function approvedVerification(context, live) {
  try {
    // The lookup-only view: no settle-on-read or normalisation of the whole transcript.
    const messages = context.backendService?.sessionStore?.peekSessionMessages?.(live.sessionId);
    if (!Array.isArray(messages)) return '';
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.kind !== 'plan_document' || String(message.turn_id || '') !== live.turnId) continue;
      const plan = message.plan_document;
      if (!APPROVED_PLAN_STATES.has(String(plan?.state || ''))) return '';
      const text = typeof plan.verification === 'string' ? plan.verification.replace(/\s+/gu, ' ').trim() : '';
      return text.length > VERIFICATION_CHARS ? `${text.slice(0, VERIFICATION_CHARS - 1)}\u2026` : text;
    }
  } catch (_error) {
    return '';
  }
  return '';
}

// Records a Git decision for the user; it never stages, commits or runs anything.
module.exports = {
  name: NAME,
  ...manifestSchema(NAME),
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  workspaceRequired: true,

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
    const result = await publishProposal(NAME, RESULT, validated.value, captured.binding, live, context);
    const verification = result.isError ? '' : approvedVerification(context, live);
    if (!verification) return result;
    return {
      ...result,
      content: `${result.content} The plan you were approved said to check: "${verification}". `
        + 'If any part of that did not run, tell the user in your answer.',
    };
  },
};
