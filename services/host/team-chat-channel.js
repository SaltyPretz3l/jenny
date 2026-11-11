'use strict';

// One team chat channel in memory (row 123 slice 2a-1): loading its segments,
// reconciling a torn write, the per-channel index, the paging rules and the
// pure builders of a post. The store owns every write; the guarded file access
// and the failure kinds live in team-chat-files.js (split in slice 2a-3b).
//
// A channel state (newState) is { doc, loaded, read, strays, broken } until
// loaded, then also { entries, byId, threads, head, headDirty }: `entries` are
// the visible messages in seq order as { id, seq, rev, n, root }, `threads`
// maps a root id to its reply stats { count, last_at, members } (members: the
// ids that wrote the root or a reply or were mentioned in one, the implicit
// followers), `head` is the committed head segment and `headDirty` says its
// file still holds dropped (uncommitted) messages.
// `io.readSegment(channelId, n)` returns a validated segment or throws.

const crypto = require('node:crypto');

const schema = require('./team-chat-schema');
const { sumBytes } = require('./team-chat-retention');
const { corrupt } = require('./team-chat-files');

const SEGMENT_FILE = /^seg-([1-9][0-9]{0,8})\.json$/u;
const TEMP_FILE = /^\.host-[a-f0-9]{32}\.tmp$/u;
const NO_MEMBERS = new Set();

const clone = (value) => JSON.parse(JSON.stringify(value));
const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const timeOf = (message) => Date.parse(message.created_at);

const newState = (doc) => ({ doc, loaded: false, read: undefined, strays: [], broken: null });

function segmentMeta(n, segment, bytes, newestAt) {
  const { messages } = segment;
  if (messages.length === 0) throw corrupt('segment_empty');
  return { n, first_seq: messages[0].seq, last_seq: messages[messages.length - 1].seq, count: messages.length,
    bytes, newest_at: newestAt };
}

// The implicit followers a message adds to its thread: its author (for a
// Jenny reply, the member who asked) and the member ids it mentions.
function addMembers(members, author, mentions) {
  if (typeof author === 'string') members.add(author);
  for (const mention of mentions) if (mention.startsWith('member_')) members.add(mention);
  return members;
}

// ------------------------------------------------------------ load

// A load in steps, one segment each, so the store can yield between segments
// (slice 2a-3b). Nothing is assigned to the channel state until finishLoad.
function startLoad(doc) {
  return { doc, index: 0, entries: [], byId: new Map(), threads: new Map(), roots: new Map(), deleted: new Set(),
    metas: [], maxRev: doc.rev, expected: doc.floor_seq, head: null, headDirty: false };
}

// A message at or past next_seq is uncommitted (a torn post) and dropped;
// anywhere but the head that is corruption, as is a gap. A reply whose root is
// below the floor was pruned with it.
function loadStep(load, segment) {
  const { doc } = load;
  const listed = doc.segments[load.index];
  const isHead = load.index === doc.segments.length - 1;
  load.index += 1;
  const committed = segment.messages.filter((message) => message.seq < doc.next_seq);
  if (committed.length !== segment.messages.length) {
    if (!isHead) throw corrupt('segment_uncommitted');
    load.headDirty = true;
  }
  for (const message of committed) {
    if (message.seq !== load.expected) throw corrupt('segment_gap');
    load.expected += 1;
    if (load.byId.has(message.id)) throw corrupt('duplicate_id');
    load.maxRev = Math.max(load.maxRev, message.rev);
    if (message.deleted !== null) load.deleted.add(message.id);
    const rootId = message.thread_root_id;
    if (rootId === null) {
      // Kept only until a reply needs it: the author id and the mention list, never the text.
      load.roots.set(message.id, [message.author.member_id, message.mentions]);
    } else {
      const root = load.byId.get(rootId);
      if (!root) continue;
      if (root.root !== null) throw corrupt('thread_invalid');
      const stats = load.threads.get(rootId)
        || { count: 0, last_at: null, members: addMembers(new Set(), ...load.roots.get(rootId)) };
      addMembers(stats.members, message.author.member_id, message.mentions);
      load.threads.set(rootId, { count: stats.count + 1, last_at: message.created_at, members: stats.members });
    }
    const entry = { id: message.id, seq: message.seq, rev: message.rev, n: listed.n, root: rootId };
    load.byId.set(message.id, entry);
    load.entries.push(entry);
  }
  const kept = { ...segment, messages: committed };
  load.metas.push(segmentMeta(listed.n, kept, bytesOf(kept), Math.max(...committed.map(timeOf))));
  if (isHead) load.head = kept;
}

// Assigns a finished load. `state.doc` may differ from the doc the load read
// only by a change that touches no segment (an archive); revisions past the
// committed one roll forward, and pins naming a missing or deleted message drop.
function finishLoad(state, load, io) {
  const read = load.doc;
  if (load.index !== read.segments.length || load.expected !== read.next_seq) throw corrupt('segment_gap');
  const doc = state.doc;
  const listedNs = new Set(read.segments.map((meta) => meta.n));
  const strays = io.listDir(doc.channel_id).filter((name) => {
    const match = SEGMENT_FILE.exec(name);
    return (match && !listedNs.has(Number(match[1]))) || TEMP_FILE.test(name);
  });
  const maxRev = Math.max(load.maxRev, doc.rev);
  const pins = doc.pins.filter((id) => load.byId.has(id) && !load.deleted.has(id));
  state.doc = { ...doc, rev: maxRev, segments: load.metas, bytes: sumBytes(load.metas), pins };
  Object.assign(state, { entries: load.entries, byId: load.byId, threads: load.threads, head: load.head,
    headDirty: load.headDirty, loaded: true });
  state.strays = [...new Set([...state.strays, ...strays])];
  return { strays: strays.length, rolledForward: maxRev - doc.rev };
}

// Reads every listed segment once and assigns nothing until all of it checks
// out (the synchronous path; the store's ensureLoaded is the yielding one).
function loadChannel(state, io) {
  if (state.loaded) return { strays: 0, rolledForward: 0 };
  const load = startLoad(state.doc);
  for (const listed of load.doc.segments) loadStep(load, io.readSegment(load.doc.channel_id, listed.n));
  return finishLoad(state, load, io);
}

function segmentOf(state, n, io) {
  if (state.head && state.head.n === n) return state.head;
  return io.readSegment(state.doc.channel_id, n);
}

// The stored record with the reply stats the store maintains for a root.
function presentMessage(state, message) {
  const out = clone(message);
  if (out.thread_root_id === null) {
    const stats = state.threads.get(out.id);
    out.reply_count = stats ? stats.count : 0;
    out.last_reply_at = stats ? stats.last_at : null;
  }
  return out;
}

// `shape` of each entry's stored record, reading each segment once.
function recordsOf(state, entries, io, shape) {
  const segments = new Map();
  return entries.map((entry) => {
    if (!segments.has(entry.n)) {
      segments.set(entry.n, new Map(segmentOf(state, entry.n, io).messages.map((message) => [message.id, message])));
    }
    return shape(segments.get(entry.n).get(entry.id));
  });
}

function materialize(state, entries, io) {
  return recordsOf(state, entries, io, (message) => presentMessage(state, message));
}

// The unread walk's light records: seq, author, mentions and whether the
// message is deleted; no text, and no copy of the record or its edit history.
function unreadRecords(state, entries, io) {
  return recordsOf(state, entries, io, (message) => ({ seq: message.seq,
    author: { kind: message.author.kind, member_id: message.author.member_id }, mentions: [...message.mentions],
    deleted: message.deleted !== null }));
}

function findMessage(state, messageId, io) {
  const entry = schema.isMessageId(messageId) ? state.byId.get(messageId) : undefined;
  if (!entry) return null;
  const segment = segmentOf(state, entry.n, io);
  return { entry, segment, message: segment.messages.find((message) => message.id === messageId) };
}

const isLimit = (limit, max) => schema.isPositive(limit) && limit <= max;

// The newest `limit` timeline entries before `beforeSeq`, oldest first; null
// for an invalid parameter.
function historyPage(state, { beforeSeq, limit }) {
  if (!isLimit(limit, schema.LIMITS.HISTORY_LIMIT_MAX) || (beforeSeq !== undefined && !schema.isPositive(beforeSeq))) {
    return null;
  }
  const picked = [];
  let hasMore = false;
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[i];
    if (entry.root !== null || (beforeSeq !== undefined && entry.seq >= beforeSeq)) continue;
    if (picked.length === limit) { hasMore = true; break; }
    picked.push(entry);
  }
  return { entries: picked.reverse(), hasMore };
}

// Entries changed after `afterRev`, by rev then seq; a page never ends inside
// one revision (a reply and its root share one).
function changedPage(state, { afterRev, limit }) {
  if (!schema.isCount(afterRev) || !isLimit(limit, schema.LIMITS.SYNC_LIMIT_MAX)) return null;
  const changed = state.entries.filter((entry) => entry.rev > afterRev).sort((a, b) => a.rev - b.rev || a.seq - b.seq);
  let end = Math.min(limit, changed.length);
  while (end < changed.length && changed[end].rev === changed[end - 1].rev) end += 1;
  return { entries: changed.slice(0, end), more: end < changed.length };
}

function threadPage(state, root, { afterSeq, limit }) {
  if (!isLimit(limit, schema.LIMITS.THREAD_LIMIT_MAX) || (afterSeq !== undefined && !schema.isCount(afterSeq))) return null;
  const replies = state.entries.filter((entry) => entry.root === root.id
    && (afterSeq === undefined || entry.seq > afterSeq));
  return { entries: replies.slice(0, limit), hasMore: replies.length > limit };
}

// Search's walk (slice 2a-3b): the visible messages of the one segment that
// holds the newest entry before `beforeSeq` (0: from the newest), newest
// first, deleted ones left out, as light records (the text string is shared,
// not copied). `next` is the seq to continue before, or null at the floor.
// Null for an invalid `beforeSeq`.
function segmentBefore(state, beforeSeq, io) {
  if (!schema.isCount(beforeSeq)) return null;
  const { entries } = state;
  let lo = 0;
  let hi = entries.length;
  if (beforeSeq === 0) lo = hi;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].seq < beforeSeq) lo = mid + 1;
    else hi = mid;
  }
  let i = lo - 1;
  if (i < 0) return { messages: [], next: null };
  const n = entries[i].n;
  const records = new Map(segmentOf(state, n, io).messages.map((message) => [message.id, message]));
  const messages = [];
  for (; i >= 0 && entries[i].n === n; i -= 1) {
    const message = records.get(entries[i].id);
    if (message.deleted !== null) continue;
    messages.push({ id: message.id, seq: message.seq, root_id: message.thread_root_id,
      author: { kind: message.author.kind, member_id: message.author.member_id }, created_at: message.created_at,
      text: message.text });
  }
  return { messages, next: i >= 0 ? entries[i + 1].seq : null };
}

// The unread walk (slice 2a-3b): entries after `afterSeq`, newest first,
// every timeline entry and each reply whose thread `follows(rootId, members)`
// admits (members: the thread's implicit followers); at most `limit`, `more`
// when further ones exist. In memory only; the caller materializes.
function recentEntries(state, { afterSeq, limit, follows }) {
  const picked = [];
  for (let i = state.entries.length - 1; i >= 0; i -= 1) {
    const entry = state.entries[i];
    if (entry.seq <= afterSeq) break;
    if (entry.root !== null && follows(entry.root, state.threads.get(entry.root)?.members || NO_MEMBERS) !== true) {
      continue;
    }
    if (picked.length === limit) return { entries: picked, more: true };
    picked.push(entry);
  }
  return { entries: picked, more: false };
}

// ------------------------------------------------------------ writes (pure)

// The segments a post writes: the head (or a new head when the current one is
// full or would cross the byte threshold) and, for a reply, the root's segment
// with its stats and revision. `root` is a findMessage result or null.
function buildAppend(state, message, root, limits) {
  const head = state.head;
  const headMeta = state.doc.segments[state.doc.segments.length - 1];
  const roll = !head || head.messages.length >= limits.segmentMaxMessages
    || headMeta.bytes + bytesOf(message) + 1 > limits.segmentMaxBytes;
  const n = roll ? (headMeta ? headMeta.n + 1 : 1) : head.n;
  const target = { schema_version: schema.SCHEMA_VERSION, channel_id: state.doc.channel_id, n,
    messages: roll ? [clone(message)] : [...head.messages, clone(message)] };
  let rootSegment = null;
  if (root) {
    rootSegment = root.entry.n === n ? target : { ...root.segment, messages: [...root.segment.messages] };
    const at = rootSegment.messages.findIndex((item) => item.id === root.entry.id);
    const stats = state.threads.get(root.entry.id) || { count: 0 };
    rootSegment.messages[at] = { ...rootSegment.messages[at], reply_count: stats.count + 1,
      last_reply_at: message.created_at, rev: message.rev };
    if (rootSegment === target) rootSegment = null;
  }
  const newestAt = roll ? timeOf(message) : Math.max(headMeta.newest_at, timeOf(message));
  return { n, roll, target, rootSegment, newestAt, headBytes: roll ? 0 : headMeta.bytes };
}

// Records a committed post in the in-memory index. `rootMessage` is the
// root's record for a reply: its author and mentions seed the thread's
// implicit followers on the first reply.
function rememberAppend(state, message, n, target, rootMessage = null) {
  state.head = target;
  state.headDirty = false;
  const entry = { id: message.id, seq: message.seq, rev: message.rev, n, root: message.thread_root_id };
  state.entries.push(entry);
  state.byId.set(message.id, entry);
  if (message.thread_root_id !== null) {
    const stats = state.threads.get(message.thread_root_id)
      || { count: 0, members: addMembers(new Set(), rootMessage?.author.member_id, rootMessage?.mentions || []) };
    addMembers(stats.members, message.author.member_id, message.mentions);
    state.threads.set(message.thread_root_id, { count: stats.count + 1, last_at: message.created_at,
      members: stats.members });
    state.byId.get(message.thread_root_id).rev = message.rev;
  }
}

// An edit's new mentions join its thread's implicit followers (they are never
// removed until the thread is pruned; a reload recomputes from current text).
function rememberMentions(state, message) {
  const stats = state.threads.get(message.thread_root_id === null ? message.id : message.thread_root_id);
  if (stats) addMembers(stats.members, null, message.mentions);
}

const withMessage = (segment, updated) => ({ ...segment,
  messages: segment.messages.map((item) => (item.id === updated.id ? updated : item)) });

function digestOf(op, payload) {
  return crypto.createHash('sha256').update(JSON.stringify([op, payload])).digest('hex');
}

// A live idempotency entry for this device and request id, or null.
function findRequest(doc, key, now) {
  return doc.requests.find((item) => item.device_id === key.deviceId && item.request_id === key.requestId
    && now - item.at <= schema.LIMITS.REQUEST_TTL_MS) || null;
}

// The channel's entries with this one added: expired ones dropped, newest 512 kept.
function requestsWith(doc, key, digest, result, now) {
  const kept = doc.requests.filter((item) => now - item.at <= schema.LIMITS.REQUEST_TTL_MS);
  kept.push({ device_id: key.deviceId, request_id: key.requestId, digest, at: now, result });
  return kept.slice(-schema.LIMITS.REQUESTS_MAX);
}

// Drops pruned messages from the in-memory index.
function forgetMessages(state, gone) {
  state.entries = state.entries.filter((entry) => !gone(entry.id));
  for (const id of [...state.byId.keys()]) {
    if (gone(id)) {
      state.byId.delete(id);
      state.threads.delete(id);
    }
  }
}

module.exports = {
  buildAppend,
  bytesOf,
  changedPage,
  clone,
  digestOf,
  finishLoad,
  findMessage,
  findRequest,
  forgetMessages,
  historyPage,
  loadChannel,
  loadStep,
  materialize,
  newState,
  presentMessage,
  recentEntries,
  rememberAppend,
  rememberMentions,
  requestsWith,
  segmentBefore,
  segmentMeta,
  startLoad,
  threadPage,
  unreadRecords,
  withMessage,
};
