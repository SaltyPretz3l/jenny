'use strict';

// `terminal_run` (row 94 P4, owner picks T1 and C1): the Jenny chat runs one command line in the user's Workspace IDE,
// in a terminal of its own (an idle Jenny terminal or a new one, never a shell the user is using). It runs in the
// user's environment, outside the sidecar's run_command checks, so it is always carded, even in Auto, and never
// always-allowed; the approval path checks the line before the card and the port (services/terminal-tools-service.js)
// runs only under this call's card. The answer comes once the line is sent; there is no exit code, so the model reads
// the output with terminal_read. Refused in Plan mode and read-only chats and when the kill switch is off. No result
// carries exception text.
const { manifestSchema } = require('./tool-result');
const { checkLiveCall } = require('./propose-tool-support');
const { jsonToolResult, plainInput } = require('./session-directory-tool-support');

const NAME = 'terminal_run';
const LABEL = 'Terminal: run';
const SENT = 'Sent to the terminal; it is not finished yet. Read its output with terminal_read before saying what it did.';
const UNCONFIRMED = 'The app did not confirm the command in time; it may still run. Check with terminal_read before trying again.';

function validInput(input) {
  return plainInput(input, ['command', 'purpose']) && typeof input.command === 'string' && input.command.length >= 1
    && input.command.length <= 2000 && typeof input.purpose === 'string' && input.purpose.length >= 1 && input.purpose.length <= 200;
}

function answerOf(answer) {
  if (answer?.ok === true) return { ok: true, status: 'sent', terminal: answer.terminal ?? null, note: SENT };
  const reason = typeof answer?.reason === 'string' ? answer.reason : 'unavailable';
  return reason === 'unconfirmed' ? { ok: false, reason, note: UNCONFIRMED } : { ok: false, reason };
}

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize: () => LABEL,
  async execute(input = {}, context = {}) {
    const result = (value) => jsonToolResult(NAME, LABEL, value, { terminal: value.terminal });
    if (context.backendService?.featureFlags?.terminal_tools === false) return result({ ok: false, reason: 'disabled' });
    if (context.readOnly || context.planMode) return result({ ok: false, reason: 'mode_refused' });
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_input' });
    const live = checkLiveCall(context);
    const port = context.terminalToolsService;
    if (!live.ok || typeof port?.run !== 'function') return result({ ok: false, reason: 'unavailable' });
    try {
      return result(answerOf(await port.run({
        caller_session_id: live.sessionId, tool_call_id: String(context.callId || ''), command: input.command,
      })));
    } catch (_error) {
      return result({ ok: false, reason: 'unavailable' });
    }
  },
};
