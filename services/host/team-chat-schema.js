'use strict';

// Team chat documents, schema version 1 (row 123 slice 2a-1, TEAM_CHAT_SPEC
// "Message record" and "Store"). Closed-field validation of every document the
// store reads and of every input it turns into a record. Pure functions; no
// disk, no clock, no logging. Every field of the message record exists from
// version 1 so later slices add behaviour, not migrations.

const { isId } = require('../../server/team/ids');
const { isCount, isPlainObject } = require('../../server/team/member-schema');

const SCHEMA_VERSION = 1;
const MIB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;

const LIMITS = Object.freeze({
  TEXT_MAX_CHARS: 16000,
  MENTIONS_MAX: 16,
  REFS_MAX: 8,
  ATTACHMENTS_MAX: 8,
  EDITS_MAX: 10,
  REACTIONS_MAX: 20,
  REACTORS_MAX: 64,
  PINS_MAX: 50,
  FOLLOWED_MAX: 200,
  // The member bound: read.json entries, presence, and every per-member or
  // per-device limiter table in the chat commands (the team has at most 8).
  MEMBERS_MAX: 64,
  REQUESTS_MAX: 512,
  REQUEST_TTL_MS: 24 * HOUR_MS,
  CHANNELS_MAX: 1024,
  SEGMENTS_MAX: 4096,
  SEGMENT_MAX_MESSAGES: 500,
  // A post rolls to a new segment before the head would cross this size.
  SEGMENT_MAX_BYTES: MIB,
  // An edit may grow a sealed segment up to this size, never past it; it is
  // also the read bound of a segment file.
  SEGMENT_HARD_MAX_BYTES: 4 * MIB,
  INDEX_MAX_BYTES: 256 * 1024,
  CHANNEL_MAX_BYTES: MIB,
  // 64 members with 200 followed threads each is about 675 KB.
  READ_MAX_BYTES: MIB,
  REF_PATH_MAX_CHARS: 1024,
  ATTACHMENT_NAME_MAX_CHARS: 255,
  ATTACHMENT_MAX_BYTES: 4 * MIB,
  HISTORY_LIMIT_MAX: 100,
  SYNC_LIMIT_MAX: 200,
  // The overview's unread walk reads at most this many candidates per channel,
  // through a store read bounded by RECENT_LIMIT_MAX.
  UNREAD_SCAN_MAX: 300,
  RECENT_LIMIT_MAX: 1000,
  THREAD_LIMIT_MAX: 100,
});

const NOTIFY_LEVELS = Object.freeze(['all', 'mentions', 'none']);
const AUTHOR_KINDS = Object.freeze(['member', 'jenny']);
const ATTACHMENT_KINDS = Object.freeze(['image', 'file']);

const PATTERNS = Object.freeze({
  // A request id or a session id.
  token: /^[A-Za-z0-9_-]{1,128}$/u,
  project: /^project_[A-Za-z0-9_-]{1,128}$/u,
  message: /^msg_[0-9A-HJKMNP-TV-Z]{26}$/u,
  attachment: /^att_[0-9A-HJKMNP-TV-Z]{26}$/u,
  digest: /^[a-f0-9]{64}$/u,
  iso: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  mime: /^[a-z0-9][a-z0-9.+-]{0,62}\/[a-z0-9][a-z0-9.+-]{0,62}$/u,
});

// The only channel ids that may become a directory name: the team channel, a
// project channel, a direct conversation (a 64-hex hash of its participants).
const CHANNEL_PATTERNS = Object.freeze([
  ['team', /^chan_team$/u],
  ['project', /^chan_project_[A-Za-z0-9_-]{1,128}$/u],
  ['dm', /^chan_dm_[a-f0-9]{64}$/u],
]);

const KEYS = Object.freeze({
  index: ['schema_version', 'channels'],
  indexEntry: ['channel_id', 'kind', 'created_at'],
  channel: ['schema_version', 'channel_id', 'kind', 'created_at', 'archived', 'rev', 'next_seq', 'floor_seq', 'bytes',
    'pins', 'segments', 'requests'],
  segmentMeta: ['n', 'first_seq', 'last_seq', 'count', 'bytes', 'newest_at'],
  request: ['device_id', 'request_id', 'digest', 'at', 'result'],
  segment: ['schema_version', 'channel_id', 'n', 'messages'],
  message: ['id', 'channel_id', 'seq', 'rev', 'author', 'created_at', 'edited_at', 'text', 'thread_root_id',
    'reply_count', 'last_reply_at', 'mentions', 'refs', 'attachments', 'edits', 'reactions', 'pinned', 'deleted',
    'served_by'],
  read: ['schema_version', 'channel_id', 'members'],
  readMember: ['member_id', 'last_read_seq', 'notify', 'followed', 'updated_at'],
  followed: ['root_id', 'on'],
});

const RESULT_KEYS = Object.freeze(['message_id', 'seq', 'rev']);

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

const isPositive = (value) => Number.isSafeInteger(value) && value >= 1;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const isMemberId = (value) => isId('member', value);
const isDeviceId = (value) => isId('device', value);
const isMessageId = (value) => matches(PATTERNS.message, value);

function isIso(value) {
  if (!matches(PATTERNS.iso, value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

const isNullOrIso = (value) => value === null || isIso(value);

// Returns the channel kind for a valid channel id, else null. Called before a
// channel id touches any path.
function channelKind(channelId) {
  if (typeof channelId !== 'string' || channelId.length > 160) return null;
  for (const [kind, pattern] of CHANNEL_PATTERNS) if (pattern.test(channelId)) return kind;
  return null;
}

// Markdown source: well-formed UTF-16, 1 to 16,000 code points, not blank, and
// no control characters other than tab, line feed and carriage return.
function isMessageText(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.TEXT_MAX_CHARS * 2) return false;
  if (typeof value.isWellFormed === 'function' ? !value.isWellFormed() : /\p{Cs}/u.test(value)) return false;
  if (/\p{Cc}/u.test(value.replace(/[\t\n\r]/gu, ''))) return false;
  if (value.trim().length === 0) return false;
  return [...value].length <= LIMITS.TEXT_MAX_CHARS;
}

function isSafeLabel(value, maxChars) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars
    && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)
    && (typeof value.isWellFormed !== 'function' || value.isWellFormed());
}

function isMention(value) {
  return value === 'jenny' || value === 'channel' || isMemberId(value);
}

function isMentionList(value) {
  return Array.isArray(value) && value.length <= LIMITS.MENTIONS_MAX && value.every(isMention)
    && new Set(value).size === value.length;
}

function isRef(ref) {
  if (!isPlainObject(ref)) return false;
  if (ref.kind === 'conversation') return hasExactKeys(ref, ['kind', 'session_id']) && matches(PATTERNS.token, ref.session_id);
  if (ref.kind === 'file') {
    return hasExactKeys(ref, ['kind', 'project_id', 'path', 'line']) && matches(PATTERNS.project, ref.project_id)
      && isSafeLabel(ref.path, LIMITS.REF_PATH_MAX_CHARS) && (ref.line === null || isPositive(ref.line));
  }
  if (ref.kind === 'message') {
    return hasExactKeys(ref, ['kind', 'channel_id', 'message_id']) && channelKind(ref.channel_id) !== null
      && isMessageId(ref.message_id);
  }
  return false;
}

const isRefList = (value) => Array.isArray(value) && value.length <= LIMITS.REFS_MAX && value.every(isRef);

// A valid ref list rebuilt in a fixed key order, so equal payloads hash equal.
function normalizeRefs(refs) {
  return refs.map((ref) => {
    if (ref.kind === 'conversation') return { kind: ref.kind, session_id: ref.session_id };
    if (ref.kind === 'file') return { kind: ref.kind, project_id: ref.project_id, path: ref.path, line: ref.line };
    return { kind: ref.kind, channel_id: ref.channel_id, message_id: ref.message_id };
  });
}

function isAttachment(item) {
  return hasExactKeys(item, ['id', 'name', 'mime', 'size_bytes', 'kind']) && matches(PATTERNS.attachment, item.id)
    && isSafeLabel(item.name, LIMITS.ATTACHMENT_NAME_MAX_CHARS) && matches(PATTERNS.mime, item.mime)
    && isPositive(item.size_bytes) && item.size_bytes <= LIMITS.ATTACHMENT_MAX_BYTES
    && ATTACHMENT_KINDS.includes(item.kind);
}

// A reaction key holds at least one non-ASCII character (so never a prototype
// name) and no control or space characters. The emoji allowlist is slice 2b's.
function isReactionKey(key) {
  return key.length >= 1 && key.length <= 32 && !/^\p{ASCII}*$/u.test(key) && !/[\p{Cc}\p{Z}]/u.test(key);
}

function isReactions(value) {
  if (!isPlainObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value);
  if (keys.length > LIMITS.REACTIONS_MAX) return false;
  return keys.every((key) => {
    const ids = value[key];
    return isReactionKey(key) && Array.isArray(ids) && ids.length >= 1 && ids.length <= LIMITS.REACTORS_MAX
      && ids.every(isMemberId) && new Set(ids).size === ids.length;
  });
}

function isStamp(value) {
  return value === null || (hasExactKeys(value, ['by', 'at']) && isMemberId(value.by) && isIso(value.at));
}

function isEdits(value) {
  return Array.isArray(value) && value.length <= LIMITS.EDITS_MAX
    && value.every((edit) => hasExactKeys(edit, ['text', 'edited_at']) && isMessageText(edit.text) && isIso(edit.edited_at));
}

function isAuthor(author) {
  return hasExactKeys(author, ['kind', 'member_id']) && AUTHOR_KINDS.includes(author.kind) && isMemberId(author.member_id);
}

function validateMessage(message, channelId) {
  if (!hasExactKeys(message, KEYS.message)) return false;
  if (!isMessageId(message.id) || message.channel_id !== channelId) return false;
  if (!isPositive(message.seq) || !isPositive(message.rev) || !isAuthor(message.author)) return false;
  if (!isIso(message.created_at) || !isNullOrIso(message.edited_at)) return false;
  if (message.thread_root_id !== null && !isMessageId(message.thread_root_id)) return false;
  if (!isCount(message.reply_count) || !isNullOrIso(message.last_reply_at)) return false;
  if (message.thread_root_id !== null && (message.reply_count !== 0 || message.last_reply_at !== null)) return false;
  if (!isMentionList(message.mentions) || !isRefList(message.refs) || !isEdits(message.edits)) return false;
  if (!Array.isArray(message.attachments) || message.attachments.length > LIMITS.ATTACHMENTS_MAX
    || !message.attachments.every(isAttachment)) return false;
  if (!isReactions(message.reactions) || !isStamp(message.pinned) || !isStamp(message.deleted)) return false;
  if (message.served_by !== null && !isMemberId(message.served_by)) return false;
  if (message.deleted !== null) {
    return message.text === '' && message.edits.length === 0 && Object.keys(message.reactions).length === 0
      && message.attachments.length === 0 && message.refs.length === 0 && message.pinned === null;
  }
  return isMessageText(message.text);
}

function fail(reason, schema = false) {
  return { ok: false, reason, schema };
}

// Shared head of every document: a plain object whose schema_version is 1. A
// different integer version is `schema: true` (refused, never treated as
// corrupt); anything else is malformed.
function checkVersion(doc) {
  if (!isPlainObject(doc)) return fail('not_object');
  if (doc.schema_version !== SCHEMA_VERSION) {
    return Number.isSafeInteger(doc.schema_version) ? fail('unsupported_schema', true) : fail('shape_invalid');
  }
  return null;
}

function validateIndexDoc(doc) {
  const head = checkVersion(doc);
  if (head) return head;
  if (!hasExactKeys(doc, KEYS.index) || !Array.isArray(doc.channels) || doc.channels.length > LIMITS.CHANNELS_MAX) return fail('index_invalid');
  const folded = new Set();
  for (const entry of doc.channels) {
    if (!hasExactKeys(entry, KEYS.indexEntry) || channelKind(entry.channel_id) !== entry.kind || !isIso(entry.created_at)) {
      return fail('index_entry_invalid');
    }
    const key = entry.channel_id.toLowerCase();
    if (folded.has(key)) return fail('index_duplicate');
    folded.add(key);
  }
  return { ok: true };
}

function isRequestEntry(entry) {
  if (!hasExactKeys(entry, KEYS.request) || !isDeviceId(entry.device_id)) return false;
  if (!matches(PATTERNS.token, entry.request_id) || !matches(PATTERNS.digest, entry.digest) || !isCount(entry.at)) {
    return false;
  }
  const result = entry.result;
  if (!isPlainObject(result) || Object.keys(result).length === 0) return false;
  return Object.keys(result).every((key) => RESULT_KEYS.includes(key)
    && (key === 'message_id' ? isMessageId(result[key]) : isPositive(result[key])));
}

function validateSegmentMetas(segments, doc) {
  if (!Array.isArray(segments) || segments.length > LIMITS.SEGMENTS_MAX) return false;
  let previous = null;
  for (const meta of segments) {
    if (!hasExactKeys(meta, KEYS.segmentMeta) || !isPositive(meta.n) || !isCount(meta.count) || !isCount(meta.bytes)
      || !isCount(meta.newest_at) || !isPositive(meta.first_seq) || !isCount(meta.last_seq)) return false;
    if (previous && meta.n <= previous.n) return false;
    previous = meta;
  }
  return segments.length === 0 || segments[0].first_seq >= doc.floor_seq;
}

function validateChannelDoc(doc, channelId) {
  const head = checkVersion(doc);
  if (head) return head;
  if (!hasExactKeys(doc, KEYS.channel) || doc.channel_id !== channelId || channelKind(channelId) !== doc.kind) {
    return fail('channel_invalid');
  }
  if (!isIso(doc.created_at) || !(doc.archived === null || (hasExactKeys(doc.archived, ['at']) && isIso(doc.archived.at)))) {
    return fail('channel_invalid');
  }
  if (!isCount(doc.rev) || !isPositive(doc.next_seq) || !isPositive(doc.floor_seq) || doc.floor_seq > doc.next_seq
    || !isCount(doc.bytes)) return fail('channel_counters_invalid');
  if (!Array.isArray(doc.pins) || doc.pins.length > LIMITS.PINS_MAX || !doc.pins.every(isMessageId)
    || new Set(doc.pins).size !== doc.pins.length) return fail('channel_pins_invalid');
  if (!validateSegmentMetas(doc.segments, doc)) return fail('channel_segments_invalid');
  if (!Array.isArray(doc.requests) || doc.requests.length > LIMITS.REQUESTS_MAX || !doc.requests.every(isRequestEntry)) {
    return fail('channel_requests_invalid');
  }
  return { ok: true };
}

function validateSegmentDoc(doc, channelId, n) {
  const head = checkVersion(doc);
  if (head) return head;
  if (!hasExactKeys(doc, KEYS.segment) || doc.channel_id !== channelId || doc.n !== n) return fail('segment_invalid');
  if (!Array.isArray(doc.messages) || doc.messages.length > LIMITS.SEGMENT_MAX_MESSAGES) return fail('segment_invalid');
  let previous = 0;
  for (const message of doc.messages) {
    if (!validateMessage(message, channelId)) return fail('message_invalid');
    if (message.seq <= previous) return fail('segment_order_invalid');
    previous = message.seq;
  }
  return { ok: true };
}

function validateReadDoc(doc, channelId) {
  const head = checkVersion(doc);
  if (head) return head;
  if (!hasExactKeys(doc, KEYS.read) || doc.channel_id !== channelId) return fail('read_invalid');
  if (!Array.isArray(doc.members) || doc.members.length > LIMITS.MEMBERS_MAX) return fail('read_invalid');
  const seen = new Set();
  for (const entry of doc.members) {
    if (!hasExactKeys(entry, KEYS.readMember) || !isMemberId(entry.member_id) || seen.has(entry.member_id)
      || !isCount(entry.last_read_seq) || !NOTIFY_LEVELS.includes(entry.notify) || !isCount(entry.updated_at)) {
      return fail('read_member_invalid');
    }
    seen.add(entry.member_id);
    if (!Array.isArray(entry.followed) || entry.followed.length > LIMITS.FOLLOWED_MAX
      || !entry.followed.every((f) => hasExactKeys(f, KEYS.followed) && isMessageId(f.root_id) && typeof f.on === 'boolean')) {
      return fail('read_followed_invalid');
    }
  }
  return { ok: true };
}

// Crockford base32: a 48-bit millisecond time (10 characters) then 80 random
// bits (16 characters), so ids sort by creation time.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(value, length) {
  let out = '';
  let rest = BigInt(value);
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD[Number(rest % 32n)] + out;
    rest /= 32n;
  }
  return out;
}

function newMessageId(nowMs, randomBytes) {
  const bytes = randomBytes(10);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 10) throw new TypeError('randomBytes must return 10 bytes.');
  const time = Math.max(0, Math.min(Math.floor(nowMs), 2 ** 48 - 1));
  return `msg_${encodeBase32(time, 10)}${encodeBase32(BigInt(`0x${bytes.toString('hex')}`), 16)}`;
}

function emptyChannelDoc(channelId, kind, createdAt) {
  return {
    schema_version: SCHEMA_VERSION, channel_id: channelId, kind, created_at: createdAt, archived: null, rev: 0,
    next_seq: 1, floor_seq: 1, bytes: 0, pins: [], segments: [], requests: [],
  };
}

function defaultNotify(kind) {
  return kind === 'dm' ? 'all' : 'mentions';
}

module.exports = {
  SCHEMA_VERSION,
  LIMITS,
  NOTIFY_LEVELS,
  AUTHOR_KINDS,
  PATTERNS,
  channelKind,
  defaultNotify,
  emptyChannelDoc,
  isCount,
  isDeviceId,
  isMemberId,
  isMentionList,
  isMessageId,
  isMessageText,
  isPositive,
  isRefList,
  newMessageId,
  normalizeRefs,
  validateChannelDoc,
  validateIndexDoc,
  validateMessage,
  validateReadDoc,
  validateSegmentDoc,
};
