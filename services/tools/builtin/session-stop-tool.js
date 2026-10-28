'use strict';

// `session_stop` (row 69 W2): stops another chat in the caller's scope (its running turn plus its
// queued or paused work). Side-effecting with an `ask` policy default, so the approval comes from the
// normal tool approval path before this runs; refused in Plan mode, read-only chats and lockdown, and
// never aimed at the caller's own turn. The caller comes only from the live call binding.
const { manifestSchema } = require('./tool-result');
const { callDirectory, jsonToolResult, plainInput } = require('./session-directory-tool-support');

const NAME = 'session_stop';
// `purpose` is the approval card's intent line (every approval-gated tool declares it).
const KEYS = ['session_id', 'purpose'];

function validInput(input) {
  if (!plainInput(input, KEYS)) return false;
  if (typeof input.session_id !== 'string' || !input.session_id || input.session_id.length > 256) return false;
  // The approval card shows `purpose`; this tool never reads it, and bounds it like the manifest (1,024).
  return !Object.hasOwn(input, 'purpose') || (typeof input.purpose === 'string' && input.purpose.length <= 1024);
}

const result = (value) => jsonToolResult(NAME, 'Session stop', value, { cleanup: value.cleanup });

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: false, sideEffecting: true,
  summarize: () => 'Session stop',
  async execute(input = {}, context = {}) {
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_request' });
    if (context.readOnly || context.planMode) return result({ ok: false, reason: 'mode_refused' });
    return result(await callDirectory(context, 'stop', { sessionId: input.session_id }));
  },
};
