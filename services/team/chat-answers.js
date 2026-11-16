'use strict';

// The host answers the chat client passes straight to the renderer (slice
// 2a-4b): an older history page, a thread page and the read, notify and follow
// answers. Each is rebuilt from checked fields only: every message record
// passes the host's own validator for the channel asked about, a page holds no
// more records than the limit asked for, a thread's replies all name its root,
// and every flag and count has its type. Anything else answers
// `team_chat_answer_invalid` and carries nothing of the answer. A host refusal
// passes through chatFailure (its code and reason only). Pure functions.
//
// Slice 2a-4c adds the search page: each match exactly the host's fields, its
// channel one the cache lists (and the scoped one, when scoped), its excerpt a
// slice of message text within the host's 200-unit bound, the cursor opaque and
// within the host's bound and alphabet.

const { LIMITS, isCount, isIso, isMessageId, isMessageText, isPositive } = require('../host/team-chat-schema');
const { hasExactKeys, isPlainObject } = require('../../server/team/member-schema');
const { checkedMessage } = require('./chat-cache');
const { isAuthor } = require('./chat-live');
const { isNotify } = require('./chat-shapes');
const { chatFailure, invalidRequest } = require('./team-errors');

const invalid = () => invalidRequest('team_chat_answer_invalid');

// Every record of `list` checked for `channelId` and by `check`, at most `limit` of them; null when any fails.
function records(list, channelId, limit, check = () => true) {
  if (!Array.isArray(list) || list.length > limit) return null;
  const out = [];
  for (const item of list) {
    const record = checkedMessage(item, channelId);
    if (!record || !check(record)) return null;
    out.push(record);
  }
  return out;
}

/** An older history page: { ok, messages, has_more, floor_seq }. */
function historyAnswer(answer, channelId, limit) {
  if (!answer || answer.ok !== true) return chatFailure(answer);
  const messages = records(answer.messages, channelId, limit);
  if (!messages || typeof answer.has_more !== 'boolean' || !isCount(answer.floor_seq)) return invalid();
  return { ok: true, messages, has_more: answer.has_more, floor_seq: answer.floor_seq };
}

/** A thread page: { ok, root, replies, has_more, following? }, the root asked for and only its replies. */
function threadAnswer(answer, channelId, rootId, limit) {
  if (!answer || answer.ok !== true) return chatFailure(answer);
  const root = checkedMessage(answer.root, channelId);
  if (!root || root.id !== rootId || root.thread_root_id !== null) return invalid();
  const replies = records(answer.replies, channelId, limit, (record) => record.thread_root_id === rootId);
  if (!replies || typeof answer.has_more !== 'boolean') return invalid();
  // `following` (the asking member's own, from a host that knows it) passes when a boolean, is absent from an older
  // host, and anything else is invalid.
  if (Object.hasOwn(answer, 'following') && typeof answer.following !== 'boolean') return invalid();
  // `read_seq` (E59: the member's own mark for the thread) the same way: a count, or absent from an older host.
  if (Object.hasOwn(answer, 'read_seq') && !isCount(answer.read_seq)) return invalid();
  return { ok: true, root, replies, has_more: answer.has_more,
    ...(Object.hasOwn(answer, 'following') ? { following: answer.following } : {}),
    ...(Object.hasOwn(answer, 'read_seq') ? { read_seq: answer.read_seq } : {}) };
}

const FIELD_CHECKS = Object.freeze({
  last_read_seq: isCount, thread_read_seq: (value) => value === null || isCount(value), level: isNotify, root_id: isMessageId, on: (value) => typeof value === 'boolean',
  rev: isPositive,
});

/** A small answer (mark_read, set_notify, follow): each named field passes its check. */
function fieldsAnswer(answer, fields) {
  if (!answer || answer.ok !== true) return chatFailure(answer);
  const out = { ok: true };
  for (const field of fields) {
    if (!FIELD_CHECKS[field](answer[field])) return invalid();
    out[field] = answer[field];
  }
  return out;
}

/**
 * The earlier versions of a message: { ok, edits, rev, trimmed }, each edit exactly { text, edited_at },
 * at most the host's EDITS_MAX. Fields the host adds are dropped; `trimmed` is false when the host omits it.
 */
function editsAnswer(answer) {
  if (!answer || answer.ok !== true) return chatFailure(answer);
  const trimmed = Object.hasOwn(answer, 'trimmed') ? answer.trimmed : false;
  if (!Array.isArray(answer.edits) || answer.edits.length > LIMITS.EDITS_MAX || !isCount(answer.rev)
    || typeof trimmed !== 'boolean') return invalid();
  const edits = [];
  for (const edit of answer.edits) {
    if (!isPlainObject(edit) || !hasExactKeys(edit, ['text', 'edited_at']) || !isMessageText(edit.text)
      || !isIso(edit.edited_at)) return invalid();
    edits.push({ text: edit.text, edited_at: edit.edited_at });
  }
  return { ok: true, edits, rev: answer.rev, trimmed };
}

/** A channel's pinned messages: { ok, pins, trimmed }, each record checked for the channel and pinned, none twice. */
function pinsAnswer(answer, channelId) {
  if (!answer || answer.ok !== true) return chatFailure(answer);
  const pins = records(answer.pins, channelId, LIMITS.PINS_MAX, (record) => record.pinned !== null);
  if (!pins || new Set(pins.map((record) => record.id)).size !== pins.length || typeof answer.trimmed !== 'boolean') return invalid();
  return { ok: true, pins, trimmed: answer.trimmed };
}

// The host's search bounds (services/host/team-chat-search.js, server/api-contract.js CHAT_CURSOR_*): an excerpt
// of at most 200 UTF-16 units, a cursor of at most 512 base64url characters. Copied, not imported:
// server/api-contract.js compiles Ajv and is not otherwise loaded in the Electron main process.
const EXCERPT_MAX = 200;
const CURSOR_MAX = 512;
const CURSOR = /^[A-Za-z0-9_-]+$/u;
const MATCH_KEYS = Object.freeze(['channel_id', 'message_id', 'seq', 'root_id', 'author', 'created_at', 'excerpt']);

const isCursor = (value) => typeof value === 'string' && value.length >= 1 && value.length <= CURSOR_MAX
  && CURSOR.test(value);

// A slice of message text: well-formed, 1 to 200 units, no control character but tab and line breaks.
function isExcerpt(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > EXCERPT_MAX) return false;
  if (typeof value.isWellFormed === 'function' ? !value.isWellFormed() : /\p{Cs}/u.test(value)) return false;
  return !/\p{Cc}/u.test(value.replace(/[\t\n\r]/gu, ''));
}

function checkedMatch(value, isListed) {
  if (!isPlainObject(value) || !hasExactKeys(value, MATCH_KEYS)) return null;
  if (!isListed(value.channel_id) || !isMessageId(value.message_id) || !isPositive(value.seq)
    || (value.root_id !== null && !isMessageId(value.root_id)) || !isAuthor(value.author) || !isIso(value.created_at)
    || !isExcerpt(value.excerpt)) return null;
  return { channel_id: value.channel_id, message_id: value.message_id, seq: value.seq, root_id: value.root_id,
    author: { kind: value.author.kind, member_id: value.author.member_id }, created_at: value.created_at,
    excerpt: value.excerpt };
}

/** A search page: { ok, matches, next_cursor }, at most `limit` matches, each in a channel `isListed` accepts. */
function searchAnswer(answer, isListed, limit) {
  if (!answer || answer.ok !== true) return chatFailure(answer);
  if (!Array.isArray(answer.matches) || answer.matches.length > limit
    || (answer.next_cursor !== null && !isCursor(answer.next_cursor))) return invalid();
  const matches = [];
  for (const value of answer.matches) {
    const match = checkedMatch(value, isListed);
    if (!match) return invalid();
    matches.push(match);
  }
  return { ok: true, matches, next_cursor: answer.next_cursor };
}

module.exports = { editsAnswer, fieldsAnswer, historyAnswer, isCursor, pinsAnswer, searchAnswer, threadAnswer };
