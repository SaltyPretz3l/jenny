'use strict';

// `session_status` (row 69 W2): a deterministic digest of one chat in the caller's scope. The caller
// comes only from the live call binding; an id outside the scope reads as not_found.
const { manifestSchema } = require('./tool-result');
const { callDirectory, jsonToolResult, plainInput, withDataNote } = require('./session-directory-tool-support');

const NAME = 'session_status';
const KEYS = ['session_id', 'include_transcript_tail', 'include_changes'];

function validInput(input) {
  if (!plainInput(input, KEYS)) return false;
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 256) return false;
  return ['include_transcript_tail', 'include_changes']
    .every(key => !Object.hasOwn(input, key) || typeof input[key] === 'boolean');
}

const result = (value) => jsonToolResult(NAME, 'Session status', value);

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => 'Session status',
  async execute(input = {}, context = {}) {
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_request' });
    return result(withDataNote(await callDirectory(context, 'digest', { sessionId: input.session_id,
      includeTranscriptTail: input.include_transcript_tail !== false, includeChanges: input.include_changes === true })));
  },
};
