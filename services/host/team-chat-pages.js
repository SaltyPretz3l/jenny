'use strict';

// Team chat read answers on the host (row 123 slices 2a-3a and 2a-3b): the byte
// bound on history, sync and thread pages, and the overview: the bounded unread
// count (followed thread replies included) and the members with presence.
// Pure over a TeamChatStore's reads (the overview awaits its yielding load);
// no I/O of its own, no logging (nothing here may carry message text anywhere).

const { LIMITS, defaultNotify } = require('./team-chat-schema');

const PAGE_MAX_BYTES = 512 * 1024;
// Room for the HTTP answer around a page (the envelope adds no message text).
const RESPONSE_HEADROOM_BYTES = 4096;

const sizeOf = (value) => Buffer.byteLength(JSON.stringify(value));

// The page bound: 512 KiB, and always under the team HTTP response cap.
function pageBudget(maxResponseBytes) {
  const cap = Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 ? maxResponseBytes : PAGE_MAX_BYTES;
  return Math.max(1024, Math.min(PAGE_MAX_BYTES, cap - RESPONSE_HEADROOM_BYTES));
}

// A message alone over the budget loses its earlier versions, oldest first:
// a 16,000-character text with ten earlier versions in 4-byte characters is
// about 700 KB. The 2b `team.chat.edits` read is where the full list lives.
// Pages and events (team-chat-commands.js) both use it.
function fitOne(message, budget) {
  let out = message;
  while (out.edits.length > 0 && sizeOf(out) > budget) out = { ...out, edits: out.edits.slice(1) };
  return out;
}

// How many of `items`, taken in order, fit in `room` bytes as JSON array members.
function countFitting(items, room) {
  let used = 0;
  let count = 0;
  for (const item of items) {
    used += sizeOf(item) + (count > 0 ? 1 : 0);
    if (used > room) break;
    count += 1;
  }
  return count;
}

// History is the newest page, oldest first: the far end is the oldest, so
// messages drop from the start and the client pages on with `before_seq`.
function boundHistory(page, budget) {
  const room = budget - sizeOf({ ...page, messages: [], has_more: true });
  const keep = countFitting([...page.messages].reverse(), room);
  if (keep === page.messages.length) return page;
  const kept = keep > 0 ? page.messages.slice(page.messages.length - keep)
    : [fitOne(page.messages[page.messages.length - 1], room)];
  return { ...page, messages: kept, has_more: true };
}

// Sync runs by revision, oldest first: messages drop from the end, never
// inside one revision (a reply and its root share one), and `more` says go on.
function boundSync(page, budget) {
  const room = budget - sizeOf({ ...page, messages: [], more: true });
  const { messages } = page;
  let keep = countFitting(messages, room);
  if (keep === messages.length) return page;
  while (keep > 0 && messages[keep - 1].rev === messages[keep].rev) keep -= 1;
  if (keep > 0) return { ...page, messages: messages.slice(0, keep), more: true };
  const group = messages.filter((message) => message.rev === messages[0].rev);
  const share = Math.floor((room - (group.length - 1)) / group.length);
  return { ...page, messages: group.map((message) => fitOne(message, share)), more: true };
}

// A thread is the root and its replies after `after_seq`, oldest first:
// replies drop from the end and the client pages on with `after_seq`. With
// replies to send, the root gets at most half the budget so one reply fits.
function boundThread(page, budget) {
  if (sizeOf(page) <= budget) return page;
  const rootBudget = page.replies.length > 0 ? Math.floor(budget / 2) : budget;
  const root = fitOne(page.root, rootBudget - sizeOf({ ...page, root: null, replies: [], has_more: true }));
  const room = budget - sizeOf({ ...page, root, replies: [], has_more: true });
  const keep = countFitting(page.replies, room);
  if (keep === page.replies.length) return root === page.root ? page : { ...page, root };
  const replies = keep > 0 ? page.replies.slice(0, keep) : [fitOne(page.replies[0], room)];
  return { ...page, root, replies, has_more: true };
}

const BOUNDS = { history: boundHistory, sync: boundSync, thread: boundThread };

function boundPage(kind, page, budget) {
  return page && page.ok === true ? BOUNDS[kind](page, budget) : page;
}

// The threads `memberId` follows, as a predicate over (rootId, members): an
// explicit follow or unfollow in the read state decides; otherwise the member
// follows a thread they wrote the root of, replied in or were mentioned in
// (`members`, kept by the store from the thread's messages).
function followsFor(memberId, followed) {
  const explicit = new Map((Array.isArray(followed) ? followed : []).map((item) => [item.root_id, item.on === true]));
  return (rootId, members) => (explicit.has(rootId) ? explicit.get(rootId) : members.has(memberId));
}

// Unread messages after `lastReadSeq` written by someone else and not
// deleted: every timeline message, and each reply in a thread the member
// follows. At most 300 are read (light records: author, mentions, deleted;
// no text or edit history); past that `capped` says more unread exist. A
// counted message that mentions the actor or `channel` sets the flag.
function unreadOf(store, channelId, memberId, lastReadSeq, followed) {
  const page = store.recentMessages(channelId, { afterSeq: lastReadSeq, limit: LIMITS.UNREAD_SCAN_MAX,
    follows: followsFor(memberId, followed) });
  if (!page.ok) return null;
  let unread = 0;
  let mention = false;
  for (const message of page.messages) {
    const own = message.author.kind === 'member' && message.author.member_id === memberId;
    if (own || message.deleted) continue;
    unread += 1;
    if (message.mentions.includes(memberId) || message.mentions.includes('channel')) mention = true;
  }
  return { unread, mention, capped: page.more };
}

// The overview rows for the channels `visible` admits. A caught-up member
// costs no message read; a channel with unread messages is loaded first with
// the store's yielding load. A broken channel or an unreadable read state
// shows zero unread rather than failing the overview.
async function overviewChannels(store, memberId, visible) {
  const listed = store.listChannels();
  if (!listed.ok) return listed;
  const channels = [];
  for (const info of listed.channels) {
    if (!visible(info.channel_id)) continue;
    const read = store.readState(info.channel_id, memberId);
    const lastReadSeq = read.ok ? read.last_read_seq : 0;
    const counting = !info.broken && lastReadSeq < info.last_seq;
    if (counting) await store.ensureLoaded(info.channel_id);
    const counted = counting ? unreadOf(store, info.channel_id, memberId, lastReadSeq, read.ok ? read.followed : [])
      : null;
    channels.push({
      channel_id: info.channel_id, kind: info.kind, archived: info.archived, rev: info.rev, last_seq: info.last_seq,
      floor_seq: info.floor_seq, last_read_seq: lastReadSeq, notify: read.ok ? read.notify : defaultNotify(info.kind),
      unread: counted ? counted.unread : 0, unread_capped: counted ? counted.capped : false,
      mention: counted ? counted.mention : false,
    });
  }
  return { ok: true, channels };
}

// The overview's members: each active member's id, display name, role and
// presence. `roster()` lists active members as { member_id, display_name,
// role }; nothing about devices, keys or addresses is read or sent.
function overviewMembers(roster, presence) {
  let listed;
  try {
    listed = typeof roster === 'function' ? roster() : [];
  } catch (_error) {
    listed = [];
  }
  return (Array.isArray(listed) ? listed : []).map((member) => {
    const seen = presence ? presence.stateOf(member.member_id) : { state: 'offline', last_seen_at: null };
    return { member_id: member.member_id, display_name: member.display_name, role: member.role, state: seen.state,
      last_seen_at: seen.last_seen_at };
  });
}

module.exports = { boundPage, fitOne, overviewChannels, overviewMembers, pageBudget };
