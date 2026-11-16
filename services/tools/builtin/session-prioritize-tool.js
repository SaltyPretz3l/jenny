'use strict';

// `session_prioritize` (row 136 slice 3): the primary Jenny chat puts another chat's task first on the
// model ("Finish this first"), or lifts a pick it made. It changes only the order chats use the model
// in, the person or Jenny can undo it, and the person's own pick always stands, so it needs no card
// (policy `auto`). Refused in Plan mode and read-only chats. Only the primary chat is offered it
// (services/backend/primary-settings-tool-gate.js), and the directory refuses every other caller.
const { manifestSchema } = require('./tool-result');
const { callDirectory, jsonToolResult, plainInput, withDataNote } = require('./session-directory-tool-support');

const NAME = 'session_prioritize';
const LABEL = 'Chat order';
const KEYS = ['session_id', 'first'];
const SUMMARY_TITLE_CHARS = 60;
// What the two refusals of this tool mean to the model; the shared sentences cover the rest.
const MESSAGES = Object.freeze({
  user_pick_active: 'The user chose which chat goes first and their choice stands. Do not call this again; tell them if they asked for another order.',
  self: 'This chat cannot be put first. Name another chat.',
});

function validInput(input) {
  if (!plainInput(input, KEYS)) return false;
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 256) return false;
  return !Object.hasOwn(input, 'first') || typeof input.first === 'boolean';
}

// The row in the Jenny chat's timeline: which chat, and what changed for it. The title is another
// chat's text, so it is cut to one line of whole characters.
function summaryOf(value) {
  if (value.ok !== true || (value.first !== true && value.changed !== true)) return LABEL;
  const clean = typeof value.title === 'string' ? value.title.replace(/\s+/g, ' ').trim() : '';
  const title = clean ? `"${[...clean].slice(0, SUMMARY_TITLE_CHARS).join('')}"` : 'A chat';
  return value.first === true ? `Put ${title} first` : `${title} takes turns again`;
}

function result(value) {
  const message = value.ok !== true && Object.hasOwn(MESSAGES, value.reason) ? MESSAGES[value.reason] : null;
  const shown = message ? { ...value, message } : withDataNote(value);
  const summary = summaryOf(value);
  // The Electron bridge carries a result's metadata, not its summary, to the saved row, so the row's
  // words travel as `row_summary` when something changed (gate sitting 2026-11-14).
  const rowMetadata = value.ok === true && summary !== LABEL ? { row_summary: summary } : {};
  return { ...jsonToolResult(NAME, summary, shown, rowMetadata), isError: value.ok !== true };
}

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize: () => LABEL,
  async execute(input = {}, context = {}) {
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_request' });
    if (context.readOnly || context.planMode) return result({ ok: false, reason: 'mode_refused' });
    return result(await callDirectory(context, 'prioritize', {
      sessionId: input.session_id, first: input.first !== false,
      lanes: context.backendService?.sessionRuntime?.lanes,
    }));
  },
};
