'use strict';

// `sessions_list` (row 69 W2): the chats the calling chat may see, with a status each. The caller
// comes only from the live call binding; the scope rule lives in services/session-directory-scope.js.
// Row 129 C7: the model reads a compact row per chat (what picks a chat), a title `query`, an `offset`,
// and a count of what a page left out. The directory applies query and offset to every chat the caller
// may see (after the scope rule, before the row cap) and returns the page with an exact `total`.
const { manifestSchema } = require('./tool-result');
const { callDirectory, jsonToolResult, plainInput, withDataNote } = require('./session-directory-tool-support');

const NAME = 'sessions_list';
const KEYS = ['scope', 'project_id', 'include_archived', 'limit', 'query', 'offset'];
const SCOPES = ['active', 'recent', 'all'];
const DEFAULT_LIMIT = 10;
const MAX_QUERY_CHARS = 200;
const MAX_OFFSET = 1000;

function validInput(input) {
  if (!plainInput(input, KEYS)) return false;
  if (Object.hasOwn(input, 'scope') && !SCOPES.includes(input.scope)) return false;
  if (Object.hasOwn(input, 'project_id') && !(typeof input.project_id === 'string'
    && input.project_id.length > 0 && input.project_id.length <= 160)) return false;
  if (Object.hasOwn(input, 'include_archived') && typeof input.include_archived !== 'boolean') return false;
  if (Object.hasOwn(input, 'query') && !(typeof input.query === 'string' && input.query.length <= MAX_QUERY_CHARS)) return false;
  if (Object.hasOwn(input, 'offset') && !(Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= MAX_OFFSET)) return false;
  return !Object.hasOwn(input, 'limit') || (Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50);
}

// One chat as the model needs it to pick one; flags appear only when they are set.
function compactRow(row) {
  const outcome = row?.last_outcome?.status;
  return {
    session_id: row?.session_id,
    title: row?.title,
    project: row?.project?.name || row?.project?.id || null,
    project_id: row?.project?.id ?? null,
    status: row?.status,
    updated_at: row?.updated_at ?? null,
    ...(typeof outcome === 'string' ? { last_outcome: outcome } : {}),
    ...(row?.waiting_on_user === true ? { waiting_on_user: true } : {}),
    ...(row?.waiting_for ? { waiting_for: row.waiting_for } : {}),
    ...(row?.unread_message_count > 0 ? { unread_message_count: row.unread_message_count } : {}),
    ...(row?.archived === true ? { archived: true } : {}),
    ...(row?.linked?.parent_session_id ? { parent_session_id: row.linked.parent_session_id } : {}),
    ...(row?.linked?.children_count > 0 ? { children_count: row.linked.children_count } : {}),
  };
}

function remainingNote(remaining, atLeast, nextOffset, searched) {
  const count = `${atLeast ? 'At least ' : ''}${remaining} more ${remaining === 1 ? 'chat' : 'chats'}`;
  return { remaining, at_least: atLeast || undefined,
    how: `${count} not shown. Call sessions_list again with offset ${nextOffset}${searched ? ' and the same query' : ''} to see the next page.` };
}

function shaped(raw, { query, offset }) {
  if (raw?.ok !== true || !Array.isArray(raw.rows)) return raw;
  const page = raw.rows.map(compactRow);
  const next = offset + page.length;
  const total = Number.isSafeInteger(raw.total) ? raw.total : next;
  const atLeast = raw.total_at_least === true;
  const out = { ok: true, rows: page };
  if (total - next > 0) out.more = remainingNote(total - next, atLeast, next, Boolean(query));
  else if ((atLeast || raw.truncated === true) && page.length > 0) {
    out.more = { remaining: 0, at_least: true, how: `More chats exist beyond these. Call sessions_list again with offset ${next}${query ? ' and the same query' : ''} to see the next page.` };
  }
  if (page.length === 0) {
    out.message = offset > 0 ? 'No chats at that offset. Use a smaller offset.'
      : query ? 'No chat title matches that query. Try a shorter query or omit query.' : 'No chats match.';
  }
  return out;
}

const result = (value) => jsonToolResult(NAME, 'Sessions: list', value);

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => 'Sessions: list',
  async execute(input = {}, context = {}) {
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_request' });
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const offset = input.offset ?? 0;
    const scope = input.scope ?? 'recent';
    // `recent` stops at the 20 newest chats; a title search or a later page reads all of them.
    const raw = await callDirectory(context, 'list', { scope: scope === 'recent' && (query || offset > 0) ? 'all' : scope,
      project_id: input.project_id ?? null, include_archived: input.include_archived === true,
      limit: input.limit ?? DEFAULT_LIMIT, query, offset });
    return result(withDataNote(shaped(raw, { query, offset })));
  },
};
