'use strict';

// Team chat documents, schema version 1 (row 123 slice 2a-1, TEAM_CHAT_SPEC
// "Message record" and "Store"). Closed-field validation of every document the
// store reads and of every input it turns into a record. Pure functions; no
// disk, no clock, no logging. Every field of the message record exists from
// version 1 so later slices add behaviour, not migrations. Slice 2d gives the
// channel document alone version 2, which adds `participants` (a direct
// conversation's members, stored once); the index and segments stay version 1.
// Slice E59 gives the read state version 2: each followed item gains `read_seq`
// (the thread's own read mark, null while it tracks the channel mark) and `on`
// may be null (no explicit choice: an item that only holds the mark of a thread
// followed by the implicit rule). Version 1 is read and carried forward as
// version 2, every mark null, so nothing reads as new after the upgrade.
// Row 173 gives the channel document version 3: `name`, `topic`, `created_by`, `changes`, and `archived` as
// `{ at, by }` (TEAM_CHANNELS_2026-11-16.md "Channel record, schema 3"). Versions 1 and 2 are read and carried
// forward as version 3, the team channel named `team`, every other channel with no profile.

const crypto = require('node:crypto');

const { isId } = require('../../server/team/ids');
const { isCount, isPlainObject } = require('../../server/team/member-schema');
const names = require('./team-chat-names');

const SCHEMA_VERSION = 1;
// The channel document's version (row 173): versions 1 and 2 are read and carried forward as version 3 when the
// document is next written.
const CHANNEL_SCHEMA_VERSION = 3;
const CHANNEL_V2 = 2;
// The read state's version (E59), carried forward the same way.
const READ_SCHEMA_VERSION = 2;
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
  // 64 members with 200 followed threads each, every one with a 7-digit mark, measures about 940 KB (E59).
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
  // Row 173: live custom channels per team (archived ones do not count), the change records a channel keeps,
  // and the name and topic bounds in code points.
  CUSTOM_CHANNELS_MAX: 32,
  CHANNEL_CHANGES_MAX: 10,
  CHANNEL_NAME_MAX: 40,
  CHANNEL_TOPIC_MAX: 250,
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
  // Row 173: a channel a member made; the suffix is host-generated base32 (10 random bytes).
  ['channel', /^chan_c_[a-z2-7]{16}$/u],
]);

const CHANNEL_KEYS_V1 = ['schema_version', 'channel_id', 'kind', 'created_at', 'archived', 'rev', 'next_seq', 'floor_seq',
  'bytes', 'pins', 'segments', 'requests'];

const CHANNEL_KEYS_V2 = [...CHANNEL_KEYS_V1, 'participants'];

// A change record's kinds (row 173); `renamed` also carries `from` and `to`.
const CHANGE_KINDS = Object.freeze(['created', 'renamed', 'topic', 'archived', 'unarchived']);

const KEYS = Object.freeze({
  index: ['schema_version', 'channels'],
  indexEntry: ['channel_id', 'kind', 'created_at'],
  channelV1: CHANNEL_KEYS_V1,
  channelV2: CHANNEL_KEYS_V2,
  channel: [...CHANNEL_KEYS_V2, 'name', 'topic', 'created_by', 'changes', 'profile_rev'],
  change: ['kind', 'by', 'at', 'seq_after'],
  renamed: ['kind', 'by', 'at', 'seq_after', 'from', 'to'],
  segmentMeta: ['n', 'first_seq', 'last_seq', 'count', 'bytes', 'newest_at'],
  request: ['device_id', 'request_id', 'digest', 'at', 'result'],
  segment: ['schema_version', 'channel_id', 'n', 'messages'],
  message: ['id', 'channel_id', 'seq', 'rev', 'author', 'created_at', 'edited_at', 'text', 'thread_root_id',
    'reply_count', 'last_reply_at', 'mentions', 'refs', 'attachments', 'edits', 'reactions', 'pinned', 'deleted',
    'served_by'],
  read: ['schema_version', 'channel_id', 'members'],
  readMember: ['member_id', 'last_read_seq', 'notify', 'followed', 'updated_at'],
  followedV1: ['root_id', 'on'],
  followed: ['root_id', 'on', 'read_seq'],
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

// A direct conversation's id: `chan_dm_` plus the SHA-256 hex of its participants' member ids sorted by code
// unit and joined by one line feed. The same people always give the same id, whoever asks and in any order.
// The only place an id is built; the store's create and the channel document check both call it.
function dmChannelId(memberIds) {
  const digest = crypto.createHash('sha256').update([...memberIds].sort().join('\n'), 'utf8').digest('hex');
  return `chan_dm_${digest}`;
}

// The shape of a participant list: 2 to 8 distinct member ids in code unit order (so sorted, as the id is built).
function isParticipantList(value) {
  return Array.isArray(value) && value.length >= 2 && value.length <= 8 && value.every(isMemberId)
    && value.every((id, at) => at === 0 || value[at - 1] < id);
}

// A stored participant list: that shape, and the ids hash to the channel's own id.
function isParticipants(value, channelId) {
  return isParticipantList(value) && dmChannelId(value) === channelId;
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
// name) and no control or space characters. A stored key is not held to the
// allowlist (team-chat-emoji.js, checked when a reaction is made), so changing
// the list never corrupts a channel on load.
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
function checkVersion(doc, accepted = [SCHEMA_VERSION]) {
  if (!isPlainObject(doc)) return fail('not_object');
  if (!accepted.includes(doc.schema_version)) {
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

// Row 173: a stored name or topic is its own normalization (team-chat-names.js), within the schema's bounds.
const channelName = (value) => names.normalizeName(value, LIMITS.CHANNEL_NAME_MAX);
const channelTopic = (value) => names.normalizeTopic(value, LIMITS.CHANNEL_TOPIC_MAX);
const isChannelName = (value) => names.isStoredName(value, LIMITS.CHANNEL_NAME_MAX);

// A change record: `by` is a member id, or null on an `archived` the host made; `seq_after` is the channel's last
// assigned seq at the change (`nextSeq` - 1 at most).
function isChange(change, nextSeq) {
  if (!isPlainObject(change) || !CHANGE_KINDS.includes(change.kind)) return false;
  if (!hasExactKeys(change, change.kind === 'renamed' ? KEYS.renamed : KEYS.change)) return false;
  if (!(isMemberId(change.by) || (change.by === null && change.kind === 'archived'))) return false;
  if (!isIso(change.at) || !isCount(change.seq_after) || change.seq_after >= nextSeq) return false;
  return change.kind !== 'renamed' || (isChannelName(change.from) && isChannelName(change.to));
}

// Version 3's profile: `team` is named `team`; a custom channel has a name and its creator; a project or direct
// channel has neither. Every channel has a topic ('' where none) and at most 10 change records.
function isProfile(doc) {
  const custom = doc.kind === 'channel';
  const nameOk = doc.kind === 'team' ? doc.name === 'team' : custom ? isChannelName(doc.name) : doc.name === null;
  return nameOk && (custom ? isMemberId(doc.created_by) : doc.created_by === null)
    && names.isStoredTopic(doc.topic, LIMITS.CHANNEL_TOPIC_MAX) && Array.isArray(doc.changes)
    && doc.changes.length <= LIMITS.CHANNEL_CHANGES_MAX && doc.changes.every((change) => isChange(change, doc.next_seq))
    && isCount(doc.profile_rev) && doc.profile_rev <= doc.rev;
}

// Versions 1 and 2 archive as `{ at }`; version 3 as `{ at, by }`, `by` null when the host archived it.
function isArchived(value, version) {
  if (value === null) return true;
  if (version !== CHANNEL_SCHEMA_VERSION) return hasExactKeys(value, ['at']) && isIso(value.at);
  return hasExactKeys(value, ['at', 'by']) && isIso(value.at) && (value.by === null || isMemberId(value.by));
}

// Version 1 has no `participants`; version 2 has it: an array for a direct conversation that stores its
// participants, null otherwise (a direct channel created before 2d, or one made without participants, has none and
// shows to nobody). Version 3 adds the profile (row 173); a custom channel exists only from version 3.
function validateChannelDoc(doc, channelId) {
  const head = checkVersion(doc, [SCHEMA_VERSION, CHANNEL_V2, CHANNEL_SCHEMA_VERSION]);
  if (head) return head;
  const version = doc.schema_version;
  const keys = version === SCHEMA_VERSION ? KEYS.channelV1 : version === CHANNEL_V2 ? KEYS.channelV2 : KEYS.channel;
  if (!hasExactKeys(doc, keys) || doc.channel_id !== channelId || channelKind(channelId) !== doc.kind) {
    return fail('channel_invalid');
  }
  if (doc.participants !== undefined && doc.participants !== null
    && !(doc.kind === 'dm' && isParticipants(doc.participants, channelId))) return fail('channel_invalid');
  if (!isIso(doc.created_at) || !isArchived(doc.archived, version)) return fail('channel_invalid');
  if (version === CHANNEL_SCHEMA_VERSION ? !isProfile(doc) : doc.kind === 'channel') return fail('channel_invalid');
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

// A followed item. Version 1: an explicit follow or unfollow. Version 2: `on` true, false or null; an unfollowed
// thread holds no mark, an item with no explicit choice exists only to hold one.
function isFollowedItem(item, version) {
  if (version === SCHEMA_VERSION) return hasExactKeys(item, KEYS.followedV1) && isMessageId(item.root_id) && typeof item.on === 'boolean';
  if (!hasExactKeys(item, KEYS.followed) || !isMessageId(item.root_id)) return false;
  if (item.on === false) return item.read_seq === null;
  if (item.on === null) return isCount(item.read_seq);
  return item.on === true && (item.read_seq === null || isCount(item.read_seq));
}

function validateReadDoc(doc, channelId) {
  const head = checkVersion(doc, [SCHEMA_VERSION, READ_SCHEMA_VERSION]);
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
      || !entry.followed.every((f) => isFollowedItem(f, doc.schema_version))) {
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

// A new channel document. The team channel is named `team`; a custom channel's profile comes from its creator
// (team-chat-manage.js); every other channel has none.
function emptyChannelDoc(channelId, kind, createdAt, participants = null) {
  return {
    schema_version: CHANNEL_SCHEMA_VERSION, channel_id: channelId, kind, created_at: createdAt, archived: null, rev: 0,
    next_seq: 1, floor_seq: 1, bytes: 0, pins: [], segments: [], requests: [], participants: freezeList(participants),
    name: kind === 'team' ? 'team' : null, topic: '', created_by: null, changes: [], profile_rev: 0,
  };
}

// A validated channel document in the current shape. Version 1 gains no participants; versions 1 and 2 gain the
// team channel's name `team` (every other channel null), an empty topic, no creator and no change records, and an
// archive stamp `{ at }` becomes `{ at, by: null }`. Nothing else changes. The participants are frozen once, here and
// at creation, so the audience rule can hand the list out as it is.
function currentChannelDoc(doc) {
  const current = { ...doc, schema_version: CHANNEL_SCHEMA_VERSION, participants: freezeList(doc.participants) };
  if (doc.schema_version === CHANNEL_SCHEMA_VERSION) return current;
  return { ...current, archived: doc.archived === null ? null : { at: doc.archived.at, by: null },
    name: doc.kind === 'team' ? 'team' : null, topic: '', created_by: null, changes: [], profile_rev: 0 };
}

// A validated read document in the current shape: version 1 gains version 2 and a null mark on every followed item
// (each thread's mark then tracks the member's channel mark, as every reply was counted before). Nothing else changes.
function currentReadDoc(doc) {
  if (doc.schema_version === READ_SCHEMA_VERSION) return doc;
  return { ...doc, schema_version: READ_SCHEMA_VERSION, members: doc.members.map((entry) => ({ ...entry,
    followed: entry.followed.map((item) => ({ root_id: item.root_id, on: item.on, read_seq: null })) })) };
}

function freezeList(list) {
  return Array.isArray(list) ? Object.freeze([...list]) : null;
}

function defaultNotify(kind) {
  return kind === 'dm' ? 'all' : 'mentions';
}

module.exports = {
  SCHEMA_VERSION,
  CHANNEL_SCHEMA_VERSION,
  READ_SCHEMA_VERSION,
  LIMITS,
  NOTIFY_LEVELS,
  AUTHOR_KINDS,
  CHANGE_KINDS,
  PATTERNS,
  channelKind,
  channelName,
  channelTopic,
  currentChannelDoc,
  currentReadDoc,
  defaultNotify,
  dmChannelId,
  emptyChannelDoc,
  isCount,
  isDeviceId,
  isIso,
  isMemberId,
  isParticipantList,
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
