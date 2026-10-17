'use strict';

const {
  checkLiveCall, proposalFailure, publishProposal, resolveProposalDeps,
} = require('./propose-tool-support');

const NAME = 'propose_command';
const RESULT = Object.freeze({
  kind: 'command',
  resultKind: 'command_proposal',
  summary: 'Offered a command',
  content: 'The user can Copy or Run this command from the card under your answer. '
    + 'Do not run it yourself. Continue your answer.',
});

// Records a command for the user to Copy or Run; it never executes anything.
module.exports = {
  name: NAME,
  description: 'Offer the user a concrete shell command they can Copy or Run from a card.',
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  workspaceRequired: true,
  parameters: {},

  // The command text is deliberately not echoed into the tool row.
  summarize() {
    return 'Offer a command to run';
  },

  async execute(input, context = {}) {
    const deps = resolveProposalDeps(context);
    if (!deps) return proposalFailure(NAME, 'unavailable');
    // Pass 1 (no shell yet) yields the normalized cwd/command the binding captures.
    const first = deps.records.normalizeCommandProposalInput(input, { shell: null });
    if (!first?.ok) return proposalFailure(NAME, 'invalid_request', { cause: first?.cause_code });
    const live = checkLiveCall(context);
    if (!live.ok) return proposalFailure(NAME, 'authority_changed');
    let captured;
    try {
      captured = await deps.binding.captureCommandProposalBinding({
        backendService: context.backendService,
        sessionId: live.sessionId,
        trusted: live.trusted,
        cwd: first.value.cwd,
        command: first.value.command,
      });
    } catch (_error) {
      return proposalFailure(NAME, 'unavailable');
    }
    if (!captured?.ok) return proposalFailure(NAME, captured?.reason, { cause: captured?.cause_code });
    // Pass 2: the captured shell decides D4 (a multi-line command on cmd.exe) and
    // the backend caps the timeout (docker: timeout_sandbox_limit).
    const validated = deps.records.normalizeCommandProposalInput(input, {
      shell: captured.binding?.command?.shell || null,
      backend: captured.binding?.command?.backend || null,
    });
    if (!validated?.ok) return proposalFailure(NAME, 'invalid_request', { cause: validated?.cause_code });
    if (!checkLiveCall(context).ok) return proposalFailure(NAME, 'authority_changed');
    return publishProposal(NAME, RESULT, validated.value, captured.binding, live, context);
  },
};
