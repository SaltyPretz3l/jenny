'use strict';

// A followed thread's own unread count in the main process (row 123 slice E59). Pure transitions over one cached
// channel row and one follow-knowledge table; no I/O, no timers, no logging. chat-cache.js calls them.
//
// A row from a host that sends `threads` (E59) holds `threads`: root id -> { base_unread, base_mention, live },
// at most THREADS_MAX (the host's own bound a row), where `base_*` are the overview's counts and `live` the replies
// counted since, each { seq, mention }, at most LIVE_MAX. A thread past that bound still counts on the row, as on
// the host, and is held in `overflow`: root id -> its known unread replies { seq, mention } (live replies, and those
// a thread page showed past the member's mark), at most OVERFLOW_MAX threads of OVERFLOW_ITEMS_MAX replies, so a
// thread mark or an unfollow can take them off the row's count. A row from an older host holds `threads: null`: no
// thread is counted and no sign shows, as before.
// `own_mention` says whether the timeline (not a thread) holds an unread mention: true, false, or null while the
// overview's single flag cannot tell (a thread in it also mentions you); null is treated as true.
//
// What the cache knows of who follows a thread (`createFollowKnowledge`), per channel, at most KNOWN_MAX roots:
// - a root the overview lists (it has unseen replies, so you follow it);
// - a `chatFollow` answer (explicit; it wins over everything else seen here);
// - a `chatThread` answer's `following` (the host's rule at that moment);
// - the implicit rule where the cache can see it: your own reply, a reply that mentions you, and a root record
//   (an opened channel's page, or the root event the host sends after each reply) written by you or naming you.
// It can be wrong until the next overview for a thread you follow by the implicit rule whose root it never saw
// and that had no unseen replies at the overview: a live reply there is held back (`pending`, at most
// PENDING_MAX roots a channel) until the root's record arrives, and otherwise counts at the next overview.

const { isCount, isMessageId } = require('../host/team-chat-schema');

const THREADS_MAX = 20;
const LIVE_MAX = 100;
const KNOWN_MAX = 200;
const PENDING_MAX = 64;
const OVERFLOW_MAX = 64;
const OVERFLOW_ITEMS_MAX = 400;

/** Whether a record names this member (or the whole channel), and whether this member wrote it. */
const mentionsMe = (record, memberId) => record.mentions.includes(memberId) || record.mentions.includes('channel');
const isOwn = (record, memberId) => record.author.kind === 'member' && record.author.member_id === memberId;

/** The overview's thread list as held: a Map, or null for a host without one. A malformed list is held empty. */
function heldThreads(value) {
  if (!Object.hasOwn(value, 'threads')) return null;
  const list = value.threads;
  const ok = Array.isArray(list) && list.length <= THREADS_MAX && list.every((item) => Boolean(item) && typeof item === 'object'
    && isMessageId(item.root_id) && isCount(item.unread) && item.unread > 0 && typeof item.mention === 'boolean');
  const held = new Map();
  if (!ok) return held;
  for (const item of list) held.set(item.root_id, { base_unread: item.unread, base_mention: item.mention, live: [] });
  return held;
}

/** Whether the overview's mention flag is the timeline's: false when it is false, null when a thread also mentions. */
function ownMentionOf(value, threads) {
  if (value.mention !== true) return false;
  if (!threads) return true;
  return [...threads.values()].some((thread) => thread.base_mention) ? null : true;
}

const unreadOf = (thread) => thread.base_unread + thread.live.length;
const mentionOf = (thread) => thread.base_mention || thread.live.some((item) => item.mention);

/** The row's threads as the renderer gets them (newest overview order, then new ones), or undefined for an older host. */
function publicThreads(channel) {
  if (!channel.threads) return undefined;
  return [...channel.threads].map(([rootId, thread]) => ({ root_id: rootId, unread: unreadOf(thread), mention: mentionOf(thread) }));
}

function threadTotals(channel) {
  let unread = 0;
  let mention = false;
  for (const thread of channel.threads ? channel.threads.values() : []) {
    unread += unreadOf(thread);
    mention = mention || mentionOf(thread);
  }
  for (const items of channel.overflow ? channel.overflow.values() : []) {
    unread += items.length;
    mention = mention || items.some((item) => item.mention);
  }
  return { unread, mention };
}

/** The channel mark reached the newest message: what stays unread is the threads' own. */
function readToEnd(channel) {
  const totals = threadTotals(channel);
  channel.unread = totals.unread;
  channel.mention = totals.mention;
  channel.unread_capped = false;
  channel.own_mention = false;
}

/** A thread past the row's bound: its known replies, newest thread last, within both overflow bounds. */
function overflowWith(channel, rootId, items) {
  const overflow = channel.overflow || (channel.overflow = new Map());
  const bySeq = new Map((overflow.get(rootId) || []).map((item) => [item.seq, item]));
  for (const item of items) bySeq.set(item.seq, item);
  overflow.delete(rootId);
  overflow.set(rootId, [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-OVERFLOW_ITEMS_MAX));
  if (overflow.size > OVERFLOW_MAX) overflow.delete(overflow.keys().next().value);
}

/** Counted replies for a thread: on its row entry while it has one or there is room, else in `overflow`. */
function addLive(channel, rootId, items) {
  const listed = channel.threads.get(rootId);
  if (listed || channel.threads.size < THREADS_MAX) {
    const thread = listed || { base_unread: 0, base_mention: false, live: [] };
    const live = [...thread.live, ...items].slice(-LIVE_MAX);
    channel.unread += live.length - thread.live.length;
    thread.live = live;
    channel.threads.delete(rootId);
    channel.threads.set(rootId, thread);
  } else {
    channel.unread += items.length;
    overflowWith(channel, rootId, items);
  }
  if (items.some((item) => item.mention)) channel.mention = true;
}

/** A fresh timeline message from someone else past the channel mark: counted, and its mention kept as the timeline's. */
function countTimeline(channel, record, memberId) {
  channel.unread += 1;
  if (mentionsMe(record, memberId)) {
    channel.mention = true;
    channel.own_mention = true;
  }
}

/**
 * A fresh reply (its seq past the channel's newest before it). Counted when the thread is known followed; held in
 * `pending` while unknown. Your own reply and a reply naming you teach the implicit rule, and the follow starts at
 * that reply (as on the host): replies held back for the thread before it no longer count. Answers true if counted.
 */
function countReply(channel, record, memberId, known) {
  if (!channel.threads || record.deleted !== null) return false;
  const rootId = record.thread_root_id;
  if (isOwn(record, memberId) || record.mentions.includes(memberId)) {
    if (known.follows(channel.channel_id, rootId) === undefined && channel.pending) channel.pending.delete(rootId);
    known.implicit(channel.channel_id, rootId);
  }
  if (isOwn(record, memberId)) return false;
  const follows = known.follows(channel.channel_id, rootId);
  const item = { seq: record.seq, mention: mentionsMe(record, memberId) };
  if (follows === undefined) {
    const pending = channel.pending || (channel.pending = new Map());
    if (!pending.has(rootId) && pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value);
    pending.set(rootId, [...(pending.get(rootId) || []), item].slice(-LIVE_MAX));
    return false;
  }
  if (!follows) return false;
  addLive(channel, rootId, [item]);
  return true;
}

/** A root record seen: by you or naming you, its thread is followed, and replies held back for it now count. */
function sawRoot(channel, record, memberId, known) {
  if (!channel.threads || record.thread_root_id !== null) return false;
  if (isOwn(record, memberId) || record.mentions.includes(memberId)) known.implicit(channel.channel_id, record.id);
  const held = channel.pending && channel.pending.get(record.id);
  if (!held) return false;
  const follows = known.follows(channel.channel_id, record.id);
  if (follows === undefined) return false;
  channel.pending.delete(record.id);
  if (follows) addLive(channel, record.id, held);
  return follows;
}

/**
 * A followed thread's page with the member's own mark (`readSeq`, from a host that sends it) for a thread the row
 * does not list: the replies it shows past the mark (not yours, not deleted) are held in `overflow`, so a thread mark
 * can take them off the row's count. They are already in the row's count (the host counted them). Nothing for a
 * thread the row lists, an unfollowed one or an older host.
 */
function sawThreadPage(channel, rootId, page, memberId) {
  if (!channel.threads || channel.threads.has(rootId) || page.following !== true || !isCount(page.read_seq)) return;
  const items = page.replies.filter((record) => record.seq > page.read_seq && record.deleted === null && !isOwn(record, memberId))
    .map((record) => ({ seq: record.seq, mention: mentionsMe(record, memberId) }));
  if (items.length) overflowWith(channel, rootId, items);
}

/**
 * The host answered a thread mark (`threadReadSeq`), or the thread is no longer followed (null). What the cache
 * held for the thread at or under the mark goes (all of it for null), and the row's count falls by as many. The
 * row's mention falls with the thread's only while the timeline's own mention is known to be clear. Answers true
 * when the row changed.
 */
function clearThread(channel, rootId, threadReadSeq) {
  const thread = channel.threads && channel.threads.get(rootId);
  const overflow = channel.overflow && channel.overflow.get(rootId);
  if (!thread && !overflow) return false;
  const after = (items) => (threadReadSeq === null ? [] : items.filter((item) => item.seq > threadReadSeq));
  let removed = 0;
  if (thread) {
    const kept = after(thread.live);
    removed += unreadOf(thread) - kept.length;
    if (kept.length) channel.threads.set(rootId, { base_unread: 0, base_mention: false, live: kept });
    else channel.threads.delete(rootId);
  }
  if (overflow) {
    const kept = after(overflow);
    removed += overflow.length - kept.length;
    if (kept.length) channel.overflow.set(rootId, kept);
    else channel.overflow.delete(rootId);
  }
  channel.unread = Math.max(0, channel.unread - removed);
  if (channel.unread === 0) channel.unread_capped = false;
  const timelineRead = channel.last_read_seq >= channel.last_seq;
  if (timelineRead || channel.own_mention === false) channel.mention = threadTotals(channel).mention;
  return removed > 0;
}

/** Who follows which thread, as far as this client has seen (see the head of this file). */
function createFollowKnowledge() {
  let byChannel = new Map();
  function table(channelId) {
    if (!byChannel.has(channelId)) byChannel.set(channelId, new Map());
    return byChannel.get(channelId);
  }
  function set(channelId, rootId, on, explicit) {
    const known = table(channelId);
    known.delete(rootId);
    known.set(rootId, { on, explicit });
    if (known.size > KNOWN_MAX) known.delete(known.keys().next().value);
  }
  return {
    follows: (channelId, rootId) => byChannel.get(channelId)?.get(rootId)?.on,
    /** The implicit rule saw you take part: followed, unless you unfollowed it here. */
    implicit(channelId, rootId) {
      const held = byChannel.get(channelId)?.get(rootId);
      if (!(held && held.explicit && !held.on)) set(channelId, rootId, true, Boolean(held && held.explicit));
    },
    /** What the host said: `explicit` for a `chatFollow` answer, else a thread page's `following`. */
    learn(channelId, rootId, on, explicit) {
      const held = byChannel.get(channelId)?.get(rootId);
      set(channelId, rootId, on, explicit || Boolean(held && held.explicit && held.on === on));
    },
    clear() { byChannel = new Map(); },
  };
}

module.exports = { KNOWN_MAX, LIVE_MAX, OVERFLOW_ITEMS_MAX, OVERFLOW_MAX, PENDING_MAX, THREADS_MAX, clearThread, countReply,
  countTimeline, createFollowKnowledge, heldThreads, isOwn, mentionsMe, ownMentionOf, publicThreads, readToEnd, sawRoot,
  sawThreadPage };
