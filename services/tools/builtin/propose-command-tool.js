'use strict';

const {
  checkLiveCall, proposalFailure, publishProposal, resolveProposalDeps,
} = require('./propose-tool-support');
const { manifestSchema } = require('./tool-result');
const { PROPOSAL_LIMITS } = require('../../backend/chat-proposal-records');
const { sandboxReady, sandboxMode } = require('../../execution/command-bridge');

const NAME = 'propose_command';
const COPY_OR_RUN = 'The user can Copy or Run this command from the card under your answer. ';
const TAIL = 'Do not run it yourself. Continue your answer.';
const RESULT = Object.freeze({
  kind: 'command',
  resultKind: 'command_proposal',
  summary: 'Offered a command',
  content: COPY_OR_RUN + TAIL,
});
// With the command sandbox on, Run never touches this computer: say so, so the answer
// does not promise a host run, and say when Run cannot work at all (Copy still does).
const SANDBOX_RUN = 'Run executes it in an offline Linux copy of the workspace with /bin/sh (POSIX syntax, '
  + 'no network, only Node.js and Python 3 installed, none of the tools on this computer); Copy is for the user\'s own terminal. ';
// Row 106: in Synced workspace mode Run's changes come back to the folder.
const SYNCED_RUN = 'Run executes it offline in a Linux copy of the workspace with /bin/sh (POSIX syntax, no network, '
  + 'only Node.js and Python 3 installed, none of the tools on this computer); files it adds, changes or deletes are copied back afterwards and can be '
  + 'undone, except .git, hook folders, dependency folders and links. Copy is for the user\'s own terminal. ';
const SANDBOX_NOT_READY = 'The command sandbox is not ready, so Run is unavailable on the card: tell the user '
  + 'to Copy the command into their own terminal. ';

function resultSpec(backend, context) {
  if (backend !== 'docker') return RESULT;
  const synced = sandboxMode(context.backendService) === 'synced';
  const lead = sandboxReady(context.backendService) ? COPY_OR_RUN + (synced ? SYNCED_RUN : SANDBOX_RUN)
    : 'The user can Copy this command from the card under your answer. ' + SANDBOX_NOT_READY;
  return { ...RESULT, content: lead + TAIL };
}

function invalidCommand(cause) {
  const failure = proposalFailure(NAME, 'invalid_request', { cause });
  if (cause !== 'timeout_sandbox_limit') return failure;
  return { ...failure, content: `${NAME} did not record a proposal. timeout_seconds can be at most `
    + `${PROPOSAL_LIMITS.docker_timeout_max} while the command sandbox is on. Correct it and call ${NAME} again.` };
}

// Records a command for the user to Copy or Run; it never executes anything.
module.exports = {
  name: NAME,
  ...manifestSchema(NAME),
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  workspaceRequired: true,

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
    if (!validated?.ok) return invalidCommand(validated?.cause_code);
    if (!checkLiveCall(context).ok) return proposalFailure(NAME, 'authority_changed');
    return publishProposal(NAME, resultSpec(captured.binding?.command?.backend, context), validated.value, captured.binding, live, context);
  },
};
