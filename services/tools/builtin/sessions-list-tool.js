'use strict';

// `sessions_list` (row 69 W2): the chats the calling chat may see, with a status each. The caller
// comes only from the live call binding; the scope rule lives in services/session-directory-scope.js.
const { manifestSchema } = require('./tool-result');
const { callDirectory, jsonToolResult, plainInput, withDataNote } = require('./session-directory-tool-support');

const NAME = 'sessions_list';
const KEYS = ['scope', 'project_id', 'include_archived', 'limit'];
const SCOPES = ['active', 'recent', 'all'];

function validInput(input) {
  if (!plainInput(input, KEYS)) return false;
  if (Object.hasOwn(input, 'scope') && !SCOPES.includes(input.scope)) return false;
  if (Object.hasOwn(input, 'project_id') && !(typeof input.project_id === 'string'
    && input.project_id.length > 0 && input.project_id.length <= 160)) return false;
  if (Object.hasOwn(input, 'include_archived') && typeof input.include_archived !== 'boolean') return false;
  return !Object.hasOwn(input, 'limit') || (Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50);
}

const result = (value) => jsonToolResult(NAME, 'Sessions: list', value);

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => 'Sessions: list',
  async execute(input = {}, context = {}) {
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_request' });
    return result(withDataNote(await callDirectory(context, 'list', { scope: input.scope ?? 'recent',
      project_id: input.project_id ?? null, include_archived: input.include_archived === true, limit: input.limit ?? 20 })));
  },
};
