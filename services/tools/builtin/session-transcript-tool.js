'use strict';

// `session_transcript`: the pageable transcript of one chat in the caller's scope (the full read that
// `session_status` leaves out). The caller comes only from the live call binding; an id outside the
// scope reads as not_found.
const { manifestSchema } = require('./tool-result');
const { callDirectory, jsonToolResult, plainInput, withDataNote } = require('./session-directory-tool-support');

const NAME = 'session_transcript';
const KEYS = ['session_id', 'rows', 'before_message_id', 'include_tool_activity'];

function validInput(input) {
  if (!plainInput(input, KEYS)) return false;
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 256) return false;
  if (Object.hasOwn(input, 'rows') && !(Number.isInteger(input.rows) && input.rows >= 1 && input.rows <= 40)) return false;
  if (Object.hasOwn(input, 'before_message_id')
    && !(typeof input.before_message_id === 'string' && input.before_message_id && input.before_message_id.length <= 128)) return false;
  return !Object.hasOwn(input, 'include_tool_activity') || typeof input.include_tool_activity === 'boolean';
}

const result = (value) => jsonToolResult(NAME, 'Session transcript', value);

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => 'Session transcript',
  async execute(input = {}, context = {}) {
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_request' });
    return result(withDataNote(await callDirectory(context, 'transcript', { sessionId: input.session_id,
      rows: input.rows ?? 20, beforeMessageId: input.before_message_id ?? null,
      includeToolActivity: input.include_tool_activity === true })));
  },
};
