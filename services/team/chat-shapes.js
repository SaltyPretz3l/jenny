'use strict';

// Shapes the desktop chat client (row 123, slice 2a-4b) checks before anything
// is kept or sent: channel and message ids, message text, refs and the local
// drafts and outbox entries kept in client.json. Message text, refs, ids and
// counts use the host's own validators (services/host/team-chat-schema.js), so
// a payload the client accepts is one the host's store accepts. Pure functions;
// no disk.

const {
  NOTIFY_LEVELS, channelKind, isMessageId, isMessageText, isPositive, isRefList,
} = require('../host/team-chat-schema');
const { isPlainObject } = require('../../server/team/member-schema');
const { CODE, REASON } = require('./team-errors');

// Owner bounds (TEAM_CHAT_SPEC "Desktop client"): 200 drafts of at most 64 KiB each.
const DRAFTS_MAX = 200;
// A draft's text, measured as its JSON-encoded UTF-8 bytes (what client.json stores).
const DRAFT_MAX_BYTES = 64 * 1024;
// Slice 2a-4b: at most 50 unsent chat mutations per team.
const OUTBOX_MAX = 50;
// The connection refuses a request body over 64 KiB (services/team/http-client.js MAX_REQUEST_BYTES); the
// command envelope around the params (version, operation, ids, epoch) stays well under the 1 KiB left.
const REQUEST_PARAMS_MAX_BYTES = 63 * 1024;
// A stored entry: its params plus the entry's own ids, time and state.
const OUTBOX_ENTRY_MAX_BYTES = REQUEST_PARAMS_MAX_BYTES + 1024;
// The only operations an outbox entry may hold: chat mutations whose retry the host answers from its
// idempotency record. Nothing else is ever resent.
const OUTBOX_OPERATIONS = Object.freeze(['team.chat.post', 'team.chat.edit', 'team.chat.delete']);
const ENTRY_ID = /^out_[A-Za-z0-9_-]{16,64}$/u;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const isPlain = (value) => isPlainObject(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hasOnly = (value, required, optional = []) => isPlain(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const isChannelId = (value) => channelKind(value) !== null;
const isIso = (value) => typeof value === 'string' && ISO.test(value) && new Date(Date.parse(value)).toISOString() === value;
const isNotify = (value) => NOTIFY_LEVELS.includes(value);
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** A draft's text: a well-formed string of at most 64 KiB as stored ('' clears a draft). */
function isDraftText(value) {
  if (typeof value !== 'string' || value.length > DRAFT_MAX_BYTES) return false;
  if (typeof value.isWellFormed === 'function' ? !value.isWellFormed() : /\p{Cs}/u.test(value)) return false;
  return jsonBytes(value) <= DRAFT_MAX_BYTES;
}

/** The host params of one outbox operation, closed exactly as the host's schema. */
function isOutboxParams(operation, params) {
  if (operation === 'team.chat.post') {
    return hasOnly(params, ['channel_id', 'text'], ['thread_root_id', 'refs']) && isChannelId(params.channel_id)
      && isMessageText(params.text) && (params.thread_root_id === undefined || isMessageId(params.thread_root_id))
      && (params.refs === undefined || isRefList(params.refs));
  }
  if (operation === 'team.chat.edit') {
    return hasOnly(params, ['channel_id', 'message_id', 'text', 'expected_rev']) && isChannelId(params.channel_id)
      && isMessageId(params.message_id) && isMessageText(params.text) && isPositive(params.expected_rev);
  }
  if (operation === 'team.chat.delete') {
    return hasOnly(params, ['channel_id', 'message_id']) && isChannelId(params.channel_id) && isMessageId(params.message_id);
  }
  return false;
}

/** True when the params of a chat mutation fit in one request to the host. */
const fitsRequest = (params) => jsonBytes(params) <= REQUEST_PARAMS_MAX_BYTES;

const isFailure = (value) => value === null
  || (hasOnly(value, ['code', 'reason']) && CODE.test(value.code) && REASON.test(value.reason));

/** One stored outbox entry. */
function isOutboxEntry(entry) {
  return hasOnly(entry, ['entry_id', 'request_id', 'operation', 'params', 'created_at', 'attempted', 'failed'])
    && ENTRY_ID.test(entry.entry_id) && REQUEST_ID.test(entry.request_id) && OUTBOX_OPERATIONS.includes(entry.operation)
    && isOutboxParams(entry.operation, entry.params) && fitsRequest(entry.params) && isIso(entry.created_at)
    && typeof entry.attempted === 'boolean' && isFailure(entry.failed) && jsonBytes(entry) <= OUTBOX_ENTRY_MAX_BYTES;
}

/** One stored draft: a channel, an optional thread root, non-empty text and when it was written. */
function isDraftEntry(entry) {
  return hasOnly(entry, ['channel_id', 'thread_root_id', 'text', 'updated_at']) && isChannelId(entry.channel_id)
    && (entry.thread_root_id === null || isMessageId(entry.thread_root_id)) && entry.text !== ''
    && isDraftText(entry.text) && isIso(entry.updated_at);
}

const draftKey = (channelId, rootId) => `${channelId}/${rootId || ''}`;

/** True for a bounded draft list with one entry per channel and thread. */
function isDraftList(value) {
  if (!Array.isArray(value) || value.length > DRAFTS_MAX || !value.every(isDraftEntry)) return false;
  return new Set(value.map((entry) => draftKey(entry.channel_id, entry.thread_root_id))).size === value.length;
}

/** True for a bounded outbox with unique entry and request ids. */
function isOutboxList(value) {
  if (!Array.isArray(value) || value.length > OUTBOX_MAX || !value.every(isOutboxEntry)) return false;
  return new Set(value.map((entry) => entry.entry_id)).size === value.length
    && new Set(value.map((entry) => entry.request_id)).size === value.length;
}

module.exports = {
  DRAFTS_MAX, DRAFT_MAX_BYTES, ENTRY_ID, OUTBOX_ENTRY_MAX_BYTES, OUTBOX_MAX, OUTBOX_OPERATIONS, draftKey, fitsRequest,
  isChannelId, isDraftEntry, isDraftList, isDraftText, isMessageId, isMessageText, isNotify, isOutboxEntry,
  isOutboxList, isRefList,
};
