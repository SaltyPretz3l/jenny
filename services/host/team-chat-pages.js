'use strict';

// Team chat read answers on the host (row 123 slices 2a-3a and 2a-3b): the byte
// bound on history, sync and thread pages, and the overview: the bounded unread
// count (followed thread replies included, each after its thread's own mark, E59),
// the followed threads with unseen replies, and the members with presence.
// Pure over a TeamChatStore's reads (the overview awaits its yielding load);
// no I/O of its own, no logging (nothing here may carry message text anywhere).

const { LIMITS, defaultNotify } = require('./team-chat-schema');
const { PIN_REACH, followsFor, markFor, storedMarks } = require('./team-chat-thread-marks');

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

// The `team.chat.edits` answer within `budget`: ten versions of 16,000 four-byte characters are about
// 640 KB, so the oldest versions drop first, the newest always stays, and `trimmed` says so. Each
// version is sized once.
function boundEdits(answer, budget) {
  if (!answer || answer.ok !== true) return answer;
  const { edits } = answer;
  const room = budget - sizeOf({ ...answer, edits: [], trimmed: true });
  let used = 0;
  let keep = 0;
  for (let at = edits.length - 1; at >= 0; at -= 1) {
    used += sizeOf(edits[at]) + (keep > 0 ? 1 : 0);
    if (used > room && keep > 0) break;
    keep += 1;
  }
  return keep === edits.length ? answer : { ...answer, edits: edits.slice(edits.length - keep), trimmed: true };
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

// The pinned list in the channel's pin order: records drop from the end when the page is over budget, and
// `trimmed` says so (false when everything fits).
function boundPins(page, budget) {
  const room = budget - sizeOf({ ...page, pins: [], trimmed: true });
  const keep = countFitting(page.pins, room);
  return { ...page, pins: keep === page.pins.length ? page.pins : page.pins.slice(0, keep), trimmed: keep < page.pins.length };
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

const BOUNDS = { history: boundHistory, sync: boundSync, thread: boundThread, pins: boundPins };

function boundPage(kind, page, budget) {
  return page && page.ok === true ? BOUNDS[kind](page, budget) : page;
}

// E59: at most this many followed threads with unseen replies per overview row, and per overview answer (about
// 66 bytes each, so 13 KB at most). Past either bound a thread's replies still count in the row's `unread`; the
// thread shows no sign of its own until it is listed.
const THREADS_PER_ROW = 20;
const THREADS_PER_OVERVIEW = 200;

// Where the unread walk starts: the channel mark, or the oldest stored mark of a followed thread under it, never
// more than PIN_REACH entries behind the channel's newest (`lastSeq`; a stored mark that far back goes at the next
// channel mark). A channel whose stored marks are all null starts at its channel mark.
function walkStart(read, lastSeq) {
  const stored = [...storedMarks(read.followed).values()];
  if (stored.length === 0) return read.last_read_seq;
  return Math.min(read.last_read_seq, Math.max(lastSeq - PIN_REACH, Math.min(...stored)));
}

// Unread messages written by someone else and not deleted: every timeline
// message after the channel mark, and each reply in a thread the member
// follows after that thread's own mark (E59; the channel mark while it has none).
// At most 300 are read (light records: root, author, mentions, deleted;
// no text or edit history); past that `capped` says more unread exist. A
// counted message that mentions the actor or `channel` sets the flag. `threads`:
// the followed threads with a counted reply, { root_id, unread, mention }: those with a stored mark first (they
// have waited since a channel read), each group newest reply first.
function unreadOf(store, channelId, memberId, read, lastSeq) {
  const follows = followsFor(memberId, read.followed);
  const markOf = markFor({ member_id: memberId, ...read });
  const page = store.recentMessages(channelId, { afterSeq: walkStart(read, lastSeq), timelineAfter: read.last_read_seq,
    limit: LIMITS.UNREAD_SCAN_MAX, follows: (rootId, members, seq) => follows(rootId, members) && seq > markOf(rootId, members) });
  if (!page.ok) return null;
  let unread = 0;
  let mention = false;
  const threads = new Map();
  for (const message of page.messages) {
    const own = message.author.kind === 'member' && message.author.member_id === memberId;
    if (own || message.deleted) continue;
    unread += 1;
    const mentioned = message.mentions.includes(memberId) || message.mentions.includes('channel');
    if (mentioned) mention = true;
    if (message.root_id === null) continue;
    const thread = threads.get(message.root_id) || { root_id: message.root_id, unread: 0, mention: false };
    thread.unread += 1;
    thread.mention = thread.mention || mentioned;
    threads.set(message.root_id, thread);
  }
  const stored = storedMarks(read.followed);
  const listed = [...threads.values()].sort((a, b) => Number(stored.has(b.root_id)) - Number(stored.has(a.root_id)));
  return { unread, mention, capped: page.more, threads: listed.slice(0, THREADS_PER_ROW) };
}

// A team has at most eight members, so the asker sees at most seven others (LIMITS.MEMBERS_MAX is the read
// file's entry bound, 64, not the team's).
const READS_MAX = 7;

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The stored read positions of the other members of the channel's audience (a Set of member ids), for "seen by":
// positions above 0, sorted by member id, never the asker's. Read from read.json (no segment); unreadable states
// answer none.
function readsOf(store, channelId, memberId, audience) {
  const read = store.readPositions(channelId);
  if (!read.ok) return [];
  return read.positions
    .filter((entry) => entry.member_id !== memberId && audience.has(entry.member_id) && entry.last_read_seq > 0)
    .map((entry) => ({ member_id: entry.member_id, seq: entry.last_read_seq }))
    .sort((a, b) => byId(a.member_id, b.member_id))
    .slice(0, READS_MAX);
}

// The overview rows for the channels `visible` admits. A caught-up member
// costs no message read; a channel with unread messages is loaded first with
// the store's yielding load. A broken channel or an unreadable read state
// shows zero unread rather than failing the overview.
async function overviewChannels(store, memberId, visible, audienceOf) {
  const listed = store.listChannels();
  if (!listed.ok) return listed;
  const channels = [];
  let threadRoom = THREADS_PER_OVERVIEW;
  for (const info of listed.channels) {
    if (!visible(info.channel_id)) continue;
    const read = store.readState(info.channel_id, memberId);
    const lastReadSeq = read.ok ? read.last_read_seq : 0;
    const counting = !info.broken && (read.ok ? walkStart(read, info.last_seq) : 0) < info.last_seq;
    // The member may have lost the channel during the load (review round two, R07-F04): asked again after it.
    if (counting) {
      await store.ensureLoaded(info.channel_id);
      if (!visible(info.channel_id)) continue;
    }
    const counted = counting ? unreadOf(store, info.channel_id, memberId,
      read.ok ? read : { last_read_seq: 0, followed: [] }, info.last_seq) : null;
    const threads = counted ? counted.threads.slice(0, threadRoom) : [];
    const audience = audienceOf(info.channel_id);
    threadRoom -= threads.length;
    channels.push({
      channel_id: info.channel_id, kind: info.kind, archived: info.archived, rev: info.rev, last_seq: info.last_seq,
      floor_seq: info.floor_seq, last_read_seq: lastReadSeq, notify: read.ok ? read.notify : defaultNotify(info.kind),
      unread: counted ? counted.unread : 0, unread_capped: counted ? counted.capped : false,
      mention: counted ? counted.mention : false, threads,
      reads: readsOf(store, info.channel_id, memberId, audience), pin_count: info.pin_count,
      // A direct conversation names its participants (the asker is one: only they see the row).
      ...(info.participants ? { participants: info.participants } : {}),
      // Slice 2b-3: a project channel names who can read it now, the asker included, in code-unit order (at most
      // eight: the team's size). The same Set decides `reads` above; a team or direct row carries none.
      ...(info.kind === 'project' ? { audience: [...audience].sort(byId) } : {}),
      // Row 173: the team channel and a custom channel carry their profile; `archived` stays a boolean.
      ...(info.kind === 'team' || info.kind === 'channel' ? { name: info.name, topic: info.topic,
        created_by: info.created_by, archived_by: info.archived_by, changes: info.changes } : {}),
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

module.exports = { THREADS_PER_OVERVIEW, THREADS_PER_ROW, boundEdits, boundPage, fitOne, overviewChannels,
  overviewMembers, pageBudget };
