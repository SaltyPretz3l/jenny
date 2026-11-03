'use strict';

// The `session_export` and `terminal_run` approval steps (row 94 P4), like project-create-approval.js. Before the
// card, the tool's port checks the request and remembers it under this call (the export port proves the model's
// `chat_title` names the chat that is exported; the terminal port checks the command line and that the IDE has a
// project open); each port later acts only under that call's card. A request the port refuses never reaches a card:
// the approval path ends the call with this refusal as the tool's output, so the model learns the reason and the
// user is never asked over something that cannot happen. A request the port accepts adds a line to the card's reason
// naming where the result lands (the Downloads file name, the terminal's folder), so the user approves that too.
const { sandboxEnabled } = require('../execution/command-bridge');

const SESSION_EXPORT_TOOL = 'session_export';
const TERMINAL_RUN_TOOL = 'terminal_run';

const STEPS = Object.freeze({
  [SESSION_EXPORT_TOOL]: {
    reasons: new Set(['invalid_input', 'not_found', 'title_mismatch', 'empty', 'not_allowed', 'disabled', 'unavailable']),
    // The real title, so the model can retry with it.
    extras: ['chat_title'],
    prepare: (service, sessionId, callId, input) => service?.primaryChatExport?.prepareCard?.({
      session_id: sessionId, tool_call_id: callId, target_session_id: input?.session_id, chat_title: input?.chat_title,
    }),
    cardNote: (answer) => (typeof answer?.file_name === 'string' ? `Saved to your Downloads folder as "${answer.file_name}".` : ''),
    note: 'The app refused this before asking the user; nothing was saved.',
  },
  [TERMINAL_RUN_TOOL]: {
    reasons: new Set(['invalid_command', 'project_not_open', 'sandbox_mode', 'not_allowed', 'disabled', 'unavailable']),
    extras: [],
    // Docker sandbox mode never runs a host terminal (the bridge refuses terminal_run there), so no card asks for one.
    prepare: (service, sessionId, callId, input) => (sandboxEnabled(service) ? { ok: false, reason: 'sandbox_mode' }
      : service?.terminalTools?.prepareRun?.({ session_id: sessionId, tool_call_id: callId, command: input?.command })),
    cardNote: (answer) => (typeof answer?.folder === 'string' && answer.folder ? `Runs in a new Jenny terminal tab in ${answer.folder}.` : ''),
    note: 'The app refused this before asking the user; nothing was run.',
  },
});

/** Whether `toolName` has a pre-card step here. */
function hasCardStep(toolName) {
  return Object.hasOwn(STEPS, toolName);
}

/** `{refusal, cardNote}`: the refusal text that ends the call before any card (else `null`), and the line the card
 * adds to its reason when it shows (else ''). */
async function appControlCardStep(service, toolName, sessionId, callId, input) {
  const step = hasCardStep(toolName) ? STEPS[toolName] : null;
  if (!step) return { refusal: null, cardNote: '' };
  let answer = null;
  try {
    answer = await step.prepare(service, sessionId, callId, input);
  } catch (_error) {
    answer = null;
  }
  if (answer?.ok === true) return { refusal: null, cardNote: step.cardNote(answer) };
  const reason = step.reasons.has(answer?.reason) ? answer.reason : 'unavailable';
  const extras = Object.fromEntries(step.extras.filter((key) => typeof answer?.[key] === 'string').map((key) => [key, answer[key]]));
  return { refusal: JSON.stringify({ ok: false, reason, ...extras, note: step.note }), cardNote: '' };
}

/** `null` when the card may show, else the refusal text that ends the call before any card. */
async function appControlCardRefusal(service, toolName, sessionId, callId, input) {
  return (await appControlCardStep(service, toolName, sessionId, callId, input)).refusal;
}

module.exports = { SESSION_EXPORT_TOOL, TERMINAL_RUN_TOOL, appControlCardRefusal, appControlCardStep, hasCardStep };
