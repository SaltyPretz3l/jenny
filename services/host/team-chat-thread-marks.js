'use strict';

// A thread's own read mark (row 123 slice E59, TEAM_CHAT_SPEC "E59 as built"). Pure rules over a member's read
// entry ({ member_id, last_read_seq, followed: [{ root_id, on, read_seq }] }) and a loaded channel state; no disk,
// no clock.
//
// - Who follows: an explicit follow or unfollow (`on` a boolean) decides; otherwise the member follows a thread
//   they wrote the root of, replied in or were mentioned in (the thread's implicit members: a Map of member id to
//   the seq of the first message that made them one).
// - A followed thread's mark is its stored `read_seq`; else the channel mark, raised for a thread followed by the
//   implicit rule to just before the message that made the member follow it (named in a reply after days away,
//   the replies before that one never read as new).
// - A thread whose mark is null is pinned when the channel mark moves past one of its counted replies (either
//   way), so a channel read never reads a reply and Mark unread never unreads one. A stored mark whose thread has
//   no reply after it and none after the new channel mark is dropped again (null).
// - Bounds: at most 50 pins (items with no explicit choice) a member a channel; a stored mark whose thread's newest
//   reply lies more than 2,000 entries (four full segments) behind the channel's newest goes at the next channel
//   mark; the follow list holds 200 items, and a pin never pushes out an explicit choice. A pin is dropped
//   newest-reply oldest first; past the bound the thread tracks the channel mark again.

const { LIMITS } = require('./team-chat-schema');

const PINS_MAX = 50;
const PIN_REACH = 2000;
const NO_MEMBERS = new Map();

// The threads `memberId` follows, as a predicate over (rootId, members): an explicit choice in the read state
// decides; otherwise the member follows a thread whose implicit members (`members`) include them.
function followsFor(memberId, followed) {
  const explicit = new Map((Array.isArray(followed) ? followed : [])
    .filter((item) => typeof item.on === 'boolean').map((item) => [item.root_id, item.on]));
  return (rootId, members) => (explicit.has(rootId) ? explicit.get(rootId) : members.has(memberId));
}

// root id -> stored mark, for the items that hold one.
function storedMarks(followed) {
  const marks = new Map();
  for (const item of Array.isArray(followed) ? followed : []) {
    if (Number.isSafeInteger(item.read_seq)) marks.set(item.root_id, item.read_seq);
  }
  return marks;
}

// The thread mark for this entry, as a function of (rootId, members): its stored mark; an explicit follow with
// none tracks the channel mark; a thread followed by the implicit rule starts just before the message that made
// the member one of its members, if that lies past the channel mark.
function markFor(entry) {
  const stored = storedMarks(entry.followed);
  const explicit = new Set((Array.isArray(entry.followed) ? entry.followed : [])
    .filter((item) => typeof item.on === 'boolean').map((item) => item.root_id));
  return (rootId, members) => {
    if (stored.has(rootId)) return stored.get(rootId);
    const joined = explicit.has(rootId) ? undefined : members?.get(entry.member_id);
    return Number.isSafeInteger(joined) ? Math.max(entry.last_read_seq, joined - 1) : entry.last_read_seq;
  };
}

const threadMarkOf = (entry, rootId, members) => markFor(entry)(rootId, members);

// The seq of a thread's newest reply (kept in the thread stats), or 0 when it has none.
const lastReplyOf = (state, rootId) => state.threads.get(rootId)?.last_seq || 0;

// The follow list within its bounds: at most PINS_MAX pins, then at most FOLLOWED_MAX items in all; pins go first
// (the one whose thread has the oldest newest reply first), then the oldest explicit items.
function boundFollowed(state, list) {
  const pins = list.filter((item) => item.on === null);
  const room = Math.max(0, Math.min(PINS_MAX, LIMITS.FOLLOWED_MAX - (list.length - pins.length)));
  if (pins.length <= room) return list.slice(-LIMITS.FOLLOWED_MAX);
  const keep = new Set(pins.map((item) => [item, lastReplyOf(state, item.root_id)])
    .sort((a, b) => b[1] - a[1]).slice(0, room).map(([item]) => item));
  return list.filter((item) => item.on !== null || keep.has(item)).slice(-LIMITS.FOLLOWED_MAX);
}

// The implicit members of a thread: the store's stats, or for a root with no reply yet, its author and mentions
// (joined at the root's seq).
function implicitMembers(state, rootEntry, rootMessage) {
  const stats = state.threads.get(rootEntry.id);
  if (stats) return stats.members;
  if (!rootMessage) return NO_MEMBERS;
  const members = new Map(rootMessage.mentions.filter((mention) => mention.startsWith('member_'))
    .map((mention) => [mention, rootEntry.seq]));
  if (typeof rootMessage.author.member_id === 'string') members.set(rootMessage.author.member_id, rootEntry.seq);
  return members;
}

// The roots with a reply in (low, high], from one walk back from the newest entry, never below `floor`.
function rootsBetween(state, low, high, floor) {
  const between = new Set();
  const stop = Math.max(low, floor);
  for (let at = state.entries.length - 1; at >= 0; at -= 1) {
    const entry = state.entries[at];
    if (entry.seq <= stop) break;
    if (entry.root !== null && entry.seq <= high) between.add(entry.root);
  }
  return between;
}

// Sets a thread's stored mark (null clears it): an item with no explicit choice and no mark is removed.
function withMark(followed, rootId, readSeq) {
  const at = followed.findIndex((item) => item.root_id === rootId);
  if (at < 0) return readSeq === null ? followed : [...followed, { root_id: rootId, on: null, read_seq: readSeq }];
  const item = followed[at];
  if (readSeq === null && item.on === null) return followed.filter((_, index) => index !== at);
  const out = [...followed];
  out[at] = { root_id: rootId, on: item.on, read_seq: item.on === false ? null : readSeq };
  return out;
}

// The follow list after the channel mark moves from `from` to `to` (either way). A stored mark is dropped when its
// thread is read (on a raise: no reply after the mark and none after `to`) or when its thread's newest reply lies
// more than PIN_REACH entries behind the channel's newest. A followed thread with no stored mark whose own mark
// changes with the move (a counted reply between the two positions) is pinned at its mark before the move.
// Pruned roots drop out; then the bounds.
function followedAfterChannelMark(state, entry, from, to) {
  const floor = state.doc.next_seq - 1 - PIN_REACH;
  const stored = storedMarks(entry.followed);
  const follows = followsFor(entry.member_id, entry.followed);
  let followed = entry.followed.filter((item) => state.byId.has(item.root_id));
  for (const [rootId, mark] of stored) {
    const last = lastReplyOf(state, rootId);
    if ((to > from && last <= mark && last <= to) || last < floor) followed = withMark(followed, rootId, null);
  }
  const before = markFor(entry);
  const after = markFor({ ...entry, last_read_seq: to });
  for (const rootId of rootsBetween(state, Math.min(from, to), Math.max(from, to), floor)) {
    if (stored.has(rootId) || !state.byId.has(rootId)) continue;
    const members = state.threads.get(rootId)?.members || NO_MEMBERS;
    const mark = before(rootId, members);
    if (follows(rootId, members) && mark !== after(rootId, members)) followed = withMark(followed, rootId, mark);
  }
  return boundFollowed(state, followed);
}

module.exports = { PINS_MAX, PIN_REACH, boundFollowed, followedAfterChannelMark, followsFor, implicitMembers,
  lastReplyOf, markFor, storedMarks, threadMarkOf, withMark };
