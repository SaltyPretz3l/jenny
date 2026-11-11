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

// Row 129 C8: the model reads at most this many characters of rows per call (the directory may send
// up to 20 rows of 2,000), and the latest reply once.
const BUDGET_CHARS = 6000;
const CLIP_MARK = ' [clipped]';

function clipHead(text, limit) {
  return text.length <= limit ? text : text.slice(0, limit - CLIP_MARK.length).replace(/[\ud800-\udbff]$/u, '') + CLIP_MARK;
}

function clipTail(text, limit) {
  return text.length <= limit ? text : `[clipped] ${text.slice(-(limit - CLIP_MARK.length)).replace(/^[\udc00-\udfff]/u, '')}`;
}

// The newest rows that fit the budget (the newest row is always kept, cut to fit), the latest reply only
// when no row carries it, and a sentence on how to read earlier rows.
function shaped(value) {
  if (value?.ok !== true || !Array.isArray(value.rows) || value.rows.length === 0) return value;
  const { last_reply: reply, last_reply_clipped: replyClipped, last_reply_message_id: replyId, ...base } = value;
  let left = BUDGET_CHARS;
  const kept = [];
  for (let index = value.rows.length - 1; index >= 0; index -= 1) {
    const row = value.rows[index];
    const text = typeof row?.text === 'string' ? row.text : '';
    if (text.length > left && kept.length > 0) break;
    kept.push(text.length > left ? { ...row, text: clipHead(text, left) } : row);
    left -= Math.min(text.length, left);
  }
  kept.reverse();
  const more = base.more_before === true || kept.length < value.rows.length;
  const oldest = kept[0]?.id;
  // A row holds at most 2,000 characters, so a longer reply still comes once more, as its tail.
  const replyRow = kept.find(row => row?.id === replyId);
  const carried = typeof reply === 'string'
    && (!replyRow || typeof replyRow.text !== 'string' || replyRow.text.length < reply.length);
  return { ...base, rows: kept, more_before: more, budget_chars: BUDGET_CHARS,
    ...(more && oldest ? { earlier: `Earlier messages exist. Call session_transcript again with before_message_id set to "${oldest}" to read them.` } : {}),
    ...(carried ? { last_reply: clipTail(reply, BUDGET_CHARS), last_reply_clipped: replyClipped === true || reply.length > BUDGET_CHARS, last_reply_message_id: replyId } : {}) };
}

const result = (value) => jsonToolResult(NAME, 'Session transcript', value);

module.exports = {
  name: NAME, ...manifestSchema(NAME), category: 'builtin', workspaceRequired: false,
  readOnly: true, sideEffecting: false,
  summarize: () => 'Session transcript',
  async execute(input = {}, context = {}) {
    if (!validInput(input)) return result({ ok: false, reason: 'invalid_request' });
    return result(withDataNote(shaped(await callDirectory(context, 'transcript', { sessionId: input.session_id,
      rows: input.rows ?? 20, beforeMessageId: input.before_message_id ?? null,
      includeToolActivity: input.include_tool_activity === true }))));
  },
};
