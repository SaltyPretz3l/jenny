'use strict';

/* services/tools/builtin/run-view-restart-tool.js: `run_view_restart` (roadmap row 197)
 *
 * Stop the program in the project's Live tab, build it, start it and report how that went. The
 * owner's confirmed run command is the only command that ever runs; this tool takes no arguments.
 * The result is one line plus, on a failure, the bounded build tail or the program's last output.
 * Only the first line is ever saved (the step summary in `metadata`). */

const { manifestSchema } = require('./tool-result');
const { checkRunViewCall, failure, reasonWord } = require('./run-view-tool-support');

const KIND = 'run_view_restart';
const MAX_CONTENT_CHARS = 4000;
const NO_COMMAND = 'This project has no confirmed run command. The owner sets it in the Live tab.';

function result(status, content, { isError, summary, generation }) {
  const stepSummary = content.split('\n', 1)[0].slice(0, 300);
  return {
    content, summary, isError,
    metadata: { result_kind: KIND, status, step_summary: stepSummary, generation: generation ?? null },
  };
}

// The first line, then as much of the end of the detail as fits.
function withDetail(head, detail) {
  const room = MAX_CONTENT_CHARS - head.length - 1;
  const text = String(detail || '').replace(/\s+$/, '');
  return text && room > 0 ? `${head}\n${text.slice(-room)}` : head;
}

function exitWords(exitCode) {
  return Number.isInteger(exitCode) ? `exit code ${exitCode}` : 'no exit code';
}

function fromOutcome(outcome) {
  const generation = outcome.run?.generation;
  const fail = (status, summary, content) => result(status, content, { isError: true, summary, generation });
  switch (outcome.outcome) {
    case 'running':
      return result('ok', `Restarted: generation ${generation} is running and its window is up.`,
        { isError: false, summary: 'Live: restarted', generation });
    case 'no_window':
      return result('ok', `Restarted: generation ${generation} is running but no window appeared yet.`,
        { isError: false, summary: 'Live: restarted', generation });
    case 'build_failed':
      return fail('build_failed', 'Live: build failed',
        withDetail(`The build failed (${exitWords(outcome.exitCode)}). Last output:`, outcome.buildTail));
    case 'ended_early': {
      const lines = Array.isArray(outcome.lines) ? outcome.lines.join('\n') : '';
      const why = outcome.run?.reason ? ` (${reasonWord(outcome.run.reason)})` : '';
      return fail('ended_early', 'Live: ended early',
        withDetail(`The program ended before it was ready${why} (${exitWords(outcome.exitCode)}). Last output:`, lines));
    }
    case 'cancelled':
      return fail('cancelled', 'Live: cancelled', 'The restart was cancelled and the program was stopped.');
    case 'stopped':
      return fail('stopped', 'Live: stopped', 'The program was stopped before it came up.');
    case 'timeout':
      return fail('timeout', 'Live: timeout', 'The program did not finish starting in time.');
    default:
      return fail('refused', 'Live: refused',
        `The program could not be started (${reasonWord(outcome.reason)}).`);
  }
}

async function confirmedCommand(service, projectId) {
  const status = await service.getStatus({ projectId });
  if (status?.ok !== true) {
    return status?.reason === 'no_project'
      ? failure(KIND, 'unavailable', 'This chat has no project folder.')
      : failure(KIND, 'unavailable', 'The Live tab could not be read.');
  }
  return status.command?.status === 'confirmed' ? null : failure(KIND, 'refused', NO_COMMAND);
}

module.exports = {
  name: 'run_view_restart', ...manifestSchema('run_view_restart'), category: 'builtin', workspaceRequired: true,
  readOnly: false, sideEffecting: true,
  summarize: () => 'Live: restart',
  async execute(input, context = {}) {
    const checked = checkRunViewCall(KIND, input, context, { restart: true });
    if (checked.failure) return checked.failure;
    // The wait can outlast a build; the turn's clocks stop while it runs when the bridge offers that.
    let resume = null;
    try {
      const service = checked.holder.get();
      const refused = await confirmedCommand(service, checked.projectId);
      if (refused) return refused;
      resume = typeof context.suspendTurnClocks === 'function' ? context.suspendTurnClocks() : null;
      const outcome = await service.restartAndWait({
        projectId: checked.projectId, chatId: checked.live.sessionId, worktree: null, signal: context.abortSignal,
      });
      return fromOutcome(outcome || {});
    } catch (_error) {
      return failure(KIND, 'failed', 'The restart failed.');
    } finally {
      if (typeof resume === 'function') {
        try { resume(); } catch (_error) { /* a clock that cannot resume must not hide the result */ }
      }
    }
  },
};
