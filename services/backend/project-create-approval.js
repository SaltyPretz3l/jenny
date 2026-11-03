'use strict';

// The `project_create` approval step (row 94 P2). Before the card, the placement port checks the request and
// remembers it under this call (primary-chat-placement-service.js `prepareCard`); the card itself is the
// generic one over the exact `folder` and `name` arguments (EXACT_APPROVAL_FIELDS), which the port has already
// proved are the folder that gets bound. A request the port refuses never reaches a card: the approval path
// ends the call with this refusal as the tool's output, so the model learns the reason (and the real path or
// the existing project) and the user is never asked over a folder that cannot be bound.
const TOOL_NAME = 'project_create';
// Closed tokens the model may see, plus the facts it needs for the next step.
const REFUSAL_REASONS = new Set(['invalid_input', 'missing', 'invalid_folder', 'root_folder', 'home_folder', 'protected_folder',
  'credential_folder', 'resolves_elsewhere', 'exists', 'not_allowed', 'disabled', 'unavailable']);
// What a refusal may carry back to the model (the canonical folder, the project that already has it).
const REFUSAL_EXTRAS = Object.freeze(['folder', 'project_id', 'project_name']);

const refusalExtras = (answer) => Object.fromEntries(REFUSAL_EXTRAS
  .filter((key) => typeof answer?.[key] === 'string').map((key) => [key, answer[key]]));

/** `null` when the card may show, else the refusal text that ends the call before any card. */
async function projectCreateRefusal(service, sessionId, callId, input) {
  let answer = null;
  try {
    const port = service?.primaryChatPlacement;
    if (typeof port?.prepareCard === 'function') {
      answer = await port.prepareCard({ session_id: sessionId, tool_call_id: callId, name: input?.name, folder: input?.folder });
    }
  } catch (_error) {
    answer = null;
  }
  if (answer?.ok === true) return null;
  const reason = REFUSAL_REASONS.has(answer?.reason) ? answer.reason : 'unavailable';
  return JSON.stringify({ ok: false, reason, ...refusalExtras(answer), note: 'The app refused this before asking the user; nothing was created.' });
}

module.exports = { TOOL_NAME, projectCreateRefusal, refusalExtras };
